import QRCode from 'qrcode';

/**
 * Renders `data` as a QR code PNG.
 * @param {string} data - the string to encode (a ticket's QR code value)
 * @returns {Promise<Buffer>} PNG image buffer
 */
export async function generateQRCode(data) {
  return new Promise((resolve, reject) => {
    QRCode.toBuffer(data, { type: 'png', width: 150 }, (err, buffer) => {
      if (err) reject(err);
      else resolve(buffer);
    });
  });
}
