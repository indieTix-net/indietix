/**
 * marketingEngine — the Marquee Engine poller.
 *
 * Runs on an EventBridge schedule (rate(5 minutes), configured manually --
 * see README.md) and does two things per client, in order:
 *
 *   1. GENERATE: for every currently-active UseQRCode Square item, expand
 *      any enabled MarketingSchedule rows into concrete MarketingPost rows
 *      (Status = 'draft'). Idempotent -- relies on MarketingPost's unique
 *      (SquareItemID, Channel, PostType, ScheduledFor) constraint.
 *   2. SEND: find MarketingPost rows that are Status = 'approved' and due
 *      (facebook/instagram/tiktok only -- see below), re-check the source
 *      item is still active in Square (the review gate described in the
 *      Marquee Engine design doc), then hand off to the channel sender.
 *
 * Nothing here fires for a client unless MARKETING_ENGINE_ENABLED is
 * "true" in their Client.configuration, and nothing reaches Status =
 * 'approved' without a human approving it via marketing.html's status
 * table (QRScanner's app.mjs). That single Approve click is the only
 * human checkpoint for every channel -- as of 2026-10-19, email sends
 * automatically through this poller too, same as the other three
 * (earlier it was manual-only, a deliberate choice that's since been
 * reversed; QRScanner/app.mjs's "Send Now" button still exists as an
 * optional immediate-send override, it's just no longer the only way
 * an approved email post goes out).
 *
 * Facebook/Instagram/TikTok (sendFacebookPost/sendInstagramPost/
 * sendTikTokPost, Phase 6) and email (sendEmailPost) all real-send
 * through this same poller -- but each one only fires for a client that
 * actually has that channel's credentials populated in
 * Client.configuration (META_PAGE_ACCESS_TOKEN + META_PAGE_ID for
 * Facebook, + META_IG_BUSINESS_ID for Instagram; TIKTOK_ACCESS_TOKEN for
 * TikTok; email always has SENDER_EMAIL once a client is onboarded, so
 * it's effectively always real). TikTok access tokens expire in ~24h --
 * if TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET/TIKTOK_REFRESH_TOKEN are also
 * set, refreshTikTokToken() refreshes (and persists the rotated pair)
 * before every send; a client with only a static TIKTOK_ACCESS_TOKEN
 * keeps working exactly as before until it goes stale. Until a client's
 * platform app approval
 * comes through and the social tokens get filled in, sendDuePost() falls
 * back to the original dry-run stub for that channel, so Phase 6 shipped
 * safely with zero behavior change for every existing client's social
 * channels. No client has real social credentials yet as of 2026-10-19,
 * so none of the three social senders have been exercised against a live
 * platform -- their request shapes are correct per each platform's
 * current official docs, not yet battle-tested. Email HAS been
 * exercised live (via the original manual Send Now path), so
 * sendEmailPost here reuses that same proven logic, just triggered by
 * the poller instead of a button click.
 */

import fs from 'fs';
import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import sharp from 'sharp';
import mailcomposer from 'mailcomposer';

const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
const sesClient = new SESClient({ region: process.env.AWS_REGION || 'us-east-2' });

// sharp's SVG text rendering (used for the weekly digest image) needs a
// real font + fontconfig available at render time. Lambda's bare runtime
// has neither -- confirmed live via "Fontconfig error: Cannot load default
// config file" in CloudWatch and the rendered text coming out as blank
// tofu-box glyphs. Point fontconfig at both the DejaVu Sans font bundled
// via the dejavu-fonts-ttf dependency (permissive Bitstream Vera license,
// kept as a fallback) and Electrolize (Google Fonts, OFL license,
// downloaded straight from google/fonts on GitHub into src/fonts/ since
// it's not published as a standalone TTF npm package -- the @fontsource
// package only ships woff/woff2, which fontconfig/freetype can't load),
// writing a minimal fonts.conf to /tmp at cold start -- the only writable
// path in the Lambda filesystem. /opt/nodejs/node_modules is where
// deploy.sh's layer zip structure always puts layer dependencies, and
// /var/task is where the function code zip (including src/fonts/) lands
// -- both deterministic, not resolved at runtime (see DEPLOY.md).
try {
  const fontconfigDir = '/tmp/fontconfig';
  fs.mkdirSync(fontconfigDir, { recursive: true });
  fs.writeFileSync(`${fontconfigDir}/fonts.conf`, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/var/task/fonts</dir>
  <dir>/opt/nodejs/node_modules/dejavu-fonts-ttf/ttf</dir>
  <cachedir>/tmp/fontconfig-cache</cachedir>
</fontconfig>
`);
  process.env.FONTCONFIG_PATH = fontconfigDir;
  process.env.HOME = process.env.HOME || '/tmp';
} catch (error) {
  console.warn('Could not set up fontconfig for digest text rendering:', error.message);
}

// ---- SQUARE API BASE ----
// Square's production API unless SQUARE_API_BASE says otherwise: an
// environment pointed at Square's sandbox sets it to
// https://connect.squareupsandbox.com (bootstrap.sh, SQUARE_ENVIRONMENT).
const SQUARE_API_BASE = (process.env.SQUARE_API_BASE || 'https://connect.squareup.com').replace(/\/+$/, '');
// ---- END SQUARE API BASE ----
const SQUARE_CATALOG_SEARCH_API_URL = `${SQUARE_API_BASE}/v2/catalog/search`;
const SQUARE_CATALOG_OBJECT_API_URL = `${SQUARE_API_BASE}/v2/catalog/object`;

// Mirrors the module-level pattern in expireQRCodeSquareModifiers/src/index.mjs --
// set once per client before that client's catalog calls, read by the
// Square-API helper functions below. Safe because clients are processed
// one at a time, sequentially, same as that Lambda.
let currentClientConfig = {};

// =====================================================================
// CLIENT DISCOVERY -- copied verbatim from expireQRCodeSquareModifiers/
// src/index.mjs:19-168 (this Lambda's third consumer; per README's
// stated policy, shared utilities get extracted to a real package once a
// FOURTH consumer needs them -- not yet).
// =====================================================================

async function getDatabaseCredentials(secretName) {
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretName,
        VersionStage: "AWSCURRENT",
      })
    );
    const secret = JSON.parse(response.SecretString);
    console.log(`Successfully retrieved database credentials from: ${secretName}`);
    return secret;
  } catch (error) {
    console.error(`Error retrieving database credentials from ${secretName}:`, error);
    throw error;
  }
}

async function getAllClientDatabases(dbConfig) {
  console.log("Discovering client databases...");
  const pgClient = new Client({
    ...dbConfig,
    database: 'postgres'
  });

  try {
    await pgClient.connect();
    const query = `
      SELECT datname
      FROM pg_database
      WHERE datname NOT IN ('postgres', 'template0', 'template1', 'rdsadmin')
        AND datistemplate = false
        AND datallowconn = true
      ORDER BY datname
    `;
    const result = await pgClient.query(query);
    const databases = result.rows.map(row => row.datname);
    console.log(`Found ${databases.length} potential client databases: ${databases.join(', ')}`);
    return databases;
  } finally {
    await pgClient.end();
  }
}

async function getClientConfiguration(databaseName, baseDbConfig) {
  const pgClient = new Client({
    ...baseDbConfig,
    database: databaseName
  });

  try {
    await pgClient.connect();

    const tableExistsQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'Client'
      );
    `;
    const tableResult = await pgClient.query(tableExistsQuery);
    if (!tableResult.rows[0].exists) {
      console.log(`Database ${databaseName}: No 'Client' table found`);
      return null;
    }

    const configQuery = `
      SELECT "configuration"
      FROM "Client"
      WHERE "configuration" IS NOT NULL
      LIMIT 1
    `;
    const result = await pgClient.query(configQuery);
    if (result.rows.length === 0) {
      console.log(`Database ${databaseName}: No configuration found in Client table`);
      return null;
    }

    return {
      clientId: databaseName,
      configuration: result.rows[0].configuration
    };
  } catch (error) {
    console.log(`Database ${databaseName}: Error checking configuration - ${error.message}`);
    return null;
  } finally {
    await pgClient.end();
  }
}

