import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../src/index.mjs';

test('parseIntent: recognizes every STOP keyword', () => {
  for (const kw of ['STOP', 'STOPALL', 'END', 'QUIT', 'CANCEL', 'UNSUBSCRIBE', 'OPTOUT', 'OPT-OUT', 'REMOVE', 'ARRET', 'TD']) {
    assert.equal(parseIntent({ messageKeyword: kw, messageBody: '' }), 'stop', `expected "${kw}" to parse as stop`);
  }
});

test('parseIntent: recognizes every HELP keyword', () => {
  for (const kw of ['HELP', 'INFO', 'AIDE']) {
    assert.equal(parseIntent({ messageKeyword: kw, messageBody: '' }), 'help');
  }
});

test('parseIntent: recognizes every START keyword', () => {
  for (const kw of ['START', 'UNSTOP', 'YES', 'SUBSCRIBE']) {
    assert.equal(parseIntent({ messageKeyword: kw, messageBody: '' }), 'start');
  }
});

test('parseIntent: is case-insensitive', () => {
  assert.equal(parseIntent({ messageKeyword: 'stop', messageBody: '' }), 'stop');
  assert.equal(parseIntent({ messageKeyword: 'Help', messageBody: '' }), 'help');
  assert.equal(parseIntent({ messageKeyword: 'yes', messageBody: '' }), 'start');
});

test('parseIntent: matches on the first word only ("STOP please" still classifies)', () => {
  assert.equal(parseIntent({ messageKeyword: '', messageBody: 'STOP please' }), 'stop');
  assert.equal(parseIntent({ messageKeyword: '', messageBody: 'help me' }), 'help');
});

test('parseIntent: prefers messageKeyword over messageBody when both are present', () => {
  assert.equal(parseIntent({ messageKeyword: 'STOP', messageBody: 'actually never mind START' }), 'stop');
});

test('parseIntent: falls back to messageBody when messageKeyword is absent', () => {
  assert.equal(parseIntent({ messageKeyword: null, messageBody: 'START' }), 'start');
  assert.equal(parseIntent({ messageBody: 'START' }), 'start');
});

test('parseIntent: unrecognized text is "unknown", not an error', () => {
  assert.equal(parseIntent({ messageKeyword: '', messageBody: 'thanks for the ticket!' }), 'unknown');
  assert.equal(parseIntent({}), 'unknown');
  assert.equal(parseIntent({ messageKeyword: null, messageBody: null }), 'unknown');
});
