/**
 * Microsoft Graph Webhook Endpoint
 * Email Tracking System - Phase 2 Critical Webhook Infrastructure
 * Created: 2025-09-05 for Microsoft Graph webhook processing
 * 
 * ⚠️ CRITICAL: This endpoint handles all Microsoft Graph webhook notifications
 * Must respond within 30 seconds to avoid Microsoft timeouts
 * Integrates with rate limiting, audit logging, and queue processing
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { rateLimiter } from '@/lib/rate-limiter';
import { auditLogger } from '@/lib/audit-logger';
import { webhookProcessor } from '@/lib/webhook-processor';
import { 
  MicrosoftGraphWebhookPayload, 
  MicrosoftGraphNotification,
  WebhookValidationError 
} from '@/types/microsoft-graph-webhooks';

// ============================================================================
// WEBHOOK VALIDATION UTILITIES
// ============================================================================

/**
 * Validate Microsoft Graph webhook signature
 * @param payload - Raw webhook payload
 * @param signature - Microsoft signature header
 * @param secret - Webhook secret for validation
 * @returns boolean - True if signature is valid
 */
function validateWebhookSignature(
  payload: string, 
  signature: string, 
  secret: string
): boolean {
  try {
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload, 'utf8')
      .digest('hex');
    
    const providedSignature = signature.replace('sha256=', '');
    
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(providedSignature, 'hex')
    );
  } catch (error) {
    console.error('Signature validation failed:', error);
    return false;
  }
}

/**
 * Validate Microsoft Graph notification structure
 * @param notification - Individual notification object
 * @returns ValidationResult - Validation status and errors
 */
function validateNotificationStructure(notification: MicrosoftGraphNotification): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!notification.subscriptionId) {
    errors.push('Missing subscriptionId');
  }

  if (!notification.changeType) {
    errors.push('Missing changeType');
  }

  if (!notification.resource) {
    errors.push('Missing resource');
  }

  if (!notification.tenantId) {
    errors.push('Missing tenantId');
  }

  // Validate subscription expiration format
  if (notification.subscriptionExpirationDateTime) {
    const expiration = new Date(notification.subscriptionExpirationDateTime);
    if (isNaN(expiration.getTime())) {
      errors.push('Invalid subscriptionExpirationDateTime format');
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Handle Microsoft Graph validation token challenge
 * @param validationToken - Token sent by Microsoft for initial validation
 * @returns Response with validation token or error
 */
function handleValidationChallenge(validationToken: string): NextResponse {
  const expectedToken = process.env.WEBHOOK_VALIDATION_TOKEN;
  
  if (!expectedToken) {
    console.error('WEBHOOK_VALIDATION_TOKEN not configured');
    return NextResponse.json(
      { error: 'Webhook validation not configured' },
      { status: 500 }
    );
  }

  if (validationToken === expectedToken) {
    // Microsoft expects the validation token to be returned in response body
    return new NextResponse(validationToken, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain',
      },
    });
  }

  return NextResponse.json(
    { error: 'Invalid validation token' },
    { status: 403 }
  );
}

// ============================================================================
// MAIN WEBHOOK HANDLERS
// ============================================================================

/**
 * GET Handler - Microsoft Graph Validation Challenge
 * Microsoft sends GET request with validationToken query parameter
 * during subscription creation to validate the endpoint
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const searchParams = request.nextUrl.searchParams;
  const validationToken = searchParams.get('validationToken');

  try {
    // Log validation attempt
    await auditLogger.logEvent(
      'webhook_validation_attempt',
      'high',
      {
        endpoint: '/api/webhooks/microsoft',
        method: 'GET',
        has_validation_token: !!validationToken,
        timestamp: new Date().toISOString(),
      }
    );

    if (!validationToken) {
      return NextResponse.json(
        { error: 'Missing validationToken parameter' },
        { status: 400 }
      );
    }

    const response = handleValidationChallenge(validationToken);
    
    // Log successful validation
    if (response.status === 200) {
      await auditLogger.logEvent(
        'webhook_validation_success',
        'medium',
        {
          validation_token_valid: true,
          response_time_ms: Date.now() - startTime,
        }
      );
    }

    return response;

  } catch (error) {
    console.error('Webhook validation failed:', error);
    
    await auditLogger.logEvent(
      'webhook_validation_failed',
      'critical',
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        response_time_ms: Date.now() - startTime,
      }
    );

    return NextResponse.json(
      { error: 'Validation failed' },
      { status: 500 }
    );
  }
}

/**
 * POST Handler - Microsoft Graph Webhook Notifications
 * Receives and processes webhook notifications from Microsoft Graph
 * Must respond within 30 seconds to avoid timeouts
 */
