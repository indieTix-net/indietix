import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { deleteSquareRefreshSecret } from '../src/index.js';

// Teardown removes a Connect Square venue's refresh-token secret. Stubbed
// Secrets Manager: no network, no AWS credentials.
const originalSend = SecretsManagerClient.prototype.send;
let calls;
let answer;

beforeEach(() => {
  calls = [];
  answer = async () => ({});
  SecretsManagerClient.prototype.send = async function (command) {
    calls.push({ name: command.constructor.name, input: command.input });
    return answer();
  };
});
afterEach(() => { SecretsManagerClient.prototype.send = originalSend; });

test("deleteSquareRefreshSecret: deletes the venue's secret at once", async () => {
  assert.equal(await deleteSquareRefreshSecret('VENUE1'), 'deleted');
  assert.deepEqual(calls, [{
    name: 'DeleteSecretCommand',
    input: { SecretId: 'indieTix/square/clients/VENUE1', ForceDeleteWithoutRecovery: true }
  }]);
});

test("deleteSquareRefreshSecret: a personal-token venue has none, and that's fine", async () => {
  answer = async () => { throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' }); };
  assert.equal(await deleteSquareRefreshSecret('VENUE1'), 'none');
});

test('deleteSquareRefreshSecret: any other error is reported, not thrown', async () => {
  answer = async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); };
  assert.equal(await deleteSquareRefreshSecret('VENUE1'), false);
});
