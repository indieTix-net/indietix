import {
  S3,
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsCommand,
  CopyObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import QRCode from "qrcode";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import nodemailer from 'nodemailer';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import mailcomposer from 'mailcomposer';
import pg from 'pg';
import crypto from 'crypto';
import { WebhooksHelper } from "square";

const { Pool } = pg;

// Initialize AWS clients
const secretsClient = new SecretsManagerClient({ region: "us-east-2" });
const s3 = new S3();
const s3Client = new S3Client({ region: "us-east-2" });
const sesClient = new SESClient({ region: "us-east-2" });
const snsClient = new SNSClient({ region: "us-east-2" });

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

// Email details - will be overridden by client config
const RECIPIENT_EMAIL = "lawrence.liberty.hall@gmail.com";

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
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    
    const signedUrl = await getSignedUrl(s3Client, command, { expiresIn });
    console.log(`Generated presigned URL for ${bucket}/${key}`);
    return signedUrl;
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    throw error;
  }
}

/**
 * Sends SMS with ticket information and download link
 * @param {string} phoneNumber - Recipient phone number (E.164 format)
 * @param {string} ticketDownloadUrl - URL to download the PDF ticket
 * @param {string} qrCodeData - QR code data as backup
 * @param {string} eventName - Name of the event
 * @param {string} variation - Ticket variation details
 * @returns {Promise} - SNS publish result
 */
