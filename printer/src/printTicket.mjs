import { discovery } from '@thermal-label/brother-ql-node';
import { createPreviewOffline } from '@thermal-label/brother-ql-core';
import { renderTicketToRasterImage } from './renderTicket.mjs';
import { PRINTER_HOST, MEDIA_ID, DEVICE_KEY } from './config.mjs';

function findMedia() {
  const media = discovery.listMedia().find((m) => m.id === MEDIA_ID);
  if (!media) {
    throw new Error(`MEDIA_ID ${MEDIA_ID} not found in the driver's media catalog.`);
  }
  return media;
}

/**
 * Fetches a ticket PDF and sends it to the configured Brother QL
 * printer over TCP. Throws if PRINTER_HOST isn't configured or if the
 * printer can't be reached -- callers should surface that clearly
 * rather than silently swallow it (there's no background DLQ/retry
 * here, see the project's own getSquareOrders incident for why that's
 * deliberate elsewhere -- this is a direct, synchronous, one-shot
 * action the operator is standing in front of, closer in spirit to a
 * button press than to an async queue).
 *
 * One immediate in-request retry is the exception: the QL-820NWB
 * drops into a power-save state after a few minutes idle where it
 * stays associated to WiFi (ping/ARP still work) but the first TCP
 * connect to the print port times out -- confirmed live 2026-10-27,
 * a bare `nc` probe moments later succeeded once the printer had
 * "woken up." A single retry still ends in the same click either
 * succeeding or failing visibly -- it's not a queue, nothing happens
 * outside the operator's awareness, so it doesn't reintroduce the
 * hazard the no-retry decision above is about.
 *
 * Logs one "Print timing" line per ticket (milliseconds per step), so a
 * slow print can be traced to the download, the PDF render, the printer
 * connection or the print itself.
 *
 * @param {string} pdfUrl - presigned S3 URL for the ticket PDF.
 */
export async function printTicket(pdfUrl) {
  requirePrinterHost();
  const timings = {};
  const start = performance.now();
  let outcome = 'failed';
  try {
    const { image, media } = await prepareTicket(pdfUrl, timings);
    await sendWithRetry(image, media, timings);
    outcome = 'printed';
  } finally {
    logTiming(outcome, timings, start);
  }
}

/**
 * Prints several tickets in order (Print Tickets on the Orders page). The
 * next ticket is downloaded and drawn while the current one prints, so the
 * printer isn't left waiting between labels; tickets still go to the
 * printer one at a time, in the order given. Stops at the first failure.
 *
 * @param {string[]} pdfUrls - presigned S3 URLs, in print order.
 * @returns {Promise<number>} how many printed. A thrown error carries
 *   `printed`, the count that made it out before the failure.
 */
export async function printTickets(pdfUrls) {
  requirePrinterHost();
  const prepare = (i) => {
    const job = { timings: { batch: `${i + 1}/${pdfUrls.length}` }, start: performance.now() };
    job.ready = prepareTicket(pdfUrls[i], job.timings);
    // Awaited in turn below; this only stops an unhandled rejection when
    // an earlier ticket fails and this one is never reached.
    job.ready.catch(() => {});
    return job;
  };
  let printed = 0;
  let current = prepare(0);
  for (let i = 0; i < pdfUrls.length; i++) {
    const next = i + 1 < pdfUrls.length ? prepare(i + 1) : null;
    let outcome = 'failed';
    try {
      const { image, media } = await current.ready;
      await sendWithRetry(image, media, current.timings);
      outcome = 'printed';
      printed++;
    } catch (error) {
      error.printed = printed;
      throw error;
    } finally {
      logTiming(outcome, current.timings, current.start);
    }
    current = next;
  }
  return printed;
}

function requirePrinterHost() {
  if (!PRINTER_HOST) {
    throw new Error('PRINTER_HOST is not configured. Set it in .env to the printer\'s LAN IP.');
  }
}

function logTiming(outcome, timings, start) {
  timings.totalMs = Math.round(performance.now() - start);
  console.log(`Print timing (${outcome}):`, JSON.stringify(timings));
}

