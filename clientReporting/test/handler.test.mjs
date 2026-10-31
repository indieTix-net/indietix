import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { startPostgresContainer, stopPostgresContainer, createDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handler } = require('../src/index.js');

const { Client } = pg;
const secretsMock = mockClient(SecretsManagerClient);

let adminConfig, containerName;

before(async () => {
  ({ dbConfig: adminConfig, containerName } = await startPostgresContainer());

  await createDatabase(adminConfig, 'client_epsilon');
  await createDatabaseObjects({ ...adminConfig, database: 'client_epsilon' }, 'client_epsilon', 1, 'Epsilon', 'EE');
  const client = new Client({ ...adminConfig, database: 'client_epsilon' });
  await client.connect();
  await client.query(
    `INSERT INTO "Client" ("clientID", "clientSecret", "contactName", "clientEmail", "Status", "configuration")
     VALUES ('EPSILON123456', 'top-secret-client-secret', 'Contact', 'contact@example.com', 'active', $1)`,
    [JSON.stringify({ SQUARE_ACCESS_TOKEN: 'real-square-token-xyz', WEB_HEADER_COMPANY: 'Epsilon Cinema' })]
  );
  await client.end();

  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({
      host: adminConfig.host,
      port: adminConfig.port,
      username: adminConfig.user,
      password: adminConfig.password,
      ssl: 'false'
    })
  });
});

beforeEach(() => {
  secretsMock.resetHistory();
});

after(async () => {
  await stopPostgresContainer(containerName);
});

test('SECURITY FIX: with no query params at all, configuration is NOT included (safe default)', async () => {
  const result = await handler({ queryStringParameters: null });
  const body = JSON.parse(result.body);
  const found = body.clients.find(c => c.clientid === 'EPSILON123456');
  assert.ok(found, 'client should still be present');
  assert.equal(found.configuration, undefined, 'configuration must be redacted by default');
});

test('SECURITY FIX: clientsecret is stripped regardless of the configuration setting', async () => {
  const withConfig = await handler({ queryStringParameters: { include_configuration: 'true' } });
  const withoutConfig = await handler({ queryStringParameters: { include_configuration: 'false' } });

  for (const result of [withConfig, withoutConfig]) {
    const body = JSON.parse(result.body);
    const found = body.clients.find(c => c.clientid === 'EPSILON123456');
    assert.equal(found.clientsecret, undefined, 'clientsecret must never be returned, in either mode');
  }
});

test('include_configuration=true explicitly opts in to seeing the full configuration blob', async () => {
  const result = await handler({ queryStringParameters: { include_configuration: 'true' } });
  const body = JSON.parse(result.body);
  const found = body.clients.find(c => c.clientid === 'EPSILON123456');
  assert.equal(found.configuration.SQUARE_ACCESS_TOKEN, 'real-square-token-xyz');
});

test('an unrecognized include_configuration value is treated the same as the safe default (redacted)', async () => {
  const result = await handler({ queryStringParameters: { include_configuration: 'yes-please' } });
  const body = JSON.parse(result.body);
  const found = body.clients.find(c => c.clientid === 'EPSILON123456');
  assert.equal(found.configuration, undefined);
});

test('database_filter narrows results to databases whose name includes the filter string', async () => {
  const result = await handler({ queryStringParameters: { database_filter: 'epsilon' } });
  const body = JSON.parse(result.body);
  assert.ok(body.clients.every(c => c.source_database.includes('epsilon')));
  assert.ok(body.clients.length >= 1);
});

test('status_filter matches case-insensitively', async () => {
  const result = await handler({ queryStringParameters: { status_filter: 'ACTIVE' } });
  const body = JSON.parse(result.body);
  const found = body.clients.find(c => c.clientid === 'EPSILON123456');
  assert.ok(found, 'status_filter=ACTIVE should still match a client with Status=active');
});

test('summary stats report total/filtered counts and a per-database breakdown', async () => {
  const result = await handler({ queryStringParameters: null });
  const body = JSON.parse(result.body);
  assert.ok(body.summary.total_clients >= 1);
  assert.equal(body.summary.filtered_clients, body.clients.length);
  assert.ok(body.summary.clients_per_database.client_epsilon >= 1);
});

test('handler returns 500 with an error message if Secrets Manager itself fails', async () => {
  secretsMock.on(GetSecretValueCommand).rejects(new Error('Secrets Manager unavailable'));
  const result = await handler({ queryStringParameters: null });
  assert.equal(result.statusCode, 500);
  const body = JSON.parse(result.body);
  assert.match(body.message, /Secrets Manager unavailable/);

  // Restore for any tests that might run after this one.
  secretsMock.on(GetSecretValueCommand).resolves({
    SecretString: JSON.stringify({ host: adminConfig.host, port: adminConfig.port, username: adminConfig.user, password: adminConfig.password, ssl: 'false' })
  });
});
