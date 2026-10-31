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
import QRCode from "qrcode";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import nodemailer from 'nodemailer';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import mailcomposer from 'mailcomposer';
import pg from 'pg';
import crypto from 'crypto';
import { WebhooksHelper } from "square";

const { Pool } = pg;


// Initialize PostgreSQL connection pool
const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'libertyHall',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Create a Nodemailer transporter using AWS SES
const transporter = nodemailer.createTransport({
  SES: { ses: new SESClient(), aws: { defaultProvider } }
});

// Configure AWS
const s3 = new S3();
const s3Client = new S3Client({ region: "us-east-2" });
const sesClient = new SESClient({ region: "us-east-2" });


// S3 bucket details
/*
const BUCKET_NAME = "libertyhall-ticket-templates";
const BUCKET_NAME_OUT = "libertyhall-ticket-out";
const TEMPLATE_PDF_KEY = "libertyHallEventTicketHorizontal.pdf";
*/
// Email details
const RECIPIENT_EMAIL = "lawrence.liberty.hall@gmail.com";
const SENDER_EMAIL = "lawrence.liberty.hall@gmail.com"; // Must be verified in SES

//square setup
const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN; // Store in AWS Lambda env vars
const ENV_TYPE = process.env.ENV_TYPE;
const ENV_TYPE_PROD = 'prod';
const ENV_TYPE_DEV = 'dev';
const SQUARE_API_URL = "https://connect.squareup.com/v2/orders/";
const SQUARE_CATALOG_API_URL = "https://connect.squareup.com/v2/catalog/batch-retrieve";
const SQUARE_CUSTOMER_API_URL = "https://connect.squareup.com/v2/customers/";

/**
 * Verifies client credentials against the Client table
 * @param {Object} pool - PostgreSQL connection pool for the client's database
 * @param {string} clientId - The client ID to verify
 * @param {string} clientSecret - The client secret to verify
 * @returns {Promise<boolean>} - True if credentials are valid, false otherwise
 */
