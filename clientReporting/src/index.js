const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

// Initialize AWS clients
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'us-east-2' });

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
 * @param {Object} dbConfig - Database configuration object (connects to postgres db)
 * @returns {Promise<Array>} - Array of database names
 */
async function getAllClientDatabases(dbConfig) {
  console.log("Discovering client databases...");
  const pgClient = new Client({
    ...dbConfig,
    database: 'postgres'
  });
  
  try {
    await pgClient.connect();
    
    // Query to find all databases except system databases
    const query = `
      SELECT datname 
      FROM pg_database 
      WHERE datname NOT IN ('postgres', 'template0', 'template1', 'rdsadmin', 'indietix')
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
 * Gets client records from a specific client database
 * @param {string} databaseName - Name of the client database
 * @param {Object} baseDbConfig - Base database configuration
 * @returns {Promise<Array>} - Array of client records from this database
 */
async function getClientsFromDatabase(databaseName, baseDbConfig) {
  const pgClient = new Client({
    ...baseDbConfig,
    database: databaseName
  });
  
  try {
    await pgClient.connect();
    
    // Check if Client table exists
    const tableExistsQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'Client'
      );
    `;
    
    const tableResult = await pgClient.query(tableExistsQuery);
    if (!tableResult.rows[0].exists) {
      console.log(`Database ${databaseName}: No 'Client' table found`);
      return [];
    }
    
    // Get all client records from this database
    const clientQuery = `
      SELECT 
        $1 as source_database,
        "ID" as client_id,
        "clientID" as clientid,
        "clientSecret" as clientsecret,
        "contactName" as contactname,
        "clientEmail" as clientemail,
        "createdDate" as createddate,
        "updatedDate" as updateddate,
        "OrderID" as orderid,
        "ClientPlan" as clientplan,
        "ClientMaxTicketsPerMonth" as clientmaxtickets,
        "ClientChargePerTicket" as clientchargeperticket,
        "HasBeenSetup" as hasbeensetup,
        "Status" as status,
        "configuration"
      FROM "Client"
      ORDER BY "ID"
    `;
    
    const result = await pgClient.query(clientQuery, [databaseName]);
    
    console.log(`Database ${databaseName}: Found ${result.rows.length} client records`);
    return result.rows;
    
  } catch (error) {
    console.log(`Database ${databaseName}: Error querying clients - ${error.message}`);
    return [];
  } finally {
    await pgClient.end();
  }
}

/**
 * Gets all client records from all discovered client databases
 * @param {Object} baseDbConfig - Base database configuration object
 * @returns {Promise<Array>} - Array of all client objects from all databases
 */
async function getAllClientsFromAllDatabases(baseDbConfig) {
  console.log("Starting cross-database client consolidation...");
  
  // First, get all client databases
  const clientDatabases = await getAllClientDatabases(baseDbConfig);
  
  if (clientDatabases.length === 0) {
    console.log("No client databases found");
    return [];
  }
  
  // For each database, get its client records
  const allClients = [];
  for (const dbName of clientDatabases) {
    const clientsFromDb = await getClientsFromDatabase(dbName, baseDbConfig);
    allClients.push(...clientsFromDb);
    
    // Small delay to avoid overwhelming the database
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  
  console.log(`Successfully consolidated ${allClients.length} client records from ${clientDatabases.length} databases`);
  return allClients;
}

// Exported for this repo's own tests -- purely additive, doesn't change
// exports.handler's own behavior.
exports.getAllClientDatabases = getAllClientDatabases;
exports.getClientsFromDatabase = getClientsFromDatabase;
exports.getAllClientsFromAllDatabases = getAllClientsFromAllDatabases;

/**
 * Main Lambda handler - returns consolidated client data from all databases
 */
exports.handler = async (event, context) => {
  console.log('Client Consolidation Lambda started');
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // Get database credentials from Secrets Manager
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
    
    // Get all clients from all databases
    const allClients = await getAllClientsFromAllDatabases(baseDbConfig);
    
    // Parse query parameters for filtering
    // SECURITY: include_configuration defaults to 'false' and must be
    // explicitly set to the string 'true' to opt IN to seeing a client's
    // full configuration JSON (which contains SQUARE_ACCESS_TOKEN,
    // SQUARE_SIGNATURE_KEY, SMS campaign IDs, etc.). Was previously
    // inverted -- any value other than the literal string 'false' leaked
    // every client's full configuration by default. Fixed 2026-10-25,
    // found while writing this repo's test suite.
    const {
      include_configuration = 'false',
      database_filter,
      status_filter
    } = event.queryStringParameters || {};
    
    // Apply filters if requested
    let filteredClients = allClients;
    
    if (database_filter) {
      filteredClients = filteredClients.filter(client => 
        client.source_database.includes(database_filter)
      );
    }
    
    if (status_filter) {
      filteredClients = filteredClients.filter(client => 
        client.status && client.status.toLowerCase() === status_filter.toLowerCase()
      );
    }
    
    // Only include the full configuration blob when explicitly opted
    // into -- clientsecret is always stripped regardless.
    if (include_configuration === 'true') {
      filteredClients = filteredClients.map(client => {
        const { clientsecret, ...clientWithoutSecret } = client;
        return clientWithoutSecret;
      });
    } else {
      filteredClients = filteredClients.map(client => {
        const { configuration, clientsecret, ...clientWithoutSensitive } = client;
        return clientWithoutSensitive;
      });
    }
    
    // Summary statistics
    const databaseCounts = {};
    allClients.forEach(client => {
      databaseCounts[client.source_database] = (databaseCounts[client.source_database] || 0) + 1;
    });
    
    console.log(`Returning ${filteredClients.length} client records`);
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({
        summary: {
          total_clients: allClients.length,
          filtered_clients: filteredClients.length,
          databases_scanned: Object.keys(databaseCounts).length,
          clients_per_database: databaseCounts
        },
        clients: filteredClients,
        timestamp: new Date().toISOString()
      })
    };
    
  } catch (error) {
    console.error('Fatal error in client consolidation:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: 'Fatal error in client consolidation',
        message: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};
