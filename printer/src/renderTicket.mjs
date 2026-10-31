// PDF -> printable RawImageData pipeline.
//
// The ticket PDF itself is NOT sized for a label printer -- it's a wide
// (3:1, horizontal-orientation) digital document meant to be viewed on a
// screen or printed on a regular home printer, not a literal 2x6in label.
// To put it on a continuous roll, we rasterize it, rotate it 90deg (the
// roll is narrow -- its printable WIDTH has to receive the ticket's
// visual HEIGHT, and its feed LENGTH receives the ticket's visual
// WIDTH), then scale to fit the printer's printable dot width. Keeping
// the source aspect ratio means a 696-dot-wide continuous media (62mm)
// produces a roughly 7in-long ticket, which is in the right
// neighborhood for a physical admit-one stub -- "doesn't have to be
// exact," per the original ask.
//
// Die-cut media (fixed-size precut labels, e.g. DK-11201) can't use
// that "however long it needs to be" logic -- the printer's protocol
// requires the bitmap's row count to exactly equal the media's
// dieCutMaskedAreaDots (resolveDieCutRows in brother-ql-core's
// protocol.js throws "resize the image" otherwise). So for die-cut we
// scale to fit *within* the fixed printable box (letterboxed, like
// `object-fit: contain`) and pad the rest with white, instead of
// letting the feed length float.

import { createRequire } from 'node:module';
import path from 'node:path';
import { pdf } from 'pdf-to-img';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { PRINT_WIDTH_DOTS } from './config.mjs';

// pdf-to-img (as of 7.0.1) resolves its own pdfjs-dist install path via
// createRequire().resolve() -- which returns a native, OS-style path
// (backslashes on Windows) -- then runs that through node:path/posix's
// dirname(), which only understands forward slashes. On Windows that
// silently collapses to the wrong directory, so pdfjs-dist can never
// find its own bundled standard_fonts/cmaps and throws
// "Unable to load font data ... LiberationSans-Regular.ttf" on any PDF
// using a non-embedded standard font (Helvetica, here). Harmless on
// macOS/Linux (all-POSIX paths), which is why this wasn't caught until
// the box-office Windows PC, 2026-10-28. Worked around here by
// resolving the same path ourselves with the platform-native `path`
// module and passing it through pdf-to-img's own docInitParams escape
// hatch, which overrides its broken internal default.
//
// One more Windows-specific wrinkle on top of that: pdfjs-dist validates
// these URLs with a hardcoded `val.endsWith("/")` check (a plain string
// check, not OS-aware) -- see getFactoryUrlProp in pdfjs-dist's own
// legacy/build/pdf.mjs. A trailing path.sep (backslash on Windows)
// fails that check even though the directory itself resolves fine, so
// the trailing character must be a literal "/" on every OS, not
// path.sep. The actual file read afterwards is a plain
// fs.readFile(url), which Windows accepts mixed slash styles in just
// fine, so this doesn't need to be "correct" Windows path syntax --
// just pass pdfjs-dist's own string check.
const pdfjsDistDir = path.dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
const PDF_DOC_INIT_PARAMS = {
  standardFontDataUrl: `${path.join(pdfjsDistDir, 'standard_fonts')}/`,
  cMapUrl: `${path.join(pdfjsDistDir, 'cmaps')}/`,
  cMapPacked: true,
};

/**
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {import('@thermal-label/brother-ql-core').Media} [media] - when
 *   provided and `media.type === 'die-cut'`, the output bitmap is
 *   locked to `media.printableDots` x `media.dieCutMaskedAreaDots`
 *   exactly (required by the die-cut print protocol). Omitted or
 *   continuous media falls back to the original "scale to width, let
 *   height float" behavior.
 * @returns {Promise<{width: number, height: number, data: Uint8Array}>}
 *   RawImageData shape expected by @thermal-label/brother-ql-node's
 *   print() / createPreviewOffline().
 */
export async function renderTicketToRasterImage(pdfBytes, media) {
  // scale: 2 gives enough source resolution that the QR code stays
  // sharp after the resize below -- the PDF's own "page size" isn't a
  // real-world physical size (see note above), so this is just "render
  // at 2x the PDF's native point-based dimensions," not tied to any
  // target DPI.
  const doc = await pdf(pdfBytes, { scale: 2, docInitParams: PDF_DOC_INIT_PARAMS });
  if (doc.length < 1) {
    throw new Error('Ticket PDF has no pages');
  }
  const pageBuffer = await doc.getPage(1);
  await doc.destroy();

  const sourceImage = await loadImage(pageBuffer);

  // Step 1: rotate 90deg CW. The ticket is wide (landscape); the roll's
  // printable area is narrow and feeds along its length, so the
  // ticket's width needs to become the feed direction.
  const rotatedWidth = sourceImage.height;
  const rotatedHeight = sourceImage.width;
  const rotatedCanvas = createCanvas(rotatedWidth, rotatedHeight);
  const rotatedCtx = rotatedCanvas.getContext('2d');
  rotatedCtx.translate(rotatedWidth, 0);
  rotatedCtx.rotate(Math.PI / 2);
  rotatedCtx.drawImage(sourceImage, 0, 0);

  const targetWidth = media?.printableDots ?? PRINT_WIDTH_DOTS;
  const dieCutLength = media?.type === 'die-cut' ? media.dieCutMaskedAreaDots : undefined;

  let finalWidth, finalHeight, drawWidth, drawHeight, drawX, drawY;
  if (dieCutLength) {
    // Fixed label box: scale to fit inside targetWidth x dieCutLength
    // (whichever axis is tighter), then center on a white canvas of
    // exactly that size -- the row count the protocol requires.
    const fitScale = Math.min(targetWidth / rotatedWidth, dieCutLength / rotatedHeight);
    drawWidth = Math.round(rotatedWidth * fitScale);
    drawHeight = Math.round(rotatedHeight * fitScale);
    finalWidth = targetWidth;
    finalHeight = dieCutLength;
    drawX = Math.floor((finalWidth - drawWidth) / 2);
    drawY = Math.floor((finalHeight - drawHeight) / 2);
  } else {
    // Continuous roll: scale to the printable width, preserving aspect
    // ratio -- whatever that makes the feed length.
    const scale = targetWidth / rotatedWidth;
    drawWidth = finalWidth = targetWidth;
    drawHeight = finalHeight = Math.round(rotatedHeight * scale);
    drawX = drawY = 0;
  }

  const finalCanvas = createCanvas(finalWidth, finalHeight);
  const finalCtx = finalCanvas.getContext('2d');
  // White background first -- the source PDF render can have
  // transparency, and the printer has no concept of "transparent."
  finalCtx.fillStyle = '#ffffff';
  finalCtx.fillRect(0, 0, finalWidth, finalHeight);
  finalCtx.drawImage(rotatedCanvas, drawX, drawY, drawWidth, drawHeight);

  const imageData = finalCtx.getImageData(0, 0, finalWidth, finalHeight);
  return { width: finalWidth, height: finalHeight, data: imageData.data };
}
