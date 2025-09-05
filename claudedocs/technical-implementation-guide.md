# Technical Implementation Guide

## Implementation Priorities and Phases

### Phase 1: Foundation (Weeks 1-2)

1. **Authentication System**
   - Microsoft OAuth2 integration
   - Supabase user profiles
   - Protected routes middleware

2. **Basic Email Account Management**
   - Connect Microsoft accounts
   - Token management and refresh
   - Basic webhook subscription setup

3. **Core Database Schema**
   - Implement essential tables
   - Set up RLS policies
   - Create database functions

### Phase 2: Core Features (Weeks 3-5)

1. **Email Tracking Engine**
   - Webhook processing pipeline
   - Email ingestion from Graph API
   - Response detection logic

2. **Basic Follow-up System**
   - Simple follow-up rules
   - Template management
   - Execution engine

3. **Dashboard UI**
   - Email list with filtering
   - Basic statistics
   - Settings management

### Phase 3: Advanced Features (Weeks 6-8)

1. **Advanced Follow-up Logic**
   - Complex rule conditions
   - Multiple follow-up chains
   - A/B testing templates

2. **Analytics and Reporting**
   - Response rate tracking
   - Performance metrics
   - Export capabilities

3. **Real-time Features**
   - Live notifications
   - Real-time updates
   - Progressive enhancement

## Key Technical Patterns

### 1. Microsoft Graph API Integration

```typescript
// lib/microsoft-graph.ts
import { Client } from '@microsoft/microsoft-graph-client';
import { decrypt, encrypt } from './encryption';

export class GraphService {
  private client: Client;
  
  constructor(accessToken: string) {
    this.client = Client.init({
      authProvider: (done) => {
        done(null, accessToken);
      }
    });
  }

  // Subscribe to email webhooks
  async createEmailSubscription(userEmail: string, notificationUrl: string) {
    const subscription = {
      changeType: 'created,updated',
      notificationUrl,
      resource: 'me/messages',
      expirationDateTime: new Date(Date.now() + 3600000 * 24 * 3).toISOString(), // 3 days
      clientState: crypto.randomUUID()
    };

    return await this.client.api('/subscriptions').post(subscription);
  }

  // Sync emails for tracking
  async syncRecentEmails(since?: Date) {
    const filter = since 
      ? `sentDateTime gt ${since.toISOString()}` 
      : `sentDateTime gt ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}`;

    return await this.client
      .api('/me/messages')
      .filter(filter)
      .select('id,conversationId,subject,from,toRecipients,sentDateTime,hasAttachments,importance')
      .orderby('sentDateTime desc')
      .top(100)
      .get();
  }

  // Send follow-up email
  async sendFollowUp(originalMessage: any, template: FollowUpTemplate) {
    const followUpMessage = {
      subject: this.processTemplate(template.subject_template, originalMessage),
      body: {
        contentType: 'html',
        content: this.processTemplate(template.body_template, originalMessage)
      },
      toRecipients: originalMessage.toRecipients,
      replyTo: originalMessage.from,
      conversationId: originalMessage.conversationId
    };

    return await this.client.api('/me/sendMail').post({
      message: followUpMessage
    });
  }

  private processTemplate(template: string, context: any): string {
    return template
      .replace(/\{\{subject\}\}/g, context.subject)
      .replace(/\{\{from_name\}\}/g, context.from?.emailAddress?.name || 'there')
      .replace(/\{\{date\}\}/g, new Date(context.sentDateTime).toLocaleDateString());
  }
}
```

### 2. Webhook Processing Pipeline

