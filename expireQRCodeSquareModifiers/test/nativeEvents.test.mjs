import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { startPostgresContainer, stopPostgresContainer, createDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { syncNativeEvents } from '../src/native-events.mjs';

// ---- NATIVE EVENTS: the nightly sync + drift check ----
// A real venue database; Square's batch-retrieve stubbed on global fetch.

let adminConfig, containerName, venueConfig, db;
let squareObjects; // what Square "has", by id
let fetchCalls;
let originalFetch;

before(async () => {
  ({ dbConfig: adminConfig, containerName } = await startPostgresContainer());
  await createDatabase(adminConfig, 'venue_sync');
  venueConfig = { ...adminConfig, database: 'venue_sync' };
  await createDatabaseObjects(venueConfig, 'venue_sync', 1, 'Sync Theatre', 'ST');
  await createDatabase(adminConfig, 'venue_old');
  db = new pg.Client(venueConfig);
  await db.connect();
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method });
    if (!String(url).endsWith('/v2/catalog/batch-retrieve')) throw new Error(`unmocked Square call ${url}`);
    const { object_ids } = JSON.parse(options.body);
    const objects = object_ids.map((id) => squareObjects[id]).filter(Boolean);
    return { ok: true, status: 200, json: async () => ({ objects }), text: async () => '' };
  };
});
after(async () => {
  globalThis.fetch = originalFetch;
  await db.end();
  await stopPostgresContainer(containerName);
});

const item = (id, archived, name, extra = {}) => ({ type: 'ITEM', id, item_data: { name, is_archived: archived, ...extra } });
const list = (id, modifiers) => ({ type: 'MODIFIER_LIST', id, modifier_list_data: { name: 'Show Time', modifiers: modifiers.map(([mid, name]) => ({ type: 'MODIFIER', id: mid, modifier_data: { name } })) } });

async function event(title, status, itemId, listId, { description = null, imageId = null } = {}) {
  const id = (await db.query(`INSERT INTO "Event" ("Kind", "Title", "Status", "Description") VALUES ('movie', $1, $2, $3) RETURNING "ID"`, [title, status, description])).rows[0].ID;
  await db.query(`INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ('event', $1, 'square', 'ITEM', $2), ('event', $1, 'square', 'MODIFIER_LIST', $3)`, [id, itemId, listId]);
  if (imageId) await db.query(`INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID") VALUES ('event', $1, 'square', 'IMAGE', $2)`, [id, imageId]);
  return id;
}
async function showing(eventId, label, startsAt, status, modifierId, { linkDeleted = false } = {}) {
  const id = (await db.query(`INSERT INTO "Showing" ("EventID", "StartsAt", "Venue", "Label", "Status") VALUES ($1, $2, 'Main', $3, $4) RETURNING "ID"`, [eventId, startsAt, label, status])).rows[0].ID;
  await db.query(`INSERT INTO "ExternalCatalogLink" ("EntityType", "EntityID", "Provider", "ExternalType", "ExternalID", "DeletedAt", "DeletedReason") VALUES ('showing', $1, 'square', 'MODIFIER', $2, $3, $4)`,
    [id, modifierId, linkDeleted ? new Date() : null, linkDeleted ? 'sold_out' : null]);
  return id;
}
const statusOf = async (table, id) => (await db.query(`SELECT "Status" FROM "${table}" WHERE "ID" = $1`, [id])).rows[0].Status;
const linkClosed = async (modifierId) => (await db.query(`SELECT "DeletedReason" FROM "ExternalCatalogLink" WHERE "ExternalID" = $1`, [modifierId])).rows[0].DeletedReason;

async function quietly(work) {
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try { return { result: await work(), logged }; } finally { console.error = original; }
}

beforeEach(async () => {
  fetchCalls = [];
  squareObjects = {};
  for (const t of ['ExternalCatalogLink', 'Showing', 'Event']) await db.query(`DELETE FROM "${t}"`);
});

test('past showtimes are marked expired and their links closed once Square no longer has them; nothing is reported', async () => {
  const e = await event('Old Run', 'active', 'ITEM-A', 'LIST-A');
  const past = await showing(e, 'Fri 01-03-2020 7:00 PM (Main)', '2020-01-03 19:00', 'on_sale', 'MOD-PAST');
  const pastSoldOut = await showing(e, 'Sat 01-04-2020 7:00 PM (Main)', '2020-01-04 19:00', 'sold_out', 'MOD-PAST-SOLD', { linkDeleted: true });
  const upcoming = await showing(e, 'Fri 06-07-2030 7:00 PM (Main)', '2030-06-07 19:00', 'on_sale', 'MOD-UP');
  squareObjects = { 'ITEM-A': item('ITEM-A', false, 'Old Run'), 'LIST-A': list('LIST-A', [['MOD-UP', 'Fri 06-07-2030 7:00 PM (Main)']]) };

  const { result, logged } = await quietly(() => syncNativeEvents(venueConfig, 'token', 'venue_sync'));
  assert.deepEqual([result.showingsExpired, result.linksClosed, result.eventsArchived, result.drift], [2, 1, 0, []]);
  assert.equal(await statusOf('Showing', past), 'expired');
  assert.equal(await statusOf('Showing', pastSoldOut), 'expired');
  assert.equal(await statusOf('Showing', upcoming), 'on_sale');
  assert.equal(await linkClosed('MOD-PAST'), 'expired');
  assert.equal(await linkClosed('MOD-PAST-SOLD'), 'sold_out', 'an already-closed link keeps its reason');
  assert.equal(await linkClosed('MOD-UP'), null);
  assert.deepEqual(logged, []);
  assert.equal(fetchCalls.length, 1, 'one batch-retrieve, no writes to Square');
});

