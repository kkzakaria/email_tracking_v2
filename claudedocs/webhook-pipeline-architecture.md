# Microsoft Graph Webhook Pipeline Architecture
**Phase 2 - Email Tracking System**  
**Created:** 2025-09-05  
**Status:** ✅ IMPLEMENTED  

## Overview

This document describes the complete Microsoft Graph webhook pipeline architecture implemented for Phase 2 of the email tracking system. The pipeline enables real-time processing of email changes through Microsoft Graph webhook notifications.

## Architecture Flow

```
Microsoft Graph API → /api/webhooks/microsoft → Validation → Queue → Processing → Database Update
                                            ↓
                                       Audit Logging
                                            ↓
                                    Subscription Management
```

## Core Components

### 1. Webhook Endpoint (`/api/webhooks/microsoft`)
**File:** `app/api/webhooks/microsoft/route.ts`

**Responsibilities:**
- Receives POST notifications from Microsoft Graph
- Handles GET validation challenges during subscription creation
- Validates webhook signatures for security
- Queues notifications for asynchronous processing
- Returns responses within 30-second timeout requirement

**Key Features:**
- Rate limiting integration
- Signature validation with HMAC-SHA256
- Validation token challenge handling
- Comprehensive error handling and audit logging
- CORS support for cross-origin requests

### 2. Webhook Processor (`lib/webhook-processor.ts`)
**Singleton Service:** `webhookProcessor`

**Responsibilities:**
- Manages asynchronous processing queue
- Implements retry logic with exponential backoff
- Provides dead letter queue for failed jobs
- Monitors processing performance and metrics

**Key Features:**
- Configurable retry attempts (default: 3)
- Exponential backoff with jitter
- Concurrent job processing (configurable limit)
- Queue statistics and monitoring
- Graceful shutdown handling

### 3. Subscription Manager (`lib/subscription-manager.ts`)
**Singleton Service:** `subscriptionManager`

**Responsibilities:**
- Creates Microsoft Graph webhook subscriptions
- Automatically renews subscriptions before expiration
- Monitors subscription health and status
- Handles subscription errors and recreation

**Key Features:**
- Automatic renewal within 48 hours of expiration
- Configurable expiration periods (default: 72 hours)
- Error tracking and recovery
- Background renewal monitoring
- Resource-specific subscriptions (email, mailbox)

### 4. Email Change Detector (`lib/email-detector.ts`)
**Singleton Service:** `emailDetector`

**Responsibilities:**
- Processes webhook notifications to detect email changes
- Identifies new tracked emails (outgoing)
- Detects responses to tracked emails with confidence scoring
- Updates tracking status in database

**Key Features:**
- Advanced response detection using subject similarity
- Confidence scoring algorithm (0-1 scale)
- Auto-reply detection and filtering
- Conversation thread matching
- Response time window filtering (default: 7 days)

## Database Schema

### Webhook Subscriptions Table
```sql
CREATE TABLE webhook_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID NOT NULL REFERENCES email_accounts(id),
  microsoft_subscription_id TEXT NOT NULL UNIQUE,
  resource TEXT NOT NULL,
  change_type TEXT NOT NULL,
  notification_url TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  client_state TEXT,
  is_active BOOLEAN DEFAULT true,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  last_renewed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Webhook Queue Table
```sql
CREATE TABLE webhook_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_data JSONB NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  scheduled_for TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  processed_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

## API Endpoints

### Webhook Management
- `POST /api/webhooks/microsoft` - Receive webhook notifications
- `GET /api/webhooks/microsoft` - Handle validation challenges
- `GET /api/webhooks/microsoft/health` - System health check

### Subscription Management
- `POST /api/subscriptions/create` - Create new subscriptions
- `GET /api/subscriptions/status` - Get subscription status
- `POST /api/subscriptions/renew` - Renew subscriptions

## Configuration

### Environment Variables
```env
# Webhook Configuration
WEBHOOK_BASE_URL=http://localhost:3000
WEBHOOK_SECRET=your-webhook-secret
WEBHOOK_VALIDATION_TOKEN=your-validation-token

# Processing Configuration
WEBHOOK_MAX_RETRIES=3
WEBHOOK_RETRY_DELAY_MS=1000
WEBHOOK_MAX_RETRY_DELAY_MS=60000
WEBHOOK_MAX_CONCURRENT_JOBS=10
WEBHOOK_PROCESSING_INTERVAL_MS=5000

# Subscription Configuration
SUBSCRIPTION_EXPIRATION_HOURS=72
SUBSCRIPTION_RENEWAL_THRESHOLD_HOURS=48
SUBSCRIPTION_RENEWAL_CHECK_INTERVAL=3600000

# Email Detection Configuration
EMAIL_RESPONSE_WINDOW_HOURS=168
EMAIL_BATCH_SIZE=50
```

