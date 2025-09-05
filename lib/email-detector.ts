/**
 * Email Change Detection Engine
 * Email Tracking System - Phase 2 Critical Email Detection Infrastructure
 * Created: 2025-09-05 for Microsoft Graph webhook email processing
 * 
 * ⚠️ CRITICAL: This service detects and processes email changes from webhook notifications
 * Identifies new emails, responses, and updates tracking status
 */

import { supabaseAdmin } from './supabase';
import { auditLogger } from './audit-logger';
import { createGraphClient } from './microsoft-graph-client';
import { emailTrackingService } from './email-tracking-service';
import { responseMatcher } from './response-matcher';
import {
  MicrosoftGraphNotification,
  EmailChangeDetector,
  EmailChangeResult,
  TrackedEmailUpdate,
  ResponseDetectionResult,
  EmailChangeStatus,
  WebhookProcessingError
} from '@/types/microsoft-graph-webhooks';
import { GraphEmail } from '@/types/email-tracking';

// ============================================================================
// CONFIGURATION
// ============================================================================

const EMAIL_DETECTION_CONFIG = {
  responseMatchingThreshold: 0.7, // Minimum confidence score for response matching
  autoReplyKeywords: [
    'out of office', 'vacation', 'away', 'automatic reply', 
    'auto-reply', 'do not reply', 'noreply', 'undelivered'
  ],
  maxSubjectSimilarityDistance: 0.8, // For fuzzy subject matching
  responseWindowHours: parseInt(process.env.EMAIL_RESPONSE_WINDOW_HOURS || '168'), // 7 days
  batchProcessingSize: parseInt(process.env.EMAIL_BATCH_SIZE || '50'),
} as const;

/**
 * Calculate string similarity using Levenshtein distance
 * @param str1 - First string
 * @param str2 - Second string
 * @returns Similarity ratio (0-1)
 */
function calculateStringSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) {
    return 1.0;
  }

  const distance = levenshteinDistance(longer.toLowerCase(), shorter.toLowerCase());
  return (longer.length - distance) / longer.length;
}

/**
 * Calculate Levenshtein distance between two strings
 * @param str1 - First string
 * @param str2 - Second string
 * @returns Distance number
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}

/**
 * Check if email appears to be an auto-reply
 * @param subject - Email subject
 * @param bodyPreview - Email body preview
 * @returns True if appears to be auto-reply
 */
function isAutoReply(subject: string, bodyPreview?: string): boolean {
  const textToCheck = `${subject} ${bodyPreview || ''}`.toLowerCase();
  
  return EMAIL_DETECTION_CONFIG.autoReplyKeywords.some(keyword => 
    textToCheck.includes(keyword.toLowerCase())
  );
}

/**
 * Extract conversation identifiers from email subject
 * @param subject - Email subject line
 * @returns Cleaned subject and potential reply indicators
 */
function parseEmailSubject(subject: string): {
  cleanedSubject: string;
  isReply: boolean;
  isForward: boolean;
  originalSubject: string;
} {
  const cleanedSubject = subject
    .replace(/^(RE:\s*)+/gi, '')
    .replace(/^(FW[D]?:\s*)+/gi, '')
    .replace(/^(FWD:\s*)+/gi, '')
    .trim();

  const isReply = /^RE:\s*/gi.test(subject);
  const isForward = /^FW[D]?:\s*/gi.test(subject);

  return {
    cleanedSubject,
    isReply,
    isForward,
    originalSubject: subject,
  };
}

// ============================================================================
// EMAIL CHANGE DETECTOR CLASS
// ============================================================================

