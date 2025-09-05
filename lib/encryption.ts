/**
 * Encryption Service - AES-256-GCM Implementation
 * Email Tracking System - Critical Security Infrastructure
 * Created: 2025-09-05 for Microsoft OAuth2 Authentication
 * 
 * ⚠️ CRITICAL: This service handles encryption of sensitive Microsoft OAuth2 tokens
 * Uses AES-256-GCM for authenticated encryption with associated data (AEAD)
 */

import { randomBytes, createCipherGCM, createDecipherGCM } from 'crypto';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const TAG_LENGTH = 16; // 128 bits
const SALT_LENGTH = 32; // 256 bits

/**
 * Encryption Service Class
 * Handles all cryptographic operations for sensitive data
 */
export class EncryptionService {
  private encryptionKey: Buffer;

  constructor() {
    const key = process.env.ENCRYPTION_KEY;
    
    if (!key) {
      throw new Error('ENCRYPTION_KEY environment variable is required');
    }

    if (key.length < 32) {
      throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
    }

    // Derive encryption key from environment variable
    this.encryptionKey = Buffer.from(key.padEnd(32, '0').substring(0, 32), 'utf8');
  }

  /**
   * Encrypt sensitive data with AES-256-GCM
   * @param data - The plaintext data to encrypt
   * @param associatedData - Optional associated data for AEAD (e.g., user ID)
   * @returns Promise<EncryptedData> - Encrypted data with metadata
   */
  async encrypt(data: string, associatedData?: string): Promise<EncryptedData> {
    try {
      // Generate random IV and salt
      const iv = randomBytes(IV_LENGTH);
      const salt = randomBytes(SALT_LENGTH);

      // Create cipher
      const cipher = createCipherGCM(ALGORITHM, this.encryptionKey);
      cipher.setIV(iv);

      // Add associated data if provided (for AEAD)
      if (associatedData) {
        cipher.setAAD(Buffer.from(associatedData, 'utf8'));
      }

      // Encrypt the data
      let encrypted = cipher.update(data, 'utf8');
      encrypted = Buffer.concat([encrypted, cipher.final()]);

      // Get the authentication tag
      const tag = cipher.getAuthTag();

      // Return encrypted data with metadata
      return {
        encrypted: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        salt: salt.toString('base64'),
        algorithm: ALGORITHM,
        timestamp: Date.now(),
      };

    } catch (error) {
      console.error('Encryption failed:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt data encrypted with AES-256-GCM
   * @param encryptedData - The encrypted data object
   * @param associatedData - Optional associated data for AEAD verification
   * @returns Promise<string> - The decrypted plaintext
   */
  async decrypt(encryptedData: EncryptedData, associatedData?: string): Promise<string> {
    try {
      // Validate encrypted data structure
      if (!encryptedData.encrypted || !encryptedData.iv || !encryptedData.tag) {
        throw new Error('Invalid encrypted data format');
      }

      if (encryptedData.algorithm !== ALGORITHM) {
        throw new Error(`Unsupported encryption algorithm: ${encryptedData.algorithm}`);
      }

      // Convert from base64
      const encrypted = Buffer.from(encryptedData.encrypted, 'base64');
      const iv = Buffer.from(encryptedData.iv, 'base64');
      const tag = Buffer.from(encryptedData.tag, 'base64');

      // Create decipher
      const decipher = createDecipherGCM(ALGORITHM, this.encryptionKey);
      decipher.setIV(iv);
      decipher.setAuthTag(tag);

      // Add associated data if provided (for AEAD verification)
      if (associatedData) {
        decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      }

      // Decrypt the data
      let decrypted = decipher.update(encrypted);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString('utf8');

    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  /**
   * Encrypt Microsoft OAuth2 tokens specifically
   * @param tokens - Microsoft OAuth2 token response
   * @param accountId - Account ID for associated data
   * @returns Promise<EncryptedTokens> - Encrypted token data
   */
  async encryptTokens(tokens: MicrosoftTokens, accountId: string): Promise<EncryptedTokens> {
    try {
      const tokenData = JSON.stringify(tokens);
      const encrypted = await this.encrypt(tokenData, accountId);
      
      return {
        ...encrypted,
        account_id: accountId,
        token_type: 'microsoft_oauth2',
        expires_at: tokens.expires_at || null,
      };

    } catch (error) {
      console.error('Token encryption failed:', error);
      throw new Error('Failed to encrypt Microsoft tokens');
    }
  }

  /**
   * Decrypt Microsoft OAuth2 tokens specifically
   * @param encryptedTokens - Encrypted token data
   * @returns Promise<MicrosoftTokens> - Decrypted Microsoft tokens
   */
  async decryptTokens(encryptedTokens: EncryptedTokens): Promise<MicrosoftTokens> {
    try {
      if (encryptedTokens.token_type !== 'microsoft_oauth2') {
        throw new Error(`Invalid token type: ${encryptedTokens.token_type}`);
      }

      const decryptedData = await this.decrypt(encryptedTokens, encryptedTokens.account_id);
      return JSON.parse(decryptedData) as MicrosoftTokens;

    } catch (error) {
      console.error('Token decryption failed:', error);
      throw new Error('Failed to decrypt Microsoft tokens');
    }
  }

  /**
   * Check if encrypted data is valid and not corrupted
   * @param encryptedData - The encrypted data to validate
   * @returns boolean - Whether the data appears valid
   */
  validateEncryptedData(encryptedData: EncryptedData): boolean {
    try {
      return !!(
        encryptedData.encrypted &&
        encryptedData.iv &&
        encryptedData.tag &&
        encryptedData.algorithm === ALGORITHM &&
        encryptedData.timestamp &&
        typeof encryptedData.timestamp === 'number'
      );
    } catch {
      return false;
    }
  }

  /**
   * Generate secure random string for secrets
   * @param length - Length of the random string
   * @returns string - Cryptographically secure random string
   */
  generateSecureRandom(length = 32): string {
    return randomBytes(Math.ceil(length / 2))
      .toString('hex')
      .substring(0, length);
  }

  /**
   * Health check for encryption service
   * @returns Promise<EncryptionHealthCheck> - Service health status
   */
  async healthCheck(): Promise<EncryptionHealthCheck> {
    try {
      // Test encryption/decryption cycle
      const testData = 'test-encryption-health-check';
      const testAssociatedData = 'health-check';
      
      const encrypted = await this.encrypt(testData, testAssociatedData);
      const decrypted = await this.decrypt(encrypted, testAssociatedData);
      
      if (decrypted !== testData) {
        throw new Error('Encryption/decryption cycle failed');
      }

      return {
        healthy: true,
        message: 'Encryption service functioning correctly',
        timestamp: new Date().toISOString(),
        algorithm: ALGORITHM,
        key_length: this.encryptionKey.length * 8, // bits
      };

    } catch (error) {
      return {
        healthy: false,
        message: `Encryption service health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface EncryptedData {
  encrypted: string;      // Base64 encoded encrypted data
  iv: string;            // Base64 encoded initialization vector
  tag: string;           // Base64 encoded authentication tag
  salt: string;          // Base64 encoded salt
  algorithm: string;     // Encryption algorithm used
  timestamp: number;     // Encryption timestamp
}

export interface EncryptedTokens extends EncryptedData {
  account_id: string;    // Account ID for associated data
  token_type: string;    // Type of token (e.g., 'microsoft_oauth2')
  expires_at: number | null; // Token expiration timestamp
}

export interface MicrosoftTokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  token_type: string;
  id_token?: string;
}

export interface EncryptionHealthCheck {
  healthy: boolean;
  message: string;
  timestamp: string;
  algorithm?: string;
  key_length?: number;
  error?: string;
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

// Export singleton instance for use throughout the application
export const encryptionService = new EncryptionService();

// Export default for convenience
export default encryptionService;