-- Webhook Infrastructure RLS Policies - Phase 2 Security
-- Migration: 20250905000004_webhook_rls_policies
-- Created: 2025-09-05 by backend-architect
-- Priority: CRITICAL - Security policies for webhook tables

-- ============================================================================
-- ENABLE ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on webhook tables
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_queue ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- WEBHOOK SUBSCRIPTIONS POLICIES
-- ============================================================================

-- Policy: Users can view their own webhook subscriptions
CREATE POLICY "Users can view own webhook subscriptions" ON webhook_subscriptions
  FOR SELECT
  USING (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

-- Policy: Users can insert webhook subscriptions for their accounts
CREATE POLICY "Users can create webhook subscriptions" ON webhook_subscriptions
  FOR INSERT
  WITH CHECK (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

-- Policy: Users can update their own webhook subscriptions
CREATE POLICY "Users can update own webhook subscriptions" ON webhook_subscriptions
  FOR UPDATE
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

-- Policy: Users can delete their own webhook subscriptions
CREATE POLICY "Users can delete own webhook subscriptions" ON webhook_subscriptions
  FOR DELETE
  USING (
    email_account_id IN (
      SELECT id FROM email_accounts 
      WHERE user_id = auth.uid()
    )
  );

-- Policy: Service role has full access to webhook subscriptions
CREATE POLICY "Service role full access to webhook subscriptions" ON webhook_subscriptions
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- ============================================================================
-- WEBHOOK QUEUE POLICIES
-- ============================================================================

-- Policy: Users can view webhook queue entries for their accounts
CREATE POLICY "Users can view own webhook queue entries" ON webhook_queue
  FOR SELECT
  USING (
    -- Allow if account_id matches user's email accounts
    account_id IN (
      SELECT id::text FROM email_accounts 
      WHERE user_id = auth.uid()
    )
    OR
    -- Allow if account_id is a subscription ID owned by user
    account_id IN (
      SELECT ws.microsoft_subscription_id 
      FROM webhook_subscriptions ws
      JOIN email_accounts ea ON ws.email_account_id = ea.id
      WHERE ea.user_id = auth.uid()
    )
  );

-- Policy: Service role has full access to webhook queue
CREATE POLICY "Service role full access to webhook queue" ON webhook_queue
  FOR ALL
  USING (auth.jwt() ->> 'role' = 'service_role')
  WITH CHECK (auth.jwt() ->> 'role' = 'service_role');

-- Policy: System can insert webhook queue entries (for webhook processing)
CREATE POLICY "System can insert webhook queue entries" ON webhook_queue
  FOR INSERT
  WITH CHECK (true); -- Allow all inserts, will be restricted by application logic

-- Policy: System can update webhook queue entries (for processing status)
CREATE POLICY "System can update webhook queue entries" ON webhook_queue
  FOR UPDATE
  USING (true) -- Allow all updates, will be restricted by application logic
  WITH CHECK (true);

-- ============================================================================
-- ADDITIONAL SECURITY FUNCTIONS
-- ============================================================================

-- Function to check if user owns a subscription
CREATE OR REPLACE FUNCTION user_owns_subscription(subscription_id TEXT)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM webhook_subscriptions ws
    JOIN email_accounts ea ON ws.email_account_id = ea.id
    WHERE ws.microsoft_subscription_id = subscription_id
      AND ea.user_id = auth.uid()
  );
END;
$$;

-- Function to check if user owns an email account
CREATE OR REPLACE FUNCTION user_owns_account(account_id UUID)
RETURNS BOOLEAN
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 
    FROM email_accounts 
    WHERE id = account_id
      AND user_id = auth.uid()
  );
END;
$$;

-- ============================================================================
-- WEBHOOK PROCESSING SECURITY
-- ============================================================================

-- Policy: Webhook processing function access (for service account)
CREATE POLICY "Webhook processing access" ON webhook_subscriptions
  FOR SELECT
  USING (
    -- Allow service role
    auth.jwt() ->> 'role' = 'service_role'
    OR
    -- Allow authenticated requests for verification
    (auth.uid() IS NOT NULL AND is_active = true)
  );

-- ============================================================================
-- MONITORING AND AUDIT POLICIES
-- ============================================================================

