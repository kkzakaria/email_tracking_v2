/**
 * Tracked Emails API Endpoint - List and Filter Tracked Emails
 * GET /api/emails/tracked - Get tracked emails with filtering
 * Phase 2 Critical Implementation
 * Created: 2025-09-05
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { emailTrackingService } from '@/lib/email-tracking-service';
import { auditLogger } from '@/lib/audit-logger';
import { TrackedEmailFilters } from '@/types/email-tracking';
import { TrackingStatusEnum } from '@/types/database';

// ============================================================================
// GET - LIST TRACKED EMAILS WITH FILTERING
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
      .select('id, email_address')
      .eq('id', accountId)
      .eq('user_id', session.user.id)
      .eq('is_active', true)
      .single();

    if (accountError || !account) {
      await auditLogger.logEvent(
        'unauthorized_tracked_emails_access',
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

    // Build filters from query parameters
    const filters: TrackedEmailFilters = {};

    // Status filter
    const statusParam = searchParams.get('status');
    if (statusParam) {
      const statuses = statusParam.split(',');
      const validStatuses = statuses.filter(s => 
        ['active', 'paused', 'completed', 'failed'].includes(s)
      ) as TrackingStatusEnum[];
      
      if (validStatuses.length > 0) {
        filters.status = validStatuses.length === 1 ? validStatuses[0] : validStatuses;
      }
    }

    // Has response filter
    const hasResponseParam = searchParams.get('hasResponse');
    if (hasResponseParam !== null) {
      filters.hasResponse = hasResponseParam === 'true';
    }

    // Date range filter
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    if (startDate || endDate) {
      filters.dateRange = {
        start: startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        end: endDate ? new Date(endDate) : new Date(),
      };
    }

    // Search query
    const searchQuery = searchParams.get('search');
    if (searchQuery) {
      filters.searchQuery = searchQuery;
    }

    // Sorting
    const sortBy = searchParams.get('sortBy') as 'sent_at' | 'updated_at' | 'response_count' | 'subject' | null;
    if (sortBy) {
      filters.sortBy = sortBy;
    }

    const sortOrder = searchParams.get('sortOrder') as 'asc' | 'desc' | null;
    if (sortOrder) {
      filters.sortOrder = sortOrder;
    }

    // Pagination
    const page = parseInt(searchParams.get('page') || '1');
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100); // Max 100 per page
    filters.limit = limit;
    filters.offset = (page - 1) * limit;

    // Get tracked emails
    const result = await emailTrackingService.getTrackedEmails(accountId, filters);

    // Log successful access (low priority to avoid spam)
    if (Math.random() < 0.1) { // Log only 10% of requests
      await auditLogger.logEvent(
        'tracked_emails_accessed',
        'low',
        {
          user_id: session.user.id,
          account_id: accountId,
          email_count: result.data.length,
          total_count: result.pagination.total,
          filters_applied: Object.keys(filters).length,
        }
      );
    }

    return NextResponse.json({
      success: true,
      data: result.data.map(email => ({
        id: email.id,
        messageId: email.messageId,
        conversationId: email.conversationId,
        subject: email.subject,
        fromEmail: email.fromEmail,
        fromName: email.fromName,
        toEmails: email.toEmails,
        ccEmails: email.ccEmails,
        bodyPreview: email.bodyPreview,
        sentAt: email.sentAt,
        hasResponse: email.hasResponse,
        lastResponseAt: email.lastResponseAt,
        responseCount: email.responseCount,
        trackingStatus: email.trackingStatus,
        createdAt: email.createdAt,
        updatedAt: email.updatedAt,
        responseTimeHours: email.responseTimeHours,
        isOverdue: email.isOverdue,
        engagementScore: email.engagementScore,
      })),
      pagination: result.pagination,
      filters: result.filters,
      account: {
        id: account.id,
        emailAddress: account.email_address,
      }
    });

  } catch (error) {
    console.error('Failed to get tracked emails:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'tracked_emails_fetch_failed',
      'high',
      {
        user_id: session?.user?.id || 'anonymous',
        error: error instanceof Error ? error.message : 'Unknown error',
        ip: request.headers.get('x-forwarded-for') || 'unknown',
      }
    );

    return NextResponse.json(
      {
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch tracked emails',
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