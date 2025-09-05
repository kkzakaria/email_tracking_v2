# Email Tracking Engine Architecture
**Phase 2 - Email Tracking System Implementation**  
**Created:** 2025-09-05  
**Status:** ✅ IMPLEMENTED  

## Overview

The Email Tracking Engine is the core component of the email tracking system, providing comprehensive email lifecycle management, response detection, and analytics. This document describes the complete architecture and integration with the existing webhook pipeline.

## Architecture Components

```
┌─────────────────────────────────────────────────────────────┐
│                    Email Tracking Engine                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ Email Tracking  │  │ Email Ingestion │  │ Response     │ │
│  │ Service         │  │ Engine          │  │ Matcher      │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ Email Lifecycle │  │ Analytics       │  │ API          │ │
│  │ Manager         │  │ Service         │  │ Endpoints    │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│            Existing Webhook Pipeline Integration            │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────────┐ │
│  │ Webhook         │  │ Email Detector  │  │ Microsoft    │ │
│  │ Processor       │  │ (Enhanced)      │  │ Graph Client │ │
│  └─────────────────┘  └─────────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Email Tracking Service (`lib/email-tracking-service.ts`)
**Primary Service:** `emailTrackingService`

**Responsibilities:**
- Start/stop email tracking for individual messages
- Manage tracked email lifecycle and status
- Provide CRUD operations for tracked emails
- Calculate metrics and engagement scores
- Handle batch operations with pagination

**Key Features:**
- Automatic email ingestion from Microsoft Graph
- Real-time status updates via webhook integration
- Comprehensive filtering and search capabilities
- Performance-optimized queries with proper indexing
- Rate limiting compliance for Microsoft Graph API

### 2. Email Ingestion Engine (`lib/email-ingestion.ts`)
**Primary Service:** `emailIngestionEngine`

**Responsibilities:**
- Periodic synchronization with Microsoft Graph API
- Batch processing of outbound emails
- Deduplication and conflict resolution
- Retry logic with exponential backoff
- Performance monitoring and error handling

**Key Features:**
- Configurable batch sizes and sync intervals
- Intelligent filtering for outbound emails only
- Rate limiting integration with queue management
- Comprehensive error tracking and recovery
- Support for manual and automatic synchronization

### 3. Response Matcher (`lib/response-matcher.ts`)
**Primary Service:** `responseMatcher`

**Responsibilities:**
- Intelligent response detection with >95% accuracy
- Multi-factor confidence scoring algorithm
- Auto-reply detection and filtering
- Thread and conversation matching
- Response validation and duplicate prevention

**Key Features:**
- Advanced string similarity algorithms (Levenshtein distance)
- Weighted confidence scoring (subject, recipient, time, conversation)
- Configurable confidence thresholds
- Support for multiple languages
- Comprehensive logging and audit trails

### 4. Email Lifecycle Manager (`lib/email-lifecycle.ts`)
**Primary Service:** `emailLifecycleManager`

**Responsibilities:**
- State machine implementation for email status transitions
- Automatic timeout and archival processing
- Background cleanup of old emails
- Status validation and transition rules
- Performance monitoring and health checks

**Key Features:**
- Configurable state transition rules
- Automatic processing intervals
- Grace periods for status changes
- Batch processing for performance
- Comprehensive audit logging

## State Machine Definition

```
[PENDING] → [SENT] → [DELIVERED] → [OPENED] → [REPLIED]
    ↓         ↓         ↓           ↓           ↓
