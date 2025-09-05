/**
 * Email Lifecycle Manager - State Machine for Email Tracking Status
 * Email Tracking System - Phase 2 Critical Implementation
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This service manages the complete lifecycle of tracked emails
 * Implements state machine transitions and automated lifecycle management
 */

import { supabaseAdmin } from './supabase';
import { auditLogger } from './audit-logger';
import {
  EmailLifecycleManager,
  EmailTrackingStatus,
  EmailTrackingTransitions,
  EmailTrackingError
} from '@/types/email-tracking';
import { TrackingStatusEnum } from '@/types/database';

// ============================================================================
// CONFIGURATION
// ============================================================================

const LIFECYCLE_CONFIG = {
  timeoutDays: parseInt(process.env.EMAIL_TRACKING_TIMEOUT_DAYS || '30'),
  archiveAfterDays: parseInt(process.env.EMAIL_TRACKING_ARCHIVE_DAYS || '90'),
  cleanupBatchSize: parseInt(process.env.EMAIL_LIFECYCLE_BATCH_SIZE || '100'),
  processingIntervalMs: parseInt(process.env.EMAIL_LIFECYCLE_PROCESSING_INTERVAL_MS || '3600000'), // 1 hour
  
  // Grace periods before automatic transitions
  gracePeriods: {
    pendingToActive: 5 * 60 * 1000,      // 5 minutes for pending emails
    activeToOverdue: 7 * 24 * 60 * 60 * 1000, // 7 days for active emails
    overdueToFailed: 30 * 24 * 60 * 60 * 1000, // 30 days for overdue emails
  },
} as const;

// ============================================================================
// STATE MACHINE DEFINITION
// ============================================================================

const EMAIL_STATE_TRANSITIONS: EmailTrackingTransitions = {
  [EmailTrackingStatus.PENDING]: [
    EmailTrackingStatus.SENT,
    EmailTrackingStatus.FAILED,
    EmailTrackingStatus.CLOSED,
  ],
  [EmailTrackingStatus.SENT]: [
    EmailTrackingStatus.DELIVERED,
    EmailTrackingStatus.BOUNCED,
    EmailTrackingStatus.FAILED,
    EmailTrackingStatus.CLOSED,
  ],
  [EmailTrackingStatus.DELIVERED]: [
    EmailTrackingStatus.OPENED,
    EmailTrackingStatus.REPLIED,
    EmailTrackingStatus.CLOSED,
  ],
  [EmailTrackingStatus.OPENED]: [
    EmailTrackingStatus.REPLIED,
    EmailTrackingStatus.CLOSED,
  ],
  [EmailTrackingStatus.REPLIED]: [
    EmailTrackingStatus.CLOSED,
  ],
  [EmailTrackingStatus.BOUNCED]: [
    EmailTrackingStatus.CLOSED,
  ],
  [EmailTrackingStatus.CLOSED]: [], // Terminal state
};

// ============================================================================
// EMAIL LIFECYCLE MANAGER CLASS
// ============================================================================

export class EmailLifecycleEngine implements EmailLifecycleManager {
  private processingInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor() {
    this.startAutomaticProcessing();
  }