async function sendTicketSMS(phoneNumber, ticketDownloadUrl, qrCodeData, eventName, variation) {
  try {
    // Validate and format phone number
    let formattedPhone = phoneNumber;
    
    // Remove any non-numeric characters except +
    formattedPhone = formattedPhone.replace(/[^\d+]/g, '');
    
    // Add +1 if it's a 10-digit US number
    if (formattedPhone.length === 10) {
      formattedPhone = '+1' + formattedPhone;
    } else if (formattedPhone.length === 11 && formattedPhone.startsWith('1')) {
      formattedPhone = '+' + formattedPhone;
    } else if (!formattedPhone.startsWith('+')) {
      formattedPhone = '+1' + formattedPhone;
    }
    
    console.log(`Attempting to send SMS to: ${formattedPhone}`);
    
    // US-optimized message with clear branding at the start
    const message = `LIBERTY HALL TICKET\n\n` +
                   `Event: ${eventName}\n` +
                   `Details: ${variation}\n\n` +
                   `Get your ticket: ${ticketDownloadUrl}\n\n` +
                   `QR Code: ${qrCodeData}\n\n` +
                   `Present this message or PDF at venue. Link expires in 7 days.\n\n` +
                   `Reply STOP to opt out.`;
    
    const params = {
      Message: message,
      PhoneNumber: formattedPhone,
      MessageAttributes: {
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional'
        }
      }
    };
    
    const result = await snsClient.send(new PublishCommand(params));
    console.log(`SMS sent successfully to ${formattedPhone}. Message ID: ${result.MessageId}`);
    return result;
  } catch (error) {
    console.error('SMS Error Details:', error);
    
    // Check if it's a sandbox mode error
    if (error.message.includes('not verified') || error.message.includes('sandbox')) {
      console.log(`SMS failed due to sandbox mode - phone ${phoneNumber} not verified`);
      console.log('To test SMS: Add this phone number to SNS verified numbers in AWS console');
      // Don't throw error - just log and continue
      return { sandboxMode: true, phoneNumber: formattedPhone };
    }
    
    throw error;
  }
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
  
  // Parse the datetime portion using the existing logic
  const datetime = parseToPostgresTimestamp(dateTimeStr, opts);
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
    
    // First insert - QR code product with added Distributor, ProductVenue, and ProductSeatCode columns
    const productQuery = `
      INSERT INTO "QRCodeProduct" ("QRCode", "CheckedIn", "CreatedDate", "ExpirationDate", "LastEditedDate",
      "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductPrice",
       "ProductID", "ProductMetadata", "EmailAddress", "FirstName", "LastName", "PhoneNumber", "Distributor", "ProductVenue", "ProductSeatCode", "Status")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
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
      productDetails.status || 'Unknown' // Status value
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
      // Second insert - Order record
      orderQuery = `
        INSERT INTO "Order" ("OrderID", "CreatedDate", "LastEditedDate", "OrderMetaData", "EmailAddress", "FirstName", "LastName", "PhoneNumber")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
        productDetails.customerPhoneNumber // phoneNumber
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

  // Process each message from SQS (batch processing)
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
      // Continue processing other messages in the batch
    }
  }
  
  // Return processing results
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
    console.log(`Loaded client configuration for ${clientId}:`, JSON.stringify(clientConfig));
    
    // Set up configuration values
    const BUCKET_NAME = clientConfig.S3_BUCKET_PREFIX+clientId.toLowerCase();
    const FOLDER_NAME_OUT = "tickets-out";
    const TEMPLATE_PDF_KEY = clientConfig.TICKET_FILENAME || "ticket_horizontal.pdf";

    
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
   
    let recipientEmail = RECIPIENT_EMAIL; // Default recipient
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
          itemPrice: item.base_price_money.amount / 100,
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
 
    // Enhance order details with catalog information
    if (finalItemArray.length > 0) {
      
   
      // Process each line item to create tickets
      const ticketResults = [];
      const emailAttachments = []; // Array to hold all attachments
      let emailSubject = 'Your Liberty Hall Tickets';
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
              'status': 'valid'
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
          const templatePdfBuffer = await getPdfFromS3(BUCKET_NAME, TEMPLATE_PDF_KEY);
          
          // Overlay QR Code on the PDF
          const modifiedPdfBuffer = await overlayQRCodeOnPdf(templatePdfBuffer, qrCodeBuffer, orderInfo);
          
          // Save the new PDF to S3
          const outputPdfKey = FOLDER_NAME_OUT + "/" +`QR-Ticket-${sku}.pdf`;
          await savePdfToS3(BUCKET_NAME, outputPdfKey, modifiedPdfBuffer);
          
          // Check if SMS is enabled in client configuration before attempting SMS
          const smsEnabled = clientConfig.SEND_SMS === true || clientConfig.SEND_SMS === 'true';
          console.log(`SMS enabled for client ${clientId}: ${smsEnabled}`);
          
          let ticketDownloadUrl = null;
          
          // Send SMS if enabled, phone number is available and valid
          if (smsEnabled && customerPhoneNumber && customerPhoneNumber.trim() && customerPhoneNumber !== '7857491972') { // Exclude default phone
            try {
              // Generate presigned URL for the PDF (only if SMS is enabled)
              ticketDownloadUrl = await generatePresignedUrl(BUCKET_NAME, outputPdfKey);
              
              console.log(`Sending SMS to ${customerPhoneNumber} for ticket ${itemName}`);
              await sendTicketSMS(
                customerPhoneNumber,
                ticketDownloadUrl,
                sku,
                itemName,
                `${currentVariation}: ${lineItem.itemModifierValues}`
              );
              console.log(`SMS sent successfully for ticket ${itemName}`);
            } catch (smsError) {
              console.error(`Error sending SMS for ticket ${itemName}:`, smsError);
              // Continue processing even if SMS fails - don't break the whole process
            }
          } else {
            if (!smsEnabled) {
              console.log(`SMS disabled for client ${clientId} - skipping SMS for ${itemName}`);
            } else {
              console.log(`No valid phone number for SMS: ${customerPhoneNumber}`);
            }
          }
          
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
            sms_sent: smsEnabled && customerPhoneNumber && customerPhoneNumber.trim() && customerPhoneNumber !== '7857491972'
          });
          count += 1;
        } catch (error) {
          console.error(`Error processing ticket for ${itemName} ${currentVariation}:`, error);
        }
      }

      emailBody += '\n';

      // Now send a single email with all attachments if there are any
      if (emailAttachments.length > 0) {
        try {
          if (emailAttachments.length > 1) {
            emailSubject = `Your ${emailAttachments.length} Liberty Hall Tickets`;
          } else {
            emailSubject = 'Your Liberty Hall Ticket';
          }
          
          emailBody += `\nIf you have any questions about your tickets, please contact us.\n\nThank you for supporting Liberty Hall!`;
          
          console.log(`Sending email with ${emailAttachments.length} attachments to ${recipientEmail}`);
          
          await sendEmailWithMultipleAttachments(
            clientConfig.SENDER_EMAIL,
            recipientEmail,
            emailSubject,
            emailBody,
            emailAttachments
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
          sms_enabled: clientConfig.SEND_SMS === true || clientConfig.SEND_SMS === 'true'
        }),
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
 * @returns {Promise} - AWS SES send result
 */
async function sendEmailWithMultipleAttachments(sender, recipient, subject, body, attachments) {
  // Create a mail object
  const mail = mailcomposer({
    from: sender,
    to: recipient,
    bcc: 'lawrence.liberty.hall@gmail.com',
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
    Destinations: [recipient, 'lawrence.liberty.hall@gmail.com']  
  }));

  return result;
}
/**
* Generates a QR Code buffer
*/
async function generateQRCode(sku) {
  return new Promise((resolve, reject) => {
      QRCode.toBuffer(sku, { type: "png", width: 150 }, (err, buffer) => {
          if (err) reject(err);
          else resolve(buffer);
      });
  });
}