[FAILED]  [BOUNCED]  [CLOSED]   [CLOSED]   [CLOSED]
```

**Valid Transitions:**
- `PENDING` → `SENT`, `FAILED`, `CLOSED`
- `SENT` → `DELIVERED`, `BOUNCED`, `FAILED`, `CLOSED`  
- `DELIVERED` → `OPENED`, `REPLIED`, `CLOSED`
- `OPENED` → `REPLIED`, `CLOSED`
- `REPLIED` → `CLOSED`
- `BOUNCED` → `CLOSED`
- `CLOSED` → (Terminal state)

## Database Schema Integration

### Core Tables
```sql
-- Primary tracking table
tracked_emails (
  id UUID PRIMARY KEY,
  email_account_id UUID REFERENCES email_accounts(id),
  message_id TEXT UNIQUE,
  conversation_id TEXT,
  subject TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_emails TEXT[] NOT NULL,
  tracking_status tracking_status_enum DEFAULT 'active',
  has_response BOOLEAN DEFAULT FALSE,
  response_count INTEGER DEFAULT 0,
  sent_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Response tracking table
email_responses (
  id UUID PRIMARY KEY,
  tracked_email_id UUID REFERENCES tracked_emails(id),
  message_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  received_at TIMESTAMP WITH TIME ZONE NOT NULL,
  is_auto_reply BOOLEAN DEFAULT FALSE,
  confidence_score FLOAT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Indexes for Performance
```sql
-- Core lookup indexes
CREATE INDEX idx_tracked_emails_account_id ON tracked_emails(email_account_id);
CREATE INDEX idx_tracked_emails_message_id ON tracked_emails(message_id);
CREATE INDEX idx_tracked_emails_status ON tracked_emails(tracking_status);
CREATE INDEX idx_tracked_emails_sent_at ON tracked_emails(sent_at DESC);
CREATE INDEX idx_tracked_emails_has_response ON tracked_emails(has_response);

-- Response lookup indexes  
CREATE INDEX idx_email_responses_tracked_id ON email_responses(tracked_email_id);
CREATE INDEX idx_email_responses_received_at ON email_responses(received_at DESC);
```

## API Endpoints

### Email Tracking Management
- `POST /api/emails/track` - Start tracking an email
- `DELETE /api/emails/track` - Stop tracking an email
- `GET /api/emails/tracked` - List tracked emails with filters
- `GET /api/emails/tracked/[id]` - Get single tracked email details
- `PUT /api/emails/tracked/[id]/status` - Update tracking status
- `DELETE /api/emails/tracked/[id]` - Stop tracking (alias)

### Analytics and Metrics
- `GET /api/emails/analytics` - Get tracking metrics and statistics

### Synchronization
- `POST /api/emails/sync` - Manual email synchronization
- `GET /api/emails/sync` - Get synchronization status

## Integration with Webhook Pipeline

### Enhanced Email Detector
The existing `email-detector.ts` has been enhanced to integrate with the new tracking engine:

**Integration Points:**
1. **Outbound Email Detection:** Automatically starts tracking for sent emails
2. **Response Detection:** Uses the advanced response matcher for accurate matching
3. **Status Updates:** Updates tracking status based on webhook notifications
4. **Performance Optimization:** Reduces redundant Graph API calls

**Workflow:**
```
Webhook Notification → Email Detector → Response Matcher → Tracking Service → Database Update
                                    ↓
                                Auto-tracking for new outbound emails
```

## Configuration

### Environment Variables
```env
# Email Tracking Configuration
EMAIL_TRACKING_ENABLED=true
EMAIL_TRACKING_MAX_AGE_DAYS=30
EMAIL_TRACKING_SYNC_INTERVAL_MINUTES=15
EMAIL_TRACKING_BATCH_SIZE=50
EMAIL_AUTO_TRACK_OUTBOUND=true

# Response Detection
RESPONSE_DETECTION_CONFIDENCE_THRESHOLD=0.8
RESPONSE_DETECTION_AUTO_REPLY_FILTER=true
RESPONSE_DETECTION_MAX_THREAD_DEPTH=10

# Performance Settings
EMAIL_INGESTION_MAX_CONCURRENT=5
EMAIL_INGESTION_RETRY_DELAY_MS=5000
EMAIL_INGESTION_MAX_RETRIES=3

# Lifecycle Management
EMAIL_TRACKING_TIMEOUT_DAYS=30
EMAIL_TRACKING_ARCHIVE_DAYS=90
EMAIL_LIFECYCLE_PROCESSING_INTERVAL_MS=3600000
```

## Performance Metrics

### Target Performance
- **Email Sync:** < 30 seconds for 100 emails
- **Response Detection:** < 5 seconds after webhook notification
- **API Response:** < 2 seconds for normal queries
- **Database Queries:** Optimized with proper indexes

### Scalability Considerations
- **Batch Processing:** Configurable batch sizes for large volumes
- **Rate Limiting:** Microsoft Graph API compliance (10k ops/hour)
- **Database Performance:** Proper indexing and query optimization
- **Memory Management:** Cleanup of old tracking data

## Security Features

### Data Protection
- **Row-Level Security:** Users can only access their own tracked emails
- **Token Security:** All Microsoft Graph operations use encrypted tokens
- **Audit Logging:** Comprehensive logging of all tracking operations
- **Rate Limiting:** Protection against API abuse

### Privacy Compliance
- **Data Minimization:** Only essential email metadata is stored
- **Automatic Cleanup:** Old tracking data is automatically archived
- **User Control:** Users can stop tracking at any time
- **Consent Management:** Tracking requires explicit user action

## Error Handling and Recovery

### Error Categories
1. **Transient Errors:** Network timeouts, temporary API issues
2. **Rate Limit Errors:** Microsoft Graph throttling
3. **Authentication Errors:** Token expiry, permission issues
4. **Data Errors:** Invalid email IDs, missing references

### Recovery Strategies
- **Exponential Backoff:** For transient errors
- **Retry Queues:** Failed operations are queued for retry
- **Dead Letter Queue:** Permanent failures are isolated
- **Manual Recovery:** API endpoints for manual error resolution

## Testing and Validation

### Test Script
A comprehensive test script (`scripts/test-email-tracking.js`) validates:
- Database connectivity and table structure
- API endpoint functionality
- Webhook integration
- Rate limiting system
- Data integrity and relationships

### Integration Tests
- **End-to-end email tracking workflow**
- **Response detection accuracy validation**
- **Performance benchmarking**
- **Error handling scenarios**

## Monitoring and Health Checks

### Health Metrics
- **Tracking Success Rate:** Percentage of successful tracking operations
- **Response Detection Accuracy:** Confidence score distribution
- **API Performance:** Response times and error rates
- **Database Performance:** Query times and connection health

### Alerts and Monitoring
- **High Error Rates:** > 10% failure rate
- **Slow Performance:** > 5 second response times
- **Rate Limit Warnings:** Approaching Microsoft Graph limits
- **Database Issues:** Connection or performance problems

## Future Enhancements

### Phase 3 Features
1. **Advanced Analytics:** Email engagement heatmaps and trends
2. **Follow-up Automation:** Automatic follow-up email suggestions
3. **AI-Powered Insights:** Machine learning for response prediction
4. **Bulk Operations:** Mass email tracking management
5. **Real-time Dashboard:** Live tracking status updates

This architecture provides a robust, scalable foundation for comprehensive email tracking with high accuracy response detection and real-time status updates.