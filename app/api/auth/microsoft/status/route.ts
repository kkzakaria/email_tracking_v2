/**
 * Microsoft Account Status API
 * Email Tracking System - Account Status and Health Check
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This endpoint provides status information for Microsoft accounts
 * Includes connectivity tests, token validation, and rate limit status
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../[...nextauth]/route';
import { supabaseAdmin } from '@/lib/supabase';
import { tokenManager } from '@/lib/token-manager';
import { rateLimiter } from '@/lib/rate-limiter';
import { auditLogger, AuditEventType, AuditSeverity } from '@/lib/audit-logger';
import { createGraphClient } from '@/lib/microsoft-graph-client';
import { encryptionService } from '@/lib/encryption';

/**
 * GET /api/auth/microsoft/status
 * Get comprehensive status for Microsoft accounts
 */
export async function GET(request: NextRequest) {
  try {
    // Get current session
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('account_id');
    const includeTests = searchParams.get('include_tests') === 'true';
    const includeHealth = searchParams.get('include_health') === 'true';

    let accounts = [];

    if (accountId) {
      // Get specific account
      const { data: account, error } = await supabaseAdmin!
        .from('email_accounts')
        .select(`
          id,
          email_address,
          display_name,
          is_active,
          last_sync_at,
          created_at,
          updated_at,
          provider_user_id
        `)
        .eq('id', accountId)
        .eq('user_id', session.user.id)
        .eq('provider', 'microsoft')
        .single();

      if (error || !account) {
        return NextResponse.json(
          { error: 'Account not found', message: 'Microsoft account not found' },
          { status: 404 }
        );
      }

      accounts = [account];
    } else {
      // Get all user's Microsoft accounts
      const { data, error } = await supabaseAdmin!
        .from('email_accounts')
        .select(`
          id,
          email_address,
          display_name,
          is_active,
          last_sync_at,
          created_at,
          updated_at,
          provider_user_id
        `)
        .eq('user_id', session.user.id)
        .eq('provider', 'microsoft');

      if (error) {
        console.error('Failed to fetch Microsoft accounts:', error);
        return NextResponse.json(
          { error: 'Database error', message: 'Failed to fetch accounts' },
          { status: 500 }
        );
      }

      accounts = data || [];
    }

    // Get detailed status for each account
    const accountStatuses = await Promise.all(
      accounts.map(async (account) => {
        const status: Record<string, unknown> = {
          account_id: account.id,
          email_address: account.email_address,
          display_name: account.display_name,
          is_active: account.is_active,
          last_sync_at: account.last_sync_at,
          created_at: account.created_at,
          updated_at: account.updated_at,
        };

        try {
          // Check if tokens exist and are valid
          const tokens = await tokenManager.getValidTokens(account.id);
          status.has_valid_tokens = !!tokens;
          
          if (tokens) {
            status.token_expires_at = new Date(tokens.expires_at!).toISOString();
            status.token_expires_in_minutes = Math.floor((tokens.expires_at! - Date.now()) / (60 * 1000));
            status.scopes = tokens.scope?.split(' ') || [];
          }
        } catch (error) {
          console.warn(`Failed to check tokens for account ${account.id}:`, error);
          status.has_valid_tokens = false;
          status.token_error = error instanceof Error ? error.message : 'Unknown error';
        }

        try {
          // Get rate limit status
          const rateLimitStatus = await rateLimiter.getStatus(account.id);
          status.rate_limits = rateLimitStatus;
        } catch (error) {
          console.warn(`Failed to get rate limit status for account ${account.id}:`, error);
          status.rate_limits = null;
        }

        // Run connectivity tests if requested
        if (includeTests && status.has_valid_tokens) {
          try {
            const graphClient = createGraphClient(account.id);
            const connectivityTest = await graphClient.testConnectivity();
            status.connectivity_test = connectivityTest;
          } catch (error) {
            console.warn(`Connectivity test failed for account ${account.id}:`, error);
            status.connectivity_test = {
              success: false,
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date().toISOString(),
            };
          }
        }

        return status;
      })
    );

    // Include system health checks if requested
    let systemHealth = null;
    if (includeHealth) {
      try {
        systemHealth = {
          token_manager: await tokenManager.healthCheck(),
          rate_limiter: await rateLimiter.healthCheck(),
          encryption_service: await encryptionService.healthCheck(),
          audit_logger: await auditLogger.healthCheck(),
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        console.warn('System health check failed:', error);
        systemHealth = {
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        };
      }
    }

    // Log status check (only for specific account queries to avoid spam)
    if (accountId) {
      await auditLogger.logEvent({
        event_type: 'account_status_checked',
        user_id: session.user.id,
        account_id: accountId,
        severity: AuditSeverity.LOW,
        details: {
          provider: 'microsoft',
          include_tests: includeTests,
          include_health: includeHealth,
        },
      });
    }

    return NextResponse.json({
      accounts: accountStatuses,
      total: accountStatuses.length,
      system_health: systemHealth,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Microsoft status check failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/auth/microsoft/status',
        method: 'GET',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to get account status' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/auth/microsoft/status
 * Force refresh tokens and re-check status
 */
export async function POST(request: NextRequest) {
  try {
    // Get current session
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { account_id, force_refresh = false } = body;

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing parameter', message: 'account_id is required' },
        { status: 400 }
      );
    }

    // Verify account belongs to user
    const { data: account, error: accountError } = await supabaseAdmin!
      .from('email_accounts')
      .select('id, email_address, display_name')
      .eq('id', account_id)
      .eq('user_id', session.user.id)
      .eq('provider', 'microsoft')
      .single();

    if (accountError || !account) {
      return NextResponse.json(
        { error: 'Account not found', message: 'Microsoft account not found' },
        { status: 404 }
      );
    }

    let refreshResult = null;

    if (force_refresh) {
      try {
        // Get current tokens
        const currentTokens = await tokenManager.getTokens(account_id);
        
        if (!currentTokens?.refresh_token) {
          return NextResponse.json(
            { error: 'No refresh token', message: 'Cannot refresh tokens without refresh token' },
            { status: 400 }
          );
        }

        // Force token refresh
        const newTokens = await tokenManager.refreshTokens(account_id, currentTokens.refresh_token);
        
        refreshResult = {
          success: !!newTokens,
          expires_at: newTokens?.expires_at ? new Date(newTokens.expires_at).toISOString() : null,
          scopes: newTokens?.scope?.split(' ') || [],
        };

      } catch (error) {
        console.error('Token refresh failed:', error);
        refreshResult = {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }

    // Run connectivity test
    let connectivityTest = null;
    try {
      const graphClient = createGraphClient(account_id);
      connectivityTest = await graphClient.testConnectivity();
    } catch (error) {
      console.warn(`Connectivity test failed for account ${account_id}:`, error);
      connectivityTest = {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      };
    }

    // Get updated rate limit status
    let rateLimitStatus = null;
    try {
      rateLimitStatus = await rateLimiter.getStatus(account_id);
    } catch (error) {
      console.warn(`Failed to get rate limit status:`, error);
    }

    // Log status refresh
    await auditLogger.logEvent({
      event_type: 'account_status_refreshed',
      user_id: session.user.id,
      account_id: account_id,
      severity: AuditSeverity.MEDIUM,
      details: {
        provider: 'microsoft',
        force_refresh,
        refresh_success: refreshResult?.success,
        connectivity_success: connectivityTest?.success,
      },
    });

    return NextResponse.json({
      account_id,
      refresh_result: refreshResult,
      connectivity_test: connectivityTest,
      rate_limit_status: rateLimitStatus,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Microsoft status refresh failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/auth/microsoft/status',
        method: 'POST',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to refresh account status' },
      { status: 500 }
    );
  }
}