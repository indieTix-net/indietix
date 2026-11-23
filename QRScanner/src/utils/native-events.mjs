// ---- NATIVE EVENTS ----
// IndieTix's own record of an event (Event, TicketType, Showing) and of the
// POS objects it's published as (ExternalCatalogLink). Add Movie / Add Event
// write a draft here first, then create the Square item, then link the two
// and mark the event active. Sales still happen in the POS.
// See NATIVE_EVENTS_PLAN.md (step 2). Tables come from clientSetup-Teardown
// (createDatabaseObjects / migrations.sql, 2026-11-20).

import * as squareApi from 'square-api-lib';

// 42P01 = undefined_table: a venue database that hasn't run the 2026-11-20
// migration. Add Movie/Event then works exactly as before (Square only).
const UNDEFINED_TABLE = '42P01';

const DAYS = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
// "Sun 01-18-2026 7:00 PM (Spacement, 21+)" -- what getMovieInfo.js /
// getEventInfo.js formatShowtime() produce and Square shows as the modifier.
// Also reads what staff have typed straight into Square (checked against all
// 591 showtime labels on Liberty Hall's tickets, 2026-11-20): "9:30PM", a
// one-digit day or month ("10-9-2026"), no weekday, and extras after the
// parentheses ("(Spacement) - All Ages"). A time with no AM/PM is refused,
// not guessed (getSquareOrders read "8:30" as 8:30 in the morning).
const LABEL_PATTERN = /^(?:([A-Za-z]{3}) )?(\d{1,2})-(\d{1,2})-(\d{4}) (\d{1,2}):(\d{2}) ?(AM|PM)(?: ?\(([^()]*)\))?(?: ?- ?(.+))?$/i;

/**
 * Parse a showtime label into the Showing's fields, or null if it can't be
 * read without guessing.
 * @returns {{ startsAt: string, venue: string, descriptors: string[], label: string } | null}
 *   startsAt is Chicago wall-clock 'YYYY-MM-DD HH:MM:00', the same value
 *   getSquareOrders stores as QRCodeProduct.ProductDate for this label.
 */
export function parseShowtimeLabel(label) {
  if (typeof label !== 'string') return null;
  const text = label.trim().replace(/\s+/g, ' ');
  const m = LABEL_PATTERN.exec(text);
  if (!m) return null;
  const [, day, mm, dd, yyyy, h, min, ampmRaw, inParens, after] = m;
  if (day !== undefined && !DAYS.has(day.toLowerCase())) return null;
  const ampm = ampmRaw.toUpperCase();
  const month = Number(mm); const date = Number(dd); const year = Number(yyyy);
  let hour = Number(h); const minute = Number(min);
  if (month < 1 || month > 12 || hour < 1 || hour > 12 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const parts = (inParens ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  // Add Event joins several extras with " - " ("(Spacement) - All Ages - 21+").
  const extras = (after ?? '').split(/,| - /).map((s) => s.trim()).filter(Boolean);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    startsAt: `${yyyy}-${pad(month)}-${pad(date)} ${pad(hour)}:${pad(minute)}:00`,
    // Same default getSquareOrders' parseItemModifierValues uses.
    venue: parts[0] || 'Main',
    descriptors: [...parts.slice(1), ...extras],
    label: text
  };
}

// Only real web addresses are kept (an uploaded poster arrives as a
// data: URL, which can be megabytes).
export function storablePosterUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 2000 ? url : null;
}

/**
 * Save the event as a draft, before anything is created in the POS.
 * @param pool pg pool for the venue's database
 * @param {object} e { kind: 'movie'|'event', title, eventType, distributor, imdbID,
 *   description, posterUrl, createdBy, ticketTypes: [{name, price}], showings: [parseShowtimeLabel()],
 *   roomCapacities: the venue's ROOM_CAPACITY setting (each showing starts with its room's seats) }
 * @returns {Promise<{ eventId, ticketTypeIds: number[], showingIds: number[] } | null>}
 *   null when this venue's database doesn't have the tables yet.
 */
export async function createDraftEvent(pool, e) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await client.query(
      `INSERT INTO "Event" ("Kind", "Title", "EventType", "Distributor", "ImdbID", "Description", "PosterUrl", "Status", "CreatedBy")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8) RETURNING "ID"`,
      [e.kind, e.title, e.eventType || null, e.distributor || null, e.imdbID || null, e.description || null,
        storablePosterUrl(e.posterUrl), e.createdBy || null]
    );
    const eventId = event.rows[0].ID;
    const ticketTypeIds = [];
    for (const [i, t] of (e.ticketTypes || []).entries()) {
      const row = await client.query(
        `INSERT INTO "TicketType" ("EventID", "Name", "PriceCents", "SortOrder") VALUES ($1, $2, $3, $4) RETURNING "ID"`,
        [eventId, t.name, Math.round(Number(t.price) * 100), i]
      );
      ticketTypeIds.push(row.rows[0].ID);
    }
    const showingIds = [];
    for (const [i, s] of e.showings.entries()) {
      // Seats typed on Add Movie/Event (already checked by readShowtimeSeats), else the room's.
      const seats = e.seats?.[i] || { capacity: roomCapacity(e.roomCapacities, s.venue), heldSeats: 0 };
      const row = await client.query(
        `INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Descriptors", "Label", "Capacity", "HeldSeats") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "ID"`,
        [eventId, s.startsAt, s.venue, s.descriptors.join(', '), s.label, seats.capacity, seats.heldSeats]
      );
      showingIds.push(row.rows[0].ID);
    }
    await client.query('COMMIT');
    return { eventId, ticketTypeIds, showingIds };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === UNDEFINED_TABLE) {
      console.log('Native event tables not in this venue database yet; creating the Square item only.');
      return null;
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Link the draft to what Square created and mark it active.
 * Showtime modifiers are matched to showings by the ordinal Add Movie/Event
 * gives them (index + 1), ticket variations to ticket types by position.
 * @param draft createDraftEvent()'s result
 * @param {object} square { itemId, modifierListId, imageId, modifiers: [{id, modifier_data:{ordinal}}], variations: [{id}] }
 */
export async function publishEventLinks(pool, draft, square) {
  const links = [
    ['event', draft.eventId, 'ITEM', square.itemId],
    ['event', draft.eventId, 'MODIFIER_LIST', square.modifierListId]
  ];
  if (square.imageId) links.push(['event', draft.eventId, 'IMAGE', square.imageId]);
  const modifiers = square.modifiers || [];
  if (modifiers.length !== draft.showingIds.length) {
    throw new Error(`Square returned ${modifiers.length} showtime modifiers for ${draft.showingIds.length} showings`);
  }
  const byOrdinal = [...modifiers].sort((a, b) => (a.modifier_data?.ordinal ?? 0) - (b.modifier_data?.ordinal ?? 0));
  byOrdinal.forEach((m, i) => links.push(['showing', draft.showingIds[i], 'MODIFIER', m.id]));
  const variations = square.variations || [];
  if (variations.length !== draft.ticketTypeIds.length) {
    throw new Error(`Square returned ${variations.length} ticket variations for ${draft.ticketTypeIds.length} ticket types`);
  }
  variations.forEach((v, i) => links.push(['ticket_type', draft.ticketTypeIds[i], 'ITEM_VARIATION', v.id]));
  for (const [, , , id] of links) if (!id) throw new Error('Square returned an object without an id');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [entityType, entityId, externalType, externalId] of links) {
      await client.query(
        `INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ($1, $2, 'square', $3, $4)`,
        [entityType, entityId, externalType, externalId]
      );
    }
    await client.query(`UPDATE "Event" SET "Status" = 'active', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [draft.eventId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Remove a draft whose POS item was never created. */
export async function discardDraftEvent(pool, draft) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM "ExternalCatalogLink" WHERE "EntityType" = 'event' AND "EntityID" = $1`, [draft.eventId]);
    await client.query(`DELETE FROM "ExternalCatalogLink" WHERE "EntityType" = 'showing' AND "EntityID" = ANY($1::int[])`, [draft.showingIds]);
    await client.query(`DELETE FROM "ExternalCatalogLink" WHERE "EntityType" = 'ticket_type' AND "EntityID" = ANY($1::int[])`, [draft.ticketTypeIds]);
    await client.query(`DELETE FROM "Showing" WHERE "EventID" = $1`, [draft.eventId]);
    await client.query(`DELETE FROM "TicketType" WHERE "EventID" = $1`, [draft.eventId]);
    await client.query(`DELETE FROM "Event" WHERE "ID" = $1 AND "Status" = 'draft'`, [draft.eventId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`Could not discard draft event ${draft.eventId}:`, error.message);
  } finally {
    client.release();
  }
}
// ---- ROOM CAPACITY ----
// ROOM_CAPACITY (Client Settings) is {"room name": seats}. A new showing
// starts with its room's seats; no entry (or a bad one) = no limit (NULL).
export function roomCapacity(roomCapacities, venue) {
  if (!roomCapacities || typeof roomCapacities !== 'object' || Array.isArray(roomCapacities)) return null;
  const wanted = String(venue || '').trim().toLowerCase();
  for (const [room, seats] of Object.entries(roomCapacities)) {
    if (room.trim().toLowerCase() !== wanted) continue;
    const n = Number(seats);
    return Number.isInteger(n) && n >= 0 && String(seats).trim() !== '' ? n : null;
  }
  return null;
}