export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const clientIP = request.headers.get('x-forwarded-for') || 'unknown';

  try {
    // Rate limiting check
    const rateLimitResult = await rateLimiter.checkAndRecord('webhook_endpoint', 'webhook_create');
    
    if (!rateLimitResult.allowed) {
      await auditLogger.logEvent(
        'webhook_rate_limited',
        'high',
        {
          client_ip: clientIP,
          rate_limit_exceeded: true,
          current_count: rateLimitResult.current_count,
          limit: rateLimitResult.limit,
        }
      );

      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      );
    }

    // Read and validate request body
    const rawPayload = await request.text();
    
    if (!rawPayload) {
      throw new WebhookValidationError('Empty webhook payload', ['Empty request body']);
    }

    let webhookPayload: MicrosoftGraphWebhookPayload;
    
    try {
      webhookPayload = JSON.parse(rawPayload);
    } catch (error) {
      throw new WebhookValidationError('Invalid JSON payload', ['Malformed JSON']);
    }

    // Validate webhook signature (if configured)
    const webhookSecret = process.env.WEBHOOK_SECRET;
    const signature = request.headers.get('x-ms-signature-sha256');
    
    if (webhookSecret && signature) {
      const isSignatureValid = validateWebhookSignature(rawPayload, signature, webhookSecret);
      
      if (!isSignatureValid) {
        throw new WebhookValidationError(
          'Invalid webhook signature',
          ['Signature verification failed']
        );
      }
    } else if (process.env.NODE_ENV === 'production') {
      // In production, signature validation should be mandatory
      console.warn('⚠️ Webhook signature validation not configured for production');
    }

    // Validate payload structure
    if (!webhookPayload.value || !Array.isArray(webhookPayload.value)) {
      throw new WebhookValidationError(
        'Invalid webhook payload structure',
        ['Missing or invalid value array']
      );
    }

    // Process each notification in the payload
    const processingResults = [];
    const errors = [];

    for (let i = 0; i < webhookPayload.value.length; i++) {
      const notification = webhookPayload.value[i];
      
      try {
        // Validate individual notification structure
        const validationResult = validateNotificationStructure(notification);
        
        if (!validationResult.isValid) {
          errors.push({
            index: i,
            notification_id: notification.subscriptionId || 'unknown',
            errors: validationResult.errors,
          });
          continue;
        }

        // Add notification to processing queue
        await webhookProcessor.addJob(notification, notification.subscriptionId);
        
        processingResults.push({
          index: i,
          notification_id: notification.subscriptionId,
          status: 'queued',
        });

      } catch (error) {
        console.error(`Failed to process notification ${i}:`, error);
        errors.push({
          index: i,
          notification_id: notification.subscriptionId || 'unknown',
          error: error instanceof Error ? error.message : 'Processing failed',
        });
      }
    }

    const processingTime = Date.now() - startTime;

    // Log webhook processing result
    await auditLogger.logEvent(
      'webhook_notifications_received',
      errors.length > 0 ? 'high' : 'medium',
      {
        total_notifications: webhookPayload.value.length,
        successful_queued: processingResults.length,
        failed_validations: errors.length,
        processing_time_ms: processingTime,
        client_ip: clientIP,
        has_signature: !!signature,
        errors: errors.length > 0 ? errors : undefined,
      }
    );

    // Return appropriate response
    if (errors.length === 0) {
      return NextResponse.json({
        success: true,
        message: `${processingResults.length} notifications queued for processing`,
        processing_time_ms: processingTime,
      });
    } else {
      return NextResponse.json({
        success: processingResults.length > 0,
        message: `${processingResults.length} notifications queued, ${errors.length} failed validation`,
        processing_time_ms: processingTime,
        errors: errors,
      }, { status: 207 }); // 207 Multi-Status for partial success
    }

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    console.error('Webhook processing failed:', error);

    // Log critical webhook failure
    await auditLogger.logEvent(
      'webhook_processing_failed',
      'critical',
      {
        error: error instanceof Error ? error.message : 'Unknown error',
        error_type: error instanceof WebhookValidationError ? 'validation' : 'processing',
        processing_time_ms: processingTime,
        client_ip: clientIP,
        validation_errors: error instanceof WebhookValidationError ? error.validationErrors : undefined,
      }
    );

    // Return error response
    if (error instanceof WebhookValidationError) {
      return NextResponse.json({
        error: 'Webhook validation failed',
        details: error.validationErrors,
        processing_time_ms: processingTime,
      }, { status: 400 });
    }

    return NextResponse.json({
      error: 'Webhook processing failed',
      processing_time_ms: processingTime,
    }, { status: 500 });
  }
}

// ============================================================================
// HEALTH CHECK AND OPTIONS
// ============================================================================

/**
 * OPTIONS Handler - CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': process.env.CORS_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ms-signature-sha256',
      'Access-Control-Max-Age': '86400', // 24 hours
    },
  });
}