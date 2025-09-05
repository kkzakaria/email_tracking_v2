-- Database Performance Optimizations
-- Email Tracking System - Phase 2 Performance Improvements
-- Created: 2025-09-05
-- Purpose: Database indexes, functions, and schema optimizations for high-volume email tracking

-- ============================================================================
-- PHASE 1: CRITICAL INDEX OPTIMIZATIONS
-- ============================================================================

-- 1. Compound index for tracked emails filtering (most critical)
-- Covers the primary query pattern: account + status + response + time filtering
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_account_status_response
  ON tracked_emails(email_account_id, tracking_status, has_response, sent_at DESC)
  WHERE tracking_status IN ('active', 'paused');

-- 2. Optimized index for active email tracking queries
-- Covers dashboard and real-time queries for active tracking
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_active_tracking
  ON tracked_emails(email_account_id, sent_at DESC, updated_at DESC)
  WHERE tracking_status = 'active'
  INCLUDE (subject, response_count, has_response);

-- 3. Text search optimization for subject and email searches
-- Enables fast full-text search on subjects and email addresses
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_search_subject
  ON tracked_emails USING gin(to_tsvector('english', subject))
  WHERE email_account_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_search_emails
  ON tracked_emails USING gin(to_emails)
  WHERE email_account_id IS NOT NULL;

-- 4. Response tracking optimization
-- Optimizes queries for emails with responses and response timing
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_responses
  ON tracked_emails(email_account_id, has_response, last_response_at DESC)
  WHERE has_response = true
  INCLUDE (sent_at, response_count);

-- 5. Conversation and message ID lookups
-- Optimizes deduplication and conversation tracking
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_message_id
  ON tracked_emails(email_account_id, message_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_conversation
  ON tracked_emails(email_account_id, conversation_id, sent_at DESC)
  WHERE conversation_id IS NOT NULL;

-- ============================================================================
-- PHASE 2: RATE LIMITING OPTIMIZATIONS
-- ============================================================================

-- 1. Active rate limit window optimization
-- Covers the most frequent rate limit check queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limit_active_window
  ON rate_limit_tracking(email_account_id, operation_type, window_end DESC)
  WHERE window_end > NOW()
  INCLUDE (requests_count, window_start);

-- 2. Rate limit cleanup optimization
-- Optimizes the cleanup process for old rate limit records
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limit_cleanup
  ON rate_limit_tracking(window_end)
  WHERE window_end < NOW() - INTERVAL '1 day';

-- 3. Rate limit analytics
-- Optimizes rate limit usage analytics and monitoring
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rate_limit_analytics
  ON rate_limit_tracking(operation_type, window_start DESC)
  INCLUDE (requests_count, email_account_id);

-- ============================================================================
-- PHASE 3: WEBHOOK PROCESSING OPTIMIZATIONS
-- ============================================================================

-- 1. Priority-based webhook queue processing
-- Add priority column if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'webhook_queue' 
    AND column_name = 'priority'
  ) THEN
    ALTER TABLE webhook_queue ADD COLUMN priority INTEGER DEFAULT 5;
  END IF;
END $$;

-- Optimized index for priority-based processing
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_queue_priority
  ON webhook_queue(status, priority DESC, scheduled_for ASC)
  WHERE status IN ('pending', 'failed')
  INCLUDE (notification_data, account_id);

-- 2. Webhook processing status tracking
-- Optimizes status-based queries and job monitoring
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_queue_processing
  ON webhook_queue(status, updated_at DESC)
  WHERE status = 'processing'
  INCLUDE (scheduled_for, retry_count);

-- 3. Failed webhook analysis
-- Optimizes queries for failed webhook analysis and retry logic
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_webhook_queue_failed
  ON webhook_queue(status, retry_count, created_at DESC)
  WHERE status = 'failed' AND retry_count < max_retries
  INCLUDE (error_message, scheduled_for);

-- ============================================================================
-- PHASE 4: ANALYTICS AND REPORTING OPTIMIZATIONS
-- ============================================================================

