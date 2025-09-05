/**
 * Performance Monitoring Setup
 * Email Tracking System - Performance Optimization Implementation
 * Created: 2025-09-05
 * 
 * Comprehensive performance monitoring system for database queries,
 * API response times, and system resource utilization
 */

// ============================================================================
// PERFORMANCE METRICS COLLECTION
// ============================================================================

export interface PerformanceMetric {
  operation: string;
  duration: number;
  timestamp: number;
  status: 'success' | 'error';
  metadata?: Record<string, unknown>;
}

export interface QueryPerformanceMetric extends PerformanceMetric {
  query_type: 'select' | 'insert' | 'update' | 'delete' | 'function';
  table_name?: string;
  rows_affected?: number;
  execution_plan?: string;
}

export interface APIPerformanceMetric extends PerformanceMetric {
  endpoint: string;
  method: string;
  status_code: number;
  user_id?: string;
  account_id?: string;
}

// ============================================================================
// PERFORMANCE MONITOR CLASS
// ============================================================================

export class PerformanceMonitor {
  private metrics: Map<string, PerformanceMetric[]> = new Map();
  private readonly MAX_METRICS_PER_OPERATION = 1000;
  private readonly SLOW_QUERY_THRESHOLD_MS = 1000;
  private readonly SLOW_API_THRESHOLD_MS = 2000;
  
