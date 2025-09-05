/**
 * Security Audit Logger
 * Email Tracking System - Comprehensive Security Event Tracking
 * Created: 2025-09-05 by security-engineer
 * 
 * ⚠️ CRITICAL: All security-related events must be logged through this service
 * Provides tamper-evident audit trails and compliance logging
 */

import { supabaseAdmin } from './supabase';
import { createHash } from 'crypto';
import { Database } from '../types/database';

type AuditLog = Database['public']['Tables']['audit_logs']['Row'];
type AuditLogInsert = Database['public']['Tables']['audit_logs']['Insert'];

/**
 * Security event severity levels
 */
export type SecuritySeverity = 'info' | 'warning' | 'error' | 'critical';

/**
 * Security event categories
 */
export type SecurityEventType = 
  | 'authentication' 
  | 'authorization' 
  | 'data_access' 
  | 'data_modification' 
  | 'token_operation'
  | 'rate_limit' 
  | 'webhook' 
  | 'encryption'
  | 'validation'
  | 'security_violation';

/**
 * Comprehensive audit event interface
 */
export interface SecurityAuditEvent {
  user_id?: string;
  session_id?: string;
  action: string;
  resource_type: string;
  resource_id?: string;
  event_type: SecurityEventType;
  severity: SecuritySeverity;
  metadata?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  success: boolean;
  error_message?: string;
  performance_metrics?: {
    execution_time_ms?: number;
    memory_usage_mb?: number;
  };
  compliance_flags?: {
    gdpr_relevant?: boolean;
    pii_involved?: boolean;
    financial_data?: boolean;
  };
}

/**
 * Audit trail integrity verification
 */
interface AuditIntegrity {
  hash: string;
  previous_hash?: string;
  timestamp: string;
  event_count: number;
}

/**
 * Security metrics aggregation
 */
interface SecurityMetrics {
  total_events: number;
  events_by_severity: Record<SecuritySeverity, number>;
  events_by_type: Record<SecurityEventType, number>;
  failed_operations: number;
  suspicious_activities: number;
  last_24h_events: number;
}

/**
 * Main Audit Logger Class
 */
export class SecurityAuditLogger {
  private static instance: SecurityAuditLogger;
  private lastAuditHash: string = '';
  private eventCounter: number = 0;

  constructor() {
    if (SecurityAuditLogger.instance) {
      return SecurityAuditLogger.instance;
    }
    SecurityAuditLogger.instance = this;
  }

  /**
   * Log a security event with full audit trail
   * @param event - Security event to log
   */
  async logSecurityEvent(event: SecurityAuditEvent): Promise<void> {
    if (!supabaseAdmin) {
      console.warn('Audit logging disabled: Supabase admin client not available');
      return;
    }

    try {
      // Generate integrity hash
      const integrity = this.generateIntegrityHash(event);
      
      // Create audit log entry
      const auditEntry: AuditLogInsert = {
        user_id: event.user_id || null,
        action: event.action,
        resource_type: event.resource_type,
        resource_id: event.resource_id || null,
        old_values: null, // Set by triggers for UPDATE operations
        new_values: {
          event_type: event.event_type,
          severity: event.severity,
          success: event.success,
          error_message: event.error_message,
          metadata: event.metadata,
          performance_metrics: event.performance_metrics,
          compliance_flags: event.compliance_flags,
          integrity: integrity
        },
        ip_address: event.ip_address || null,
        user_agent: event.user_agent || null
      };

      // Store audit entry
      const { error } = await supabaseAdmin
        .from('audit_logs')
        .insert(auditEntry);

      if (error) {
        console.error('Failed to store audit log:', error);
        // Fallback: Log to console for debugging
        console.warn('AUDIT FALLBACK:', JSON.stringify(auditEntry, null, 2));
      }

      // Update integrity chain
      this.lastAuditHash = integrity.hash;
      this.eventCounter++;

      // Send critical events to external monitoring
      if (event.severity === 'critical') {
        await this.sendCriticalAlert(event);
      }

    } catch (error) {
      console.error('Audit logging failed:', error);
      // Even if audit logging fails, we must continue operation
      // But we should alert administrators
      await this.sendAuditFailureAlert(error as Error, event);
    }
  }

  /**
   * Convenience methods for common security events
   */

  async logAuthentication(
    userId: string | undefined,
    action: string,
    success: boolean,
    ip?: string,
    userAgent?: string,
    error?: string
  ): Promise<void> {
    await this.logSecurityEvent({
      user_id: userId,
      action,
      resource_type: 'authentication',
      event_type: 'authentication',
      severity: success ? 'info' : 'warning',
      success,
      error_message: error,
      ip_address: ip,
      user_agent: userAgent,
      compliance_flags: {
        gdpr_relevant: true,
        pii_involved: true
      }
    });
  }

