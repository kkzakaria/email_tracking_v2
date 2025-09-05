-- Email Tracking System - Initial Schema Migration
-- Migration: 20250905000001_initial_schema
-- Created: 2025-09-05 by backend-architect
-- Priority: CRITICAL - Includes rate_limit_tracking for Microsoft Graph API

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create enums
CREATE TYPE tracking_status_enum AS ENUM ('active', 'paused', 'completed', 'failed');
CREATE TYPE importance_level_enum AS ENUM ('low', 'normal', 'high');
CREATE TYPE execution_status_enum AS ENUM ('scheduled', 'executed', 'failed', 'cancelled');
CREATE TYPE notification_type_enum AS ENUM (
  'response_received', 
  'follow_up_sent', 
  'follow_up_failed', 
  'webhook_error', 
  'token_expired', 
  'rate_limit_exceeded'
);

-- ============================================================================
-- CORE TABLES
-- ============================================================================

-- Users and Authentication (extends Supabase auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  full_name TEXT,
  company TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Email Accounts (Microsoft accounts)
CREATE TABLE email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  microsoft_user_id TEXT NOT NULL UNIQUE,
  email_address TEXT NOT NULL,
  display_name TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  webhook_subscription_id TEXT,
  webhook_expires_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(user_id, email_address)
);

-- ⚠️ CRITICAL: Rate Limiting Table for Microsoft Graph API
CREATE TABLE rate_limit_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL, -- 'email_read', 'webhook_create', 'bulk_operation'
  requests_count INTEGER DEFAULT 0,
  window_start TIMESTAMP WITH TIME ZONE NOT NULL,
  window_end TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(email_account_id, operation_type, window_start)
);

-- Email Tracking
CREATE TABLE tracked_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL, -- Microsoft Graph message ID
  conversation_id TEXT,
  thread_id TEXT,
  subject TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_emails TEXT[] NOT NULL,
  cc_emails TEXT[],
  bcc_emails TEXT[],
  body_preview TEXT,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
  has_response BOOLEAN DEFAULT false,
  last_response_at TIMESTAMP WITH TIME ZONE,
  response_count INTEGER DEFAULT 0,
  tracking_status tracking_status_enum DEFAULT 'active',
  follow_up_rule_id UUID, -- Will be linked after follow_up_rules table creation
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(email_account_id, message_id)
);

-- Email Responses
CREATE TABLE email_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_email_id UUID NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  from_name TEXT,
  subject TEXT,
  body_preview TEXT,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Follow-up Templates (created before rules for referential integrity)
CREATE TABLE follow_up_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Follow-up Rules
CREATE TABLE follow_up_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN DEFAULT true,
  
  -- Conditions
  applies_to_domains TEXT[], -- null means all domains
  applies_to_emails TEXT[], -- specific emails
  exclude_domains TEXT[],
  exclude_emails TEXT[],
  min_importance importance_level_enum DEFAULT 'normal',
  
  -- Follow-up settings
  first_follow_up_hours INTEGER NOT NULL DEFAULT 24,
  second_follow_up_hours INTEGER, -- null = no second follow-up
  third_follow_up_hours INTEGER, -- null = no third follow-up
  max_follow_ups INTEGER DEFAULT 1,
  
  -- Templates
  first_template_id UUID REFERENCES follow_up_templates(id),
  second_template_id UUID REFERENCES follow_up_templates(id),
  third_template_id UUID REFERENCES follow_up_templates(id),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add foreign key constraint to tracked_emails after follow_up_rules creation
ALTER TABLE tracked_emails 
ADD CONSTRAINT fk_tracked_emails_follow_up_rule 
FOREIGN KEY (follow_up_rule_id) REFERENCES follow_up_rules(id);

-- Follow-up Executions
CREATE TABLE follow_up_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_email_id UUID NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  follow_up_rule_id UUID NOT NULL REFERENCES follow_up_rules(id) ON DELETE CASCADE,
  follow_up_number INTEGER NOT NULL, -- 1, 2, or 3
  scheduled_for TIMESTAMP WITH TIME ZONE NOT NULL,
  executed_at TIMESTAMP WITH TIME ZONE,
  execution_status execution_status_enum DEFAULT 'scheduled',
  message_id TEXT, -- Graph API message ID when sent
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Notifications
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type notification_type_enum NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User Settings
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  timezone TEXT DEFAULT 'UTC',
  notification_preferences JSONB DEFAULT '{}',
  tracking_preferences JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Analytics Events (for tracking system usage and performance)
CREATE TABLE analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Audit Logs (for security and compliance)
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  old_values JSONB,
  new_values JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User Consent Records (GDPR compliance)
CREATE TABLE user_consent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL, -- 'email_tracking', 'data_processing', 'marketing'
  granted BOOLEAN NOT NULL,
  consent_date TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  withdrawn_date TIMESTAMP WITH TIME ZONE,
  legal_basis TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Email tracking queries
CREATE INDEX idx_tracked_emails_account_status ON tracked_emails(email_account_id, tracking_status);
CREATE INDEX idx_tracked_emails_sent_at ON tracked_emails(sent_at);
CREATE INDEX idx_tracked_emails_has_response ON tracked_emails(has_response) WHERE has_response = false;

-- Follow-up execution queries
CREATE INDEX idx_follow_up_executions_scheduled ON follow_up_executions(scheduled_for, execution_status);
CREATE INDEX idx_follow_up_executions_tracked_email ON follow_up_executions(tracked_email_id);

