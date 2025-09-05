/**
 * Input Validation Schemas - Zod
 * Email Tracking System - Security Input Validation
 * Created: 2025-09-05 by security-engineer
 * 
 * ⚠️ CRITICAL: All API inputs must be validated through these schemas
 * Provides SQL injection, XSS, and data integrity protection
 */

import { z } from 'zod';

// ============================================================================
// COMMON VALIDATION SCHEMAS
// ============================================================================

/**
 * UUID validation
 */
export const UuidSchema = z.string().uuid('Invalid UUID format');

/**
 * Email validation with enhanced security
 */
export const EmailSchema = z
  .string()
  .min(5, 'Email too short')
  .max(320, 'Email too long') // RFC 5321 limit
  .email('Invalid email address')
  .transform((email) => email.toLowerCase().trim());

/**
 * Domain validation
 */
export const DomainSchema = z
  .string()
  .min(1)
  .max(253) // RFC 1035 limit
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/, 
    'Invalid domain format');

/**
 * Safe HTML content (removes dangerous tags)
 */
export const SafeHtmlSchema = z
  .string()
  .transform((content) => sanitizeHtmlContent(content));

/**
 * Safe text (no HTML allowed)
 */
export const SafeTextSchema = z
  .string()
  .transform((text) => sanitizeTextContent(text));

/**
 * Microsoft User ID validation
 */
export const MicrosoftUserIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, 
    'Invalid Microsoft User ID format');

// ============================================================================
// USER AND PROFILE SCHEMAS
// ============================================================================

/**
 * User profile creation/update
 */
export const ProfileSchema = z.object({
  email: EmailSchema,
  full_name: z.string().min(1).max(100).transform(sanitizeTextContent).optional().nullable(),
  company: z.string().min(1).max(100).transform(sanitizeTextContent).optional().nullable()
});

/**
 * User settings schema
 */
export const UserSettingsSchema = z.object({
  timezone: z.string().min(1).max(50),
  notification_preferences: z.object({
    email: z.boolean().default(true),
    in_app: z.boolean().default(true),
    follow_up_sent: z.boolean().default(true),
    response_received: z.boolean().default(true)
  }),
  tracking_preferences: z.object({
    auto_track: z.boolean().default(true),
    track_replies: z.boolean().default(true)
  })
});

// ============================================================================
// EMAIL ACCOUNT SCHEMAS
// ============================================================================

/**
 * Email account creation
 */
export const EmailAccountSchema = z.object({
  microsoft_user_id: MicrosoftUserIdSchema,
  email_address: EmailSchema,
  display_name: z.string().min(1).max(100).transform(sanitizeTextContent).optional().nullable()
});

/**
 * Email account update
 */
export const EmailAccountUpdateSchema = z.object({
  display_name: z.string().min(1).max(100).transform(sanitizeTextContent).optional().nullable(),
  is_active: z.boolean().optional()
});

// ============================================================================
// TRACKED EMAIL SCHEMAS  
// ============================================================================

/**
 * Tracked email creation
 */
export const TrackedEmailSchema = z.object({
  email_account_id: UuidSchema,
  message_id: z.string().min(1).max(255),
  conversation_id: z.string().min(1).max(255).optional().nullable(),
  thread_id: z.string().min(1).max(255).optional().nullable(),
  subject: z.string().min(1).max(255).transform(sanitizeTextContent),
  from_email: EmailSchema,
  from_name: z.string().max(100).transform(sanitizeTextContent).optional().nullable(),
  to_emails: z.array(EmailSchema).min(1).max(50),
  cc_emails: z.array(EmailSchema).max(50).optional().nullable(),
  bcc_emails: z.array(EmailSchema).max(50).optional().nullable(),
  body_preview: z.string().max(500).transform(sanitizeTextContent).optional().nullable(),
  sent_at: z.string().datetime(),
  has_response: z.boolean().default(false),
  last_response_at: z.string().datetime().optional().nullable(),
  response_count: z.number().int().min(0).max(999).default(0),
  tracking_status: z.enum(['active', 'paused', 'completed', 'failed'] as const).default('active'),
  follow_up_rule_id: UuidSchema.optional().nullable()
});

/**
 * Tracked email update
 */
