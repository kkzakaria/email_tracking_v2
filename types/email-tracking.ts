/**
 * Email Tracking System Types
 * Phase 2 Critical Implementation - Email Tracking Engine Types
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: These types support the email tracking service and lifecycle management
 */

import { TrackingStatusEnum } from './database';

// ============================================================================
// EMAIL TRACKING STATUS TYPES
// ============================================================================

export enum EmailTrackingStatus {
  PENDING = 'pending',           // Email en attente d'envoi
  SENT = 'sent',                 // Email envoyé
  DELIVERED = 'delivered',       // Email livré (via webhook)
  OPENED = 'opened',             // Email ouvert (si tracking pixels)
  REPLIED = 'replied',           // Réponse reçue
  BOUNCED = 'bounced',           // Email rejeté
  CLOSED = 'closed'              // Tracking terminé
}

export interface EmailTrackingTransitions {
  [key: string]: EmailTrackingStatus[];
}

// ============================================================================
// EMAIL TRACKING METRICS TYPES
// ============================================================================

export interface EmailTrackingMetrics {
  totalTracked: number;
  responseRate: number;              // % d'emails avec réponse
  averageResponseTime: number;       // Temps moyen de réponse (heures)
  bounceRate: number;               // % d'emails bounced
  deliveryRate: number;             // % d'emails delivered
  engagementScore: number;          // Score d'engagement calculé
  periodStart: Date;                // Début de période des métriques
  periodEnd: Date;                  // Fin de période des métriques
}

export interface EmailTrackingStats {
  byStatus: Record<EmailTrackingStatus, number>;
  byTimeRange: {
    last24h: number;
    last7d: number;
    last30d: number;
    allTime: number;
  };
  responseMetrics: {
    averageResponseTimeHours: number;
    medianResponseTimeHours: number;
    responsesByDay: Array<{
      date: string;
      count: number;
    }>;
  };
}

// ============================================================================
// EMAIL INGESTION TYPES
// ============================================================================

export interface EmailIngestionOptions {
  since?: Date;                     // Date à partir de laquelle récupérer
  batchSize?: number;               // Taille du batch de traitement
  forceRefresh?: boolean;           // Force la resynchronisation
  includeDeleted?: boolean;         // Inclure les emails supprimés
}

export interface EmailIngestionResult {
  success: boolean;
  processedCount: number;
  newTrackedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: Array<{
    messageId: string;
    error: string;
    retryable: boolean;
  }>;
  startTime: Date;
  endTime: Date;
  nextCursor?: string;              // Pour pagination
}

export interface GraphEmail {
  id: string;
  conversationId?: string;
  subject: string;
  from?: {
    emailAddress: {
      address: string;
      name?: string;
    };
  };
  toRecipients: Array<{
    emailAddress: {
      address: string;
      name?: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress: {
      address: string;
      name?: string;
    };
  }>;
  bodyPreview?: string;
  sentDateTime?: string;
  receivedDateTime?: string;
  createdDateTime?: string;
  isDraft: boolean;
  isRead: boolean;
}

// ============================================================================
// EMAIL OPERATIONS INTERFACE
// ============================================================================

export interface EmailOperations {
  // Récupération des emails sortants récents
  getRecentSentEmails(accountId: string, since?: Date): Promise<GraphEmail[]>;
  
  // Détails d'un email spécifique
  getEmailDetails(accountId: string, messageId: string): Promise<GraphEmail>;
  
  // Recherche dans les conversations
  searchEmailThread(accountId: string, threadId: string): Promise<GraphEmail[]>;
  
  // Marquage des emails comme lus/trackés
  updateEmailProperties(accountId: string, messageId: string, properties: Record<string, unknown>): Promise<void>;
  
  // Récupération par batch avec pagination
  getEmailsBatch(accountId: string, options: EmailIngestionOptions): Promise<{
    emails: GraphEmail[];
    nextCursor?: string;
    hasMore: boolean;
  }>;
}

// ============================================================================
// EMAIL TRACKING SERVICE TYPES
// ============================================================================

export interface EmailTrackingService {
  // Core tracking operations
  startTracking(accountId: string, messageId: string): Promise<TrackedEmail>;
  stopTracking(emailId: string): Promise<void>;
  getTrackedEmail(emailId: string): Promise<TrackedEmail | null>;
  
  // Batch operations
  syncAccountEmails(accountId: string, options?: EmailIngestionOptions): Promise<EmailIngestionResult>;
  
