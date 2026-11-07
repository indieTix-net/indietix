import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, squareHandlers, resetSquareHandlers } from './helpers/testServer.mjs';

let ctx;

before(async () => {
  ctx = await startTestServer({
    clientConfig: { SQUARE_LOCATION_ID: 'LOC123' }
  });
});
after(async () => { await stopTestServer(ctx); });

beforeEach(() => { resetSquareHandlers(); });

// Every test passes createCalendarEvents:false and omits posterUrl/imdbID --
// both the Google Calendar integration and the image-upload path make real
// outbound calls this harness deliberately does not mock (Calendar via
// googleapis' own transport, image upload via form-data's raw http.submit(),
// neither going through global fetch). Skipping both via the route's own
// existing opt-outs is the safe way to exercise the rest of the route
// without risking a real external call, mirroring the lesson learned from
// sms-utils' dual-package mocking gap earlier in this session.

function movieBody(overrides = {}) {
  return {
    movieData: {
      title: 'Test Movie',
      description: 'A test movie',
      imdbID: undefined,
      showtimes: ['Sun 01-18-2026 7:00 PM (Main Theater)'],
      ...overrides
    },
    createCalendarEvents: false
  };
}

function eventBody(overrides = {}) {
  return {
    eventData: {
      title: 'Test Live Event',
      description: 'A test event',
      showtimes: ['Sun 01-18-2026 7:00 PM (Main Theater)'],
      ...overrides
    },
    createCalendarEvents: false
  };
}

// ---- calendar not configured ----
// This venue has no Google Calendar settings, so asking for calendar events
// is safe here: the route skips the calendar before any Google call, and the
// message has to say so instead of claiming the events were created.

test('POST /api/square/create-movie-item: calendar requested but not set up says so, still creates the item', async () => {
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: { ...movieBody(), createCalendarEvents: true } });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.match(json.message, /Calendar events were not created: Google Calendar is not set up/);
  assert.doesNotMatch(json.message, /Calendar events created\./);
});

test('POST /api/square/create-event-item: calendar requested but not set up says so, still creates the item', async () => {
  squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'MOCK_CAT_EVENTS', category_data: { name: 'Events' } }] }) });
  const { status, json } = await ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body: { ...eventBody(), createCalendarEvents: true } });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.match(json.message, /Calendar events were not created: Google Calendar is not set up/);
});

// ---- create-movie-item ----

test('POST /api/square/create-movie-item: happy path creates item + sets inventory', async () => {
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.itemId, 'MOCK_ITEM_ID');
  assert.match(json.squareUrl, /MOCK_ITEM_ID$/);
});

test('POST /api/square/create-movie-item: no showtimes is rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody({ showtimes: [] }) });
  assert.equal(status, 400);
});

test('POST /api/square/create-movie-item: a name collision in Square is rejected with 409', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'EXISTING' }] }) });
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 409);
  assert.match(json.error, /already exists/);
});

// Records every catalog object create, answering a CATEGORY create with a
// mock id and everything else the way the default handler does.
function recordCatalogCreates(categoryResult) {
  const created = [];
  const defaultCreate = squareHandlers.createCatalogObject;
  squareHandlers.createCatalogObject = async (body) => {
    created.push(body.object);
    if (body.object.type === 'CATEGORY') {
      return categoryResult || { ok: true, status: 200, json: async () => ({ catalog_object: { ...body.object, id: `MOCK_CAT_NEW_${body.object.category_data.name}` } }) };
    }
    return defaultCreate(body);
  };
  return created;
}

test('POST /api/square/create-movie-item: missing Cinema category is created, then used for the item', async () => {
  squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [] }) });
  const created = recordCatalogCreates();
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const categories = created.filter(o => o.type === 'CATEGORY');
  assert.equal(categories.length, 1);
  assert.equal(categories[0].category_data.name, 'Cinema');
  const item = created.find(o => o.type === 'ITEM');
  assert.equal(item.item_data.reporting_category.id, 'MOCK_CAT_NEW_Cinema');
});

