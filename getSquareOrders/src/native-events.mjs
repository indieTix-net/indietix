// ---- NATIVE EVENTS (step 3) ----
// Which IndieTix showing a ticket is for, and stopping sales when one is
// full. Tables (Event, Showing, ExternalCatalogLink, QRCodeProduct.ShowingID)
// come from clientSetup-Teardown's 2026-11-20 migration and are written by
// QRScanner's Add Movie/Event and Showtimes page. See NATIVE_EVENTS_PLAN.md.
//
// Nothing here may fail an order: every function catches its own errors.
// A venue database without the tables (42P01) behaves exactly as before.
import * as squareApi from 'square-api-lib';

const UNDEFINED_TABLE = '42P01';
const NOT_SOLD = ['refunded', 'cancelled', 'canceled', 'transferred'];
const CHICAGO_NOW = `(NOW() AT TIME ZONE 'America/Chicago')`;
// Same lock class QRScanner's Showtimes page takes per event (7101); this
// one is per showing.
const SHOWING_LOCK_CLASS = 7102;

/**
 * Look up the showings for a sale's line items.
 * @param pool venue DB pool
 * @param lineItems [{ variationId, modifierId }] (Square catalog object ids)
 * @returns {Promise<{ byModifier: Map<string, {showingId, eventId, startsAt, venue, status}>, knownVariations: Set<string> }>}
 *   byModifier: every modifier id a showing ever had (deleted ones too: a
 *   ticket can arrive seconds after its showtime sold out). knownVariations:
 *   ticket variations of items IndieTix has its own copy of.
 */
export async function lookupShowings(pool, lineItems) {
  const empty = { byModifier: new Map(), knownVariations: new Set() };
  const modifierIds = [...new Set(lineItems.map((l) => l.modifierId).filter(Boolean))];
  const variationIds = [...new Set(lineItems.map((l) => l.variationId).filter(Boolean))];
  if (modifierIds.length === 0 && variationIds.length === 0) return empty;
  try {
    const showings = await pool.query(`
      SELECT l."ExternalID", s."ID", s."EventID", s."StartsAt"::text AS "StartsAt", s."Venue", s."Status"
      FROM "ExternalCatalogLink" l JOIN "Showing" s ON s."ID" = l."EntityID"
      WHERE l."Provider" = 'square' AND l."EntityType" = 'showing' AND l."ExternalType" = 'MODIFIER' AND l."ExternalID" = ANY($1::text[])`,
      [modifierIds]);
    const variations = await pool.query(`
      SELECT "ExternalID" FROM "ExternalCatalogLink"
      WHERE "Provider" = 'square' AND "EntityType" = 'ticket_type' AND "ExternalType" = 'ITEM_VARIATION' AND "ExternalID" = ANY($1::text[])`,
      [variationIds]);
    return {
      byModifier: new Map(showings.rows.map((r) => [r.ExternalID, { showingId: r.ID, eventId: r.EventID, startsAt: r.StartsAt, venue: r.Venue, status: r.Status }])),
      knownVariations: new Set(variations.rows.map((r) => r.ExternalID))
    };
  } catch (error) {
    if (error.code !== UNDEFINED_TABLE) console.error('Showing lookup failed (tickets are issued from the showtime text, as before):', error.message);
    return empty;
  }
}

/**
 * Stop selling showings that are now full: remove the showtime modifier from
 * Square (gone online and at the register), mark the showing sold out, and
 * archive the item if no upcoming showing is left on sale. Runs after the
 * tickets are saved; a paid ticket is never refused (an overshoot of one or
 * two is possible during webhook lag).
 * @param {number[]} showingIds showings this order sold tickets for
 * @returns {Promise<Array<{showingId, soldOut, archived}>>}
 */
export async function enforceCapacity(pool, accessToken, showingIds) {
  const results = [];
  for (const showingId of [...new Set(showingIds)]) {
    try {
      results.push(await enforceOne(pool, accessToken, showingId));
    } catch (error) {
      console.error(`CAPACITY_ENFORCEMENT_FAILED: showing ${showingId}: ${error.message}. It may still be on sale in Square past its capacity; check the Showtimes page.`);
      results.push({ showingId, soldOut: false, error: error.message });
    }
  }
  return results;
}

