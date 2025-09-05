/**
 * Webhook Subscription Creation Endpoint
 * Email Tracking System - Phase 2 Subscription Management
 * Created: 2025-09-05 for Microsoft Graph subscription management
 * 
 * ⚠️ CRITICAL: This endpoint creates new webhook subscriptions for email accounts
 * Must handle rate limits and validate account permissions
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { supabaseAdmin } from '@/lib/supabase';
import { subscriptionManager } from '@/lib/subscription-manager';
import { rateLimiter } from '@/lib/rate-limiter';
import { auditLogger } from '@/lib/audit-logger';
import { createValidator } from '@/lib/validators';

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

const CreateSubscriptionSchema = {
  type: 'object',
  required: ['accountId'],
  properties: {
    accountId: {
      type: 'string',
      format: 'uuid',
      description: 'Email account ID to create subscription for',
    },
    resource: {
      type: 'string',
      enum: ['email', 'mailbox'],
      default: 'email',
      description: 'Resource type to subscribe to',
    },
    forceRecreate: {
      type: 'boolean',
      default: false,
      description: 'Force recreation if subscription already exists',
    },
  },
  additionalProperties: false,
} as const;

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * POST /api/subscriptions/create
 * Create a new webhook subscription for an email account
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const clientIP = request.headers.get('x-forwarded-for') || 'unknown';

  try {
    // Authentication check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    // Rate limiting
    const rateLimitResult = await rateLimiter.checkAndRecord(
      `subscription_create_${session.user.id}`,
      'webhook_create'
    );

    if (!rateLimitResult.allowed) {
      await auditLogger.logEvent(
        'subscription_creation_rate_limited',
        'medium',
        {
          user_id: session.user.id,
          client_ip: clientIP,
          rate_limit_exceeded: true,
        }
      );

      return NextResponse.json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((new Date(rateLimitResult.reset_time).getTime() - Date.now()) / 1000),
      }, { status: 429 });
    }

    // Parse and validate request body
    const body = await request.json();
    const validator = createValidator(CreateSubscriptionSchema);
    const validationResult = validator(body);

    if (!validationResult.success) {
      return NextResponse.json({
        error: 'Invalid request data',
        details: validationResult.errors,
      }, { status: 400 });
    }

    const { accountId, resource = 'email', forceRecreate = false } = validationResult.data;

    // Verify account ownership
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    const { data: account, error: accountError } = await supabaseAdmin
      .from('email_accounts')
      .select('id, email_address, is_active, webhook_subscription_id')
      .eq('id', accountId)
      .eq('user_id', session.user.id)
      .eq('is_active', true)
      .single();

    if (accountError || !account) {
      await auditLogger.logEvent(
        'subscription_creation_unauthorized',
        'medium',
        {
          user_id: session.user.id,
          account_id: accountId,
          client_ip: clientIP,
        }
      );

      return NextResponse.json({
        error: 'Email account not found or access denied',
      }, { status: 404 });
    }

    // Check if subscription already exists
    if (account.webhook_subscription_id && !forceRecreate) {
      // Verify the existing subscription is still active
      try {
        const existingStatus = await subscriptionManager.getSubscriptionStatus(
          account.webhook_subscription_id
        );

        if (existingStatus.isActive) {
          return NextResponse.json({
            success: true,
            message: 'Subscription already exists and is active',
            subscription: {
              id: existingStatus.microsoftSubscriptionId,
              accountId: existingStatus.accountId,
              resource: existingStatus.resource,
              isActive: existingStatus.isActive,
              expiresAt: existingStatus.expiresAt,
              createdAt: existingStatus.createdAt,
            },
            alreadyExists: true,
          });
        }
      } catch (error) {
        console.log('Existing subscription validation failed, proceeding with creation');
      }
    }

    // Delete existing subscription if force recreate is requested
    if (account.webhook_subscription_id && forceRecreate) {
      try {
        await subscriptionManager.deleteSubscription(account.webhook_subscription_id);
        console.log(`Deleted existing subscription ${account.webhook_subscription_id} for recreation`);
      } catch (error) {
        console.warn('Failed to delete existing subscription during recreation:', error);
      }
    }

    // Create new subscription
    const subscription = await subscriptionManager.createSubscription(accountId, resource);

    const processingTime = Date.now() - startTime;

    // Log successful creation
    await auditLogger.logEvent(
      'webhook_subscription_created_via_api',
      'medium',
      {
        user_id: session.user.id,
        account_id: accountId,
        subscription_id: subscription.id,
        resource,
        force_recreate: forceRecreate,
        expires_at: subscription.expirationDateTime,
        processing_time_ms: processingTime,
        client_ip: clientIP,
      }
    );

    return NextResponse.json({
      success: true,
      message: 'Webhook subscription created successfully',
      subscription: {
        id: subscription.id,
        accountId,
        resource: subscription.resource,
        changeType: subscription.changeType,
        notificationUrl: subscription.notificationUrl,
        expiresAt: subscription.expirationDateTime,
        clientState: subscription.clientState,
      },
      processingTime,
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Failed to create webhook subscription:', error);

    await auditLogger.logEvent(
      'subscription_creation_failed',
      'high',
      {
        user_id: (await getServerSession(authOptions))?.user?.id,
        error: error instanceof Error ? error.message : 'Unknown error',
        processing_time_ms: processingTime,
        client_ip: clientIP,
      }
    );

    // Return appropriate error response
    if (error instanceof Error) {
      if (error.message.includes('Rate limit')) {
        return NextResponse.json({
          error: 'Rate limit exceeded for Microsoft Graph API',
          retryAfter: 300, // 5 minutes
        }, { status: 429 });
      }

      if (error.message.includes('subscription already exists')) {
        return NextResponse.json({
          error: 'Subscription already exists',
          suggestion: 'Use forceRecreate=true to recreate the subscription',
        }, { status: 409 });
      }
    }

    return NextResponse.json({
      error: 'Failed to create webhook subscription',
      processingTime,
    }, { status: 500 });
  }
}

/**
 * OPTIONS handler for CORS
 */
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}