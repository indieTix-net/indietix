const { Client } = require('pg');
const { S3Client, CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command, DeleteObjectsCommand, CopyObjectCommand, PutObjectCommand, PutBucketPolicyCommand, PutBucketCorsCommand, PutPublicAccessBlockCommand } = require('@aws-sdk/client-s3');
const { SecretsManagerClient, GetSecretValueCommand, CreateSecretCommand, DeleteSecretCommand } = require('@aws-sdk/client-secrets-manager');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Initialize AWS clients
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });

/**
 * Validates username for S3 bucket naming compliance
 * @param {string} username - Username to validate
 * @returns {boolean} - True if valid, throws error if not
 */
function validateUsername(username) {
  if (!username || typeof username !== 'string') {
    throw new Error('Username is required and must be a string');
  }
  
  const lowerUsername = username.toLowerCase();
  
  // S3 bucket naming rules
  if (lowerUsername.length < 3 || lowerUsername.length > 63) {
    throw new Error('Username must be between 3 and 63 characters long');
  }
  
  // Must start and end with letter or number
  if (!/^[a-z0-9]/.test(lowerUsername) || !/[a-z0-9]$/.test(lowerUsername)) {
    throw new Error('Username must begin and end with a letter or number');
  }
  
  // Can only contain lowercase letters, numbers, dots, and hyphens
  if (!/^[a-z0-9.-]+$/.test(lowerUsername)) {
    throw new Error('Username can only contain letters, numbers, dots (.), and hyphens (-)');
  }
  
  // Must not contain two adjacent periods
  if (/\.\./.test(lowerUsername)) {
    throw new Error('Username must not contain consecutive dots (..)');
  }
  
  // Must not be formatted as an IP address
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipRegex.test(lowerUsername)) {
    throw new Error('Username cannot be formatted as an IP address');
  }
  
  console.log(`Username validation passed: ${username}`);
  return true;
}

/**
 * Derives (or sanitizes an explicitly-provided) per-client film-code prefix
 * for bdor_for_date's "Film Code" column. Restricted to 2-4 uppercase
 * letters/digits since the value is interpolated directly into the
 * function's SQL body at creation time (same pattern this file already
 * uses for theaterName), not passed as a query parameter.
 * @param {string} [explicitPrefix] - Caller-supplied override
 * @param {string} [theaterName] - Used to derive initials when no override is given
 * @param {string} username - Client username; last-resort fallback
 * @returns {string} - 2-4 char uppercase alphanumeric prefix
 */
function deriveFilmCodePrefix(explicitPrefix, theaterName, username) {
  const sanitize = (value) => (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const fromOverride = sanitize(explicitPrefix).slice(0, 4);
  if (fromOverride.length >= 2) return fromOverride;

  if (theaterName) {
    const initials = theaterName
      .trim()
      .split(/\s+/)
      .map(word => word[0])
      .join('')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 4);
    if (initials.length >= 2) return initials;
  }

  const fromUsername = sanitize(username).slice(0, 2);
  if (fromUsername.length === 2) return fromUsername;

  return 'XX';
}

/**
 * Retrieves database credentials from AWS Secrets Manager
 * @param {string} secretName - The secret name to retrieve
 * @returns {Promise<Object>} - Database credentials object
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

// ---- ADMIN DB CREDENTIALS ----
// Environments built by bootstrap.sh pass their OWN Aurora cluster's
// RDS-managed master secret + endpoint (DB_ADMIN_SECRET_ARN / DB_HOST), so
// onboarding always lands on this environment's cluster and survives RDS's
// automatic password rotation. Production predates that and keeps its
// hand-made fixed-name secret, so it's the fallback. Found 2026-10-29: a
// bootstrap environment relying on the fixed name silently onboarded onto
// a DIFFERENT environment's cluster.
async function getAdminDbCredentials() {
  if (process.env.DB_ADMIN_SECRET_ARN && process.env.DB_HOST) {
    const master = await getDatabaseCredentials(process.env.DB_ADMIN_SECRET_ARN);
    return {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT || '5432',
      username: master.username,
      password: master.password,
      ssl: 'true'
    };
  }
  return getDatabaseCredentials('indieTix/rds/clients/indietix/credentials');
}

// Never log credentials: the raw event carries the venue's master login
// secret, Square keys and an optional admin password.
const REDACTED_EVENT_FIELDS = ['clientSecret', 'square_access_token', 'square_signature_key', 'admin_password', 'settings'];
const redactEvent = (event) =>
  JSON.stringify(event, (key, value) => (REDACTED_EVENT_FIELDS.includes(key) && value ? '[REDACTED]' : value), 2);

/**
 * Creates AWS Secrets Manager secret for client database credentials
 * @param {string} clientUsername - Client username
 * @param {string} clientSecret - Client password (cleartext)
 * @param {Object} baseDbConfig - Base database configuration for host/port/ssl
 */
async function createClientSecret(clientUsername, clientSecret, baseDbConfig) {
  const secretName = `indieTix/rds/clients/${clientUsername}/credentials`;
  console.log(`Creating AWS secret: ${secretName}`);
  
  const secretValue = {
    username: clientUsername,
    password: clientSecret,
    host: baseDbConfig.host,
    port: baseDbConfig.port,
    ssl: baseDbConfig.ssl ? 'true' : 'false',
    database: clientUsername
  };
  
  try {
    const command = new CreateSecretCommand({
      Name: secretName,
      Description: `Database credentials for indieTix client: ${clientUsername}`,
      SecretString: JSON.stringify(secretValue)
    });
    
    await secretsClient.send(command);
    console.log(`AWS secret created successfully: ${secretName}`);
    return secretName;
    
  } catch (error) {
    console.error(`Error creating AWS secret ${secretName}:`, error);
    throw error;
  }
}

/**
 * Deletes AWS Secrets Manager secret for client
 * @param {string} clientUsername - Client username
 */
async function deleteClientSecret(clientUsername) {
  const secretName = `indieTix/rds/clients/${clientUsername}/credentials`;
  console.log(`Deleting AWS secret: ${secretName}`);
  
  try {
    const command = new DeleteSecretCommand({
      SecretId: secretName,
      ForceDeleteWithoutRecovery: true // Immediately delete without recovery period
    });
    
    await secretsClient.send(command);
    console.log(`AWS secret deleted successfully: ${secretName}`);
    return true;
    
  } catch (error) {
    console.error(`Error deleting AWS secret ${secretName}:`, error);
    return false;
  }
}

/**
 * Deletes the venue's Connect Square refresh-token secret
 * (indieTix/square/clients/<id>, written by QRScanner's SQUARE OAUTH
 * callback), if it has one. A personal-token venue has none, which is fine.
 * @returns {Promise<'deleted'|'none'|false>}
 */
async function deleteSquareRefreshSecret(clientUsername) {
  const secretName = `indieTix/square/clients/${clientUsername}`;
  try {
    await secretsClient.send(new DeleteSecretCommand({ SecretId: secretName, ForceDeleteWithoutRecovery: true }));
    console.log(`Square refresh-token secret deleted: ${secretName}`);
    return 'deleted';
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') return 'none';
    console.error(`Error deleting Square refresh-token secret ${secretName}:`, error);
    return false;
  }
}

/**
 * Creates a new PostgreSQL user for the client
 * @param {Object} dbConfig - Database configuration
 * @param {string} clientUsername - Client username
 * @param {string} clientSecret - Client password (cleartext)
 */
