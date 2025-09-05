/**
 * Microsoft Accounts Management API
 * Email Tracking System - CRUD Operations for Microsoft Accounts
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This endpoint manages Microsoft email accounts
 * Includes security validation and audit logging
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../auth/[...nextauth]/route';
import { supabaseAdmin } from '@/lib/supabase';
import { tokenManager } from '@/lib/token-manager';
import { rateLimiter } from '@/lib/rate-limiter';
import { createGraphClient } from '@/lib/microsoft-graph-client';
import { auditLogger, AuditEventType, AuditSeverity } from '@/lib/audit-logger';
import { 
  EmailAccountCreateSchema, 
  EmailAccountUpdateSchema, 
  PaginationSchema,
  createValidator 
} from '@/lib/validators';

/**
 * GET /api/accounts/microsoft
 * Get all Microsoft accounts for the current user
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
    
    // Validate pagination parameters
    const paginationValidator = createValidator(PaginationSchema);
    const paginationResult = paginationValidator({
      page: parseInt(searchParams.get('page') || '1'),
      limit: parseInt(searchParams.get('limit') || '20'),
      order: searchParams.get('order') || 'desc',
    });

    if (!paginationResult.success) {
      return NextResponse.json(
        { error: 'Invalid parameters', errors: paginationResult.errors },
        { status: 400 }
      );
    }

    const { page, limit, order } = paginationResult.data;
    const offset = (page - 1) * limit;
    const includeTokens = searchParams.get('include_tokens') === 'true';
    const includeRateLimit = searchParams.get('include_rate_limit') === 'true';

    // Get total count
    const { count, error: countError } = await supabaseAdmin!
      .from('email_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', session.user.id)
      .eq('provider', 'microsoft');

    if (countError) {
      console.error('Failed to count Microsoft accounts:', countError);
      return NextResponse.json(
        { error: 'Database error', message: 'Failed to count accounts' },
        { status: 500 }
      );
    }

    // Get accounts with pagination
    const { data: accounts, error } = await supabaseAdmin!
      .from('email_accounts')
      .select(`
        id,
        email_address,
        display_name,
        provider_user_id,
        is_active,
        last_sync_at,
        created_at,
        updated_at,
        settings
      `)
      .eq('user_id', session.user.id)
      .eq('provider', 'microsoft')
      .order('created_at', { ascending: order === 'asc' })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Failed to fetch Microsoft accounts:', error);
      return NextResponse.json(
        { error: 'Database error', message: 'Failed to fetch accounts' },
        { status: 500 }
      );
    }

    // Enrich accounts with additional data if requested
    const enrichedAccounts = await Promise.all(
      (accounts || []).map(async (account) => {
        const enrichedAccount: any = { ...account };

        // Include token information
        if (includeTokens) {
          try {
            const tokens = await tokenManager.getValidTokens(account.id);
            enrichedAccount.has_valid_tokens = !!tokens;
            if (tokens) {
              enrichedAccount.token_expires_at = new Date(tokens.expires_at!).toISOString();
              enrichedAccount.token_expires_in_minutes = Math.floor((tokens.expires_at! - Date.now()) / (60 * 1000));
              enrichedAccount.scopes = tokens.scope?.split(' ') || [];
            }
          } catch (error) {
            console.warn(`Failed to get tokens for account ${account.id}:`, error);
            enrichedAccount.has_valid_tokens = false;
          }
        }

        // Include rate limit status
        if (includeRateLimit) {
          try {
            const rateLimitStatus = await rateLimiter.getStatus(account.id);
            enrichedAccount.rate_limits = rateLimitStatus;
          } catch (error) {
            console.warn(`Failed to get rate limits for account ${account.id}:`, error);
            enrichedAccount.rate_limits = null;
          }
        }

        return enrichedAccount;
      })
    );

    const totalPages = Math.ceil((count || 0) / limit);

    return NextResponse.json({
      accounts: enrichedAccounts,
      pagination: {
        page,
        limit,
        total: count || 0,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Microsoft accounts GET failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/accounts/microsoft',
        method: 'GET',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to fetch Microsoft accounts' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/accounts/microsoft
 * Create a new Microsoft account (typically used after OAuth2 flow)
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

    // Validate input
    const validator = createValidator(EmailAccountCreateSchema);
    const validationResult = validator({
      ...body,
      user_id: session.user.id,
      provider: 'microsoft',
    });

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid input', errors: validationResult.errors },
        { status: 400 }
      );
    }

    const accountData = validationResult.data;

    // Check if account already exists
    const { data: existingAccount, error: checkError } = await supabaseAdmin!
      .from('email_accounts')
      .select('id')
      .eq('user_id', session.user.id)
      .eq('provider', 'microsoft')
      .eq('provider_user_id', accountData.provider_user_id)
      .single();

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 is "not found"
      console.error('Failed to check existing account:', checkError);
      return NextResponse.json(
        { error: 'Database error', message: 'Failed to check existing account' },
        { status: 500 }
      );
    }

    if (existingAccount) {
      return NextResponse.json(
        { error: 'Account exists', message: 'Microsoft account already connected' },
        { status: 409 }
      );
    }

    // Create new account
    const { data: newAccount, error: createError } = await supabaseAdmin!
      .from('email_accounts')
      .insert({
        user_id: accountData.user_id,
        provider: accountData.provider,
        email_address: accountData.email_address,
        display_name: accountData.display_name,
        provider_user_id: accountData.provider_user_id,
        is_active: true,
        settings: accountData.settings || {
          auto_track: true,
          track_replies: true,
          notification_enabled: true,
        },
      })
      .select()
      .single();

    if (createError || !newAccount) {
      console.error('Failed to create Microsoft account:', createError);
      return NextResponse.json(
        { error: 'Database error', message: 'Failed to create account' },
        { status: 500 }
      );
    }

    // Log account creation
    await auditLogger.logEvent({
      event_type: AuditEventType.ACCOUNT_CONNECTED,
      user_id: session.user.id,
      account_id: newAccount.id,
      severity: AuditSeverity.MEDIUM,
      details: {
        provider: 'microsoft',
        email_address: newAccount.email_address,
        display_name: newAccount.display_name,
      },
    });

    return NextResponse.json({
      success: true,
      account: newAccount,
      message: 'Microsoft account created successfully',
    }, { status: 201 });

  } catch (error) {
    console.error('Microsoft account creation failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/accounts/microsoft',
        method: 'POST',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to create Microsoft account' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/accounts/microsoft
 * Update a Microsoft account
 */