/**
* Retrieves a PDF from S3
*/
async function getPdfFromS3(bucket, key) {
  
  console.log(`Retrieving PDF from ${bucket}/${key}`);
  const getObjectResponse = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key
  }));

  // Convert the response stream to a Buffer
  const pdfBytes = await streamToBuffer(getObjectResponse.Body);
  return pdfBytes;
}

// Helper function to convert a stream to a buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function overlayQRCodeOnPdf(pdfBuffer, qrCodeBuffer, orderInfo) {
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const firstPage = pdfDoc.getPages()[0];
  
  // Embed QR code image
  const qrImage = await pdfDoc.embedPng(qrCodeBuffer);
  const { width, height } = firstPage.getSize();
  
  // Get orientation from client config (default to horizontal)
  const orientation = clientConfig.TICKET_ORIENTATION || "horizontal";
  
  // QR code dimensions
  const qrSize = 120;
  
  let qrCodeX, qrCodeY, textX, textY, maxTextWidth, maxTextHeight;
  
  if (orientation === "vertical") {
    // Vertical layout (600w x 1800h)
    // QR code at top center, 50px from top
    qrCodeX = (width - qrSize) / 2;
    qrCodeY = height - 75 - (.5)*qrSize;
    
    // Text area below QR code, centered
    textX = 25; // 50px margin from left
    maxTextWidth = width - 50; // 50px margins on both sides
    
    // Text starts below QR code with some padding
    textY = qrCodeY - 30;
    
    // Text should not go further than 70% down the ticket height
    const maxTextBottom = height * 0.3; // 30% from bottom = 70% from top
    maxTextHeight = textY - maxTextBottom;
    
  } else {
    // Horizontal layout (1800w x 600h) - existing logic
    qrCodeX = width - 130;
    qrCodeY = (height / 2) - 60;
    
    textX = width - 275;
    maxTextWidth = qrCodeX - textX - 10; // 10px padding
    maxTextHeight = height; // No height restriction for horizontal
    textY = null; // Will be calculated based on content for centering
  }
  
  // Draw QR code
  firstPage.drawImage(qrImage, {
    x: qrCodeX,
    y: qrCodeY,
    width: qrSize,
    height: qrSize,
  });
  
  // Text parameters
  const lineHeight = 10;
  const fontSize = 8;
  
  // Function to calculate text height based on content and width constraints
  function calculateTextHeight(text, maxWidth, font, fontSize) {
    if (!text) return 0;
    
    const words = text.split(' ');
    let line = '';
    let lineCount = 1;
    
    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const textWidth = font.widthOfTextAtSize(testLine, fontSize);
      
      if (textWidth > maxWidth && line) {
        line = word;
        lineCount++;
      } else {
        line = testLine;
      }
    }
    
    return lineCount * lineHeight;
  }
  
  // Function to handle text wrapping with height constraints
  function drawWrappedText(text, x, y, maxWidth, maxHeight, lineHeight, font, fontSize) {
    if (!text) return y;
    
    const words = text.split(' ');
    let line = '';
    let currentY = y;
    let linesDrawn = 0;
    const maxLines = maxHeight ? Math.floor(maxHeight / lineHeight) : Infinity;
    
    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const textWidth = font.widthOfTextAtSize(testLine, fontSize);
      
      if (textWidth > maxWidth && line) {
        // Check if we have room for another line
        if (linesDrawn >= maxLines - 1) {
          // Truncate text if we're out of space
          const truncatedLine = line + '...';
          firstPage.drawText(truncatedLine, {
            x,
            y: currentY,
            size: fontSize,
            font,
            color: rgb(0, 0, 0),
          });
          return currentY - lineHeight;
        }
        
        // Draw completed line and move to next line
        firstPage.drawText(line, {
          x,
          y: currentY,
          size: fontSize,
          font,
          color: rgb(0, 0, 0),
        });
        
        line = word;
        currentY -= lineHeight;
        linesDrawn++;
      } else {
        line = testLine;
      }
    }
    
    // Draw the last line if we have space
    if (line && linesDrawn < maxLines) {
      firstPage.drawText(line, {
        x,
        y: currentY,
        size: fontSize,
        font,
        color: rgb(0, 0, 0),
      });
    }
    
    return currentY - lineHeight; // Return the Y position for the next text block
  }
  
  if (orientation === "vertical") {
    // Vertical layout text positioning
    let currentY = textY;
    const spacingBetweenSections = lineHeight / 2;
    
    // Draw title
    firstPage.drawText('TICKET INFORMATION:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    
    currentY -= lineHeight + spacingBetweenSections;
    
    // Draw item name
    firstPage.drawText('Event:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    
    currentY -= lineHeight;
    
    // Draw name with wrapping and height constraints
    currentY = drawWrappedText(
      orderInfo.name,
      textX + 10,
      currentY,
      maxTextWidth - 10,
      maxTextHeight * 0.4, // Use 40% of available height for event name
      lineHeight,
      helveticaFont,
      fontSize
    );
    
    // Draw variation if available and we have space
    if (orderInfo.variation && currentY > (height * 0.3 + lineHeight * 3)) {
      currentY -= spacingBetweenSections;
      
      firstPage.drawText('Details:', {
        x: textX,
        y: currentY,
        size: fontSize,
        font: helveticaBold,
        color: rgb(0, 0, 0),
      });
      
      currentY -= lineHeight;
      
      // Use remaining height for details
      const remainingHeight = currentY - (height * 0.3);
      drawWrappedText(
        orderInfo.variation + ": " + orderInfo.itemModifierValues,
        textX + 10,
        currentY,
        maxTextWidth - 10,
        remainingHeight,
        lineHeight,
        helveticaFont,
        fontSize
      );
    }
    
  } else {
    // Horizontal layout text positioning (existing logic with minor adjustments)
    // Calculate total text height to center vertically
    const titleHeight = lineHeight;
    const nameHeight = calculateTextHeight(orderInfo.name, maxTextWidth - 25, helveticaFont, fontSize);
    const variationHeight = orderInfo.variation ? 
      calculateTextHeight(orderInfo.variation, maxTextWidth - 35, helveticaFont, fontSize) : 0;
    
    // Add spacing between sections
    const spacingBetweenSections = lineHeight / 2;
    const totalTextHeight = titleHeight + nameHeight + 
      (orderInfo.variation ? variationHeight + spacingBetweenSections : 0);
    
    // Center text block vertically relative to QR code
    const qrCodeCenterY = qrCodeY + qrSize / 2;
    const startY = qrCodeCenterY + totalTextHeight / 2;
    
    // Draw title
    let currentY = startY;
    firstPage.drawText('TICKET INFORMATION:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    
    currentY -= lineHeight;
    
    // Draw item name with wrapping
    firstPage.drawText('Event:', {
      x: textX,
      y: currentY,
      size: fontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
    
    // Draw name with offset for "Event:" label
    currentY = drawWrappedText(
      orderInfo.name,
      textX + 35,
      currentY,
      maxTextWidth - 25,
      null, // No height constraint for horizontal layout
      lineHeight,
      helveticaFont,
      fontSize
    );
    
    // Draw variation if available
    if (orderInfo.variation) {
      currentY -= spacingBetweenSections; // Add spacing between sections
      
      firstPage.drawText('Details:', {
        x: textX,
        y: currentY,
        size: fontSize,
        font: helveticaBold,
        color: rgb(0, 0, 0),
      });
      
      // Draw variation with offset for "Details:" label
      drawWrappedText(
        orderInfo.variation + ": " + orderInfo.itemModifierValues,
        textX + 35,
        currentY,
        maxTextWidth - 35,
        null, // No height constraint for horizontal layout
        lineHeight,
        helveticaFont,
        fontSize
      );
    }
  }
  
  return await pdfDoc.save();
}

/**
* Saves a modified PDF to S3
*/
async function savePdfToS3(bucket, key, pdfBuffer) {
  await s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: pdfBuffer,
      ContentType: "application/pdf",
  }));

  console.log(`Saved PDF to S3: s3://${bucket}/${key}`);
}


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


