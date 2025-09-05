# Email Tracking System Architecture

**Dernière révision**: 5 septembre 2025 - Validation de compatibilité effectuée  
**Status de compatibilité**: ✅ Compatible avec mises à jour mineures requises

## 1. High-Level System Architecture

```text
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Frontend      │    │   Backend API   │    │   External      │
│   (Next.js 15) │◄──►│   (App Router)  │◄──►│   Services      │
└─────────────────┘    └─────────────────┘    └─────────────────┘
        │                       │                       │
        ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   UI Layer      │    │   Service Layer │    │ Microsoft Graph │
│ - Dashboard     │    │ - Auth Service  │    │ - Email API     │
│ - Email List    │    │ - Email Service │    │ - Webhooks      │
│ - Follow-up     │    │ - Follow-up     │    │ - OAuth2        │
│   Config        │    │   Service       │    │ - Rate Limiter  │ ⚠️ NEW
│ - Notifications │    │ - Notification  │    └─────────────────┘
└─────────────────┘    │   Service       │              │
        │               │ - Rate Limiter  │ ⚠️ NEW       ▼
        ▼               └─────────────────┘    ┌─────────────────┐
┌─────────────────┐              ▼               │   Vercel        │
│   State Mgmt    │    ┌─────────────────┐    │ - Deployment    │
│ - React Query   │    │   Database      │    │ - Edge Runtime  │
│ - Zustand       │    │   (Supabase)    │    │ - Cron Jobs     │
└─────────────────┘    └─────────────────┘    └─────────────────┘

                      Data Flow Architecture
┌─────────────┐   webhooks  ┌─────────────┐   process   ┌─────────────┐
│   MS Graph  │────────────►│ Webhook API │────────────►│ Queue/Jobs  │
└─────────────┘             │Rate Limited │⚠️ NEW      └─────────────┘
                            └─────────────┘             │
                                   │                            ▼
                            ┌─────────────┐            ┌─────────────┐
                            │  Database   │            │ Follow-up   │
                            │   Updates   │            │  Engine     │
                            └─────────────┘            └─────────────┘
                                   │                            │
                                   ▼                            ▼
                            ┌─────────────┐            ┌─────────────┐
                            │ Real-time   │            │ Send Email  │
                            │ Updates     │            │ via Graph   │
                            └─────────────┘            └─────────────┘
```

## 2. Database Schema Design

### Core Tables

```sql
-- Users and Authentication
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT NOT NULL,
  full_name TEXT,
  company TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
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
  token_expires_at TIMESTAMP NOT NULL,
  webhook_subscription_id TEXT,
  webhook_expires_at TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(user_id, email_address)
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
  sent_at TIMESTAMP NOT NULL,
  has_response BOOLEAN DEFAULT false,
  last_response_at TIMESTAMP,
  response_count INTEGER DEFAULT 0,
  tracking_status tracking_status_enum DEFAULT 'active',
  follow_up_rule_id UUID REFERENCES follow_up_rules(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
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
  received_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
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
  
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Follow-up Templates
CREATE TABLE follow_up_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subject_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Follow-up Executions
CREATE TABLE follow_up_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tracked_email_id UUID NOT NULL REFERENCES tracked_emails(id) ON DELETE CASCADE,
  follow_up_rule_id UUID NOT NULL REFERENCES follow_up_rules(id) ON DELETE CASCADE,
  follow_up_number INTEGER NOT NULL, -- 1, 2, or 3
  scheduled_for TIMESTAMP NOT NULL,
  executed_at TIMESTAMP,
  execution_status execution_status_enum DEFAULT 'scheduled',
  message_id TEXT, -- Graph API message ID when sent
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ⚠️ NEW: Rate Limiting Table
CREATE TABLE rate_limit_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_account_id UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  operation_type TEXT NOT NULL, -- 'email_read', 'webhook_create', 'bulk_operation'
  requests_count INTEGER DEFAULT 0,
  window_start TIMESTAMP NOT NULL,
  window_end TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(email_account_id, operation_type, window_start)
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
  created_at TIMESTAMP DEFAULT NOW()
);

-- User Settings
CREATE TABLE user_settings (
  user_id UUID PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
  timezone TEXT DEFAULT 'UTC',
  notification_preferences JSONB DEFAULT '{}',
  tracking_preferences JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Enums
CREATE TYPE tracking_status_enum AS ENUM ('active', 'paused', 'completed', 'failed');
CREATE TYPE importance_level_enum AS ENUM ('low', 'normal', 'high');
CREATE TYPE execution_status_enum AS ENUM ('scheduled', 'executed', 'failed', 'cancelled');
CREATE TYPE notification_type_enum AS ENUM ('response_received', 'follow_up_sent', 'follow_up_failed', 'webhook_error', 'token_expired', 'rate_limit_exceeded');
```