// Error message for a bad ROOM_CAPACITY value, or null if it's fine.
export function validateRoomCapacity(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'Room seats must be a list of rooms and seat counts';
  for (const [room, seats] of Object.entries(value)) {
    if (!room.trim() || room.length > 255) return 'Each room seat count needs its room name';
    if (seats === '' || seats === null) continue;
    if (!/^[0-9]{1,6}$/.test(String(seats))) return `Seats for "${room}" must be a whole number (or blank for no limit)`;
  }
  return null;
}
// ---- END ROOM CAPACITY ----

// ---- SHOWTIME MANAGEMENT ----
// The Showtimes page (showtimes.html): list events, then add, edit,
// re-seat or cancel a showing. Each change is made in IndieTix and Square
// together, inside one database transaction (rolled back if Square fails).
// Only events IndieTix has its own copy of (Add Movie/Event since native
// events step 2; older Square items after the step 4 import).

export class ShowtimeError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// 'deleted' (an order deleted on the Orders page) frees its seat too.
const NOT_SOLD = ['refunded', 'cancelled', 'canceled', 'transferred', 'deleted'];
const CHICAGO_NOW = `(NOW() AT TIME ZONE 'America/Chicago')`;
// Two-key advisory lock: one staff change per event at a time.
const EVENT_LOCK_CLASS = 7101;
// getSquareOrders' per-showing lock (its sell-out check). Taken after the
// event lock, never before, so the two can't deadlock.
const SHOWING_LOCK_CLASS = 7102;

// Tickets sold for each showing (not refunded/cancelled/transferred), by
// ShowingID (step 3 on) or by the showing's Square modifier IDs, which every
// ticket already stores in ProductMetadata.modifiers[].catalog_object_id.
const SOLD_SQL = `
  SELECT s."ID" AS "ShowingID", COUNT(DISTINCT q."ID")::int AS "Sold"
  FROM "Showing" s
  LEFT JOIN "ExternalCatalogLink" l
    ON l."EntityType" = 'showing' AND l."EntityID" = s."ID" AND l."ExternalType" = 'MODIFIER'
  LEFT JOIN "QRCodeProduct" q
    ON (q."ShowingID" = s."ID"
        OR (l."ExternalID" IS NOT NULL AND q."ProductMetadata" @> jsonb_build_object('modifiers', jsonb_build_array(jsonb_build_object('catalog_object_id', l."ExternalID")))))
   AND COALESCE(q."Status", 'valid') <> ALL($2::text[])
  WHERE s."EventID" = $1
  GROUP BY s."ID"`;

function wrapMissingTables(error) {
  if (error.code === UNDEFINED_TABLE) return new ShowtimeError(503, 'Showtime management is not set up for this venue yet (its database needs the 2026-11-20 update).');
  return error;
}

export async function listEvents(pool, { includeArchived = false } = {}) {
  try {
    const result = await pool.query(`
      SELECT e."ID", e."Kind", e."Title", e."EventType", e."Status",
             COUNT(s."ID") FILTER (WHERE s."Status" IN ('on_sale', 'sold_out') AND s."StartsAt" >= ${CHICAGO_NOW})::int AS "Upcoming",
             MIN(s."StartsAt") FILTER (WHERE s."Status" IN ('on_sale', 'sold_out') AND s."StartsAt" >= ${CHICAGO_NOW})::text AS "NextStartsAt"
      FROM "Event" e LEFT JOIN "Showing" s ON s."EventID" = e."ID"
      WHERE e."Status" = 'active' OR ($1 AND e."Status" = 'archived')
      GROUP BY e."ID"
      ORDER BY MIN(s."StartsAt") FILTER (WHERE s."Status" IN ('on_sale', 'sold_out') AND s."StartsAt" >= ${CHICAGO_NOW}) NULLS LAST, e."Title"`,
      [includeArchived]);
    return result.rows.map((r) => ({ id: r.ID, kind: r.Kind, title: r.Title, eventType: r.EventType, status: r.Status, upcoming: r.Upcoming, nextStartsAt: r.NextStartsAt }));
  } catch (error) { throw wrapMissingTables(error); }
}

export async function getEventWithShowings(pool, eventId) {
  try {
    const event = await pool.query(`SELECT * FROM "Event" WHERE "ID" = $1 AND "Status" <> 'draft'`, [eventId]);
    if (event.rows.length === 0) throw new ShowtimeError(404, 'Event not found');
    const showings = await pool.query(`
      SELECT s.*, s."StartsAt"::text AS "StartsAtText", (s."StartsAt" < ${CHICAGO_NOW}) AS "IsPast", COALESCE(sold."Sold", 0) AS "Sold"
      FROM "Showing" s LEFT JOIN (${SOLD_SQL}) sold ON sold."ShowingID" = s."ID"
      WHERE s."EventID" = $1 ORDER BY s."StartsAt", s."ID"`, [eventId, NOT_SOLD]);
    const e = event.rows[0];
    // Every ticket ever, refunded or not: decides whether Delete deletes or ends it.
    const ever = await pool.query(`SELECT COALESCE(SUM("Sold"), 0)::int AS n FROM (${SOLD_SQL}) x`, [eventId, []]);
    return {
      id: e.ID, kind: e.Kind, title: e.Title, eventType: e.EventType, distributor: e.Distributor, status: e.Status,
      description: e.Description || '', posterUrl: e.PosterUrl || null, ticketsEver: ever.rows[0].n,
      showings: showings.rows.map((s) => ({
        id: s.ID, label: s.Label, startsAt: s.StartsAtText, venue: s.Venue, descriptors: s.Descriptors,
        status: s.Status, capacity: s.Capacity, heldSeats: s.HeldSeats, sold: s.Sold, isPast: s.IsPast,
        available: s.Capacity === null ? null : Math.max(0, s.Capacity - s.HeldSeats - s.Sold)
      }))
    };
  } catch (error) { throw wrapMissingTables(error); }
}

