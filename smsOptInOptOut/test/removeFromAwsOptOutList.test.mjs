import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockClient } from 'aws-sdk-client-mock';
import { PinpointSMSVoiceV2Client, DeleteOptedOutNumberCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { handleStart } from '../src/index.mjs';

const smsVoiceMock = mockClient(PinpointSMSVoiceV2Client);

// removeFromAwsOptOutList itself isn't exported (it's a pure side-effect
// helper with no DB interaction), but handleStart calls it unconditionally
// as its last step -- test through that rather than adding an export whose
// only purpose would be this test.

test('removeFromAwsOptOutList (via handleStart): skips the AWS call entirely when no list is configured', async () => {
  smsVoiceMock.reset();
  await handleStart({
    pool: { query: async () => ({ rows: [] }) },
    normalizedPhone: '+19135551234',
    mostRecentConsent: { Status: 'active' },
    clientConfig: {} // no SMS_OPT_OUT_LIST_NAME
  });
  assert.equal(smsVoiceMock.calls().length, 0);
});

test('removeFromAwsOptOutList (via handleStart): calls DeleteOptedOutNumberCommand when a list is configured', async () => {
  smsVoiceMock.reset();
  smsVoiceMock.on(DeleteOptedOutNumberCommand).resolves({});

  await handleStart({
    pool: { query: async () => ({ rows: [] }) },
    normalizedPhone: '+19135551234',
    mostRecentConsent: { Status: 'active' },
    clientConfig: { SMS_OPT_OUT_LIST_NAME: 'liberty-hall-optouts' }
  });

  const call = smsVoiceMock.commandCalls(DeleteOptedOutNumberCommand)[0];
  assert.equal(call.args[0].input.OptOutListName, 'liberty-hall-optouts');
  assert.equal(call.args[0].input.OptedOutNumber, '+19135551234');
});

test('removeFromAwsOptOutList (via handleStart): a ResourceNotFoundException (not on the list) is swallowed silently', async () => {
  smsVoiceMock.reset();
  const err = new Error('not found');
  err.name = 'ResourceNotFoundException';
  smsVoiceMock.on(DeleteOptedOutNumberCommand).rejects(err);

  await assert.doesNotReject(() => handleStart({
    pool: { query: async () => ({ rows: [] }) },
    normalizedPhone: '+19135551234',
    mostRecentConsent: { Status: 'active' },
    clientConfig: { SMS_OPT_OUT_LIST_NAME: 'liberty-hall-optouts' }
  }));
});

test('removeFromAwsOptOutList (via handleStart): any other AWS error is logged, not thrown (START must not fail the whole flow over this)', async () => {
  smsVoiceMock.reset();
  smsVoiceMock.on(DeleteOptedOutNumberCommand).rejects(new Error('ThrottlingException'));

  await assert.doesNotReject(() => handleStart({
    pool: { query: async () => ({ rows: [] }) },
    normalizedPhone: '+19135551234',
    mostRecentConsent: { Status: 'active' },
    clientConfig: { SMS_OPT_OUT_LIST_NAME: 'liberty-hall-optouts' }
  }));
});
