// ---- NATIVE EVENTS ----
// IndieTix's own record of an event (Event, TicketType, Showing) and of the
// POS objects it's published as (ExternalCatalogLink). Add Movie / Add Event
// write a draft here first, then create the Square item, then link the two
// and mark the event active. Sales still happen in the POS.
// See NATIVE_EVENTS_PLAN.md (step 2). Tables come from clientSetup-Teardown
// (createDatabaseObjects / migrations.sql, 2026-11-20).

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
 *   description, posterUrl, createdBy, ticketTypes: [{name, price}], showings: [parseShowtimeLabel()] }
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
        `INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Descriptors", "Label") VALUES ($1, $2, $3, $4, $5) RETURNING "ID"`,
        [eventId, s.startsAt, s.venue, s.descriptors.join(', '), s.label]
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
// ---- END NATIVE EVENTS ----
