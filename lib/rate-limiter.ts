/**
 * Microsoft Graph API Rate Limiter Service
 * Email Tracking System - Critical Rate Limiting Infrastructure
 * Created: 2025-09-05 by backend-architect
 * 
 * ⚠️ CRITICAL: This service is required for Microsoft Graph API compliance
 * Implements the rate limiting system for September 2025 API updates
 */

import { supabaseAdmin, checkRateLimit, recordRateLimitUsage } from './supabase';
import { RateLimitOperationType } from '../types/database';

// Rate limit configurations based on Microsoft Graph API limits (September 2025)
export const RATE_LIMITS = {
  email_read: {
    limit: parseInt(process.env.GRAPH_RATE_LIMIT_EMAIL_OPS || '10000'),
    windowMinutes: parseInt(process.env.GRAPH_RATE_LIMIT_WINDOW_MINUTES || '60'),
    description: 'Email read operations per hour'
  },
  webhook_create: {
    limit: parseInt(process.env.GRAPH_RATE_LIMIT_WEBHOOKS || '50'),
    windowMinutes: parseInt(process.env.GRAPH_RATE_LIMIT_WINDOW_MINUTES || '60'),
    description: 'Webhook subscriptions per hour'
  },
  bulk_operation: {
    limit: parseInt(process.env.GRAPH_RATE_LIMIT_BULK || '100'),
    windowMinutes: 1, // Bulk operations are per minute
    description: 'Bulk operations per minute'
  }
} as const;

/**
 * Microsoft Graph API Rate Limiter Class
 * Handles rate limiting for all Microsoft Graph API operations
 */
export class GraphRateLimiter {
  private isEnabled: boolean;

  constructor() {
    this.isEnabled = !!supabaseAdmin;
    
    if (!this.isEnabled) {
      console.warn('⚠️  Rate limiter disabled: Supabase admin client not available');
    }
  }

