// ---- NATIVE EVENTS (nightly sync + drift check) ----
// After this job has cleaned up Square (past showtimes removed, finished
// items archived), bring the venue's own event records in line with it and
// report anything changed in Square by hand. Tables come from
// clientSetup-Teardown's 2026-11-20 migration; see NATIVE_EVENTS_PLAN.md.
//
// Updates IndieTix's records (never Square):
//  - showings more than 5 hours past (the same grace this job gives Square)
//    -> 'expired'; their showtime links closed once Square no longer has them
//  - events whose Square item is archived -> 'archived'
// Reports, without changing anything (SHOWTIME_DRIFT, alarm
// <prefix>-showtime-out-of-sync):
//  - a showtime on the item's Square list that IndieTix doesn't know
//    (added in Square instead of on the Showtimes page)
//  - an upcoming on-sale showtime missing from Square (deleted there by hand)
//  - a showtime renamed in Square
//  - an item deleted from Square, or unarchived there while IndieTix has it
//    archived
// A venue database without the tables is skipped quietly.
import pg from 'pg';
import * as squareApi from 'square-api-lib';

const { Client } = pg;
const UNDEFINED_TABLE = '42P01';
const PAST_GRACE = `((NOW() AT TIME ZONE 'America/Chicago') - INTERVAL '5 hours')`;
const CHICAGO_NOW = `(NOW() AT TIME ZONE 'America/Chicago')`;

async function batchRetrieve(accessToken, ids) {
  const objects = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const response = await squareApi.squareFetch(accessToken, '/v2/catalog/batch-retrieve', {
      method: 'POST',
      body: JSON.stringify({ object_ids: ids.slice(i, i + 1000) })
    });
    if (!response.ok) throw new Error(`Square batch-retrieve: ${response.status} ${await response.text()}`);
    const body = await response.json();
    for (const o of body.objects || []) objects.set(o.id, o);
  }
  return objects;
}

/**
 * @param {object} dbConfig connection settings for the venue's own database
 * @param {string} accessToken the venue's Square token
 * @param {string} clientId for log lines
 * @returns {Promise<{ skipped?: string, showingsExpired: number, linksClosed: number, eventsArchived: number, drift: string[] }>}
 */
export async function syncNativeEvents(dbConfig, accessToken, clientId) {
  const summary = { showingsExpired: 0, linksClosed: 0, eventsArchived: 0, drift: [] };
  const db = new Client(dbConfig);
  await db.connect();
  try {
    let events;
    try {
      events = (await db.query(`
        SELECT e."ID", e."Title", e."Status",
               MAX(l."ExternalID") FILTER (WHERE l."ExternalType" = 'ITEM') AS "ItemID",
               MAX(l."ExternalID") FILTER (WHERE l."ExternalType" = 'MODIFIER_LIST') AS "ListID"
        FROM "Event" e
        JOIN "ExternalCatalogLink" l ON l."EntityType" = 'event' AND l."EntityID" = e."ID" AND l."Provider" = 'square' AND l."DeletedAt" IS NULL
        WHERE e."Status" IN ('active', 'archived')
        GROUP BY e."ID"`)).rows;
    } catch (error) {
      if (error.code === UNDEFINED_TABLE) return { ...summary, skipped: 'no native event tables' };
      throw error;
    }

    // 1. Past showings -> expired (whatever Square says).
    summary.showingsExpired = (await db.query(
      `UPDATE "Showing" SET "Status" = 'expired' WHERE "Status" IN ('on_sale', 'sold_out') AND "StartsAt" < ${PAST_GRACE}`)).rowCount;
    if (events.length === 0) return summary;

    const ids = [...new Set(events.flatMap((e) => [e.ItemID, e.ListID]).filter(Boolean))];
    const square = await batchRetrieve(accessToken, ids);

    const showings = (await db.query(`
      SELECT s."ID", s."EventID", s."Label", s."Status", (s."StartsAt" >= ${CHICAGO_NOW}) AS "Upcoming",
             l."ExternalID", l."DeletedAt"
      FROM "Showing" s
      LEFT JOIN "ExternalCatalogLink" l ON l."EntityType" = 'showing' AND l."EntityID" = s."ID" AND l."ExternalType" = 'MODIFIER' AND l."Provider" = 'square'
      WHERE s."EventID" = ANY($1::int[])`, [events.map((e) => e.ID)])).rows;

    for (const event of events) {
      const drift = (message) => {
        summary.drift.push(`"${event.Title}": ${message}`);
        console.error(`SHOWTIME_DRIFT: ${clientId}: event ${event.ID} "${event.Title}": ${message}. Fix it on the Showtimes page (or undo the change in Square).`);
      };
      const item = event.ItemID ? square.get(event.ItemID) : null;
      if (event.ItemID && !item) { drift('its Square item was deleted in Square'); continue; }
      const archivedInSquare = item?.item_data?.is_archived === true;

      // 2. Item archived in Square (by this job or by hand) -> event archived.
      if (archivedInSquare && event.Status === 'active') {
        await db.query(`UPDATE "Event" SET "Status" = 'archived', "UpdatedAt" = CURRENT_TIMESTAMP WHERE "ID" = $1 AND "Status" = 'active'`, [event.ID]);
        summary.eventsArchived += 1;
      } else if (!archivedInSquare && event.Status === 'archived') {
        drift('its Square item was unarchived in Square, but IndieTix has it archived');
      }

      const list = event.ListID ? square.get(event.ListID) : null;
      const inSquare = new Map((list?.modifier_list_data?.modifiers || []).map((m) => [m.id, m.modifier_data?.name || '']));
      const mine = showings.filter((s) => s.EventID === event.ID);
      const everLinked = new Set(mine.map((s) => s.ExternalID).filter(Boolean));

      for (const s of mine) {
        if (!s.ExternalID || s.DeletedAt) continue;
        if (!inSquare.has(s.ExternalID)) {
          // 3. Gone from Square: expected once it's past (this job removed it).
          if (s.Status === 'expired' || !s.Upcoming) {
            await db.query(
              `UPDATE "ExternalCatalogLink" SET "DeletedAt" = CURRENT_TIMESTAMP, "DeletedReason" = 'expired' WHERE "Provider" = 'square' AND "ExternalID" = $1 AND "DeletedAt" IS NULL`,
              [s.ExternalID]);
            summary.linksClosed += 1;
          } else if (s.Status === 'on_sale') {
            drift(`showtime "${s.Label}" was removed from Square, but IndieTix still has it on sale`);
          }
        } else if (inSquare.get(s.ExternalID) !== s.Label && s.Upcoming) {
          drift(`showtime "${s.Label}" was renamed in Square to "${inSquare.get(s.ExternalID)}"`);
        }
      }
      if (!archivedInSquare) {
        for (const [modifierId, name] of inSquare) {
          if (!everLinked.has(modifierId)) drift(`showtime "${name}" is in Square but not in IndieTix (added in Square)`);
        }
      }
    }
    return summary;
  } finally {
    await db.end().catch(() => {});
  }
}
// ---- END NATIVE EVENTS ----
