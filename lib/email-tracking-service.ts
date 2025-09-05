/**
 * Email Tracking Service - Core Email Tracking Engine
 * Email Tracking System - Phase 2 Critical Implementation
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This service handles the main email tracking functionality
 * Integrates with webhook pipeline and provides real-time tracking updates
 */

import { supabaseAdmin } from './supabase';
import { auditLogger } from './audit-logger';
import { createGraphClient } from './microsoft-graph-client';
import { rateLimiter } from './rate-limiter';
import { webhookProcessor } from './webhook-processor';
import {
  EmailTrackingService,
  TrackedEmail,
  TrackedEmailFilters,
  TrackedEmailsResponse,
  EmailTrackingMetrics,
  EmailTrackingStats,
  EmailIngestionResult,
  EmailIngestionOptions,
  EmailTrackingStatus,
  EmailTrackingError,
  EmailIngestionError,
  GraphEmail
} from '@/types/email-tracking';
import { TrackingStatusEnum } from '@/types/database';

// ============================================================================
// CONFIGURATION
// ============================================================================

const EMAIL_TRACKING_CONFIG = {
  maxAgeDays: parseInt(process.env.EMAIL_TRACKING_MAX_AGE_DAYS || '30'),
  syncIntervalMinutes: parseInt(process.env.EMAIL_TRACKING_SYNC_INTERVAL_MINUTES || '15'),
  batchSize: parseInt(process.env.EMAIL_TRACKING_BATCH_SIZE || '50'),
  autoTrackOutbound: process.env.EMAIL_AUTO_TRACK_OUTBOUND === 'true',
  responseDetection: {
    confidenceThreshold: parseFloat(process.env.RESPONSE_DETECTION_CONFIDENCE_THRESHOLD || '0.8'),
    autoReplyFilter: process.env.RESPONSE_DETECTION_AUTO_REPLY_FILTER === 'true',
    maxThreadDepth: parseInt(process.env.RESPONSE_DETECTION_MAX_THREAD_DEPTH || '10'),
  },
} as const;

// ============================================================================
// EMAIL TRACKING SERVICE CLASS
// ============================================================================

export class EmailTrackingEngine implements EmailTrackingService {
  private syncInProgress = new Set<string>(); // Track accounts being synced

  /**
   * Start tracking an email by message ID
   * @param accountId - Email account ID
   * @param messageId - Microsoft Graph message ID
   * @returns Tracked email record
   */
  async startTracking(accountId: string, messageId: string): Promise<TrackedEmail> {
    try {
      if (!supabaseAdmin) {
        throw new EmailTrackingError('Database not available', 'DATABASE_ERROR', accountId);
      }

      // Check if already being tracked
      const { data: existingEmail } = await supabaseAdmin
        .from('tracked_emails')
        .select('*')
        .eq('email_account_id', accountId)
        .eq('message_id', messageId)
        .single();

      if (existingEmail) {
        return this.mapDbToTrackedEmail(existingEmail);
      }

      // Get email details from Microsoft Graph
      const graphClient = createGraphClient(accountId);
      const emailDetails = await graphClient.callAPI<GraphEmail>(
        `/me/messages/${messageId}`,
        'GET',
        undefined,
        { '$select': 'id,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,bodyPreview,conversationId,isDraft' }
      );

      if (emailDetails.isDraft) {
        throw new EmailTrackingError('Cannot track draft emails', 'DRAFT_EMAIL', accountId, messageId);
      }

      // Create tracked email record
      const trackedEmailData = {
        email_account_id: accountId,
        message_id: messageId,
        conversation_id: emailDetails.conversationId,
        subject: emailDetails.subject || 'No Subject',
        from_email: emailDetails.from?.emailAddress?.address || '',
        from_name: emailDetails.from?.emailAddress?.name,
        to_emails: emailDetails.toRecipients?.map(r => r.emailAddress.address) || [],
        cc_emails: emailDetails.ccRecipients?.length ? emailDetails.ccRecipients.map(r => r.emailAddress.address) : null,
        bcc_emails: emailDetails.bccRecipients?.length ? emailDetails.bccRecipients.map(r => r.emailAddress.address) : null,
        body_preview: emailDetails.bodyPreview,
        sent_at: emailDetails.sentDateTime || new Date().toISOString(),
        tracking_status: 'active' as TrackingStatusEnum,
        has_response: false,
        response_count: 0,
      };

      const { data: trackedEmail, error } = await supabaseAdmin
        .from('tracked_emails')
        .insert([trackedEmailData])
        .select()
        .single();

      if (error) {
        throw new EmailTrackingError(`Failed to create tracked email: ${error.message}`, 'CREATE_ERROR', accountId, messageId);
      }

      // Log tracking start
      await auditLogger.logEvent(
        'email_tracking_started',
        'medium',
        {
          tracked_email_id: trackedEmail.id,
          account_id: accountId,
          message_id: messageId,
          subject: trackedEmail.subject,
          recipient_count: trackedEmailData.to_emails.length,
        }
      );

      return this.mapDbToTrackedEmail(trackedEmail);

    } catch (error) {
      console.error(`Failed to start tracking email ${messageId}:`, error);
      
      if (error instanceof EmailTrackingError) {
        throw error;
      }
      
      throw new EmailTrackingError(
        'Failed to start email tracking',
        'TRACKING_START_ERROR',
        accountId,
        messageId,
        true
      );
    }
  }

