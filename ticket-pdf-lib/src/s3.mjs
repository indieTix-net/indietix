import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

// Takes an already-configured S3Client as a parameter rather than
// constructing one internally -- this library has no opinion on region/
// credentials; the caller's own client (same one it uses everywhere
// else) is reused as-is.

/**
 * @param {import('@aws-sdk/client-s3').S3Client} s3Client
 * @param {string} bucket
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
export async function fetchPdfFromS3(s3Client, bucket, key) {
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return await streamToBuffer(response.Body);
}

/**
 * @param {import('@aws-sdk/client-s3').S3Client} s3Client
 * @param {string} bucket
 * @param {string} key
 * @param {Buffer|Uint8Array} pdfBuffer
 */
export async function savePdfToS3(s3Client, bucket, key, pdfBuffer) {
  await s3Client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: pdfBuffer,
    ContentType: 'application/pdf',
  }));
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
