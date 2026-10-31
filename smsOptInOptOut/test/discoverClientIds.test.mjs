import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { SecretsManagerClient, ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { discoverClientIds } from '../src/index.mjs';

const secretsMock = mockClient(SecretsManagerClient);

test('discoverClientIds: extracts client IDs matching the Square-merchant-ID shape, excludes admin creds', async () => {
  secretsMock.reset();
  secretsMock.on(ListSecretsCommand).resolves({
    SecretList: [
      { Name: 'indieTix/rds/clients/M5E5N7KAHZA7Q/credentials' },
      { Name: 'indieTix/rds/clients/ABCDEFGHIJKLM/credentials' },
      { Name: 'indieTix/rds/clients/indietix/credentials' }, // admin superuser cred -- wrong shape
      { Name: 'indieTix/rds/clients/backup/credentials' },   // also wrong shape
      { Name: 'some/unrelated/secret' }                      // doesn't match the pattern at all
    ]
  });

  const ids = await discoverClientIds();
  assert.deepEqual(ids.sort(), ['ABCDEFGHIJKLM', 'M5E5N7KAHZA7Q']);
});

test('discoverClientIds: follows pagination via NextToken', async () => {
  secretsMock.reset();
  secretsMock
    .on(ListSecretsCommand)
    .resolvesOnce({
      SecretList: [{ Name: 'indieTix/rds/clients/AAAAAAAAAAAAA/credentials' }],
      NextToken: 'page2'
    })
    .resolvesOnce({
      SecretList: [{ Name: 'indieTix/rds/clients/BBBBBBBBBBBBB/credentials' }]
    });

  const ids = await discoverClientIds();
  assert.deepEqual(ids.sort(), ['AAAAAAAAAAAAA', 'BBBBBBBBBBBBB']);
});

test('discoverClientIds: dedupes if the same client ID somehow appears twice', async () => {
  secretsMock.reset();
  secretsMock.on(ListSecretsCommand).resolves({
    SecretList: [
      { Name: 'indieTix/rds/clients/M5E5N7KAHZA7Q/credentials' },
      { Name: 'indieTix/rds/clients/M5E5N7KAHZA7Q/credentials' }
    ]
  });

  const ids = await discoverClientIds();
  assert.deepEqual(ids, ['M5E5N7KAHZA7Q']);
});

test('discoverClientIds: an empty secret list returns an empty array, not an error', async () => {
  secretsMock.reset();
  secretsMock.on(ListSecretsCommand).resolves({ SecretList: [] });

  const ids = await discoverClientIds();
  assert.deepEqual(ids, []);
});