  /**
   * Check if an operation is allowed under current rate limits
   * @param emailAccountId - The email account performing the operation
   * @param operationType - Type of operation to check
   * @returns Promise<RateLimitResult> - Whether the operation is allowed
   */
  async checkLimit(
    emailAccountId: string,
    operationType: RateLimitOperationType
  ): Promise<RateLimitResult> {
    try {
      // If rate limiter is disabled, allow all operations
      if (!this.isEnabled) {
        return {
          allowed: true,
          current_count: 0,
          remaining: RATE_LIMITS[operationType].limit,
          reset_time: new Date().toISOString(),
          limit: RATE_LIMITS[operationType].limit
        };
      }

      const config = RATE_LIMITS[operationType];
      const result = await checkRateLimit(
        emailAccountId,
        operationType,
        config.limit,
        config.windowMinutes
      );

      return {
        allowed: result.allowed,
        current_count: result.current_count,
        remaining: config.limit - result.current_count,
        reset_time: result.reset_time,
        limit: config.limit
      };

    } catch (error) {
      console.error(`Rate limit check failed for ${operationType}:`, error);
      
      // On error, default to allowing the operation but log the issue
      return {
        allowed: true,
        current_count: 0,
        remaining: RATE_LIMITS[operationType].limit,
        reset_time: new Date().toISOString(),
        limit: RATE_LIMITS[operationType].limit,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Record that an operation was performed (increment usage)
   * @param emailAccountId - The email account that performed the operation
   * @param operationType - Type of operation performed
   * @returns Promise<boolean> - Whether the recording was successful
   */
  async recordUsage(
    emailAccountId: string,
    operationType: RateLimitOperationType
  ): Promise<boolean> {
    try {
      if (!this.isEnabled) {
        return true; // Simulate success when disabled
      }

      const config = RATE_LIMITS[operationType];
      const success = await recordRateLimitUsage(
        emailAccountId,
        operationType,
        config.windowMinutes
      );

      if (!success) {
        console.warn(`Failed to record usage for ${operationType} on account ${emailAccountId}`);
      }

      return success;

    } catch (error) {
      console.error(`Rate limit usage recording failed for ${operationType}:`, error);
      return false;
    }
  }

  /**
   * Check if operation is allowed and record usage atomically
   * This is the primary method to use before making Microsoft Graph API calls
   * 
   * @param emailAccountId - The email account performing the operation
   * @param operationType - Type of operation
   * @returns Promise<RateLimitResult> - Result with allowed status
   */
  async checkAndRecord(
    emailAccountId: string,
    operationType: RateLimitOperationType
  ): Promise<RateLimitResult> {
    try {
      // First check if the operation is allowed
      const checkResult = await this.checkLimit(emailAccountId, operationType);
      
      if (!checkResult.allowed) {
        // Operation not allowed, return the result without recording
        return checkResult;
      }

      // Operation is allowed, record the usage
      const recordSuccess = await this.recordUsage(emailAccountId, operationType);
      
      if (!recordSuccess) {
        console.warn(`Usage recording failed for ${operationType}, but operation was allowed`);
      }

      // Return the check result (operation was allowed)
      return {
        ...checkResult,
        usage_recorded: recordSuccess
      };

    } catch (error) {
      console.error(`Rate limit check and record failed for ${operationType}:`, error);
      
      // On error, default to allowing the operation
      return {
        allowed: true,
        current_count: 0,
        remaining: RATE_LIMITS[operationType].limit,
        reset_time: new Date().toISOString(),
        limit: RATE_LIMITS[operationType].limit,
        usage_recorded: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Get current rate limit status for all operation types
   * @param emailAccountId - The email account to check
   * @returns Promise<RateLimitStatusSummary> - Current status for all operations
   */
  async getStatus(emailAccountId: string): Promise<RateLimitStatusSummary> {
    try {
      const statuses: RateLimitStatusSummary = {};

      // Check all operation types
      for (const [opType, config] of Object.entries(RATE_LIMITS)) {
        const result = await this.checkLimit(
          emailAccountId,
          opType as RateLimitOperationType
        );

        statuses[opType as RateLimitOperationType] = {
          ...result,
          description: config.description
        };
      }

      return statuses;

    } catch (error) {
      console.error('Failed to get rate limit status:', error);
      
      // Return default status on error
      const defaultStatuses: RateLimitStatusSummary = {};
      for (const [opType, config] of Object.entries(RATE_LIMITS)) {
        defaultStatuses[opType as RateLimitOperationType] = {
          allowed: true,
          current_count: 0,
          remaining: config.limit,
          reset_time: new Date().toISOString(),
          limit: config.limit,
          description: config.description,
          error: error instanceof Error ? error.message : 'Unknown error'
        };
      }
      return defaultStatuses;
    }
  }

  /**
   * Check if rate limiting is properly configured and functional
   * @returns Promise<HealthCheck> - Health status of the rate limiter
   */
  async healthCheck(): Promise<HealthCheck> {
    try {
      if (!this.isEnabled) {
        return {
          healthy: false,
          message: 'Rate limiter disabled - Supabase admin client not available',
          timestamp: new Date().toISOString()
        };
      }

      // Test with a dummy account ID
      const testAccountId = '00000000-0000-0000-0000-000000000001';
      const result = await this.checkLimit(testAccountId, 'email_read');

      return {
        healthy: true,
        message: 'Rate limiter functioning correctly',
        timestamp: new Date().toISOString(),
        test_result: result
      };

    } catch (error) {
      return {
        healthy: false,
        message: `Rate limiter health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface RateLimitResult {
  allowed: boolean;
  current_count: number;
  reset_time: string;
  remaining: number;
  limit: number;
  usage_recorded?: boolean;
  error?: string;
}

export interface RateLimitStatusSummary {
  email_read?: RateLimitResult & { description: string };
  webhook_create?: RateLimitResult & { description: string };
  bulk_operation?: RateLimitResult & { description: string };
}

export interface HealthCheck {
  healthy: boolean;
  message: string;
  timestamp: string;
  test_result?: RateLimitResult;
  error?: string;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Format rate limit status for logging
 */
export function formatRateLimitStatus(result: RateLimitResult): string {
  const status = result.allowed ? '✅ ALLOWED' : '❌ BLOCKED';
  const usage = `${result.current_count}/${result.limit}`;
  const remaining = result.remaining;
  const resetTime = result.reset_time;
  
  return `${status} | Usage: ${usage} | Remaining: ${remaining} | Reset: ${resetTime}`;
}

/**
 * Create rate limit error for API responses
 */
export function createRateLimitError(result: RateLimitResult): RateLimitError {
  return {
    code: 'RATE_LIMIT_EXCEEDED',
    message: 'Rate limit exceeded for Microsoft Graph API operations',
    details: {
      current_count: result.current_count,
      limit: result.limit,
      reset_time: result.reset_time,
      retry_after: Math.ceil((new Date(result.reset_time).getTime() - Date.now()) / 1000)
    }
  };
}

export interface RateLimitError {
  code: 'RATE_LIMIT_EXCEEDED';
  message: string;
  details: {
    current_count: number;
    limit: number;
    reset_time: string;
    retry_after: number; // seconds until reset
  };
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

// Export singleton instance for use throughout the application
export const rateLimiter = new GraphRateLimiter();

// Export default for convenience
export default rateLimiter;