async function getAllClientsWithConfigurations(baseDbConfig) {
  console.log("Starting client discovery process...");
  const clientDatabases = await getAllClientDatabases(baseDbConfig);
  if (clientDatabases.length === 0) {
    console.log("No client databases found");
    return [];
  }

  const clients = [];
  for (const dbName of clientDatabases) {
    const clientConfig = await getClientConfiguration(dbName, baseDbConfig);
    if (clientConfig) {
      clients.push(clientConfig);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`Successfully found ${clients.length} clients with valid configurations`);
  return clients;
}

// =====================================================================
// SQUARE CATALOG DISCOVERY -- copied verbatim from
// expireQRCodeSquareModifiers/src/index.mjs:341-780.
// =====================================================================

async function getAllCategories() {
  try {
    const response = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        object_types: ['CATEGORY'],
        include_related_objects: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get all categories: ${response.status} ${errorText}`);
    }

    const categoryData = await response.json();
    return categoryData.objects?.length ? categoryData.objects : [];
  } catch (error) {
    console.error(`Error getting all categories:`, error);
    return [];
  }
}

async function getCategoryIds(categoryNames = ['Cinema', 'Events']) {
  try {
    const allCategories = await getAllCategories();
    const categoryIds = [];

    allCategories.forEach(category => {
      if (category.type === 'CATEGORY' && category.category_data?.name) {
        const categoryName = category.category_data.name;
        if (categoryNames.some(target => target.toLowerCase() === categoryName.toLowerCase())) {
          categoryIds.push(category.id);
        }
      }
    });

    console.log(`Found ${categoryIds.length} matching category IDs: ${categoryIds.join(', ')}`);
    return categoryIds;
  } catch (error) {
    console.error(`Error getting category IDs:`, error);
    throw error;
  }
}

async function getItemsByCategoryIds(categoryIds) {
  try {
    if (!categoryIds || categoryIds.length === 0) {
      return { objects: [], related_objects: [] };
    }

    let allItems = [];
    // Square doesn't support OR queries, so each category is searched separately.
    for (const categoryId of categoryIds) {
      try {
        const categoryResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            object_types: ['ITEM'],
            query: {
              exact_query: {
                attribute_name: 'category_id',
                attribute_value: categoryId
              }
            },
            include_related_objects: true
          })
        });

        if (!categoryResponse.ok) {
          const errorText = await categoryResponse.text();
          console.error(`Failed to search for items in category ${categoryId}: ${categoryResponse.status} ${errorText}`);
          continue;
        }

        const categoryData = await categoryResponse.json();
        if (categoryData.objects?.length) {
          allItems.push(...categoryData.objects);
          if (categoryData.related_objects) {
            allItems.push(...categoryData.related_objects);
          }
        }
      } catch (categoryError) {
        console.error(`Error searching category ${categoryId}:`, categoryError);
        continue;
      }
    }

    const uniqueItems = allItems.filter((item, index, self) =>
      index === self.findIndex(i => i.id === item.id)
    );

    return {
      objects: uniqueItems.filter(item => item.type === 'ITEM'),
      related_objects: uniqueItems.filter(item => item.type !== 'ITEM')
    };
  } catch (error) {
    console.error(`Error fetching items by category IDs:`, error);
    throw error;
  }
}

async function getAllCatalogItems() {
  try {
    const response = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        object_types: ['ITEM'],
        include_related_objects: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch all catalog items: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error fetching all catalog items:`, error);
    throw error;
  }
}

async function getItemsByCategoryNames(categoryNames = ['Cinema', 'Events']) {
  try {
    const categoryIds = await getCategoryIds(categoryNames);
    if (categoryIds.length === 0) {
      console.log(`Category lookup failed. Falling back to getting ALL items...`);
      return await getAllCatalogItems();
    }
    return await getItemsByCategoryIds(categoryIds);
  } catch (error) {
    console.error(`Error searching items by category names:`, error);
    try {
      return await getAllCatalogItems();
    } catch (fallbackError) {
      console.error(`Fallback also failed:`, fallbackError);
      throw fallbackError;
    }
  }
}

