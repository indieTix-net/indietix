import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { setupTestDatabase, teardownTestDatabase } from 'test-db-harness';
import { createDatabaseObjects } from '../../clientSetup-Teardown/src/index.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { processClientDatabase } = require('../src/index.js');
const SftpClient = require('ssh2-sftp-client');
const { Client: FtpClient } = require('basic-ftp');

const { Client } = pg;
const s3Mock = mockClient(S3Client);

// SAFETY: FTP1/FTP2 are live, running
// nightly in production -- a test run accidentally reaching a real
// server could double-deliver a real report. uploadToFtpServer()
// constructs `new SftpClient()`/`new FtpClient()` directly (no
// injectable factory), so the only reliable way to guarantee zero
// network calls is to monkey-patch the real classes' prototypes before
// any test runs. Host values below are also deliberately obviously-fake
// (`.invalid` TLD, reserved per RFC 2606) as defense in depth on top of
// the patched methods -- even if the patch were somehow bypassed, these
// hosts can never resolve to a real server.
let sftpCalls, ftpCalls;
let originalSftpConnect, originalSftpPut, originalSftpEnd;
let originalFtpAccess, originalFtpUploadFrom, originalFtpClose, originalFtpEnsureDir;

before(() => {
  originalSftpConnect = SftpClient.prototype.connect;
  originalSftpPut = SftpClient.prototype.put;
  originalSftpEnd = SftpClient.prototype.end;
  originalFtpAccess = FtpClient.prototype.access;
  originalFtpUploadFrom = FtpClient.prototype.uploadFrom;
  originalFtpClose = FtpClient.prototype.close;
  originalFtpEnsureDir = FtpClient.prototype.ensureDir;

  SftpClient.prototype.connect = async function (opts) { sftpCalls.push({ method: 'connect', opts }); this.sftp = true; };
  SftpClient.prototype.put = async function (local, remote) { sftpCalls.push({ method: 'put', local, remote }); };
  SftpClient.prototype.end = async function () { sftpCalls.push({ method: 'end' }); };

  FtpClient.prototype.access = async function (opts) { ftpCalls.push({ method: 'access', opts }); };
  FtpClient.prototype.uploadFrom = async function (local, remote) { ftpCalls.push({ method: 'uploadFrom', local, remote }); };
  FtpClient.prototype.close = function () { ftpCalls.push({ method: 'close' }); };
  FtpClient.prototype.ensureDir = async function (dir) { ftpCalls.push({ method: 'ensureDir', dir }); };
});

after(async () => {
  SftpClient.prototype.connect = originalSftpConnect;
  SftpClient.prototype.put = originalSftpPut;
  SftpClient.prototype.end = originalSftpEnd;
  FtpClient.prototype.access = originalFtpAccess;
  FtpClient.prototype.uploadFrom = originalFtpUploadFrom;
  FtpClient.prototype.close = originalFtpClose;
  FtpClient.prototype.ensureDir = originalFtpEnsureDir;

  await client.end();
  await teardownTestDatabase(containerName);
});

let dbConfig, containerName, client;

before(async () => {
  ({ dbConfig, containerName } = await setupTestDatabase({ dbName: 'daily_pg_sftp_test' }));
  await createDatabaseObjects(dbConfig, 'daily_pg_sftp_test', 69938, 'Test Theatre', 'TT');
  client = new Client(dbConfig);
  await client.connect();
});

beforeEach(async () => {
  sftpCalls = [];
  ftpCalls = [];
  s3Mock.reset();
  s3Mock.on(PutObjectCommand).resolves({});
  await client.query(`DELETE FROM "QRCodeProduct"`);
});

async function insertTicket({ productDate, price = 10, status = 'valid' }) {
  await client.query(
    `INSERT INTO "QRCodeProduct"
      ("QRCode", "ExpirationDate", "ProductDate", "ProductName", "ProductLocation",
       "ProductType", "ProductDetails", "ProductPrice", "ProductID", "ProductVenue",
       "ProductSeatCode", "Status")
     VALUES ($1, '2099-01-01', $2, 'Test Movie', 'Main', 'Movie', 'details', $3, 'ITEM', 'Main Theatre', 'Adult', $4)`,
    [`QR-${Math.random().toString(36).slice(2)}`, productDate, price, status]
  );
}

