import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { renderTicketPdf } from '../src/pdfOverlay.mjs';
import { generateQRCode } from '../src/qrcode.mjs';

// No binary fixture files committed -- a blank single-page PDF at the
// real ticket-template dimensions (1800x600 horizontal, 600x1800
// vertical, matching the actual templates in production) is built here
// at test time. These tests can't assert on *pixel-exact* text
// position (pdf-lib doesn't re-parse drawn content back out, and
// standing up real PDF content-stream parsing just for this would be
// disproportionate) -- what they do verify: the render never throws,
// the output is a structurally valid single-page PDF, and the page
// dimensions are preserved, across both orientations and the known
// edge cases in the text-wrapping algorithm (long titles, missing
// optional fields, a single word wider than the wrap width).

async function blankTemplate(width, height) {
  const doc = await PDFDocument.create();
  doc.addPage([width, height]);
  return Buffer.from(await doc.save());
}

async function assertValidSinglePagePdf(pdfBytes, expectedWidth, expectedHeight) {
  const doc = await PDFDocument.load(pdfBytes);
  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPages()[0].getSize();
  assert.equal(width, expectedWidth);
  assert.equal(height, expectedHeight);
}

const qr = await generateQRCode('test-ticket-code');

test('horizontal orientation: normal name + variation renders a valid single-page PDF', async () => {
  const template = await blankTemplate(1800, 600);
  const out = await renderTicketPdf(template, qr, { name: 'Digger (2026)', variation: 'Adult', itemModifierValues: 'Sun 05-17-2026 2:30 PM' }, 'horizontal');
  await assertValidSinglePagePdf(out, 1800, 600);
});

test('vertical orientation: normal name + variation renders a valid single-page PDF', async () => {
  const template = await blankTemplate(600, 1800);
  const out = await renderTicketPdf(template, qr, { name: 'Digger (2026)', variation: 'Adult', itemModifierValues: 'Sun 05-17-2026 2:30 PM' }, 'vertical');
  await assertValidSinglePagePdf(out, 600, 1800);
});

test('defaults to horizontal when orientation is omitted', async () => {
  const template = await blankTemplate(1800, 600);
  const out = await renderTicketPdf(template, qr, { name: 'Digger (2026)' });
  await assertValidSinglePagePdf(out, 1800, 600);
});

test('horizontal: missing optional variation/itemModifierValues does not throw', async () => {
  const template = await blankTemplate(1800, 600);
  const out = await renderTicketPdf(template, qr, { name: 'Digger (2026)' }, 'horizontal');
  await assertValidSinglePagePdf(out, 1800, 600);
});

test('vertical: missing optional variation/itemModifierValues does not throw', async () => {
  const template = await blankTemplate(600, 1800);
  const out = await renderTicketPdf(template, qr, { name: 'Digger (2026)' }, 'vertical');
  await assertValidSinglePagePdf(out, 600, 1800);
});

test('horizontal: very long title triggers wrapping/truncation without throwing', async () => {
  const template = await blankTemplate(1800, 600);
  const longName = 'The Extraordinarily Long and Overly Descriptive Title of a Movie That Should Not Realistically Exist But Must Still Render Safely (2026)';
  const out = await renderTicketPdf(template, qr, { name: longName, variation: 'Adult', itemModifierValues: 'Sun 05-17-2026 2:30 PM' }, 'horizontal');
  await assertValidSinglePagePdf(out, 1800, 600);
});

test('vertical: very long title triggers wrapping/truncation without throwing (tighter height budget than horizontal)', async () => {
  const template = await blankTemplate(600, 1800);
  const longName = 'The Extraordinarily Long and Overly Descriptive Title of a Movie That Should Not Realistically Exist But Must Still Render Safely (2026)';
  const longVariation = 'A very long seat/ticket-type description that also needs to wrap across several lines in the remaining vertical space';
  const out = await renderTicketPdf(template, qr, { name: longName, variation: longVariation, itemModifierValues: 'extra detail text' }, 'vertical');
  await assertValidSinglePagePdf(out, 600, 1800);
});

test('a single word wider than the wrap width does not infinite-loop or throw', async () => {
  const template = await blankTemplate(1800, 600);
  // drawWrappedText's algorithm only breaks on spaces -- a single
  // "word" with no spaces that's wider than maxWidth is the classic
  // edge case for this style of greedy word-wrap (it can never find a
  // valid break point inside the word itself).
  const unbreakableWord = 'Supercalifragilisticexpialidocioussupercalifragilisticexpialidocious';
  const out = await renderTicketPdf(template, qr, { name: unbreakableWord }, 'horizontal');
  await assertValidSinglePagePdf(out, 1800, 600);
});

test('empty-string name does not throw (falls through drawWrappedText\'s falsy-text guard)', async () => {
  const template = await blankTemplate(1800, 600);
  const out = await renderTicketPdf(template, qr, { name: '' }, 'horizontal');
  await assertValidSinglePagePdf(out, 1800, 600);
});