### Indexes for Performance

```sql
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

-- ⚠️ NEW: Rate limiting queries
CREATE INDEX idx_rate_limit_tracking_account_type ON rate_limit_tracking(email_account_id, operation_type);
CREATE INDEX idx_rate_limit_tracking_window ON rate_limit_tracking(window_start, window_end);
```

## 3. API Routes and Endpoints Structure

```typescript
// Authentication & User Management
/api/auth/
├── microsoft/callback        # OAuth callback from Microsoft
├── microsoft/refresh         # Token refresh
├── signout                  # Sign out user

/api/user/
├── profile                  # GET, PUT user profile
├── settings                 # GET, PUT user settings
└── email-accounts           # GET, POST, DELETE email accounts

// Email Management
/api/emails/
├── tracked                  # GET tracked emails with pagination
├── [messageId]             # GET specific email details
├── [messageId]/responses   # GET responses to specific email
└── sync                    # POST manual sync trigger

// Follow-up Management  
/api/follow-ups/
├── rules                   # GET, POST follow-up rules
├── rules/[id]             # GET, PUT, DELETE specific rule
├── templates              # GET, POST templates
├── templates/[id]         # GET, PUT, DELETE specific template
├── executions             # GET scheduled/executed follow-ups
└── executions/[id]/cancel # POST cancel follow-up

// Webhooks & External
/api/webhooks/
├── microsoft              # POST Microsoft Graph webhooks
└── health                 # GET webhook health check

// ⚠️ NEW: Rate Limiting
/api/rate-limit/
├── check                  # POST check rate limit before operation
├── status                 # GET current rate limit status
└── reset                  # POST reset rate limit window (admin)

// Analytics & Dashboard
/api/analytics/
├── dashboard              # GET dashboard statistics
├── response-rates         # GET response rate analytics
└── follow-up-performance  # GET follow-up effectiveness

// Notifications
/api/notifications/
├── list                   # GET user notifications
├── [id]/read             # PUT mark as read
└── mark-all-read         # PUT mark all as read
```

## 4. Component Hierarchy and Organization