async function retrieveCatalogObject(objectId) {
  try {
    const response = await fetch(`${SQUARE_CATALOG_OBJECT_API_URL}/${objectId}?include_related_objects=true`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to retrieve catalog object ${objectId}: ${response.status} ${errorText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error retrieving catalog object ${objectId}:`, error);
    throw error;
  }
}

function filterItemsByCustomAttribute(catalogData, attributeName, attributeValue) {
  const itemsWithAttribute = [];
  const modifierListsToProcess = new Set();

  if (catalogData.objects && Array.isArray(catalogData.objects)) {
    catalogData.objects.forEach(catalogObject => {
      // Archiving just hides an item from the online store/POS -- Square's
      // search API still returns it. Without this check, an archived item
      // stays eligible for campaign/digest generation indefinitely, and
      // can even surface another item's real showtimes under its own
      // (wrong, stale) title if the two happen to share a modifier list
      // (confirmed live: an archived item whose modifier_list_info still
      // pointed at a currently-active item's modifier list). Same check
      // already applied in QRScanner/app.mjs's searchMarketingCatalogItems
      // and expireQRCodeSquareModifiers's candidate filter.
      if (catalogObject.type === 'ITEM' && catalogObject.item_data?.is_archived !== true) {
        let hasTargetAttribute = false;

        if (catalogObject.custom_attribute_values && typeof catalogObject.custom_attribute_values === 'object') {
          Object.values(catalogObject.custom_attribute_values).forEach(attribute => {
            if (attribute.name === attributeName && attribute.boolean_value === true) {
              hasTargetAttribute = true;
            }
          });
        }

        if (!hasTargetAttribute && catalogObject.item_data?.variations) {
          catalogObject.item_data.variations.forEach(variation => {
            if (variation.custom_attribute_values && typeof variation.custom_attribute_values === 'object') {
              Object.values(variation.custom_attribute_values).forEach(attribute => {
                if (attribute.name === attributeName && attribute.boolean_value === true) {
                  hasTargetAttribute = true;
                }
              });
            }
          });
        }

        if (hasTargetAttribute && catalogObject.item_data?.modifier_list_info) {
          itemsWithAttribute.push(catalogObject);
          catalogObject.item_data.modifier_list_info.forEach(modifierListInfo => {
            modifierListsToProcess.add(modifierListInfo.modifier_list_id);
          });
        }
      }
    });
  }

  console.log(`Found ${itemsWithAttribute.length} items with ${attributeName} = ${attributeValue}`);
  return { items: itemsWithAttribute, modifierLists: modifierListsToProcess };
}

// Parses 'Fri 05-30-2025 3:15 PM (Big Theatre)' or 'Fri 09-08-2025 (Big Theatre)' --
// copied verbatim from expireQRCodeSquareModifiers/src/index.mjs:785-827.
function parseDateFromModifierName(modifierName) {
  try {
    let match = modifierName.match(/^.*?(\d{2}-\d{2}-\d{4}\s+\d{1,2}:\d{2}\s+[AP]M)/);
    let hasTime = true;

    if (!match) {
      match = modifierName.match(/^.*?(\d{2}-\d{2}-\d{4})/);
      hasTime = false;
    }
    if (!match) {
      return null;
    }

    const dateTimeStr = match[1];

    if (hasTime) {
      const [datePart, timePart, ampm] = dateTimeStr.split(' ');
      const [month, day, year] = datePart.split('-');
      const chicagoDateStr = `${month}/${day}/${year} ${timePart} ${ampm}`;
      return new Date(chicagoDateStr + ' GMT-0600');
    } else {
      const [month, day, year] = dateTimeStr.split('-');
      const chicagoDateStr = `${month}/${day}/${year} 11:59 PM GMT-0600`;
      return new Date(chicagoDateStr);
    }
  } catch (error) {
    console.error(`Error parsing date from modifier name "${modifierName}":`, error.message);
    return null;
  }
}

// Extracts venue + descriptors from the parenthetical part of a modifier
// name, e.g. "Sun 05-25-2025 8:00 PM (Little Theatre, Closed Caption)" ->
// { venue: "Little Theatre", descriptors: ["Closed Caption"] }. Mirrors
// getSquareOrders/src/index.mjs's parseItemModifierValues, scoped to just
// the venue/descriptor part since date parsing is parseDateFromModifierName's job here.
function parseVenueAndDescriptors(modifierName) {
  const match = modifierName.match(/\(([^)]+)\)/);
  if (!match) return { venue: null, descriptors: [] };

  const parts = match[1].split(',').map(p => p.trim()).filter(Boolean);
  return { venue: parts[0] || null, descriptors: parts.slice(1) };
}

// =====================================================================
// NEW: campaign anchoring -- turns an item's modifier list into an
// opening date (earliest showtime), a last-showtime boundary (latest
// showtime, the same boundary expireQRCodeSquareModifiers uses to decide
// an item is done and safe to archive), and the full parsed showtime
// list (needed for last-chance-day copy). During-the-run (positive-
// offset) MarketingPost rows never get generated past the boundary.
// =====================================================================

async function getItemShowtimeWindow(item) {
  const modifierListId = item.item_data?.modifier_list_info?.[0]?.modifier_list_id;
  if (!modifierListId) return null;

  const retrieveResult = await retrieveCatalogObject(modifierListId);
  const modifiers = retrieveResult.object?.modifier_list_data?.modifiers;
  if (!modifiers?.length) return null;

  const showtimes = modifiers
    .map(modifier => {
      const name = modifier.modifier_data?.name || '';
      const date = parseDateFromModifierName(name);
      if (!date) return null;
      return { date, ...parseVenueAndDescriptors(name) };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  if (showtimes.length === 0) return null;

  return {
    anchorDate: showtimes[0].date,
    lastShowtimeDate: showtimes[showtimes.length - 1].date,
    showtimes
  };
}

// =====================================================================
// NEW: caption generation. Default path is template-based (free, no API
// call) -- captions are assembled from canned phrases + Square item
// fields. AI-generated captions are opt-in only (MarketingSchedule.
// UseAiCaptions), since an unattended poller auto-generating every
// caption via Claude would mean real recurring spend nobody explicitly
// chose to incur. See the Marquee Engine design doc, Phase 5.
// =====================================================================

const LINK_CHANNELS = new Set(['email', 'facebook']);
const CAPTION_CHAR_LIMITS = { instagram: 2200, tiktok: 2200, facebook: 63000, email: 5000 };

function slugify(title) {
  return (title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function getPurchaseUrl(clientConfig, item) {
  if (!clientConfig.ECOMMERCE_SITE_URL) return null;
  const name = item.item_data?.name || '';
  return `${clientConfig.ECOMMERCE_SITE_URL}/product/${slugify(name)}/${item.id}`;
}

// Square variations are embedded on the item object itself (children of
// item_data, not separate related objects) -- see create-movie-item in
// QRScanner/src/app.mjs, which builds them the same way.
function getPriceRange(item) {
  const amounts = (item.item_data?.variations || [])
    .map(v => v.item_variation_data?.price_money?.amount)
    .filter(a => typeof a === 'number');
  if (amounts.length === 0) return null;

  const min = Math.min(...amounts) / 100;
  const max = Math.max(...amounts) / 100;
  return min === max ? `$${min.toFixed(2)}` : `$${min.toFixed(2)}–$${max.toFixed(2)}`;
}

function formatShowtime(showtime) {
  const time = showtime.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  return showtime.venue ? `${time} (${showtime.venue})` : time;
}

const CAMPAIGN_TEMPLATES = [
  (ctx) => `${ctx.title} is coming to ${ctx.venueName}! ${ctx.priceLine}${ctx.linkLine}`,
  (ctx) => `Don't miss ${ctx.title} at ${ctx.venueName}.${ctx.descriptorLine} ${ctx.priceLine}${ctx.linkLine}`,
  (ctx) => `Now showing: ${ctx.title}. ${ctx.priceLine}${ctx.linkLine}`,
  (ctx) => `${ctx.title} -- grab your tickets before it's gone.${ctx.descriptorLine} ${ctx.priceLine}${ctx.linkLine}`
];

function buildTemplateCaption({ item, channel, clientConfig, scheduledFor, window, templateIndex, isLastChance }) {
  const title = item.item_data?.name || '(untitled)';
  const venueName = clientConfig.WEB_HEADER_COMPANY || 'us';
  const priceRange = getPriceRange(item);
  const priceLine = priceRange ? `Tickets ${priceRange}.` : '';
  const purchaseUrl = getPurchaseUrl(clientConfig, item);
  const linkLine = LINK_CHANNELS.has(channel) && purchaseUrl ? ` Get tickets: ${purchaseUrl}` : (purchaseUrl ? ' Link in bio!' : '');

  const nearestShowtime = (window.showtimes || []).find(s => s.descriptors.length > 0);
  const descriptorLine = nearestShowtime?.descriptors.length ? ` (${nearestShowtime.descriptors.join(', ')})` : '';

  let text;
  if (isLastChance) {
    const sameDayShowtimes = (window.showtimes || []).filter(s =>
      s.date.toDateString() === scheduledFor.toDateString() && s.date >= scheduledFor
    );
    const timesText = sameDayShowtimes.length > 0
      ? sameDayShowtimes.map(formatShowtime).join(', ')
      : 'today';
    text = `Last chance to see ${title} at ${venueName}! Only showing at ${timesText}.${linkLine}`;
  } else {
    const templateFn = CAMPAIGN_TEMPLATES[templateIndex % CAMPAIGN_TEMPLATES.length];
    text = templateFn({ title, venueName, priceLine, linkLine, descriptorLine });
  }

  const limit = CAPTION_CHAR_LIMITS[channel] || 2200;
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

// AI path -- opt-in only, per MarketingSchedule.UseAiCaptions. Reuses the
// exact pattern already fixed in QRScanner/src/app.mjs's Insights feature
// (claude-sonnet-5, raw fetch to /v1/messages).
async function generateAiCaption({ item, channel, clientConfig, scheduledFor, window, isLastChance }) {
  if (!clientConfig.ANTHROPIC_API_KEY) {
    console.warn('UseAiCaptions is on but ANTHROPIC_API_KEY is not configured; falling back to template');
    return buildTemplateCaption({ item, channel, clientConfig, scheduledFor, window, templateIndex: 0, isLastChance });
  }

  const title = item.item_data?.name || '(untitled)';
  const description = item.item_data?.description || '';
  const priceRange = getPriceRange(item);
  const purchaseUrl = getPurchaseUrl(clientConfig, item);
  const linkInstruction = LINK_CHANNELS.has(channel)
    ? `Include this purchase link naturally: ${purchaseUrl || '(no link available)'}`
    : `Do not include a raw URL -- this platform doesn't support clickable links in captions. End with something like "link in bio" instead.`;

  const prompt = `Write a single short promotional social media caption for ${CHANNEL_LABEL(channel)} announcing a movie/event screening.

Title: ${title}
Venue: ${clientConfig.WEB_HEADER_COMPANY || ''}
${priceRange ? `Price: ${priceRange}` : ''}
${description ? `Details: ${description.slice(0, 500)}` : ''}
${isLastChance ? 'This is the LAST DAY this is showing -- convey urgency.' : ''}
${linkInstruction}

Write like a real person at the venue dashing off a quick post, not polished ad copy:
- No rhetorical questions, and skip stock phrases like "don't miss out," "unforgettable experience," or "calling all movie lovers."
- At most one exclamation point total -- plain periods are fine and often better.
- Skip em dashes; use a comma or start a new sentence instead.
- Be concrete (the actual title, venue, date, price) rather than leaning on generic hype words like "incredible" or "amazing."
- Keep it a little understated. It should read like something a person typed, not something generated.

Return ONLY the caption text, no explanation, no markdown, no quotes around it.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': clientConfig.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }
    const data = await response.json();
    const text = data.content?.[0]?.text?.trim();
    if (!text) throw new Error('Empty response from Claude');

    const limit = CAPTION_CHAR_LIMITS[channel] || 2200;
    return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
  } catch (error) {
    console.error('AI caption generation failed, falling back to template:', error.message);
    return buildTemplateCaption({ item, channel, clientConfig, scheduledFor, window, templateIndex: 0, isLastChance });
  }
}

function CHANNEL_LABEL(channel) {
  return { email: 'an email newsletter', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' }[channel] || channel;
}

// =====================================================================
// NEW: schedule expansion. MarketingSchedule.PhaseConfig is stored
// already-expanded (see the Marquee Engine design doc): a list of
// unambiguous day-offsets from the campaign anchor, each with a time of
// day. Expanding "phases" (duration + frequency) into this list is the
// admin UI's job (not yet built), not this Lambda's -- by the time a
// schedule reaches this table it's just:
//   { "offsets": [ { "daysFromAnchor": -28, "time": "11:30" }, ... ] }
// =====================================================================

function computePlannedPostSlots(phaseConfig, anchorDate, lastShowtimeDate) {
  const offsets = phaseConfig?.offsets;
  if (!Array.isArray(offsets)) return [];

  const slots = [];
  for (const offset of offsets) {
    if (typeof offset.daysFromAnchor !== 'number' || !offset.time) continue;

    const [hours, minutes] = offset.time.split(':').map(Number);
    const scheduledFor = new Date(anchorDate);
    scheduledFor.setDate(scheduledFor.getDate() + offset.daysFromAnchor);
    scheduledFor.setHours(hours, minutes, 0, 0);

    // Bound during-the-run (positive-offset) slots by the item's actual
    // last showtime -- there's nothing left to promote after that.
    if (scheduledFor > lastShowtimeDate) continue;

    slots.push(scheduledFor);
  }
  return slots;
}

// =====================================================================
// NEW: per-client processing
// =====================================================================

async function upsertPlannedPosts(pgClient, squareItemId, channel, plannedPosts) {
  let inserted = 0;
  for (const { scheduledFor, caption, imageUrl } of plannedPosts) {
    const result = await pgClient.query(
      `INSERT INTO "MarketingPost" ("SquareItemID", "Channel", "PostType", "ScheduledFor", "Status", "PostContent")
       VALUES ($1, $2, 'campaign', $3, 'draft', $4)
       ON CONFLICT ("SquareItemID", "Channel", "PostType", "ScheduledFor") DO NOTHING
       RETURNING "ID"`,
      [squareItemId, channel, scheduledFor, JSON.stringify({ caption, imageUrl })]
    );
    inserted += result.rows.length;
  }
  return inserted;
}

// Resolves a Square item's existing catalog image to a URL at draft-creation
// time -- reuses the same retrieveCatalogObject helper used for showtime
// windows, just pointed at the item's image_ids[0] instead of a modifier
// list. Returns null (not thrown) on any failure -- a missing image
// shouldn't block draft generation.
async function resolveItemImageUrl(item) {
  const imageId = item.item_data?.image_ids?.[0];
  if (!imageId) return null;
  try {
    const result = await retrieveCatalogObject(imageId);
    return result.object?.image_data?.url || null;
  } catch (error) {
    console.warn(`Could not resolve image for item ${item.id}:`, error.message);
    return null;
  }
}

// =====================================================================
// NEW: weekly digest -- a day-by-day "what's playing" roundup, distinct
// from per-item campaign posts. Generated at most once per configured
// week (gated on today being DIGEST_DAY_OF_WEEK and the current Chicago
// time being at/past DIGEST_TIME; the unique (SquareItemID, Channel,
// PostType, ScheduledFor) constraint, with a fixed 'digest' sentinel for
// SquareItemID since a digest isn't about one item, makes repeat poller
// ticks the same day a safe no-op). Image is a background (uploaded via
// the admin UI, scaled to fit within DIGEST_MAX_DIMENSION on its longer
// side -- any aspect ratio, never cropped) with the day/event grid drawn
// on top as an SVG sized to match the background's actual dimensions,
// composited with sharp -- same library used for every other image
// operation in this platform.
// =====================================================================

// Defensive cap only (2026-10-26) -- the admin-upload path in QRScanner's
// app.mjs already scales to fit within this, but generateDigestImage
// re-applies it in case DIGEST_BACKGROUND_IMAGE_URL is ever set some other
// way. No longer forces a square crop: the overlay is sized to whatever
// shape results, read back from the image itself (see generateDigestImage),
// not assumed from a constant. DIGEST_DEFAULT_CANVAS_SIZE below is the
// unrelated fallback used only when no background image is set at all.
const DIGEST_MAX_DIMENSION = 1024;
const DIGEST_DEFAULT_CANVAS_SIZE = 1080;

// Chicago "now", via Intl so this is correct regardless of the Lambda
// process's own timezone (always UTC) and regardless of DST -- unlike the
// GMT-0600-hardcoded Date construction in parseDateFromModifierName above,
// which only this function's siblings (getChicagoDateParts,
// formatChicagoTime12h) need to stay consistent with for display purposes.
function getChicagoNow() {
  return getChicagoDateParts(new Date(), true);
}

function getChicagoDateParts(date, withWeekday = false) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    ...(withWeekday ? { weekday: 'long' } : {}),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  if (map.hour === '24') map.hour = '00'; // Intl quirk: midnight can come back as "24" with hour12:false
  return map;
}

function formatChicagoTime12h(date) {
  return date.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
}

// Pure calendar-date arithmetic via Date.UTC, carefully not mixed with any
// local-timezone Date methods -- avoids the whole class of bug the
// ScheduledFor display fix (QRScanner's marketing.js) had to work around.
function addDaysToYMD(year, month, day, deltaDays) {
  const base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + deltaDays);
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

function escapeSvgText(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Days-of-week grid as an SVG: day label in a left column, each distinct
// title that day gets its OWN line in the right column -- title **bold**,
// its showtimes *italic and not bold* by default ("**Movie One** @
// _5:30, 7:30_" / "**Movie Two** @ _3:30, 4:10_" stacked, not crammed onto
// one line), size and bold/not-bold independently configurable per field
// (dateStyle/eventStyle/timeStyle -- times stay italic regardless, that's
// what visually separates them from the title, not configurable) -- the
// whole two-column block is centered both vertically AND horizontally
// within the area inside `bounds` (pixels inset from each edge of the
// background image's own actual width/height, passed in -- not a fixed
// square), rather than always being left-anchored and stretched to fill
// the full width regardless of how little text there actually is.
// Optional headerText/footerText (own styling, own IN_IMAGE/IN_CAPTION
// config gate applied by the caller -- this function just draws whatever
// text it's given) sit at fixed positions at the top/bottom of the area,
// horizontally centered on their own; the day/event grid is vertically
// centered in whatever space is left between them, not the full area.
// White text with a black outline keeps it legible over an arbitrary
// background color. No text-WRAPPING within a line (SVG has none built in
// without a real layout engine) -- an individual line still truncates if
// it's extremely long (e.g. a title with many showtimes).
function buildDigestSvg({ bounds, dayEntries, width, height, dateStyle, eventStyle, timeStyle, headerText, headerStyle, footerText, footerStyle }) {
  const top = bounds?.top || 0;
  const right = bounds?.right || 0;
  const bottom = bounds?.bottom || 0;
  const left = bounds?.left || 0;

  const areaWidth = Math.max(width - left - right, 10);
  const areaHeight = Math.max(height - top - bottom, 10);

  // Rough average glyph width for a given font size -- there's no real
  // text-measurement available in this SVG-only, no-DOM Lambda
  // environment, so this heuristic drives all the width/truncation/
  // centering math below. Bold glyphs render noticeably wider than
  // regular at the same size (confirmed visually -- an earlier version
  // used one flat 0.55 multiplier for everything, including always-bold
  // text, and columns ended up overlapping with zero gap as a result), so
  // bold text gets its own, wider estimate.
  const charW = (size) => size * 0.55;
  const charWBold = (size) => size * 0.68;

  // DejaVu Sans, not Electrolize -- confirmed via a full repro of the real
  // Lambda environment (same sharp/libvips build, same fontconfig setup,
  // Docker + public.ecr.aws/lambda/nodejs:22) that Electrolize-Regular.ttf
  // is the ONLY Electrolize weight bundled (no bold/italic face exists for
  // it at all). Once title/showtime styling needed real bold + italic
  // (2026-10-26), that stopped working: fontconfig resolves "Electrolize"
  // successfully for plain text, but when a <tspan> asks for font-weight
  // 700 or font-style italic, this environment's font-family fallback does
  // NOT cascade to the next name in the list for just the missing style --
  // it silently renders at Electrolize's one regular weight instead of
  // trying DejaVu Sans next, even though DejaVu Sans has correctly-matched
  // bold/oblique faces bundled. Leading with "DejaVu Sans" (which has all
  // four weight/style combinations) fixed it; verified bold/italic both
  // render correctly with this single-name-first ordering in the same
  // repro. The minimal fonts.conf set up at module load doesn't include
  // generic-family (sans-serif) alias rules, so naming an installed font
  // directly is what actually resolves either way.
  const textAttrs = `font-family="DejaVu Sans, Helvetica, Arial, sans-serif" fill="#ffffff" stroke="#000000" stroke-width="2" style="paint-order: stroke;"`;

  // ---- Header / footer: optional static text, own styling, single line,
  // horizontally centered independently of the day/event grid below. ----
  const headerFontSize = Math.max(Number(headerStyle?.fontSize) || 16, 1);
  const headerBold = headerStyle?.bold !== false; // default true
  const footerFontSize = Math.max(Number(footerStyle?.fontSize) || 16, 1);
  const footerBold = footerStyle?.bold !== false; // default true

  // Word-wraps onto as many lines as needed to fit areaWidth -- no
  // ellipsis/truncation for header/footer text, a line break instead.
  // Only a single word that's wider than the whole area on its own still
  // can't be split further (no mid-word hyphenation), so that one line is
  // left as-is rather than silently dropping part of it.
  function wrapToLines(text, fontSize, bold) {
    const w = bold ? charWBold(fontSize) : charW(fontSize);
    const maxChars = Math.max(5, Math.floor(areaWidth / w));
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length > maxChars && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    return lines.length ? lines : [''];
  }

  // Centered via SVG's own text-anchor="middle" at a fixed x, not a
  // manually-computed x from the char-width heuristic -- that heuristic
  // is only an *average* glyph width estimate (needed for deciding where
  // to wrap a line, where being approximate is harmless), and using it to
  // also compute each line's centering offset was visibly off for lines
  // whose actual letter mix didn't match the average. text-anchor lets
  // the renderer center against the real glyph widths it already knows.
  const centerX = left + areaWidth / 2;

  const headerLineHeight = headerFontSize * 1.3;
  const headerLines = headerText ? wrapToLines(headerText, headerFontSize, headerBold) : [];
  const headerBlockHeight = headerLines.length * headerLineHeight;
  const headerGap = headerLines.length ? headerFontSize * 0.6 : 0;

  const footerLineHeight = footerFontSize * 1.3;
  const footerLines = footerText ? wrapToLines(footerText, footerFontSize, footerBold) : [];
  const footerBlockHeight = footerLines.length * footerLineHeight;
  const footerGap = footerLines.length ? footerFontSize * 0.6 : 0;

  const headerSvg = headerLines.map((line, i) => {
    const y = top + headerLineHeight * i + headerLineHeight / 2;
    return `<text x="${centerX}" y="${y}" text-anchor="middle" font-size="${headerFontSize}" font-weight="${headerBold ? 700 : 400}" dominant-baseline="middle" ${textAttrs}>${escapeSvgText(line)}</text>`;
  }).join('');

  // Footer grows upward from the bottom bound as more lines are needed,
  // rather than downward off the canvas.
  const footerBlockTop = height - bottom - footerBlockHeight;
  const footerSvg = footerLines.map((line, i) => {
    const y = footerBlockTop + footerLineHeight * i + footerLineHeight / 2;
    return `<text x="${centerX}" y="${y}" text-anchor="middle" font-size="${footerFontSize}" font-weight="${footerBold ? 700 : 400}" dominant-baseline="middle" ${textAttrs}>${escapeSvgText(line)}</text>`;
  }).join('');

  // ---- Day/event grid -- confined to whatever space is left between the
  // header and footer zones, not the full area. ----
  const gridTop = top + headerBlockHeight + headerGap;
  const gridAreaHeight = Math.max(areaHeight - headerBlockHeight - headerGap - footerBlockHeight - footerGap, 10);

  // Normalize to {title, times} pairs -- 'Nothing scheduled' is a plain
  // placeholder line (no title to bold), not a real title/times pair.
  const rowsData = dayEntries.map(entry => ({
    entry,
    lines: entry.eventEntries && entry.eventEntries.length
      ? entry.eventEntries
      : [{ title: '', times: 'Nothing scheduled' }]
  }));

  // Day label shares its row with the first event line; every other event
  // for that day gets its own row, lined up under the event column (not
  // the date); one blank row separates each day from the next.
  const totalRows = rowsData.reduce((sum, d) => sum + Math.max(1, d.lines.length), 0)
    + Math.max(0, rowsData.length - 1);

  // Each field's size defaults to what the overlay used before these
  // became configurable. Bold defaults match the prior hardcoded
  // behavior too: date and title were always bold, times were not.
  let dateFontSize = Math.max(Number(dateStyle?.fontSize) || 16, 1);
  let eventFontSize = Math.max(Number(eventStyle?.fontSize) || 14, 1);
  let timeFontSize = Math.max(Number(timeStyle?.fontSize) || 14, 1);
  const dateBold = dateStyle?.bold !== false; // default true
  const eventBold = eventStyle?.bold !== false; // default true
  const timeBold = timeStyle?.bold === true; // default false

  // Fixed, natural line height -- NOT gridAreaHeight / totalRows.
  // Stretching row height to fill whatever space was available (an
  // earlier approach) made gaps between lines balloon on any
  // lightly-booked week; a light week should just leave the bottom of the
  // canvas empty, not spread its few lines across the whole thing. Only
  // shrink below this baseline if a genuinely packed week wouldn't
  // otherwise fit -- all three configured sizes scale down together,
  // proportionally, so their relative sizing is preserved.
  let rowHeight = Math.max(dateFontSize, eventFontSize, timeFontSize) * 1.3;
  const neededHeight = totalRows * rowHeight;
  if (neededHeight > gridAreaHeight) {
    const scale = gridAreaHeight / neededHeight;
    dateFontSize *= scale;
    eventFontSize *= scale;
    timeFontSize *= scale;
    rowHeight *= scale;
  }
  dateFontSize = Math.max(8, dateFontSize);
  eventFontSize = Math.max(8, eventFontSize);
  timeFontSize = Math.max(8, timeFontSize);

  // Day-label column sized to the widest label actually being shown, not
  // a fixed fraction of areaWidth -- a short label ("Mon") shouldn't force
  // a big gap before the event text starts. Extra margin in colGap is
  // deliberate -- the width heuristic is approximate, and a
  // slightly-too-wide gap reads better than overlapping text.
  const labelWidth = Math.max(...rowsData.map(d => (dateBold ? charWBold(dateFontSize) : charW(dateFontSize)) * d.entry.label.length), 1);
  const colGap = charW(eventFontSize) * 2.5;
  const leftColWidth = labelWidth + colGap;

  // Event column gets whatever's left of areaWidth; a line that still
  // doesn't fit gets truncated with an ellipsis, same as before. Sized
  // against whichever of title/times renders wider at its configured
  // size+weight (conservative/undercounts available characters when
  // they differ) -- better to truncate a touch early than let either
  // overflow past the canvas edge.
  const availableEventWidth = Math.max(areaWidth - leftColWidth, 10);
  const eventCharW = eventBold ? charWBold(eventFontSize) : charW(eventFontSize);
  const timeCharW = timeBold ? charWBold(timeFontSize) : charW(timeFontSize);
  const maxLineChars = Math.max(10, Math.floor(availableEventWidth / Math.max(eventCharW, timeCharW)));

  // Truncation budget is the same "title @ times" combined length as
  // before truncation existed per-field; measure the widest line actually
  // being shown (post-truncation) so a compact week's table can be
  // centered as a block instead of always stretching/left-anchoring to
  // the full areaWidth. Title portion measured at the event field's
  // width, the rest (separator + times) at the time field's width,
  // matching how the line actually renders.
  let widestLineWidth = 0;
  for (const { lines } of rowsData) {
    for (const evt of lines) {
      if (!evt.title) {
        const shownLen = Math.min(evt.times.length, maxLineChars);
        widestLineWidth = Math.max(widestLineWidth, timeCharW * shownLen);
        continue;
      }
      const full = `${evt.title} @ ${evt.times}`;
      const shownLen = Math.min(full.length, maxLineChars);
      const titleLen = Math.min(evt.title.length, shownLen);
      const restLen = shownLen - titleLen;
      widestLineWidth = Math.max(widestLineWidth, eventCharW * titleLen + timeCharW * restLen);
    }
  }

  const blockWidth = Math.min(leftColWidth + widestLineWidth, areaWidth);
  const blockLeft = left + Math.max(0, (areaWidth - blockWidth) / 2);

  // Center the content block vertically in the grid's own space rather
  // than always starting at its top, now that it won't necessarily fill
  // it.
  const contentHeight = totalRows * rowHeight;
  const startY = gridTop + Math.max(0, (gridAreaHeight - contentHeight) / 2);

  let cursorY = startY;
  const rows = rowsData.map(({ entry, lines }, dayIndex) => {
    const lineSvgs = lines.map((evt, i) => {
      const y = cursorY + rowHeight / 2;
      cursorY += rowHeight;

      const dayLabelSvg = i === 0
        ? `<text x="${blockLeft}" y="${y}" font-size="${dateFontSize}" font-weight="${dateBold ? 700 : 400}" dominant-baseline="middle" ${textAttrs}>${escapeSvgText(entry.label)}</text>`
        : '';
      const eventX = blockLeft + leftColWidth;

      if (!evt.title) {
        // Placeholder ("Nothing scheduled") -- plain text, no bold/italic.
        let text = evt.times;
        if (text.length > maxLineChars) text = text.slice(0, maxLineChars - 1) + '…';
        return dayLabelSvg + `<text x="${eventX}" y="${y}" font-size="${timeFontSize}" dominant-baseline="middle" ${textAttrs}>${escapeSvgText(text)}</text>`;
      }

      // Truncate the combined "Title @ times" text the same way as
      // before, then split the (possibly truncated) result back into
      // title/times pieces so each can get its own size/weight/style.
      const separator = ' @ ';
      const full = `${evt.title}${separator}${evt.times}`;
      let shownTitle = evt.title;
      let shownTimes = evt.times;
      if (full.length > maxLineChars) {
        const truncated = full.slice(0, maxLineChars - 1) + '…';
        const sepIndex = truncated.indexOf(separator);
        if (sepIndex === -1) {
          // Truncation landed inside the title itself -- no room left to
          // show any times.
          shownTitle = truncated;
          shownTimes = '';
        } else {
          shownTitle = truncated.slice(0, sepIndex);
          shownTimes = truncated.slice(sepIndex + separator.length);
        }
      }

      const eventSvg = `<text x="${eventX}" y="${y}" dominant-baseline="middle" ${textAttrs}>` +
        `<tspan font-size="${eventFontSize}" font-weight="${eventBold ? 700 : 400}">${escapeSvgText(shownTitle)}</tspan>` +
        (shownTimes
          ? `<tspan font-size="${timeFontSize}" xml:space="preserve"> @ </tspan>` +
            `<tspan font-size="${timeFontSize}" font-weight="${timeBold ? 700 : 400}" font-style="italic">${escapeSvgText(shownTimes)}</tspan>`
          : '') +
        `</text>`;

      return dayLabelSvg + eventSvg;
    }).join('');

    if (dayIndex < rowsData.length - 1) cursorY += rowHeight; // blank row between days
    return lineSvgs;
  }).join('');

  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${headerSvg}${rows}${footerSvg}</svg>`;
}

async function generateDigestImage({ backgroundImageUrl, bounds, dayEntries, dateStyle, eventStyle, timeStyle, headerText, headerStyle, footerText, footerStyle }) {
  let backgroundBuffer, width, height;

  if (backgroundImageUrl) {
    const response = await fetch(backgroundImageUrl);
    if (!response.ok) throw new Error(`Failed to fetch digest background: ${response.status}`);
    const rawBuffer = Buffer.from(await response.arrayBuffer());
    // Defensive re-normalize even though the admin-upload path already caps
    // to DIGEST_MAX_DIMENSION -- cheap, and keeps this function correct even
    // if DIGEST_BACKGROUND_IMAGE_URL is ever set some other way. No crop:
    // whatever shape results is what the overlay gets built against, read
    // back from the actual image below rather than assumed.
    backgroundBuffer = await sharp(rawBuffer)
      .resize(DIGEST_MAX_DIMENSION, DIGEST_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .jpeg()
      .toBuffer();
    const meta = await sharp(backgroundBuffer).metadata();
    width = meta.width;
    height = meta.height;
  } else {
    width = DIGEST_DEFAULT_CANVAS_SIZE;
    height = DIGEST_DEFAULT_CANVAS_SIZE;
    backgroundBuffer = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } }
    }).jpeg().toBuffer();
  }

  const svgBuffer = Buffer.from(buildDigestSvg({ bounds, dayEntries, width, height, dateStyle, eventStyle, timeStyle, headerText, headerStyle, footerText, footerStyle }));

  return sharp(backgroundBuffer)
    .composite([{ input: svgBuffer, top: 0, left: 0 }])
    .withMetadata({ density: 72 })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function uploadDigestImageToS3(buffer, clientConfig, clientId, dateStr) {
  const region = process.env.AWS_REGION || 'us-east-2';
  const bucketName = `${clientConfig.S3_BUCKET_PREFIX}${clientId.toLowerCase()}`;
  // Date-only keys meant any same-day regeneration (a manual re-test, or a
  // DIGEST_TIME change after an earlier send that day) would silently
  // overwrite the image file an already-SENT post's history points at.
  // Date.now() keeps every generation its own object.
  const key = `digest-generated/digest_${dateStr}_${Date.now()}.jpg`;

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg'
  }));

  return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}

