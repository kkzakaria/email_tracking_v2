/**
 * Single Tracked Email API Endpoint
 * GET /api/emails/tracked/[id] - Get single tracked email details
 * PUT /api/emails/tracked/[id]/status - Update tracking status
 * DELETE /api/emails/tracked/[id] - Stop tracking (alias for DELETE /api/emails/track)
 * Phase 2 Critical Implementation
 * Created: 2025-09-05
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../auth/[...nextauth]/route';
import { emailTrackingService } from '@/lib/email-tracking-service';
import { emailLifecycleManager } from '@/lib/email-lifecycle';
import { auditLogger } from '@/lib/audit-logger';
import { createValidator } from '@/lib/validators';
import { EmailTrackingStatus } from '@/types/email-tracking';
import { z } from 'zod';

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const UpdateStatusSchema = z.object({
  status: z.enum(['pending', 'sent', 'delivered', 'opened', 'replied', 'bounced', 'closed']),
});

// ============================================================================
// GET - GET SINGLE TRACKED EMAIL DETAILS
// ============================================================================

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 }
      );
    }

    const emailId = params.id;

    // Validate UUID format
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(emailId)) {
      return NextResponse.json(
        { error: { code: 'INVALID_ID', message: 'Invalid email ID format' } },
        { status: 400 }
      );
    }

    // Verify email ownership
    const { supabase } = await import('@/lib/supabase');
    const { data: trackedEmail, error: emailError } = await supabase
      .from('tracked_emails')
      .select(`
        *,
        email_accounts!inner (
          id,
          user_id,
          email_address
        ),
        email_responses (
          id,
          message_id,
          from_email,
          from_name,
          subject,
          body_preview,
          received_at,
          is_auto_reply,
          confidence_score,
          created_at
        )
      `)
      .eq('id', emailId)
      .single();

    if (emailError || !trackedEmail || trackedEmail.email_accounts.user_id !== session.user.id) {
      await auditLogger.logEvent(
        'unauthorized_tracked_email_access',
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

    // Map database record to response format
    const mappedEmail = {
      id: trackedEmail.id,
      emailAccountId: trackedEmail.email_account_id,
      messageId: trackedEmail.message_id,
      conversationId: trackedEmail.conversation_id,
      threadId: trackedEmail.thread_id,
      subject: trackedEmail.subject,
      fromEmail: trackedEmail.from_email,
      fromName: trackedEmail.from_name,
      toEmails: trackedEmail.to_emails,
      ccEmails: trackedEmail.cc_emails,
      bccEmails: trackedEmail.bcc_emails,
      bodyPreview: trackedEmail.body_preview,
      sentAt: trackedEmail.sent_at,
      hasResponse: trackedEmail.has_response,
      lastResponseAt: trackedEmail.last_response_at,
      responseCount: trackedEmail.response_count,
      trackingStatus: trackedEmail.tracking_status,
      followUpRuleId: trackedEmail.follow_up_rule_id,
      createdAt: trackedEmail.created_at,
      updatedAt: trackedEmail.updated_at,
      
      // Calculated fields
      responseTimeHours: trackedEmail.last_response_at && trackedEmail.sent_at ? 
        (new Date(trackedEmail.last_response_at).getTime() - new Date(trackedEmail.sent_at).getTime()) / (1000 * 60 * 60) : null,
      
      isOverdue: trackedEmail.tracking_status === 'active' && 
                !trackedEmail.has_response && 
                (Date.now() - new Date(trackedEmail.sent_at).getTime()) > (7 * 24 * 60 * 60 * 1000),
      
      engagementScore: trackedEmail.has_response ? 
        Math.min(100, 70 + (trackedEmail.response_count * 10)) : 
        (trackedEmail.tracking_status === 'active' ? 30 : 10),

      // Related data
      account: {
        id: trackedEmail.email_accounts.id,
        emailAddress: trackedEmail.email_accounts.email_address,
      },
      responses: trackedEmail.email_responses || [],
    };

    // Log successful access
    await auditLogger.logEvent(
      'tracked_email_accessed',
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
      data: mappedEmail
    });

  } catch (error) {
    console.error('Failed to get tracked email:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'tracked_email_fetch_failed',
      'high',
      {
        user_id: session?.user?.id || 'anonymous',
        email_id: params.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        ip: request.headers.get('x-forwarded-for') || 'unknown',
      }
    );

    return NextResponse.json(
      {
        error: {
          code: 'FETCH_FAILED',
          message: 'Failed to fetch tracked email',
          details: error instanceof Error ? error.message : 'Unknown error',
        }
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// PUT - UPDATE TRACKING STATUS
// ============================================================================

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 }
      );
    }

    const emailId = params.id;

    // Parse and validate request body
    const body = await request.json();
    const validator = createValidator(UpdateStatusSchema);
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

    const { status } = validationResult.data;

    // Verify email ownership and get current status
    const { supabase } = await import('@/lib/supabase');
    const { data: trackedEmail, error: emailError } = await supabase
      .from('tracked_emails')
      .select(`
        id,
        subject,
        tracking_status,
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
        'unauthorized_status_update_attempt',
        'medium',
        {
          user_id: session.user.id,
          email_id: emailId,
          requested_status: status,
          ip: request.headers.get('x-forwarded-for') || 'unknown',
        }
      );

      return NextResponse.json(
        { error: { code: 'EMAIL_NOT_FOUND', message: 'Tracked email not found or not accessible' } },
        { status: 404 }
      );
    }

    // Map database status to lifecycle status
    const currentStatus = trackedEmail.tracking_status;
    let currentLifecycleStatus: EmailTrackingStatus;
    let newLifecycleStatus: EmailTrackingStatus;

    // Simple mapping for this implementation
    switch (currentStatus) {
      case 'active': currentLifecycleStatus = EmailTrackingStatus.DELIVERED; break;
      case 'completed': currentLifecycleStatus = EmailTrackingStatus.CLOSED; break;
      case 'failed': currentLifecycleStatus = EmailTrackingStatus.BOUNCED; break;
      case 'paused': currentLifecycleStatus = EmailTrackingStatus.SENT; break;
      default: currentLifecycleStatus = EmailTrackingStatus.DELIVERED;
    }

    newLifecycleStatus = status as EmailTrackingStatus;

    // Check if transition is valid
    const validTransitions = emailLifecycleManager.getValidTransitions(currentLifecycleStatus);
    if (!validTransitions.includes(newLifecycleStatus)) {
      return NextResponse.json(
        {
          error: {
            code: 'INVALID_TRANSITION',
            message: `Invalid status transition from ${currentLifecycleStatus} to ${newLifecycleStatus}`,
            details: {
              currentStatus: currentLifecycleStatus,
              requestedStatus: newLifecycleStatus,
              validTransitions,
            }
          }
        },
        { status: 400 }
      );
    }

    // Perform the transition
    const transitionSuccess = await emailLifecycleManager.transitionStatus(
      emailId,
      currentLifecycleStatus,
      newLifecycleStatus
    );

    if (!transitionSuccess) {
      return NextResponse.json(
        {
          error: {
            code: 'TRANSITION_FAILED',
            message: 'Failed to update email status',
          }
        },
        { status: 500 }
      );
    }

    // Get updated email data
    const updatedEmail = await emailTrackingService.getTrackedEmail(emailId);

    // Log successful status update
    await auditLogger.logEvent(
      'email_status_updated',
      'low',
      {
        user_id: session.user.id,
        account_id: trackedEmail.email_account_id,
        tracked_email_id: emailId,
        subject: trackedEmail.subject,
        old_status: currentLifecycleStatus,
        new_status: newLifecycleStatus,
      }
    );

    return NextResponse.json({
      success: true,
      data: {
        id: emailId,
        previousStatus: currentLifecycleStatus,
        newStatus: newLifecycleStatus,
        updatedAt: new Date().toISOString(),
        email: updatedEmail,
      }
    });

  } catch (error) {
    console.error('Failed to update email status:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'email_status_update_failed',
      'high',
      {
        user_id: session?.user?.id || 'anonymous',
        email_id: params.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        ip: request.headers.get('x-forwarded-for') || 'unknown',
      }
    );

    return NextResponse.json(
      {
        error: {
          code: 'UPDATE_FAILED',
          message: 'Failed to update email status',
          details: error instanceof Error ? error.message : 'Unknown error',
        }
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// DELETE - STOP TRACKING EMAIL
// ============================================================================

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 }
      );
    }

    const emailId = params.id;

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
        'unauthorized_email_deletion_attempt',
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

    // Log successful deletion
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
    console.error('Failed to stop email tracking:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'email_tracking_deletion_failed',
      'high',
      {
        user_id: session?.user?.id || 'anonymous',
        email_id: params.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        ip: request.headers.get('x-forwarded-for') || 'unknown',
      }
    );

    return NextResponse.json(
      {
        error: {
          code: 'DELETE_FAILED',
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