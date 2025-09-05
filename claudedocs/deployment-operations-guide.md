# Deployment and Operations Guide

## Pre-Deployment Checklist

### Environment Setup

#### 1. Supabase Configuration

```bash
# Local development setup
supabase start
supabase db reset
supabase gen types typescript --local > types/database.ts

# Production setup
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set ENCRYPTION_KEY="your-encryption-key"
```

#### 2. Microsoft Graph API Setup

- Register application in Azure AD
- Configure OAuth2 redirect URIs
- Set required permissions:
  - `Mail.Read` (Read user mail)
  - `Mail.Send` (Send mail as user)
  - `User.Read` (Read user profile)

#### 3. Environment Variables

```bash
# .env.local (development)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

MICROSOFT_CLIENT_ID=your-azure-app-id
MICROSOFT_CLIENT_SECRET=your-azure-app-secret
MICROSOFT_REDIRECT_URI=http://localhost:3000/api/auth/microsoft/callback

ENCRYPTION_KEY=your-32-char-encryption-key
WEBHOOK_SECRET=your-webhook-validation-secret

# .env.production (via Vercel dashboard)
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-prod-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-prod-service-role-key

MICROSOFT_CLIENT_ID=your-prod-azure-app-id
MICROSOFT_CLIENT_SECRET=your-prod-azure-app-secret
MICROSOFT_REDIRECT_URI=https://your-domain.com/api/auth/microsoft/callback
```

### Security Validation

#### 1. Security Headers Check

```typescript
// Test security headers
const securityHeaders = [
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'X-XSS-Protection',
  'Content-Security-Policy'
];

async function validateSecurityHeaders(url: string) {
  const response = await fetch(url);
  const missingHeaders = securityHeaders.filter(
    header => !response.headers.get(header.toLowerCase())
  );
  
  if (missingHeaders.length > 0) {
    throw new Error(`Missing security headers: ${missingHeaders.join(', ')}`);
  }
}
```

#### 2. RLS Policy Verification

```sql
-- Test RLS policies
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual
FROM pg_policies 
WHERE schemaname = 'public';

-- Verify no data leakage between users
SET ROLE authenticated;
SET request.jwt.claims TO '{"sub": "test-user-id"}';
SELECT * FROM tracked_emails; -- Should only return test user's data
```

## Deployment Pipeline

### 1. Automated Deployment (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: 'pnpm'
      
      - run: pnpm install
      - run: pnpm run lint
      - run: pnpm run type-check
      - run: pnpm run test
      
      # Security scanning
      - run: pnpm audit
      - uses: github/codeql-action/analyze@v2

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    
    steps:
      - uses: actions/checkout@v4
      - uses: vercel/action@v1
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'

  database-migration:
    needs: deploy
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: |
          supabase db push --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}

  smoke-tests:
    needs: [deploy, database-migration]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install
      - run: pnpm run test:e2e
        env:
          TEST_URL: https://your-domain.com
```

### 2. Database Migration Strategy

```sql
-- Migration versioning system
CREATE TABLE IF NOT EXISTS migration_history (
  version INTEGER PRIMARY KEY,
  description TEXT NOT NULL,
  applied_at TIMESTAMP DEFAULT NOW(),
  applied_by TEXT DEFAULT current_user
);

-- Example migration: Add email analytics table
-- migrations/003_add_email_analytics.sql
INSERT INTO migration_history (version, description) 
VALUES (3, 'Add email analytics materialized view');

CREATE MATERIALIZED VIEW email_analytics AS
SELECT 
  DATE_TRUNC('day', sent_at) as date,
  email_account_id,
  COUNT(*) as total_emails,
  COUNT(*) FILTER (WHERE has_response = true) as emails_with_response,
  AVG(response_count) as avg_response_count
FROM tracked_emails
WHERE sent_at >= NOW() - INTERVAL '90 days'
GROUP BY DATE_TRUNC('day', sent_at), email_account_id
ORDER BY date DESC;

