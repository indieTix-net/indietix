// app.mjs - Modified to use client-agnostic authentication with AWS Secrets Manager
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import bodyParser from 'body-parser';
import pkg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import AWS from 'aws-sdk';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import mailcomposer from 'mailcomposer';
import { calendar } from '@googleapis/calendar';
import { GoogleAuth } from 'google-auth-library';
import { drive } from '@googleapis/drive';
import { Readable } from 'stream';
import crypto from 'crypto';
import sharp from 'sharp';

import { QRCodeProduct, initializeModelForClient, sequelize, Sequelize } from './models/index.mjs';
import { initializeModelForClient as initializeModelForClientOrder } from './models/order.mjs';
import { initializeModelForClient as initializeClientModel } from './models/client.mjs';
import { initializeModelForClient as initializeUserModel } from './models/user.mjs';
import { encryptPasswordResetToken, decryptPasswordResetToken, isPasswordResetTokenValid } from './utils/crypto-utils.mjs';
import { buildDataFilterWhereClause, normalizeEventType, eventExactPattern, eventContainsPattern } from './utils/data-filter-utils.mjs';
import { sendSms, buildMessageBody, normalizeToE164, maskForDisplay } from 'sms-utils';
// Shared QR-gen/PDF-overlay logic (see ../../ticket-pdf-lib) -- comes from
// the "ticketPdfLib" Lambda layer at runtime, not this repo's own
// node_modules. getSquareOrders is NOT touched by this and keeps running
// its own original copy of this logic for every real order.
import { generateQRCode, renderTicketPdf } from 'ticket-pdf-lib';


const ses = new AWS.SES();
const { Pool } = pkg;
const SQUARE_CATALOG_SEARCH_API_URL = "https://connect.squareup.com/v2/catalog/search";
const SQUARE_CATALOG_OBJECT_API_URL = "https://connect.squareup.com/v2/catalog/object";
const SQUARE_CATALOG_LIST_API_URL = "https://connect.squareup.com/v2/catalog/list";
const SQUARE_INVENTORY_BATCH_CREATE = "https://connect.squareup.com/v2/inventory/changes/batch-create";
const SQUARE_ITEM_LIBRARY_URL = "https://squareup.com/dashboard/items/library"
const SQUARE_IMAGE_UPLOAD_URL = "connect.squareup.com";
const SQUARE_REFUND_API_URL = "https://connect.squareup.com/v2/refunds";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Global configuration that gets populated from client config.
// No fallback for JWT_SECRET: every request path calls getClientConfiguration()
// before signing/verifying a token, so this should always be overwritten with the
// client's own secret. Leaving it unset makes jwt.sign/verify throw instead of
// silently falling back to a guessable value shared across every client.
// No STATIC_WEBSITE_URL fallback -- it used to default to Liberty Hall's
// own CloudFront URL, which meant a cold start (or any request landing
// before some other authenticated request has populated this from the
// real caller's own client config) would redirect a DIFFERENT client's
// staff to Liberty Hall's login page. /login checks for this explicitly
// instead of ever redirecting to the wrong venue.
let globalConfig = {
  AWS_REGION: process.env.AWS_REGION
};

// Configure AWS SDK with default region (will be updated from client config)
AWS.config.update({
  region: globalConfig.AWS_REGION
});

const s3 = new AWS.S3();
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });

/**
 * Retrieves database credentials from AWS Secrets Manager
 * @param {string} clientId - The client ID used to construct the secret name
 * @returns {Promise<Object>} - Database credentials object
 */
async function getDatabaseCredentials(clientId) {
  try {
    const secretName = `indieTix/rds/clients/${clientId}/credentials`;
    
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretName,
        VersionStage: "AWSCURRENT",
      })
    );
    
    const secret = JSON.parse(response.SecretString);
    console.log(`Successfully retrieved database credentials for client: ${clientId}`);
    return secret;
  } catch (error) {
    console.error(`Error retrieving database credentials for ${clientId}:`, error);
    throw error;
  }
}

/**
 * Gets client configuration from the database and updates global config
 * @param {Object} pool - Database connection pool
 * @param {string} clientId - The client ID
 * @returns {Promise<Object>} - Client configuration object
 */
async function getClientConfiguration(pool, clientId) {
  try {
    const query = `
      SELECT "configuration" FROM "Client" 
      WHERE "clientID" = $1
    `;

    const result = await pool.query(query, [clientId]);
    
    if (result.rows.length === 0) {
      throw new Error(`No configuration found for client: ${clientId}`);
    }
    
    const config = result.rows[0].configuration;
    console.log(`Retrieved configuration for client: ${clientId}`);
    
    // Update global configuration with client-specific values. AWS_REGION
    // is deliberately re-pinned to process.env.AWS_REGION afterward --
    // it's a deployment-level property (which region THIS Lambda runs in),
    // never a per-client one, but Client.configuration has historically
    // carried a (frequently stale/wrong) AWS_REGION key, and this spread
    // used to let it silently win, which then fed into AWS.config.update()
    // below and pointed the shared S3 client (ticket presigned URLs,
    // poster uploads, etc.) at the wrong region entirely in any deployment
    // other than the original us-east-2 one. Found running a real
    // bootstrap verification in a separate region (us-west-1) 2026-10-27 --
    // confirmed nothing else in the platform reads Client.configuration's
    // AWS_REGION for anything, so overriding it here is safe.
    globalConfig = {
      ...globalConfig,
      ...config,
      AWS_REGION: process.env.AWS_REGION
    };

    console.log(`Updated global configuration with client settings`);
    return config;
  } catch (error) {
    console.error(`Error retrieving client configuration for ${clientId}:`, error);
    throw error;
  }
}

/**
 * Creates a database connection pool using AWS Secrets Manager credentials
 * @param {string} clientId - The client ID (also used as database name)
 * @returns {Promise<Object>} - Database connection pool
 */
async function createClientDbConnection(clientId) {
  try {
    // Validate the clientId format
    if (!clientId || !/^[A-Za-z0-9]+$/.test(clientId)) {
      throw new Error(`Invalid clientId format: ${clientId}`);
    }
    
    // Get database credentials from AWS Secrets Manager
    const dbCredentials = await getDatabaseCredentials(clientId);
    
    // Create connection pool
    const pool = new Pool({
      host: dbCredentials.host,
      port: parseInt(dbCredentials.port || '5432'),
      database: clientId, // Database name is the clientId
      user: dbCredentials.username,
      password: dbCredentials.password,
      ssl: dbCredentials.ssl === 'true' ? { rejectUnauthorized: false } : false,
      // 20s, not 10s: an Aurora cluster allowed to auto-pause (sandbox,
      // AuroraMinCapacity 0) takes ~15s to resume on the first connection.
      connectionTimeoutMillis: 20000,
      max: 3
    });
    
    console.log(`Successfully created database connection for client: ${clientId}`);
    return pool;
  } catch (error) {
    console.error(`Error creating database connection for client ${clientId}:`, error);
    throw error;
  }
}

const app = express();

// Add middleware for parsing JSON requests. Default limit is 100kb, which
// is too small for the base64 image uploads a few routes accept directly
// in the JSON body (e.g. marketing post image edits) -- 6mb comfortably
// covers those while staying under the Lambda Function URL's own 6MB
// request payload ceiling (raising this further wouldn't help; Lambda
// itself would reject first). Large file uploads that don't need
// server-side processing (e.g. getMovieInfo.js's custom poster) still use
// the presigned-S3-URL pattern (/api/presigned-upload) instead, which
// bypasses this limit entirely.
app.use(bodyParser.json({ limit: '6mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '6mb' }));

// For local development, serve static files
if (globalConfig.ENV_TYPE === 'development') {
  // Public routes that don't need authentication
  app.use('/login.html', express.static(path.join(__dirname, 'public', 'login.html')));
  app.use('/css', express.static(path.join(__dirname, 'public', 'css')));
  app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
  app.use('/img', express.static(path.join(__dirname, 'public', 'img')));
  
  // Protected routes that need authentication
  app.use('/', requireAuth, express.static(path.join(__dirname, 'public')));
}

// Authentication middleware
const requireAuth = async (req, res, next) => {
  // Get token from Authorization header
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }
  
  try {
    // First decode the token WITHOUT verification to get the client ID
    const unverifiedDecoded = jwt.decode(token);
    
    if (!unverifiedDecoded || !unverifiedDecoded.username) {
      return res.status(401).json({ success: false, message: 'Invalid token format' });
    }
    
    // Get the client's configuration to get their JWT secret
    let clientPool;
    try {
      clientPool = await createClientDbConnection(unverifiedDecoded.username);
      await getClientConfiguration(clientPool, unverifiedDecoded.username);
      await clientPool.end();
    } catch (error) {
      console.error('Error retrieving client config for token verification:', error);
      return res.status(401).json({ success: false, message: 'Authentication failed' });
    }
    
    // Now verify the token with the correct client-specific JWT secret
    const decoded = jwt.verify(token, globalConfig.JWT_SECRET);
    
    // Add user data to request
    req.user = decoded;
    
    // If this is a sub-user (not a client), attach their data filter
    if (decoded.userType === 'user' && decoded.dataFilter) {
      req.dataFilter = decoded.dataFilter;
    } else {
      req.dataFilter = null; // Client has no filter restrictions
    }
    
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

// ---- SERVER-SIDE PERMISSIONS ----
// The UI's header-loader.js PAGE_ACCESS map decides what a user SEES;
// these decide what the API actually ALLOWS. Keep the two in step.
//
// Rules (decided route by route, 2026-10-29):
// - The client login (userType 'client', the venue's master account)
//   passes every permission check.
// - Sub-users pass if ANY listed flag is true. Flags are independent:
//   'admin' is NOT a superset of the others.
// - Permissions are read from the JWT, so a change takes effect at the
//   user's next login (tokens last 24h) -- accepted tradeoff.
const PERMS_DOOR = ['view', 'edit', 'checkIn'];     // scanner, tickets, dashboard
const PERMS_ORDERS = ['view', 'edit'];              // order.html, reports.html
const PERMS_ANY = ['view', 'edit', 'checkIn', 'marketing', 'admin'];

const requirePermission = (...allowed) => (req, res, next) => {
  if (req.user?.userType === 'client') return next();
  let perms = req.user?.permissions || {};
  if (typeof perms === 'string') {
    try { perms = JSON.parse(perms); } catch { perms = {}; }
  }
  if (allowed.some(p => perms[p] === true)) return next();
  return res.status(403).json({
    success: false,
    returnStatus: 'failed_forbidden',
    message: 'Access denied. Insufficient permissions.'
  });
};

// True when this request has a sub-user data filter to enforce.
const hasDataFilter = (req) =>
  !!(req.dataFilter && req.dataFilter.datafilters && req.dataFilter.datafilters.length > 0);

// Whether a single ticket is visible to this request's data filter.
// column is one of the fixed identifiers below, never user input.
async function ticketPassesDataFilter(req, column, value) {
  if (!hasDataFilter(req)) return true;
  if (!['QRCode', 'ID'].includes(column)) throw new Error(`bad column ${column}`);
  const { whereClause, params } = buildDataFilterWhereClause(req.dataFilter, 2);
  const pool = await createDbConnection(req.user.dbName);
  try {
    const result = await pool.query(
      `SELECT 1 FROM "QRCodeProduct" WHERE "QRCodeProduct"."${column}" = $1 ${whereClause} LIMIT 1`,
      [value, ...params]
    );
    return result.rows.length > 0;
  } finally {
    await pool.end();
  }
}

// Whether an order (by "Order"."ID") has at least one ticket visible to
// this request's data filter -- same JOIN the GET /api/orders search uses.
async function orderPassesDataFilter(req, orderId) {
  if (!hasDataFilter(req)) return true;
  const { whereClause, params } = buildDataFilterWhereClause(req.dataFilter, 2);
  const pool = await createDbConnection(req.user.dbName);
  try {
    const result = await pool.query(
      `SELECT 1 FROM "Order" o
       INNER JOIN "QRCodeProductToOrder" pto ON o."ID" = pto."OrderID"
       INNER JOIN "QRCodeProduct" ON pto."QRCodeProductID" = "QRCodeProduct"."ID"
       WHERE o."ID" = $1 ${whereClause} LIMIT 1`,
      [orderId, ...params]
    );
    return result.rows.length > 0;
  } finally {
    await pool.end();
  }
}

// Data-filtered resources answer 404, not 403, so a filtered user can't
// probe for the existence of tickets/orders outside their filter.
const filteredNotFound = (res, what = 'Not found') =>
  res.status(404).json({ success: false, returnStatus: 'failed_not_found', message: what });

// Who actually performed an audited action, from the verified token --
// stored next to the free-text name the UI sends, which is spoofable.
const actorFromToken = (req) =>
  req.user?.userType === 'client'
    ? { userType: 'client', clientId: req.user.username }
    : { userType: 'user', userId: req.user?.userId ?? null };
// ---- END SERVER-SIDE PERMISSIONS ----

/**
 * Fetches (or decodes) a poster from any source and re-encodes it to a real
 * JPEG via sharp, regardless of the actual source format (webp, png, gif...)
 * or what a server happened to claim its Content-Type was. This is the one
 * place that normalizes poster images -- every call site that uploads a
 * poster to Square or S3 should go through here instead of trusting a
 * fetched buffer's declared format.
 *
 * OMDb/Amazon's media CDN increasingly serves posters as WebP, which Square's
 * Catalog Images API doesn't support and which doesn't render consistently
 * wherever the S3-hosted calendar poster link ends up being previewed. Sharp
 * decodes based on the real file signature, so this fixes both regardless of
 * why the source came back in an unexpected format.
 *
 * @param {Object} source - Exactly one of url / buffer / dataUrl
 * @param {string} [source.url] - URL to fetch the poster from
 * @param {Buffer} [source.buffer] - Raw poster bytes already in hand
 * @param {string} [source.dataUrl] - A data:image/...;base64,... URL
 * @param {Object} [options]
 * @param {boolean} [options.square=false] - Letterbox onto a square black
 *   canvas (preserving aspect ratio), matching the frontend's existing
 *   square-poster behavior for the Square catalog item image.
 * @param {number} [options.size=600] - Square canvas size in pixels
 * @returns {Promise<{buffer: Buffer, contentType: string, extension: string}>}
 */
async function normalizePosterImage({ url, buffer, dataUrl }, { square = false, size = 600 } = {}) {
  let inputBuffer = buffer;

  if (!inputBuffer) {
    if (dataUrl) {
      const matches = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (!matches) {
        throw new Error('Invalid data URL format for poster');
      }
      inputBuffer = Buffer.from(matches[1], 'base64');
      console.log(`Decoded data URL poster, ${inputBuffer.length} bytes (pre-normalization)`);
    } else if (url) {
      console.log(`Downloading poster from: ${url}`);
      const posterResponse = await fetch(url);
      if (!posterResponse.ok) {
        throw new Error(`Failed to download poster: ${posterResponse.status}`);
      }
      inputBuffer = Buffer.from(await posterResponse.arrayBuffer());
      console.log(`Downloaded poster, ${inputBuffer.length} bytes (pre-normalization)`);
    } else {
      throw new Error('normalizePosterImage requires one of: url, buffer, dataUrl');
    }
  }

  let pipeline = sharp(inputBuffer);

  if (square) {
    // Letterbox (black bars), preserving aspect ratio -- not a crop. Matches
    // getMovieInfo.js's createSquarePosterBlob behavior for consistency.
    pipeline = pipeline.resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0 }
    });
  } else {
    // Cap height at 1000px -- some source images (OMDB, etc.) come in oversized.
    // withoutEnlargement so smaller source images aren't upscaled.
    pipeline = pipeline.resize({ height: 1000, withoutEnlargement: true, fit: 'inside' });
  }

  const outputBuffer = await pipeline
    .withMetadata({ density: 72 })
    .jpeg({ quality: 90 })
    .toBuffer();
  console.log(`Poster normalized to ${square ? `${size}x${size} square ` : 'max 1000px height '}JPEG, ${outputBuffer.length} bytes`);

  return { buffer: outputBuffer, contentType: 'image/jpeg', extension: 'jpg' };
}

/**
 * Upload poster to S3
 * @param {Object} options - Upload options
 * @param {string} options.url - URL to download poster from (optional)
 * @param {Buffer} options.buffer - Buffer containing poster data (optional)
 * @param {string} options.dataUrl - data:image/...;base64,... URL (optional)
 * @param {string} options.filename - Suggested filename (optional, will be sanitized)
 * @param {boolean} [options.square=false] - Letterbox onto a square canvas
 * @param {string} clientId - Client ID for determining S3 bucket
 * @returns {Promise<string>} - S3 URL of uploaded poster
 */
async function uploadPosterToS3({ url, buffer, dataUrl, filename, square = false }, clientId) {
  const { buffer: posterBuffer, contentType: posterContentType, extension } =
    await normalizePosterImage({ url, buffer, dataUrl }, { square });

  // Create safe filename
  const safeFilename = filename
    ? `${filename.replace(/[^a-z0-9]/gi, '_')}_poster.${extension}`
    : `poster_${Date.now()}.${extension}`;

  const s3Key = `movie-posters/${safeFilename}`;
  const bucketName = globalConfig.S3_BUCKET_PREFIX+clientId.toLowerCase();

  // Upload to S3
  await s3.putObject({
    Bucket: bucketName,
    Key: s3Key,
    Body: posterBuffer,
    ContentType: posterContentType
  }).promise();

  const s3Url = `https://${bucketName}.s3.${globalConfig.AWS_REGION}.amazonaws.com/${s3Key}`;
  console.log(`✅ Uploaded poster to S3: ${s3Url}`);

  return s3Url;
}

// ---- DIGEST BACKGROUND IMAGE ----
// Any shape is allowed -- scaled down to fit within this max dimension
// (on whichever side is larger) if bigger, aspect ratio preserved, never
// cropped and never upscaled. The weekly digest's text-overlay offsets
// (top/right/bottom/left, in pixels) are then measured against this
// image's real resulting dimensions, not a fixed canvas -- see
// marketingEngine's generateDigestImage, which reads the actual
// width/height back out instead of assuming a constant.
const DIGEST_MAX_DIMENSION = 1024;

async function normalizeDigestBackgroundImage({ url, buffer, dataUrl }) {
  let inputBuffer = buffer;
  if (!inputBuffer) {
    if (dataUrl) {
      const matches = dataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (!matches) throw new Error('Invalid data URL format for digest background');
      inputBuffer = Buffer.from(matches[1], 'base64');
    } else if (url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to download digest background: ${response.status}`);
      inputBuffer = Buffer.from(await response.arrayBuffer());
    } else {
      throw new Error('normalizeDigestBackgroundImage requires one of: url, buffer, dataUrl');
    }
  }

  const outputBuffer = await sharp(inputBuffer)
    .resize(DIGEST_MAX_DIMENSION, DIGEST_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
    .withMetadata({ density: 72 })
    .jpeg({ quality: 90 })
    .toBuffer();

  return { buffer: outputBuffer, contentType: 'image/jpeg', extension: 'jpg' };
}

async function uploadDigestBackgroundToS3({ url, buffer, dataUrl }, clientId) {
  const { buffer: bgBuffer, contentType, extension } = await normalizeDigestBackgroundImage({ url, buffer, dataUrl });

  const s3Key = `digest-backgrounds/background_${Date.now()}.${extension}`;
  const bucketName = globalConfig.S3_BUCKET_PREFIX + clientId.toLowerCase();

  await s3.putObject({
    Bucket: bucketName,
    Key: s3Key,
    Body: bgBuffer,
    ContentType: contentType
  }).promise();

  const s3Url = `https://${bucketName}.s3.${globalConfig.AWS_REGION}.amazonaws.com/${s3Key}`;
  console.log(`✅ Uploaded digest background to S3: ${s3Url}`);
  return s3Url;
}
// ---- end DIGEST BACKGROUND IMAGE ----

// Helper function to create a database connection (legacy - kept for compatibility)
function createDbConnection(dbName) {
  // This will now use the new client-specific connection method
  return createClientDbConnection(dbName);
}

// S3-specific URL encoding function (conservative approach)
function s3UrlEncode(str) {
  return str;
}

// Updated Login API endpoint - Supports both Client and User login
// Updated Login API endpoint - Supports both Client and User login
app.post('/api/login', async (req, res) => {
  const { username, password, clientId } = req.body;
  
  if (!username || !password || !clientId) {
    return res.status(400).json({ 
      success: false, 
      message: 'Username, password, and client ID are required' 
    });
  }
  
  let clientPool;
  
  try {
    console.log(`Attempting login for user: ${username} on client: ${clientId}`);
    
    // Connect to the client's database using clientId
    try {
      clientPool = await createClientDbConnection(clientId);
      
      // Get client configuration
      await getClientConfiguration(clientPool, clientId);
      
      // First, check if this is a client-level login (username === clientId)
      if (username === clientId) {
        // This might be a client login attempt
        const clientResult = await clientPool.query(
          'SELECT * FROM "Client" WHERE "clientID" = $1',
          [clientId]
        );
        
        if (clientResult.rows.length > 0) {
          const client = clientResult.rows[0];
          
          // Verify password for client
          const isValidPassword = await bcrypt.compare(password, client.clientSecret);
          
          if (isValidPassword) {
            // Generate token for client
            const token = jwt.sign(
              { 
                username: client.clientID,
                dbName: client.clientID,
                userType: 'client'
              },
              globalConfig.JWT_SECRET,
              { expiresIn: '24h' }
            );
            
            await clientPool.end();
            
            return res.json({ 
              success: true, 
              token,
              userType: 'client',
              message: 'Client login successful'
            });
          }
        }
      }
      
      // Not a client login, try user authentication
      // Query the Users table in the client's database
      const userResult = await clientPool.query(
        'SELECT * FROM "Users" WHERE "Username" = $1',
        [username]
      );
      
      if (userResult.rows.length > 0) {
        const user = userResult.rows[0];
        
        // Verify password for user
        const isValidPassword = await bcrypt.compare(password, user.Password);
        
        if (isValidPassword) {
          // Generate token for user with dataFilter
          const token = jwt.sign(
            { 
              //username: user.Username,
              username: clientId,
              dbName: clientId, // Use the clientId as the database name
              userType: 'user',
              userId: user.ID,
              dataFilter: user.DataFilter,
              permissions: user.Permissions
            },
            globalConfig.JWT_SECRET,
            { expiresIn: '24h' }
          );
          
          await clientPool.end();
          
          return res.json({ 
            success: true, 
            token,
            userType: 'user',
            message: 'User login successful'
          });
        }
      }
      
      // Neither client nor user found, or password was invalid
      await clientPool.end();
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid username or password' 
      });
      
    } catch (connectionError) {
      console.error(`Login attempt failed for ${username} on client ${clientId}:`, connectionError);
      if (clientPool) await clientPool.end();
      return res.status(401).json({ 
        success: false, 
        message: 'Invalid credentials or client ID'
      });
    }
    
  } catch (error) {
    console.error('Login error:', error);
    if (clientPool) await clientPool.end();
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
});

// Forgot Password endpoint - sends reset email
app.post('/api/forgot-password', async (req, res) => {
  const { email, clientId } = req.body;
  
  if (!email || !clientId) {
    return res.status(400).json({
      success: false,
      message: 'Email and client ID are required'
    });
  }
  
  let clientPool;
  
  try {
    // Connect to client database
    clientPool = await createClientDbConnection(clientId);
    
    // Get client configuration for email settings and password reset secret
    await getClientConfiguration(clientPool, clientId);
    
    // Check if user exists with this email
    const userResult = await clientPool.query(
      'SELECT * FROM "Users" WHERE "Email" = $1',
      [email]
    );
    
    if (userResult.rows.length === 0) {
      // Don't reveal if email doesn't exist (security best practice)
      await clientPool.end();
      return res.json({
        success: true,
        message: 'If that email exists, a password reset link has been sent'
      });
    }
    
    const user = userResult.rows[0];
    
    // Generate encrypted reset token
    const resetToken = encryptPasswordResetToken(email, globalConfig.PASSWORD_RESET_SECRET);
    
    // Build reset URL
    const resetUrl = `${globalConfig.STATIC_WEBSITE_URL}/reset-password.html?token=${resetToken}&client=${clientId}`;
    
    // Send email with reset link
    const emailBody = `
Hello ${user.FirstName},

You requested a password reset for your account. Click the link below to reset your password:

${resetUrl}

This link will expire in 30 minutes.

If you didn't request this reset, please ignore this email.

Best regards,
IndieTix Team
    `;
    
    await sendEmailWithMultipleAttachments(
      // Same sender as every other email; EMAIL_FROM is the older key some configs still have.
      globalConfig.SENDER_EMAIL || globalConfig.EMAIL_FROM || 'noreply@indietix.net',
      email,
      'Password Reset Request',
      emailBody,
      []
    );
    
    await clientPool.end();
    
    return res.json({
      success: true,
      message: 'If that email exists, a password reset link has been sent'
    });
    
  } catch (error) {
    console.error('Forgot password error:', error);
    if (clientPool) await clientPool.end();
    return res.status(500).json({
      success: false,
      message: 'Error processing password reset request'
    });
  }
});

// Reset Password endpoint - verifies token and updates password
app.post('/api/reset-password', async (req, res) => {
  const { token, email, password, repeatPassword, clientId } = req.body;
  
  if (!token || !email || !password || !repeatPassword || !clientId) {
    return res.status(400).json({
      success: false,
      message: 'All fields are required'
    });
  }
  
  if (password !== repeatPassword) {
    return res.status(400).json({
      success: false,
      message: 'Passwords do not match'
    });
  }
  
  let clientPool;
  
  try {
    // Connect to client database
    clientPool = await createClientDbConnection(clientId);
    
    // Get client configuration for password reset secret
    await getClientConfiguration(clientPool, clientId);
    
    // Decrypt token
    const decrypted = decryptPasswordResetToken(token, globalConfig.PASSWORD_RESET_SECRET);
    
    if (!decrypted) {
      await clientPool.end();
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset link'
      });
    }
    
    // Verify email matches and token is still valid (30 minutes)
    if (decrypted.email !== email) {
      await clientPool.end();
      return res.status(400).json({
        success: false,
        message: 'Email does not match reset request'
      });
    }
    
    if (!isPasswordResetTokenValid(decrypted.timestamp)) {
      await clientPool.end();
      return res.status(400).json({
        success: false,
        message: 'Reset link has expired'
      });
    }
    
    // Hash new password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Update password in database
    const updateResult = await clientPool.query(
      'UPDATE "Users" SET "Password" = $1, "UpdatedDate" = $2 WHERE "Email" = $3 RETURNING "ID"',
      [hashedPassword, new Date(), email]
    );
    
    if (updateResult.rows.length === 0) {
      await clientPool.end();
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    await clientPool.end();
    
    return res.json({
      success: true,
      message: 'Password reset successfully'
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    if (clientPool) await clientPool.end();
    return res.status(500).json({
      success: false,
      message: 'Error resetting password'
    });
  }
});

// User Management Endpoints (Client-only access)

// Middleware to check if user is a client (not a sub-user)
const requireClientAuth = (req, res, next) => {
  if (req.user.userType !== 'client') {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Client privileges required.'
    });
  }
  next();
};

// ---- DATA FILTER EVENT OPTIONS ----
// Event names for the data-filter pickers (User Management, API Keys): every
// ticketed Square catalog item (so a promoter's account can be set up before
// their show's first sale) plus every name already on a sold ticket (so past,
// archived shows stay pickable). Square being unreachable only drops the
// catalog half. Names match "QRCodeProduct"."ProductName", which
// getSquareOrders copies from the Square item name.
app.get('/api/data-filter/events', requireAuth, requireClientAuth, async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);
    const sold = await userPool.query(
      `SELECT DISTINCT "ProductName" FROM "QRCodeProduct" WHERE "ProductName" IS NOT NULL`
    );
    await userPool.end();
    userPool = null;

    const names = new Set(sold.rows.map(r => r.ProductName));
    if (globalConfig.SQUARE_ACCESS_TOKEN) {
      try {
        const targetCategories = globalConfig.TARGET_CATEGORIES
          ? globalConfig.TARGET_CATEGORIES.split(',').map(c => c.trim())
          : ['Cinema', 'Events'];
        const items = await searchMarketingCatalogItems(globalConfig.SQUARE_ACCESS_TOKEN, targetCategories);
        items.forEach(item => { if (item.name && item.name !== '(untitled)') names.add(item.name); });
      } catch (error) {
        console.error('Data filter events: Square catalog unavailable, using sold tickets only:', error.message);
      }
    }
    return res.json({ success: true, events: [...names].sort((x, y) => x.localeCompare(y)) });
  } catch (error) {
    console.error('Error loading data filter events:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error loading events' });
  }
});
// ---- END DATA FILTER EVENT OPTIONS ----

// Get all users for a client
app.get('/api/users', requireAuth, requireClientAuth, async (req, res) => {
  let userPool;
  
  try {
    userPool = await createDbConnection(req.user.dbName);
    
    const result = await userPool.query(
      'SELECT "ID", "Username", "Email", "FirstName", "LastName", "Permissions", "DataFilter", "CreatedDate", "UpdatedDate" FROM "Users" ORDER BY "ID"'
    );
    
    await userPool.end();
    
    return res.json({
      success: true,
      users: result.rows
    });
    
  } catch (error) {
    console.error('Error fetching users:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      message: 'Error fetching users'
    });
  }
});


// Create a new user
app.post('/api/users', requireAuth, requireClientAuth, async (req, res) => {
  const { username, password, email, firstName, lastName, permissions, dataFilter } = req.body;
  
  if (!username || !password || !email) {
    return res.status(400).json({
      success: false,
      message: 'Username, password, and email are required'
    });
  }
  
  let userPool;
  
  try {
    userPool = await createDbConnection(req.user.dbName);
    
    // Check if username already exists
    const existingUser = await userPool.query(
      'SELECT "ID" FROM "Users" WHERE "Username" = $1',
      [username]
    );
    
    if (existingUser.rows.length > 0) {
      await userPool.end();
      return res.status(400).json({
        success: false,
        message: 'Username already exists'
      });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insert new user
    const result = await userPool.query(
      `INSERT INTO "Users" ("Username", "Password", "Email", "FirstName", "LastName", "Permissions", "DataFilter", "CreatedDate", "UpdatedDate")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING "ID", "Username", "Email", "FirstName", "LastName", "Permissions", "DataFilter", "CreatedDate", "UpdatedDate"`,
      [username, hashedPassword, email, firstName, lastName, permissions || { view: true, edit: false, checkIn: false }, dataFilter || { datafilters: [] }, new Date(), new Date()]
    );
    
    await userPool.end();
    
    return res.json({
      success: true,
      user: result.rows[0],
      message: 'User created successfully'
    });
    
  } catch (error) {
    console.error('Error creating user:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      message: 'Error creating user'
    });
  }
});

// Update a user
app.put('/api/users/:userId', requireAuth, requireClientAuth, async (req, res) => {
  const { userId } = req.params;
  const { username, password, email, firstName, lastName, permissions, dataFilter } = req.body;
  
  if (!userId) {
    return res.status(400).json({
      success: false,
      message: 'User ID is required'
    });
  }
  
  let userPool;
  
  try {
    userPool = await createDbConnection(req.user.dbName);
    
    // Build update query dynamically based on provided fields
    const updates = [];
    const values = [];
    let paramIndex = 1;
    
    if (username) {
      updates.push(`"Username" = $${paramIndex++}`);
      values.push(username);
    }
    
    if (password) {
      const hashedPassword = await bcrypt.hash(password, 10);
      updates.push(`"Password" = $${paramIndex++}`);
      values.push(hashedPassword);
    }
    
    if (email) {
      updates.push(`"Email" = $${paramIndex++}`);
      values.push(email);
    }
    
    if (firstName !== undefined) {
      updates.push(`"FirstName" = $${paramIndex++}`);
      values.push(firstName);
    }
    
    if (lastName !== undefined) {
      updates.push(`"LastName" = $${paramIndex++}`);
      values.push(lastName);
    }
    
    if (permissions) {
      updates.push(`"Permissions" = $${paramIndex++}`);
      values.push(permissions);
    }
    
    if (dataFilter) {
      updates.push(`"DataFilter" = $${paramIndex++}`);
      values.push(dataFilter);
    }
    
    updates.push(`"UpdatedDate" = $${paramIndex++}`);
    values.push(new Date());
    
    values.push(userId);
    
    const result = await userPool.query(
      `UPDATE "Users" SET ${updates.join(', ')} WHERE "ID" = $${paramIndex} 
       RETURNING "ID", "Username", "Email", "FirstName", "LastName", "Permissions", "DataFilter", "CreatedDate", "UpdatedDate"`,
      values
    );
    
    await userPool.end();
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    return res.json({
      success: true,
      user: result.rows[0],
      message: 'User updated successfully'
    });
    
  } catch (error) {
    console.error('Error updating user:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      message: 'Error updating user'
    });
  }
});

// Delete a user
app.delete('/api/users/:userId', requireAuth, requireClientAuth, async (req, res) => {
  const { userId } = req.params;
  
  if (!userId) {
    return res.status(400).json({
      success: false,
      message: 'User ID is required'
    });
  }
  
  let userPool;
  
  try {
    userPool = await createDbConnection(req.user.dbName);
    
    const result = await userPool.query(
      'DELETE FROM "Users" WHERE "ID" = $1 RETURNING "ID"',
      [userId]
    );
    
    await userPool.end();
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    return res.json({
      success: true,
      message: 'User deleted successfully'
    });
    
  } catch (error) {
    console.error('Error deleting user:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      message: 'Error deleting user'
    });
  }
});

// Pre-signed URL generation endpoint
app.post('/api/presigned-download', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  try {
    const { qrCode } = req.body;
    
    if (!qrCode) {
      return res.status(400).json({ 
        success: false, 
        message: 'QR code is required' 
      });
    }

    console.log('Generating pre-signed URL for QR Code:', qrCode);
    console.log('Username from JWT:', req.user.username);

    // Verify the QR code exists in the user's database (optional security check)
    let userPool;
    try {
      userPool = await createDbConnection(req.user.dbName);
      const checkResult = await userPool.query(
        'SELECT "ID", "Status" FROM "QRCodeProduct" WHERE "QRCode" = $1',
        [qrCode]
      );
      
      if (checkResult.rows.length === 0 || !(await ticketPassesDataFilter(req, 'QRCode', qrCode))) {
        await userPool.end();
        return res.status(404).json({ 
          success: false, 
          message: 'QR code not found' 
        });
      }

      // Check if the ticket is refunded
      const qrCodeRecord = checkResult.rows[0];
      const status = qrCodeRecord.Status || 'valid';
      
      if (status === 'refunded') {
        await userPool.end();
        return res.status(403).json({ 
          success: false, 
          message: 'Cannot download refunded ticket' 
        });
      }

      await userPool.end();
    } catch (dbError) {
      console.error('Database verification error:', dbError);
      if (userPool) await userPool.end();
      return res.status(500).json({ 
        success: false, 
        message: 'Database verification failed' 
      });
    }

    // Construct the S3 object key
    const encodedQrCode = "QR-Ticket-"+s3UrlEncode(qrCode);
    const objectKey = `tickets-out/${encodedQrCode}.pdf`;
    const bucketName = globalConfig.S3_BUCKET_PREFIX+req.user.username.toLowerCase();

    console.log('S3 Bucket:', bucketName);
    console.log('S3 Object Key:', objectKey);

    // Generate pre-signed URL
    const params = {
      Bucket: bucketName,
      Key: objectKey,
      Expires: 300, // URL expires in 5 minutes (300 seconds)
      ResponseContentDisposition: `attachment; filename="ticket-${qrCode}.pdf"`
    };

    const signedUrl = await s3.getSignedUrlPromise('getObject', params);

    console.log('Pre-signed URL generated successfully');

    return res.json({
      success: true,
      downloadUrl: signedUrl,
      expiresIn: 300,
      message: 'Pre-signed URL generated successfully'
    });

  } catch (error) {
    console.error('Error generating pre-signed URL:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to generate download URL',
      error: error.message
    });
  }
});

