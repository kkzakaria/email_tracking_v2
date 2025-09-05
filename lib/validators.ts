/**
 * Validation Schemas - Zod-based Input Validation
 * Email Tracking System - Critical Security Infrastructure  
 * Created: 2025-09-05 for Microsoft OAuth2 Authentication
 * 
 * ⚠️ CRITICAL: This service validates all inputs for security and data integrity
 * Uses Zod for comprehensive type-safe validation
 */

import { z } from 'zod';

// Add zod dependency if not already present
const isZodAvailable = (() => {
  try {
    return !!z;
  } catch {
    return false;
  }
})();

if (!isZodAvailable) {
  console.error('⚠️ Zod dependency missing. Please install: pnpm add zod');
}

// ============================================================================
// MICROSOFT OAUTH2 VALIDATION SCHEMAS
// ============================================================================

/**
 * Microsoft OAuth2 Authorization URL Parameters
 */
export const MicrosoftAuthParamsSchema = z.object({
  client_id: z.string().uuid('Invalid Microsoft client ID format'),
  response_type: z.literal('code'),
  redirect_uri: z.string().url('Invalid redirect URI format'),
  scope: z.string().min(1, 'Scope is required'),
  state: z.string().min(16, 'State must be at least 16 characters'),
  response_mode: z.enum(['query', 'fragment']).optional(),
  prompt: z.enum(['none', 'login', 'consent', 'select_account']).optional(),
});

/**
 * Microsoft OAuth2 Token Exchange Request
 */
export const MicrosoftTokenExchangeSchema = z.object({
  grant_type: z.literal('authorization_code'),
  client_id: z.string().uuid('Invalid client ID format'),
  client_secret: z.string().min(1, 'Client secret is required'),
  code: z.string().min(1, 'Authorization code is required'),
  redirect_uri: z.string().url('Invalid redirect URI'),
  scope: z.string().optional(),
});

/**
 * Microsoft OAuth2 Token Refresh Request
 */
export const MicrosoftTokenRefreshSchema = z.object({
  grant_type: z.literal('refresh_token'),
  client_id: z.string().uuid('Invalid client ID format'),
  client_secret: z.string().min(1, 'Client secret is required'),
  refresh_token: z.string().min(1, 'Refresh token is required'),
  scope: z.string().optional(),
});

/**
 * Microsoft OAuth2 Token Response
 */
export const MicrosoftTokenResponseSchema = z.object({
  access_token: z.string().min(1, 'Access token is required'),
  token_type: z.string().default('Bearer'),
  expires_in: z.number().positive('Token expiry must be positive'),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

/**
 * Microsoft Graph User Information
 */
export const MicrosoftUserInfoSchema = z.object({
  id: z.string().min(1, 'User ID is required'),
  displayName: z.string().min(1, 'Display name is required'),
  mail: z.string().email('Invalid email format').nullable(),
  userPrincipalName: z.string().email('Invalid UPN format'),
  jobTitle: z.string().nullable().optional(),
  officeLocation: z.string().nullable().optional(),
  mobilePhone: z.string().nullable().optional(),
  businessPhones: z.array(z.string()).optional(),
  preferredLanguage: z.string().optional(),
  surname: z.string().optional(),
  givenName: z.string().optional(),
});

// ============================================================================
// EMAIL ACCOUNT VALIDATION SCHEMAS
// ============================================================================

/**
 * Email Account Creation
 */
export const EmailAccountCreateSchema = z.object({
  user_id: z.string().uuid('Invalid user ID format'),
  provider: z.literal('microsoft'),
  email_address: z.string().email('Invalid email address'),
  display_name: z.string().min(1, 'Display name is required'),
  provider_user_id: z.string().min(1, 'Provider user ID is required'),
  settings: z.object({
    auto_track: z.boolean().default(true),
    track_replies: z.boolean().default(true),
    notification_enabled: z.boolean().default(true),
  }).optional(),
});

/**
 * Email Account Update
 */
export const EmailAccountUpdateSchema = z.object({
  display_name: z.string().min(1, 'Display name is required').optional(),
  settings: z.object({
    auto_track: z.boolean(),
    track_replies: z.boolean(),
    notification_enabled: z.boolean(),
  }).partial().optional(),
  is_active: z.boolean().optional(),
});

// ============================================================================
// API REQUEST VALIDATION SCHEMAS
// ============================================================================

/**
 * Microsoft Graph API Call Parameters
 */
export const GraphAPICallSchema = z.object({
  account_id: z.string().uuid('Invalid account ID'),
  endpoint: z.string().min(1, 'Endpoint is required'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  headers: z.record(z.string()).optional(),
  body: z.unknown().optional(),
});

/**
 * Rate Limit Check Request
 */
export const RateLimitCheckSchema = z.object({
  account_id: z.string().uuid('Invalid account ID'),
  operation_type: z.enum(['email_read', 'webhook_create', 'bulk_operation']),
});

/**
 * Pagination Parameters
 */
export const PaginationSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// ============================================================================
// SECURITY VALIDATION SCHEMAS
// ============================================================================

/**
 * Encryption Data Validation
 */
export const EncryptedDataSchema = z.object({
  encrypted: z.string().min(1, 'Encrypted data is required'),
  iv: z.string().min(1, 'IV is required'),
  tag: z.string().min(1, 'Authentication tag is required'),
  salt: z.string().min(1, 'Salt is required'),
  algorithm: z.literal('aes-256-gcm'),
  timestamp: z.number().positive('Timestamp must be positive'),
});

/**
 * JWT Token Validation
 */
export const JWTTokenSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/, 'Invalid JWT format'),
});

