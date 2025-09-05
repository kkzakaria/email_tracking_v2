/**
 * Microsoft Graph Subscription Manager
 * Email Tracking System - Phase 2 Critical Subscription Infrastructure
 * Created: 2025-09-05 for Microsoft Graph webhook subscriptions
 * 
 * ⚠️ CRITICAL: This service manages Microsoft Graph webhook subscriptions
 * Handles creation, renewal, and monitoring of email tracking subscriptions
 */

import { supabaseAdmin } from './supabase';
import { auditLogger } from './audit-logger';
import { createGraphClient } from './microsoft-graph-client';
import { rateLimiter } from './rate-limiter';
import {
  WebhookSubscriptionCreate,
  WebhookSubscriptionResponse,
  SubscriptionManager,
  SubscriptionStatus,
  SubscriptionManagementError,
  WebhookSubscriptionRecord
} from '@/types/microsoft-graph-webhooks';

// ============================================================================
// CONFIGURATION
// ============================================================================

const SUBSCRIPTION_CONFIG = {
  defaultExpirationHours: parseInt(process.env.SUBSCRIPTION_EXPIRATION_HOURS || '72'),
  renewalThresholdHours: parseInt(process.env.SUBSCRIPTION_RENEWAL_THRESHOLD_HOURS || '48'),
  maxRetryAttempts: parseInt(process.env.SUBSCRIPTION_MAX_RETRIES || '3'),
  renewalCheckIntervalMs: parseInt(process.env.SUBSCRIPTION_RENEWAL_CHECK_INTERVAL || '3600000'), // 1 hour
  baseUrl: process.env.WEBHOOK_BASE_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000',
  clientState: process.env.WEBHOOK_CLIENT_STATE || 'email-tracking-webhook-v1',
} as const;

const SUBSCRIPTION_RESOURCES = {
  email: 'me/messages',
  mailbox: 'me/mailFolders',
} as const;

/**
 * Generate notification URL for webhook subscriptions
 * @param resource - Resource type being subscribed to
 * @returns Full notification URL
 */
function generateNotificationUrl(resource: string): string {
  const baseUrl = SUBSCRIPTION_CONFIG.baseUrl.replace(/\/$/, '');
  return `${baseUrl}/api/webhooks/microsoft`;
}

/**
 * Calculate subscription expiration date
 * @param hours - Hours from now
 * @returns ISO string date
 */
function calculateExpirationDate(hours: number): string {
  const expirationTime = new Date(Date.now() + (hours * 60 * 60 * 1000));
  return expirationTime.toISOString();
}

// ============================================================================
// SUBSCRIPTION MANAGER CLASS
// ============================================================================

