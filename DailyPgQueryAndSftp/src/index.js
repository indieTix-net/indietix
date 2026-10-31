const { Client } = require('pg');
const SftpClient = require('ssh2-sftp-client');
const { Client: FtpClient } = require('basic-ftp');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

// Initialize AWS clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });

/**
 * Returns today's date in America/Chicago as a YYYY-MM-DD string.
 * Lambdas run in UTC, so we have to ask for Chicago explicitly.
 */
function todayInChicago() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

/**
 * Validates that a string is in YYYY-MM-DD format and represents a real date.
 */
function isValidDateString(s) {
  if (typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Retrieves database credentials from AWS Secrets Manager
 */
async function getDatabaseCredentials(secretName) {
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretName,
        VersionStage: "AWSCURRENT",
      })
    );

    const secret = JSON.parse(response.SecretString);
    console.log(`Successfully retrieved database credentials from: ${secretName}`);
    return secret;
  } catch (error) {
    console.error(`Error retrieving database credentials from ${secretName}:`, error);
    throw error;
  }
}

/**
 * Gets all client databases by querying system catalogs
 */
async function getAllClientDatabases(dbConfig) {
  console.log("Discovering client databases...");
  const pgClient = new Client({
    ...dbConfig,
    database: 'postgres'
  });

  try {
    await pgClient.connect();

    const query = `
      SELECT datname
      FROM pg_database
      WHERE datname NOT IN ('postgres', 'template0', 'template1', 'rdsadmin')
        AND datistemplate = false
        AND datallowconn = true
      ORDER BY datname
    `;

    const result = await pgClient.query(query);
    const databases = result.rows.map(row => row.datname);

    console.log(`Found ${databases.length} potential client databases: ${databases.join(', ')}`);
    return databases;

  } finally {
    await pgClient.end();
  }
}

/**
 * Gets client configuration from a specific client database
 */
