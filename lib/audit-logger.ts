/**
 * Audit Logger Service - Security Event Logging
 * Email Tracking System - Critical Security Infrastructure
 * Created: 2025-09-05 for Microsoft OAuth2 Authentication
 * 
 * ⚠️ CRITICAL: This service logs all security-related events for compliance and monitoring
 * Integrates with Supabase analytics_events table for persistent audit trail
 */

import { supabaseAdmin, getCurrentUser } from './supabase';

// Event severity levels
export enum AuditSeverity {
  LOW = 'low',
  MEDIUM = 'medium', 
  HIGH = 'high',
  CRITICAL = 'critical'
}

// Predefined event types for consistency
export enum AuditEventType {
  // Authentication events
  TOKEN_STORED = 'token_stored',
  TOKEN_RETRIEVED = 'token_retrieved',
  TOKEN_REFRESHED = 'token_refreshed',
  TOKEN_REVOKED = 'token_revoked',
  TOKEN_STORAGE_FAILED = 'token_storage_failed',
  TOKEN_RETRIEVAL_FAILED = 'token_retrieval_failed',
  TOKEN_REFRESH_FAILED = 'token_refresh_failed',
  TOKEN_REVOCATION_FAILED = 'token_revocation_failed',
  
  // OAuth2 flow events
  OAUTH_INITIATED = 'oauth_initiated',
  OAUTH_CALLBACK_RECEIVED = 'oauth_callback_received',
  OAUTH_SUCCESS = 'oauth_success',
  OAUTH_FAILED = 'oauth_failed',
  OAUTH_DENIED = 'oauth_denied',
  
  // Microsoft Graph API events
  GRAPH_API_CALL = 'graph_api_call',
  GRAPH_API_FAILED = 'graph_api_failed',
  GRAPH_RATE_LIMITED = 'graph_rate_limited',
  
  // Account management events
  ACCOUNT_CONNECTED = 'account_connected',
  ACCOUNT_DISCONNECTED = 'account_disconnected',
  ACCOUNT_SYNC_STARTED = 'account_sync_started',
  ACCOUNT_SYNC_COMPLETED = 'account_sync_completed',
  ACCOUNT_SYNC_FAILED = 'account_sync_failed',
  
  // Security events
  UNAUTHORIZED_ACCESS = 'unauthorized_access',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  SECURITY_VIOLATION = 'security_violation',
  ENCRYPTION_FAILED = 'encryption_failed',
  DECRYPTION_FAILED = 'decryption_failed',
  
  // System events
  SYSTEM_ERROR = 'system_error',
  SERVICE_HEALTH_CHECK = 'service_health_check',
  DATABASE_ERROR = 'database_error',
}

/**
 * Audit Logger Service Class
 * Handles logging of security and system events for compliance and monitoring
 */
export class AuditLogger {
  private isEnabled: boolean;

  constructor() {
    this.isEnabled = !!supabaseAdmin;
    
    if (!this.isEnabled) {
      console.warn('⚠️  Audit logger disabled: Supabase admin client not available');
    }
  }