async function generateDigestPost(pgClient, clientConfig, clientId) {
  const digestEnabled = clientConfig.DIGEST_ENABLED === true || clientConfig.DIGEST_ENABLED === 'true';
  if (!digestEnabled) return 0;

  const now = getChicagoNow();
  const configuredDay = (clientConfig.DIGEST_DAY_OF_WEEK || 'monday').toLowerCase();
  if (now.weekday.toLowerCase() !== configuredDay) return 0;

  const configuredTime = clientConfig.DIGEST_TIME || '10:00';
  if (`${now.hour}:${now.minute}` < configuredTime) return 0;

  const attributeName = clientConfig.USE_QR_CODE || 'UseQRCode';
  const attributeValue = clientConfig.USE_QR_CODE_VALUE || 'true';
  const targetCategories = clientConfig.TARGET_CATEGORIES
    ? clientConfig.TARGET_CATEGORIES.split(',').map(cat => cat.trim())
    : ['Cinema', 'Events'];
  const catalogData = await getItemsByCategoryNames(targetCategories);
  const { items } = filterItemsByCustomAttribute(catalogData, attributeName, attributeValue);

  const todayY = Number(now.year), todayM = Number(now.month), todayD = Number(now.day);
  const dayEntries = [];
  for (let i = 0; i < 7; i++) {
    const { year, month, day } = addDaysToYMD(todayY, todayM, todayD, i);
    const label = new Date(Date.UTC(year, month - 1, day))
      .toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'numeric', day: 'numeric' });
    // titleTimes groups this day's showtimes by title, so "Movie One @
    // 5:30, 7:30, 9:30" is one line instead of three separate ones.
    dayEntries.push({ year, month, day, label, titleTimes: new Map() });
  }

  for (const item of items) {
    const window = await getItemShowtimeWindow(item);
    if (!window) continue;
    const title = item.item_data?.name || '(untitled)';
    for (const showtime of window.showtimes) {
      const parts = getChicagoDateParts(showtime.date);
      const entry = dayEntries.find(d => d.year === Number(parts.year) && d.month === Number(parts.month) && d.day === Number(parts.day));
      if (!entry) continue;
      if (!entry.titleTimes.has(title)) entry.titleTimes.set(title, []);
      entry.titleTimes.get(title).push(formatChicagoTime12h(showtime.date));
    }
  }

  // One entry per distinct title that day -- {title, times}, e.g.
  // { title: 'Movie One', times: '5:30 PM, 7:30 PM' }. buildDigestSvg uses
  // this structure to bold the title and italicize the times separately;
  // the plain-text caption below just joins them back into one string.
  for (const entry of dayEntries) {
    entry.eventEntries = Array.from(entry.titleTimes.entries()).map(([title, times]) => ({ title, times: times.join(', ') }));
  }

  // Only show days with something actually playing -- a 7-row grid full of
  // "Nothing scheduled" wasn't useful.
  const activeDayEntries = dayEntries.filter(d => d.eventEntries.length > 0);

  // Mirrors the image layout: date shares its line with the first event,
  // later events for that day indent to line up under the event text (not
  // the date), and a blank line separates each day.
  let captionText = activeDayEntries.length
    ? activeDayEntries.map(d => {
        const indent = ' '.repeat(d.label.length + 2);
        return d.eventEntries.map((evt, i) => {
          const line = `${evt.title} @ ${evt.times}`;
          return i === 0 ? `${d.label}  ${line}` : `${indent}${line}`;
        }).join('\n');
      }).join('\n\n')
    : 'Nothing scheduled this week.';

  // buildDigestSvg divides the available height by total line count --
  // fall back to a single placeholder line rather than dividing by zero on
  // a week with nothing scheduled at all.
  const svgDayEntries = activeDayEntries.length
    ? activeDayEntries
    : [{ label: 'This week', eventEntries: [{ title: '', times: 'Nothing scheduled' }] }];

  // Per-field size/weight, same "check both true and 'true'" convention as
  // every other boolean config value in this platform (Postgres JSON
  // booleans and JSON strings are both possible depending on how the
  // config was written -- see README). Times default to NOT bold
  // (isTrue, opt-in); date/event/header/footer default to bold (isFalse,
  // opt-out) -- matches what the overlay already looked like before any
  // of this was configurable.
  const isTrue = (v) => v === true || v === 'true';
  const isFalse = (v) => v === false || v === 'false';
  const dateStyle = { fontSize: clientConfig.DIGEST_DATE_FONT_SIZE, bold: !isFalse(clientConfig.DIGEST_DATE_BOLD) };
  const eventStyle = { fontSize: clientConfig.DIGEST_EVENT_FONT_SIZE, bold: !isFalse(clientConfig.DIGEST_EVENT_BOLD) };
  const timeStyle = { fontSize: clientConfig.DIGEST_TIME_FONT_SIZE, bold: isTrue(clientConfig.DIGEST_TIME_BOLD) };
  const headerStyle = { fontSize: clientConfig.DIGEST_HEADER_FONT_SIZE, bold: !isFalse(clientConfig.DIGEST_HEADER_BOLD) };
  const footerStyle = { fontSize: clientConfig.DIGEST_FOOTER_FONT_SIZE, bold: !isFalse(clientConfig.DIGEST_FOOTER_BOLD) };

  const headerTextTrimmed = (clientConfig.DIGEST_HEADER_TEXT || '').trim();
  const footerTextTrimmed = (clientConfig.DIGEST_FOOTER_TEXT || '').trim();
  const headerInImage = headerTextTrimmed && isTrue(clientConfig.DIGEST_HEADER_IN_IMAGE);
  const footerInImage = footerTextTrimmed && isTrue(clientConfig.DIGEST_FOOTER_IN_IMAGE);
  const headerInCaption = headerTextTrimmed && isTrue(clientConfig.DIGEST_HEADER_IN_CAPTION);
  const footerInCaption = footerTextTrimmed && isTrue(clientConfig.DIGEST_FOOTER_IN_CAPTION);

  // Caption is the plain-text version sent for every channel (email,
  // Facebook, Instagram, TikTok all share one caption -- there's no
  // per-channel text), independent of whether the same text is also
  // drawn into the image.
  if (headerInCaption) captionText = `${headerTextTrimmed}\n\n${captionText}`;
  if (footerInCaption) captionText = `${captionText}\n\n${footerTextTrimmed}`;

  let imageUrl = null;
  try {
    const imageBuffer = await generateDigestImage({
      backgroundImageUrl: clientConfig.DIGEST_BACKGROUND_IMAGE_URL,
      bounds: clientConfig.DIGEST_TEXT_BOUNDS,
      dayEntries: svgDayEntries,
      dateStyle, eventStyle, timeStyle,
      headerText: headerInImage ? headerTextTrimmed : null,
      headerStyle,
      footerText: footerInImage ? footerTextTrimmed : null,
      footerStyle
    });
    imageUrl = await uploadDigestImageToS3(imageBuffer, clientConfig, clientId, `${now.year}-${now.month}-${now.day}`);
  } catch (error) {
    console.error('Error generating digest image:', error);
  }

  const scheduledForStr = `${now.year}-${now.month}-${now.day} ${configuredTime}:00`;
  const channels = Array.isArray(clientConfig.DIGEST_CHANNELS) && clientConfig.DIGEST_CHANNELS.length
    ? clientConfig.DIGEST_CHANNELS
    : ['email'];

  let inserted = 0;
  for (const channel of channels) {
    const result = await pgClient.query(
      `INSERT INTO "MarketingPost" ("SquareItemID", "Channel", "PostType", "ScheduledFor", "Status", "PostContent")
       VALUES ('digest', $1, 'digest', $2, 'draft', $3)
       ON CONFLICT ("SquareItemID", "Channel", "PostType", "ScheduledFor") DO NOTHING
       RETURNING "ID"`,
      [channel, scheduledForStr, JSON.stringify({ caption: captionText, imageUrl })]
    );
    inserted += result.rows.length;
  }

  console.log(`Generated ${inserted} digest post(s)`);
  return inserted;
}