/**
 * Session Validation
 */
export const SessionSchema = z.object({
  user_id: z.string().uuid('Invalid user ID'),
  session_id: z.string().min(16, 'Session ID must be at least 16 characters'),
  expires_at: z.string().datetime('Invalid expiration date format'),
});

// ============================================================================
// ENVIRONMENT VALIDATION SCHEMAS
// ============================================================================

/**
 * Microsoft OAuth2 Environment Variables
 */
export const MicrosoftEnvSchema = z.object({
  MICROSOFT_CLIENT_ID: z.string().uuid('Invalid Microsoft Client ID format'),
  MICROSOFT_CLIENT_SECRET: z.string().min(32, 'Microsoft Client Secret must be at least 32 characters'),
  MICROSOFT_TENANT_ID: z.string().default('common'),
  MICROSOFT_SCOPES: z.string().min(1, 'Microsoft Scopes are required'),
  MICROSOFT_REDIRECT_URI: z.string().url('Invalid Microsoft Redirect URI'),
});

/**
 * NextAuth Environment Variables
 */
export const NextAuthEnvSchema = z.object({
  NEXTAUTH_URL: z.string().url('Invalid NextAuth URL'),
  NEXTAUTH_SECRET: z.string().min(32, 'NextAuth Secret must be at least 32 characters'),
});

/**
 * Encryption Environment Variables
 */
export const EncryptionEnvSchema = z.object({
  ENCRYPTION_KEY: z.string().min(32, 'Encryption Key must be at least 32 characters'),
  JWT_SECRET: z.string().min(32, 'JWT Secret must be at least 32 characters'),
});

// ============================================================================
// UTILITY VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate Microsoft OAuth2 scopes
 */
export const validateMicrosoftScopes = (scopes: string): boolean => {
  const requiredScopes = [
    'https://graph.microsoft.com/User.Read',
    'https://graph.microsoft.com/Mail.Read',
  ];

  const providedScopes = scopes.split(' ').map(s => s.trim());
  return requiredScopes.every(required => providedScopes.includes(required));
};

/**
 * Validate email address format
 */
export const isValidEmail = (email: string): boolean => {
  return z.string().email().safeParse(email).success;
};

/**
 * Validate UUID format
 */
export const isValidUUID = (uuid: string): boolean => {
  return z.string().uuid().safeParse(uuid).success;
};

/**
 * Validate URL format
 */
export const isValidURL = (url: string): boolean => {
  return z.string().url().safeParse(url).success;
};

/**
 * Sanitize string input (remove potentially dangerous characters)
 */