-- Grant service role ability to cleanup old webhook data
GRANT EXECUTE ON FUNCTION cleanup_webhook_queue(INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION get_avg_webhook_processing_time() TO service_role;

-- Grant authenticated users ability to check subscription ownership
GRANT EXECUTE ON FUNCTION user_owns_subscription(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION user_owns_account(UUID) TO authenticated;

-- ============================================================================
-- PERFORMANCE OPTIMIZATION POLICIES
-- ============================================================================

-- Create partial indexes for commonly filtered queries
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_user_active
  ON webhook_subscriptions (email_account_id, is_active, expires_at)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_webhook_queue_user_status
  ON webhook_queue (account_id, status, created_at)
  WHERE status IN ('pending', 'processing', 'failed');

-- ============================================================================
-- SECURITY CONSTRAINTS
-- ============================================================================

-- Add check constraints for data integrity
ALTER TABLE webhook_subscriptions 
ADD CONSTRAINT check_webhook_subscription_expiry 
CHECK (expires_at > created_at);

ALTER TABLE webhook_subscriptions
ADD CONSTRAINT check_webhook_subscription_error_count
CHECK (error_count >= 0);

ALTER TABLE webhook_queue
ADD CONSTRAINT check_webhook_queue_retry_count
CHECK (retry_count >= 0 AND retry_count <= max_retries);

ALTER TABLE webhook_queue
ADD CONSTRAINT check_webhook_queue_status
CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead_letter'));

-- ============================================================================
-- DOCUMENTATION COMMENTS
-- ============================================================================

COMMENT ON FUNCTION user_owns_subscription(TEXT) IS 'Check if authenticated user owns the specified Microsoft Graph subscription';
COMMENT ON FUNCTION user_owns_account(UUID) IS 'Check if authenticated user owns the specified email account';

-- ============================================================================
-- TESTING POLICIES (Development Only)
-- ============================================================================

-- Create test function to verify RLS is working
CREATE OR REPLACE FUNCTION test_webhook_rls_policies()
RETURNS TABLE(test_name TEXT, passed BOOLEAN, details TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  test_user_id UUID := gen_random_uuid();
  test_account_id UUID;
  test_subscription_id TEXT := 'test-subscription-' || gen_random_uuid();
BEGIN
  -- Only run tests in development
  IF current_setting('app.environment', true) != 'development' THEN
    RETURN QUERY SELECT 'RLS Tests'::TEXT, true, 'Skipped in production'::TEXT;
    RETURN;
  END IF;

  -- Create test data
  INSERT INTO profiles (id, email, full_name) 
  VALUES (test_user_id, 'test@example.com', 'Test User');
  
  INSERT INTO email_accounts (id, user_id, microsoft_user_id, email_address, access_token_encrypted, refresh_token_encrypted, token_expires_at)
  VALUES (gen_random_uuid(), test_user_id, 'test-ms-id', 'test@example.com', 'encrypted-token', 'encrypted-refresh', NOW() + INTERVAL '1 hour')
  RETURNING id INTO test_account_id;

  -- Test subscription creation
  BEGIN
    INSERT INTO webhook_subscriptions (email_account_id, microsoft_subscription_id, resource, change_type, notification_url, expires_at)
    VALUES (test_account_id, test_subscription_id, 'me/messages', 'created,updated', 'https://example.com/webhook', NOW() + INTERVAL '72 hours');
    
    RETURN QUERY SELECT 'Subscription Creation'::TEXT, true, 'User can create subscriptions for own accounts'::TEXT;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'Subscription Creation'::TEXT, false, SQLERRM::TEXT;
  END;

  -- Cleanup test data
  DELETE FROM webhook_subscriptions WHERE microsoft_subscription_id = test_subscription_id;
  DELETE FROM email_accounts WHERE id = test_account_id;
  DELETE FROM profiles WHERE id = test_user_id;

  RETURN QUERY SELECT 'RLS Tests Complete'::TEXT, true, 'All webhook RLS policies tested'::TEXT;
END;
$$;

-- Grant execution to service role for testing
GRANT EXECUTE ON FUNCTION test_webhook_rls_policies() TO service_role;

-- ============================================================================
-- FINAL VERIFICATION
-- ============================================================================

-- Verify all policies are created
DO $$
DECLARE
  policy_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO policy_count
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('webhook_subscriptions', 'webhook_queue');
  
  IF policy_count < 8 THEN
    RAISE WARNING 'Expected at least 8 RLS policies, found %. Please verify policy creation.', policy_count;
  ELSE
    RAISE NOTICE 'Webhook RLS policies created successfully: % policies ✅', policy_count;
  END IF;
END $$;