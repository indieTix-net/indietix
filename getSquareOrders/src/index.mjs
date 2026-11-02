import {
  S3,
  S3Client,
  CreateBucketCommand,
  ListObjectsCommand,
  CopyObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import nodemailer from 'nodemailer';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import mailcomposer from 'mailcomposer';
import pg from 'pg';
import crypto from 'crypto';
import { WebhooksHelper } from "square";

// SMS opt-in utilities (replaces the old SNS-based sendTicketSMS path; the
// SNS-direct-to-number approach doesn't work with 10DLC and has been the
// source of carrier rejections. All SMS now flows through sendSms() which
// uses AWS End User Messaging / Pinpoint SMS v2 with the registered campaign.)
import { sendSms, buildMessageBody, normalizeToE164 } from 'sms-utils';

// Shared QR-gen/PDF-overlay logic (see ../../ticket-pdf-lib), proven out
// first in QRScanner's ticket-transfer feature before being wired in here --
// the live order-processing pipeline. Faithful port, confirmed line-for-line
// equivalent to this file's old generateQRCode/overlayQRCodeOnPdf/
// getPdfFromS3/savePdfToS3 (now removed) before switching over.
import { generateQRCode, renderTicketPdf, fetchPdfFromS3, savePdfToS3 } from 'ticket-pdf-lib';

const { Pool } = pg;

// Initialize AWS clients
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION });
const s3 = new S3();
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const sesClient = new SESClient({ region: process.env.AWS_REGION });

// Global variables for client configuration
let clientConfig = {};

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
 * Creates and validates a database connection pool using AWS Secrets Manager credentials
 * @param {string} clientId - The client ID, which is also the database name
 * @returns {Promise<Object|null>} - Returns a database pool if successful, null if not
 */
async function getClientPoolWithSecrets(clientId) {
  try {
    // Validate the clientId format (alphanumeric only)
    if (!clientId || !/^[A-Za-z0-9]+$/.test(clientId)) {
      console.error(`Invalid clientId format: ${clientId}`);
      return null;
    }
    
    // Get database credentials from AWS Secrets Manager
    const dbCredentials = await getDatabaseCredentials(clientId);
    
    // Create a pool for this specific client database
    const clientPool = new Pool({
      host: dbCredentials.host,
      port: parseInt(dbCredentials.port || '5432'),
      database: clientId, // Database name is the clientId
      user: dbCredentials.username,
      password: dbCredentials.password,
      ssl: dbCredentials.ssl === 'true' ? { rejectUnauthorized: false } : false,
      // Set a shorter idle timeout for Lambda environment
      idleTimeoutMillis: 10000,
      // Set reasonable pool limits for Lambda
      max: 8 // Maximum 3 clients in the pool
    });
    
    // Test the connection to verify the database exists
    try {
      const client = await clientPool.connect();
      console.log(`Successfully connected to database: ${clientId}`);
      client.release();
      return clientPool;
    } catch (connError) {
      console.error(`Error connecting to client database ${clientId}:`, connError);
      
      // Try to properly close the pool before returning null
      try {
        await clientPool.end();
      } catch (endError) {
        console.error(`Error closing pool for ${clientId}:`, endError);
      }
      
      return null;
    }
  } catch (error) {
    console.error(`Error creating pool for client ${clientId}:`, error);
    return null;
  }
}

/**
 * Retrieves client configuration from the database
 * @param {Object} pool - PostgreSQL connection pool
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
    return config;
  } catch (error) {
    console.error(`Error retrieving client configuration for ${clientId}:`, error);
    throw error;
  }
}

// Create a Nodemailer transporter using AWS SES
const transporter = nodemailer.createTransport({
  SES: { ses: sesClient, aws: { defaultProvider } }
});

// A walk-up/cash sale with no captured buyer email falls back to
// clientConfig.OWNER_BCC_EMAIL if the client has one set (see
// sendEmailWithMultipleAttachments) -- no global default here. Used to be
// a hardcoded Liberty Hall personal address shared across every client;
// see clientSetup-Teardown's 2026-10-25 OWNER_BCC_EMAIL migration.

// Square API URLs
const SQUARE_API_URL = "https://connect.squareup.com/v2/orders/";
const SQUARE_CATALOG_API_URL = "https://connect.squareup.com/v2/catalog/batch-retrieve";
const SQUARE_CUSTOMER_API_URL = "https://connect.squareup.com/v2/customers/";

/**
 * Generates a presigned URL for S3 object download
 * @param {string} bucket - S3 bucket name
 * @param {string} key - S3 object key
 * @param {number} expiresIn - URL expiration time in seconds (default: 7 days)
 * @returns {Promise<string>} - Presigned download URL
 */
async function generatePresignedUrl(bucket, key, expiresIn = 604800) { // 7 days default
  try {
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const { GetObjectCommand, S3Client: S3ClientCtor } = await import('@aws-sdk/client-s3');

    // Sign with dedicated IAM user credentials, NOT Lambda's STS credentials.
    // STS credentials append X-Amz-Security-Token (~800-1500 chars) to the URL,
    // pushing SMS bodies over AWS's 1600-char messageBody limit. The dedicated
    // user has s3:GetObject only on indietix-*/tickets-out/* -- narrow scope.
    // Credentials come from TICKET_SIGNER_ACCESS_KEY / TICKET_SIGNER_SECRET_KEY
    // env vars, set on the Lambda.
    const signingClient = new S3ClientCtor({
      region: process.env.AWS_REGION,
      credentials: {
        accessKeyId: process.env.TICKET_SIGNER_ACCESS_KEY,
        secretAccessKey: process.env.TICKET_SIGNER_SECRET_KEY
      }
    });

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    
    const signedUrl = await getSignedUrl(signingClient, command, { expiresIn });
    console.log(`Generated presigned URL for ${bucket}/${key}`);
    return signedUrl;
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw error;
  }
}

/**
 * Generates an opaque, unguessable opt-in URL token (22 chars in base64url).
 * One token per order; same token covers all tickets in the order, so a
 * single opt-in click opts the customer in for everything in that purchase.
 * Fits inside Order.OptInToken VARCHAR(32) with room to spare.
 */
function generateOptInToken() {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Upserts a Customer row keyed by phone number (E.164 normalized, unique),
 * falling back to email lookup when no phone is available.
 *
 * Phone is the primary SMS identity. Email is indexed but not unique --
 * families may share emails, so we don't use email as the upsert key.
 *
 * Behavior:
 *  - normalized phone present: INSERT ON CONFLICT (phone) DO UPDATE
 *    (refresh email/name in case the customer corrected something)
 *  - phone missing/invalid but email present: look up the most recent
 *    Customer row with that email; return its ID if found, else null
 *    (we don't create new Customer records via email alone -- the
 *    SmsConsent web flow does that when the customer types in a phone)
 *  - neither: null
 *
 * @returns {Promise<number|null>} Customer.ID or null
 */
async function upsertCustomer(pool, email, rawPhone, firstName, lastName) {
  const normalizedPhone = normalizeToE164(rawPhone);

  if (normalizedPhone) {
    const result = await pool.query(
      `INSERT INTO "Customer" ("PhoneNumber", "Email", "FirstName", "LastName", "CreatedDate", "UpdatedDate")
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT ("PhoneNumber") DO UPDATE SET
         "Email"       = COALESCE(EXCLUDED."Email", "Customer"."Email"),
         "FirstName"   = COALESCE(EXCLUDED."FirstName", "Customer"."FirstName"),
         "LastName"    = COALESCE(EXCLUDED."LastName", "Customer"."LastName"),
         "UpdatedDate" = CURRENT_TIMESTAMP
       RETURNING "ID"`,
      [normalizedPhone, email || null, firstName || null, lastName || null]
    );
    return result.rows[0].ID;
  }

  if (email) {
    const result = await pool.query(
      `SELECT "ID" FROM "Customer" WHERE "Email" = $1 ORDER BY "UpdatedDate" DESC LIMIT 1`,
      [email]
    );
    if (result.rows.length > 0) {
      return result.rows[0].ID;
    }
  }

  return null;
}

/**
 * Returns true if the given phone has an active SmsConsent row.
 * Drives two downstream decisions in processWebhook:
 *   (a) whether to auto-send the ticket SMS immediately (active = yes)
 *   (b) whether the email shows the "text me" CTA (active = NO CTA shown,
 *       because re-prompting opted-in customers would be confusing)
 *
 * @param {Object} pool - PostgreSQL connection pool
 * @param {string} normalizedPhone - E.164-formatted phone number, or null
 * @returns {Promise<boolean>}
 */
async function hasActiveConsentForPhone(pool, normalizedPhone) {
  if (!normalizedPhone) return false;
  const result = await pool.query(
    `SELECT 1 FROM "SmsConsent" WHERE "PhoneNumber" = $1 AND "Status" = 'active' LIMIT 1`,
    [normalizedPhone]
  );
  return result.rows.length > 0;
}

/**
 * Parses item modifier values to extract both datetime and venue information
 * Handles formats like "Sun 05-25-2025 8:00 PM (Little Theatre)" or "Sun 05-25-2025 8:00 PM (Little Theatre, captions)"
 * 
 * @param {string} modifierStr - The input modifier string to parse
 * @param {Object} options - Options for parsing
 * @param {boolean} options.includeTimezone - Whether to include timezone in the output (default: false)
 * @param {string} options.defaultYear - Default year to use if not specified (default: current year)
 * @returns {Object} - Object containing { datetime: string|null, eventVenue: string }
 */
function parseItemModifierValues(modifierStr, options = {}) {
  // Default options
  const defaults = {
    includeTimezone: false,
    defaultYear: new Date().getFullYear()
  };
  
  const opts = { ...defaults, ...options };
  
  if (!modifierStr || typeof modifierStr !== 'string') {
    return {
      datetime: null,
      eventVenue: 'Main'
    };
  }
  
  // Normalize input - handle multiple spaces
  let input = modifierStr.trim().replace(/\s+/g, ' ');
  
  // Extract venue information from parentheses
  let eventVenue = 'Main'; // Default venue
  let dateTimeStr = input;
  
  // Look for venue information in parentheses
  const venueMatch = input.match(/\(([^,)]+)(?:,.*?)?\)/);
  if (venueMatch) {
    eventVenue = venueMatch[1].trim();
    // Remove the parentheses part to get just the datetime portion
    dateTimeStr = input.replace(/\s*\([^)]*\)\s*$/, '').trim();
  }
  
  console.log(`Parsing modifier: "${modifierStr}" -> DateTime: "${dateTimeStr}", Venue: "${eventVenue}"`);
  
  // Parse the datetime portion using the existing logic. Was `const
  // datetime` before 2026-10-25 -- reassigning it in the fallback branch
  // below threw "Assignment to constant variable", which this function's
  // one caller (processWebhook) catches per-ticket and swallows, silently
  // dropping the whole ticket for a paid order whenever a showtime string
  // didn't match any of parseToPostgresTimestamp's patterns.
  let datetime = parseToPostgresTimestamp(dateTimeStr, opts);
  if (!datetime) {
    datetime = new Date().toISOString().slice(0, 19).replace('T', ' ');
  }
  return {
    datetime: datetime,
    eventVenue: eventVenue
  };
}

