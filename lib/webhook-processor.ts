/**
 * Webhook Processor Service - Asynchronous Queue Processing
 * Email Tracking System - Phase 2 Critical Webhook Infrastructure  
 * Created: 2025-09-05 for Microsoft Graph webhook processing
 * 
 * ⚠️ CRITICAL: This service handles asynchronous processing of webhook notifications
 * Implements queue management, retry logic, and dead letter queue
 */

import { supabaseAdmin } from './supabase';
import { auditLogger } from './audit-logger';
import { emailDetector } from './email-detector';
import { 
  MicrosoftGraphNotification,
  WebhookJob,
  QueueProcessor,
  QueueStats,
  WebhookProcessingError,
  WebhookQueueRecord
} from '@/types/microsoft-graph-webhooks';

// ============================================================================
// CONFIGURATION
// ============================================================================

const WEBHOOK_QUEUE_CONFIG = {
  maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '3'),
  baseRetryDelayMs: parseInt(process.env.WEBHOOK_RETRY_DELAY_MS || '1000'),
  maxRetryDelayMs: parseInt(process.env.WEBHOOK_MAX_RETRY_DELAY_MS || '60000'),
  maxConcurrentJobs: parseInt(process.env.WEBHOOK_MAX_CONCURRENT_JOBS || '10'),
  processingIntervalMs: parseInt(process.env.WEBHOOK_PROCESSING_INTERVAL_MS || '5000'),
  deadLetterEnabled: process.env.WEBHOOK_DEAD_LETTER_ENABLED === 'true',
} as const;

/**
 * Calculate exponential backoff delay with jitter
 * @param retryCount - Current retry count
 * @param baseDelay - Base delay in milliseconds
 * @param maxDelay - Maximum delay in milliseconds
 * @returns Delay in milliseconds
 */
function calculateBackoffDelay(retryCount: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, retryCount);
  const withJitter = exponentialDelay * (0.5 + Math.random() * 0.5); // Add 50% jitter
  return Math.min(withJitter, maxDelay);
}

// ============================================================================
// WEBHOOK PROCESSOR CLASS
// ============================================================================

export class WebhookProcessor implements QueueProcessor {
  private isProcessing = false;
  private processingInterval: NodeJS.Timeout | null = null;
  private activeJobs = new Set<string>();

  constructor() {
    this.startProcessing();
  }

