import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer } from './helpers/testServer.mjs';

// Placeholder values are what clientSetup's default config ships with, so a
// fresh venue must read as "not set up" rather than "set up".
let placeholderCtx;
let configuredCtx;

before(async () => {
  placeholderCtx = await startTestServer({
    clientId: 'PLACEHOLDERCLIENT',
    clientConfig: {
      OMDB_API_KEY: '',
      GOOGLE_SERVICE_ACCOUNT_KEY: 'updateWithRealServiceAccountKey',
      CINEMA_CALENDAR_ID: 'updateWithRealCinemaCalendarID',
      EVENT_CALENDAR_ID: 'updateWithRealEventCalendarID'
    }
  });
  configuredCtx = await startTestServer({
    clientId: 'CONFIGUREDCLIENT',
    clientConfig: {
      OMDB_API_KEY: 'venue-omdb-key',
      GOOGLE_SERVICE_ACCOUNT_KEY: { type: 'service_account', client_email: 'svc@example.iam.gserviceaccount.com' },
      CINEMA_CALENDAR_ID: 'cinema@group.calendar.google.com',
      EVENT_CALENDAR_ID: ''
    }
  });
});
after(async () => {
  await stopTestServer(placeholderCtx);
  await stopTestServer(configuredCtx);
});

test('GET /api/integrations/status: placeholder and empty values read as not set up', async () => {
  const { status, json } = await placeholderCtx.request('GET', '/api/integrations/status', { token: placeholderCtx.clientToken });
  assert.equal(status, 200);
  assert.deepEqual(json, { success: true, omdb: false, cinemaCalendar: false, eventCalendar: false });
});

test('GET /api/integrations/status: real values read as set up, each calendar on its own ID', async () => {
  const { status, json } = await configuredCtx.request('GET', '/api/integrations/status', { token: configuredCtx.clientToken });
  assert.equal(status, 200);
  assert.deepEqual(json, { success: true, omdb: true, cinemaCalendar: true, eventCalendar: false });
});

test('GET /api/integrations/status: returns booleans only, never the stored values', async () => {
  const { json } = await configuredCtx.request('GET', '/api/integrations/status', { token: configuredCtx.clientToken });
  const body = JSON.stringify(json);
  assert.doesNotMatch(body, /venue-omdb-key|svc@example|cinema@group/);
});

test('GET /api/integrations/status: requires auth', async () => {
  const { status } = await configuredCtx.request('GET', '/api/integrations/status');
  assert.equal(status, 401);
});