/**
 * Fetches selection value for a custom attribute from Square API
 * @param {string} definitionId - The custom attribute definition ID
 * @param {string} selectionId - The selection UID value to look up
 * @returns {Promise<string>} - The string value of the selection
 */
async function fetchSelectionValue(definitionId, selectionId) {
  try {
    if (!definitionId || !selectionId) {
      console.log("Missing definition ID or selection ID for attribute lookup");
      return "Unknown";
    }

    console.log(`Fetching selection value for definitionId: ${definitionId}, selectionId: ${selectionId}`);
    
    // Direct API call to get the definition
    const url = `https://connect.squareup.com/v2/catalog/object/${definitionId}`;
    
    console.log(`Making API call to: ${url}`);
    
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${clientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to fetch selection definition: ${response.status} ${errorText}`);
      return "Unknown";
    }

    const definitionData = await response.json();
    
    // Log the structure to verify
    console.log(`Looking for selection ID: ${selectionId} in response`);
    
    // Check if object exists and contains the selections in allowed_selections
    if (definitionData.object && 
        definitionData.object.custom_attribute_definition_data && 
        definitionData.object.custom_attribute_definition_data.selection_config && 
        definitionData.object.custom_attribute_definition_data.selection_config.allowed_selections) {
      
      // This is the key change - looking in allowed_selections instead of selections
      const selections = definitionData.object.custom_attribute_definition_data.selection_config.allowed_selections;
      console.log(`Found ${selections.length} allowed selections`);
      
      // Find the matching selection
      const matchingSelection = selections.find(selection => selection.uid === selectionId);
      
      if (matchingSelection) {
        console.log(`Found matching selection: ${matchingSelection.name} for ID: ${selectionId}`);
        return matchingSelection.name;
      } else {
        console.log(`Selection ID ${selectionId} not found in the ${selections.length} available selections`);
        
        // Log all selection UIDs for debugging
        const allUIDs = selections.map(s => s.uid).join(', ');
        console.log(`Available selection UIDs: ${allUIDs}`);
      }
    } else {
      console.log("Could not find the expected selection_config.allowed_selections path in the response");
      console.log("Response structure:", JSON.stringify(definitionData, null, 2));
    }
    
    console.log(`No matching selection found for ID: ${selectionId}`);
    return "Unknown";
  } catch (error) {
    console.error(`Error fetching selection value: ${error}`);
    return "Unknown";
  }
}

// Modified getCatalogItemsDetailsForQR function (EventVenue now comes from modifier parsing)
function getCatalogItemsDetailsForQR(orderData, catalogData) {
  // Part 1: Collect all catalog items that have the UseQRCode property set to true
  const itemIDsWithQRCodes = [];
  const reportingCategories = [];
  const distributors = {}; // Object to store Distributor values by variation ID
  const eventTypes = {}; // Object to store EventType values by variation ID
  
  // Log the whole catalog data structure for debugging
  console.log("Catalog data structure:", JSON.stringify(catalogData, null, 2));
  
  // Step 1: Loop through all the objects in the "related_objects" array
  if (catalogData.related_objects && Array.isArray(catalogData.related_objects)) {
    catalogData.related_objects.forEach(relatedObject => {
      // Step 2: Check if it's an ITEM type and has custom attribute values
      if (relatedObject.type === 'ITEM') {
        let hasQRCode = false;
        let distributorInfo = null; // Store the Distributor selection info
        let eventTypeInfo = null; // Store the EventType selection info
        
        // Log item for debugging
        console.log(`Examining item: ${relatedObject.id}, name: ${relatedObject.item_data?.name}`);
        
        // Check for custom attributes at the item level
        if (relatedObject.custom_attribute_values && 
          typeof relatedObject.custom_attribute_values === 'object' && 
          relatedObject.custom_attribute_values !== null) {
          
          console.log(`Item has custom attributes: ${JSON.stringify(relatedObject.custom_attribute_values)}`);
          
          // Examine each custom attribute
          Object.entries(relatedObject.custom_attribute_values).forEach(([key, attribute]) => {
            console.log(`Examining attribute: ${key}, name: ${attribute.name}, type: ${attribute.type}`);
            
            // Check for UseQRCode using client config
            if (attribute.name === clientConfig.USE_QR_CODE && attribute.boolean_value === true) {
              hasQRCode = true;
              console.log(`Found ${clientConfig.USE_QR_CODE} attribute set to true`);
            }
            
            // Check for Distributor attribute using client config
            //if ((attribute.name === clientConfig.DISTRIBUTOR_NAME || attribute.name === 'Distributor') && 
            if ((attribute.name === clientConfig.DISTRIBUTOR_NAME) && 
                attribute.type === 'SELECTION' && 
                attribute.selection_uid_values && attribute.selection_uid_values.length > 0) {
              
              console.log(`Found distributor attribute: ${attribute.name} with selection ID: ${attribute.selection_uid_values[0]}`);
              
              distributorInfo = {
                definitionId: attribute.custom_attribute_definition_id,
                selectionId: attribute.selection_uid_values[0]
              };
            }
            
            // Check for EventType attribute using client config
            //if ((attribute.name === clientConfig.EVENT_TYPE || attribute.name === 'EventType') && 
            if ((attribute.name === clientConfig.EVENT_TYPE) && 
                attribute.type === 'SELECTION' && 
                attribute.selection_uid_values && attribute.selection_uid_values.length > 0) {
              
              console.log(`Found event type attribute: ${attribute.name} with selection ID: ${attribute.selection_uid_values[0]}`);
              
              eventTypeInfo = {
                definitionId: attribute.custom_attribute_definition_id,
                selectionId: attribute.selection_uid_values[0]
              };
            }
          });
        }

        // If we didn't find UseQRCode at the item level, check at the variation level
        if (!hasQRCode && relatedObject.item_data && relatedObject.item_data.variations) {
          console.log(`Checking variations for ${clientConfig.USE_QR_CODE}`);
          
          relatedObject.item_data.variations.forEach(variation => {
            console.log(`Checking variation: ${variation.id}`);
            
            // Check if custom_attribute_values exists and is an object
            if (variation.custom_attribute_values && 
              typeof variation.custom_attribute_values === 'object' && 
              variation.custom_attribute_values !== null) {
              
              console.log(`Variation has custom attributes: ${JSON.stringify(variation.custom_attribute_values)}`);
              
              // Examine each custom attribute
              Object.entries(variation.custom_attribute_values).forEach(([key, attribute]) => {
                console.log(`Examining attribute: ${key}, name: ${attribute.name}, type: ${attribute.type}`);
                
                // Check for UseQRCode using client config
                if (attribute.name === clientConfig.USE_QR_CODE && attribute.boolean_value === true) {
                  hasQRCode = true;
                  console.log(`Found ${clientConfig.USE_QR_CODE} attribute set to true in variation`);
                }
                
                // Check for Distributor attribute at the variation level using client config
                //if ((attribute.name === clientConfig.DISTRIBUTOR_NAME || attribute.name === 'Distributor') && 
                if ((attribute.name === clientConfig.DISTRIBUTOR_NAME) && 
                    attribute.type === 'SELECTION' && 
                    attribute.selection_uid_values && attribute.selection_uid_values.length > 0) {
                  
                  console.log(`Found distributor at variation level: ${attribute.name} with selection ID: ${attribute.selection_uid_values[0]}`);
                  
                  distributorInfo = {
                    definitionId: attribute.custom_attribute_definition_id,
                    selectionId: attribute.selection_uid_values[0]
                  };
                }
                
                // Check for EventType attribute at the variation level using client config
                //if ((attribute.name === clientConfig.EVENT_TYPE || attribute.name === 'EventType') && 
                if ((attribute.name === clientConfig.EVENT_TYPE) && 
                    attribute.type === 'SELECTION' && 
                    attribute.selection_uid_values && attribute.selection_uid_values.length > 0) {
                  
                  console.log(`Found event type at variation level: ${attribute.name} with selection ID: ${attribute.selection_uid_values[0]}`);
                  
                  eventTypeInfo = {
                    definitionId: attribute.custom_attribute_definition_id,
                    selectionId: attribute.selection_uid_values[0]
                  };
                }
              });
            }
          });
        }
        
        // Step 4: If UseQRCode is true, add all variation IDs to the array
        if (hasQRCode && relatedObject.item_data && relatedObject.item_data.variations) {
          console.log(`Item has ${clientConfig.USE_QR_CODE} and variations - processing`);
          
          relatedObject.item_data.variations.forEach(variation => {
            if (variation.id) {
              console.log(`Adding variation ${variation.id} to QR code items`);
              
              reportingCategories[variation.id] = JSON.stringify(relatedObject.item_data.categories);
              itemIDsWithQRCodes.push(variation.id);
              
              // Store the Distributor info for this variation
              if (distributorInfo) {
                distributors[variation.id] = distributorInfo;
                console.log(`Associated distributor info with variation ${variation.id}`);
              }
              
              // Store the EventType info for this variation
              if (eventTypeInfo) {
                eventTypes[variation.id] = eventTypeInfo;
                console.log(`Associated event type info with variation ${variation.id}`);
              }
              
              // Also check for variation-level attribute overrides
              if (variation.custom_attribute_values) {
                Object.entries(variation.custom_attribute_values).forEach(([key, attribute]) => {
                  // Distributor override using client config
                  //if ((attribute.name === clientConfig.DISTRIBUTOR_NAME || attribute.name === 'Distributor') && 
                  if ((attribute.name === clientConfig.DISTRIBUTOR_NAME) && 
                      attribute.type === 'SELECTION' && 
                      attribute.selection_uid_values && attribute.selection_uid_values.length > 0) {
                    
                    console.log(`Found variation-specific distributor: ${attribute.name} with ID: ${attribute.selection_uid_values[0]}`);
                    
                    // This overrides the item-level distributor info for this variation
                    distributors[variation.id] = {
                      definitionId: attribute.custom_attribute_definition_id,
                      selectionId: attribute.selection_uid_values[0]
                    };
                  }
                  
                  // EventType override using client config
                  //if ((attribute.name === clientConfig.EVENT_TYPE || attribute.name === 'EventType') && 
                  if ((attribute.name === clientConfig.EVENT_TYPE) && 
                      attribute.type === 'SELECTION' && 
                      attribute.selection_uid_values && attribute.selection_uid_values.length > 0) {
                    
                    console.log(`Found variation-specific event type: ${attribute.name} with ID: ${attribute.selection_uid_values[0]}`);
                    
                    // This overrides the item-level event type info for this variation
                    eventTypes[variation.id] = {
                      definitionId: attribute.custom_attribute_definition_id,
                      selectionId: attribute.selection_uid_values[0]
                    };
                  }
                });
              }
            }
          });
        }
      }
    });
  }
  
  // Part 2: Match line items with QR code-enabled catalog items
  const qrCodeItemsForPrint = [];
  
  // Check if orderData has the expected structure
  if (orderData.order && orderData.order.line_items && Array.isArray(orderData.order.line_items)) {
    // Step 1: Loop through line items and check if they match QR code-enabled items
    orderData.order.line_items.forEach(lineItem => {
      if (lineItem.catalog_object_id && itemIDsWithQRCodes.includes(lineItem.catalog_object_id)) {
        // Step 2: Push matching line items to the result array
        lineItem.location_id = orderData.order.location_id;
        lineItem.reportingCategories = reportingCategories[lineItem.catalog_object_id];
        
        // Add Distributor info to the line item if available
        if (distributors[lineItem.catalog_object_id]) {
          lineItem.distributorInfo = distributors[lineItem.catalog_object_id];
          console.log(`Added distributorInfo to line item ${lineItem.name}: ${JSON.stringify(lineItem.distributorInfo)}`);
        } else {
          console.log(`No distributor info found for line item ${lineItem.name}`);
        }
        
        // Add EventType info to the line item if available
        if (eventTypes[lineItem.catalog_object_id]) {
          lineItem.eventTypeInfo = eventTypes[lineItem.catalog_object_id];
          console.log(`Added eventTypeInfo to line item ${lineItem.name}: ${JSON.stringify(lineItem.eventTypeInfo)}`);
        } else {
          console.log(`No event type info found for line item ${lineItem.name}`);
        }
        
        qrCodeItemsForPrint.push(lineItem);
      }
    });
  }
  
  console.log("QR Code Items for Print:", JSON.stringify(qrCodeItemsForPrint));
  return qrCodeItemsForPrint;
}

/**
 * Verifies client credentials against the Client table
 * @param {Object} pool - PostgreSQL connection pool for the client's database
 * @param {string} clientId - The client ID to verify
 * @returns {Promise<Array>} - Array of client records if valid, empty array otherwise
 */
async function verifyClientCredentials(pool, clientId) {
  try {
    // Query the Client table to verify credentials
    const query = `
      SELECT * FROM "Client" 
      WHERE "clientID" = $1
    `;

    const result = await pool.query(query, [clientId]);
    
    // If a row is found, credentials are valid
    const isValid = result.rows.length > 0;
    
    if (isValid) {
      console.log(`Successfully verified credentials for client: ${clientId}`);
    } else {
      console.error(`Invalid credentials for client: ${clientId}`);
      console.error(`query: ${query}`);
      console.error(`result: ${JSON.stringify(result)}`);
    }
    
    return result.rows;
  } catch (error) {
    console.error(`Error verifying client credentials for ${clientId}:`, error);
    return [];
  }
}

/**
 * Saves QR code data to the PostgreSQL database
 */
async function saveQRCodeToDatabase(pool, qrCode, productDetails = '', createJunctionAndOrder = 0, expirationDays = 90) {
  let client;
  try {
    if (createJunctionAndOrder) {
        const query = `
        SELECT * FROM "Order" 
        WHERE "OrderID" = $1
      `;

      const result = await pool.query(query, [productDetails.order_id]);
      
      // If a row is found, credentials are valid
      const isValid = result.rows.length == 0;
      
      if (isValid) {
        console.log(`No previous orders for ${productDetails.order_id}`);
      } else {
        console.error(`already an order for order_id: ${productDetails.order_id}`);
        throw new Error(`already an order for order_id: ${productDetails.order_id}`);
      }
    }
    // Calculate expiration date (default 30 days from now)
    const currentDate = new Date();
    const expirationDate = new Date();
    expirationDate.setDate(currentDate.getDate() + expirationDays);
    
    // Format dates for PostgreSQL
    const currentDateStr = currentDate.toISOString();
    const expirationDateStr = expirationDate.toISOString();
    
    client = await pool.connect();
    // Begin transaction
    await client.query('BEGIN');
    
    // First insert - QR code product with added Distributor, ProductVenue, ProductSeatCode, CustomerID columns
    const productQuery = `
      INSERT INTO "QRCodeProduct" ("QRCode", "CheckedIn", "CreatedDate", "ExpirationDate", "LastEditedDate",
      "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductPrice",
       "ProductID", "ProductMetadata", "EmailAddress", "FirstName", "LastName", "PhoneNumber", "Distributor", "ProductVenue", "ProductSeatCode", "Status", "CustomerID")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
      RETURNING "ID"
    `;
    
    console.log("This is the JoshNewproductDetails"+JSON.stringify(productDetails));
    
    let productValues = [
      qrCode, // QR code value
      false, // checkedIn (false by default)
      currentDateStr, // CreatedDate
      expirationDateStr, // ExpirationDate
      currentDateStr, // LastEditedDate
      productDetails.itemDate, // ProductDate
      productDetails.item_name, // ProductName
      productDetails.itemLocation, // ProductLocation
      productDetails.itemType, // ProductType (now from EventType custom attribute)
      productDetails.itemModifierValues, // ProductDetails
      productDetails.itemPrice, // ProductPrice
      productDetails.itemId, // ProductID
      productDetails.itemDetails, // ProductMetadata
      productDetails.emailAddress, // emailAddress
      productDetails.customerFirstName, // firstName
      productDetails.customerLastName, // lastName
      productDetails.customerPhoneNumber, // phoneNumber
      productDetails.distributor || 'Unknown', // Distributor value
      productDetails.eventVenue || 'Unknown', // ProductVenue value
      productDetails.seatCode || 'Unknown', // ProductSeatCode value (NEW)
      productDetails.status || 'Unknown', // Status value
      productDetails.customerId || null // CustomerID (NEW for SMS opt-in)
    ];
    
    const productResult = await client.query(productQuery, productValues);
    const productId = productResult.rows[0].ID;
    console.log(`QR code saved to database with ID: ${productId}`);
    
    // If we need to create the junction and order records
    let orderId;
    let orderQuery;
    let orderValues;
    let orderResult;
    if (createJunctionAndOrder) {
      // Second insert - Order record (with OptInToken + CustomerID for SMS opt-in)
      orderQuery = `
        INSERT INTO "Order" ("OrderID", "CreatedDate", "LastEditedDate", "OrderMetaData", "EmailAddress", "FirstName", "LastName", "PhoneNumber", "OptInToken", "CustomerID")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING "ID"
      `;
      
      orderValues = [
        productDetails.order_id, // OrderID
        currentDateStr, // CreatedDate
        currentDateStr, // UpdatedDate
        productDetails.orderDetails,
        productDetails.emailAddress,
        productDetails.customerFirstName, // firstName
        productDetails.customerLastName, // lastName
        productDetails.customerPhoneNumber, // phoneNumber
        productDetails.optInToken || null, // OptInToken (NEW for SMS opt-in)
        productDetails.customerId || null // CustomerID (NEW for SMS opt-in)
      ];
      
      orderResult = await client.query(orderQuery, orderValues);
      orderId = orderResult.rows[0].ID;
      console.log(`set OrderResult with ID: ${orderId}`);
      
    } else {
      
        // Second insert - Order record
        orderQuery = `
          SELECT "ID" FROM "Order" where "OrderID" = $1
        `;
        
        orderValues = [
          productDetails.order_id, // OrderID
        ];
        
        orderResult = await client.query(orderQuery, orderValues);
        console.log(`get OrderResult with ID: `+JSON.stringify(orderResult));
        orderId = orderResult.rows[0].ID;
        console.log(`get OrderResult with ID: ${orderId}`);
        
      
    }
    
     // Third insert - Junction table
     const junctionQuery = `
     INSERT INTO "QRCodeProductToOrder" ("QRCodeProductID", "OrderID", "CreatedDate", "UpdatedDate")
     VALUES ($1, $2, $3, $4)
     RETURNING "ID"
   `;
   
   const junctionValues = [
     productId, // ProductID
     orderId, // OrderID
     currentDateStr, // CreatedDate
     currentDateStr // UpdatedDate
   ];
   
   const junctionResult = await client.query(junctionQuery, junctionValues);
   console.log(`JunctionResult with ID: ${junctionResult.rows[0].ID}`);
    // Commit the transaction - all changes are saved
    await client.query('COMMIT');
    
    return productId;
    
    // Insert QR code data into the database
    
  } catch (error) {
    //new line below
    if (client) {
      await client.query('ROLLBACK');
    }
    console.error("Error saving QR code to database:", error);
    throw error;
  } finally {
    // Always release the client back to the pool
    if (client) {
      client.release();
    }
  }
  
}


async function getCustomer(customerId) {
  try {
    const response = await fetch(SQUARE_CUSTOMER_API_URL + customerId, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${clientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch customer: ${response.status} ${errorText}`);
    }

    const customerData = await response.json();
    console.log(`Customer data: ${JSON.stringify(customerData)}`);
    return customerData;
  }
  catch (error) {
    console.error(`Error fetching customer data:`, error);
    return {};
  }

}