  async logTokenOperation(
    userId: string,
    emailAccountId: string,
    operation: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    await this.logSecurityEvent({
      user_id: userId,
      action: operation,
      resource_type: 'microsoft_tokens',
      resource_id: emailAccountId,
      event_type: 'token_operation',
      severity: success ? 'info' : 'error',
      success,
      error_message: error,
      compliance_flags: {
        gdpr_relevant: true,
        pii_involved: false
      }
    });
  }

  async logRateLimitViolation(
    emailAccountId: string,
    operationType: string,
    currentCount: number,
    limit: number,
    ip?: string
  ): Promise<void> {
    await this.logSecurityEvent({
      action: 'rate_limit_exceeded',
      resource_type: 'rate_limiting',
      resource_id: emailAccountId,
      event_type: 'rate_limit',
      severity: 'warning',
      success: false,
      metadata: {
        operation_type: operationType,
        current_count: currentCount,
        limit: limit,
        violation_percentage: (currentCount / limit) * 100
      },
      ip_address: ip,
      compliance_flags: {
        gdpr_relevant: false
      }
    });
  }

  async logDataAccess(
    userId: string,
    resourceType: string,
    resourceId: string,
    action: string,
    success: boolean,
    recordCount?: number
  ): Promise<void> {
    await this.logSecurityEvent({
      user_id: userId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      event_type: 'data_access',
      severity: success ? 'info' : 'warning',
      success,
      metadata: {
        record_count: recordCount,
        query_type: action
      },
      compliance_flags: {
        gdpr_relevant: true,
        pii_involved: resourceType.includes('email') || resourceType.includes('profile')
      }
    });
  }

  async logSecurityViolation(
    violationType: string,
    details: string,
    severity: SecuritySeverity = 'critical',
    ip?: string,
    userAgent?: string,
    userId?: string
  ): Promise<void> {
    await this.logSecurityEvent({
      user_id: userId,
      action: 'security_violation',
      resource_type: 'security',
      event_type: 'security_violation',
      severity,
      success: false,
      error_message: details,
      metadata: {
        violation_type: violationType,
        detection_time: new Date().toISOString()
      },
      ip_address: ip,
      user_agent: userAgent,
      compliance_flags: {
        gdpr_relevant: false
      }
    });
  }

  async logWebhookEvent(
    emailAccountId: string,
    webhookType: string,
    success: boolean,
    responseTime?: number,
    error?: string
  ): Promise<void> {
    await this.logSecurityEvent({
      action: `webhook_${success ? 'received' : 'failed'}`,
      resource_type: 'webhook',
      resource_id: emailAccountId,
      event_type: 'webhook',
      severity: success ? 'info' : 'error',
      success,
      error_message: error,
      metadata: {
        webhook_type: webhookType,
        processing_result: success ? 'processed' : 'failed'
      },
      performance_metrics: {
        execution_time_ms: responseTime
      }
    });
  }

  /**
   * Query security metrics and trends
   */
  async getSecurityMetrics(timeframeHours = 24): Promise<SecurityMetrics> {
    if (!supabaseAdmin) {
      throw new Error('Supabase admin client not available for metrics');
    }

    try {
      const since = new Date();
      since.setHours(since.getHours() - timeframeHours);

      const { data, error } = await supabaseAdmin
        .from('audit_logs')
        .select('*')
        .gte('created_at', since.toISOString());

      if (error) throw error;

      const events = data || [];
      
      // Aggregate metrics
      const metrics: SecurityMetrics = {
        total_events: events.length,
        events_by_severity: {
          info: 0,
          warning: 0,
          error: 0,
          critical: 0
        },
        events_by_type: {
          authentication: 0,
          authorization: 0,
          data_access: 0,
          data_modification: 0,
          token_operation: 0,
          rate_limit: 0,
          webhook: 0,
          encryption: 0,
          validation: 0,
          security_violation: 0
        },
        failed_operations: 0,
        suspicious_activities: 0,
        last_24h_events: events.filter(e => {
          const eventTime = new Date(e.created_at);
          const last24h = new Date();
          last24h.setHours(last24h.getHours() - 24);
          return eventTime > last24h;
        }).length
      };

      // Process events
      events.forEach(event => {
        const metadata = event.new_values as any;
        
        if (metadata?.severity && metrics.events_by_severity.hasOwnProperty(metadata.severity)) {
          metrics.events_by_severity[metadata.severity as SecuritySeverity]++;
        }

        if (metadata?.event_type && metrics.events_by_type.hasOwnProperty(metadata.event_type)) {
          metrics.events_by_type[metadata.event_type as SecurityEventType]++;
        }

        if (metadata?.success === false) {
          metrics.failed_operations++;
        }

        if (metadata?.severity === 'critical' || metadata?.event_type === 'security_violation') {
          metrics.suspicious_activities++;
        }
      });

      return metrics;

    } catch (error) {
      console.error('Failed to get security metrics:', error);
      throw error;
    }
  }