/**
 * Add Movie / Add Event's optional seats, one entry per showtime (the shared
 * showtime form sends them). Missing = the room's seats. Same rules as the
 * Showtimes page. Throws ShowtimeError(400) naming the showtime.
 */
export function readShowtimeSeats(seats, labels) {
  if (seats === undefined || seats === null) return undefined;
  if (!Array.isArray(seats) || seats.length !== labels.length) throw new ShowtimeError(400, 'Seats must be given for every showtime, or for none');
  return seats.map((s, i) => {
    if (s === null || s === undefined) return undefined;
    try {
      return readSeats(s);
    } catch (error) {
      throw new ShowtimeError(400, `${labels[i]}: ${error.message}`);
    }
  });
}

// Capacity / held seats as typed: '' or null capacity = no limit.
function readSeats({ capacity, heldSeats }) {
  const cap = capacity === '' || capacity === null || capacity === undefined ? null : Number(capacity);
  const held = heldSeats === '' || heldSeats === null || heldSeats === undefined ? 0 : Number(heldSeats);
  if (cap !== null && (!Number.isInteger(cap) || cap < 0 || cap > 999999)) throw new ShowtimeError(400, 'Capacity must be a whole number of seats (or blank for no limit)');
  if (!Number.isInteger(held) || held < 0 || held > 999999) throw new ShowtimeError(400, 'Held seats must be a whole number');
  if (cap === null && held > 0) throw new ShowtimeError(400, 'Held seats need a capacity to be held from');
  if (cap !== null && held > cap) throw new ShowtimeError(400, 'Held seats can\'t be more than the capacity');
  return { capacity: cap, heldSeats: held };
}

async function inEventTransaction(pool, eventId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [EVENT_LOCK_CLASS, eventId]);
    const event = await client.query(`SELECT * FROM "Event" WHERE "ID" = $1 AND "Status" <> 'draft'`, [eventId]);
    if (event.rows.length === 0) throw new ShowtimeError(404, 'Event not found');
    const links = await client.query(
      `SELECT "ExternalType", "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'event' AND "EntityID" = $1 AND "Provider" = 'square' AND "DeletedAt" IS NULL`, [eventId]);
    const link = Object.fromEntries(links.rows.map((r) => [r.ExternalType, r.ExternalID]));
    if (!link.ITEM || !link.MODIFIER_LIST) throw new ShowtimeError(409, 'This event isn\'t linked to a Square item, so its showtimes can\'t be changed here');
    const result = await work(client, event.rows[0], link);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw wrapMissingTables(error);
  } finally {
    client.release();
  }
}

async function soldFor(client, eventId, showingId) {
  const r = await client.query(`SELECT "Sold" FROM (${SOLD_SQL}) x WHERE "ShowingID" = $3`, [eventId, NOT_SOLD, showingId]);
  return r.rows[0]?.Sold ?? 0;
}

async function loadShowing(client, eventId, showingId) {
  const r = await client.query(`SELECT *, ("StartsAt" < ${CHICAGO_NOW}) AS "IsPast" FROM "Showing" WHERE "ID" = $1 AND "EventID" = $2`, [showingId, eventId]);
  if (r.rows.length === 0) throw new ShowtimeError(404, 'Showtime not found');
  return r.rows[0];
}

async function activeModifierId(client, showingId) {
  const r = await client.query(
    `SELECT "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "ExternalType" = 'MODIFIER' AND "Provider" = 'square' AND "DeletedAt" IS NULL ORDER BY "ID" DESC LIMIT 1`,
    [showingId]);
  return r.rows[0]?.ExternalID || null;
}

async function checkNewLabel(client, eventId, label, exceptShowingId = null) {
  const parsed = parseShowtimeLabel(label);
  if (!parsed) throw new ShowtimeError(400, `Showtime not understood; expected the form "Sun 01-18-2026 7:00 PM (Main Theater)"`);
  const past = await client.query(`SELECT $1::timestamp < ${CHICAGO_NOW} AS past`, [parsed.startsAt]);
  if (past.rows[0].past) throw new ShowtimeError(400, 'That showtime is in the past');
  const dup = await client.query(
    `SELECT 1 FROM "Showing" WHERE "EventID" = $1 AND "Label" = $2 AND "Status" <> 'cancelled' AND ($3::int IS NULL OR "ID" <> $3)`,
    [eventId, parsed.label, exceptShowingId]);
  if (dup.rows.length > 0) throw new ShowtimeError(409, 'This event already has that showtime');
  return parsed;
}

// Square's time-only "kitchen name" Add Event gives each showtime.
function abbreviationFor(event, label) {
  if (event.Kind !== 'event') return undefined;
  const m = /(\d{1,2}:\d{2}\s+(?:AM|PM))/.exec(label);
  return m ? m[1] : undefined;
}

/**
 * Put a showtime on the item's Square showtime list (a new modifier, after
 * the ones already there) and link it to the showing. Used by addShowing and
 * by putting a sold-out showing back on sale. Returns the modifier id; the
 * caller removes it from Square if its transaction then fails.
 */
async function createShowtimeModifier(client, accessToken, event, link, showingId, label) {
  const list = await squareApi.retrieveCatalogObject(accessToken, link.MODIFIER_LIST);
  const ordinals = (list.object?.modifier_list_data?.modifiers || []).map((m) => m.modifier_data?.ordinal || 0);
  const modifierData = { name: label, price_money: { amount: 0, currency: 'USD' }, ordinal: Math.max(0, ...ordinals) + 1, modifier_list_id: link.MODIFIER_LIST };
  const abbreviation = abbreviationFor(event, label);
  if (abbreviation) modifierData.abbreviation = abbreviation;
  const created = await squareApi.upsertCatalogObject(accessToken, {
    idempotency_key: `indietix-showing-${event.ID}-${showingId}-${Date.now()}`,
    object: { type: 'MODIFIER', id: '#new_showtime', ...(list.object?.present_at_location_ids ? { present_at_location_ids: list.object.present_at_location_ids } : {}), modifier_data: modifierData }
  });
  const modifierId = created.catalog_object?.id;
  if (!modifierId) throw new Error('Square did not return the new showtime\'s id');
  await client.query(
    `INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ('showing', $1, 'square', 'MODIFIER', $2)`,
    [showingId, modifierId]);
  return modifierId;
}