CREATE UNIQUE INDEX idx_email_analytics_date_account 
ON email_analytics (date, email_account_id);
```

### 3. Health Checks and Monitoring

```typescript
// app/api/health/route.ts
export async function GET() {
  const checks = await Promise.allSettled([
    checkDatabase(),
    checkMicrosoftGraphAPI(),
    checkWebhookEndpoint(),
    checkCronJobs()
  ]);

  const results = checks.map((check, index) => ({
    service: ['database', 'microsoft-graph', 'webhooks', 'cron-jobs'][index],
    status: check.status === 'fulfilled' ? 'healthy' : 'unhealthy',
    details: check.status === 'rejected' ? check.reason?.message : 'OK'
  }));

  const allHealthy = results.every(r => r.status === 'healthy');

  return NextResponse.json(
    { status: allHealthy ? 'healthy' : 'degraded', checks: results },
    { status: allHealthy ? 200 : 503 }
  );
}

async function checkDatabase() {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from('profiles').select('count').limit(1);
  if (error) throw error;
}

async function checkMicrosoftGraphAPI() {
  const response = await fetch('https://graph.microsoft.com/v1.0/$metadata');
  if (!response.ok) throw new Error('Microsoft Graph API unavailable');
}

async function checkWebhookEndpoint() {
  const response = await fetch(`${process.env.VERCEL_URL}/api/webhooks/health`);
  if (!response.ok) throw new Error('Webhook endpoint unavailable');
}

async function checkCronJobs() {
  // Check if cron jobs are running (check last execution timestamp)
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from('cron_job_logs')
    .select('*')
    .order('executed_at', { ascending: false })
    .limit(1);

  const lastRun = data?.[0]?.executed_at;
  if (!lastRun || new Date(lastRun) < new Date(Date.now() - 15 * 60 * 1000)) {
    throw new Error('Cron jobs not running');
  }
}
```

## Monitoring and Observability

### 1. Application Metrics

```typescript
// lib/metrics.ts
export class MetricsCollector {
  static async trackEmailProcessed(emailAccountId: string, processingTime: number) {
    // Send to external monitoring service
    await fetch('https://api.your-monitoring-service.com/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metric: 'email.processed',
        value: 1,
        tags: { account_id: emailAccountId },
        timestamp: Date.now()
      })
    });

    // Store in database for internal analytics
    const supabase = createServiceRoleClient();
    await supabase.from('performance_metrics').insert({
      metric_name: 'email_processing_time',
      metric_value: processingTime,
      metadata: { email_account_id: emailAccountId },
      recorded_at: new Date().toISOString()
    });
  }

  static async trackFollowUpSent(ruleId: string, success: boolean) {
    const metric = success ? 'follow_up.sent' : 'follow_up.failed';
    
    await fetch('https://api.your-monitoring-service.com/metrics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metric,
        value: 1,
        tags: { rule_id: ruleId },
        timestamp: Date.now()
      })
    });
  }
}

// Usage in API routes
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    const result = await processEmail();
    
    MetricsCollector.trackEmailProcessed(
      result.emailAccountId, 
      Date.now() - startTime
    );
    
    return NextResponse.json(result);
  } catch (error) {
    MetricsCollector.trackEmailProcessed(
      'unknown',
      Date.now() - startTime
    );
    throw error;
  }
}
```

### 2. Error Tracking with Sentry

```typescript
// lib/sentry.ts
import * as Sentry from '@sentry/nextjs';

export function initSentry() {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV,
    
    // Performance monitoring
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    
    // Session replay for debugging
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    
    // Custom error filtering
    beforeSend(event, hint) {
      // Don't send client-side validation errors
      if (event.exception?.values?.[0]?.type === 'ValidationError') {
        return null;
      }
      return event;
    },
    
    // Custom tags for better organization
    initialScope: {
      tags: {
        component: 'email-tracking',
        version: process.env.npm_package_version
      }
    }
  });
}

// Structured error context
export function captureEmailTrackingError(error: Error, context: {
  userId?: string;
  emailAccountId?: string;
  messageId?: string;
  operation: string;
}) {
  Sentry.withScope(scope => {
    scope.setTag('operation', context.operation);
    scope.setUser({ id: context.userId });
    scope.setContext('email_tracking', {
      emailAccountId: context.emailAccountId,
      messageId: context.messageId
    });
    
    Sentry.captureException(error);
  });
}
```

### 3. Performance Monitoring

```typescript
// lib/performance.ts
export class PerformanceMonitor {
  private static timers = new Map<string, number>();

