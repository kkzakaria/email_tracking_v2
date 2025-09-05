/**
 * Email Tracking API Endpoint - Start/Stop Email Tracking
 * POST /api/emails/track - Start tracking an email
 * DELETE /api/emails/track - Stop tracking an email
 * Phase 2 Critical Implementation
 * Created: 2025-09-05
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { emailTrackingService } from '@/lib/email-tracking-service';
import { auditLogger } from '@/lib/audit-logger';
import { createValidator } from '@/lib/validators';
import { z } from 'zod';

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const TrackEmailSchema = z.object({
  messageId: z.string().min(1, 'Message ID is required'),
  accountId: z.string().uuid('Invalid account ID format'),
});

const StopTrackingSchema = z.object({
  emailId: z.string().uuid('Invalid email ID format'),
});

// ============================================================================
// POST - START TRACKING AN EMAIL
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
    const validator = createValidator(TrackEmailSchema);
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

    const { messageId, accountId } = validationResult.data;

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
        'unauthorized_email_tracking_attempt',
        'medium',
        {
          user_id: session.user.id,
          account_id: accountId,
          message_id: messageId,
          ip: request.headers.get('x-forwarded-for') || 'unknown',
        }
      );

      return NextResponse.json(
        { error: { code: 'ACCOUNT_NOT_FOUND', message: 'Email account not found or not accessible' } },
        { status: 404 }
      );
    }

    // Start tracking the email
    const trackedEmail = await emailTrackingService.startTracking(accountId, messageId);

    // Log successful tracking start
    await auditLogger.logEvent(
      'email_tracking_started',
      'low',
      {
        user_id: session.user.id,
        account_id: accountId,
        tracked_email_id: trackedEmail.id,
        message_id: messageId,
        subject: trackedEmail.subject,
        recipient_count: trackedEmail.toEmails.length,
      }
    );

    return NextResponse.json({
      success: true,
      data: {
        id: trackedEmail.id,
        messageId: trackedEmail.messageId,
        subject: trackedEmail.subject,
        toEmails: trackedEmail.toEmails,
        sentAt: trackedEmail.sentAt,
        trackingStatus: trackedEmail.trackingStatus,
        hasResponse: trackedEmail.hasResponse,
        responseCount: trackedEmail.responseCount,
        createdAt: trackedEmail.createdAt,
      }
    });

  } catch (error) {
    console.error('Email tracking start failed:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'email_tracking_start_failed',
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
        { error: { code: 'RATE_LIMIT', message: 'Rate limit exceeded. Please try again later.' } },
        { status: 429 }
      );
    }

    if (error instanceof Error && error.message.includes('draft')) {
      return NextResponse.json(
        { error: { code: 'DRAFT_EMAIL', message: 'Cannot track draft emails' } },
        { status: 400 }
      );
    }

    return NextResponse.json(
      {
        error: {
          code: 'TRACKING_FAILED',
          message: 'Failed to start email tracking',
          details: error instanceof Error ? error.message : 'Unknown error',
        }
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE - STOP TRACKING AN EMAIL
// ============================================================================

export async function DELETE(request: NextRequest) {
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
    const validator = createValidator(StopTrackingSchema);
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

    const { emailId } = validationResult.data;

    // Verify email ownership
    const { supabase } = await import('@/lib/supabase');
    const { data: trackedEmail, error: emailError } = await supabase
      .from('tracked_emails')
      .select(`
        id,
        subject,
        email_account_id,
        email_accounts!inner (
          id,
          user_id,
          email_address
        )
      `)
      .eq('id', emailId)
      .single();

    if (emailError || !trackedEmail || trackedEmail.email_accounts.user_id !== session.user.id) {
      await auditLogger.logEvent(
        'unauthorized_email_stop_tracking_attempt',
        'medium',
        {
          user_id: session.user.id,
          email_id: emailId,
          ip: request.headers.get('x-forwarded-for') || 'unknown',
        }
      );

      return NextResponse.json(
        { error: { code: 'EMAIL_NOT_FOUND', message: 'Tracked email not found or not accessible' } },
        { status: 404 }
      );
    }

    // Stop tracking the email
    await emailTrackingService.stopTracking(emailId);

    // Log successful tracking stop
    await auditLogger.logEvent(
      'email_tracking_stopped',
      'low',
      {
        user_id: session.user.id,
        account_id: trackedEmail.email_account_id,
        tracked_email_id: emailId,
        subject: trackedEmail.subject,
      }
    );

    return NextResponse.json({
      success: true,
      message: 'Email tracking stopped successfully'
    });

  } catch (error) {
    console.error('Email tracking stop failed:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'email_tracking_stop_failed',
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
          code: 'STOP_TRACKING_FAILED',
          message: 'Failed to stop email tracking',
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