// Get presigned URL for uploading files to S3
// ---- OMDB MOVIE LOOKUP ----
// Add Movie looks movies up through these routes instead of calling OMDB from
// the browser, so the venue's OMDB_API_KEY (Client Settings) never ships to
// the page. Same `edit` permission as creating the movie.
const OMDB_API_URL = 'https://www.omdbapi.com/';
const OMDB_POSTER_URL = 'https://img.omdbapi.com/';
const IMDB_ID_PATTERN = /^tt\d{5,10}$/;

// The current venue's OMDB poster URL for an IMDb id, or null when no key is set.
function omdbPosterUrl(imdbID) {
  if (!globalConfig.OMDB_API_KEY || !IMDB_ID_PATTERN.test(String(imdbID))) return null;
  return `${OMDB_POSTER_URL}?i=${encodeURIComponent(imdbID)}&h=600&apikey=${encodeURIComponent(globalConfig.OMDB_API_KEY)}`;
}

// Loads the venue's config and answers 400 when it has no OMDB key. Returns
// the key, or null after responding.
async function requireOmdbKey(req, res) {
  const pool = await createDbConnection(req.user.dbName);
  try {
    await getClientConfiguration(pool, req.user.dbName);
  } finally {
    await pool.end();
  }
  if (!globalConfig.OMDB_API_KEY) {
    res.status(400).json({ Response: 'False', Error: 'Movie lookup needs an OMDB API key: add OMDB_API_KEY in Client Settings' });
    return null;
  }
  return globalConfig.OMDB_API_KEY;
}

app.get('/api/omdb/search', requireAuth, requirePermission('edit'), async (req, res) => {
  try {
    const title = String(req.query.title || '').trim();
    const year = String(req.query.year || '').trim();
    if (!title) return res.status(400).json({ Response: 'False', Error: 'A title is required' });
    if (year && !/^\d{4}$/.test(year)) return res.status(400).json({ Response: 'False', Error: 'Year must be four digits' });
    const key = await requireOmdbKey(req, res);
    if (!key) return;
    const params = new URLSearchParams({ apikey: key, s: title, type: 'movie' });
    if (year) params.set('y', year);
    const response = await fetch(`${OMDB_API_URL}?${params}`);
    return res.status(response.ok ? 200 : 502).json(await response.json());
  } catch (error) {
    console.error('OMDB search failed:', error.message);
    return res.status(502).json({ Response: 'False', Error: 'Movie search is unavailable right now' });
  }
});

app.get('/api/omdb/movie/:imdbID', requireAuth, requirePermission('edit'), async (req, res) => {
  try {
    if (!IMDB_ID_PATTERN.test(req.params.imdbID)) return res.status(400).json({ Response: 'False', Error: 'Invalid IMDb id' });
    const key = await requireOmdbKey(req, res);
    if (!key) return;
    const params = new URLSearchParams({ apikey: key, i: req.params.imdbID, plot: 'full' });
    const response = await fetch(`${OMDB_API_URL}?${params}`);
    return res.status(response.ok ? 200 : 502).json(await response.json());
  } catch (error) {
    console.error('OMDB lookup failed:', error.message);
    return res.status(502).json({ Response: 'False', Error: 'Movie details are unavailable right now' });
  }
});

// The poster comes back as base64 JSON rather than raw bytes, so it works
// through the Lambda Function URL without binary-response setup.
app.get('/api/omdb/poster/:imdbID', requireAuth, requirePermission('edit'), async (req, res) => {
  try {
    if (!IMDB_ID_PATTERN.test(req.params.imdbID)) return res.status(400).json({ success: false, message: 'Invalid IMDb id' });
    const key = await requireOmdbKey(req, res);
    if (!key) return;
    const response = await fetch(omdbPosterUrl(req.params.imdbID));
    if (!response.ok) return res.status(404).json({ success: false, message: 'No poster for this movie' });
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.startsWith('image/')) return res.status(404).json({ success: false, message: 'No poster for this movie' });
    const data = Buffer.from(await response.arrayBuffer()).toString('base64');
    return res.json({ success: true, contentType, data });
  } catch (error) {
    console.error('OMDB poster fetch failed:', error.message);
    return res.status(502).json({ success: false, message: 'Poster is unavailable right now' });
  }
});
// ---- END OMDB MOVIE LOOKUP ----

// ---- INTEGRATION STATUS ----
// Add Movie / Add Event ask which integrations the venue has set up, so they
// can warn up front and disable the Google Calendar checkbox instead of
// "succeeding" at something that was never configured. Booleans only --
// never the values themselves. New clients start with "updateWithReal..."
// placeholders (clientSetup's default config), which count as not set.
function isIntegrationValueSet(value) {
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  const text = String(value ?? '').trim();
  return text !== '' && !text.startsWith('updateWithReal');
}

function isCalendarConfigured(calendarId) {
  return isIntegrationValueSet(globalConfig.GOOGLE_SERVICE_ACCOUNT_KEY) && isIntegrationValueSet(calendarId);
}

app.get('/api/integrations/status', requireAuth, requirePermission('edit'), async (req, res) => {
  try {
    const pool = await createDbConnection(req.user.dbName);
    try {
      await getClientConfiguration(pool, req.user.dbName);
    } finally {
      await pool.end();
    }
    return res.json({
      success: true,
      omdb: isIntegrationValueSet(globalConfig.OMDB_API_KEY),
      cinemaCalendar: isCalendarConfigured(globalConfig.CINEMA_CALENDAR_ID),
      eventCalendar: isCalendarConfigured(globalConfig.EVENT_CALENDAR_ID)
    });
  } catch (error) {
    console.error('Integration status check failed:', error.message);
    return res.status(500).json({ success: false, message: 'Could not check integration settings' });
  }
});
// ---- END INTEGRATION STATUS ----

app.post('/api/presigned-upload', requireAuth, requirePermission('edit'), async (req, res) => {
  try {
    const { fileName, contentType, folder } = req.body;
    
    if (!fileName) {
      return res.status(400).json({ 
        success: false, 
        error: 'File name is required' 
      });
    }
    
    // Validate content type is an image
    if (contentType && !contentType.startsWith('image/')) {
      return res.status(400).json({
        success: false,
        error: 'Only image files are allowed'
      });
    }
    
    // The caller doesn't get to pick where in the bucket this lands:
    // ticket PDFs live in the same bucket (tickets-out/), and a presigned
    // PUT into that prefix would let any editor overwrite a real ticket.
    // Every real caller sends 'movie-posters'.
    const UPLOAD_FOLDER = 'movie-posters';
    if (folder && folder !== UPLOAD_FOLDER) {
      return res.status(400).json({
        success: false,
        error: `Uploads are only allowed to ${UPLOAD_FOLDER}/`
      });
    }

    console.log(`Generating presigned upload URL for: ${fileName}`);
    
    // Create safe filename
    const safeFilename = fileName.replace(/[^a-z0-9.-]/gi, '_');
    const s3Key = `${UPLOAD_FOLDER}/${safeFilename}`;
    const bucketName = globalConfig.S3_BUCKET_PREFIX+req.user.username.toLowerCase();
    
    // Generate presigned URL for PUT operation
    const params = {
      Bucket: bucketName,
      Key: s3Key,
      Expires: 300, // URL expires in 5 minutes
      ContentType: contentType || 'image/jpeg'
    };
    
    const uploadUrl = await s3.getSignedUrlPromise('putObject', params);
    
    // Calculate final S3 URL
    const s3Url = `https://${bucketName}.s3.${globalConfig.AWS_REGION}.amazonaws.com/${s3Key}`;
    
    console.log('Presigned upload URL generated successfully');
    
    return res.json({
      success: true,
      uploadUrl: uploadUrl,
      fileUrl: s3Url,
      expiresIn: 300,
      message: 'Presigned URL generated successfully'
    });
    
  } catch (error) {
    console.error('Error generating presigned upload URL:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Failed to generate upload URL',
      details: error.message
    });
  }
});

// Login page route
app.get('/login', (req, res) => {
  // Redirect to the login page hosted on S3/CloudFront using client config.
  // globalConfig is only populated by some other request's own
  // getClientConfiguration() call -- on a cold start, or if this request
  // is the first to land on a warm container, it won't be set yet. Fail
  // explicitly rather than redirecting to no URL (or, as it used to
  // default, hardcoded to Liberty Hall's URL regardless of which client's
  // staff this actually is).
  if (!globalConfig.STATIC_WEBSITE_URL) {
    return res.status(503).send('Service temporarily unavailable, please try again.');
  }
  res.redirect(`${globalConfig.STATIC_WEBSITE_URL}/login.html`);
});

// Logout endpoint
app.get('/api/logout', (req, res) => {
  // With JWT, we don't need to do anything server-side for logout
  // The client will handle removing the token
  res.json({ success: true, message: 'Logged out successfully' });
});

// Create a simple API endpoint for health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


app.get('/api/orders', requireAuth, requirePermission(...PERMS_ORDERS), async (req, res) => {
  let userPool;
  try {
    const { search, startDate, endDate } = req.query;
    console.log('GET /api/orders — search:', search, 'dates:', { startDate, endDate });

    userPool = await createDbConnection(req.user.dbName);

    // --- parameterised clause builders ---
    let queryParams = [];
    let searchClause = '';
    let dateClause = '';

    // Search: same 5 fields, single param reused across OR branches
    if (search) {
      const idx = queryParams.length + 1;
      searchClause = ` AND (
        o."OrderID"      ILIKE $${idx} OR
        o."FirstName"    ILIKE $${idx} OR
        o."LastName"     ILIKE $${idx} OR
        o."EmailAddress" ILIKE $${idx} OR
        o."PhoneNumber"  ILIKE $${idx}
      )`;
      queryParams.push(`%${search}%`);
    }

    // Date range: up to two params depending on which bounds are present
    if (startDate && endDate) {
      const start = new Date(startDate);
      const end   = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateClause = ` AND o."CreatedDate" BETWEEN $${queryParams.length + 1} AND $${queryParams.length + 2}`;
      queryParams.push(start, end);
    } else if (startDate) {
      dateClause = ` AND o."CreatedDate" >= $${queryParams.length + 1}`;
      queryParams.push(new Date(startDate));
    } else if (endDate) {
      const end = new Date(endDate);
      end.setHours(23, 59, 59, 999);
      dateClause = ` AND o."CreatedDate" <= $${queryParams.length + 1}`;
      queryParams.push(end);
    }

    // --- data-filter JOIN + WHERE (sub-users only, conditional) ---
    let joinClause        = '';
    let dataFilterClause  = '';

    if (req.dataFilter && req.dataFilter.datafilters && req.dataFilter.datafilters.length > 0) {
      // JOIN is only needed when filtering by product attributes
      joinClause = `
        INNER JOIN "QRCodeProductToOrder" pto        ON o."ID" = pto."OrderID"
        INNER JOIN "QRCodeProduct"                   ON pto."QRCodeProductID" = "QRCodeProduct"."ID"
      `;

      // buildDataFilterWhereClause needs to know where to start numbering its own $N params
      const { whereClause: dfClause, params: filterParams } = buildDataFilterWhereClause(
        req.dataFilter,
        queryParams.length + 1
      );
      dataFilterClause = dfClause;
      queryParams.push(...filterParams);
    }

    // Hard cap on rows returned. Without a date filter this query can span a
    // venue's entire order history; each row carries a full OrderMetaData JSON
    // blob, and an unbounded result set has blown past Lambda's 6MB synchronous
    // response payload limit (crashes with 413 RequestEntityTooLarge before the
    // client ever sees a normal HTTP error).
    const ORDERS_QUERY_LIMIT = 500;
    const limitIdx = queryParams.length + 1;
    queryParams.push(ORDERS_QUERY_LIMIT + 1); // fetch one extra to detect truncation

    // --- single query, all clauses slotted in ---
    const query = `
      SELECT DISTINCT o.*
      FROM "Order" o
      ${joinClause}
      WHERE 1=1
      ${searchClause}
      ${dateClause}
      ${dataFilterClause}
      ORDER BY o."ID" DESC
      LIMIT $${limitIdx}
    `;

    console.log('GET /api/orders — query:', query, 'params:', queryParams);

    const result = await userPool.query(query, queryParams);
    await userPool.end();

    const truncated = result.rows.length > ORDERS_QUERY_LIMIT;
    const rows = truncated ? result.rows.slice(0, ORDERS_QUERY_LIMIT) : result.rows;

    return res.json({ orders: rows, truncated, limit: ORDERS_QUERY_LIMIT });

  } catch (error) {
    console.error('Error fetching orders:', error);
    if (userPool) await userPool.end();
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// API route to get all QRCode products with optional search and date filtering
app.get('/api/products', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  try {
    const { search, startDate, endDate } = req.query;
    console.log('Search query:', search);
    console.log('Date range:', { startDate, endDate });
    
    // Add debug logging here
    console.log('About to get database credentials for:', req.user.dbName);
    const dbCredentials = await getDatabaseCredentials(req.user.dbName);
    console.log('Retrieved credentials:', { 
      host: dbCredentials.host, 
      port: dbCredentials.port,
      database: req.user.dbName 
    });
    
    console.log('About to initialize model for client');
    const { QRCodeProduct } = await initializeModelForClient(req.user.dbName, dbCredentials);
    console.log('Model initialized successfully');
    
    let whereClause = {};
    let andConditions = [];
    
    // Add search conditions if search term provided
    if (search) {
      andConditions.push({
        [Sequelize.Op.or]: [
          { ProductDetails: { [Sequelize.Op.iLike]: `%${search}%` } },
          { ProductName: { [Sequelize.Op.iLike]: `%${search}%` } },
          { EmailAddress: { [Sequelize.Op.iLike]: `%${search}%` } },
          { PhoneNumber: { [Sequelize.Op.iLike]: `%${search}%` } },
          { FirstName: { [Sequelize.Op.iLike]: `%${search}%` } },
          { LastName: { [Sequelize.Op.iLike]: `%${search}%` } }
        ]
      });
    }
    
    // Add date range filtering if provided
    if (startDate || endDate) {
      let dateCondition = {};
      
      if (startDate && endDate) {
        // Both start and end date provided
        const start = new Date(startDate);
        const end = new Date(endDate);
        // Set end date to end of day
        end.setHours(23, 59, 59, 999);
        
        dateCondition = {
          ProductDate: { [Sequelize.Op.between]: [start, end] }
        };
      } else if (startDate) {
        // Only start date provided
        const start = new Date(startDate);
        dateCondition = {
          ProductDate: { [Sequelize.Op.gte]: start }
        };
      } else if (endDate) {
        // Only end date provided
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        dateCondition = {
          ProductDate: { [Sequelize.Op.lte]: end }
        };
      }
      
      andConditions.push(dateCondition);
    }
    
    // Build final where clause
    if (andConditions.length > 0) {
      if (andConditions.length === 1) {
        whereClause = andConditions[0];
      } else {
        whereClause = {
          [Sequelize.Op.and]: andConditions
        };
      }
    }
    
    // Apply user data filters if they exist (for sub-users)
    if (req.dataFilter && req.dataFilter.datafilters && req.dataFilter.datafilters.length > 0) {
      console.log('Applying user data filters:', JSON.stringify(req.dataFilter, null, 2));
      
      const orConditions = [];
      
      for (const filter of req.dataFilter.datafilters) {
        const filterConditions = {};
        
        // Date filter - use Sequelize's date comparison with CAST to DATE
        if (filter.date) {
          // Use sequelize.where with sequelize.fn to cast to DATE
          filterConditions[Sequelize.Op.and] = [
            Sequelize.where(
              Sequelize.fn('DATE', Sequelize.col('ProductDate')),
              filter.date
            )
          ];
        }
        
        // Event name filter - case-insensitive
        if (filter.event || filter.eventContains) {
          const nameConditions = [];
          if (filter.event) nameConditions.push({ [Sequelize.Op.iLike]: eventExactPattern(filter.event) });
          if (filter.eventContains) nameConditions.push({ [Sequelize.Op.iLike]: eventContainsPattern(filter.eventContains) });
          filterConditions.ProductName = { [Sequelize.Op.and]: nameConditions };
        }
        
        // Event type filter - case-insensitive
        if (filter.eventType) {
          filterConditions.ProductType = { [Sequelize.Op.iLike]: normalizeEventType(filter.eventType) };
        }
        
        if (Object.keys(filterConditions).length > 0) {
          orConditions.push(filterConditions);
        }
      }
      
      // Combine user filters with existing conditions
      if (orConditions.length > 0) {
        console.log('User filter OR conditions:', JSON.stringify(orConditions, null, 2));
        
        if (Object.keys(whereClause).length > 0) {
          whereClause = {
            [Sequelize.Op.and]: [
              whereClause,
              { [Sequelize.Op.or]: orConditions }
            ]
          };
        } else {
          whereClause = { [Sequelize.Op.or]: orConditions };
        }
      }
    }
    
    console.log('Final where clause:', JSON.stringify(whereClause, null, 2));
    
    const products = await QRCodeProduct.findAll({
      where: whereClause,
      order: [['id', 'DESC']]
    });
    
    console.log(`Found ${products.length} products`);
    
    res.json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

/* =============================================================================
 *  DASHBOARD ENDPOINT  —  paste this block into app.mjs
 * =============================================================================
 *  Adds:  GET /api/dashboard/today
 *
 *  Returns every movie / event showing TODAY (venue-local time) together with
 *  tickets-sold and checked-in counts pulled from the "QRCodeProduct" table,
 *  scoped to the requesting user's data filter.
 *
 *  Optional ?date=YYYY-MM-DD (added for the dashboard's calendar picker)
 *  views any other day instead -- defaults to today when omitted/invalid.
 *
 *  WHERE TO PASTE:
 *  Drop this whole block in right after the existing
 *  `app.get('/api/square/showtimes-for-date', ...)` handler. It only uses
 *  things already defined at module scope in app.mjs:
 *
 *      app, requireAuth, createClientDbConnection, getClientConfiguration,
 *      getDatabaseCredentials, initializeModelForClient, Sequelize,
 *      globalConfig, SQUARE_CATALOG_SEARCH_API_URL,
 *      parseShowtimeString(), extractRuntime()
 *
 *  parseShowtimeString / extractRuntime are function declarations, so they are
 *  hoisted and callable from here regardless of paste position.
 *
 *  ----------------------------------------------------------------------------
 *  SCHEMA NOTES (confirmed against \d "QRCodeProduct")
 *
 *   - "ProductMetadata"  jsonb       <-- NOTE the lowercase 'd'. The Sequelize
 *                                       model attribute is row.ProductMetadata.
 *   - "CheckedIn"        boolean NOT NULL DEFAULT false
 *   - "ProductDate"      timestamp without time zone NOT NULL
 *   - "Status"           varchar(100)   values seen: 'valid', 'refunded'
 *   - "ProductName"      varchar(420) NOT NULL
 *   - "ProductType"      varchar(200) NOT NULL  (e.g. 'Movie', 'Live')
 *
 *  Refunded / cancelled tickets are excluded from BOTH sold and checked-in
 *  counts via:  Status NOT IN ('refunded','cancelled','canceled')
 *  (NULL Status is treated as countable — COALESCE to '' so it passes.)
 *
 *  ----------------------------------------------------------------------------
 *  ACCESS & FILTERING
 *
 *  Guarded by requireAuth only (no requireClientAuth) so clients AND sub-users
 *  of every permission level can open the dashboard.
 *
 *  Data scoping works exactly like /api/products: if the request carries
 *  `req.dataFilter.datafilters`, those filters are applied to the QRCodeProduct
 *  query (OR of {date, event, eventType} conditions, same code as /api/products).
 *  Filtering is done in ONE place — the ticket query. The Square catalog scan
 *  is intentionally NOT filtered; a showtime is only surfaced if the filtered
 *  ticket set produced at least one matching ticket for it.
 *
 *  KNOWN TRADEOFF: a show in a filtered sub-user's scope but with zero sales so
 *  far will not appear for them (no tickets => nothing to match). Clients and
 *  unfiltered sub-users still see every show. Mirrors /api/products row scoping.
 *
 *  ----------------------------------------------------------------------------
 *  HOW TICKETS LINK TO SHOWTIMES
 *
 *  Each QRCodeProduct row's "ProductMetadata" jsonb has a `modifiers` array;
 *  each modifier is a Square SHOWTIME, e.g.:
 *      "modifiers": [{
 *         "name": "Sun 05-17-2026 2:30 PM (Little Theater)",
 *         "catalog_object_id": "YNFPNRIMLYSHMGTOG4SV2TXB"
 *      }]
 *  That `catalog_object_id` is the Square MODIFIER id — an exact match for the
 *  modifier's `id` in the catalog — so ticket links to showing by modifier id,
 *  with no date math. (The TOP-LEVEL ProductMetadata `catalog_object_id` is the
 *  price-variation id, e.g. "Adult", and is NOT used.) A normalized movie-title
 *  match is kept only as a safety net for tickets lacking a modifiers array.
 *
 *  ----------------------------------------------------------------------------
 *  ONE THING TO VERIFY: depends on parseShowtimeString() returning numeric
 *  `year, month, day, hour, minute` plus `location` (optionally `descriptors`).
 *  If your parseShowtimeString returns a different shape, adjust the field
 *  reads in getShowtimesForDate() — otherwise date-matching fails silently and
 *  the dashboard will look empty.
 *
 *  Venue timezone comes from globalConfig.VENUE_TIMEZONE; falls back to
 *  America/Chicago (Lawrence, KS).
 * ========================================================================== */

const VENUE_TZ_FALLBACK = 'America/Chicago';

// Ticket statuses that must NOT count toward sold / checked-in totals.
const EXCLUDED_TICKET_STATUSES = ['refunded', 'cancelled', 'canceled', 'transferred'];

/**
 * Scan the Square catalog and return every showtime on `dateStr` (YYYY-MM-DD).
 * Each showtime carries `modifierId` — the Square modifier's catalog object id,
 * which is what a ticket's ProductMetadata.modifiers[].catalog_object_id holds.
 */
async function getShowtimesForDate(accessToken, dateStr) {
  const searchResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ object_types: ['ITEM'], include_related_objects: true })
  });

  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    throw new Error(`Square catalog search failed: ${searchResponse.status} ${errorText}`);
  }

  const searchData = await searchResponse.json();
  if (!searchData.objects || searchData.objects.length === 0) return [];

  // Index related modifier lists by id.
  const modifierListMap = {};
  (searchData.related_objects || [])
    .filter(o => o.type === 'MODIFIER_LIST')
    .forEach(m => { modifierListMap[m.id] = m; });

  const showtimes = [];

  for (const item of searchData.objects) {
    if (item.type !== 'ITEM') continue;

    const title   = item.item_data?.name || 'Untitled';
    const runtime = extractRuntime(item.item_data?.description || '');

    for (const modListInfo of (item.item_data?.modifier_list_info || [])) {
      const modifierList = modifierListMap[modListInfo.modifier_list_id];
      if (!modifierList) continue;

      for (const modifier of (modifierList.modifier_list_data?.modifiers || [])) {
        const showtimeName = modifier.modifier_data?.name;
        if (!showtimeName) continue;

        const parsed = parseShowtimeString(showtimeName);
        if (!parsed) continue;

        // Compare on the parsed wall-clock date directly — no Date()/UTC
        // conversion — so this is timezone-safe wherever the Lambda runs.
        const ymd = `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
        if (ymd !== dateStr) continue;

        // 12-hour display string built straight from the parsed components.
        const h12  = (parsed.hour % 12) || 12;
        const ampm = parsed.hour < 12 ? 'AM' : 'PM';
        const displayTime = `${h12}:${String(parsed.minute).padStart(2, '0')} ${ampm}`;

        showtimes.push({
          itemId:      item.id,
          modifierId:  modifier.id,            // <-- the per-showtime link key
          title,
          location:    parsed.location,
          descriptors: parsed.descriptors || [],
          runtime,
          hour:        parsed.hour,
          minute:      parsed.minute,
          displayTime,
          // Ordering key only — minutes since midnight. Never sent as an instant.
          sortKey:     parsed.hour * 60 + parsed.minute,
          rawModifier: showtimeName
        });
      }
    }
  }

  showtimes.sort((a, b) => a.sortKey - b.sortKey);
  return showtimes;
}

/**
 * Pull the modifiers array out of a ProductMetadata value, tolerating either a
 * parsed object (jsonb column, the normal case) or a JSON string (defensive).
 */
function extractTicketModifiers(productMetadata) {
  if (!productMetadata) return [];
  let meta = productMetadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { return []; }
  }
  return Array.isArray(meta.modifiers) ? meta.modifiers : [];
}




app.get('/api/product_by_qrcode', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  let userPool;
  try {
    const { search } = req.query;
    
    if (!search) {
      return res.json([]);
    }
    
    // Get client-specific models
    const dbCredentials = await getDatabaseCredentials(req.user.dbName);
    const { QRCodeProduct } = await initializeModelForClient(req.user.dbName, dbCredentials);
    
    // First try to find in regular products
    const products = await QRCodeProduct.findAll({
      where: {
        qrCode: search
      },
      order: [['id', 'DESC']]
    });
    
    // If found in regular products, return them -- unless a sub-user's
    // data filter hides this ticket, in which case answer exactly like an
    // unknown code (an empty list) rather than revealing it exists.
    if (products.length > 0) {
      if (!(await ticketPassesDataFilter(req, 'QRCode', search))) {
        return res.json([]);
      }
      return res.json(products);
    }
    
    // Not found in regular products, check skeleton keys
    userPool = await createDbConnection(req.user.dbName);
    
    const skeletonKeyResult = await userPool.query(
      'SELECT * FROM "SkeletonKey" WHERE "qrCode" = $1',
      [search]
    );
    
    await userPool.end();
    
    // If found as skeleton key, return in a format compatible with the UI
    if (skeletonKeyResult.rows.length > 0) {
      const key = skeletonKeyResult.rows[0];
      
      // Return skeleton key data formatted like a product
      return res.json([{
        id: key.id,
        qrCode: key.qrCode,
        productName: `🔑 Skeleton Key: ${key.description}`,
        itemVariationName: key.keyType,
        expirationDate: key.expiresAt, // null unless an expiration date was set
        checkedIn: false, // Always show as not checked in (they can be used multiple times)
        isSkeletonKey: true,
        skeletonKeyData: {
          keyType: key.keyType,
          description: key.description,
          eventName: key.eventName,
          isActive: key.isActive,
          maxUsesPerDay: key.maxUsesPerDay,
          maxTotalUses: key.maxTotalUses,
          expiresAt: key.expiresAt,
          totalUses: key.totalUses,
          lastUsedAt: key.lastUsedAt
        }
      }]);
    }
    
    // Not found anywhere
    return res.json([]);
    
  } catch (error) {
    console.error('Error fetching products:', error);
    if (userPool) await userPool.end();
    res.status(500).json({ error: 'Internal server error' });
  }
});


// QR code check-in (authenticated)
app.post('/api/checkin', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  const { qrCode, eventName, notes } = req.body;
  console.log('QR Code:', qrCode);
  if (!qrCode) {
    return res.status(400).json({ 
      returnStatus: 'failed_invalid_request', 
      message: 'QR code is required' 
    });
  }
  
  let userPool;
  try {
    // Create a connection to the user-specific database using JWT info
    userPool = await createDbConnection(req.user.dbName);
    
    // Check if QR code exists and its status
    const checkResult = await userPool.query(
      'SELECT "ID", "CheckedIn", "ExpirationDate", "ProductVenue", "ProductName", "Status" FROM "QRCodeProduct" WHERE "QRCode" = $1',
      [qrCode]
    );
    
    // A ticket hidden by the sub-user's data filter answers exactly like an
    // unknown code -- same response the scanner lookup gives for it.
    if (checkResult.rows.length > 0 && !(await ticketPassesDataFilter(req, 'QRCode', qrCode))) {
      await userPool.end();
      return res.json({ returnStatus: 'failed_no_QRCode' });
    }

    // If found in regular tickets, process as normal ticket
    if (checkResult.rows.length > 0) {
      const qrCodeRecord = checkResult.rows[0];

      // Only a 'valid' ticket (or a legacy NULL status) may be checked in.
      // Refunded, cancelled, deleted and transferred tickets used to scan in
      // as if nothing had happened -- this route never looked at Status.
      const ticketStatus = qrCodeRecord.Status || 'valid';
      if (ticketStatus !== 'valid') {
        await userPool.end();
        return res.json({
          returnStatus: 'failed_ticket_not_valid',
          ticketStatus,
          productName: qrCodeRecord.ProductName
        });
      }
      
      // Check if already checked in
      if (qrCodeRecord.CheckedIn) {
        await userPool.end();
        return res.json({ returnStatus: 'failed_already_checked_in' });
      }
      
      // Check if expired
      const currentDate = new Date();
      const expirationDate = new Date(qrCodeRecord.ExpirationDate);
      
      if (currentDate > expirationDate) {
        await userPool.end();
        return res.json({ 
          returnStatus: 'failed_expired_qrcode', 
          expirationDate: expirationDate.toISOString() 
        });
      }
      
      // Update the QR code to checked in
      await userPool.query(
       'UPDATE "QRCodeProduct" SET "CheckedIn" = true, "LastEditedDate" = $1 WHERE "ID" = $2',
       [currentDate.toISOString(), qrCodeRecord.ID]
      );

      await userPool.end();
      return res.json({ 
        returnStatus: 'successful_checkin',
        location: qrCodeRecord.ProductVenue,
        productName: qrCodeRecord.ProductName
      });

    }
    
    // QR code not found in regular tickets, check skeleton keys
    const skeletonKeyResult = await userPool.query(
      'SELECT * FROM "SkeletonKey" WHERE "qrCode" = $1 AND "isActive" = true',
      [qrCode]
    );
    
    if (skeletonKeyResult.rows.length === 0) {
      await userPool.end();
      return res.json({ returnStatus: 'failed_no_QRCode' });
    }
    
    const key = skeletonKeyResult.rows[0];

    // Check expiration first -- cheapest check, no query needed. expiresAt
    // is a calendar date (not a timestamp), so the key is still good
    // through the end of that day -- only expired once the current date
    // is strictly after it.
    if (key.expiresAt) {
      const today = new Date().toISOString().slice(0, 10);
      const expiresAtDate = new Date(key.expiresAt).toISOString().slice(0, 10);
      if (today > expiresAtDate) {
        await userPool.end();
        return res.json({
          returnStatus: 'failed_skeleton_key_expired',
          message: `Skeleton key expired on ${expiresAtDate}`,
          isSkeletonKey: true
        });
      }
    }

    // Check lifetime use cap -- also no extra query, totalUses is already
    // on the row we just fetched.
    if (key.maxTotalUses && key.totalUses >= key.maxTotalUses) {
      await userPool.end();
      return res.json({
        returnStatus: 'failed_skeleton_key_total_limit',
        message: `Skeleton key lifetime use limit reached (${key.maxTotalUses} total uses)`,
        isSkeletonKey: true
      });
    }

    // Check daily rate limits if set
    if (key.maxUsesPerDay) {
      const todayUsesResult = await userPool.query(`
        SELECT COUNT(*) FROM "SkeletonKeyUsage"
        WHERE "skeletonKeyId" = $1 
        AND "usedAt" > CURRENT_DATE
      `, [key.id]);
      
      const todayUses = parseInt(todayUsesResult.rows[0].count);
      
      if (todayUses >= key.maxUsesPerDay) {
        await userPool.end();
        return res.json({ 
          returnStatus: 'failed_skeleton_key_limit',
          message: `Skeleton key daily limit reached (${key.maxUsesPerDay} per day)`,
          isSkeletonKey: true
        });
      }
    }
    
    // Check recent use (rate limiting - 5 uses in 10 minutes)
    const recentUsesResult = await userPool.query(`
      SELECT COUNT(*) FROM "SkeletonKeyUsage"
      WHERE "skeletonKeyId" = $1 
      AND "usedAt" > NOW() - INTERVAL '10 minutes'
    `, [key.id]);
    
    const recentUses = parseInt(recentUsesResult.rows[0].count);
    
    if (recentUses >= 5) {
      await userPool.end();
      return res.json({ 
        returnStatus: 'failed_skeleton_key_rate_limit',
        message: 'Skeleton key used too frequently - possible security issue',
        isSkeletonKey: true
      });
    }
    
    // Log the usage
    await userPool.query(`
      INSERT INTO "SkeletonKeyUsage" 
      ("skeletonKeyId", "eventName", "notes", "ipAddress")
      VALUES ($1, $2, $3, $4)
    `, [key.id, eventName || key.eventName || null, notes || null, req.ip]);
    
    // Update last used and total uses
    await userPool.query(`
      UPDATE "SkeletonKey" 
      SET "lastUsedAt" = NOW(), "totalUses" = "totalUses" + 1
      WHERE "id" = $1
    `, [key.id]);
    
    await userPool.end();
    
    return res.json({ 
      returnStatus: 'successful_skeleton_key_checkin',
      message: `Skeleton key accepted: ${key.description}`,
      isSkeletonKey: true,
      keyType: key.keyType,
      description: key.description,
      eventName: key.eventName
    });
    
  } catch (error) {
    console.error('Database error:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ 
      returnStatus: 'failed_server_error',
      message: 'An error occurred while processing your request',
      error: error.message
    });
  }
});

// GET skeleton keys (authenticated)
app.get('/api/skeleton-keys', requireAuth, requireClientAuth, async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    
    const result = await userPool.query(
      'SELECT * FROM "SkeletonKey" ORDER BY "createdAt" DESC'
    );
    
    await userPool.end();
    
    return res.json({
      success: true,
      skeletonKeys: result.rows
    });
  } catch (error) {
    console.error('Error fetching skeleton keys:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Failed to fetch skeleton keys',
      error: error.message
    });
  }
});

// POST create skeleton key (authenticated)
app.post('/api/skeleton-keys', requireAuth, requireClientAuth, async (req, res) => {
  let userPool;
  try {
    const { qrCode, keyType, description, eventName, maxUsesPerDay, maxTotalUses, expiresAt, isActive } = req.body;
    
    // Validation
    if (!qrCode || !keyType || !description) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_validation',
        message: 'QR code, key type, and description are required'
      });
    }
    
    userPool = await createDbConnection(req.user.dbName);
    
    // Check for duplicates
    const checkResult = await userPool.query(
      'SELECT "id" FROM "SkeletonKey" WHERE "qrCode" = $1',
      [qrCode]
    );
    
    if (checkResult.rows.length > 0) {
      await userPool.end();
      return res.status(409).json({
        success: false,
        returnStatus: 'failed_duplicate',
        message: 'A skeleton key with this QR code already exists'
      });
    }
    
    // Create skeleton key
    const insertResult = await userPool.query(`
      INSERT INTO "SkeletonKey"
      ("qrCode", "keyType", "description", "eventName", "maxUsesPerDay", "maxTotalUses", "expiresAt", "isActive")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `, [qrCode, keyType, description, eventName || null, maxUsesPerDay || null, maxTotalUses || null, expiresAt || null, isActive !== false]);
    
    await userPool.end();
    
    console.log(`Created skeleton key: ${qrCode} (${keyType})`);
    
    return res.json({
      success: true,
      skeletonKey: insertResult.rows[0]
    });
  } catch (error) {
    console.error('Error creating skeleton key:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Failed to create skeleton key',
      error: error.message
    });
  }
});

// PATCH update skeleton key (authenticated)
app.patch('/api/skeleton-keys/:qrCode', requireAuth, requireClientAuth, async (req, res) => {
  let userPool;
  try {
    const { qrCode } = req.params;
    const { isActive } = req.body;
    
    if (isActive === undefined) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_validation',
        message: 'isActive field is required'
      });
    }
    
    userPool = await createDbConnection(req.user.dbName);
    
    const result = await userPool.query(`
      UPDATE "SkeletonKey"
      SET "isActive" = $1
      WHERE "qrCode" = $2
      RETURNING *
    `, [isActive, qrCode]);
    
    await userPool.end();
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        returnStatus: 'failed_not_found',
        message: 'Skeleton key not found'
      });
    }
    
    console.log(`Updated skeleton key ${qrCode}: isActive=${isActive}`);
    
    return res.json({
      success: true,
      skeletonKey: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating skeleton key:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Failed to update skeleton key',
      error: error.message
    });
  }
});

// requireClientAuth matters here: this returns the entire configuration
// blob verbatim, including live secrets (SQUARE_ACCESS_TOKEN, JWT_SECRET).
// Found via testing that requireAuth alone let any sub-user token read
// it -- use /api/client/branding for anything a non-client staff view needs.
app.get('/api/client', requireAuth, requireClientAuth, async (req, res) => {
  try {
    // Get client-specific models
    const dbCredentials = await getDatabaseCredentials(req.user.dbName);
    const { Client } = await initializeClientModel(req.user.dbName, dbCredentials);
    
    const client = await Client.findOne({
      where: {
        clientID: req.user.username
      }
    });
    
    if (!client) {
      return res.status(404).json({ 
        success: false,
        returnStatus: 'failed_no_client',
        message: 'Client not found' 
      });
    }
    
    // Remove sensitive data for response
    const clientData = {
      id: client.id,
      clientID: client.clientID,
      contactName: client.contactName,
      clientEmail: client.clientEmail,
      createdDate: client.createdDate,
      updatedDate: client.updatedDate,
      hasBeenSetup: client.hasBeenSetup,
      status: client.status,
      // Only what Client Settings can edit (see CLIENT SETTINGS ALLOWLIST) --
      // internals like JWT_SECRET never need to reach the browser.
      configuration: Object.fromEntries(
        Object.entries(client.configuration || {}).filter(([key]) => allowedClientSettingKeys(client.configuration || {}).has(key))
      )
    };
    
    res.json({
      success: true,
      client: clientData
    });
  } catch (error) {
    console.error('Error fetching client:', error);
    res.status(500).json({ 
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Internal server error', 
      error: error.message 
    });
  }
});

// UPDATE client information (authenticated). requireClientAuth matters here
// too -- this can overwrite configuration (including secrets) and set a
// brand new clientSecret (the venue's own login password); requireAuth
// alone let any sub-user token do both.
// ---- CLIENT SETTINGS ALLOWLIST ----
// The configuration keys PUT /api/client (Client Settings) may write. Kept in
// step with clientSetup-Teardown's USER_DEFINABLE default (test/clientSettings
// checks the two match). A venue's own stored USER_DEFINABLE list is honored
// too, but isn't relied on alone: it's copied at onboarding, so older venues'
// lists are missing keys added since (OMDB_API_KEY, SENDER_EMAIL, ...).
// Everything else -- JWT_SECRET, ENV_TYPE, S3_BUCKET_PREFIX, SENDER_EMAIL's
// older EMAIL_FROM, USER_DEFINABLE itself -- can't be changed from the page.
const CLIENT_SETTINGS_KEYS = [
  'SQUARE_ACCESS_TOKEN', 'SQUARE_SIGNATURE_KEY', 'SQUARE_WEBHOOK_URL', 'SQUARE_LOCATION_ID',
  'STATIC_WEBSITE_URL', 'DISTRIBUTOR_NAME', 'EVENT_TYPE', 'EVENT_LOCATIONS', 'EVENT_DESCRIPTORS',
  'USERS_NAMES', 'GOOGLE_SERVICE_ACCOUNT_KEY', 'CINEMA_CALENDAR_ID', 'EVENT_CALENDAR_ID',
  'ANTHROPIC_API_KEY', 'OMDB_API_KEY', 'FTP1_HOST', 'FTP1_PASSWORD', 'FTP1_PORT',
  'FTP1_REMOTE_PATH', 'FTP1_TYPE', 'FTP1_USER', 'FTP2_HOST', 'FTP2_PASSWORD', 'FTP2_PORT',
  'FTP2_REMOTE_PATH', 'FTP2_TYPE', 'FTP2_USER', 'FTP3_HOST', 'FTP3_PASSWORD', 'FTP3_PORT',
  'FTP3_REMOTE_PATH', 'FTP3_TYPE', 'FTP3_USER', 'USE_FTP', 'THEATER_ID', 'THEATER_NAME',
  'WEB_HEADER_COMPANY', 'LOGO_FILE', 'EBOR_THEATRE_NO', 'FILM_CODE_PREFIX', 'MODIFIER_NAME_FILTER',
  'TARGET_CATEGORIES', 'SEND_SMS', 'PASSWORD_RESET_SECRET', 'ECOMMERCE_SITE_URL',
  'SMS_CAMPAIGN_ID', 'SMS_ORIGINATION_NUMBER', 'SMS_SENDER_BRAND', 'SMS_OPT_OUT_LIST_NAME',
  'SMS_SPEND_LIMIT_PER_5MIN', 'SMS_LOG_RETENTION_DAYS', 'BAD_SHOWTIME_SNS_TOPIC_ARN',
  'INDIETIX_PRIVACY_URL', 'INDIETIX_TERMS_URL', 'MARKETING_ENGINE_ENABLED', 'DIGEST_ENABLED',
  'DIGEST_DAY_OF_WEEK', 'DIGEST_TIME', 'DIGEST_CHANNELS', 'DIGEST_BACKGROUND_IMAGE_URL',
  'DIGEST_TEXT_BOUNDS', 'DIGEST_DATE_FONT_SIZE', 'DIGEST_DATE_BOLD', 'DIGEST_EVENT_FONT_SIZE',
  'DIGEST_EVENT_BOLD', 'DIGEST_TIME_FONT_SIZE', 'DIGEST_TIME_BOLD', 'DIGEST_HEADER_TEXT',
  'DIGEST_HEADER_FONT_SIZE', 'DIGEST_HEADER_BOLD', 'DIGEST_HEADER_IN_IMAGE',
  'DIGEST_HEADER_IN_CAPTION', 'DIGEST_FOOTER_TEXT', 'DIGEST_FOOTER_FONT_SIZE',
  'DIGEST_FOOTER_BOLD', 'DIGEST_FOOTER_IN_IMAGE', 'DIGEST_FOOTER_IN_CAPTION',
  'MARKETING_SES_CONFIGURATION_SET', 'SHARE_NUDGE_ENABLED', 'TICKET_ORIENTATION',
  'TICKET_FILENAME', 'SENDER_EMAIL', 'OWNER_BCC_EMAIL', 'ONE_PER_EMAIL_ITEMS',
  'META_PAGE_ACCESS_TOKEN', 'META_PAGE_ID', 'META_IG_BUSINESS_ID', 'TIKTOK_ACCESS_TOKEN',
  'TIKTOK_REFRESH_TOKEN', 'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_PRIVACY_LEVEL'
];

function allowedClientSettingKeys(currentConfig) {
  const stored = Array.isArray(currentConfig.USER_DEFINABLE) ? currentConfig.USER_DEFINABLE : [];
  return new Set([...CLIENT_SETTINGS_KEYS, ...stored]);
}
// ---- END CLIENT SETTINGS ALLOWLIST ----

app.put('/api/client', requireAuth, requireClientAuth, async (req, res) => {
  try {
    const { 
      clientSecret, 
      contactName, 
      clientEmail,
      configuration 
    } = req.body;
    
    // Validate required fields
    if (!contactName || !clientEmail) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_validation',
        message: 'Contact name and email are required'
      });
    }
    
    // Validate email format
    if (!clientEmail.includes('@')) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_validation',
        message: 'Valid email address is required'
      });
    }
    
    // Only the client login itself may change the client secret (the
    // master login's password). The route is already client-only via
    // requireClientAuth; this is a second guard in case that ever loosens,
    // since a sub-user who could reset it could then log in as the client.
    if (clientSecret && clientSecret.trim() !== '' && req.user.userType !== 'client') {
      return res.status(403).json({
        success: false,
        returnStatus: 'failed_forbidden',
        message: 'Only the client login can change the client secret'
      });
    }
    
    console.log(`Updating client: ${req.user.username}`);
    
    // Get client-specific models
    const dbCredentials = await getDatabaseCredentials(req.user.dbName);
    const { Client } = await initializeClientModel(req.user.dbName, dbCredentials);
    
    const client = await Client.findOne({
      where: {
        clientID: req.user.username
      }
    });
    
    if (!client) {
      return res.status(404).json({
        success: false,
        returnStatus: 'failed_no_client',
        message: 'Client not found'
      });
    }
    
    // Prepare update data
    const updateData = {
      contactName: contactName.trim(),
      clientEmail: clientEmail.trim(),
      updatedDate: new Date()
    };
    
    // Hash password if provided
    if (clientSecret && clientSecret.trim() !== '') {
      const hashedSecret = await bcrypt.hash(clientSecret.trim(), 10);
      updateData.clientSecret = hashedSecret;
    }
    
    // Update configuration if provided
    const ignoredKeys = [];
    if (configuration && typeof configuration === 'object') {
      // Get current configuration
      const currentConfig = client.configuration || {};
      
      // Merge in only the keys Client Settings may change (see CLIENT
      // SETTINGS ALLOWLIST); anything else is dropped and named in the
      // response, so a non-user-definable field can't be overwritten.
      const allowed = allowedClientSettingKeys(currentConfig);
      const accepted = {};
      for (const [key, value] of Object.entries(configuration)) {
        if (allowed.has(key)) accepted[key] = value;
        else ignoredKeys.push(key);
      }
      if (ignoredKeys.length) {
        console.warn(`Client settings save ignored non-user-definable keys: ${ignoredKeys.join(', ')}`);
      }

      updateData.configuration = { ...currentConfig, ...accepted };
    }
    
    // Update the client
    await client.update(updateData);
    
    console.log(`Client updated successfully: ${req.user.username}`);
    
    return res.json({
      success: true,
      returnStatus: 'successful_update',
      message: 'Client information updated successfully',
      ...(ignoredKeys.length ? { ignoredKeys } : {})
    });
    
  } catch (error) {
    console.error('Error updating client:', error);
    
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Failed to update client information',
      error: error.message
    });
  }
});

// ---- CLIENT UI CONFIG ----
// The handful of non-sensitive Client.configuration keys that operator pages
// (Add Movie, Add Event, Order) need. Those pages used to call the full
// GET /api/client, which returns the whole configuration -- Square tokens,
// FTP credentials, social tokens -- and is client-login-only, so sub-users
// got a 403 and the pages silently fell back to defaults. Same response shape as
// GET /api/client (client.configuration) so callers only change the URL.
// (GET /api/client itself is client-login-only: Client Settings is the
// master account's page.)
const UI_CONFIG_KEYS = ['EVENT_LOCATIONS', 'EVENT_DESCRIPTORS', 'SHOWTIME_BUFFER_MINUTES', 'USERS_NAMES'];

app.get('/api/client/ui-config', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  try {
    const dbCredentials = await getDatabaseCredentials(req.user.dbName);
    const { Client } = await initializeClientModel(req.user.dbName, dbCredentials);

    const client = await Client.findOne({
      where: {
        clientID: req.user.username
      }
    });

    if (!client) {
      return res.status(404).json({
        success: false,
        returnStatus: 'failed_no_client',
        message: 'Client not found'
      });
    }

    const config = client.configuration || {};
    const configuration = {};
    for (const key of UI_CONFIG_KEYS) {
      if (config[key] !== undefined) configuration[key] = config[key];
    }

    res.json({
      success: true,
      client: { configuration }
    });
  } catch (error) {
    console.error('Error fetching client UI config:', error);
    res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Internal server error'
    });
  }
});
// ---- END CLIENT UI CONFIG ----

// Lightweight branding endpoint for header components
app.get('/api/client/branding', requireAuth, requirePermission(...PERMS_ANY), async (req, res) => {
  try {
    // Get client-specific models
    const dbCredentials = await getDatabaseCredentials(req.user.dbName);
    const { Client } = await initializeClientModel(req.user.dbName, dbCredentials);
    
    const client = await Client.findOne({
      where: {
        clientID: req.user.username
      }
    });
    
    if (!client) {
      return res.status(404).json({ 
        success: false,
        returnStatus: 'failed_no_client',
        message: 'Client not found' 
      });
    }
    
    // Extract only branding-related configuration
    const config = client.configuration || {};
    const brandingData = {
      webHeaderCompany: config.WEB_HEADER_COMPANY || 'IndieTix',
      logoFile: config.LOGO_FILE || 'indieTixLogo.png',
      theaterName: config.THEATER_NAME || '',
      clientID: client.clientID
    };
    
    res.json({
      success: true,
      branding: brandingData
    });
  } catch (error) {
    console.error('Error fetching client branding:', error);
    res.status(500).json({ 
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Internal server error', 
      error: error.message 
    });
  }
});


app.post('/api/checkout', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  const { qrCode } = req.body;
  
  if (!qrCode) {
    return res.status(400).json({ 
      returnStatus: 'failed_invalid_request', 
      message: 'QR code is required' 
    });
  }
  
  let userPool;
  try {
    // Create a connection to the user-specific database using JWT info
    userPool = await createDbConnection(req.user.dbName);
    
    // Check if QR code exists and its status
    const checkResult = await userPool.query(
      'SELECT "ID", "CheckedIn", "ExpirationDate" FROM "QRCodeProduct" WHERE "QRCode" = $1',
      [qrCode]
    );
    
    // QR code not found in database (or hidden by the sub-user's data filter)
    if (checkResult.rows.length === 0 || !(await ticketPassesDataFilter(req, 'QRCode', qrCode))) {
      await userPool.end();
      return res.json({ returnStatus: 'failed_no_QRCode' });
    }
    
    const qrCodeRecord = checkResult.rows[0];
    
    // Check if already checked out (not checked in)
    if (!qrCodeRecord.CheckedIn) {
      await userPool.end();
      return res.json({ returnStatus: 'failed_already_checked_out' });
    }
    
    // Check if expired
    const currentDate = new Date();
    const expirationDate = new Date(qrCodeRecord.ExpirationDate);
    
    if (currentDate > expirationDate) {
      await userPool.end();
      return res.json({ 
        returnStatus: 'failed_expired_qrcode', 
        expirationDate: expirationDate.toISOString() 
      });
    }
    
    // Update the QR code to checked out (CheckedIn = false)
    await userPool.query(
      'UPDATE "QRCodeProduct" SET "CheckedIn" = false, "LastEditedDate" = $1 WHERE "ID" = $2',
      [currentDate.toISOString(), qrCodeRecord.ID]
    );
    
    await userPool.end();
    return res.json({ returnStatus: 'successful_checkout' });
    
  } catch (error) {
    console.error('Database error:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ 
      returnStatus: 'failed_server_error',
      message: 'An error occurred while processing your request',
      error: error.message
    });
  }
});

// API route to toggle refund status for a product by ID
app.post('/api/products/:id/refund', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get client-specific models
	const dbCredentials = await getDatabaseCredentials(req.user.dbName);
	const { QRCodeProduct } = await initializeModelForClient(req.user.dbName, dbCredentials);
    
    const product = await QRCodeProduct.findByPk(id);
    
    if (!product || !(await ticketPassesDataFilter(req, 'ID', id))) {
      return res.status(404).json({ 
        success: false, 
        returnStatus: 'failed_no_product',
        message: 'Product not found' 
      });
    }
    
    // Get current status (default to 'valid' if null/undefined)
    const currentStatus = product.status || 'valid';
    
    // Toggle the status
    const newStatus = currentStatus === 'valid' ? 'refunded' : 'valid';
    
    // Update the product status
    await product.update({
      status: newStatus,
      lastEditedDate: new Date()
    });
    
    return res.json({ 
      success: true, 
      returnStatus: 'successful_refund_toggle',
      message: `Product status changed to ${newStatus}`,
      newStatus: newStatus,
      product 
    });
  } catch (error) {
    console.error('Error toggling refund status:', error);
    return res.status(500).json({ 
      success: false,
      returnStatus: 'failed_server_error',
      message: 'An error occurred while processing your request',
      error: error.message
    });
  }
});



// ---- TICKET TRANSFER ----
// Moves a valid, not-yet-checked-in ticket to a new recipient: generates a
// brand new QR code + PDF for them (via the shared ticket-pdf-lib layer --
// the same QR-gen/PDF-overlay logic getSquareOrders uses for original
// tickets, ported fresh rather than touching that pipeline), emails it to
// the recipient, and marks the original ticket 'transferred' so it can
// never be scanned again. bdor_for_date already treats 'transferred' as
// zero-contribution everywhere (see clientSetup-Teardown's
// createDatabaseObjects) -- the new row carries the real sale forward for
// box-office reporting, so nothing double-counts or drops out.
//
// Deliberately email-only for now, no SMS: the recipient is a brand new
// contact who has never gone through the SMS opt-in/consent flow, and
// this isn't the place to invent a second consent-bypass path.
app.post('/api/products/:id/transfer', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
  const { id } = req.params;
  const { recipientFirstName, recipientLastName, recipientEmail, recipientPhone } = req.body;

  if (!recipientEmail || !recipientEmail.includes('@')) {
    return res.status(400).json({
      success: false,
      returnStatus: 'failed_validation',
      message: 'A valid recipient email address is required'
    });
  }

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);

    const originalResult = await userPool.query(
      `SELECT qp.*, pto."OrderID" AS "OrderID"
       FROM "QRCodeProduct" qp
       JOIN "QRCodeProductToOrder" pto ON pto."QRCodeProductID" = qp."ID"
       WHERE qp."ID" = $1
       LIMIT 1`,
      [id]
    );

    if (originalResult.rows.length === 0) {
      await userPool.end();
      return res.status(404).json({
        success: false,
        returnStatus: 'failed_no_product',
        message: 'Ticket not found'
      });
    }

    const original = originalResult.rows[0];
    const currentStatus = original.Status || 'valid';

    if (currentStatus !== 'valid') {
      await userPool.end();
      return res.status(409).json({
        success: false,
        returnStatus: 'failed_not_transferable',
        message: `Only valid tickets can be transferred (current status: ${currentStatus})`
      });
    }

    if (original.CheckedIn) {
      await userPool.end();
      return res.status(409).json({
        success: false,
        returnStatus: 'failed_already_checked_in',
        message: 'This ticket has already been checked in and cannot be transferred'
      });
    }

    const normalizedPhone = recipientPhone ? normalizeToE164(recipientPhone) : null;
    const newQrCode = `TRANSFER-${crypto.randomBytes(12).toString('base64url')}`;

    // Render the new ticket PDF before touching the database -- if PDF
    // generation fails, nothing has changed yet and the request just errors.
    const bucketName = globalConfig.S3_BUCKET_PREFIX + req.user.username.toLowerCase();
    const templateKey = globalConfig.TICKET_FILENAME || 'ticket_horizontal.pdf';
    const orientation = globalConfig.TICKET_ORIENTATION || 'horizontal';

    const [qrCodeBuffer, templatePdfBuffer] = await Promise.all([
      generateQRCode(newQrCode),
      s3.getObject({ Bucket: bucketName, Key: templateKey }).promise().then(r => r.Body)
    ]);

    const orderInfo = {
      name: original.ProductName,
      variation: original.ProductSeatCode,
      itemModifierValues: original.ProductDetails
    };
    const newPdfBuffer = await renderTicketPdf(templatePdfBuffer, qrCodeBuffer, orderInfo, orientation);

    const newPdfKey = `tickets-out/QR-Ticket-${newQrCode}.pdf`;
    await s3.putObject({
      Bucket: bucketName,
      Key: newPdfKey,
      Body: newPdfBuffer,
      ContentType: 'application/pdf'
    }).promise();

    // Now the database changes -- both in one transaction so a half-done
    // transfer (new row created but old one not marked, or vice versa)
    // can't happen.
    const client = await userPool.connect();
    let newProductId;
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(
        `INSERT INTO "QRCodeProduct"
          ("QRCode", "CheckedIn", "CreatedDate", "ExpirationDate", "LastEditedDate",
           "ProductMetadata", "ProductDate", "ProductName", "ProductLocation", "ProductType",
           "ProductDetails", "ProductPrice", "ProductID", "EmailAddress", "FirstName", "LastName",
           "PhoneNumber", "Distributor", "ProductVenue", "ProductSeatCode", "Status")
         VALUES
          ($1, false, NOW(), $2, NOW(),
           $3, $4, $5, $6, $7,
           $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, 'valid')
         RETURNING "ID"`,
        [
          newQrCode,
          original.ExpirationDate,
          original.ProductMetadata ? JSON.stringify(original.ProductMetadata) : null,
          original.ProductDate,
          original.ProductName,
          original.ProductLocation,
          original.ProductType,
          original.ProductDetails,
          original.ProductPrice,
          original.ProductID,
          recipientEmail,
          recipientFirstName || null,
          recipientLastName || null,
          normalizedPhone,
          original.Distributor,
          original.ProductVenue,
          original.ProductSeatCode
        ]
      );
      newProductId = insertResult.rows[0].ID;

      await client.query(
        `INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID") VALUES ($1, $2)`,
        [newProductId, original.OrderID]
      );

      await client.query(
        `UPDATE "QRCodeProduct" SET "Status" = 'transferred', "LastEditedDate" = NOW() WHERE "ID" = $1`,
        [original.ID]
      );

      await client.query('COMMIT');
    } catch (dbError) {
      await client.query('ROLLBACK');
      throw dbError;
    } finally {
      client.release();
    }

    await userPool.end();
    userPool = null;

    // Email the new ticket to the recipient. A failure here doesn't roll
    // back the transfer -- the ticket is real and valid either way; staff
    // can resend from the order/ticket if the email bounces.
    try {
      const recipientName = `${recipientFirstName || ''} ${recipientLastName || ''}`.trim() || 'there';
      const subject = `Your Transferred Ticket - ${original.ProductName}`;
      const body = `Hi ${recipientName},

A ticket has been transferred to you: ${original.ProductName}.

Please find your new ticket attached as a PDF. Save it to your phone or print it to bring to the event.

Best regards,
${globalConfig.WEB_HEADER_COMPANY || 'IndieTix'}`;

      await sendEmailWithMultipleAttachments(
        globalConfig.SENDER_EMAIL,
        recipientEmail,
        subject,
        body,
        [{ filename: `QR-Ticket-${newQrCode}.pdf`, content: newPdfBuffer, contentType: 'application/pdf' }]
      );
    } catch (emailError) {
      console.error('Transfer succeeded but failed to email the new ticket:', emailError);
      return res.json({
        success: true,
        returnStatus: 'successful_transfer_email_failed',
        message: 'Ticket transferred, but the email to the recipient failed to send',
        newProductId,
        newQrCode
      });
    }

    return res.json({
      success: true,
      returnStatus: 'successful_transfer',
      message: 'Ticket transferred successfully',
      newProductId,
      newQrCode
    });

  } catch (error) {
    console.error('Error transferring ticket:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'An error occurred while transferring the ticket',
      error: error.message
    });
  }
});
// ---- end TICKET TRANSFER ----

