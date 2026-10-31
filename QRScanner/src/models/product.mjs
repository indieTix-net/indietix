// models/product.mjs
import { Sequelize, DataTypes } from 'sequelize';

// Define the QRCodeProduct model to match your existing PostgreSQL schema
const defineQRCodeProductModel = (sequelize) => {
  return sequelize.define('QRCodeProduct', {
    // Primary key - matches your PostgreSQL "ID" field
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      field: 'ID' // Maps to the actual column name in PostgreSQL
    },
    
    // QR Code data - matches your "QRCode" field
    qrCode: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'QRCode'
    },
    
    // Check-in status - matches your "CheckedIn" field
    checkedIn: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      field: 'CheckedIn'
    },
    
    // Purchase Date - based on the CreatedDate column.
    // Frontend exposes this as `purchaseDate` on each ticket record.
    purchaseDate: {
	  type: DataTypes.DATE,
	  allowNull: true,
	  field: 'CreatedDate',
	  get() {
	    const date = this.getDataValue('purchaseDate');
	    if (!date) return null;

	    // Convert UTC storage to America/Chicago for display
	    return new Date(date).toLocaleString('en-US', {
	      year: 'numeric',
	      month: 'long',
	      day: 'numeric',
	      hour: 'numeric',
	      minute: '2-digit',
	      timeZone: 'America/Chicago'
	    });
	  }
    },

    // Expiration date - matches your "ExpirationDate" field
    expirationDate: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'ExpirationDate',
      get() {
        // Get the raw value
        const date = this.getDataValue('expirationDate');
        if (!date) return null;
        
        // Convert UTC storage to America/Chicago for display
        return new Date(date).toLocaleString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'America/Chicago'
        });
      }
    },
    
    // Last edited date - matches your "LastEditedDate" field
    lastEditedDate: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'LastEditedDate'
    },
    
    // Additional fields can be added to match your table schema
    name: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'ProductName' // If your table has this column
    },

    customerFirstName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'FirstName' // If your table has this column
    },

    customerLastName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'LastName' // If your table has this column
    },

    customerPhoneNumber: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'PhoneNumber' // If your table has this column
    },
    
    productDate: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'ProductDate',
      get() {
        // Get the raw value
        const date = this.getDataValue('productDate');
        if (!date) return null;

        // TODO: ProductDate is stored as a naive string (e.g. "2026-04-30 17:15:00")
        // representing showtime in Chicago local time. The current logic only
        // displays correctly because the runtime (Lambda) is in UTC; on a server
        // in any other timezone the displayed hour will shift. Long-term fix:
        // parse the string explicitly as America/Chicago using date-fns-tz or
        // Luxon, then format with timeZone: 'America/Chicago'.
        return new Date(date).toLocaleString('en-US', {
          month: 'long',
          day: 'numeric',
          year: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZone: 'UTC'
        });
      } // If your table has this column
    },
    productDetails: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'ProductDetails' // If your table has this column
    }, 
    productPrice: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'ProductPrice' // If your table has this column
    },
    emailAddress: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'EmailAddress' // If your table has this column
    },
    
    // NEW FIELD: Distributor - maps to the "Distributor" column
    distributor: {
      type: DataTypes.STRING(1000), // VARCHAR(1000) to match the column definition
      allowNull: true,
      field: 'Distributor' // Maps to the exact column name
    },

    // NEW FIELD: Event Venue - maps to the "ProductVenue" column
    eventVenue: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'ProductVenue' // Maps to the ProductVenue column
    },
    
    // NEW FIELD: Event Seat Code - maps to the "ProductSeatCode" column
    eventSeatCode: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'ProductSeatCode' // Maps to the ProductSeatCode column
    },
    
    // NEW FIELD: Event Type - maps to the "ProductType" column
    eventType: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'ProductType' // Maps to the ProductType column
    },
    status: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'Status' // Maps to the ProductType column
    }
  }, {
    // Table configuration
    tableName: 'QRCodeProduct', // Matches your existing table name with exact capitalization
    timestamps: false, // Disable Sequelize's automatic timestamp fields
    schema: 'public' // PostgreSQL schema if needed
  });
};

// Function to initialize the model based on database credentials from AWS Secrets Manager
const initializeModelForClient = async (clientDbName, dbCredentials) => {
  try {
    console.log(`Creating Sequelize connection for client: ${clientDbName}`);
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
    console.log(`Sequelize connection to client database '${clientDbName}' established successfully.`);
    
    // Define the model for this client using the credentials
    const ClientQRCodeProduct = defineQRCodeProductModel(clientSequelize);
    
    return { 
      sequelize: clientSequelize, 
      QRCodeProduct: ClientQRCodeProduct 
    };
  } catch (error) {
    console.error(`Error connecting to client database '${clientDbName}' with Sequelize:`, error);
    throw error;
  }
};

// Create a default instance for backward compatibility (but this won't be used in production)
let sequelize = null;
let QRCodeProduct = null;

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
  
  QRCodeProduct = defineQRCodeProductModel(sequelize);
}

// Export both the model and the initializer function
export { sequelize, QRCodeProduct, initializeModelForClient, Sequelize };


