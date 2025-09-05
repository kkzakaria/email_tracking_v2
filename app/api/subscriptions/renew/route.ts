/**
 * Webhook Subscription Renewal Endpoint
 * Email Tracking System - Phase 2 Subscription Management
 * Created: 2025-09-05 for Microsoft Graph subscription renewal
 * 
 * ⚠️ CRITICAL: This endpoint handles manual and automated subscription renewals
 * Must handle Microsoft Graph API rate limits and subscription errors
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

const RenewSubscriptionSchema = {
  type: 'object',
  properties: {
    subscriptionId: {
      type: 'string',
      minLength: 1,
      description: 'Microsoft Graph subscription ID to renew',
    },
    accountId: {
      type: 'string',
      format: 'uuid',
      description: 'Email account ID (alternative to subscriptionId)',
    },
    renewAll: {
      type: 'boolean',
      default: false,
      description: 'Renew all expiring subscriptions for the user',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Force renewal even if not expiring soon',
    },
  },
  additionalProperties: false,
  oneOf: [
    { required: ['subscriptionId'] },
    { required: ['accountId'] },
    { required: ['renewAll'] },
  ],
} as const;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Check if user owns the subscription
 */
async function verifySubscriptionOwnership(
  subscriptionId: string, 
  userId: string
): Promise<{ isOwner: boolean; accountId?: string; subscriptionRecord?: unknown }> {
  if (!supabaseAdmin) {
    return { isOwner: false };
  }

  try {
    const { data: subscription, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select(`
        *,
        email_accounts!inner(user_id, email_address)
      `)
      .eq('microsoft_subscription_id', subscriptionId)
      .eq('email_accounts.user_id', userId)
      .single();

    return {
      isOwner: !error && !!subscription,
      accountId: subscription?.email_account_id,
      subscriptionRecord: subscription,
    };

  } catch (error) {
    console.error('Failed to verify subscription ownership:', error);
    return { isOwner: false };
  }
}

/**
 * Get expiring subscriptions for a user
 */
async function getUserExpiringSubscriptions(userId: string): Promise<unknown[]> {
  if (!supabaseAdmin) {
    return [];
  }

  try {
    // Get subscriptions expiring within 48 hours
    const expirationThreshold = new Date(Date.now() + (48 * 60 * 60 * 1000));

    const { data: subscriptions, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select(`
        *,
        email_accounts!inner(user_id, email_address)
      `)
      .eq('is_active', true)
      .eq('email_accounts.user_id', userId)
      .lte('expires_at', expirationThreshold.toISOString())
      .order('expires_at', { ascending: true });

    if (error) {
      console.error('Failed to get expiring subscriptions:', error);
      return [];
    }

    return subscriptions || [];

  } catch (error) {
    console.error('Failed to get expiring subscriptions:', error);
    return [];
  }
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * POST /api/subscriptions/renew
 * Renew webhook subscriptions manually or automatically
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
      `subscription_renew_${session.user.id}`,
      'webhook_create'
    );

    if (!rateLimitResult.allowed) {
      await auditLogger.logEvent(
        'subscription_renewal_rate_limited',
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
    const validator = createValidator(RenewSubscriptionSchema);
    const validationResult = validator(body);

    if (!validationResult.success) {
      return NextResponse.json({
        error: 'Invalid request data',
        details: validationResult.errors,
      }, { status: 400 });
    }

    const { subscriptionId, accountId, renewAll = false, force = false } = validationResult.data;

    // Handle renewal of all expiring subscriptions
    if (renewAll) {
      const expiringSubscriptions = await getUserExpiringSubscriptions(session.user.id);
      
      if (expiringSubscriptions.length === 0) {
        return NextResponse.json({
          success: true,
          message: 'No subscriptions need renewal',
          renewed: [],
          skipped: [],
        });
      }

      const renewalResults = [];
      const errors = [];

      for (const subscription of expiringSubscriptions) {
        try {
          const result = await subscriptionManager.renewSubscription(
            subscription.microsoft_subscription_id
          );
          
          renewalResults.push({
            subscriptionId: subscription.microsoft_subscription_id,
            accountEmail: subscription.email_accounts.email_address,
            newExpirationDate: result.expirationDateTime,
            success: true,
          });

        } catch (error) {
          console.error(`Failed to renew subscription ${subscription.microsoft_subscription_id}:`, error);
          errors.push({
            subscriptionId: subscription.microsoft_subscription_id,
            accountEmail: subscription.email_accounts.email_address,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      const processingTime = Date.now() - startTime;

      await auditLogger.logEvent(
        'bulk_subscription_renewal',
        errors.length > 0 ? 'medium' : 'low',
        {
          user_id: session.user.id,
          total_subscriptions: expiringSubscriptions.length,
          successful_renewals: renewalResults.length,
          failed_renewals: errors.length,
          processing_time_ms: processingTime,
          client_ip: clientIP,
        }
      );

      return NextResponse.json({
        success: renewalResults.length > 0,
        message: `Renewed ${renewalResults.length} of ${expiringSubscriptions.length} subscriptions`,
        renewed: renewalResults,
        errors: errors.length > 0 ? errors : undefined,
        processingTime,
      });
    }

    // Handle single subscription renewal
    let targetSubscriptionId = subscriptionId;
    const targetAccountId = accountId;

    // If accountId is provided, get the subscription ID
    if (accountId && !subscriptionId) {
      if (!supabaseAdmin) {
        throw new Error('Database connection not available');
      }

      const { data: account, error: accountError } = await supabaseAdmin
        .from('email_accounts')
        .select('webhook_subscription_id, email_address')
        .eq('id', accountId)
        .eq('user_id', session.user.id)
        .single();

      if (accountError || !account) {
        return NextResponse.json({
          error: 'Account not found or access denied',
        }, { status: 404 });
      }

      if (!account.webhook_subscription_id) {
        return NextResponse.json({
          error: 'No active webhook subscription found for this account',
        }, { status: 404 });
      }

      targetSubscriptionId = account.webhook_subscription_id;
    }

    if (!targetSubscriptionId) {
      return NextResponse.json({
        error: 'Subscription ID is required',
      }, { status: 400 });
    }

    // Verify ownership
    const ownershipCheck = await verifySubscriptionOwnership(targetSubscriptionId, session.user.id);
    
    if (!ownershipCheck.isOwner) {
      await auditLogger.logEvent(
        'subscription_renewal_unauthorized',
        'medium',
        {
          user_id: session.user.id,
          subscription_id: targetSubscriptionId,
          account_id: targetAccountId,
          client_ip: clientIP,
        }
      );

      return NextResponse.json({
        error: 'Subscription not found or access denied',
      }, { status: 404 });
    }

    // Check if renewal is needed (unless forced)
    if (!force) {
      try {
        const status = await subscriptionManager.getSubscriptionStatus(targetSubscriptionId);
        const hoursUntilExpiration = (status.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);
        
        if (hoursUntilExpiration > 72) { // More than 72 hours left
          return NextResponse.json({
            success: false,
            message: 'Subscription does not need renewal yet',
            subscription: {
              id: targetSubscriptionId,
              expiresAt: status.expiresAt,
              hoursUntilExpiration: Math.round(hoursUntilExpiration),
            },
            suggestion: 'Use force=true to renew anyway',
          }, { status: 409 });
        }
      } catch (error) {
        // Continue with renewal if we can't check status
        console.warn('Could not check subscription status before renewal:', error);
      }
    }

    // Perform renewal
    const renewedSubscription = await subscriptionManager.renewSubscription(targetSubscriptionId);
    
    const processingTime = Date.now() - startTime;

    // Log successful renewal
    await auditLogger.logEvent(
      'subscription_renewed_via_api',
      'medium',
      {
        user_id: session.user.id,
        subscription_id: targetSubscriptionId,
        account_id: ownershipCheck.accountId,
        new_expiration: renewedSubscription.expirationDateTime,
        forced: force,
        processing_time_ms: processingTime,
        client_ip: clientIP,
      }
    );

    return NextResponse.json({
      success: true,
      message: 'Subscription renewed successfully',
      subscription: {
        id: renewedSubscription.id,
        accountId: ownershipCheck.accountId,
        resource: renewedSubscription.resource,
        expiresAt: renewedSubscription.expirationDateTime,
        notificationUrl: renewedSubscription.notificationUrl,
      },
      processingTime,
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Failed to renew subscription:', error);

    await auditLogger.logEvent(
      'subscription_renewal_failed',
      'high',
      {
        user_id: (await getServerSession(authOptions))?.user?.id,
        subscription_id: subscriptionId,
        account_id: accountId,
        renew_all: renewAll,
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

      if (error.message.includes('not found')) {
        return NextResponse.json({
          error: 'Subscription not found or already deleted',
        }, { status: 404 });
      }

      if (error.message.includes('expired')) {
        return NextResponse.json({
          error: 'Subscription has already expired and cannot be renewed',
          suggestion: 'Create a new subscription instead',
        }, { status: 410 });
      }
    }

    return NextResponse.json({
      error: 'Failed to renew subscription',
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