// Main application route (authenticated)
app.get('/', requireAuth, requirePermission(...PERMS_DOOR), (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Resend email endpoint
app.post('/api/orders/:orderId/resend-email', requireAuth, requirePermission(...PERMS_ORDERS), async (req, res) => {
  try {
    const { orderId } = req.params;
    
    if (!orderId) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_missing_order_id',
        message: 'Order ID is required'
      });
    }

    // Get client-specific models
const dbCredentials = await getDatabaseCredentials(req.user.dbName);
const { Order } = await initializeModelForClientOrder(req.user.dbName, dbCredentials);
    
    // Find the order
    const order = await Order.findByPk(orderId);
    
    if (!order) {
      return res.status(404).json({
        success: false,
        returnStatus: 'failed_no_order',
        message: 'Order not found'
      });
    }

    // Query to get QR codes associated with this order
    const userPool = await createDbConnection(req.user.dbName);
    const qrCodeResult = await userPool.query(
      'SELECT cp."QRCode" FROM "Order" as o JOIN "QRCodeProductToOrder" as pto ON o."ID" = pto."OrderID" JOIN "QRCodeProduct" cp ON pto."QRCodeProductID" = cp."ID" WHERE o."ID" = $1',
      [orderId]
    );
    await userPool.end();

    if (qrCodeResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        returnStatus: 'failed_no_qrcodes',
        message: 'No QR codes found for this order'
      });
    }

    // Extract QR codes from query result
    const qrCodes = qrCodeResult.rows.map(row => row.QRCode);
    console.log('Found QR codes for order:', qrCodes);

    // Validate email address
    const emailAddress = order.emailAddress;
    if (!emailAddress || !emailAddress.includes('@')) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_invalid_email',
        message: 'Invalid email address'
      });
    }

    // Prepare email content
    const customerName = `${order.firstName || ''} ${order.lastName || ''}`.trim() || 'Valued Customer';
    const orderMetaData = order.orderMetaData || {};
    
    console.log('Sending email to:', emailAddress);
    console.log('Customer name:', customerName);

    const subject = `Your QR Code Ticket - Order ${order.orderID}`;
    const emailBody = `Dear ${customerName},

Thank you for your order! Please find your QR code ticket(s) attached.

Order Details:
- Order ID: ${order.orderID}
- Created: ${order.createdDate}
- Customer: ${customerName}
- Email: ${order.emailAddress}
${orderMetaData.eventName ? `- Event: ${orderMetaData.eventName}` : ''}
${orderMetaData.ticketCount ? `- Number of Tickets: ${orderMetaData.ticketCount}` : ''}
${orderMetaData.totalAmount ? `- Total Amount: ${orderMetaData.totalAmount}` : ''}

Please save the attached QR code(s) to your phone or print them out to bring to the event.

Best regards,
Liberty Hall Team`;

    // Generate QR code attachments from S3 using the found QR codes
    const bucketName = globalConfig.S3_BUCKET_PREFIX+req.user.username.toLowerCase();
    const qrAttachments = await generateQRCodeAttachments(order, qrCodes, bucketName);
    
    // Send email
    const sender = globalConfig.SENDER_EMAIL;
    await sendEmailWithMultipleAttachments(sender, emailAddress, subject, emailBody, qrAttachments);

    // Update LastEditedDate
    await order.update({
      lastEditedDate: new Date()
    });

    return res.json({
      success: true,
      returnStatus: 'successful_resend',
      message: 'Email resent successfully',
      emailAddress: emailAddress,
      qrCodesAttached: qrCodes.length
    });

  } catch (error) {
    console.error('Error resending email:', error);
    
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_email_service',
      message: 'Failed to resend email',
      error: error.message
    });
  }
});

async function generateQRCodeAttachments(order, qrCodes, bucketName) {
  const attachments = [];
  
  // Iterate through all QR codes and fetch each from S3
  for (let i = 0; i < qrCodes.length; i++) {
    const qrCode = qrCodes[i];
    
    try {
      const encodedQrCode = "QR-Ticket-" + s3UrlEncode(qrCode);
      const s3Key = `tickets-out/${encodedQrCode}.pdf`;
      
      console.log(`Fetching QR code ${i + 1}/${qrCodes.length}: ${qrCode} from ${s3Key}`);
      
      const fileContent = await getS3FileContent(bucketName, s3Key);
      
      attachments.push({
        filename: `${encodedQrCode}.pdf`,
        content: fileContent,
        contentType: 'application/pdf'
      });
      
      console.log(`Successfully attached QR code: ${qrCode}`);
      
    } catch (s3Error) {
      console.error(`Error fetching QR code ${qrCode} from S3:`, s3Error);
      // Continue with other QR codes even if one fails
    }
  }
  
  if (attachments.length === 0) {
    throw new Error(`No ticket files found in S3 for any of the ${qrCodes.length} QR codes`);
  }
  
  console.log(`Successfully generated ${attachments.length} attachments out of ${qrCodes.length} QR codes`);
  return attachments;
}

// Email sending function using AWS v2. `html` is optional -- when given,
// mailcomposer sends a multipart/alternative message (html + text fallback);
// existing callers that don't pass it are unaffected.
async function sendEmailWithMultipleAttachments(sender, recipient, subject, body, attachments, html) {
  const mail = mailcomposer({
    from: sender,
    to: recipient,
    subject: subject,
    text: body,
    ...(html ? { html } : {}),
    attachments: attachments
  });

  const mimeMessage = await new Promise((resolve, reject) => {
    mail.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  // Use AWS v2 SES
  const result = await ses.sendRawEmail({
    RawMessage: { Data: mimeMessage }
  }).promise();

  return result;
}

// Helper function to fetch file content from S3
async function getS3FileContent(bucketName, key) {
  const params = {
    Bucket: bucketName,
    Key: key
  };
  
  const response = await s3.getObject(params).promise();
  return response.Body; // AWS v2 returns Buffer directly
}

// Edit order endpoint
app.put('/api/orders/:orderId/edit', requireAuth, requirePermission(...PERMS_ORDERS), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { firstName, lastName, phoneNumber, emailAddress } = req.body;
    
    if (!orderId) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_missing_order_id',
        message: 'Order ID is required'
      });
    }

    // Validate required email field
    if (!emailAddress || !emailAddress.includes('@')) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_validation',
        message: 'Valid email address is required'
      });
    }

    // Phones are always stored E.164 (platform convention) -- SMS consent
    // and Customer lookups match on it. Blank clears the phone; anything
    // else that won't normalize is rejected rather than stored raw.
    let normalizedPhone = null;
    if (phoneNumber && String(phoneNumber).trim() !== '') {
      normalizedPhone = normalizeToE164(String(phoneNumber));
      if (!normalizedPhone) {
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_validation',
          message: 'Phone number is not valid'
        });
      }
    }

    console.log('Updating order:', orderId, 'with data:', { firstName, lastName, phoneNumber: normalizedPhone, emailAddress });

    // Create database connection
    let userPool;
    try {
      userPool = await createDbConnection(req.user.dbName);
      
      // First, verify the order exists
      const orderCheck = await userPool.query(
        'SELECT "ID", "OrderID" FROM "Order" WHERE "ID" = $1 LIMIT 1',
        [orderId]
      );
      
      if (orderCheck.rows.length === 0) {
        await userPool.end();
        return res.status(404).json({
          success: false,
          returnStatus: 'failed_no_order',
          message: 'Order not found'
        });
      }

      console.log('Found order:', orderCheck.rows[0].OrderID);

      // Single SQL statement to update both tables atomically using CTE
      const updateResult = await userPool.query(
        `WITH order_update AS (
           UPDATE "Order" 
           SET "FirstName" = $1, 
               "LastName" = $2, 
               "PhoneNumber" = $3, 
               "EmailAddress" = $4, 
               "LastEditedDate" = $5
           WHERE "ID" = $6
           RETURNING "ID"
         ),
         qrcode_update AS (
           UPDATE "QRCodeProduct" 
           SET "FirstName" = $1, 
               "LastName" = $2, 
               "PhoneNumber" = $3, 
               "EmailAddress" = $4, 
               "LastEditedDate" = $5
           WHERE "ID" IN (
             SELECT pto."QRCodeProductID" 
             FROM "QRCodeProductToOrder" pto, order_update ou
             WHERE pto."OrderID" = ou."ID"
             LIMIT 10
           )
           RETURNING "ID"
         )
         SELECT 
           (SELECT COUNT(*) FROM order_update) as orders_updated,
           (SELECT COUNT(*) FROM qrcode_update) as qrcodes_updated`,
        [firstName, lastName, normalizedPhone, emailAddress, new Date(), orderId]
      );

      await userPool.end();

      const result = updateResult.rows[0];
      console.log('Update completed - Orders:', result.orders_updated, 'QR Codes:', result.qrcodes_updated);

      // Check if the order was actually updated
      if (result.orders_updated === 0) {
        return res.status(404).json({
          success: false,
          returnStatus: 'failed_no_order',
          message: 'Order not found or could not be updated'
        });
      }

      return res.json({
        success: true,
        returnStatus: 'successful_update',
        message: 'Order updated successfully',
        ordersUpdated: parseInt(result.orders_updated),
        qrCodesUpdated: parseInt(result.qrcodes_updated)
      });

    } catch (dbError) {
      console.error('Database error during order update:', dbError);
      
      if (userPool) await userPool.end();
      
      return res.status(500).json({
        success: false,
        returnStatus: 'failed_database_error',
        message: 'Database error occurred during update',
        error: dbError.message
      });
    }

  } catch (error) {
    console.error('Error updating order:', error);
    
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Failed to update order',
      error: error.message
    });
  }
});

// List tickets for an order (used by the refund modal's ticket checklist)
app.get('/api/orders/:orderId/tickets', requireAuth, requirePermission(...PERMS_ORDERS), async (req, res) => {
  let userPool;
  try {
    const { orderId } = req.params;

    // Sub-users only see orders with a ticket inside their data filter.
    if (!(await orderPassesDataFilter(req, orderId))) {
      return filteredNotFound(res, 'Order not found');
    }


    if (!orderId) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_missing_order_id',
        message: 'Order ID is required'
      });
    }

    userPool = await createDbConnection(req.user.dbName);

    const ticketsResult = await userPool.query(
      `SELECT qcp."ID", qcp."QRCode", qcp."ProductName", qcp."ProductSeatCode",
              qcp."ProductPrice", qcp."Status"
       FROM "QRCodeProduct" qcp
       JOIN "QRCodeProductToOrder" pto ON qcp."ID" = pto."QRCodeProductID"
       WHERE pto."OrderID" = $1
       ORDER BY qcp."ID" ASC`,
      [orderId]
    );

    await userPool.end();

    return res.json({
      success: true,
      returnStatus: 'successful_ticket_list',
      tickets: ticketsResult.rows
    });

  } catch (error) {
    console.error('Error fetching tickets for order:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Failed to fetch tickets for order',
      error: error.message
    });
  }
});