export async function PUT(request: NextRequest) {
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

    const body = await request.json();

    // Validate input
    const validator = createValidator(EmailAccountUpdateSchema);
    const validationResult = validator(body);

    if (!validationResult.success) {
      return NextResponse.json(
        { error: 'Invalid input', errors: validationResult.errors },
        { status: 400 }
      );
    }

    const updateData = validationResult.data;

    // Verify account belongs to user
    const { data: existingAccount, error: checkError } = await supabaseAdmin!
      .from('email_accounts')
      .select('id, email_address, display_name')
      .eq('id', accountId)
      .eq('user_id', session.user.id)
      .eq('provider', 'microsoft')
      .single();

    if (checkError || !existingAccount) {
      return NextResponse.json(
        { error: 'Account not found', message: 'Microsoft account not found' },
        { status: 404 }
      );
    }

    // Update account
    const { data: updatedAccount, error: updateError } = await supabaseAdmin!
      .from('email_accounts')
      .update({
        ...updateData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', accountId)
      .select()
      .single();

    if (updateError || !updatedAccount) {
      console.error('Failed to update Microsoft account:', updateError);
      return NextResponse.json(
        { error: 'Database error', message: 'Failed to update account' },
        { status: 500 }
      );
    }

    // Log account update
    await auditLogger.logEvent({
      event_type: 'account_updated',
      user_id: session.user.id,
      account_id: accountId,
      severity: AuditSeverity.LOW,
      details: {
        provider: 'microsoft',
        updated_fields: Object.keys(updateData),
        old_display_name: existingAccount.display_name,
        new_display_name: updatedAccount.display_name,
      },
    });

    return NextResponse.json({
      success: true,
      account: updatedAccount,
      message: 'Microsoft account updated successfully',
    });

  } catch (error) {
    console.error('Microsoft account update failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/accounts/microsoft',
        method: 'PUT',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to update Microsoft account' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/accounts/microsoft
 * Delete (deactivate) a Microsoft account
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
    const hardDelete = searchParams.get('hard_delete') === 'true';

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
        { error: 'Account not found', message: 'Microsoft account not found' },
        { status: 404 }
      );
    }

    if (hardDelete) {
      // Hard delete: completely remove account and all associated data
      
      // 1. Revoke tokens
      await tokenManager.revokeTokens(accountId);

      // 2. Delete associated data (tracked emails, notifications, etc.)
      const tablesToClean = [
        'follow_up_executions',
        'email_engagement_events',
        'tracked_emails',
        'notifications',
        'encrypted_tokens',
      ];

      for (const table of tablesToClean) {
        try {
          await supabaseAdmin!
            .from(table)
            .delete()
            .eq('account_id', accountId);
        } catch (error) {
          console.warn(`Failed to clean table ${table} for account ${accountId}:`, error);
        }
      }

      // 3. Delete the account
      const { error: deleteError } = await supabaseAdmin!
        .from('email_accounts')
        .delete()
        .eq('id', accountId);

      if (deleteError) {
        console.error('Failed to hard delete account:', deleteError);
        return NextResponse.json(
          { error: 'Database error', message: 'Failed to delete account' },
          { status: 500 }
        );
      }

      // Log hard deletion
      await auditLogger.logEvent({
        event_type: 'account_hard_deleted',
        user_id: session.user.id,
        account_id: accountId,
        severity: AuditSeverity.HIGH,
        details: {
          provider: 'microsoft',
          email_address: account.email_address,
          display_name: account.display_name,
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Microsoft account permanently deleted',
        account_id: accountId,
        deletion_type: 'hard',
      });

    } else {
      // Soft delete: deactivate account
      const { error: deactivateError } = await supabaseAdmin!
        .from('email_accounts')
        .update({
          is_active: false,
          updated_at: new Date().toISOString(),
        })
        .eq('id', accountId);

      if (deactivateError) {
        console.error('Failed to deactivate account:', deactivateError);
        return NextResponse.json(
          { error: 'Database error', message: 'Failed to deactivate account' },
          { status: 500 }
        );
      }

      // Log soft deletion
      await auditLogger.logEvent({
        event_type: AuditEventType.ACCOUNT_DISCONNECTED,
        user_id: session.user.id,
        account_id: accountId,
        severity: AuditSeverity.MEDIUM,
        details: {
          provider: 'microsoft',
          email_address: account.email_address,
          display_name: account.display_name,
          deletion_type: 'soft',
        },
      });

      return NextResponse.json({
        success: true,
        message: 'Microsoft account deactivated',
        account_id: accountId,
        deletion_type: 'soft',
      });
    }

  } catch (error) {
    console.error('Microsoft account deletion failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/accounts/microsoft',
        method: 'DELETE',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Failed to delete Microsoft account' },
      { status: 500 }
    );
  }
}