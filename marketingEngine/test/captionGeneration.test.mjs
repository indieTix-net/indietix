import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, getPurchaseUrl, getPriceRange, formatShowtime, buildTemplateCaption } from '../src/index.mjs';

test('slugify: lowercases and replaces non-alphanumeric runs with a single hyphen', () => {
  assert.equal(slugify('Digger (2026)!'), 'digger-2026-');
  assert.equal(slugify('The Movie: Part Two'), 'the-movie-part-two');
});

test('slugify: empty/null input never throws', () => {
  assert.equal(slugify(''), '');
  assert.equal(slugify(null), '');
  assert.equal(slugify(undefined), '');
});

test('getPurchaseUrl: builds a slugified product URL when ECOMMERCE_SITE_URL is configured', () => {
  const url = getPurchaseUrl({ ECOMMERCE_SITE_URL: 'https://shop.example.com' }, { id: 'item-1', item_data: { name: 'Digger (2026)' } });
  assert.equal(url, 'https://shop.example.com/product/digger-2026-/item-1');
});

test('getPurchaseUrl: returns null when no ECOMMERCE_SITE_URL is configured', () => {
  assert.equal(getPurchaseUrl({}, { id: 'item-1', item_data: { name: 'Movie' } }), null);
});

function itemWithPrices(amountsInCents) {
  return {
    item_data: {
      variations: amountsInCents.map((amount, i) => ({ id: `var-${i}`, item_variation_data: { price_money: { amount } } }))
    }
  };
}

test('getPriceRange: a single price formats as one dollar amount', () => {
  assert.equal(getPriceRange(itemWithPrices([1200])), '$12.00');
});

test('getPriceRange: multiple distinct prices format as a range', () => {
  assert.equal(getPriceRange(itemWithPrices([1000, 1500])), '$10.00–$15.00');
});

test('getPriceRange: identical prices across variations collapse to a single amount, not a range', () => {
  assert.equal(getPriceRange(itemWithPrices([1200, 1200])), '$12.00');
});

test('getPriceRange: no variations/prices returns null', () => {
  assert.equal(getPriceRange({ item_data: { variations: [] } }), null);
  assert.equal(getPriceRange({ item_data: {} }), null);
});

test('formatShowtime: includes the venue in parentheses when present', () => {
  const showtime = { date: new Date('2026-05-17T20:30:00.000Z'), venue: 'Little Theatre' };
  assert.equal(formatShowtime(showtime), '3:30 PM (Little Theatre)');
});

test('formatShowtime: omits the parenthetical entirely when there is no venue', () => {
  const showtime = { date: new Date('2026-05-17T20:30:00.000Z'), venue: null };
  assert.equal(formatShowtime(showtime), '3:30 PM');
});

const baseWindow = { showtimes: [{ date: new Date('2026-05-17T20:30:00.000Z'), venue: 'Main', descriptors: [] }] };
const baseItem = { item_data: { name: 'Digger (2026)', variations: [{ item_variation_data: { price_money: { amount: 1200 } } }] } };
const baseClientConfig = { WEB_HEADER_COMPANY: 'Liberty Hall' };

test('buildTemplateCaption: a normal (not last-chance) post uses the templates and includes the price', () => {
  const caption = buildTemplateCaption({
    item: baseItem, channel: 'facebook', clientConfig: baseClientConfig,
    scheduledFor: new Date('2026-05-01T12:00:00.000Z'), window: baseWindow, templateIndex: 0, isLastChance: false
  });
  assert.match(caption, /Digger \(2026\)/);
  assert.match(caption, /Tickets \$12\.00/);
});

test('buildTemplateCaption: email/facebook get a real purchase link; other channels get "Link in bio!"', () => {
  const configWithUrl = { ...baseClientConfig, ECOMMERCE_SITE_URL: 'https://shop.example.com' };
  const fbCaption = buildTemplateCaption({ item: baseItem, channel: 'facebook', clientConfig: configWithUrl, scheduledFor: new Date(), window: baseWindow, templateIndex: 0, isLastChance: false });
  const igCaption = buildTemplateCaption({ item: baseItem, channel: 'instagram', clientConfig: configWithUrl, scheduledFor: new Date(), window: baseWindow, templateIndex: 0, isLastChance: false });

  assert.match(fbCaption, /Get tickets: https:\/\/shop\.example\.com/);
  assert.match(igCaption, /Link in bio!/);
  assert.doesNotMatch(igCaption, /shop\.example\.com/);
});

test('buildTemplateCaption: last-chance day names the actual remaining showtimes instead of generic copy', () => {
  const scheduledFor = new Date('2026-05-17T15:00:00.000Z'); // same calendar day as the showtime below
  const window = { showtimes: [{ date: new Date('2026-05-17T20:30:00.000Z'), venue: 'Main', descriptors: [] }] };
  const caption = buildTemplateCaption({ item: baseItem, channel: 'facebook', clientConfig: baseClientConfig, scheduledFor, window, templateIndex: 0, isLastChance: true });
  assert.match(caption, /Last chance/);
  assert.match(caption, /3:30 PM/);
});

test('buildTemplateCaption: respects each channel\'s character limit, truncating with an ellipsis', () => {
  const longTitleItem = { item_data: { name: 'X'.repeat(3000), variations: [] } };
  const caption = buildTemplateCaption({ item: longTitleItem, channel: 'facebook', clientConfig: {}, scheduledFor: new Date(), window: { showtimes: [] }, templateIndex: 2, isLastChance: false });
  assert.ok(caption.length <= 63000);

  const igCaption = buildTemplateCaption({ item: longTitleItem, channel: 'instagram', clientConfig: {}, scheduledFor: new Date(), window: { showtimes: [] }, templateIndex: 2, isLastChance: false });
  assert.equal(igCaption.length, 2200);
  assert.ok(igCaption.endsWith('…'));
});
