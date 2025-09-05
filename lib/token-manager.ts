/**
 * Token Manager Service - Secure Microsoft OAuth2 Token Management
 * Email Tracking System - Critical Security Infrastructure
 * Created: 2025-09-05 for Microsoft OAuth2 Authentication
 * 
 * ⚠️ CRITICAL: This service manages the lifecycle of Microsoft OAuth2 tokens
 * Integrates with encryption service and Supabase for secure storage
 */

import { supabaseAdmin, supabase } from './supabase';
import { encryptionService, MicrosoftTokens, EncryptedTokens } from './encryption';
import { auditLogger } from './audit-logger';

// Token refresh threshold (refresh if expires within 5 minutes)
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Token Manager Service Class
 * Handles secure storage, retrieval, and refresh of Microsoft OAuth2 tokens
 */
export class TokenManager {
  private isEnabled: boolean;

  constructor() {
    this.isEnabled = !!supabaseAdmin;
    
    if (!this.isEnabled) {
      console.warn('⚠️  Token manager disabled: Supabase admin client not available');
    }
  }

  /**
   * Store Microsoft OAuth2 tokens securely
   * @param accountId - The email account ID
   * @param tokens - Microsoft OAuth2 tokens
   * @param userInfo - User information from Microsoft Graph
   * @returns Promise<TokenStoreResult> - Result of token storage
   */
  async storeTokens(
    accountId: string,
    tokens: MicrosoftTokens,
    userInfo?: MicrosoftUserInfo
  ): Promise<TokenStoreResult> {
    try {
      if (!this.isEnabled) {
        throw new Error('Token manager is disabled');
      }

      // Calculate expiration timestamp if not provided
      const expiresAt = tokens.expires_at || (Date.now() + 3600 * 1000); // Default 1 hour
      const tokensWithExpiry: MicrosoftTokens = { ...tokens, expires_at: expiresAt };

      // Encrypt tokens
      const encryptedTokens = await encryptionService.encryptTokens(tokensWithExpiry, accountId);

      // Store in database
      const { data, error } = await supabaseAdmin!
        .from('encrypted_tokens')
        .upsert({
          account_id: accountId,
          token_type: 'microsoft_oauth2',
          encrypted_data: encryptedTokens,
          expires_at: new Date(expiresAt).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (error) throw error;

      // Update account information if user info provided
      if (userInfo) {
        await this.updateAccountInfo(accountId, userInfo);
      }

      // Log successful token storage
      await auditLogger.logEvent({
        event_type: 'token_stored',
        account_id: accountId,
        details: {
          token_type: 'microsoft_oauth2',
          expires_at: new Date(expiresAt).toISOString(),
          has_refresh_token: !!tokens.refresh_token,
          scopes: tokens.scope?.split(' ') || [],
        },
      });

      return {
        success: true,
        account_id: accountId,
        expires_at: expiresAt,
        message: 'Tokens stored successfully',
      };

    } catch (error) {
      console.error('Token storage failed:', error);
      
      // Log token storage failure
      await auditLogger.logEvent({
        event_type: 'token_storage_failed',
        account_id: accountId,
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
          token_type: 'microsoft_oauth2',
        },
      });

      return {
        success: false,
        account_id: accountId,
        expires_at: null,
        message: error instanceof Error ? error.message : 'Token storage failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Retrieve and decrypt Microsoft OAuth2 tokens
   * @param accountId - The email account ID
   * @returns Promise<MicrosoftTokens | null> - Decrypted tokens or null if not found
   */
  async getTokens(accountId: string): Promise<MicrosoftTokens | null> {
    try {
      if (!this.isEnabled) {
        return null;
      }

      // Retrieve encrypted tokens from database
      const { data, error } = await supabaseAdmin!
        .from('encrypted_tokens')
        .select('*')
        .eq('account_id', accountId)
        .eq('token_type', 'microsoft_oauth2')
        .single();

      if (error || !data) {
        return null;
      }

      // Check if tokens are expired
      const expiresAt = new Date(data.expires_at).getTime();
      const now = Date.now();

      if (expiresAt <= now) {
        console.warn(`Tokens expired for account ${accountId}`);
        return null;
      }

      // Decrypt tokens
      const tokens = await encryptionService.decryptTokens(data.encrypted_data as EncryptedTokens);

      // Log token retrieval
      await auditLogger.logEvent({
        event_type: 'token_retrieved',
        account_id: accountId,
        details: {
          token_type: 'microsoft_oauth2',
          expires_at: new Date(expiresAt).toISOString(),
          expires_in_minutes: Math.floor((expiresAt - now) / (60 * 1000)),
        },
      });

      return tokens;

    } catch (error) {
      console.error('Token retrieval failed:', error);
      
      // Log token retrieval failure
      await auditLogger.logEvent({
        event_type: 'token_retrieval_failed',
        account_id: accountId,
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
          token_type: 'microsoft_oauth2',
        },
      });

      return null;
    }
  }

  /**
   * Get tokens and refresh if needed
   * @param accountId - The email account ID
   * @returns Promise<MicrosoftTokens | null> - Fresh tokens or null if refresh failed
   */
  async getValidTokens(accountId: string): Promise<MicrosoftTokens | null> {
    try {
      const tokens = await this.getTokens(accountId);
      
      if (!tokens) {
        return null;
      }

      // Check if tokens need refresh
      const expiresAt = tokens.expires_at || 0;
      const needsRefresh = (expiresAt - Date.now()) < REFRESH_THRESHOLD_MS;

      if (needsRefresh && tokens.refresh_token) {
        console.log(`Refreshing tokens for account ${accountId}`);
        return await this.refreshTokens(accountId, tokens.refresh_token);
      }

      return tokens;

    } catch (error) {
      console.error('Failed to get valid tokens:', error);
      return null;
    }
  }

  /**
   * Refresh Microsoft OAuth2 tokens
   * @param accountId - The email account ID
   * @param refreshToken - The refresh token
   * @returns Promise<MicrosoftTokens | null> - New tokens or null if refresh failed
   */
  async refreshTokens(accountId: string, refreshToken: string): Promise<MicrosoftTokens | null> {
    try {
      const clientId = process.env.MICROSOFT_CLIENT_ID;
      const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

      if (!clientId || !clientSecret) {
        throw new Error('Microsoft OAuth2 credentials not configured');
      }

      // Refresh tokens with Microsoft
      const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          scope: process.env.MICROSOFT_SCOPES || 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read',
        }),
      });

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.text();
        throw new Error(`Token refresh failed: ${tokenResponse.status} ${errorData}`);
      }

