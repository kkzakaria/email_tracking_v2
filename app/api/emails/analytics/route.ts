/**
 * Email Analytics API Endpoint
 * GET /api/emails/analytics - Get tracking metrics and statistics
 * Phase 2 Critical Implementation
 * Created: 2025-09-05
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { emailTrackingService } from '@/lib/email-tracking-service';
import { auditLogger } from '@/lib/audit-logger';

// ============================================================================
// GET - GET ANALYTICS AND METRICS
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
        'unauthorized_analytics_access',
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

    // Parse date range
    let dateRange: { start: Date; end: Date } | undefined;
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    
    if (startDate || endDate) {
      dateRange = {
        start: startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days ago
        end: endDate ? new Date(endDate) : new Date(),
      };
    }

    // Get metrics and stats in parallel
    const [metrics, stats] = await Promise.all([
      emailTrackingService.getTrackingMetrics(accountId, dateRange),
      emailTrackingService.getTrackingStats(accountId),
    ]);

    // Additional summary calculations
    const summary = {
      totalTracked: metrics.totalTracked,
      responseRate: metrics.responseRate,
      averageResponseTime: metrics.averageResponseTime,
      deliveryRate: metrics.deliveryRate,
      engagementScore: metrics.engagementScore,
      
      // Time-based breakdowns
      last24h: stats.byTimeRange.last24h,
      last7d: stats.byTimeRange.last7d,
      last30d: stats.byTimeRange.last30d,
      
      // Status distribution
      statusDistribution: stats.byStatus,
      
      // Response trends
      responseTrends: {
        averageHours: stats.responseMetrics.averageResponseTimeHours,
        medianHours: stats.responseMetrics.medianResponseTimeHours,
        dailyResponses: stats.responseMetrics.responsesByDay,
      },
    };

    // Performance indicators
    const performanceIndicators = {
      responseRateGrade: getGrade(metrics.responseRate, [
        { min: 80, grade: 'A' },
        { min: 60, grade: 'B' },
        { min: 40, grade: 'C' },
        { min: 20, grade: 'D' },
        { min: 0, grade: 'F' },
      ]),
      
      deliveryRateGrade: getGrade(metrics.deliveryRate, [
        { min: 95, grade: 'A' },
        { min: 90, grade: 'B' },
        { min: 80, grade: 'C' },
        { min: 70, grade: 'D' },
        { min: 0, grade: 'F' },
      ]),
      
      responseSpeedGrade: getResponseSpeedGrade(metrics.averageResponseTime),
      
      overallGrade: getGrade(metrics.engagementScore, [
        { min: 80, grade: 'A' },
        { min: 60, grade: 'B' },
        { min: 40, grade: 'C' },
        { min: 20, grade: 'D' },
        { min: 0, grade: 'F' },
      ]),
    };

    // Insights and recommendations
    const insights = generateInsights(metrics, stats);

    const analyticsData = {
      metrics,
      stats,
      summary,
      performanceIndicators,
      insights,
      account: {
        id: account.id,
        emailAddress: account.email_address,
      },
      dateRange: dateRange || {
        start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        end: new Date(),
      },
      generatedAt: new Date().toISOString(),
    };

    // Log analytics access (sample to avoid spam)
    if (Math.random() < 0.2) { // Log 20% of requests
      await auditLogger.logEvent(
        'analytics_accessed',
        'low',
        {
          user_id: session.user.id,
          account_id: accountId,
          date_range_days: dateRange ? 
            Math.ceil((dateRange.end.getTime() - dateRange.start.getTime()) / (24 * 60 * 60 * 1000)) : 
            30,
          total_tracked: metrics.totalTracked,
          response_rate: metrics.responseRate,
        }
      );
    }

    return NextResponse.json({
      success: true,
      data: analyticsData
    });

  } catch (error) {
    console.error('Failed to get analytics:', error);

    // Log the error
    const session = await getServerSession(authOptions);
    await auditLogger.logEvent(
      'analytics_fetch_failed',
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
          code: 'ANALYTICS_FAILED',
          message: 'Failed to fetch analytics data',
          details: error instanceof Error ? error.message : 'Unknown error',
        }
      },
      { status: 500 }
    );
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function getGrade(value: number, gradeThresholds: Array<{ min: number; grade: string }>) {
  for (const threshold of gradeThresholds) {
    if (value >= threshold.min) {
      return threshold.grade;
    }
  }
  return 'F';
}

function getResponseSpeedGrade(averageHours: number): string {
  if (averageHours <= 2) return 'A'; // Very fast (2 hours or less)
  if (averageHours <= 8) return 'B'; // Fast (same day)
  if (averageHours <= 24) return 'C'; // Good (next day)
  if (averageHours <= 72) return 'D'; // Slow (3 days)
  return 'F'; // Very slow (more than 3 days)
}

function generateInsights(metrics: any, stats: any): Array<{
  type: 'positive' | 'neutral' | 'negative' | 'suggestion';
  title: string;
  message: string;
  value?: number;
}> {
  const insights: Array<{
    type: 'positive' | 'neutral' | 'negative' | 'suggestion';
    title: string;
    message: string;
    value?: number;
  }> = [];

  // Response rate insights
  if (metrics.responseRate > 70) {
    insights.push({
      type: 'positive',
      title: 'Excellent Response Rate',
      message: `Your response rate of ${metrics.responseRate.toFixed(1)}% is well above average.`,
      value: metrics.responseRate,
    });
  } else if (metrics.responseRate < 20) {
    insights.push({
      type: 'negative',
      title: 'Low Response Rate',
      message: `Your response rate of ${metrics.responseRate.toFixed(1)}% could be improved.`,
      value: metrics.responseRate,
    });
    
    insights.push({
      type: 'suggestion',
      title: 'Improve Response Rate',
      message: 'Consider personalizing your subject lines and following up on important emails.',
    });
  }

  // Response time insights
  if (metrics.averageResponseTime > 0) {
    if (metrics.averageResponseTime <= 24) {
      insights.push({
        type: 'positive',
        title: 'Fast Response Times',
        message: `You typically receive responses within ${metrics.averageResponseTime.toFixed(1)} hours.`,
        value: metrics.averageResponseTime,
      });
    } else if (metrics.averageResponseTime > 168) { // More than a week
      insights.push({
        type: 'neutral',
        title: 'Delayed Response Times',
        message: `Average response time is ${Math.round(metrics.averageResponseTime / 24)} days.`,
        value: metrics.averageResponseTime,
      });
    }
  }

  // Delivery insights
  if (metrics.deliveryRate < 95) {
    insights.push({
      type: 'negative',
      title: 'Delivery Issues',
      message: `${(100 - metrics.deliveryRate).toFixed(1)}% of your emails are not being delivered.`,
      value: metrics.deliveryRate,
    });
    
    insights.push({
      type: 'suggestion',
      title: 'Check Email Lists',
      message: 'Review your recipient lists and remove invalid email addresses.',
    });
  }

  // Activity insights
  const recentActivity = stats.byTimeRange.last7d;
  const previousActivity = stats.byTimeRange.last30d - stats.byTimeRange.last7d;
  
  if (recentActivity > previousActivity / 3) {
    insights.push({
      type: 'positive',
      title: 'Increased Activity',
      message: 'Your email tracking activity has increased recently.',
      value: recentActivity,
    });
  } else if (recentActivity === 0) {
    insights.push({
      type: 'neutral',
      title: 'No Recent Activity',
      message: 'No tracked emails in the last 7 days.',
    });
  }

  // Engagement insights
  if (metrics.engagementScore > 80) {
    insights.push({
      type: 'positive',
      title: 'High Engagement',
      message: 'Your emails generate strong engagement from recipients.',
      value: metrics.engagementScore,
    });
  } else if (metrics.engagementScore < 40) {
    insights.push({
      type: 'suggestion',
      title: 'Boost Engagement',
      message: 'Try improving your email subject lines and content to increase engagement.',
    });
  }

  return insights;
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