  // Status updates
  updateTrackingStatus(emailId: string, status: EmailTrackingStatus): Promise<void>;
  
  // Metrics and analytics
  getTrackingMetrics(accountId: string, dateRange?: { start: Date; end: Date }): Promise<EmailTrackingMetrics>;
  getTrackingStats(accountId: string): Promise<EmailTrackingStats>;
}

// ============================================================================
// TRACKED EMAIL TYPES
// ============================================================================

export interface TrackedEmail {
  id: string;
  emailAccountId: string;
  messageId: string;
  conversationId?: string;
  threadId?: string;
  subject: string;
  fromEmail: string;
  fromName?: string;
  toEmails: string[];
  ccEmails?: string[];
  bccEmails?: string[];
  bodyPreview?: string;
  sentAt: Date;
  hasResponse: boolean;
  lastResponseAt?: Date;
  responseCount: number;
  trackingStatus: TrackingStatusEnum;
  followUpRuleId?: string;
  createdAt: Date;
  updatedAt: Date;
  
  // Calculated fields
  responseTimeHours?: number;
  isOverdue?: boolean;
  engagementScore?: number;
}

export interface TrackedEmailFilters {
  status?: TrackingStatusEnum | TrackingStatusEnum[];
  hasResponse?: boolean;
  dateRange?: {
    start: Date;
    end: Date;
  };
  searchQuery?: string;           // Recherche dans subject/recipients
  sortBy?: 'sent_at' | 'updated_at' | 'response_count' | 'subject';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

// ============================================================================
// RESPONSE MATCHING TYPES
// ============================================================================

export interface ResponseMatcher {
  matchResponse(incomingEmail: GraphEmail, accountId: string): Promise<ResponseMatchResult | null>;
  calculateMatchConfidence(trackedEmail: TrackedEmail, incomingEmail: GraphEmail): number;
  validateResponse(matchResult: ResponseMatchResult): Promise<boolean>;
}

export interface ResponseMatchResult {
  trackedEmailId: string;
  matchConfidence: number;        // 0-1 score
  matchFactors: {
    subjectSimilarity: number;
    recipientMatch: boolean;
    timeProximity: number;
    conversationMatch: boolean;
  };
  isAutoReply: boolean;
  validationScore: number;
}

// ============================================================================
// EMAIL LIFECYCLE TYPES
// ============================================================================

export interface EmailLifecycleManager {
  transitionStatus(emailId: string, fromStatus: EmailTrackingStatus, toStatus: EmailTrackingStatus): Promise<boolean>;
  validateTransition(fromStatus: EmailTrackingStatus, toStatus: EmailTrackingStatus): boolean;
  getValidTransitions(currentStatus: EmailTrackingStatus): EmailTrackingStatus[];
  
  // Automatic lifecycle management
  processTimeouts(): Promise<number>;    // Returns number of emails processed
  archiveOldEmails(olderThanDays: number): Promise<number>;
  cleanupFailedEmails(): Promise<number>;
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface EmailTrackingConfig {
  enabled: boolean;
  maxAgeDays: number;                    // Archiver après X jours
  syncIntervalMinutes: number;           // Sync toutes les X minutes
  batchSize: number;                     // Traiter X emails par batch
  autoTrackOutbound: boolean;            // Tracker automatiquement les sortants
  
  // Response detection
  responseDetection: {
    confidenceThreshold: number;         // Seuil de confiance minimum
    autoReplyFilter: boolean;           // Filtrer les auto-replies
    maxThreadDepth: number;             // Profondeur max des threads
  };
  
  // Performance settings
  performance: {
    maxConcurrentSyncs: number;
    rateLimitBuffer: number;            // % de buffer sur les limites
    retryBackoffMs: number;
  };
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class EmailTrackingError extends Error {
  constructor(
    message: string,
    public code: string,
    public accountId?: string,
    public emailId?: string,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'EmailTrackingError';
  }
}

export class EmailIngestionError extends Error {
  constructor(
    message: string,
    public accountId: string,
    public batchSize: number,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'EmailIngestionError';
  }
}

export class ResponseMatchingError extends Error {
  constructor(
    message: string,
    public messageId: string,
    public accountId: string
  ) {
    super(message);
    this.name = 'ResponseMatchingError';
  }
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface TrackedEmailsResponse {
  data: TrackedEmail[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  filters: TrackedEmailFilters;
}

export interface EmailTrackingResponse {
  success: boolean;
  data?: TrackedEmail;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export interface SyncResponse {
  success: boolean;
  data?: EmailIngestionResult;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}