async function getClientConfiguration(databaseName, baseDbConfig) {
  const pgClient = new Client({
    ...baseDbConfig,
    database: databaseName
  });

  try {
    await pgClient.connect();

    const tableExistsQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'Client'
      );
    `;

    const tableResult = await pgClient.query(tableExistsQuery);
    if (!tableResult.rows[0].exists) {
      console.log(`Database ${databaseName}: No 'Client' table found`);
      return null;
    }

    const configQuery = `
      SELECT "configuration"
      FROM "Client"
      WHERE "configuration" IS NOT NULL
      LIMIT 1
    `;

    const result = await pgClient.query(configQuery);

    if (result.rows.length === 0) {
      console.log(`Database ${databaseName}: No configuration found in Client table`);
      return null;
    }

    const configuration = result.rows[0].configuration;
    console.log(`Database ${databaseName}: Found valid configuration`);

    return {
      clientId: databaseName,
      configuration: configuration
    };

  } catch (error) {
    console.log(`Database ${databaseName}: Error checking configuration - ${error.message}`);
    return null;
  } finally {
    await pgClient.end();
  }
}

/**
 * Gets all clients with their configurations by discovering databases
 */
async function getAllClientsWithConfigurations(baseDbConfig) {
  console.log("Starting client discovery process...");

  const clientDatabases = await getAllClientDatabases(baseDbConfig);

  if (clientDatabases.length === 0) {
    console.log("No client databases found");
    return [];
  }

  const clients = [];
  for (const dbName of clientDatabases) {
    const clientConfig = await getClientConfiguration(dbName, baseDbConfig);
    if (clientConfig) {
      clients.push(clientConfig);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log(`Successfully found ${clients.length} clients with valid configurations`);
  return clients;
}

/**
 * Processes a single client's database
 * @param {Object} clientData - Client data with ID and configuration
 * @param {Object} baseDbConfig - Base database configuration
 * @param {string} reportDate - YYYY-MM-DD; Chicago business day to report on
 */
async function processClientDatabase(clientData, baseDbConfig, reportDate) {
  const { clientId, configuration } = clientData;
  let pgClient;
  const tempFiles = [];  // anything we create gets cleaned up at the end

  console.log(`\n=== Processing client: ${clientId} for report date: ${reportDate} ===`);

  try {
    const clientDbConfig = {
      ...baseDbConfig,
      database: clientId
    };

    const sqlQuery = configuration.SQL_QUERY || "SELECT * FROM get_bdor_grouped_for_date($1, $2, $3)";
    const theaterId = configuration.THEATER_ID || "00000";
    const theaterName = configuration.THEATER_NAME || "Unknown Theater";

    // YYYYMMDD0000 timestamp used in both filenames.
    const filenameDateStr = reportDate.replace(/-/g, '') + '0000';

    // ===== TDI/RTS (CSV) =====
    const tdiFilename = `RTS_${theaterId}_${filenameDateStr}.csv`;
    const tdiTempPath = path.join(os.tmpdir(), `${clientId}_${tdiFilename}`);
    tempFiles.push(tdiTempPath);

    pgClient = new Client(clientDbConfig);
    await pgClient.connect();

    // Run the configured TDI query
    let tdiResult;
    if (sqlQuery.includes('get_bdor_grouped_for_date')) {
      console.log(`Executing parameterized (date) query for ${clientId}: ${sqlQuery}`);
      console.log(`Parameters: [Theater ID: "${theaterId}", Theater Name: "${theaterName}", Report Date: "${reportDate}"]`);
      tdiResult = await pgClient.query(sqlQuery, [theaterId, theaterName, reportDate]);
    } else if (sqlQuery.includes('get_bdor_grouped')) {
      // Legacy fallback for any client config still using the old 2-param function.
      console.log(`Executing legacy 2-param query for ${clientId}: ${sqlQuery}`);
      console.log(`Parameters: [Theater ID: "${theaterId}", Theater Name: "${theaterName}"]`);
      console.warn(`WARNING: ${clientId} is still configured with legacy get_bdor_grouped; reportDate will be ignored.`);
      tdiResult = await pgClient.query(sqlQuery, [theaterId, theaterName]);
    } else {
      console.log(`Executing custom query for ${clientId}: ${sqlQuery}`);
      tdiResult = await pgClient.query(sqlQuery);
    }
    console.log(`TDI query executed for ${clientId}. Found ${tdiResult.rows.length} rows.`);

    const tdiCsv = convertToCSV(tdiResult);
    await fs.writeFile(tdiTempPath, tdiCsv, 'utf8');
    console.log(`TDI file created for ${clientId}: ${tdiTempPath}`);

    // ===== EBOR (XML) — only if EBOR_THEATRE_NO is configured =====
    const eborTheatreNo = configuration.EBOR_THEATRE_NO;
    let eborTempPath = null;
    let eborFilename = null;
    let eborRowCount = 0;

    if (eborTheatreNo) {
      eborFilename = `FRG_${eborTheatreNo}_${filenameDateStr}.xml`;
      eborTempPath = path.join(os.tmpdir(), `${clientId}_${eborFilename}`);
      tempFiles.push(eborTempPath);

      const eborResult = await pgClient.query(
        'SELECT * FROM public.get_ebor_engagements_for_date($1, $2)',
        [eborTheatreNo, reportDate]
      );
      eborRowCount = eborResult.rows.length;
      console.log(`EBOR query executed for ${clientId}. Found ${eborRowCount} engagement rows.`);

      const eborXml = buildEborXml(eborResult.rows, reportDate, eborTheatreNo);
      await fs.writeFile(eborTempPath, eborXml, 'utf8');
      console.log(`EBOR file created for ${clientId}: ${eborTempPath}`);
    } else {
      console.log(`EBOR_THEATRE_NO not set for ${clientId}; skipping EBOR file generation.`);
    }

    await pgClient.end();
    pgClient = null;

    // ===== FTP uploads =====
    // Hardcoded routing: FTP1 = EBOR, FTP2 = TDI, FTP3 = TDI (second TDI destination).
    const ftpResults = [];
    if (configuration.USE_FTP === 'true') {
      console.log(`FTP uploads enabled for ${clientId}, processing...`);

      // FTP1 → EBOR XML (only if both the FTP and the EBOR file exist)
      if (configuration.FTP1_HOST && eborTempPath) {
        try {
          const ftp1Result = await uploadToFtpServer({
            type: configuration.FTP1_TYPE || 'sftp',
            host: configuration.FTP1_HOST,
            port: parseInt(configuration.FTP1_PORT || (configuration.FTP1_TYPE === 'ftp' ? '21' : '22')),
            username: configuration.FTP1_USER,
            password: configuration.FTP1_PASSWORD,
            remotePath: configuration.FTP1_REMOTE_PATH || '/',
          }, eborTempPath, eborFilename);

          ftpResults.push({ server: 'FTP1', purpose: 'EBOR', file: eborFilename, ...ftp1Result });
          console.log(`FTP1 (EBOR) upload successful for ${clientId}: ${ftp1Result.remotePath}`);
        } catch (error) {
          console.error(`FTP1 (EBOR) upload failed for ${clientId}:`, error);
          ftpResults.push({ server: 'FTP1', purpose: 'EBOR', file: eborFilename, error: error.message });
        }
      } else if (configuration.FTP1_HOST && !eborTempPath) {
        console.log(`FTP1 (EBOR) configured for ${clientId} but no EBOR file to upload (EBOR_THEATRE_NO missing).`);
      }

      // FTP2 → TDI CSV
      if (configuration.FTP2_HOST) {
        try {
          const ftp2Result = await uploadToFtpServer({
            type: configuration.FTP2_TYPE || 'sftp',
            host: configuration.FTP2_HOST,
            port: parseInt(configuration.FTP2_PORT || (configuration.FTP2_TYPE === 'ftp' ? '21' : '22')),
            username: configuration.FTP2_USER,
            password: configuration.FTP2_PASSWORD,
            remotePath: configuration.FTP2_REMOTE_PATH || '/',
          }, tdiTempPath, tdiFilename);

          ftpResults.push({ server: 'FTP2', purpose: 'TDI', file: tdiFilename, ...ftp2Result });
          console.log(`FTP2 (TDI) upload successful for ${clientId}: ${ftp2Result.remotePath}`);
        } catch (error) {
          console.error(`FTP2 (TDI) upload failed for ${clientId}:`, error);
          ftpResults.push({ server: 'FTP2', purpose: 'TDI', file: tdiFilename, error: error.message });
        }
      }

      // FTP3 → TDI CSV (second destination for the same report as FTP2)
      if (configuration.FTP3_HOST) {
        try {
          const ftp3Result = await uploadToFtpServer({
            type: configuration.FTP3_TYPE || 'sftp',
            host: configuration.FTP3_HOST,
            port: parseInt(configuration.FTP3_PORT || (configuration.FTP3_TYPE === 'ftp' ? '21' : '22')),
            username: configuration.FTP3_USER,
            password: configuration.FTP3_PASSWORD,
            remotePath: configuration.FTP3_REMOTE_PATH || '/',
          }, tdiTempPath, tdiFilename);

          ftpResults.push({ server: 'FTP3', purpose: 'TDI', file: tdiFilename, ...ftp3Result });
          console.log(`FTP3 (TDI) upload successful for ${clientId}: ${ftp3Result.remotePath}`);
        } catch (error) {
          console.error(`FTP3 (TDI) upload failed for ${clientId}:`, error);
          ftpResults.push({ server: 'FTP3', purpose: 'TDI', file: tdiFilename, error: error.message });
        }
      }
    } else {
      console.log(`FTP uploads disabled for ${clientId}`);
    }

    // ===== S3 uploads (both files when present) =====
    const s3Bucket = configuration.S3_BUCKET_PREFIX + `${clientId.toLowerCase()}-bdor`;
    console.log(`Uploading to S3 bucket: ${s3Bucket}`);

    // TDI
    const tdiBody = await fs.readFile(tdiTempPath);
    await s3Client.send(new PutObjectCommand({
      Bucket: s3Bucket,
      Key: tdiFilename,
      Body: tdiBody,
      ContentType: 'text/csv'
    }));
    const tdiS3Location = `https://${s3Bucket}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${tdiFilename}`;
    console.log(`TDI uploaded to S3 for ${clientId}: ${tdiS3Location}`);

    // EBOR (only if present)
    let eborS3Location = null;
    if (eborTempPath) {
      const eborBody = await fs.readFile(eborTempPath);
      await s3Client.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: eborFilename,
        Body: eborBody,
        ContentType: 'application/xml'
      }));
      eborS3Location = `https://${s3Bucket}.s3.${process.env.AWS_REGION || 'us-east-2'}.amazonaws.com/${eborFilename}`;
      console.log(`EBOR uploaded to S3 for ${clientId}: ${eborS3Location}`);
    }

    // ===== Cleanup =====
    for (const p of tempFiles) {
      try { await fs.unlink(p); } catch (e) { /* ignore */ }
    }

    return {
      clientId: clientId,
      success: true,
      reportDate: reportDate,
      tdi: {
        filename: tdiFilename,
        rowCount: tdiResult.rows.length,
        s3Location: tdiS3Location
      },
      ebor: eborFilename ? {
        filename: eborFilename,
        rowCount: eborRowCount,
        s3Location: eborS3Location
      } : null,
      ftpResults: ftpResults,
      s3Bucket: s3Bucket
    };

  } catch (error) {
    console.error(`Error processing client ${clientId}:`, error);

    if (pgClient) {
      try { await pgClient.end(); }
      catch (e) { console.error(`Error closing database connection for ${clientId}:`, e); }
    }

    for (const p of tempFiles) {
      try { await fs.unlink(p); } catch (e) { /* ignore */ }
    }

    return {
      clientId: clientId,
      success: false,
      error: error.message
    };
  }
}