```typescript
// app/api/webhooks/microsoft/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase';
import { GraphService } from '@/lib/microsoft-graph';

export async function POST(request: NextRequest) {
  try {
    // Verify webhook signature
    const signature = request.headers.get('x-ms-signature');
    if (!verifySignature(await request.text(), signature)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }

    const notifications = await request.json();
    
    // Process each notification
    for (const notification of notifications.value) {
      await processNotification(notification);
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }
}

async function processNotification(notification: any) {
  const supabase = createServiceRoleClient();
  
  // Get the email account for this subscription
  const { data: account } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('webhook_subscription_id', notification.subscriptionId)
    .single();

  if (!account) return;

  // Initialize Graph client
  const accessToken = decrypt(account.access_token_encrypted);
  const graph = new GraphService(accessToken);

  // Process the changed message
  if (notification.changeType === 'created') {
    await handleNewEmail(graph, notification.resourceData.id, account);
  } else if (notification.changeType === 'updated') {
    await handleEmailUpdate(graph, notification.resourceData.id, account);
  }
}

async function handleNewEmail(graph: GraphService, messageId: string, account: any) {
  const supabase = createServiceRoleClient();
  
  // Get message details from Graph API
  const message = await graph.client
    .api(`/me/messages/${messageId}`)
    .select('id,conversationId,subject,from,toRecipients,sentDateTime,hasAttachments,importance,bodyPreview')
    .get();

  // Check if this is a response to a tracked email
  const { data: trackedEmail } = await supabase
    .from('tracked_emails')
    .select('*')
    .eq('email_account_id', account.id)
    .eq('conversation_id', message.conversationId)
    .eq('has_response', false)
    .single();

  if (trackedEmail) {
    // This is a response - update tracking
    await supabase
      .from('tracked_emails')
      .update({
        has_response: true,
        last_response_at: new Date().toISOString(),
        response_count: trackedEmail.response_count + 1,
        tracking_status: 'completed'
      })
      .eq('id', trackedEmail.id);

    // Record the response
    await supabase
      .from('email_responses')
      .insert({
        tracked_email_id: trackedEmail.id,
        message_id: messageId,
        from_email: message.from.emailAddress.address,
        from_name: message.from.emailAddress.name,
        subject: message.subject,
        body_preview: message.bodyPreview,
        received_at: message.sentDateTime
      });

    // Cancel pending follow-ups
    await supabase
      .from('follow_up_executions')
      .update({ execution_status: 'cancelled' })
      .eq('tracked_email_id', trackedEmail.id)
      .eq('execution_status', 'scheduled');

    // Send notification
    await createNotification(account.user_id, 'response_received', {
      subject: trackedEmail.subject,
      from: message.from.emailAddress.name
    });
  } else {
    // This might be a new outbound email to track
    await considerForTracking(message, account);
  }
}
```

### 3. Follow-up Execution Engine