async function generatePlannedPosts(pgClient, clientConfig) {
  const attributeName = clientConfig.USE_QR_CODE || 'UseQRCode';
  const attributeValue = clientConfig.USE_QR_CODE_VALUE || 'true';
  const targetCategories = clientConfig.TARGET_CATEGORIES
    ? clientConfig.TARGET_CATEGORIES.split(',').map(cat => cat.trim())
    : ['Cinema', 'Events'];

  const catalogData = await getItemsByCategoryNames(targetCategories);
  const { items } = filterItemsByCustomAttribute(catalogData, attributeName, attributeValue);

  let totalInserted = 0;
  for (const item of items) {
    const schedulesResult = await pgClient.query(
      `SELECT "Channel", "PhaseConfig", "UseAiCaptions" FROM "MarketingSchedule"
       WHERE "SquareItemID" = $1 AND "Enabled" = true`,
      [item.id]
    );
    if (schedulesResult.rows.length === 0) continue;

    const window = await getItemShowtimeWindow(item);
    if (!window) {
      console.log(`Item ${item.id} (${item.item_data?.name}) has no parseable showtimes, skipping`);
      continue;
    }

    const imageUrl = await resolveItemImageUrl(item);

    for (const schedule of schedulesResult.rows) {
      const slots = computePlannedPostSlots(schedule.PhaseConfig, window.anchorDate, window.lastShowtimeDate);

      const plannedPosts = [];
      for (let i = 0; i < slots.length; i++) {
        const scheduledFor = slots[i];
        // Last-chance-day content rule: the post lands on the same
        // calendar day as the item's actual last showtime -- name the
        // remaining showtimes instead of generic copy. No new trigger,
        // just a different content path for whichever post happens to
        // land there (see design doc's "Also In Scope").
        const isLastChance = scheduledFor.toDateString() === window.lastShowtimeDate.toDateString();

        const captionArgs = { item, channel: schedule.Channel, clientConfig, scheduledFor, window, isLastChance };
        const caption = schedule.UseAiCaptions
          ? await generateAiCaption(captionArgs)
          : buildTemplateCaption({ ...captionArgs, templateIndex: i });

        plannedPosts.push({ scheduledFor, caption, imageUrl });
      }

      const inserted = await upsertPlannedPosts(pgClient, item.id, schedule.Channel, plannedPosts);
      totalInserted += inserted;
    }
  }

  console.log(`Generated ${totalInserted} new planned MarketingPost rows`);
  return totalInserted;
}