export const TrackedEmailUpdateSchema = z.object({
  subject: z.string().min(1).max(255).transform(sanitizeTextContent).optional(),
  tracking_status: z.enum(['active', 'paused', 'completed', 'failed'] as const).optional(),
  follow_up_rule_id: UuidSchema.optional().nullable()
});

// ============================================================================
// FOLLOW-UP SCHEMAS
// ============================================================================

/**
 * Follow-up template schema
 */
export const FollowUpTemplateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).transform(sanitizeTextContent),
  subject_template: z.string().min(1, 'Subject template is required').max(300).transform(sanitizeTextContent),
  body_template: z.string().min(1, 'Body template is required').max(10000).transform(sanitizeHtmlContent),
  is_default: z.boolean().default(false)
});

/**
 * Follow-up template update
 */
export const FollowUpTemplateUpdateSchema = z.object({
  name: z.string().min(1).max(100).transform(sanitizeTextContent).optional(),
  subject_template: z.string().min(1).max(300).transform(sanitizeTextContent).optional(),
  body_template: z.string().min(1).max(10000).transform(sanitizeHtmlContent).optional(),
  is_default: z.boolean().optional()
});

/**
 * Follow-up rule schema
 */
export const FollowUpRuleSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100).transform(sanitizeTextContent),
  description: z.string().max(500).transform(sanitizeTextContent).optional().nullable(),
  is_active: z.boolean().default(true),
  
  // Targeting conditions
  applies_to_domains: z.array(DomainSchema).max(100).optional().nullable(),
  applies_to_emails: z.array(EmailSchema).max(100).optional().nullable(),
  exclude_domains: z.array(DomainSchema).max(100).optional().nullable(),
  exclude_emails: z.array(EmailSchema).max(100).optional().nullable(),
  
  // Importance and timing
  min_importance: z.enum(['low', 'normal', 'high'] as const).default('normal'),
  first_follow_up_hours: z.number().int().min(1, 'Must be at least 1 hour').max(8760, 'Max 1 year'), // Max 1 year
  second_follow_up_hours: z.number().int().min(1).max(8760).optional().nullable(),
  third_follow_up_hours: z.number().int().min(1).max(8760).optional().nullable(),
  max_follow_ups: z.number().int().min(1).max(3).default(1),
  
  // Template references
  first_template_id: UuidSchema.optional().nullable(),
  second_template_id: UuidSchema.optional().nullable(),
  third_template_id: UuidSchema.optional().nullable()
})
.refine((data) => {
  // Ensure follow-up hours are in ascending order
  if (data.second_follow_up_hours && data.first_follow_up_hours >= data.second_follow_up_hours) {
    return false;
  }
  if (data.third_follow_up_hours && data.second_follow_up_hours && data.second_follow_up_hours >= data.third_follow_up_hours) {
    return false;
  }
  return true;
}, 'Follow-up hours must be in ascending order')
.refine((data) => {
  // Ensure template IDs are provided for the number of follow-ups
  if (data.max_follow_ups >= 2 && !data.second_template_id) {
    return false;
  }
  if (data.max_follow_ups >= 3 && !data.third_template_id) {
    return false;
  }
  return true;
}, 'Template IDs must be provided for all configured follow-ups');

/**
 * Follow-up rule update
 */
export const FollowUpRuleUpdateSchema = FollowUpRuleSchema.partial();

// ============================================================================
// RATE LIMITING SCHEMAS
// ============================================================================

/**
 * Rate limit operation validation
 */
export const RateLimitOperationSchema = z.enum(['email_read', 'webhook_create', 'bulk_operation'] as const);

/**
 * Rate limit check request
 */
export const RateLimitCheckSchema = z.object({
  email_account_id: UuidSchema,
  operation_type: RateLimitOperationSchema
});

// ============================================================================
// NOTIFICATION SCHEMAS
// ============================================================================

/**
 * Notification creation
 */
export const NotificationSchema = z.object({
  type: z.enum([
    'response_received',
    'follow_up_sent', 
    'follow_up_failed',
    'webhook_error',
    'token_expired',
    'rate_limit_exceeded'
  ] as const),
  title: z.string().min(1).max(200).transform(sanitizeTextContent),
  message: z.string().min(1).max(1000).transform(sanitizeTextContent),
  metadata: z.record(z.unknown()).optional().nullable()
});

/**
 * Notification update
 */
export const NotificationUpdateSchema = z.object({
  is_read: z.boolean()
});