export class EmailChangeDetectionEngine implements EmailChangeDetector {
  /**
   * Process a Microsoft Graph webhook notification
   * @param notification - Webhook notification from Microsoft Graph
   * @returns Processing result
   */
  async processNotification(notification: MicrosoftGraphNotification): Promise<EmailChangeResult> {
    try {
      if (!supabaseAdmin) {
        throw new Error('Database connection not available');
      }

      // Get account ID from subscription
      const accountId = await this.getAccountIdFromSubscription(notification.subscriptionId);
      
      if (!accountId) {
        return {
          type: 'no_action',
          success: false,
          error: `No account found for subscription ${notification.subscriptionId}`,
        };
      }

      // Extract message ID from resource
      const messageId = this.extractMessageId(notification.resource);
      
      if (!messageId) {
        return {
          type: 'no_action',
          success: false,
          error: 'Could not extract message ID from notification resource',
        };
      }

      // Process based on change type
      switch (notification.changeType) {
        case 'created':
          return await this.handleEmailCreated(messageId, accountId, notification);
        
        case 'updated':
          return await this.handleEmailUpdated(messageId, accountId, notification);
        
        case 'deleted':
          return await this.handleEmailDeleted(messageId, accountId, notification);
        
        default:
          return {
            type: 'no_action',
            success: true,
            details: { changeType: notification.changeType, messageId },
          };
      }

    } catch (error) {
      console.error('Failed to process webhook notification:', error);
      
      await auditLogger.logEvent(
        'email_detection_processing_failed',
        'high',
        {
          subscription_id: notification.subscriptionId,
          resource: notification.resource,
          change_type: notification.changeType,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );

      return {
        type: 'no_action',
        success: false,
        error: error instanceof Error ? error.message : 'Processing failed',
      };
    }
  }

  /**
   * Handle email creation notification
   * @param messageId - Microsoft Graph message ID
   * @param accountId - Email account ID
   * @param notification - Original notification
   * @returns Processing result
   */
  private async handleEmailCreated(
    messageId: string,
    accountId: string,
    notification: MicrosoftGraphNotification
  ): Promise<EmailChangeResult> {
    try {
      // Get email details from Microsoft Graph
      const graphClient = createGraphClient(accountId);
      const emailDetails = await graphClient.callAPI(`/me/messages/${messageId}`, 'GET', undefined, {
        '$select': 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,bodyPreview,conversationId,isDraft,isRead'
      });

      // Check if this is a response to an existing tracked email
      const responseMatch = await responseMatcher.matchResponse(emailDetails, accountId);
      
      if (responseMatch) {
        // This is a response to a tracked email - record it
        await this.recordEmailResponseFromMatch(responseMatch, messageId, emailDetails);
        
        await auditLogger.logEvent(
          'email_response_detected',
          'medium',
          {
            tracked_email_id: responseMatch.trackedEmailId,
            message_id: messageId,
            from_email: emailDetails.from?.emailAddress?.address,
            confidence: responseMatch.matchConfidence,
            is_auto_reply: responseMatch.isAutoReply,
          }
        );

        return {
          type: 'response_detected',
          success: true,
          responseId: messageId, // Use message ID as response ID
          details: {
            trackedEmailId: responseMatch.trackedEmailId,
            confidence: responseMatch.matchConfidence,
            isAutoReply: responseMatch.isAutoReply,
          },
        };
      }

      // Check if this email should be tracked (sent from this account)
      const accountEmail = await this.getAccountEmail(accountId);
      const fromEmail = emailDetails.from?.emailAddress?.address?.toLowerCase();
      
      if (fromEmail === accountEmail?.toLowerCase() && !emailDetails.isDraft) {
        // This is an outgoing email that should be tracked
        try {
          const trackedEmail = await emailTrackingService.startTracking(accountId, messageId);
          
          await auditLogger.logEvent(
            'tracked_email_created_from_webhook',
            'medium',
            {
              tracked_email_id: trackedEmail.id,
              message_id: messageId,
              subject: trackedEmail.subject,
              to_recipients_count: trackedEmail.toEmails.length,
            }
          );

          return {
            type: 'new_email',
            success: true,
            emailId: trackedEmail.id,
            details: {
              subject: trackedEmail.subject,
              recipientCount: trackedEmail.toEmails.length,
            },
          };
        } catch (error) {
          console.error(`Failed to start tracking for email ${messageId}:`, error);
          // Don't throw - this is not critical for webhook processing
        }
      }

      return {
        type: 'no_action',
        success: true,
        details: { reason: 'Email does not require tracking', messageId },
      };

    } catch (error) {
      console.error(`Failed to handle email creation ${messageId}:`, error);
      throw new WebhookProcessingError(
        'Failed to process email creation',
        messageId,
        true,
        error instanceof Error ? error : new Error('Unknown error')
      );
    }
  }

  /**
   * Handle email update notification
   * @param messageId - Microsoft Graph message ID
   * @param accountId - Email account ID
   * @param notification - Original notification
   * @returns Processing result
   */
  private async handleEmailUpdated(
    messageId: string,
    accountId: string,
    notification: MicrosoftGraphNotification
  ): Promise<EmailChangeResult> {
    try {
      // Check if this is a tracked email
      const { data: trackedEmail } = await supabaseAdmin!
        .from('tracked_emails')
        .select('id, subject, tracking_status')
        .eq('email_account_id', accountId)
        .eq('message_id', messageId)
        .single();

      if (trackedEmail) {
        // Update tracked email status if needed
        // For now, we just log the update
        await auditLogger.logEvent(
          'tracked_email_updated',
          'low',
          {
            tracked_email_id: trackedEmail.id,
            message_id: messageId,
            current_status: trackedEmail.tracking_status,
          }
        );

        return {
          type: 'email_updated',
          success: true,
          emailId: trackedEmail.id,
          details: { currentStatus: trackedEmail.tracking_status },
        };
      }

      return {
        type: 'no_action',
        success: true,
        details: { reason: 'Email not tracked', messageId },
      };

    } catch (error) {
      console.error(`Failed to handle email update ${messageId}:`, error);
      throw new WebhookProcessingError(
        'Failed to process email update',
        messageId,
        true,
        error instanceof Error ? error : new Error('Unknown error')
      );
    }
  }

  /**
   * Handle email deletion notification
   * @param messageId - Microsoft Graph message ID
   * @param accountId - Email account ID
   * @param notification - Original notification
   * @returns Processing result
   */
  private async handleEmailDeleted(
    messageId: string,
    accountId: string,
    notification: MicrosoftGraphNotification
  ): Promise<EmailChangeResult> {
    try {
      // Check if this was a tracked email
      const { data: trackedEmail } = await supabaseAdmin!
        .from('tracked_emails')
        .select('id, subject, tracking_status')
        .eq('email_account_id', accountId)
        .eq('message_id', messageId)
        .single();

      if (trackedEmail) {
        // Update tracking status to indicate deletion
        await supabaseAdmin!
          .from('tracked_emails')
          .update({
            tracking_status: 'failed',
            updated_at: new Date(),
          })
          .eq('id', trackedEmail.id);

        await auditLogger.logEvent(
          'tracked_email_deleted',
          'medium',
          {
            tracked_email_id: trackedEmail.id,
            message_id: messageId,
            previous_status: trackedEmail.tracking_status,
          }
        );

        return {
          type: 'email_deleted',
          success: true,
          emailId: trackedEmail.id,
          details: { previousStatus: trackedEmail.tracking_status },
        };
      }

      return {
        type: 'no_action',
        success: true,
        details: { reason: 'Deleted email was not tracked', messageId },
      };

    } catch (error) {
      console.error(`Failed to handle email deletion ${messageId}:`, error);
      throw new WebhookProcessingError(
        'Failed to process email deletion',
        messageId,
        true,
        error instanceof Error ? error : new Error('Unknown error')
      );
    }
  }

  /**
   * Detect if an email is a response to a tracked email
   * @param messageId - Microsoft Graph message ID
   * @param accountId - Email account ID
   * @returns Response detection result or null
   */
  async detectEmailResponse(messageId: string, accountId: string): Promise<ResponseDetectionResult | null> {
    try {
      if (!supabaseAdmin) {
        throw new Error('Database connection not available');
      }

      // Get email details from Microsoft Graph
      const graphClient = createGraphClient(accountId);
      const emailDetails = await graphClient.callAPI(`/me/messages/${messageId}`, 'GET', undefined, {
        '$select': 'id,subject,from,toRecipients,receivedDateTime,bodyPreview,conversationId'
      });

      const fromEmail = emailDetails.from?.emailAddress?.address;
      const fromName = emailDetails.from?.emailAddress?.name;
      const receivedAt = new Date(emailDetails.receivedDateTime);
      
      if (!fromEmail) {
        return null;
      }

      // Parse the subject to identify potential replies
      const subjectInfo = parseEmailSubject(emailDetails.subject || '');
      
      if (!subjectInfo.isReply) {
        return null; // Not a reply
      }

      // Find matching tracked emails by subject similarity and recipients
      const { data: trackedEmails } = await supabaseAdmin
        .from('tracked_emails')
        .select('id, subject, from_email, to_emails, sent_at, tracking_status')
        .eq('email_account_id', accountId)
        .eq('tracking_status', 'active')
        .gte('sent_at', new Date(Date.now() - EMAIL_DETECTION_CONFIG.responseWindowHours * 60 * 60 * 1000).toISOString());

      if (!trackedEmails || trackedEmails.length === 0) {
        return null;
      }

      // Find the best matching tracked email
      let bestMatch: Record<string, unknown> | null = null;
      let bestConfidence = 0;

      for (const trackedEmail of trackedEmails) {
        const confidence = this.calculateResponseConfidence(
          trackedEmail,
          emailDetails,
          subjectInfo,
          fromEmail,
          receivedAt
        );

        if (confidence > bestConfidence && confidence >= EMAIL_DETECTION_CONFIG.responseMatchingThreshold) {
          bestMatch = trackedEmail;
          bestConfidence = confidence;
        }
      }

      if (!bestMatch) {
        return null;
      }

      // Create response record
      const responseId = crypto.randomUUID();
      const isAutoReply = isAutoReply(emailDetails.subject || '', emailDetails.bodyPreview);

      return {
        responseId,
        trackedEmailId: bestMatch.id,
        responseMessageId: messageId,
        fromEmail,
        fromName,
        receivedAt,
        subject: emailDetails.subject || '',
        bodyPreview: emailDetails.bodyPreview,
        isAutoReply,
        confidence: bestConfidence,
      };

    } catch (error) {
      console.error(`Failed to detect email response ${messageId}:`, error);
      return null;
    }
  }

  /**
   * Calculate confidence score for response matching
   * @param trackedEmail - Original tracked email
   * @param responseEmail - Potential response email
   * @param subjectInfo - Parsed subject information
   * @param fromEmail - Response from email
   * @param receivedAt - Response received date
   * @returns Confidence score (0-1)
   */
  private calculateResponseConfidence(
    trackedEmail: Record<string, unknown>,
    responseEmail: Record<string, unknown>,
    subjectInfo: Record<string, unknown>,
    fromEmail: string,
    receivedAt: Date
  ): number {
    let confidence = 0;
    let factors = 0;

    // Subject similarity (40% weight)
    const subjectSimilarity = calculateStringSimilarity(
      trackedEmail.subject,
      subjectInfo.cleanedSubject
    );
    confidence += subjectSimilarity * 0.4;
    factors += 0.4;

    // Recipient match (30% weight)
    const toEmails = (trackedEmail.to_emails as string[]) || [];
    const isRecipient = toEmails.some((email: string) => 
      email.toLowerCase() === fromEmail.toLowerCase()
    );
    if (isRecipient) {
      confidence += 0.3;
    }
    factors += 0.3;

    // Time proximity (20% weight)
    const sentAt = new Date(trackedEmail.sent_at);
    const timeDiffHours = (receivedAt.getTime() - sentAt.getTime()) / (1000 * 60 * 60);
    
    if (timeDiffHours > 0 && timeDiffHours <= EMAIL_DETECTION_CONFIG.responseWindowHours) {
      const timeScore = Math.max(0, 1 - (timeDiffHours / EMAIL_DETECTION_CONFIG.responseWindowHours));
      confidence += timeScore * 0.2;
    }
    factors += 0.2;

    // Conversation thread (10% weight)
    if (responseEmail.conversationId && trackedEmail.conversation_id === responseEmail.conversationId) {
      confidence += 0.1;
    }
    factors += 0.1;

    return factors > 0 ? confidence / factors : 0;
  }

  /**
   * Record a detected email response from match result
   * @param matchResult - Response match result
   * @param messageId - Message ID of the response
   * @param emailDetails - Email details from Graph API
   */
  private async recordEmailResponseFromMatch(matchResult: any, messageId: string, emailDetails: GraphEmail): Promise<void> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    const fromEmail = emailDetails.from?.emailAddress?.address || '';
    const fromName = emailDetails.from?.emailAddress?.name;
    const receivedAt = emailDetails.receivedDateTime ? new Date(emailDetails.receivedDateTime) : new Date();

    // Insert response record
    const { error: insertError } = await supabaseAdmin
      .from('email_responses')
      .insert([{
        tracked_email_id: matchResult.trackedEmailId,
        message_id: messageId,
        from_email: fromEmail,
        from_name: fromName,
        received_at: receivedAt.toISOString(),
        subject: emailDetails.subject || '',
        body_preview: emailDetails.bodyPreview,
        is_auto_reply: matchResult.isAutoReply,
        confidence_score: matchResult.matchConfidence,
      }]);

    if (insertError) {
      throw new Error(`Failed to record response: ${insertError.message}`);
    }

    // Update tracked email status
    const { error: updateError } = await supabaseAdmin
      .from('tracked_emails')
      .update({
        has_response: true,
        last_response_at: receivedAt.toISOString(),
        response_count: supabaseAdmin.rpc('increment_response_count', { 
          row_id: matchResult.trackedEmailId 
        }),
        updated_at: new Date().toISOString(),
      })
      .eq('id', matchResult.trackedEmailId);

    if (updateError) {
      throw new Error(`Failed to update tracked email: ${updateError.message}`);
    }
  }

