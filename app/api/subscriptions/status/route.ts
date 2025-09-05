/**
 * Webhook Subscription Status Endpoint
 * Email Tracking System - Phase 2 Subscription Management
 * Created: 2025-09-05 for Microsoft Graph subscription status monitoring
 * 
 * ⚠️ CRITICAL: This endpoint provides subscription status and health information
 * Used for monitoring subscription health and expiration
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { supabaseAdmin } from '@/lib/supabase';
import { subscriptionManager } from '@/lib/subscription-manager';
import { rateLimiter } from '@/lib/rate-limiter';
import { auditLogger } from '@/lib/audit-logger';

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/subscriptions/status
 * Get subscription status for user's accounts or specific account/subscription
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const searchParams = request.nextUrl.searchParams;
  const accountId = searchParams.get('accountId');
  const subscriptionId = searchParams.get('subscriptionId');
  const includeAll = searchParams.get('all') === 'true';

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
      `subscription_status_${session.user.id}`,
      'email_read'
    );

    if (!rateLimitResult.allowed) {
      return NextResponse.json({
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((new Date(rateLimitResult.reset_time).getTime() - Date.now()) / 1000),
      }, { status: 429 });
    }

    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    // Handle specific subscription ID query
    if (subscriptionId) {
      // Verify user owns this subscription
      const { data: subscription } = await supabaseAdmin
        .from('webhook_subscriptions')
        .select(`
          *,
          email_accounts!inner(user_id)
        `)
        .eq('microsoft_subscription_id', subscriptionId)
        .eq('email_accounts.user_id', session.user.id)
        .single();

      if (!subscription) {
        return NextResponse.json({
          error: 'Subscription not found or access denied',
        }, { status: 404 });
      }

      try {
        const status = await subscriptionManager.getSubscriptionStatus(subscriptionId);
        
        return NextResponse.json({
          success: true,
          subscription: {
            id: status.microsoftSubscriptionId,
            accountId: status.accountId,
            resource: status.resource,
            isActive: status.isActive,
            expiresAt: status.expiresAt,
            createdAt: status.createdAt,
            lastRenewedAt: status.lastRenewedAt,
            errorCount: status.errorCount,
            lastError: status.lastError,
            nextRenewalCheck: status.nextRenewalCheck,
            hoursUntilExpiration: Math.max(0, (status.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)),
          },
        });

      } catch (error) {
        console.error(`Failed to get status for subscription ${subscriptionId}:`, error);
        return NextResponse.json({
          error: 'Failed to get subscription status',
        }, { status: 500 });
      }
    }

    // Handle specific account ID query
    if (accountId) {
      // Verify user owns this account
      const { data: account } = await supabaseAdmin
        .from('email_accounts')
        .select('id, email_address')
        .eq('id', accountId)
        .eq('user_id', session.user.id)
        .single();

      if (!account) {
        return NextResponse.json({
          error: 'Account not found or access denied',
        }, { status: 404 });
      }

      try {
        const subscriptions = await subscriptionManager.getAccountSubscriptions(accountId);
        
        const formattedSubscriptions = subscriptions.map(sub => ({
          id: sub.microsoftSubscriptionId,
          accountId: sub.accountId,
          resource: sub.resource,
          isActive: sub.isActive,
          expiresAt: sub.expiresAt,
          createdAt: sub.createdAt,
          lastRenewedAt: sub.lastRenewedAt,
          errorCount: sub.errorCount,
          lastError: sub.lastError,
          hoursUntilExpiration: Math.max(0, (sub.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)),
        }));

        return NextResponse.json({
          success: true,
          account: {
            id: account.id,
            email: account.email_address,
            subscriptionCount: formattedSubscriptions.length,
            activeSubscriptionCount: formattedSubscriptions.filter(s => s.isActive).length,
          },
          subscriptions: formattedSubscriptions,
        });

      } catch (error) {
        console.error(`Failed to get subscriptions for account ${accountId}:`, error);
        return NextResponse.json({
          error: 'Failed to get account subscriptions',
        }, { status: 500 });
      }
    }

    // Get all user's account subscriptions
    const { data: userAccounts, error: accountsError } = await supabaseAdmin
      .from('email_accounts')
      .select('id, email_address, is_active')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false });

    if (accountsError) {
      throw new Error(`Failed to fetch user accounts: ${accountsError.message}`);
    }

    if (!userAccounts || userAccounts.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No email accounts found',
        accounts: [],
        summary: {
          totalAccounts: 0,
          activeAccounts: 0,
          totalSubscriptions: 0,
          activeSubscriptions: 0,
          expiringSubscriptions: 0,
        },
      });
    }

    // Get subscriptions for each account
    const accountsWithSubscriptions = await Promise.all(
      userAccounts.map(async (account) => {
        try {
          const subscriptions = await subscriptionManager.getAccountSubscriptions(account.id);
          
          const formattedSubscriptions = subscriptions.map(sub => ({
            id: sub.microsoftSubscriptionId,
            resource: sub.resource,
            isActive: sub.isActive,
            expiresAt: sub.expiresAt,
            createdAt: sub.createdAt,
            lastRenewedAt: sub.lastRenewedAt,
            errorCount: sub.errorCount,
            lastError: sub.lastError,
            hoursUntilExpiration: Math.max(0, (sub.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60)),
          }));

          return {
            id: account.id,
            email: account.email_address,
            isActive: account.is_active,
            subscriptions: includeAll ? formattedSubscriptions : formattedSubscriptions.filter(s => s.isActive),
            subscriptionCount: formattedSubscriptions.length,
            activeSubscriptionCount: formattedSubscriptions.filter(s => s.isActive).length,
          };

        } catch (error) {
          console.error(`Failed to get subscriptions for account ${account.id}:`, error);
          return {
            id: account.id,
            email: account.email_address,
            isActive: account.is_active,
            subscriptions: [],
            subscriptionCount: 0,
            activeSubscriptionCount: 0,
            error: 'Failed to fetch subscriptions',
          };
        }
      })
    );

    // Calculate summary statistics
    const summary = {
      totalAccounts: userAccounts.length,
      activeAccounts: userAccounts.filter(a => a.is_active).length,
      totalSubscriptions: accountsWithSubscriptions.reduce((sum, acc) => sum + acc.subscriptionCount, 0),
      activeSubscriptions: accountsWithSubscriptions.reduce((sum, acc) => sum + acc.activeSubscriptionCount, 0),
      expiringSubscriptions: accountsWithSubscriptions.reduce((sum, acc) => {
        const expiringSoon = acc.subscriptions.filter(sub => 
          sub.isActive && sub.hoursUntilExpiration <= 48
        ).length;
        return sum + expiringSoon;
      }, 0),
    };

    const processingTime = Date.now() - startTime;

    // Log status check
    await auditLogger.logEvent(
      'subscription_status_checked',
      'low',
      {
        user_id: session.user.id,
        account_id: accountId,
        subscription_id: subscriptionId,
        include_all: includeAll,
        total_accounts: summary.totalAccounts,
        active_subscriptions: summary.activeSubscriptions,
        processing_time_ms: processingTime,
      }
    );

    return NextResponse.json({
      success: true,
      accounts: accountsWithSubscriptions,
      summary,
      processingTime,
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    console.error('Failed to get subscription status:', error);

    await auditLogger.logEvent(
      'subscription_status_check_failed',
      'medium',
      {
        user_id: (await getServerSession(authOptions))?.user?.id,
        account_id: accountId,
        subscription_id: subscriptionId,
        error: error instanceof Error ? error.message : 'Unknown error',
        processing_time_ms: processingTime,
      }
    );

    return NextResponse.json({
      error: 'Failed to get subscription status',
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
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}