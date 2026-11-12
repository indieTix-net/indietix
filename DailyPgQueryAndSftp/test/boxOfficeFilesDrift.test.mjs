import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as qrscanner from '../../QRScanner/src/utils/box-office-files.mjs';

// QRScanner's Box Office Reports page builds these same files on demand from
// its own copy of the builders. Both copies must give identical bytes, or a
// downloaded file wouldn't match what the feeds got.
const require = createRequire(import.meta.url);
const nightly = require('../src/index.js');

const rows = [
  { TheatreID: '69938', 'Theatre Name': 'Liberty Hall Cinema', 'Film Code': 'LH1', Screen: '1', Title: 'Plain Title', Distributor: 'Dist', Showtime: '202604261900', 'Ticket Type': 'Adult', Gross: '21.86', Net: '20.00', Tax: '1.86', Sold: '2', Refunded: '0', Open: '0', Close: '2' },
  { TheatreID: '69938', 'Theatre Name': 'Liberty Hall Cinema', 'Film Code': 'LH2', Screen: '2', Title: 'Quote "this", & <that>', Distributor: null, Showtime: '202604262100', 'Ticket Type': 'Child\nLine', Gross: '0', Net: '0', Tax: '0', Sold: '1', Refunded: '1', Open: '0', Close: '0' }
];

test('RTS CSV: QRScanner copy matches the nightly job', () => {
  assert.equal(qrscanner.buildRtsCsv(rows), nightly.convertToCSV({ rows }));
  assert.equal(qrscanner.buildRtsCsv([]), nightly.convertToCSV({ rows: [] }));
  for (const value of [null, undefined, 'a,b', 'a"b', 'a\rb', 'plain', 12]) {
    assert.equal(qrscanner.escapeCSVField(value), nightly.escapeCSVField(value));
  }
});

test('FRG XML: QRScanner copy matches the nightly job', () => {
  const ebor = [{ Title: 'A, B & <C>', 'Film Code': ' LH2 ', Gross: '123.4' }, { Title: null, 'Film Code': null, Gross: null }];
  assert.equal(qrscanner.buildEborXml(ebor, '2026-04-26', '902063'), nightly.buildEborXml(ebor, '2026-04-26', '902063'));
  assert.equal(qrscanner.buildEborXml([], '2026-04-26', '902063'), nightly.buildEborXml([], '2026-04-26', '902063'));
});

test('file names: same as the nightly job writes', () => {
  assert.deepEqual(qrscanner.boxOfficeFileNames('2026-04-26', '69938', '902063'), { rts: 'RTS_69938_202604260000.csv', frg: 'FRG_902063_202604260000.xml' });
  assert.equal(qrscanner.boxOfficeFileNames('2026-04-26', '69938', '').frg, null);
});