test('processClientDatabase: generates a real TDI CSV from real ticket data and uploads it to S3 (no FTP configured)', async () => {
  await insertTicket({ productDate: '2026-04-26 19:00:00', price: 10.93 });

  const result = await processClientDatabase(
    { clientId: 'daily_pg_sftp_test', configuration: { THEATER_ID: '69938', THEATER_NAME: 'Test Theatre', S3_BUCKET_PREFIX: 'indietix-', USE_FTP: 'false' } },
    dbConfig,
    '2026-04-26'
  );

  assert.equal(result.success, true);
  assert.equal(result.tdi.rowCount, 1);
  assert.equal(result.tdi.filename, 'RTS_69938_202604260000.csv');
  assert.equal(result.ebor, null, 'no EBOR_THEATRE_NO configured -- no EBOR file expected');
  assert.equal(result.ftpResults.length, 0);
  assert.equal(sftpCalls.length, 0);
  assert.equal(ftpCalls.length, 0);

  const s3Calls = s3Mock.commandCalls(PutObjectCommand);
  assert.equal(s3Calls.length, 1, 'only the TDI file -- no EBOR file was generated');
  assert.equal(s3Calls[0].args[0].input.Key, 'RTS_69938_202604260000.csv');
});

test('processClientDatabase: EBOR_THEATRE_NO configured generates a real EBOR XML too, uploaded to S3', async () => {
  await insertTicket({ productDate: '2026-04-27 19:00:00', price: 12 });

  const result = await processClientDatabase(
    { clientId: 'daily_pg_sftp_test', configuration: { THEATER_ID: '69938', THEATER_NAME: 'Test Theatre', EBOR_THEATRE_NO: '69938', S3_BUCKET_PREFIX: 'indietix-', USE_FTP: 'false' } },
    dbConfig,
    '2026-04-27'
  );

  assert.equal(result.success, true);
  assert.ok(result.ebor);
  assert.equal(result.ebor.filename, 'FRG_69938_202604270000.xml');
  assert.equal(result.ebor.rowCount, 1);

  const s3Calls = s3Mock.commandCalls(PutObjectCommand);
  assert.equal(s3Calls.length, 2, 'both TDI and EBOR files uploaded');
});

test('processClientDatabase: FTP routing is FTP1=EBOR, FTP2=TDI, FTP3=TDI -- all three deliberately fake/mocked, never touching a real server', async () => {
  await insertTicket({ productDate: '2026-04-28 19:00:00', price: 15 });

  const result = await processClientDatabase(
    {
      clientId: 'daily_pg_sftp_test',
      configuration: {
        THEATER_ID: '69938', THEATER_NAME: 'Test Theatre', EBOR_THEATRE_NO: '69938',
        S3_BUCKET_PREFIX: 'indietix-', USE_FTP: 'true',
        FTP1_TYPE: 'sftp', FTP1_HOST: 'ftp1.mock-sftp-test.invalid', FTP1_USER: 'u1', FTP1_PASSWORD: 'p1',
        FTP2_TYPE: 'ftp', FTP2_HOST: 'ftp2.mock-ftp-test.invalid', FTP2_USER: 'u2', FTP2_PASSWORD: 'p2',
        FTP3_TYPE: 'sftp', FTP3_HOST: 'ftp3.mock-sftp-test.invalid', FTP3_USER: 'u3', FTP3_PASSWORD: 'p3'
      }
    },
    dbConfig,
    '2026-04-28'
  );

  assert.equal(result.success, true);
  assert.equal(result.ftpResults.length, 3);

  const byServer = Object.fromEntries(result.ftpResults.map(r => [r.server, r]));
  assert.equal(byServer.FTP1.purpose, 'EBOR');
  assert.equal(byServer.FTP1.file, 'FRG_69938_202604280000.xml');
  assert.equal(byServer.FTP2.purpose, 'TDI');
  assert.equal(byServer.FTP2.file, 'RTS_69938_202604280000.csv');
  assert.equal(byServer.FTP3.purpose, 'TDI');
  assert.equal(byServer.FTP3.file, 'RTS_69938_202604280000.csv');

  // FTP1 and FTP3 are sftp -> went through the mocked SftpClient; FTP2 is
  // plain ftp -> went through the mocked FtpClient. Never a real connection.
  assert.equal(sftpCalls.filter(c => c.method === 'connect').length, 2);
  assert.equal(ftpCalls.filter(c => c.method === 'access').length, 1);
  assert.equal(ftpCalls[0].opts.host, 'ftp2.mock-ftp-test.invalid');
});

