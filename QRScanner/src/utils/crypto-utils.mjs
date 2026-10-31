// utils/crypto-utils.mjs
import crypto from 'crypto';

/**
 * Encrypts data with a timestamp for password reset URLs
 * @param {string} email - The email address to encrypt
 * @param {string} secret - The encryption secret from AWS Secrets Manager
 * @returns {string} - Base64 encoded encrypted string
 */
export function encryptPasswordResetToken(email, secret) {
  const timestamp = Date.now();
  const data = JSON.stringify({ email, timestamp });
  
  // Create cipher
  const algorithm = 'aes-256-cbc';
  const key = crypto.scryptSync(secret, 'salt', 32);
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  let encrypted = cipher.update(data, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Combine IV and encrypted data
  const combined = iv.toString('hex') + ':' + encrypted;
  
  // Return URL-safe base64
  return Buffer.from(combined).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Decrypts password reset token
 * @param {string} token - The encrypted token from URL
 * @param {string} secret - The encryption secret from AWS Secrets Manager
 * @returns {object|null} - { email, timestamp } or null if invalid
 */
export function decryptPasswordResetToken(token, secret) {
  try {
    // Convert from URL-safe base64
    const urlSafeToken = token
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    
    // Add padding if needed
    const padding = '='.repeat((4 - (urlSafeToken.length % 4)) % 4);
    const combined = Buffer.from(urlSafeToken + padding, 'base64').toString('utf8');
    
    // Split IV and encrypted data
    const parts = combined.split(':');
    if (parts.length !== 2) {
      return null;
    }
    
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    
    // Decrypt
    const algorithm = 'aes-256-cbc';
    const key = crypto.scryptSync(secret, 'salt', 32);
    
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    const data = JSON.parse(decrypted);
    return data;
  } catch (error) {
    console.error('Error decrypting password reset token:', error);
    return null;
  }
}

/**
 * Validates if a password reset token is still valid (within 30 minutes)
 * @param {number} timestamp - The timestamp from the token
 * @returns {boolean} - true if valid, false if expired
 */
export function isPasswordResetTokenValid(timestamp) {
  const now = Date.now();
  const thirtyMinutes = 30 * 60 * 1000; // 30 minutes in milliseconds
  return (now - timestamp) < thirtyMinutes;
}
