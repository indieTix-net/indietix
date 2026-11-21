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

const DAYS = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
// "Sun 01-18-2026 7:00 PM (Spacement, 21+)" -- what getMovieInfo.js /
// getEventInfo.js formatShowtime() produce and Square shows as the modifier.
const LABEL_PATTERN = /^([A-Za-z]{3}) (\d{2})-(\d{2})-(\d{4}) (\d{1,2}):(\d{2}) (AM|PM)(?: \(([^()]*)\))?$/;

/**
 * Parse a showtime label into the Showing's fields, or null if it isn't in
 * the format the Add Movie/Event pages produce.
 * @returns {{ startsAt: string, venue: string, descriptors: string[], label: string } | null}
 *   startsAt is Chicago wall-clock 'YYYY-MM-DD HH:MM:00', the same value
 *   getSquareOrders stores as QRCodeProduct.ProductDate for this label.
 */
export function parseShowtimeLabel(label) {
  if (typeof label !== 'string') return null;
  const text = label.trim().replace(/\s+/g, ' ');
  const m = LABEL_PATTERN.exec(text);
  if (!m) return null;
  const [, day, mm, dd, yyyy, h, min, ampm, inParens] = m;
  if (!DAYS.has(day)) return null;
  const month = Number(mm); const date = Number(dd); const year = Number(yyyy);
  let hour = Number(h); const minute = Number(min);
  if (month < 1 || month > 12 || hour < 1 || hour > 12 || minute > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const parts = (inParens ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    startsAt: `${yyyy}-${mm}-${dd} ${pad(hour)}:${pad(minute)}:00`,
    // Same default getSquareOrders' parseItemModifierValues uses.
    venue: parts[0] || 'Main',
    descriptors: parts.slice(1),
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
    for (const s of e.showings) {
      const row = await client.query(
        `INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Descriptors", "Label", "Capacity") VALUES ($1, $2, $3, $4, $5, $6) RETURNING "ID"`,
        [eventId, s.startsAt, s.venue, s.descriptors.join(', '), s.label, roomCapacity(e.roomCapacities, s.venue)]
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

const NOT_SOLD = ['refunded', 'cancelled', 'canceled', 'transferred'];
const CHICAGO_NOW = `(NOW() AT TIME ZONE 'America/Chicago')`;
// Two-key advisory lock: one staff change per event at a time.
const EVENT_LOCK_CLASS = 7101;

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
    return {
      id: e.ID, kind: e.Kind, title: e.Title, eventType: e.EventType, distributor: e.Distributor, status: e.Status,
      showings: showings.rows.map((s) => ({
        id: s.ID, label: s.Label, startsAt: s.StartsAtText, venue: s.Venue, descriptors: s.Descriptors,
        status: s.Status, capacity: s.Capacity, heldSeats: s.HeldSeats, sold: s.Sold, isPast: s.IsPast,
        available: s.Capacity === null ? null : Math.max(0, s.Capacity - s.HeldSeats - s.Sold)
      }))
    };
  } catch (error) { throw wrapMissingTables(error); }
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

      // Next ordinal after the showtimes already in Square's list.
      const list = await squareApi.retrieveCatalogObject(accessToken, link.MODIFIER_LIST);
      const ordinals = (list.object?.modifier_list_data?.modifiers || []).map((m) => m.modifier_data?.ordinal || 0);
      const modifierData = { name: parsed.label, price_money: { amount: 0, currency: 'USD' }, ordinal: Math.max(0, ...ordinals) + 1, modifier_list_id: link.MODIFIER_LIST };
      const abbreviation = abbreviationFor(event, parsed.label);
      if (abbreviation) modifierData.abbreviation = abbreviation;
      const created = await squareApi.upsertCatalogObject(accessToken, {
        idempotency_key: `indietix-showing-${eventId}-${showingId}-${Date.now()}`,
        object: { type: 'MODIFIER', id: '#new_showtime', ...(list.object?.present_at_location_ids ? { present_at_location_ids: list.object.present_at_location_ids } : {}), modifier_data: modifierData }
      });
      createdModifierId = created.catalog_object?.id;
      if (!createdModifierId) throw new Error('Square did not return the new showtime\'s id');
      await client.query(
        `INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ('showing', $1, 'square', 'MODIFIER', $2)`,
        [showingId, createdModifierId]);

      // A showtime added to an archived event puts the item back on sale.
      let unarchived = false;
      if (event.Status === 'archived') {
        await squareApi.unarchiveItem(accessToken, link.ITEM);
        await client.query(`UPDATE "Event" SET "Status" = 'active', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
        unarchived = true;
      }
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
    const modifierId = await activeModifierId(client, showingId);
    if (modifierId) {
      const response = await squareApi.squareFetch(accessToken, `/v2/catalog/object/${modifierId}`, { method: 'DELETE' });
      // 404: already gone from Square (e.g. the nightly expiry job removed it).
      if (!response.ok && response.status !== 404) {
        throw new Error(`Square could not remove the showtime: ${response.status} ${await response.text()}`);
      }
      await client.query(
        `UPDATE "ExternalCatalogLink" SET "DeletedAt" = CURRENT_TIMESTAMP, "DeletedReason" = 'cancelled' WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "ExternalID" = $2`,
        [showingId, modifierId]);
    }
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
// ---- END SHOWTIME MANAGEMENT ----

// ---- END NATIVE EVENTS ----
