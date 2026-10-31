import { Client } from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// Initialize AWS clients
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });

// Square API URLs
const SQUARE_CATALOG_SEARCH_API_URL = "https://connect.squareup.com/v2/catalog/search";
const SQUARE_CATALOG_OBJECT_API_URL = "https://connect.squareup.com/v2/catalog/object";

// Global variable to store current client configuration
let currentClientConfig = {};

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

/**
 * Gets all client databases by querying system catalogs
 * @param {Object} dbConfig - Database configuration object (connects to known client db)
 * @returns {Promise<Array>} - Array of database names
 */
async function getAllClientDatabases(dbConfig) {
  console.log("Discovering client databases...");
  const pgClient = new Client({
    ...dbConfig,
    // pg_database is a cluster-wide system catalog, so any database the
    // indietix superuser can reach works here -- 'postgres' is the default
    // maintenance database every Aurora Postgres cluster has, and avoids
    // hardcoding any particular client's database.
    database: 'postgres'
  });

  try {
    await pgClient.connect();
    console.log("Successfully connected to 'postgres' for discovery");
    
    // Query to find all databases except system databases
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
 * @param {string} databaseName - Name of the client database
 * @param {Object} baseDbConfig - Base database configuration
 * @returns {Promise<Object|null>} - Client configuration object or null if no valid config
 */
async function getClientConfiguration(databaseName, baseDbConfig) {
  const pgClient = new Client({
    ...baseDbConfig,
    database: databaseName
  });
  
  try {
    await pgClient.connect();
    
    // Check if Client table exists and has configuration data
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
    
    // Get configuration from Client table
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
 * @param {Object} baseDbConfig - Base database configuration object
 * @returns {Promise<Array>} - Array of client objects with configurations
 */
async function getAllClientsWithConfigurations(baseDbConfig) {
  console.log("Starting client discovery process...");
  
  // First, get all client databases
  const clientDatabases = await getAllClientDatabases(baseDbConfig);
  
  if (clientDatabases.length === 0) {
    console.log("No client databases found");
    return [];
  }
  
  // For each database, try to get its configuration
  const clients = [];
  for (const dbName of clientDatabases) {
    const clientConfig = await getClientConfiguration(dbName, baseDbConfig);
    if (clientConfig) {
      clients.push(clientConfig);
    }
    
    // Small delay to avoid overwhelming the database
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  console.log(`Successfully found ${clients.length} clients with valid configurations`);
  return clients;
}

/**
 * Processes a single client's Square catalog for expired modifiers
 * @param {Object} clientData - Client data with ID and configuration
 * @returns {Promise<Object>} - Processing result for the client
 */
async function processClientModifiers(clientData) {
  const { clientId, configuration } = clientData;
  
  console.log(`\n=== Processing client: ${clientId} ===`);
  
  try {
    // Set current client configuration globally
    currentClientConfig = configuration;
    
    // Get configuration values with defaults
    const attributeName = configuration.USE_QR_CODE || 'UseQRCode';
    const attributeValue = configuration.USE_QR_CODE_VALUE || 'true';
    const modifierNameFilter = configuration.MODIFIER_NAME_FILTER || 'Show Times';
    const targetCategories = configuration.TARGET_CATEGORIES ? 
      configuration.TARGET_CATEGORIES.split(',').map(cat => cat.trim()) : 
      ['Cinema', 'Events'];
    
    console.log(`Client ${clientId} configuration:`);
    console.log(`  - Attribute Name: ${attributeName}`);
    console.log(`  - Attribute Value: ${attributeValue}`);
    console.log(`  - Modifier Name Filter: ${modifierNameFilter}`);
    console.log(`  - Target Categories: [${targetCategories.join(', ')}]`);
    console.log(`  - Square Access Token: ${configuration.SQUARE_ACCESS_TOKEN ? 'Present' : 'Missing'}`);
    console.log(`  - Environment Type: ${configuration.ENV_TYPE}`);
    
    // Check if we have required Square credentials
    if (!configuration.SQUARE_ACCESS_TOKEN) {
      console.log(`  - Missing Square Access Token for ${clientId}, skipping`);
      return {
        clientId: clientId,
        success: false,
        error: 'Missing Square Access Token'
      };
    }
    
    const result = await removeExpiredEventTimeModifiers(attributeName, attributeValue, modifierNameFilter, targetCategories);
    
    return {
      clientId: clientId,
      success: true,
      ...result
    };
    
  } catch (error) {
    console.error(`Error processing client ${clientId}:`, error);
    
    return {
      clientId: clientId,
      success: false,
      error: error.message
    };
  }
}

// Exported for this repo's own tests -- purely additive, doesn't change
// handler's own behavior.
export {
    getAllClientDatabases,
    getClientConfiguration,
    getAllClientsWithConfigurations,
    parseDateFromModifierName,
    isModifierExpired,
    filterItemsByCustomAttribute,
    getItemsByCategoryNames,
    archiveItem,
    deleteCatalogObject,
    updateCatalogObject,
    retrieveCatalogObject,
    removeExpiredEventTimeModifiers,
    processClientModifiers
};

export const handler = async (event, context) => {
  console.log('Starting multi-client expired modifier removal process...');
  
  try {
    // Get indietix superuser credentials from Secrets Manager
    console.log('Retrieving indietix superuser credentials...');
    const dbCredentials = await getDatabaseCredentials('indieTix/rds/clients/indietix/credentials');
    
    // Base database configuration using indietix superuser
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
    
    // Get all clients with their configurations through database discovery
    console.log('Starting database discovery process...');
    const clients = await getAllClientsWithConfigurations(baseDbConfig);
    
    if (clients.length === 0) {
      console.log('No clients found with configurations.');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No clients found with configurations',
          timestamp: new Date().toISOString()
        })
      };
    }
    
    console.log(`Processing ${clients.length} clients for expired modifiers...`);
    
    // Process each client
    const results = [];
    for (const client of clients) {
      const result = await processClientModifiers(client);
      results.push(result);
      
      // Add a small delay between clients to avoid overwhelming Square API
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Summary statistics
    const successfulClients = results.filter(r => r.success);
    const failedClients = results.filter(r => !r.success);
    
    const totalStats = successfulClients.reduce((acc, result) => ({
      totalItemsFound: acc.totalItemsFound + (result.itemsFound || 0),
      totalModifierListsProcessed: acc.totalModifierListsProcessed + (result.modifierListsProcessed || 0),
      totalModifierListsUpdated: acc.totalModifierListsUpdated + (result.totalModifierListsUpdated || 0),
      totalModifierListsDeleted: acc.totalModifierListsDeleted + (result.totalModifierListsDeleted || 0),
      totalItemsArchived: acc.totalItemsArchived + (result.totalItemsArchived || 0),
      totalExpiredModifiersRemoved: acc.totalExpiredModifiersRemoved + (result.totalExpiredModifiersRemoved || 0)
    }), {
      totalItemsFound: 0,
      totalModifierListsProcessed: 0,
      totalModifierListsUpdated: 0,
      totalModifierListsDeleted: 0,
      totalItemsArchived: 0,
      totalExpiredModifiersRemoved: 0
    });
    
    console.log(`\n=== MULTI-CLIENT PROCESSING COMPLETE ===`);
    console.log(`Total clients processed: ${results.length}`);
    console.log(`Successful: ${successfulClients.length}`);
    console.log(`Failed: ${failedClients.length}`);
    console.log(`Total items found: ${totalStats.totalItemsFound}`);
    console.log(`Total expired modifiers removed: ${totalStats.totalExpiredModifiersRemoved}`);
    console.log(`Total items archived: ${totalStats.totalItemsArchived}`);
    
    if (failedClients.length > 0) {
      console.log('Failed clients:', failedClients.map(f => f.clientId).join(', '));
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Successfully processed ${successfulClients.length} of ${results.length} clients`,
        summary: {
          totalClients: results.length,
          successful: successfulClients.length,
          failed: failedClients.length,
          ...totalStats
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
        timestamp: new Date().toISOString()
      })
    };
  }
};

/**
 * Debug function to get ALL categories to see what exists
 */
async function getAllCategories() {
  try {
    console.log('Getting ALL categories for debugging...');
    
    const response = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        object_types: ['CATEGORY'],
        include_related_objects: false
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get all categories: ${response.status} ${errorText}`);
    }

    const categoryData = await response.json();
    
    if (categoryData.objects?.length) {
      console.log(`Found ${categoryData.objects.length} total categories:`);
      categoryData.objects.forEach(category => {
        if (category.type === 'CATEGORY' && category.category_data?.name) {
          console.log(`  - Category: "${category.category_data.name}" (ID: ${category.id})`);
        }
      });
      return categoryData.objects;
    } else {
      console.log('No categories found in catalog');
      return [];
    }
    
  } catch (error) {
    console.error(`Error getting all categories:`, error);
    return [];
  }
}

/**
 * Get category IDs by category names - with better debugging
 */
async function getCategoryIds(categoryNames = ['Cinema', 'Event']) {
  try {
    console.log(`Looking up category IDs for: ${categoryNames.join(', ')}...`);
    
    // First, get ALL categories to see what exists
    const allCategories = await getAllCategories();
    
    const categoryIds = [];
    
    if (allCategories.length > 0) {
      allCategories.forEach(category => {
        if (category.type === 'CATEGORY' && category.category_data?.name) {
          const categoryName = category.category_data.name;
          // Check if this category matches one of our target categories (case insensitive)
          if (categoryNames.some(target => target.toLowerCase() === categoryName.toLowerCase())) {
            categoryIds.push(category.id);
            console.log(`Found matching category "${categoryName}" with ID: ${category.id}`);
          }
        }
      });
    }
    
    if (categoryIds.length === 0) {
      console.log(`No categories found matching: ${categoryNames.join(', ')}`);
      console.log('Available categories are listed above. Please check the category names.');
    }
    
    console.log(`Found ${categoryIds.length} matching category IDs: ${categoryIds.join(', ')}`);
    return categoryIds;
    
  } catch (error) {
    console.error(`Error getting category IDs:`, error);
    throw error;
  }
}

/**
 * Get catalog items by category IDs
 */
async function getItemsByCategoryIds(categoryIds) {
  try {
    if (!categoryIds || categoryIds.length === 0) {
      console.log('No category IDs provided, returning empty result');
      return { objects: [], related_objects: [] };
    }
    
    console.log(`Fetching catalog items in category IDs: ${categoryIds.join(', ')}...`);
    
    let allItems = [];
    
    // Square doesn't support OR queries, so we need to search each category separately
    for (const categoryId of categoryIds) {
      try {
        console.log(`Searching for items in category ID: ${categoryId}`);
        
        const categoryResponse = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            object_types: ['ITEM'],
            query: {
              exact_query: {
                attribute_name: 'category_id',
                attribute_value: categoryId
              }
            },
            include_related_objects: true
          })
        });

        if (!categoryResponse.ok) {
          const errorText = await categoryResponse.text();
          console.error(`Failed to search for items in category ${categoryId}: ${categoryResponse.status} ${errorText}`);
          continue;
        }

        const categoryData = await categoryResponse.json();
        if (categoryData.objects?.length) {
          console.log(`Found ${categoryData.objects.length} items in category ${categoryId}`);
          allItems.push(...categoryData.objects);
          
          // Also collect related objects
          if (categoryData.related_objects) {
            allItems.push(...categoryData.related_objects);
          }
        }
        
      } catch (categoryError) {
        console.error(`Error searching category ${categoryId}:`, categoryError);
        continue;
      }
    }
    
    // Remove duplicates
    const uniqueItems = allItems.filter((item, index, self) => 
      index === self.findIndex(i => i.id === item.id)
    );
    
    console.log(`Total unique items found across categories: ${uniqueItems.length}`);
    
    return {
      objects: uniqueItems.filter(item => item.type === 'ITEM'),
      related_objects: uniqueItems.filter(item => item.type !== 'ITEM')
    };
    
  } catch (error) {
    console.error(`Error fetching items by category IDs:`, error);
    throw error;
  }
}