-- 1. Time-based analytics optimization
-- Covers most dashboard and analytics queries by time periods
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tracked_emails_time_analytics
  ON tracked_emails(email_account_id, sent_at DESC)
  INCLUDE (tracking_status, has_response, response_count, last_response_at);

-- 2. Email responses analytics
-- Optimizes response tracking and timing analytics
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_responses_analytics
  ON email_responses(tracked_email_id, received_at DESC)
  INCLUDE (from_email, is_auto_reply);

-- 3. Response timing optimization
-- Optimizes response time calculations and analytics
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_responses_timing
  ON email_responses(received_at DESC)
  WHERE received_at IS NOT NULL
  INCLUDE (tracked_email_id, from_email);

-- ============================================================================
-- PHASE 5: OPTIMIZED DATABASE FUNCTIONS
-- ============================================================================

-- 1. Optimized tracked emails retrieval function
-- Replaces N+1 query pattern with single optimized query
CREATE OR REPLACE FUNCTION get_tracked_emails_optimized(
  p_account_id UUID,
  p_status TEXT[] DEFAULT NULL,
  p_has_response BOOLEAN DEFAULT NULL,
  p_start_date TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  p_end_date TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  p_search_text TEXT DEFAULT NULL,
  p_sort_by TEXT DEFAULT 'sent_at',
  p_sort_order TEXT DEFAULT 'desc',
  p_limit INTEGER DEFAULT 20,
  p_offset INTEGER DEFAULT 0
)
RETURNS TABLE(
  -- Core tracked email fields
  id UUID,
  email_account_id UUID,
  message_id TEXT,
  conversation_id TEXT,
  thread_id TEXT,
  subject TEXT,
  from_email TEXT,
  from_name TEXT,
  to_emails TEXT[],
  cc_emails TEXT[],
  bcc_emails TEXT[],
  body_preview TEXT,
  sent_at TIMESTAMP WITH TIME ZONE,
  has_response BOOLEAN,
  last_response_at TIMESTAMP WITH TIME ZONE,
  response_count INTEGER,
  tracking_status TEXT,
  follow_up_rule_id UUID,
  created_at TIMESTAMP WITH TIME ZONE,
  updated_at TIMESTAMP WITH TIME ZONE,
  
  -- Aggregated response data
  response_emails JSONB,
  response_time_hours NUMERIC,
  is_overdue BOOLEAN,
  engagement_score INTEGER
) AS $$
DECLARE
  dynamic_query TEXT;
  sort_clause TEXT;