  /**
   * Transition an email from one status to another
   * @param emailId - Tracked email ID
   * @param fromStatus - Current status
   * @param toStatus - Desired status
   * @returns True if transition was successful
   */
  async transitionStatus(
    emailId: string,
    fromStatus: EmailTrackingStatus,
    toStatus: EmailTrackingStatus
  ): Promise<boolean> {
    try {
      if (!supabaseAdmin) {
        throw new EmailTrackingError('Database not available', 'DATABASE_ERROR', undefined, emailId);
      }

      // Validate the transition
      if (!this.validateTransition(fromStatus, toStatus)) {
        await auditLogger.logEvent(
          'invalid_email_transition',
          'medium',
          {
            email_id: emailId,
            from_status: fromStatus,
            to_status: toStatus,
            reason: 'Invalid state transition',
          }
        );
        return false;
      }

      // Get current email state to verify
      const { data: currentEmail, error: fetchError } = await supabaseAdmin
        .from('tracked_emails')
        .select('id, tracking_status, subject, email_account_id')
        .eq('id', emailId)
        .single();

      if (fetchError || !currentEmail) {
        throw new EmailTrackingError(
          `Email not found: ${fetchError?.message || 'Not found'}`,
          'EMAIL_NOT_FOUND',
          undefined,
          emailId
        );
      }

      // Verify current status matches expected status
      const currentStatus = this.mapDbStatusToTrackingStatus(currentEmail.tracking_status);
      if (currentStatus !== fromStatus) {
        await auditLogger.logEvent(
          'email_status_mismatch',
          'medium',
          {
            email_id: emailId,
            expected_status: fromStatus,
            actual_status: currentStatus,
            requested_transition: toStatus,
          }
        );
        return false;
      }

      // Perform the transition
      const updateData: any = {
        tracking_status: this.mapTrackingStatusToDb(toStatus),
        updated_at: new Date().toISOString(),
      };

      // Add specific fields based on the transition
      if (toStatus === EmailTrackingStatus.REPLIED) {
        updateData.has_response = true;
        if (!currentEmail.last_response_at) {
          updateData.last_response_at = new Date().toISOString();
        }
      } else if (toStatus === EmailTrackingStatus.CLOSED) {
        updateData.completed_at = new Date().toISOString();
      }

      const { error: updateError } = await supabaseAdmin
        .from('tracked_emails')
        .update(updateData)
        .eq('id', emailId);

      if (updateError) {
        throw new EmailTrackingError(
          `Failed to update status: ${updateError.message}`,
          'STATUS_UPDATE_ERROR',
          undefined,
          emailId
        );
      }

      // Log successful transition
      await auditLogger.logEvent(
        'email_status_transitioned',
        'low',
        {
          email_id: emailId,
          account_id: currentEmail.email_account_id,
          from_status: fromStatus,
          to_status: toStatus,
          subject: currentEmail.subject,
          timestamp: new Date().toISOString(),
        }
      );

      return true;

    } catch (error) {
      console.error(`Failed to transition email ${emailId} from ${fromStatus} to ${toStatus}:`, error);
      
      await auditLogger.logEvent(
        'email_transition_failed',
        'high',
        {
          email_id: emailId,
          from_status: fromStatus,
          to_status: toStatus,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );

      if (error instanceof EmailTrackingError) {
        throw error;
      }

      throw new EmailTrackingError(
        'Failed to transition email status',
        'TRANSITION_ERROR',
        undefined,
        emailId
      );
    }
  }

  /**
   * Validate if a status transition is allowed
   * @param fromStatus - Current status
   * @param toStatus - Desired status
   * @returns True if transition is valid
   */
  validateTransition(fromStatus: EmailTrackingStatus, toStatus: EmailTrackingStatus): boolean {
    const allowedTransitions = EMAIL_STATE_TRANSITIONS[fromStatus];
    return allowedTransitions ? allowedTransitions.includes(toStatus) : false;
  }

  /**
   * Get valid transitions from a current status
   * @param currentStatus - Current status
   * @returns Array of valid next statuses
   */
  getValidTransitions(currentStatus: EmailTrackingStatus): EmailTrackingStatus[] {
    return EMAIL_STATE_TRANSITIONS[currentStatus] || [];
  }

  /**
   * Process automatic timeouts and state transitions
   * @returns Number of emails processed
   */
  async processTimeouts(): Promise<number> {
    try {
      if (!supabaseAdmin) {
        return 0;
      }

      if (this.isProcessing) {
        console.log('Lifecycle processing already in progress');
        return 0;
      }

      this.isProcessing = true;
      let processedCount = 0;

      try {
        // 1. Process pending emails that should become active
        processedCount += await this.processPendingTimeouts();

        // 2. Process active emails that should become overdue
        processedCount += await this.processActiveTimeouts();

        // 3. Process overdue emails that should fail
        processedCount += await this.processOverdueTimeouts();

        // 4. Process emails that should be automatically closed
        processedCount += await this.processAutoClose();

        await auditLogger.logEvent(
          'lifecycle_processing_completed',
          'low',
          {
            processed_count: processedCount,
            timestamp: new Date().toISOString(),
          }
        );

        return processedCount;

      } catch (error) {
        console.error('Error in lifecycle timeout processing:', error);
        
        await auditLogger.logEvent(
          'lifecycle_processing_error',
          'high',
          {
            error: error instanceof Error ? error.message : 'Unknown error',
            processed_count: processedCount,
          }
        );

        throw error;
      } finally {
        this.isProcessing = false;
      }

    } catch (error) {
      console.error('Failed to process timeouts:', error);
      return 0;
    }
  }

  /**
   * Archive old emails that are no longer needed
   * @param olderThanDays - Archive emails older than this many days
   * @returns Number of emails archived
   */
  async archiveOldEmails(olderThanDays: number = LIFECYCLE_CONFIG.archiveAfterDays): Promise<number> {
    try {
      if (!supabaseAdmin) {
        return 0;
      }

      const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
      
      // Get old completed emails
      const { data: oldEmails, error: fetchError } = await supabaseAdmin
        .from('tracked_emails')
        .select('id, subject, email_account_id')
        .eq('tracking_status', 'completed')
        .lt('updated_at', cutoffDate.toISOString())
        .limit(LIFECYCLE_CONFIG.cleanupBatchSize);

      if (fetchError) {
        throw new Error(`Failed to fetch old emails: ${fetchError.message}`);
      }

      if (!oldEmails || oldEmails.length === 0) {
        return 0;
      }

      const emailIds = oldEmails.map(email => email.id);

      // Update status to archived (we'll use 'completed' as archived status)
      const { error: updateError } = await supabaseAdmin
        .from('tracked_emails')
        .update({
          tracking_status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .in('id', emailIds);

      if (updateError) {
        throw new Error(`Failed to archive emails: ${updateError.message}`);
      }

      await auditLogger.logEvent(
        'emails_archived',
        'low',
        {
          archived_count: oldEmails.length,
          cutoff_date: cutoffDate.toISOString(),
          oldest_archived: Math.min(...oldEmails.map(e => new Date(e.updated_at).getTime())),
        }
      );

      return oldEmails.length;

    } catch (error) {
      console.error('Failed to archive old emails:', error);
      
      await auditLogger.logEvent(
        'email_archiving_failed',
        'medium',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          older_than_days: olderThanDays,
        }
      );

      return 0;
    }
  }

  /**
   * Clean up emails that have failed permanently
   * @returns Number of emails cleaned up
   */
  async cleanupFailedEmails(): Promise<number> {
    try {
      if (!supabaseAdmin) {
        return 0;
      }

      // Get failed emails older than cleanup period
      const cutoffDate = new Date(Date.now() - LIFECYCLE_CONFIG.archiveAfterDays * 24 * 60 * 60 * 1000);
      
      const { data: failedEmails, error: fetchError } = await supabaseAdmin
        .from('tracked_emails')
        .select('id, subject, email_account_id')
        .eq('tracking_status', 'failed')
        .lt('updated_at', cutoffDate.toISOString())
        .limit(LIFECYCLE_CONFIG.cleanupBatchSize);

      if (fetchError) {
        throw new Error(`Failed to fetch failed emails: ${fetchError.message}`);
      }

      if (!failedEmails || failedEmails.length === 0) {
        return 0;
      }

      const emailIds = failedEmails.map(email => email.id);

      // Mark as completed (archived) rather than deleting
      const { error: updateError } = await supabaseAdmin
        .from('tracked_emails')
        .update({
          tracking_status: 'completed',
          updated_at: new Date().toISOString(),
        })
        .in('id', emailIds);

      if (updateError) {
        throw new Error(`Failed to cleanup failed emails: ${updateError.message}`);
      }

      await auditLogger.logEvent(
        'failed_emails_cleaned_up',
        'low',
        {
          cleaned_count: failedEmails.length,
          cutoff_date: cutoffDate.toISOString(),
        }
      );

      return failedEmails.length;

    } catch (error) {
      console.error('Failed to cleanup failed emails:', error);
      return 0;
    }
  }

  /**
   * Start automatic lifecycle processing
   */
  private startAutomaticProcessing(): void {
    if (this.processingInterval) {
      return; // Already started
    }

    this.processingInterval = setInterval(
      () => {
        this.processTimeouts().catch(error => {
          console.error('Automatic lifecycle processing error:', error);
        });
      },
      LIFECYCLE_CONFIG.processingIntervalMs
    );

    console.log(`📧 Email lifecycle processor started (interval: ${LIFECYCLE_CONFIG.processingIntervalMs}ms)`);
  }

  /**
   * Stop automatic lifecycle processing
   */
  stopAutomaticProcessing(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
    console.log('📧 Email lifecycle processor stopped');
  }

  /**
   * Process pending emails that should become sent
   */
  private async processPendingTimeouts(): Promise<number> {
    if (!supabaseAdmin) return 0;

    const cutoffTime = new Date(Date.now() - LIFECYCLE_CONFIG.gracePeriods.pendingToActive);
    
    const { data: pendingEmails, error } = await supabaseAdmin
      .from('tracked_emails')
      .select('id, tracking_status')
      .eq('tracking_status', 'active') // Using active as our base tracking state
      .lt('created_at', cutoffTime.toISOString())
      .limit(LIFECYCLE_CONFIG.cleanupBatchSize);

    if (error || !pendingEmails) return 0;

    let processed = 0;
    for (const email of pendingEmails) {
      try {
        // This is a no-op since we're using 'active' as the main state
        // In a full implementation, you might transition from 'pending' to 'sent'
        processed++;
      } catch (error) {
        console.error(`Failed to process pending timeout for email ${email.id}:`, error);
      }
    }

    return processed;
  }

  /**
   * Process active emails that should become overdue
   */
  private async processActiveTimeouts(): Promise<number> {
    if (!supabaseAdmin) return 0;

    const cutoffTime = new Date(Date.now() - LIFECYCLE_CONFIG.gracePeriods.activeToOverdue);
    
    const { data: activeEmails, error } = await supabaseAdmin
      .from('tracked_emails')
      .select('id, tracking_status, has_response')
      .eq('tracking_status', 'active')
      .eq('has_response', false)
      .lt('sent_at', cutoffTime.toISOString())
      .limit(LIFECYCLE_CONFIG.cleanupBatchSize);

    if (error || !activeEmails) return 0;

    let processed = 0;
    for (const email of activeEmails) {
      try {
        // Keep as active but could add overdue flag in future
        // For now, just count as processed
        processed++;
      } catch (error) {
        console.error(`Failed to process active timeout for email ${email.id}:`, error);
      }
    }

    return processed;
  }

  /**
   * Process overdue emails that should fail
   */
  private async processOverdueTimeouts(): Promise<number> {
    if (!supabaseAdmin) return 0;

    const cutoffTime = new Date(Date.now() - LIFECYCLE_CONFIG.gracePeriods.overdueToFailed);
    
    const { data: overdueEmails, error } = await supabaseAdmin
      .from('tracked_emails')
      .select('id, tracking_status, has_response')
      .eq('tracking_status', 'active')
      .eq('has_response', false)
      .lt('sent_at', cutoffTime.toISOString())
      .limit(LIFECYCLE_CONFIG.cleanupBatchSize);

    if (error || !overdueEmails) return 0;

    let processed = 0;
    for (const email of overdueEmails) {
      try {
        const success = await this.transitionStatus(
          email.id,
          EmailTrackingStatus.DELIVERED, // Assuming they were delivered but no response
          EmailTrackingStatus.CLOSED // Close after timeout
        );
        if (success) processed++;
      } catch (error) {
        console.error(`Failed to process overdue timeout for email ${email.id}:`, error);
      }
    }

    return processed;
  }

  /**
   * Process emails that should be automatically closed
   */
  private async processAutoClose(): Promise<number> {
    if (!supabaseAdmin) return 0;

    const cutoffTime = new Date(Date.now() - LIFECYCLE_CONFIG.timeoutDays * 24 * 60 * 60 * 1000);
    
    const { data: oldEmails, error } = await supabaseAdmin
      .from('tracked_emails')
      .select('id, tracking_status')
      .eq('tracking_status', 'active')
      .lt('sent_at', cutoffTime.toISOString())
      .limit(LIFECYCLE_CONFIG.cleanupBatchSize);

    if (error || !oldEmails) return 0;

    let processed = 0;
    for (const email of oldEmails) {
      try {
        const { error: updateError } = await supabaseAdmin
          .from('tracked_emails')
          .update({
            tracking_status: 'completed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', email.id);

        if (!updateError) processed++;
      } catch (error) {
        console.error(`Failed to auto-close email ${email.id}:`, error);
      }
    }

    return processed;
  }

  /**
   * Map database status to tracking status enum
   */
  private mapDbStatusToTrackingStatus(dbStatus: TrackingStatusEnum): EmailTrackingStatus {
    switch (dbStatus) {
      case 'active': return EmailTrackingStatus.DELIVERED;
      case 'completed': return EmailTrackingStatus.CLOSED;
      case 'failed': return EmailTrackingStatus.BOUNCED;
      case 'paused': return EmailTrackingStatus.SENT;
      default: return EmailTrackingStatus.DELIVERED;
    }
  }

  /**
   * Map tracking status to database status
   */
  private mapTrackingStatusToDb(status: EmailTrackingStatus): TrackingStatusEnum {
    switch (status) {
      case EmailTrackingStatus.PENDING: return 'active';
      case EmailTrackingStatus.SENT: return 'active';
      case EmailTrackingStatus.DELIVERED: return 'active';
      case EmailTrackingStatus.OPENED: return 'active';
      case EmailTrackingStatus.REPLIED: return 'active';
      case EmailTrackingStatus.BOUNCED: return 'failed';
      case EmailTrackingStatus.CLOSED: return 'completed';
      default: return 'active';
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const emailLifecycleManager = new EmailLifecycleEngine();

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('Shutting down email lifecycle manager...');
  emailLifecycleManager.stopAutomaticProcessing();
});

process.on('SIGTERM', () => {
  console.log('Shutting down email lifecycle manager...');
  emailLifecycleManager.stopAutomaticProcessing();
});

// Export for convenience
export { EmailLifecycleEngine as default };