  /**
   * Track database query performance
   */
  async trackQuery<T>(
    operation: string,
    queryType: 'select' | 'insert' | 'update' | 'delete' | 'function',
    tableName: string | undefined,
    query: () => Promise<T>
  ): Promise<T> {
    const startTime = performance.now();
    const startTimestamp = Date.now();
    
    try {
      const result = await query();
      const duration = performance.now() - startTime;
      
      const metric: QueryPerformanceMetric = {
        operation,
        query_type: queryType,
        table_name: tableName,
        duration,
        timestamp: startTimestamp,
        status: 'success',
        rows_affected: this.extractRowsAffected(result),
      };
      
      this.recordMetric(operation, metric);
      
      // Alert on slow queries
      if (duration > this.SLOW_QUERY_THRESHOLD_MS) {
        this.alertSlowOperation('query', operation, duration, {
          query_type: queryType,
          table_name: tableName,
        });
      }
      
      return result;
      
    } catch (error) {
      const duration = performance.now() - startTime;
      
      const metric: QueryPerformanceMetric = {
        operation,
        query_type: queryType,
        table_name: tableName,
        duration,
        timestamp: startTimestamp,
        status: 'error',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
      
      this.recordMetric(operation, metric);
      throw error;
    }
  }
  
  /**
   * Track API endpoint performance
   */
  async trackAPI<T>(
    endpoint: string,
    method: string,
    userId?: string,
    accountId?: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const startTime = performance.now();
    const startTimestamp = Date.now();
    
    try {
      const result = await operation();
      const duration = performance.now() - startTime;
      
      const metric: APIPerformanceMetric = {
        operation: `${method} ${endpoint}`,
        endpoint,
        method,
        duration,
        timestamp: startTimestamp,
        status: 'success',
        status_code: 200,
        user_id: userId,
        account_id: accountId,
      };
      
      this.recordMetric(metric.operation, metric);
      
      // Alert on slow APIs
      if (duration > this.SLOW_API_THRESHOLD_MS) {
        this.alertSlowOperation('api', endpoint, duration, {
          method,
          user_id: userId,
          account_id: accountId,
        });
      }
      
      return result;
      
    } catch (error) {
      const duration = performance.now() - startTime;
      const statusCode = this.extractStatusCode(error);
      
      const metric: APIPerformanceMetric = {
        operation: `${method} ${endpoint}`,
        endpoint,
        method,
        duration,
        timestamp: startTimestamp,
        status: 'error',
        status_code: statusCode,
        user_id: userId,
        account_id: accountId,
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
      
      this.recordMetric(metric.operation, metric);
      throw error;
    }
  }
  
  /**
   * Track general operation performance
   */
  async trackOperation<T>(
    operation: string,
    task: () => Promise<T>,
    metadata?: Record<string, unknown>
  ): Promise<T> {
    const startTime = performance.now();
    const startTimestamp = Date.now();
    
    try {
      const result = await task();
      const duration = performance.now() - startTime;
      
      const metric: PerformanceMetric = {
        operation,
        duration,
        timestamp: startTimestamp,
        status: 'success',
        metadata,
      };
      
      this.recordMetric(operation, metric);
      return result;
      
    } catch (error) {
      const duration = performance.now() - startTime;
      
      const metric: PerformanceMetric = {
        operation,
        duration,
        timestamp: startTimestamp,
        status: 'error',
        metadata: {
          ...metadata,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      };
      
      this.recordMetric(operation, metric);
      throw error;
    }
  }
  
  /**
   * Get performance statistics for an operation
   */
  getOperationStats(operation: string): {
    count: number;
    avgDuration: number;
    p50Duration: number;
    p95Duration: number;
    p99Duration: number;
    errorRate: number;
    successRate: number;
  } | null {
    const metrics = this.metrics.get(operation);
    if (!metrics || metrics.length === 0) {
      return null;
    }
    
    const durations = metrics.map(m => m.duration).sort((a, b) => a - b);
    const errorCount = metrics.filter(m => m.status === 'error').length;
    
    return {
      count: metrics.length,
      avgDuration: durations.reduce((sum, d) => sum + d, 0) / durations.length,
      p50Duration: durations[Math.floor(durations.length * 0.5)],
      p95Duration: durations[Math.floor(durations.length * 0.95)],
      p99Duration: durations[Math.floor(durations.length * 0.99)],
      errorRate: (errorCount / metrics.length) * 100,
      successRate: ((metrics.length - errorCount) / metrics.length) * 100,
    };
  }
  
  /**
   * Get all operations with their performance stats
   */
  getAllOperationStats(): Array<{
    operation: string;
    stats: ReturnType<typeof this.getOperationStats>;
  }> {
    return Array.from(this.metrics.keys()).map(operation => ({
      operation,
      stats: this.getOperationStats(operation),
    }));
  }
  
  /**
   * Clear metrics for an operation
   */
  clearMetrics(operation?: string): void {
    if (operation) {
      this.metrics.delete(operation);
    } else {
      this.metrics.clear();
    }
  }
  
  /**
   * Export metrics for external monitoring systems
   */
  exportMetrics(): {
    timestamp: number;
    operations: Array<{
      name: string;
      metrics: PerformanceMetric[];
      stats: ReturnType<typeof this.getOperationStats>;
    }>;
  } {
    return {
      timestamp: Date.now(),
      operations: Array.from(this.metrics.entries()).map(([name, metrics]) => ({
        name,
        metrics: [...metrics],
        stats: this.getOperationStats(name),
      })),
    };
  }
  
  // Private helper methods
  private recordMetric(operation: string, metric: PerformanceMetric): void {
    if (!this.metrics.has(operation)) {
      this.metrics.set(operation, []);
    }
    
    const operationMetrics = this.metrics.get(operation)!;
    operationMetrics.push(metric);
    
    // Keep only the most recent metrics to prevent memory issues
    if (operationMetrics.length > this.MAX_METRICS_PER_OPERATION) {
      operationMetrics.splice(0, operationMetrics.length - this.MAX_METRICS_PER_OPERATION);
    }
  }
  
  private extractRowsAffected(result: unknown): number | undefined {
    if (result && typeof result === 'object' && 'count' in result) {
      return result.count as number;
    }
    if (Array.isArray(result)) {
      return result.length;
    }
    return undefined;
  }
  
  private extractStatusCode(error: unknown): number {
    if (error && typeof error === 'object' && 'status' in error) {
      return error.status as number;
    }
    return 500;
  }
  
  private alertSlowOperation(
    type: 'query' | 'api',
    operation: string,
    duration: number,
    metadata: Record<string, unknown>
  ): void {
    console.warn(
      `🐌 Slow ${type} detected: ${operation} took ${duration.toFixed(2)}ms`,
      metadata
    );
    
    // Could integrate with external alerting systems here
    // Example: Send to monitoring service, Slack, etc.
  }
}

// ============================================================================
// CACHE PERFORMANCE MONITORING
// ============================================================================

export interface CacheMetrics {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  hitRate: number;
  avgRetrievalTime: number;
  size: number;
  memoryUsage?: number;
}

export class CachePerformanceMonitor {
  private metrics: Map<string, CacheMetrics> = new Map();
  
  recordHit(cacheKey: string, retrievalTime: number): void {
    const metrics = this.getOrCreateMetrics(cacheKey);
    metrics.hits++;
    this.updateAverageRetrievalTime(metrics, retrievalTime);
    this.updateHitRate(metrics);
  }
  
  recordMiss(cacheKey: string): void {
    const metrics = this.getOrCreateMetrics(cacheKey);
    metrics.misses++;
    this.updateHitRate(metrics);
  }
  
  recordSet(cacheKey: string): void {
    const metrics = this.getOrCreateMetrics(cacheKey);
    metrics.sets++;
    metrics.size++;
  }
  
  recordDelete(cacheKey: string): void {
    const metrics = this.getOrCreateMetrics(cacheKey);
    metrics.deletes++;
    metrics.size = Math.max(0, metrics.size - 1);
  }
  
  getCacheMetrics(cacheKey?: string): CacheMetrics | Map<string, CacheMetrics> {
    if (cacheKey) {
      return this.metrics.get(cacheKey) || this.createEmptyMetrics();
    }
    return new Map(this.metrics);
  }
  
  clearMetrics(cacheKey?: string): void {
    if (cacheKey) {
      this.metrics.delete(cacheKey);
    } else {
      this.metrics.clear();
    }
  }
  
  private getOrCreateMetrics(cacheKey: string): CacheMetrics {
    if (!this.metrics.has(cacheKey)) {
      this.metrics.set(cacheKey, this.createEmptyMetrics());
    }
    return this.metrics.get(cacheKey)!;
  }
  
  private createEmptyMetrics(): CacheMetrics {
    return {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      hitRate: 0,
      avgRetrievalTime: 0,
      size: 0,
    };
  }
  
  private updateHitRate(metrics: CacheMetrics): void {
    const total = metrics.hits + metrics.misses;
    metrics.hitRate = total > 0 ? (metrics.hits / total) * 100 : 0;
  }
  
  private updateAverageRetrievalTime(metrics: CacheMetrics, newTime: number): void {
    if (metrics.hits === 1) {
      metrics.avgRetrievalTime = newTime;
    } else {
      metrics.avgRetrievalTime = (
        (metrics.avgRetrievalTime * (metrics.hits - 1) + newTime) / metrics.hits
      );
    }
  }
}

// ============================================================================
// ENHANCED RATE LIMITER WITH PERFORMANCE MONITORING
// ============================================================================

import { GraphRateLimiter, RateLimitResult } from '../lib/rate-limiter';
import { RateLimitOperationType } from '../types/database';

export class MonitoredRateLimiter extends GraphRateLimiter {
  private performanceMonitor = new PerformanceMonitor();
  private cacheMonitor = new CachePerformanceMonitor();
  private cache = new Map<string, CachedRateLimitResult>();
  private readonly CACHE_TTL_MS = 60000; // 1 minute cache

  async checkAndRecord(
    emailAccountId: string,
    operationType: RateLimitOperationType
  ): Promise<RateLimitResult> {
    const cacheKey = `${emailAccountId}:${operationType}`;
    
    return this.performanceMonitor.trackQuery(
      'rate_limit_check',
      'select',
      'rate_limit_tracking',
      async () => {
        // Try cache first
        const cached = this.checkCache(cacheKey);
        if (cached) {
          return cached;
        }
        
        // Cache miss - hit database
        this.cacheMonitor.recordMiss(cacheKey);
        const result = await super.checkAndRecord(emailAccountId, operationType);
        
        // Cache the result
        this.setCache(cacheKey, result);
        
        return result;
      }
    );
  }
  
  private checkCache(cacheKey: string): RateLimitResult | null {
    const startTime = performance.now();
    const cached = this.cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      const retrievalTime = performance.now() - startTime;
      this.cacheMonitor.recordHit(cacheKey, retrievalTime);
      
      // Increment in-memory counter
      cached.result.current_count++;
      cached.result.remaining = Math.max(0, cached.result.limit - cached.result.current_count);
      cached.result.allowed = cached.result.current_count <= cached.result.limit;
      
      return cached.result;
    }
    
    // Cache expired or missing
    if (cached) {
      this.cache.delete(cacheKey);
      this.cacheMonitor.recordDelete(cacheKey);
    }
    
    return null;
  }
  
  private setCache(cacheKey: string, result: RateLimitResult): void {
    this.cache.set(cacheKey, {
      result: { ...result },
      timestamp: Date.now(),
    });
    this.cacheMonitor.recordSet(cacheKey);
  }
  
  getPerformanceMetrics() {
    return {
      rateLimiter: this.performanceMonitor.getOperationStats('rate_limit_check'),
      cache: this.cacheMonitor.getCacheMetrics(),
      cacheSize: this.cache.size,
    };
  }
}

interface CachedRateLimitResult {
  result: RateLimitResult;
  timestamp: number;
}

// ============================================================================
// PERFORMANCE MIDDLEWARE FOR API ROUTES
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';

export function withPerformanceMonitoring<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>
) {
  return async (...args: T): Promise<NextResponse> => {
    const request = args[0] as NextRequest;
    const performanceMonitor = getGlobalPerformanceMonitor();
    
    const method = request.method;
    const pathname = new URL(request.url).pathname;
    
    return performanceMonitor.trackAPI(
      pathname,
      method,
      undefined, // User ID would be extracted from session
      undefined, // Account ID would be extracted from request
      () => handler(...args)
    );
  };
}

// Usage example:
// export const GET = withPerformanceMonitoring(async (request: NextRequest) => {
//   // Your API handler logic
// });

// ============================================================================
// ENHANCED EMAIL TRACKING SERVICE WITH MONITORING
// ============================================================================

import { EmailTrackingEngine } from '../lib/email-tracking-service';
import { TrackedEmailFilters, EmailTrackingMetrics } from '../types/email-tracking';

export class MonitoredEmailTrackingService extends EmailTrackingEngine {
  private performanceMonitor = new PerformanceMonitor();
  private cacheMonitor = new CachePerformanceMonitor();
  private cache = new Map<string, CachedResult>();
  private readonly CACHE_TTL_MS = 300000; // 5 minutes