  /**
   * Verify audit trail integrity
   */
  async verifyAuditIntegrity(startDate: Date, endDate: Date): Promise<boolean> {
    if (!supabaseAdmin) {
      throw new Error('Supabase admin client not available for integrity check');
    }

    try {
      const { data, error } = await supabaseAdmin
        .from('audit_logs')
        .select('new_values, created_at')
        .gte('created_at', startDate.toISOString())
        .lte('created_at', endDate.toISOString())
        .order('created_at', { ascending: true });

      if (error) throw error;

      let previousHash = '';
      for (const log of data || []) {
        const metadata = log.new_values as any;
        const integrity = metadata?.integrity as AuditIntegrity;
        
        if (!integrity) {
          console.warn('Audit log missing integrity data:', log.created_at);
          return false;
        }

        if (previousHash && integrity.previous_hash !== previousHash) {
          console.error('Audit integrity violation detected at:', log.created_at);
          return false;
        }

        previousHash = integrity.hash;
      }

      return true;

    } catch (error) {
      console.error('Audit integrity verification failed:', error);
      return false;
    }
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  /**
   * Generate tamper-evident hash for audit trail
   */
  private generateIntegrityHash(event: SecurityAuditEvent): AuditIntegrity {
    const timestamp = new Date().toISOString();
    this.eventCounter++;

    const hashData = JSON.stringify({
      ...event,
      timestamp,
      event_count: this.eventCounter,
      previous_hash: this.lastAuditHash
    });

    const hash = createHash('sha256')
      .update(hashData)
      .digest('hex');

    return {
      hash,
      previous_hash: this.lastAuditHash || undefined,
      timestamp,
      event_count: this.eventCounter
    };
  }

  /**
   * Send critical security alerts to external monitoring
   */
  private async sendCriticalAlert(event: SecurityAuditEvent): Promise<void> {
    try {
      // TODO: Integrate with external monitoring service (Sentry, DataDog, etc.)
      // For now, just log to console with structured format
      console.error('🚨 CRITICAL SECURITY EVENT 🚨', {
        timestamp: new Date().toISOString(),
        event_type: event.event_type,
        action: event.action,
        resource: event.resource_type,
        user_id: event.user_id,
        ip_address: event.ip_address,
        error: event.error_message,
        metadata: event.metadata
      });

      // In production, this would send to:
      // - Sentry for error tracking
      // - Slack/Teams for immediate alerts
      // - Email notifications to security team
      // - External SIEM system

    } catch (error) {
      console.error('Failed to send critical alert:', error);
    }
  }

  /**
   * Send audit failure alerts
   */
  private async sendAuditFailureAlert(error: Error, event: SecurityAuditEvent): Promise<void> {
    try {
      console.error('⚠️ AUDIT LOGGING FAILURE ⚠️', {
        timestamp: new Date().toISOString(),
        error: error.message,
        failed_event: {
          action: event.action,
          resource: event.resource_type,
          user_id: event.user_id
        }
      });

      // This is critical - if audit logging fails, the security team must know immediately
      // In production: Send to backup logging system, SMS alerts, etc.

    } catch (alertError) {
      console.error('Failed to send audit failure alert:', alertError);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE AND CONVENIENCE FUNCTIONS
// ============================================================================

export const auditLogger = new SecurityAuditLogger();

/**
 * Quick logging functions for common use cases
 */
export const logAuth = (userId: string | undefined, action: string, success: boolean, ip?: string, error?: string) =>
  auditLogger.logAuthentication(userId, action, success, ip, undefined, error);

export const logToken = (userId: string, accountId: string, operation: string, success: boolean, error?: string) =>
  auditLogger.logTokenOperation(userId, accountId, operation, success, error);

export const logRateLimit = (accountId: string, type: string, count: number, limit: number, ip?: string) =>
  auditLogger.logRateLimitViolation(accountId, type, count, limit, ip);

export const logDataAccess = (userId: string, resource: string, id: string, action: string, success: boolean) =>
  auditLogger.logDataAccess(userId, resource, id, action, success);

export const logSecurityViolation = (type: string, details: string, severity?: SecuritySeverity, ip?: string) =>
  auditLogger.logSecurityViolation(type, details, severity, ip);

export const logWebhook = (accountId: string, type: string, success: boolean, time?: number, error?: string) =>
  auditLogger.logWebhookEvent(accountId, type, success, time, error);

export default auditLogger;