/**
 * Build the comScore EBOR (Nightly Box Office) XML string.
 *
 * Format mirrors what comScore historically received from the prior RTS system:
 *   <Nightly_box_office>
 *   <YYYYMMDD>
 *   theatre_no,film_code,title,gross
 *   ...
 *   </YYYYMMDD>
 *   </Nightly_box_office>
 *
 * Note: <YYYYMMDD> is NOT a valid XML element name (can't start with a digit),
 * but this is the format comScore expects and parses on their end. We mirror
 * exactly what they were receiving previously.
 *
 * Title text gets minimal XML-escaping in case of '&' or '<'. Commas inside
 * titles would break the CSV-style row format; we strip them to a single space
 * to keep each row at exactly four fields.
 */
function buildEborXml(rows, reportDate, theatreNo) {
  const dateTag = reportDate.replace(/-/g, '');  // "2026-04-26" -> "20260426"

  const lines = [
    '<Nightly_box_office>',
    `<${dateTag}>`
  ];

  for (const r of rows) {
    const title = String(r.Title || '')
      .replace(/,/g, ' ')      // commas would break CSV-in-XML row format
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .trim();
    const filmCode = String(r['Film Code'] || '').trim();
    const grossNum = Number(r.Gross || 0);
    const gross = grossNum.toFixed(2);

    lines.push(`${theatreNo},${filmCode},${title},${gross}`);
  }

  lines.push(`</${dateTag}>`);
  lines.push('</Nightly_box_office>');
  lines.push('');  // trailing newline

  return lines.join('\n');
}