  async getTrackedEmails(accountId: string, filters?: TrackedEmailFilters) {
    const cacheKey = `tracked_emails:${accountId}:${JSON.stringify(filters)}`;
    
    return this.performanceMonitor.trackQuery(
      'get_tracked_emails',
      'select',
      'tracked_emails',
      async () => {
        // Check cache first
        const cached = this.checkCache(cacheKey);
        if (cached) {
          return cached;
        }
        
        // Cache miss
        this.cacheMonitor.recordMiss(cacheKey);
        const result = await super.getTrackedEmails(accountId, filters);
        
        // Cache result
        this.setCache(cacheKey, result);
        
        return result;
      }
    );
  }
  
  async getTrackingMetrics(accountId: string, dateRange?: { start: Date; end: Date }) {
    const cacheKey = `metrics:${accountId}:${dateRange?.start?.getTime()}-${dateRange?.end?.getTime()}`;
    
    return this.performanceMonitor.trackQuery(
      'get_tracking_metrics',
      'select',
      'tracked_emails',
      async () => {
        const cached = this.checkCache(cacheKey);
        if (cached) {
          return cached;
        }
        
        this.cacheMonitor.recordMiss(cacheKey);
        const result = await super.getTrackingMetrics(accountId, dateRange);
        
        this.setCache(cacheKey, result);
        return result;
      }
    );
  }
  