async function enforceOne(pool, accessToken, showingId) {
  const client = await pool.connect();
  let archiveItemId = null;
  let eventId = null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [SHOWING_LOCK_CLASS, showingId]);
    const showing = (await client.query(`SELECT * FROM "Showing" WHERE "ID" = $1`, [showingId])).rows[0];
    if (!showing || showing.Status !== 'on_sale' || showing.Capacity === null) {
      await client.query('COMMIT');
      return { showingId, soldOut: false };
    }
    const sold = (await client.query(`
      SELECT COUNT(DISTINCT q."ID")::int AS n
      FROM "QRCodeProduct" q
      WHERE COALESCE(q."Status", 'valid') <> ALL($2::text[])
        AND (q."ShowingID" = $1 OR EXISTS (
          SELECT 1 FROM "ExternalCatalogLink" l
          WHERE l."EntityType" = 'showing' AND l."EntityID" = $1 AND l."ExternalType" = 'MODIFIER'
            AND q."ProductMetadata" @> jsonb_build_object('modifiers', jsonb_build_array(jsonb_build_object('catalog_object_id', l."ExternalID")))))`,
      [showingId, NOT_SOLD])).rows[0].n;
    const sellable = showing.Capacity - showing.HeldSeats;
    if (sold < sellable) {
      await client.query('COMMIT');
      return { showingId, soldOut: false, sold, sellable };
    }

    const links = await client.query(
      `SELECT "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "ExternalType" = 'MODIFIER' AND "Provider" = 'square' AND "DeletedAt" IS NULL`,
      [showingId]);
    for (const { ExternalID } of links.rows) {
      const response = await squareApi.squareFetch(accessToken, `/v2/catalog/object/${ExternalID}`, { method: 'DELETE' });
      // 404: already gone (expired, or removed in Square by hand).
      if (!response.ok && response.status !== 404) throw new Error(`Square could not remove showtime ${ExternalID}: ${response.status} ${await response.text()}`);
    }
    await client.query(
      `UPDATE "ExternalCatalogLink" SET "DeletedAt" = CURRENT_TIMESTAMP, "DeletedReason" = 'sold_out' WHERE "EntityType" = 'showing' AND "EntityID" = $1 AND "ExternalType" = 'MODIFIER' AND "DeletedAt" IS NULL`,
      [showingId]);
    await client.query(`UPDATE "Showing" SET "Status" = 'sold_out', "SoldOutAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [showingId]);
    console.log(`SHOWING_SOLD_OUT: showing ${showingId} ("${showing.Label}") sold ${sold} of ${sellable}; removed from Square.`);

    eventId = showing.EventID;
    const remaining = (await client.query(
      `SELECT COUNT(*)::int AS n FROM "Showing" WHERE "EventID" = $1 AND "Status" = 'on_sale' AND "StartsAt" >= ${CHICAGO_NOW}`, [eventId])).rows[0].n;
    if (remaining === 0) {
      archiveItemId = (await client.query(
        `SELECT "ExternalID" FROM "ExternalCatalogLink" WHERE "EntityType" = 'event' AND "EntityID" = $1 AND "ExternalType" = 'ITEM' AND "Provider" = 'square' AND "DeletedAt" IS NULL`,
        [eventId])).rows[0]?.ExternalID || null;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === UNDEFINED_TABLE) return { showingId, soldOut: false };
    throw error;
  } finally {
    client.release();
  }

  // After the commit: the showtime is already off sale, so archiving the
  // now-empty item can fail without undoing that.
  let archived = false;
  if (archiveItemId) {
    try {
      await squareApi.archiveItem(accessToken, archiveItemId);
      await pool.query(`UPDATE "Event" SET "Status" = 'archived', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1`, [eventId]);
      archived = true;
    } catch (error) {
      console.error(`CAPACITY_ENFORCEMENT_FAILED: showing ${showingId} sold out and was removed, but archiving Square item ${archiveItemId} failed: ${error.message}`);
    }
  }
  return { showingId, soldOut: true, archived };
}
// ---- END NATIVE EVENTS ----