// Refund order endpoint
app.post('/api/orders/:orderId/refund', requireAuth, requirePermission(...PERMS_ORDERS), async (req, res) => {
  try {
    const { orderId } = req.params;
    const { paymentId, refundedBy, refundReason, refundAmount, ticketIds } = req.body;

    // Sub-users only see orders with a ticket inside their data filter.
    if (!(await orderPassesDataFilter(req, orderId))) {
      return filteredNotFound(res, 'Order not found');
    }


    if (!orderId) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_missing_order_id',
        message: 'Order ID is required'
      });
    }

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_no_payment_id',
        message: 'Payment ID is required'
      });
    }

    if (!refundedBy) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_missing_refunded_by',
        message: 'Refunded by user is required'
      });
    }

    if (!refundReason) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_missing_refund_reason',
        message: 'Refund reason is required'
      });
    }

    // Variable/partial refund amount (cents). Omitted means "full refund" —
    // resolved against the actual Square payment amount further down.
    let requestedAmount = null;
    if (refundAmount !== undefined && refundAmount !== null) {
      requestedAmount = Number(refundAmount);
      if (!Number.isInteger(requestedAmount) || requestedAmount <= 0) {
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_invalid_amount',
          message: 'Refund amount must be a positive integer number of cents'
        });
      }
    }

    if (ticketIds !== undefined && !Array.isArray(ticketIds)) {
      return res.status(400).json({
        success: false,
        returnStatus: 'failed_invalid_ticket_ids',
        message: 'ticketIds must be an array'
      });
    }

    console.log('Processing refund for order:', orderId, 'payment ID:', paymentId);
    console.log('Refunded by:', refundedBy, 'Reason:', refundReason);
    console.log('=== REFUND ENDPOINT START ===');

    // Get Square access token
    const accessToken = globalConfig.SQUARE_ACCESS_TOKEN;
    if (!accessToken) {
      return res.status(500).json({
        success: false,
        returnStatus: 'failed_square_not_configured',
        message: 'Square API not configured'
      });
    }

    let userPool;
    try {
      userPool = await createDbConnection(req.user.dbName);
      
      // Verify order exists and get order details
      const orderCheck = await userPool.query(
        'SELECT "ID", "OrderID", "OrderMetaData" FROM "Order" WHERE "ID" = $1 LIMIT 1',
        [orderId]
      );
      
      if (orderCheck.rows.length === 0) {
        await userPool.end();
        return res.status(404).json({
          success: false,
          returnStatus: 'failed_no_order',
          message: 'Order not found'
        });
      }

      const order = orderCheck.rows[0];
      console.log('Found order:', order.OrderID);

      // Check if already refunded by checking tickets
      console.log('Checking if order already refunded...');
      const ticketStatusCheck = await userPool.query(
        `SELECT COUNT(*) as refunded_count
         FROM "QRCodeProduct" qcp
         JOIN "QRCodeProductToOrder" pto ON qcp."ID" = pto."QRCodeProductID"
         WHERE pto."OrderID" = $1 AND qcp."Status" = 'refunded'`,
        [orderId]
      );

      console.log('Ticket status check result:', ticketStatusCheck.rows[0]);

      if (parseInt(ticketStatusCheck.rows[0].refunded_count) > 0) {
        console.log('Order already refunded, returning error');
        await userPool.end();
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_already_refunded',
          message: 'This order has already been refunded'
        });
      }

      console.log('Order not already refunded, proceeding with refund...');

      // Resolve which tickets this refund should invalidate. Selection is
      // validated against this order's own tickets so a caller can't sneak
      // in IDs belonging to another order.
      const orderTicketsResult = await userPool.query(
        `SELECT qcp."ID", qcp."Status"
         FROM "QRCodeProduct" qcp
         JOIN "QRCodeProductToOrder" pto ON qcp."ID" = pto."QRCodeProductID"
         WHERE pto."OrderID" = $1`,
        [orderId]
      );

      const validTicketIdsOnOrder = new Set(
        orderTicketsResult.rows
          .filter(r => r.Status === 'valid')
          .map(r => r.ID)
      );

      let ticketIdsToRefund;
      if (Array.isArray(ticketIds)) {
        const requestedIds = ticketIds.map(id => Number(id));
        const invalidRequested = requestedIds.filter(id => !validTicketIdsOnOrder.has(id));
        if (invalidRequested.length > 0) {
          await userPool.end();
          return res.status(400).json({
            success: false,
            returnStatus: 'failed_invalid_ticket_ids',
            message: 'One or more selected tickets are not valid tickets on this order',
            invalidTicketIds: invalidRequested
          });
        }
        ticketIdsToRefund = requestedIds;
      } else {
        // No selection provided — default to invalidating every valid ticket on the order
        ticketIdsToRefund = Array.from(validTicketIdsOnOrder);
      }

      console.log('Tickets to invalidate:', ticketIdsToRefund);

      // Call Square Refund API
      const idempotencyKey = `${order.OrderID}-${crypto.randomUUID()}`;
      console.log('Created idempotency key:', idempotencyKey);

      const orderMeta = order.OrderMetaData || {};
      const orderData = orderMeta.order || {};
      const totalMoney = orderData.total_money || {};
      const currency = totalMoney.currency || 'USD';

      console.log('Requested refund amount (cents):', requestedAmount, 'currency:', currency);

      console.log('Fetching original payment from Square to validate refund amount...');
      
      // Fetch the actual payment from Square to verify amount and check for existing refunds
      const paymentResponse = await fetch(`https://connect.squareup.com/v2/payments/${paymentId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!paymentResponse.ok) {
        const paymentError = await paymentResponse.json();
        console.error('Square payment lookup failed:', paymentError);
        await userPool.end();
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_payment_lookup',
          message: 'Could not verify original payment with Square',
          squareErrors: paymentError.errors
        });
      }
      
      const paymentData = await paymentResponse.json();
      console.log('Square payment retrieved:', {
        paymentId: paymentData.payment.id,
        status: paymentData.payment.status,
        amount: paymentData.payment.amount_money.amount,
        refundIds: paymentData.payment.refund_ids
      });
      
      if (!paymentData.payment) {
        await userPool.end();
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_payment_not_found',
          message: 'Payment not found in Square'
        });
      }
      
      const originalAmount = paymentData.payment.amount_money.amount;
      const paymentStatus = paymentData.payment.status;
      const existingRefundIds = paymentData.payment.refund_ids || [];
      
      // Check if payment is in refundable state
      if (paymentStatus !== 'COMPLETED' && paymentStatus !== 'APPROVED') {
        await userPool.end();
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_payment_not_refundable',
          message: `Payment status is ${paymentStatus}, cannot refund. Only COMPLETED or APPROVED payments can be refunded.`
        });
      }
      
      // Check for existing partial refunds
      if (existingRefundIds.length > 0) {
        console.log(`WARNING: Payment has ${existingRefundIds.length} existing refund(s):`, existingRefundIds);
        await userPool.end();
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_already_has_refunds',
          message: `This payment has already been refunded (${existingRefundIds.length} refund(s) exist). Cannot process duplicate refund.`,
          existingRefundIds: existingRefundIds
        });
      }
      
      // Default to a full refund of the original payment when no amount was requested
      const amount = requestedAmount !== null ? requestedAmount : originalAmount;

      // CRITICAL: Validate refund amount doesn't exceed the actual amount charged.
      // originalAmount comes straight from Square's payment record, so this is
      // the authoritative cap — the client-supplied amount can never exceed it.
      if (amount > originalAmount) {
        console.error(`Refund amount validation FAILED: Attempting to refund ${amount} but original payment was only ${originalAmount}`);
        await userPool.end();
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_amount_exceeds_payment',
          message: `Refund amount ($${(amount/100).toFixed(2)}) exceeds original payment ($${(originalAmount/100).toFixed(2)})`
        });
      }

      const isPartialRefund = amount < originalAmount;

      console.log('Amount validation passed. Proceeding with refund.', { amount, originalAmount, isPartialRefund });
      
      const refundPayload = {
        idempotency_key: idempotencyKey,
        payment_id: paymentId,
        amount_money: {
          amount: amount,
          currency: currency
        },
        reason: 'Customer requested refund'
      };

      console.log('Calling Square Refund API with payload:', refundPayload);

      const squareResponse = await fetch(SQUARE_REFUND_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(refundPayload)
      });

      const squareData = await squareResponse.json();
      
      if (!squareResponse.ok || squareData.errors) {
        console.error('Square API refund error:', squareData);
        await userPool.end();
        return res.status(400).json({
          success: false,
          returnStatus: 'failed_square_api',
          message: squareData.errors ? squareData.errors[0].detail : 'Square refund failed',
          squareErrors: squareData.errors
        });
      }

      console.log('Square refund successful:', squareData.refund);

      // Invalidate only the tickets selected for this refund (defaults to all
      // valid tickets on the order, resolved above)
      const refundTime = new Date();
      const updateTicketsResult = await userPool.query(
        `UPDATE "QRCodeProduct"
         SET "Status" = 'refunded',
             "ExpirationDate" = $1,
             "LastEditedDate" = $1
         WHERE "ID" = ANY($2::int[])
         RETURNING "ID", "QRCode"`,
        [refundTime, ticketIdsToRefund]
      );

      const ticketsInvalidated = updateTicketsResult.rows.length;
      console.log('Tickets invalidated:', ticketsInvalidated, 'QR codes:', updateTicketsResult.rows.map(r => r.QRCode));

      // Update OrderMetaData with refund information
      // Parse if string, otherwise use object, then create mutable copy
      let orderMetaData;
      if (typeof order.OrderMetaData === 'string') {
        orderMetaData = JSON.parse(order.OrderMetaData);
      } else {
        // Create a mutable copy of the object
        orderMetaData = JSON.parse(JSON.stringify(order.OrderMetaData || {}));
      }
      
      orderMetaData.refund = {
        refundedAt: refundTime.toISOString(),
        refundedBy: refundedBy,
        refundedByAccount: actorFromToken(req), // verified identity; refundedBy is UI-supplied
        refundReason: refundReason,
        refundId: squareData.refund.id,
        refundStatus: squareData.refund.status,
        amount: amount,
        orderTotal: originalAmount,
        currency: currency,
        partial: isPartialRefund,
        ticketsInvalidated: ticketsInvalidated,
        refundedTickets: updateTicketsResult.rows.map(r => r.QRCode)
      };

      // Update Order table with refund metadata and status
      await userPool.query(
        `UPDATE "Order" 
         SET "OrderMetaData" = $1,
             "LastEditedDate" = $2,
             "Status" = 'Refunded'
         WHERE "ID" = $3`,
        [JSON.stringify(orderMetaData), refundTime, orderId]
      );

      console.log('OrderMetaData updated with refund information and Status set to Refunded');

      await userPool.end();

      const successResponse = {
        success: true,
        returnStatus: 'successful_refund',
        message: 'Order refunded successfully',
        refundId: squareData.refund.id,
        refundStatus: squareData.refund.status,
        amount: amount,
        orderTotal: originalAmount,
        partial: isPartialRefund,
        ticketsInvalidated: ticketsInvalidated,
        refundedTickets: updateTicketsResult.rows.map(r => r.QRCode)
      };

      console.log('Sending success response:', JSON.stringify(successResponse));
      console.log('=== REFUND ENDPOINT SUCCESS - RETURNING 200 ===');

      return res.status(200).json(successResponse);

    } catch (dbError) {
      console.error('Database error during refund:', dbError);
      
      if (userPool) await userPool.end();
      
      return res.status(500).json({
        success: false,
        returnStatus: 'failed_database_error',
        message: 'Database error occurred during refund',
        error: dbError.message
      });
    }

  } catch (error) {
    console.error('Error processing refund:', error);
    
    return res.status(500).json({
      success: false,
      returnStatus: 'failed_server_error',
      message: 'Failed to process refund',
      error: error.message
    });
  }
});

// Cancel Order endpoint
app.post('/api/orders/:orderId/cancel', requireAuth, requirePermission(...PERMS_ORDERS), async (req, res) => {
  const { orderId } = req.params;
  const { cancelledBy, cancelReason } = req.body;
  
  try {
    // Sub-users only see orders with a ticket inside their data filter.
    if (!(await orderPassesDataFilter(req, orderId))) {
      return filteredNotFound(res, 'Order not found');
    }

    // Validate required fields
    if (!cancelledBy) {
      return res.status(400).json({
        success: false,
        message: 'cancelledBy is required'
      });
    }
    
    if (!cancelReason) {
      return res.status(400).json({
        success: false,
        message: 'cancelReason is required'
      });
    }
    
    console.log(`Processing cancel for order ID: ${orderId}`);
    console.log('Cancelled by:', cancelledBy, 'Reason:', cancelReason);
    
    let userPool;
    try {
      userPool = await createDbConnection(req.user.dbName);
      
      // Check if order exists and is Valid — also fetch OrderMetaData for audit trail
      const orderCheck = await userPool.query(
        'SELECT "ID", "OrderID", "Status", "OrderMetaData" FROM "Order" WHERE "ID" = $1 LIMIT 1',
        [orderId]
      );
      
      if (orderCheck.rows.length === 0) {
        await userPool.end();
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }
      
      const order = orderCheck.rows[0];
      
      if (order.Status !== 'Valid') {
        await userPool.end();
        return res.status(400).json({
          success: false,
          message: `Cannot cancel order with status: ${order.Status}`
        });
      }
      
      // Build updated OrderMetaData with cancel audit info
      const cancelTime = new Date();
      let orderMetaData;
      if (typeof order.OrderMetaData === 'string') {
        orderMetaData = JSON.parse(order.OrderMetaData);
      } else {
        orderMetaData = JSON.parse(JSON.stringify(order.OrderMetaData || {}));
      }
      
      orderMetaData.cancel = {
        cancelledAt: cancelTime.toISOString(),
        cancelledBy: cancelledBy,
        cancelledByAccount: actorFromToken(req), // verified identity; cancelledBy is UI-supplied
        cancelReason: cancelReason
      };
      
      // Update order status to Cancelled and save audit trail
      await userPool.query(
        `UPDATE "Order" 
         SET "Status" = 'Cancelled',
             "OrderMetaData" = $1,
             "LastEditedDate" = $2
         WHERE "ID" = $3`,
        [JSON.stringify(orderMetaData), cancelTime, orderId]
      );
      
      // Invalidate associated tickets
      await userPool.query(
        `UPDATE "QRCodeProduct" 
         SET "Status" = 'cancelled',
             "ExpirationDate" = NOW()
         WHERE "ID" IN (
           SELECT "QRCodeProductID" 
           FROM "QRCodeProductToOrder" 
           WHERE "OrderID" = $1
         )`,
        [orderId]
      );
      
      await userPool.end();
      
      return res.status(200).json({
        success: true,
        message: 'Order cancelled successfully',
        orderId: order.OrderID
      });
      
    } catch (dbError) {
      console.error('Database error during cancel:', dbError);
      if (userPool) await userPool.end();
      
      return res.status(500).json({
        success: false,
        message: 'Database error occurred during cancel',
        error: dbError.message
      });
    }
    
  } catch (error) {
    console.error('Error cancelling order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to cancel order',
      error: error.message
    });
  }
});

// Delete Order endpoint
app.post('/api/orders/:orderId/delete', requireAuth, requirePermission(...PERMS_ORDERS), async (req, res) => {
  const { orderId } = req.params;
  const { deletedBy, deleteReason } = req.body;
  
  try {
    // Sub-users only see orders with a ticket inside their data filter.
    if (!(await orderPassesDataFilter(req, orderId))) {
      return filteredNotFound(res, 'Order not found');
    }

    // Validate required fields
    if (!deletedBy) {
      return res.status(400).json({
        success: false,
        message: 'deletedBy is required'
      });
    }
    
    if (!deleteReason) {
      return res.status(400).json({
        success: false,
        message: 'deleteReason is required'
      });
    }
    
    console.log(`Processing delete for order ID: ${orderId}`);
    console.log('Deleted by:', deletedBy, 'Reason:', deleteReason);
    
    let userPool;
    try {
      userPool = await createDbConnection(req.user.dbName);
      
      // Check if order exists and is Valid — also fetch OrderMetaData for audit trail
      const orderCheck = await userPool.query(
        'SELECT "ID", "OrderID", "Status", "OrderMetaData" FROM "Order" WHERE "ID" = $1 LIMIT 1',
        [orderId]
      );
      
      if (orderCheck.rows.length === 0) {
        await userPool.end();
        return res.status(404).json({
          success: false,
          message: 'Order not found'
        });
      }
      
      const order = orderCheck.rows[0];
      
      if (order.Status !== 'Valid') {
        await userPool.end();
        return res.status(400).json({
          success: false,
          message: `Cannot delete order with status: ${order.Status}`
        });
      }
      
      // Build updated OrderMetaData with delete audit info
      const deleteTime = new Date();
      let orderMetaData;
      if (typeof order.OrderMetaData === 'string') {
        orderMetaData = JSON.parse(order.OrderMetaData);
      } else {
        orderMetaData = JSON.parse(JSON.stringify(order.OrderMetaData || {}));
      }
      
      orderMetaData.delete = {
        deletedAt: deleteTime.toISOString(),
        deletedBy: deletedBy,
        deletedByAccount: actorFromToken(req), // verified identity; deletedBy is UI-supplied
        deleteReason: deleteReason
      };
      
      // Update order status to Deleted and save audit trail
      await userPool.query(
        `UPDATE "Order" 
         SET "Status" = 'Deleted',
             "OrderMetaData" = $1,
             "LastEditedDate" = $2
         WHERE "ID" = $3`,
        [JSON.stringify(orderMetaData), deleteTime, orderId]
      );
      
      // Invalidate associated tickets
      await userPool.query(
        `UPDATE "QRCodeProduct" 
         SET "Status" = 'deleted',
             "ExpirationDate" = NOW()
         WHERE "ID" IN (
           SELECT "QRCodeProductID" 
           FROM "QRCodeProductToOrder" 
           WHERE "OrderID" = $1
         )`,
        [orderId]
      );
      
      await userPool.end();
      
      return res.status(200).json({
        success: true,
        message: 'Order deleted successfully',
        orderId: order.OrderID
      });
      
    } catch (dbError) {
      console.error('Database error during delete:', dbError);
      if (userPool) await userPool.end();
      
      return res.status(500).json({
        success: false,
        message: 'Database error occurred during delete',
        error: dbError.message
      });
    }
    
  } catch (error) {
    console.error('Error deleting order:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete order',
      error: error.message
    });
  }
});


// UPDATED ENDPOINT for app.mjs
// This replaces the existing app.post('/api/square/create-movie-item', ...) endpoint

// UPDATED ENDPOINT for app.mjs
// This replaces the existing app.post('/api/square/create-movie-item', ...) endpoint

/**
 * Create a movie item in Square catalog with showtimes as modifiers
 * POST /api/square/create-movie-item
 * 
 * Request body:
 * {
 *   movieData: {
 *     title: string,
 *     description: string,
 *     imdbID: string,
 *     posterUrl: string (optional),
 *     showtimes: string[] // Array of formatted showtimes like "Sun 01-18-2026 7:00 PM (Spacement)"
 *   }
 * }
 */
app.post('/api/square/create-movie-item', requireAuth, requirePermission('edit'), async (req, res) => {
  let clientPool;
  
  try {
    const { movieData } = req.body;
    
    console.log(`Creating Square item for movie: ${movieData.title}`);
    console.log(`Showtimes: ${movieData.showtimes?.length || 0}`);
    
    // Get client configuration
    clientPool = await createClientDbConnection(req.user.dbName);
    await getClientConfiguration(clientPool, req.user.dbName);
    await clientPool.end();
    
    const accessToken = globalConfig.SQUARE_ACCESS_TOKEN;
    const locationId = globalConfig.SQUARE_LOCATION_ID;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Square API not configured' });
    }
    
    if (!locationId) {
      return res.status(500).json({ error: 'Square Location ID not configured' });
    }
    
    // Validate showtimes
    if (!movieData.showtimes || movieData.showtimes.length === 0) {
      return res.status(400).json({ 
        error: 'At least one showtime is required',
        details: 'Please add showtimes before creating the item'
      });
    }
    
    // 1. Check if item already exists
    const searchResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        object_types: ['ITEM'],
        query: {
          exact_query: {
            attribute_name: 'name',
            attribute_value: movieData.title
          }
        }
      })
    });
    
    const searchData = await searchResponse.json();
    
    if (searchData.objects && searchData.objects.length > 0) {
      return res.status(409).json({ 
        error: 'An item with this name already exists in Square.'
      });
    }
    
    // 2. Find Cinema category
    const categoryResponse = await fetch(SQUARE_CATALOG_LIST_API_URL+'?types=CATEGORY', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const categoryData = await categoryResponse.json();
    let cinemaCategoryId = null;
    
    if (categoryData.objects) {
      for (const cat of categoryData.objects) {
        if (cat.category_data?.name === 'Cinema') {
          cinemaCategoryId = cat.id;
          console.log(`Found Cinema category: ${cinemaCategoryId}`);
          break;
        }
      }
    }
    
    if (!cinemaCategoryId) {
      return res.status(500).json({ error: 'Cinema category not found' });
    }
   
    // 3. Get custom attribute definitions
    const customAttrResponse = await fetch(SQUARE_CATALOG_LIST_API_URL+'?types=CUSTOM_ATTRIBUTE_DEFINITION', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const customAttrData = await customAttrResponse.json();
    console.log('Custom attributes response:', JSON.stringify(customAttrData, null, 2));

    let useQRCodeDefId = null;
let useQRCodeKey = null;  // ADD
let onlineDisplayNameDefId = null;
let onlineDisplayNameKey = null;  // ADD
let eventTypeDefId = null;
let eventTypeKey = null;  // ADD
let eventTypeMovieSelectionUid = null;
let distributorDefId = null;
let distributorKey = null;  // ADD
let distributorLibertyHallSelectionUid = null;

if (customAttrData.objects) {
  for (const def of customAttrData.objects) {
    if (def.custom_attribute_definition_data) {
      const attrName = def.custom_attribute_definition_data.name;
      const attrData = def.custom_attribute_definition_data;
      
      if (attrName === 'UseQRCode') {
        useQRCodeDefId = def.id;
        useQRCodeKey = attrData.key;  // ADD
      } else if (attrName === 'Online Display Name') {
        onlineDisplayNameDefId = def.id;
        onlineDisplayNameKey = attrData.key;  // ADD
      } else if (attrName === 'EventType') {
        eventTypeDefId = def.id;
        eventTypeKey = attrData.key;  // ADD
        const selections = attrData.selection_config?.allowed_selections || [];
        for (const sel of selections) {
          if (sel.name === 'Movie') {
            eventTypeMovieSelectionUid = sel.uid;
            break;
          }
        }
      } else if (attrName === 'Distributor') {
        distributorDefId = def.id;
        distributorKey = attrData.key;  // ADD
        const selections = attrData.selection_config?.allowed_selections || [];
        for (const sel of selections) {
          if (sel.name === 'Liberty Hall Cinema') {
            distributorLibertyHallSelectionUid = sel.uid;
            break;
          }
        }
      } 
    }
  }
}
    
    // 4. Create modifier list with all showtimes
    // Each showtime becomes a modifier option in the list
    const modifiers = movieData.showtimes.map((showtime, index) => ({
      type: 'MODIFIER',
      id: `#showtime_${index}`,
      modifier_data: {
        name: showtime, // "Sun 01-18-2026 7:00 PM (Spacement)"
        price_money: { amount: 0, currency: 'USD' },
        ordinal: index + 1
      }
    }));
    
    const modifierListObject = {
      type: 'MODIFIER_LIST',
      id: '#movie_times_modifier',
      modifier_list_data: {
        internal_name: `Show Time (${movieData.title})`,
        name: globalConfig.MODIFIER_NAME_FILTER || 'Show Time', // Display name
        ordinal: 0,
        selection_type: 'SINGLE',
        modifiers: modifiers
      },
      present_at_location_ids: [locationId]
    };
    
    const createModifierResponse = await fetch(SQUARE_CATALOG_OBJECT_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: `${movieData.imdbID}-modifier-${Date.now()}`,
        object: modifierListObject
      })
    });
    
    if (!createModifierResponse.ok) {
      const errorText = await createModifierResponse.text();
      return res.status(500).json({ error: 'Failed to create modifier list', details: errorText });
    }
    
    const modifierData = await createModifierResponse.json();
    const modifierListId = modifierData.catalog_object.id;
    
    console.log(`Created modifier list with ${modifiers.length} showtimes: ${modifierListId}`);
    
    // 5. Upload image (optional, don't fail if it doesn't work)
    let imageId = null;
    const tempImageId = `#image_${movieData.imdbID}_${Date.now()}`;
    if (movieData.posterUrl || movieData.imdbID) {
      try {
        const posterUrl = movieData.posterUrl || omdbPosterUrl(movieData.imdbID);
        if (!posterUrl) throw new Error('No poster URL: set OMDB_API_KEY in Client Settings');

        // Normalize to a real square JPEG regardless of the source's actual
        // format (webp, png, ...) -- see normalizePosterImage().
        let posterBuffer = null;
        let posterFetchOk = true;
        try {
          const normalized = await normalizePosterImage(
            posterUrl.startsWith('data:image/') ? { dataUrl: posterUrl } : { url: posterUrl },
            { square: true }
          );
          posterBuffer = normalized.buffer;
        } catch (normalizeError) {
          console.log(`Poster fetch/normalize failed, skipping image upload: ${normalizeError.message}`);
          posterFetchOk = false;
        }

        if (posterFetchOk && posterBuffer) {
          const FormData = (await import('form-data')).default;
          const formData = new FormData();

          // Create safer filename
          const safeFilename = movieData.title
            .replace(/[^a-z0-9]/gi, '_')
            .replace(/_+/g, '_')
            .toLowerCase()
            .substring(0, 100);

          console.log(`Safe filename: ${safeFilename}_poster.jpg`);

          formData.append('file', posterBuffer, {
            filename: `${safeFilename}_poster.jpg`,
            contentType: 'image/jpeg'
          });
          
          const requestMetadata = {
            idempotency_key: `${movieData.imdbID}-image-${Date.now()}`,
            image: {
              id: tempImageId,
              type: 'IMAGE',
              image_data: {
                caption: movieData.title
              }
            }
          };
          
          formData.append('request', JSON.stringify(requestMetadata));
          
          console.log('Uploading image to Square...');
          console.log('Request metadata:', JSON.stringify(requestMetadata, null, 2));

          // Alternative approach using streams (more reliable with FormData)
          const imageResponse = await new Promise((resolve, reject) => {
            formData.submit({
              protocol: 'https:',
              host: SQUARE_IMAGE_UPLOAD_URL,
              path: '/v2/catalog/images',
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`
              }
            }, (err, res) => {
              if (err) return reject(err);
              let data = '';
              res.on('data', chunk => data += chunk);
              res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, text: () => data }));
            });
          });
          
          const imageResponseText = await imageResponse.text();
          console.log('Image upload response status:', imageResponse.status);
          
          if (imageResponse.ok) {
            const imageData = JSON.parse(imageResponseText);
            imageId = imageData.image?.id;
            console.log(`✅ Image uploaded successfully: ${imageId}`);
          } else {
            console.error('❌ Image upload failed:', imageResponseText);
          }
        }
      } catch (err) {
        console.error('❌ Image upload exception:', err.message);
      }
    }
    
    // 6. Create the item with modifier list
    const itemObject = {
      type: 'ITEM',
      id: '#movie_item',
      item_data: {        
        name: movieData.title,
        description: buildItemDescription(movieData),
        product_type: 'REGULAR',
        skip_modifier_screen: false,
        available_online: true,
        available_for_pickup: false,
        available_electronically: false,
        reporting_category: { id: cinemaCategoryId },
        is_taxable: false,
        //tax_ids: [],
        modifier_list_info: [{
          modifier_list_id: modifierListId,
          min_selected_modifiers: 1,
          max_selected_modifiers: 1,
          enabled: true
        }],
        variations: [
          {
            type: 'ITEM_VARIATION',
            id: '#child_variation',
            item_variation_data: {
              item_id: '#movie_item',
              name: 'Child',
              pricing_type: 'FIXED_PRICING',
              price_money: { amount: 1000, currency: 'USD' },
              track_inventory: true,
              inventory_alert_type: 'LOW_QUANTITY',
              location_overrides: [{
                location_id: locationId,
                track_inventory: true,
                inventory_alert_type: 'LOW_QUANTITY'
              }]
            }
          },
          {
            type: 'ITEM_VARIATION',
            id: '#adult_variation',
            item_variation_data: {
              item_id: '#movie_item',
              name: 'Adult',
              pricing_type: 'FIXED_PRICING',
              price_money: { amount: 1250, currency: 'USD' },
              track_inventory: true,
              inventory_alert_type: 'LOW_QUANTITY',
              location_overrides: [{
                location_id: locationId,
                track_inventory: true,
                inventory_alert_type: 'LOW_QUANTITY'
              }]
            }
          },
          {
            type: 'ITEM_VARIATION',
            id: '#senior_variation',
            item_variation_data: {
              item_id: '#movie_item',
              name: 'Senior',
              pricing_type: 'FIXED_PRICING',
              price_money: { amount: 1100, currency: 'USD' },
              track_inventory: true,
              inventory_alert_type: 'LOW_QUANTITY',
              location_overrides: [{
                location_id: locationId,
                track_inventory: true,
                inventory_alert_type: 'LOW_QUANTITY'
              }]
            }
          }
        ],
        channels: [
          "CH_oNOvSZlMqIPpFYWA9FcMKYGsx0Zjw39xkCPOYRlQuYC",
          "CH_NqTX0cy0Q7Ob557vINmQ4OOfhvj9ZhV6rW4N1gM29945o"
        ]
      },
      present_at_location_ids: [locationId]
    };
    
    if (imageId) {
      itemObject.item_data.image_ids = [imageId];
    }
    
    // Build custom attributes at itemObject level (NOT in item_data)
// Use keys from attribute definitions, not IDs
itemObject.custom_attribute_values = {};

if (useQRCodeKey) {
  itemObject.custom_attribute_values[useQRCodeKey] = {
    boolean_value: true
  };
}

if (onlineDisplayNameKey) {
  itemObject.custom_attribute_values[onlineDisplayNameKey] = {
    string_value: movieData.title
  };
}

if (eventTypeKey && eventTypeMovieSelectionUid) {
  itemObject.custom_attribute_values[eventTypeKey] = {
    selection_uid_values: [eventTypeMovieSelectionUid]
  };
}

if (distributorKey && distributorLibertyHallSelectionUid) {
  itemObject.custom_attribute_values[distributorKey] = {
    selection_uid_values: [distributorLibertyHallSelectionUid]
  };
}

console.log('Creating item...');
console.log('=== CUSTOM ATTRIBUTES BEING SENT ===');
console.log(JSON.stringify(itemObject.custom_attribute_values, null, 2));
console.log('=== END CUSTOM ATTRIBUTES ===');

const createItemResponse = await fetch(SQUARE_CATALOG_OBJECT_API_URL, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    idempotency_key: `${movieData.imdbID}-${Date.now()}`,
    object: itemObject
  })
});

    if (!createItemResponse.ok) {
      const errorText = await createItemResponse.text();
      console.error('CREATE FAILED:', errorText);
      return res.status(500).json({ 
        error: 'Failed to create item in Square',
        details: errorText
      });
    }
    
    const createItemData = await createItemResponse.json();
    console.log('=== SQUARE RESPONSE ===');
console.log(JSON.stringify(createItemData, null, 2));
console.log('=== END RESPONSE ===');
    console.log(`✅ Item created: ${createItemData.catalog_object.id}`);
    
    // 7. Set inventory
    const variationIds = createItemData.catalog_object.item_data.variations.map(v => v.id);
    
    const inventoryChanges = variationIds.map(varId => ({
      type: 'ADJUSTMENT',
      adjustment: {
        catalog_object_id: varId,
        from_state: 'NONE',
        to_state: 'IN_STOCK',
        location_id: locationId,
        quantity: '500',
        occurred_at: new Date().toISOString()
      }
    }));
    
    await fetch(SQUARE_INVENTORY_BATCH_CREATE, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: `inventory-${movieData.imdbID}-${Date.now()}`,
        changes: inventoryChanges
      })
    });
    
    // After successful Square creation, conditionally create calendar events
const shouldCreateCalendarEvents = req.body.createCalendarEvents !== false; // Default true if not specified
// What actually happened with the calendar, for the response message --
// it used to say "Calendar events created." whenever the box was checked.
let calendarNote = '';

if (shouldCreateCalendarEvents && !isCalendarConfigured(globalConfig.CINEMA_CALENDAR_ID)) {
  calendarNote = ' Calendar events were not created: Google Calendar is not set up in Client Settings.';
  console.log('Skipping calendar event creation (Google Calendar not configured)');
} else if (shouldCreateCalendarEvents) {
  try {
    let squareItemUrl = null;
    try {
      const itemId = createItemData.catalog_object.id;
      const itemDetailsResponse = await fetch(SQUARE_CATALOG_OBJECT_API_URL+`/${itemId}?include_related_objects=true`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (itemDetailsResponse.ok) {
        const itemDetails = await itemDetailsResponse.json();
        squareItemUrl = globalConfig.ECOMMERCE_SITE_URL+`/product/${movieData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${itemId}`;
        console.log(`Square item URL: ${squareItemUrl}`);
      }
    } catch (urlError) {
      console.warn('Could not fetch Square item URL:', urlError);
    }
    
    // Extract runtime from movieData
    let runtimeMinutes = 120;
    if (movieData.runtime && movieData.runtime !== '--') {
      const runtimeMatch = movieData.runtime.match(/(\d+)/);
      if (runtimeMatch) {
        runtimeMinutes = parseInt(runtimeMatch[1]);
        console.log(`Using movie runtime: ${runtimeMinutes} minutes`);
      }
    }
    
    // Parse showtime strings
    const parseShowtimeString = (showtimeStr) => {
      const parenthesesMatch = showtimeStr.match(/\(([^)]+)\)/);
      let location = 'Main Theater';
      let descriptors = [];
      
      if (parenthesesMatch) {
        const parts = parenthesesMatch[1].split(',').map(s => s.trim());
        location = parts[0];
        descriptors = parts.slice(1);
      }
      
      const dateTimeMatch = showtimeStr.match(/([A-Za-z]+)\s+(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)/);
      
      if (!dateTimeMatch) {
        console.error(`Unable to parse showtime: ${showtimeStr}`);
        throw new Error(`Invalid showtime format: ${showtimeStr}`);
      }
      
      const [, dayOfWeek, month, day, year, hour, minute, ampm] = dateTimeMatch;
      
      let hour24 = parseInt(hour);
      if (ampm === 'PM' && hour24 !== 12) {
        hour24 += 12;
      } else if (ampm === 'AM' && hour24 === 12) {
        hour24 = 0;
      }
      
      const startDate = new Date(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        hour24,
        parseInt(minute),
        0,
        0
      );
      
      const totalMinutes = runtimeMinutes;
      const endDate = new Date(startDate.getTime() + totalMinutes * 60 * 1000);
      
      // Format as local datetime without timezone indicator (no 'Z')
      // Google Calendar will interpret this with the timeZone field we provide
      const formatLocalDateTime = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const seconds = String(date.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
      };
      
      return {
        location: location,
        descriptors: descriptors,
        startDateTime: formatLocalDateTime(startDate),
        endDateTime: formatLocalDateTime(endDate),
        originalString: showtimeStr
      };
    };
    
    const parsedShowtimes = movieData.showtimes.map(showtimeStr => 
      parseShowtimeString(showtimeStr)
    );
    
    console.log(`Parsed ${parsedShowtimes.length} showtimes for calendar`);
    
    const calendarResponse = await createCalendarEvents(
      movieData,
      parsedShowtimes,
      globalConfig.CINEMA_CALENDAR_ID,
      squareItemUrl,
      req.user.username,
      req.body.userTimezone
    );
    
    if (!calendarResponse.success) {
      console.warn('Calendar events creation failed:', calendarResponse.error);
      calendarNote = ' Calendar events could not be created (see the server log).';
    } else {
      console.log(`✅ Created ${calendarResponse.eventsCreated} calendar events`);
      calendarNote = ' Calendar events created.';
    }
  } catch (calendarError) {
    console.error('Calendar integration error:', calendarError);
    calendarNote = ' Calendar events could not be created (see the server log).';
    // Don't fail the whole request if calendar fails
  }
} else {
  console.log('Skipping calendar event creation (checkbox not checked)');
}

res.json({
  success: true,
  itemId: createItemData.catalog_object.id,
  message: `Successfully created "${movieData.title}" in Square with ${movieData.showtimes.length} showtimes.${calendarNote}`,
  squareUrl: SQUARE_ITEM_LIBRARY_URL+`/${createItemData.catalog_object.id}`
});
    
  } catch (error) {
    console.error('Error:', error);
    if (clientPool) await clientPool.end();
    res.status(500).json({ error: 'Failed to create item', details: error.message });
  }
});

// Create Event Item in Square (matches movie endpoint pattern exactly)
app.post('/api/square/create-event-item', requireAuth, requirePermission('edit'), async (req, res) => {
  let clientPool;
  
  try {
    const { eventData } = req.body;
    
    console.log(`Creating Square item for event: ${eventData.title}`);
    console.log(`Showtimes: ${eventData.showtimes?.length || 0}`);
    
    // Get client configuration
    clientPool = await createClientDbConnection(req.user.dbName);
    await getClientConfiguration(clientPool, req.user.dbName);
    await clientPool.end();
    
    const accessToken = globalConfig.SQUARE_ACCESS_TOKEN;
    const locationId = globalConfig.SQUARE_LOCATION_ID;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Square API not configured' });
    }
    
    if (!locationId) {
      return res.status(500).json({ error: 'Square Location ID not configured' });
    }
    
    // Validate showtimes
    if (!eventData.showtimes || eventData.showtimes.length === 0) {
      return res.status(400).json({ 
        error: 'At least one showtime is required',
        details: 'Please add showtimes before creating the item'
      });
    }
    
    // 1. Check if item already exists
    const searchResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        object_types: ['ITEM'],
        query: {
          exact_query: {
            attribute_name: 'name',
            attribute_value: eventData.title
          }
        }
      })
    });
    
    const searchData = await searchResponse.json();
    
    if (searchData.objects && searchData.objects.length > 0) {
      return res.status(409).json({ 
        error: 'An item with this name already exists in Square.'
      });
    }
    
    // 2. Find Events category
    const categoryResponse = await fetch(SQUARE_CATALOG_LIST_API_URL+'?types=CATEGORY', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const categoryData = await categoryResponse.json();
    let eventsCategoryId = null;
    
    if (categoryData.objects) {
      for (const cat of categoryData.objects) {
        if (cat.category_data?.name === 'Events') {
          eventsCategoryId = cat.id;
          console.log(`Found Events category: ${eventsCategoryId}`);
          break;
        }
      }
    }
    
    if (!eventsCategoryId) {
      return res.status(500).json({ error: 'Events category not found in Square' });
    }
   
    // 3. Get custom attribute definitions
    const customAttrResponse = await fetch(SQUARE_CATALOG_LIST_API_URL+'?types=CUSTOM_ATTRIBUTE_DEFINITION', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    const customAttrData = await customAttrResponse.json();
    console.log('Custom attributes response:', JSON.stringify(customAttrData, null, 2));

    let useQRCodeDefId = null;
    let useQRCodeKey = null;
    let onlineDisplayNameDefId = null;
    let onlineDisplayNameKey = null;
    let eventTypeDefId = null;
    let eventTypeKey = null;
    let eventTypeEventSelectionUid = null;
    let distributorDefId = null;
    let distributorKey = null;
    let distributorLibertyHallSelectionUid = null;

    if (customAttrData.objects) {
      for (const def of customAttrData.objects) {
        if (def.custom_attribute_definition_data) {
          const attrName = def.custom_attribute_definition_data.name;
          const attrData = def.custom_attribute_definition_data;
          
          if (attrName === 'UseQRCode') {
            useQRCodeDefId = def.id;
            useQRCodeKey = attrData.key;
          } else if (attrName === 'Online Display Name') {
            onlineDisplayNameDefId = def.id;
            onlineDisplayNameKey = attrData.key;
          } else if (attrName === 'EventType') {
            eventTypeDefId = def.id;
            eventTypeKey = attrData.key;
            const selections = attrData.selection_config?.allowed_selections || [];
            for (const sel of selections) {
              if (sel.name === 'Live') {
                eventTypeEventSelectionUid = sel.uid;
                break;
              }
            }
          } else if (attrName === 'Distributor') {
            distributorDefId = def.id;
            distributorKey = attrData.key;
            const selections = attrData.selection_config?.allowed_selections || [];
            for (const sel of selections) {
              if (sel.name === 'Liberty Hall Events') {
                distributorLibertyHallSelectionUid = sel.uid;
                break;
              }
            }
          } 
        }
      }
    }
    
    // 4. Create modifier list with all showtimes (SAME AS MOVIE)
    const modifiers = eventData.showtimes.map((showtime, index) => {
      // Extract just the time for abbreviation (Kitchen Name in Square)
      // e.g. "Sun 01-18-2026 7:00 PM (Spacement)" -> "7:00 PM"
      const timeMatch = showtime.match(/(\d{1,2}:\d{2}\s+(?:AM|PM))/);
      const abbreviation = timeMatch ? timeMatch[1] : `T${index + 1}`;
      
      return {
        type: 'MODIFIER',
        id: `#showtime_${index}`,
        modifier_data: {
          name: showtime,
          abbreviation: abbreviation, // This sets "Kitchen Name" in Square
          price_money: { amount: 0, currency: 'USD' },
          ordinal: index + 1
        }
      };
    });
    
    const modifierListObject = {
      type: 'MODIFIER_LIST',
      id: '#event_times_modifier',
      modifier_list_data: {
        internal_name: `Show Time (${eventData.title})`,
        name: globalConfig.MODIFIER_NAME_FILTER || 'Show Time',
        ordinal: 0,
        selection_type: 'SINGLE',
        modifiers: modifiers
      },
      present_at_location_ids: [locationId]
    };
    
    const createModifierResponse = await fetch(SQUARE_CATALOG_OBJECT_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: `${eventData.title.replace(/\s+/g, '-')}-modifier-${Date.now()}`,
        object: modifierListObject
      })
    });
    
    if (!createModifierResponse.ok) {
      const errorText = await createModifierResponse.text();
      return res.status(500).json({ error: 'Failed to create modifier list', details: errorText });
    }
    
    const modifierData = await createModifierResponse.json();
    const modifierListId = modifierData.catalog_object.id;
    
    console.log(`✅ EVENT: Created modifier list: ${modifierListId}`);
    console.log(`   - Number of modifiers: ${modifiers.length}`);
    console.log(`   - Modifiers:`, modifiers.map(m => m.modifier_data.abbreviation).join(', '));
    
    // 5. Upload image (SAME AS MOVIE)
    let imageId = null;
    const tempImageId = `#image_${eventData.title.replace(/\s+/g, '_')}_${Date.now()}`;
    
    if (eventData.posterUrl) {
      try {
        // Normalize to a real square JPEG regardless of the source's actual
        // format (webp, png, ...) -- see normalizePosterImage().
        const normalized = await normalizePosterImage(
          eventData.posterUrl.startsWith('data:image/')
            ? { dataUrl: eventData.posterUrl }
            : { url: eventData.posterUrl },
          { square: true }
        );
        const posterBuffer = normalized.buffer;

        // Upload to Square
        const FormData = (await import('form-data')).default;
        const formData = new FormData();
        
        const safeFilename = eventData.title
          .replace(/[^a-z0-9]/gi, '_')
          .replace(/_+/g, '_')
          .toLowerCase()
          .substring(0, 100);
        
        console.log(`Safe filename: ${safeFilename}_poster.jpg`);
        
        formData.append('file', posterBuffer, {
          filename: `${safeFilename}_poster.jpg`,
          contentType: 'image/jpeg'
        });
        
        const requestMetadata = {
          idempotency_key: `${eventData.title.replace(/\s+/g, '-')}-image-${Date.now()}`,
          image: {
            id: tempImageId,
            type: 'IMAGE',
            image_data: {
              caption: eventData.title
            }
          }
        };
        
        formData.append('request', JSON.stringify(requestMetadata));
        
        console.log('Uploading image to Square...');
        
        const imageResponse = await new Promise((resolve, reject) => {
          formData.submit({
            protocol: 'https:',
            host: SQUARE_IMAGE_UPLOAD_URL,
            path: '/v2/catalog/images',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`
            }
          }, (err, res) => {
            if (err) return reject(err);
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, text: () => data }));
          });
        });
        
        const imageResponseText = await imageResponse.text();
        console.log('Image upload response status:', imageResponse.status);
        
        if (imageResponse.ok) {
          const imageData = JSON.parse(imageResponseText);
          imageId = imageData.image?.id;
          console.log(`✅ Image uploaded successfully: ${imageId}`);
        } else {
          console.error('❌ Image upload failed:', imageResponseText);
        }
      } catch (err) {
        console.error('❌ Image upload exception:', err.message);
      }
    }
    
    // 6. Create the item with modifier list (SAME STRUCTURE AS MOVIE)
    const itemObject = {
      type: 'ITEM',
      id: '#event_item',
      item_data: {
        name: eventData.title,
        description: buildItemDescription(eventData),
        product_type: 'REGULAR',
        skip_modifier_screen: false,
        available_online: true,
        available_for_pickup: false,
        available_electronically: false,
        reporting_category: { id: eventsCategoryId },
        is_taxable: false,
        modifier_list_info: [{
          modifier_list_id: modifierListId,
          min_selected_modifiers: 1,
          max_selected_modifiers: 1,
          enabled: true
        }],
        variations: [
          {
            type: 'ITEM_VARIATION',
            id: '#event_variation',
            item_variation_data: {
              item_id: '#event_item',
              name: 'Regular',
              pricing_type: 'FIXED_PRICING',
              price_money: { amount: 0, currency: 'USD' },
              track_inventory: true,
              inventory_alert_type: 'LOW_QUANTITY',
              location_overrides: [{
                location_id: locationId,
                track_inventory: true,
                inventory_alert_type: 'LOW_QUANTITY'
              }]
            }
          }
        ],
        channels: [
          "CH_oNOvSZlMqIPpFYWA9FcMKYGsx0Zjw39xkCPOYRlQuYC",
          "CH_NqTX0cy0Q7Ob557vINmQ4OOfhvj9ZhV6rW4N1gM29945o"
        ]
      },
      present_at_location_ids: [locationId]
    };
    
    if (imageId) {
      itemObject.item_data.image_ids = [imageId];
    }
    
    console.log(`✅ EVENT: About to create item with modifier list ID: ${modifierListId}`);
    
    // Build custom attributes (SAME AS MOVIE)
    itemObject.custom_attribute_values = {};

    if (useQRCodeKey) {
      itemObject.custom_attribute_values[useQRCodeKey] = {
        boolean_value: true
      };
    }

    if (onlineDisplayNameKey) {
      itemObject.custom_attribute_values[onlineDisplayNameKey] = {
        string_value: eventData.title
      };
    }

    if (eventTypeKey && eventTypeEventSelectionUid) {
      itemObject.custom_attribute_values[eventTypeKey] = {
        selection_uid_values: [eventTypeEventSelectionUid]
      };
    }

    if (distributorKey && distributorLibertyHallSelectionUid) {
      itemObject.custom_attribute_values[distributorKey] = {
        selection_uid_values: [distributorLibertyHallSelectionUid]
      };
    }

    console.log('Creating item...');
    console.log('=== EVENT CUSTOM ATTRIBUTES BEING SENT ===');
    console.log(JSON.stringify(itemObject.custom_attribute_values, null, 2));
    console.log(`   - UseQRCode key: ${useQRCodeKey || 'NOT SET'}`);
    console.log(`   - OnlineDisplayName key: ${onlineDisplayNameKey || 'NOT SET'}`);
    console.log(`   - EventType key: ${eventTypeKey || 'NOT SET'} (UID: ${eventTypeEventSelectionUid || 'NOT SET'})`);
    console.log(`   - Distributor key: ${distributorKey || 'NOT SET'} (UID: ${distributorLibertyHallSelectionUid || 'NOT SET'})`);
    console.log('=== END CUSTOM ATTRIBUTES ===');

    const createItemResponse = await fetch(SQUARE_CATALOG_OBJECT_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: `${eventData.title.replace(/\s+/g, '-')}-item-${Date.now()}`,
        object: itemObject
      })
    });
    
    if (!createItemResponse.ok) {
      const errorText = await createItemResponse.text();
      console.error('CREATE FAILED:', errorText);
      return res.status(500).json({ 
        error: 'Failed to create item in Square',
        details: errorText
      });
    }
    
    const createItemData = await createItemResponse.json();
    console.log('=== EVENT SQUARE RESPONSE ===');
    console.log('Item ID:', createItemData.catalog_object.id);
    console.log('Modifier lists in response:', createItemData.catalog_object.item_data?.modifier_list_info?.length || 0);
    if (createItemData.catalog_object.custom_attribute_values) {
      console.log('Custom attributes in response:', Object.keys(createItemData.catalog_object.custom_attribute_values).length);
      console.log('Custom attribute keys:', Object.keys(createItemData.catalog_object.custom_attribute_values));
    }
    console.log('=== END RESPONSE ===');
    console.log(`✅ Item created: ${createItemData.catalog_object.id}`);
    
    // 7. Set inventory (THIS WAS MISSING!)
    const variationIds = createItemData.catalog_object.item_data.variations.map(v => v.id);
    
    const inventoryChanges = variationIds.map(varId => ({
      type: 'ADJUSTMENT',
      adjustment: {
        catalog_object_id: varId,
        from_state: 'NONE',
        to_state: 'IN_STOCK',
        location_id: locationId,
        quantity: '500',
        occurred_at: new Date().toISOString()
      }
    }));
    
    await fetch(SQUARE_INVENTORY_BATCH_CREATE, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: `inventory-${eventData.title.replace(/\s+/g, '-')}-${Date.now()}`,
        changes: inventoryChanges
      })
    });
    
    // After successful Square creation, conditionally create calendar events  
    const shouldCreateCalendarEvents = req.body.createCalendarEvents !== false;
    // What actually happened with the calendar, for the response message.
    let calendarNote = '';

    if (shouldCreateCalendarEvents && !isCalendarConfigured(globalConfig.EVENT_CALENDAR_ID)) {
      calendarNote = ' Calendar events were not created: Google Calendar is not set up in Client Settings.';
      console.log('Skipping calendar event creation (Google Calendar not configured)');
    } else if (shouldCreateCalendarEvents) {
      try {
        let squareItemUrl = null;
        try {
          const itemId = createItemData.catalog_object.id;
          const itemDetailsResponse = await fetch(SQUARE_CATALOG_OBJECT_API_URL+`/${itemId}?include_related_objects=true`, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            }
          });
          
          if (itemDetailsResponse.ok) {
            const itemDetails = await itemDetailsResponse.json();
            squareItemUrl = globalConfig.ECOMMERCE_SITE_URL+`/product/${eventData.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${itemId}`;
            console.log(`Square item URL: ${squareItemUrl}`);
          }
        } catch (urlError) {
          console.warn('Could not fetch Square item URL:', urlError);
        }
        
        // Extract runtime/duration from eventData (default 2 hours for events)
        let durationMinutes = 120;
        if (eventData.duration && eventData.duration !== '--') {
          const durationMatch = eventData.duration.match(/(\d+)/);
          if (durationMatch) {
            durationMinutes = parseInt(durationMatch[1]);
            console.log(`Using event duration: ${durationMinutes} minutes`);
          }
        }
        
        // Parse showtime strings (USE SAME LOGIC AS MOVIES)
        const parseShowtimeString = (showtimeStr) => {
          const parenthesesMatch = showtimeStr.match(/\(([^)]+)\)/);
          let location = 'Main Theater';
          let descriptors = [];
          
          if (parenthesesMatch) {
            const parts = parenthesesMatch[1].split(',').map(s => s.trim());
            location = parts[0];
            descriptors = parts.slice(1);
          }
          
          const dateTimeMatch = showtimeStr.match(/([A-Za-z]+)\s+(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)/);
          
          if (!dateTimeMatch) {
            console.error(`Unable to parse showtime: ${showtimeStr}`);
            throw new Error(`Invalid showtime format: ${showtimeStr}`);
          }
          
          const [, dayOfWeek, month, day, year, hour, minute, ampm] = dateTimeMatch;
          
          let hour24 = parseInt(hour);
          if (ampm === 'PM' && hour24 !== 12) {
            hour24 += 12;
          } else if (ampm === 'AM' && hour24 === 12) {
            hour24 = 0;
          }
          
          const startDate = new Date(
            parseInt(year),
            parseInt(month) - 1,
            parseInt(day),
            hour24,
            parseInt(minute),
            0,
            0
          );
          
          const totalMinutes = durationMinutes;
          const endDate = new Date(startDate.getTime() + totalMinutes * 60 * 1000);
          
          // Format as local datetime without timezone indicator (no 'Z')
          // Google Calendar will interpret this with the timeZone field we provide
          const formatLocalDateTime = (date) => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const hours = String(date.getHours()).padStart(2, '0');
            const minutes = String(date.getMinutes()).padStart(2, '0');
            const seconds = String(date.getSeconds()).padStart(2, '0');
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
          };
          
          return {
            location: location,
            descriptors: descriptors,
            startDateTime: formatLocalDateTime(startDate),
            endDateTime: formatLocalDateTime(endDate),
            originalString: showtimeStr
          };
        };
        
        const parsedShowtimes = eventData.showtimes.map(showtimeStr => 
          parseShowtimeString(showtimeStr)
        );
        
        console.log(`Parsed ${parsedShowtimes.length} showtimes for calendar`);
        console.log('Sample parsed showtime:', parsedShowtimes[0]);
        
        console.log(`📅 EVENT: Attempting to create calendar events...`);
        console.log(`   - Calendar ID: ${globalConfig.EVENT_CALENDAR_ID || 'NOT SET!'}`);
        console.log(`   - Number of showtimes: ${parsedShowtimes.length}`);
        console.log(`   - Client ID: ${req.user.username}`);
        
        if (!globalConfig.EVENT_CALENDAR_ID) {
          console.error('❌ EVENT_CALENDAR_ID is not set in config!');
        }
        
        const calendarResponse = await createCalendarEvents(
          eventData,
          parsedShowtimes,
          globalConfig.EVENT_CALENDAR_ID,
          squareItemUrl,
          req.user.username,
          req.body.userTimezone
        );
        
        console.log('📅 EVENT: Calendar response:', JSON.stringify(calendarResponse, null, 2));
        
        if (!calendarResponse.success) {
          console.error('❌ EVENT: Calendar events creation failed:', calendarResponse.error);
          calendarNote = ' Calendar events could not be created (see the server log).';
        } else {
          console.log(`✅ Created ${calendarResponse.eventsCreated} calendar events`);
          calendarNote = ' Calendar events created.';
        }
      } catch (calendarError) {
        console.error('❌ EVENT: Calendar integration error:', calendarError);
        console.error('❌ EVENT: Calendar error stack:', calendarError.stack);
        calendarNote = ' Calendar events could not be created (see the server log).';
        // Don't fail the whole request if calendar fails
      }
    } else {
      console.log('Skipping calendar event creation (checkbox not checked)');
    }

    res.json({
      success: true,
      itemId: createItemData.catalog_object.id,
      message: `Successfully created "${eventData.title}" in Square with ${eventData.showtimes.length} showtimes.${calendarNote}`,
      squareUrl: SQUARE_ITEM_LIBRARY_URL+`/${createItemData.catalog_object.id}`
    });
    
  } catch (error) {
    console.error('Error:', error);
    if (clientPool) await clientPool.end();
    res.status(500).json({ error: 'Failed to create event item', details: error.message });
  }
});

// app_mjs_insights_endpoint.js
// Add this endpoint to your app.mjs file

// Insights endpoint - Text-to-SQL with Claude API
app.post('/api/insights/query', requireAuth, requirePermission('admin'), async (req, res) => {
  const clientId = req.user.clientId;
  const { question } = req.body;
  
  console.log(`[Insights] Client ${clientId} asking: ${question}`);
  
  if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Question is required' });
  }
  
  let clientPool;
  
  try {
      // Get client database connection
      clientPool = await createClientDbConnection(req.user.dbName);
      
      // Get database schema context for this client
      const schemaContext = `
You are analyzing a movie and live event ticketing and sales database for a movie theater and event venue. 

**BUSINESS CONTEXT:**
- The business is based in lawrence, kansas.  Please keep that in mind when searching the internet for things like weather patterns.  Location specific questions that users may have.
- QRCodeProducts are TICKETS - each record represents a single ticket for a movie showing or event
- Customers place Orders that contain one or more tickets (QRCodeProducts)
- ProductType indicates what kind of ticket: "Live" for events like concerts or speakers or fundraisers... anything with a live performer, and "Movie" for cinema.
- ProductName contains the movie title or event name (e.g., "The Godfather", "Trivia Night", "Tom Petty")
- When someone buys tickets, an Order is created and linked to QRCodeProducts via QRCodeProductToOrder

**COMMON QUERY PATTERNS:**
- "How many movies sold" = COUNT tickets WHERE ProductType = 'Movie'
- "Best selling movies" = GROUP BY ProductName and COUNT
- "Revenue" = SUM of ProductPrice
- "This month" = WHERE CreatedDate >= DATE_TRUNC('month', CURRENT_DATE)

**DATABASE SCHEMA:**

**Table: "Order"**
Represents a customer purchase/transaction.
- ID (serial, primary key)
- OrderID (text, unique identifier like "ORD-12345")
- CreatedDate (timestamp, when order was placed)
- OrderMetaData (jsonb, additional order information)
- PhoneNumber (text, customer phone)
- LastName (text, customer last name)
- FirstName (text, customer first name)
- EmailAddress (text, customer email)

**Table: "QRCodeProduct"**
Represents individual tickets for movies and events. Each row = 1 ticket.
- ID (serial, primary key)
- QRCode (text, unique QR code for the ticket)
- ProductName (text, **THE MOVIE TITLE OR EVENT NAME** - e.g., "The Godfather (1972)", "Trivia Night", "Tom Petty")
- ProductDate (timestamp, date/time of the movie showing or event)
- ProductLocation (text, venue location like "Main Auditorium", "Little Theater", "Spacement")
- ProductPrice (numeric, ticket price in dollars)
- ProductType (text, "Live" for speakers, podcasts, concerts, fundraisers... anything live, "Movie" = cinema )
- CheckedIn (boolean, whether ticket has been scanned/used)
- Status (text, "valid" = valid ticket, "refunded" = refunded, "cancelled" = cancelled)
- CreatedDate (timestamp, when ticket was purchased)
- TicketHolderName (text, optional name on ticket)

**Table: "QRCodeProductToOrder"**
Junction table linking tickets to orders (many-to-many relationship).
- ID (serial, primary key)
- QRCodeProductID (integer, foreign key to QRCodeProduct.ID)
- OrderID (text, foreign key to Order.OrderID)

**RELATIONSHIPS:**
- One Order can contain many tickets (QRCodeProducts)
- Each ticket (QRCodeProduct) belongs to exactly one Order
- Join pattern: Order -> QRCodeProductToOrder -> QRCodeProduct

**IMPORTANT NOTES:**
- **All table/column names are CASE-SENSITIVE and must be quoted**: "Order", "QRCodeProduct", "ProductName"
- To count movies sold: COUNT(*) FROM "QRCodeProduct" WHERE "ProductType" = 'Movie'
- To get revenue: SUM("ProductPrice") FROM "QRCodeProduct" WHERE "Status" = 'valid'
- ProductName contains the movie/event name - use this for grouping by movie
- Always filter out refunded tickets: WHERE "Status" != 'refunded' (unless specifically asked about refunds)
- Date filtering: Use CURRENT_DATE, DATE_TRUNC(), or explicit date comparisons
- For "best selling" queries: GROUP BY "ProductName" and ORDER BY COUNT(*) DESC

**EXAMPLE QUERIES:**
-- How many movie tickets sold this month:
SELECT COUNT(*) FROM "QRCodeProduct" 
WHERE "ProductType" = 'Movie' 
AND "Status" = 'valid'
AND "CreatedDate" >= DATE_TRUNC('month', CURRENT_DATE);

-- Top 5 best selling movies:
SELECT "ProductName", COUNT(*) as tickets_sold
FROM "QRCodeProduct" 
WHERE "ProductType" = 'Movie' AND "Status" = 'valid'
GROUP BY "ProductName" 
ORDER BY tickets_sold DESC 
LIMIT 5;

-- Total revenue this week:
SELECT SUM("ProductPrice") as total_revenue
FROM "QRCodeProduct"
WHERE "Status" = 'valid'
AND "CreatedDate" >= DATE_TRUNC('week', CURRENT_DATE);
`;

      // Step 1: Call Claude API to generate SQL
      console.log('[Insights] Calling Claude API to generate SQL...');
      
      const sqlGenerationResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
              'Content-Type': 'application/json',
              'x-api-key': globalConfig.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
              model: 'claude-sonnet-5',
              max_tokens: 2000,
              messages: [{
                  role: 'user',
                  content: `${schemaContext}

User question: "${question}"

Generate a PostgreSQL SELECT query to answer this question. Return ONLY the SQL query, no explanation or markdown formatting. The query must be read-only (SELECT only).`
              }]
          })
      });
      
      if (!sqlGenerationResponse.ok) {
          throw new Error(`Claude API error: ${sqlGenerationResponse.status}`);
      }
      
      const sqlData = await sqlGenerationResponse.json();
      let generatedSQL = sqlData.content[0].text.trim();
      
      // Clean up SQL (remove markdown code blocks if present)
      generatedSQL = generatedSQL.replace(/```sql\n?/g, '').replace(/```\n?/g, '').trim();
      
      console.log('[Insights] Generated SQL:', generatedSQL);
      
      // Security check: Ensure it's a SELECT query only
      const sqlUpper = generatedSQL.toUpperCase().trim();
      if (!sqlUpper.startsWith('SELECT')) {
          return res.status(400).json({ 
              error: 'Only SELECT queries are allowed for safety',
              sql: generatedSQL 
          });
      }
      
      // Check for dangerous operations
      const dangerousKeywords = ['DROP ', 'DELETE ', 'UPDATE ', 'INSERT ', 'ALTER ', 'CREATE ', 'TRUNCATE '];
      for (const keyword of dangerousKeywords) {
          if (sqlUpper.includes(keyword)) {
              return res.status(400).json({ 
                  error: `Query contains forbidden operation: ${keyword}`,
                  sql: generatedSQL 
              });
          }
      }
      
      // ---- INSIGHTS SQL HARDENING ----
      // The keyword checks above are a first pass only -- easy to slip past
      // (a newline instead of a space, a CTE, a crafted question). The real
      // guarantees come from the database itself:
      //   1. exactly one statement (no "SELECT 1; COMMIT; DELETE ..." to
      //      escape the read-only transaction),
      //   2. never the credential tables ("Users" password hashes,
      //      "Client".clientSecret + configuration secrets),
      //   3. a READ ONLY transaction with a statement timeout, so Postgres
      //      rejects any write and kills runaway queries.
      const singleStatement = generatedSQL.replace(/;\s*$/, '');
      if (singleStatement.includes(';')) {
          return res.status(400).json({ 
              error: 'Only a single SELECT statement is allowed',
              sql: generatedSQL 
          });
      }
      if (/\b(users|client)\b/i.test(singleStatement)) {
          return res.status(400).json({ 
              error: 'That question needs account or configuration data, which Insights cannot access',
              sql: generatedSQL 
          });
      }
      
      // Step 2: Execute the SQL query
      console.log('[Insights] Executing SQL query (read-only)...');
      
      const roClient = await clientPool.connect();
      let result;
      try {
          await roClient.query('BEGIN READ ONLY');
          await roClient.query("SET LOCAL statement_timeout = '10s'");
          result = await roClient.query(singleStatement);
      } finally {
          await roClient.query('ROLLBACK').catch(() => {});
          roClient.release();
      }
      // ---- END INSIGHTS SQL HARDENING ----
      console.log(`[Insights] Query returned ${result.rows.length} rows`);
      
      // Step 3: Call Claude API to format the results into a natural language answer
console.log('[Insights] Calling Claude API to format results...');

const formattingResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'x-api-key': globalConfig.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2000,
        messages: [{
            role: 'user',
            content: `Original question: "${question}"

SQL query executed: ${generatedSQL}

Query results (${result.rows.length} rows):
${JSON.stringify(result.rows, null, 2)}

Please provide a clear, concise answer to the user's question based on these database results AND any additional information from the web if needed. You have web search available - use it for things like NFL schedules, moon phases, movie releases, local events, etc.

Format the answer in a friendly, conversational way. If showing numbers, format them nicely (add $ for prices, commas for large numbers, etc.). If there are multiple results, present them in an organized way.`
        }],
        tools: [{
            type: 'web_search_20260209',
            name: 'web_search'
        }]
    })
});

if (!formattingResponse.ok) {
    console.error('[Insights] Formatting API error:', formattingResponse.status);
    throw new Error(`Claude API error during formatting: ${formattingResponse.status}`);
}

const formattingData = await formattingResponse.json();

// Log the full response for debugging
console.log('[Insights] Formatting response:', JSON.stringify(formattingData, null, 2));

// Extract text from response - handle different response structures
let answer = ''; // Initialize as empty string
try {
    if (formattingData && formattingData.content && Array.isArray(formattingData.content)) {
        for (const content of formattingData.content) {
            if (content && content.type === 'text' && content.text) {
                answer += content.text;
            }
        }
    } else {
        console.error('[Insights] Unexpected response structure:', formattingData);
        answer = "I received an unexpected response format. Please try again.";
    }
} catch (parseError) {
    console.error('[Insights] Error parsing response:', parseError);
    answer = "I encountered an error processing the response. Please try again.";
}

// Fallback if no answer was generated
if (!answer || answer.length === 0) {
    answer = "I wasn't able to generate an answer. Please try rephrasing your question.";
}

// Safe trim
answer = typeof answer === 'string' ? answer.trim() : String(answer).trim();

console.log('[Insights] Answer generated successfully');

// Return the formatted answer
res.json({
    answer: answer,
    sql: generatedSQL,
    rowCount: result.rows.length
});
      
  } catch (error) {
      console.error('[Insights] Error:', error);
      res.status(500).json({ 
          error: 'Failed to generate insights: ' + error.message 
      });
  } finally {
      // Always close the pool connection
      if (clientPool) {
          await clientPool.end();
      }
  }
});

async function createCalendarEvents(movieData, showtimes, calendarId, squareItemUrl, clientId, userTimezone = 'America/Chicago') {
  try {
    console.log(`[Calendar] Starting calendar event creation for ${movieData.title}`);
    console.log(`[Calendar] Calendar ID: ${calendarId}`);
    console.log(`[Calendar] Number of showtimes: ${showtimes.length}`);
    
    const auth = await getGoogleAuth();
    const calendarClient = calendar({ version: 'v3', auth });
    
    // Upload poster to S3 (if available) using the new uploadPosterToS3 function
    let posterS3Url = null;
    if (movieData.posterUrl || movieData.imdbID) {
      try {
        const posterUrl = movieData.posterUrl || omdbPosterUrl(movieData.imdbID);
        if (!posterUrl) throw new Error('No poster URL: set OMDB_API_KEY in Client Settings');
        const filename = movieData.title || `poster_${Date.now()}`;
        
        console.log(`[Calendar] Uploading poster for calendar events...`);
        posterS3Url = await uploadPosterToS3({
          ...(posterUrl.startsWith('data:image/') ? { dataUrl: posterUrl } : { url: posterUrl }),
          filename: filename,
          square: true // matches the Square catalog item's poster treatment
        }, clientId);
        console.log(`[Calendar] Poster uploaded successfully: ${posterS3Url}`);
        
      } catch (s3Error) {
        console.warn('[Calendar] Could not upload poster to S3:', s3Error.message);
        console.warn('[Calendar] Continuing with calendar creation without poster...');
      }
    } else {
      console.log('[Calendar] No poster URL or IMDB ID provided, skipping poster upload');
    }
    
    const createdEvents = [];
    console.log(`[Calendar] Creating ${showtimes.length} calendar events...`);
    
    
    for (const showtime of showtimes) {
      console.log(`[Calendar] Creating event for: ${showtime.startDateTime}`);
      let eventTitle = movieData.title;
  if (showtime.descriptors && showtime.descriptors.length > 0) {
    const descriptorStr = showtime.descriptors.join(' • ');
    eventTitle = `${movieData.title}   [${descriptorStr}]`;
  }

  const event = {
    summary: eventTitle,
        location: showtime.location,
        description: buildEventDescription(movieData, showtime, squareItemUrl, posterS3Url),
        start: {
          dateTime: showtime.startDateTime,
          timeZone: userTimezone,
        },
        end: {
          dateTime: showtime.endDateTime,
          timeZone: userTimezone,
        },
        colorId: '9',
      };
      
      console.log(`[Calendar] Event object:`, JSON.stringify(event, null, 2));
      
      const response = await calendarClient.events.insert({
        calendarId: calendarId,
        requestBody: event
      });
      
      console.log(`[Calendar] ✅ Event created: ${response.data.id}`);
      console.log(`[Calendar] Event link: ${response.data.htmlLink}`);
      
      createdEvents.push({
        eventId: response.data.id,
        eventLink: response.data.htmlLink,
        showtime: showtime.startDateTime
      });
    }
    
    console.log(`[Calendar] Successfully created ${createdEvents.length} calendar events`);
    
    return {
      success: true,
      eventsCreated: createdEvents.length,
      events: createdEvents
    };
    
  } catch (error) {
    console.error('[Calendar] ERROR creating calendar events:', error);
    console.error('[Calendar] Error stack:', error.stack);
    return {
      success: false,
      error: error.message
    };
  }
}

// ---- MARKETING ENGINE: richer Square item description ----
// Square's own item_data.description was previously just the bare
// OMDB plot (movieData.description). Marketing content (captions, the
// weekly digest) reads from this field, so it's enriched with the same
// rating/genre/runtime/director/cast fields buildEventDescription()
// already assembles for the calendar -- minus the per-showtime location
// and purchase-link button, which don't apply to a single catalog-wide
// description field. Purely additive: same string field, richer text,
// gracefully falls back to just the plot/description if the other
// fields aren't present (movies from OMDB vs. free-form events).
function buildItemDescription(data) {
  let description = '';
  if (data.rated) description += `Rating: ${data.rated}\n`;
  if (data.genre) description += `Genre: ${data.genre}\n`;
  if (data.runtime) description += `Runtime: ${data.runtime}\n`;

  const body = data.plot || data.description || '';
  if (body) description += `\n${body}\n`;

  if (data.director) description += `\nDirector: ${data.director}`;
  if (data.actors) description += `\nCast: ${data.actors}`;

  return description.trim();
}
// ---- end MARKETING ENGINE: richer Square item description ----

function buildEventDescription(movieData, showtime, squareItemUrl, posterUrl) {
  let description = '';

  if (squareItemUrl) {
    description += `\n<a href="${squareItemUrl}">Purchase Tickets</a>: \n\n${squareItemUrl}\n\n`;
    description += `
      [button]
        text=Get Tickets
        link=${squareItemUrl}
        target=_blank
      [/button]
    `;
  }

  description += `${movieData.title} 
${movieData.rated ? `Rating: ${movieData.rated}` : ''}
${movieData.genre ? `Genre: ${movieData.genre}` : ''}
${movieData.runtime ? `Runtime: ${movieData.runtime}` : ''}

${movieData.plot || movieData.description || ''}

Location: ${showtime.location}`;

  // Add descriptors if they exist
  if (showtime.descriptors && showtime.descriptors.length > 0) {
    description += `\n${showtime.descriptors.join(' • ')}`;
  }


  // Add Square purchase link

  if (movieData.director) {
    description += `\n\nDirector: ${movieData.director}`;
  }
  
  if (movieData.actors) {
    description += `\nCast: ${movieData.actors}`;
  }

    // Add poster link
  if (posterUrl) {
    description += `\n\nPoster: ${posterUrl}`;
  }
  
  return description.trim();
}

async function getGoogleAuth() {
  let credentials = globalConfig.GOOGLE_SERVICE_ACCOUNT_KEY;
  
  if (typeof credentials === 'string') {
    try {
      credentials = JSON.parse(credentials);
    } catch (err) {
      throw new Error('Invalid Google Service Account Key JSON');
    }
  }
  
  const auth = new GoogleAuth({
    credentials: credentials,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/drive.file' // Added Drive scope
    ],
  });
  
  return auth;
}


// ---- MARKETING ENGINE ROUTES ----
// Admin UI backing routes for the Marquee Engine schedule editor / status
// page (marketing.html). All requireAuth only, gated client-side by the
// new "marketing" Users.Permissions flag via header-loader.js's
// PAGE_ACCESS map -- same convention as every other permission-gated page
// in this app (there's no server-side per-permission middleware here yet).
// Actual post generation/sending happens in the separate marketingEngine
// Lambda; these routes only read/write MarketingSchedule, MarketingPost,
// and the DIGEST_* Client.configuration keys.

const MARKETING_CHANNELS = ['email', 'facebook', 'instagram', 'tiktok'];

// Square Catalog Search for UseQRCode items, scoped to the configured
// target categories. Deliberately self-contained rather than reusing
// marketingEngine's copy of the same logic -- that Lambda is a separate
// deployable, and app.mjs already does its own inline Square Catalog
// Search calls elsewhere (e.g. create-movie-item) rather than sharing a
// helper, so this matches this file's own existing convention.
async function searchMarketingCatalogItems(accessToken, targetCategories) {
  const searchResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      object_types: ['ITEM'],
      include_related_objects: false
    })
  });

  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    throw new Error(`Square catalog search failed: ${searchResponse.status} ${errorText}`);
  }

  const searchData = await searchResponse.json();
  const items = (searchData.objects || []).filter(obj => obj.type === 'ITEM');

  return items
    .filter(item => {
      // Archiving (item_data.is_archived) just hides an item from the
      // online store/POS -- it's not the same as deletion, so Square's
      // search API still returns it. expireQRCodeSquareModifiers archives
      // old/completed showtimes this way, so without this check every
      // archived item kept showing up as eligible for a marketing post.
      if (item.item_data?.is_archived === true) {
        return false;
      }
      const categoryName = item.item_data?.reporting_category?.name;
      if (targetCategories.length > 0 && categoryName && !targetCategories.some(c => c.toLowerCase() === categoryName.toLowerCase())) {
        return false;
      }
      const attrs = item.custom_attribute_values ? Object.values(item.custom_attribute_values) : [];
      return attrs.some(attr => attr.name === 'UseQRCode' && attr.boolean_value === true);
    })
    .map(item => ({
      squareItemId: item.id,
      name: item.item_data?.name || '(untitled)',
      description: item.item_data?.description || ''
    }));
}

// List active USE_QR_CODE Square items eligible for a marketing schedule.
app.get('/api/marketing/items', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);

    const scheduledResult = await userPool.query(`SELECT DISTINCT "SquareItemID" FROM "MarketingSchedule"`);
    const itemsWithSchedules = new Set(scheduledResult.rows.map(r => r.SquareItemID));
    await userPool.end();

    if (!globalConfig.SQUARE_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: 'Square API not configured' });
    }

    const targetCategories = globalConfig.TARGET_CATEGORIES
      ? globalConfig.TARGET_CATEGORIES.split(',').map(c => c.trim())
      : ['Cinema', 'Events'];

    const items = await searchMarketingCatalogItems(globalConfig.SQUARE_ACCESS_TOKEN, targetCategories);
    items.forEach(item => { item.hasSchedule = itemsWithSchedules.has(item.squareItemId); });
    return res.json({ success: true, items });
  } catch (error) {
    console.error('Error fetching marketing items:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error fetching marketing items' });
  }
});

// ---- SCHEDULE PRESET DATE PREVIEW ----
// Returns the earliest/latest showtime calendar dates for one item, parsed
// from its modifier list (same showtime-string format as parseShowtimeString
// elsewhere in this file). Lets the schedule editor show staff real calendar
// dates next to each day-offset instead of only the abstract "-28 days" --
// matches the Marquee Engine design doc's "generated preview" decision.
async function getItemShowtimeWindow(accessToken, squareItemId) {
  const searchResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ object_types: ['ITEM'], include_related_objects: true })
  });

  if (!searchResponse.ok) {
    const errorText = await searchResponse.text();
    throw new Error(`Square catalog search failed: ${searchResponse.status} ${errorText}`);
  }

  const searchData = await searchResponse.json();
  const item = (searchData.objects || []).find(obj => obj.type === 'ITEM' && obj.id === squareItemId);
  if (!item) return null;

  const modifierListMap = {};
  (searchData.related_objects || [])
    .filter(obj => obj.type === 'MODIFIER_LIST')
    .forEach(m => { modifierListMap[m.id] = m; });

  const dates = [];
  for (const modListInfo of (item.item_data?.modifier_list_info || [])) {
    const modifierList = modifierListMap[modListInfo.modifier_list_id];
    if (!modifierList) continue;
    for (const modifier of (modifierList.modifier_list_data?.modifiers || [])) {
      const parsed = parseShowtimeString(modifier.modifier_data?.name || '');
      if (!parsed) continue;
      dates.push(`${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`);
    }
  }
  if (dates.length === 0) return null;

  dates.sort();
  return { anchorDate: dates[0], lastShowtimeDate: dates[dates.length - 1] };
}

app.get('/api/marketing/items/:squareItemId/window', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);
    await userPool.end();

    if (!globalConfig.SQUARE_ACCESS_TOKEN) {
      return res.status(500).json({ success: false, message: 'Square API not configured' });
    }

    const window = await getItemShowtimeWindow(globalConfig.SQUARE_ACCESS_TOKEN, req.params.squareItemId);
    return res.json({ success: true, window });
  } catch (error) {
    console.error('Error fetching item showtime window:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error fetching item showtime window' });
  }
});
// ---- end SCHEDULE PRESET DATE PREVIEW ----

// Read every channel's schedule for one item.
app.get('/api/marketing/schedules/:squareItemId', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    const result = await userPool.query(
      `SELECT "Channel", "PhaseConfig", "Enabled", "UseAiCaptions", "UpdatedDate"
       FROM "MarketingSchedule" WHERE "SquareItemID" = $1 ORDER BY "Channel"`,
      [req.params.squareItemId]
    );
    await userPool.end();
    return res.json({ success: true, schedules: result.rows });
  } catch (error) {
    console.error('Error fetching marketing schedules:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error fetching marketing schedules' });
  }
});

// Create or update one (item, channel) schedule.
app.put('/api/marketing/schedules/:squareItemId/:channel', requireAuth, requirePermission('marketing'), async (req, res) => {
  const { squareItemId, channel } = req.params;
  const { phaseConfig, enabled, useAiCaptions } = req.body;

  if (!MARKETING_CHANNELS.includes(channel)) {
    return res.status(400).json({ success: false, message: `Channel must be one of: ${MARKETING_CHANNELS.join(', ')}` });
  }
  if (!phaseConfig || !Array.isArray(phaseConfig.offsets)) {
    return res.status(400).json({ success: false, message: 'phaseConfig.offsets array is required' });
  }

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await userPool.query(
      `INSERT INTO "MarketingSchedule" ("SquareItemID", "Channel", "PhaseConfig", "Enabled", "UseAiCaptions")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("SquareItemID", "Channel") DO UPDATE
       SET "PhaseConfig" = $3, "Enabled" = $4, "UseAiCaptions" = $5, "UpdatedDate" = CURRENT_TIMESTAMP`,
      [squareItemId, channel, JSON.stringify(phaseConfig), enabled !== false, useAiCaptions === true]
    );
    await userPool.end();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error saving marketing schedule:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error saving marketing schedule' });
  }
});

// Remove one (item, channel) schedule. Does not touch already-generated
// MarketingPost rows -- those stay for the status page's history.
app.delete('/api/marketing/schedules/:squareItemId/:channel', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await userPool.query(
      `DELETE FROM "MarketingSchedule" WHERE "SquareItemID" = $1 AND "Channel" = $2`,
      [req.params.squareItemId, req.params.channel]
    );
    await userPool.end();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting marketing schedule:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error deleting marketing schedule' });
  }
});

// Remove every channel's schedule for one item in one shot -- the
// item-card-level "Delete Schedule" button, as opposed to the modal's
// per-channel "Remove" buttons. Does not touch already-generated
// MarketingPost rows -- those stay for the status page's history.
app.delete('/api/marketing/schedules/:squareItemId', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await userPool.query(
      `DELETE FROM "MarketingSchedule" WHERE "SquareItemID" = $1`,
      [req.params.squareItemId]
    );
    await userPool.end();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting all marketing schedules for item:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error deleting marketing schedules' });
  }
});

// Status/history view -- same MarketingPost table the poller writes to,
// filtered by status and/or item. Powers both the "pending" and "sent
// history" views on the same admin page.
app.get('/api/marketing/status', requireAuth, requirePermission('marketing'), async (req, res) => {
  const { status, squareItemId, limit } = req.query;
  const conditions = [];
  const values = [];

  if (status) {
    values.push(status);
    conditions.push(`"Status" = $${values.length}`);
  }
  if (squareItemId) {
    values.push(squareItemId);
    conditions.push(`"SquareItemID" = $${values.length}`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rowLimit = Math.min(parseInt(limit) || 200, 1000);

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    const result = await userPool.query(
      `SELECT * FROM "MarketingPost" ${whereClause} ORDER BY "ScheduledFor" DESC LIMIT ${rowLimit}`,
      values
    );
    await userPool.end();
    return res.json({ success: true, posts: result.rows });
  } catch (error) {
    console.error('Error fetching marketing status:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error fetching marketing status' });
  }
});

const DIGEST_CONFIG_KEYS = [
  'DIGEST_ENABLED', 'DIGEST_DAY_OF_WEEK', 'DIGEST_TIME', 'DIGEST_CHANNELS',
  'DIGEST_BACKGROUND_IMAGE_URL', 'DIGEST_TEXT_BOUNDS',
  'DIGEST_DATE_FONT_SIZE', 'DIGEST_DATE_BOLD',
  'DIGEST_EVENT_FONT_SIZE', 'DIGEST_EVENT_BOLD',
  'DIGEST_TIME_FONT_SIZE', 'DIGEST_TIME_BOLD',
  'DIGEST_HEADER_TEXT', 'DIGEST_HEADER_FONT_SIZE', 'DIGEST_HEADER_BOLD',
  'DIGEST_HEADER_IN_IMAGE', 'DIGEST_HEADER_IN_CAPTION',
  'DIGEST_FOOTER_TEXT', 'DIGEST_FOOTER_FONT_SIZE', 'DIGEST_FOOTER_BOLD',
  'DIGEST_FOOTER_IN_IMAGE', 'DIGEST_FOOTER_IN_CAPTION'
];

app.get('/api/marketing/digest-settings', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);
    await userPool.end();

    const settings = {};
    DIGEST_CONFIG_KEYS.forEach(key => { settings[key] = globalConfig[key]; });
    return res.json({ success: true, settings });
  } catch (error) {
    console.error('Error fetching digest settings:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error fetching digest settings' });
  }
});

// On-demand AI caption regeneration for one specific draft post -- the
// "regenerate with AI" touch-up action, distinct from a schedule's
// UseAiCaptions batch opt-in (marketingEngine Lambda). Only ever runs when
// a human clicks it here; never called automatically.
app.post('/api/marketing/posts/:postId/regenerate-caption', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);

    const postResult = await userPool.query(
      `SELECT * FROM "MarketingPost" WHERE "ID" = $1`,
      [req.params.postId]
    );
    if (postResult.rows.length === 0) {
      await userPool.end();
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    const post = postResult.rows[0];
    if (post.Status !== 'draft') {
      await userPool.end();
      return res.status(400).json({ success: false, message: 'Only draft posts can be regenerated' });
    }
    if (post.PostType === 'digest') {
      await userPool.end();
      return res.status(400).json({ success: false, message: 'AI regeneration is for single-item campaign posts -- edit a digest\'s text directly instead.' });
    }

    if (!globalConfig.ANTHROPIC_API_KEY) {
      await userPool.end();
      return res.status(400).json({ success: false, message: 'ANTHROPIC_API_KEY is not configured for this client' });
    }
    if (!globalConfig.SQUARE_ACCESS_TOKEN) {
      await userPool.end();
      return res.status(500).json({ success: false, message: 'Square API not configured' });
    }

    const itemResponse = await fetch(`${SQUARE_CATALOG_OBJECT_API_URL}/${post.SquareItemID}`, {
      headers: { 'Authorization': `Bearer ${globalConfig.SQUARE_ACCESS_TOKEN}` }
    });
    if (!itemResponse.ok) {
      await userPool.end();
      return res.status(502).json({ success: false, message: 'Could not fetch the Square item' });
    }
    const itemData = await itemResponse.json();
    const item = itemData.object;

    const linkChannels = ['email', 'facebook'];
    const purchaseUrl = globalConfig.ECOMMERCE_SITE_URL
      ? `${globalConfig.ECOMMERCE_SITE_URL}/product/${(item.item_data?.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}/${item.id}`
      : null;
    const linkInstruction = linkChannels.includes(post.Channel)
      ? `Include this purchase link naturally: ${purchaseUrl || '(no link available)'}`
      : `Do not include a raw URL -- this platform doesn't support clickable links in captions. End with something like "link in bio" instead.`;

    const prompt = `Write a single short promotional social media caption for ${post.Channel} announcing a movie/event screening.

Title: ${item.item_data?.name || ''}
Venue: ${globalConfig.WEB_HEADER_COMPANY || ''}
Scheduled for: ${new Date(post.ScheduledFor).toLocaleDateString()}
${item.item_data?.description ? `Details: ${item.item_data.description.slice(0, 500)}` : ''}
${linkInstruction}

Write like a real person at the venue dashing off a quick post, not polished ad copy:
- No rhetorical questions, and skip stock phrases like "don't miss out," "unforgettable experience," or "calling all movie lovers."
- At most one exclamation point total -- plain periods are fine and often better.
- Skip em dashes; use a comma or start a new sentence instead.
- Be concrete (the actual title, venue, date, price) rather than leaning on generic hype words like "incredible" or "amazing."
- Keep it a little understated. It should read like something a person typed, not something generated.

Return ONLY the caption text, no explanation, no markdown, no quotes around it.`;

    const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': globalConfig.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!aiResponse.ok) {
      await userPool.end();
      return res.status(502).json({ success: false, message: `Claude API error: ${aiResponse.status}` });
    }
    const aiData = await aiResponse.json();
    const caption = aiData.content?.[0]?.text?.trim();
    if (!caption) {
      await userPool.end();
      return res.status(502).json({ success: false, message: 'Claude returned an empty response' });
    }

    const newContent = { ...(post.PostContent || {}), caption, aiRegenerated: true };
    await userPool.query(
      `UPDATE "MarketingPost" SET "PostContent" = $2, "UpdatedDate" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
      [post.ID, JSON.stringify(newContent)]
    );
    await userPool.end();
    return res.json({ success: true, caption });
  } catch (error) {
    console.error('Error regenerating caption:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error regenerating caption' });
  }
});

// Resolves a Square item's existing catalog image (the same poster used
// everywhere else) to a URL, so marketing posts get an image automatically
// without the admin having to attach one by hand. Returns null on any
// failure -- a missing image shouldn't break caption generation or sending.
async function resolveItemImageUrl(accessToken, item) {
  const imageId = item.item_data?.image_ids?.[0];
  if (!imageId) return null;
  try {
    const response = await fetch(`${SQUARE_CATALOG_OBJECT_API_URL}/${imageId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.object?.image_data?.url || null;
  } catch (error) {
    console.error('Error resolving item image:', error);
    return null;
  }
}

// Edit a post's caption and/or image before it's sent. Restricted to
// draft/approved -- editing something already sent doesn't make sense.
// imageDataUrl (base64, from a file input) is optional; when provided it's
// normalized + uploaded the same way movie posters are elsewhere
// (uploadPosterToS3 -> normalizePosterImage), replacing PostContent.imageUrl.
app.put('/api/marketing/posts/:postId', requireAuth, requirePermission('marketing'), async (req, res) => {
  const { caption, imageDataUrl } = req.body;

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);

    const postResult = await userPool.query(`SELECT * FROM "MarketingPost" WHERE "ID" = $1`, [req.params.postId]);
    if (postResult.rows.length === 0) {
      await userPool.end();
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    const post = postResult.rows[0];
    if (post.Status !== 'draft' && post.Status !== 'approved') {
      await userPool.end();
      return res.status(400).json({ success: false, message: 'Only draft or approved posts can be edited' });
    }

    const newContent = { ...(post.PostContent || {}) };
    if (typeof caption === 'string' && caption.trim()) {
      newContent.caption = caption.trim();
    }
    if (imageDataUrl) {
      newContent.imageUrl = await uploadPosterToS3(
        { dataUrl: imageDataUrl, filename: `marketing-post-${post.ID}`, square: false },
        req.user.dbName
      );
    }

    await userPool.query(
      `UPDATE "MarketingPost" SET "PostContent" = $2, "UpdatedDate" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
      [post.ID, JSON.stringify(newContent)]
    );
    await userPool.end();
    return res.json({ success: true, postContent: newContent });
  } catch (error) {
    console.error('Error editing marketing post:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error editing marketing post' });
  }
});

// Sent posts are permanent history and can't be deleted; anything else
// (draft/approved/failed/skipped) can be cleaned up.
app.delete('/api/marketing/posts/:postId', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);

    const postResult = await userPool.query(`SELECT "Status" FROM "MarketingPost" WHERE "ID" = $1`, [req.params.postId]);
    if (postResult.rows.length === 0) {
      await userPool.end();
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (postResult.rows[0].Status === 'sent') {
      await userPool.end();
      return res.status(400).json({ success: false, message: "Sent posts can't be deleted -- they're kept as history" });
    }

    await userPool.query(`DELETE FROM "MarketingPost" WHERE "ID" = $1`, [req.params.postId]);
    await userPool.end();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting marketing post:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error deleting marketing post' });
  }
});

// Human-review gate the design doc always called for but was never built --
// a draft post can't be sent until a person approves it here first.
app.put('/api/marketing/posts/:postId/approve', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    const result = await userPool.query(
      `UPDATE "MarketingPost" SET "Status" = 'approved', "UpdatedDate" = CURRENT_TIMESTAMP
       WHERE "ID" = $1 AND "Status" = 'draft' RETURNING "ID"`,
      [req.params.postId]
    );
    await userPool.end();
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Post not found or not in draft status' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Error approving marketing post:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error approving marketing post' });
  }
});

// Manual, on-demand real send for one approved post -- email only for now
// (Facebook/Instagram/TikTok real sending is Phase 6, not built). Reuses
// sendEmailWithMultipleAttachments (AWS SES v2 + mailcomposer), the exact
// function that already sends real ticket-confirmation emails, so no new
// dependency or Lambda layer change is needed. One email per active
// MarketingEmailContact, each with its own working unsubscribe link.
app.post('/api/marketing/posts/:postId/send-now', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    const clientConfig = await getClientConfiguration(userPool, req.user.dbName);

    const postResult = await userPool.query(`SELECT * FROM "MarketingPost" WHERE "ID" = $1`, [req.params.postId]);
    if (postResult.rows.length === 0) {
      await userPool.end();
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    const post = postResult.rows[0];

    if (post.Channel !== 'email') {
      await userPool.end();
      return res.status(400).json({ success: false, message: `Sending for ${post.Channel} isn't built yet -- only email is wired up so far.` });
    }
    if (post.Status !== 'approved') {
      await userPool.end();
      return res.status(400).json({ success: false, message: 'Only approved posts can be sent. Approve it first.' });
    }
    // Digest posts round up every active item, not just one -- there's no
    // single Square item to re-check or name here, unlike a campaign post.
    const isDigest = post.PostType === 'digest';
    let item = null;

    if (!isDigest) {
      if (!clientConfig.SQUARE_ACCESS_TOKEN) {
        await userPool.end();
        return res.status(500).json({ success: false, message: 'Square API not configured' });
      }

      // Re-check the source item is still active before firing, same safety
      // net the automatic poller uses (marketingEngine/src/index.mjs
      // sendDuePosts) -- a schedule can outlive the showtime it was built for.
      const itemResponse = await fetch(`${SQUARE_CATALOG_OBJECT_API_URL}/${post.SquareItemID}`, {
        headers: { 'Authorization': `Bearer ${clientConfig.SQUARE_ACCESS_TOKEN}` }
      });
      if (!itemResponse.ok) {
        await userPool.end();
        return res.status(502).json({ success: false, message: 'Could not fetch the Square item' });
      }
      const itemData = await itemResponse.json();
      item = itemData.object;
      if (!item || item.is_deleted || item.item_data?.is_archived) {
        await userPool.query(
          `UPDATE "MarketingPost" SET "Status" = 'skipped', "FailureReason" = $2, "UpdatedDate" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
          [post.ID, 'Source item no longer active in Square']
        );
        await userPool.end();
        return res.status(400).json({ success: false, message: 'This item is no longer active in Square -- post marked skipped.' });
      }
    }

    const contactsResult = await userPool.query(
      `SELECT "Email", "UnsubscribeToken" FROM "MarketingEmailContact" WHERE "Status" = 'active'`
    );
    const contacts = contactsResult.rows;
    if (contacts.length === 0) {
      await userPool.end();
      return res.status(400).json({ success: false, message: 'No active email contacts to send to.' });
    }

    const caption = post.PostContent?.caption || '';
    const venueName = clientConfig.WEB_HEADER_COMPANY || 'IndieTix';
    const subject = isDigest ? `This week at ${venueName}` : `${item.item_data?.name || '(untitled)'} at ${venueName}`;
    const sender = clientConfig.SENDER_EMAIL;
    const baseUrl = clientConfig.STATIC_WEBSITE_URL;

    // PostContent.imageUrl wins if the admin attached/edited one (always
    // true for a digest -- the composed background+text image is set at
    // generation time); otherwise fall back to the Square item's own
    // catalog image automatically.
    const imageUrl = post.PostContent?.imageUrl || (item ? await resolveItemImageUrl(clientConfig.SQUARE_ACCESS_TOKEN, item) : null);
    const escapeForHtml = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let successCount = 0;
    const failures = [];
    for (const contact of contacts) {
      try {
        const unsubscribeUrl = baseUrl
          ? `${baseUrl}/email-unsubscribe.html?token=${contact.UnsubscribeToken}&client=${req.user.dbName}`
          : null;
        const body = `${caption}${unsubscribeUrl ? `\n\n---\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}` : ''}`;
        const html = `
          ${imageUrl ? `<img src="${imageUrl}" alt="" style="max-width:100%;border-radius:8px;margin-bottom:16px;">` : ''}
          <p style="font-size:16px;line-height:1.5;white-space:pre-wrap;">${escapeForHtml(caption)}</p>
          ${unsubscribeUrl ? `<hr style="margin:24px 0;border:none;border-top:1px solid #ddd;"><p style="font-size:12px;color:#888;"><a href="${unsubscribeUrl}">Unsubscribe</a> from these emails.</p>` : ''}
        `;
        await sendEmailWithMultipleAttachments(sender, contact.Email, subject, body, [], html);
        successCount++;
      } catch (sendError) {
        console.error(`Error sending marketing email to ${contact.Email}:`, sendError);
        failures.push(contact.Email);
      }
    }

    const sentContent = {
      ...(post.PostContent || {}),
      imageUrl,
      sentAt: new Date().toISOString(),
      recipientCount: successCount,
      failedRecipients: failures
    };
    const finalStatus = successCount > 0 ? 'sent' : 'failed';
    await userPool.query(
      `UPDATE "MarketingPost" SET "Status" = $2, "PostContent" = $3, "FailureReason" = $4, "UpdatedDate" = CURRENT_TIMESTAMP WHERE "ID" = $1`,
      [post.ID, finalStatus, JSON.stringify(sentContent), failures.length > 0 ? `Failed for: ${failures.join(', ')}` : null]
    );

    await userPool.end();
    return res.json({ success: true, sent: successCount, failed: failures.length });
  } catch (error) {
    console.error('Error sending marketing post:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error sending marketing post' });
  }
});

app.put('/api/marketing/digest-settings', requireAuth, requirePermission('marketing'), async (req, res) => {
  const patch = {};
  DIGEST_CONFIG_KEYS.forEach(key => {
    if (req.body[key] !== undefined) patch[key] = req.body[key];
  });
  if (Object.keys(patch).length === 0 && !req.body.backgroundImageDataUrl) {
    return res.status(400).json({ success: false, message: 'No recognized digest settings provided' });
  }

  let userPool;
  try {
    // backgroundImageDataUrl is handled separately from the rest of the
    // patch -- it needs the sharp normalize/upload round-trip, not a
    // straight JSON merge.
    if (req.body.backgroundImageDataUrl) {
      patch.DIGEST_BACKGROUND_IMAGE_URL = await uploadDigestBackgroundToS3(
        { dataUrl: req.body.backgroundImageDataUrl },
        req.user.dbName
      );
    }

    userPool = await createDbConnection(req.user.dbName);
    await userPool.query(
      `UPDATE "Client" SET "configuration" = "configuration"::jsonb || $1::jsonb, "updatedDate" = CURRENT_TIMESTAMP`,
      [JSON.stringify(patch)]
    );
    await userPool.end();
    return res.json({ success: true, backgroundImageUrl: patch.DIGEST_BACKGROUND_IMAGE_URL });
  } catch (error) {
    console.error('Error saving digest settings:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error saving digest settings' });
  }
});

// ---- CUSTOM SCHEDULE PRESETS ----
// Staff-defined, reusable across every item/channel for this client.
// Stored the same way Digest Settings are -- one JSON key in
// Client.configuration, not a new table -- so no schema/migration is
// needed. Complements the hardcoded built-in presets in marketing.js
// (Standard 4-week ramp, etc.); together they cover the Marquee Engine
// design doc's "Phase builder + presets" decision.
function isValidPresetOffsets(offsets) {
  return Array.isArray(offsets) && offsets.length > 0 && offsets.every(o =>
    o && typeof o.daysFromAnchor === 'number' && typeof o.time === 'string' && /^\d{2}:\d{2}$/.test(o.time)
  );
}

app.get('/api/marketing/custom-presets', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);
    await userPool.end();
    return res.json({
      success: true,
      presets: Array.isArray(globalConfig.MARKETING_SCHEDULE_PRESETS) ? globalConfig.MARKETING_SCHEDULE_PRESETS : []
    });
  } catch (error) {
    console.error('Error fetching custom schedule presets:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error fetching custom schedule presets' });
  }
});

app.post('/api/marketing/custom-presets', requireAuth, requirePermission('marketing'), async (req, res) => {
  const name = (req.body.name || '').trim();
  const offsets = req.body.offsets;

  if (!name || name.length > 60) {
    return res.status(400).json({ success: false, message: 'Preset name is required (max 60 characters)' });
  }
  if (!isValidPresetOffsets(offsets)) {
    return res.status(400).json({ success: false, message: 'offsets must be a non-empty array of { daysFromAnchor: number, time: "HH:MM" }' });
  }

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);

    const existing = Array.isArray(globalConfig.MARKETING_SCHEDULE_PRESETS) ? globalConfig.MARKETING_SCHEDULE_PRESETS : [];
    // Upsert by name (case-insensitive) so re-saving under the same name
    // overwrites rather than duplicating.
    const updated = [
      ...existing.filter(p => (p.name || '').toLowerCase() !== name.toLowerCase()),
      { name, offsets }
    ].sort((a, b) => a.name.localeCompare(b.name));

    await userPool.query(
      `UPDATE "Client" SET "configuration" = "configuration"::jsonb || $1::jsonb, "updatedDate" = CURRENT_TIMESTAMP`,
      [JSON.stringify({ MARKETING_SCHEDULE_PRESETS: updated })]
    );
    await userPool.end();
    return res.json({ success: true, presets: updated });
  } catch (error) {
    console.error('Error saving custom schedule preset:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error saving custom schedule preset' });
  }
});

// Name passed as a query param (not a route param) so preset names with
// slashes or other path-unfriendly characters don't need special routing.
app.delete('/api/marketing/custom-presets', requireAuth, requirePermission('marketing'), async (req, res) => {
  const name = (req.query.name || '').trim();
  if (!name) {
    return res.status(400).json({ success: false, message: 'name query parameter is required' });
  }

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await getClientConfiguration(userPool, req.user.dbName);

    const existing = Array.isArray(globalConfig.MARKETING_SCHEDULE_PRESETS) ? globalConfig.MARKETING_SCHEDULE_PRESETS : [];
    const updated = existing.filter(p => (p.name || '').toLowerCase() !== name.toLowerCase());

    await userPool.query(
      `UPDATE "Client" SET "configuration" = "configuration"::jsonb || $1::jsonb, "updatedDate" = CURRENT_TIMESTAMP`,
      [JSON.stringify({ MARKETING_SCHEDULE_PRESETS: updated })]
    );
    await userPool.end();
    return res.json({ success: true, presets: updated });
  } catch (error) {
    console.error('Error deleting custom schedule preset:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error deleting custom schedule preset' });
  }
});
// ---- end CUSTOM SCHEDULE PRESETS ----

// ---- ADMIN EMAIL CONTACT LIST ----
// Staff-facing counterpart to the public self-signup/unsubscribe routes
// below (email-signup.html / email-unsubscribe.html) -- same
// MarketingEmailContact table, but authenticated and with a hard delete
// available, since this table is deliberately not audit/append-only
// shaped (see its CREATE TABLE comment in clientSetup-Teardown).
app.get('/api/marketing/email-contacts', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    const result = await userPool.query(
      `SELECT "ID", "Email", "Status", "CreatedDate" FROM "MarketingEmailContact" ORDER BY "CreatedDate" DESC`
    );
    await userPool.end();
    return res.json({ success: true, contacts: result.rows });
  } catch (error) {
    console.error('Error fetching email contacts:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error fetching email contacts' });
  }
});

// Admin-entered equivalent of /api/public/email-signup -- same
// upsert-or-reactivate semantics, just authenticated and without needing
// a ?client= param (the JWT already carries dbName).
app.post('/api/marketing/email-contacts', requireAuth, requirePermission('marketing'), async (req, res) => {
  const normalizedEmail = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required' });
  }

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);

    const existing = await userPool.query(
      `SELECT "ID" FROM "MarketingEmailContact" WHERE "Email" = $1`,
      [normalizedEmail]
    );

    let contact;
    if (existing.rows.length > 0) {
      const result = await userPool.query(
        `UPDATE "MarketingEmailContact" SET "Status" = 'active' WHERE "ID" = $1
         RETURNING "ID", "Email", "Status", "CreatedDate"`,
        [existing.rows[0].ID]
      );
      contact = result.rows[0];
    } else {
      const unsubscribeToken = crypto.randomBytes(16).toString('base64url');
      const result = await userPool.query(
        `INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken")
         VALUES ($1, 'active', $2)
         RETURNING "ID", "Email", "Status", "CreatedDate"`,
        [normalizedEmail, unsubscribeToken]
      );
      contact = result.rows[0];
    }

    await userPool.end();
    return res.json({ success: true, contact });
  } catch (error) {
    console.error('Error adding email contact:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error adding email contact' });
  }
});

app.put('/api/marketing/email-contacts/:id/status', requireAuth, requirePermission('marketing'), async (req, res) => {
  const { status } = req.body;
  if (status !== 'active' && status !== 'unsubscribed') {
    return res.status(400).json({ success: false, message: 'status must be "active" or "unsubscribed"' });
  }

  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    const result = await userPool.query(
      `UPDATE "MarketingEmailContact" SET "Status" = $1 WHERE "ID" = $2 RETURNING "ID"`,
      [status, req.params.id]
    );
    await userPool.end();
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Contact not found' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Error updating email contact status:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error updating email contact status' });
  }
});

app.delete('/api/marketing/email-contacts/:id', requireAuth, requirePermission('marketing'), async (req, res) => {
  let userPool;
  try {
    userPool = await createDbConnection(req.user.dbName);
    await userPool.query(`DELETE FROM "MarketingEmailContact" WHERE "ID" = $1`, [req.params.id]);
    await userPool.end();
    return res.json({ success: true });
  } catch (error) {
    console.error('Error deleting email contact:', error);
    if (userPool) await userPool.end();
    return res.status(500).json({ success: false, message: 'Error deleting email contact' });
  }
});
// ---- end ADMIN EMAIL CONTACT LIST ----
// ---- end MARKETING ENGINE ROUTES ----

// ---- PUBLIC EMAIL SIGNUP / UNSUBSCRIBE ROUTES ----
// Same shape as the existing /api/public/opt-in routes above: no JWT,
// client resolved from a ?client= query param via createClientDbConnection
// + getClientConfiguration, same validation regexes. Feeds
// MarketingEmailContact, the admin-curated email list managed from the
// Email List section of marketing.html (see the authenticated
// /api/marketing/email-contacts routes above) and this public signup page.

function isValidClientId(clientId) {
  return typeof clientId === 'string' && /^[A-Za-z0-9]+$/.test(clientId);
}

// A patron scans a QR code at the box office -> lands on email-signup.html
// -> POSTs here. No token needed (unlike opt-in, there's no order to tie
// this to -- it's a fresh, self-identified signup).
app.post('/api/public/email-signup', async (req, res) => {
  const { client: clientId, email } = req.body;

  if (!isValidClientId(clientId)) {
    return res.status(400).json({ success: false, message: 'Invalid client' });
  }
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ success: false, message: 'A valid email address is required' });
  }

  let clientPool;
  try {
    clientPool = await createClientDbConnection(clientId);
    const clientConfig = await getClientConfiguration(clientPool, clientId);

    const existing = await clientPool.query(
      `SELECT "ID", "Status" FROM "MarketingEmailContact" WHERE "Email" = $1`,
      [normalizedEmail]
    );

    if (existing.rows.length > 0) {
      // Already on the list and active -- idempotent, no error. If they'd
      // previously unsubscribed, re-activate (this is a fresh, voluntary
      // signup, same as opt-in's resubscribe handling).
      await clientPool.query(
        `UPDATE "MarketingEmailContact" SET "Status" = 'active' WHERE "ID" = $1`,
        [existing.rows[0].ID]
      );
    } else {
      const unsubscribeToken = crypto.randomBytes(16).toString('base64url');
      await clientPool.query(
        `INSERT INTO "MarketingEmailContact" ("Email", "Status", "UnsubscribeToken")
         VALUES ($1, 'active', $2)`,
        [normalizedEmail, unsubscribeToken]
      );
    }

    await clientPool.end();
    return res.json({ success: true, venueName: clientConfig.WEB_HEADER_COMPANY || null });
  } catch (error) {
    console.error('Error handling email signup:', error);
    if (clientPool) await clientPool.end();
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

// One-click unsubscribe, reached from an email footer link. A GET with a
// side effect is intentional here -- CAN-SPAM requires unsubscribing to be
// a single click, not a login/confirm flow, and flipping Status is
// idempotent so a re-click or link-scanner hitting it twice is harmless.
app.get('/api/public/email-unsubscribe', async (req, res) => {
  const { token, client: clientId } = req.query;

  if (!isValidClientId(clientId)) {
    return res.status(400).json({ success: false, message: 'Invalid client' });
  }
  if (!token || !/^[A-Za-z0-9_-]+$/.test(token) || token.length > 32) {
    return res.status(400).json({ success: false, message: 'Invalid token' });
  }

  let clientPool;
  try {
    clientPool = await createClientDbConnection(clientId);
    await getClientConfiguration(clientPool, clientId);

    const result = await clientPool.query(
      `UPDATE "MarketingEmailContact" SET "Status" = 'unsubscribed'
       WHERE "UnsubscribeToken" = $1
       RETURNING "Email"`,
      [token]
    );
    await clientPool.end();

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'That unsubscribe link is no longer valid.' });
    }
    return res.json({ success: true, message: 'You have been unsubscribed.' });
  } catch (error) {
    console.error('Error handling email unsubscribe:', error);
    if (clientPool) await clientPool.end();
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});
// ---- end PUBLIC EMAIL SIGNUP / UNSUBSCRIBE ROUTES ----

// =============================================================================
// ---- PUBLIC API v1 ----
// =============================================================================
// A small, stable, versioned API a venue can hand to the tools around it
// (third-party door scanners, promoter dashboards, the venue's website, BI).
// Read-mostly; check-in is the only write. Selling stays in Square.
// Spec: openapi.yaml (src/public/openapi.yaml). Proposal: API_V1_PROPOSAL.md.
//
// Contract rules (don't break within /v1):
// - Auth: `Authorization: Bearer itk_<clientId>_<secret>`. The clientId in the
//   key picks the venue's database (same job ?client= does for the public
//   opt-in page), so there is no shared key-lookup table. Only the key's
//   SHA-256 is stored, per venue, in "ApiKey".
// - Success: { data, next_cursor? }. Failure: { error: { code, message } }
//   with a real HTTP status. Never 200-with-a-failure-in-the-body.
// - Times are ISO 8601. ProductDate/ExpirationDate are venue wall-clock
//   (Chicago by convention) and go out WITH their offset; CreatedDate /
//   LastEditedDate are DB-server UTC and go out with 'Z'.
// - Buyer contact info (name/email/phone) only with the 'orders:pii' scope.
// - API keys can only check in real tickets, never skeleton keys.

const V1_SCOPES = ['showtimes:read', 'tickets:read', 'orders:read', 'orders:pii', 'reports:read', 'checkin:write'];
const V1_RATE_LIMIT_PER_MINUTE = 120;
const V1_PAGE_DEFAULT = 50;
const V1_PAGE_MAX = 200;

const v1Error = (res, status, code, message) =>
  res.status(status).json({ error: { code, message } });

const venueTz = () => globalConfig.VENUE_TIMEZONE || VENUE_TZ_FALLBACK;

// Minutes east of UTC for `tz` at instant `date`, e.g. -300 for CDT.
function tzOffsetMinutes(tz, date) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(date).find(p => p.type === 'timeZoneName')?.value || 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}

// 'YYYY-MM-DDTHH:MM:SS' venue wall-clock -> ISO 8601 with that moment's offset.
function wallClockToIso(wall, tz = venueTz()) {
  if (!wall) return null;
  const m = String(wall).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = '00'] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  let offset = tzOffsetMinutes(tz, new Date(asUtc));
  offset = tzOffsetMinutes(tz, new Date(asUtc - offset * 60000)); // settle DST edges
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${hh}:${mm}`;
}

// 'YYYY-MM-DDTHH:MM:SS' DB-server UTC -> 'YYYY-MM-DDTHH:MM:SSZ'.
const utcWallToIso = (wall) => (wall ? `${String(wall).slice(0, 19)}Z` : null);

const isYmd = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

// SQL fragment rendering a timestamp column as 'YYYY-MM-DDTHH:MM:SS' text, so
// pg never converts it through the Node process's local timezone.
const tsText = (col) => `to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS')`;

function v1Limit(req) {
  const n = parseInt(req.query.limit, 10);
  if (!Number.isFinite(n) || n < 1) return V1_PAGE_DEFAULT;
  return Math.min(n, V1_PAGE_MAX);
}

function v1Cursor(req) {
  if (req.query.cursor === undefined) return 0;
  const n = parseInt(req.query.cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const hasScope = (req, scope) => req.apiKey.scopes.includes(scope);

// ---- v1 auth: API key -> venue database ----
const requireApiKey = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const m = key.match(/^itk_([A-Za-z0-9.-]{3,63})_([A-Za-z0-9_-]{20,})$/);
  if (!m) return v1Error(res, 401, 'unauthorized', 'A valid API key is required');
  const clientId = m[1];

  let pool;
  try {
    pool = await createClientDbConnection(clientId);
    await getClientConfiguration(pool, clientId);
  } catch (error) {
    // Unknown client (no secret) and bad DB creds both land here: never
    // reveal which.
    if (pool) await pool.end().catch(() => {});
    return v1Error(res, 401, 'unauthorized', 'A valid API key is required');
  }

  try {
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    // One atomic statement: authenticate, record use, and advance the
    // per-key one-minute rate window.
    const result = await pool.query(
      `UPDATE "ApiKey" SET
         "RateWindowCount" = CASE
           WHEN "RateWindowStart" IS NULL OR "RateWindowStart" < LOCALTIMESTAMP - INTERVAL '1 minute' THEN 1
           ELSE "RateWindowCount" + 1 END,
         "RateWindowStart" = CASE
           WHEN "RateWindowStart" IS NULL OR "RateWindowStart" < LOCALTIMESTAMP - INTERVAL '1 minute' THEN LOCALTIMESTAMP
           ELSE "RateWindowStart" END,
         "LastUsedAt" = LOCALTIMESTAMP
       WHERE "KeyHash" = $1 AND "RevokedAt" IS NULL
       RETURNING "ID", "Scopes", "DataFilter", "RateWindowCount"`,
      [keyHash]
    );
    if (result.rows.length === 0) {
      await pool.end();
      return v1Error(res, 401, 'unauthorized', 'A valid API key is required');
    }
    const row = result.rows[0];
    if (row.RateWindowCount > V1_RATE_LIMIT_PER_MINUTE) {
      await pool.end();
      res.set('Retry-After', '60');
      return v1Error(res, 429, 'rate_limited', `Limit is ${V1_RATE_LIMIT_PER_MINUTE} requests per minute per key`);
    }

    req.apiKey = { id: row.ID, scopes: Array.isArray(row.Scopes) ? row.Scopes : [] };
    req.dataFilter = row.DataFilter && row.DataFilter.datafilters ? row.DataFilter : null;
    req.v1Pool = pool;
    req.v1ClientId = clientId;

    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      console.log(`[v1] key=${req.apiKey.id} ${req.method} ${req.path} -> ${res.statusCode}`);
      pool.end().catch(() => {});
    };
    res.on('finish', finish);
    res.on('close', finish);
    next();
  } catch (error) {
    console.error('[v1] auth error:', error);
    await pool.end().catch(() => {});
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
};

const requireScope = (scope) => (req, res, next) =>
  hasScope(req, scope) ? next() : v1Error(res, 403, 'insufficient_scope', `This key needs the '${scope}' scope`);

// Data-filter clause for queries over "QRCodeProduct" (unaliased), numbered
// from $startIndex. Empty when the key has no filter.
const v1FilterClause = (req, startIndex) => buildDataFilterWhereClause(req.dataFilter, startIndex);

// ---- v1 serializers ----
const TICKET_COLUMNS = `
  "QRCodeProduct"."ID", "QRCodeProduct"."QRCode", "QRCodeProduct"."ProductName", "QRCodeProduct"."ProductType",
  "QRCodeProduct"."ProductLocation", "QRCodeProduct"."ProductVenue", "QRCodeProduct"."ProductSeatCode",
  "QRCodeProduct"."ProductPrice", "QRCodeProduct"."Status", "QRCodeProduct"."CheckedIn",
  "QRCodeProduct"."ProductMetadata", "QRCodeProduct"."FirstName", "QRCodeProduct"."LastName",
  "QRCodeProduct"."EmailAddress", "QRCodeProduct"."PhoneNumber",
  ${tsText('"QRCodeProduct"."ProductDate"')} AS "ProductDateText",
  ${tsText('"QRCodeProduct"."CreatedDate"')} AS "CreatedText",
  ${tsText('"QRCodeProduct"."LastEditedDate"')} AS "EditedText"`;

function serializeTicket(row, req) {
  const modifiers = extractTicketModifiers(row.ProductMetadata);
  const ticket = {
    qr_code: row.QRCode,
    event: row.ProductName,
    event_type: row.ProductType,
    showtime_id: modifiers[0]?.catalog_object_id || null,
    starts_at: wallClockToIso(row.ProductDateText),
    location: row.ProductVenue || row.ProductLocation || null,
    seat: row.ProductSeatCode || null,
    price: row.ProductPrice === null || row.ProductPrice === undefined ? null : Number(row.ProductPrice),
    status: row.Status || 'valid',
    checked_in: row.CheckedIn === true,
    created_at: utcWallToIso(row.CreatedText),
    updated_at: utcWallToIso(row.EditedText)
  };
  if (hasScope(req, 'orders:pii')) {
    ticket.buyer = {
      first_name: row.FirstName || null,
      last_name: row.LastName || null,
      email: row.EmailAddress || null,
      phone: row.PhoneNumber || null
    };
  }
  return ticket;
}

function serializeOrder(row, req) {
  const order = {
    id: row.ID,
    square_order_id: row.OrderID,
    status: row.Status,
    ticket_count: Number(row.TicketCount || 0),
    total: row.Total === null || row.Total === undefined ? null : Number(row.Total),
    created_at: utcWallToIso(row.CreatedText)
  };
  if (hasScope(req, 'orders:pii')) {
    order.buyer = {
      first_name: row.FirstName || null,
      last_name: row.LastName || null,
      email: row.EmailAddress || null,
      phone: row.PhoneNumber || null
    };
  }
  return order;
}

// ---- GET /v1/showtimes ----
// Every showtime in the Square catalog between `from` and `to` (venue-local
// dates, inclusive; default today .. today+30). Cached per venue for 60s.
const v1ShowtimeCache = new Map();

async function listCatalogShowtimes(accessToken) {
  const showtimes = [];
  let cursor;
  do {
    const response = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ object_types: ['ITEM'], include_related_objects: true, ...(cursor ? { cursor } : {}) })
    });
    if (!response.ok) throw new Error(`Square catalog search failed: ${response.status}`);
    const data = await response.json();

    const modifierLists = {};
    (data.related_objects || [])
      .filter(o => o.type === 'MODIFIER_LIST')
      .forEach(o => { modifierLists[o.id] = o; });

    for (const item of (data.objects || [])) {
      if (item.type !== 'ITEM' || item.item_data?.is_archived) continue;
      for (const info of (item.item_data?.modifier_list_info || [])) {
        for (const modifier of (modifierLists[info.modifier_list_id]?.modifier_list_data?.modifiers || [])) {
          const parsed = modifier.modifier_data?.name ? parseShowtimeString(modifier.modifier_data.name) : null;
          if (!parsed) continue;
          const pad = (n) => String(n).padStart(2, '0');
          const ymd = `${parsed.year}-${pad(parsed.month)}-${pad(parsed.day)}`;
          showtimes.push({
            id: modifier.id,
            item_id: item.id,
            title: item.item_data?.name || 'Untitled',
            date: ymd,
            starts_at: wallClockToIso(`${ymd}T${pad(parsed.hour)}:${pad(parsed.minute)}:00`),
            location: parsed.location,
            descriptors: parsed.descriptors || [],
            runtime: extractRuntime(item.item_data?.description || '') || null
          });
        }
      }
    }
    cursor = data.cursor;
  } while (cursor);
  return showtimes;
}

function venueToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: venueTz() }).format(new Date()); // YYYY-MM-DD
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

app.get('/v1/showtimes', requireApiKey, requireScope('showtimes:read'), async (req, res) => {
  const from = req.query.from ?? venueToday();
  const to = req.query.to ?? addDays(from, 30);
  if (!isYmd(from) || !isYmd(to)) return v1Error(res, 400, 'invalid_date', 'from/to must be YYYY-MM-DD');
  if (!globalConfig.SQUARE_ACCESS_TOKEN) return v1Error(res, 503, 'square_not_configured', 'This venue has not connected Square');
  try {
    const cached = v1ShowtimeCache.get(req.v1ClientId);
    let all;
    if (cached && Date.now() - cached.at < 60000) {
      all = cached.showtimes;
    } else {
      all = await listCatalogShowtimes(globalConfig.SQUARE_ACCESS_TOKEN);
      v1ShowtimeCache.set(req.v1ClientId, { at: Date.now(), showtimes: all });
    }
    const data = all
      .filter(s => s.date >= from && s.date <= to)
      .sort((a, b) => (a.starts_at < b.starts_at ? -1 : a.starts_at > b.starts_at ? 1 : 0));
    return res.json({ data });
  } catch (error) {
    console.error('[v1] showtimes error:', error);
    return v1Error(res, 502, 'square_unavailable', 'Could not read showtimes from Square');
  }
});

// ---- GET /v1/tickets ----
app.get('/v1/tickets', requireApiKey, requireScope('tickets:read'), async (req, res) => {
  const cursor = v1Cursor(req);
  if (cursor === null) return v1Error(res, 400, 'invalid_cursor', 'cursor is not valid');
  const limit = v1Limit(req);
  const { event, date, showtime, status, updated_since } = req.query;
  if (date !== undefined && !isYmd(date)) return v1Error(res, 400, 'invalid_date', 'date must be YYYY-MM-DD');
  if (updated_since !== undefined && Number.isNaN(Date.parse(updated_since))) {
    return v1Error(res, 400, 'invalid_date', 'updated_since must be an ISO 8601 timestamp');
  }

  const params = [cursor];
  const where = ['"QRCodeProduct"."ID" > $1'];
  if (event) { params.push(event); where.push(`"QRCodeProduct"."ProductName" ILIKE $${params.length}`); }
  if (date) { params.push(date); where.push(`"QRCodeProduct"."ProductDate"::date = $${params.length}::date`); }
  if (showtime) {
    params.push(JSON.stringify({ modifiers: [{ catalog_object_id: showtime }] }));
    where.push(`"QRCodeProduct"."ProductMetadata" @> $${params.length}::jsonb`);
  }
  if (status) { params.push(status); where.push(`COALESCE("QRCodeProduct"."Status", 'valid') = $${params.length}`); }
  if (updated_since) {
    params.push(updated_since);
    where.push(`"QRCodeProduct"."LastEditedDate" > ($${params.length}::timestamptz AT TIME ZONE 'UTC')`);
  }
  const { whereClause, params: filterParams } = v1FilterClause(req, params.length + 1);
  params.push(...filterParams);
  params.push(limit + 1);

  try {
    const result = await req.v1Pool.query(
      `SELECT ${TICKET_COLUMNS} FROM "QRCodeProduct"
       WHERE ${where.join(' AND ')} ${whereClause}
       ORDER BY "QRCodeProduct"."ID" LIMIT $${params.length}`,
      params
    );
    const rows = result.rows.slice(0, limit);
    const next = result.rows.length > limit ? String(rows[rows.length - 1].ID) : null;
    return res.json({ data: rows.map(r => serializeTicket(r, req)), next_cursor: next });
  } catch (error) {
    console.error('[v1] tickets error:', error);
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
});

// One ticket by QR code, honoring the key's data filter (hidden = 404).
async function v1FindTicket(req, qrCode) {
  const { whereClause, params } = v1FilterClause(req, 2);
  const result = await req.v1Pool.query(
    `SELECT ${TICKET_COLUMNS},
            "QRCodeProduct"."ExpirationDate" < (NOW() AT TIME ZONE $${params.length + 2}) AS "IsExpired"
     FROM "QRCodeProduct"
     WHERE "QRCodeProduct"."QRCode" = $1 ${whereClause}
     ORDER BY "QRCodeProduct"."ID" DESC LIMIT 1`,
    [qrCode, ...params, venueTz()]
  );
  return result.rows[0] || null;
}

app.get('/v1/tickets/:qrCode', requireApiKey, requireScope('tickets:read'), async (req, res) => {
  try {
    const row = await v1FindTicket(req, req.params.qrCode);
    if (!row) return v1Error(res, 404, 'ticket_not_found', 'No ticket with that QR code');
    return res.json({ data: serializeTicket(row, req) });
  } catch (error) {
    console.error('[v1] ticket error:', error);
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
});

// ---- GET /v1/orders ----
// Orders by creation date (venue-local dates, inclusive). A filtered key
// only sees orders with at least one ticket inside its filter.
const ORDER_SELECT = `
  SELECT o."ID", o."OrderID", o."Status", o."FirstName", o."LastName", o."EmailAddress", o."PhoneNumber",
         ${tsText('o."CreatedDate"')} AS "CreatedText",
         COUNT(DISTINCT pto."QRCodeProductID") AS "TicketCount",
         SUM(all_t."ProductPrice") AS "Total"
  FROM "Order" o
  LEFT JOIN "QRCodeProductToOrder" pto ON pto."OrderID" = o."ID"
  LEFT JOIN "QRCodeProduct" all_t ON all_t."ID" = pto."QRCodeProductID"`;

function orderFilterExists(req, startIndex) {
  const { whereClause, params } = v1FilterClause(req, startIndex);
  if (!whereClause) return { sql: '', params: [] };
  return {
    sql: ` AND EXISTS (
      SELECT 1 FROM "QRCodeProductToOrder" fpto
      JOIN "QRCodeProduct" ON "QRCodeProduct"."ID" = fpto."QRCodeProductID"
      WHERE fpto."OrderID" = o."ID" ${whereClause})`,
    params
  };
}

app.get('/v1/orders', requireApiKey, requireScope('orders:read'), async (req, res) => {
  const cursor = v1Cursor(req);
  if (cursor === null) return v1Error(res, 400, 'invalid_cursor', 'cursor is not valid');
  const limit = v1Limit(req);
  const { from, to } = req.query;
  if ((from !== undefined && !isYmd(from)) || (to !== undefined && !isYmd(to))) {
    return v1Error(res, 400, 'invalid_date', 'from/to must be YYYY-MM-DD');
  }

  const params = [cursor];
  const where = ['o."ID" > $1'];
  if (from || to) {
    // Only bind the timezone when it's used -- Postgres can't type an
    // unreferenced parameter.
    params.push(venueTz());
    const localDate = `(o."CreatedDate" AT TIME ZONE 'UTC' AT TIME ZONE $${params.length})::date`;
    if (from) { params.push(from); where.push(`${localDate} >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`${localDate} <= $${params.length}::date`); }
  }
  const filter = orderFilterExists(req, params.length + 1);
  params.push(...filter.params);
  params.push(limit + 1);

  try {
    const result = await req.v1Pool.query(
      `${ORDER_SELECT}
       WHERE ${where.join(' AND ')} ${filter.sql}
       GROUP BY o."ID" ORDER BY o."ID" LIMIT $${params.length}`,
      params
    );
    const rows = result.rows.slice(0, limit);
    const next = result.rows.length > limit ? String(rows[rows.length - 1].ID) : null;
    return res.json({ data: rows.map(r => serializeOrder(r, req)), next_cursor: next });
  } catch (error) {
    console.error('[v1] orders error:', error);
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
});

app.get('/v1/orders/:id', requireApiKey, requireScope('orders:read'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return v1Error(res, 404, 'order_not_found', 'No order with that id');
  try {
    const filter = orderFilterExists(req, 2);
    const result = await req.v1Pool.query(
      `${ORDER_SELECT} WHERE o."ID" = $1 ${filter.sql} GROUP BY o."ID"`,
      [id, ...filter.params]
    );
    if (result.rows.length === 0) return v1Error(res, 404, 'order_not_found', 'No order with that id');

    // A filtered key sees only the order's tickets inside its filter.
    const ticketFilter = v1FilterClause(req, 2);
    const tickets = await req.v1Pool.query(
      `SELECT ${TICKET_COLUMNS} FROM "QRCodeProduct"
       JOIN "QRCodeProductToOrder" pto ON pto."QRCodeProductID" = "QRCodeProduct"."ID"
       WHERE pto."OrderID" = $1 ${ticketFilter.whereClause} ORDER BY "QRCodeProduct"."ID"`,
      [id, ...ticketFilter.params]
    );
    const order = serializeOrder(result.rows[0], req);
    order.tickets = tickets.rows.map(r => serializeTicket(r, req));
    return res.json({ data: order });
  } catch (error) {
    console.error('[v1] order error:', error);
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
});

// ---- POST /v1/checkins, POST /v1/checkins/:qrCode/undo ----
// Real tickets only (never skeleton keys). Only a 'valid' ticket checks in;
// refunded/cancelled/deleted/transferred tickets are refused. Optional
// Idempotency-Key header replays the first response for that key.
async function v1Idempotent(req, res, handler) {
  const idemKey = req.get('Idempotency-Key');
  if (idemKey !== undefined && (idemKey.length < 1 || idemKey.length > 100)) {
    return v1Error(res, 400, 'invalid_idempotency_key', 'Idempotency-Key must be 1-100 characters');
  }
  if (idemKey) {
    const prior = await req.v1Pool.query(
      `SELECT "ResponseStatus", "ResponseBody" FROM "ApiIdempotency" WHERE "ApiKeyID" = $1 AND "IdempotencyKey" = $2`,
      [req.apiKey.id, idemKey]
    );
    if (prior.rows.length > 0) {
      res.set('Idempotent-Replayed', 'true');
      return res.status(prior.rows[0].ResponseStatus).json(prior.rows[0].ResponseBody);
    }
  }
  const { status, body } = await handler();
  if (idemKey) {
    await req.v1Pool.query(
      `INSERT INTO "ApiIdempotency" ("ApiKeyID", "IdempotencyKey", "ResponseStatus", "ResponseBody")
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [req.apiKey.id, idemKey, status, JSON.stringify(body)]
    );
  }
  return res.status(status).json(body);
}

const errorBody = (code, message) => ({ error: { code, message } });

app.post('/v1/checkins', requireApiKey, requireScope('checkin:write'), async (req, res) => {
  const qrCode = req.body?.qr_code;
  if (!qrCode || typeof qrCode !== 'string') return v1Error(res, 400, 'missing_qr_code', 'qr_code is required');
  try {
    return await v1Idempotent(req, res, async () => {
      const ticket = await v1FindTicket(req, qrCode);
      if (!ticket) return { status: 404, body: errorBody('ticket_not_found', 'No ticket with that QR code') };
      if ((ticket.Status || 'valid') !== 'valid') {
        return { status: 409, body: errorBody('ticket_not_valid', `Ticket status is '${ticket.Status}'`) };
      }
      if (ticket.IsExpired) return { status: 409, body: errorBody('ticket_expired', 'Ticket has expired') };

      // Conditional update: two scanners racing on one ticket can't both win.
      const updated = await req.v1Pool.query(
        `UPDATE "QRCodeProduct" SET "CheckedIn" = true, "LastEditedDate" = (NOW() AT TIME ZONE 'UTC')
         WHERE "ID" = $1 AND "CheckedIn" = false AND COALESCE("Status", 'valid') = 'valid'
         RETURNING "ID"`,
        [ticket.ID]
      );
      if (updated.rows.length === 0) {
        return { status: 409, body: errorBody('ticket_already_checked_in', 'Ticket is already checked in') };
      }
      const fresh = await v1FindTicket(req, qrCode);
      return { status: 201, body: { data: serializeTicket(fresh, req) } };
    });
  } catch (error) {
    console.error('[v1] checkin error:', error);
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
});

app.post('/v1/checkins/:qrCode/undo', requireApiKey, requireScope('checkin:write'), async (req, res) => {
  try {
    return await v1Idempotent(req, res, async () => {
      const ticket = await v1FindTicket(req, req.params.qrCode);
      if (!ticket) return { status: 404, body: errorBody('ticket_not_found', 'No ticket with that QR code') };
      const updated = await req.v1Pool.query(
        `UPDATE "QRCodeProduct" SET "CheckedIn" = false, "LastEditedDate" = (NOW() AT TIME ZONE 'UTC')
         WHERE "ID" = $1 AND "CheckedIn" = true RETURNING "ID"`,
        [ticket.ID]
      );
      if (updated.rows.length === 0) {
        return { status: 409, body: errorBody('ticket_not_checked_in', 'Ticket is not checked in') };
      }
      const fresh = await v1FindTicket(req, req.params.qrCode);
      return { status: 200, body: { data: serializeTicket(fresh, req) } };
    });
  } catch (error) {
    console.error('[v1] undo checkin error:', error);
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
});

// ---- GET /v1/reports/sales ----
// Per-showtime (or per-event) counts and revenue over showtime dates
// [from, to] (venue-local, inclusive; default today). Revenue counts only
// tickets still standing (not refunded/cancelled/deleted/transferred).
app.get('/v1/reports/sales', requireApiKey, requireScope('reports:read'), async (req, res) => {
  const from = req.query.from ?? venueToday();
  const to = req.query.to ?? from;
  const groupBy = req.query.group_by ?? 'showtime';
  if (!isYmd(from) || !isYmd(to)) return v1Error(res, 400, 'invalid_date', 'from/to must be YYYY-MM-DD');
  if (!['showtime', 'event'].includes(groupBy)) {
    return v1Error(res, 400, 'invalid_group_by', "group_by must be 'showtime' or 'event'");
  }

  const params = [from, to, ['refunded', 'cancelled', 'canceled', 'deleted', 'transferred']];
  const { whereClause, params: filterParams } = v1FilterClause(req, params.length + 1);
  params.push(...filterParams);
  const groupCols = groupBy === 'showtime'
    ? `"QRCodeProduct"."ProductName", "QRCodeProduct"."ProductDate"`
    : `"QRCodeProduct"."ProductName"`;
  const standing = `COALESCE("QRCodeProduct"."Status", 'valid') <> ALL($3::text[])`;

  try {
    const result = await req.v1Pool.query(
      `SELECT "QRCodeProduct"."ProductName" AS "Event",
              ${groupBy === 'showtime' ? `${tsText('"QRCodeProduct"."ProductDate"')}` : 'NULL'} AS "StartsText",
              COUNT(*) FILTER (WHERE ${standing}) AS "Sold",
              COUNT(*) FILTER (WHERE ${standing} AND "QRCodeProduct"."CheckedIn") AS "CheckedIn",
              COUNT(*) FILTER (WHERE COALESCE("QRCodeProduct"."Status", 'valid') = 'refunded') AS "Refunded",
              COALESCE(SUM("QRCodeProduct"."ProductPrice") FILTER (WHERE ${standing}), 0) AS "Revenue"
       FROM "QRCodeProduct"
       WHERE "QRCodeProduct"."ProductDate"::date BETWEEN $1::date AND $2::date ${whereClause}
       GROUP BY ${groupCols}
       ORDER BY ${groupBy === 'showtime' ? '"QRCodeProduct"."ProductDate", ' : ''}"QRCodeProduct"."ProductName"`,
      params
    );
    const data = result.rows.map(r => ({
      event: r.Event,
      ...(groupBy === 'showtime' ? { starts_at: wallClockToIso(r.StartsText) } : {}),
      sold: Number(r.Sold),
      checked_in: Number(r.CheckedIn),
      refunded: Number(r.Refunded),
      revenue: Number(r.Revenue)
    }));
    return res.json({ data });
  } catch (error) {
    console.error('[v1] sales report error:', error);
    return v1Error(res, 500, 'server_error', 'Something went wrong');
  }
});

// Unknown /v1 paths answer in the v1 error shape, not Express's HTML 404.
app.use('/v1', (req, res) => v1Error(res, 404, 'not_found', 'No such endpoint'));

// ---- API key management (operator UI: Client Settings, client login only) ----
app.get('/api/api-keys', requireAuth, requireClientAuth, async (req, res) => {
  let pool;
  try {
    pool = await createDbConnection(req.user.dbName);
    const result = await pool.query(
      `SELECT "ID", "Name", "KeyPrefix", "Scopes", "DataFilter",
              ${tsText('"CreatedAt"')} AS "CreatedText", ${tsText('"LastUsedAt"')} AS "LastUsedText",
              ${tsText('"RevokedAt"')} AS "RevokedText"
       FROM "ApiKey" ORDER BY "ID" DESC`
    );
    await pool.end();
    return res.json({
      success: true,
      scopes: V1_SCOPES,
      keys: result.rows.map(r => ({
        id: r.ID, name: r.Name, prefix: r.KeyPrefix, scopes: r.Scopes, dataFilter: r.DataFilter,
        createdAt: utcWallToIso(r.CreatedText), lastUsedAt: utcWallToIso(r.LastUsedText),
        revokedAt: utcWallToIso(r.RevokedText)
      }))
    });
  } catch (error) {
    console.error('Error listing API keys:', error);
    if (pool) await pool.end().catch(() => {});
    return res.status(500).json({ success: false, message: 'Could not load API keys' });
  }
});

app.post('/api/api-keys', requireAuth, requireClientAuth, async (req, res) => {
  const { name, scopes, dataFilter } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return res.status(400).json({ success: false, message: 'A name (up to 100 characters) is required' });
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every(s => V1_SCOPES.includes(s))) {
    return res.status(400).json({ success: false, message: `Scopes must be one or more of: ${V1_SCOPES.join(', ')}` });
  }
  if (scopes.includes('orders:pii') && !scopes.includes('orders:read') && !scopes.includes('tickets:read')) {
    return res.status(400).json({ success: false, message: "'orders:pii' only adds buyer details to orders/tickets -- add 'orders:read' or 'tickets:read' too" });
  }
  if (dataFilter !== undefined && dataFilter !== null &&
      (typeof dataFilter !== 'object' || !Array.isArray(dataFilter.datafilters))) {
    return res.status(400).json({ success: false, message: 'dataFilter must look like { "datafilters": [ ... ] }' });
  }

  let pool;
  try {
    const secret = crypto.randomBytes(32).toString('base64url');
    const key = `itk_${req.user.username}_${secret}`;
    const keyHash = crypto.createHash('sha256').update(key).digest('hex');
    const prefix = `itk_${req.user.username}_${secret.slice(0, 4)}`;

    pool = await createDbConnection(req.user.dbName);
    const result = await pool.query(
      `INSERT INTO "ApiKey" ("Name", "KeyPrefix", "KeyHash", "Scopes", "DataFilter")
       VALUES ($1, $2, $3, $4, $5) RETURNING "ID"`,
      [name.trim(), prefix, keyHash, JSON.stringify([...new Set(scopes)]),
        dataFilter && dataFilter.datafilters.length > 0 ? JSON.stringify(dataFilter) : null]
    );
    await pool.end();
    // The only time the full key is ever returned.
    return res.status(201).json({ success: true, id: result.rows[0].ID, key, prefix });
  } catch (error) {
    console.error('Error creating API key:', error);
    if (pool) await pool.end().catch(() => {});
    return res.status(500).json({ success: false, message: 'Could not create API key' });
  }
});

app.post('/api/api-keys/:id/revoke', requireAuth, requireClientAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(404).json({ success: false, message: 'No active key with that id' });
  let pool;
  try {
    pool = await createDbConnection(req.user.dbName);
    const result = await pool.query(
      `UPDATE "ApiKey" SET "RevokedAt" = LOCALTIMESTAMP WHERE "ID" = $1 AND "RevokedAt" IS NULL RETURNING "ID"`,
      [id]
    );
    await pool.end();
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No active key with that id' });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error('Error revoking API key:', error);
    if (pool) await pool.end().catch(() => {});
    return res.status(500).json({ success: false, message: 'Could not revoke API key' });
  }
});
// ---- END PUBLIC API v1 ----

export default app;



// NEW ENDPOINT: Get all showtimes for a specific date and location
// Add this to app.mjs

app.get('/api/square/showtimes-for-date', requireAuth, requirePermission('edit'), async (req, res) => {
  try {
    const { date, location } = req.query;
    
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required' });
    }
    
    // Get client configuration
    const clientPool = await createClientDbConnection(req.user.dbName);
    await getClientConfiguration(clientPool, req.user.dbName);
    await clientPool.end();
    
    const accessToken = globalConfig.SQUARE_ACCESS_TOKEN;
    const cinemaCategoryId = globalConfig.CINEMA_CATEGORY_ID;
    
    if (!accessToken) {
      return res.status(500).json({ error: 'Square API not configured' });
    }
    
    console.log(`📅 Fetching showtimes for date: ${date}, location: ${location || 'all'}`);
    
    // Search for all cinema items (using the working query format from index.mjs)
    const searchResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        object_types: ['ITEM'],
        include_related_objects: true
      })
    });
    
    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      console.error('Square search error:', errorText);
      return res.status(500).json({ error: 'Failed to search Square catalog' });
    }
    
    const searchData = await searchResponse.json();
    console.log(`Found ${searchData.objects?.length || 0} cinema items`);
    
    if (!searchData.objects || searchData.objects.length === 0) {
      return res.json({ showtimes: [] });
    }
    
    // Build a map of related modifier lists
    const modifierListMap = {};
    if (searchData.related_objects) {
      searchData.related_objects
        .filter(obj => obj.type === 'MODIFIER_LIST')
        .forEach(modList => {
          modifierListMap[modList.id] = modList;
        });
    }
    
    // Parse showtimes from all items
    const showtimes = [];
    const targetDate = new Date(date + 'T00:00:00');  // Parse as midnight local time
    const targetDateStr = targetDate.toISOString().split('T')[0];  // YYYY-MM-DD
    
    for (const item of searchData.objects) {
      if (item.type !== 'ITEM') continue;
      
      const title = item.item_data?.name || 'Unknown';
      const runtime = extractRuntime(item.item_data?.description || '');
      
      // Get modifier lists attached to this item
      const modifierListInfo = item.item_data?.modifier_list_info || [];
      
      for (const modListInfo of modifierListInfo) {
        const modifierList = modifierListMap[modListInfo.modifier_list_id];
        if (!modifierList) continue;
        
        const modifiers = modifierList.modifier_list_data?.modifiers || [];
        
        // Parse each modifier (showtime)
        for (const modifier of modifiers) {
          const showtimeName = modifier.modifier_data?.name;
          if (!showtimeName) continue;
          
          const parsed = parseShowtimeString(showtimeName);
          if (!parsed) continue;
          
          // Check if this showtime is on the target date
          const showtimeDate = new Date(parsed.year, parsed.month - 1, parsed.day);
          const showtimeDateStr = showtimeDate.toISOString().split('T')[0];
          
          if (showtimeDateStr !== targetDateStr) continue;
          
          // If location filter is specified, check it matches
          if (location && parsed.location !== location) continue;
          
          // Calculate start and end times
          const startTime = new Date(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute);
          const endTime = new Date(startTime.getTime() + runtime * 60 * 1000);
          
          showtimes.push({
            title,
            location: parsed.location,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
            runtime,  // in minutes
            descriptors: parsed.descriptors || [],
            itemId: item.id
          });
        }
      }
    }
    
    // Sort by start time
    showtimes.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    
    console.log(`📅 Returning ${showtimes.length} showtimes for ${date}`);
    
    res.json({ 
      showtimes,
      date: targetDateStr,
      location: location || 'all'
    });
    
  } catch (error) {
    console.error('Error fetching showtimes:', error);
    res.status(500).json({ 
      error: 'Failed to fetch showtimes',
      details: error.message 
    });
  }
});

(function registerDashboardTodayRoute() {

  const VENUE_TZ_FALLBACK = 'America/Chicago';
  const EXCLUDED_TICKET_STATUSES = ['refunded', 'cancelled', 'canceled', 'transferred'];

  async function getShowtimesForDate(accessToken, dateStr) {
    const searchResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ object_types: ['ITEM'], include_related_objects: true })
    });

    if (!searchResponse.ok) {
      const errorText = await searchResponse.text();
      throw new Error(`Square catalog search failed: ${searchResponse.status} ${errorText}`);
    }

    const searchData = await searchResponse.json();
    if (!searchData.objects || searchData.objects.length === 0) return [];

    const modifierListMap = {};
    (searchData.related_objects || [])
      .filter(o => o.type === 'MODIFIER_LIST')
      .forEach(m => { modifierListMap[m.id] = m; });

    const showtimes = [];

    for (const item of searchData.objects) {
      if (item.type !== 'ITEM') continue;

      const title   = item.item_data?.name || 'Untitled';
      const runtime = extractRuntime(item.item_data?.description || '');

      for (const modListInfo of (item.item_data?.modifier_list_info || [])) {
        const modifierList = modifierListMap[modListInfo.modifier_list_id];
        if (!modifierList) continue;

        for (const modifier of (modifierList.modifier_list_data?.modifiers || [])) {
          const showtimeName = modifier.modifier_data?.name;
          if (!showtimeName) continue;

          const parsed = parseShowtimeString(showtimeName);
          if (!parsed) continue;

          const ymd = `${parsed.year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}`;
          if (ymd !== dateStr) continue;

          const h12  = (parsed.hour % 12) || 12;
          const ampm = parsed.hour < 12 ? 'AM' : 'PM';
          const displayTime = `${h12}:${String(parsed.minute).padStart(2, '0')} ${ampm}`;

          showtimes.push({
            itemId:      item.id,
            modifierId:  modifier.id,
            title,
            location:    parsed.location,
            descriptors: parsed.descriptors || [],
            runtime,
            hour:        parsed.hour,
            minute:      parsed.minute,
            displayTime,
            sortKey:     parsed.hour * 60 + parsed.minute,
            rawModifier: showtimeName
          });
        }
      }
    }

    showtimes.sort((a, b) => a.sortKey - b.sortKey);
    return showtimes;
  }

  /** Pull the modifiers array from a ProductMetadata value (jsonb obj or string). */
  function extractTicketModifiers(productMetadata) {
    if (!productMetadata) return [];
    let meta = productMetadata;
    if (typeof meta === 'string') {
      try { meta = JSON.parse(meta); } catch (_) { return []; }
    }
    return Array.isArray(meta.modifiers) ? meta.modifiers : [];
  }

  /* start of texting endpoints */
// =============================================================================
// PUBLIC OPT-IN ENDPOINTS (for 10DLC SMS opt-in flow)
//
// These are PUBLIC (no requireAuth). Multi-tenant safety comes from the
// clientId query param combined with the OptInToken -- the token is unguessable
// (crypto.randomBytes(16) -> 22 chars base64url) and scoped to a single Order
// row inside a single client's database, so an attacker with only the URL
// gets exactly one order's worth of opt-in-flow capability, no more.
//
// Add these imports at the top of app.mjs alongside the other imports:
//
//   import { sendSms, buildMessageBody, normalizeToE164, maskForDisplay } from 'sms-utils';
//
// Also required: @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner
// (Express app likely already has these for the /api/presigned-download route.)
// =============================================================================

/**
 * Convenience: extract the real client IP behind CloudFront / API Gateway.
 * req.ip alone may be the proxy's IP; X-Forwarded-For carries the real
 * caller as the leftmost entry.
 */
function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        // Leftmost entry is the original client
        return xff.split(',')[0].trim();
    }
    return req.ip || null;
}

/**
 * Build a Chicago-local short label for the SMS body / order summary card.
 * Matches the format used in the webhook lambda so opt-in-triggered
 * messages look identical to auto-fired ones.
 */
function formatEventDateLabel(productDate) {
    if (!productDate) return '';
    try {
        return new Date(productDate).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
            timeZone: 'America/Chicago'
        });
    } catch (e) {
        return '';
    }
}

/**
 * Query all QRCodeProduct rows for a given internal Order.ID.
 * Returns rows with the fields we need to build tickets: QRCode (SKU),
 * ProductName, ProductDate.
 */
async function getTicketsForOrder(pool, orderInternalId) {
    const result = await pool.query(
        `SELECT qp."QRCode", qp."ProductName", qp."ProductDate"
         FROM "QRCodeProductToOrder" j
         JOIN "QRCodeProduct" qp ON qp."ID" = j."QRCodeProductID"
         WHERE j."OrderID" = $1
         ORDER BY qp."ID"`,
        [orderInternalId]
    );
    return result.rows;
}

/**
 * Generate a 7-day presigned S3 URL for a given ticket's SMS PDF, following
 * the same key convention the webhook lambda uses: tickets-out/QR-Ticket-{sku}-sms.pdf
 * in the client's S3 bucket. This is the vertical-orientation PDF, rendered
 * unconditionally for every ticket at webhook time so it's always present
 * here regardless of whether the customer had SMS consent at purchase time.
 */
async function presignTicketPdf(clientConfig, clientId, sku) {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { S3Client } = await import('@aws-sdk/client-s3');

    // Sign with dedicated IAM user credentials, NOT Lambda's STS credentials.
    // STS credentials append X-Amz-Security-Token (~800-1500 chars) to the URL,
    // pushing SMS bodies over AWS's 1600-char messageBody limit. The dedicated
    // user has s3:GetObject only on indietix-*/tickets-out/* -- narrow scope.
    // Credentials come from TICKET_SIGNER_ACCESS_KEY / TICKET_SIGNER_SECRET_KEY
    // env vars, set on the Lambda.
    const s3Client = new S3Client({
        region: process.env.AWS_REGION,
        credentials: {
            accessKeyId: process.env.TICKET_SIGNER_ACCESS_KEY,
            secretAccessKey: process.env.TICKET_SIGNER_SECRET_KEY
        }
    });
    const bucket = clientConfig.S3_BUCKET_PREFIX + clientId.toLowerCase();
    const key = `tickets-out/QR-Ticket-${sku}-sms.pdf`;

    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(s3Client, command, { expiresIn: 604800 }); // 7 days
}

/**
 * Send one SMS per ticket, matching the webhook lambda's per-ticket send
 * pattern. Continues on individual failures so a single S3 hiccup doesn't
 * lose the whole order.
 * Returns { sent, attempted } counts for the response body.
 */
async function sendTicketSmsForOrder({ pool, clientConfig, clientId, tickets, toPhone }) {
    const venueName = clientConfig.WEB_HEADER_COMPANY || 'the venue';
    let sent = 0;
    for (const t of tickets) {
        try {
            const url = await presignTicketPdf(clientConfig, clientId, t.QRCode);
            const dateLabel = formatEventDateLabel(t.ProductDate);
            const content =
                `Your ticket for ${t.ProductName}` +
                (dateLabel ? ` on ${dateLabel}` : '') +
                ` at ${venueName}: ${url}`;
            const body = buildMessageBody(clientConfig.SMS_SENDER_BRAND, content);

            const result = await sendSms({
                toPhone: toPhone,
                body: body,
                clientConfig: clientConfig,
                pool: pool
            });
            if (result.sent) sent++;
            else console.log(`SMS not sent for ticket ${t.QRCode}: ${result.reason}`);
        } catch (err) {
            console.error(`Error sending SMS for ticket ${t.QRCode}:`, err);
        }
    }
    return { sent: sent, attempted: tickets.length };
}


// -----------------------------------------------------------------------------
// GET /api/public/opt-in
//
// Query params: token, client
//
// Returns the info the opt-in page needs to render:
//   200 { orderExists: true, consentState: 'new'|'active'|'revoked',
//         venueName, phoneMasked, tickets: [{name, dateLabel}],
//         previousUnsubscribeDate?, originationNumberDisplay? }
//   404 (no order found for this token)
//   400 (missing/malformed params)
//
// Side effect: when consentState === 'active', we re-fire the ticket SMS(es)
// to the on-file phone before returning. That's what makes returning
// opted-in customers see "we just sent it" instead of a form.
// -----------------------------------------------------------------------------
app.get('/api/public/opt-in', async (req, res) => {
    const { token, client: clientId } = req.query;

    if (!token || !clientId) {
        return res.status(400).json({ success: false, message: 'Missing token or client' });
    }
    if (!/^[A-Za-z0-9]+$/.test(clientId)) {
        return res.status(400).json({ success: false, message: 'Invalid client' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 32) {
        return res.status(400).json({ success: false, message: 'Invalid token' });
    }

    let clientPool;
    try {
        clientPool = await createClientDbConnection(clientId);
        const clientConfig = await getClientConfiguration(clientPool, clientId);

        // Look up the order by token. Returns the phone we captured at
        // purchase time (may be null / walk-up default), and the internal
        // Order.ID for the ticket join below.
        const orderResult = await clientPool.query(
            `SELECT "ID", "PhoneNumber", "FirstName", "LastName", "EmailAddress", "CustomerID"
             FROM "Order"
             WHERE "OptInToken" = $1
             LIMIT 1`,
            [token]
        );
        if (orderResult.rows.length === 0) {
            await clientPool.end();
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        const order = orderResult.rows[0];

        // Fetch tickets for the order summary card
        const ticketRows = await getTicketsForOrder(clientPool, order.ID);
        const tickets = ticketRows.map(t => ({
            name: t.ProductName,
            dateLabel: formatEventDateLabel(t.ProductDate)
        }));

        // Determine consent state from the phone we have on file for
        // this order. The customer may enter a different phone in the
        // form -- that's fine, we re-check server-side on POST.
        const normalizedOnFilePhone = normalizeToE164(order.PhoneNumber);

        let consentState = 'new';
        let previousUnsubscribeDate = null;
        let phoneMasked = null;

        if (normalizedOnFilePhone) {
            const consentResult = await clientPool.query(
                `SELECT "Status", "RevokedAt", "ConsentTimestamp"
                 FROM "SmsConsent"
                 WHERE "PhoneNumber" = $1
                 ORDER BY "ConsentTimestamp" DESC
                 LIMIT 1`,
                [normalizedOnFilePhone]
            );
            if (consentResult.rows.length > 0) {
                const last = consentResult.rows[0];
                if (last.Status === 'active') {
                    consentState = 'active';
                    phoneMasked = maskForDisplay(normalizedOnFilePhone);
                } else if (last.Status === 'revoked') {
                    consentState = 'revoked';
                    if (last.RevokedAt) {
                        previousUnsubscribeDate = new Date(last.RevokedAt).toLocaleDateString('en-US', {
                            month: 'long', day: 'numeric', year: 'numeric'
                        });
                    }
                }
            }
        }

        // Active consent -> auto-fire the ticket SMS(es) so the customer
        // sees "sent!" instead of a form. Don't fail the response if SMS
        // errors -- customer already sees confirmation and can hit the
        // link again.
        if (consentState === 'active' && tickets.length > 0) {
            try {
                await sendTicketSmsForOrder({
                    pool: clientPool,
                    clientConfig: clientConfig,
                    clientId: clientId,
                    tickets: ticketRows,
                    toPhone: normalizedOnFilePhone
                });
            } catch (smsErr) {
                console.error('Auto-resend on GET failed:', smsErr);
            }
        }

        await clientPool.end();
        return res.json({
            success: true,
            orderExists: true,
            consentState: consentState,
            venueName: clientConfig.WEB_HEADER_COMPANY || null,
            phoneMasked: phoneMasked,
            previousUnsubscribeDate: previousUnsubscribeDate,
            originationNumberDisplay: clientConfig.SMS_ORIGINATION_NUMBER || null,
            tickets: tickets
        });

    } catch (err) {
        console.error('GET /api/public/opt-in error:', err);
        if (clientPool) {
            try { await clientPool.end(); } catch (_) {}
        }
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});


// -----------------------------------------------------------------------------
// POST /api/public/opt-in
//
// Body JSON: { token, clientId, phone, consentText }
//
// - Validates inputs and looks up the order.
// - Normalizes phone to E.164 (US/CA only, via the shared sms-utils package).
// - Checks for existing active consent -- if present, this becomes an
//   idempotent re-send (same as GET's auto-resend path).
// - Otherwise INSERTs an SmsConsent row with full audit fields, then
//   fires one SMS per ticket in the order.
// - Returns { success: true, phoneMasked, ticketsSent }.
//
// The SmsConsent write is deliberately append-only: even resubscribes
// insert a NEW row (with PreviousConsentID pointing to the revoked one).
// Never update history. See /areas/indietix.md for the schema convention.
// -----------------------------------------------------------------------------
app.post('/api/public/opt-in', async (req, res) => {
    const { token, clientId, phone, consentText } = req.body || {};

    if (!token || !clientId || !phone || !consentText) {
        return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    if (!/^[A-Za-z0-9]+$/.test(clientId)) {
        return res.status(400).json({ success: false, message: 'Invalid client' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(token) || token.length > 32) {
        return res.status(400).json({ success: false, message: 'Invalid token' });
    }
    if (consentText.length > 1000) {
        return res.status(400).json({ success: false, message: 'Consent text too long' });
    }

    const normalizedPhone = normalizeToE164(phone);
    if (!normalizedPhone) {
        return res.status(400).json({
            success: false,
            message: 'Please enter a valid US or Canadian mobile number.'
        });
    }

    let clientPool;
    try {
        clientPool = await createClientDbConnection(clientId);
        const clientConfig = await getClientConfiguration(clientPool, clientId);

        // Look up order by token; must exist to accept opt-in.
        const orderResult = await clientPool.query(
            `SELECT "ID", "CustomerID", "FirstName", "LastName", "EmailAddress"
             FROM "Order"
             WHERE "OptInToken" = $1
             LIMIT 1`,
            [token]
        );
        if (orderResult.rows.length === 0) {
            await clientPool.end();
            return res.status(404).json({ success: false, message: 'Order not found' });
        }
        const order = orderResult.rows[0];

        // ---- Token-scoped claim (SMS amplification guard) --------------
        // Bind this token to the submitted phone atomically. The WHERE
        // clause allows the update only if OptInClaimedByPhone is either
        // NULL (nobody's claimed it yet) or already equals normalizedPhone
        // (same customer re-submitting, either idempotent or after STOP).
        //
        // If the update returns 0 rows, someone else already claimed the
        // token with a DIFFERENT phone -- reject with 409 before we do any
        // Customer upsert, SmsConsent INSERT, or SMS sends. Kills the
        // "leaked-token → spam many phones" vector at the source.
        //
        // Race-safe: two concurrent POSTs with different phones will both
        // try this UPDATE; Postgres serializes them and only the first
        // wins. The loser gets 0 rows and 409s cleanly.
        const claimResult = await clientPool.query(
            `UPDATE "Order"
             SET "OptInClaimedByPhone" = $1, "LastEditedDate" = CURRENT_TIMESTAMP
             WHERE "ID" = $2
               AND ("OptInClaimedByPhone" IS NULL OR "OptInClaimedByPhone" = $1)
             RETURNING "ID"`,
            [normalizedPhone, order.ID]
        );
        if (claimResult.rows.length === 0) {
            console.warn(`Token-scoped claim rejected: token=${token}, submittedPhone=${normalizedPhone}, orderId=${order.ID}`);
            await clientPool.end();
            return res.status(409).json({
                success: false,
                message: 'This order has already been claimed by a different phone number. If this is a mistake, please contact the venue.'
            });
        }
        // ---- end token-scoped claim ------------------------------------

        // Upsert Customer keyed by the phone the CUSTOMER just typed (not
        // the one on Order). They might have entered a different number
        // than the one Square had -- that's fine, this is the phone they
        // want texts on.
        const customerUpsert = await clientPool.query(
            `INSERT INTO "Customer" ("PhoneNumber", "Email", "FirstName", "LastName", "CreatedDate", "UpdatedDate")
             VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             ON CONFLICT ("PhoneNumber") DO UPDATE SET
                 "Email"       = COALESCE(EXCLUDED."Email", "Customer"."Email"),
                 "FirstName"   = COALESCE(EXCLUDED."FirstName", "Customer"."FirstName"),
                 "LastName"    = COALESCE(EXCLUDED."LastName", "Customer"."LastName"),
                 "UpdatedDate" = CURRENT_TIMESTAMP
             RETURNING "ID"`,
            [normalizedPhone, order.EmailAddress || null, order.FirstName || null, order.LastName || null]
        );
        const customerId = customerUpsert.rows[0].ID;

        // Find any prior consent for this phone. Two things drive off this:
        //   1. If active already -> idempotent re-send, no new INSERT.
        //   2. If revoked -> new INSERT gets PreviousConsentID pointing here.
        const priorResult = await clientPool.query(
            `SELECT "ID", "Status"
             FROM "SmsConsent"
             WHERE "PhoneNumber" = $1
             ORDER BY "ConsentTimestamp" DESC
             LIMIT 1`,
            [normalizedPhone]
        );
        const priorRow = priorResult.rows[0] || null;
        const isResubscribe = priorRow && priorRow.Status === 'revoked';

        // Idempotent path: already active. Skip the INSERT, still fire the
        // SMS resend, return success. This handles double-submits and
        // repeat visits to the URL.
        if (priorRow && priorRow.Status === 'active') {
            const tickets = await getTicketsForOrder(clientPool, order.ID);
            const smsResult = await sendTicketSmsForOrder({
                pool: clientPool,
                clientConfig: clientConfig,
                clientId: clientId,
                tickets: tickets,
                toPhone: normalizedPhone
            });
            await clientPool.end();
            return res.json({
                success: true,
                phoneMasked: maskForDisplay(normalizedPhone),
                ticketsSent: smsResult.sent,
                idempotent: true
            });
        }

        // Insert the audit row. Capture everything the customer saw and
        // did: verbatim consent text, the URL they were on, their IP,
        // their user agent, our SMS campaign ID, and (for resubscribes)
        // the ID of the revoked row they're superseding.
        const consentUrl = `${clientConfig.STATIC_WEBSITE_URL}/opt-in/${token}?client=${clientId}`;
        const consentInsert = await clientPool.query(
            `INSERT INTO "SmsConsent" (
                "CustomerID", "PhoneNumber", "Status", "OptInMethod",
                "ConsentText", "ConsentURL", "IPAddress", "UserAgent",
                "CampaignID", "PreviousConsentID", "ConsentTimestamp", "CreatedDate"
             ) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
             RETURNING "ID"`,
            [
                customerId,
                normalizedPhone,
                isResubscribe ? 'web_resubscribe' : 'web_initial',
                consentText,
                consentUrl,
                getClientIp(req),
                (req.get('User-Agent') || '').slice(0, 500),
                clientConfig.SMS_CAMPAIGN_ID || null,
                isResubscribe ? priorRow.ID : null
            ]
        );
        console.log(`SmsConsent inserted: ID=${consentInsert.rows[0].ID}, phone=${normalizedPhone}, method=${isResubscribe ? 'web_resubscribe' : 'web_initial'}`);

        // Backfill this customer's ID onto the Order if it wasn't set
        // (e.g. walk-up sale where webhook couldn't resolve a customer).
        if (!order.CustomerID) {
            await clientPool.query(
                `UPDATE "Order" SET "CustomerID" = $1, "LastEditedDate" = CURRENT_TIMESTAMP WHERE "ID" = $2`,
                [customerId, order.ID]
            );
        }

        // Fire the ticket SMS(es). sendSms rechecks consent internally as
        // belt-and-suspenders -- the row we just inserted satisfies that
        // check, so this will succeed for a well-configured client
        // (campaign ID + origination number both present in config).
        const tickets = await getTicketsForOrder(clientPool, order.ID);
        const smsResult = await sendTicketSmsForOrder({
            pool: clientPool,
            clientConfig: clientConfig,
            clientId: clientId,
            tickets: tickets,
            toPhone: normalizedPhone
        });

        await clientPool.end();
        return res.json({
            success: true,
            phoneMasked: maskForDisplay(normalizedPhone),
            ticketsSent: smsResult.sent,
            ticketsAttempted: smsResult.attempted,
            resubscribe: isResubscribe
        });

    } catch (err) {
        console.error('POST /api/public/opt-in error:', err);
        if (clientPool) {
            try { await clientPool.end(); } catch (_) {}
        }
        return res.status(500).json({
            success: false,
            message: 'Something went wrong. Please try again in a moment.'
        });
    }
});

  /* end of texting endpoints */

  app.get('/api/dashboard/today', requireAuth, requirePermission(...PERMS_DOOR), async (req, res) => {
    const debug = req.query.debug === '1' || req.query.debug === 'true';
    const dbg = {};
    let clientPool;
    try {
      clientPool = await createClientDbConnection(req.user.dbName);
      await getClientConfiguration(clientPool, req.user.dbName);
      await clientPool.end();
      clientPool = null;

      const accessToken = globalConfig.SQUARE_ACCESS_TOKEN;
      if (!accessToken) {
        return res.status(500).json({ error: 'Square API not configured' });
      }

      const tz = globalConfig.VENUE_TIMEZONE || VENUE_TZ_FALLBACK;

      // Optional ?date=YYYY-MM-DD to view a day other than today (dashboard's
      // calendar picker) -- defaults to today in the venue's own timezone,
      // exactly as before this was added. Kept as a plain calendar-date
      // string, never parsed into a Date object for actual use, so it flows
      // into the same CAST(:today AS date) SQL bracket below with no
      // timezone conversion either way.
      const requestedDate = typeof req.query.date === 'string' ? req.query.date.trim() : '';
      // Date.parse('2026-02-30') doesn't reject an impossible day-of-month --
      // it silently rolls over to 2026-03-02. A native <input type="date">
      // can't actually produce that through the UI, but a direct API call
      // could, so round-trip the parsed value back to Y-M-D and compare.
      const dateMatch = requestedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const parsedMs = dateMatch ? Date.parse(requestedDate) : NaN;
      const isValidDateStr = !!dateMatch && !isNaN(parsedMs) &&
        new Date(parsedMs).toISOString().slice(0, 10) === requestedDate;
      const todayStr = isValidDateStr
        ? requestedDate
        : new Intl.DateTimeFormat('en-CA', {
            timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
          }).format(new Date());

      console.log(`[dashboard] Building ${isValidDateStr ? 'requested' : 'today'} view for ${todayStr} (${tz})`);

      const showtimes = await getShowtimesForDate(accessToken, todayStr);
      console.log(`[dashboard] ${showtimes.length} showtime(s) found.`);
      if (debug) {
        dbg.date = todayStr;
        dbg.showtimeCount = showtimes.length;
        dbg.showtimeModifierIds = showtimes.map(s => s.modifierId);
      }

      if (showtimes.length === 0) {
        return res.json({
          date: todayStr, timezone: tz,
          generatedAt: new Date().toISOString(),
          filtered: false, eventCount: 0, events: [],
          ...(debug ? { _debug: dbg } : {})
        });
      }

      // ----- Ticket query --------------------------------------------------
      const dbCredentials = await getDatabaseCredentials(req.user.dbName);
      const { QRCodeProduct } = await initializeModelForClient(req.user.dbName, dbCredentials);
      const sequelize = QRCodeProduct.sequelize;

      // Explicit scalar placeholders for the status exclusion — NO array
      // binding. Each excluded status gets its own :excN replacement.
      const replacements = { today: todayStr };
      const statusPlaceholders = EXCLUDED_TICKET_STATUSES.map((status, i) => {
        replacements[`exc${i}`] = status;
        return `:exc${i}`;
      });

      // Sub-user data filter -> optional AND( OR(...) ) block.
      let filterApplied = false;
      let filterSql = '';
      if (req.dataFilter && req.dataFilter.datafilters && req.dataFilter.datafilters.length > 0) {
        const ors = [];
        req.dataFilter.datafilters.forEach((filter, i) => {
          const parts = [];
          if (filter.date) {
            parts.push(`DATE("ProductDate") = :f_date_${i}`);
            replacements[`f_date_${i}`] = filter.date;
          }
          if (filter.event) {
            parts.push(`"ProductName" ILIKE :f_event_${i}`);
            replacements[`f_event_${i}`] = eventExactPattern(filter.event);
          }
          if (filter.eventContains) {
            parts.push(`"ProductName" ILIKE :f_econtains_${i}`);
            replacements[`f_econtains_${i}`] = eventContainsPattern(filter.eventContains);
          }
          if (filter.eventType) {
            parts.push(`"ProductType" ILIKE :f_etype_${i}`);
            replacements[`f_etype_${i}`] = normalizeEventType(filter.eventType);
          }
          if (parts.length) ors.push('(' + parts.join(' AND ') + ')');
        });
        if (ors.length) {
          filterSql = ' AND (' + ors.join(' OR ') + ')';
          filterApplied = true;
        }
      }

      // ProductDate is `timestamp without time zone`. Bracket today +/- 1 day
      // by casting the bound date string; this is timezone-safe regardless of
      // the Lambda's own clock.
      const sql = `
        SELECT "CheckedIn", "ProductName", "ProductDate", "Status", "ProductMetadata"
        FROM "QRCodeProduct"
        WHERE "ProductDate" >= (CAST(:today AS date) - INTERVAL '1 day')
          AND "ProductDate" <  (CAST(:today AS date) + INTERVAL '2 days')
          AND LOWER(COALESCE("Status", '')) NOT IN (${statusPlaceholders.join(', ')})
          ${filterSql}
      `;

      let ticketRows;
      try {
        ticketRows = await sequelize.query(sql, {
          replacements,
          type: sequelize.QueryTypes.SELECT
        });
      } catch (queryError) {
        // Surface the DB error as JSON instead of letting it 502.
        console.error('[dashboard] Ticket query failed:', queryError);
        return res.status(500).json({
          error: 'Ticket query failed',
          details: queryError.message,
          ...(debug ? { _debug: { ...dbg, sql: sql.trim(), replacements } } : {})
        });
      }

      console.log(`[dashboard] ${ticketRows.length} ticket row(s) returned`
        + (filterApplied ? ' (filtered)' : ' (unfiltered)') + '.');

      if (debug) {
        dbg.filterApplied = filterApplied;
        dbg.ticketRowCount = ticketRows.length;
        dbg.sampleTicket = ticketRows[0]
          ? {
              ProductName: ticketRows[0].ProductName,
              ProductDate: ticketRows[0].ProductDate,
              Status: ticketRows[0].Status,
              CheckedIn: ticketRows[0].CheckedIn,
              metadataType: typeof ticketRows[0].ProductMetadata,
              modifierIds: extractTicketModifiers(ticketRows[0].ProductMetadata)
                .map(m => m && m.catalog_object_id)
            }
          : null;
      }

      // ----- Aggregate -----------------------------------------------------
      const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const byModifierId = {};
      const byTitle = {};

      for (const row of ticketRows) {
        const isCheckedIn = row.CheckedIn === true;
        const modifiers = extractTicketModifiers(row.ProductMetadata);

        let attributed = false;
        for (const mod of modifiers) {
          const modId = mod && mod.catalog_object_id;
          if (!modId) continue;
          if (!byModifierId[modId]) byModifierId[modId] = { sold: 0, checkedIn: 0 };
          byModifierId[modId].sold += 1;
          if (isCheckedIn) byModifierId[modId].checkedIn += 1;
          attributed = true;
        }
        if (!attributed) {
          const key = norm(row.ProductName);
          if (!byTitle[key]) byTitle[key] = [];
          byTitle[key].push({ sold: 1, checkedIn: isCheckedIn ? 1 : 0 });
        }
      }

      if (debug) {
        dbg.distinctTicketModifierIds = Object.keys(byModifierId);
        dbg.titleFallbackKeys = Object.keys(byTitle);
      }

      const usedTitle = {};
      const events = [];

      for (const st of showtimes) {
        let sold = 0, checkedIn = 0, matchedBy = 'none';

        const exact = byModifierId[st.modifierId];
        if (exact) {
          sold = exact.sold;
          checkedIn = exact.checkedIn;
          matchedBy = 'modifier_id';
        } else {
          const key = norm(st.title);
          const bucket = byTitle[key];
          if (bucket && bucket.length) {
            const idx = usedTitle[key] || 0;
            if (idx < bucket.length) {
              sold = bucket[idx].sold;
              checkedIn = bucket[idx].checkedIn;
              matchedBy = 'title';
            }
            usedTitle[key] = idx + 1;
          }
        }

        if (filterApplied && matchedBy === 'none') continue;

        events.push({
          title:       st.title,
          location:    st.location,
          displayTime: st.displayTime,
          runtime:     st.runtime,
          descriptors: st.descriptors,
          itemId:      st.itemId,
          modifierId:  st.modifierId,
          ticketsSold: sold,
          checkedIn:   checkedIn,
          matchedBy
        });
      }

      const trimmed = events.slice(0, 12);

      return res.json({
        date:        todayStr,
        timezone:    tz,
        generatedAt: new Date().toISOString(),
        filtered:    filterApplied,
        eventCount:  trimmed.length,
        events:      trimmed,
        ...(debug ? { _debug: dbg } : {})
      });

    } catch (error) {
      console.error('[dashboard] Error building today view:', error);
      if (clientPool) { try { await clientPool.end(); } catch (_) { /* ignore */ } }
      return res.status(500).json({
        error: 'Failed to build dashboard',
        details: error.message
      });
    }
  });

})();

// Helper function to parse showtime string
// Format: "Sun 01-18-2026 7:00 PM (Main Theater, Sold Out)"
function parseShowtimeString(showtimeStr) {
  try {
    // Extract date and time
    const dateTimeMatch = showtimeStr.match(/([A-Za-z]+)\s+(\d{2})-(\d{2})-(\d{4})\s+(\d{1,2}):(\d{2})\s+(AM|PM)/);
    if (!dateTimeMatch) return null;
    
    const [, dayOfWeek, month, day, year, hour, minute, ampm] = dateTimeMatch;
    
    // Convert to 24-hour format
    let hour24 = parseInt(hour);
    if (ampm === 'PM' && hour24 !== 12) {
      hour24 += 12;
    } else if (ampm === 'AM' && hour24 === 12) {
      hour24 = 0;
    }
    
    // Extract location and descriptors from parentheses
    const parenthesesMatch = showtimeStr.match(/\(([^)]+)\)/);
    let location = 'Main Theater';  // default
    let descriptors = [];
    
    if (parenthesesMatch) {
      const parts = parenthesesMatch[1].split(',').map(s => s.trim());
      location = parts[0];
      descriptors = parts.slice(1);
    }
    
    return {
      year: parseInt(year),
      month: parseInt(month),
      day: parseInt(day),
      hour: hour24,
      minute: parseInt(minute),
      location,
      descriptors
    };
  } catch (error) {
    console.error('Error parsing showtime string:', showtimeStr, error);
    return null;
  }
}

// Helper function to extract runtime from description
// Looks for patterns like "Runtime: 120 min" or "120 minutes" in description
function extractRuntime(description) {
  const defaultRuntime = 120;  // 2 hours default
  
  if (!description) return defaultRuntime;
  
  // Try to find "Runtime: XXX" pattern
  const runtimeMatch = description.match(/Runtime:\s*(\d+)/i);
  if (runtimeMatch) {
    return parseInt(runtimeMatch[1]);
  }
  
  // Try to find "XXX min" or "XXX minutes"
  const minMatch = description.match(/(\d+)\s*min/i);
  if (minMatch) {
    return parseInt(minMatch[1]);
  }
  
  return defaultRuntime;
}