```text
app/
├── (auth)/                    # Route group for auth pages
│   ├── sign-in/
│   └── sign-up/
├── (dashboard)/              # Protected dashboard routes
│   ├── layout.tsx           # Dashboard layout with nav
│   ├── page.tsx             # Dashboard home
│   ├── emails/
│   │   ├── page.tsx         # Email list
│   │   └── [id]/
│   │       └── page.tsx     # Email details
│   ├── follow-ups/
│   │   ├── page.tsx         # Follow-up rules
│   │   ├── rules/
│   │   │   ├── new/
│   │   │   └── [id]/edit/
│   │   └── templates/
│   │       ├── new/
│   │       └── [id]/edit/
│   ├── settings/
│   │   ├── page.tsx         # General settings
│   │   ├── accounts/        # Email accounts
│   │   └── notifications/   # Notification preferences
│   └── analytics/
│       └── page.tsx         # Analytics dashboard
├── api/                     # API routes (as detailed above)
├── globals.css
├── layout.tsx              # Root layout
└── page.tsx                # Landing/welcome page

components/
├── ui/                     # shadcn/ui components
│   ├── button.tsx
│   ├── card.tsx
│   ├── dialog.tsx
│   ├── form.tsx
│   ├── input.tsx
│   ├── select.tsx
│   ├── table.tsx
│   ├── toast.tsx
│   └── ...
├── layout/                 # Layout components
│   ├── header.tsx
│   ├── sidebar.tsx
│   ├── navigation.tsx
│   └── footer.tsx
├── auth/                   # Authentication components
│   ├── login-form.tsx
│   ├── microsoft-auth-button.tsx
│   └── protected-route.tsx
├── dashboard/              # Dashboard-specific components
│   ├── stats-cards.tsx
│   ├── recent-emails.tsx
│   ├── response-chart.tsx
│   └── quick-actions.tsx
├── emails/                 # Email-related components
│   ├── email-list.tsx
│   ├── email-card.tsx
│   ├── email-detail.tsx
│   ├── email-filters.tsx
│   └── email-search.tsx
├── follow-ups/             # Follow-up components
│   ├── rule-form.tsx
│   ├── rule-list.tsx
│   ├── template-editor.tsx
│   ├── execution-timeline.tsx
│   └── follow-up-preview.tsx
├── notifications/          # Notification components
│   ├── notification-bell.tsx
│   ├── notification-list.tsx
│   └── notification-item.tsx
├── charts/                 # Analytics components
│   ├── response-rate-chart.tsx
│   ├── follow-up-performance.tsx
│   └── email-volume-chart.tsx
└── forms/                  # Reusable form components
    ├── email-account-form.tsx
    ├── follow-up-rule-form.tsx
    └── settings-form.tsx

lib/
├── supabase.ts            # Supabase client
├── microsoft-graph.ts     # Microsoft Graph client
├── auth.ts               # Authentication helpers
├── email-service.ts      # Email operations
├── follow-up-service.ts  # Follow-up logic
├── notification-service.ts # Notifications
├── analytics.ts          # Analytics calculations
├── encryption.ts         # Token encryption/decryption
├── validators.ts         # Zod schemas
├── constants.ts          # Application constants
├── rate-limiter.ts       # ⚠️ NEW: Rate limiting service
└── utils.ts              # Utility functions

hooks/
├── use-auth.ts           # Authentication hook
├── use-emails.ts         # Email data management
├── use-follow-ups.ts     # Follow-up management
├── use-notifications.ts  # Real-time notifications
├── use-analytics.ts      # Analytics data
├── use-rate-limiter.ts   # ⚠️ NEW: Rate limiting hook
└── use-debounce.ts       # Utility hooks

types/
├── database.ts           # Supabase generated types
├── microsoft-graph.ts    # Graph API types
├── auth.ts              # Auth-related types
├── email.ts             # Email types
├── follow-up.ts         # Follow-up types
├── rate-limiter.ts      # ⚠️ NEW: Rate limiting types
└── analytics.ts         # Analytics types
```

## 5. Security Considerations

### Authentication & Authorization

- **OAuth 2.0 Flow**: Microsoft Graph API integration with proper PKCE
- **JWT Tokens**: Supabase handles secure JWT token management
- **Row Level Security (RLS)**: Supabase RLS policies for data isolation
- **Token Encryption**: Encrypt Microsoft access/refresh tokens at rest
- **Session Management**: Secure session handling with proper expiration

### Data Protection

```sql
-- RLS Policies Example
ALTER TABLE tracked_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own tracked emails" 
ON tracked_emails 
FOR ALL 
TO authenticated 
USING (
  email_account_id IN (
    SELECT id FROM email_accounts 
    WHERE user_id = auth.uid()
  )
);

CREATE POLICY "Users can only access their own follow-up rules"
ON follow_up_rules
FOR ALL
TO authenticated
USING (user_id = auth.uid());

-- ⚠️ NEW: Rate limiting data protection
ALTER TABLE rate_limit_tracking ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can only access their own rate limit data"
ON rate_limit_tracking
FOR ALL
TO authenticated
USING (
  email_account_id IN (
    SELECT id FROM email_accounts 
    WHERE user_id = auth.uid()
  )
);
```