## Security Features

### Webhook Security
1. **Signature Validation:** HMAC-SHA256 signature verification
2. **Token Challenges:** Microsoft validation token support
3. **Rate Limiting:** Configurable rate limits per endpoint
4. **Input Validation:** Comprehensive payload validation
5. **Audit Logging:** All webhook events logged for compliance

### Access Control
1. **RLS Policies:** Row-level security on all webhook tables
2. **User Isolation:** Users can only access their own subscriptions
3. **Service Role Access:** Webhook processing uses service role
4. **Authentication:** JWT token verification for API access

## Monitoring and Health Checks

### Health Monitoring
- **Database Connectivity:** Connection and query performance
- **Queue Health:** Backlog size and processing times
- **Subscription Status:** Active/expired subscription tracking
- **System Metrics:** Overall system health scoring

### Performance Metrics
- **Processing Times:** Average webhook processing duration
- **Queue Statistics:** Pending, completed, failed job counts
- **Error Rates:** Failure ratios and error categorization
- **Throughput:** Notifications processed per hour

## Error Handling

### Retry Strategy
1. **Exponential Backoff:** Increasing delays between retries
2. **Jitter Addition:** Randomization to prevent thundering herd
3. **Maximum Attempts:** Configurable retry limits
4. **Dead Letter Queue:** Permanent storage for failed jobs

### Error Categories
- **Transient Errors:** Network timeouts, temporary API issues
- **Permanent Errors:** Invalid tokens, deleted accounts
- **Rate Limit Errors:** Microsoft Graph throttling
- **Validation Errors:** Malformed webhook payloads

## Integration Points

### Microsoft Graph API
- **Subscription Creation:** POST /subscriptions
- **Subscription Renewal:** PATCH /subscriptions/{id}
- **Message Retrieval:** GET /me/messages/{id}
- **User Information:** GET /me

### Internal Services
- **Rate Limiter:** Request throttling and compliance
- **Audit Logger:** Security event logging
- **Token Manager:** Encrypted token storage and refresh
- **Graph Client:** Microsoft Graph API wrapper

## Deployment Considerations

### Production Requirements
1. **Webhook URL:** HTTPS endpoint with valid SSL certificate
2. **Secret Management:** Secure storage of webhook secrets
3. **Database Migrations:** Apply webhook table migrations
4. **Environment Variables:** Configure all webhook settings
5. **Monitoring Setup:** Enable health check endpoints

### Scaling Considerations
1. **Queue Processing:** Horizontal scaling of workers
2. **Database Performance:** Proper indexing on webhook tables
3. **Memory Management:** Cleanup of old webhook queue entries
4. **Rate Limiting:** Microsoft Graph API compliance

## Testing Strategy

### Unit Tests
- Webhook signature validation
- Queue processing logic
- Subscription management functions
- Email detection algorithms

### Integration Tests
- End-to-end webhook flow
- Microsoft Graph API interactions
- Database transaction integrity
- Error handling scenarios

### Performance Tests
- Webhook processing throughput
- Queue backlog management
- Subscription renewal timing
- System resource usage

## Maintenance

### Regular Tasks
1. **Queue Cleanup:** Remove old processed jobs
2. **Subscription Monitoring:** Check for renewal failures
3. **Health Checks:** Monitor system performance
4. **Error Analysis:** Review failed webhook processing

### Monitoring Alerts
- High queue backlog (>100 pending jobs)
- Subscription expiry warnings (24 hours before)
- High error rates (>10% failure rate)
- System health degradation

## Next Steps

### Phase 3 Enhancements
1. **Follow-up Rules:** Automated email follow-ups
2. **Advanced Analytics:** Email engagement metrics
3. **UI Dashboard:** Real-time monitoring interface
4. **Bulk Operations:** Mass email tracking management

This architecture provides a robust, scalable foundation for real-time email tracking through Microsoft Graph webhooks, with comprehensive error handling, monitoring, and security features.