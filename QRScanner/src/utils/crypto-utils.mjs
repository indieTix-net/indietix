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

// ---- SEALED TOKENS ----
// Encrypted, expiring, purpose-bound tokens for links that carry data
// through a browser (hosted signup's Square sign-in state, its status page,
// its set-password link). AES-256-GCM, so they can be neither read nor
// altered; URL-safe base64. The key is 32 bytes (see signupKey in app.mjs).
export function sealToken(payload, key, ttlMs) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }), 'utf8'),
    cipher.final()
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

// The payload, or null if the token is malformed, altered, expired, or
// sealed for a different purpose.
export function openToken(token, key, purpose) {
  try {
    const raw = Buffer.from(String(token), 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const payload = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    if (payload.p !== purpose || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
// ---- END SEALED TOKENS ----
