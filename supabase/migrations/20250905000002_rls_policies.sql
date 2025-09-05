-- Email Tracking System - Row Level Security Policies
-- Migration: 20250905000002_rls_policies
-- Created: 2025-09-05 by backend-architect
-- Priority: CRITICAL - Security policies for all tables

-- ============================================================================
-- ENABLE RLS ON ALL TABLES
-- ============================================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracked_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE follow_up_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_consent_records ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- PROFILES POLICIES
-- ============================================================================

-- Users can only read and update their own profile
CREATE POLICY "Users can view their own profile"
  ON profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can insert their own profile"
  ON profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

-- ============================================================================
-- EMAIL ACCOUNTS POLICIES
-- ============================================================================

-- Users can only access their own email accounts
CREATE POLICY "Users can view their own email accounts"
  ON email_accounts FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own email accounts"
  ON email_accounts FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own email accounts"
  ON email_accounts FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own email accounts"
  ON email_accounts FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================================
-- ⚠️ CRITICAL: RATE LIMIT TRACKING POLICIES
-- ============================================================================

-- Users can only access rate limit data for their own email accounts
CREATE POLICY "Users can view their own rate limit data"
  ON rate_limit_tracking FOR SELECT
  TO authenticated
  USING (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

-- System can insert rate limit data for authenticated users' accounts
CREATE POLICY "System can insert rate limit data for user accounts"
  ON rate_limit_tracking FOR INSERT
  TO authenticated
  WITH CHECK (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

-- System can update rate limit data for authenticated users' accounts
CREATE POLICY "System can update rate limit data for user accounts"
  ON rate_limit_tracking FOR UPDATE
  TO authenticated
  USING (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

-- Allow service role to manage rate limiting (for cleanup functions)
CREATE POLICY "Service role can manage all rate limit data"
  ON rate_limit_tracking FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- TRACKED EMAILS POLICIES
-- ============================================================================

-- Users can only access tracked emails from their own email accounts
CREATE POLICY "Users can view their own tracked emails"
  ON tracked_emails FOR SELECT
  TO authenticated
  USING (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert tracked emails for their accounts"
  ON tracked_emails FOR INSERT
  TO authenticated
  WITH CHECK (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update their own tracked emails"
  ON tracked_emails FOR UPDATE
  TO authenticated
  USING (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete their own tracked emails"
  ON tracked_emails FOR DELETE
  TO authenticated
  USING (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

-- ============================================================================
-- EMAIL RESPONSES POLICIES
-- ============================================================================

-- Users can only access responses to their tracked emails
CREATE POLICY "Users can view responses to their tracked emails"
  ON email_responses FOR SELECT
  TO authenticated
  USING (
    tracked_email_id IN (
      SELECT te.id FROM tracked_emails te
      JOIN email_accounts ea ON te.email_account_id = ea.id
      WHERE ea.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert responses to their tracked emails"
  ON email_responses FOR INSERT
  TO authenticated
  WITH CHECK (
    tracked_email_id IN (
      SELECT te.id FROM tracked_emails te
      JOIN email_accounts ea ON te.email_account_id = ea.id
      WHERE ea.user_id = auth.uid()
    )
  );

-- ============================================================================
-- FOLLOW-UP TEMPLATES POLICIES
-- ============================================================================

-- Users can view their own templates and default templates
CREATE POLICY "Users can view their own and default templates"
  ON follow_up_templates FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid() OR 
    user_id = '00000000-0000-0000-0000-000000000000' -- Default templates
  );

CREATE POLICY "Users can insert their own templates"
  ON follow_up_templates FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own templates"
  ON follow_up_templates FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own templates"
  ON follow_up_templates FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================================
-- FOLLOW-UP RULES POLICIES
-- ============================================================================

-- Users can only access their own follow-up rules
CREATE POLICY "Users can view their own follow-up rules"
  ON follow_up_rules FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own follow-up rules"
  ON follow_up_rules FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own follow-up rules"
  ON follow_up_rules FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own follow-up rules"
  ON follow_up_rules FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================================
-- FOLLOW-UP EXECUTIONS POLICIES
-- ============================================================================

-- Users can only access executions for their tracked emails
CREATE POLICY "Users can view their own follow-up executions"
  ON follow_up_executions FOR SELECT
  TO authenticated
  USING (
    tracked_email_id IN (
      SELECT te.id FROM tracked_emails te
      JOIN email_accounts ea ON te.email_account_id = ea.id
      WHERE ea.user_id = auth.uid()
    )
  );

-- System can insert executions for user's tracked emails
CREATE POLICY "System can insert follow-up executions for user emails"
  ON follow_up_executions FOR INSERT
  TO authenticated
  WITH CHECK (
    tracked_email_id IN (
      SELECT te.id FROM tracked_emails te
      JOIN email_accounts ea ON te.email_account_id = ea.id
      WHERE ea.user_id = auth.uid()
    )
  );

-- System can update executions for user's tracked emails
CREATE POLICY "System can update follow-up executions for user emails"
  ON follow_up_executions FOR UPDATE
  TO authenticated
  USING (
    tracked_email_id IN (
      SELECT te.id FROM tracked_emails te
      JOIN email_accounts ea ON te.email_account_id = ea.id
      WHERE ea.user_id = auth.uid()
    )
  )
  WITH CHECK (
    tracked_email_id IN (
      SELECT te.id FROM tracked_emails te
      JOIN email_accounts ea ON te.email_account_id = ea.id
      WHERE ea.user_id = auth.uid()
    )
  );

-- ============================================================================
-- NOTIFICATIONS POLICIES
-- ============================================================================

-- Users can only access their own notifications
CREATE POLICY "Users can view their own notifications"
  ON notifications FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "System can insert notifications for users"
  ON notifications FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own notifications"
  ON notifications FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete their own notifications"
  ON notifications FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================================
-- USER SETTINGS POLICIES
-- ============================================================================

-- Users can only access their own settings
CREATE POLICY "Users can view their own settings"
  ON user_settings FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own settings"
  ON user_settings FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own settings"
  ON user_settings FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- ANALYTICS EVENTS POLICIES
-- ============================================================================

-- Users can view their own analytics events
CREATE POLICY "Users can view their own analytics events"
  ON analytics_events FOR SELECT
  TO authenticated
  USING (user_id = auth.uid() OR user_id IS NULL);

-- System can insert analytics events
CREATE POLICY "System can insert analytics events"
  ON analytics_events FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid() OR user_id IS NULL);

-- Service role can view all events for system analytics
CREATE POLICY "Service role can view all analytics events"
  ON analytics_events FOR SELECT
  TO service_role
  USING (true);

-- ============================================================================
-- AUDIT LOGS POLICIES
-- ============================================================================

-- Users can view their own audit logs
CREATE POLICY "Users can view their own audit logs"
  ON audit_logs FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- System can insert audit logs
CREATE POLICY "System can insert audit logs"
  ON audit_logs FOR INSERT
  TO authenticated
  WITH CHECK (true); -- Allow system to log any action

-- Service role can view all audit logs
CREATE POLICY "Service role can view all audit logs"
  ON audit_logs FOR SELECT
  TO service_role
  USING (true);

-- ============================================================================
-- USER CONSENT RECORDS POLICIES
-- ============================================================================

-- Users can only access their own consent records
CREATE POLICY "Users can view their own consent records"
  ON user_consent_records FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert their own consent records"
  ON user_consent_records FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own consent records"
  ON user_consent_records FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ============================================================================
-- SECURITY FUNCTIONS FOR RLS
-- ============================================================================

-- Function to check if user owns an email account
CREATE OR REPLACE FUNCTION user_owns_email_account(account_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM email_accounts
    WHERE id = account_id AND user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user can access tracked email
CREATE OR REPLACE FUNCTION user_can_access_tracked_email(tracked_email_id UUID)
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM tracked_emails te
    JOIN email_accounts ea ON te.email_account_id = ea.id
    WHERE te.id = tracked_email_id AND ea.user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to audit policy violations (for monitoring)
CREATE OR REPLACE FUNCTION log_rls_violation(
  table_name TEXT,
  operation TEXT,
  user_id UUID DEFAULT auth.uid()
)
RETURNS VOID AS $$
BEGIN
  INSERT INTO audit_logs (user_id, action, resource_type, ip_address, created_at)
  VALUES (
    user_id,
    'RLS_VIOLATION',
    table_name || '_' || operation,
    INET_CLIENT_ADDR(),
    NOW()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Comments for security documentation
COMMENT ON POLICY "Users can view their own rate limit data" ON rate_limit_tracking 
IS 'Critical security policy for Microsoft Graph API rate limiting data access';

COMMENT ON FUNCTION user_owns_email_account IS 'Security helper function to verify email account ownership';
COMMENT ON FUNCTION user_can_access_tracked_email IS 'Security helper function to verify tracked email access';
COMMENT ON FUNCTION log_rls_violation IS 'Security monitoring function for RLS policy violations';

-- Migration completed successfully
SELECT 'Email Tracking System - RLS policies migration completed successfully' as message;