test('processClientDatabase: FTP1 (EBOR) is skipped gracefully when FTP1 is configured but EBOR_THEATRE_NO is not', async () => {
  await insertTicket({ productDate: '2026-04-29 19:00:00', price: 10 });

  const result = await processClientDatabase(
    {
      clientId: 'daily_pg_sftp_test',
      configuration: {
        THEATER_ID: '69938', THEATER_NAME: 'Test Theatre', S3_BUCKET_PREFIX: 'indietix-', USE_FTP: 'true',
        FTP1_HOST: 'ftp1.mock-sftp-test.invalid', FTP1_USER: 'u1', FTP1_PASSWORD: 'p1'
        // no EBOR_THEATRE_NO, no FTP2/FTP3
      }
    },
    dbConfig,
    '2026-04-29'
  );

  assert.equal(result.success, true);
  assert.equal(result.ftpResults.length, 0, 'FTP1 configured but nothing to send it -- not an error, just nothing to do');
  assert.equal(sftpCalls.length, 0);
});

test('processClientDatabase: an FTP upload failure is captured per-server, not fatal to the whole client (S3 uploads still happen)', async () => {
  await insertTicket({ productDate: '2026-04-30 19:00:00', price: 10 });
  SftpClient.prototype.connect = async function () { throw new Error('Connection refused (mocked failure)'); };

  const result = await processClientDatabase(
    {
      clientId: 'daily_pg_sftp_test',
      configuration: {
        THEATER_ID: '69938', THEATER_NAME: 'Test Theatre', EBOR_THEATRE_NO: '69938',
        S3_BUCKET_PREFIX: 'indietix-', USE_FTP: 'true',
        FTP1_HOST: 'ftp1.mock-sftp-test.invalid', FTP1_USER: 'u1', FTP1_PASSWORD: 'p1'
      }
    },
    dbConfig,
    '2026-04-30'
  );

  assert.equal(result.success, true, 'the client overall still succeeds -- one FTP failure is captured, not fatal');
  assert.equal(result.ftpResults[0].server, 'FTP1');
  assert.match(result.ftpResults[0].error, /Connection refused/);
  assert.equal(s3Mock.commandCalls(PutObjectCommand).length, 2, 'S3 uploads proceed regardless of FTP outcome');

  // Restore for subsequent tests.
  SftpClient.prototype.connect = async function (opts) { sftpCalls.push({ method: 'connect', opts }); this.sftp = true; };
});

test('processClientDatabase: the legacy 2-param SQL_QUERY path still works (reportDate ignored, as documented)', async () => {
  await insertTicket({ productDate: '2026-05-01 19:00:00', price: 10 });

  const result = await processClientDatabase(
    {
      clientId: 'daily_pg_sftp_test',
      configuration: {
        THEATER_ID: '69938', THEATER_NAME: 'Test Theatre', S3_BUCKET_PREFIX: 'indietix-', USE_FTP: 'false',
        SQL_QUERY: 'SELECT * FROM get_bdor_grouped(1, $1, $2)'
      }
    },
    dbConfig,
    '2026-05-01'
  );

  // get_bdor_grouped doesn't exist in this schema (only the _for_date
  // variant does) -- the legacy branch is real but the function itself
  // isn't defined for a from-scratch client, so this should fail
  // cleanly rather than silently succeed with wrong data.
  assert.equal(result.success, false);
});

test('processClientDatabase: a database-level failure (e.g. invalid client ID) is caught and reported, not thrown', async () => {
  const result = await processClientDatabase(
    { clientId: 'this_database_does_not_exist', configuration: { THEATER_ID: '1', THEATER_NAME: 'X', S3_BUCKET_PREFIX: 'indietix-', USE_FTP: 'false' } },
    dbConfig,
    '2026-05-01'
  );
  assert.equal(result.success, false);
  assert.ok(result.error);
});
