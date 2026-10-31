// models/Order.mjs
import { Sequelize, DataTypes } from 'sequelize';

// Define the Order model to match your existing PostgreSQL schema
const defineOrderModel = (sequelize) => {
  return sequelize.define('Order', {
    // Primary key - matches your PostgreSQL "ID" field
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      field: 'ID' // Maps to the actual column name in PostgreSQL
    },
    
    // Order ID - matches your "OrderID" field
    orderID: {
      type: DataTypes.STRING(100),
      allowNull: false,
      field: 'OrderID'
    },
    
    // Created date - matches your "CreatedDate" field
    createdDate: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'CreatedDate'
    },
    
    // Last edited date - matches your "LastEditedDate" field
    lastEditedDate: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'LastEditedDate'
    },
    
    // Order metadata - matches your "OrderMetaData" field (JSONB)
    orderMetaData: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: 'OrderMetaData'
    },
    
    // Phone number - matches your "PhoneNumber" field
    phoneNumber: {
      type: DataTypes.STRING(420),
      allowNull: true,
      field: 'PhoneNumber'
    },
    
    // Last name - matches your "LastName" field
    lastName: {
      type: DataTypes.STRING(420),
      allowNull: true,
      field: 'LastName'
    },
    
    // First name - matches your "FirstName" field
    firstName: {
      type: DataTypes.STRING(420),
      allowNull: true,
      field: 'FirstName'
    },
    
    // Email address - matches your "EmailAddress" field
    emailAddress: {
      type: DataTypes.STRING(420),
      allowNull: true,
      field: 'EmailAddress'
    },
    
    // Status - Valid, Refunded, Cancelled, Deleted
    status: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'Valid',
      field: 'Status'
    }
  }, {
    // Table configuration
    tableName: 'Order', // Matches your existing table name with exact capitalization
    timestamps: false, // Disable Sequelize's automatic timestamp fields since we have our own
    schema: 'public' // PostgreSQL schema if needed
  });
};

// Function to initialize the model based on database credentials from AWS Secrets Manager
const initializeModelForClient = async (clientDbName, dbCredentials) => {
  try {
    console.log(`Creating Sequelize connection for client orders: ${clientDbName}`);
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
    console.log(`Sequelize connection to client database '${clientDbName}' for orders established successfully.`);
    
    // Define the model for this client using the credentials
    const ClientOrder = defineOrderModel(clientSequelize);
    
    return { 
      sequelize: clientSequelize, 
      Order: ClientOrder 
    };
  } catch (error) {
    console.error(`Error connecting to client database '${clientDbName}' with Sequelize for orders:`, error);
    throw error;
  }
};

// Create a default instance for backward compatibility (but this won't be used in production)
let sequelize = null;
let Order = null;

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
  
  Order = defineOrderModel(sequelize);
}

// Export both the model and the initializer function
export { sequelize, Order, initializeModelForClient, Sequelize };


