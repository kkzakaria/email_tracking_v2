/**
 * Microsoft Graph Webhook Types and Interfaces
 * Email Tracking System - Webhook Pipeline Infrastructure
 * Created: 2025-09-05 for Phase 2 Webhook Implementation
 * 
 * ⚠️ CRITICAL: These types must match Microsoft Graph API specifications
 * Reference: https://docs.microsoft.com/en-us/graph/webhooks
 */

// ============================================================================
// MICROSOFT GRAPH WEBHOOK NOTIFICATION TYPES
// ============================================================================

export interface MicrosoftGraphNotification {
  subscriptionId: string;
  subscriptionExpirationDateTime: string;
  changeType: string;
  resource: string;
  resourceData?: {
    id: string;
    '@odata.type': string;
    '@odata.id': string;
  };
  clientState?: string;
  tenantId: string;
}

export interface MicrosoftGraphWebhookPayload {
  value: MicrosoftGraphNotification[];
  validationTokens?: string[];
}

// ============================================================================
// WEBHOOK SUBSCRIPTION MANAGEMENT TYPES
// ============================================================================

export interface WebhookSubscriptionCreate {
  changeType: 'created,updated,deleted' | 'created' | 'updated' | 'deleted';
  notificationUrl: string;
  resource: string;
  expirationDateTime: string;
  clientState?: string;
  includeResourceData?: boolean;
  encryptionCertificate?: string;
  encryptionCertificateId?: string;
}

export interface WebhookSubscriptionResponse {
  id: string;
  resource: string;
  applicationId: string;
  changeType: string;
  clientState: string | null;
  notificationUrl: string;
  expirationDateTime: string;
  creatorId: string;
  includeResourceData: boolean | null;
  lifecycleNotificationUrl: string | null;
  encryptionCertificate: string | null;
  encryptionCertificateId: string | null;
  latestSupportedTlsVersion: string;
  notificationQueryOptions: string | null;
  notificationUrlAppId: string | null;
}

// ============================================================================
// WEBHOOK QUEUE AND PROCESSING TYPES
// ============================================================================

export interface WebhookJob {
  id: string;
  notification: MicrosoftGraphNotification;
  accountId: string;
  retryCount: number;
  maxRetries: number;
  priority: 'high' | 'normal' | 'low';
  createdAt: Date;
  scheduledFor: Date;
  processedAt?: Date;
  errorMessage?: string;
  lastAttemptAt?: Date;
}

export interface QueueProcessor {
  addJob(notification: MicrosoftGraphNotification, accountId: string): Promise<void>;
  processJobs(): Promise<void>;
  handleRetry(job: WebhookJob): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
}

export interface QueueStats {
  totalJobs: number;
  pendingJobs: number;
  processingJobs: number;
  completedJobs: number;
  failedJobs: number;
  retryJobs: number;
  oldestPendingJob?: Date;
  averageProcessingTime: number;
}

// ============================================================================
// SUBSCRIPTION MANAGEMENT TYPES
// ============================================================================

export interface SubscriptionManager {
  createSubscription(accountId: string, resource: string): Promise<WebhookSubscriptionResponse>;
  renewSubscription(subscriptionId: string): Promise<WebhookSubscriptionResponse>;
  deleteSubscription(subscriptionId: string): Promise<void>;
  getSubscriptionStatus(subscriptionId: string): Promise<SubscriptionStatus>;
  getAccountSubscriptions(accountId: string): Promise<SubscriptionStatus[]>;
  checkExpiringSubscriptions(): Promise<SubscriptionStatus[]>;
}

export interface SubscriptionStatus {
  id: string;
  accountId: string;
  resource: string;
  isActive: boolean;
  expiresAt: Date;
  createdAt: Date;
  lastRenewedAt?: Date;
  errorCount: number;
  lastError?: string;
  nextRenewalCheck: Date;
  microsoftSubscriptionId: string;
}

// ============================================================================
// EMAIL CHANGE DETECTION TYPES
// ============================================================================

export interface EmailChangeDetector {
  processNotification(notification: MicrosoftGraphNotification): Promise<EmailChangeResult>;
  detectNewEmail(messageId: string, accountId: string): Promise<TrackedEmailUpdate | null>;
  detectEmailResponse(messageId: string, accountId: string): Promise<ResponseDetectionResult | null>;
  updateTrackedEmailStatus(emailId: string, status: EmailChangeStatus): Promise<void>;
}