-- Notification queries
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read, created_at);

-- Response tracking
CREATE INDEX idx_email_responses_tracked_email ON email_responses(tracked_email_id, received_at);

-- ⚠️ CRITICAL: Rate limiting indexes
CREATE INDEX idx_rate_limit_tracking_account_type ON rate_limit_tracking(email_account_id, operation_type);
CREATE INDEX idx_rate_limit_tracking_window ON rate_limit_tracking(window_start, window_end);
CREATE INDEX idx_rate_limit_tracking_active_window ON rate_limit_tracking(window_end);

-- Analytics and audit indexes
CREATE INDEX idx_analytics_events_user_type ON analytics_events(user_id, event_type, created_at);
CREATE INDEX idx_audit_logs_user_action ON audit_logs(user_id, action, created_at);
CREATE INDEX idx_user_consent_records_user_type ON user_consent_records(user_id, consent_type);

-- ============================================================================
-- FUNCTIONS FOR BUSINESS LOGIC
-- ============================================================================

-- Function to automatically update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply updated_at triggers to all tables with updated_at column
CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_email_accounts_updated_at BEFORE UPDATE ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_rate_limit_tracking_updated_at BEFORE UPDATE ON rate_limit_tracking
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tracked_emails_updated_at BEFORE UPDATE ON tracked_emails
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_follow_up_rules_updated_at BEFORE UPDATE ON follow_up_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_follow_up_templates_updated_at BEFORE UPDATE ON follow_up_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_settings_updated_at BEFORE UPDATE ON user_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ⚠️ CRITICAL: Rate limiting management functions
CREATE OR REPLACE FUNCTION check_rate_limit(
  account_id UUID,
  operation_type TEXT,
  limit_count INTEGER DEFAULT 10000,
  window_minutes INTEGER DEFAULT 60
)
RETURNS TABLE(allowed BOOLEAN, current_count INTEGER, reset_time TIMESTAMP WITH TIME ZONE) AS $$
DECLARE
  window_start TIMESTAMP WITH TIME ZONE;
  current_usage INTEGER;
BEGIN
  -- Calculate window start time
  window_start := DATE_TRUNC('hour', NOW()) + INTERVAL '1 hour' * FLOOR(EXTRACT(EPOCH FROM NOW() - DATE_TRUNC('hour', NOW())) / (window_minutes * 60));
  
  -- Get current usage in this window
  SELECT COALESCE(SUM(requests_count), 0) INTO current_usage
  FROM rate_limit_tracking
  WHERE email_account_id = account_id 
    AND rate_limit_tracking.operation_type = check_rate_limit.operation_type
    AND window_start <= NOW() 
    AND window_end > NOW();
    
  -- Return result
  RETURN QUERY SELECT 
    (current_usage < limit_count) as allowed,
    current_usage as current_count,
    (window_start + INTERVAL '1 minute' * window_minutes) as reset_time;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to record rate limit usage
CREATE OR REPLACE FUNCTION record_rate_limit_usage(
  account_id UUID,
  operation_type TEXT,
  window_minutes INTEGER DEFAULT 60
)
RETURNS BOOLEAN AS $$
DECLARE
  window_start TIMESTAMP WITH TIME ZONE;
  window_end TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Calculate window times
  window_start := DATE_TRUNC('hour', NOW()) + INTERVAL '1 hour' * FLOOR(EXTRACT(EPOCH FROM NOW() - DATE_TRUNC('hour', NOW())) / (window_minutes * 60));
  window_end := window_start + INTERVAL '1 minute' * window_minutes;
  
  -- Insert or update usage record
  INSERT INTO rate_limit_tracking (email_account_id, operation_type, requests_count, window_start, window_end)
  VALUES (account_id, operation_type, 1, window_start, window_end)
  ON CONFLICT (email_account_id, operation_type, window_start)
  DO UPDATE SET 
    requests_count = rate_limit_tracking.requests_count + 1,
    updated_at = NOW();
    
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clean up old rate limit records
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete records older than 7 days
  DELETE FROM rate_limit_tracking
  WHERE window_end < NOW() - INTERVAL '7 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- Log cleanup action
  INSERT INTO analytics_events (event_type, event_data)
  VALUES ('rate_limit_cleanup', jsonb_build_object('deleted_records', deleted_count));
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- INITIAL DATA SETUP
-- ============================================================================

-- Create system user profile for default templates (bypasses RLS using service role)
-- This will be handled separately through seed.sql to avoid foreign key issues
-- The templates will be created during seed phase after proper auth setup

-- Default templates will be created in seed.sql file
-- INSERT statements moved to separate seed file to handle auth dependencies properly

-- Comment for migration tracking
COMMENT ON TABLE rate_limit_tracking IS 'Critical table for Microsoft Graph API rate limiting - September 2025 update';
COMMENT ON FUNCTION check_rate_limit IS 'Core rate limiting function for Microsoft Graph API compliance';
COMMENT ON FUNCTION record_rate_limit_usage IS 'Records API usage for rate limit tracking';
COMMENT ON FUNCTION cleanup_old_rate_limits IS 'Cleanup function for old rate limit records';

-- Migration completed successfully
SELECT 'Email Tracking System - Initial schema migration completed successfully' as message;