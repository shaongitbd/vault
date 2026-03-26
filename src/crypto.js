'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const SALT_PATH = path.join(DATA_DIR, '.salt');

const SCRYPT_N = Math.pow(2, 15); // 32768 — strong but compatible
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MB

/**
 * Retrieve or generate the application-wide salt used for key derivation.
 * The salt is stored in `data/.salt` as 32 random bytes.
 */
function getAppSalt() {
  if (fs.existsSync(SALT_PATH)) {
    return fs.readFileSync(SALT_PATH);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const salt = crypto.randomBytes(32);
  fs.writeFileSync(SALT_PATH, salt);
  return salt;
}

/**
 * Derive a vault ID and encryption key from a password.
 *
 * @param {string} password
 * @returns {{ vaultId: string, encryptionKey: Buffer }}
 */
function deriveKeys(password) {
  const salt = getAppSalt();
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  const firstHalf = derived.subarray(0, 32);
  const secondHalf = derived.subarray(32, 64);

  const vaultId = crypto.createHash('sha256').update(firstHalf).digest('hex');
  const encryptionKey = Buffer.from(secondHalf);

  return { vaultId, encryptionKey };
}

/**
 * Encrypt a buffer using AES-256-GCM.
 * Output format: IV (16 bytes) + AuthTag (16 bytes) + CipherText
 *
 * @param {Buffer} data
 * @param {Buffer} key - 32-byte encryption key
 * @returns {Buffer}
 */
function encrypt(data, key) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const cipherText = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag(); // 16 bytes

  return Buffer.concat([iv, authTag, cipherText]);
}

/**
 * Decrypt a buffer previously encrypted with encrypt().
 *
 * @param {Buffer} encryptedData - IV (16) + AuthTag (16) + CipherText
 * @param {Buffer} key - 32-byte encryption key
 * @returns {Buffer}
 */
function decrypt(encryptedData, key) {
  const iv = encryptedData.subarray(0, 16);
  const authTag = encryptedData.subarray(16, 32);
  const cipherText = encryptedData.subarray(32);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

/**
 * Encrypt a UTF-8 string.
 *
 * @param {string} str
 * @param {Buffer} key
 * @returns {Buffer}
 */
function encryptString(str, key) {
  return encrypt(Buffer.from(str, 'utf-8'), key);
}

/**
 * Decrypt a buffer back to a UTF-8 string.
 *
 * @param {Buffer} buf
 * @param {Buffer} key
 * @returns {string}
 */
function decryptString(buf, key) {
  return decrypt(buf, key).toString('utf-8');
}

/**
 * Generate a random 32-character hex ID.
 *
 * @returns {string}
 */
function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = {
  deriveKeys,
  encrypt,
  decrypt,
  encryptString,
  decryptString,
  generateId,
};
