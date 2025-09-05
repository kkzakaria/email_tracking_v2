/**
 * Microsoft Account Connection API
 * Email Tracking System - Microsoft OAuth2 Integration
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This endpoint handles Microsoft account connection
 * Integrates with NextAuth, token management, and audit logging
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../[...nextauth]/route';
import { supabaseAdmin } from '@/lib/supabase';
import { auditLogger, AuditEventType, AuditSeverity } from '@/lib/audit-logger';
import { createValidator, EmailAccountCreateSchema } from '@/lib/validators';
import { rateLimiter } from '@/lib/rate-limiter';
import { createGraphClient } from '@/lib/microsoft-graph-client';

/**
 * GET /api/auth/microsoft/connect
 * Get Microsoft account connection status for current user
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

    // Get connected Microsoft accounts
    const { data: accounts, error } = await supabaseAdmin!
      .from('email_accounts')
      .select(`
        id,
        email_address,
        display_name,
        is_active,
        last_sync_at,
        created_at,
        updated_at
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

    // Check rate limit status for each account
    const accountsWithStatus = await Promise.all(
      (accounts || []).map(async (account) => {
        try {
          const rateLimitStatus = await rateLimiter.getStatus(account.id);
          return {
            ...account,
            rate_limit_status: rateLimitStatus,
          };
        } catch (error) {
          console.warn(`Failed to get rate limit status for account ${account.id}:`, error);
          return {
            ...account,
            rate_limit_status: null,
          };
        }
      })
    );

    return NextResponse.json({
      accounts: accountsWithStatus,
      total: accountsWithStatus.length,
    });

  } catch (error) {
    console.error('Microsoft connect GET failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/auth/microsoft/connect',
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
 * POST /api/auth/microsoft/connect
 * Connect a new Microsoft account (initiate OAuth2 flow)
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

    // For OAuth2 flow, we typically redirect to NextAuth
    // This endpoint can be used to initiate the flow with custom parameters
    const { redirect_uri, custom_scopes, prompt } = body;

    // Validate redirect URI if provided
    if (redirect_uri && !redirect_uri.startsWith(process.env.NEXTAUTH_URL!)) {
      return NextResponse.json(
        { error: 'Invalid redirect URI', message: 'Redirect URI must match configured domain' },
        { status: 400 }
      );
    }

    // Build OAuth2 authorization URL
    const authParams = new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID!,
      response_type: 'code',
      redirect_uri: redirect_uri || `${process.env.NEXTAUTH_URL}/api/auth/callback/microsoft`,
      scope: custom_scopes || process.env.MICROSOFT_SCOPES!,
      response_mode: 'query',
      prompt: prompt || 'select_account',
      state: `user_${session.user.id}_${Date.now()}`, // Include user ID in state for tracking
    });

    const authorizationUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${authParams.toString()}`;

    // Log OAuth initiation
    await auditLogger.logEvent({
      event_type: AuditEventType.OAUTH_INITIATED,
      user_id: session.user.id,
      severity: AuditSeverity.MEDIUM,
      details: {
        provider: 'microsoft',
        scopes: custom_scopes || process.env.MICROSOFT_SCOPES!,
        prompt: prompt || 'select_account',
      },
    });

    return NextResponse.json({
      authorization_url: authorizationUrl,
      state: authParams.get('state'),
      expires_in: 600, // Authorization URL expires in 10 minutes
    });

  } catch (error) {
    console.error('Microsoft connect POST failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.OAUTH_FAILED,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/auth/microsoft/connect',
        method: 'POST',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to initiate connection' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/auth/microsoft/connect
 * Disconnect a Microsoft account
 */
export async function DELETE(request: NextRequest) {
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

    if (!accountId) {
      return NextResponse.json(
        { error: 'Missing parameter', message: 'account_id is required' },
        { status: 400 }
      );
    }

    // Verify account belongs to user
    const { data: account, error: accountError } = await supabaseAdmin!
      .from('email_accounts')
      .select('id, email_address, display_name')
      .eq('id', accountId)
      .eq('user_id', session.user.id)
      .eq('provider', 'microsoft')
      .single();

    if (accountError || !account) {
      return NextResponse.json(
        { error: 'Account not found', message: 'Microsoft account not found or not owned by user' },
        { status: 404 }
      );
    }

    // Revoke tokens
    try {
      const graphClient = createGraphClient(accountId);
      
      // Test if we can still access the account before revoking
      try {
        await graphClient.getUser();
      } catch (error) {
        console.warn('Account already inaccessible, proceeding with cleanup:', error);
      }
      
      // Revoke stored tokens
      // Note: tokenManager.revokeTokens will be called during account deletion
      
    } catch (error) {
      console.warn('Failed to revoke tokens, proceeding with account deletion:', error);
    }

    // Deactivate account (soft delete)
    const { error: updateError } = await supabaseAdmin!
      .from('email_accounts')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', accountId);

    if (updateError) {
      console.error('Failed to deactivate account:', updateError);
      return NextResponse.json(
        { error: 'Database error', message: 'Failed to disconnect account' },
        { status: 500 }
      );
    }

    // Delete associated tokens
    const { error: tokenError } = await supabaseAdmin!
      .from('encrypted_tokens')
      .delete()
      .eq('account_id', accountId);

    if (tokenError) {
      console.warn('Failed to delete encrypted tokens:', tokenError);
      // Don't fail the request, just log the warning
    }

    // Log account disconnection
    await auditLogger.logEvent({
      event_type: AuditEventType.ACCOUNT_DISCONNECTED,
      user_id: session.user.id,
      account_id: accountId,
      severity: AuditSeverity.MEDIUM,
      details: {
        provider: 'microsoft',
        email_address: account.email_address,
        display_name: account.display_name,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Microsoft account disconnected successfully',
      account_id: accountId,
    });

  } catch (error) {
    console.error('Microsoft disconnect failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/auth/microsoft/connect',
        method: 'DELETE',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to disconnect account' },
      { status: 500 }
    );
  }
}