  /**
   * Add a webhook notification to the processing queue
   * @param notification - Microsoft Graph notification
   * @param accountId - Email account ID associated with the notification
   */
  async addJob(notification: MicrosoftGraphNotification, accountId: string): Promise<void> {
    try {
      if (!supabaseAdmin) {
        throw new Error('Database connection not available');
      }

      // Create unique job ID from notification
      const jobId = `${notification.subscriptionId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      const job: Omit<WebhookQueueRecord, 'id' | 'created_at' | 'updated_at'> = {
        notification_data: notification,
        account_id: accountId,
        status: 'pending',
        retry_count: 0,
        max_retries: WEBHOOK_QUEUE_CONFIG.maxRetries,
        scheduled_for: new Date(),
      };

      const { error } = await supabaseAdmin
        .from('webhook_queue')
        .insert([job]);

      if (error) {
        throw new Error(`Failed to add job to queue: ${error.message}`);
      }

      // Log job creation
      await auditLogger.logEvent(
        'webhook_job_created',
        'medium',
        {
          job_id: jobId,
          subscription_id: notification.subscriptionId,
          account_id: accountId,
          resource: notification.resource,
          change_type: notification.changeType,
        }
      );

    } catch (error) {
      console.error('Failed to add webhook job to queue:', error);
      
      await auditLogger.logEvent(
        'webhook_job_creation_failed',
        'high',
        {
          subscription_id: notification.subscriptionId,
          account_id: accountId,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );

      throw new WebhookProcessingError(
        'Failed to queue webhook notification',
        notification.subscriptionId,
        true,
        error instanceof Error ? error : new Error('Unknown error')
      );
    }
  }

  /**
   * Start the queue processing loop
   */
  private startProcessing(): void {
    if (this.processingInterval) {
      return; // Already started
    }

    this.processingInterval = setInterval(
      () => this.processJobs(),
      WEBHOOK_QUEUE_CONFIG.processingIntervalMs
    );

    console.log(`📥 Webhook queue processor started (interval: ${WEBHOOK_QUEUE_CONFIG.processingIntervalMs}ms)`);
  }

  /**
   * Stop the queue processing loop
   */
  stopProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    console.log('📥 Webhook queue processor stopped');
  }

  /**
   * Process pending webhook jobs from the queue
   */
  async processJobs(): Promise<void> {
    if (this.isProcessing) {
      return; // Already processing
    }

    if (!supabaseAdmin) {
      console.error('Database connection not available for webhook processing');
      return;
    }

    this.isProcessing = true;

    try {
      // Get available job slots
      const availableSlots = WEBHOOK_QUEUE_CONFIG.maxConcurrentJobs - this.activeJobs.size;
      
      if (availableSlots <= 0) {
        return; // No available slots
      }

      // Fetch pending jobs
      const { data: jobs, error } = await supabaseAdmin
        .from('webhook_queue')
        .select('*')
        .in('status', ['pending', 'failed'])
        .lte('scheduled_for', new Date().toISOString())
        .order('created_at', { ascending: true })
        .limit(availableSlots);

      if (error) {
        console.error('Failed to fetch webhook jobs:', error);
        return;
      }

      if (!jobs || jobs.length === 0) {
        return; // No jobs to process
      }

      // Process jobs concurrently
      const processingPromises = jobs.map(job => this.processJob(job));
      await Promise.allSettled(processingPromises);

    } catch (error) {
      console.error('Error in webhook queue processing:', error);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Process a single webhook job
   * @param job - Webhook job record from database
   */
  private async processJob(job: WebhookQueueRecord): Promise<void> {
    const jobId = job.id;
    this.activeJobs.add(jobId);

    try {
      // Mark job as processing
      await this.updateJobStatus(jobId, 'processing');

      // Process the notification
      const result = await emailDetector.processNotification(job.notification_data);

      if (result.success) {
        // Job completed successfully
        await this.updateJobStatus(jobId, 'completed', {
          processed_at: new Date(),
        });

        await auditLogger.logEvent(
          'webhook_job_completed',
          'low',
          {
            job_id: jobId,
            subscription_id: job.notification_data.subscriptionId,
            account_id: job.account_id,
            result_type: result.type,
            retry_count: job.retry_count,
          }
        );

      } else {
        // Job failed, determine if retry is needed
        await this.handleJobFailure(job, result.error || 'Processing failed');
      }

    } catch (error) {
      console.error(`Failed to process webhook job ${jobId}:`, error);
      await this.handleJobFailure(job, error instanceof Error ? error.message : 'Unknown error');
    } finally {
      this.activeJobs.delete(jobId);
    }
  }

  /**
   * Handle job failure with retry logic
   * @param job - Failed webhook job
   * @param errorMessage - Error message from the failure
   */
  private async handleJobFailure(job: WebhookQueueRecord, errorMessage: string): Promise<void> {
    const canRetry = job.retry_count < job.max_retries;

    if (canRetry) {
      const nextRetryCount = job.retry_count + 1;
      const delayMs = calculateBackoffDelay(
        nextRetryCount,
        WEBHOOK_QUEUE_CONFIG.baseRetryDelayMs,
        WEBHOOK_QUEUE_CONFIG.maxRetryDelayMs
      );
      
      const scheduledFor = new Date(Date.now() + delayMs);

      await this.updateJobStatus(job.id, 'pending', {
        retry_count: nextRetryCount,
        scheduled_for: scheduledFor,
        error_message: errorMessage,
      });

      await auditLogger.logEvent(
        'webhook_job_retry_scheduled',
        'medium',
        {
          job_id: job.id,
          subscription_id: job.notification_data.subscriptionId,
          retry_count: nextRetryCount,
          max_retries: job.max_retries,
          scheduled_for: scheduledFor.toISOString(),
          error: errorMessage,
          delay_ms: delayMs,
        }
      );

    } else {
      // Max retries reached
      const finalStatus = WEBHOOK_QUEUE_CONFIG.deadLetterEnabled ? 'dead_letter' : 'failed';

      await this.updateJobStatus(job.id, finalStatus, {
        error_message: errorMessage,
      });

      await auditLogger.logEvent(
        'webhook_job_max_retries_reached',
        'high',
        {
          job_id: job.id,
          subscription_id: job.notification_data.subscriptionId,
          account_id: job.account_id,
          final_status: finalStatus,
          total_retries: job.retry_count,
          error: errorMessage,
        }
      );
    }
  }

  /**
   * Handle retry for a specific webhook job
   * @param job - Webhook job to retry
   */
  async handleRetry(job: WebhookJob): Promise<void> {
    // This method is part of the QueueProcessor interface
    // The actual retry logic is handled in processJobs and handleJobFailure
    console.log(`Manual retry requested for job ${job.id}`);
    
    // Reset job status to pending for immediate retry
    await this.updateJobStatus(job.id, 'pending', {
      scheduled_for: new Date(),
    });
  }

  /**
   * Update job status in database
   * @param jobId - Job ID
   * @param status - New status
   * @param updates - Additional updates
   */
  private async updateJobStatus(
    jobId: string, 
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter',
    updates?: Partial<WebhookQueueRecord>
  ): Promise<void> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    const updateData = {
      status,
      updated_at: new Date(),
      ...updates,
    };

    const { error } = await supabaseAdmin
      .from('webhook_queue')
      .update(updateData)
      .eq('id', jobId);

    if (error) {
      console.error(`Failed to update job ${jobId} status:`, error);
      throw new Error(`Failed to update job status: ${error.message}`);
    }
  }

  /**
   * Get queue statistics
   * @returns Queue statistics
   */
  async getQueueStats(): Promise<QueueStats> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    try {
      // Get job counts by status
      const { data: statusCounts, error: statusError } = await supabaseAdmin
        .from('webhook_queue')
        .select('status')
        .then(({ data, error }) => {
          if (error || !data) return { data: [], error };
          
          const counts = data.reduce((acc, job) => {
            acc[job.status] = (acc[job.status] || 0) + 1;
            return acc;
          }, {} as Record<string, number>);
          
          return { data: counts, error };
        });

      if (statusError) {
        throw statusError;
      }

      // Get oldest pending job
      const { data: oldestPending } = await supabaseAdmin
        .from('webhook_queue')
        .select('created_at')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();

      // Get average processing time for completed jobs
      const { data: avgProcessingTime } = await supabaseAdmin
        .rpc('get_avg_webhook_processing_time');

      return {
        totalJobs: Object.values(statusCounts || {}).reduce((sum, count) => sum + count, 0),
        pendingJobs: statusCounts?.pending || 0,
        processingJobs: this.activeJobs.size,
        completedJobs: statusCounts?.completed || 0,
        failedJobs: (statusCounts?.failed || 0) + (statusCounts?.dead_letter || 0),
        retryJobs: statusCounts?.pending || 0, // Pending jobs include retries
        oldestPendingJob: oldestPending ? new Date(oldestPending.created_at) : undefined,
        averageProcessingTime: avgProcessingTime || 0,
      };

    } catch (error) {
      console.error('Failed to get queue statistics:', error);
      throw error;
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const webhookProcessor = new WebhookProcessor();

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('Shutting down webhook processor...');
  webhookProcessor.stopProcessing();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down webhook processor...');
  webhookProcessor.stopProcessing();
  process.exit(0);
});