/**
 * Fetch catalog item details from Square API
 */
async function fetchCatalogItems(catalogObjectIds) {
  try {
    if (!catalogObjectIds || catalogObjectIds.length === 0) {
      return {};
    }

    console.log(`Fetching catalog details for ${catalogObjectIds.length} items`);
    
    const response = await fetch(SQUARE_CATALOG_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${clientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        object_ids: catalogObjectIds,
        include_related_objects: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch catalog items: ${response.status} ${errorText}`);
    }

    const catalogData = await response.json();
    console.log(`Item catalog details  ${JSON.stringify(catalogData)} `);
    return catalogData;
  }
  catch (error) {
    console.error(`Error fetching catalog items:`, error);
    return {};
  } 
}

/**
 * Extract custom attributes from catalog item
 */
function extractCustomAttributes(catalogItem) {
  if (!catalogItem || !catalogItem.custom_attribute_values) {
    return {};
  }
  
  const customAttributes = {};
  for (const [key, value] of Object.entries(catalogItem.custom_attribute_values)) {
    customAttributes[key] = value.string_value || value.number_value || value.boolean_value || value.selection_uid_values;
  }
  
  return customAttributes;
}

/**
 * Parses various timestamp formats and converts them to a Postgres-compatible timestamp string
 * Handles standard formats and non-standard ones like "April 30, 10:00pm" or "April 30 @ 5pm"
 * 
 * @param {string} timestampStr - The input timestamp string to parse
 * @param {Object} options - Options for parsing
 * @param {boolean} options.includeTimezone - Whether to include timezone in the output (default: false)
 * @param {string} options.defaultYear - Default year to use if not specified (default: current year)
 * @param {string} options.defaultTime - Default time to use if not specified (default: "00:00:00")
 * @returns {string|null} - Postgres-compatible timestamp string or null if parsing failed
 */
function parseToPostgresTimestamp(dateStr, options = {}) {
  // Default options
  const defaults = {
    includeTimezone: false,
    defaultYear: new Date().getFullYear()
  };
  
  const opts = { ...defaults, ...options };
  
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }
  
  // Normalize input
  let input = dateStr.trim()
    .replace(/@/g, ' ')     // Replace @ with space
    .replace(/\s+/g, ' ')   // Normalize multiple spaces
    .replace(/,/g, ' ');    // Replace commas with spaces
  
  // Try standard format first
  let date = new Date(input);
  if (!isNaN(date.getTime())) {
    return formatDate(date, opts.includeTimezone);
  }
  
  // Try specific patterns
  
  // Pattern: Day of week + date in MM-DD-YYYY + time format
  // This handles: Sun 05-04-2025 6:00 PM, Sunday 05-04-2025 6:00pm, etc.
  const dowDateTimeRegex = /(?:(\w+)\s+)?(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*([ap]\.?m\.?)?/i;
  let match = input.match(dowDateTimeRegex);
  
  if (match) {
    // We don't need the day of week for date calculation, but we captured it anyway
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const year = parseInt(match[4], 10);
    const hours = parseInt(match[5], 10);
    const minutes = parseInt(match[6], 10);
    const seconds = match[7] ? parseInt(match[7], 10) : 0;
    const ampm = match[8] ? match[8].toLowerCase() : null;
    
    // Validate month and day
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return null;
    }
    
    // Adjust hours for AM/PM
    let adjustedHours = hours;
    if (ampm && ampm.startsWith('p') && hours < 12) {
      adjustedHours += 12;
    } else if (ampm && ampm.startsWith('a') && hours === 12) {
      adjustedHours = 0;
    }
    
    // Create date (month is 0-indexed in JavaScript Date)
    date = new Date(year, month - 1, day, adjustedHours, minutes, seconds);
    return formatDate(date, opts.includeTimezone);
  }
  
  // Pattern 1: "Month Day, HH:MM XM" format (April 10, 5:00 pm)
  const dateTimeRegex = /(\w+)\s+(\d{1,2})(?:,|\s)\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*([ap]\.?m\.?)?/i;
  match = input.match(dateTimeRegex);
  
  if (match) {
    const month = match[1];
    const day = parseInt(match[2], 10);
    const hours = parseInt(match[3], 10);
    const minutes = parseInt(match[4], 10);
    const seconds = match[5] ? parseInt(match[5], 10) : 0;
    const ampm = match[6] ? match[6].toLowerCase() : null;
    
    // Get month number
    const monthIndex = getMonthIndex(month);
    if (monthIndex === -1) return null;
    
    // Adjust hours for AM/PM
    let adjustedHours = hours;
    if (ampm && ampm.startsWith('p') && hours < 12) {
      adjustedHours += 12;
    } else if (ampm && ampm.startsWith('a') && hours === 12) {
      adjustedHours = 0;
    }
    
    // Create date
    date = new Date(opts.defaultYear, monthIndex, day, adjustedHours, minutes, seconds);
    return formatDate(date, opts.includeTimezone);
  }
  
  // Pattern 2: "Month Day NUM(am|pm)" format (April 30 5pm)
  const simpleTimeRegex = /(\w+)\s+(\d{1,2})(?:,|\s)?\s*(\d{1,2})\s*([ap]\.?m\.?)/i;
  match = input.match(simpleTimeRegex);
  
  if (match) {
    const month = match[1];
    const day = parseInt(match[2], 10);
    const hours = parseInt(match[3], 10);
    const ampm = match[4].toLowerCase();
    
    // Get month number
    const monthIndex = getMonthIndex(month);
    if (monthIndex === -1) return null;
    
    // Adjust hours for AM/PM
    let adjustedHours = hours;
    if (ampm.startsWith('p') && hours < 12) {
      adjustedHours += 12;
    } else if (ampm.startsWith('a') && hours === 12) {
      adjustedHours = 0;
    }
    
    // Create date
    date = new Date(opts.defaultYear, monthIndex, day, adjustedHours, 0, 0);
    return formatDate(date, opts.includeTimezone);
  }
  
  return null;
}

/**
 * Helper function to get month index from name
 */
function getMonthIndex(monthName) {
  const monthNames = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];
  
  const shortMonthNames = monthNames.map(m => m.substring(0, 3));
  const monthLower = monthName.toLowerCase();
  
  // First try exact match
  let monthIndex = monthNames.findIndex(m => m === monthLower);
  
  // Then try starts with
  if (monthIndex === -1) {
    monthIndex = monthNames.findIndex(m => 
      monthLower.startsWith(m) || m.startsWith(monthLower)
    );
  }
  
  // Then try short month names
  if (monthIndex === -1) {
    const shortIndex = shortMonthNames.findIndex(m => m === monthLower);
    if (shortIndex !== -1) {
      monthIndex = shortIndex;
    }
  }
  
  return monthIndex;
}

/**
 * Helper function to get day of week index from name (not used in date calculation but included for completeness)
 */
function getDayOfWeekIndex(dayName) {
  const dayNames = [
    "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"
  ];
  
  const shortDayNames = dayNames.map(d => d.substring(0, 3));
  const dayLower = dayName.toLowerCase();
  
  // First try exact match
  let dayIndex = dayNames.findIndex(d => d === dayLower);
  
  // Then try starts with
  if (dayIndex === -1) {
    dayIndex = dayNames.findIndex(d => 
      dayLower.startsWith(d) || d.startsWith(dayLower)
    );
  }
  
  // Then try short day names
  if (dayIndex === -1) {
    const shortIndex = shortDayNames.findIndex(d => d === dayLower);
    if (shortIndex !== -1) {
      dayIndex = shortIndex;
    }
  }
  
  return dayIndex;
}

/**
 * Helper function to format date as Postgres timestamp
 */
function formatDate(date, includeTimezone) {
  if (!date || isNaN(date.getTime())) {
    return '04-25-1977 4:20';
  }
  
  // Format for Postgres: YYYY-MM-DD HH:MM:SS
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  
  let result = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  
  // Add timezone if requested
  if (includeTimezone) {
    // Get timezone offset in hours and minutes
    const tzOffset = date.getTimezoneOffset();
    const tzHours = Math.abs(Math.floor(tzOffset / 60)).toString().padStart(2, '0');
    const tzMinutes = Math.abs(tzOffset % 60).toString().padStart(2, '0');
    const tzSign = tzOffset <= 0 ? '+' : '-';
    
    result += ` ${tzSign}${tzHours}:${tzMinutes}`;
  }
  
  return result;
}

// ---- SECTION: SMS display date formatting ----
// `formatDate()` above (and parseToPostgresTimestamp/parseItemModifierValues
// that call it) produce a timezone-naive "YYYY-MM-DD HH:MM:SS" string whose
// digits are already the correct Chicago wall-clock values -- same
// convention as the DB's ProductDate column. The SMS body used to do
// `new Date(eventDateTime).toLocaleString('en-US', {timeZone: 'America/
// Chicago'})`, which is wrong: constructing a Date from a space-separated,
// offset-less string gets it interpreted as UTC (a documented V8 quirk,
// same net effect as Lambda's own local tz being UTC), then toLocaleString
// converts that UTC instant *back* to Chicago time -- double-shifting a
// wall-clock value that was never UTC to begin with and needed no
// conversion at all. Fix: parse the digits directly and format them for
// display, with no Date object and no timezone conversion in the loop --
// none is wanted, since we're redisplaying the same wall-clock moment, not
// converting between zones. Only the SMS body was affected; PDF/DB/check-in
// never ran this code path.
const SMS_DATE_MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatChicagoWallClockForSms(wallClockStr) {
  if (!wallClockStr) return '';
  const match = wallClockStr.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!match) return '';
  const [, , monthNum, dayStr, hour24Str, minuteStr] = match;
  const monthName = SMS_DATE_MONTH_ABBR[parseInt(monthNum, 10) - 1];
  if (!monthName) return '';
  const hour24 = parseInt(hour24Str, 10);
  const day = parseInt(dayStr, 10);
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;
  const ampm = hour24 < 12 ? 'AM' : 'PM';
  return `${monthName} ${day}, ${hour12}:${minuteStr} ${ampm}`;
}
// ---- END SECTION: SMS display date formatting ----

async function isFromSquare(signature, body, sigKey, notURL) {
  return await WebhooksHelper.verifySignature({
      requestBody: body,
      signatureHeader: signature,
      signatureKey: sigKey,
      notificationUrl: notURL
    });
}

export const handler = async (event) => {
  // Log the incoming SQS event
  console.log('Received SQS event:', JSON.stringify(event));

  // Track processing results
  const results = {
    success: 0,
    failure: 0,
    errors: []
  };

  // Deliberate design choice (2026-10-21, after a real incident -- see
  // getSquareOrders' README): this handler always reports the whole
  // batch as successful, regardless of what happened to any individual
  // message, and never asks SQS to retry. Two reasons:
  //
  //   1. Square's own webhook retries are governed entirely by
  //      square-queue-forwarder, which already always returns 200 to
  //      Square -- nothing here is visible to Square at all, so there's
  //      no risk of Square re-sending a webhook because of anything this
  //      function does or doesn't do.
  //   2. SQS-level retries were tried (reporting real failures via
  //      ReportBatchItemFailures) and caused a real production outage: a
  //      message that deterministically fails the same way every time
  //      blocks every later message in its FIFO MessageGroupId, backing
  //      up every other order for that client until it exhausts its
  //      retries. Given how rare genuine transient failures are here
  //      versus how costly a wrong "needs retry" classification is, the
  //      simpler and safer choice is: log clearly (see the explicit
  //      paymentResponse.ok check in processWebhook, and the explicit
  //      return for orders with no ticketed items, both added the same
  //      night as this change) and always mark the message handled. A
  //      real failure needs a human looking at the logs, not an
  //      automatic retry that can take the whole client's queue down
  //      with it if the failure turns out to be permanent.
  //
  // Not using FunctionResponseTypes/ReportBatchItemFailures on the event
  // source mapping either -- this return value intentionally has nothing
  // for it to read.
  for (const record of event.Records) {
    try {
      console.log(`Processing SQS message: ${record.messageId}`);

      // Parse the SQS message body (which contains our original webhook data)
      const webhookMessage = JSON.parse(record.body);

      // Extract the original API Gateway event from the SQS message
      const apiGatewayEvent = {
        headers: webhookMessage.body.headers ?? webhookMessage.headers,
        body: webhookMessage.body.body ?? webhookMessage.body,
        // Restore other properties that might be needed
        pathParameters: webhookMessage.body.pathParameters ?? webhookMessage.pathParameters,
        queryStringParameters: webhookMessage.body.queryStringParameters ?? webhookMessage.queryStringParameters,
        requestContext: webhookMessage.body.requestContext ?? webhookMessage.requestContext
      };

      console.log('Reconstructed API Gateway event from SQS message:', JSON.stringify(apiGatewayEvent));

      // Process the webhook using your existing logic
      const webhookResult = await processWebhook(apiGatewayEvent);
      console.log('Webhook processing result:', JSON.stringify(webhookResult));

      results.success++;
    } catch (error) {
      console.error('Error processing SQS message:', error);
      results.failure++;
      results.errors.push(error.message);
      // Continue processing other messages in the batch -- not retried,
      // see the comment at the top of this handler.
    }
  }

  console.log(`Batch complete: ${results.success} succeeded, ${results.failure} failed`, JSON.stringify(results));

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: `Processed ${event.Records.length} webhook messages`,
      results: results
    })
  };
};

// Your existing webhook processing logic, now as a separate function
async function processWebhook(event) {
  console.log('event called, headers:', JSON.stringify(event.headers));

  if (event.headers && 'square-retry-number' in event.headers) {
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'This is a retry and we arent going to retry cause Squares webhook logic is crazy' })
    };
  }
  let squareSignature;
  
  let orderId = null;
  let clientId = null;
  let clientPool = null;

  console.log('Event:', JSON.stringify(event));

  // For webhooks coming from API Gateway, the body might be a string that needs parsing
  let webhookData;
  if (event.body) {
    try {
      // Parse body if it's a string (common with API Gateway)
      console.log('Setting Webhook data:', (typeof event.body));

      webhookData = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (e) {
      console.error('Error parsing webhook payload:', e);
      webhookData = event.body; // Use as-is if parsing fails
    }
  } else if (event.merchant_id) {
    // Direct invocation (not through API Gateway)
    webhookData = event;
  } else {
    console.error('Unexpected event structure:', event);
    return {
      statusCode: 400,
      body: JSON.stringify({ message: 'Invalid webhook payload structure' })
    };
  }

  console.log('Webhook data:', JSON.stringify(webhookData));

  
  try {
    if (webhookData.merchant_id) {
      // Fallback to alternative ID extraction
      clientId = webhookData.merchant_id;
    }

    // 2. Validate client credentials are provided
    if (!clientId) {
      console.error('Missing client credentials');
      return {
        statusCode: 401,
        body: JSON.stringify({ message: 'Unauthorized: Missing client credentials' })
      };
    }
    
    // 3. Get client-specific database pool using AWS Secrets Manager
    clientPool = await getClientPoolWithSecrets(clientId);
    if (!clientPool) {
      console.error(`Invalid client ID or database doesn't exist: ${clientId}`);
      return {
        statusCode: 401,
        body: JSON.stringify({ message: 'Unauthorized: Invalid client' })
      };
    }
    
    // 4. Verify client credentials and get client configuration
    let clientRecord = await verifyClientCredentials(clientPool, clientId);
    if (clientRecord.length === 0) {
      console.error(`Invalid client credentials for client: ${clientId}`);
      await clientPool.end(); // Close the pool for this invalid client
      return {
        statusCode: 401,
        body: JSON.stringify({ message: 'Unauthorized: Invalid credentials' })
      };
    }
    
    // 5. Get client configuration from the database
    clientConfig = await getClientConfiguration(clientPool, clientId);
    // Key names only: the values include the Square token, FTP and social
    // passwords, etc., and this ran on every order (found 2026-11-01).
    console.log(`Loaded client configuration for ${clientId} (${Object.keys(clientConfig || {}).length} keys: ${Object.keys(clientConfig || {}).sort().join(', ')})`);
    
    // Set up configuration values
    const BUCKET_NAME = clientConfig.S3_BUCKET_PREFIX+clientId.toLowerCase();
    const FOLDER_NAME_OUT = "tickets-out";
    const TEMPLATE_PDF_KEY = clientConfig.TICKET_FILENAME || "ticket_horizontal.pdf";
    // Texted tickets use their own template (defaults to vertical, which reads
    // better on a phone screen), independent of TICKET_FILENAME/TICKET_ORIENTATION
    // used for the emailed PDF. Provisioned into every client bucket at setup time.
    const TEMPLATE_PDF_SMS_KEY = clientConfig.TICKET_SMS_FILENAME || "ticket_vertical.pdf";

    
    // Get signature verification details from client config
    let sigKey = clientConfig.SQUARE_SIGNATURE_KEY;
    let notURL = clientConfig.SQUARE_WEBHOOK_URL;
    
    if (clientConfig.ENV_TYPE === 'prod') {
      //test network connectivity
      try {
        squareSignature =
          event.headers?.['x-square-hmacsha256-signature'] ||
          event.headers?.['X-Square-HMACSHA256-Signature'];
      } catch (error) {
        console.error('no square signature sent headers:', event.headers);
        console.error('no square signature sent data:', event.data);
        return {
          statusCode: 401,
          body: JSON.stringify({ message: 'Unauthorized' })
        };
      }
      
      // Early exit if signature header is missing
      if (!squareSignature) {
        console.log('Request rejected: Missing Square signature header');
        return {
          statusCode: 401,
          body: JSON.stringify({ message: 'Unauthorized' })
        };
      } else {
        // Get the raw request body for verification
        let requestBody = event.body;
        
        // Handle different body formats - this is critical
        if (typeof requestBody === 'object' && requestBody !== null) {
          // If it's already an object, stringify it
          requestBody = JSON.stringify(requestBody);
        } else if (typeof requestBody === 'string') {
          // If it's a string that looks like JSON, use it as is
          // No need to modify it
        }
        
        console.log('Request body for verification:', requestBody);
        
        if (await isFromSquare(squareSignature, requestBody, sigKey, notURL)) {
          // Signature is valid. Return 200 OK.
          console.info("Request body authorized: " + requestBody);
          
        } else {
          return {
            statusCode: 401,
            body: JSON.stringify({ message: 'Unauthorized square sigKey' })
          };
        }
      }
    }

    console.log(`Authenticated client: ${clientId}`);

    if (webhookData.data?.object?.payment?.status != "COMPLETED") {
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'we are only accepting payment stati that are completed' })
      };
    }

    // ---- Idempotency check (duplicate-webhook guard) ----------------------
    // Square sends multiple webhook events per completed order:
    //   payment.created / payment.updated / order.updated / order.fulfillment.*
    // Any of them can have payment.status = "COMPLETED", so the filter above
    // doesn't dedupe. If we've already created an Order row for this order_id,
    // skip everything -- return 200 fast so Square stops retrying, save all
    // the Square API calls, avoid the misleading "already an order" throw
    // downstream in saveQRCodeToDatabase.
    //
    // orderId is available in the webhook body itself (no API call required).
    const earlyOrderId = webhookData.data?.object?.payment?.order_id;
    if (earlyOrderId) {
      const existingOrderCheck = await clientPool.query(
        `SELECT "ID" FROM "Order" WHERE "OrderID" = $1`,
        [earlyOrderId]
      );
      if (existingOrderCheck.rows.length > 0) {
        console.log(`Order ${earlyOrderId} already processed (Order.ID=${existingOrderCheck.rows[0].ID}); duplicate webhook event, skipping.`);
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: 'Order already processed (idempotent no-op)',
            order_id: earlyOrderId,
            existing_order_id: existingOrderCheck.rows[0].ID
          })
        };
      }
      console.log(`Order ${earlyOrderId} not yet in DB; proceeding with full webhook processing.`);
    }
    // ---- end idempotency check --------------------------------------------

    let recipientEmail = clientConfig.OWNER_BCC_EMAIL || null; // Default recipient for a walk-up sale with no captured email; null skips the send below rather than guessing
    let customerFirstName = 'WALK-UP';
    let customerLastName = 'CASH-MASTER';
    let customerPhoneNumber = '7857491972';
    console.log('BigTimeQ2:', JSON.stringify(webhookData));

    const paymentId = webhookData.data.object.payment.id;
    const SQUARE_PAYMENT_API_URL = "https://connect.squareup.com/v2/payments/";
