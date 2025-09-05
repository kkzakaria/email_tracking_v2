/**
 * Security Middleware - Next.js 15
 * Email Tracking System - Security Headers and Request Validation
 * Created: 2025-09-05 by security-engineer
 * 
 * ⚠️ CRITICAL: All requests pass through this middleware for security validation
 * Implements CSP, rate limiting, webhook validation, and security headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';

// Rate limiting store (in-memory for development, use Redis in production)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * Rate limiting configuration
 */
const RATE_LIMIT_CONFIG = {
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 100, // requests per window
  maxRequestsAuth: 200, // higher limit for authenticated routes
  maxRequestsWebhook: 50, // lower limit for webhooks
  skipSuccessfulRequests: false
};

/**
 * Security headers configuration
 */
const SECURITY_HEADERS = {
  // Prevent clickjacking
  'X-Frame-Options': 'DENY',
  
  // Prevent MIME sniffing
  'X-Content-Type-Options': 'nosniff',
  
  // XSS Protection (legacy, but still useful)
  'X-XSS-Protection': '1; mode=block',
  
  // Referrer Policy
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  
  // Permissions Policy (restrict features)
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  
  // Strict Transport Security (HTTPS only)
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
};

/**
 * Content Security Policy
 */
const CSP_DIRECTIVES = {
  'default-src': ["'self'"],
  'script-src': [
    "'self'",
    "'unsafe-inline'", // Next.js requires this for development
    "'unsafe-eval'",   // Required for Next.js hot reload
    'https://vercel.live'
  ],
  'style-src': [
    "'self'",
    "'unsafe-inline'", // Tailwind CSS requires this
    'https://fonts.googleapis.com'
  ],
  'font-src': [
    "'self'",
    'data:',
    'https://fonts.gstatic.com'
  ],
  'img-src': [
    "'self'",
    'data:',
    'https:',
    'blob:'
  ],
  'connect-src': [
    "'self'",
    'https://graph.microsoft.com',
    'https://login.microsoftonline.com',
    'https://*.supabase.co',
    'wss://*.supabase.co',
    'https://vercel.live'
  ],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'upgrade-insecure-requests': []
};

/**
 * Build CSP header value
 */
function buildCSP(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([directive, sources]) => {
      if (sources.length === 0) return directive;
      return `${directive} ${sources.join(' ')}`;
    })
    .join('; ');
}

/**
 * Generate rate limit key for request
 */
function getRateLimitKey(request: NextRequest): string {
  const ip = request.ip || 
    request.headers.get('x-forwarded-for')?.split(',')[0] || 
    request.headers.get('x-real-ip') || 
    'anonymous';
  
  const userAgent = request.headers.get('user-agent')?.substring(0, 50) || '';
  
  // Create a composite key for better rate limiting
  return createHash('sha256')
    .update(`${ip}:${userAgent}`)
    .digest('hex')
    .substring(0, 16);
}

/**
 * Check rate limit for request
 */
function checkRateLimit(request: NextRequest): boolean {
  const key = getRateLimitKey(request);
  const now = Date.now();
  const windowMs = RATE_LIMIT_CONFIG.windowMs;
  
  // Determine max requests based on route
  let maxRequests = RATE_LIMIT_CONFIG.maxRequests;
  if (request.nextUrl.pathname.startsWith('/api/auth/')) {
    maxRequests = RATE_LIMIT_CONFIG.maxRequestsAuth;
  } else if (request.nextUrl.pathname.startsWith('/api/webhooks/')) {
    maxRequests = RATE_LIMIT_CONFIG.maxRequestsWebhook;
  }
  
  const entry = rateLimitStore.get(key);
  
  if (!entry || now > entry.resetTime) {
    // First request in window or window expired
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + windowMs
    });
    return true;
  }
  
  if (entry.count >= maxRequests) {
    return false;
  }
  
  // Increment count
  entry.count++;
  return true;
}

/**
 * Validate webhook signature
 */
function validateWebhookSignature(request: NextRequest, body: string): boolean {
  const signature = request.headers.get('x-ms-signature');
  const webhookSecret = process.env.WEBHOOK_SECRET;
  
  if (!signature || !webhookSecret) {
    return false;
  }
  
  try {
    const expectedSignature = createHash('sha256')
      .update(body, 'utf8')
      .update(webhookSecret, 'utf8')
      .digest('hex');
    
    const receivedSignature = signature.replace('sha256=', '');
    
    return timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(receivedSignature, 'hex')
    );
  } catch (error) {
    console.error('Webhook signature validation error:', error);
    return false;
  }
}

/**
 * Security validation for requests
 */
