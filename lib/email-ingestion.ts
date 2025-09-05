/**
 * Email Ingestion Engine - Automated Email Retrieval and Processing
 * Email Tracking System - Phase 2 Critical Implementation
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This service handles periodic email ingestion from Microsoft Graph
 * Integrates with rate limiting and automatic tracking
 */

import { supabaseAdmin } from './supabase';
import { auditLogger } from './audit-logger';
import { createGraphClient } from './microsoft-graph-client';
import { rateLimiter } from './rate-limiter';
import { emailTrackingService } from './email-tracking-service';
import {
  EmailIngestionOptions,
  EmailIngestionResult,
  EmailIngestionError,
  GraphEmail,
  EmailOperations
} from '@/types/email-tracking';

// ============================================================================
// CONFIGURATION
// ============================================================================

const INGESTION_CONFIG = {
  defaultBatchSize: parseInt(process.env.EMAIL_INGESTION_BATCH_SIZE || '50'),
  maxBatchSize: parseInt(process.env.EMAIL_INGESTION_MAX_BATCH_SIZE || '200'),
  defaultLookbackHours: parseInt(process.env.EMAIL_INGESTION_LOOKBACK_HOURS || '24'),
  maxLookbackDays: parseInt(process.env.EMAIL_INGESTION_MAX_LOOKBACK_DAYS || '30'),
  maxConcurrentAccounts: parseInt(process.env.EMAIL_INGESTION_MAX_CONCURRENT || '5'),
  retryDelayMs: parseInt(process.env.EMAIL_INGESTION_RETRY_DELAY_MS || '5000'),
  maxRetries: parseInt(process.env.EMAIL_INGESTION_MAX_RETRIES || '3'),
  deduplicationEnabled: process.env.EMAIL_INGESTION_DEDUPLICATION_ENABLED !== 'false',
} as const;

// ============================================================================
// EMAIL INGESTION ENGINE CLASS
// ============================================================================

export class EmailIngestionEngine implements EmailOperations {
  private ingestionInProgress = new Set<string>(); // Track accounts being processed
  private retryQueue = new Map<string, { count: number; nextRetry: Date }>(); // Retry tracking