// Make a fresh API call to get complete payment data
const paymentResponse = await fetch(`${SQUARE_PAYMENT_API_URL}${paymentId}`, {
  method: "GET",
  headers: {
    "Authorization": `Bearer ${clientConfig.SQUARE_ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  }
});

const currentPaymentData = await paymentResponse.json();
console.log('Payment API response:', JSON.stringify(currentPaymentData, null, 2));

if (!paymentResponse.ok) {
  throw new Error(`Square Payments API returned ${paymentResponse.status} for payment ${paymentId}: ${JSON.stringify(currentPaymentData.errors || currentPaymentData)}`);
}

const customerId = currentPaymentData.payment.customer_id;
console.log('customerId:', customerId);

    if (customerId) {
      let customer = await getCustomer(customerId);
      console.log('Customer:', JSON.stringify(customer));
      recipientEmail = customer?.customer?.email_address || recipientEmail;
      customerFirstName = customer?.customer?.given_name || customerFirstName;
      customerLastName = customer?.customer?.family_name || customerLastName;
      customerPhoneNumber = customer?.customer?.phone_number || customerPhoneNumber;
    }
    else {
      recipientEmail = webhookData.data.object.payment.buyer_email_address || recipientEmail;
      customerFirstName = webhookData.data.object.payment.billing_address?.first_name || 
        webhookData.data.object.payment.shipping_address?.first_name || customerFirstName;
      customerLastName = webhookData.data.object.payment.billing_address?.last_name ||
        webhookData.data.object.payment.shipping_address?.last_name || customerLastName;
    }
   
    // Try to extract order ID based on the structure 
    if (webhookData.data?.object?.payment?.order_id) {
      orderId = webhookData.data.object.payment.order_id;
    }

    // Validate order ID
    if (!orderId) {
      console.error("Could not find order ID. Full event:", JSON.stringify(event, null, 2));
      throw new Error("Invalid event structure: Cannot extract order ID");
    }

    console.log("Extracted Order ID:", orderId);

    // Add a check to ensure orderId exists
    if (!orderId) {
      console.error("Could not extract order ID", body);
      throw new Error("Invalid body structure: Cannot extract order ID");
    }
    const response = await fetch(`${SQUARE_API_URL}${orderId}`, {
      method: "GET",
      headers: {
          "Authorization": `Bearer ${clientConfig.SQUARE_ACCESS_TOKEN}`,
          "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch order: ${response.status} ${await response.text()}`);
    }

    const orderDetailsT = await response.json();
         console.log("Order Details:", JSON.stringify(orderDetailsT, null, 2));
         const orderDetails = JSON.stringify(orderDetailsT, null, 2);
        
         // Log the received order for debugging
         console.log("Received Order:", orderDetails);
     
         //START ORDER DETAILS
         const order = orderDetailsT.order;
    
    // Collect all catalog object IDs from line items
    const catalogObjectIds = [];
    if (order.line_items && order.line_items.length > 0) {
      order.line_items.forEach(lineItem => {
        if (lineItem.catalog_object_id) {
          catalogObjectIds.push(lineItem.catalog_object_id);
        }
      });
    }
    
    // Fetch catalog items in batch
    const catalogItems = await fetchCatalogItems(catalogObjectIds);

    let qrCodeItems = getCatalogItemsDetailsForQR(orderDetailsT, catalogItems);
    let finalItemArray = [];
    console.log("WTF", JSON.stringify(qrCodeItems));
    qrCodeItems.forEach(item => {
      // Process each item based on quantity
      const quantity = parseInt(item.quantity, 10);
      for (let i = 0; i < quantity; i++) {
        let itemModValues = [];
        if (item.modifiers && item.modifiers.length > 0) {
          item.modifiers.forEach(modifier => {
            itemModValues.push(modifier.name);
          });
        }
        let itemModifiersString = itemModValues.join(', ');
        finalItemArray.push({
          orderId: orderId,
          itemId: item.catalog_object_id,
          itemName: item.name,
          variationName: item.variation_name,
          itemPrice: item.total_money ? (item.total_money.amount / 100) / parseInt(item.quantity, 10) : item.base_price_money.amount / 100,
          itemType: item.reportingCategories, // This will be replaced by EventType custom attribute
          itemLocation: item.location_id,
          itemModifierValues: itemModifiersString,
          itemDetails: JSON.stringify(item),
          // Add the distributorInfo if it exists
          distributorInfo: item.distributorInfo,
          // Add the eventTypeInfo if it exists
          eventTypeInfo: item.eventTypeInfo,
          // Generate a unique QR code data string
          qrCodeData: `${item.name}_${item.variation_name}_${orderId}_${item.uid}_${i}_${Date.now()}`
        });
        console.log("finalItemArray:", JSON.stringify(finalItemArray));
      }
    });    
 
    // ---- ONE PER EMAIL ITEMS ----
    // Items named in ONE_PER_EMAIL_ITEMS (comma-separated Square item names,
    // capitals ignored; e.g. a $0 free sample ticket) are limited to one
    // ticket per buyer email address, ever: at most one per order, and none
    // if this email already has a ticket for that item. Unset = no limit,
    // so venues that don't use it see no change.
    const onePerEmailItems = String(clientConfig.ONE_PER_EMAIL_ITEMS || '')
      .split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
    if (onePerEmailItems.length > 0) {
      const keptLimited = new Set();
      const allowed = [];
      for (const lineItem of finalItemArray) {
        const nameKey = String(lineItem.itemName || '').trim().toLowerCase();
        if (!onePerEmailItems.includes(nameKey)) {
          allowed.push(lineItem);
          continue;
        }
        if (keptLimited.has(nameKey)) {
          console.log(`ONE_PER_EMAIL_ITEMS: dropping extra "${lineItem.itemName}" in order ${orderId} (one per order)`);
          continue;
        }
        if (recipientEmail) {
          const already = await clientPool.query(
            `SELECT 1 FROM "QRCodeProduct" WHERE LOWER(TRIM("ProductName")) = $1 AND LOWER(TRIM("EmailAddress")) = LOWER(TRIM($2)) LIMIT 1`,
            [nameKey, recipientEmail]
          );
          if (already.rows.length > 0) {
            console.log(`ONE_PER_EMAIL_ITEMS: ${recipientEmail} already has a "${lineItem.itemName}" ticket; skipping it in order ${orderId}`);
            continue;
          }
        }
        keptLimited.add(nameKey);
        allowed.push(lineItem);
      }
      finalItemArray = allowed;
    }
    // ---- END ONE PER EMAIL ITEMS ----

    // Enhance order details with catalog information
    if (finalItemArray.length > 0) {
      
      // ---- SMS opt-in: per-order setup ----------------------------------
      // Generate a single OptInToken for this whole order. Same token covers
      // every ticket in the purchase, so the customer's one opt-in click
      // signs them up for all of it. Token gets stored on the Order row by
      // saveQRCodeToDatabase below and surfaces in the email opt-in CTA.
      const optInToken = generateOptInToken();

      // Normalize once; reuse for consent lookup and downstream SMS send.
      const normalizedCustomerPhone = normalizeToE164(customerPhoneNumber);

      // Upsert Customer row. Returns existing ID if we've seen this phone
      // (or email, as fallback) before; new ID if not. Can be null if
      // neither phone nor email is usable (rare -- only walk-up cash sales
      // with no buyer info, which use the WALK-UP/CASH-MASTER defaults).
      // Named dbCustomerId to disambiguate from the Square customerId above.
      const dbCustomerId = await upsertCustomer(
        clientPool,
        recipientEmail,
        customerPhoneNumber,
        customerFirstName,
        customerLastName
      );
      console.log(`Customer resolved: ID=${dbCustomerId}, phone=${normalizedCustomerPhone}, email=${recipientEmail}`);

      // Check active SMS consent. Drives both auto-send (yes -> text now)
      // and email CTA visibility (no -> show "text me my ticket" link).
      const hasActiveConsent = await hasActiveConsentForPhone(clientPool, normalizedCustomerPhone);
      console.log(`SMS active consent for ${normalizedCustomerPhone}: ${hasActiveConsent}`);

      // Master SMS kill switch (per-client config). When false, no SMS goes
      // out and no opt-in CTA appears in the email -- new clients without
      // an approved 10DLC campaign should have this set to "false".
      const smsEnabled = clientConfig.SEND_SMS === true || clientConfig.SEND_SMS === 'true';
      console.log(`SMS enabled for client ${clientId}: ${smsEnabled}`);
      // ---- end SMS opt-in setup -----------------------------------------
   
      // Process each line item to create tickets
      const ticketResults = [];
      const emailAttachments = []; // Array to hold all attachments
      const venueNameForEmail = clientConfig.WEB_HEADER_COMPANY || 'the venue';
      let emailSubject = `Your ${venueNameForEmail} Tickets`;
      let emailBody = 'Thank you for your purchase! Please find your tickets attached.\n\n';
      let count = 0;
      
      // Updated ticket processing loop with configurable SMS functionality
      for (const lineItem of finalItemArray) {
        console.log(`Processing lineItem: ${JSON.stringify(lineItem)}`);
        const itemName = lineItem.itemName || "Unknown Item";
        const itemId = lineItem.itemId || "Unknown ItemId";
        const sku = lineItem.qrCodeData;
        
        emailBody += `Event: ${itemName}\n`;
        
        let currentVariation = lineItem.variationName;
        try {
          // Fetch Distributor string value if we have the info
          let distributorValue = "Unknown";
          if (lineItem.distributorInfo) {
            distributorValue = await fetchSelectionValue(
              lineItem.distributorInfo.definitionId,
              lineItem.distributorInfo.selectionId
            );
            console.log(`Got distributor value: ${distributorValue} for item: ${itemName}`);
          }
          
          // Fetch EventType string value if we have the info
          let eventTypeValue = "Unknown";
          if (lineItem.eventTypeInfo) {
            eventTypeValue = await fetchSelectionValue(
              lineItem.eventTypeInfo.definitionId,
              lineItem.eventTypeInfo.selectionId
            );
            console.log(`Got event type value: ${eventTypeValue} for item: ${itemName}`);
          }
          
          // NEW: Parse itemModifierValues to extract datetime and venue
          const modifierParsed = parseItemModifierValues(lineItem.itemModifierValues);
          const eventDateTime = modifierParsed.datetime;
          const eventVenue = modifierParsed.eventVenue;
          
          console.log(`Parsed modifier values for ${itemName}: DateTime: ${eventDateTime}, Venue: ${eventVenue}`);
          
          const orderInfo = {
            name: itemName,
            variation: currentVariation, 
            itemModifierValues: lineItem.itemModifierValues
          };
          
          let createJunctionAndOrder = !count;
          let expirationWindow = 90;
          // Save QR code to database
          try {
            await saveQRCodeToDatabase(clientPool, sku, {
              client_id: clientId,
              order_id: orderId,
              item_name: itemName,
              item_variation: currentVariation,
              orderDetails: orderDetailsT, 
              itemDetails: lineItem.itemDetails,
              itemId: lineItem.itemId,
              itemPrice: lineItem.itemPrice,
              itemType: eventTypeValue,
              itemLocation: lineItem.itemLocation,
              itemDate: eventDateTime,
              itemModifierValues: lineItem.itemModifierValues,
              distributor: distributorValue,
              eventVenue: eventVenue,
              seatCode: lineItem.variationName,
              emailAddress: recipientEmail,
              'customerFirstName': customerFirstName,
              'customerLastName': customerLastName,
              'customerPhoneNumber': customerPhoneNumber, 
              'status': 'valid',
              // SMS opt-in: token stored on Order, dbCustomerId on both Order and QRCodeProduct.
              // Only the FIRST ticket in the order (createJunctionAndOrder=true) writes the
              // Order row and consumes the OptInToken; subsequent tickets just get CustomerID.
              optInToken: optInToken,
              customerId: dbCustomerId
            }, 
            createJunctionAndOrder,
            expirationWindow);
            console.log(`QR code saved to database: ${sku}`);
          } catch (error) {
            console.error("Failed to save QR code to database:", error);
            return {
              statusCode: 200,
              body: JSON.stringify({ error: `Failed to process order: ${orderId}` }),
            };
          }
          
          // Generate QR Code as a Buffer
          const qrCodeBuffer = await generateQRCode(sku);

          // Retrieve the PDF template from S3
          const templatePdfBuffer = await fetchPdfFromS3(s3Client, BUCKET_NAME, TEMPLATE_PDF_KEY);

          // Overlay QR Code on the PDF
          const ticketOrientation = clientConfig.TICKET_ORIENTATION || "horizontal";
          const modifiedPdfBuffer = await renderTicketPdf(templatePdfBuffer, qrCodeBuffer, orderInfo, ticketOrientation);

          // Save the new PDF to S3
          const outputPdfKey = FOLDER_NAME_OUT + "/" +`QR-Ticket-${sku}.pdf`;
          await savePdfToS3(s3Client, BUCKET_NAME, outputPdfKey, modifiedPdfBuffer);

          // ---- SMS-specific vertical PDF (rendered unconditionally) ----
          // Rendered for every ticket, same as the horizontal PDF above,
          // regardless of whether this customer has SMS consent yet. This
          // way the file is already sitting in S3 by the time a customer
          // opts in later via the web form (QRScanner's opt-in endpoint
          // just presigns this key -- it doesn't render PDFs itself).
          const smsOrientation = clientConfig.TICKET_SMS_ORIENTATION || "vertical";
          const smsTemplatePdfBuffer = await fetchPdfFromS3(s3Client, BUCKET_NAME, TEMPLATE_PDF_SMS_KEY);
          const smsPdfBuffer = await renderTicketPdf(smsTemplatePdfBuffer, qrCodeBuffer, orderInfo, smsOrientation);
          const smsPdfKey = FOLDER_NAME_OUT + "/" + `QR-Ticket-${sku}-sms.pdf`;
          await savePdfToS3(s3Client, BUCKET_NAME, smsPdfKey, smsPdfBuffer);
          // ---- end SMS-specific vertical PDF ----------------------------

          // ---- SMS auto-send for returning opted-in customers ----------
          // Only fires when ALL of these are true:
          //   (a) SEND_SMS = "true" in client config (master kill switch)
          //   (b) Customer has an active SmsConsent row for this phone
          //   (c) Phone normalized successfully to E.164
          //
          // Customers WITHOUT active consent see the opt-in CTA in the
          // email instead. They click through, consent on the web form,
          // and the opt-in endpoint sends them their ticket SMS at that
          // point -- not here.
          //
          // The consent check inside sendSms() is belt-and-suspenders;
          // hasActiveConsent above is the structural gate.
          let ticketDownloadUrl = null;
          let smsSentForThisTicket = false;

          if (smsEnabled && hasActiveConsent && normalizedCustomerPhone) {
            try {
              ticketDownloadUrl = await generatePresignedUrl(BUCKET_NAME, smsPdfKey);

              // Format a Chicago-local short date for the SMS body. eventDateTime
              // is already wall-clock Chicago time by convention (see
              // formatChicagoWallClockForSms's comment) -- no timezone
              // conversion needed or wanted here, just a readable restatement
              // of the same moment, e.g. "May 28, 7:30 PM".
              const eventDateStr = formatChicagoWallClockForSms(eventDateTime);
              
              const venueName = clientConfig.WEB_HEADER_COMPANY || 'the venue';
              const content = `Your ticket for ${itemName}${eventDateStr ? ' on ' + eventDateStr : ''} at ${venueName}: ${ticketDownloadUrl}`;
              const messageBody = buildMessageBody(clientConfig.SMS_SENDER_BRAND, content);
              
              const smsResult = await sendSms({
                toPhone: normalizedCustomerPhone,
                body: messageBody,
                clientConfig,
                pool: clientPool
              });
              
              if (smsResult.sent) {
                console.log(`SMS sent for ticket ${itemName}: ${smsResult.messageId}`);
                smsSentForThisTicket = true;
              } else {
                console.log(`SMS not sent for ticket ${itemName}: ${smsResult.reason}`);
              }
            } catch (smsError) {
              console.error(`Error sending SMS for ticket ${itemName}:`, smsError);
              // Continue processing -- SMS failure shouldn't break the email path
            }
          } else {
            if (!smsEnabled) {
              console.log(`SMS disabled for client ${clientId} -- skipping auto-send for ${itemName}`);
            } else if (!hasActiveConsent) {
              console.log(`No active SMS consent for ${normalizedCustomerPhone || customerPhoneNumber} -- email CTA will offer opt-in instead`);
            } else {
              console.log(`Phone could not be normalized to E.164: "${customerPhoneNumber}" -- skipping SMS`);
            }
          }
          // ---- end SMS auto-send --------------------------------------
          
          // Add this PDF as an attachment for the email
          const filename = `${sku.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`;
          emailAttachments.push({
            filename: filename,
            content: modifiedPdfBuffer,
            contentType: 'application/pdf'
          });
          
          emailBody += `- Ticket ${itemName}: ${currentVariation}\n`;
          
          ticketResults.push({
            sku: sku,
            item_id: itemId,
            item: `${itemName} ${currentVariation}`,
            sms_enabled: smsEnabled,
            sms_sent: smsSentForThisTicket
          });
          count += 1;
        } catch (error) {
          console.error(`Error processing ticket for ${itemName} ${currentVariation}:`, error);
        }
      }

      emailBody += '\n';

      // ---- Email opt-in CTA -----------------------------------------
      // Only show the "text me" link if SMS is enabled for this client AND
      // the customer doesn't already have active consent. Returning opted-in
      // customers got their ticket SMS automatically and don't need a CTA.
      // Brand-new and previously-revoked customers get the CTA -- the opt-in
      // page handles the resubscribe banner for the latter group.
      if (smsEnabled && !hasActiveConsent && clientConfig.STATIC_WEBSITE_URL) {
        // client={clientId} is required by the public opt-in Express endpoints.
        // Multi-tenant public routes can't determine which DB to open from
        // the token alone (tokens are per-client-DB, not globally unique),
        // so the URL carries the client explicitly. Same pattern as
        // reset-password.html?token=X&client=Y.
        // Query-string form (works without CloudFront path rewrite).
        // opt-in.js accepts either this or /opt-in/{token}?client=X; we use
        // this until a CloudFront Function rewrite is set up.
        const optInUrl = `${clientConfig.STATIC_WEBSITE_URL}/opt-in.html?token=${optInToken}&client=${clientId}`;
        emailBody += `\nPrefer text? Get your ticket(s) on your phone instead:\n${optInUrl}\n\n`;
      }
      // ---- end email opt-in CTA -------------------------------------

      // ---- MARKETING ENGINE: post-purchase share nudge ---------------
      // Off by default (SHARE_NUDGE_ENABLED, per-client config -- string,
      // not boolean, same convention as SEND_SMS). A single line riding
      // the existing confirmation send -- no new email, no new schedule
      // entry, no dependency on the marketingEngine Lambda.
      if (clientConfig.SHARE_NUDGE_ENABLED === true || clientConfig.SHARE_NUDGE_ENABLED === 'true') {
        const venueName = clientConfig.WEB_HEADER_COMPANY || 'us';
        emailBody += `\nEnjoyed your visit? Tag ${venueName} and share the show with a friend!\n`;
      }
      // ---- end MARKETING ENGINE: post-purchase share nudge ------------

      // Now send a single email with all attachments if there are any
      if (emailAttachments.length > 0 && !recipientEmail) {
        console.log(`No recipient email available for this order (no buyer email captured, and this client has no OWNER_BCC_EMAIL configured) -- skipping ticket email send.`);
      } else if (emailAttachments.length > 0) {
        try {
          if (emailAttachments.length > 1) {
            emailSubject = `Your ${emailAttachments.length} ${venueNameForEmail} Tickets`;
          } else {
            emailSubject = `Your ${venueNameForEmail} Ticket`;
          }

          emailBody += `\nIf you have any questions about your tickets, please contact us.\n\nThank you for supporting ${venueNameForEmail}!`;

          console.log(`Sending email with ${emailAttachments.length} attachments to ${recipientEmail}`);

          await sendEmailWithMultipleAttachments(
            clientConfig.SENDER_EMAIL,
            recipientEmail,
            emailSubject,
            emailBody,
            emailAttachments,
            clientConfig.OWNER_BCC_EMAIL || null
          );

          console.log(`Email with ${emailAttachments.length} attachments sent successfully`);
        } catch (emailError) {
          console.error(`Error sending email with attachments:`, emailError);
        }
      }

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "PDF tickets with order details sent successfully",
          tickets: ticketResults,
          recipient: recipientEmail,
          ticketCount: emailAttachments.length,
          sms_enabled: smsEnabled,
          sms_active_consent: hasActiveConsent,
          opt_in_token_generated: !!optInToken
        }),
      };
      } else {
        // No line item in this order had the ticketed-item (UseQRCode)
        // custom attribute -- e.g. a bar/concession-only sale processed
        // through the same Square webhook. Nothing to ticket, but this is
        // a normal, expected outcome, not a failure -- must return an
        // explicit, well-formed result so the caller's success/failure
        // classification doesn't fall through to an implicit `undefined`
        // (that gap crashed the SQS handler and backed up the whole FIFO
        // queue on 2026-10-21; see getSquareOrders' README).
        console.log(`Order ${orderId} has no ticketed items -- nothing to process.`);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: 'No ticketed items in this order; nothing to process.' }),
        };
      }
    }catch (error) {
        console.error("Error processing order:", error);
        return {
          statusCode: 500,
          body: JSON.stringify({ error: `Failed to process order: ${error.message}` }),
        };
      } finally {
        // Keep the pool open for future invocations
        // If you want to close it, uncomment: await clientPool.end();
    }
}