/**
 * Fallback: Get ALL catalog items (in case category approach fails)
 */
async function getAllCatalogItems() {
  try {
    console.log('Fallback: Getting ALL catalog items...');
    
    const response = await fetch(SQUARE_CATALOG_SEARCH_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        object_types: ['ITEM'],
        include_related_objects: true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to fetch all catalog items: ${response.status} ${errorText}`);
    }

    const catalogData = await response.json();
    console.log(`Retrieved ${catalogData.objects?.length || 0} total catalog items`);
    return catalogData;
  } catch (error) {
    console.error(`Error fetching all catalog items:`, error);
    throw error;
  }
}

/**
 * Get catalog items by category names - with fallback to all items
 */
async function getItemsByCategoryNames(categoryNames = ['Cinema', 'Event']) {
  try {
    console.log(`Fetching catalog items in categories: ${categoryNames.join(', ')}...`);
    
    // Step 1: Try to get category IDs
    const categoryIds = await getCategoryIds(categoryNames);
    
    if (categoryIds.length === 0) {
      console.log(`Category approach failed. Falling back to getting ALL items...`);
      console.log('This will be less efficient but will ensure we find items with the target attribute');
      
      // Fallback to getting all items
      return await getAllCatalogItems();
    }
    
    // Step 2: Get items in those categories
    return await getItemsByCategoryIds(categoryIds);
    
  } catch (error) {
    console.error(`Error searching items by category names:`, error);
    console.log(`Error occurred. Falling back to getting ALL items...`);
    
    // Fallback to getting all items on error
    try {
      return await getAllCatalogItems();
    } catch (fallbackError) {
      console.error(`Fallback also failed:`, fallbackError);
      throw fallbackError;
    }
  }
}

/**
 * Retrieve catalog object
 */
async function retrieveCatalogObject(objectId) {
  try {
    const response = await fetch(`${SQUARE_CATALOG_OBJECT_API_URL}/${objectId}?include_related_objects=true`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to retrieve catalog object ${objectId}: ${response.status} ${errorText}`);
    }

    const objectData = await response.json();
    return objectData;
  } catch (error) {
    console.error(`Error retrieving catalog object ${objectId}:`, error);
    throw error;
  }
}