test('POST /api/square/create-movie-item: an existing Cinema category is reused, not duplicated', async () => {
  const created = recordCatalogCreates();
  const { status } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 200);
  assert.equal(created.filter(o => o.type === 'CATEGORY').length, 0);
  assert.equal(created.find(o => o.type === 'ITEM').item_data.reporting_category.id, 'MOCK_CAT_CINEMA');
});

test('POST /api/square/create-movie-item: Cinema category on a later page of the list is found', async () => {
  let calls = 0;
  squareHandlers.listCatalogCategories = async () => {
    calls += 1;
    return calls === 1
      ? { ok: true, status: 200, json: async () => ({ objects: [{ id: 'CAT_OTHER', category_data: { name: 'Bar' } }], cursor: 'PAGE2' }) }
      : { ok: true, status: 200, json: async () => ({ objects: [{ id: 'CAT_PAGE2_CINEMA', category_data: { name: 'Cinema' } }] }) };
  };
  const created = recordCatalogCreates();
  const { status } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 200);
  assert.equal(calls, 2);
  assert.equal(created.filter(o => o.type === 'CATEGORY').length, 0);
  assert.equal(created.find(o => o.type === 'ITEM').item_data.reporting_category.id, 'CAT_PAGE2_CINEMA');
});

test('POST /api/square/create-movie-item: a failed category create is a 500, not a crash', async () => {
  squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [] }) });
  recordCatalogCreates({ ok: false, status: 500, text: async () => 'square category failure' });
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 500);
  assert.match(json.error, /Cinema category/);
});

test('POST /api/square/create-movie-item: Square not configured (no access token) is a 500', async () => {
  const unconfigured = await startTestServer({ clientId: 'NOSQUARECLIENT1', clientConfig: { SQUARE_ACCESS_TOKEN: '', SQUARE_LOCATION_ID: 'LOC1' } });
  try {
    const { status, json } = await unconfigured.request('POST', '/api/square/create-movie-item', { token: unconfigured.clientToken, body: movieBody() });
    assert.equal(status, 500);
    assert.match(json.error, /Square API not configured/);
  } finally {
    await stopTestServer(unconfigured);
  }
});

test('POST /api/square/create-movie-item: a modifier-list creation failure in Square surfaces as a 500', async () => {
  const defaultCreate = squareHandlers.createCatalogObject;
  squareHandlers.createCatalogObject = async (body) => body.object.type === 'MODIFIER_LIST'
    ? { ok: false, status: 500, text: async () => 'square modifier failure' }
    : defaultCreate(body);
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 500);
  assert.match(json.error, /modifier list/);
});

test('POST /api/square/create-movie-item: an item-creation failure in Square surfaces as a 500 (modifier list already created)', async () => {
  squareHandlers.createCatalogObject = async (body) => {
    if (body.object.type === 'ITEM') return { ok: false, status: 500, text: async () => 'square item failure' };
    return { ok: true, status: 200, json: async () => ({ catalog_object: { ...body.object, id: 'MOCK_MODIFIER_LIST_ID' } }) };
  };
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 500);
  assert.match(json.error, /Failed to create item in Square/);
});

// ---- create-event-item ----

test('POST /api/square/create-event-item: happy path creates item + sets inventory', async () => {
  squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'MOCK_CAT_EVENTS', category_data: { name: 'Events' } }] }) });
  const { status, json } = await ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body: eventBody() });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  assert.equal(json.itemId, 'MOCK_ITEM_ID');
});

test('POST /api/square/create-event-item: no showtimes is rejected with 400', async () => {
  const { status } = await ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body: eventBody({ showtimes: [] }) });
  assert.equal(status, 400);
});

test('POST /api/square/create-event-item: a name collision in Square is rejected with 409', async () => {
  squareHandlers.searchCatalog = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'EXISTING' }] }) });
  const { status } = await ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body: eventBody() });
  assert.equal(status, 409);
});