/**
 * Sends an email with multiple PDF attachments
 * @param {string} sender - Email sender address
 * @param {string} recipient - Email recipient address
 * @param {string} subject - Email subject line
 * @param {string} body - Email body text
 * @param {Array} attachments - Array of attachment objects with filename, content, and contentType
 * @param {string|null} [ownerBccEmail] - this client's Client.configuration.OWNER_BCC_EMAIL,
 *   if they have one set. Per-client opt-in, not a shared/global address --
 *   used to be hardcoded to Liberty Hall's own personal email, which BCC'd
 *   (and SES-Destination'd) every OTHER client's ticket emails to it too.
 * @returns {Promise} - AWS SES send result
 */
async function sendEmailWithMultipleAttachments(sender, recipient, subject, body, attachments, ownerBccEmail = null) {
  // Create a mail object
  const mail = mailcomposer({
    from: sender,
    to: recipient,
    ...(ownerBccEmail ? { bcc: ownerBccEmail } : {}),
    subject: subject,
    text: body,
    attachments: attachments
  });

  // Build the MIME message
  const mimeMessage = await new Promise((resolve, reject) => {
    mail.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });

  const result = await sesClient.send(new SendRawEmailCommand({
    RawMessage: { Data: mimeMessage },
    Destinations: ownerBccEmail ? [recipient, ownerBccEmail] : [recipient]
  }));

  return result;
}
// generateQRCode, getPdfFromS3/streamToBuffer, overlayQRCodeOnPdf, and
// savePdfToS3 used to live here. Removed in favor of the shared
// ticket-pdf-lib package (generateQRCode, fetchPdfFromS3, renderTicketPdf,
// savePdfToS3) -- confirmed line-for-line equivalent before the switch.


async function sendEmailWithAttachment(sender, recipient, subject, body, attachmentBuffer, attachmentName) {
// Create a mail object
const mail = mailcomposer({
  from: sender,
  to: recipient,
  subject: subject,
  text: body,
  attachments: [
    {
      filename: attachmentName,
      content: attachmentBuffer,
      contentType: 'application/pdf'
    }
  ]
});

// Build the MIME message
const mimeMessage = await new Promise((resolve, reject) => {
  mail.build((err, message) => {
    if (err) reject(err);
    else resolve(message);
  });
});

// Send the raw email
const result = await sesClient.send(new SendRawEmailCommand({
  RawMessage: { Data: mimeMessage }
}));

return result;
}