// ============================================================================
// WEBHOOK SCHEMAS
// ============================================================================

/**
 * Microsoft Graph webhook validation
 */
export const GraphWebhookSchema = z.object({
  value: z.array(z.object({
    subscriptionId: UuidSchema,
    changeType: z.string().min(1),
    resource: z.string().min(1),
    resourceData: z.record(z.unknown()).optional()
  }))
});

/**
 * Webhook subscription request
 */
export const WebhookSubscriptionSchema = z.object({
  email_account_id: UuidSchema,
  resource: z.string().min(1).max(200),
  change_types: z.array(z.string().min(1)).min(1).max(10),
  notification_url: z.string().url(),
  expires_at: z.string().datetime()
});

// ============================================================================
// API REQUEST SCHEMAS
// ============================================================================

/**
 * Pagination parameters
 */
export const PaginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

/**
 * Search and filtering
 */
export const EmailSearchSchema = z.object({
  query: z.string().max(200).transform(sanitizeTextContent).optional(),
  from_email: EmailSchema.optional(),
  to_email: EmailSchema.optional(),
  domain: DomainSchema.optional(),
  tracking_status: z.enum(['active', 'paused', 'completed', 'failed'] as const).optional(),
  has_response: z.boolean().optional(),
  date_from: z.string().datetime().optional(),
  date_to: z.string().datetime().optional()
});

// ============================================================================
// SECURITY VALIDATION FUNCTIONS
// ============================================================================

/**
 * Sanitize HTML content (remove dangerous tags and attributes)
 */
function sanitizeHtmlContent(content: string): string {
  if (!content) return content;

  return content
    // Remove script tags
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    // Remove iframe tags
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
    // Remove object/embed tags
    .replace(/<(object|embed)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, '')
    // Remove javascript: links
    .replace(/javascript:/gi, '')
    // Remove event handlers
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    // Remove data: URLs (potential XSS vector)
    .replace(/src\s*=\s*["']data:[^"']*["']/gi, '')
    .trim();
}

/**
 * Sanitize text content (remove all HTML)
 */
function sanitizeTextContent(content: string): string {
  if (!content) return content;

  return content
    // Remove all HTML tags
    .replace(/<[^>]*>/g, '')
    // Decode HTML entities
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .trim();
}

/**
 * Validation middleware factory
 */
export function createValidationMiddleware<T>(schema: z.ZodSchema<T>) {
  return (data: unknown): T => {
    try {
      return schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        throw new Error(`Validation failed: ${message}`);
      }
      throw error;
    }
  };
}

/**
 * Async validation middleware factory
 */
export function createAsyncValidationMiddleware<T>(schema: z.ZodSchema<T>) {
  return async (data: unknown): Promise<T> => {
    try {
      return await schema.parseAsync(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const message = error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        throw new Error(`Validation failed: ${message}`);
      }
      throw error;
    }
  };
}

// ============================================================================
// SECURITY HELPERS
// ============================================================================

/**
 * Check if string contains potential SQL injection patterns
 */
export function detectSqlInjection(input: string): boolean {
  const sqlPatterns = [
    /(\s|^)(union|select|insert|update|delete|drop|create|alter|exec|execute)\s/i,
    /(\'|(\\\')|(\%27)|(\\%27))/,
    /(\-\-)|(\%2D\%2D)/,
    /(\/\*)|(\%2F\%2A)/,
    /(\|\||&&)/
  ];

  return sqlPatterns.some(pattern => pattern.test(input));
}

/**
 * Check if string contains potential XSS patterns
 */
export function detectXss(input: string): boolean {
  const xssPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /javascript:/i,
    /on\w+\s*=\s*["'][^"']*["']/i,
    /src\s*=\s*["']data:/i,
    /<iframe/i,
    /<object/i,
    /<embed/i
  ];

  return xssPatterns.some(pattern => pattern.test(input));
}

/**
 * Security validation decorator
 */
export function securityValidate(input: string, fieldName: string): string {
  if (detectSqlInjection(input)) {
    throw new Error(`Potential SQL injection detected in ${fieldName}`);
  }

  if (detectXss(input)) {
    throw new Error(`Potential XSS attack detected in ${fieldName}`);
  }

  return input;
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  sanitizeHtmlContent,
  sanitizeTextContent
};