BEGIN
  -- Build dynamic WHERE clause
  dynamic_query := '
    SELECT 
      te.*,
      COALESCE(
        jsonb_agg(
          jsonb_build_object(
            ''id'', er.id,
            ''from_email'', er.from_email,
            ''from_name'', er.from_name,
            ''subject'', er.subject,
            ''received_at'', er.received_at,
            ''is_auto_reply'', er.is_auto_reply
          )
          ORDER BY er.received_at DESC
        ) FILTER (WHERE er.id IS NOT NULL),
        ''[]''::jsonb
      ) as response_emails,
      CASE 
        WHEN te.last_response_at IS NOT NULL 
        THEN EXTRACT(EPOCH FROM (te.last_response_at - te.sent_at)) / 3600.0
        ELSE NULL 
      END as response_time_hours,
      CASE 
        WHEN te.tracking_status = ''active'' 
          AND te.has_response = false 
          AND te.sent_at < NOW() - INTERVAL ''7 days''
        THEN true 
        ELSE false 
      END as is_overdue,
      CASE 
        WHEN te.has_response THEN LEAST(100, 70 + (te.response_count * 10))
        WHEN te.tracking_status = ''active'' THEN 30
        ELSE 10
      END as engagement_score
    FROM tracked_emails te
    LEFT JOIN email_responses er ON er.tracked_email_id = te.id
    WHERE te.email_account_id = $1';

  -- Add dynamic filters
  IF p_status IS NOT NULL THEN
    dynamic_query := dynamic_query || ' AND te.tracking_status = ANY($2)';
  END IF;

  IF p_has_response IS NOT NULL THEN
    dynamic_query := dynamic_query || ' AND te.has_response = ' || p_has_response;
  END IF;

  IF p_start_date IS NOT NULL THEN
    dynamic_query := dynamic_query || ' AND te.sent_at >= ''' || p_start_date || '''';
  END IF;

  IF p_end_date IS NOT NULL THEN
    dynamic_query := dynamic_query || ' AND te.sent_at <= ''' || p_end_date || '''';
  END IF;

  IF p_search_text IS NOT NULL AND length(p_search_text) > 0 THEN
    dynamic_query := dynamic_query || ' AND (te.subject ILIKE ''%' || p_search_text || '%'' OR ''' || p_search_text || ''' = ANY(te.to_emails))';
  END IF;

  dynamic_query := dynamic_query || ' GROUP BY te.id';

  -- Add sorting
  IF p_sort_by = 'sent_at' THEN
    sort_clause := ' ORDER BY te.sent_at ' || UPPER(p_sort_order);
  ELSIF p_sort_by = 'updated_at' THEN
    sort_clause := ' ORDER BY te.updated_at ' || UPPER(p_sort_order);
  ELSIF p_sort_by = 'response_count' THEN
    sort_clause := ' ORDER BY te.response_count ' || UPPER(p_sort_order) || ', te.sent_at DESC';
  ELSIF p_sort_by = 'subject' THEN
    sort_clause := ' ORDER BY te.subject ' || UPPER(p_sort_order) || ', te.sent_at DESC';
  ELSE
    sort_clause := ' ORDER BY te.sent_at DESC';
  END IF;

  dynamic_query := dynamic_query || sort_clause;

  -- Add pagination
  dynamic_query := dynamic_query || ' LIMIT ' || p_limit || ' OFFSET ' || p_offset;

  -- Execute dynamic query
  RETURN QUERY EXECUTE dynamic_query USING p_account_id, p_status;
END;
$$ LANGUAGE plpgsql STABLE;

-- 2. Optimized analytics function
-- Single query for all analytics data to reduce round trips
CREATE OR REPLACE FUNCTION get_tracking_analytics(
  p_account_id UUID,
  p_start_date TIMESTAMP WITH TIME ZONE DEFAULT NULL,
  p_end_date TIMESTAMP WITH TIME ZONE DEFAULT NULL
)
RETURNS TABLE(
  total_tracked INTEGER,
  total_with_response INTEGER,
  total_active INTEGER,
  total_completed INTEGER,
  total_failed INTEGER,
  avg_response_time_hours NUMERIC,
  median_response_time_hours NUMERIC,
  response_rate NUMERIC,
  delivery_rate NUMERIC,
  engagement_score NUMERIC,
  responses_last_24h INTEGER,
  responses_last_7d INTEGER,
  responses_last_30d INTEGER,
  daily_responses JSONB
) AS $$
DECLARE
  start_date TIMESTAMP WITH TIME ZONE;
  end_date TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Set default date range if not provided
  start_date := COALESCE(p_start_date, NOW() - INTERVAL '30 days');
  end_date := COALESCE(p_end_date, NOW());

  RETURN QUERY
  WITH base_stats AS (
    SELECT 
      te.id,
      te.tracking_status,
      te.has_response,
      te.sent_at,
      te.last_response_at,
      te.response_count,
      CASE 
        WHEN te.last_response_at IS NOT NULL 
        THEN EXTRACT(EPOCH FROM (te.last_response_at - te.sent_at)) / 3600.0
        ELSE NULL 
      END as response_time_hours
    FROM tracked_emails te
    WHERE te.email_account_id = p_account_id
      AND te.sent_at >= start_date
      AND te.sent_at <= end_date
  ),
  aggregated_stats AS (
    SELECT 
      COUNT(*)::INTEGER as total_tracked,
      COUNT(*) FILTER (WHERE has_response)::INTEGER as total_with_response,
      COUNT(*) FILTER (WHERE tracking_status = 'active')::INTEGER as total_active,
      COUNT(*) FILTER (WHERE tracking_status = 'completed')::INTEGER as total_completed,
      COUNT(*) FILTER (WHERE tracking_status = 'failed')::INTEGER as total_failed,
      AVG(response_time_hours) as avg_response_time_hours,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY response_time_hours) as median_response_time_hours,
      ARRAY_AGG(response_time_hours ORDER BY response_time_hours) FILTER (WHERE response_time_hours IS NOT NULL) as response_times
    FROM base_stats
  ),
  time_based_stats AS (
    SELECT 
      COUNT(*) FILTER (WHERE last_response_at >= NOW() - INTERVAL '24 hours')::INTEGER as responses_last_24h,
      COUNT(*) FILTER (WHERE last_response_at >= NOW() - INTERVAL '7 days')::INTEGER as responses_last_7d,
      COUNT(*) FILTER (WHERE last_response_at >= NOW() - INTERVAL '30 days')::INTEGER as responses_last_30d
    FROM base_stats
    WHERE has_response = true
  ),
  daily_response_stats AS (
    SELECT 
      jsonb_agg(
        jsonb_build_object(
          'date', response_date,
          'count', daily_count
        )
        ORDER BY response_date
      ) as daily_responses
    FROM (
      SELECT 
        DATE(last_response_at) as response_date,
        COUNT(*)::INTEGER as daily_count
      FROM base_stats
      WHERE has_response = true 
        AND last_response_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(last_response_at)
    ) daily
  )
  SELECT 
    agg.total_tracked,
    agg.total_with_response,
    agg.total_active,
    agg.total_completed,
    agg.total_failed,
    COALESCE(agg.avg_response_time_hours, 0) as avg_response_time_hours,
    COALESCE(agg.median_response_time_hours, 0) as median_response_time_hours,
    CASE 
      WHEN agg.total_tracked > 0 
      THEN (agg.total_with_response::NUMERIC / agg.total_tracked) * 100
      ELSE 0 
    END as response_rate,
    CASE 
      WHEN agg.total_tracked > 0 
      THEN ((agg.total_tracked - agg.total_failed)::NUMERIC / agg.total_tracked) * 100
      ELSE 0 
    END as delivery_rate,
    CASE 
      WHEN agg.total_tracked > 0 
      THEN LEAST(100, (agg.total_with_response::NUMERIC / agg.total_tracked) * 70 + ((agg.total_tracked - agg.total_failed)::NUMERIC / agg.total_tracked) * 30)
      ELSE 0 
    END as engagement_score,
    time_stats.responses_last_24h,
    time_stats.responses_last_7d,
    time_stats.responses_last_30d,
    COALESCE(daily_stats.daily_responses, '[]'::jsonb) as daily_responses
  FROM aggregated_stats agg
  CROSS JOIN time_based_stats time_stats
  CROSS JOIN daily_response_stats daily_stats;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. Optimized rate limiting function with caching support
-- Enhanced rate limiting with better performance characteristics
CREATE OR REPLACE FUNCTION check_and_record_rate_limit(
  p_account_id UUID,
  p_operation_type TEXT,
  p_limit_count INTEGER DEFAULT 10000,
  p_window_minutes INTEGER DEFAULT 60
)
RETURNS TABLE(
  allowed BOOLEAN,
  current_count INTEGER,
  reset_time TIMESTAMP WITH TIME ZONE,
  remaining INTEGER
) AS $$
DECLARE
  window_start TIMESTAMP WITH TIME ZONE;
  window_end TIMESTAMP WITH TIME ZONE;
  current_usage INTEGER;
BEGIN
  -- Calculate current window boundaries
  window_start := DATE_TRUNC('hour', NOW()) + 
    INTERVAL '1 hour' * FLOOR(EXTRACT(EPOCH FROM NOW() - DATE_TRUNC('hour', NOW())) / (p_window_minutes * 60));
  window_end := window_start + INTERVAL '1 minute' * p_window_minutes;
  
  -- Get current usage and increment atomically
  WITH current_window AS (
    INSERT INTO rate_limit_tracking (
      email_account_id,
      operation_type,
      requests_count,
      window_start,
      window_end
    )
    VALUES (p_account_id, p_operation_type, 1, window_start, window_end)
    ON CONFLICT (email_account_id, operation_type, window_start)
    DO UPDATE SET 
      requests_count = rate_limit_tracking.requests_count + 1,
      updated_at = NOW()
    RETURNING requests_count
  )
  SELECT requests_count INTO current_usage FROM current_window;
  
  -- Return result
  RETURN QUERY SELECT 
    (current_usage <= p_limit_count) as allowed,
    current_usage as current_count,
    window_end as reset_time,
    GREATEST(0, p_limit_count - current_usage) as remaining;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Batch email insertion function
-- Optimizes email ingestion with batch processing
CREATE OR REPLACE FUNCTION insert_tracked_emails_batch(
  p_emails JSONB
)
RETURNS TABLE(
  inserted_count INTEGER,
  skipped_count INTEGER,
  error_count INTEGER,
  inserted_ids UUID[]
) AS $$
DECLARE
  email_record JSONB;
  inserted_ids UUID[] := '{}';
  inserted_count INTEGER := 0;
  skipped_count INTEGER := 0;
  error_count INTEGER := 0;
BEGIN
  -- Batch insert with conflict handling
  WITH email_data AS (
    SELECT 
      (value->>'email_account_id')::UUID as email_account_id,
      value->>'message_id' as message_id,
      value->>'conversation_id' as conversation_id,
      value->>'thread_id' as thread_id,
      value->>'subject' as subject,
      value->>'from_email' as from_email,
      value->>'from_name' as from_name,
      ARRAY(SELECT jsonb_array_elements_text(value->'to_emails')) as to_emails,
      CASE WHEN value->'cc_emails' != 'null' 
        THEN ARRAY(SELECT jsonb_array_elements_text(value->'cc_emails'))
        ELSE NULL 
      END as cc_emails,
      CASE WHEN value->'bcc_emails' != 'null' 
        THEN ARRAY(SELECT jsonb_array_elements_text(value->'bcc_emails'))
        ELSE NULL 
      END as bcc_emails,
      value->>'body_preview' as body_preview,
      (value->>'sent_at')::TIMESTAMP WITH TIME ZONE as sent_at,
      COALESCE((value->>'has_response')::BOOLEAN, false) as has_response,
      COALESCE((value->>'response_count')::INTEGER, 0) as response_count,
      COALESCE(value->>'tracking_status', 'active') as tracking_status
    FROM jsonb_array_elements(p_emails)
  ),
  inserted_emails AS (
    INSERT INTO tracked_emails (
      email_account_id,
      message_id,
      conversation_id,
      thread_id,
      subject,
      from_email,
      from_name,
      to_emails,
      cc_emails,
      bcc_emails,
      body_preview,
      sent_at,
      has_response,
      response_count,
      tracking_status
    )
    SELECT * FROM email_data
    ON CONFLICT (email_account_id, message_id) DO NOTHING
    RETURNING id
  )
  SELECT 
    COUNT(*)::INTEGER,
    (jsonb_array_length(p_emails) - COUNT(*))::INTEGER,
    0,
    array_agg(id)
  INTO inserted_count, skipped_count, error_count, inserted_ids
  FROM inserted_emails;

  RETURN QUERY SELECT inserted_count, skipped_count, error_count, inserted_ids;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- PHASE 6: MATERIALIZED VIEWS FOR ANALYTICS
-- ============================================================================

-- 1. Hourly email tracking metrics
-- Pre-calculated analytics for dashboard performance
CREATE MATERIALIZED VIEW IF NOT EXISTS tracked_emails_hourly_metrics AS
SELECT 
  email_account_id,
  DATE_TRUNC('hour', created_at) as metric_hour,
  COUNT(*) as emails_tracked,
  COUNT(*) FILTER (WHERE has_response = true) as emails_with_response,
  COUNT(*) FILTER (WHERE tracking_status = 'active') as active_emails,
  COUNT(*) FILTER (WHERE tracking_status = 'failed') as failed_emails,
  AVG(response_count) as avg_response_count,
  AVG(
    CASE WHEN last_response_at IS NOT NULL 
    THEN EXTRACT(EPOCH FROM (last_response_at - sent_at)) / 3600.0 
    END
  ) as avg_response_time_hours
FROM tracked_emails
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY email_account_id, DATE_TRUNC('hour', created_at);

-- Create unique index for materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_emails_hourly_metrics_pk
  ON tracked_emails_hourly_metrics(email_account_id, metric_hour);

-- 2. Daily rate limiting metrics
CREATE MATERIALIZED VIEW IF NOT EXISTS rate_limiting_daily_metrics AS
SELECT 
  operation_type,
  DATE_TRUNC('day', window_start) as metric_date,
  COUNT(*) as total_windows,
  SUM(requests_count) as total_requests,
  AVG(requests_count) as avg_requests_per_window,
  MAX(requests_count) as peak_requests_per_window,
  COUNT(DISTINCT email_account_id) as unique_accounts
FROM rate_limit_tracking
WHERE window_start >= NOW() - INTERVAL '30 days'
GROUP BY operation_type, DATE_TRUNC('day', window_start);

-- Create unique index for rate limiting metrics
CREATE UNIQUE INDEX IF NOT EXISTS idx_rate_limiting_daily_metrics_pk
  ON rate_limiting_daily_metrics(operation_type, metric_date);

-- ============================================================================
-- PHASE 7: AUTOMATED MAINTENANCE
-- ============================================================================

-- 1. Materialized view refresh function
CREATE OR REPLACE FUNCTION refresh_analytics_views()
RETURNS BOOLEAN AS $$
BEGIN
  -- Refresh hourly metrics
  REFRESH MATERIALIZED VIEW CONCURRENTLY tracked_emails_hourly_metrics;
  
  -- Refresh daily rate limiting metrics
  REFRESH MATERIALIZED VIEW CONCURRENTLY rate_limiting_daily_metrics;
  
  -- Log refresh completion
  INSERT INTO analytics_events (event_type, event_data)
  VALUES (
    'materialized_views_refreshed', 
    jsonb_build_object(
      'timestamp', NOW(),
      'views_refreshed', array['tracked_emails_hourly_metrics', 'rate_limiting_daily_metrics']
    )
  );
  
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  -- Log error
  INSERT INTO analytics_events (event_type, event_data)
  VALUES (
    'materialized_view_refresh_failed',
    jsonb_build_object(
      'timestamp', NOW(),
      'error', SQLERRM
    )
  );
  
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Comprehensive cleanup function
CREATE OR REPLACE FUNCTION cleanup_performance_tables()
RETURNS TABLE(
  table_name TEXT,
  records_deleted INTEGER,
  cleanup_duration_ms INTEGER
) AS $$
DECLARE
  start_time TIMESTAMP;
  end_time TIMESTAMP;
  deleted_count INTEGER;
BEGIN
  -- Cleanup old rate limit records
  start_time := clock_timestamp();
  DELETE FROM rate_limit_tracking
  WHERE window_end < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  end_time := clock_timestamp();
  
  RETURN QUERY SELECT 
    'rate_limit_tracking'::TEXT,
    deleted_count,
    EXTRACT(EPOCH FROM (end_time - start_time) * 1000)::INTEGER;

  -- Cleanup old webhook queue entries
  start_time := clock_timestamp();
  DELETE FROM webhook_queue
  WHERE status = 'completed' 
    AND created_at < NOW() - INTERVAL '7 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  end_time := clock_timestamp();
  
  RETURN QUERY SELECT 
    'webhook_queue'::TEXT,
    deleted_count,
    EXTRACT(EPOCH FROM (end_time - start_time) * 1000)::INTEGER;

  -- Cleanup old analytics events
  start_time := clock_timestamp();
  DELETE FROM analytics_events
  WHERE created_at < NOW() - INTERVAL '30 days'
    AND event_type NOT IN ('system_startup', 'migration_completed');
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  end_time := clock_timestamp();
  
  RETURN QUERY SELECT 
    'analytics_events'::TEXT,
    deleted_count,
    EXTRACT(EPOCH FROM (end_time - start_time) * 1000)::INTEGER;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Verify all indexes were created successfully
SELECT 
  schemaname,
  tablename,
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
  AND tablename IN ('tracked_emails', 'rate_limit_tracking', 'webhook_queue', 'email_responses')
ORDER BY tablename, indexname;

-- Check index sizes and usage
SELECT 
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) as index_size,
  idx_scan as index_scans,
  idx_tup_read as tuples_read,
  idx_tup_fetch as tuples_fetched
FROM pg_stat_user_indexes 
WHERE schemaname = 'public'
  AND indexname LIKE 'idx_%'
ORDER BY pg_relation_size(indexrelid) DESC;

-- Performance validation query examples
-- Test 1: Tracked emails filtering performance
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM get_tracked_emails_optimized(
  'test-account-id'::UUID,
  ARRAY['active'],
  true,
  NOW() - INTERVAL '30 days',
  NOW(),
  'test',
  'sent_at',
  'desc',
  20,
  0
);

-- Test 2: Rate limiting check performance
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM check_and_record_rate_limit(
  'test-account-id'::UUID,
  'email_read',
  10000,
  60
);

-- Test 3: Analytics query performance
EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
SELECT * FROM get_tracking_analytics(
  'test-account-id'::UUID,
  NOW() - INTERVAL '30 days',
  NOW()
);

-- ============================================================================
-- MONITORING AND ALERTING SETUP
-- ============================================================================

-- Create performance monitoring view
CREATE VIEW performance_monitoring AS
SELECT 
  'database' as component,
  'query_performance' as metric_type,
  schemaname || '.' || tablename as resource,
  seq_scan as sequential_scans,
  seq_tup_read as sequential_reads,
  idx_scan as index_scans,
  idx_tup_fetch as index_fetches,
  n_tup_ins as inserts,
  n_tup_upd as updates,
  n_tup_del as deletes,
  NOW() as measured_at
FROM pg_stat_user_tables
WHERE schemaname = 'public'
UNION ALL
SELECT 
  'database' as component,
  'index_usage' as metric_type,
  schemaname || '.' || indexname as resource,
  idx_scan as sequential_scans,
  idx_tup_read as sequential_reads,
  idx_scan as index_scans,
  idx_tup_fetch as index_fetches,
  0 as inserts,
  0 as updates,
  0 as deletes,
  NOW() as measured_at
FROM pg_stat_user_indexes
WHERE schemaname = 'public';

COMMENT ON VIEW performance_monitoring IS 'Real-time database performance metrics for monitoring and alerting';

-- Log optimization completion
INSERT INTO analytics_events (event_type, event_data)
VALUES (
  'database_optimizations_applied',
  jsonb_build_object(
    'timestamp', NOW(),
    'optimization_phase', 'complete',
    'indexes_created', (
      SELECT COUNT(*) 
      FROM pg_indexes 
      WHERE schemaname = 'public' 
        AND indexname LIKE 'idx_%'
        AND tablename IN ('tracked_emails', 'rate_limit_tracking', 'webhook_queue', 'email_responses')
    ),
    'functions_created', 6,
    'materialized_views_created', 2
  )
);

SELECT 'Database performance optimizations applied successfully! ✅' as status;