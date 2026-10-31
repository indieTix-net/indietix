// models/client.mjs
import { Sequelize, DataTypes } from 'sequelize';

// Define the Client model to match your existing PostgreSQL schema
const defineClientModel = (sequelize) => {
  return sequelize.define('Client', {
    // Primary key - matches your PostgreSQL "ID" field
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      field: 'ID' // Maps to the actual column name in PostgreSQL
    },
    
    // Client ID - matches your "clientID" field
    clientID: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      field: 'clientID'
    },
    
    // Client secret - matches your "clientSecret" field
    clientSecret: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: 'clientSecret'
    },
    
    // Contact name - matches your "contactName" field
    contactName: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'contactName'
    },
    
    // Client email - matches your "clientEmail" field
    clientEmail: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'clientEmail'
    },
    
    // Created date - matches your "createdDate" field
    createdDate: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'createdDate'
    },
    
    // Updated date - matches your "updatedDate" field
    updatedDate: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'updatedDate'
    },
    
    // Order ID - matches your "OrderID" field
    orderID: {
      type: DataTypes.STRING(100),
      allowNull: true,
      field: 'OrderID'
    },
    
    // Client plan - matches your "ClientPlan" field
    clientPlan: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'ClientPlan'
    },
    
    // Client max tickets per month - matches your "ClientMaxTicketsPerMonth" field
    clientMaxTicketsPerMonth: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'ClientMaxTicketsPerMonth'
    },
    
    // Client charge per ticket - matches your "ClientChargePerTicket" field
    clientChargePerTicket: {
      type: DataTypes.DECIMAL(19, 4),
      allowNull: true,
      field: 'ClientChargePerTicket'
    },
    
    // Has been setup - matches your "HasBeenSetup" field
    hasBeenSetup: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      field: 'HasBeenSetup'
    },
    
    // Status - matches your "Status" field
    status: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'Status'
    },
    
    // Configuration - matches your "configuration" field (JSON)
    configuration: {
      type: DataTypes.JSON,
      allowNull: true,
      field: 'configuration'
    }
  }, {
    // Table configuration
    tableName: 'Client', // Matches your existing table name with exact capitalization
    timestamps: false, // Disable Sequelize's automatic timestamp fields since we have our own
    schema: 'public' // PostgreSQL schema if needed
  });
};

// Function to initialize the model based on database credentials from AWS Secrets Manager
const initializeModelForClient = async (clientDbName, dbCredentials) => {
  try {
    console.log(`Creating Sequelize connection for client management: ${clientDbName}`);
    console.log(`Using host: ${dbCredentials.host}, port: ${dbCredentials.port}`);
    
    // Create a new Sequelize instance for the specific client database using provided credentials
    const clientSequelize = new Sequelize({
      host: dbCredentials.host,
      port: parseInt(dbCredentials.port || '5432'),
      database: clientDbName, // Use the client-specific database name from JWT
      username: dbCredentials.username,
      password: dbCredentials.password,
      dialect: 'postgres',
      dialectOptions: {
        ssl: dbCredentials.ssl === 'true' ? { rejectUnauthorized: false } : false
      },
      logging: false
    });
    
    // Test the connection
    await clientSequelize.authenticate();
    console.log(`Sequelize connection to client database '${clientDbName}' for client management established successfully.`);
    
    // Define the model for this client using the credentials
    const ClientModel = defineClientModel(clientSequelize);
    
    return { 
      sequelize: clientSequelize, 
      Client: ClientModel 
    };
  } catch (error) {
    console.error(`Error connecting to client database '${clientDbName}' with Sequelize for client management:`, error);
    throw error;
  }
};

// Create a default instance for backward compatibility (but this won't be used in production)
let sequelize = null;
let Client = null;

// Only create default instances if we have environment variables (for development/testing)
if (process.env.DB_HOST) {
  sequelize = new Sequelize({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'libertyHall',
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    dialect: 'postgres',
    dialectOptions: {
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
    },
    logging: process.env.NODE_ENV === 'development' ? console.log : false
  });
  
  Client = defineClientModel(sequelize);
}

// Export both the model and the initializer function
export { sequelize, Client, initializeModelForClient, Sequelize };
