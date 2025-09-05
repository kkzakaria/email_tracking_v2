/**
 * Token Encryption Service - AES-256-GCM
 * Email Tracking System - Critical Security Infrastructure
 * Created: 2025-09-05 by security-engineer
 * 
 * ⚠️ CRITICAL SECURITY: This service handles encryption of Microsoft Graph tokens
 * Uses AES-256-GCM with PBKDF2 key derivation for maximum security
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto';

// Encryption configuration constants
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const SALT_LENGTH = 64; // 512 bits
const TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000; // 100k iterations for PBKDF2

// Environment validation
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  throw new Error('ENCRYPTION_KEY environment variable is required');
}

if (ENCRYPTION_KEY.length < 32) {
  throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
}

/**
 * Encrypted data structure
 */
export interface EncryptedToken {
  data: string; // Base64 encoded: salt + iv + tag + encrypted_data
  algorithm: string;
  created_at: string;
  version: number;
}

/**
 * Token Encryption Service
 * Provides secure encryption/decryption for Microsoft Graph API tokens
 */
class TokenEncryptionService {
  private static readonly VERSION = 1;

  /**
   * Derive encryption key using PBKDF2
   * @param password - Base encryption key from environment
   * @param salt - Random salt for key derivation
   * @returns Derived encryption key
   */
  private static deriveKey(password: string, salt: Buffer): Buffer {
    return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
  }

  /**
   * Encrypt plaintext data using AES-256-GCM
   * @param plaintext - Data to encrypt (token, refresh token, etc.)
   * @param userId - User ID for additional entropy (optional but recommended)
   * @returns Encrypted token object
   */
  static encrypt(plaintext: string, userId?: string): EncryptedToken {
    if (!plaintext) {
      throw new Error('Plaintext data is required for encryption');
    }

    try {
      // Generate random values
      const salt = randomBytes(SALT_LENGTH);
      const iv = randomBytes(IV_LENGTH);
      
      // Add userId to entropy if provided
      const keyMaterial = userId ? `${ENCRYPTION_KEY}:${userId}` : ENCRYPTION_KEY;
      
      // Derive encryption key
      const key = this.deriveKey(keyMaterial, salt);
      
      // Create cipher
      const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
      
      // Encrypt data
      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      // Get authentication tag
      const tag = cipher.getAuthTag();
      
      // Combine all components: salt + iv + tag + encrypted_data
      const combined = Buffer.concat([
        salt,
        iv,
        tag,
        Buffer.from(encrypted, 'hex')
      ]);
      
      return {
        data: combined.toString('base64'),
        algorithm: ENCRYPTION_ALGORITHM,
        created_at: new Date().toISOString(),
        version: this.VERSION
      };

    } catch (error) {
      console.error('Encryption failed:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt encrypted token data
   * @param encryptedToken - Encrypted token object
   * @param userId - User ID for additional entropy (must match encryption)
   * @returns Decrypted plaintext
   */
  static decrypt(encryptedToken: EncryptedToken, userId?: string): string {
    if (!encryptedToken?.data) {
      throw new Error('Encrypted token data is required');
    }

    if (encryptedToken.algorithm !== ENCRYPTION_ALGORITHM) {
      throw new Error(`Unsupported encryption algorithm: ${encryptedToken.algorithm}`);
    }

    if (encryptedToken.version !== this.VERSION) {
      throw new Error(`Unsupported encryption version: ${encryptedToken.version}`);
    }

    try {
      // Decode base64 data
      const buffer = Buffer.from(encryptedToken.data, 'base64');
      
      // Extract components
      const salt = buffer.subarray(0, SALT_LENGTH);
      const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
      const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
      const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
      
      // Recreate encryption key
      const keyMaterial = userId ? `${ENCRYPTION_KEY}:${userId}` : ENCRYPTION_KEY;
      const key = this.deriveKey(keyMaterial, salt);
      
      // Create decipher
      const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
      decipher.setAuthTag(tag);
      
      // Decrypt data
      let decrypted = decipher.update(encrypted, undefined, 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;

    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error('Failed to decrypt data - token may be corrupted or tampered with');
    }
  }

  /**
   * Validate encrypted token without decrypting
   * @param encryptedToken - Token to validate
   * @returns true if token appears valid
   */
  static validate(encryptedToken: EncryptedToken): boolean {
    try {
      if (!encryptedToken?.data || !encryptedToken.algorithm || !encryptedToken.version) {
        return false;
      }

      if (encryptedToken.algorithm !== ENCRYPTION_ALGORITHM) {
        return false;
      }

      if (encryptedToken.version !== this.VERSION) {
        return false;
      }

      // Validate base64 data length
      const buffer = Buffer.from(encryptedToken.data, 'base64');
      const expectedMinLength = SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1; // +1 for at least some encrypted data
      
      return buffer.length >= expectedMinLength;

    } catch (error) {
      return false;
    }
  }

  /**
   * Check if token is expired (based on creation time)
   * @param encryptedToken - Token to check
   * @param maxAgeHours - Maximum age in hours (default: 24)
   * @returns true if token is expired
   */
  static isExpired(encryptedToken: EncryptedToken, maxAgeHours = 24): boolean {
    try {
      if (!encryptedToken?.created_at) {
        return true; // Consider invalid tokens as expired
      }

      const createdAt = new Date(encryptedToken.created_at);
      const expiryTime = new Date(createdAt.getTime() + (maxAgeHours * 60 * 60 * 1000));
      
      return new Date() > expiryTime;

    } catch (error) {
      return true; // Consider invalid dates as expired
    }
  }

  /**
   * Securely compare two encrypted tokens for equality
   * @param token1 - First token
   * @param token2 - Second token
   * @returns true if tokens are equal (timing-safe comparison)
   */
  static secureCompare(token1: EncryptedToken, token2: EncryptedToken): boolean {
    try {
      if (!token1?.data || !token2?.data) {
        return false;
      }

      const buffer1 = Buffer.from(token1.data, 'base64');
      const buffer2 = Buffer.from(token2.data, 'base64');
      
      if (buffer1.length !== buffer2.length) {
        return false;
      }

      return timingSafeEqual(buffer1, buffer2);

    } catch (error) {
      return false;
    }
  }
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Encrypt a string (convenience wrapper)
 */
export function encrypt(plaintext: string, userId?: string): string {
  const encrypted = TokenEncryptionService.encrypt(plaintext, userId);
  return JSON.stringify(encrypted);
}

/**
 * Decrypt a string (convenience wrapper)
 */
export function decrypt(encryptedData: string, userId?: string): string {
  try {
    const encrypted: EncryptedToken = JSON.parse(encryptedData);
    return TokenEncryptionService.decrypt(encrypted, userId);
  } catch (error) {
    throw new Error('Invalid encrypted data format');
  }
}

/**
 * Validate encrypted data string
 */
export function validateEncrypted(encryptedData: string): boolean {
  try {
    const encrypted: EncryptedToken = JSON.parse(encryptedData);
    return TokenEncryptionService.validate(encrypted);
  } catch (error) {
    return false;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export { TokenEncryptionService as TokenEncryption };