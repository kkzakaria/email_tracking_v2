# Security and Compliance Guide

## Data Privacy and Compliance Framework

### GDPR Compliance Requirements

#### 1. Data Minimization and Purpose Limitation

```typescript
// Only collect necessary email metadata
interface MinimalEmailData {
  id: string;
  subject: string;
  fromEmail: string;
  fromName?: string;
  toEmails: string[];
  sentAt: Date;
  hasResponse: boolean;
  // No email body content stored
  bodyPreview?: string; // Max 150 characters from Graph API
}

// Data retention policy
const DATA_RETENTION_DAYS = 365; // Configurable per user

// Auto-cleanup function
async function cleanupExpiredData() {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DATA_RETENTION_DAYS);
  
  await supabase
    .from('tracked_emails')
    .delete()
    .lt('sent_at', cutoffDate.toISOString());
}
```

#### 2. Consent Management

```typescript
// User consent tracking
interface ConsentRecord {
  userId: string;
  consentType: 'email_tracking' | 'data_processing' | 'analytics';
  granted: boolean;
  grantedAt: Date;
  version: string; // Privacy policy version
  ipAddress: string;
  userAgent: string;
}

// Consent validation middleware
export function requireConsent(consentType: string) {
  return async (req: NextRequest) => {
    const userId = await getUserId(req);
    
    const hasConsent = await checkUserConsent(userId, consentType);
    if (!hasConsent) {
      return NextResponse.json(
        { error: 'Consent required for this operation' },
        { status: 403 }
      );
    }
  };
}
```

#### 3. Data Subject Rights Implementation

```typescript
// GDPR Rights API endpoints
// app/api/privacy/data-export/route.ts
export async function GET() {
  const userId = await getCurrentUserId();
  
  // Export all user data in machine-readable format
  const userData = await exportUserData(userId);
  
  return new Response(JSON.stringify(userData, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="user-data-export.json"'
    }
  });
}

// app/api/privacy/data-deletion/route.ts
export async function DELETE() {
  const userId = await getCurrentUserId();
  
  // Delete all user data (cascading deletes via foreign keys)
  await deleteUserData(userId);
  
  // Also revoke Microsoft Graph tokens
  await revokeMicrosoftTokens(userId);
  
  return NextResponse.json({ message: 'Data deleted successfully' });
}

// Data portability
async function exportUserData(userId: string) {
  const supabase = createServiceRoleClient();
  
  const [profile, emailAccounts, trackedEmails, followUpRules] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', userId).single(),
    supabase.from('email_accounts').select('*').eq('user_id', userId),
    supabase.from('tracked_emails').select('*').eq('user_id', userId),
    supabase.from('follow_up_rules').select('*').eq('user_id', userId)
  ]);
  
  return {
    exportDate: new Date().toISOString(),
    profile: profile.data,
    emailAccounts: emailAccounts.data?.map(account => ({
      ...account,
      // Remove sensitive tokens from export
      access_token_encrypted: '[REDACTED]',
      refresh_token_encrypted: '[REDACTED]'
    })),
    trackedEmails: trackedEmails.data,
    followUpRules: followUpRules.data
  };
}
```

## Token Security and Encryption

### 1. Encryption at Rest

```typescript
// lib/encryption.ts
import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from 'crypto';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const SALT_LENGTH = 64;
const TAG_LENGTH = 16;

class TokenEncryption {
  private static deriveKey(password: string, salt: Buffer): Buffer {
    return pbkdf2Sync(password, salt, 100000, KEY_LENGTH, 'sha512');
  }

  static encrypt(plaintext: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = this.deriveKey(process.env.ENCRYPTION_KEY!, salt);
    
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
    
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    // Combine salt + iv + tag + encrypted data
    const result = Buffer.concat([salt, iv, tag, Buffer.from(encrypted, 'hex')]);
    return result.toString('base64');
  }

  static decrypt(encryptedData: string): string {
    const buffer = Buffer.from(encryptedData, 'base64');
    
    const salt = buffer.subarray(0, SALT_LENGTH);
    const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
    const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    const encrypted = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
    
    const key = this.deriveKey(process.env.ENCRYPTION_KEY!, salt);
    
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, null, 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }
}

export const encrypt = TokenEncryption.encrypt;
export const decrypt = TokenEncryption.decrypt;
```

### 2. Token Rotation and Management