// A showtime going on sale on an archived event puts the item back on sale.
async function unarchiveIfArchived(client, accessToken, event, link) {
  if (event.Status !== 'archived') return false;
  await squareApi.unarchiveItem(accessToken, link.ITEM);
  await client.query(`UPDATE "Event" SET "Status" = 'active', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [event.ID]);
  return true;
}

/** Add a showtime: Showing + a new modifier on the item's Square showtime list. */
export async function addShowing(pool, accessToken, eventId, { label, capacity, heldSeats }, { roomCapacities } = {}) {
  let createdModifierId = null;
  try {
    return await inEventTransaction(pool, eventId, async (client, event, link) => {
      const parsed = await checkNewLabel(client, eventId, label);
      const seats = capacity === undefined
        ? { capacity: roomCapacity(roomCapacities, parsed.venue), heldSeats: 0 }
        : readSeats({ capacity, heldSeats });
      const row = await client.query(
        `INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Descriptors", "Label", "Capacity", "HeldSeats") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "ID"`,
        [eventId, parsed.startsAt, parsed.venue, parsed.descriptors.join(', '), parsed.label, seats.capacity, seats.heldSeats]);
      const showingId = row.rows[0].ID;
      createdModifierId = await createShowtimeModifier(client, accessToken, event, link, showingId, parsed.label);
      const unarchived = await unarchiveIfArchived(client, accessToken, event, link);
      await client.query(`UPDATE "Event" SET "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
      return { showingId, modifierId: createdModifierId, unarchived };
    });
  } catch (error) {
    // The database rolled back; don't leave the new showtime on sale in Square.
    if (createdModifierId) {
      await squareApi.deleteCatalogObject(accessToken, createdModifierId).catch((e) => console.error(`Could not remove showtime ${createdModifierId} from Square after a failed add:`, e.message));
    }
    throw error;
  }
}

/** Change a showtime's date/time/room/extras. Only before any ticket is sold. */
export async function editShowing(pool, accessToken, eventId, showingId, { label }) {
  return inEventTransaction(pool, eventId, async (client, event) => {
    const showing = await loadShowing(client, eventId, showingId);
    if (!['on_sale', 'sold_out'].includes(showing.Status)) throw new ShowtimeError(409, 'Only a showtime that\'s still on sale can be changed');
    if (showing.IsPast) throw new ShowtimeError(409, 'That showtime has already happened');
    const sold = await soldFor(client, eventId, showingId);
    if (sold > 0) throw new ShowtimeError(409, `${sold} ticket${sold === 1 ? ' has' : 's have'} been sold for this showtime, and ${sold === 1 ? 'it shows' : 'they show'} the current time. Cancel it and add a new one instead.`);
    const parsed = await checkNewLabel(client, eventId, label, showingId);
    if (parsed.label === showing.Label) return { changed: false };
    const modifierId = await activeModifierId(client, showingId);
    if (!modifierId) throw new ShowtimeError(409, 'This showtime is no longer in Square');
    await client.query(
      `UPDATE "Showing" SET "StartsAt" = $2, "Venue" = $3, "Descriptors" = $4, "Label" = $5 WHERE "ID" = $1`,
      [showingId, parsed.startsAt, parsed.venue, parsed.descriptors.join(', '), parsed.label]);
    let current;
    try {
      current = await squareApi.retrieveCatalogObject(accessToken, modifierId);
    } catch (error) {
      throw new ShowtimeError(409, 'This showtime is no longer in Square');
    }
    const modifierData = { ...current.object.modifier_data, name: parsed.label };
    const abbreviation = abbreviationFor(event, parsed.label);
    if (abbreviation) modifierData.abbreviation = abbreviation;
    await squareApi.upsertCatalogObject(accessToken, {
      idempotency_key: `indietix-showing-edit-${showingId}-${Date.now()}`,
      object: { ...current.object, modifier_data: modifierData }
    });
    await client.query(`UPDATE "Event" SET "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
    return { changed: true };
  });
}

/** Change capacity / held seats. Allowed after sales, never below what's sold. IndieTix only. */
export async function setShowingSeats(pool, eventId, showingId, { capacity, heldSeats }) {
  return inEventTransaction(pool, eventId, async (client) => {
    const showing = await loadShowing(client, eventId, showingId);
    if (showing.Status === 'cancelled') throw new ShowtimeError(409, 'That showtime was cancelled');
    const seats = readSeats({ capacity, heldSeats });
    const sold = await soldFor(client, eventId, showingId);
    if (seats.capacity !== null && seats.capacity - seats.heldSeats < sold) {
      throw new ShowtimeError(409, `${sold} tickets are already sold, so capacity minus held seats can't be less than ${sold}`);
    }
    await client.query(`UPDATE "Showing" SET "Capacity" = $2, "HeldSeats" = $3 WHERE "ID" = $1`, [showingId, seats.capacity, seats.heldSeats]);
    return { ...seats, sold };
  });
}

/**
 * Cancel a showtime: remove its modifier from Square (off sale online and at
 * the register). Sold tickets are NOT refunded; the count is returned so staff
 * can refund them. Cancelling the item's last upcoming showtime archives it.
 */
