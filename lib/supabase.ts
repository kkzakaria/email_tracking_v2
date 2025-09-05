/**
 * Supabase Client Configuration
 * Email Tracking System - Backend Infrastructure
 * Created: 2025-09-05 by backend-architect
 * 
 * Configured for:
 * - Row Level Security (RLS)
 * - Real-time subscriptions
 * - Rate limiting integration
 * - Microsoft Graph API token management
 */

import { createClient } from '@supabase/supabase-js';
import { Database } from '../types/database';

// Environment variables validation
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error('Missing environment variable: NEXT_PUBLIC_SUPABASE_URL');
}

if (!supabaseAnonKey) {
  throw new Error('Missing environment variable: NEXT_PUBLIC_SUPABASE_ANON_KEY');
}

// Client-side Supabase client (for authenticated users)
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'pkce', // Use PKCE flow for security
  },
  realtime: {
    params: {
      eventsPerSecond: 10, // Rate limit realtime events
    },
  },
  db: {
    schema: 'public',
  },
  global: {
    headers: {
      'X-Client-Info': 'email-tracking-system@1.0.0',
    },
  },
});

// Server-side Supabase client (with service role privileges)
export const supabaseAdmin = supabaseServiceRoleKey 
  ? createClient<Database>(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
      db: {
        schema: 'public',
      },
      global: {
        headers: {
          'X-Client-Info': 'email-tracking-system-admin@1.0.0',
        },
      },
    })
  : null;

// ============================================================================
// AUTHENTICATION HELPERS
// ============================================================================

/**
 * Get current user session
 */
export async function getCurrentUser() {
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    return user;
  } catch (error) {
    console.error('Error getting current user:', error);
    return null;
  }
}

/**
 * Get user profile with settings
 */
export async function getUserProfile(userId?: string) {
  try {
    const user = userId || (await getCurrentUser())?.id;
    if (!user) return null;

    const { data: profile, error } = await supabase
      .from('profiles')
      .select(`
        *,
        user_settings(*)
      `)
      .eq('id', user)
      .single();

    if (error) throw error;
    return profile;
  } catch (error) {
    console.error('Error getting user profile:', error);
    return null;
  }
}

/**
 * Sign out user and clean up local state
 */
export async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    
    // Clear any local storage or cached data
    if (typeof window !== 'undefined') {
      localStorage.removeItem('email-tracking-cache');
    }
  } catch (error) {
    console.error('Error signing out:', error);
    throw error;
  }
}

// ============================================================================
// DATABASE HELPERS
// ============================================================================

/**
 * Create user profile after signup
 */
export async function createUserProfile(user: {
  id: string;
  email: string;
  user_metadata?: { full_name?: string; company?: string };
}) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        email: user.email,
        full_name: user.user_metadata?.full_name || null,
        company: user.user_metadata?.company || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Create default user settings
    await supabase
      .from('user_settings')
      .insert({
        user_id: user.id,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        notification_preferences: {
          email: true,
          in_app: true,
          follow_up_sent: true,
          response_received: true,
        },
        tracking_preferences: {
          auto_track: true,
          track_replies: true,
        },
      });

    return data;
  } catch (error) {
    console.error('Error creating user profile:', error);
    throw error;
  }
}

// ============================================================================
// RATE LIMITING HELPERS (Critical for Microsoft Graph API)
// ============================================================================

/**
 * Check rate limit for Microsoft Graph operations
 */
export async function checkRateLimit(
  emailAccountId: string,
  operationType: 'email_read' | 'webhook_create' | 'bulk_operation',
  limitCount = 10000,
  windowMinutes = 60
) {
  try {
    if (!supabaseAdmin) {
      throw new Error('Supabase admin client not available for rate limiting');
    }

    const { data, error } = await supabaseAdmin.rpc('check_rate_limit', {
      account_id: emailAccountId,
      operation_type: operationType,
      limit_count: limitCount,
      window_minutes: windowMinutes,
    });

    if (error) throw error;
    return data[0] || { allowed: false, current_count: 0, reset_time: new Date().toISOString() };
  } catch (error) {
    console.error('Error checking rate limit:', error);
    // Default to allowing operation if rate limit check fails
    return { allowed: true, current_count: 0, reset_time: new Date().toISOString() };
  }
}

/**
 * Record rate limit usage for Microsoft Graph operations
 */
export async function recordRateLimitUsage(
  emailAccountId: string,
  operationType: 'email_read' | 'webhook_create' | 'bulk_operation',
  windowMinutes = 60
) {
  try {
    if (!supabaseAdmin) {
      throw new Error('Supabase admin client not available for rate limiting');
    }

    const { data, error } = await supabaseAdmin.rpc('record_rate_limit_usage', {
      account_id: emailAccountId,
      operation_type: operationType,
      window_minutes: windowMinutes,
    });

    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error recording rate limit usage:', error);
    // Log the error but don't fail the operation
    return false;
  }
}

// ============================================================================
// REAL-TIME SUBSCRIPTIONS
// ============================================================================

/**
 * Subscribe to real-time updates for user's data
 */
export function subscribeToUserUpdates(userId: string, callbacks: {
  onEmailUpdate?: (payload: { [key: string]: unknown }) => void;
  onNotificationUpdate?: (payload: { [key: string]: unknown }) => void;
  onFollowUpUpdate?: (payload: { [key: string]: unknown }) => void;
}) {
  const subscriptions: Array<ReturnType<typeof supabase.channel>> = [];

  // Subscribe to tracked emails
  if (callbacks.onEmailUpdate) {
    const emailSub = supabase
      .channel(`user-emails-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tracked_emails',
          filter: `email_account_id=in.(select id from email_accounts where user_id=eq.${userId})`,
        },
        callbacks.onEmailUpdate
      )
      .subscribe();
    subscriptions.push(emailSub);
  }

  // Subscribe to notifications
  if (callbacks.onNotificationUpdate) {
    const notificationSub = supabase
      .channel(`user-notifications-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`,
        },
        callbacks.onNotificationUpdate
      )
      .subscribe();
    subscriptions.push(notificationSub);
  }

  // Subscribe to follow-up executions
  if (callbacks.onFollowUpUpdate) {
    const followUpSub = supabase
      .channel(`user-followups-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'follow_up_executions',
          filter: `tracked_email_id=in.(select te.id from tracked_emails te join email_accounts ea on te.email_account_id = ea.id where ea.user_id=eq.${userId})`,
        },
        callbacks.onFollowUpUpdate
      )
      .subscribe();
    subscriptions.push(followUpSub);
  }

  // Return cleanup function
  return () => {
    subscriptions.forEach(sub => {
      if (sub) {
        supabase.removeChannel(sub);
      }
    });
  };
}

// ============================================================================
// ERROR HANDLING AND LOGGING
// ============================================================================

/**
 * Log database errors for monitoring
 */
export async function logDatabaseError(error: Error | unknown, context: string) {
  try {
    const user = await getCurrentUser();
    
    // Log to analytics events for monitoring
    await supabase
      .from('analytics_events')
      .insert({
        user_id: user?.id || null,
        event_type: 'database_error',
        event_data: {
          error: error instanceof Error ? error.message : 'Unknown error',
          context,
          timestamp: new Date().toISOString(),
          stack: error instanceof Error ? error.stack || null : null,
        },
      });
  } catch (logError) {
    // If logging fails, at least log to console
    console.error('Failed to log database error:', logError);
  }
}

// ============================================================================
// TYPE EXPORTS
// ============================================================================

export type SupabaseClient = typeof supabase;
export type { Database };