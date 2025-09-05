/**
 * NextAuth.js Configuration - Microsoft OAuth2 Provider
 * Email Tracking System - Authentication Handler
 * Created: 2025-09-05 for Microsoft OAuth2 Authentication
 * 
 * ⚠️ CRITICAL: This handler manages the complete OAuth2 flow with Microsoft
 * Integrates with token management, encryption, and audit logging
 */

import NextAuth from 'next-auth';
import { NextAuthOptions } from 'next-auth';
import { SupabaseAdapter } from '@next-auth/supabase-adapter';
import { tokenManager } from '@/lib/token-manager';
import { auditLogger, AuditEventType, AuditSeverity } from '@/lib/audit-logger';
import { supabase, supabaseAdmin, createUserProfile } from '@/lib/supabase';
import { 
  validateEnvironment,
  MicrosoftTokenResponseSchema,
  MicrosoftUserInfoSchema,
  createValidator 
} from '@/lib/validators';
import { MicrosoftUserInfo } from '@/lib/microsoft-graph-client';

// Validate environment on startup
const envValidation = validateEnvironment();
if (!envValidation.valid) {
  console.error('❌ Environment validation failed:', envValidation.errors);
  throw new Error('Invalid environment configuration for authentication');
}

/**
 * Microsoft OAuth2 Provider Configuration
 */
const microsoftProvider = {
  id: 'microsoft',
  name: 'Microsoft',
  type: 'oauth' as const,
  wellKnown: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid_configuration',
  authorization: {
    url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    params: {
      scope: process.env.MICROSOFT_SCOPES || 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/MailboxSettings.ReadWrite',
      response_type: 'code',
      response_mode: 'query',
      prompt: 'select_account',
    },
  },
  token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  userinfo: 'https://graph.microsoft.com/v1.0/me',
  clientId: process.env.MICROSOFT_CLIENT_ID,
  clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
  profile: async (profile: any) => {
    try {
      // Validate profile data
      const validator = createValidator(MicrosoftUserInfoSchema);
      const validationResult = validator(profile);
      
      if (!validationResult.success) {
        console.error('Invalid Microsoft profile data:', validationResult.errors);
        throw new Error(`Invalid profile data: ${validationResult.errors.join(', ')}`);
      }

      const userInfo = validationResult.data;

      return {
        id: userInfo.id,
        name: userInfo.displayName,
        email: userInfo.mail || userInfo.userPrincipalName,
        image: null, // Microsoft Graph doesn't provide avatar in basic profile
        microsoftId: userInfo.id,
        userPrincipalName: userInfo.userPrincipalName,
      };
    } catch (error) {
      console.error('Profile mapping failed:', error);
      throw error;
    }
  },
};

/**
 * NextAuth.js Configuration
 */
