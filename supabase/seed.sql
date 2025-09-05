-- Email Tracking System - Seed Data
-- File: seed.sql
-- Created: 2025-09-05 by backend-architect
-- Purpose: Initial data for development and testing

-- ============================================================================
-- DEVELOPMENT SEED DATA
-- ============================================================================

-- Note: This file is used for local development only
-- Production data should never be seeded this way

-- Insert a test user profile (will be created automatically when a user signs up via Supabase Auth)
-- This is just for reference - actual profiles are created via auth triggers

-- Create some default system templates that are available to all users
-- These templates are owned by a special system user ID

-- Temporarily disable RLS for system data insertion
SET session_replication_role = replica;

-- Create system user in auth.users first (simulated for local development)
-- This is a workaround for local development - in production use proper auth flow
INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
VALUES ('00000000-0000-0000-0000-000000000000', 'system@email-tracking.local', '', NOW(), NOW(), NOW(), '{}', '{}')
ON CONFLICT (id) DO NOTHING;

-- Create system profile
INSERT INTO profiles (id, email, full_name, company)
VALUES ('00000000-0000-0000-0000-000000000000', 'system@email-tracking.local', 'System Templates', 'System')
ON CONFLICT (id) DO NOTHING;

-- Re-enable RLS
SET session_replication_role = DEFAULT;