// Exported for this repo's own tests -- purely additive, doesn't change
// exports.handler's own behavior.
exports.todayInChicago = todayInChicago;
exports.isValidDateString = isValidDateString;
exports.getAllClientDatabases = getAllClientDatabases;
exports.getClientConfiguration = getClientConfiguration;
exports.getAllClientsWithConfigurations = getAllClientsWithConfigurations;
exports.processClientDatabase = processClientDatabase;
exports.buildEborXml = buildEborXml;
exports.convertToCSV = convertToCSV;
exports.escapeCSVField = escapeCSVField;

exports.handler = async (event, context) => {
  console.log('Starting multi-client database export process...');

  // Resolve the report date: optional event.reportDate, else today in Chicago.
  let reportDate;
  if (event && event.reportDate) {
    if (!isValidDateString(event.reportDate)) {
      const msg = `Invalid event.reportDate: "${event.reportDate}". Expected YYYY-MM-DD.`;
      console.error(msg);
      return {
        statusCode: 400,
        body: JSON.stringify({ error: msg, timestamp: new Date().toISOString() })
      };
    }
    reportDate = event.reportDate;
    console.log(`Using report date from event payload: ${reportDate}`);
  } else {
    reportDate = todayInChicago();
    console.log(`No reportDate in event; defaulting to today (America/Chicago): ${reportDate}`);
  }

  try {
    console.log('Retrieving indietix superuser credentials...');
    const dbCredentials = await getDatabaseCredentials('indieTix/rds/clients/indietix/credentials');

    const baseDbConfig = {
      host: dbCredentials.host,
      port: parseInt(dbCredentials.port || '5432'),
      user: dbCredentials.username,
      password: dbCredentials.password,
      ssl: dbCredentials.ssl === 'true' ? { rejectUnauthorized: false } : false,
      // 20s, not 10s: an Aurora cluster allowed to auto-pause (sandbox,
      // AuroraMinCapacity 0) takes ~15s to resume on the first connection.
      connectionTimeoutMillis: 20000,
      query_timeout: 30000,
    };

    console.log(`Connected to database host: ${dbCredentials.host}`);

    console.log('Starting database discovery process...');
    const clients = await getAllClientsWithConfigurations(baseDbConfig);

    if (clients.length === 0) {
      console.log('No clients found with configurations.');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No clients found with configurations',
          reportDate: reportDate,
          timestamp: new Date().toISOString()
        })
      };
    }

    console.log(`Processing ${clients.length} clients for report date ${reportDate}...`);

    const results = [];
    for (const client of clients) {
      const result = await processClientDatabase(client, baseDbConfig, reportDate);
      results.push(result);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const successfulClients = results.filter(r => r.success);
    const failedClients = results.filter(r => !r.success);

    console.log(`\n=== PROCESSING COMPLETE ===`);
    console.log(`Report date: ${reportDate}`);
    console.log(`Total clients: ${results.length}`);
    console.log(`Successful: ${successfulClients.length}`);
    console.log(`Failed: ${failedClients.length}`);

    if (failedClients.length > 0) {
      console.log('Failed clients:', failedClients.map(f => f.clientId).join(', '));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Successfully processed ${successfulClients.length} of ${results.length} clients`,
        reportDate: reportDate,
        summary: {
          totalClients: results.length,
          successful: successfulClients.length,
          failed: failedClients.length,
          totalTdiRows: successfulClients.reduce((sum, r) => sum + (r.tdi?.rowCount || 0), 0),
          totalEborRows: successfulClients.reduce((sum, r) => sum + (r.ebor?.rowCount || 0), 0),
          eborClients: successfulClients.filter(r => r.ebor).length
        },
        results: results,
        timestamp: new Date().toISOString()
      })
    };

  } catch (error) {
    console.error('Fatal error in multi-client processing:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Fatal error in multi-client processing',
        message: error.message,
        reportDate: reportDate,
        timestamp: new Date().toISOString()
      })
    };
  }
};

// Helper function to upload to FTP/SFTP server
async function uploadToFtpServer(config, localFilePath, filename) {
  const remotePath = path.posix.join(config.remotePath, filename);

  if (config.type.toLowerCase() === 'sftp') {
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: 20000,
        strictVendor: false
      });

      await sftp.put(localFilePath, remotePath);
      await sftp.end();

      return { success: true, remotePath: remotePath, type: 'sftp' };
    } catch (error) {
      if (sftp.sftp) {
        try { await sftp.end(); } catch (e) { /* ignore */ }
      }
      throw error;
    }
  } else {
    const ftp = new FtpClient();
    try {
      await ftp.access({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        secure: false
      });

      const remoteDir = path.posix.dirname(remotePath);
      if (remoteDir !== '.' && remoteDir !== '/') {
        try { await ftp.ensureDir(remoteDir); } catch (e) { /* ignore */ }
      }

      await ftp.uploadFrom(localFilePath, remotePath);
      ftp.close();

      return { success: true, remotePath: remotePath, type: 'ftp' };
    } catch (error) {
      ftp.close();
      throw error;
    }
  }
}

/**
 * Convert pg query result to CSV (RFC 4180, no header row).
 * Empty result sets produce the literal body "No data found\n".
 */
function convertToCSV(queryResult) {
  if (!queryResult.rows || queryResult.rows.length === 0) {
    return 'No data found\n';
  }

  // Preserve the column order returned by the function/view.
  const columns = Object.keys(queryResult.rows[0]);

  // No header row per BDOR spec (RFC 4180 + "Do not include a header record").
  let csv = '';

  for (const row of queryResult.rows) {
    const values = columns.map(col => {
      const value = row[col];
      if (value === null || value === undefined) {
        return '';
      }
      return escapeCSVField(String(value));
    });
    csv += values.join(',') + '\r\n';  // CRLF per RFC 4180
  }

  return csv;
}

// Helper function to escape CSV fields per RFC 4180
function escapeCSVField(field) {
  if (field === null || field === undefined) {
    return '';
  }

  field = String(field);

  if (field.includes(',') || field.includes('\n') || field.includes('\r') || field.includes('"')) {
    field = '"' + field.replace(/"/g, '""') + '"';
  }

  return field;
}