export const authOptions: NextAuthOptions = {
  providers: [microsoftProvider],
  
  adapter: SupabaseAdapter({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    secret: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  }),
  
  session: {
    strategy: 'jwt',
    maxAge: 24 * 60 * 60, // 24 hours
  },
  
  jwt: {
    maxAge: 24 * 60 * 60, // 24 hours
  },
  
  pages: {
    signIn: '/auth/signin',
    error: '/auth/error',
  },
  
  callbacks: {
    /**
     * JWT Callback - Handle token storage and refresh
     */
    async jwt({ token, user, account }) {
      try {
        // Initial sign in - store tokens
        if (account && user) {
          console.log('🔐 Storing OAuth tokens for user:', user.id);
          
          // Validate token response
          const tokenValidator = createValidator(MicrosoftTokenResponseSchema);
          const tokenValidation = tokenValidator({
            access_token: account.access_token!,
            token_type: account.token_type || 'Bearer',
            expires_in: account.expires_at ? Math.floor((account.expires_at * 1000 - Date.now()) / 1000) : 3600,
            refresh_token: account.refresh_token,
            scope: account.scope,
            id_token: account.id_token,
          });

          if (!tokenValidation.success) {
            console.error('Invalid token response:', tokenValidation.errors);
            throw new Error(`Invalid token data: ${tokenValidation.errors.join(', ')}`);
          }

          // Create or get email account
          let emailAccountId: string;
          
          try {
            // Check if email account exists
            const { data: existingAccount } = await supabaseAdmin!
              .from('email_accounts')
              .select('id')
              .eq('user_id', user.id)
              .eq('provider', 'microsoft')
              .eq('provider_user_id', token.microsoftId || user.id)
              .single();

            if (existingAccount) {
              emailAccountId = existingAccount.id;
            } else {
              // Create new email account
              const { data: newAccount, error: accountError } = await supabaseAdmin!
                .from('email_accounts')
                .insert({
                  user_id: user.id,
                  provider: 'microsoft',
                  email_address: user.email!,
                  display_name: user.name!,
                  provider_user_id: token.microsoftId || user.id,
                  is_active: true,
                })
                .select('id')
                .single();

              if (accountError || !newAccount) {
                throw new Error(`Failed to create email account: ${accountError?.message}`);
              }

              emailAccountId = newAccount.id;
              
              // Log account connection
              await auditLogger.logEvent({
                event_type: AuditEventType.ACCOUNT_CONNECTED,
                user_id: user.id,
                account_id: emailAccountId,
                severity: AuditSeverity.MEDIUM,
                details: {
                  provider: 'microsoft',
                  email_address: user.email,
                  scopes: account.scope?.split(' ') || [],
                },
              });
            }
          } catch (error) {
            console.error('Email account creation/retrieval failed:', error);
            throw error;
          }

          // Store encrypted tokens
          try {
            const tokenData = {
              access_token: account.access_token!,
              refresh_token: account.refresh_token,
              expires_at: account.expires_at ? account.expires_at * 1000 : Date.now() + 3600 * 1000,
              scope: account.scope,
              token_type: account.token_type || 'Bearer',
              id_token: account.id_token,
            };

            const userInfo: MicrosoftUserInfo = {
              id: token.microsoftId || user.id,
              displayName: user.name!,
              mail: user.email!,
              userPrincipalName: token.userPrincipalName || user.email!,
            };

            const storeResult = await tokenManager.storeTokens(emailAccountId, tokenData, userInfo);
            
            if (!storeResult.success) {
              throw new Error(`Token storage failed: ${storeResult.message}`);
            }

            // Add account info to token
            token.emailAccountId = emailAccountId;
            token.tokenStored = true;
            
            // Log successful authentication
            await auditLogger.logAuthSuccess(
              emailAccountId,
              'microsoft',
              account.scope?.split(' ') || [],
              {
                user_id: user.id,
                expires_at: new Date(storeResult.expires_at!).toISOString(),
              }
            );

          } catch (error) {
            console.error('Token storage failed:', error);
            
            // Log authentication failure
            await auditLogger.logAuthFailure(
              emailAccountId || null,
              'microsoft',
              error instanceof Error ? error.message : 'Token storage failed',
              {
                user_id: user.id,
              }
            );
            
            throw error;
          }
        }
        
        return token;
      } catch (error) {
        console.error('JWT callback failed:', error);
        
        // Log system error
        await auditLogger.logEvent({
          event_type: AuditEventType.OAUTH_FAILED,
          user_id: user?.id || null,
          severity: AuditSeverity.HIGH,
          details: {
            error: error instanceof Error ? error.message : 'JWT callback failed',
            provider: 'microsoft',
          },
        });
        
        throw error;
      }
    },

    /**
     * Session Callback - Customize session object
     */
    async session({ session, token }) {
      try {
        if (token) {
          session.user.id = token.sub!;
          session.user.microsoftId = token.microsoftId as string;
          session.user.emailAccountId = token.emailAccountId as string;
          session.user.tokenStored = token.tokenStored as boolean;
        }
        
        return session;
      } catch (error) {
        console.error('Session callback failed:', error);
        throw error;
      }
    },

    /**
     * Sign In Callback - Control sign in access
     */
    async signIn({ user, account, profile }) {
      try {
        if (!account || account.provider !== 'microsoft') {
          return false;
        }

        // Validate required scopes
        const requiredScopes = ['User.Read', 'Mail.Read'];
        const grantedScopes = account.scope?.split(' ') || [];
        const hasRequiredScopes = requiredScopes.every(scope => 
          grantedScopes.some(granted => granted.includes(scope))
        );

        if (!hasRequiredScopes) {
          console.error('Missing required scopes:', {
            required: requiredScopes,
            granted: grantedScopes,
          });
          
          await auditLogger.logAuthFailure(
            null,
            'microsoft',
            'Missing required scopes',
            {
              user_id: user.id,
              required_scopes: requiredScopes,
              granted_scopes: grantedScopes,
            }
          );
          
          return false;
        }

        // Create user profile if it doesn't exist
        try {
          await createUserProfile({
            id: user.id,
            email: user.email!,
            user_metadata: {
              full_name: user.name || undefined,
            },
          });
        } catch (profileError) {
          console.warn('User profile creation failed (may already exist):', profileError);
          // Don't fail sign in if profile creation fails
        }

        return true;
      } catch (error) {
        console.error('Sign in callback failed:', error);
        
        await auditLogger.logEvent({
          event_type: AuditEventType.OAUTH_FAILED,
          user_id: user?.id || null,
          severity: AuditSeverity.HIGH,
          details: {
            error: error instanceof Error ? error.message : 'Sign in callback failed',
            provider: 'microsoft',
          },
        });
        
        return false;
      }
    },
  },

  events: {
    /**
     * Sign In Event - Log successful sign in
     */
    async signIn({ user, account }) {
      if (account?.provider === 'microsoft') {
        console.log('✅ User signed in:', user.email);
        
        await auditLogger.logEvent({
          event_type: AuditEventType.OAUTH_SUCCESS,
          user_id: user.id,
          severity: AuditSeverity.MEDIUM,
          details: {
            provider: 'microsoft',
            email: user.email,
            scopes: account.scope?.split(' ') || [],
          },
        });
      }
    },

    /**
     * Sign Out Event - Log sign out
     */
    async signOut({ token }) {
      if (token?.sub) {
        console.log('👋 User signed out:', token.sub);
        
        await auditLogger.logEvent({
          event_type: 'user_signed_out',
          user_id: token.sub,
          severity: AuditSeverity.LOW,
          details: {
            provider: 'microsoft',
          },
        });
      }
    },
  },

  debug: process.env.NODE_ENV === 'development',
};

// Create NextAuth handler
const handler = NextAuth(authOptions);

// Export for App Router
export { handler as GET, handler as POST };

// Export auth options for use in other files
export { authOptions };