function validateRequest(request: NextRequest): string | null {
  const userAgent = request.headers.get('user-agent');
  const origin = request.headers.get('origin');
  const referer = request.headers.get('referer');
  
  // Block requests without user agent (potential bots)
  if (!userAgent) {
    return 'Missing user agent';
  }
  
  // Block suspicious user agents
  const suspiciousUserAgents = [
    /sqlmap/i,
    /nmap/i,
    /nikto/i,
    /wget/i,
    /curl/i,
    /python-requests/i
  ];
  
  if (suspiciousUserAgents.some(pattern => pattern.test(userAgent))) {
    return 'Suspicious user agent detected';
  }
  
  // Validate origin for API requests
  if (request.nextUrl.pathname.startsWith('/api/') && 
      request.method !== 'GET' && 
      request.method !== 'OPTIONS') {
    
    const allowedOrigins = [
      process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,
      process.env.NEXT_PUBLIC_SITE_URL,
      'http://localhost:3000', // Development
      'https://localhost:3000'
    ].filter(Boolean);
    
    if (origin && !allowedOrigins.some(allowed => origin.startsWith(allowed as string))) {
      return 'Invalid origin';
    }
  }
  
  return null;
}

/**
 * Clean up expired rate limit entries
 */
function cleanupRateLimitStore(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Main middleware function
 */
export async function middleware(request: NextRequest) {
  try {
    // Clean up rate limit store periodically
    if (Math.random() < 0.01) { // 1% chance
      cleanupRateLimitStore();
    }
    
    // Security validation
    const securityError = validateRequest(request);
    if (securityError) {
      console.warn(`Security validation failed: ${securityError}`, {
        ip: request.ip,
        userAgent: request.headers.get('user-agent'),
        path: request.nextUrl.pathname
      });
      
      return NextResponse.json(
        { error: 'Request blocked for security reasons' },
        { status: 403 }
      );
    }
    
    // Rate limiting (skip for OPTIONS requests)
    if (request.method !== 'OPTIONS') {
      const rateLimitPassed = checkRateLimit(request);
      if (!rateLimitPassed) {
        const resetTime = rateLimitStore.get(getRateLimitKey(request))?.resetTime || Date.now();
        const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
        
        console.warn('Rate limit exceeded', {
          ip: request.ip,
          userAgent: request.headers.get('user-agent'),
          path: request.nextUrl.pathname
        });
        
        return NextResponse.json(
          { 
            error: 'Rate limit exceeded',
            retryAfter: retryAfter
          },
          { 
            status: 429,
            headers: {
              'Retry-After': retryAfter.toString(),
              'X-RateLimit-Limit': RATE_LIMIT_CONFIG.maxRequests.toString(),
              'X-RateLimit-Reset': (resetTime / 1000).toString()
            }
          }
        );
      }
    }
    
    // Microsoft Graph webhook validation
    if (request.nextUrl.pathname === '/api/webhooks/microsoft' && request.method === 'POST') {
      // Handle Microsoft Graph webhook validation token
      const validationToken = request.nextUrl.searchParams.get('validationToken');
      if (validationToken) {
        return new NextResponse(validationToken, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' }
        });
      }
      
      // Validate webhook signature
      try {
        const body = await request.text();
        const signatureValid = validateWebhookSignature(request, body);
        
        if (!signatureValid) {
          console.warn('Invalid webhook signature', {
            signature: request.headers.get('x-ms-signature'),
            path: request.nextUrl.pathname
          });
          
          return NextResponse.json(
            { error: 'Invalid webhook signature' },
            { status: 401 }
          );
        }
        
        // Re-create request with body for the API route
        const newRequest = new NextRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body: body
        });
        
        return NextResponse.next({
          request: newRequest
        });
        
      } catch (error) {
        console.error('Webhook validation error:', error);
        return NextResponse.json(
          { error: 'Webhook validation failed' },
          { status: 400 }
        );
      }
    }
    
    // Create response
    const response = NextResponse.next();
    
    // Apply security headers
    Object.entries(SECURITY_HEADERS).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    
    // Apply CSP header
    response.headers.set('Content-Security-Policy', buildCSP());
    
    // Add rate limit headers
    const rateLimitKey = getRateLimitKey(request);
    const rateLimitEntry = rateLimitStore.get(rateLimitKey);
    if (rateLimitEntry) {
      response.headers.set('X-RateLimit-Limit', RATE_LIMIT_CONFIG.maxRequests.toString());
      response.headers.set('X-RateLimit-Remaining', (RATE_LIMIT_CONFIG.maxRequests - rateLimitEntry.count).toString());
      response.headers.set('X-RateLimit-Reset', (rateLimitEntry.resetTime / 1000).toString());
    }
    
    // HSTS only in production
    if (process.env.NODE_ENV === 'production') {
      response.headers.set('Strict-Transport-Security', SECURITY_HEADERS['Strict-Transport-Security']);
    }
    
    return response;
    
  } catch (error) {
    console.error('Middleware error:', error);
    
    // Return a safe error response
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * Middleware configuration
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes are handled separately)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ]
};