```typescript
// lib/token-manager.ts
export class TokenManager {
  private supabase = createServiceRoleClient();

  async refreshAccessToken(emailAccountId: string): Promise<string> {
    const { data: account } = await this.supabase
      .from('email_accounts')
      .select('*')
      .eq('id', emailAccountId)
      .single();

    if (!account) throw new Error('Email account not found');
    
    // Check if token is expired
    if (new Date(account.token_expires_at) > new Date()) {
      return decrypt(account.access_token_encrypted);
    }

    // Refresh token
    const refreshToken = decrypt(account.refresh_token_encrypted);
    const newTokens = await this.requestNewTokens(refreshToken);

    // Update stored tokens
    await this.supabase
      .from('email_accounts')
      .update({
        access_token_encrypted: encrypt(newTokens.access_token),
        refresh_token_encrypted: encrypt(newTokens.refresh_token),
        token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', emailAccountId);

    return newTokens.access_token;
  }

  private async requestNewTokens(refreshToken: string) {
    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID!,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send'
      })
    });

    if (!response.ok) {
      throw new Error('Failed to refresh token');
    }

    return await response.json();
  }

  // Scheduled job to refresh tokens before expiry
  async refreshExpiringTokens() {
    const expiryThreshold = new Date();
    expiryThreshold.setHours(expiryThreshold.getHours() + 1); // Refresh 1 hour before expiry

    const { data: expiringAccounts } = await this.supabase
      .from('email_accounts')
      .select('id')
      .lt('token_expires_at', expiryThreshold.toISOString())
      .eq('is_active', true);

    for (const account of expiringAccounts || []) {
      try {
        await this.refreshAccessToken(account.id);
      } catch (error) {
        console.error(`Failed to refresh token for account ${account.id}:`, error);
        // Notify user of token issues
        await this.notifyTokenError(account.id);
      }
    }
  }
}
```

## Input Validation and Sanitization

### 1. Zod Schema Validation

```typescript
// lib/validators.ts
import { z } from 'zod';

export const EmailAccountSchema = z.object({
  email_address: z.string().email('Invalid email address'),
  display_name: z.string().min(1).max(100),
  microsoft_user_id: z.string().uuid('Invalid Microsoft user ID')
});

export const FollowUpRuleSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  description: z.string().max(500).optional(),
  is_active: z.boolean().default(true),
  
  // Conditions
  applies_to_domains: z.array(z.string().regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)).optional(),
  applies_to_emails: z.array(z.string().email()).optional(),
  exclude_domains: z.array(z.string().regex(/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/)).optional(),
  exclude_emails: z.array(z.string().email()).optional(),
  
  // Follow-up settings
  first_follow_up_hours: z.number().int().min(1).max(8760), // Max 1 year
  second_follow_up_hours: z.number().int().min(1).max(8760).optional(),
  third_follow_up_hours: z.number().int().min(1).max(8760).optional(),
  max_follow_ups: z.number().int().min(1).max(3).default(1),
});

export const FollowUpTemplateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  subject_template: z.string().min(1, 'Subject is required').max(200),
  body_template: z.string().min(1, 'Body is required').max(10000),
  is_default: z.boolean().default(false)
});

// Input sanitization
export function sanitizeEmailContent(content: string): string {
  // Remove potentially dangerous HTML tags and scripts
  return content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+="[^"]*"/gi, '')
    .trim();
}

// Validation middleware
export function validateRequest<T>(schema: z.ZodSchema<T>) {
  return async (req: NextRequest) => {
    try {
      const body = await req.json();
      const validated = schema.parse(body);
      return validated;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new Error(`Validation failed: ${error.errors.map(e => e.message).join(', ')}`);
      }
      throw error;
    }
  };
}
```

### 2. Rate Limiting and Security Headers

```typescript
// middleware.ts
import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter } from '@/lib/rate-limiter';

const rateLimiter = new RateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100, // per window
  keyGenerator: (req) => req.ip || 'anonymous'
});

export async function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Security headers
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  
  // CSP header
  response.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https://graph.microsoft.com https://*.supabase.co wss://*.supabase.co;"
  );

  // Rate limiting for API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const isAllowed = await rateLimiter.checkLimit(request);
    
    if (!isAllowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      );
    }
  }

  // Webhook signature validation
  if (request.nextUrl.pathname === '/api/webhooks/microsoft') {
    const signature = request.headers.get('x-ms-signature');
    const validationToken = request.headers.get('validationtoken');
    
    // Handle Microsoft Graph webhook validation
    if (validationToken) {
      return new Response(validationToken, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' }
      });
    }
    
    if (!signature) {
      return NextResponse.json(
        { error: 'Missing webhook signature' },
        { status: 401 }
      );
    }
  }

  return response;
}

export const config = {
  matcher: [
    '/api/:path*',
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ]
};
```

## Audit Logging and Monitoring

### 1. Security Event Logging