/**
 * Delete catalog object
 */
async function deleteCatalogObject(objectId) {
  try {
    console.log(`Deleting catalog object: ${objectId}`);
    
    const response = await fetch(`${SQUARE_CATALOG_OBJECT_API_URL}/${objectId}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to delete catalog object ${objectId}: ${response.status} ${errorText}`);
    }

    const deleteData = await response.json();
    console.log(`Successfully deleted catalog object: ${objectId}`);
    return deleteData;
  } catch (error) {
    console.error(`Error deleting catalog object ${objectId}:`, error);
    throw error;
  }
}

/**
 * Archive item with correct field names for REST API
 */
async function archiveItem(itemId) {
  try {
    console.log(`Archiving item: ${itemId}`);
    
    // First get the current item to get the version and data
    const currentItem = await retrieveCatalogObject(itemId);
    
    if (!currentItem.object) {
      throw new Error(`Could not retrieve item ${itemId} for archiving`);
    }
    
    // Use snake_case for REST API
    const updatePayload = {
      idempotency_key: `archive-${itemId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      object: {
        type: "ITEM",
        id: itemId,
        version: currentItem.object.version,
        item_data: {
          ...currentItem.object.item_data,
          is_archived: true
        }
      }
    };

    const response = await fetch(SQUARE_CATALOG_OBJECT_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(updatePayload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to archive item ${itemId}: ${response.status} ${errorText}`);
    }

    const archiveData = await response.json();
    console.log(`Successfully archived item: ${itemId}`);
    return archiveData;
  } catch (error) {
    console.error(`Error archiving item ${itemId}:`, error);
    throw error;
  }
}