export async function cancelShowing(pool, accessToken, eventId, showingId) {
  const outcome = await inEventTransaction(pool, eventId, async (client, event, link) => {
    const showing = await loadShowing(client, eventId, showingId);
    if (showing.Status === 'cancelled') throw new ShowtimeError(409, 'That showtime is already cancelled');
    const sold = await soldFor(client, eventId, showingId);
    await client.query(`UPDATE "Showing" SET "Status" = 'cancelled' WHERE "ID" = $1`, [showingId]);
    await removeShowtimeFromSquare(client, accessToken, showingId);
    const remaining = await client.query(
      `SELECT COUNT(*)::int AS n FROM "Showing" WHERE "EventID" = $1 AND "Status" IN ('on_sale', 'sold_out') AND "StartsAt" >= ${CHICAGO_NOW}`, [eventId]);
    await client.query(`UPDATE "Event" SET "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
    return { sold, lastOne: remaining.rows[0].n === 0, itemId: link.ITEM };
  });
  // After the commit: the showtime is already off sale in Square, so the
  // cancellation stands even if archiving the now-empty item fails.
  let archived = false;
  let archiveError = null;
  if (outcome.lastOne) {
    try {
      await squareApi.archiveItem(accessToken, outcome.itemId);
      await pool.query(`UPDATE "Event" SET "Status" = 'archived', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
      archived = true;
    } catch (error) {
      console.error(`Showtime cancelled, but archiving Square item ${outcome.itemId} failed:`, error.message);
      archiveError = 'It was the last showtime, but the item could not be archived in Square; archive it there.';
    }
  }
  return { soldTickets: outcome.sold, archived, archiveError };
}

// Delete a showing's modifier from Square (off sale online and at the
// register) and close its link. Used by cancelShowing and deleteEvent.
async function removeShowtimeFromSquare(client, accessToken, showingId) {
  const modifierId = await activeModifierId(client, showingId);
  if (!modifierId) return;
  const response = await squareApi.squareFetch(accessToken, `/v2/catalog/object/${modifierId}`, { method: 'DELETE' });
  // 404: already gone from Square (e.g. the nightly expiry job removed it).
  if (!response.ok && response.status !== 404) {
    throw new Error(`Square could not remove the showtime: ${response.status} ${await response.text()}`);
  }
  await client.query(
    `UPDATE "ExternalCatalogLink" SET "DeletedAt" = CURRENT_TIMESTAMP, "DeletedReason" = 'cancelled' WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "ExternalID" = $2`,
    [showingId, modifierId]);
}

// ---- EVENT DETAILS (edit / delete) ----
// The Showtimes page's Event details panel (2026-11-23). Name, description
// and poster are changed here and on the Square item together, so staff
// don't edit half in Square and half in IndieTix. Ticket types and prices
// are still changed in Square. The nightly expiry job reports name,
// description and poster changed in Square by hand (SHOWTIME_DRIFT).

const MAX_TITLE = 255;
const MAX_DESCRIPTION = 4000; // Square allows 4096

/** What customers see as the item's description. */
export function squareItemDescription(itemData) {
  return itemData?.description_plaintext ?? itemData?.description ?? '';
}

/** Same text, ignoring how whitespace and line breaks came back. */
export function sameText(a, b) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

function readEventDetails({ title, description }) {
  const out = {};
  if (title !== undefined && title !== null) {
    if (typeof title !== 'string' || !title.trim()) throw new ShowtimeError(400, 'The event needs a name');
    if (title.trim().length > MAX_TITLE) throw new ShowtimeError(400, `The name can be at most ${MAX_TITLE} characters`);
    out.title = title.trim();
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') throw new ShowtimeError(400, 'Description not understood');
    if (description.trim().length > MAX_DESCRIPTION) throw new ShowtimeError(400, `The description can be at most ${MAX_DESCRIPTION} characters`);
    out.description = description.trim();
  }
  return out;
}

async function eventLinks(db, eventId) {
  const rows = await db.query(
    `SELECT "ExternalType", "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'event' AND "EntityID" = $1 AND "Provider" = 'square' AND "DeletedAt" IS NULL`, [eventId]);
  return Object.fromEntries(rows.rows.map((r) => [r.ExternalType, r.ExternalID]));
}

/**
 * The name, description and poster customers see now (read from Square),
 * for the edit form. Falls back to IndieTix's copy, with squareError set,
 * when Square can't be read.
 */
export async function getEventDetails(pool, accessToken, eventId) {
  try {
    const event = await pool.query(`SELECT * FROM "Event" WHERE "ID" = $1 AND "Status" <> 'draft'`, [eventId]);
    if (event.rows.length === 0) throw new ShowtimeError(404, 'Event not found');
    const e = event.rows[0];
    const mine = { title: e.Title, description: e.Description || '', imageUrl: e.PosterUrl || null };
    const link = await eventLinks(pool, eventId);
    if (!link.ITEM) return { ...mine, squareError: 'This event isn\'t linked to a Square item' };
    let current;
    try {
      current = await squareApi.retrieveCatalogObject(accessToken, link.ITEM);
    } catch (error) {
      return { ...mine, squareError: 'Square couldn\'t be read just now, so this shows IndieTix\'s copy' };
    }
    const item = current.object;
    if (!item || item.is_deleted) return { ...mine, squareError: 'This event\'s item is no longer in Square' };
    const imageId = item.item_data?.image_ids?.[0];
    const image = (current.related_objects || []).find((o) => o.id === imageId && o.type === 'IMAGE');
    return {
      title: item.item_data?.name || e.Title,
      description: squareItemDescription(item.item_data),
      imageUrl: image?.image_data?.url || mine.imageUrl
    };
  } catch (error) { throw wrapMissingTables(error); }
}

async function uploadPoster(accessToken, poster, title, eventId) {
  const safe = String(title).replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').toLowerCase().substring(0, 100) || 'event';
  const response = await squareApi.uploadCatalogImage(accessToken, {
    imageBuffer: poster.buffer,
    filename: `${safe}_poster.jpg`,
    contentType: 'image/jpeg',
    request: {
      idempotency_key: `indietix-event-poster-${eventId}-${Date.now()}`,
      image: { id: '#event_poster', type: 'IMAGE', image_data: { caption: title } }
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Square could not take the poster: ${response.status} ${text}`);
  const imageId = JSON.parse(text).image?.id;
  if (!imageId) throw new Error('Square did not return the poster\'s id');
  return imageId;
}

/**
 * Change an event's name, description and/or poster, on the Square item and
 * here. Fields left undefined are unchanged. Saving a field also corrects it
 * where Square and IndieTix had drifted apart.
 * @param {object} changes { title?, description?, poster?: { buffer (square JPEG), sourceUrl } }
 * @returns {Promise<{ changed: string[] }>} e.g. ['name', 'poster']
 */
export async function editEventDetails(pool, accessToken, eventId, { title, description, poster } = {}) {
  const wanted = readEventDetails({ title, description });
  if (wanted.title === undefined && wanted.description === undefined && !poster) throw new ShowtimeError(400, 'Nothing to change');
  let uploadedImageId = null;
  let squareSaved = false;
  try {
    return await inEventTransaction(pool, eventId, async (client, event, link) => {
      let current;
      try {
        current = await squareApi.retrieveCatalogObject(accessToken, link.ITEM);
      } catch (error) {
        throw new ShowtimeError(409, 'This event\'s Square item couldn\'t be read (was it deleted in Square?)');
      }
      const item = current.object;
      if (!item || item.type !== 'ITEM' || item.is_deleted) throw new ShowtimeError(409, 'This event\'s item is no longer in Square');
      const itemData = { ...item.item_data };
      const customAttributes = item.custom_attribute_values ? { ...item.custom_attribute_values } : null;
      const changed = [];

      if (wanted.title !== undefined && (wanted.title !== event.Title || wanted.title !== itemData.name)) {
        // Add Movie/Event repeats the title in the online display name attribute.
        for (const [key, value] of Object.entries(customAttributes || {})) {
          if (typeof value?.string_value === 'string' && value.string_value === itemData.name) customAttributes[key] = { ...value, string_value: wanted.title };
        }
        itemData.name = wanted.title;
        changed.push('name');
      }
      if (wanted.description !== undefined &&
          (!sameText(wanted.description, event.Description) || !sameText(wanted.description, squareItemDescription(itemData)))) {
        // Square makes the HTML and plain-text copies from this.
        delete itemData.description_html;
        delete itemData.description_plaintext;
        itemData.description = wanted.description;
        changed.push('description');
      }
      if (poster) {
        uploadedImageId = await uploadPoster(accessToken, poster, itemData.name, eventId);
        itemData.image_ids = [uploadedImageId];
        changed.push('poster');
      }
      if (changed.length === 0) return { changed };

      await squareApi.upsertCatalogObject(accessToken, {
        idempotency_key: `indietix-event-edit-${eventId}-${Date.now()}`,
        object: { ...item, item_data: itemData, ...(customAttributes ? { custom_attribute_values: customAttributes } : {}) }
      });
      squareSaved = true;

      await client.query(
        `UPDATE "Event" SET "Title" = $2, "Description" = $3, "PosterUrl" = CASE WHEN $4 THEN $5 ELSE "PosterUrl" END, "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
        [eventId,
          changed.includes('name') ? wanted.title : event.Title,
          changed.includes('description') ? wanted.description : event.Description,
          Boolean(poster), poster ? storablePosterUrl(poster.sourceUrl) : null]);
      if (poster) {
        await client.query(
          `UPDATE "ExternalCatalogLink" SET "DeletedAt" = CURRENT_TIMESTAMP, "DeletedReason" = 'replaced' WHERE "EntityType" = 'event' AND "EntityID" = $1 AND "ExternalType" = 'IMAGE' AND "Provider" = 'square' AND "DeletedAt" IS NULL`,
          [eventId]);
        await client.query(
          `INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ('event', $1, 'square', 'IMAGE', $2)`,
          [eventId, uploadedImageId]);
      }
      return { changed };
    });
  } catch (error) {
    // The item never pointed at the new poster; don't leave it in Square's library.
    if (uploadedImageId && !squareSaved) {
      await squareApi.deleteCatalogObject(accessToken, uploadedImageId).catch((e) => console.error(`Could not remove unused poster ${uploadedImageId} from Square:`, e.message));
    }
    throw error;
  }
}

// Every ticket ever made for this event, refunded or not: by showing, by
// showtime modifier, or by ticket variation (a showtime the import couldn't read).
async function ticketsEverSold(client, eventId) {
  const r = await client.query(`
    WITH ids AS (
      SELECT l."ExternalID" FROM "ExternalCatalogLink" l
      WHERE l."Provider" = 'square' AND (
        (l."EntityType" = 'showing' AND l."EntityID" IN (SELECT "ID" FROM "Showing" WHERE "EventID" = $1)) OR
        (l."EntityType" = 'ticket_type' AND l."EntityID" IN (SELECT "ID" FROM "TicketType" WHERE "EventID" = $1)))
    )
    SELECT COUNT(*)::int AS n FROM "QRCodeProduct" q
    WHERE q."ShowingID" IN (SELECT "ID" FROM "Showing" WHERE "EventID" = $1)
       OR EXISTS (SELECT 1 FROM ids WHERE
            q."ProductMetadata" @> jsonb_build_object('modifiers', jsonb_build_array(jsonb_build_object('catalog_object_id', ids."ExternalID")))
         OR q."ProductMetadata" @> jsonb_build_object('catalog_object_id', ids."ExternalID"))`, [eventId]);
  return r.rows[0].n;
}