// Download and draw one ticket, ready to send.
async function prepareTicket(pdfUrl, timings) {
  const downloadStart = performance.now();
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ticket PDF: ${response.status}`);
  }
  const pdfBytes = Buffer.from(await response.arrayBuffer());
  timings.downloadMs = Math.round(performance.now() - downloadStart);
  timings.pdfKB = Math.round(pdfBytes.length / 1024);
  const media = findMedia();
  const image = await renderTicketToRasterImage(pdfBytes, media, timings);
  return { image, media };
}

// One retry after 2 s, for the printer's power-save wake-up (see above).
async function sendWithRetry(image, media, timings) {
  try {
    await sendToPrinter(image, media, timings, '');
  } catch (firstError) {
    timings.firstTryError = firstError.message;
    const waitStart = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    timings.retryWaitMs = Math.round(performance.now() - waitStart);
    try {
      await sendToPrinter(image, media, timings, 'retry');
    } catch {
      throw firstError;
    }
  }
}

// `prefix` keeps a retry's step times separate from the first try's.
async function sendToPrinter(image, media, timings = {}, prefix = '') {
  const key = (name) => (prefix ? `${prefix}${name[0].toUpperCase()}${name.slice(1)}` : name);
  let stepStart = performance.now();
  const printer = await discovery.openPrinter({ host: PRINTER_HOST, deviceKey: DEVICE_KEY });
  timings[key('connectMs')] = Math.round(performance.now() - stepStart);
  // The driver sends every job in 1 KB pieces with a 20 ms pause between
  // them, which a USB printer needs and a network one doesn't. A ticket is
  // about 113 KB, so that pacing alone cost 2.4 s on a Mac and more on the
  // box office PC (Windows timers are coarser). Over the network, send the
  // job in one write. printMs minus sendMs is the printer's own time plus
  // the driver's page-counter check.
  if (printer.transportType === 'tcp' && printer.transport && typeof printer.writeChunked === 'function') {
    printer.writeChunked = async (bytes) => {
      const sendStart = performance.now();
      await printer.transport.write(bytes);
      timings[key('sendMs')] = Math.round(performance.now() - sendStart);
      timings.jobKB = Math.round(bytes.length / 1024);
    };
  }
  stepStart = performance.now();
  try {
    await printer.print(image, media);
  } finally {
    // print() includes the driver's page-counter confirmation, so this is
    // recorded even when that check fails
    timings[key('printMs')] = Math.round(performance.now() - stepStart);
    stepStart = performance.now();
    await printer.close();
    timings[key('closeMs')] = Math.round(performance.now() - stepStart);
  }
}

/**
 * Renders the exact same pipeline a real print would use, but returns a
 * PNG buffer instead of sending anything to a printer -- for verifying
 * layout/scale before real hardware is on hand, or for debugging a
 * print that came out wrong without burning a physical label.
 *
 * @param {string} pdfUrl - presigned S3 URL for the ticket PDF.
 * @returns {Promise<Buffer>} PNG of the black plane, at the exact pixel
 *   dimensions that would be sent to the printer.
 */
export async function previewTicket(pdfUrl) {
  const response = await fetch(pdfUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ticket PDF: ${response.status}`);
  }
  const pdfBytes = Buffer.from(await response.arrayBuffer());

  const media = findMedia();
  const image = await renderTicketToRasterImage(pdfBytes, media);
  const preview = createPreviewOffline(image, media);

  return labelBitmapToPng(preview.planes[0].bitmap);
}

// Unpacks a 1bpp LabelBitmap (MSB-first, 8 pixels/byte, matching the
// Brother raster convention) into a viewable PNG via @napi-rs/canvas.
async function labelBitmapToPng(bitmap) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const canvas = createCanvas(bitmap.widthPx, bitmap.heightPx);
  const ctx = canvas.getContext('2d');
  const imageData = ctx.createImageData(bitmap.widthPx, bitmap.heightPx);
  const bytesPerRow = Math.ceil(bitmap.widthPx / 8);

  for (let y = 0; y < bitmap.heightPx; y++) {
    for (let x = 0; x < bitmap.widthPx; x++) {
      const byteIndex = y * bytesPerRow + (x >> 3);
      const bit = 7 - (x & 7);
      const isBlack = (bitmap.data[byteIndex] >> bit) & 1;
      const pixelIndex = (y * bitmap.widthPx + x) * 4;
      const value = isBlack ? 0 : 255;
      imageData.data[pixelIndex] = value;
      imageData.data[pixelIndex + 1] = value;
      imageData.data[pixelIndex + 2] = value;
      imageData.data[pixelIndex + 3] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toBuffer('image/png');
}