  /**
   * Stop tracking an email
   * @param emailId - Tracked email ID
   */
  async stopTracking(emailId: string): Promise<void> {
    try {
      if (!supabaseAdmin) {
        throw new EmailTrackingError('Database not available', 'DATABASE_ERROR');
      }

      const { error } = await supabaseAdmin
        .from('tracked_emails')
        .update({
          tracking_status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', emailId);

      if (error) {
        throw new EmailTrackingError(`Failed to stop tracking: ${error.message}`, 'STOP_ERROR', undefined, emailId);
      }

      await auditLogger.logEvent(
        'email_tracking_stopped',
        'low',
        {
          tracked_email_id: emailId,
          stopped_at: new Date().toISOString(),
        }
      );

    } catch (error) {
      console.error(`Failed to stop tracking email ${emailId}:`, error);
      
      if (error instanceof EmailTrackingError) {
        throw error;
      }
      
      throw new EmailTrackingError('Failed to stop tracking', 'STOP_TRACKING_ERROR', undefined, emailId);
    }
  }

  /**
   * Get a tracked email by ID
   * @param emailId - Tracked email ID
   * @returns Tracked email or null
   */
  async getTrackedEmail(emailId: string): Promise<TrackedEmail | null> {
    try {
      if (!supabaseAdmin) {
        return null;
      }

      const { data: trackedEmail, error } = await supabaseAdmin
        .from('tracked_emails')
        .select(`
          *,
          email_responses (
            id,
            from_email,
            from_name,
            subject,
            received_at,
            is_auto_reply,
            confidence_score
          )
        `)
        .eq('id', emailId)
        .single();

      if (error || !trackedEmail) {
        return null;
      }

      return this.mapDbToTrackedEmail(trackedEmail);

    } catch (error) {
      console.error(`Failed to get tracked email ${emailId}:`, error);
      return null;
    }
  }

  /**
   * Get tracked emails with filtering and pagination
   * @param accountId - Email account ID
   * @param filters - Filtering options
   * @returns Paginated tracked emails
   */
  async getTrackedEmails(accountId: string, filters?: TrackedEmailFilters): Promise<TrackedEmailsResponse> {
    try {
      if (!supabaseAdmin) {
        throw new EmailTrackingError('Database not available', 'DATABASE_ERROR', accountId);
      }

      let query = supabaseAdmin
        .from('tracked_emails')
        .select(`
          *,
          email_responses (
            id,
            from_email,
            received_at,
            is_auto_reply
          )
        `, { count: 'exact' })
        .eq('email_account_id', accountId);

      // Apply filters
      if (filters?.status) {
        if (Array.isArray(filters.status)) {
          query = query.in('tracking_status', filters.status);
        } else {
          query = query.eq('tracking_status', filters.status);
        }
      }

      if (filters?.hasResponse !== undefined) {
        query = query.eq('has_response', filters.hasResponse);
      }

      if (filters?.dateRange) {
        query = query.gte('sent_at', filters.dateRange.start.toISOString())
                    .lte('sent_at', filters.dateRange.end.toISOString());
      }

      if (filters?.searchQuery) {
        query = query.or(`subject.ilike.%${filters.searchQuery}%,to_emails.cs.{${filters.searchQuery}}`);
      }

      // Apply sorting
      const sortBy = filters?.sortBy || 'sent_at';
      const sortOrder = filters?.sortOrder || 'desc';
      query = query.order(sortBy, { ascending: sortOrder === 'asc' });

      // Apply pagination
      const limit = filters?.limit || 20;
      const offset = filters?.offset || 0;
      query = query.range(offset, offset + limit - 1);

      const { data: emails, error, count } = await query;

      if (error) {
        throw new EmailTrackingError(`Failed to fetch tracked emails: ${error.message}`, 'FETCH_ERROR', accountId);
      }

      const mappedEmails = (emails || []).map(email => this.mapDbToTrackedEmail(email));
      const total = count || 0;
      const pageSize = limit;
      const page = Math.floor(offset / pageSize) + 1;

      return {
        data: mappedEmails,
        pagination: {
          total,
          page,
          pageSize,
          hasNext: offset + pageSize < total,
          hasPrev: offset > 0,
        },
        filters: filters || {},
      };

    } catch (error) {
      console.error(`Failed to get tracked emails for account ${accountId}:`, error);
      
      if (error instanceof EmailTrackingError) {
        throw error;
      }
      
      throw new EmailTrackingError('Failed to fetch tracked emails', 'FETCH_EMAILS_ERROR', accountId);
    }
  }

  /**
   * Sync account emails from Microsoft Graph
   * @param accountId - Email account ID
   * @param options - Ingestion options
   * @returns Ingestion result
   */
  async syncAccountEmails(accountId: string, options?: EmailIngestionOptions): Promise<EmailIngestionResult> {
    const startTime = new Date();
    
    try {
      if (!supabaseAdmin) {
        throw new EmailIngestionError('Database not available', accountId, 0);
      }

      // Check if sync already in progress
      if (this.syncInProgress.has(accountId)) {
        throw new EmailIngestionError('Sync already in progress for this account', accountId, 0);
      }

      this.syncInProgress.add(accountId);

      const batchSize = options?.batchSize || EMAIL_TRACKING_CONFIG.batchSize;
      const since = options?.since || new Date(Date.now() - 24 * 60 * 60 * 1000); // Last 24 hours default

      let processedCount = 0;
      let newTrackedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;
      const errors: Array<{ messageId: string; error: string; retryable: boolean }> = [];

      // Get sent emails from Microsoft Graph
      const graphClient = createGraphClient(accountId);
      
      // Check rate limits before making calls
      const rateLimitCheck = await rateLimiter.checkAndRecord(accountId, 'email_read');
      if (!rateLimitCheck.allowed) {
        throw new EmailIngestionError('Rate limit exceeded', accountId, batchSize);
      }

      const messagesResponse = await graphClient.getMessages({
        $top: batchSize,
        $filter: `sentDateTime ge ${since.toISOString()} and isDraft eq false`,
        $select: 'id,subject,from,toRecipients,ccRecipients,sentDateTime,bodyPreview,conversationId,isDraft',
        $orderby: 'sentDateTime desc'
      });

      const emails = messagesResponse.value as GraphEmail[] || [];
      
      // Get account email to identify outbound emails
      const accountEmailResponse = await graphClient.getUser();
      const accountEmail = accountEmailResponse.mail || accountEmailResponse.userPrincipalName;

      for (const email of emails) {
        try {
          processedCount++;

          // Check if this is an outbound email
          const fromEmail = email.from?.emailAddress?.address?.toLowerCase();
          
          if (fromEmail !== accountEmail?.toLowerCase()) {
            skippedCount++;
            continue; // Skip inbound emails
          }

          // Check if already tracked
          const { data: existingEmail } = await supabaseAdmin
            .from('tracked_emails')
            .select('id')
            .eq('email_account_id', accountId)
            .eq('message_id', email.id)
            .single();

          if (existingEmail && !options?.forceRefresh) {
            skippedCount++;
            continue;
          }

          // Create or update tracked email
          if (EMAIL_TRACKING_CONFIG.autoTrackOutbound) {
            try {
              await this.startTracking(accountId, email.id);
              newTrackedCount++;
            } catch (trackingError) {
              errorCount++;
              errors.push({
                messageId: email.id,
                error: trackingError instanceof Error ? trackingError.message : 'Unknown error',
                retryable: true,
              });
            }
          }

        } catch (emailError) {
          errorCount++;
          errors.push({
            messageId: email.id,
            error: emailError instanceof Error ? emailError.message : 'Unknown error',
            retryable: true,
          });
        }
      }

      const result: EmailIngestionResult = {
        success: errorCount === 0,
        processedCount,
        newTrackedCount,
        skippedCount,
        errorCount,
        errors,
        startTime,
        endTime: new Date(),
      };

      // Log sync completion
      await auditLogger.logEvent(
        'email_sync_completed',
        errorCount > 0 ? 'medium' : 'low',
        {
          account_id: accountId,
          processed_count: processedCount,
          new_tracked_count: newTrackedCount,
          error_count: errorCount,
          duration_ms: result.endTime.getTime() - result.startTime.getTime(),
        }
      );

      return result;

    } catch (error) {
      const endTime = new Date();
      console.error(`Email sync failed for account ${accountId}:`, error);

      await auditLogger.logEvent(
        'email_sync_failed',
        'high',
        {
          account_id: accountId,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration_ms: endTime.getTime() - startTime.getTime(),
        }
      );

      if (error instanceof EmailIngestionError) {
        throw error;
      }

      throw new EmailIngestionError(
        `Email sync failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        accountId,
        options?.batchSize || EMAIL_TRACKING_CONFIG.batchSize,
        error instanceof Error ? error : undefined
      );

    } finally {
      this.syncInProgress.delete(accountId);
    }
  }

  /**
   * Update tracking status for an email
   * @param emailId - Tracked email ID
   * @param status - New tracking status
   */
  async updateTrackingStatus(emailId: string, status: EmailTrackingStatus): Promise<void> {
    try {
      if (!supabaseAdmin) {
        throw new EmailTrackingError('Database not available', 'DATABASE_ERROR');
      }

      const { error } = await supabaseAdmin
        .from('tracked_emails')
        .update({
          tracking_status: status as TrackingStatusEnum,
          updated_at: new Date().toISOString(),
        })
        .eq('id', emailId);

      if (error) {
        throw new EmailTrackingError(`Failed to update status: ${error.message}`, 'STATUS_UPDATE_ERROR', undefined, emailId);
      }

      await auditLogger.logEvent(
        'email_status_updated',
        'low',
        {
          tracked_email_id: emailId,
          new_status: status,
          updated_at: new Date().toISOString(),
        }
      );

    } catch (error) {
      console.error(`Failed to update tracking status for email ${emailId}:`, error);
      
      if (error instanceof EmailTrackingError) {
        throw error;
      }
      
      throw new EmailTrackingError('Failed to update tracking status', 'STATUS_UPDATE_ERROR', undefined, emailId);
    }
  }

  /**
   * Get tracking metrics for an account
   * @param accountId - Email account ID
   * @param dateRange - Optional date range filter
   * @returns Email tracking metrics
   */
  async getTrackingMetrics(accountId: string, dateRange?: { start: Date; end: Date }): Promise<EmailTrackingMetrics> {
    try {
      if (!supabaseAdmin) {
        throw new EmailTrackingError('Database not available', 'DATABASE_ERROR', accountId);
      }

      const periodStart = dateRange?.start || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
      const periodEnd = dateRange?.end || new Date();

      // Get basic stats
      const { data: stats } = await supabaseAdmin
        .from('tracked_emails')
        .select('tracking_status, has_response, sent_at, last_response_at')
        .eq('email_account_id', accountId)
        .gte('sent_at', periodStart.toISOString())
        .lte('sent_at', periodEnd.toISOString());

      if (!stats || stats.length === 0) {
        return {
          totalTracked: 0,
          responseRate: 0,
          averageResponseTime: 0,
          bounceRate: 0,
          deliveryRate: 0,
          engagementScore: 0,
          periodStart,
          periodEnd,
        };
      }

      const totalTracked = stats.length;
      const withResponse = stats.filter(s => s.has_response);
      const responseRate = totalTracked > 0 ? (withResponse.length / totalTracked) * 100 : 0;

      // Calculate average response time
      let totalResponseTimeHours = 0;
      let responseTimeCount = 0;

      withResponse.forEach(email => {
        if (email.last_response_at && email.sent_at) {
          const sentAt = new Date(email.sent_at);
          const respondedAt = new Date(email.last_response_at);
          const responseTimeHours = (respondedAt.getTime() - sentAt.getTime()) / (1000 * 60 * 60);
          totalResponseTimeHours += responseTimeHours;
          responseTimeCount++;
        }
      });

      const averageResponseTime = responseTimeCount > 0 ? totalResponseTimeHours / responseTimeCount : 0;

      // Calculate other metrics
      const deliveredEmails = stats.filter(s => s.tracking_status !== 'failed');
      const deliveryRate = totalTracked > 0 ? (deliveredEmails.length / totalTracked) * 100 : 0;
      const bounceRate = 100 - deliveryRate;

      // Simple engagement score calculation
      const engagementScore = Math.min(100, responseRate * 0.7 + deliveryRate * 0.3);

      return {
        totalTracked,
        responseRate,
        averageResponseTime,
        bounceRate,
        deliveryRate,
        engagementScore,
        periodStart,
        periodEnd,
      };

    } catch (error) {
      console.error(`Failed to get tracking metrics for account ${accountId}:`, error);
      throw new EmailTrackingError('Failed to get tracking metrics', 'METRICS_ERROR', accountId);
    }
  }

  /**
   * Get detailed tracking statistics
   * @param accountId - Email account ID
   * @returns Detailed tracking statistics
   */
  async getTrackingStats(accountId: string): Promise<EmailTrackingStats> {
    try {
      if (!supabaseAdmin) {
        throw new EmailTrackingError('Database not available', 'DATABASE_ERROR', accountId);
      }

      // Get status counts
      const { data: statusData } = await supabaseAdmin
        .from('tracked_emails')
        .select('tracking_status, sent_at, last_response_at')
        .eq('email_account_id', accountId);

      if (!statusData) {
        throw new EmailTrackingError('Failed to fetch stats data', 'STATS_ERROR', accountId);
      }

      // Count by status
      const byStatus = statusData.reduce((acc, email) => {
        const status = email.tracking_status as EmailTrackingStatus;
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {} as Record<EmailTrackingStatus, number>);

      // Ensure all statuses have a count
      Object.values(EmailTrackingStatus).forEach(status => {
        if (!(status in byStatus)) {
          byStatus[status] = 0;
        }
      });

      // Time range counts
      const now = new Date();
      const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const last30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      const byTimeRange = {
        last24h: statusData.filter(e => new Date(e.sent_at) >= last24h).length,
        last7d: statusData.filter(e => new Date(e.sent_at) >= last7d).length,
        last30d: statusData.filter(e => new Date(e.sent_at) >= last30d).length,
        allTime: statusData.length,
      };

      // Response metrics
      const responseTimes = statusData
        .filter(e => e.last_response_at)
        .map(e => {
          const sentAt = new Date(e.sent_at);
          const respondedAt = new Date(e.last_response_at!);
          return (respondedAt.getTime() - sentAt.getTime()) / (1000 * 60 * 60); // hours
        })
        .sort((a, b) => a - b);

      const averageResponseTimeHours = responseTimes.length > 0 
        ? responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length 
        : 0;

      const medianResponseTimeHours = responseTimes.length > 0
        ? responseTimes[Math.floor(responseTimes.length / 2)]
        : 0;

      // Responses by day (last 30 days)
      const responsesByDay: Array<{ date: string; count: number }> = [];
      for (let i = 29; i >= 0; i--) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateStr = date.toISOString().split('T')[0];
        const count = statusData.filter(e => {
          if (!e.last_response_at) return false;
          const responseDate = new Date(e.last_response_at).toISOString().split('T')[0];
          return responseDate === dateStr;
        }).length;
        responsesByDay.push({ date: dateStr, count });
      }

      return {
        byStatus,
        byTimeRange,
        responseMetrics: {
          averageResponseTimeHours,
          medianResponseTimeHours,
          responsesByDay,
        },
      };

    } catch (error) {
      console.error(`Failed to get tracking stats for account ${accountId}:`, error);
      throw new EmailTrackingError('Failed to get tracking stats', 'STATS_ERROR', accountId);
    }
  }

  /**
   * Map database record to TrackedEmail type
   * @param dbRecord - Database record
   * @returns Mapped TrackedEmail
   */
  private mapDbToTrackedEmail(dbRecord: any): TrackedEmail {
    const sentAt = new Date(dbRecord.sent_at);
    const lastResponseAt = dbRecord.last_response_at ? new Date(dbRecord.last_response_at) : undefined;
    
    let responseTimeHours: number | undefined;
    if (lastResponseAt) {
      responseTimeHours = (lastResponseAt.getTime() - sentAt.getTime()) / (1000 * 60 * 60);
    }

    // Simple engagement score calculation
    const engagementScore = dbRecord.has_response ? 
      Math.min(100, 70 + (dbRecord.response_count * 10)) : 
      (dbRecord.tracking_status === 'active' ? 30 : 10);

    return {
      id: dbRecord.id,
      emailAccountId: dbRecord.email_account_id,
      messageId: dbRecord.message_id,
      conversationId: dbRecord.conversation_id,
      threadId: dbRecord.thread_id,
      subject: dbRecord.subject,
      fromEmail: dbRecord.from_email,
      fromName: dbRecord.from_name,
      toEmails: dbRecord.to_emails,
      ccEmails: dbRecord.cc_emails,
      bccEmails: dbRecord.bcc_emails,
      bodyPreview: dbRecord.body_preview,
      sentAt,
      hasResponse: dbRecord.has_response,
      lastResponseAt,
      responseCount: dbRecord.response_count,
      trackingStatus: dbRecord.tracking_status,
      followUpRuleId: dbRecord.follow_up_rule_id,
      createdAt: new Date(dbRecord.created_at),
      updatedAt: new Date(dbRecord.updated_at),
      responseTimeHours,
      isOverdue: dbRecord.tracking_status === 'active' && !dbRecord.has_response && 
                (Date.now() - sentAt.getTime()) > (7 * 24 * 60 * 60 * 1000), // 7 days
      engagementScore,
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const emailTrackingService = new EmailTrackingEngine();

// Export for convenience
export { EmailTrackingEngine as default };