```typescript
// lib/follow-up-service.ts
export class FollowUpService {
  private supabase = createServiceRoleClient();

  async processScheduledFollowUps() {
    const now = new Date().toISOString();
    
    // Get all scheduled follow-ups that are due
    const { data: dueFollowUps } = await this.supabase
      .from('follow_up_executions')
      .select(`
        *,
        tracked_emails(*),
        follow_up_rules(*),
        follow_up_templates(*)
      `)
      .eq('execution_status', 'scheduled')
      .lte('scheduled_for', now);

    for (const followUp of dueFollowUps || []) {
      await this.executeFollowUp(followUp);
    }
  }

  private async executeFollowUp(followUp: any) {
    try {
      // Mark as executing
      await this.supabase
        .from('follow_up_executions')
        .update({ execution_status: 'executing' })
        .eq('id', followUp.id);

      // Check if email still needs follow-up (no response received)
      const { data: trackedEmail } = await this.supabase
        .from('tracked_emails')
        .select('*')
        .eq('id', followUp.tracked_email_id)
        .single();

      if (trackedEmail?.has_response) {
        // Response received, cancel follow-up
        await this.supabase
          .from('follow_up_executions')
          .update({ execution_status: 'cancelled' })
          .eq('id', followUp.id);
        return;
      }

      // Get email account and send follow-up
      const { data: emailAccount } = await this.supabase
        .from('email_accounts')
        .select('*')
        .eq('id', trackedEmail.email_account_id)
        .single();

      const accessToken = decrypt(emailAccount.access_token_encrypted);
      const graph = new GraphService(accessToken);

      // Get template based on follow-up number
      const templateId = this.getTemplateId(followUp.follow_up_rule, followUp.follow_up_number);
      const { data: template } = await this.supabase
        .from('follow_up_templates')
        .select('*')
        .eq('id', templateId)
        .single();

      // Send the follow-up
      const result = await graph.sendFollowUp(trackedEmail, template);

      // Mark as executed
      await this.supabase
        .from('follow_up_executions')
        .update({
          execution_status: 'executed',
          executed_at: new Date().toISOString(),
          message_id: result.id
        })
        .eq('id', followUp.id);

      // Schedule next follow-up if applicable
      await this.scheduleNextFollowUp(followUp);

    } catch (error) {
      // Mark as failed
      await this.supabase
        .from('follow_up_executions')
        .update({
          execution_status: 'failed',
          error_message: error.message
        })
        .eq('id', followUp.id);

      // Send error notification
      await createNotification(followUp.follow_up_rules.user_id, 'follow_up_failed', {
        error: error.message,
        email_subject: followUp.tracked_emails.subject
      });
    }
  }

  private async scheduleNextFollowUp(currentFollowUp: any) {
    const rule = currentFollowUp.follow_up_rules;
    const nextNumber = currentFollowUp.follow_up_number + 1;

    if (nextNumber > rule.max_follow_ups) return;

    const hoursField = `${this.getOrdinal(nextNumber)}_follow_up_hours`;
    const hours = rule[hoursField];

    if (!hours) return;

    const scheduledFor = new Date();
    scheduledFor.setHours(scheduledFor.getHours() + hours);

    await this.supabase
      .from('follow_up_executions')
      .insert({
        tracked_email_id: currentFollowUp.tracked_email_id,
        follow_up_rule_id: currentFollowUp.follow_up_rule_id,
        follow_up_number: nextNumber,
        scheduled_for: scheduledFor.toISOString(),
        execution_status: 'scheduled'
      });
  }

  private getOrdinal(num: number): string {
    const ordinals = ['first', 'second', 'third'];
    return ordinals[num - 1] || 'first';
  }

  private getTemplateId(rule: any, followUpNumber: number): string {
    const templateField = `${this.getOrdinal(followUpNumber)}_template_id`;
    return rule[templateField];
  }
}
```

### 4. Real-time Updates with Supabase

```typescript
// hooks/use-real-time-updates.ts
import { useEffect } from 'react';
import { createClient } from '@/lib/supabase';
import { useQueryClient } from '@tanstack/react-query';

export function useRealTimeUpdates(userId: string) {
  const queryClient = useQueryClient();
  const supabase = createClient();

  useEffect(() => {
    // Subscribe to tracked emails updates
    const emailsSubscription = supabase
      .channel('tracked_emails_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tracked_emails',
          filter: `email_account_id=in.(select id from email_accounts where user_id=eq.${userId})`
        },
        (payload) => {
          // Invalidate and refetch email queries
          queryClient.invalidateQueries({ queryKey: ['emails'] });
          queryClient.invalidateQueries({ queryKey: ['dashboard', 'stats'] });
        }
      )
      .subscribe();

    // Subscribe to notifications
    const notificationsSubscription = supabase
      .channel('notifications_changes')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${userId}`
        },
        (payload) => {
          queryClient.invalidateQueries({ queryKey: ['notifications'] });
          
          // Show toast notification
          toast({
            title: payload.new.title,
            description: payload.new.message
          });
        }
      )
      .subscribe();

    return () => {
      emailsSubscription.unsubscribe();
      notificationsSubscription.unsubscribe();
    };
  }, [userId, queryClient, supabase]);
}
```

### 5. Advanced Query Patterns

```typescript
// lib/queries/email-queries.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase';