  static startTimer(operationId: string): void {
    this.timers.set(operationId, performance.now());
  }

  static endTimer(operationId: string): number {
    const startTime = this.timers.get(operationId);
    if (!startTime) return 0;

    const duration = performance.now() - startTime;
    this.timers.delete(operationId);

    // Send to monitoring service
    this.recordMetric('operation_duration', duration, {
      operation: operationId
    });

    return duration;
  }

  private static async recordMetric(
    name: string, 
    value: number, 
    tags: Record<string, string>
  ) {
    // Send to external monitoring
    if (process.env.DATADOG_API_KEY) {
      await fetch('https://api.datadoghq.com/api/v1/series', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'DD-API-KEY': process.env.DATADOG_API_KEY!
        },
        body: JSON.stringify({
          series: [{
            metric: `email_tracking.${name}`,
            points: [[Math.floor(Date.now() / 1000), value]],
            tags: Object.entries(tags).map(([k, v]) => `${k}:${v}`)
          }]
        })
      });
    }
  }
}

// Usage in critical paths
export async function processWebhookNotification(notification: any) {
  const operationId = `webhook_${notification.subscriptionId}_${Date.now()}`;
  
  PerformanceMonitor.startTimer(operationId);
  
  try {
    await processNotification(notification);
  } finally {
    const duration = PerformanceMonitor.endTimer(operationId);
    
    if (duration > 5000) { // Alert on slow operations
      console.warn(`Slow webhook processing: ${duration}ms for ${operationId}`);
    }
  }
}
```

## Operational Procedures

### 1. Incident Response Playbook

#### Database Issues

```bash
# Check database health
curl -f https://your-domain.com/api/health

# Check slow queries
SELECT query, mean_exec_time, calls 
FROM pg_stat_statements 
ORDER BY mean_exec_time DESC 
LIMIT 10;

# Check active connections
SELECT count(*) FROM pg_stat_activity;

# Emergency: Scale database resources via Supabase dashboard
```

#### Microsoft Graph API Issues

```bash
# Check API status
curl -f https://graph.microsoft.com/v1.0/$metadata

# Verify webhook subscriptions
curl -H "Authorization: Bearer $ACCESS_TOKEN" \
     https://graph.microsoft.com/v1.0/subscriptions

# Emergency: Disable webhook processing
# Set environment variable DISABLE_WEBHOOKS=true
```

#### High Error Rate Response

```bash
# Check error distribution in logs
vercel logs --app your-app --since 1h | grep ERROR

# Check Sentry for error patterns
# Dashboard: https://sentry.io/your-org/your-project/

# Emergency: Enable maintenance mode
# Set environment variable MAINTENANCE_MODE=true
```

### 2. Backup and Recovery

```sql
-- Database backup strategy
-- Automated daily backups via Supabase
-- Point-in-time recovery available for 7 days

-- Manual backup before major changes
pg_dump --host=your-host \
        --username=postgres \
        --dbname=postgres \
        --no-password \
        --format=custom \
        --file=backup_$(date +%Y%m%d_%H%M%S).dump

-- Recovery test procedure
-- 1. Create test environment
-- 2. Restore backup
-- 3. Verify data integrity
-- 4. Test critical user flows
```

### 3. Scaling Procedures

#### Horizontal Scaling Triggers

- Response time > 2s (95th percentile)
- Error rate > 1%
- CPU usage > 80% sustained
- Database connection pool > 80% utilized

#### Scaling Actions

```bash
# Vercel: Automatic scaling for serverless functions
# Monitor via Vercel dashboard

# Database: Scale via Supabase dashboard
# Options: Micro -> Small -> Medium -> Large -> XL

# Caching: Implement Redis for frequent queries
# Add Redis instance via Upstash or similar
```

### 4. Regular Maintenance Tasks

#### Weekly

- Review error rates and performance metrics
- Check database query performance
- Update dependencies (automated via Dependabot)
- Review security alerts

#### Monthly

- Audit user permissions and access logs
- Review and update backup procedures
- Performance optimization review
- Security vulnerability assessment

#### Quarterly

- Disaster recovery testing
- Security penetration testing
- Database maintenance (VACUUM, reindex)
- Business continuity plan review

This operational guide ensures reliable deployment and ongoing maintenance of the email tracking system at scale.
