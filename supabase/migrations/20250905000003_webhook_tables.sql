-- Webhook Infrastructure Tables - Phase 2 Migration
-- Migration: 20250905000003_webhook_tables
-- Created: 2025-09-05 by backend-architect
-- Priority: CRITICAL - Required for Microsoft Graph webhook processing

-- ============================================================================
-- WEBHOOK SUBSCRIPTION MANAGEMENT
-- ============================================================================

-- Webhook subscriptions tracking table
CREATE TABLE webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  microsoft_subscription_id TEXT NOT NULL UNIQUE, -- Microsoft Graph subscription ID
  resource TEXT NOT NULL, -- Resource being monitored (e.g., 'me/messages')
  change_type TEXT NOT NULL, -- 'created,updated,deleted' or specific types
  notification_url TEXT NOT NULL, -- Our webhook endpoint URL
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL, -- When subscription expires
  client_state TEXT, -- Optional client state for validation
  is_active BOOLEAN DEFAULT true,
  error_count INTEGER DEFAULT 0,
  last_error TEXT, -- Last error message if any
  last_renewed_at TIMESTAMP WITH TIME ZONE, -- When last renewed
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- WEBHOOK QUEUE PROCESSING
-- ============================================================================

-- Webhook processing queue table
CREATE TABLE webhook_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_data JSONB NOT NULL, -- Full Microsoft Graph notification
  account_id TEXT NOT NULL, -- Email account ID or subscription ID
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed', 'dead_letter'
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  scheduled_for TIMESTAMP WITH TIME ZONE DEFAULT NOW(), -- When to process this job
  processed_at TIMESTAMP WITH TIME ZONE, -- When processing completed
  error_message TEXT, -- Error message if processing failed
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Webhook subscriptions indexes
CREATE INDEX idx_webhook_subscriptions_account ON webhook_subscriptions(email_account_id);
CREATE INDEX idx_webhook_subscriptions_microsoft_id ON webhook_subscriptions(microsoft_subscription_id);
CREATE INDEX idx_webhook_subscriptions_active ON webhook_subscriptions(is_active, expires_at);
CREATE INDEX idx_webhook_subscriptions_expiring ON webhook_subscriptions(expires_at) WHERE is_active = true;

-- Webhook queue indexes
CREATE INDEX idx_webhook_queue_status ON webhook_queue(status);
CREATE INDEX idx_webhook_queue_scheduled ON webhook_queue(scheduled_for, status);
CREATE INDEX idx_webhook_queue_pending ON webhook_queue(status, created_at) WHERE status IN ('pending', 'failed');
CREATE INDEX idx_webhook_queue_account ON webhook_queue(account_id);
CREATE INDEX idx_webhook_queue_processing ON webhook_queue(status, updated_at) WHERE status = 'processing';

-- ============================================================================
-- FUNCTIONS AND TRIGGERS
-- ============================================================================

-- Function to automatically update webhook_subscriptions.updated_at
CREATE OR REPLACE FUNCTION update_webhook_subscription_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for webhook_subscriptions
CREATE TRIGGER webhook_subscriptions_updated_at
  BEFORE UPDATE ON webhook_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_webhook_subscription_updated_at();

-- Function to automatically update webhook_queue.updated_at
CREATE OR REPLACE FUNCTION update_webhook_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger for webhook_queue
CREATE TRIGGER webhook_queue_updated_at
  BEFORE UPDATE ON webhook_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_webhook_queue_updated_at();

-- Function to get average webhook processing time
CREATE OR REPLACE FUNCTION get_avg_webhook_processing_time()
RETURNS NUMERIC AS $$
DECLARE
  avg_time NUMERIC;
BEGIN
  SELECT AVG(EXTRACT(EPOCH FROM (processed_at - created_at)) * 1000)
  INTO avg_time
  FROM webhook_queue
  WHERE status = 'completed'
    AND processed_at IS NOT NULL
    AND created_at > NOW() - INTERVAL '24 hours';
  
  RETURN COALESCE(avg_time, 0);
END;
$$ LANGUAGE plpgsql;

-- Function to cleanup old webhook queue entries
CREATE OR REPLACE FUNCTION cleanup_webhook_queue(retention_days INTEGER DEFAULT 7)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER := 0;
  additional_count INTEGER;
BEGIN
  -- Delete completed jobs older than retention period
  DELETE FROM webhook_queue
  WHERE status = 'completed'
    AND created_at < NOW() - (retention_days || ' days')::INTERVAL;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  -- Delete failed jobs older than double the retention period
  DELETE FROM webhook_queue
  WHERE status IN ('failed', 'dead_letter')
    AND created_at < NOW() - ((retention_days * 2) || ' days')::INTERVAL;
  
  GET DIAGNOSTICS additional_count = ROW_COUNT;
  
  RETURN deleted_count + additional_count;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- UPDATE EXISTING TABLES
-- ============================================================================

-- Add webhook-related columns to email_accounts if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'email_accounts' 
    AND column_name = 'webhook_subscription_id'
  ) THEN
    ALTER TABLE email_accounts 
    ADD COLUMN webhook_subscription_id TEXT,
    ADD COLUMN webhook_expires_at TIMESTAMP WITH TIME ZONE;
    
    -- Add index for webhook subscription lookup
    CREATE INDEX idx_email_accounts_webhook_subscription 
    ON email_accounts(webhook_subscription_id) 
    WHERE webhook_subscription_id IS NOT NULL;
  END IF;
END $$;

-- ============================================================================
-- SAMPLE DATA FOR DEVELOPMENT (Optional)
-- ============================================================================

-- Only insert sample data in development
DO $$
BEGIN
  IF current_setting('app.environment', true) = 'development' THEN
    -- Sample webhook configurations can be added here if needed
    -- This section is intentionally left empty for production safety
    NULL;
  END IF;
END $$;

-- ============================================================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================================================

COMMENT ON TABLE webhook_subscriptions IS 'Microsoft Graph webhook subscriptions for email tracking';
COMMENT ON COLUMN webhook_subscriptions.microsoft_subscription_id IS 'Unique ID from Microsoft Graph API';
COMMENT ON COLUMN webhook_subscriptions.resource IS 'Microsoft Graph resource being monitored';
COMMENT ON COLUMN webhook_subscriptions.change_type IS 'Types of changes to monitor (created, updated, deleted)';
COMMENT ON COLUMN webhook_subscriptions.expires_at IS 'When the Microsoft subscription expires';
COMMENT ON COLUMN webhook_subscriptions.client_state IS 'Validation token for webhook security';

COMMENT ON TABLE webhook_queue IS 'Asynchronous processing queue for webhook notifications';
COMMENT ON COLUMN webhook_queue.notification_data IS 'Full Microsoft Graph notification payload';
COMMENT ON COLUMN webhook_queue.status IS 'Processing status: pending, processing, completed, failed, dead_letter';
COMMENT ON COLUMN webhook_queue.scheduled_for IS 'When this job should be processed (for retry delays)';

COMMENT ON FUNCTION get_avg_webhook_processing_time() IS 'Returns average webhook processing time in milliseconds for last 24 hours';
COMMENT ON FUNCTION cleanup_webhook_queue(INTEGER) IS 'Cleanup old webhook queue entries to prevent table bloat';

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Verify tables were created successfully
DO $$
DECLARE
  table_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('webhook_subscriptions', 'webhook_queue');
  
  IF table_count != 2 THEN
    RAISE EXCEPTION 'Webhook tables were not created successfully. Expected 2 tables, found %', table_count;
  END IF;
  
  RAISE NOTICE 'Webhook infrastructure tables created successfully ✅';
END $$;