  /**
   * Get recent sent emails from Microsoft Graph
   * @param accountId - Email account ID
   * @param since - Date to retrieve emails since
   * @returns Array of Graph emails
   */
  async getRecentSentEmails(accountId: string, since?: Date): Promise<GraphEmail[]> {
    try {
      const graphClient = createGraphClient(accountId);
      const sinceDate = since || new Date(Date.now() - INGESTION_CONFIG.defaultLookbackHours * 60 * 60 * 1000);
      
      // Check rate limits
      const rateLimitResult = await rateLimiter.checkAndRecord(accountId, 'email_read');
      if (!rateLimitResult.allowed) {
        throw new EmailIngestionError(
          `Rate limit exceeded: ${rateLimitResult.current_count}/${rateLimitResult.limit}`,
          accountId,
          INGESTION_CONFIG.defaultBatchSize
        );
      }

      const response = await graphClient.getMessages({
        $top: INGESTION_CONFIG.defaultBatchSize,
        $filter: `sentDateTime ge ${sinceDate.toISOString()} and isDraft eq false`,
        $select: 'id,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,bodyPreview,conversationId,isDraft,isRead',
        $orderby: 'sentDateTime desc'
      });

      return (response.value as GraphEmail[]) || [];

    } catch (error) {
      console.error(`Failed to get recent sent emails for account ${accountId}:`, error);
      throw new EmailIngestionError(
        `Failed to retrieve emails: ${error instanceof Error ? error.message : 'Unknown error'}`,
        accountId,
        INGESTION_CONFIG.defaultBatchSize,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get detailed email information
   * @param accountId - Email account ID
   * @param messageId - Microsoft Graph message ID
   * @returns Detailed email information
   */
  async getEmailDetails(accountId: string, messageId: string): Promise<GraphEmail> {
    try {
      const graphClient = createGraphClient(accountId);
      
      // Check rate limits
      const rateLimitResult = await rateLimiter.checkAndRecord(accountId, 'email_read');
      if (!rateLimitResult.allowed) {
        throw new EmailIngestionError(
          `Rate limit exceeded: ${rateLimitResult.current_count}/${rateLimitResult.limit}`,
          accountId,
          1
        );
      }

      const email = await graphClient.callAPI<GraphEmail>(
        `/me/messages/${messageId}`,
        'GET',
        undefined,
        {
          '$select': 'id,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,bodyPreview,conversationId,isDraft,isRead'
        }
      );

      return email;

    } catch (error) {
      console.error(`Failed to get email details ${messageId} for account ${accountId}:`, error);
      throw new EmailIngestionError(
        `Failed to get email details: ${error instanceof Error ? error.message : 'Unknown error'}`,
        accountId,
        1,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Search emails in a conversation thread
   * @param accountId - Email account ID
   * @param threadId - Thread/conversation ID
   * @returns Array of emails in the thread
   */
  async searchEmailThread(accountId: string, threadId: string): Promise<GraphEmail[]> {
    try {
      const graphClient = createGraphClient(accountId);
      
      // Check rate limits
      const rateLimitResult = await rateLimiter.checkAndRecord(accountId, 'email_read');
      if (!rateLimitResult.allowed) {
        throw new EmailIngestionError(
          `Rate limit exceeded: ${rateLimitResult.current_count}/${rateLimitResult.limit}`,
          accountId,
          INGESTION_CONFIG.defaultBatchSize
        );
      }

      const response = await graphClient.getMessages({
        $filter: `conversationId eq '${threadId}'`,
        $select: 'id,subject,from,toRecipients,sentDateTime,receivedDateTime,bodyPreview,conversationId',
        $orderby: 'receivedDateTime asc',
        $top: INGESTION_CONFIG.defaultBatchSize
      });

      return (response.value as GraphEmail[]) || [];

    } catch (error) {
      console.error(`Failed to search email thread ${threadId} for account ${accountId}:`, error);
      throw new EmailIngestionError(
        `Failed to search thread: ${error instanceof Error ? error.message : 'Unknown error'}`,
        accountId,
        INGESTION_CONFIG.defaultBatchSize,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Update email properties in Microsoft Graph
   * @param accountId - Email account ID
   * @param messageId - Microsoft Graph message ID
   * @param properties - Properties to update
   */
  async updateEmailProperties(accountId: string, messageId: string, properties: Record<string, unknown>): Promise<void> {
    try {
      const graphClient = createGraphClient(accountId);
      
      // Check rate limits for bulk operation
      const rateLimitResult = await rateLimiter.checkAndRecord(accountId, 'bulk_operation');
      if (!rateLimitResult.allowed) {
        throw new EmailIngestionError(
          `Rate limit exceeded: ${rateLimitResult.current_count}/${rateLimitResult.limit}`,
          accountId,
          1
        );
      }

      await graphClient.callAPI(
        `/me/messages/${messageId}`,
        'PATCH',
        properties
      );

      await auditLogger.logEvent(
        'email_properties_updated',
        'low',
        {
          account_id: accountId,
          message_id: messageId,
          properties: Object.keys(properties),
        }
      );

    } catch (error) {
      console.error(`Failed to update email properties ${messageId} for account ${accountId}:`, error);
      throw new EmailIngestionError(
        `Failed to update email properties: ${error instanceof Error ? error.message : 'Unknown error'}`,
        accountId,
        1,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Get emails with batch processing and pagination
   * @param accountId - Email account ID
   * @param options - Ingestion options
   * @returns Batch of emails with pagination info
   */
  async getEmailsBatch(accountId: string, options: EmailIngestionOptions): Promise<{
    emails: GraphEmail[];
    nextCursor?: string;
    hasMore: boolean;
  }> {
    try {
      const graphClient = createGraphClient(accountId);
      const batchSize = Math.min(options.batchSize || INGESTION_CONFIG.defaultBatchSize, INGESTION_CONFIG.maxBatchSize);
      const since = options.since || new Date(Date.now() - INGESTION_CONFIG.defaultLookbackHours * 60 * 60 * 1000);

      // Check rate limits
      const rateLimitResult = await rateLimiter.checkAndRecord(accountId, 'email_read');
      if (!rateLimitResult.allowed) {
        throw new EmailIngestionError(
          `Rate limit exceeded: ${rateLimitResult.current_count}/${rateLimitResult.limit}`,
          accountId,
          batchSize
        );
      }

      const queryOptions: Record<string, unknown> = {
        $top: batchSize,
        $filter: `sentDateTime ge ${since.toISOString()} and isDraft eq false`,
        $select: 'id,subject,from,toRecipients,ccRecipients,bccRecipients,sentDateTime,receivedDateTime,bodyPreview,conversationId,isDraft,isRead',
        $orderby: 'sentDateTime desc'
      };

      // Add skip for pagination if cursor provided
      if (options.nextCursor) {
        queryOptions.$skip = parseInt(options.nextCursor);
      }

      const response = await graphClient.getMessages(queryOptions);
      const emails = (response.value as GraphEmail[]) || [];

      const hasMore = emails.length === batchSize;
      const nextCursor = hasMore ? 
        ((parseInt(options.nextCursor || '0') + batchSize).toString()) : 
        undefined;

      return {
        emails,
        nextCursor,
        hasMore,
      };

    } catch (error) {
      console.error(`Failed to get emails batch for account ${accountId}:`, error);
      throw new EmailIngestionError(
        `Failed to get emails batch: ${error instanceof Error ? error.message : 'Unknown error'}`,
        accountId,
        options.batchSize || INGESTION_CONFIG.defaultBatchSize,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Process full email ingestion for an account
   * @param accountId - Email account ID
   * @param options - Ingestion options
   * @returns Comprehensive ingestion result
   */
  async processFullIngestion(accountId: string, options?: EmailIngestionOptions): Promise<EmailIngestionResult> {
    const startTime = new Date();
    
    try {
      // Check if ingestion already in progress
      if (this.ingestionInProgress.has(accountId)) {
        throw new EmailIngestionError('Ingestion already in progress for this account', accountId, 0);
      }

      // Check retry queue
      const retryInfo = this.retryQueue.get(accountId);
      if (retryInfo && retryInfo.nextRetry > new Date()) {
        const waitSeconds = Math.ceil((retryInfo.nextRetry.getTime() - Date.now()) / 1000);
        throw new EmailIngestionError(
          `Account in retry cooldown. Wait ${waitSeconds} seconds.`,
          accountId,
          0
        );
      }

      this.ingestionInProgress.add(accountId);

      const batchSize = Math.min(
        options?.batchSize || INGESTION_CONFIG.defaultBatchSize,
        INGESTION_CONFIG.maxBatchSize
      );

      let processedCount = 0;
      let newTrackedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;
      const errors: Array<{ messageId: string; error: string; retryable: boolean }> = [];

      // Get account email for filtering outbound emails
      const graphClient = createGraphClient(accountId);
      const userInfo = await graphClient.getUser();
      const accountEmail = (userInfo.mail || userInfo.userPrincipalName).toLowerCase();

      let cursor: string | undefined;
      let hasMore = true;
      const maxIterations = Math.ceil(INGESTION_CONFIG.maxBatchSize * 2 / batchSize); // Safety limit

      for (let iteration = 0; iteration < maxIterations && hasMore; iteration++) {
        try {
          const batchResult = await this.getEmailsBatch(accountId, {
            ...options,
            batchSize,
            nextCursor: cursor,
          });

          cursor = batchResult.nextCursor;
          hasMore = batchResult.hasMore;

          for (const email of batchResult.emails) {
            try {
              processedCount++;

              // Filter outbound emails only
              const fromEmail = email.from?.emailAddress?.address?.toLowerCase();
              if (fromEmail !== accountEmail) {
                skippedCount++;
                continue;
              }

              // Check for deduplication if enabled
              if (INGESTION_CONFIG.deduplicationEnabled) {
                if (!supabaseAdmin) {
                  throw new Error('Database not available');
                }

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
              }

              // Start tracking the email
              try {
                await emailTrackingService.startTracking(accountId, email.id);
                newTrackedCount++;
              } catch (trackingError) {
                errorCount++;
                errors.push({
                  messageId: email.id,
                  error: trackingError instanceof Error ? trackingError.message : 'Unknown tracking error',
                  retryable: true,
                });
              }

            } catch (emailError) {
              errorCount++;
              errors.push({
                messageId: email.id,
                error: emailError instanceof Error ? emailError.message : 'Unknown email processing error',
                retryable: true,
              });
            }
          }

          // Rate limiting pause between batches
          if (hasMore && iteration < maxIterations - 1) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second pause
          }

        } catch (batchError) {
          console.error(`Batch processing error for account ${accountId}:`, batchError);
          errorCount++;
          errors.push({
            messageId: 'batch_error',
            error: batchError instanceof Error ? batchError.message : 'Batch processing failed',
            retryable: true,
          });
          break; // Stop processing if batch fails
        }
      }

      const endTime = new Date();
      const result: EmailIngestionResult = {
        success: errorCount === 0,
        processedCount,
        newTrackedCount,
        skippedCount,
        errorCount,
        errors,
        startTime,
        endTime,
        nextCursor: cursor,
      };

      // Update retry queue
      if (errorCount > 0) {
        const retryCount = (retryInfo?.count || 0) + 1;
        if (retryCount <= INGESTION_CONFIG.maxRetries) {
          const retryDelayMs = INGESTION_CONFIG.retryDelayMs * Math.pow(2, retryCount - 1);
          this.retryQueue.set(accountId, {
            count: retryCount,
            nextRetry: new Date(Date.now() + retryDelayMs),
          });
        } else {
          this.retryQueue.delete(accountId); // Max retries reached
        }
      } else {
        this.retryQueue.delete(accountId); // Success, clear retry
      }

      // Log ingestion completion
      await auditLogger.logEvent(
        'email_ingestion_completed',
        errorCount > 0 ? 'medium' : 'low',
        {
          account_id: accountId,
          processed_count: processedCount,
          new_tracked_count: newTrackedCount,
          skipped_count: skippedCount,
          error_count: errorCount,
          duration_ms: endTime.getTime() - startTime.getTime(),
          success: result.success,
        }
      );

      return result;

    } catch (error) {
      const endTime = new Date();
      console.error(`Full email ingestion failed for account ${accountId}:`, error);

      await auditLogger.logEvent(
        'email_ingestion_failed',
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
        `Email ingestion failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        accountId,
        options?.batchSize || INGESTION_CONFIG.defaultBatchSize,
        error instanceof Error ? error : undefined
      );

    } finally {
      this.ingestionInProgress.delete(accountId);
    }
  }

  /**
   * Process periodic ingestion for all active accounts
   * @param batchSize - Number of accounts to process concurrently
   * @returns Array of ingestion results
   */
  async processPeriodicIngestion(batchSize: number = INGESTION_CONFIG.maxConcurrentAccounts): Promise<EmailIngestionResult[]> {
    try {
      if (!supabaseAdmin) {
        throw new Error('Database not available');
      }

      // Get all active email accounts
      const { data: accounts, error } = await supabaseAdmin
        .from('email_accounts')
        .select('id, email_address, updated_at')
        .eq('is_active', true)
        .order('updated_at', { ascending: true }) // Process oldest first
        .limit(batchSize * 2); // Get more than batch size for selection

      if (error) {
        throw new Error(`Failed to get active accounts: ${error.message}`);
      }

      if (!accounts || accounts.length === 0) {
        console.log('No active email accounts to process');
        return [];
      }

      // Filter out accounts currently being processed
      const availableAccounts = accounts.filter(account => 
        !this.ingestionInProgress.has(account.id)
      ).slice(0, batchSize);

      if (availableAccounts.length === 0) {
        console.log('All available accounts are currently being processed');
        return [];
      }

      console.log(`Starting periodic ingestion for ${availableAccounts.length} accounts`);

      // Process accounts concurrently
      const ingestionPromises = availableAccounts.map(account => 
        this.processFullIngestion(account.id, {
          since: new Date(Date.now() - INGESTION_CONFIG.defaultLookbackHours * 60 * 60 * 1000),
          batchSize: INGESTION_CONFIG.defaultBatchSize,
          forceRefresh: false,
        })
      );

      const results = await Promise.allSettled(ingestionPromises);
      
      const successfulResults: EmailIngestionResult[] = [];
      const failedResults: Array<{ accountId: string; error: string }> = [];

      results.forEach((result, index) => {
        const accountId = availableAccounts[index].id;
        
        if (result.status === 'fulfilled') {
          successfulResults.push(result.value);
        } else {
          failedResults.push({
            accountId,
            error: result.reason instanceof Error ? result.reason.message : 'Unknown error',
          });
        }
      });

      // Log periodic ingestion summary
      await auditLogger.logEvent(
        'periodic_ingestion_completed',
        failedResults.length > 0 ? 'medium' : 'low',
        {
          total_accounts: availableAccounts.length,
          successful_accounts: successfulResults.length,
          failed_accounts: failedResults.length,
          total_processed: successfulResults.reduce((sum, r) => sum + r.processedCount, 0),
          total_new_tracked: successfulResults.reduce((sum, r) => sum + r.newTrackedCount, 0),
          total_errors: successfulResults.reduce((sum, r) => sum + r.errorCount, 0),
        }
      );

      return successfulResults;

    } catch (error) {
      console.error('Periodic email ingestion failed:', error);
      
      await auditLogger.logEvent(
        'periodic_ingestion_failed',
        'high',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          batch_size: batchSize,
        }
      );

      throw error;
    }
  }

  /**
   * Get ingestion status for an account
   * @param accountId - Email account ID
   * @returns Ingestion status information
   */
  getIngestionStatus(accountId: string): {
    inProgress: boolean;
    retryInfo?: { count: number; nextRetry: Date };
  } {
    return {
      inProgress: this.ingestionInProgress.has(accountId),
      retryInfo: this.retryQueue.get(accountId),
    };
  }

  /**
   * Clear retry status for an account
   * @param accountId - Email account ID
   */
  clearRetryStatus(accountId: string): void {
    this.retryQueue.delete(accountId);
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const emailIngestionEngine = new EmailIngestionEngine();

// Export for convenience
export { EmailIngestionEngine as default };