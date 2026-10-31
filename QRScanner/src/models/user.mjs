// models/user.mjs
import { Sequelize, DataTypes } from 'sequelize';

// Define the User model for sub-user authentication and permissions
const defineUserModel = (sequelize) => {
  return sequelize.define('User', {
    // Primary key
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
      field: 'ID'
    },
    
    // Username for login
    username: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      field: 'Username'
    },
    
    // Hashed password (similar to clientSecret)
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'Password'
    },
    
    // Email address
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      field: 'Email'
    },
    
    // First name
    firstName: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'FirstName'
    },
    
    // Last name
    lastName: {
      type: DataTypes.STRING(255),
      allowNull: true,
      field: 'LastName'
    },
    
    // Permissions JSON - e.g., { view: true, edit: false, checkIn: false, marketing: false, admin: false }
    // - view:      access to most pages (orders, reports, scanner, products)
    // - edit:      access to all sub-user pages including create movie/event
    // - checkIn:   limited to scanner (index.html) and products.html only
    // - marketing: access to the Marquee Engine schedule editor / status page (marketing.html)
    // - admin:     access to Client Settings (client.html) and Insights (insights.html)
    // Existing rows without checkIn/marketing/admin will read as undefined → falsy (treated as false).
    permissions: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: { view: true, edit: false, checkIn: false, marketing: false, admin: false },
      field: 'Permissions'
    },
    
    // Data filters JSON - e.g., { datafilters: [{ date: '10-10-2025', event: 'cinemaName', eventType: 'cinema' }] }
    dataFilter: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: { datafilters: [] },
      field: 'DataFilter'
    },
    
    // Created date
    createdDate: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'CreatedDate'
    },
    
    // Updated date
    updatedDate: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'UpdatedDate'
    }
  }, {
    tableName: 'Users',
    timestamps: false,
    schema: 'public'
  });
};

// Function to initialize the User model for a specific client database
const initializeModelForClient = async (clientDbName, dbCredentials) => {
  try {
    console.log(`Creating Sequelize connection for User management: ${clientDbName}`);
    
    const clientSequelize = new Sequelize({
      host: dbCredentials.host,
      port: parseInt(dbCredentials.port || '5432'),
      database: clientDbName,
      username: dbCredentials.username,
      password: dbCredentials.password,
      dialect: 'postgres',
      dialectOptions: {
        ssl: dbCredentials.ssl === 'true' ? { rejectUnauthorized: false } : false
      },
      logging: false
    });
    
    await clientSequelize.authenticate();
    console.log(`Sequelize connection to client database '${clientDbName}' for User management established successfully.`);
    
    const UserModel = defineUserModel(clientSequelize);
    
    return { 
      sequelize: clientSequelize, 
      User: UserModel 
    };
  } catch (error) {
    console.error(`Error connecting to client database '${clientDbName}' with Sequelize for User management:`, error);
    throw error;
  }
};

// Create a default instance for backward compatibility
let sequelize = null;
let User = null;

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
  
  User = defineUserModel(sequelize);
}

export { sequelize, User, initializeModelForClient, Sequelize };