export function useTrackedEmails(filters: EmailFilters = {}) {
  const supabase = createClient();
  
  return useQuery({
    queryKey: ['emails', 'tracked', filters],
    queryFn: async () => {
      let query = supabase
        .from('tracked_emails')
        .select(`
          *,
          email_accounts(email_address, display_name),
          email_responses(count),
          follow_up_executions(
            id,
            follow_up_number,
            scheduled_for,
            execution_status,
            executed_at
          )
        `)
        .order('sent_at', { ascending: false });

      // Apply filters
      if (filters.hasResponse !== undefined) {
        query = query.eq('has_response', filters.hasResponse);
      }
      
      if (filters.status) {
        query = query.eq('tracking_status', filters.status);
      }
      
      if (filters.dateFrom) {
        query = query.gte('sent_at', filters.dateFrom);
      }
      
      if (filters.dateTo) {
        query = query.lte('sent_at', filters.dateTo);
      }
      
      if (filters.search) {
        query = query.or(`subject.ilike.%${filters.search}%,from_email.ilike.%${filters.search}%`);
      }

      const { data, error } = await query.range(
        (filters.page - 1) * filters.limit,
        filters.page * filters.limit - 1
      );

      if (error) throw error;
      return data;
    },
    staleTime: 30000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useEmailStats() {
  const supabase = createClient();
  
  return useQuery({
    queryKey: ['dashboard', 'stats'],
    queryFn: async () => {
      // Get counts in parallel
      const [totalEmails, responseRate, pendingFollowUps, activeRules] = await Promise.all([
        supabase
          .from('tracked_emails')
          .select('*', { count: 'exact', head: true }),
        
        supabase.rpc('calculate_response_rate'),
        
        supabase
          .from('follow_up_executions')
          .select('*', { count: 'exact', head: true })
          .eq('execution_status', 'scheduled'),
        
        supabase
          .from('follow_up_rules')
          .select('*', { count: 'exact', head: true })
          .eq('is_active', true)
      ]);

      return {
        totalEmails: totalEmails.count || 0,
        responseRate: responseRate.data?.[0]?.rate || 0,
        pendingFollowUps: pendingFollowUps.count || 0,
        activeRules: activeRules.count || 0
      };
    },
    staleTime: 2 * 60 * 1000, // 2 minutes
    refetchInterval: 5 * 60 * 1000, // Refresh every 5 minutes
  });
}
```

## Performance Optimization Strategies

### 1. Database Optimization

```sql
-- Materialized view for analytics
CREATE MATERIALIZED VIEW email_analytics AS
SELECT 
  DATE_TRUNC('day', sent_at) as date,
  COUNT(*) as total_emails,
  COUNT(*) FILTER (WHERE has_response = true) as emails_with_response,
  AVG(response_count) as avg_response_count,
  AVG(EXTRACT(EPOCH FROM (last_response_at - sent_at))/3600) as avg_response_time_hours
FROM tracked_emails
WHERE sent_at >= NOW() - INTERVAL '90 days'
GROUP BY DATE_TRUNC('day', sent_at)
ORDER BY date DESC;

-- Refresh function
CREATE OR REPLACE FUNCTION refresh_email_analytics()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY email_analytics;
END;
$$ LANGUAGE plpgsql;

-- Auto-refresh trigger
CREATE OR REPLACE FUNCTION trigger_refresh_analytics()
RETURNS trigger AS $$
BEGIN
  PERFORM refresh_email_analytics();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER refresh_analytics_trigger
AFTER INSERT OR UPDATE ON tracked_emails
FOR EACH STATEMENT EXECUTE FUNCTION trigger_refresh_analytics();
```

### 2. Caching Strategy

```typescript
// lib/cache.ts
import { unstable_cache } from 'next/cache';

export const getCachedUserStats = unstable_cache(
  async (userId: string) => {
    const supabase = createServiceRoleClient();
    
    const { data } = await supabase.rpc('get_user_stats', { 
      user_id: userId 
    });
    
    return data;
  },
  ['user-stats'],
  {
    revalidate: 300, // 5 minutes
    tags: ['stats']
  }
);

export const getCachedEmailAnalytics = unstable_cache(
  async (userId: string, days: number = 30) => {
    const supabase = createServiceRoleClient();
    
    const { data } = await supabase
      .from('email_analytics')
      .select('*')
      .gte('date', new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString());
      
    return data;
  },
  ['email-analytics'],
  {
    revalidate: 3600, // 1 hour
    tags: ['analytics']
  }
);

// Revalidate cache when data changes
export async function revalidateUserCache(userId: string) {
  revalidateTag('stats');
  revalidateTag('analytics');
}
```

This implementation guide provides the concrete patterns and code structures needed to build the email tracking system efficiently and securely.