  /**
   * Log an audit event
   * @param event - The audit event to log
   * @returns Promise<boolean> - Whether the logging was successful
   */
  async logEvent(event: AuditEvent): Promise<boolean> {
    try {
      if (!this.isEnabled) {
        // Log to console if database logging is disabled
        console.log('AUDIT:', JSON.stringify({
          ...event,
          timestamp: new Date().toISOString(),
        }));
        return true;
      }

      // Get current user context if not provided
      let userId = event.user_id;
      if (!userId && event.include_user_context !== false) {
        const user = await getCurrentUser();
        userId = user?.id || null;
      }

      // Determine severity if not provided
      const severity = event.severity || this.determineSeverity(event.event_type);

      // Create audit log entry
      const { error } = await supabaseAdmin!
        .from('analytics_events')
        .insert({
          user_id: userId,
          event_type: event.event_type,
          event_data: {
            ...event.details,
            severity,
            account_id: event.account_id,
            ip_address: event.ip_address,
            user_agent: event.user_agent,
            session_id: event.session_id,
            audit_metadata: {
              source: 'audit-logger',
              version: '1.0.0',
              timestamp: new Date().toISOString(),
            },
          },
          created_at: new Date().toISOString(),
        });

      if (error) {
        console.error('Failed to log audit event:', error);
        
        // Fallback to console logging
        console.log('AUDIT (DB_FAILED):', JSON.stringify({
          ...event,
          severity,
          user_id: userId,
          timestamp: new Date().toISOString(),
          db_error: error.message,
        }));
        
        return false;
      }

      // Log to console for immediate visibility (in development)
      if (process.env.NODE_ENV === 'development' || process.env.DEBUG === 'true') {
        console.log('AUDIT:', {
          event_type: event.event_type,
          severity,
          user_id: userId,
          account_id: event.account_id,
          details: event.details,
        });
      }

      return true;

    } catch (error) {
      console.error('Audit logging failed:', error);
      
      // Emergency console logging
      console.log('AUDIT (EMERGENCY):', JSON.stringify({
        ...event,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
      
      return false;
    }
  }

  /**
   * Log authentication success event
   * @param accountId - The account that authenticated
   * @param provider - The authentication provider (e.g., 'microsoft')
   * @param scopes - The granted scopes
   * @param metadata - Additional metadata
   */
  async logAuthSuccess(
    accountId: string,
    provider: string,
    scopes: string[],
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    return await this.logEvent({
      event_type: AuditEventType.OAUTH_SUCCESS,
      account_id: accountId,
      severity: AuditSeverity.MEDIUM,
      details: {
        provider,
        scopes,
        ...metadata,
      },
    });
  }

  /**
   * Log authentication failure event
   * @param accountId - The account that failed to authenticate
   * @param provider - The authentication provider
   * @param error - The error that occurred
   * @param metadata - Additional metadata
   */
  async logAuthFailure(
    accountId: string | null,
    provider: string,
    error: string,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    return await this.logEvent({
      event_type: AuditEventType.OAUTH_FAILED,
      account_id: accountId,
      severity: AuditSeverity.HIGH,
      details: {
        provider,
        error,
        ...metadata,
      },
    });
  }

  /**
   * Log Microsoft Graph API call
   * @param accountId - The account making the API call
   * @param endpoint - The Graph API endpoint
   * @param method - HTTP method
   * @param success - Whether the call was successful
   * @param rateLimited - Whether the call was rate limited
   * @param metadata - Additional metadata
   */
  async logGraphAPICall(
    accountId: string,
    endpoint: string,
    method: string,
    success: boolean,
    rateLimited: boolean = false,
    metadata?: Record<string, unknown>
  ): Promise<boolean> {
    const eventType = rateLimited 
      ? AuditEventType.GRAPH_RATE_LIMITED
      : success 
        ? AuditEventType.GRAPH_API_CALL 
        : AuditEventType.GRAPH_API_FAILED;

    const severity = rateLimited 
      ? AuditSeverity.MEDIUM
      : success 
        ? AuditSeverity.LOW 
        : AuditSeverity.HIGH;

    return await this.logEvent({
      event_type: eventType,
      account_id: accountId,
      severity,
      details: {
        endpoint,
        method,
        success,
        rate_limited: rateLimited,
        ...metadata,
      },
    });
  }

  /**
   * Log security violation event
   * @param violation - The type of violation
   * @param severity - Severity level
   * @param details - Violation details
   * @param userContext - User context information
   */
  async logSecurityViolation(
    violation: string,
    severity: AuditSeverity,
    details: Record<string, unknown>,
    userContext?: {
      user_id?: string;
      ip_address?: string;
      user_agent?: string;
      session_id?: string;
    }
  ): Promise<boolean> {
    return await this.logEvent({
      event_type: AuditEventType.SECURITY_VIOLATION,
      severity,
      details: {
        violation_type: violation,
        ...details,
      },
      ...userContext,
    });
  }

  /**
   * Log system error event
   * @param error - The error that occurred
   * @param context - Context where the error occurred
   * @param severity - Error severity (defaults to HIGH)
   */
  async logSystemError(
    error: Error | string,
    context: string,
    severity: AuditSeverity = AuditSeverity.HIGH
  ): Promise<boolean> {
    return await this.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity,
      details: {
        error_message: error instanceof Error ? error.message : error,
        error_stack: error instanceof Error ? error.stack : undefined,
        context,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * Get audit events for an account
   * @param accountId - The account ID to query
   * @param limit - Maximum number of events to return
   * @param eventTypes - Filter by event types
   * @returns Promise<AuditEvent[]> - Array of audit events
   */
  async getAuditEvents(
    accountId: string,
    limit: number = 100,
    eventTypes?: AuditEventType[]
  ): Promise<AuditEvent[]> {
    try {
      if (!this.isEnabled) {
        return [];
      }

      let query = supabaseAdmin!
        .from('analytics_events')
        .select('*')
        .eq('event_data->>account_id', accountId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (eventTypes && eventTypes.length > 0) {
        query = query.in('event_type', eventTypes);
      }

      const { data, error } = await query;

      if (error) {
        console.error('Failed to retrieve audit events:', error);
        return [];
      }

      return (data || []).map(event => ({
        event_type: event.event_type as AuditEventType,
        account_id: event.event_data?.account_id,
        user_id: event.user_id,
        severity: event.event_data?.severity as AuditSeverity,
        details: event.event_data || {},
        created_at: event.created_at,
      }));

    } catch (error) {
      console.error('Audit event retrieval failed:', error);
      return [];
    }
  }

  /**
   * Determine event severity based on event type
   * @param eventType - The event type
   * @returns AuditSeverity - The appropriate severity level
   */
  private determineSeverity(eventType: AuditEventType | string): AuditSeverity {
    const criticalEvents = [
      AuditEventType.SECURITY_VIOLATION,
      AuditEventType.UNAUTHORIZED_ACCESS,
      AuditEventType.ENCRYPTION_FAILED,
      AuditEventType.DECRYPTION_FAILED,
    ];

    const highEvents = [
      AuditEventType.OAUTH_FAILED,
      AuditEventType.TOKEN_STORAGE_FAILED,
      AuditEventType.TOKEN_RETRIEVAL_FAILED,
      AuditEventType.TOKEN_REFRESH_FAILED,
      AuditEventType.GRAPH_API_FAILED,
      AuditEventType.ACCOUNT_SYNC_FAILED,
      AuditEventType.SYSTEM_ERROR,
    ];

    const mediumEvents = [
      AuditEventType.TOKEN_REFRESHED,
      AuditEventType.TOKEN_REVOKED,
      AuditEventType.OAUTH_SUCCESS,
      AuditEventType.ACCOUNT_CONNECTED,
      AuditEventType.ACCOUNT_DISCONNECTED,
      AuditEventType.GRAPH_RATE_LIMITED,
      AuditEventType.SUSPICIOUS_ACTIVITY,
    ];

    if (criticalEvents.includes(eventType as AuditEventType)) {
      return AuditSeverity.CRITICAL;
    }

    if (highEvents.includes(eventType as AuditEventType)) {
      return AuditSeverity.HIGH;
    }

    if (mediumEvents.includes(eventType as AuditEventType)) {
      return AuditSeverity.MEDIUM;
    }

    return AuditSeverity.LOW;
  }

  /**
   * Health check for audit logger
   * @returns Promise<AuditLoggerHealthCheck> - Service health status
   */
  async healthCheck(): Promise<AuditLoggerHealthCheck> {
    try {
      if (!this.isEnabled) {
        return {
          healthy: false,
          message: 'Audit logger disabled - Supabase admin client not available',
          timestamp: new Date().toISOString(),
        };
      }

      // Test logging functionality
      const testEvent: AuditEvent = {
        event_type: AuditEventType.SERVICE_HEALTH_CHECK,
        severity: AuditSeverity.LOW,
        details: {
          service: 'audit-logger',
          test: true,
        },
        include_user_context: false,
      };

      const success = await this.logEvent(testEvent);

      return {
        healthy: success,
        message: success 
          ? 'Audit logger functioning correctly' 
          : 'Audit logger test failed',
        timestamp: new Date().toISOString(),
        database_connected: this.isEnabled,
        test_log_success: success,
      };

    } catch (error) {
      return {
        healthy: false,
        message: `Audit logger health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface AuditEvent {
  event_type: AuditEventType | string;
  account_id?: string | null;
  user_id?: string | null;
  severity?: AuditSeverity;
  details: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  session_id?: string;
  include_user_context?: boolean;
  created_at?: string;
}

export interface AuditLoggerHealthCheck {
  healthy: boolean;
  message: string;
  timestamp: string;
  database_connected?: boolean;
  test_log_success?: boolean;
  error?: string;
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

// Export singleton instance for use throughout the application
export const auditLogger = new AuditLogger();

// Export default for convenience
export default auditLogger;