      const tokenData = await tokenResponse.json();
      
      // Convert to our token format
      const newTokens: MicrosoftTokens = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || refreshToken, // Keep old refresh token if new one not provided
        expires_at: Date.now() + (tokenData.expires_in * 1000),
        scope: tokenData.scope,
        token_type: tokenData.token_type || 'Bearer',
      };

      // Store the refreshed tokens
      const storeResult = await this.storeTokens(accountId, newTokens);
      
      if (storeResult.success) {
        // Log successful token refresh
        await auditLogger.logEvent({
          event_type: 'token_refreshed',
          account_id: accountId,
          details: {
            token_type: 'microsoft_oauth2',
            expires_at: new Date(newTokens.expires_at!).toISOString(),
            scopes: newTokens.scope?.split(' ') || [],
          },
        });

        return newTokens;
      } else {
        throw new Error(storeResult.message);
      }

    } catch (error) {
      console.error('Token refresh failed:', error);
      
      // Log token refresh failure
      await auditLogger.logEvent({
        event_type: 'token_refresh_failed',
        account_id: accountId,
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
          token_type: 'microsoft_oauth2',
        },
      });

      return null;
    }
  }

  /**
   * Revoke and delete Microsoft OAuth2 tokens
   * @param accountId - The email account ID
   * @returns Promise<boolean> - Whether revocation was successful
   */
  async revokeTokens(accountId: string): Promise<boolean> {
    try {
      if (!this.isEnabled) {
        return false;
      }

      // Get current tokens
      const tokens = await this.getTokens(accountId);
      
      if (tokens) {
        // Attempt to revoke tokens with Microsoft
        try {
          await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/logout', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              token: tokens.access_token,
              token_type_hint: 'access_token',
            }),
          });
        } catch (revokeError) {
          console.warn('Failed to revoke tokens with Microsoft:', revokeError);
          // Continue with local deletion even if revocation fails
        }
      }

      // Delete tokens from database
      const { error } = await supabaseAdmin!
        .from('encrypted_tokens')
        .delete()
        .eq('account_id', accountId)
        .eq('token_type', 'microsoft_oauth2');

      if (error) throw error;

      // Log token revocation
      await auditLogger.logEvent({
        event_type: 'token_revoked',
        account_id: accountId,
        details: {
          token_type: 'microsoft_oauth2',
          had_tokens: !!tokens,
        },
      });

      return true;

    } catch (error) {
      console.error('Token revocation failed:', error);
      
      // Log token revocation failure
      await auditLogger.logEvent({
        event_type: 'token_revocation_failed',
        account_id: accountId,
        details: {
          error: error instanceof Error ? error.message : 'Unknown error',
          token_type: 'microsoft_oauth2',
        },
      });

      return false;
    }
  }

  /**
   * Update account information with user data from Microsoft
   * @param accountId - The email account ID
   * @param userInfo - Microsoft user information
   */
  private async updateAccountInfo(accountId: string, userInfo: MicrosoftUserInfo): Promise<void> {
    try {
      const { error } = await supabaseAdmin!
        .from('email_accounts')
        .update({
          display_name: userInfo.displayName,
          email_address: userInfo.mail || userInfo.userPrincipalName,
          provider_user_id: userInfo.id,
          last_sync_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId);

      if (error) {
        console.error('Failed to update account info:', error);
      }
    } catch (error) {
      console.error('Account info update failed:', error);
    }
  }

  /**
   * Health check for token manager
   * @returns Promise<TokenManagerHealthCheck> - Service health status
   */
  async healthCheck(): Promise<TokenManagerHealthCheck> {
    try {
      if (!this.isEnabled) {
        return {
          healthy: false,
          message: 'Token manager disabled - Supabase admin client not available',
          timestamp: new Date().toISOString(),
        };
      }

      // Test database connectivity
      const { error } = await supabaseAdmin!
        .from('encrypted_tokens')
        .select('account_id')
        .limit(1);

      if (error) {
        throw new Error(`Database connectivity failed: ${error.message}`);
      }

      // Test encryption service
      const encryptionHealth = await encryptionService.healthCheck();
      if (!encryptionHealth.healthy) {
        throw new Error(`Encryption service unhealthy: ${encryptionHealth.message}`);
      }

      return {
        healthy: true,
        message: 'Token manager functioning correctly',
        timestamp: new Date().toISOString(),
        encryption_healthy: encryptionHealth.healthy,
        database_connected: true,
      };

    } catch (error) {
      return {
        healthy: false,
        message: `Token manager health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface TokenStoreResult {
  success: boolean;
  account_id: string;
  expires_at: number | null;
  message: string;
  error?: string;
}

export interface MicrosoftUserInfo {
  id: string;
  displayName: string;
  mail?: string;
  userPrincipalName: string;
  jobTitle?: string;
  officeLocation?: string;
  mobilePhone?: string;
  businessPhones?: string[];
}

export interface TokenManagerHealthCheck {
  healthy: boolean;
  message: string;
  timestamp: string;
  encryption_healthy?: boolean;
  database_connected?: boolean;
  error?: string;
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

// Export singleton instance for use throughout the application
export const tokenManager = new TokenManager();

// Export default for convenience
export default tokenManager;