  private checkCache<T>(cacheKey: string): T | null {
    const startTime = performance.now();
    const cached = this.cache.get(cacheKey) as CachedResult<T> | undefined;
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      const retrievalTime = performance.now() - startTime;
      this.cacheMonitor.recordHit(cacheKey, retrievalTime);
      return cached.data;
    }
    
    if (cached) {
      this.cache.delete(cacheKey);
      this.cacheMonitor.recordDelete(cacheKey);
    }
    
    return null;
  }
  
  private setCache<T>(cacheKey: string, data: T): void {
    this.cache.set(cacheKey, {
      data,
      timestamp: Date.now(),
    });
    this.cacheMonitor.recordSet(cacheKey);
  }
  
  getPerformanceMetrics() {
    return {
      operations: this.performanceMonitor.getAllOperationStats(),
      cache: this.cacheMonitor.getCacheMetrics(),
      cacheSize: this.cache.size,
    };
  }
}

interface CachedResult<T = unknown> {
  data: T;
  timestamp: number;
}

// ============================================================================
// GLOBAL PERFORMANCE MONITOR INSTANCE
// ============================================================================

let globalPerformanceMonitor: PerformanceMonitor | null = null;

export function getGlobalPerformanceMonitor(): PerformanceMonitor {
  if (!globalPerformanceMonitor) {
    globalPerformanceMonitor = new PerformanceMonitor();
  }
  return globalPerformanceMonitor;
}

