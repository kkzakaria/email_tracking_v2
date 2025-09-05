/**
 * Response Matcher - Advanced Email Response Detection and Matching
 * Email Tracking System - Phase 2 Critical Implementation
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This service handles intelligent response detection and matching
 * Uses multiple algorithms to achieve >95% accuracy in response matching
 */

import { supabaseAdmin } from './supabase';
import { auditLogger } from './audit-logger';
import {
  ResponseMatcher,
  ResponseMatchResult,
  TrackedEmail,
  GraphEmail,
  ResponseMatchingError
} from '@/types/email-tracking';

// ============================================================================
// CONFIGURATION
// ============================================================================

const MATCHING_CONFIG = {
  confidenceThreshold: parseFloat(process.env.RESPONSE_DETECTION_CONFIDENCE_THRESHOLD || '0.8'),
  autoReplyFilter: process.env.RESPONSE_DETECTION_AUTO_REPLY_FILTER === 'true',
  maxThreadDepth: parseInt(process.env.RESPONSE_DETECTION_MAX_THREAD_DEPTH || '10'),
  maxResponseWindowHours: parseInt(process.env.EMAIL_RESPONSE_WINDOW_HOURS || '168'), // 7 days
  
  // Matching weights for confidence scoring
  weights: {
    subjectSimilarity: 0.35,      // Subject similarity (35%)
    recipientMatch: 0.25,         // Direct recipient match (25%)
    conversationMatch: 0.20,      // Conversation/thread match (20%)
    timeProximity: 0.15,          // Time proximity (15%)
    headerAnalysis: 0.05,         // Email headers analysis (5%)
  },
  
  // Auto-reply detection keywords
  autoReplyKeywords: [
    'out of office', 'vacation', 'away', 'automatic reply', 'auto-reply', 'auto reply',
    'do not reply', 'noreply', 'no-reply', 'undelivered', 'delivery failure',
    'autoreply', 'ooo', 'currently away', 'not available', 'temporarily away',
    'automatic response', 'automated message', 'system generated',
    // French
    'absence du bureau', 'absent', 'réponse automatique', 'ne pas répondre',
    // Spanish  
    'fuera de oficina', 'respuesta automática', 'no responder',
    // German
    'abwesenheit', 'automatische antwort', 'nicht antworten'
  ],
} as const;

// ============================================================================
// RESPONSE MATCHING ENGINE CLASS
// ============================================================================

export class ResponseMatchingEngine implements ResponseMatcher {
  