export class MicrosoftGraphSubscriptionManager implements SubscriptionManager {
  private renewalInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.startRenewalMonitoring();
  }

  /**
   * Create a new webhook subscription for an email account
   * @param accountId - Email account ID
   * @param resource - Resource to subscribe to (default: 'email')
   * @returns Created subscription response
   */
  async createSubscription(
    accountId: string, 
    resource: string = 'email'
  ): Promise<WebhookSubscriptionResponse> {
    try {
      if (!supabaseAdmin) {
        throw new Error('Database connection not available');
      }

      // Check if subscription already exists
      const existingSubscription = await this.getActiveSubscription(accountId, resource);
      if (existingSubscription && existingSubscription.isActive) {
        throw new SubscriptionManagementError(
          'Active subscription already exists for this account and resource',
          existingSubscription.microsoftSubscriptionId,
          accountId,
          'create'
        );
      }

      // Check rate limits
      const rateLimitResult = await rateLimiter.checkAndRecord(accountId, 'webhook_create');
      if (!rateLimitResult.allowed) {
        throw new SubscriptionManagementError(
          `Rate limit exceeded for webhook creation: ${rateLimitResult.current_count}/${rateLimitResult.limit}`,
          undefined,
          accountId,
          'create'
        );
      }

      // Create Graph client for the account
      const graphClient = createGraphClient(accountId);

      // Prepare subscription data
      const subscriptionData: WebhookSubscriptionCreate = {
        changeType: 'created,updated,deleted',
        notificationUrl: generateNotificationUrl(resource),
        resource: SUBSCRIPTION_RESOURCES[resource as keyof typeof SUBSCRIPTION_RESOURCES] || resource,
        expirationDateTime: calculateExpirationDate(SUBSCRIPTION_CONFIG.defaultExpirationHours),
        clientState: SUBSCRIPTION_CONFIG.clientState,
      };

      // Create subscription via Microsoft Graph
      const microsoftResponse = await graphClient.createSubscription(subscriptionData);

      // Store subscription in database
      const subscriptionRecord: Omit<WebhookSubscriptionRecord, 'id' | 'created_at' | 'updated_at'> = {
        email_account_id: accountId,
        microsoft_subscription_id: microsoftResponse.id,
        resource: subscriptionData.resource,
        change_type: subscriptionData.changeType,
        notification_url: subscriptionData.notificationUrl,
        expires_at: new Date(microsoftResponse.expirationDateTime),
        client_state: subscriptionData.clientState,
        is_active: true,
        error_count: 0,
      };

      const { data: savedSubscription, error } = await supabaseAdmin
        .from('webhook_subscriptions')
        .insert([subscriptionRecord])
        .select()
        .single();

      if (error) {
        // Try to delete the Microsoft subscription since we couldn't save it
        try {
          await graphClient.callAPI(`/subscriptions/${microsoftResponse.id}`, 'DELETE');
        } catch (cleanupError) {
          console.error('Failed to cleanup Microsoft subscription after database error:', cleanupError);
        }

        throw new Error(`Failed to save subscription to database: ${error.message}`);
      }

      // Update email account with subscription info
      await supabaseAdmin
        .from('email_accounts')
        .update({
          webhook_subscription_id: microsoftResponse.id,
          webhook_expires_at: new Date(microsoftResponse.expirationDateTime),
          updated_at: new Date(),
        })
        .eq('id', accountId);

      // Log successful creation
      await auditLogger.logEvent(
        'webhook_subscription_created',
        'medium',
        {
          account_id: accountId,
          subscription_id: microsoftResponse.id,
          resource: subscriptionData.resource,
          expires_at: microsoftResponse.expirationDateTime,
          notification_url: subscriptionData.notificationUrl,
        }
      );

      return microsoftResponse;

    } catch (error) {
      console.error(`Failed to create subscription for account ${accountId}:`, error);

      await auditLogger.logEvent(
        'webhook_subscription_creation_failed',
        'high',
        {
          account_id: accountId,
          resource,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );

      if (error instanceof SubscriptionManagementError) {
        throw error;
      }

      throw new SubscriptionManagementError(
        'Failed to create webhook subscription',
        undefined,
        accountId,
        'create'
      );
    }
  }

  /**
   * Renew an existing webhook subscription
   * @param subscriptionId - Microsoft subscription ID to renew
   * @returns Renewed subscription response
   */
  async renewSubscription(subscriptionId: string): Promise<WebhookSubscriptionResponse> {
    try {
      if (!supabaseAdmin) {
        throw new Error('Database connection not available');
      }

      // Get subscription record from database
      const { data: subscriptionRecord, error: fetchError } = await supabaseAdmin
        .from('webhook_subscriptions')
        .select('*')
        .eq('microsoft_subscription_id', subscriptionId)
        .eq('is_active', true)
        .single();

      if (fetchError || !subscriptionRecord) {
        throw new SubscriptionManagementError(
          'Subscription not found or inactive',
          subscriptionId,
          undefined,
          'renew'
        );
      }

      // Check rate limits
      const rateLimitResult = await rateLimiter.checkAndRecord(
        subscriptionRecord.email_account_id, 
        'webhook_create'
      );
      
      if (!rateLimitResult.allowed) {
        throw new SubscriptionManagementError(
          `Rate limit exceeded for subscription renewal: ${rateLimitResult.current_count}/${rateLimitResult.limit}`,
          subscriptionId,
          subscriptionRecord.email_account_id,
          'renew'
        );
      }

      // Create Graph client for the account
      const graphClient = createGraphClient(subscriptionRecord.email_account_id);

      // Prepare renewal data
      const newExpirationDateTime = calculateExpirationDate(SUBSCRIPTION_CONFIG.defaultExpirationHours);

      // Renew subscription via Microsoft Graph
      const renewalData = {
        expirationDateTime: newExpirationDateTime,
      };

      const microsoftResponse = await graphClient.callAPI(
        `/subscriptions/${subscriptionId}`,
        'PATCH',
        renewalData
      );

      // Update subscription record in database
      const updateData = {
        expires_at: new Date(newExpirationDateTime),
        last_renewed_at: new Date(),
        error_count: 0, // Reset error count on successful renewal
        last_error: null,
        updated_at: new Date(),
      };

      await supabaseAdmin
        .from('webhook_subscriptions')
        .update(updateData)
        .eq('microsoft_subscription_id', subscriptionId);

      // Update email account
      await supabaseAdmin
        .from('email_accounts')
        .update({
          webhook_expires_at: new Date(newExpirationDateTime),
          updated_at: new Date(),
        })
        .eq('id', subscriptionRecord.email_account_id);

      // Log successful renewal
      await auditLogger.logEvent(
        'webhook_subscription_renewed',
        'medium',
        {
          subscription_id: subscriptionId,
          account_id: subscriptionRecord.email_account_id,
          new_expiration: newExpirationDateTime,
          resource: subscriptionRecord.resource,
        }
      );

      return microsoftResponse as WebhookSubscriptionResponse;

    } catch (error) {
      console.error(`Failed to renew subscription ${subscriptionId}:`, error);

      // Increment error count
      if (supabaseAdmin) {
        await supabaseAdmin
          .from('webhook_subscriptions')
          .update({
            error_count: supabaseAdmin.raw('error_count + 1'),
            last_error: error instanceof Error ? error.message : 'Unknown error',
            updated_at: new Date(),
          })
          .eq('microsoft_subscription_id', subscriptionId);
      }

      await auditLogger.logEvent(
        'webhook_subscription_renewal_failed',
        'high',
        {
          subscription_id: subscriptionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );

      if (error instanceof SubscriptionManagementError) {
        throw error;
      }

      throw new SubscriptionManagementError(
        'Failed to renew webhook subscription',
        subscriptionId,
        undefined,
        'renew'
      );
    }
  }

  /**
   * Delete a webhook subscription
   * @param subscriptionId - Microsoft subscription ID to delete
   */
  async deleteSubscription(subscriptionId: string): Promise<void> {
    try {
      if (!supabaseAdmin) {
        throw new Error('Database connection not available');
      }

      // Get subscription record
      const { data: subscriptionRecord } = await supabaseAdmin
        .from('webhook_subscriptions')
        .select('*')
        .eq('microsoft_subscription_id', subscriptionId)
        .single();

      if (subscriptionRecord) {
        // Create Graph client
        const graphClient = createGraphClient(subscriptionRecord.email_account_id);

        // Delete subscription from Microsoft Graph
        await graphClient.callAPI(`/subscriptions/${subscriptionId}`, 'DELETE');

        // Mark subscription as inactive in database
        await supabaseAdmin
          .from('webhook_subscriptions')
          .update({
            is_active: false,
            updated_at: new Date(),
          })
          .eq('microsoft_subscription_id', subscriptionId);

        // Update email account
        await supabaseAdmin
          .from('email_accounts')
          .update({
            webhook_subscription_id: null,
            webhook_expires_at: null,
            updated_at: new Date(),
          })
          .eq('id', subscriptionRecord.email_account_id);

        await auditLogger.logEvent(
          'webhook_subscription_deleted',
          'medium',
          {
            subscription_id: subscriptionId,
            account_id: subscriptionRecord.email_account_id,
          }
        );
      }

    } catch (error) {
      console.error(`Failed to delete subscription ${subscriptionId}:`, error);
      
      await auditLogger.logEvent(
        'webhook_subscription_deletion_failed',
        'high',
        {
          subscription_id: subscriptionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        }
      );

      throw new SubscriptionManagementError(
        'Failed to delete webhook subscription',
        subscriptionId,
        undefined,
        'delete'
      );
    }
  }

  /**
   * Get status of a specific subscription
   * @param subscriptionId - Microsoft subscription ID
   * @returns Subscription status
   */
  async getSubscriptionStatus(subscriptionId: string): Promise<SubscriptionStatus> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    const { data: subscription, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('*')
      .eq('microsoft_subscription_id', subscriptionId)
      .single();

    if (error || !subscription) {
      throw new SubscriptionManagementError(
        'Subscription not found',
        subscriptionId,
        undefined,
        'status'
      );
    }

    const expiresAt = new Date(subscription.expires_at);
    const hoursUntilExpiration = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);

    return {
      id: subscription.id,
      accountId: subscription.email_account_id,
      resource: subscription.resource,
      isActive: subscription.is_active && hoursUntilExpiration > 0,
      expiresAt,
      createdAt: new Date(subscription.created_at),
      lastRenewedAt: subscription.last_renewed_at ? new Date(subscription.last_renewed_at) : undefined,
      errorCount: subscription.error_count,
      lastError: subscription.last_error,
      nextRenewalCheck: new Date(Date.now() + SUBSCRIPTION_CONFIG.renewalCheckIntervalMs),
      microsoftSubscriptionId: subscription.microsoft_subscription_id,
    };
  }

  /**
   * Get all subscriptions for an account
   * @param accountId - Email account ID
   * @returns Array of subscription statuses
   */
  async getAccountSubscriptions(accountId: string): Promise<SubscriptionStatus[]> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    const { data: subscriptions, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('*')
      .eq('email_account_id', accountId)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch account subscriptions: ${error.message}`);
    }

    return subscriptions.map(sub => {
      const expiresAt = new Date(sub.expires_at);
      const hoursUntilExpiration = (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);

      return {
        id: sub.id,
        accountId: sub.email_account_id,
        resource: sub.resource,
        isActive: sub.is_active && hoursUntilExpiration > 0,
        expiresAt,
        createdAt: new Date(sub.created_at),
        lastRenewedAt: sub.last_renewed_at ? new Date(sub.last_renewed_at) : undefined,
        errorCount: sub.error_count,
        lastError: sub.last_error,
        nextRenewalCheck: new Date(Date.now() + SUBSCRIPTION_CONFIG.renewalCheckIntervalMs),
        microsoftSubscriptionId: sub.microsoft_subscription_id,
      };
    });
  }

  /**
   * Check for subscriptions that need renewal
   * @returns Array of subscription statuses that need renewal
   */
  async checkExpiringSubscriptions(): Promise<SubscriptionStatus[]> {
    if (!supabaseAdmin) {
      throw new Error('Database connection not available');
    }

    const thresholdDate = new Date(
      Date.now() + (SUBSCRIPTION_CONFIG.renewalThresholdHours * 60 * 60 * 1000)
    );

    const { data: expiringSubs, error } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('*')
      .eq('is_active', true)
      .lte('expires_at', thresholdDate.toISOString())
      .order('expires_at', { ascending: true });

    if (error) {
      console.error('Failed to fetch expiring subscriptions:', error);
      return [];
    }

    return expiringSubs.map(sub => ({
      id: sub.id,
      accountId: sub.email_account_id,
      resource: sub.resource,
      isActive: sub.is_active,
      expiresAt: new Date(sub.expires_at),
      createdAt: new Date(sub.created_at),
      lastRenewedAt: sub.last_renewed_at ? new Date(sub.last_renewed_at) : undefined,
      errorCount: sub.error_count,
      lastError: sub.last_error,
      nextRenewalCheck: new Date(Date.now() + SUBSCRIPTION_CONFIG.renewalCheckIntervalMs),
      microsoftSubscriptionId: sub.microsoft_subscription_id,
    }));
  }

  /**
   * Get active subscription for an account and resource
   * @param accountId - Email account ID
   * @param resource - Resource type
   * @returns Subscription status or null
   */
  private async getActiveSubscription(accountId: string, resource: string): Promise<SubscriptionStatus | null> {
    if (!supabaseAdmin) {
      return null;
    }

    const { data: subscription } = await supabaseAdmin
      .from('webhook_subscriptions')
      .select('*')
      .eq('email_account_id', accountId)
      .eq('resource', SUBSCRIPTION_RESOURCES[resource as keyof typeof SUBSCRIPTION_RESOURCES] || resource)
      .eq('is_active', true)
      .single();

    if (!subscription) {
      return null;
    }

    const expiresAt = new Date(subscription.expires_at);
    const isStillActive = expiresAt.getTime() > Date.now();

    if (!isStillActive) {
      // Mark as inactive if expired
      await supabaseAdmin
        .from('webhook_subscriptions')
        .update({ is_active: false, updated_at: new Date() })
        .eq('id', subscription.id);

      return null;
    }

    return {
      id: subscription.id,
      accountId: subscription.email_account_id,
      resource: subscription.resource,
      isActive: isStillActive,
      expiresAt,
      createdAt: new Date(subscription.created_at),
      lastRenewedAt: subscription.last_renewed_at ? new Date(subscription.last_renewed_at) : undefined,
      errorCount: subscription.error_count,
      lastError: subscription.last_error,
      nextRenewalCheck: new Date(Date.now() + SUBSCRIPTION_CONFIG.renewalCheckIntervalMs),
      microsoftSubscriptionId: subscription.microsoft_subscription_id,
    };
  }

  /**
   * Start automatic renewal monitoring
   */
  private startRenewalMonitoring(): void {
    if (this.renewalInterval) {
      return; // Already started
    }

    this.renewalInterval = setInterval(
      () => this.performAutomaticRenewals(),
      SUBSCRIPTION_CONFIG.renewalCheckIntervalMs
    );

    console.log(`🔄 Subscription renewal monitoring started (interval: ${SUBSCRIPTION_CONFIG.renewalCheckIntervalMs}ms)`);
  }

  /**
   * Stop automatic renewal monitoring
   */
  stopRenewalMonitoring(): void {
    if (this.renewalInterval) {
      clearInterval(this.renewalInterval);
      this.renewalInterval = null;
    }
    console.log('🔄 Subscription renewal monitoring stopped');
  }

  /**
   * Perform automatic renewals for expiring subscriptions
   */
  private async performAutomaticRenewals(): Promise<void> {
    try {
      const expiringSubs = await this.checkExpiringSubscriptions();
      
      if (expiringSubs.length === 0) {
        return;
      }

      console.log(`🔄 Found ${expiringSubs.length} subscriptions needing renewal`);

      // Renew subscriptions concurrently (with reasonable limit)
      const renewalPromises = expiringSubs
        .slice(0, 10) // Limit concurrent renewals
        .map(async (sub) => {
          try {
            await this.renewSubscription(sub.microsoftSubscriptionId);
            console.log(`✅ Successfully renewed subscription ${sub.microsoftSubscriptionId}`);
          } catch (error) {
            console.error(`❌ Failed to auto-renew subscription ${sub.microsoftSubscriptionId}:`, error);
          }
        });

      await Promise.allSettled(renewalPromises);

    } catch (error) {
      console.error('Error during automatic renewal check:', error);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

export const subscriptionManager = new MicrosoftGraphSubscriptionManager();

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('Shutting down subscription manager...');
  subscriptionManager.stopRenewalMonitoring();
});

process.on('SIGTERM', () => {
  console.log('Shutting down subscription manager...');
  subscriptionManager.stopRenewalMonitoring();
});