test('POST /api/square/create-event-item: missing Events category is created, then used for the item', async () => {
  squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'CAT_X', category_data: { name: 'Cinema' } }] }) });
  const created = recordCatalogCreates();
  const { status, json } = await ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body: eventBody() });
  assert.equal(status, 200);
  assert.equal(json.success, true);
  const categories = created.filter(o => o.type === 'CATEGORY');
  assert.equal(categories.length, 1);
  assert.equal(categories[0].category_data.name, 'Events');
  const item = created.find(o => o.type === 'ITEM');
  assert.equal(item.item_data.reporting_category.id, 'MOCK_CAT_NEW_Events');
});

// ---- ticket item setup: custom attributes, ticket types, distributors ----

async function setVenueConfig(values) {
  await ctx.pgClient.query(`UPDATE "Client" SET configuration = (configuration::jsonb || $2::jsonb)::json WHERE "clientID" = $1`, [ctx.clientId, JSON.stringify(values)]);
}
const clearTicketSettings = () => setVenueConfig({ MOVIE_TICKET_TYPES: '', EVENT_TICKET_TYPES: '', MOVIE_DISTRIBUTOR: '', EVENT_DISTRIBUTOR: '' });

// The four definitions as an existing venue's Square account has them.
function existingDefinitions({ distributors = ['Janus Films', 'House Events'] } = {}) {
  const def = (id, name, type, key, choices) => ({
    id, type: 'CUSTOM_ATTRIBUTE_DEFINITION',
    custom_attribute_definition_data: {
      name, type, key,
      ...(choices ? { selection_config: { allowed_selections: choices.map((c, i) => ({ uid: `${key}_SEL_${i}`, name: c })) } } : {})
    }
  });
  return [
    def('DEF_QR', 'UseQRCode', 'BOOLEAN', 'seller_qr'),
    def('DEF_NAME', 'Online Display Name', 'STRING', 'seller_name'),
    def('DEF_TYPE', 'EventType', 'SELECTION', 'seller_type', ['Movie', 'Live']),
    def('DEF_DIST', 'Distributor', 'SELECTION', 'seller_dist', distributors)
  ];
}

test('ticket items: a new venue gets the four custom attributes created, and the item uses them', async () => {
  const created = recordCatalogCreates();
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 200);
  const defs = created.filter(o => o.type === 'CUSTOM_ATTRIBUTE_DEFINITION').map(o => o.custom_attribute_definition_data);
  assert.deepEqual(defs.map(d => [d.name, d.type]), [['UseQRCode', 'BOOLEAN'], ['Online Display Name', 'STRING'], ['EventType', 'SELECTION'], ['Distributor', 'SELECTION']]);
  assert.deepEqual(defs[2].selection_config.allowed_selections.map(c => c.name), ['Movie', 'Live']);
  assert.deepEqual(defs[3].selection_config.allowed_selections.map(c => c.name), ['Test Venue'], 'distributor defaults to the venue name');
  assert.ok(defs.every(d => d.seller_visibility === 'SELLER_VISIBILITY_READ_WRITE_VALUES'));
  const item = created.find(o => o.type === 'ITEM');
  assert.deepEqual(item.custom_attribute_values.indietix_use_qr_code, { boolean_value: true });
  assert.deepEqual(item.custom_attribute_values.indietix_event_type, { selection_uid_values: ['#choice_0'] });
  assert.deepEqual(item.custom_attribute_values.indietix_distributor, { selection_uid_values: ['#choice_0'] });
  assert.equal(item.item_data.channels, undefined, 'no hardcoded sales channels');
  assert.doesNotMatch(json.message, /isn't a choice/);
});