async function createPostgreSQLUser(dbConfig, clientUsername, clientSecret) {
  console.log(`Creating PostgreSQL user: ${clientUsername}`);
  
  // Connect to postgres database to create new user
  const pgClient = new Client({
    ...dbConfig,
    database: 'postgres'
  });
  
  try {
    await pgClient.connect();
    
    // Create the new user with password - using literal escaping since CREATE USER doesn't support $1 parameters
    const escapedPassword = clientSecret.replace(/'/g, "''"); // Escape single quotes by doubling them
    const createUserQuery = `CREATE USER "${clientUsername}" WITH PASSWORD '${escapedPassword}'`;
    await pgClient.query(createUserQuery);
    
    console.log(`PostgreSQL user created successfully: ${clientUsername}`);
    
  } finally {
    await pgClient.end();
  }
}

/**
 * Creates a new PostgreSQL database for the client
 * @param {Object} dbConfig - Database configuration
 * @param {string} clientUsername - Client username (database name)
 */
async function createClientDatabase(dbConfig, clientUsername) {
  console.log(`Creating database for client: ${clientUsername}`);
  
  // Connect to postgres database to create new database
  const pgClient = new Client({
    ...dbConfig,
    database: 'postgres'
  });
  
  try {
    await pgClient.connect();
    
    // Create the new database
    const createDbQuery = `CREATE DATABASE "${clientUsername}"`;
    await pgClient.query(createDbQuery);
    
    console.log(`Database created successfully: ${clientUsername}`);
    
  } finally {
    await pgClient.end();
  }
}

/**
 * Grants database permissions to the PostgreSQL user
 * @param {Object} dbConfig - Database configuration
 * @param {string} clientUsername - Client username
 */
async function grantDatabasePermissions(dbConfig, clientUsername) {
  console.log(`Granting database permissions to user: ${clientUsername}`);
  
  // Connect to postgres database to grant permissions
  const pgClient = new Client({
    ...dbConfig,
    database: 'postgres'
  });
  
  try {
    await pgClient.connect();
    
    // Grant all privileges on the database to the user
    const grantQuery = `GRANT ALL PRIVILEGES ON DATABASE "${clientUsername}" TO "${clientUsername}"`;
    await pgClient.query(grantQuery);
    
    console.log(`Database permissions granted successfully to: ${clientUsername}`);
    
  } finally {
    await pgClient.end();
  }
  
  // Also need to grant permissions on the schema and tables within the database
  const clientDbClient = new Client({
    ...dbConfig,
    database: clientUsername
  });
  
  try {
    await clientDbClient.connect();
    
    // Grant usage on public schema
    await clientDbClient.query(`GRANT USAGE ON SCHEMA public TO "${clientUsername}"`);
    
    // Grant all privileges on all tables in public schema
    await clientDbClient.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${clientUsername}"`);
    
    // Grant all privileges on all sequences in public schema (for serial columns)
    await clientDbClient.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${clientUsername}"`);
    
    // Grant all privileges on all functions in public schema
    await clientDbClient.query(`GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO "${clientUsername}"`);
    
    // Set default privileges for future objects
    await clientDbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${clientUsername}"`);
    await clientDbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${clientUsername}"`);
    await clientDbClient.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO "${clientUsername}"`);
    
    console.log(`Schema and object permissions granted successfully to: ${clientUsername}`);
    
  } finally {
    await clientDbClient.end();
  }
}

/**
 * Creates all required database objects in the client database
 * @param {Object} dbConfig - Database configuration
 * @param {string} clientUsername - Client username (database name)
 * @param {string} theaterId - Theater ID for the bdor view
 * @param {string} theaterName - Theater name for the bdor view
 * @param {string} filmCodePrefix - Per-client film-code prefix for bdor_for_date (2-4 uppercase letters)
 */

async function createDatabaseObjects(dbConfig, clientUsername, theaterId, theaterName, filmCodePrefix) {
  console.log(`Creating database objects for client: ${clientUsername}`);
  
  const pgClient = new Client({
    ...dbConfig,
    database: clientUsername
  });
  
  try {
    await pgClient.connect();
    
    // ===========================================================
    // TABLES
    // ===========================================================
    
    // 1. Client table
    const createClientTable = `
      CREATE TABLE public."Client" (
        "ID" SERIAL PRIMARY KEY,
        "clientID" VARCHAR(100) NOT NULL UNIQUE,
        "clientSecret" VARCHAR(100) NOT NULL,
        "contactName" VARCHAR(255) NOT NULL,
        "clientEmail" VARCHAR(255) NOT NULL,
        "createdDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "OrderID" VARCHAR(100),
        "ClientPlan" VARCHAR(255),
        "ClientMaxTicketsPerMonth" VARCHAR(255),
        "ClientChargePerTicket" NUMERIC(19,4),
        "HasBeenSetup" BOOLEAN,
        "Status" VARCHAR(255),
        "configuration" JSON
      );
      
      CREATE INDEX "idx_client_clientid" ON public."Client" ("clientID");
    `;
    await pgClient.query(createClientTable);
    console.log('Client table created');
    
    // 2. Order table (with OptInToken + CustomerID + OptInClaimedByPhone
    // for SMS opt-in, and idx_order_status restored from live DB).
    //
    // OptInClaimedByPhone binds a token to one specific phone atomically at
    // consent time. Prevents the "leaked-token -> spam many phones" attack;
    // see /areas/indietix.md and the token-scoped POST /api/public/opt-in
    // handler. No index needed -- we only ever check this column on a row
    // we already resolved via OptInToken.
    const createOrderTable = `
      CREATE TABLE public."Order" (
        "ID" SERIAL PRIMARY KEY,
        "OrderID" VARCHAR(100) NOT NULL,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "LastEditedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "OrderMetaData" JSONB,
        "PhoneNumber" VARCHAR(420),
        "LastName" VARCHAR(420),
        "FirstName" VARCHAR(420),
        "EmailAddress" VARCHAR(420),
        "Status" VARCHAR(50) DEFAULT 'Valid',
        "OptInToken" VARCHAR(32),
        "CustomerID" INTEGER,
        "OptInClaimedByPhone" VARCHAR(20)
      );
      
      CREATE UNIQUE INDEX "idx_order_orderid"     ON public."Order" ("OrderID");
      CREATE        INDEX "idx_order_status"      ON public."Order" ("Status");
      CREATE UNIQUE INDEX "idx_order_optintoken"  ON public."Order" ("OptInToken");
      CREATE        INDEX "idx_order_customerid"  ON public."Order" ("CustomerID");
    `;
    await pgClient.query(createOrderTable);
    console.log('Order table created');
    
    // 3. QRCodeProduct table (with CustomerID for SMS opt-in)
    const createQRCodeProductTable = `
      CREATE TABLE public."QRCodeProduct" (
        "ID" SERIAL PRIMARY KEY,
        "QRCode" VARCHAR(200) NOT NULL,
        "CheckedIn" BOOLEAN NOT NULL DEFAULT false,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "ExpirationDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        "LastEditedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "ProductMetadata" JSONB,
        "ProductDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        "ProductName" VARCHAR(420) NOT NULL,
        "ProductLocation" VARCHAR(200) NOT NULL,
        "ProductType" VARCHAR(200) NOT NULL,
        "ProductDetails" VARCHAR(800) NOT NULL,
        "ProductPrice" NUMERIC(19,4),
        "ProductID" VARCHAR(100) NOT NULL,
        "EmailAddress" VARCHAR(420),
        "FirstName" VARCHAR(420),
        "LastName" VARCHAR(420),
        "PhoneNumber" VARCHAR(420),
        "Distributor" VARCHAR(1000),
        "ProductVenue" VARCHAR(500),
        "ProductSeatCode" VARCHAR(200),
        "Status" VARCHAR(100),
        "CustomerID" INTEGER
      );
      
      CREATE UNIQUE INDEX "idx_qrcodeproduct_qrcode"     ON public."QRCodeProduct" ("QRCode");
      CREATE        INDEX "idx_qrcodeproduct_customerid" ON public."QRCodeProduct" ("CustomerID");
    `;
    await pgClient.query(createQRCodeProductTable);
    console.log('QRCodeProduct table created');
    
    // 4. QRCodeProductToOrder table
    const createQRCodeProductToOrderTable = `
      CREATE TABLE public."QRCodeProductToOrder" (
        "ID" SERIAL PRIMARY KEY,
        "QRCodeProductID" INTEGER NOT NULL,
        "OrderID" INTEGER NOT NULL,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await pgClient.query(createQRCodeProductToOrderTable);
    console.log('QRCodeProductToOrder table created');
    
    // 5. SkeletonKey table
    const createSkeletonKeyTable = `
      CREATE TABLE IF NOT EXISTS public."SkeletonKey" (
        "id" SERIAL PRIMARY KEY,
        "qrCode" VARCHAR(255) UNIQUE NOT NULL,
        "description" VARCHAR(255),
        "eventName" VARCHAR(255),
        "keyType" VARCHAR(50),
        "isActive" BOOLEAN DEFAULT true,
        "maxUsesPerDay" INTEGER,
        "maxTotalUses" INTEGER,
        "expiresAt" DATE,
        "createdAt" TIMESTAMP DEFAULT NOW(),
        "lastUsedAt" TIMESTAMP,
        "totalUses" INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_skeleton_key_qrcode ON public."SkeletonKey"("qrCode");
      CREATE INDEX IF NOT EXISTS idx_skeleton_key_active ON public."SkeletonKey"("isActive");
    `;
    await pgClient.query(createSkeletonKeyTable);
    console.log('SkeletonKey table created');

    // 6. SkeletonKeyUsage table
    const createSkeletonKeyJuncTable = `
      CREATE TABLE IF NOT EXISTS public."SkeletonKeyUsage" (
        "id" SERIAL PRIMARY KEY,
        "skeletonKeyId" INTEGER REFERENCES public."SkeletonKey"("id") ON DELETE CASCADE,
        "usedAt" TIMESTAMP DEFAULT NOW(),
        "eventName" VARCHAR(255),
        "notes" TEXT,
        "ipAddress" VARCHAR(45)
      );

      CREATE INDEX IF NOT EXISTS idx_skeleton_usage_key  ON public."SkeletonKeyUsage"("skeletonKeyId");
      CREATE INDEX IF NOT EXISTS idx_skeleton_usage_date ON public."SkeletonKeyUsage"("usedAt");
    `;
    await pgClient.query(createSkeletonKeyJuncTable);
    console.log('SkeletonKeyUsage table created');
    
    // 7. Users table -- staff/operator accounts for QRScanner web app.
    // RESTORED from live DB; was missing from previous setup script.
    // Default permissions are least-privilege: door-scan only, no admin access.
    const createUsersTable = `
      CREATE TABLE public."Users" (
        "ID" SERIAL PRIMARY KEY,
        "Username" VARCHAR(100) NOT NULL,
        "Password" VARCHAR(255) NOT NULL,
        "Email" VARCHAR(255) NOT NULL,
        "FirstName" VARCHAR(255),
        "LastName" VARCHAR(255),
        "Permissions" JSON DEFAULT '{"view": false, "edit": false, "checkIn": true, "marketing": false, "admin": false}'::json,
        "DataFilter" JSON DEFAULT '{"datafilters": []}'::json,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Users_Username_key" UNIQUE ("Username")
      );
      
      CREATE INDEX "idx_users_email"    ON public."Users" ("Email");
      CREATE INDEX "idx_users_username" ON public."Users" ("Username");

      COMMENT ON COLUMN public."Users"."ID"          IS 'Primary key - auto-incrementing user ID';
      COMMENT ON COLUMN public."Users"."Username"    IS 'Unique username for login';
      COMMENT ON COLUMN public."Users"."Password"    IS 'Bcrypt hashed password';
      COMMENT ON COLUMN public."Users"."Email"       IS 'User email address for password reset';
      COMMENT ON COLUMN public."Users"."FirstName"   IS 'User first name';
      COMMENT ON COLUMN public."Users"."LastName"    IS 'User last name';
      COMMENT ON COLUMN public."Users"."Permissions" IS 'JSON object with view, edit, checkIn, marketing, and admin permissions; default is least-privilege (checkIn only)';
      COMMENT ON COLUMN public."Users"."DataFilter"  IS 'JSON object with data filter rules: {datafilters: [{date, event, eventType}]}';
      COMMENT ON COLUMN public."Users"."CreatedDate" IS 'Timestamp when user was created';
      COMMENT ON COLUMN public."Users"."UpdatedDate" IS 'Timestamp when user was last updated';
    `;
    await pgClient.query(createUsersTable);
    console.log('Users table created');
    
    // 8. Customer table -- one row per unique phone number.
    // Phone is the SMS identity; email is indexed but not unique
    // (family members may share an email).
    const createCustomerTable = `
      CREATE TABLE public."Customer" (
        "ID" SERIAL PRIMARY KEY,
        "PhoneNumber" VARCHAR(20) NOT NULL,
        "Email" VARCHAR(420),
        "FirstName" VARCHAR(420),
        "LastName" VARCHAR(420),
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Customer_PhoneNumber_key" UNIQUE ("PhoneNumber")
      );
      
      CREATE INDEX "idx_customer_email" ON public."Customer" ("Email");
      CREATE INDEX "idx_customer_phone" ON public."Customer" ("PhoneNumber");
    `;
    await pgClient.query(createCustomerTable);
    console.log('Customer table created');

    // 9. SmsConsent table -- immutable audit log of every consent event.
    // Never UPDATE history; only flip Status + RevokedAt, and INSERT new rows
    // for resubscribes (linked back via PreviousConsentID).
    const createSmsConsentTable = `
      CREATE TABLE public."SmsConsent" (
        "ID" SERIAL PRIMARY KEY,
        "CustomerID" INTEGER NOT NULL,
        "PhoneNumber" VARCHAR(20) NOT NULL,
        "Status" VARCHAR(20) NOT NULL DEFAULT 'active',
        "OptInMethod" VARCHAR(50) NOT NULL,
        "ConsentText" TEXT NOT NULL,
        "ConsentURL" VARCHAR(500),
        "IPAddress" VARCHAR(45),
        "UserAgent" TEXT,
        "CampaignID" VARCHAR(100),
        "PreviousConsentID" INTEGER,
        "ConsentTimestamp" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "RevokedAt" TIMESTAMP WITHOUT TIME ZONE,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SmsConsent_Status_check" CHECK ("Status" IN ('active', 'revoked'))
      );
      
      CREATE INDEX "idx_smsconsent_customer"     ON public."SmsConsent" ("CustomerID");
      CREATE INDEX "idx_smsconsent_phone"        ON public."SmsConsent" ("PhoneNumber");
      CREATE INDEX "idx_smsconsent_phone_status" ON public."SmsConsent" ("PhoneNumber", "Status");
      
      -- A phone can have at most ONE active consent at a time.
      CREATE UNIQUE INDEX "idx_smsconsent_active_phone_unique" 
        ON public."SmsConsent" ("PhoneNumber") WHERE "Status" = 'active';
    `;
    await pgClient.query(createSmsConsentTable);
    console.log('SmsConsent table created');
    
    // 10. SmsOutboundLog -- append-only audit log of every successful outbound
    //     SMS. Feeds the spend circuit breaker in utils/sms.mjs, which counts
    //     rows in the last 5 minutes and refuses new sends over the threshold
    //     (SMS_SPEND_LIMIT_PER_5MIN in client config; default 300).
    //
    //     Rows older than SMS_LOG_RETENTION_DAYS (default 30) are pruned
    //     probabilistically (~1% of successful sends) by utils/sms.mjs. Keeps
    //     the table bounded without needing separate cleanup infrastructure.
    //
    //     Also useful as a general audit trail: every SMS the platform sent
    //     to a customer, with the AWS MessageId for cross-referencing to
    //     AWS billing/deliverability reports.
    const createSmsOutboundLogTable = `
      CREATE TABLE public."SmsOutboundLog" (
        "ID" SERIAL PRIMARY KEY,
        "PhoneNumber" VARCHAR(20) NOT NULL,
        "MessageID" VARCHAR(255),
        "BodyPreview" VARCHAR(160),
        "SentAt" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- The circuit breaker query filters on SentAt >= now - 5 min every send,
      -- so it needs an index or the query slows linearly as the table grows.
      CREATE INDEX "idx_smsoutboundlog_sentat" ON public."SmsOutboundLog" ("SentAt");
    `;
    await pgClient.query(createSmsOutboundLogTable);
    console.log('SmsOutboundLog table created');

    // ---- MARKETING ENGINE TABLES ----
    // Square-Catalog-driven social/email promotion pipeline. See indieTix's
    // published Marquee Engine design doc for the full design. All three
    // tables are additive; MARKETING_ENGINE_ENABLED (Client.configuration)
    // gates whether the marketingEngine Lambda does anything with them.

    // 11. MarketingSchedule -- one row per (SquareItemID, Channel). Holds the
    // phase-builder cadence definition; expanded into concrete MarketingPost
    // rows by the poller at run time, not stored pre-expanded.
    const createMarketingScheduleTable = `
      CREATE TABLE public."MarketingSchedule" (
        "ID" SERIAL PRIMARY KEY,
        "SquareItemID" VARCHAR(100) NOT NULL,
        "Channel" VARCHAR(20) NOT NULL,
        "PhaseConfig" JSONB NOT NULL,
        "Enabled" BOOLEAN NOT NULL DEFAULT true,
        "UseAiCaptions" BOOLEAN NOT NULL DEFAULT false,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "MarketingSchedule_Channel_check" CHECK ("Channel" IN ('email', 'facebook', 'instagram', 'tiktok')),
        CONSTRAINT "MarketingSchedule_item_channel_key" UNIQUE ("SquareItemID", "Channel")
      );

      CREATE INDEX "idx_marketingschedule_item" ON public."MarketingSchedule" ("SquareItemID");
    `;
    await pgClient.query(createMarketingScheduleTable);
    console.log('MarketingSchedule table created');

    // 12. MarketingPost -- one row per (SquareItemID, Channel, ScheduledFor).
    // Doubles as both the schedule editor's "pending" view and the status
    // page's "history" view, filtered by Status. PostContent snapshots the
    // generated caption/fields at approval time, since the source Square
    // item can change or get archived after a post is scheduled.
    const createMarketingPostTable = `
      CREATE TABLE public."MarketingPost" (
        "ID" SERIAL PRIMARY KEY,
        "SquareItemID" VARCHAR(100) NOT NULL,
        "Channel" VARCHAR(20) NOT NULL,
        "PostType" VARCHAR(20) NOT NULL DEFAULT 'campaign',
        "ScheduledFor" TIMESTAMP WITHOUT TIME ZONE NOT NULL,
        "Status" VARCHAR(20) NOT NULL DEFAULT 'draft',
        "FailureReason" VARCHAR(500),
        "PlatformPostID" VARCHAR(255),
        "PostContent" JSONB,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "UpdatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "MarketingPost_Channel_check" CHECK ("Channel" IN ('email', 'facebook', 'instagram', 'tiktok')),
        CONSTRAINT "MarketingPost_PostType_check" CHECK ("PostType" IN ('campaign', 'digest', 'low_inventory')),
        CONSTRAINT "MarketingPost_Status_check" CHECK ("Status" IN ('draft', 'approved', 'sent', 'failed', 'skipped')),
        CONSTRAINT "MarketingPost_slot_key" UNIQUE ("SquareItemID", "Channel", "PostType", "ScheduledFor")
      );

      -- The poller's due-post lookup filters on Status + ScheduledFor every run.
      CREATE INDEX "idx_marketingpost_due" ON public."MarketingPost" ("Status", "ScheduledFor");
      CREATE INDEX "idx_marketingpost_item" ON public."MarketingPost" ("SquareItemID");
    `;
    await pgClient.query(createMarketingPostTable);
    console.log('MarketingPost table created');

    // 13. MarketingEmailContact -- simple admin-curated list, distinct from
    // Customer (addresses collected at the theater aren't necessarily tied
    // to a ticket purchase). Deliberately not SmsConsent-shaped: no
    // audit/consent-text fields, since this isn't 10DLC-regulated.
    const createMarketingEmailContactTable = `
      CREATE TABLE public."MarketingEmailContact" (
        "ID" SERIAL PRIMARY KEY,
        "Email" VARCHAR(420) NOT NULL,
        "Status" VARCHAR(20) NOT NULL DEFAULT 'active',
        "UnsubscribeToken" VARCHAR(32) NOT NULL,
        "CreatedDate" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "MarketingEmailContact_Status_check" CHECK ("Status" IN ('active', 'unsubscribed')),
        CONSTRAINT "MarketingEmailContact_Email_key" UNIQUE ("Email"),
        CONSTRAINT "MarketingEmailContact_UnsubscribeToken_key" UNIQUE ("UnsubscribeToken")
      );

      CREATE INDEX "idx_marketingemailcontact_status" ON public."MarketingEmailContact" ("Status");
    `;
    await pgClient.query(createMarketingEmailContactTable);
    console.log('MarketingEmailContact table created');
    // ---- end MARKETING ENGINE TABLES ----

    // ---- PUBLIC API v1 TABLES ----
    // 14. ApiKey -- per-venue keys for the /v1 public API. The key itself is
    // never stored, only its SHA-256 (keys are 32 random bytes, so a fast
    // hash is fine -- bcrypt is for low-entropy human passwords). Scopes and
    // DataFilter mirror a sub-user's permissions/DataFilter so one set of
    // rules covers both. RateWindow* back a simple per-key per-minute cap.
    const createApiKeyTable = `
      CREATE TABLE public."ApiKey" (
        "ID" SERIAL PRIMARY KEY,
        "Name" VARCHAR(100) NOT NULL,
        "KeyPrefix" VARCHAR(40) NOT NULL,
        "KeyHash" CHAR(64) NOT NULL,
        "Scopes" JSONB NOT NULL DEFAULT '[]',
        "DataFilter" JSONB,
        "CreatedAt" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "LastUsedAt" TIMESTAMP WITHOUT TIME ZONE,
        "RevokedAt" TIMESTAMP WITHOUT TIME ZONE,
        "RateWindowStart" TIMESTAMP WITHOUT TIME ZONE,
        "RateWindowCount" INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "ApiKey_KeyHash_key" UNIQUE ("KeyHash")
      );
    `;
    await pgClient.query(createApiKeyTable);
    console.log('ApiKey table created');

    // 15. ApiIdempotency -- remembers the response to a write (check-in) per
    // (ApiKeyID, Idempotency-Key) so a scanner retrying over a flaky
    // connection gets the original answer, not "already checked in".
    // No FK to ApiKey, per convention.
    const createApiIdempotencyTable = `
      CREATE TABLE public."ApiIdempotency" (
        "ApiKeyID" INTEGER NOT NULL,
        "IdempotencyKey" VARCHAR(100) NOT NULL,
        "ResponseStatus" INTEGER NOT NULL,
        "ResponseBody" JSONB NOT NULL,
        "CreatedAt" TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY ("ApiKeyID", "IdempotencyKey")
      );
    `;
    await pgClient.query(createApiIdempotencyTable);
    console.log('ApiIdempotency table created');
    // ---- end PUBLIC API v1 TABLES ----

    // ===========================================================
    // FUNCTIONS
    // ===========================================================
    
    // 10. safe_to_timestamp -- null-safe text→timestamp helper.
    // RESTORED from live DB; was missing from previous setup script.
    const createSafeToTimestampFunction = `
      CREATE OR REPLACE FUNCTION public.safe_to_timestamp(p_text text)
       RETURNS timestamp without time zone
       LANGUAGE plpgsql
       STABLE
      AS $$
      BEGIN
          IF p_text IS NULL THEN
              RETURN NULL;
          END IF;
          RETURN p_text::timestamp;
      EXCEPTION WHEN others THEN
          RETURN NULL;
      END;
      $$;
    `;
    await pgClient.query(createSafeToTimestampFunction);
    console.log('safe_to_timestamp function created');
    
    // 11. bdor_for_date -- row-level showtime-date report.
    // Reports every ticket whose SHOWTIME (ProductDate) falls on the given
    // Chicago calendar date, regardless of when it was purchased.
    //
    // ProductDate is timestamp without time zone with values representing
    // Chicago wall-clock time by convention; no timezone conversion is applied.
    //
    // Refund rule: by business policy refunds never happen after showtime,
    // so at report time every ticket for the report date is in its final
    // state. Refunded tickets are reported with gross=0, net=0, tax=0,
    // sold=0, refunded=1.
    //
    // Transferred tickets (Status = 'transferred', added for the ticket
    // transfer feature) are the OLD, superseded row left behind when a
    // ticket is moved to a new recipient -- a brand new QRCodeProduct row
    // with the same showtime/price/seat already carries the real sale
    // forward. The old row must contribute ZERO everywhere, same as
    // refunded, but is NOT a refund (no money came back), so it reports
    // sold=0, refunded=0 rather than refunded=1 -- it just vanishes from
    // the report, which is correct since the new row already represents
    // that same seat.
    //
    // Cancelled tickets (Status = 'cancelled', set by QRScanner's whole-
    // order cancellation feature) are treated the same way as transferred:
    // zero everywhere, refunded=0 (cancelling an order isn't necessarily a
    // refund). Found as a real gap while writing this repo's test suite --
    // this function previously only checked for 'refunded'/'transferred'
    // and silently counted cancelled tickets as full-price sales.
    //
    // Gross is tax-inclusive (the price the customer paid).
    // Net is tax-exclusive (Gross / (1 + SALES_TAX_RATE/100)). Tax = Gross - Net.
    // SALES_TAX_RATE and SCREEN_NUMBERS are read from Client Settings each
    // time the report runs (not baked in), so a change applies to the next
    // report. Neither is required: blank tax = none, no screen match = 1.
    //
    // TheatreID and Theatre Name are baked into the function body as SQL
    // literals, so the ID must be digits and the name has its quotes
    // doubled (a venue like "Joe's Cinema" used to break onboarding here).
    if (!/^[0-9]+$/.test(String(theaterId))) {
      throw new Error(`theater_id must be digits only, got "${theaterId}"`);
    }
    const sqlTheaterId = Number(theaterId);
    const sqlTheaterName = String(theaterName).replace(/'/g, "''");
    const createBdorForDateFunction = `
      CREATE OR REPLACE FUNCTION public.bdor_for_date(p_report_date date)
       RETURNS TABLE("TheatreID" integer, "Theatre Name" text, "Film Code" text, "Screen" text, "Title" character varying, "Distributor" character varying, "Showtime" text, "Ticket Type" character varying, "Gross" numeric, "Net" numeric, "Tax" numeric, "Sold" integer, "Refunded" integer, "Open" integer, "Close" integer)
       LANGUAGE sql
       STABLE
      AS $$
          SELECT
              ${sqlTheaterId} AS "TheatreID",
              '${sqlTheaterName}'::text AS "Theatre Name",
              '${filmCodePrefix}'::text || substring(md5("ProductName"::text), 1, 6) AS "Film Code",
              coalesce((
                  SELECT screen.value
                  FROM jsonb_each_text(settings.screen_numbers) AS screen
                  WHERE screen.key <> ''
                    AND strpos(lower("ProductVenue"::text), lower(screen.key)) > 0
                  ORDER BY length(screen.key) DESC, screen.key
                  LIMIT 1
              ), '1') AS "Screen",
              "ProductName" AS "Title",
              "Distributor",
              to_char("ProductDate", 'YYYYMMDDHH24MI') AS "Showtime",
              "ProductSeatCode" AS "Ticket Type",
              CASE
                  WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
                  ELSE round("ProductPrice", 2)
              END AS "Gross",
              CASE
                  WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
                  ELSE round("ProductPrice" / settings.tax_divisor, 2)
              END AS "Net",
              CASE
                  WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0::numeric
                  ELSE round("ProductPrice", 2) - round("ProductPrice" / settings.tax_divisor, 2)
              END AS "Tax",
              CASE
                  WHEN "Status"::text IN ('refunded', 'transferred', 'cancelled') THEN 0
                  WHEN "ProductPrice" > 0::numeric THEN 1
                  ELSE 0
              END AS "Sold",
              CASE
                  WHEN "Status"::text = 'refunded' THEN 1
                  ELSE 0
              END AS "Refunded",
              0 AS "Open",
              1 AS "Close"
          FROM "QRCodeProduct"
          CROSS JOIN (
              -- Read when the report runs, from this venue's Client Settings:
              -- SALES_TAX_RATE, the percent included in ticket prices (blank
              -- or not a number = no tax), and SCREEN_NUMBERS, {"text in the
              -- ticket's venue": "screen"} (longest match wins; none = 1).
              SELECT
                  1 + CASE WHEN cfg.c->>'SALES_TAX_RATE' ~ '^[0-9]+([.][0-9]+)?$'
                           THEN (cfg.c->>'SALES_TAX_RATE')::numeric / 100
                           ELSE 0 END AS tax_divisor,
                  CASE WHEN jsonb_typeof(cfg.c->'SCREEN_NUMBERS') = 'object'
                       THEN cfg.c->'SCREEN_NUMBERS'
                       ELSE '{}'::jsonb END AS screen_numbers
              FROM (SELECT (SELECT "configuration"::jsonb FROM public."Client" LIMIT 1) AS c) AS cfg
          ) AS settings
          WHERE "ProductType"::text = 'Movie'
            AND "ProductDate" IS NOT NULL
            AND "ProductDate"::date = p_report_date;
      $$;
    `;
    await pgClient.query(createBdorForDateFunction);
    console.log('bdor_for_date function created');
    
    // 12. get_bdor_grouped_for_date -- aggregates row-level bdor_for_date()
    // by Title / Ticket Type / Screen / Showtime, applying theatre params.
    // Column order matches the TDI recipient spec (May 2026 email).
    const createGetBdorGroupedForDateFunction = `
      CREATE OR REPLACE FUNCTION public.get_bdor_grouped_for_date(p_theatre_id character varying, p_theatre_name character varying, p_report_date date)
       RETURNS TABLE("TheatreID" character varying, "Theatre Name" character varying, "Film Code" character varying, "Screen" character varying, "Title" character varying, "Distributor" character varying, "Showtime" text, "Ticket Type" character varying, "Gross" numeric, "Net" numeric, "Tax" numeric, "Sold" bigint, "Refunded" bigint, "Open" bigint, "Close" bigint)
       LANGUAGE sql
       STABLE
      AS $$
          SELECT
              p_theatre_id   ::character varying AS "TheatreID",
              p_theatre_name ::character varying AS "Theatre Name",
              max(b."Film Code")                 AS "Film Code",
              b."Screen"     ::character varying AS "Screen",
              b."Title"                          AS "Title",
              max(b."Distributor"::text)::character varying AS "Distributor",
              b."Showtime"                       AS "Showtime",
              b."Ticket Type"                    AS "Ticket Type",
              sum(b."Gross")    ::numeric        AS "Gross",
              sum(b."Net")      ::numeric        AS "Net",
              sum(b."Tax")      ::numeric        AS "Tax",
              sum(b."Sold")     ::bigint         AS "Sold",
              sum(b."Refunded") ::bigint         AS "Refunded",
              sum(b."Open")     ::bigint         AS "Open",
              sum(b."Close")    ::bigint         AS "Close"
          FROM public.bdor_for_date(p_report_date) b
          GROUP BY b."Title", b."Ticket Type", b."Screen", b."Showtime"
          ORDER BY b."Title", b."Showtime", b."Ticket Type";
      $$;
    `;
    await pgClient.query(createGetBdorGroupedForDateFunction);
    console.log('get_bdor_grouped_for_date function created');
    
    // 13. get_ebor_engagements_for_date -- one row per Title for the given
    // report date with title-level tax-inclusive gross. Feeds the comScore
    // EBOR XML output. RESTORED from live DB; was missing from setup script.
    //
    // Source: bdor_for_date() -- Gross is already tax-inclusive, and refunded
    // tickets already contribute Gross=0 (so they appear with zero revenue
    // rather than being filtered out, matching what comScore has historically
    // seen, e.g. "FREE WILLY, 0.00").
    const createGetEborEngagementsForDateFunction = `
      CREATE OR REPLACE FUNCTION public.get_ebor_engagements_for_date(p_theatre_no character varying, p_report_date date)
       RETURNS TABLE("TheatreNo" character varying, "Film Code" character varying, "Title" character varying, "Gross" numeric)
       LANGUAGE sql
       STABLE
      AS $$
          SELECT
              p_theatre_no::character varying              AS "TheatreNo",
              max(b."Film Code")::character varying        AS "Film Code",
              b."Title"::character varying                 AS "Title",
              sum(b."Gross")::numeric                      AS "Gross"
          FROM public.bdor_for_date(p_report_date) b
          GROUP BY b."Title"
          ORDER BY b."Title";
      $$;
    `;
    await pgClient.query(createGetEborEngagementsForDateFunction);
    console.log('get_ebor_engagements_for_date function created');
    
    // ===========================================================
    // VIEWS
    // ===========================================================
    
    // 14. OrderProductView
    const createOrderProductView = `
      CREATE OR REPLACE VIEW public."OrderProductView" AS
      SELECT qp."ID",
        qp."QRCode",
        qp."CheckedIn",
        qp."ExpirationDate",
        qp."LastEditedDate",
        qp."ProductName",
        qp."ProductDate",
        qp."ProductDetails",
        qp."ProductPrice",
        o."EmailAddress",
        o."FirstName",
        o."LastName",
        o."PhoneNumber"
       FROM "QRCodeProduct" qp
         JOIN "QRCodeProductToOrder" jt ON qp."ID" = jt."QRCodeProductID"
         JOIN "Order" o ON jt."OrderID" = o."ID";
    `;
    await pgClient.query(createOrderProductView);
    console.log('OrderProductView created');
    
    console.log('All database objects created successfully');
    
  } finally {
    await pgClient.end();
  }
}

/**
 * Inserts client record into the Client table
 * @param {Object} dbConfig - Database configuration
 * @param {string} clientUsername - Client username (database name)
 * @param {Object} clientData - Client data object
 */
async function insertClientRecord(dbConfig, clientUsername, clientData) {
  console.log(`Inserting client record for: ${clientUsername}`);
  
  const pgClient = new Client({
    ...dbConfig,
    database: clientUsername
  });
  
  try {
    await pgClient.connect();
    
    // Hash the client secret
    const hashedSecret = await bcrypt.hash(clientData.clientSecret, 10);
    
   // Create configuration JSON
    const configuration = {
      "ENV_TYPE": "dev",
      "SQUARE_ACCESS_TOKEN": clientData.square_access_token,
      "SQUARE_SIGNATURE_KEY": clientData.square_signature_key,
      "SQUARE_WEBHOOK_URL": clientData.square_webhook_url || "", // this deployment's own webhook endpoint (square-queue-forwarder's ApiEndpoint output); optional at onboarding, bootstrap.sh passes it -- was hardcoded to production's URL, found 2026-10-27 during a real bootstrap verification run
      "SQUARE_LOCATION_ID": clientData.square_location_id || "", // Square location ID; optional at onboarding, set later if not known yet
      "USE_QR_CODE": "UseQRCode",
      "SENDER_EMAIL": clientData.sender_email,
      "DISTRIBUTOR_NAME": "Distributor",
      "S3_BUCKET_PREFIX": clientData.s3_bucket_prefix || "indietix-",
      "EVENT_TYPE": "EventType",
      "EVENT_LOCATIONS": ["Main Auditorium"],
      "SALES_TAX_RATE": "",                                   // optional: percent included in ticket prices, split out of Gross in box-office reports (blank = no tax)
      "SCREEN_NUMBERS": {},                                   // optional: {"text in a ticket's venue": "screen number"} for box-office reports; no match = screen 1
      "EVENT_DESCRIPTORS": ["Closed Caption", "75mm", "All Ages", "21+", "18 and over"],
      "USERS_NAMES": [],
      "GOOGLE_SERVICE_ACCOUNT_KEY": "updateWithRealServiceAccountKey", 
      "CINEMA_CALENDAR_ID": "updateWithRealCinemaCalendarID",
      "EVENT_CALENDAR_ID": "updateWithRealEventCalendarID",
      "ANTHROPIC_API_KEY": "updateWithRealAnthropicAPIKey",
      "OMDB_API_KEY": "",                                     // movie lookup on Add Movie (free key from omdbapi.com); set in Client Settings
      "FTP1_HOST": "",
      "FTP1_PASSWORD": "",
      "FTP1_PORT": "21",
      "FTP1_REMOTE_PATH": "",
      "FTP1_TYPE": "ftp",
      "FTP1_USER": "",
      "FTP2_HOST": "",
      "FTP2_PASSWORD": "",
      "FTP2_PORT": "21",
      "FTP2_REMOTE_PATH": "",
      "FTP2_TYPE": "ftp",
      "FTP2_USER": "",
      "FTP3_HOST": "",                                        // third FTP/SFTP destination; also receives the TDI CSV (same report as FTP2)
      "FTP3_PASSWORD": "",
      "FTP3_PORT": "21",
      "FTP3_REMOTE_PATH": "",
      "FTP3_TYPE": "ftp",
      "FTP3_USER": "",
      "SQL_QUERY": "SELECT * FROM get_bdor_grouped_for_date($1, $2, $3)",
      "USE_FTP": "false",
      "THEATER_ID": clientData.theater_id,
      "THEATER_NAME": clientData.theater_name,
      "WEB_HEADER_COMPANY": clientData.theater_name, // brand shown in web UI header; usually same as THEATER_NAME
      "LOGO_FILE": "indieTixLogo.png",
      "EBOR_THEATRE_NO": "", // comScore theatre number for EBOR reporting; set once known
      "FILM_CODE_PREFIX": clientData.film_code_prefix, // baked into bdor_for_date at creation time; recreate the function to change it later
      "JWT_SECRET": crypto.randomBytes(32).toString('hex'), // unique per client — do not share this value across clients
      // AWS_REGION removed 2026-10-27 -- was hardcoded to production's
      // region ("us-east-2") on every new client regardless of which
      // deployment they were actually onboarded into. Confirmed nothing in
      // the platform reads Client.configuration's AWS_REGION for anything
      // (every Lambda already gets its own real region from the
      // Lambda-provided process.env.AWS_REGION) -- genuinely dead, not
      // just wrong, so removed rather than fixed to a placeholder.
      "STATIC_WEBSITE_URL": "", // this deployment's own CloudFront domain; set once known -- was hardcoded to production's URL, found 2026-10-27 alongside the AWS_REGION issue during a real bootstrap verification run
      "USE_QR_CODE_VALUE": "true",
      "MODIFIER_NAME_FILTER": "Show Time",
      "TARGET_CATEGORIES": "Cinema,Events",
      "SEND_SMS": "false",
      "TICKET_FILENAME": "ticket_horizontal.pdf",
      "TICKET_ORIENTATION": "horizontal",
      "TICKET_SMS_FILENAME": "ticket_vertical.pdf",
      "TICKET_SMS_ORIENTATION": "vertical",
      "PASSWORD_RESET_SECRET": crypto.randomBytes(32).toString('hex'), // unique per client — do not share this value across clients
      "ECOMMERCE_SITE_URL": "https://shop.libertyhall.net",

      // ---- SMS / 10DLC opt-in configuration ----
      // SMS sender brand is "IndieTix" globally; campaign and origination number
      // are per-client so future expansion to per-venue brands is possible.
      "SMS_CAMPAIGN_ID": "",                                  // 10DLC campaign ID once approved (per-client)
      "SMS_ORIGINATION_NUMBER": "",                           // AWS End User Messaging number, E.164 (per-client; used by inbound Lambda for routing)
      "SMS_SENDER_BRAND": "IndieTix",                         // brand shown in SMS body
      "SMS_OPT_OUT_LIST_NAME": "",                            // AWS opt-out list associated with this client's number; leave empty to skip defensive removal on START
      "SMS_SPEND_LIMIT_PER_5MIN": 300,                        // Spend circuit breaker: max successful SMS in any 5-minute window per client. Set 0 or unset to fall back to code default (300).
      "SMS_LOG_RETENTION_DAYS": 30,                           // Days of SmsOutboundLog rows to keep. Older rows pruned probabilistically by utils/sms.mjs. Set 0 or unset to fall back to code default (30).
      "INDIETIX_PRIVACY_URL": "https://indietix.com/privacy",
      "INDIETIX_TERMS_URL": "https://indietix.com/terms",

      // BAD_SHOWTIME_SNS_TOPIC_ARN: not created per-client by this Lambda today --
      // the live value observed in production is a single un-suffixed ARN, which
      // suggests this may actually be a shared resource across all clients (like
      // the inbound SMS SNS topic and TICKET_SIGNER credentials documented in
      // README's Multi-tenancy model section) rather than genuinely per-client.
      // Worth confirming before treating this as client-specific.
      "BAD_SHOWTIME_SNS_TOPIC_ARN": "",

      // ---- MARKETING ENGINE configuration ----
      // Master switch; the marketingEngine Lambda no-ops entirely for any
      // client where this isn't the string "true" (check both === true and
      // === 'true', same as SEND_SMS -- see README conventions).
      "MARKETING_ENGINE_ENABLED": "false",
      "DIGEST_ENABLED": "false",
      "DIGEST_DAY_OF_WEEK": "monday",
      "DIGEST_TIME": "10:00",
      "DIGEST_CHANNELS": ["email"],
      // Per-field size/weight for the digest image's text overlay. Times
      // are always italic (not configurable) -- that's what visually
      // separates them from the bold title; everything else defaults to
      // the sizes/weights the overlay already used before these became
      // configurable.
      "DIGEST_DATE_FONT_SIZE": 16,
      "DIGEST_DATE_BOLD": "true",
      "DIGEST_EVENT_FONT_SIZE": 14,
      "DIGEST_EVENT_BOLD": "true",
      "DIGEST_TIME_FONT_SIZE": 14,
      "DIGEST_TIME_BOLD": "false",
      // Optional static text shown above/below the auto-generated
      // day-by-day schedule. IN_IMAGE draws it into the generated digest
      // image; IN_CAPTION prepends/appends it to the plain-text caption
      // used for every channel (email, Facebook, Instagram, TikTok all
      // share one caption -- there's no per-channel text). Both off by
      // default since this is purely opt-in.
      "DIGEST_HEADER_TEXT": "",
      "DIGEST_HEADER_FONT_SIZE": 16,
      "DIGEST_HEADER_BOLD": "true",
      "DIGEST_HEADER_IN_IMAGE": "false",
      "DIGEST_HEADER_IN_CAPTION": "false",
      "DIGEST_FOOTER_TEXT": "",
      "DIGEST_FOOTER_FONT_SIZE": 16,
      "DIGEST_FOOTER_BOLD": "true",
      "DIGEST_FOOTER_IN_IMAGE": "false",
      "DIGEST_FOOTER_IN_CAPTION": "false",
      "MARKETING_SES_CONFIGURATION_SET": "",                  // separate from transactional ticket-email sending; set once created
      "SHARE_NUDGE_ENABLED": "false",                         // adds a share/bring-a-friend line to the ticket confirmation email
      "OWNER_BCC_EMAIL": "",                                  // optional: BCC'd (and added as an SES Destination) on every ticket confirmation email for this client, and used as the fallback recipient for a walk-up/cash sale with no captured buyer email. Unset by default -- per-client opt-in monitoring, not a shared/global address.
      "ONE_PER_EMAIL_ITEMS": "",                              // optional: Square item names (comma-separated) each email can get only one ticket for, e.g. a free sample; enforced by getSquareOrders
      // Terms of Service / Privacy Policy details (QRScanner utils/legal.mjs);
      // blank shows that page's "Your Venue" placeholder.
      "LEGAL_NAME": "",                                       // formal name, e.g. "Example Cinema Inc."
      "LEGAL_SHORT_NAME": "",                                 // how the pages refer to the venue; defaults to LEGAL_NAME
      "LEGAL_ADDRESS": "",                                    // street, city, state, zip
      "LEGAL_PHONE": "",
      "LEGAL_EMAIL": "",                                      // blank = privacy@indietix.net
      "LEGAL_STATE": "",                                      // governing law, e.g. "Kansas"
      "LEGAL_COURT_COUNTY": "",                               // where disputes are heard, e.g. "Douglas County, Kansas"
      "META_PAGE_ACCESS_TOKEN": "",                           // populated once Meta app review + Page connection is complete
      "META_PAGE_ID": "",                                     // Facebook Page ID real sending posts to -- required alongside the token above
      "META_IG_BUSINESS_ID": "",
      "TIKTOK_ACCESS_TOKEN": "",                              // populated once TikTok app audit is complete
      "TIKTOK_REFRESH_TOKEN": "",                             // from the same OAuth exchange as the access token above; marketingEngine auto-refreshes and rewrites both of these before every TikTok send once this + CLIENT_KEY/CLIENT_SECRET are set
      "TIKTOK_CLIENT_KEY": "",                                // this client's TikTok developer app key -- required for marketingEngine's token refresh (TikTok access tokens expire in ~24h)
      "TIKTOK_CLIENT_SECRET": "",                             // paired with TIKTOK_CLIENT_KEY above
      "TIKTOK_PRIVACY_LEVEL": "",                             // optional override; must match one of the creator's privacy_level_options or the post is auto-downgraded to the first option TikTok offers
      "MARKETING_SCHEDULE_PRESETS": [],                       // staff-defined, reusable phase-builder presets; [{ name, offsets }]
      // ---- end MARKETING ENGINE configuration ----

      "USER_DEFINABLE": [
        "SQUARE_ACCESS_TOKEN",
        "SQUARE_SIGNATURE_KEY",
        "SQUARE_WEBHOOK_URL",
        "SQUARE_LOCATION_ID",
        "STATIC_WEBSITE_URL",
        "DISTRIBUTOR_NAME",
        "EVENT_TYPE",
        "EVENT_LOCATIONS",
        "SALES_TAX_RATE",
        "SCREEN_NUMBERS",
        "EVENT_DESCRIPTORS",
        "USERS_NAMES",
        "GOOGLE_SERVICE_ACCOUNT_KEY",
        "CINEMA_CALENDAR_ID",
        "EVENT_CALENDAR_ID",
        "ANTHROPIC_API_KEY",
        "OMDB_API_KEY",
        "FTP1_HOST",
        "FTP1_PASSWORD",
        "FTP1_PORT",
        "FTP1_REMOTE_PATH",
        "FTP1_TYPE",
        "FTP1_USER",
        "FTP2_HOST",
        "FTP2_PASSWORD",
        "FTP2_PORT",
        "FTP2_REMOTE_PATH",
        "FTP2_TYPE",
        "FTP2_USER",
        "FTP3_HOST",
        "FTP3_PASSWORD",
        "FTP3_PORT",
        "FTP3_REMOTE_PATH",
        "FTP3_TYPE",
        "FTP3_USER",
        "USE_FTP",
        "THEATER_ID",
        "THEATER_NAME",
        "WEB_HEADER_COMPANY",
        "LOGO_FILE",
        "EBOR_THEATRE_NO",
        "FILM_CODE_PREFIX",
        "MODIFIER_NAME_FILTER",
        "TARGET_CATEGORIES",
        "SEND_SMS",
        "PASSWORD_RESET_SECRET",
        "ECOMMERCE_SITE_URL",
        "SMS_CAMPAIGN_ID",
        "SMS_ORIGINATION_NUMBER",
        "SMS_SENDER_BRAND",
        "SMS_OPT_OUT_LIST_NAME",
        "SMS_SPEND_LIMIT_PER_5MIN",
        "SMS_LOG_RETENTION_DAYS",
        "BAD_SHOWTIME_SNS_TOPIC_ARN",
        "INDIETIX_PRIVACY_URL",
        "INDIETIX_TERMS_URL",
        "MARKETING_ENGINE_ENABLED",
        "DIGEST_ENABLED",
        "DIGEST_DAY_OF_WEEK",
        "DIGEST_TIME",
        "DIGEST_CHANNELS",
        "DIGEST_BACKGROUND_IMAGE_URL",
        "DIGEST_TEXT_BOUNDS",
        "DIGEST_DATE_FONT_SIZE",
        "DIGEST_DATE_BOLD",
        "DIGEST_EVENT_FONT_SIZE",
        "DIGEST_EVENT_BOLD",
        "DIGEST_TIME_FONT_SIZE",
        "DIGEST_TIME_BOLD",
        "DIGEST_HEADER_TEXT",
        "DIGEST_HEADER_FONT_SIZE",
        "DIGEST_HEADER_BOLD",
        "DIGEST_HEADER_IN_IMAGE",
        "DIGEST_HEADER_IN_CAPTION",
        "DIGEST_FOOTER_TEXT",
        "DIGEST_FOOTER_FONT_SIZE",
        "DIGEST_FOOTER_BOLD",
        "DIGEST_FOOTER_IN_IMAGE",
        "DIGEST_FOOTER_IN_CAPTION",
        "MARKETING_SES_CONFIGURATION_SET",
        "SHARE_NUDGE_ENABLED",
        "TICKET_ORIENTATION",
        "TICKET_FILENAME",
        "SENDER_EMAIL",
        "OWNER_BCC_EMAIL",
        "ONE_PER_EMAIL_ITEMS",
        "LEGAL_NAME",
        "LEGAL_SHORT_NAME",
        "LEGAL_ADDRESS",
        "LEGAL_PHONE",
        "LEGAL_EMAIL",
        "LEGAL_STATE",
        "LEGAL_COURT_COUNTY",
        "META_PAGE_ACCESS_TOKEN",
        "META_PAGE_ID",
        "META_IG_BUSINESS_ID",
        "TIKTOK_ACCESS_TOKEN",
        "TIKTOK_REFRESH_TOKEN",
        "TIKTOK_CLIENT_KEY",
        "TIKTOK_CLIENT_SECRET",
        "TIKTOK_PRIVACY_LEVEL"
      ]
    };

    // ---- ONBOARDING SETTINGS ----
    // Optional `settings` object: initial values for any USER_DEFINABLE key
    // (the same keys Client Settings can edit), e.g. OMDB_API_KEY, Google
    // Calendar, FTP destinations. Anything else is skipped, so this can't
    // override internals like JWT_SECRET. Logs key names only, never values.
    // Square values passed explicitly at onboarding still win over these.
    if (clientData.settings) {
      const explicitSquare = {
        SQUARE_ACCESS_TOKEN: clientData.square_access_token,
        SQUARE_SIGNATURE_KEY: clientData.square_signature_key,
        SQUARE_WEBHOOK_URL: clientData.square_webhook_url,
        SQUARE_LOCATION_ID: clientData.square_location_id
      };
      const applied = [];
      const skipped = [];
      for (const [key, value] of Object.entries(clientData.settings)) {
        if (!configuration.USER_DEFINABLE.includes(key) || explicitSquare[key]) {
          skipped.push(key);
          continue;
        }
        configuration[key] = value;
        applied.push(key);
      }
      console.log(`Onboarding settings applied: ${applied.join(', ') || '(none)'}`);
      if (skipped.length) {
        console.log(`Onboarding settings skipped (not user-definable, or set explicitly): ${skipped.join(', ')}`);
      }
    }
    // ---- END ONBOARDING SETTINGS ----

    // ---- CONNECT SQUARE (OAuth) ----
    // Hosted signup (QRScanner) passes square_oauth when the venue connected
    // with Square's sign-in: its access token is square_access_token above,
    // its refresh token is already in Secrets Manager. These keys aren't
    // user-definable, so they can't come in through `settings`.
    if (clientData.square_oauth && clientData.square_oauth.merchant_id) {
      configuration.SQUARE_AUTH_MODE = 'oauth';
      configuration.SQUARE_MERCHANT_ID = clientData.square_oauth.merchant_id;
      configuration.SQUARE_TOKEN_EXPIRES_AT = clientData.square_oauth.expires_at || null;
      configuration.SIGNUP_SOURCE = 'hosted';
    }
    // ---- END CONNECT SQUARE ----

    // Insert client record
    const insertQuery = `
      INSERT INTO public."Client" (
        "clientID",
        "clientSecret", 
        "contactName",
        "clientEmail",
        "HasBeenSetup",
        "Status",
        "configuration"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    
    await pgClient.query(insertQuery, [
      clientData.username,
      hashedSecret,
      clientData.contactName,
      clientData.clientEmail,
      true,
      'active',
      JSON.stringify(configuration)
    ]);
    
    console.log('Client record inserted successfully');

  } finally {
    await pgClient.end();
  }
}

/**
 * Inserts a named admin Users row for a freshly-onboarded client.
 * Optional step -- called only when the caller supplied admin
 * credentials in the onboarding event.
 *
 * This is NOT required to log in -- the client-level login (username ==
 * clientId, password == clientSecret, both set at onboarding) already
 * works immediately and has full access, no Users row involved. What
 * this adds is a named personal account, so day-to-day operators aren't
 * all sharing that one raw root credential. Skip it (omit admin_username
 * / admin_password from the onboarding event) and use the client login,
 * or seed a Users row manually later via sql-runner (see
 * CLIENT_SETUP.md), if preferred.
 *
 * @param {object} dbConfig - base DB connection config (admin credentials)
 * @param {string} clientUsername - which client's database to insert into
 * @param {{username: string, password: string, email: string, firstName?: string, lastName?: string}} adminData
 */
async function insertAdminUser(dbConfig, clientUsername, adminData) {
  console.log(`Inserting first admin user for: ${clientUsername}`);

  const pgClient = new Client({
    ...dbConfig,
    database: clientUsername
  });

  try {
    await pgClient.connect();

    const hashedPassword = await bcrypt.hash(adminData.password, 10);

    // Full permissions -- this is the client's own first login, not a
    // least-privilege sub-user (see Users table's default, which is
    // checkIn-only, for the contrast). More sub-users can be created
    // normally from User Management once this one can log in.
    const permissions = {
      view: true,
      edit: true,
      checkIn: true,
      marketing: true,
      admin: true
    };

    const insertQuery = `
      INSERT INTO public."Users" (
        "Username",
        "Password",
        "Email",
        "FirstName",
        "LastName",
        "Permissions"
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `;

    await pgClient.query(insertQuery, [
      adminData.username,
      hashedPassword,
      adminData.email,
      adminData.firstName || null,
      adminData.lastName || null,
      JSON.stringify(permissions)
    ]);

    console.log('Admin user inserted successfully');

  } finally {
    await pgClient.end();
  }
}

/**
 * Creates S3 buckets for the client and sets up initial files/folders
 * @param {string} clientUsername - Client username (will be lowercased for bucket names)
 */
async function createS3Buckets(clientUsername, bucketPrefix = "indietix-") {
  const lowerUsername = clientUsername.toLowerCase();
  console.log(`Creating S3 buckets for client: ${clientUsername} (buckets: ${bucketPrefix}${lowerUsername})`);

  const bucketNames = [
    `${bucketPrefix}${lowerUsername}`,
    `${bucketPrefix}${lowerUsername}-bdor`
  ];
  
  const results = [];
  
  // Create both buckets first
  for (const bucketName of bucketNames) {
    try {
      const command = new CreateBucketCommand({
        Bucket: bucketName,
        CreateBucketConfiguration: {
          LocationConstraint: process.env.AWS_REGION || 'us-east-2'
        }
      });
      
      await s3Client.send(command);
      console.log(`S3 bucket created successfully: ${bucketName}`);
      results.push({ bucket: bucketName, action: 'created', success: true });
      
    } catch (error) {
      // bootstrap.sh's client-buckets stack creates the main bucket (with its
      // own public-access, policy and CORS settings) before onboarding runs.
      // Treat it as existing so templates and folders still get set up.
      if (error.name === 'BucketAlreadyOwnedByYou') {
        console.log(`S3 bucket already exists (owned by this account): ${bucketName}`);
        results.push({ bucket: bucketName, action: 'already_exists', success: true, preexisting: true });
        continue;
      }
      console.error(`Error creating S3 bucket ${bucketName}:`, error);
      results.push({ bucket: bucketName, action: 'create_failed', success: false, error: error.message });
    }
  }
  
  // Set up initial files and folders in the main bucket (not -bdor)
  const mainBucketName = `${bucketPrefix}${lowerUsername}`;
  
  // Check if main bucket was created successfully
  const mainBucketResult = results.find(r => r.bucket === mainBucketName);
  if (mainBucketResult && mainBucketResult.success) {
    
    // A pre-existing bucket's access settings are managed by whoever created it (the client-buckets stack).
    if (!mainBucketResult.preexisting) {
      // Configure Block Public Access settings - Allow bucket policies but block ACLs
      try {
        const publicAccessBlockConfig = new PutPublicAccessBlockCommand({
          Bucket: mainBucketName,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,        // Block public ACLs (keep checked)
            IgnorePublicAcls: true,       // Ignore public ACLs (keep checked)
            BlockPublicPolicy: false,     // Allow public bucket policies (uncheck)
            RestrictPublicBuckets: false  // Allow public bucket policies (uncheck)
          }
        });
      
        await s3Client.send(publicAccessBlockConfig);
        console.log(`Block Public Access configured for: ${mainBucketName}`);
        results.push({ 
          bucket: mainBucketName, 
          action: 'configure_public_access', 
          success: true 
        });
      
      } catch (error) {
        console.error(`Error configuring Block Public Access for ${mainBucketName}:`, error);
        results.push({ 
          bucket: mainBucketName, 
          action: 'configure_public_access_failed', 
          success: false, 
          error: error.message 
        });
      }
    
    }
    
    // Copy ticket template files from the templates bucket.
    //
    // Templates live in a dedicated bucket (not tied to any client) so that
    // client teardown can never accidentally delete the templates. Bucket
    // name is configurable via TICKET_TEMPLATES_BUCKET env var; defaults to
    // 'indietix-ticket-templates' if unset. The bucket must contain
    // ticket_horizontal.pdf and ticket_vertical.pdf at the root.
    const templatesBucket = process.env.TICKET_TEMPLATES_BUCKET || 'indietix-ticket-templates';
    const ticketFiles = [
      { source: 'ticket_horizontal.pdf', destination: 'ticket_horizontal.pdf' },
      { source: 'ticket_vertical.pdf', destination: 'ticket_vertical.pdf' }
    ];
    
    for (const ticketFile of ticketFiles) {
      try {
        const copyCommand = new CopyObjectCommand({
          Bucket: mainBucketName,
          CopySource: `${templatesBucket}/${ticketFile.source}`,
          Key: ticketFile.destination
        });
        
        await s3Client.send(copyCommand);
        console.log(`Ticket template copied successfully to: ${mainBucketName}/${ticketFile.destination}`);
        results.push({ 
          bucket: mainBucketName, 
          action: 'copy_ticket_template', 
          success: true, 
          source: `${templatesBucket}/${ticketFile.source}`,
          destination: ticketFile.destination
        });
        
      } catch (error) {
        console.error(`Error copying ticket template ${ticketFile.source} to ${mainBucketName}:`, error);
        results.push({ 
          bucket: mainBucketName, 
          action: 'copy_ticket_template_failed', 
          success: false, 
          source: ticketFile.source,
          error: error.message 
        });
      }
    }
    
    // Create folders
    const foldersToCreate = ['tickets-out/', 'movie-posters/', 'digest-backgrounds/', 'digest-generated/'];
    
    for (const folder of foldersToCreate) {
      try {
        const createFolderCommand = new PutObjectCommand({
          Bucket: mainBucketName,
          Key: folder,
          Body: '',
          ContentType: 'application/x-directory'
        });
        
        await s3Client.send(createFolderCommand);
        console.log(`Folder created successfully: ${mainBucketName}/${folder}`);
        results.push({ 
          bucket: mainBucketName, 
          action: 'create_folder', 
          success: true, 
          folder: folder
        });
        
      } catch (error) {
        console.error(`Error creating ${folder} folder in ${mainBucketName}:`, error);
        results.push({ 
          bucket: mainBucketName, 
          action: 'create_folder_failed', 
          success: false, 
          folder: folder,
          error: error.message 
        });
      }
    }
    
    // Same for its bucket policy and CORS.
    if (!mainBucketResult.preexisting) {
      // Apply bucket policy for public read access to movie-posters and the
      // weekly digest's background/generated images -- same reasoning as
      // movie-posters: these need to load directly in <img> tags and email
      // bodies without a presigned URL, unlike tickets-out (which stays
      // private, see TICKET_SIGNER_* in app.mjs/getSquareOrders).
      try {
        const bucketPolicy = {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "PublicReadMoviePosters",
              Effect: "Allow",
              Principal: "*",
              Action: "s3:GetObject",
              Resource: `arn:aws:s3:::${mainBucketName}/movie-posters/*`
            },
            {
              Sid: "PublicReadDigestImages",
              Effect: "Allow",
              Principal: "*",
              Action: "s3:GetObject",
              Resource: [
                `arn:aws:s3:::${mainBucketName}/digest-backgrounds/*`,
                `arn:aws:s3:::${mainBucketName}/digest-generated/*`
              ]
            }
          ]
        };
      
        const policyCommand = new PutBucketPolicyCommand({
          Bucket: mainBucketName,
          Policy: JSON.stringify(bucketPolicy)
        });
      
        await s3Client.send(policyCommand);
        console.log(`Bucket policy applied successfully to: ${mainBucketName}`);
        results.push({ 
          bucket: mainBucketName, 
          action: 'apply_bucket_policy', 
          success: true 
        });
      
      } catch (error) {
        console.error(`Error applying bucket policy to ${mainBucketName}:`, error);
        results.push({ 
          bucket: mainBucketName, 
          action: 'apply_bucket_policy_failed', 
          success: false, 
          error: error.message 
        });
      }
    
      // Apply CORS configuration
      try {
        const corsConfiguration = {
          CORSRules: [
            {
              AllowedHeaders: ["*"],
              AllowedMethods: ["PUT", "POST", "GET"],
              AllowedOrigins: [
                "https://dyme6dznlnzgk.cloudfront.net",
                "http://localhost:3000",
                "http://localhost:8080"
              ],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 3000
            }
          ]
        };
      
        const corsCommand = new PutBucketCorsCommand({
          Bucket: mainBucketName,
          CORSConfiguration: corsConfiguration
        });
      
        await s3Client.send(corsCommand);
        console.log(`CORS configuration applied successfully to: ${mainBucketName}`);
        results.push({ 
          bucket: mainBucketName, 
          action: 'apply_cors_config', 
          success: true 
        });
      
      } catch (error) {
        console.error(`Error applying CORS configuration to ${mainBucketName}:`, error);
        results.push({ 
          bucket: mainBucketName, 
          action: 'apply_cors_config_failed', 
          success: false, 
          error: error.message 
        });
      }
    
    }
    
  } else {
    console.log(`Skipping file setup for ${mainBucketName} because bucket creation failed`);
  }
  
  return results;
}

/**
 * Deletes client and all associated resources
 * @param {Object} dbConfig - Database configuration
 * @param {string} clientUsername - Client username to delete
 */
async function deleteClient(dbConfig, clientUsername) {
  console.log(`Starting deletion process for client: ${clientUsername}`);
  
  const results = {
    clientUsername,
    postgresUserDeleted: false,
    databaseDeleted: false,
    secretDeleted: false,
    squareSecretDeleted: false,
    s3BucketsHandled: []
  };
  
  try {
    // 1. Delete AWS Secrets Manager secret
    const secretDeleted = await deleteClientSecret(clientUsername);
    results.secretDeleted = secretDeleted;
    // 1a. Its Connect Square refresh token, if any ('none' for personal-token venues).
    results.squareSecretDeleted = await deleteSquareRefreshSecret(clientUsername);

    // 1b. Look up the bucket prefix this client was actually created with,
    // from its own database -- must happen before the database is dropped
    // (step 3), since this is the only place that value lives. Every real
    // client onboarded before this field existed has no S3_BUCKET_PREFIX
    // key at all, hence the "indietix-" fallback -- matches createS3Buckets'
    // own default, so existing clients' teardown behavior is unchanged.
    let bucketPrefix = "indietix-";
    try {
      const clientDbClient = new Client({ ...dbConfig, database: clientUsername });
      try {
        await clientDbClient.connect();
        const configResult = await clientDbClient.query(
          `SELECT "configuration"->>'S3_BUCKET_PREFIX' AS prefix FROM "Client" LIMIT 1`
        );
        if (configResult.rows[0]?.prefix) {
          bucketPrefix = configResult.rows[0].prefix;
        }
      } finally {
        await clientDbClient.end();
      }
    } catch (error) {
      console.error(`Could not read S3_BUCKET_PREFIX for ${clientUsername}, defaulting to "indietix-":`, error.message);
    }

    // 2. Delete/empty S3 buckets
    const lowerUsername = clientUsername.toLowerCase();
    const bucketNames = [
      `${bucketPrefix}${lowerUsername}`,
      `${bucketPrefix}${lowerUsername}-bdor`
    ];
    
    for (const bucketName of bucketNames) {
      try {
        // First, list and delete all objects in the bucket
        const listCommand = new ListObjectsV2Command({ Bucket: bucketName });
        const listResponse = await s3Client.send(listCommand);
        
        if (listResponse.Contents && listResponse.Contents.length > 0) {
          const deleteObjects = listResponse.Contents.map(obj => ({ Key: obj.Key }));
          const deleteCommand = new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: deleteObjects }
          });
          await s3Client.send(deleteCommand);
          console.log(`Deleted ${deleteObjects.length} objects from bucket: ${bucketName}`);
        }
        
        // Then delete the bucket
        const deleteBucketCommand = new DeleteBucketCommand({ Bucket: bucketName });
        await s3Client.send(deleteBucketCommand);
        
        console.log(`S3 bucket deleted successfully: ${bucketName}`);
        results.s3BucketsHandled.push({ bucket: bucketName, action: 'deleted', success: true });
        
      } catch (error) {
        console.error(`Error handling S3 bucket ${bucketName}:`, error);
        results.s3BucketsHandled.push({ 
          bucket: bucketName, 
          action: 'delete_failed', 
          success: false, 
          error: error.message 
        });
      }
    }
    
    // 3. Drop the client database and user
    const pgClient = new Client({
      ...dbConfig,
      database: 'postgres'
    });
    
    try {
      await pgClient.connect();
      
      // Terminate any active connections to the database
      const terminateConnectionsQuery = `
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()
      `;
      await pgClient.query(terminateConnectionsQuery, [clientUsername]);
      
      // Drop the database
      const dropDbQuery = `DROP DATABASE IF EXISTS "${clientUsername}"`;
      await pgClient.query(dropDbQuery);
      
      console.log(`Database deleted successfully: ${clientUsername}`);
      results.databaseDeleted = true;
      
      // Drop the PostgreSQL user
      const dropUserQuery = `DROP USER IF EXISTS "${clientUsername}"`;
      await pgClient.query(dropUserQuery);
      
      console.log(`PostgreSQL user deleted successfully: ${clientUsername}`);
      results.postgresUserDeleted = true;
      
    } finally {
      await pgClient.end();
    }
    
  } catch (error) {
    console.error(`Error in delete process for client ${clientUsername}:`, error);
    results.error = error.message;
  }
  
  return results;
}

/**
 * Main Lambda handler
 */
exports.handler = async (event, context) => {
  console.log('Client Setup Lambda started');
  console.log('Event:', redactEvent(event));
  
  try {
    // Get database credentials from Secrets Manager
    const dbCredentials = await getAdminDbCredentials();
    
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
    
    // Parse input parameters
    const {
      username,
      clientSecret,
      contactName,
      clientEmail,
      square_access_token,
      square_signature_key,
      square_webhook_url,
      square_location_id,
      square_oauth,
      settings,
      sender_email,
      theater_id = "000000",
      theater_name,
      film_code_prefix,
      s3_bucket_prefix,
      admin_username,
      admin_password,
      admin_email,
      admin_first_name,
      admin_last_name,
      delete_flag = false
    } = event;

    // Validate required parameters for creation
    if (!delete_flag) {
      if (!username || !clientSecret || !contactName || !clientEmail ||
          !square_access_token || !square_signature_key) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Missing required parameters',
            required: ['username', 'clientSecret', 'contactName', 'clientEmail', 'square_access_token', 'square_signature_key']
          })
        };
      }

      if (settings !== undefined && (settings === null || typeof settings !== 'object' || Array.isArray(settings))) {
        return {
          statusCode: 400,
          body: JSON.stringify({ error: 'Invalid settings', message: 'settings must be an object of Client Settings keys and values' })
        };
      }

      // Validate username for S3 bucket naming compliance
      try {
        validateUsername(username);
      } catch (validationError) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Invalid username',
            message: validationError.message,
            note: 'Username must be valid for S3 bucket naming (3-63 chars, letters/numbers/dots/hyphens only, start/end with letter/number)'
          })
        };
      }

      // Admin user creation is optional, but username+password must come
      // as a pair -- half-specified credentials are almost certainly a
      // mistake, not an intentional "skip this" signal.
      if ((admin_username && !admin_password) || (!admin_username && admin_password)) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'admin_username and admin_password must be provided together, or not at all',
          })
        };
      }
    }
    
    // Handle delete operation
    if (delete_flag) {
      if (!username) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: 'Username is required for delete operation'
          })
        };
      }
      
      const deleteResults = await deleteClient(baseDbConfig, username);
      
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: `Client deletion process completed for: ${username}`,
          results: deleteResults,
          timestamp: new Date().toISOString()
        })
      };
    }
    
    // Handle create operation
    const clientData = {
      username,
      clientSecret,
      contactName,
      clientEmail,
      square_access_token,
      square_signature_key,
      square_webhook_url,
      square_location_id,
      square_oauth,
      settings,
      sender_email: sender_email || `${contactName.replace(/\s+/g, '').toLowerCase()}@indietix.net`,
      theater_id,
      theater_name: theater_name || contactName,
      film_code_prefix: deriveFilmCodePrefix(film_code_prefix, theater_name || contactName, username),
      s3_bucket_prefix: s3_bucket_prefix || "indietix-"
    };
    
    console.log('Creating client with data:', redactEvent(clientData));
    
    // Step 1: Create PostgreSQL user
    await createPostgreSQLUser(baseDbConfig, username, clientSecret);
    
    // Step 2: Create client database
    await createClientDatabase(baseDbConfig, username);
    
    // Step 3: Create all database objects
    await createDatabaseObjects(baseDbConfig, username, theater_id, theater_name || contactName, clientData.film_code_prefix);
    
    // Step 4: Grant database permissions to the user
    await grantDatabasePermissions(baseDbConfig, username);
    
    // Step 5: Create AWS Secrets Manager secret for client
    const secretName = await createClientSecret(username, clientSecret, baseDbConfig);
    
    // Step 6: Insert client record
    await insertClientRecord(baseDbConfig, username, clientData);

    // Step 7: Create S3 buckets
    const s3Results = await createS3Buckets(username, clientData.s3_bucket_prefix);

    // Step 8: Insert the first admin user, if credentials were provided.
    // Optional -- see insertAdminUser's own comment for why this exists.
    let adminUserCreated = false;
    if (admin_username && admin_password) {
      await insertAdminUser(baseDbConfig, username, {
        username: admin_username,
        password: admin_password,
        email: admin_email || clientEmail,
        firstName: admin_first_name,
        lastName: admin_last_name
      });
      adminUserCreated = true;
    }

    console.log('Client setup completed successfully');

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Client setup completed successfully for: ${username}`,
        clientData: {
          username: clientData.username,
          contactName: clientData.contactName,
          clientEmail: clientData.clientEmail,
          sender_email: clientData.sender_email,
          theater_id: clientData.theater_id,
          theater_name: clientData.theater_name
        },
        secretName: secretName,
        s3Results: s3Results,
        adminUserCreated: adminUserCreated,
        timestamp: new Date().toISOString()
      })
    };
    
  } catch (error) {
    console.error('Fatal error in client setup:', error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Fatal error in client setup',
        message: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};

// Exported for test-db-harness and this repo's own tests -- the canonical
// schema definition (tables/indexes/functions/views) a fresh client
// database gets, decoupled from the full onboarding flow (DB user/database
// creation, S3 buckets, Secrets Manager) that exports.handler also does.
// Does NOT change exports.handler's own behavior.
exports.createDatabaseObjects = createDatabaseObjects;
exports.createS3Buckets = createS3Buckets;
exports.deleteSquareRefreshSecret = deleteSquareRefreshSecret;
exports.insertClientRecord = insertClientRecord;