// Sends one due, approved post -- facebook/instagram/tiktok only (email is
// excluded in sendDuePosts' query above). Real platform APIs (Meta Graph
// API, TikTok Content Posting API) aren't wired up yet -- this is a
// dry-run stub so the poller can deploy and run safely before any client
// has real platform credentials. Phase 6 replaces this with real senders
// for those three, gated on the relevant credential fields being populated.
// =====================================================================
// NEW: real social senders (Phase 6). Each one is gated on that channel's
// credentials actually being populated in Client.configuration -- until a
// client's platform app approval comes through and someone drops the real
// tokens in, sendDuePost() below falls back to the original dry-run stub,
// so this is safe to ship for every client right now. API shapes verified
// against current official docs (graph.facebook.com v26.0; TikTok Content
// Posting API v2) on 2026-10-19 -- nobody has live credentials to test
// against yet, so treat the exact field names as "correct per docs," not
// "battle-tested," until a client actually posts for real.
// =====================================================================

const META_GRAPH_API_VERSION = 'v26.0';

async function sendFacebookPost(post) {
  const caption = post.PostContent?.caption || '';
  const imageUrl = post.PostContent?.imageUrl;
  const pageId = currentClientConfig.META_PAGE_ID;
  const token = currentClientConfig.META_PAGE_ACCESS_TOKEN;

  // With an image, /photos (caption goes on the photo); without one,
  // /feed (plain text post) -- a digest with no background configured
  // still has no imageUrl, this keeps that case postable instead of failing.
  const endpoint = imageUrl
    ? `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/photos`
    : `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${pageId}/feed`;
  const body = new URLSearchParams({
    access_token: token,
    ...(imageUrl ? { url: imageUrl, caption } : { message: caption })
  });

  const response = await fetch(endpoint, { method: 'POST', body });
  const data = await response.json();
  if (!response.ok) throw new Error(`Facebook post failed: ${JSON.stringify(data.error || data)}`);
  return { platformPostId: data.post_id || data.id, facebookResponse: data };
}