// ============================================================================
// PERFORMANCE HEALTH CHECK ENDPOINT
// ============================================================================

export async function getPerformanceHealthCheck() {
  const performanceMonitor = getGlobalPerformanceMonitor();
  const stats = performanceMonitor.getAllOperationStats();
  
  const healthCheck = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    performance: {
      totalOperations: stats.length,
      slowOperations: stats.filter(s => s.stats && s.stats.p95Duration > 1000).length,
      highErrorRateOperations: stats.filter(s => s.stats && s.stats.errorRate > 5).length,
      avgResponseTime: stats.reduce((sum, s) => sum + (s.stats?.avgDuration || 0), 0) / Math.max(stats.length, 1),
    },
    topSlowOperations: stats
      .filter(s => s.stats)
      .sort((a, b) => (b.stats!.p95Duration) - (a.stats!.p95Duration))
      .slice(0, 5)
      .map(s => ({
        operation: s.operation,
        p95Duration: s.stats!.p95Duration,
        errorRate: s.stats!.errorRate,
        count: s.stats!.count,
      })),
  };
  
  // Determine overall health status
  if (healthCheck.performance.slowOperations > 3 || healthCheck.performance.highErrorRateOperations > 2) {
    healthCheck.status = 'degraded';
  }
  
  if (healthCheck.performance.slowOperations > 5 || healthCheck.performance.highErrorRateOperations > 5) {
    healthCheck.status = 'unhealthy';
  }
  
  return healthCheck;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  PerformanceMonitor,
  CachePerformanceMonitor,
  MonitoredRateLimiter,
  MonitoredEmailTrackingService,
};

export type {
  PerformanceMetric,
  QueryPerformanceMetric,
  APIPerformanceMetric,
  CacheMetrics,
};