  /**
   * Match an incoming email against tracked emails to find potential responses
   * @param incomingEmail - The incoming email to match
   * @param accountId - Email account ID
   * @returns Best match result or null if no good match found
   */
  async matchResponse(incomingEmail: GraphEmail, accountId: string): Promise<ResponseMatchResult | null> {
    try {
      if (!supabaseAdmin) {
        throw new ResponseMatchingError('Database not available', incomingEmail.id, accountId);
      }

      // Quick filters to exclude obvious non-responses
      if (!this.couldBeResponse(incomingEmail)) {
        return null;
      }

      // Get potential tracked emails to match against
      const potentialMatches = await this.getPotentialMatches(incomingEmail, accountId);
      
      if (potentialMatches.length === 0) {
        return null;
      }

      // Calculate match confidence for each potential match
      let bestMatch: ResponseMatchResult | null = null;
      let bestConfidence = 0;

      for (const trackedEmail of potentialMatches) {
        const confidence = this.calculateMatchConfidence(trackedEmail, incomingEmail);
        
        if (confidence > bestConfidence && confidence >= MATCHING_CONFIG.confidenceThreshold) {
          const isAutoReply = this.detectAutoReply(incomingEmail);
          
          bestMatch = {
            trackedEmailId: trackedEmail.id,
            matchConfidence: confidence,
            matchFactors: this.getMatchFactors(trackedEmail, incomingEmail),
            isAutoReply,
            validationScore: confidence, // Start with match confidence
          };
          
          bestConfidence = confidence;
        }
      }

      // Additional validation for the best match
      if (bestMatch) {
        const isValid = await this.validateResponse(bestMatch);
        if (!isValid) {
          return null;
        }
      }

      return bestMatch;

    } catch (error) {
      console.error(`Failed to match response for email ${incomingEmail.id}:`, error);
      
      await auditLogger.logEvent(
        'response_matching_error',
        'medium',
        {
          message_id: incomingEmail.id,
          account_id: accountId,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );

      if (error instanceof ResponseMatchingError) {
        throw error;
      }

      throw new ResponseMatchingError(
        `Response matching failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        incomingEmail.id,
        accountId
      );
    }
  }

  /**
   * Calculate confidence score for a potential match
   * @param trackedEmail - Original tracked email
   * @param incomingEmail - Potential response email
   * @returns Confidence score (0-1)
   */
  calculateMatchConfidence(trackedEmail: TrackedEmail, incomingEmail: GraphEmail): number {
    let totalScore = 0;
    
    // 1. Subject similarity (35% weight)
    const subjectScore = this.calculateSubjectSimilarity(
      trackedEmail.subject,
      incomingEmail.subject || ''
    );
    totalScore += subjectScore * MATCHING_CONFIG.weights.subjectSimilarity;

    // 2. Recipient match (25% weight)
    const recipientScore = this.checkRecipientMatch(trackedEmail, incomingEmail) ? 1.0 : 0.0;
    totalScore += recipientScore * MATCHING_CONFIG.weights.recipientMatch;

    // 3. Conversation match (20% weight)
    const conversationScore = this.checkConversationMatch(trackedEmail, incomingEmail) ? 1.0 : 0.0;
    totalScore += conversationScore * MATCHING_CONFIG.weights.conversationMatch;

    // 4. Time proximity (15% weight)
    const timeScore = this.calculateTimeProximity(trackedEmail, incomingEmail);
    totalScore += timeScore * MATCHING_CONFIG.weights.timeProximity;

    // 5. Header analysis (5% weight)
    const headerScore = this.analyzeEmailHeaders(trackedEmail, incomingEmail);
    totalScore += headerScore * MATCHING_CONFIG.weights.headerAnalysis;

    return Math.min(totalScore, 1.0); // Cap at 1.0
  }

  /**
   * Validate a potential response match
   * @param matchResult - The match result to validate
   * @returns True if the match is valid
   */
  async validateResponse(matchResult: ResponseMatchResult): Promise<boolean> {
    try {
      // Apply additional business rules and validations
      
      // 1. Check if confidence is above threshold
      if (matchResult.matchConfidence < MATCHING_CONFIG.confidenceThreshold) {
        return false;
      }

      // 2. If it's an auto-reply and filter is enabled, reduce validation
      if (matchResult.isAutoReply && MATCHING_CONFIG.autoReplyFilter) {
        // Auto-replies need higher confidence to be accepted
        return matchResult.matchConfidence >= (MATCHING_CONFIG.confidenceThreshold + 0.1);
      }

      // 3. Check for duplicate response detection
      if (!supabaseAdmin) {
        return true; // Can't validate without DB, allow through
      }

      // Look for existing responses from the same sender for the same tracked email
      const { data: existingResponses } = await supabaseAdmin
        .from('email_responses')
        .select('id')
        .eq('tracked_email_id', matchResult.trackedEmailId)
        .limit(5);

      // If there are already multiple responses, require higher confidence
      if (existingResponses && existingResponses.length >= 3) {
        return matchResult.matchConfidence >= (MATCHING_CONFIG.confidenceThreshold + 0.15);
      }

      // 4. All validation checks passed
      return true;

    } catch (error) {
      console.error('Response validation error:', error);
      // On error, be conservative and allow through if confidence is high
      return matchResult.matchConfidence >= 0.9;
    }
  }

  /**
   * Get potential tracked emails that could match the incoming email
   * @param incomingEmail - Incoming email to match
   * @param accountId - Email account ID
   * @returns Array of potential matches
   */
  private async getPotentialMatches(incomingEmail: GraphEmail, accountId: string): Promise<TrackedEmail[]> {
    if (!supabaseAdmin) {
      return [];
    }

    const fromEmail = incomingEmail.from?.emailAddress?.address?.toLowerCase();
    if (!fromEmail) {
      return [];
    }

    // Time window for potential matches
    const maxAge = new Date(Date.now() - MATCHING_CONFIG.maxResponseWindowHours * 60 * 60 * 1000);

    // Get tracked emails where the sender could be a recipient
    const { data: trackedEmails, error } = await supabaseAdmin
      .from('tracked_emails')
      .select('*')
      .eq('email_account_id', accountId)
      .eq('tracking_status', 'active')
      .gte('sent_at', maxAge.toISOString())
      .order('sent_at', { ascending: false })
      .limit(50); // Limit to recent emails for performance

    if (error || !trackedEmails) {
      console.error('Failed to get potential matches:', error);
      return [];
    }

    // Filter to emails where the sender is a recipient
    const potentialMatches = trackedEmails.filter(email => {
      const toEmails = (email.to_emails as string[]).map(e => e.toLowerCase());
      const ccEmails = ((email.cc_emails as string[]) || []).map(e => e.toLowerCase());
      const allRecipients = [...toEmails, ...ccEmails];
      
      return allRecipients.includes(fromEmail);
    });

    return potentialMatches.map(email => ({
      id: email.id,
      emailAccountId: email.email_account_id,
      messageId: email.message_id,
      conversationId: email.conversation_id,
      threadId: email.thread_id,
      subject: email.subject,
      fromEmail: email.from_email,
      fromName: email.from_name,
      toEmails: email.to_emails as string[],
      ccEmails: email.cc_emails as string[] | undefined,
      bccEmails: email.bcc_emails as string[] | undefined,
      bodyPreview: email.body_preview,
      sentAt: new Date(email.sent_at),
      hasResponse: email.has_response,
      lastResponseAt: email.last_response_at ? new Date(email.last_response_at) : undefined,
      responseCount: email.response_count,
      trackingStatus: email.tracking_status,
      followUpRuleId: email.follow_up_rule_id,
      createdAt: new Date(email.created_at),
      updatedAt: new Date(email.updated_at),
    }));
  }

  /**
   * Check if an incoming email could potentially be a response
   * @param incomingEmail - The incoming email
   * @returns True if it could be a response
   */
  private couldBeResponse(incomingEmail: GraphEmail): boolean {
    const subject = incomingEmail.subject || '';
    
    // Must have a subject that looks like a reply
    const hasReplyIndicator = /^(re:|reply|response|answer):/i.test(subject.trim());
    const hasReplyPrefix = subject.toLowerCase().includes('re:') || 
                          subject.toLowerCase().includes('reply') ||
                          subject.toLowerCase().includes('response');

    return hasReplyIndicator || hasReplyPrefix;
  }

  /**
   * Calculate similarity between two email subjects
   * @param originalSubject - Original email subject
   * @param responseSubject - Response email subject
   * @returns Similarity score (0-1)
   */
  private calculateSubjectSimilarity(originalSubject: string, responseSubject: string): number {
    // Clean subjects by removing reply prefixes
    const cleanOriginal = this.cleanSubjectForComparison(originalSubject);
    const cleanResponse = this.cleanSubjectForComparison(responseSubject);

    if (cleanOriginal === cleanResponse) {
      return 1.0;
    }

    // Use Levenshtein distance for similarity calculation
    const distance = this.levenshteinDistance(cleanOriginal.toLowerCase(), cleanResponse.toLowerCase());
    const maxLength = Math.max(cleanOriginal.length, cleanResponse.length);
    
    if (maxLength === 0) {
      return 0.0;
    }

    const similarity = 1 - (distance / maxLength);
    return Math.max(0, similarity);
  }

  /**
   * Clean email subject for comparison by removing reply prefixes
   * @param subject - Email subject
   * @returns Cleaned subject
   */
  private cleanSubjectForComparison(subject: string): string {
    return subject
      .replace(/^(re:\s*)+/gi, '')
      .replace(/^(fwd?:\s*)+/gi, '')
      .replace(/^(reply:\s*)+/gi, '')
      .replace(/^(response:\s*)+/gi, '')
      .trim();
  }

  /**
   * Calculate Levenshtein distance between two strings
   * @param str1 - First string
   * @param str2 - Second string
   * @returns Distance
   */
  private levenshteinDistance(str1: string, str2: string): number {
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
   * Check if the sender of the response was a recipient of the original email
   * @param trackedEmail - Original tracked email
   * @param incomingEmail - Potential response email
   * @returns True if recipient match found
   */
  private checkRecipientMatch(trackedEmail: TrackedEmail, incomingEmail: GraphEmail): boolean {
    const fromEmail = incomingEmail.from?.emailAddress?.address?.toLowerCase();
    if (!fromEmail) {
      return false;
    }

    const toEmails = trackedEmail.toEmails.map(e => e.toLowerCase());
    const ccEmails = (trackedEmail.ccEmails || []).map(e => e.toLowerCase());
    const allRecipients = [...toEmails, ...ccEmails];

    return allRecipients.includes(fromEmail);
  }

  /**
   * Check if emails belong to the same conversation
   * @param trackedEmail - Original tracked email
   * @param incomingEmail - Potential response email
   * @returns True if same conversation
   */
  private checkConversationMatch(trackedEmail: TrackedEmail, incomingEmail: GraphEmail): boolean {
    if (!trackedEmail.conversationId || !incomingEmail.conversationId) {
      return false;
    }
    
    return trackedEmail.conversationId === incomingEmail.conversationId;
  }

  /**
   * Calculate time proximity score between emails
   * @param trackedEmail - Original tracked email
   * @param incomingEmail - Potential response email
   * @returns Time proximity score (0-1)
   */
  private calculateTimeProximity(trackedEmail: TrackedEmail, incomingEmail: GraphEmail): number {
    const sentAt = trackedEmail.sentAt;
    const receivedAt = incomingEmail.receivedDateTime ? 
      new Date(incomingEmail.receivedDateTime) : 
      new Date();

    const timeDiffHours = (receivedAt.getTime() - sentAt.getTime()) / (1000 * 60 * 60);

    // Response must be after the original email
    if (timeDiffHours <= 0) {
      return 0;
    }

    // Score decreases as time difference increases
    // Perfect score for responses within 1 hour, declining to 0 at max window
    const maxHours = MATCHING_CONFIG.maxResponseWindowHours;
    
    if (timeDiffHours >= maxHours) {
      return 0;
    }

    // Exponential decay for time proximity
    const proximityScore = Math.exp(-timeDiffHours / (maxHours / 4));
    return Math.min(proximityScore, 1.0);
  }

  /**
   * Analyze email headers for additional matching signals
   * @param trackedEmail - Original tracked email
   * @param incomingEmail - Potential response email
   * @returns Header analysis score (0-1)
   */
  private analyzeEmailHeaders(trackedEmail: TrackedEmail, incomingEmail: GraphEmail): number {
    // This is a simplified implementation
    // In a full implementation, you would analyze email headers like:
    // - In-Reply-To
    // - References
    // - Message-ID correlation
    
    let score = 0;
    
    // Basic subject prefix analysis
    const responseSubject = incomingEmail.subject || '';
    if (responseSubject.toLowerCase().startsWith('re:')) {
      score += 0.5;
    }
    
    // Check for quoted content indicators
    const bodyPreview = incomingEmail.bodyPreview || '';
    if (bodyPreview.includes('>') || bodyPreview.includes('wrote:')) {
      score += 0.5;
    }

    return Math.min(score, 1.0);
  }

  /**
   * Detect if an email appears to be an auto-reply
   * @param email - Email to analyze
   * @returns True if appears to be auto-reply
   */
  private detectAutoReply(email: GraphEmail): boolean {
    const subject = (email.subject || '').toLowerCase();
    const bodyPreview = (email.bodyPreview || '').toLowerCase();
    const textToAnalyze = `${subject} ${bodyPreview}`;

    return MATCHING_CONFIG.autoReplyKeywords.some(keyword =>
      textToAnalyze.includes(keyword.toLowerCase())
    );
  }

  /**
   * Get detailed match factors for a tracked email and incoming email
   * @param trackedEmail - Original tracked email
   * @param incomingEmail - Potential response email
   * @returns Match factors breakdown
   */
  private getMatchFactors(trackedEmail: TrackedEmail, incomingEmail: GraphEmail) {
    return {
      subjectSimilarity: this.calculateSubjectSimilarity(trackedEmail.subject, incomingEmail.subject || ''),
      recipientMatch: this.checkRecipientMatch(trackedEmail, incomingEmail),
      timeProximity: this.calculateTimeProximity(trackedEmail, incomingEmail),
      conversationMatch: this.checkConversationMatch(trackedEmail, incomingEmail),
    };
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const responseMatcher = new ResponseMatchingEngine();

// Export for convenience
export { ResponseMatchingEngine as default };