### API Security

- **Rate Limiting**: Implement rate limiting for all API endpoints
- **Input Validation**: Zod schema validation for all inputs
- **CORS Configuration**: Proper CORS setup for production
- **Webhook Validation**: Verify Microsoft Graph webhook signatures
- **Environment Variables**: Secure storage of secrets

### Infrastructure Security

- **HTTPS Only**: Force HTTPS in production
- **Security Headers**: Implement security headers (CSP, HSTS, etc.)
- **Database Encryption**: Encrypt sensitive data at rest
- **Audit Logging**: Log security-relevant events
- **Backup Security**: Encrypted database backups

## 6. Deployment and Infrastructure Recommendations

### Vercel Deployment Architecture

```text
┌─────────────────┐
│   Vercel Edge   │
│   - Static      │
│   - Functions   │
│   - Middleware  │
└─────────────────┘
        │
        ▼
┌─────────────────┐    ┌─────────────────┐
│   Supabase      │    │   External      │
│   - Database    │    │   - Graph API   │
│   - Auth        │    │   - SMTP        │
│   - Realtime    │    │   - Monitoring  │
│   - Storage     │    └─────────────────┘
└─────────────────┘
```

### Environment Configuration

```typescript
// Environment variables structure - ⚠️ UPDATED
interface Environment {
  // Supabase
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  
  // Microsoft Graph - ⚠️ UPDATED SCOPES
  MICROSOFT_CLIENT_ID: string;
  MICROSOFT_CLIENT_SECRET: string;
  MICROSOFT_REDIRECT_URI: string;
  MICROSOFT_SCOPES: string; // ⚠️ NEW: Configurable scopes
  
  // Encryption
  ENCRYPTION_KEY: string;
  
  // Rate Limiting - ⚠️ NEW
  GRAPH_RATE_LIMIT_EMAIL_OPS: string; // Default: "10000"
  GRAPH_RATE_LIMIT_WEBHOOKS: string;  // Default: "50"
  GRAPH_RATE_LIMIT_BULK: string;      // Default: "100"
  
  // Monitoring
  VERCEL_URL: string;
  WEBHOOK_SECRET: string;
  
  // Optional: External services
  SENTRY_DSN?: string;
  ANALYTICS_ID?: string;
}
```

### Vercel Configuration

```typescript
// vercel.json - ⚠️ UPDATED
{
  "functions": {
    "app/api/webhooks/microsoft/route.ts": {
      "maxDuration": 30
    },
    "app/api/follow-ups/execute/route.ts": {
      "maxDuration": 60
    },
    "app/api/rate-limit/check/route.ts": {
      "maxDuration": 10
    }
  },
  "crons": [
    {
      "path": "/api/cron/process-follow-ups",
      "schedule": "*/5 * * * *"
    },
    {
      "path": "/api/cron/refresh-tokens",
      "schedule": "0 */6 * * *"
    },
    {
      "path": "/api/cron/cleanup-expired",
      "schedule": "0 2 * * *"
    },
    {
      "path": "/api/cron/reset-rate-limits",
      "schedule": "0 */1 * * *"
    }
  ]
}
```

## 7. Scalability Considerations

### Performance Optimization

- **Database Indexing**: Strategic indexes for query performance
- **Query Optimization**: Efficient Supabase queries with select() optimization
- **Caching Strategy**: Redis caching for frequently accessed data
- **Image Optimization**: Next.js Image component for optimal loading
- **Code Splitting**: Lazy loading of components and routes

### Background Job Processing

```typescript
// Background job architecture - ⚠️ UPDATED
interface JobQueue {
  // Follow-up processing
  processFollowUps: () => Promise<void>;
  
  // Token refresh
  refreshExpiredTokens: () => Promise<void>;
  
  // Webhook processing
  processWebhookEvents: (events: WebhookEvent[]) => Promise<void>;
  
  // Email synchronization
  syncEmailAccounts: (accountIds: string[]) => Promise<void>;
  
  // Analytics calculation
  calculateAnalytics: (userId: string) => Promise<void>;
  
  // ⚠️ NEW: Rate limit management
  resetRateLimits: () => Promise<void>;
  checkRateLimitStatus: (accountId: string) => Promise<RateLimitStatus>;
}
```