  /**
   * Record a detected email response (legacy method for backward compatibility)
   * @param responseResult - Response detection result
   */
  private async recordEmailResponse(responseResult: ResponseDetectionResult): Promise<void> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    // Insert response record
    const { error: insertError } = await supabaseAdmin
      .from('email_responses')
      .insert([{
        tracked_email_id: responseResult.trackedEmailId,
        message_id: responseResult.responseMessageId,
        from_email: responseResult.fromEmail,
        from_name: responseResult.fromName,
        received_at: responseResult.receivedAt,
        subject: responseResult.subject,
        body_preview: responseResult.bodyPreview,
        is_auto_reply: responseResult.isAutoReply,
        confidence_score: responseResult.confidence,
      }]);

    if (insertError) {
      throw new Error(`Failed to record response: ${insertError.message}`);
    }

    // Update tracked email status
    const { error: updateError } = await supabaseAdmin
      .from('tracked_emails')
      .update({
        has_response: true,
        last_response_at: responseResult.receivedAt,
        response_count: supabaseAdmin.raw('response_count + 1'),
        updated_at: new Date(),
      })
      .eq('id', responseResult.trackedEmailId);

    if (updateError) {
      throw new Error(`Failed to update tracked email: ${updateError.message}`);
    }
  }

  /**
   * Create a new tracked email record
   * @param emailDetails - Email details from Microsoft Graph
   * @param accountId - Email account ID
   * @returns Created tracked email or null
   */
  private async createTrackedEmail(emailDetails: Record<string, unknown>, accountId: string): Promise<Record<string, unknown> | null> {
    if (!supabaseAdmin) {
      return null;
    }

    try {
      const toEmails = emailDetails.toRecipients?.map((r: Record<string, unknown>) => r.emailAddress?.address).filter(Boolean) || [];
      const ccEmails = emailDetails.ccRecipients?.map((r: Record<string, unknown>) => r.emailAddress?.address).filter(Boolean) || [];

      const trackedEmailData = {
        email_account_id: accountId,
        message_id: emailDetails.id,
        conversation_id: emailDetails.conversationId,
        subject: emailDetails.subject || '',
        from_email: emailDetails.from?.emailAddress?.address || '',
        from_name: emailDetails.from?.emailAddress?.name,
        to_emails: toEmails,
        cc_emails: ccEmails.length > 0 ? ccEmails : null,
        body_preview: emailDetails.bodyPreview,
        sent_at: new Date(emailDetails.sentDateTime || emailDetails.createdDateTime),
        tracking_status: 'active' as const,
      };

      const { data: trackedEmail, error } = await supabaseAdmin
        .from('tracked_emails')
        .insert([trackedEmailData])
        .select()
        .single();

      if (error) {
        console.error('Failed to create tracked email:', error);
        return null;
      }

      return trackedEmail;

    } catch (error) {
      console.error('Failed to create tracked email:', error);
      return null;
    }
  }

  /**
   * Get account email address
   * @param accountId - Email account ID
   * @returns Email address or null
   */
  private async getAccountEmail(accountId: string): Promise<string | null> {
    if (!supabaseAdmin) {
      return null;
    }

    const { data: account } = await supabaseAdmin
      .from('email_accounts')
      .select('email_address')
      .eq('id', accountId)
      .single();

    return account?.email_address || null;
  }

  /**
   * Get account ID from subscription ID
   * @param subscriptionId - Microsoft Graph subscription ID
   * @returns Account ID or null
   */
  private async getAccountIdFromSubscription(subscriptionId: string): Promise<string | null> {
    if (!supabaseAdmin) {
      return null;
    }

    const { data: subscription } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('email_account_id')
      .eq('microsoft_subscription_id', subscriptionId)
      .eq('is_active', true)
      .single();

    return subscription?.email_account_id || null;
  }

  /**
   * Extract message ID from Microsoft Graph resource URL
   * @param resource - Resource URL from notification
   * @returns Message ID or null
   */
  private extractMessageId(resource: string): string | null {
    // Resource format: "Users/{user-id}/Messages/{message-id}"
    const match = resource.match(/Messages\/([^\/\?]+)/i);
    return match ? match[1] : null;
  }

  /**
   * Detect new email from message ID
   * @param messageId - Microsoft Graph message ID  
   * @param accountId - Email account ID
   * @returns Tracked email update or null
   */
  async detectNewEmail(messageId: string, accountId: string): Promise<TrackedEmailUpdate | null> {
    // This method is implemented as part of handleEmailCreated
    console.log('detectNewEmail called', { messageId, accountId });
    return null;
  }

  /**
   * Update tracked email status
   * @param emailId - Tracked email ID
   * @param status - New status
   */
  async updateTrackedEmailStatus(emailId: string, status: EmailChangeStatus): Promise<void> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    const updateData = {
      has_response: status.hasResponse,
      response_count: status.responseCount,
      last_response_at: status.lastResponseAt,
      tracking_status: status.trackingStatus,
      updated_at: new Date(),
    };

    const { error } = await supabaseAdmin
      .from('tracked_emails')
      .update(updateData)
      .eq('id', emailId);

    if (error) {
      throw new Error(`Failed to update tracked email status: ${error.message}`);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const emailDetector = new EmailChangeDetectionEngine();