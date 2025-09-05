/**
 * Microsoft Graph Webhook Health Check Endpoint
 * Email Tracking System - Phase 2 Webhook Monitoring
 * Created: 2025-09-05 for webhook system health monitoring
 * 
 * ⚠️ CRITICAL: This endpoint provides health status and metrics for webhook system
 * Used for monitoring and alerting on webhook processing issues
 */

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { webhookProcessor } from '@/lib/webhook-processor';
import { subscriptionManager } from '@/lib/subscription-manager';
import { auditLogger } from '@/lib/audit-logger';
import { WebhookMetrics, WebhookHealthCheck } from '@/types/microsoft-graph-webhooks';

// ============================================================================
// HEALTH CHECK UTILITIES
// ============================================================================

/**
 * Check database connectivity
 */
async function checkDatabaseHealth(): Promise<WebhookHealthCheck> {
  const startTime = Date.now();
  
  try {
    if (!supabaseAdmin) {
      return {
        endpoint: 'database',
        status: 'unhealthy',
        lastCheck: new Date(),
        responseTime: Date.now() - startTime,
        errorCount: 1,
        lastError: 'Database connection not available',
      };
    }

    // Simple query to test connectivity
    const { error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('id')
      .limit(1);

    return {
      endpoint: 'database',
      status: error ? 'unhealthy' : 'healthy',
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
      errorCount: error ? 1 : 0,
      lastError: error?.message,
    };

  } catch (error) {
    return {
      endpoint: 'database',
      status: 'unhealthy',
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
      errorCount: 1,
      lastError: error instanceof Error ? error.message : 'Unknown database error',
    };
  }
}

/**
 * Check webhook queue health
 */
async function checkQueueHealth(): Promise<WebhookHealthCheck> {
  const startTime = Date.now();
  
  try {
    const queueStats = await webhookProcessor.getQueueStats();
    
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    let errorMessage: string | undefined;

    // Health thresholds
    const maxPendingJobs = parseInt(process.env.WEBHOOK_HEALTH_MAX_PENDING || '100');
    const maxFailedRatio = parseFloat(process.env.WEBHOOK_HEALTH_MAX_FAILED_RATIO || '0.1');
    const maxAvgProcessingTime = parseInt(process.env.WEBHOOK_HEALTH_MAX_PROCESSING_TIME || '30000');

    if (queueStats.pendingJobs > maxPendingJobs) {
      status = 'degraded';
      errorMessage = `High queue backlog: ${queueStats.pendingJobs} pending jobs`;
    }

    if (queueStats.totalJobs > 0) {
      const failedRatio = queueStats.failedJobs / queueStats.totalJobs;
      if (failedRatio > maxFailedRatio) {
        status = status === 'healthy' ? 'degraded' : 'unhealthy';
        errorMessage = `High failure rate: ${(failedRatio * 100).toFixed(1)}%`;
      }
    }

    if (queueStats.averageProcessingTime > maxAvgProcessingTime) {
      status = status === 'healthy' ? 'degraded' : 'unhealthy';
      errorMessage = `Slow processing: ${queueStats.averageProcessingTime}ms average`;
    }

    return {
      endpoint: 'webhook_queue',
      status,
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
      errorCount: status === 'unhealthy' ? 1 : 0,
      lastError: errorMessage,
    };

  } catch (error) {
    return {
      endpoint: 'webhook_queue',
      status: 'unhealthy',
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
      errorCount: 1,
      lastError: error instanceof Error ? error.message : 'Queue health check failed',
    };
  }
}

/**
 * Check subscription health
 */
async function checkSubscriptionHealth(): Promise<WebhookHealthCheck> {
  const startTime = Date.now();
  
  try {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    // Get subscription statistics
    const { data: subscriptions, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('is_active, expires_at, error_count')
      .eq('is_active', true);

    if (error) {
      throw error;
    }

    const now = new Date();
    const expiringThreshold = new Date(now.getTime() + (24 * 60 * 60 * 1000)); // 24 hours
    
    const activeCount = subscriptions?.length || 0;
    const expiringCount = subscriptions?.filter(sub => 
      new Date(sub.expires_at) <= expiringThreshold
    ).length || 0;
    
    const errorCount = subscriptions?.reduce((sum, sub) => sum + (sub.error_count || 0), 0) || 0;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    let errorMessage: string | undefined;

    if (activeCount === 0) {
      status = 'unhealthy';
      errorMessage = 'No active webhook subscriptions';
    } else if (expiringCount > 0) {
      status = 'degraded';
      errorMessage = `${expiringCount} subscription(s) expiring within 24 hours`;
    } else if (errorCount > 0) {
      status = 'degraded';
      errorMessage = `${errorCount} total subscription errors`;
    }

    return {
      endpoint: 'subscriptions',
      status,
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
      errorCount: status === 'unhealthy' ? 1 : 0,
      lastError: errorMessage,
    };

  } catch (error) {
    return {
      endpoint: 'subscriptions',
      status: 'unhealthy',
      lastCheck: new Date(),
      responseTime: Date.now() - startTime,
      errorCount: 1,
      lastError: error instanceof Error ? error.message : 'Subscription health check failed',
    };
  }
}

/**
 * Get comprehensive webhook metrics
 */
async function getWebhookMetrics(): Promise<WebhookMetrics> {
  try {
    const [queueStats, subscriptionStats] = await Promise.all([
      webhookProcessor.getQueueStats(),
      getSubscriptionMetrics(),
    ]);

    // Get recent notification stats from audit logs
    const recentStats = await getRecentNotificationStats();

    let systemHealth: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    
    // Determine overall system health
    if (queueStats.failedJobs > queueStats.completedJobs || subscriptionStats.activeCount === 0) {
      systemHealth = 'unhealthy';
    } else if (queueStats.pendingJobs > 50 || subscriptionStats.expiringCount > 0) {
      systemHealth = 'degraded';
    }

    return {
      totalNotificationsReceived: recentStats.totalReceived,
      notificationsProcessed: queueStats.completedJobs,
      notificationsFailed: queueStats.failedJobs,
      averageProcessingTime: queueStats.averageProcessingTime,
      queueBacklog: queueStats.pendingJobs,
      activeSubscriptions: subscriptionStats.activeCount,
      expiringSubscriptions: subscriptionStats.expiringCount,
      lastNotificationReceived: recentStats.lastNotificationReceived,
      systemHealth,
    };

  } catch (error) {
    console.error('Failed to get webhook metrics:', error);
    return {
      totalNotificationsReceived: 0,
      notificationsProcessed: 0,
      notificationsFailed: 0,
      averageProcessingTime: 0,
      queueBacklog: 0,
      activeSubscriptions: 0,
      expiringSubscriptions: 0,
      systemHealth: 'unhealthy',
    };
  }
}

/**
 * Get subscription metrics
 */
async function getSubscriptionMetrics(): Promise<{
  activeCount: number;
  expiringCount: number;
}> {
  if (!supabaseAdmin) {
    return { activeCount: 0, expiringCount: 0 };
  }

  try {
    const expiringThreshold = new Date(Date.now() + (24 * 60 * 60 * 1000));

    const [activeResult, expiringResult] = await Promise.all([
      supabaseAdmin
        .from('webhook_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true),
      
      supabaseAdmin
        .from('webhook_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('is_active', true)
        .lte('expires_at', expiringThreshold.toISOString()),
    ]);

    return {
      activeCount: activeResult.count || 0,
      expiringCount: expiringResult.count || 0,
    };

  } catch (error) {
    console.error('Failed to get subscription metrics:', error);
    return { activeCount: 0, expiringCount: 0 };
  }
}

/**
 * Get recent notification statistics from audit logs
 */
async function getRecentNotificationStats(): Promise<{
  totalReceived: number;
  lastNotificationReceived?: Date;
}> {
  if (!supabaseAdmin) {
    return { totalReceived: 0 };
  }

  try {
    // Get stats from last 24 hours
    const yesterday = new Date(Date.now() - (24 * 60 * 60 * 1000));

    const { data: recentLogs } = await supabaseAdmin
      .from('audit_logs')
      .select('created_at')
      .eq('action', 'webhook_notifications_received')
      .gte('created_at', yesterday.toISOString())
      .order('created_at', { ascending: false })
      .limit(100);

    return {
      totalReceived: recentLogs?.length || 0,
      lastNotificationReceived: recentLogs?.[0] ? new Date(recentLogs[0].created_at) : undefined,
    };

  } catch (error) {
    console.error('Failed to get notification stats:', error);
    return { totalReceived: 0 };
  }
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

/**
 * GET /api/webhooks/microsoft/health
 * Returns comprehensive webhook system health status
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    // Check if detailed metrics are requested
    const searchParams = request.nextUrl.searchParams;
    const includeMetrics = searchParams.get('metrics') === 'true';
    const includeDetails = searchParams.get('details') === 'true';

    // Run health checks in parallel
    const [databaseHealth, queueHealth, subscriptionHealth] = await Promise.all([
      checkDatabaseHealth(),
      checkQueueHealth(),
      checkSubscriptionHealth(),
    ]);

    const healthChecks = [databaseHealth, queueHealth, subscriptionHealth];
    const overallStatus = healthChecks.some(h => h.status === 'unhealthy') 
      ? 'unhealthy' 
      : healthChecks.some(h => h.status === 'degraded') 
        ? 'degraded' 
        : 'healthy';

    const response: Record<string, unknown> = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      checks: includeDetails ? healthChecks : undefined,
      summary: {
        database: databaseHealth.status,
        queue: queueHealth.status,
        subscriptions: subscriptionHealth.status,
      },
    };

    // Include metrics if requested
    if (includeMetrics) {
      response.metrics = await getWebhookMetrics();
    }

    // Log health check
    await auditLogger.logEvent(
      'webhook_health_check',
      overallStatus === 'unhealthy' ? 'high' : 'low',
      {
        overall_status: overallStatus,
        database_status: databaseHealth.status,
        queue_status: queueHealth.status,
        subscription_status: subscriptionHealth.status,
        response_time_ms: Date.now() - startTime,
        include_metrics: includeMetrics,
      }
    );

    const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 207 : 503;

    return NextResponse.json(response, { status: statusCode });

  } catch (error) {
    console.error('Health check failed:', error);
    
    await auditLogger.logEvent(
      'webhook_health_check_failed',
      'critical',
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        response_time_ms: Date.now() - startTime,
      }
    );

    return NextResponse.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      responseTime: Date.now() - startTime,
      error: 'Health check failed',
    }, { status: 500 });
  }
}