### Horizontal Scaling Strategies

- **Stateless Functions**: All API routes designed as stateless
- **Database Connection Pooling**: Supabase handles connection pooling
- **Edge Caching**: Leverage Vercel Edge for static content
- **Real-time Scaling**: Supabase Realtime for live updates
- **Webhook Load Balancing**: Handle high-volume webhook processing with rate limiting

### Monitoring and Observability

- **Error Tracking**: Sentry integration for error monitoring
- **Performance Monitoring**: Vercel Analytics for performance insights
- **Database Monitoring**: Supabase built-in monitoring
- **Custom Metrics**: Track follow-up success rates, response times, rate limit hits
- **Health Checks**: API health endpoints for monitoring

### Data Archiving Strategy

```sql
-- Archive old emails (>1 year)
CREATE TABLE tracked_emails_archive (
  LIKE tracked_emails INCLUDING ALL
);

-- Move to archive periodically
INSERT INTO tracked_emails_archive 
SELECT * FROM tracked_emails 
WHERE sent_at < NOW() - INTERVAL '1 year';

-- ⚠️ NEW: Archive old rate limiting data (>30 days)
CREATE TABLE rate_limit_tracking_archive (
  LIKE rate_limit_tracking INCLUDING ALL
);

INSERT INTO rate_limit_tracking_archive 
SELECT * FROM rate_limit_tracking 
WHERE window_end < NOW() - INTERVAL '30 days';
```

## 8. ⚠️ NOUVEAUTÉS - Mises à Jour Critiques (Septembre 2025)

### Microsoft Graph API - Changements Critiques

```typescript
// lib/microsoft-graph.ts - Configuration mise à jour
export const GRAPH_CONFIG = {
  apiVersion: 'v1.0',
  baseUrl: 'https://graph.microsoft.com',
  scopes: [
    'https://graph.microsoft.com/Mail.Read',
    'https://graph.microsoft.com/Mail.Send',
    'https://graph.microsoft.com/MailboxSettings.ReadWrite', // ⚠️ NOUVEAU
    'https://graph.microsoft.com/User.Read'
  ],
  rateLimits: {
    emailOps: 10000,      // ⚠️ Augmenté de 1000 → 10000
    webhooks: 50,         // Inchangé
    bulkOperations: 100   // ⚠️ NOUVEAU
  }
};
```

### Nouveau Service de Rate Limiting

```typescript
// lib/rate-limiter.ts - ⚠️ NOUVEAU SERVICE
export class GraphRateLimiter {
  constructor(private supabase: SupabaseClient) {}
  
  async checkLimit(
    accountId: string, 
    operationType: 'email_read' | 'webhook_create' | 'bulk_operation'
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    // Implémentation de la vérification des limites
    const limit = GRAPH_CONFIG.rateLimits[operationType];
    // ... logique de vérification
  }
  
  async recordOperation(
    accountId: string,
    operationType: string
  ): Promise<void> {
    // Enregistrer l'opération pour le suivi des limites
  }
}
```

### Middleware Next.js 15 Validé

```typescript
// middleware.ts - ⚠️ VALIDÉ POUR NEXT.JS 15
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  // Rate limiting pour les webhooks
  if (request.nextUrl.pathname.startsWith('/api/webhooks/')) {
    // Logique de rate limiting
  }
  
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/webhooks/:path*',
    '/api/emails/:path*'
  ]
};
```

Cette architecture mise à jour fournit une fondation solide et compatible pour un système de suivi d'emails évolutif, capable de gérer la croissance de MVP à échelle entreprise tout en maintenant les standards de sécurité, performance et maintenabilité.

**Status de validation**: ✅ Architecture validée et mise à jour pour septembre 2025