async function verifyClientCredentials(pool, clientId/*, clientSecret*/) {
  try {
    // Query the Client table to verify credentials
    
    const query = `
      SELECT * FROM "Client" 
      WHERE "clientID" = $1
    `;

    const result = await pool.query(query, [clientId/*, clientSecret*/]);
    
    // If a row is found, credentials are valid
    const isValid = result.rows.length > 0;
    
    if (isValid) {
      console.log(`Successfully verified credentials for client: ${clientId}`);
    } else {
      console.error(`Invalid credentials for client: ${clientId}`);
      console.error(`query: ${query}`);
      console.error(`result: ${JSON.stringify(result)}`);
    }
    
    //return isValid;
    return result.rows;
  } catch (error) {
    console.error(`Error verifying client credentials for ${clientId}:`, error);
    return false;
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
    
    // First insert - QR code product
    const productQuery = `
      INSERT INTO "QRCodeProduct" ("QRCode", "CheckedIn", "CreatedDate", "ExpirationDate", "LastEditedDate",
      "ProductDate", "ProductName", "ProductLocation", "ProductType", "ProductDetails", "ProductPrice",
       "ProductID", "ProductMetadata", "EmailAddress", "FirstName", "LastName", "PhoneNumber")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
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
      productDetails.itemType, // ProductType
      productDetails.itemModifierValues, // ProductDetails
      productDetails.itemPrice, // ProductPrice
      productDetails.itemId, // ProductDetails (JSON)
      productDetails.itemDetails, // ProductDetails / metadata
      productDetails.emailAddress, // emailAddress
      productDetails.customerFirstName, // firstName
      productDetails.customerLastName, // lastName
      productDetails.customerPhoneNumber // phoneNumber
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

function findItemDataWithQRCode(data) {
  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findItemDataWithQRCode(item);
      if (result) return result;
    }
  } else if (typeof data === 'object' && data !== null) {
    // Check if 'custom_attribute_values' exists
    if (data.custom_attribute_values) {
      for (const key in data.custom_attribute_values) {
        const attr = data.custom_attribute_values[key];
        if (attr.name === "UseQRCode" && attr.boolean_value === true) {
          console.log("Found UseQRCode:", JSON.stringify(attr, null, 2));
          // Return the parent object's item_data property
          return data.item_data;
        }
      }
    }
    
    // Recursively search through other properties
    for (const key in data) {
      if (key !== 'custom_attribute_values') { // Avoid rechecking
        const result = findItemDataWithQRCode(data[key]);
        if (result) return result;
      }
    }
  }
  return null; // Return null if no match is found
}

async function getCustomer(customerId) {
  try {
    const response = await fetch(SQUARE_CUSTOMER_API_URL + customerId, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
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
    console.error(`Error verifying client credentials for ${clientId}:`, error);
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
        "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        object_ids: catalogObjectIds,
        include_related_objects: true/*,
        include_category_path_to_root: true*/
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
    console.error(`Error verifying client credentials for ${clientId}:`, error);
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

function getCatalogItemsDetailsForQR(orderData, catalogData) {
  // Part 1: Collect all catalog items that have the UseQRCode property set to true
  const itemIDsWithQRCodes = [];
  const reportingCategories = [];
  //@todo - exit loops early
  // Step 1: Loop through all the objects in the "related_objects" array
  if (catalogData.related_objects && Array.isArray(catalogData.related_objects)) {
    catalogData.related_objects.forEach(relatedObject => {
      // Step 2: Check if it's an ITEM type and has custom attribute values
      if (relatedObject.type === 'ITEM'/* && relatedObject.custom_attribute_values*/) {
        let hasQRCode = false;
        
        if (relatedObject.custom_attribute_values && 
          typeof relatedObject.custom_attribute_values === 'object' && 
          relatedObject.custom_attribute_values !== null) {
        // Step 3: Look for the UseQRCode attribute with boolean_value = true
        Object.values(relatedObject.custom_attribute_values).forEach(attribute => {
          if (attribute.name === 'UseQRCode' && attribute.boolean_value === true) {
            hasQRCode = true;
          }
        });
      }

        if (!hasQRCode) {
          relatedObject.item_data.variations.forEach(itemDataVariations => {
          // Check if custom_attribute_values exists and is an object
            if (itemDataVariations.custom_attribute_values && 
              typeof itemDataVariations.custom_attribute_values === 'object' && 
              itemDataVariations.custom_attribute_values !== null) {
            // Step 3: Look for the UseQRCode attribute with boolean_value = true
              Object.values(itemDataVariations.custom_attribute_values).forEach(attribute => {
                if (attribute.name === 'UseQRCode' && attribute.boolean_value === true) {
                  hasQRCode = true;
                }
            });
            }
          });
        }
        
        // Step 4: If UseQRCode is true, add all variation IDs to the array
        if (hasQRCode && relatedObject.item_data && relatedObject.item_data.variations) {
          relatedObject.item_data.variations.forEach(variation => {
            if (variation.id) {
              console.log("variation found:", JSON.stringify(variation));
              reportingCategories[variation.id] = JSON.stringify(relatedObject.item_data.categories);
              itemIDsWithQRCodes.push(variation.id);
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
        qrCodeItemsForPrint.push(lineItem);
      }
    });
  }
  console.log("New Function:", qrCodeItemsForPrint);
  return qrCodeItemsForPrint;
  ////itemIDsWithQRCodes,
    
}

/**
 * Creates and validates a database connection pool for a specific client
 * @param {string} clientId - The client ID, which is also the database name
 * @returns {Promise<Object|null>} - Returns a database pool if successful, null if not
 */
async function getClientPool(clientId) {
  try {
    // Validate the clientId format (lowercase letters and underscores only)
    if (!clientId || !/^[A-Za-z0-9]+$/.test(clientId)) {
      console.error(`Invalid clientId format: ${clientId}`);
      return null;
    }
    
    // Create a pool for this specific client database
    const clientPool = new Pool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432'),
      database: clientId, // Database name is the clientId
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      // Set a shorter idle timeout for Lambda environment
      idleTimeoutMillis: 10000,
      // Set reasonable pool limits for Lambda
      max: 3 // Maximum 3 clients in the pool
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
  
  // Pattern 1: "Month Day, HH:MM XM" format (April 10, 5:00 pm)
  const dateTimeRegex = /(\w+)\s+(\d{1,2})(?:,|\s)\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s*([ap]\.?m\.?)?/i;
  let match = input.match(dateTimeRegex);
  
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
 * Helper function to format date as Postgres timestamp
 */
function formatDate(date, includeTimezone) {
  if (!date || isNaN(date.getTime())) {
    return null;
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
  //test network connectivity
  if (ENV_TYPE == ENV_TYPE_PROD) {
    
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
  }
  
// end new client authorization code
  let orderId = null;
  let clientId = null;
  let clientPool = null;

//  const webhookData = event;
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

    let recipientEmail = RECIPIENT_EMAIL; // Default recipient
    let customerFirstName = '';
    let customerLastName = '';
    let customerPhoneNumber = '';
    if (webhookData.data.object.payment.buyer_email_address) {
      // Fallback to alternative ID extraction
      recipientEmail = webhookData.data.object.payment.buyer_email_address; // Default recipient
      customerFirstName = webhookData.data.object.payment.billing_address.first_name;
      customerLastName = webhookData.data.object.payment.billing_address.last_name;
      customerPhoneNumber = webhookData.data.object.payment.billing_address?.phone_number ?? ''; } else if (webhookData.data.object.payment.customer_id) {
      // make call to square api to get customer email
      let customer = await getCustomer(webhookData.data.object.payment.customer_id);
      console.log('Customer:', JSON.stringify(customer));
      recipientEmail = customer.customer.email_address;
      customerFirstName = customer.customer.given_name;
      customerLastName = customer.customer.family_name;
      customerPhoneNumber = customer.customer.phone_number;
    }

    // 2. Validate client credentials are provided
    if (!clientId /*|| !clientSecret*/) {
      console.error('Missing client credentials');
      return {
        statusCode: 401,
        body: JSON.stringify({ message: 'Unauthorized: Missing client credentials' })
      };
    }
    
    const BUCKET_NAME = clientId.toLowerCase();
    const FOLDER_NAME_OUT = "tickets-out";
    const TEMPLATE_PDF_KEY = "ticket.pdf";

    // 3. Get client-specific database pool
    clientPool = await getClientPool(clientId);
    if (!clientPool) {
      console.error(`Invalid client ID or database doesn't exist: ${clientId}`);
      return {
        statusCode: 401,
        body: JSON.stringify({ message: 'Unauthorized: Invalid client' })
      };
    }
    
    
    // 4. Verify client credentials
    let isAuthorized = await verifyClientCredentials(clientPool, clientId/*, clientSecret*/);
    if (isAuthorized.length == 0) {
      console.error(`Invalid client credentials for client: ${clientId}`);
      await clientPool.end(); // Close the pool for this invalid client
      return {
        statusCode: 401,
        body: JSON.stringify({ message: 'Unauthorized: Invalid credentials' })
      };
    }
    
    let sigKey = isAuthorized[0]['SQUARE_SIGNATURE_KEY'];
    let notURL = isAuthorized[0]['SQUARE_WEBHOOK_URL'];
    if (ENV_TYPE == ENV_TYPE_PROD) {
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
      /*
      console.error("payment status not valid:", JSON.stringify(event, null, 2));
      throw new Error("Invalid payment status for ticket creation");
      */
      return {
        statusCode: 200,
        body: JSON.stringify({ message: 'we are only accepting payment stati that are completed' })
      };
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
          "Authorization": `Bearer ${SQUARE_ACCESS_TOKEN}`,
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
    //const catalogItemsMap = await fetchCatalogItems(catalogObjectIds);
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
        itemType: item.reportingCategories,
        itemLocation: item.location_id,
        itemModifierValues: itemModifiersString,
        itemDetails: JSON.stringify(item),
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
      // First, process all items and create the PDF tickets
      for (const lineItem of finalItemArray) {
      
        console.log(`Processing lineItem: ${JSON.stringify(lineItem)}`);
        const itemName = lineItem.itemName || "Unknown Item";
        const itemId = lineItem.itemId || "Unknown ItemId";
        const sku = lineItem.qrCodeData;
        
        emailBody += `Event: ${itemName}\n`;
        
        let currentVariation = lineItem.variationName;
          try {
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
                itemType: lineItem.itemType,
                itemLocation: lineItem.itemLocation,
                itemDate: parseToPostgresTimestamp(lineItem.itemModifierValues),
                itemModifierValues: lineItem.itemModifierValues, 
                emailAddress: recipientEmail,
                'customerFirstName': customerFirstName,
                'customerLastName': customerLastName,
                'customerPhoneNumber': customerPhoneNumber
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
              item: `${itemName} ${currentVariation}`
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
            SENDER_EMAIL,
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
          ticketCount: emailAttachments.length
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
        // If you want to close it, uncomment: await pool.end();
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

  // Send the raw email
  const result = await sesClient.send(new SendRawEmailCommand({
    RawMessage: { Data: mimeMessage }
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
  
  // QR code position and dimensions
  const qrSize = 120;
  const qrCodeX = width - 130;
  const qrCodeY = (height / 2) - 60;
  
  // Draw QR code
  firstPage.drawImage(qrImage, {
    x: qrCodeX,
    y: qrCodeY,
    width: qrSize,
    height: qrSize,
  });
  
  // Text parameters
  const textX = width - 275;
  const maxTextWidth = qrCodeX - textX - 10; // 10px padding
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
  
  // Function to handle text wrapping
  function drawWrappedText(text, x, y, maxWidth, lineHeight, font, fontSize) {
    if (!text) return y;
    
    const words = text.split(' ');
    let line = '';
    let currentY = y;
    
    for (const word of words) {
      const testLine = line + (line ? ' ' : '') + word;
      const textWidth = font.widthOfTextAtSize(testLine, fontSize);
      
      if (textWidth > maxWidth && line) {
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
      } else {
        line = testLine;
      }
    }
    
    // Draw the last line
    if (line) {
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
  
  // Draw name with offset for "Item:" label
  currentY = drawWrappedText(
    orderInfo.name,
    textX + 35,
    currentY,
    maxTextWidth - 25,
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
      lineHeight,
      helveticaFont,
      fontSize
    );
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