-- Insert system-wide default templates
INSERT INTO follow_up_templates (id, user_id, name, subject_template, body_template, is_default) VALUES
-- Professional follow-up templates
('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Professional First Follow-up', 
 'Re: {{original_subject}}', 
 'Hello {{recipient_name}},

I hope this message finds you well. I''m following up on my email regarding {{subject}}.

If you have any questions or need additional information, please don''t hesitate to reach out. I''m here to help and would be happy to provide any clarification you might need.

Thank you for your time and consideration.

Best regards,
{{sender_name}}', true),

('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'Professional Second Follow-up',
 'Following up: {{original_subject}}',
 'Hello {{recipient_name}},

I wanted to reach out once more regarding {{subject}}. I understand you''re likely busy, and I appreciate your time.

If this isn''t the right time or if you need to prioritize other matters, please let me know. I''m happy to follow up at a more convenient time or provide any additional details that might be helpful.

Looking forward to your response.

Best regards,
{{sender_name}}', true),

-- Sales-oriented templates
('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Sales First Follow-up',
 'Quick follow-up: {{original_subject}}',
 'Hi {{recipient_name}},

I hope you''re doing well! I wanted to quickly follow up on my previous email about {{subject}}.

I believe this could be a great opportunity for {{recipient_company}}, and I''d love to discuss how we can help you achieve your goals.

Would you be available for a brief 15-minute call this week to explore this further?

Best regards,
{{sender_name}}', true),

('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'Sales Value-Focused Follow-up',
 'The value we can bring to {{recipient_company}}',
 'Hi {{recipient_name}},

I hope you''re having a great week! I wanted to follow up on my email about {{subject}} and share some quick insights.

Based on what I know about {{recipient_company}}, I believe we could help you:
• Increase efficiency by up to 30%
• Reduce operational costs
• Improve your team''s productivity

Would you be interested in a quick call to discuss how this applies to your specific situation?

Best regards,
{{sender_name}}', true),

-- Partnership/Collaboration templates  
('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Partnership Follow-up',
 'Partnership opportunity: {{original_subject}}',
 'Dear {{recipient_name}},

I hope this email finds you well. I''m following up on my previous message regarding the potential partnership between our organizations.

I believe there''s significant mutual value in exploring this collaboration further. Both our companies share similar values and could benefit greatly from working together.

Would you be available for a call next week to discuss this opportunity in more detail?

Looking forward to your response.

Best regards,
{{sender_name}}', true),

-- Networking templates
('40000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'Networking Follow-up',
 'Great meeting you - {{original_subject}}',
 'Hi {{recipient_name}},

It was great meeting you {{meeting_context}}! I enjoyed our conversation about {{subject}}.

As mentioned, I''d love to continue our discussion and explore potential ways we could collaborate or support each other''s work.

Would you be interested in grabbing coffee sometime next week?

Best regards,
{{sender_name}}', true);

-- Insert some example analytics events for demonstration
INSERT INTO analytics_events (event_type, event_data) VALUES
('system_startup', '{"version": "1.0.0", "environment": "development"}'),
('migration_completed', '{"migration": "initial_schema", "timestamp": "2025-09-05"}'),
('seed_data_loaded', '{"templates_count": 7, "timestamp": "2025-09-05"}');

-- Create a sample audit log entry
INSERT INTO audit_logs (action, resource_type, resource_id, new_values, ip_address, user_agent) VALUES
('SYSTEM_INIT', 'database', 'initial_setup', 
 '{"action": "seed_data_loaded", "templates": 7}',
 '127.0.0.1', 
 'Supabase-Seed-Script');

-- ============================================================================
-- DEVELOPMENT HELPER FUNCTIONS
-- ============================================================================

-- Function to reset all user data (for development only)
CREATE OR REPLACE FUNCTION dev_reset_user_data(target_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  result_text TEXT := '';
BEGIN
  -- Only allow in development environment
  IF current_setting('app.environment', true) != 'development' THEN
    RAISE EXCEPTION 'This function can only be used in development environment';
  END IF;
  
  -- Delete user data in correct order to respect foreign key constraints
  DELETE FROM user_consent_records WHERE user_id = target_user_id;
  DELETE FROM notifications WHERE user_id = target_user_id;
  DELETE FROM follow_up_executions WHERE tracked_email_id IN (
    SELECT te.id FROM tracked_emails te
    JOIN email_accounts ea ON te.email_account_id = ea.id
    WHERE ea.user_id = target_user_id
  );
  DELETE FROM email_responses WHERE tracked_email_id IN (
    SELECT te.id FROM tracked_emails te
    JOIN email_accounts ea ON te.email_account_id = ea.id
    WHERE ea.user_id = target_user_id
  );
  DELETE FROM tracked_emails WHERE email_account_id IN (
    SELECT id FROM email_accounts WHERE user_id = target_user_id
  );
  DELETE FROM rate_limit_tracking WHERE email_account_id IN (
    SELECT id FROM email_accounts WHERE user_id = target_user_id
  );
  DELETE FROM email_accounts WHERE user_id = target_user_id;
  DELETE FROM follow_up_rules WHERE user_id = target_user_id;
  DELETE FROM follow_up_templates WHERE user_id = target_user_id;
  DELETE FROM user_settings WHERE user_id = target_user_id;
  DELETE FROM analytics_events WHERE user_id = target_user_id;
  
  result_text := 'Successfully reset all data for user: ' || target_user_id::text;
  
  -- Log the reset action
  INSERT INTO audit_logs (user_id, action, resource_type, new_values)
  VALUES (target_user_id, 'DEV_DATA_RESET', 'user_data', jsonb_build_object('reset_time', NOW()));
  
  RETURN result_text;
END;
$$ LANGUAGE plpgsql;

-- Function to create test data for a user (development only)
CREATE OR REPLACE FUNCTION dev_create_test_data(target_user_id UUID)
RETURNS TEXT AS $$
DECLARE
  test_email_account_id UUID;
  test_tracked_email_id UUID;
  result_text TEXT := '';
BEGIN
  -- Only allow in development environment
  IF current_setting('app.environment', true) != 'development' THEN
    RAISE EXCEPTION 'This function can only be used in development environment';
  END IF;
  
  -- Create a test email account
  INSERT INTO email_accounts (
    user_id, microsoft_user_id, email_address, display_name,
    access_token_encrypted, refresh_token_encrypted, token_expires_at
  ) VALUES (
    target_user_id,
    'test-ms-user-' || target_user_id::text,
    'test@example.com',
    'Test User',
    'encrypted_test_access_token',
    'encrypted_test_refresh_token',
    NOW() + INTERVAL '1 hour'
  ) RETURNING id INTO test_email_account_id;
  
  -- Create a test tracked email
  INSERT INTO tracked_emails (
    email_account_id, message_id, subject, from_email, from_name,
    to_emails, sent_at
  ) VALUES (
    test_email_account_id,
    'test-message-' || gen_random_uuid()::text,
    'Test Email Subject',
    'test@example.com',
    'Test User',
    ARRAY['recipient@example.com'],
    NOW() - INTERVAL '2 hours'
  ) RETURNING id INTO test_tracked_email_id;
  
  -- Create test user settings
  INSERT INTO user_settings (user_id, timezone, notification_preferences, tracking_preferences)
  VALUES (
    target_user_id,
    'America/New_York',
    '{"email": true, "in_app": true, "follow_up_sent": true}',
    '{"auto_track": true, "track_replies": true}'
  ) ON CONFLICT (user_id) DO NOTHING;
  
  -- Create a test follow-up rule
  INSERT INTO follow_up_rules (
    user_id, name, description, first_follow_up_hours, max_follow_ups
  ) VALUES (
    target_user_id,
    'Test Follow-up Rule',
    'A test rule for development',
    24,
    2
  );
  
  result_text := 'Successfully created test data for user: ' || target_user_id::text;
  
  -- Log the creation action
  INSERT INTO analytics_events (user_id, event_type, event_data)
  VALUES (
    target_user_id, 
    'test_data_created', 
    jsonb_build_object(
      'email_account_id', test_email_account_id,
      'tracked_email_id', test_tracked_email_id,
      'created_at', NOW()
    )
  );
  
  RETURN result_text;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- COMMENTS AND DOCUMENTATION
-- ============================================================================

COMMENT ON FUNCTION dev_reset_user_data IS 'Development only: Reset all data for a specific user';
COMMENT ON FUNCTION dev_create_test_data IS 'Development only: Create test data for a specific user';

-- Final success message
SELECT 'Email Tracking System - Seed data loaded successfully' as message;

-- Show loaded template count
SELECT 
  'Loaded ' || COUNT(*) || ' default follow-up templates' as summary
FROM follow_up_templates 
WHERE user_id = '00000000-0000-0000-0000-000000000000';