export const sanitizeString = (input: string, maxLength = 1000): string => {
  return input
    .replace(/[<>\"'&]/g, '') // Remove HTML/script injection characters
    .trim()
    .substring(0, maxLength);
};

/**
 * Validate and sanitize redirect URI
 */
export const validateRedirectURI = (uri: string, allowedDomains?: string[]): boolean => {
  try {
    const url = new URL(uri);
    
    // Must be HTTPS in production
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
      return false;
    }
    
    // Check allowed domains if specified
    if (allowedDomains && allowedDomains.length > 0) {
      return allowedDomains.includes(url.hostname);
    }
    
    return true;
  } catch {
    return false;
  }
};

// ============================================================================
// VALIDATION MIDDLEWARE HELPERS
// ============================================================================

/**
 * Create validation middleware for API routes
 */
export const createValidator = <T>(schema: z.ZodSchema<T>) => {
  return (data: unknown): { success: true; data: T } | { success: false; errors: string[] } => {
    try {
      const result = schema.safeParse(data);
      
      if (result.success) {
        return { success: true, data: result.data };
      } else {
        const errors = result.error.errors.map(err => 
          `${err.path.join('.')}: ${err.message}`
        );
        return { success: false, errors };
      }
    } catch (error) {
      return { 
        success: false, 
        errors: [`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`] 
      };
    }
  };
};

/**
 * Validate environment variables on startup
 */
export const validateEnvironment = (): { valid: boolean; errors: string[] } => {
  const errors: string[] = [];

  try {
    // Validate Microsoft OAuth2 configuration
    const microsoftEnv = {
      MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
      MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
      MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
      MICROSOFT_SCOPES: process.env.MICROSOFT_SCOPES,
      MICROSOFT_REDIRECT_URI: process.env.MICROSOFT_REDIRECT_URI,
    };

    const microsoftResult = MicrosoftEnvSchema.safeParse(microsoftEnv);
    if (!microsoftResult.success) {
      errors.push(...microsoftResult.error.errors.map(err => 
        `Microsoft Config - ${err.path.join('.')}: ${err.message}`
      ));
    }

    // Validate NextAuth configuration
    const nextAuthEnv = {
      NEXTAUTH_URL: process.env.NEXTAUTH_URL,
      NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
    };

    const nextAuthResult = NextAuthEnvSchema.safeParse(nextAuthEnv);
    if (!nextAuthResult.success) {
      errors.push(...nextAuthResult.error.errors.map(err => 
        `NextAuth Config - ${err.path.join('.')}: ${err.message}`
      ));
    }

    // Validate encryption configuration
    const encryptionEnv = {
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      JWT_SECRET: process.env.JWT_SECRET,
    };

    const encryptionResult = EncryptionEnvSchema.safeParse(encryptionEnv);
    if (!encryptionResult.success) {
      errors.push(...encryptionResult.error.errors.map(err => 
        `Encryption Config - ${err.path.join('.')}: ${err.message}`
      ));
    }

    return { valid: errors.length === 0, errors };

  } catch (error) {
    errors.push(`Environment validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return { valid: false, errors };
  }
};

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type MicrosoftAuthParams = z.infer<typeof MicrosoftAuthParamsSchema>;
export type MicrosoftTokenExchange = z.infer<typeof MicrosoftTokenExchangeSchema>;
export type MicrosoftTokenRefresh = z.infer<typeof MicrosoftTokenRefreshSchema>;
export type MicrosoftTokenResponse = z.infer<typeof MicrosoftTokenResponseSchema>;
export type MicrosoftUserInfo = z.infer<typeof MicrosoftUserInfoSchema>;
export type EmailAccountCreate = z.infer<typeof EmailAccountCreateSchema>;
export type EmailAccountUpdate = z.infer<typeof EmailAccountUpdateSchema>;
export type GraphAPICall = z.infer<typeof GraphAPICallSchema>;
export type RateLimitCheck = z.infer<typeof RateLimitCheckSchema>;
export type PaginationParams = z.infer<typeof PaginationSchema>;
export type EncryptedData = z.infer<typeof EncryptedDataSchema>;
export type JWTToken = z.infer<typeof JWTTokenSchema>;
export type SessionData = z.infer<typeof SessionSchema>;
export type MicrosoftEnv = z.infer<typeof MicrosoftEnvSchema>;
export type NextAuthEnv = z.infer<typeof NextAuthEnvSchema>;
export type EncryptionEnv = z.infer<typeof EncryptionEnvSchema>;

// ============================================================================
// SCHEMA EXPORTS
// ============================================================================

export {
  MicrosoftAuthParamsSchema,
  MicrosoftTokenExchangeSchema,
  MicrosoftTokenRefreshSchema,
  MicrosoftTokenResponseSchema,
  MicrosoftUserInfoSchema,
  EmailAccountCreateSchema,
  EmailAccountUpdateSchema,
  GraphAPICallSchema,
  RateLimitCheckSchema,
  PaginationSchema,
  EncryptedDataSchema,
  JWTTokenSchema,
  SessionSchema,
  MicrosoftEnvSchema,
  NextAuthEnvSchema,
  EncryptionEnvSchema,
};