async function deleteFromSquare(accessToken, objectId) {
  const response = await squareApi.squareFetch(accessToken, `/v2/catalog/object/${objectId}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error(`Square could not delete ${objectId}: ${response.status} ${await response.text()}`);
}

/**
 * Delete an event (the Showtimes page's Delete event).
 *  - No ticket ever made for it: deleted outright, in Square (item, showtime
 *    list, poster) and in IndieTix.
 *  - Tickets made: ended instead, so sales history and box-office reports
 *    keep their event. Every upcoming showtime is cancelled (removed from
 *    Square) and the item archived. Nothing is refunded; the number of
 *    tickets for the cancelled showtimes is returned so staff can refund.
 * @returns {Promise<{ action: 'deleted' } | { action: 'ended', cancelledShowtimes, ticketsToRefund, archived, archiveError }>}
 */
export async function deleteEvent(pool, accessToken, eventId) {
  const outcome = await inEventTransaction(pool, eventId, async (client, event, link) => {
    if (await ticketsEverSold(client, eventId) === 0) {
      await deleteFromSquare(accessToken, link.ITEM); // its variations go with it
      for (const extra of [link.MODIFIER_LIST, link.IMAGE].filter(Boolean)) {
        await deleteFromSquare(accessToken, extra).catch((e) => console.error(`Event ${eventId} deleted, but ${extra} was left in Square:`, e.message));
      }
      await client.query(`DELETE FROM "ExternalCatalogLink" WHERE "EntityType" = 'showing' AND "EntityID" IN (SELECT "ID" FROM "Showing" WHERE "EventID" = $1)`, [eventId]);
      await client.query(`DELETE FROM "ExternalCatalogLink" WHERE "EntityType" = 'ticket_type' AND "EntityID" IN (SELECT "ID" FROM "TicketType" WHERE "EventID" = $1)`, [eventId]);
      await client.query(`DELETE FROM "ExternalCatalogLink" WHERE "EntityType" = 'event' AND "EntityID" = $1`, [eventId]);
      await client.query(`DELETE FROM "Showing" WHERE "EventID" = $1`, [eventId]);
      await client.query(`DELETE FROM "TicketType" WHERE "EventID" = $1`, [eventId]);
      await client.query(`DELETE FROM "Event" WHERE "ID" = $1`, [eventId]);
      console.log(`Event ${eventId} "${event.Title}" deleted (no tickets); Square item ${link.ITEM} deleted`);
      return { deleted: true };
    }
    const upcoming = await client.query(
      `SELECT "ID" FROM "Showing" WHERE "EventID" = $1 AND "Status" IN ('on_sale', 'sold_out') AND "StartsAt" >= ${CHICAGO_NOW} ORDER BY "StartsAt"`, [eventId]);
    let ticketsToRefund = 0;
    for (const { ID } of upcoming.rows) {
      ticketsToRefund += await soldFor(client, eventId, ID);
      await client.query(`UPDATE "Showing" SET "Status" = 'cancelled' WHERE "ID" = $1`, [ID]);
      await removeShowtimeFromSquare(client, accessToken, ID);
    }
    await client.query(`UPDATE "Event" SET "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
    console.log(`Event ${eventId} "${event.Title}" ended: ${upcoming.rows.length} upcoming showtimes cancelled, ${ticketsToRefund} tickets for them not refunded`);
    return { deleted: false, cancelledShowtimes: upcoming.rows.length, ticketsToRefund, itemId: link.ITEM };
  });
  if (outcome.deleted) return { action: 'deleted' };
  // After the commit, as in cancelShowing: the showtimes are already off sale.
  let archived = false;
  let archiveError = null;
  try {
    await squareApi.archiveItem(accessToken, outcome.itemId);
    await pool.query(`UPDATE "Event" SET "Status" = 'archived', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
    archived = true;
  } catch (error) {
    console.error(`Event ${eventId} ended, but archiving Square item ${outcome.itemId} failed:`, error.message);
    archiveError = 'Its showtimes are off sale, but the item could not be archived in Square; archive it there.';
  }
  return { action: 'ended', cancelledShowtimes: outcome.cancelledShowtimes, ticketsToRefund: outcome.ticketsToRefund, archived, archiveError };
}
// ---- END EVENT DETAILS ----

// ---- SHOWING SALES SYNC ----
// Keeps a showing's on-sale state in line with its sold count after anything
// changes that count or its seats here: a refund, an order cancelled or
// deleted, a seat change, an import. (getSquareOrders does the same check
// when a ticket is sold.)
//  - sold out, and room again -> back on sale: a new showtime in Square (the
//    old one was deleted), and the item unarchived if selling out archived it
//  - on sale, full, and the venue has ENFORCE_CAPACITY on -> sold out: the
//    showtime removed from Square, the item archived if nothing upcoming is
//    left on sale
// Past, cancelled, expired and no-limit showings are left alone. Never
// throws: a refund must not fail because Square couldn't be updated. Failures
// log SHOWING_SYNC_FAILED (alarm <prefix>-showtime-out-of-sync).

/** The showings (with their event) that these tickets count toward. */
export async function showingsForTickets(pool, ticketIds) {
  const ids = [...new Set((ticketIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return [];
  const result = await pool.query(`
    SELECT DISTINCT s."ID" AS "ShowingID", s."EventID"
    FROM "QRCodeProduct" q
    JOIN "Showing" s ON s."ID" = q."ShowingID"
    WHERE q."ID" = ANY($1::int[])
    UNION
    SELECT DISTINCT s."ID", s."EventID"
    FROM "QRCodeProduct" q
    JOIN "ExternalCatalogLink" l
      ON l."EntityType" = 'showing' AND l."ExternalType" = 'MODIFIER'
     AND q."ProductMetadata" @> jsonb_build_object('modifiers', jsonb_build_array(jsonb_build_object('catalog_object_id', l."ExternalID")))
    JOIN "Showing" s ON s."ID" = l."EntityID"
    WHERE q."ID" = ANY($1::int[])`, [ids]);
  return result.rows.map((r) => ({ showingId: r.ShowingID, eventId: r.EventID }));
}

/**
 * @param {Array<{showingId, eventId}>} showings
 * @param {{ accessToken: string, enforceCapacity: boolean }} options
 * @returns {Promise<Array<{ showingId, action: 'none'|'reopened'|'sold_out', label?, unarchived?, archived?, error? }>>}
 */
export async function syncShowingSales(pool, showings, { accessToken, enforceCapacity }) {
  const results = [];
  if (!accessToken) return results;
  const seen = new Set();
  for (const { showingId, eventId } of showings || []) {
    if (seen.has(showingId)) continue;
    seen.add(showingId);
    try {
      results.push(await syncOneShowing(pool, accessToken, enforceCapacity, eventId, showingId));
    } catch (error) {
      // Not linked to Square, a draft, or no tables: nothing to keep in step.
      if (error instanceof ShowtimeError) { results.push({ showingId, action: 'none' }); continue; }
      console.error(`SHOWING_SYNC_FAILED: showing ${showingId}: ${error.message}. Its on-sale state in Square may not match its seats; check the Showtimes page.`);
      results.push({ showingId, action: 'none', error: error.message });
    }
  }
  return results;
}

async function syncOneShowing(pool, accessToken, enforceCapacity, eventId, showingId) {
  let createdModifierId = null;
  let outcome;
  try {
    outcome = await inEventTransaction(pool, eventId, async (client, event, link) => {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SHOWING_LOCK_CLASS, showingId]);
      const showing = await loadShowing(client, eventId, showingId);
      if (showing.IsPast || showing.Capacity === null || !['on_sale', 'sold_out'].includes(showing.Status)) return { showingId, action: 'none' };
      const sold = await soldFor(client, eventId, showingId);
      const sellable = showing.Capacity - showing.HeldSeats;

      if (showing.Status === 'sold_out' && sold < sellable) {
        createdModifierId = await createShowtimeModifier(client, accessToken, event, link, showingId, showing.Label);
        await client.query(`UPDATE "Showing" SET "Status" = 'on_sale', "SoldOutAt" = NULL WHERE "ID" = $1`, [showingId]);
        const unarchived = await unarchiveIfArchived(client, accessToken, event, link);
        await client.query(`UPDATE "Event" SET "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
        console.log(`SHOWING_REOPENED: showing ${showingId} ("${showing.Label}") has ${sellable - sold} seat(s) again; back on sale in Square${unarchived ? ', item unarchived' : ''}.`);
        return { showingId, action: 'reopened', label: showing.Label, unarchived };
      }

      if (showing.Status === 'on_sale' && enforceCapacity && sold >= sellable) {
        const links = await client.query(
          `SELECT "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "ExternalType" = 'MODIFIER' AND "Provider" = 'square' AND "DeletedAt" IS NULL`,
          [showingId]);
        for (const { ExternalID } of links.rows) {
          const response = await squareApi.squareFetch(accessToken, `/v2/catalog/object/${ExternalID}`, { method: 'DELETE' });
          if (!response.ok && response.status !== 404) throw new Error(`Square could not remove showtime ${ExternalID}: ${response.status} ${await response.text()}`);
        }
        await client.query(
          `UPDATE "ExternalCatalogLink" SET "DeletedAt" = CURRENT_TIMESTAMP, "DeletedReason" = 'sold_out' WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "ExternalType" = 'MODIFIER' AND "DeletedAt" IS NULL`,
          [showingId]);
        await client.query(`UPDATE "Showing" SET "Status" = 'sold_out', "SoldOutAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [showingId]);
        const remaining = await client.query(
          `SELECT COUNT(*)::int AS n FROM "Showing" WHERE "EventID" = $1 AND "Status" = 'on_sale' AND "StartsAt" >= ${CHICAGO_NOW}`, [eventId]);
        await client.query(`UPDATE "Event" SET "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
        console.log(`SHOWING_SOLD_OUT: showing ${showingId} ("${showing.Label}") sold ${sold} of ${sellable}; removed from Square.`);
        return { showingId, action: 'sold_out', label: showing.Label, archiveItemId: remaining.rows[0].n === 0 && event.Status === 'active' ? link.ITEM : null };
      }
      return { showingId, action: 'none' };
    });
  } catch (error) {
    if (createdModifierId) {
      await squareApi.deleteCatalogObject(accessToken, createdModifierId).catch((e) => console.error(`Could not remove showtime ${createdModifierId} from Square after a failed reopen:`, e.message));
    }
    throw error;
  }

  // After the commit, like cancelShowing: the showtime is already off sale.
  const { archiveItemId, ...result } = outcome;
  if (archiveItemId) {
    try {
      await squareApi.archiveItem(accessToken, archiveItemId);
      await pool.query(`UPDATE "Event" SET "Status" = 'archived', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
      result.archived = true;
    } catch (error) {
      console.error(`SHOWING_SYNC_FAILED: showing ${showingId} sold out and was removed, but archiving Square item ${archiveItemId} failed: ${error.message}`);
      result.archived = false;
    }
  }
  return result;
}
// ---- END SHOWING SALES SYNC ----
// ---- END SHOWTIME MANAGEMENT ----

// ---- SQUARE IMPORT ----
// One-time (re-runnable) import of a venue's existing Square ticket items
// into its own native event tables (NATIVE_EVENTS_PLAN.md step 4), from the
// Showtimes page. Uses only this venue's Square token and database.
// A ticket item = not archived, with the venue's USE_QR_CODE attribute true
// on the item or a variation (getSquareOrders' own test). Items already
// linked are skipped, so running it again only brings in new ones.

async function squareJson(accessToken, path, init) {
  const response = await squareApi.squareFetch(accessToken, path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Square ${init?.method || 'GET'} ${path.split('?')[0]}: ${response.status}`);
  return body;
}

async function listAll(accessToken, types) {
  const objects = [];
  let cursor;
  do {
    const page = await squareJson(accessToken, `/v2/catalog/list?types=${types}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { method: 'GET' });
    objects.push(...(page.objects || []));
    cursor = page.cursor;
  } while (cursor);
  return objects;
}

async function batchRetrieve(accessToken, ids) {
  const objects = [];
  for (let i = 0; i < ids.length; i += 500) {
    const page = await squareJson(accessToken, '/v2/catalog/batch-retrieve', { method: 'POST', body: JSON.stringify({ object_ids: ids.slice(i, i + 500) }) });
    objects.push(...(page.objects || []));
  }
  return objects;
}

// The value of a named custom attribute on the item, else on its first
// variation that has it (same order getSquareOrders reads them).
function attributeOf(item, name) {
  const all = [item.custom_attribute_values, ...(item.item_data?.variations || []).map((v) => v.custom_attribute_values)];
  for (const values of all) {
    for (const attr of Object.values(values || {})) if (attr?.name === name) return attr;
  }
  return null;
}

function isTicketItem(item, useQrName) {
  if (item.type !== 'ITEM' || item.is_deleted || item.item_data?.is_archived) return false;
  const all = [item.custom_attribute_values, ...(item.item_data?.variations || []).map((v) => v.custom_attribute_values)];
  return all.some((values) => Object.values(values || {}).some((a) => a?.name === useQrName && a.boolean_value === true));
}

/**
 * @param {object} config the venue's configuration (USE_QR_CODE, EVENT_TYPE,
 *   DISTRIBUTOR_NAME, MODIFIER_NAME_FILTER, ROOM_CAPACITY)
 * @param {{ dryRun: boolean }} options dryRun = report only, write nothing
 * @returns {Promise<{ dryRun, imported: [...], skipped: [...], problems: [...] }>}
 */
export async function importFromSquare(pool, accessToken, config, { dryRun = true } = {}) {
  const useQrName = config.USE_QR_CODE || 'UseQRCode';
  const eventTypeName = config.EVENT_TYPE || 'EventType';
  const distributorName = config.DISTRIBUTOR_NAME || 'Distributor';
  const listFilter = String(config.MODIFIER_NAME_FILTER || 'Show Time').toLowerCase();

  let linkedItems;
  try {
    linkedItems = new Set((await pool.query(
      `SELECT "ExternalID" FROM "ExternalCatalogLink" WHERE "Provider" = 'square' AND "EntityType" = 'event' AND "ExternalType" = 'ITEM' AND "DeletedAt" IS NULL`)).rows.map((r) => r.ExternalID));
  } catch (error) { throw wrapMissingTables(error); }

  const items = (await listAll(accessToken, 'ITEM')).filter((item) => isTicketItem(item, useQrName));
  const definitions = await listAll(accessToken, 'CUSTOM_ATTRIBUTE_DEFINITION');
  const selectionName = (attr) => {
    const uid = attr?.selection_uid_values?.[0];
    if (!uid) return null;
    const def = definitions.find((d) => d.id === attr.custom_attribute_definition_id);
    return def?.custom_attribute_definition_data?.selection_config?.allowed_selections?.find((s) => s.uid === uid)?.name || null;
  };
  const listIds = [...new Set(items.flatMap((i) => (i.item_data?.modifier_list_info || []).map((m) => m.modifier_list_id)))];
  const lists = new Map((listIds.length ? await batchRetrieve(accessToken, listIds) : []).map((o) => [o.id, o]));

  const enforceCapacity = config.ENFORCE_CAPACITY === true || config.ENFORCE_CAPACITY === 'true';
  const report = { dryRun, enforceCapacity, imported: [], skipped: [], problems: [] };
  for (const item of items) {
    const title = item.item_data?.name || item.id;
    if (linkedItems.has(item.id)) { report.skipped.push({ title, reason: 'already in IndieTix' }); continue; }
    const itemLists = (item.item_data?.modifier_list_info || []).map((m) => lists.get(m.modifier_list_id)).filter(Boolean);
    const showtimeList = itemLists.find((l) => String(l.modifier_list_data?.name || '').toLowerCase().includes(listFilter))
      || (itemLists.length === 1 ? itemLists[0] : null);
    if (!showtimeList) { report.skipped.push({ title, reason: 'no showtime list found on the item' }); continue; }

    const showings = [];
    const unreadable = [];
    for (const modifier of showtimeList.modifier_list_data?.modifiers || []) {
      const parsed = parseShowtimeLabel(modifier.modifier_data?.name);
      if (parsed) showings.push({ ...parsed, modifierId: modifier.id, ordinal: modifier.modifier_data?.ordinal ?? 0 });
      else unreadable.push(modifier.modifier_data?.name || modifier.id);
    }
    showings.sort((a, b) => a.ordinal - b.ordinal);
    if (unreadable.length) report.problems.push({ title, problem: `showtime text not understood, left out (its sales are still ticketed, but flagged): ${unreadable.join('; ')}` });

    const eventType = selectionName(attributeOf(item, eventTypeName));
    const variations = (item.item_data?.variations || []).filter((v) => !v.is_deleted);
    const plan = {
      title,
      kind: eventType && eventType.toLowerCase() === 'movie' ? 'movie' : 'event',
      eventType,
      distributor: selectionName(attributeOf(item, distributorName)),
      description: item.item_data?.description_plaintext || null,
      ticketTypes: variations.map((v) => ({ name: v.item_variation_data?.name || 'Ticket', price: (v.item_variation_data?.price_money?.amount ?? 0) / 100, variationId: v.id })),
      showings,
      itemId: item.id,
      modifierListId: showtimeList.id,
      // So the nightly drift check can tell when the poster is changed in Square.
      imageId: item.item_data?.image_ids?.[0] || null
    };
    // Showtimes whose tickets already fill their room's seats.
    const full = await fullShowtimes(pool, showings, config.ROOM_CAPACITY);
    if (dryRun) {
      report.imported.push({ title, kind: plan.kind, showtimes: showings.length, ticketTypes: plan.ticketTypes.map((t) => t.name), full });
      continue;
    }
    try {
      const result = await saveImportedEvent(pool, plan, config.ROOM_CAPACITY);
      const entry = { title, kind: plan.kind, showtimes: showings.length, ticketTypes: plan.ticketTypes.map((t) => t.name), eventId: result.eventId, ticketsLinked: result.ticketsLinked, full };
      if (enforceCapacity && full.length) {
        const synced = await syncShowingSales(pool, result.showingIds.map((id) => ({ showingId: id, eventId: result.eventId })), { accessToken, enforceCapacity });
        entry.soldOut = synced.filter((s) => s.action === 'sold_out').map((s) => s.label);
        if (synced.some((s) => s.error)) report.problems.push({ title, problem: 'a full showtime could not be taken off sale in Square; check it on the Showtimes page' });
      }
      report.imported.push(entry);
    } catch (error) {
      report.problems.push({ title, problem: `not imported: ${error.message}` });
    }
  }
  return report;
}

// Labels of the upcoming showtimes whose sold tickets already reach their
// room's seats (the capacity the import will give them).
async function fullShowtimes(pool, showings, roomCapacities) {
  const withSeats = showings.filter((s) => roomCapacity(roomCapacities, s.venue) !== null);
  if (withSeats.length === 0) return [];
  const result = await pool.query(`
    SELECT m."ModifierID", COUNT(DISTINCT q."ID")::int AS "Sold"
    FROM unnest($1::text[], $2::timestamp[]) AS m("ModifierID", "StartsAt")
    LEFT JOIN "QRCodeProduct" q
      ON q."ProductMetadata" @> jsonb_build_object('modifiers', jsonb_build_array(jsonb_build_object('catalog_object_id', m."ModifierID")))
     AND COALESCE(q."Status", 'valid') <> ALL($3::text[])
    WHERE m."StartsAt" >= ${CHICAGO_NOW}
    GROUP BY m."ModifierID"`,
    [withSeats.map((s) => s.modifierId), withSeats.map((s) => s.startsAt), NOT_SOLD]);
  const sold = new Map(result.rows.map((r) => [r.ModifierID, r.Sold]));
  return withSeats.filter((s) => sold.has(s.modifierId) && sold.get(s.modifierId) >= roomCapacity(roomCapacities, s.venue)).map((s) => s.label);
}

async function saveImportedEvent(pool, plan, roomCapacities) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const eventId = (await client.query(
      `INSERT INTO "Event" ("Kind", "Title", "EventType", "Distributor", "Description", "Status", "CreatedBy") VALUES ($1, $2, $3, $4, $5, 'active', 'square-import') RETURNING "ID"`,
      [plan.kind, plan.title, plan.eventType, plan.distributor, plan.description])).rows[0].ID;
    const link = (type, id, extType, extId) => client.query(
      `INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ($1, $2, 'square', $3, $4)`, [type, id, extType, extId]);
    await link('event', eventId, 'ITEM', plan.itemId);
    await link('event', eventId, 'MODIFIER_LIST', plan.modifierListId);
    if (plan.imageId) await link('event', eventId, 'IMAGE', plan.imageId);
    for (const [i, t] of plan.ticketTypes.entries()) {
      const id = (await client.query(`INSERT INTO "TicketType" ("EventID", "Name", "PriceCents", "SortOrder") VALUES ($1, $2, $3, $4) RETURNING "ID"`,
        [eventId, t.name, Math.round(t.price * 100), i])).rows[0].ID;
      await link('ticket_type', id, 'ITEM_VARIATION', t.variationId);
    }
    let ticketsLinked = 0;
    const showingIds = [];
    for (const s of plan.showings) {
      const id = (await client.query(
        `INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Descriptors", "Label", "Capacity") VALUES ($1, $2, $3, $4, $5, $6) RETURNING "ID"`,
        [eventId, s.startsAt, s.venue, s.descriptors.join(', '), s.label, roomCapacity(roomCapacities, s.venue)])).rows[0].ID;
      await link('showing', id, 'MODIFIER', s.modifierId);
      showingIds.push(id);
      // Tickets already sold for this showtime get their ShowingID.
      const updated = await client.query(
        `UPDATE "QRCodeProduct" SET "ShowingID" = $1
         WHERE "ShowingID" IS NULL AND "ProductMetadata" @> jsonb_build_object('modifiers', jsonb_build_array(jsonb_build_object('catalog_object_id', $2::text)))`,
        [id, s.modifierId]);
      ticketsLinked += updated.rowCount;
    }
    await client.query('COMMIT');
    return { eventId, ticketsLinked, showingIds };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new Error('one of its Square objects is already linked to another IndieTix event');
    throw error;
  } finally {
    client.release();
  }
}
// ---- END SQUARE IMPORT ----

// ---- END NATIVE EVENTS ----