async function sendInstagramPost(post) {
  const caption = post.PostContent?.caption || '';
  const imageUrl = post.PostContent?.imageUrl;
  const igUserId = currentClientConfig.META_IG_BUSINESS_ID;
  const token = currentClientConfig.META_PAGE_ACCESS_TOKEN;

  if (!imageUrl) {
    throw new Error('Instagram requires an image and this post has none (no digest background configured, or the source item has no Square image)');
  }

  const containerResponse = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${igUserId}/media`, {
    method: 'POST',
    body: new URLSearchParams({ image_url: imageUrl, caption, access_token: token })
  });
  const containerData = await containerResponse.json();
  if (!containerResponse.ok) throw new Error(`Instagram container creation failed: ${JSON.stringify(containerData.error || containerData)}`);
  const creationId = containerData.id;

  // Image containers are usually ready almost immediately, but Meta's own
  // guidance is to poll status_code before publishing rather than assume --
  // a handful of quick retries, not a long wait.
  for (let attempt = 0; attempt < 5; attempt++) {
    const statusResponse = await fetch(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${creationId}?fields=status_code&access_token=${encodeURIComponent(token)}`
    );
    const statusData = await statusResponse.json();
    if (statusData.status_code === 'FINISHED') break;
    if (statusData.status_code === 'ERROR') throw new Error(`Instagram container processing failed: ${JSON.stringify(statusData)}`);
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  const publishResponse = await fetch(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/${igUserId}/media_publish`, {
    method: 'POST',
    body: new URLSearchParams({ creation_id: creationId, access_token: token })
  });
  const publishData = await publishResponse.json();
  if (!publishResponse.ok) throw new Error(`Instagram publish failed: ${JSON.stringify(publishData.error || publishData)}`);

  return { platformPostId: publishData.id, instagramResponse: publishData };
}

// TikTok access tokens expire in ~24h; the refresh token lasts ~365 days
// but ROTATES on every redemption -- the refresh token just used is dead
// the instant this call succeeds, so the new access_token + refresh_token
// pair must be persisted immediately, or the next refresh attempt fails
// with a now-invalid token. Refreshing unconditionally before every send
// (rather than tracking an expiry timestamp) avoids clock-skew
// bookkeeping -- TikTok allows refreshing a still-valid token early, and
// Marquee Engine's TikTok send volume is low enough that one extra call
// per post is a non-issue. No-ops (falls back to the static
// TIKTOK_ACCESS_TOKEN as before) if the client hasn't set up the OAuth
// app credentials yet.
async function refreshTikTokToken(pgClient, clientId) {
  const clientKey = currentClientConfig.TIKTOK_CLIENT_KEY;
  const clientSecret = currentClientConfig.TIKTOK_CLIENT_SECRET;
  const refreshToken = currentClientConfig.TIKTOK_REFRESH_TOKEN;

  if (!clientKey || !clientSecret || !refreshToken) {
    return;
  }

  const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });
  const data = await response.json();
  // TikTok's token endpoint returns 200 with an error payload on some
  // failure modes rather than a non-2xx status, so check both.
  if (!response.ok || data.error) {
    // Most likely cause: the refresh token itself expired (~365 days) or
    // was already redeemed by a previous/concurrent run -- either way
    // this needs a human to redo TikTok's OAuth flow, not a retry.
    throw new Error(`TikTok token refresh failed: ${JSON.stringify(data.error || data)}`);
  }

  currentClientConfig.TIKTOK_ACCESS_TOKEN = data.access_token;
  currentClientConfig.TIKTOK_REFRESH_TOKEN = data.refresh_token;

  await pgClient.query(
    `UPDATE "Client" SET "configuration" = "configuration"::jsonb || $1::jsonb, "updatedDate" = CURRENT_TIMESTAMP`,
    [JSON.stringify({ TIKTOK_ACCESS_TOKEN: data.access_token, TIKTOK_REFRESH_TOKEN: data.refresh_token })]
  );
  console.log(`TikTok token refreshed for client ${clientId}`);
}

async function sendTikTokPost(pgClient, post, clientId) {
  await refreshTikTokToken(pgClient, clientId);

  const caption = post.PostContent?.caption || '';
  const imageUrl = post.PostContent?.imageUrl;
  const token = currentClientConfig.TIKTOK_ACCESS_TOKEN;

  if (!imageUrl) {
    throw new Error('TikTok requires an image and this post has none (no digest background configured, or the source item has no Square image)');
  }

  // Required before every post per TikTok's Content Posting API docs --
  // an app that hasn't finished platform review is often restricted to a
  // narrower privacy_level_options list (e.g. SELF_ONLY only); the value
  // sent below must be one TikTok actually offered this creator+app pair.
  const creatorInfoResponse = await fetch('https://open.tiktokapis.com/v2/post/creator_info/query/', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' }
  });
  const creatorInfo = await creatorInfoResponse.json();
  if (!creatorInfoResponse.ok) throw new Error(`TikTok creator info query failed: ${JSON.stringify(creatorInfo.error || creatorInfo)}`);
  const privacyOptions = creatorInfo.data?.privacy_level_options || [];
  const privacyLevel = currentClientConfig.TIKTOK_PRIVACY_LEVEL && privacyOptions.includes(currentClientConfig.TIKTOK_PRIVACY_LEVEL)
    ? currentClientConfig.TIKTOK_PRIVACY_LEVEL
    : (privacyOptions[0] || 'SELF_ONLY');

  const response = await fetch('https://open.tiktokapis.com/v2/post/publish/content/init/', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      media_type: 'PHOTO',
      post_mode: 'DIRECT_POST',
      post_info: {
        title: caption.slice(0, 90),
        description: caption.slice(0, 4000),
        privacy_level: privacyLevel,
        disable_comment: false,
        auto_add_music: false
      },
      source_info: {
        source: 'PULL_FROM_URL',
        photo_images: [imageUrl],
        photo_cover_index: 0
      }
    })
  });
  const data = await response.json();
  if (!response.ok || data.error?.code !== 'ok') throw new Error(`TikTok post failed: ${JSON.stringify(data.error || data)}`);

  return { platformPostId: data.data?.publish_id, tiktokResponse: data };
}

// Raw MIME send via SES v2 -- mirrors sendEmailWithMultipleAttachments in
// QRScanner/app.mjs (the proven, already-live function behind the manual
// Send Now button), minus the attachments param this Lambda never needs.
async function sendEmail(sender, recipient, subject, text, html) {
  const mail = mailcomposer({
    from: sender,
    to: recipient,
    subject,
    text,
    ...(html ? { html } : {})
  });
  const mimeMessage = await new Promise((resolve, reject) => {
    mail.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
  return sesClient.send(new SendRawEmailCommand({ RawMessage: { Data: mimeMessage } }));
}

// One email per active MarketingEmailContact, each with its own working
// unsubscribe link -- same shape as app.mjs's send-now route (the two
// were built together; keep them in sync if one changes). `item` is the
// Square object already fetched by sendDuePosts' pre-send check (null for
// a digest post, which isn't about one item).
async function sendEmailPost(pgClient, post, item, clientId) {
  const contactsResult = await pgClient.query(
    `SELECT "Email", "UnsubscribeToken" FROM "MarketingEmailContact" WHERE "Status" = 'active'`
  );
  const contacts = contactsResult.rows;
  if (contacts.length === 0) {
    throw new Error('No active email contacts to send to');
  }

  const caption = post.PostContent?.caption || '';
  const venueName = currentClientConfig.WEB_HEADER_COMPANY || 'IndieTix';
  const isDigest = post.PostType === 'digest';
  const subject = isDigest ? `This week at ${venueName}` : `${item?.item_data?.name || '(untitled)'} at ${venueName}`;
  const sender = currentClientConfig.SENDER_EMAIL;
  const baseUrl = currentClientConfig.STATIC_WEBSITE_URL;

  const imageUrl = post.PostContent?.imageUrl || (item ? await resolveItemImageUrl(item) : null);
  const escapeForHtml = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let successCount = 0;
  const failures = [];
  for (const contact of contacts) {
    try {
      const unsubscribeUrl = baseUrl
        ? `${baseUrl}/email-unsubscribe.html?token=${contact.UnsubscribeToken}&client=${clientId}`
        : null;
      const body = `${caption}${unsubscribeUrl ? `\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}` : ''}`;
      const html = `
        ${imageUrl ? `<img src="${imageUrl}" alt="" style="max-width:100%;border-radius:8px;margin-bottom:16px;">` : ''}
        <p style="font-size:16px;line-height:1.5;white-space:pre-wrap;">${escapeForHtml(caption)}</p>
        ${unsubscribeUrl ? `<hr style="margin:24px 0;border:none;border-top:1px solid #ddd;"><p style="font-size:12px;color:#888;"><a href="${unsubscribeUrl}">Unsubscribe</a> from these emails.</p>` : ''}
      `;
      await sendEmail(sender, contact.Email, subject, body, html);
      successCount++;
    } catch (sendError) {
      console.error(`Error sending marketing email to ${contact.Email}:`, sendError.message);
      failures.push(contact.Email);
    }
  }

  if (successCount === 0) {
    throw new Error(`All ${contacts.length} email send(s) failed`);
  }

  return { imageUrl, recipientCount: successCount, failedRecipients: failures };
}

async function sendDuePost(pgClient, post, item, clientId) {
  let result;
  try {
    if (post.Channel === 'email') {
      result = await sendEmailPost(pgClient, post, item, clientId);
    } else if (post.Channel === 'facebook' && currentClientConfig.META_PAGE_ACCESS_TOKEN && currentClientConfig.META_PAGE_ID) {
      result = await sendFacebookPost(post);
    } else if (post.Channel === 'instagram' && currentClientConfig.META_PAGE_ACCESS_TOKEN && currentClientConfig.META_IG_BUSINESS_ID) {
      result = await sendInstagramPost(post);
    } else if (post.Channel === 'tiktok' && currentClientConfig.TIKTOK_ACCESS_TOKEN) {
      result = await sendTikTokPost(pgClient, post, clientId);
    } else {
      // No credentials configured yet for this channel/client -- same
      // dry-run stub as before, unchanged behavior until real tokens land.
      result = { dryRun: true, note: 'Platform sender not yet configured -- see Marquee Engine build plan Phase 6.' };
    }

    const newContent = { ...(post.PostContent || {}), ...result };
    await pgClient.query(
      `UPDATE "MarketingPost"
       SET "Status" = 'sent', "PlatformPostID" = $2, "PostContent" = $3, "UpdatedDate" = CURRENT_TIMESTAMP
       WHERE "ID" = $1`,
      [post.ID, result.platformPostId || null, JSON.stringify(newContent)]
    );
    console.log(`Sent MarketingPost ${post.ID} (${post.Channel}/${post.PostType}) for item ${post.SquareItemID}${result.dryRun ? ' [DRY RUN]' : ''}`);
  } catch (error) {
    console.error(`Error sending MarketingPost ${post.ID} (${post.Channel}):`, error);
    await pgClient.query(
      `UPDATE "MarketingPost" SET "Status" = 'failed', "FailureReason" = $2, "UpdatedDate" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
      [post.ID, error.message.slice(0, 500)]
    );
  }
}