export interface EmailChangeResult {
  type: 'new_email' | 'response_detected' | 'email_updated' | 'email_deleted' | 'no_action';
  success: boolean;
  emailId?: string;
  responseId?: string;
  details?: Record<string, unknown>;
  error?: string;
}

export interface TrackedEmailUpdate {
  id: string;
  messageId: string;
  subject: string;
  hasResponse: boolean;
  responseCount: number;
  lastResponseAt?: Date;
  trackingStatus: 'active' | 'paused' | 'completed' | 'failed';
}

export interface ResponseDetectionResult {
  responseId: string;
  trackedEmailId: string;
  responseMessageId: string;
  fromEmail: string;
  fromName?: string;
  receivedAt: Date;
  subject: string;
  bodyPreview?: string;
  isAutoReply: boolean;
  confidence: number; // 0-1 score for response matching
}

export interface EmailChangeStatus {
  hasResponse: boolean;
  responseCount: number;
  lastResponseAt?: Date;
  trackingStatus: 'active' | 'paused' | 'completed' | 'failed';
}

// ============================================================================
// WEBHOOK VALIDATION AND SECURITY TYPES
// ============================================================================

export interface WebhookValidation {
  validateSignature(payload: string, signature: string, secret: string): boolean;
  validateTokenChallenge(token: string): boolean;
  validateNotificationStructure(notification: MicrosoftGraphNotification): ValidationResult;
  validateSubscriptionOwnership(subscriptionId: string, accountId: string): Promise<boolean>;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================================================
// WEBHOOK MONITORING AND HEALTH TYPES
// ============================================================================

export interface WebhookHealthCheck {
  endpoint: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: Date;
  responseTime: number;
  errorCount: number;
  lastError?: string;
}

export interface WebhookMetrics {
  totalNotificationsReceived: number;
  notificationsProcessed: number;
  notificationsFailed: number;
  averageProcessingTime: number;
  queueBacklog: number;
  activeSubscriptions: number;
  expiringSubscriptions: number;
  lastNotificationReceived?: Date;
  systemHealth: 'healthy' | 'degraded' | 'unhealthy';
}

// ============================================================================
// ERROR TYPES
// ============================================================================

export class WebhookValidationError extends Error {
  constructor(
    message: string,
    public validationErrors: string[],
    public notificationId?: string
  ) {
    super(message);
    this.name = 'WebhookValidationError';
  }
}

export class WebhookProcessingError extends Error {
  constructor(
    message: string,
    public notificationId: string,
    public retryable: boolean = true,
    public originalError?: Error
  ) {
    super(message);
    this.name = 'WebhookProcessingError';
  }
}

export class SubscriptionManagementError extends Error {
  constructor(
    message: string,
    public subscriptionId?: string,
    public accountId?: string,
    public operation?: string
  ) {
    super(message);
    this.name = 'SubscriptionManagementError';
  }
}

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export interface WebhookConfig {
  baseUrl: string;
  webhookSecret: string;
  validationToken: string;
  maxRetries: number;
  retryDelayMs: number;
  maxRetryDelayMs: number;
  subscriptionExpirationHours: number;
  renewalThresholdHours: number;
  queueProcessingIntervalMs: number;
  maxConcurrentJobs: number;
  deadLetterQueueEnabled: boolean;
}

// ============================================================================
// DATABASE INTEGRATION TYPES
// ============================================================================

export interface WebhookSubscriptionRecord {
  id: string;
  email_account_id: string;
  microsoft_subscription_id: string;
  resource: string;
  change_type: string;
  notification_url: string;
  expires_at: Date;
  client_state?: string;
  is_active: boolean;
  error_count: number;
  last_error?: string;
  last_renewed_at?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface WebhookQueueRecord {
  id: string;
  notification_data: MicrosoftGraphNotification;
  account_id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter';
  retry_count: number;
  max_retries: number;
  scheduled_for: Date;
  processed_at?: Date;
  error_message?: string;
  created_at: Date;
  updated_at: Date;
}