test('ticket items: existing attributes are reused, never re-created, with the venue\'s distributor choice', async () => {
  squareHandlers.listCatalogCustomAttributes = async () => ({ ok: true, status: 200, json: async () => ({ objects: existingDefinitions() }) });
  await setVenueConfig({ MOVIE_DISTRIBUTOR: 'Janus Films', EVENT_DISTRIBUTOR: 'House Events' });
  try {
    let created = recordCatalogCreates();
    assert.equal((await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() })).status, 200);
    assert.equal(created.filter(o => o.type === 'CUSTOM_ATTRIBUTE_DEFINITION').length, 0);
    let values = created.find(o => o.type === 'ITEM').custom_attribute_values;
    assert.deepEqual(values.seller_qr, { boolean_value: true });
    assert.deepEqual(values.seller_type, { selection_uid_values: ['seller_type_SEL_0'] });
    assert.deepEqual(values.seller_dist, { selection_uid_values: ['seller_dist_SEL_0'] });

    resetSquareHandlers();
    squareHandlers.listCatalogCustomAttributes = async () => ({ ok: true, status: 200, json: async () => ({ objects: existingDefinitions() }) });
    squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'MOCK_CAT_EVENTS', category_data: { name: 'Events' } }] }) });
    created = recordCatalogCreates();
    assert.equal((await ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body: eventBody() })).status, 200);
    values = created.find(o => o.type === 'ITEM').custom_attribute_values;
    assert.deepEqual(values.seller_type, { selection_uid_values: ['seller_type_SEL_1'] }, 'events are Live');
    assert.deepEqual(values.seller_dist, { selection_uid_values: ['seller_dist_SEL_1'] });
  } finally {
    await clearTicketSettings();
  }
});

test('ticket items: a distributor that isn\'t a choice in Square is left off, with a note, and the definition is not changed', async () => {
  squareHandlers.listCatalogCustomAttributes = async () => ({ ok: true, status: 200, json: async () => ({ objects: existingDefinitions({ distributors: ['Someone Else'] }) }) });
  const created = recordCatalogCreates();
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 200);
  assert.match(json.message, /"Test Venue" isn't a choice on the Distributor attribute/);
  assert.equal(created.filter(o => o.type === 'CUSTOM_ATTRIBUTE_DEFINITION').length, 0);
  const values = created.find(o => o.type === 'ITEM').custom_attribute_values;
  assert.equal(values.seller_dist, undefined);
  assert.deepEqual(values.seller_qr, { boolean_value: true });
});

test('ticket items: if UseQRCode can\'t be created, no item is made (it would never make tickets)', async () => {
  const created = [];
  squareHandlers.createCatalogObject = async (body) => {
    created.push(body.object);
    return body.object.type === 'CUSTOM_ATTRIBUTE_DEFINITION'
      ? { ok: false, status: 400, text: async () => 'nope' }
      : { ok: true, status: 200, json: async () => ({ catalog_object: { ...body.object, id: 'X' } }) };
  };
  const { status, json } = await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  assert.equal(status, 500);
  assert.match(json.error, /UseQRCode custom attribute/);
  assert.deepEqual(created.map(o => o.type), ['CUSTOM_ATTRIBUTE_DEFINITION']);
});

test('ticket items: ticket types and prices come from the venue\'s settings, else the defaults', async () => {
  let created = recordCatalogCreates();
  await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
  const variations = (item) => item.item_data.variations.map(v => [v.item_variation_data.name, v.item_variation_data.price_money.amount]);
  assert.deepEqual(variations(created.find(o => o.type === 'ITEM')), [['Child', 1000], ['Adult', 1250], ['Senior', 1100]]);

  await setVenueConfig({ MOVIE_TICKET_TYPES: JSON.stringify([{ name: 'General', price: '9' }, { name: 'Matinee', price: '7.25' }]), EVENT_TICKET_TYPES: JSON.stringify([{ name: 'VIP', price: '40.00' }]) });
  try {
    resetSquareHandlers();
    created = recordCatalogCreates();
    await ctx.request('POST', '/api/square/create-movie-item', { token: ctx.clientToken, body: movieBody() });
    assert.deepEqual(variations(created.find(o => o.type === 'ITEM')), [['General', 900], ['Matinee', 725]]);

    resetSquareHandlers();
    squareHandlers.listCatalogCategories = async () => ({ ok: true, status: 200, json: async () => ({ objects: [{ id: 'MOCK_CAT_EVENTS', category_data: { name: 'Events' } }] }) });
    created = recordCatalogCreates();
    await ctx.request('POST', '/api/square/create-event-item', { token: ctx.clientToken, body: eventBody() });
    const item = created.find(o => o.type === 'ITEM');
    assert.deepEqual(variations(item), [['VIP', 4000]]);
    assert.equal(item.item_data.channels, undefined);
  } finally {
    await clearTicketSettings();
  }
});

