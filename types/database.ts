/**
 * Database Types - Generated from Supabase Schema
 * Email Tracking System - Type Definitions
 * Created: 2025-09-05 by backend-architect
 * 
 * NOTE: This file should be regenerated using Supabase CLI:
 * supabase gen types typescript --local > types/database.ts
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// Enum types
export type TrackingStatusEnum = 'active' | 'paused' | 'completed' | 'failed';
export type ImportanceLevelEnum = 'low' | 'normal' | 'high';
export type ExecutionStatusEnum = 'scheduled' | 'executed' | 'failed' | 'cancelled';
export type NotificationTypeEnum = 
  | 'response_received' 
  | 'follow_up_sent' 
  | 'follow_up_failed' 
  | 'webhook_error' 
  | 'token_expired' 
  | 'rate_limit_exceeded';

// Rate limiting operation types
export type RateLimitOperationType = 'email_read' | 'webhook_create' | 'bulk_operation';

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          full_name: string | null;
          company: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          full_name?: string | null;
          company?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          full_name?: string | null;
          company?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          }
        ];
      };
      email_accounts: {
        Row: {
          id: string;
          user_id: string;
          microsoft_user_id: string;
          email_address: string;
          display_name: string | null;
          access_token_encrypted: string;
          refresh_token_encrypted: string;
          token_expires_at: string;
          webhook_subscription_id: string | null;
          webhook_expires_at: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          microsoft_user_id: string;
          email_address: string;
          display_name?: string | null;
          access_token_encrypted: string;
          refresh_token_encrypted: string;
          token_expires_at: string;
          webhook_subscription_id?: string | null;
          webhook_expires_at?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          microsoft_user_id?: string;
          email_address?: string;
          display_name?: string | null;
          access_token_encrypted?: string;
          refresh_token_encrypted?: string;
          token_expires_at?: string;
          webhook_subscription_id?: string | null;
          webhook_expires_at?: string | null;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "email_accounts_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      rate_limit_tracking: {
        Row: {
          id: string;
          email_account_id: string;
          operation_type: string;
          requests_count: number;
          window_start: string;
          window_end: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email_account_id: string;
          operation_type: string;
          requests_count?: number;
          window_start: string;
          window_end: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email_account_id?: string;
          operation_type?: string;
          requests_count?: number;
          window_start?: string;
          window_end?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "rate_limit_tracking_email_account_id_fkey";
            columns: ["email_account_id"];
            isOneToOne: false;
            referencedRelation: "email_accounts";
            referencedColumns: ["id"];
          }
        ];
      };
      tracked_emails: {
        Row: {
          id: string;
          email_account_id: string;
          message_id: string;
          conversation_id: string | null;
          thread_id: string | null;
          subject: string;
          from_email: string;
          from_name: string | null;
          to_emails: string[];
          cc_emails: string[] | null;
          bcc_emails: string[] | null;
          body_preview: string | null;
          sent_at: string;
          has_response: boolean;
          last_response_at: string | null;
          response_count: number;
          tracking_status: TrackingStatusEnum;
          follow_up_rule_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          email_account_id: string;
          message_id: string;
          conversation_id?: string | null;
          thread_id?: string | null;
          subject: string;
          from_email: string;
          from_name?: string | null;
          to_emails: string[];
          cc_emails?: string[] | null;
          bcc_emails?: string[] | null;
          body_preview?: string | null;
          sent_at: string;
          has_response?: boolean;
          last_response_at?: string | null;
          response_count?: number;
          tracking_status?: TrackingStatusEnum;
          follow_up_rule_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email_account_id?: string;
          message_id?: string;
          conversation_id?: string | null;
          thread_id?: string | null;
          subject?: string;
          from_email?: string;
          from_name?: string | null;
          to_emails?: string[];
          cc_emails?: string[] | null;
          bcc_emails?: string[] | null;
          body_preview?: string | null;
          sent_at?: string;
          has_response?: boolean;
          last_response_at?: string | null;
          response_count?: number;
          tracking_status?: TrackingStatusEnum;
          follow_up_rule_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tracked_emails_email_account_id_fkey";
            columns: ["email_account_id"];
            isOneToOne: false;
            referencedRelation: "email_accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fk_tracked_emails_follow_up_rule";
            columns: ["follow_up_rule_id"];
            isOneToOne: false;
            referencedRelation: "follow_up_rules";
            referencedColumns: ["id"];
          }
        ];
      };
      email_responses: {
        Row: {
          id: string;
          tracked_email_id: string;
          message_id: string;
          from_email: string;
          from_name: string | null;
          subject: string | null;
          body_preview: string | null;
          received_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          tracked_email_id: string;
          message_id: string;
          from_email: string;
          from_name?: string | null;
          subject?: string | null;
          body_preview?: string | null;
          received_at: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          tracked_email_id?: string;
          message_id?: string;
          from_email?: string;
          from_name?: string | null;
          subject?: string | null;
          body_preview?: string | null;
          received_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "email_responses_tracked_email_id_fkey";
            columns: ["tracked_email_id"];
            isOneToOne: false;
            referencedRelation: "tracked_emails";
            referencedColumns: ["id"];
          }
        ];
      };
      follow_up_templates: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          subject_template: string;
          body_template: string;
          is_default: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          subject_template: string;
          body_template: string;
          is_default?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          subject_template?: string;
          body_template?: string;
          is_default?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "follow_up_templates_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      follow_up_rules: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          description: string | null;
          is_active: boolean;
          applies_to_domains: string[] | null;
          applies_to_emails: string[] | null;
          exclude_domains: string[] | null;
          exclude_emails: string[] | null;
          min_importance: ImportanceLevelEnum;
          first_follow_up_hours: number;
          second_follow_up_hours: number | null;
          third_follow_up_hours: number | null;
          max_follow_ups: number;
          first_template_id: string | null;
          second_template_id: string | null;
          third_template_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          description?: string | null;
          is_active?: boolean;
          applies_to_domains?: string[] | null;
          applies_to_emails?: string[] | null;
          exclude_domains?: string[] | null;
          exclude_emails?: string[] | null;
          min_importance?: ImportanceLevelEnum;
          first_follow_up_hours?: number;
          second_follow_up_hours?: number | null;
          third_follow_up_hours?: number | null;
          max_follow_ups?: number;
          first_template_id?: string | null;
          second_template_id?: string | null;
          third_template_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          name?: string;
          description?: string | null;
          is_active?: boolean;
          applies_to_domains?: string[] | null;
          applies_to_emails?: string[] | null;
          exclude_domains?: string[] | null;
          exclude_emails?: string[] | null;
          min_importance?: ImportanceLevelEnum;
          first_follow_up_hours?: number;
          second_follow_up_hours?: number | null;
          third_follow_up_hours?: number | null;
          max_follow_ups?: number;
          first_template_id?: string | null;
          second_template_id?: string | null;
          third_template_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "follow_up_rules_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "follow_up_rules_first_template_id_fkey";
            columns: ["first_template_id"];
            isOneToOne: false;
            referencedRelation: "follow_up_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "follow_up_rules_second_template_id_fkey";
            columns: ["second_template_id"];
            isOneToOne: false;
            referencedRelation: "follow_up_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "follow_up_rules_third_template_id_fkey";
            columns: ["third_template_id"];
            isOneToOne: false;
            referencedRelation: "follow_up_templates";
            referencedColumns: ["id"];
          }
        ];
      };
      follow_up_executions: {
        Row: {
          id: string;
          tracked_email_id: string;
          follow_up_rule_id: string;
          follow_up_number: number;
          scheduled_for: string;
          executed_at: string | null;
          execution_status: ExecutionStatusEnum;
          message_id: string | null;
          error_message: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          tracked_email_id: string;
          follow_up_rule_id: string;
          follow_up_number: number;
          scheduled_for: string;
          executed_at?: string | null;
          execution_status?: ExecutionStatusEnum;
          message_id?: string | null;
          error_message?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          tracked_email_id?: string;
          follow_up_rule_id?: string;
          follow_up_number?: number;
          scheduled_for?: string;
          executed_at?: string | null;
          execution_status?: ExecutionStatusEnum;
          message_id?: string | null;
          error_message?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "follow_up_executions_tracked_email_id_fkey";
            columns: ["tracked_email_id"];
            isOneToOne: false;
            referencedRelation: "tracked_emails";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "follow_up_executions_follow_up_rule_id_fkey";
            columns: ["follow_up_rule_id"];
            isOneToOne: false;
            referencedRelation: "follow_up_rules";
            referencedColumns: ["id"];
          }
        ];
      };
      notifications: {
        Row: {
          id: string;
          user_id: string;
          type: NotificationTypeEnum;
          title: string;
          message: string;
          metadata: Json | null;
          is_read: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          type: NotificationTypeEnum;
          title: string;
          message: string;
          metadata?: Json | null;
          is_read?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          type?: NotificationTypeEnum;
          title?: string;
          message?: string;
          metadata?: Json | null;
          is_read?: boolean;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      user_settings: {
        Row: {
          user_id: string;
          timezone: string;
          notification_preferences: Json;
          tracking_preferences: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          timezone?: string;
          notification_preferences?: Json;
          tracking_preferences?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          user_id?: string;
          timezone?: string;
          notification_preferences?: Json;
          tracking_preferences?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_settings_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      analytics_events: {
        Row: {
          id: string;
          user_id: string | null;
          event_type: string;
          event_data: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          event_type: string;
          event_data?: Json | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          event_type?: string;
          event_data?: Json | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "analytics_events_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      audit_logs: {
        Row: {
          id: string;
          user_id: string | null;
          action: string;
          resource_type: string;
          resource_id: string | null;
          old_values: Json | null;
          new_values: Json | null;
          ip_address: string | null;
          user_agent: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          action: string;
          resource_type: string;
          resource_id?: string | null;
          old_values?: Json | null;
          new_values?: Json | null;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          action?: string;
          resource_type?: string;
          resource_id?: string | null;
          old_values?: Json | null;
          new_values?: Json | null;
          ip_address?: string | null;
          user_agent?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "audit_logs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
      user_consent_records: {
        Row: {
          id: string;
          user_id: string;
          consent_type: string;
          granted: boolean;
          consent_date: string;
          withdrawn_date: string | null;
          legal_basis: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          consent_type: string;
          granted: boolean;
          consent_date?: string;
          withdrawn_date?: string | null;
          legal_basis?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          consent_type?: string;
          granted?: boolean;
          consent_date?: string;
          withdrawn_date?: string | null;
          legal_basis?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_consent_records_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          }
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      check_rate_limit: {
        Args: {
          account_id: string;
          operation_type: string;
          limit_count?: number;
          window_minutes?: number;
        };
        Returns: {
          allowed: boolean;
          current_count: number;
          reset_time: string;
        }[];
      };
      record_rate_limit_usage: {
        Args: {
          account_id: string;
          operation_type: string;
          window_minutes?: number;
        };
        Returns: boolean;
      };
      cleanup_old_rate_limits: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
    };
    Enums: {
      tracking_status_enum: TrackingStatusEnum;
      importance_level_enum: ImportanceLevelEnum;
      execution_status_enum: ExecutionStatusEnum;
      notification_type_enum: NotificationTypeEnum;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}

// Helper types for common operations
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Update'];
export type Enums<T extends keyof Database['public']['Enums']> = Database['public']['Enums'][T];
export type Functions<T extends keyof Database['public']['Functions']> = Database['public']['Functions'][T];

// Convenience type aliases
export type Profile = Tables<'profiles'>;
export type EmailAccount = Tables<'email_accounts'>;
export type RateLimitTracking = Tables<'rate_limit_tracking'>;
export type TrackedEmail = Tables<'tracked_emails'>;
export type EmailResponse = Tables<'email_responses'>;
export type FollowUpTemplate = Tables<'follow_up_templates'>;
export type FollowUpRule = Tables<'follow_up_rules'>;
export type FollowUpExecution = Tables<'follow_up_executions'>;
export type Notification = Tables<'notifications'>;
export type UserSettings = Tables<'user_settings'>;
export type AnalyticsEvent = Tables<'analytics_events'>;
export type AuditLog = Tables<'audit_logs'>;
export type UserConsentRecord = Tables<'user_consent_records'>;

// Rate limiting specific types
export type RateLimitOperationType = 'email_read' | 'webhook_create' | 'bulk_operation';

export interface RateLimitStatus {
  allowed: boolean;
  current_count: number;
  reset_time: string;
}

// Extended types with relationships
export interface EmailAccountWithTracking extends EmailAccount {
  rate_limit_tracking?: RateLimitTracking[];
  tracked_emails?: TrackedEmail[];
}

export interface TrackedEmailWithDetails extends TrackedEmail {
  email_account?: EmailAccount;
  email_responses?: EmailResponse[];
  follow_up_executions?: FollowUpExecution[];
  follow_up_rule?: FollowUpRule;
}

export interface ProfileWithSettings extends Profile {
  user_settings?: UserSettings;
}