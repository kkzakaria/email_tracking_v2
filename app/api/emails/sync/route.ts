/**
 * Email Synchronization API Endpoint
 * POST /api/emails/sync - Manually trigger email sync from Microsoft Graph
 * Phase 2 Critical Implementation
 * Created: 2025-09-05
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { emailIngestionEngine } from '@/lib/email-ingestion';
import { auditLogger } from '@/lib/audit-logger';
import { createValidator } from '@/lib/validators';
import { z } from 'zod';

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const SyncRequestSchema = z.object({
  accountId: z.string().uuid('Invalid account ID format'),
  options: z.object({
    since: z.string().datetime().optional(),
    batchSize: z.number().min(1).max(200).optional(),
    forceRefresh: z.boolean().optional(),
    includeDeleted: z.boolean().optional(),
  }).optional(),
});

// ============================================================================
// POST - TRIGGER MANUAL EMAIL SYNCHRONIZATION
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 }
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const validator = createValidator(SyncRequestSchema);
    const validationResult = validator(body);

    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid request data',
            details: validationResult.errors,
          }
        },
        { status: 400 }
      );
    }

    const { accountId, options = {} } = validationResult.data;

    // Verify account ownership
    const { supabase } = await import('@/lib/supabase');
    const { data: account, error: accountError } = await supabase
      .from('email_accounts')
      .select('id, email_address, updated_at')
      .eq('id', accountId)
      .eq('user_id', session.user.id)
      .eq('is_active', true)
      .single();

    if (accountError || !account) {
      await auditLogger.logEvent(
        'unauthorized_sync_attempt',
        'medium',
        {
          user_id: session.user.id,
          account_id: accountId,
          ip: request.headers.get('x-forwarded-for') || 'unknown',
        }
      );

      return NextResponse.json(
        { error: { code: 'ACCOUNT_NOT_FOUND', message: 'Email account not found or not accessible' } },
        { status: 404 }
      );
    }

    // Check if sync is already in progress
    const syncStatus = emailIngestionEngine.getIngestionStatus(accountId);
    if (syncStatus.inProgress) {
      return NextResponse.json(
        {
          error: {
            code: 'SYNC_IN_PROGRESS',
            message: 'Sync already in progress for this account',
            details: {
              accountId,
              inProgress: true,
            }
          }
        },
        { status: 409 } // Conflict
      );
    }

    // Check retry cooldown
    if (syncStatus.retryInfo) {
      const now = new Date();
      if (syncStatus.retryInfo.nextRetry > now) {
        const waitSeconds = Math.ceil((syncStatus.retryInfo.nextRetry.getTime() - now.getTime()) / 1000);
        return NextResponse.json(
          {
            error: {
              code: 'SYNC_COOLDOWN',
              message: `Account in retry cooldown. Please wait ${waitSeconds} seconds.`,
              details: {
                accountId,
                retryCount: syncStatus.retryInfo.count,
                nextRetry: syncStatus.retryInfo.nextRetry,
                waitSeconds,
              }
            }
          },
          { status: 429 } // Too Many Requests
        );
      }
    }

    // Prepare ingestion options
    const ingestionOptions = {
      since: options.since ? new Date(options.since) : new Date(Date.now() - 24 * 60 * 60 * 1000), // Default: last 24 hours
      batchSize: options.batchSize || 50,
      forceRefresh: options.forceRefresh || false,
      includeDeleted: options.includeDeleted || false,
    };

    // Log sync start
    await auditLogger.logEvent(
      'manual_sync_started',
      'medium',
      {
        user_id: session.user.id,
        account_id: accountId,
        email_address: account.email_address,
        since: ingestionOptions.since.toISOString(),
        batch_size: ingestionOptions.batchSize,
        force_refresh: ingestionOptions.forceRefresh,
        ip: request.headers.get('x-forwarded-for') || 'unknown',
      }
    );

    // Trigger the synchronization
    const syncResult = await emailIngestionEngine.processFullIngestion(accountId, ingestionOptions);

    // Prepare response data
    const responseData = {
      accountId,
      accountEmail: account.email_address,
      syncResult: {
        success: syncResult.success,
        processedCount: syncResult.processedCount,
        newTrackedCount: syncResult.newTrackedCount,
        skippedCount: syncResult.skippedCount,
        errorCount: syncResult.errorCount,
        duration: syncResult.endTime.getTime() - syncResult.startTime.getTime(),
        startTime: syncResult.startTime,
        endTime: syncResult.endTime,
        nextCursor: syncResult.nextCursor,
        
        // Error details (limited to prevent response bloat)
        errors: syncResult.errors.slice(0, 10).map(error => ({
          messageId: error.messageId,
          error: error.error,
          retryable: error.retryable,
        })),
        hasMoreErrors: syncResult.errors.length > 10,
      },
      options: ingestionOptions,
    };

    // Log sync completion
    await auditLogger.logEvent(
      'manual_sync_completed',
      syncResult.success ? 'low' : 'medium',
      {
        user_id: session.user.id,
        account_id: accountId,
        success: syncResult.success,
        processed_count: syncResult.processedCount,
        new_tracked_count: syncResult.newTrackedCount,
        error_count: syncResult.errorCount,
        duration_ms: responseData.syncResult.duration,
      }
    );

    return NextResponse.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    console.error('Manual email sync failed:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'manual_sync_failed',
      'high',
      {
        user_id: session?.user?.id || 'anonymous',
        error: error instanceof Error ? error.message : 'Unknown error',
        ip: request.headers.get('x-forwarded-for') || 'unknown',
      }
    );

    // Return appropriate error response
    if (error instanceof Error && error.message.includes('Rate limit')) {
      return NextResponse.json(
        {
          error: {
            code: 'RATE_LIMIT',
            message: 'Rate limit exceeded. Microsoft Graph API limits reached.',
            details: error.message,
          }
        },
        { status: 429 }
      );
    }

    if (error instanceof Error && error.message.includes('already in progress')) {
      return NextResponse.json(
        {
          error: {
            code: 'SYNC_IN_PROGRESS',
            message: 'Sync already in progress for this account',
          }
        },
        { status: 409 }
      );
    }

    if (error instanceof Error && error.message.includes('retry cooldown')) {
      return NextResponse.json(
        {
          error: {
            code: 'SYNC_COOLDOWN',
            message: 'Account in retry cooldown period',
            details: error.message,
          }
        },
        { status: 429 }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'SYNC_FAILED',
          message: 'Failed to synchronize emails',
          details: error instanceof Error ? error.message : 'Unknown error',
        }
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET - GET SYNC STATUS
// ============================================================================

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 }
      );
    }

    // Parse URL parameters
    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('accountId');
    
    if (!accountId) {
      return NextResponse.json(
        { error: { code: 'MISSING_ACCOUNT', message: 'Account ID is required' } },
        { status: 400 }
      );
    }

    // Verify account ownership
    const { supabase } = await import('@/lib/supabase');
    const { data: account, error: accountError } = await supabase
      .from('email_accounts')
      .select('id, email_address, updated_at')
      .eq('id', accountId)
      .eq('user_id', session.user.id)
      .eq('is_active', true)
      .single();

    if (accountError || !account) {
      return NextResponse.json(
        { error: { code: 'ACCOUNT_NOT_FOUND', message: 'Email account not found or not accessible' } },
        { status: 404 }
      );
    }

    // Get sync status
    const syncStatus = emailIngestionEngine.getIngestionStatus(accountId);

    const statusData = {
      accountId,
      accountEmail: account.email_address,
      lastSyncAt: account.updated_at,
      status: {
        inProgress: syncStatus.inProgress,
        retryInfo: syncStatus.retryInfo ? {
          count: syncStatus.retryInfo.count,
          nextRetry: syncStatus.retryInfo.nextRetry,
          waitSeconds: syncStatus.retryInfo.nextRetry > new Date() ? 
            Math.ceil((syncStatus.retryInfo.nextRetry.getTime() - Date.now()) / 1000) : 0,
        } : null,
      },
      canSync: !syncStatus.inProgress && 
               (!syncStatus.retryInfo || syncStatus.retryInfo.nextRetry <= new Date()),
    };

    return NextResponse.json({
      success: true,
      data: statusData
    });

  } catch (error) {
    console.error('Failed to get sync status:', error);

    return NextResponse.json(
      {
        error: {
          code: 'STATUS_FAILED',
          message: 'Failed to get sync status',
          details: error instanceof Error ? error.message : 'Unknown error',
        }
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// OPTIONS - CORS SUPPORT
// ============================================================================

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}