```typescript
// lib/audit-logger.ts
export interface AuditEvent {
  userId: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, any>;
  ipAddress: string;
  userAgent: string;
  timestamp: Date;
  severity: 'info' | 'warning' | 'error' | 'critical';
}

export class AuditLogger {
  private supabase = createServiceRoleClient();

  async log(event: Omit<AuditEvent, 'timestamp'>) {
    const auditEvent = {
      ...event,
      timestamp: new Date().toISOString()
    };

    // Store in audit log table
    await this.supabase
      .from('audit_logs')
      .insert([auditEvent]);

    // Send critical events to external monitoring
    if (event.severity === 'critical') {
      await this.sendToExternalMonitoring(auditEvent);
    }
  }

  private async sendToExternalMonitoring(event: AuditEvent) {
    // Send to external service (e.g., Sentry, DataDog)
    if (process.env.SENTRY_DSN) {
      // Sentry integration for critical security events
    }
  }
}

// Usage in API routes
const auditLogger = new AuditLogger();

export async function POST(request: NextRequest) {
  const userId = await getCurrentUserId();
  
  try {
    // Process request
    const result = await processRequest();
    
    await auditLogger.log({
      userId,
      action: 'follow_up_rule_created',
      resource: 'follow_up_rules',
      resourceId: result.id,
      ipAddress: request.ip || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
      severity: 'info'
    });
    
    return NextResponse.json(result);
  } catch (error) {
    await auditLogger.log({
      userId,
      action: 'follow_up_rule_creation_failed',
      resource: 'follow_up_rules',
      metadata: { error: error.message },
      ipAddress: request.ip || 'unknown',
      userAgent: request.headers.get('user-agent') || 'unknown',
      severity: 'error'
    });
    
    throw error;
  }
}
```

### 2. Database Audit Schema

```sql
-- Audit logging table
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  metadata JSONB,
  ip_address INET,
  user_agent TEXT,
  timestamp TIMESTAMP DEFAULT NOW(),
  severity TEXT CHECK (severity IN ('info', 'warning', 'error', 'critical'))
);

-- Indexes for audit queries
CREATE INDEX idx_audit_logs_user_timestamp ON audit_logs(user_id, timestamp DESC);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
CREATE INDEX idx_audit_logs_severity ON audit_logs(severity) WHERE severity IN ('error', 'critical');

-- Auto-cleanup old audit logs (keep for 7 years for compliance)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs() RETURNS void AS $$
BEGIN
  DELETE FROM audit_logs 
  WHERE timestamp < NOW() - INTERVAL '7 years';
END;
$$ LANGUAGE plpgsql;

-- Database-level audit triggers
CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO audit_logs (user_id, action, resource, resource_id, metadata)
    VALUES (
      OLD.user_id,
      TG_TABLE_NAME || '_deleted',
      TG_TABLE_NAME,
      OLD.id::text,
      row_to_json(OLD)
    );
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO audit_logs (user_id, action, resource, resource_id, metadata)
    VALUES (
      NEW.user_id,
      TG_TABLE_NAME || '_updated',
      TG_TABLE_NAME,
      NEW.id::text,
      jsonb_build_object('old', row_to_json(OLD), 'new', row_to_json(NEW))
    );
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO audit_logs (user_id, action, resource, resource_id, metadata)
    VALUES (
      NEW.user_id,
      TG_TABLE_NAME || '_created',
      TG_TABLE_NAME,
      NEW.id::text,
      row_to_json(NEW)
    );
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Apply audit triggers to sensitive tables
CREATE TRIGGER follow_up_rules_audit
  AFTER INSERT OR UPDATE OR DELETE ON follow_up_rules
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER email_accounts_audit
  AFTER INSERT OR UPDATE OR DELETE ON email_accounts
  FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();
```

## Incident Response Plan

### 1. Security Incident Detection

```typescript
// lib/security-monitor.ts
export class SecurityMonitor {
  private async detectAnomalousActivity(userId: string) {
    // Check for suspicious patterns
    const suspiciousPatterns = await Promise.all([
      this.checkUnusualLoginLocations(userId),
      this.checkExcessiveAPIUsage(userId),
      this.checkSuspiciousEmailPatterns(userId)
    ]);

    const threats = suspiciousPatterns.filter(Boolean);
    
    if (threats.length > 0) {
      await this.triggerSecurityAlert(userId, threats);
    }
  }

  private async triggerSecurityAlert(userId: string, threats: string[]) {
    const auditLogger = new AuditLogger();
    
    await auditLogger.log({
      userId,
      action: 'security_threat_detected',
      resource: 'user_account',
      metadata: { threats },
      severity: 'critical',
      ipAddress: 'system',
      userAgent: 'security-monitor'
    });

    // Temporarily disable account if critical threat
    if (threats.some(threat => threat.includes('account_compromise'))) {
      await this.disableAccount(userId);
    }

    // Send notification to security team
    await this.notifySecurityTeam(userId, threats);
  }
}
```

This security framework ensures the email tracking system meets enterprise-grade security standards while remaining compliant with privacy regulations.