async function sendDuePosts(pgClient, clientId) {
  // Every channel, including email, goes through this one query now --
  // the single human checkpoint is the earlier Approve click, not a
  // per-channel decision about whether this poller is allowed to touch it.
  const dueResult = await pgClient.query(
    `SELECT * FROM "MarketingPost"
     WHERE "Status" = 'approved' AND "ScheduledFor" <= CURRENT_TIMESTAMP
     ORDER BY "ScheduledFor" ASC`
  );

  let sent = 0;
  let skipped = 0;
  for (const post of dueResult.rows) {
    let item = null;

    // A digest post rounds up every active item under a fixed sentinel
    // SquareItemID ('digest') -- it isn't a real Square catalog object, so
    // there's nothing to re-check here. Every other post type genuinely is
    // one Square item, re-checked as a safety net for schedules that
    // weren't manually updated after a showtime changed (see Marquee
    // Engine design doc, Open Items).
    if (post.PostType !== 'digest') {
      try {
        const itemResult = await retrieveCatalogObject(post.SquareItemID);
        const isArchived = itemResult.object?.is_deleted || itemResult.object?.item_data?.is_archived;
        if (!itemResult.object || isArchived) {
          await pgClient.query(
            `UPDATE "MarketingPost" SET "Status" = 'skipped', "FailureReason" = $2, "UpdatedDate" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
            [post.ID, 'Source item no longer active in Square']
          );
          skipped++;
          continue;
        }
        item = itemResult.object;
      } catch (error) {
        await pgClient.query(
          `UPDATE "MarketingPost" SET "Status" = 'failed', "FailureReason" = $2, "UpdatedDate" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
          [post.ID, `Pre-send Square check failed: ${error.message}`]
        );
        continue;
      }
    }

    await sendDuePost(pgClient, post, item, clientId);
    sent++;
  }

  console.log(`Sent ${sent} posts, skipped ${skipped} stale posts`);
  return { sent, skipped };
}

async function processClient(clientData, baseDbConfig) {
  const { clientId, configuration } = clientData;

  const engineEnabled = configuration.MARKETING_ENGINE_ENABLED === true || configuration.MARKETING_ENGINE_ENABLED === 'true';
  if (!engineEnabled) {
    return { clientId, success: true, skipped: true };
  }

  if (!configuration.SQUARE_ACCESS_TOKEN) {
    console.log(`Client ${clientId}: MARKETING_ENGINE_ENABLED but missing SQUARE_ACCESS_TOKEN, skipping`);
    return { clientId, success: false, error: 'Missing Square Access Token' };
  }

  currentClientConfig = configuration;

  const pgClient = new Client({ ...baseDbConfig, database: clientId });
  try {
    await pgClient.connect();
    const generated = await generatePlannedPosts(pgClient, configuration);
    const digestGenerated = await generateDigestPost(pgClient, configuration, clientId);
    const { sent, skipped } = await sendDuePosts(pgClient, clientId);
    return { clientId, success: true, generated, digestGenerated, sent, skipped };
  } catch (error) {
    console.error(`Error processing client ${clientId}:`, error);
    return { clientId, success: false, error: error.message };
  } finally {
    await pgClient.end();
  }
}

// Exported for this repo's own tests -- purely additive, doesn't change
// handler's own behavior.
export {
  getAllClientDatabases,
  getClientConfiguration,
  getAllClientsWithConfigurations,
  filterItemsByCustomAttribute,
  parseDateFromModifierName,
  parseVenueAndDescriptors,
  getItemShowtimeWindow,
  slugify,
  getPurchaseUrl,
  getPriceRange,
  formatShowtime,
  buildTemplateCaption,
  generateAiCaption,
  computePlannedPostSlots,
  upsertPlannedPosts,
  resolveItemImageUrl,
  getChicagoNow,
  getChicagoDateParts,
  formatChicagoTime12h,
  addDaysToYMD,
  escapeSvgText,
  buildDigestSvg,
  generateDigestPost,
  generatePlannedPosts,
  sendFacebookPost,
  sendInstagramPost,
  refreshTikTokToken,
  sendTikTokPost,
  sendEmail,
  sendEmailPost,
  sendDuePost,
  sendDuePosts,
  processClient
};

// Test-only: currentClientConfig is module-level mutable state, set by
// processClient() before any channel sender reads it. The functions
// above that read it (sendFacebookPost, sendTikTokPost,
// refreshTikTokToken, etc.) need it set directly for focused unit tests
// that don't want to run the full processClient orchestration (catalog
// discovery + digest generation + send-due-posts) just to exercise one
// sender. Never called by production code.
export function __setCurrentClientConfigForTesting(config) {
  currentClientConfig = config;
}

export const handler = async (event, context) => {
  console.log('Starting Marquee Engine poller run...');

  try {
    const dbCredentials = await getDatabaseCredentials('indieTix/rds/clients/indietix/credentials');
    const baseDbConfig = {
      host: dbCredentials.host,
      port: parseInt(dbCredentials.port || '5432'),
      user: dbCredentials.username,
      password: dbCredentials.password,
      ssl: dbCredentials.ssl === 'true' ? { rejectUnauthorized: false } : false,
      // 20s, not 10s: an Aurora cluster allowed to auto-pause (sandbox,
      // AuroraMinCapacity 0) takes ~15s to resume on the first connection.
      connectionTimeoutMillis: 20000,
      query_timeout: 30000,
    };

    const clients = await getAllClientsWithConfigurations(baseDbConfig);
    if (clients.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ message: 'No clients found', timestamp: new Date().toISOString() }) };
    }

    const results = [];
    for (const client of clients) {
      results.push(await processClient(client, baseDbConfig));
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const active = results.filter(r => !r.skipped);
    const failed = results.filter(r => !r.success);
    console.log(`Poller run complete. ${active.length} clients active, ${failed.length} failed, ${results.length - active.length} inert (engine disabled).`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Processed ${results.length} clients (${active.length} active)`,
        results,
        timestamp: new Date().toISOString()
      })
    };
  } catch (error) {
    console.error('Fatal error in Marquee Engine poller:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Fatal error in Marquee Engine poller', message: error.message, timestamp: new Date().toISOString() })
    };
  }
};