test('an event whose Square item was archived (by the expiry job or by hand) is archived in IndieTix', async () => {
  const e = await event('Finished', 'active', 'ITEM-B', 'LIST-B');
  squareObjects = { 'ITEM-B': item('ITEM-B', true, 'Finished'), 'LIST-B': list('LIST-B', [['MOD-LEFTOVER', 'Fri 06-07-2030 7:00 PM (Main)']]) };
  const { result, logged } = await quietly(() => syncNativeEvents(venueConfig, 'token', 'venue_sync'));
  assert.equal(result.eventsArchived, 1);
  assert.equal(await statusOf('Event', e), 'archived');
  assert.deepEqual(logged, [], 'an archived item\'s showtimes aren\'t drift');
});

test('drift: showtimes added, removed or renamed in Square, and items deleted or unarchived there, are reported and nothing is changed', async () => {
  const e = await event('Hand Edited', 'active', 'ITEM-C', 'LIST-C');
  await showing(e, 'Fri 06-07-2030 7:00 PM (Main)', '2030-06-07 19:00', 'on_sale', 'MOD-OK');
  const gone = await showing(e, 'Sat 06-08-2030 7:00 PM (Main)', '2030-06-08 19:00', 'on_sale', 'MOD-GONE');
  await showing(e, 'Sun 06-09-2030 7:00 PM (Main)', '2030-06-09 19:00', 'on_sale', 'MOD-RENAMED');
  await showing(e, 'Mon 06-10-2030 7:00 PM (Main)', '2030-06-10 19:00', 'sold_out', 'MOD-SOLD', { linkDeleted: true });
  const deleted = await event('Deleted In Square', 'active', 'ITEM-DELETED', 'LIST-DELETED');
  const unarchived = await event('Unarchived In Square', 'archived', 'ITEM-E', 'LIST-E');
  squareObjects = {
    'ITEM-C': item('ITEM-C', false, 'Hand Edited'),
    'LIST-C': list('LIST-C', [['MOD-OK', 'Fri 06-07-2030 7:00 PM (Main)'], ['MOD-RENAMED', 'Sun 06-09-2030 8:00 PM (Main)'], ['MOD-HAND', 'Tue 06-11-2030 7:00 PM (Main)']]),
    'ITEM-E': item('ITEM-E', false, 'Unarchived In Square'), 'LIST-E': list('LIST-E', [])
  };

  const { result, logged } = await quietly(() => syncNativeEvents(venueConfig, 'token', 'venue_sync'));
  assert.deepEqual(result.drift.sort(), [
    '"Deleted In Square": its Square item was deleted in Square',
    '"Hand Edited": showtime "Sat 06-08-2030 7:00 PM (Main)" was removed from Square, but IndieTix still has it on sale',
    '"Hand Edited": showtime "Sun 06-09-2030 7:00 PM (Main)" was renamed in Square to "Sun 06-09-2030 8:00 PM (Main)"',
    '"Hand Edited": showtime "Tue 06-11-2030 7:00 PM (Main)" is in Square but not in IndieTix (added in Square)',
    '"Unarchived In Square": its Square item was unarchived in Square, but IndieTix has it archived'
  ]);
  assert.equal(logged.length, 5);
  assert.ok(logged.every((l) => l.startsWith('SHOWTIME_DRIFT: venue_sync: event ')), 'each line carries the alarm marker');
  assert.equal(await statusOf('Showing', gone), 'on_sale', 'drift is reported, not fixed');
  assert.equal(await linkClosed('MOD-GONE'), null);
  assert.equal(await statusOf('Event', deleted), 'active');
  assert.equal(await statusOf('Event', unarchived), 'archived');
});

test('drift: a name, description or poster changed in Square is reported; matching text and an unknown poster are not', async () => {
  await event('Same Everywhere', 'active', 'ITEM-F', 'LIST-F', { description: 'Rating: R\n\nA plot.', imageId: 'IMG-F' });
  await event('Changed By Hand', 'active', 'ITEM-G', 'LIST-G', { description: 'Our text.', imageId: 'IMG-G' });
  await event('Imported', 'active', 'ITEM-H', 'LIST-H');
  squareObjects = {
    // Square's plain-text copy, with its own line breaks: the same text.
    'ITEM-F': item('ITEM-F', false, 'Same Everywhere', { description_plaintext: 'Rating: R\nA plot. ', image_ids: ['IMG-F'] }),
    'LIST-F': list('LIST-F', []),
    'ITEM-G': item('ITEM-G', false, 'Renamed By Hand', { description_plaintext: 'Their text.', image_ids: ['IMG-OTHER'] }),
    'LIST-G': list('LIST-G', []),
    // No IMAGE link (imported before 2026-11-23): its poster isn't checked.
    'ITEM-H': item('ITEM-H', false, 'Imported', { image_ids: ['IMG-H'] }),
    'LIST-H': list('LIST-H', [])
  };
  const { result } = await quietly(() => syncNativeEvents(venueConfig, 'token', 'venue_details'));
  assert.deepEqual(result.drift.sort(), [
    '"Changed By Hand": its description was changed in Square',
    '"Changed By Hand": its name was changed in Square to "Renamed By Hand"',
    '"Changed By Hand": its poster was changed in Square'
  ]);
  assert.equal(fetchCalls.length, 1, 'reported, not fixed');
});

test('a venue database without the native event tables is skipped quietly, with no Square calls', async () => {
  const { result, logged } = await quietly(() => syncNativeEvents({ ...adminConfig, database: 'venue_old' }, 'token', 'venue_old'));
  assert.equal(result.skipped, 'no native event tables');
  assert.deepEqual(logged, []);
  assert.equal(fetchCalls.length, 0);
});