/**
 * Update catalog object
 */
async function updateCatalogObject(catalogObject) {
  try {
    const response = await fetch(SQUARE_CATALOG_OBJECT_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${currentClientConfig.SQUARE_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(catalogObject)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update catalog object: ${response.status} ${errorText}`);
    }

    const updateData = await response.json();
    return updateData;
  } catch (error) {
    console.error(`Error updating catalog object:`, error);
    throw error;
  }
}

/**
 * Filter items by custom attribute
 */
function filterItemsByCustomAttribute(catalogData, attributeName, attributeValue) {
  const itemsWithAttribute = [];
  const modifierListsToProcess = new Set();
  
  console.log(`Filtering items for ${attributeName} = ${attributeValue}...`);
  
  if (catalogData.objects && Array.isArray(catalogData.objects)) {
    catalogData.objects.forEach(catalogObject => {
      if (catalogObject.type === 'ITEM') {
        // Already archived -- nothing further to do here. Without this,
        // every already-archived item gets re-examined (and its modifier
        // list re-deleted, and the item re-archived) on every single run,
        // forever, since archiving doesn't remove an item from Square's
        // catalog search results the way deletion would.
        if (catalogObject.item_data?.is_archived === true) {
          console.log(`Skipping already-archived item: ${catalogObject.id}, name: ${catalogObject.item_data?.name}`);
          return;
        }

        let hasTargetAttribute = false;

        console.log(`Examining item: ${catalogObject.id}, name: ${catalogObject.item_data?.name}`);
        
        // Check for custom attributes at the item level
        if (catalogObject.custom_attribute_values && 
          typeof catalogObject.custom_attribute_values === 'object' && 
          catalogObject.custom_attribute_values !== null) {
          
          console.log(`Item has custom attributes: ${JSON.stringify(catalogObject.custom_attribute_values)}`);
          
          Object.entries(catalogObject.custom_attribute_values).forEach(([key, attribute]) => {
            console.log(`Examining attribute: ${key}, name: ${attribute.name}, type: ${attribute.type}`);
            
            if (attribute.name === attributeName && attribute.boolean_value === true) {
              hasTargetAttribute = true;
              console.log(`Found ${attributeName} attribute set to true`);
            }
          });
        }

        // Check at the variation level if not found at item level
        if (!hasTargetAttribute && catalogObject.item_data && catalogObject.item_data.variations) {
          console.log(`Checking variations for ${attributeName}`);
          
          catalogObject.item_data.variations.forEach(variation => {
            console.log(`Checking variation: ${variation.id}`);
            
            if (variation.custom_attribute_values && 
              typeof variation.custom_attribute_values === 'object' && 
              variation.custom_attribute_values !== null) {
              
              console.log(`Variation has custom attributes: ${JSON.stringify(variation.custom_attribute_values)}`);
              
              Object.entries(variation.custom_attribute_values).forEach(([key, attribute]) => {
                console.log(`Examining attribute: ${key}, name: ${attribute.name}, type: ${attribute.type}`);
                
                if (attribute.name === attributeName && attribute.boolean_value === true) {
                  hasTargetAttribute = true;
                  console.log(`Found ${attributeName} attribute set to true in variation`);
                }
              });
            }
          });
        }
        
        // If the item has the target attribute, collect its modifier lists
        if (hasTargetAttribute && catalogObject.item_data && catalogObject.item_data.modifier_list_info) {
          console.log(`Item has ${attributeName} and modifier lists - processing`);
          itemsWithAttribute.push(catalogObject);
          
          catalogObject.item_data.modifier_list_info.forEach(modifierListInfo => {
            modifierListsToProcess.add(modifierListInfo.modifier_list_id);
            console.log(`Adding modifier list ${modifierListInfo.modifier_list_id} to processing queue`);
          });
        }
      }
    });
  }
  
  console.log(`Found ${itemsWithAttribute.length} items with ${attributeName} = ${attributeValue}`);
  console.log(`Found ${modifierListsToProcess.size} unique modifier lists to process`);
  
  return {
    items: itemsWithAttribute,
    modifierLists: modifierListsToProcess
  };
}

/**
 * Parse date from modifier name format: 'Fri 05-30-2025 3:15 PM (Big Theatre)' or 'Fri 09-08-2025 (Big Theatre)'
 */
function parseDateFromModifierName(modifierName) {
  try {
    let match = modifierName.match(/^.*?(\d{2}-\d{2}-\d{4}\s+\d{1,2}:\d{2}\s+[AP]M)/);
    let hasTime = true;
    
    if (!match) {
      match = modifierName.match(/^.*?(\d{2}-\d{2}-\d{4})/);
      hasTime = false;
    }
    
    if (!match) {
      console.log(`Could not extract date from modifier name: "${modifierName}"`);
      return null;
    }
    
    const dateTimeStr = match[1];
    
    if (hasTime) {
      const [datePart, timePart, ampm] = dateTimeStr.split(' ');
      const [month, day, year] = datePart.split('-');
      
      // Create date string in format that toLocaleString understands as Chicago time
      // Then convert to UTC
      const chicagoDateStr = `${month}/${day}/${year} ${timePart} ${ampm}`;
      const parsedDate = new Date(chicagoDateStr + ' GMT-0600'); // CST offset
      
      console.log(`Parsed date from "${modifierName}": ${parsedDate.toISOString()}`);
      return parsedDate;
      
    } else {
      const [month, day, year] = dateTimeStr.split('-');
      const chicagoDateStr = `${month}/${day}/${year} 11:59 PM GMT-0600`;
      const parsedDate = new Date(chicagoDateStr);
      
      console.log(`Parsed date from "${modifierName}": ${parsedDate.toISOString()}`);
      return parsedDate;
    }
    
  } catch (error) {
    console.error(`Error parsing date from modifier name "${modifierName}":`, error.message);
    return null;
  }
}

function isModifierExpired(modifierName) {
  const eventDate = parseDateFromModifierName(modifierName);
  console.log(`Checking expiration for modifier "${modifierName}"`);

  if (!eventDate) return false;
  
  const currentTime = new Date(); // Current UTC time
  const bufferTime = new Date(currentTime.getTime() - (5 * 60 * 60 * 1000)); // 5 hours ago
  const isExpired = eventDate < bufferTime; // Event was more than 5 hours ago
  
  console.log(`Event date (UTC): ${eventDate.toISOString()}`);
  console.log(`Current time (UTC): ${currentTime.toISOString()}`);
  console.log(`Buffer cutoff (UTC): ${bufferTime.toISOString()}`);
  console.log(`Is Expired: ${isExpired}`);
  
  return isExpired;
}

/**
 * Main function to remove expired event time modifiers
 */
async function removeExpiredEventTimeModifiers(attributeName, attributeValue, modifierNameFilter, targetCategories) {
  console.log(`Step 1: Fetching catalog items in categories [${targetCategories.join(', ')}] and filtering for ${attributeName} = ${attributeValue}...`);
  
  // Step 1: Get items in specific categories
  const catalogData = await getItemsByCategoryNames(targetCategories);
  
  if (!catalogData.objects?.length) {
    console.log(`No catalog items found in categories: ${targetCategories.join(', ')}`);
    return {
      itemsFound: 0,
      modifierListsProcessed: 0,
      totalModifierListsUpdated: 0,
      totalModifierListsDeleted: 0,
      totalItemsArchived: 0,
      totalExpiredModifiersRemoved: 0,
      updatedLists: []
    };
  }

  console.log(`Found ${catalogData.objects.length} items in target categories`);

  // Step 2: Filter items by custom attribute and collect modifier lists
  const filterResult = filterItemsByCustomAttribute(catalogData, attributeName, attributeValue);
  
  if (filterResult.items.length === 0) {
    console.log(`No items found with ${attributeName} = ${attributeValue} in categories [${targetCategories.join(', ')}]`);
    return {
      itemsFound: 0,
      modifierListsProcessed: 0,
      totalModifierListsUpdated: 0,
      totalModifierListsDeleted: 0,
      totalItemsArchived: 0,
      totalExpiredModifiersRemoved: 0,
      updatedLists: []
    };
  }

  if (filterResult.modifierLists.size === 0) {
    console.log('No modifier lists found on matching items');
    return {
      itemsFound: filterResult.items.length,
      modifierListsProcessed: 0,
      totalModifierListsUpdated: 0,
      totalModifierListsDeleted: 0,
      totalItemsArchived: 0,
      totalExpiredModifiersRemoved: 0,
      updatedLists: []
    };
  }

  console.log(`Step 2: Found ${filterResult.modifierLists.size} unique modifier lists to process`);

  // Step 3: Process each modifier list
  const updatedLists = [];
  let totalExpiredModifiersRemoved = 0;
  let totalModifierListsDeleted = 0;
  let totalItemsArchived = 0;
  
  for (const modifierListId of filterResult.modifierLists) {
    try {
      console.log(`Processing modifier list: ${modifierListId}`);
      
      // Retrieve the current modifier list
      const retrieveResult = await retrieveCatalogObject(modifierListId);
      const modifierList = retrieveResult.object;
      
      if (!modifierList?.modifier_list_data?.modifiers?.length) {
        console.log(`Modifier list ${modifierListId} has no modifiers, skipping...`);
        continue;
      }

      // Step 4: Filter modifiers that are in target modifier lists and check if expired
      const originalModifiers = modifierList.modifier_list_data.modifiers;
      const expiredModifiers = [];
      const activeModifiers = [];
      const modifierListName = modifierList.modifier_list_data.name || '';
      
      console.log(`Found ${originalModifiers.length} modifiers in list "${modifierListName}"`);
      
      // Check if this modifier list matches our filter
      if (!modifierListName.includes(modifierNameFilter)) {
        console.log(`Modifier list "${modifierListName}" doesn't contain "${modifierNameFilter}", skipping...`);
        continue;
      }
      
      for (const modifier of originalModifiers) {
        const modifierName = modifier.modifier_data?.name || '';
        console.log(`Examining modifier: "${modifierName}"`);
        
        // Check if this event time modifier has expired
        if (isModifierExpired(modifierName)) {
          expiredModifiers.push(modifier);
          console.log(`EXPIRED: "${modifierName}" will be removed`);
        } else {
          activeModifiers.push(modifier);
          console.log(`ACTIVE: "${modifierName}" will be kept`);
        }
      }

      // Step 5: Decide what to do based on how many modifiers are expired
      if (expiredModifiers.length === 0) {
        console.log(`No expired modifiers found in list "${modifierListName}"`);
        continue;
      }

      // If ALL modifiers are expired, delete the modifier list and archive items
      if (activeModifiers.length === 0) {
        console.log(`ALL modifiers in "${modifierListName}" are expired. Deleting modifier list and archiving associated items...`);
        
        // Find all items that use this modifier list and archive them
        const itemsToArchive = filterResult.items.filter(item => 
          item.item_data?.modifier_list_info?.some(info => info.modifier_list_id === modifierListId)
        );
        
        console.log(`Found ${itemsToArchive.length} items to archive`);
        
        // Archive each item
        for (const item of itemsToArchive) {
          try {
            await archiveItem(item.id);
            totalItemsArchived++;
            console.log(`Archived item: ${item.item_data?.name} (${item.id})`);
          } catch (archiveError) {
            console.error(`Failed to archive item ${item.id}:`, archiveError.message);
          }
        }
        
        // Delete the modifier list
        try {
          await deleteCatalogObject(modifierListId);
          totalModifierListsDeleted++;
          totalExpiredModifiersRemoved += expiredModifiers.length;
          
          updatedLists.push({
            id: modifierListId,
            name: modifierListName,
            action: 'DELETED',
            expiredModifiersRemoved: expiredModifiers.map(m => m.modifier_data?.name || 'Unnamed'),
            itemsArchived: itemsToArchive.map(item => item.item_data?.name || 'Unnamed'),
            remainingModifiers: 0,
            originalModifierCount: originalModifiers.length
          });
          
          console.log(`Successfully deleted modifier list "${modifierListName}" and archived ${itemsToArchive.length} items`);
          
        } catch (deleteError) {
          console.error(`Failed to delete modifier list ${modifierListId}:`, deleteError.message);
        }
        
      } else {
        // Some modifiers are active, so just remove the expired ones
        console.log(`Removing ${expiredModifiers.length} expired modifiers from "${modifierListName}"`);

        const updatePayload = {
          idempotency_key: `remove-expired-${modifierListId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          object: {
            type: 'MODIFIER_LIST',
            id: modifierListId,
            version: modifierList.version,
            modifier_list_data: {
              ...modifierList.modifier_list_data,
              modifiers: activeModifiers
            }
          }
        };

        const updateResult = await updateCatalogObject(updatePayload);
        
        if (updateResult.catalog_object) {
          const removedModifierNames = expiredModifiers.map(m => m.modifier_data?.name || 'Unnamed');
          totalExpiredModifiersRemoved += expiredModifiers.length;
          
          updatedLists.push({
            id: modifierListId,
            name: modifierListName,
            action: 'UPDATED',
            expiredModifiersRemoved: removedModifierNames,
            remainingModifiers: activeModifiers.length,
            originalModifierCount: originalModifiers.length
          });
          
          console.log(`Successfully updated modifier list "${modifierListName}"`);
          console.log(`   Removed: ${removedModifierNames.join(', ')}`);
          console.log(`   Remaining: ${activeModifiers.length} modifiers`);
        }
      }

    } catch (error) {
      console.error(`Error processing modifier list ${modifierListId}:`, error.message);
    }
  }

  console.log('\n=== PROCESSING SUMMARY ===');
  console.log(`Items found with ${attributeName} = ${attributeValue}: ${filterResult.items.length}`);
  console.log(`Modifier lists processed: ${filterResult.modifierLists.size}`);
  console.log(`Modifier lists updated: ${updatedLists.filter(list => list.action === 'UPDATED').length}`);
  console.log(`Modifier lists deleted: ${totalModifierListsDeleted}`);
  console.log(`Items archived: ${totalItemsArchived}`);
  console.log(`Total expired modifiers removed: ${totalExpiredModifiersRemoved}`);

  return {
    itemsFound: filterResult.items.length,
    modifierListsProcessed: filterResult.modifierLists.size,
    totalModifierListsUpdated: updatedLists.filter(list => list.action === 'UPDATED').length,
    totalModifierListsDeleted,
    totalItemsArchived,
    totalExpiredModifiersRemoved,
    updatedLists
  };
}
