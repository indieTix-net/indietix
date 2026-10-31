// user-setup.mjs - Script to create users and hash passwords
import pkg from 'pg';
import bcrypt from 'bcryptjs';
import readline from 'readline';

const { Pool } = pkg;

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'libertyHall',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'your_password',
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to create a new user
async function createUser(username, password, email) {
  try {
    // Hash the password with bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Insert the user into the Clients table
    const result = await pool.query(
      'INSERT INTO "Clients" ("Username", "Password", "Email", "CreatedDate", "Active") VALUES ($1, $2, $3, CURRENT_TIMESTAMP, TRUE) RETURNING "ID"',
      [username, hashedPassword, email]
    );
    
    console.log(`User ${username} created successfully with ID: ${result.rows[0].ID}`);
    return result.rows[0].ID;
  } catch (error) {
    console.error('Error creating user:', error);
    throw error;
  }
}

// Function to prompt for user information
function promptUserInfo() {
  return new Promise((resolve) => {
    rl.question('Enter username: ', (username) => {
      rl.question('Enter password: ', (password) => {
        rl.question('Enter email: ', (email) => {
          resolve({ username, password, email });
        });
      });
    });
  });
}

// Main function
async function main() {
  try {
    console.log('=== User Creation Tool ===');
    
    // Get user information
    const { username, password, email } = await promptUserInfo();
    
    // Create the user
    await createUser(username, password, email);
    
    console.log('\nIMPORTANT: You must also create a new database with the same name as the username.');
    console.log('Run the following commands in your PostgreSQL console:');
    console.log(`CREATE DATABASE ${username};`);
    console.log(`\\c ${username}`);
    console.log(`CREATE TABLE "QRCodes" (
  "ID" SERIAL PRIMARY KEY,
  "QRCode" VARCHAR(50) NOT NULL,
  "CheckedIn" BOOLEAN NOT NULL DEFAULT FALSE,
  "CreatedDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ExpirationDate" TIMESTAMP NOT NULL,
  "LastEditedDate" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_qrcodes_qrcode ON "QRCodes" ("QRCode");`);
    
  } catch (error) {
    console.error('Error in main function:', error);
  } finally {
    // Close the database connection and readline
    await pool.end();
    rl.close();
  }
}

// Run the main function
main();
