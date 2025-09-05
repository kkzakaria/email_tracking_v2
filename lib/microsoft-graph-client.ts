/**
 * Microsoft Graph API Client - Secure Integration with Rate Limiting
 * Email Tracking System - Critical Microsoft Graph Infrastructure
 * Created: 2025-09-05 for Microsoft OAuth2 Authentication
 * 
 * ⚠️ CRITICAL: This client handles all Microsoft Graph API interactions
 * Integrates rate limiting, token management, and audit logging
 */

import { Client } from '@microsoft/microsoft-graph-client';
import { AuthenticationProvider } from '@microsoft/microsoft-graph-client';
import { tokenManager } from './token-manager';
import { rateLimiter } from './rate-limiter';
import { auditLogger } from './audit-logger';
import { 
  GraphAPICallSchema, 
  MicrosoftUserInfoSchema,
  createValidator 
} from './validators';

/**
 * Custom Authentication Provider for Microsoft Graph Client
 * Integrates with our token management system
 */
class SecureAuthenticationProvider implements AuthenticationProvider {
  constructor(private accountId: string) {}

  /**
   * Get access token for Graph API calls
   */
  async getAccessToken(): Promise<string> {
    try {
      const tokens = await tokenManager.getValidTokens(this.accountId);
      
      if (!tokens) {
        throw new Error('No valid tokens available for account');
      }

      return tokens.access_token;
    } catch (error) {
      console.error('Failed to get access token:', error);
      throw new Error('Authentication failed');
    }
  }
}

/**
 * Microsoft Graph API Client with Security Integration
 */
export class MicrosoftGraphClient {
  private client: Client | null = null;
  private accountId: string;

  constructor(accountId: string) {
    this.accountId = accountId;
    this.initializeClient();
  }

  /**
   * Initialize the Microsoft Graph client with custom auth provider
   */
  private initializeClient(): void {
    try {
      const authProvider = new SecureAuthenticationProvider(this.accountId);
      
      this.client = Client.initWithMiddleware({
        authProvider,
        defaultVersion: 'v1.0',
        debugLogging: process.env.GRAPH_API_DEBUG === 'true',
      });

    } catch (error) {
      console.error('Failed to initialize Graph client:', error);
      this.client = null;
    }
  }

  /**
   * Make a secure Graph API call with rate limiting and audit logging
   * @param endpoint - Graph API endpoint (e.g., '/me', '/me/messages')
   * @param method - HTTP method
   * @param data - Request data for POST/PUT/PATCH
   * @param headers - Additional headers
   * @returns Promise<any> - API response data
   */
  async callAPI<T>(
    endpoint: string,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' = 'GET',
    data?: unknown,
    headers?: Record<string, string>
  ): Promise<T> {
    try {
      if (!this.client) {
        throw new Error('Graph client not initialized');
      }

      // Validate request parameters
      const validator = createValidator(GraphAPICallSchema);
      const validationResult = validator({
        account_id: this.accountId,
        endpoint,
        method,
        headers,
        body: data,
      });

      if (!validationResult.success) {
        throw new Error(`Invalid request parameters: ${validationResult.errors.join(', ')}`);
      }

      // Determine operation type for rate limiting
      const operationType = this.determineOperationType(endpoint, method);
      
      // Check rate limits before making the call
      const rateLimitResult = await rateLimiter.checkAndRecord(this.accountId, operationType);
      
      if (!rateLimitResult.allowed) {
        const error = new GraphRateLimitError(rateLimitResult);
        
        // Log rate limit violation
        await auditLogger.logGraphAPICall(
          this.accountId,
          endpoint,
          method,
          false,
          true,
          {
            rate_limit_result: rateLimitResult,
            endpoint_full: endpoint,
          }
        );
        
        throw error;
      }

      // Make the actual API call
      const startTime = Date.now();
      let response: T;
      let success = true;
      let errorDetails: unknown = null;

      try {
        let request = this.client.api(endpoint);

        // Add custom headers
        if (headers) {
          Object.entries(headers).forEach(([key, value]) => {
            request = request.header(key, value);
          });
        }

        // Execute request based on method
        switch (method) {
          case 'GET':
            response = await request.get();
            break;
          case 'POST':
            response = await request.post(data);
            break;
          case 'PUT':
            response = await request.put(data);
            break;
          case 'PATCH':
            response = await request.patch(data);
            break;
          case 'DELETE':
            response = await request.delete();
            break;
          default:
            throw new Error(`Unsupported HTTP method: ${method}`);
        }

      } catch (apiError) {
        success = false;
        errorDetails = apiError;
        throw apiError;
      } finally {
        const duration = Date.now() - startTime;
        
        // Log the API call
        await auditLogger.logGraphAPICall(
          this.accountId,
          endpoint,
          method,
          success,
          false,
          {
            duration_ms: duration,
            operation_type: operationType,
            rate_limit_used: rateLimitResult.usage_recorded,
            endpoint_full: endpoint,
            error_details: errorDetails,
          }
        );
      }

      return response;

    } catch (error) {
      console.error(`Graph API call failed [${method} ${endpoint}]:`, error);
      
      // Handle specific error types
      if (error instanceof GraphRateLimitError) {
        throw error;
      }

      if (error && typeof error === 'object' && 'code' in error) {
        const graphError = error as { code: string; message: string };
        throw new GraphAPIError(graphError.code, graphError.message, endpoint, method);
      }

      throw new GraphAPIError('UNKNOWN_ERROR', 'Graph API call failed', endpoint, method);
    }
  }

  /**
   * Get user information
   * @returns Promise<MicrosoftUserInfo> - User information from Microsoft Graph
   */
  async getUser(): Promise<MicrosoftUserInfo> {
    try {
      const userResponse = await this.callAPI('/me', 'GET');
      
      // Validate response
      const validator = createValidator(MicrosoftUserInfoSchema);
      const validationResult = validator(userResponse);
      
      if (!validationResult.success) {
        throw new Error(`Invalid user info response: ${validationResult.errors.join(', ')}`);
      }
      
      return validationResult.data;
    } catch (error) {
      console.error('Failed to get user info:', error);
      throw new GraphAPIError('USER_INFO_FAILED', 'Failed to retrieve user information', '/me', 'GET');
    }
  }

  /**
   * Get user's mailbox settings
   * @returns Promise<any> - Mailbox settings
   */
  async getMailboxSettings(): Promise<Record<string, unknown>> {
    try {
      return await this.callAPI('/me/mailboxSettings', 'GET');
    } catch (error) {
      console.error('Failed to get mailbox settings:', error);
      throw error;
    }
  }

  /**
   * Get user's messages
   * @param options - Query options (top, skip, filter, select, etc.)
   * @returns Promise<any> - Messages collection
   */
  async getMessages(options?: GraphQueryOptions): Promise<Record<string, unknown>> {
    try {
      let endpoint = '/me/messages';
      
      if (options) {
        const params = new URLSearchParams();
        if (options.$top) params.append('$top', options.$top.toString());
        if (options.$skip) params.append('$skip', options.$skip.toString());
        if (options.$filter) params.append('$filter', options.$filter);
        if (options.$select) params.append('$select', options.$select);
        if (options.$orderby) params.append('$orderby', options.$orderby);
        
        const queryString = params.toString();
        if (queryString) {
          endpoint += `?${queryString}`;
        }
      }
      
      return await this.callAPI(endpoint, 'GET');
    } catch (error) {
      console.error('Failed to get messages:', error);
      throw error;
    }
  }

  /**
   * Send email message
   * @param message - Email message to send
   * @returns Promise<void>
   */
  async sendMessage(message: EmailMessage): Promise<void> {
    try {
      await this.callAPI('/me/sendMail', 'POST', {
        message,
        saveToSentItems: true,
      });
    } catch (error) {
      console.error('Failed to send message:', error);
      throw error;
    }
  }

  /**
   * Create webhook subscription
   * @param subscription - Subscription configuration
   * @returns Promise<any> - Created subscription
   */
  async createSubscription(subscription: WebhookSubscription): Promise<Record<string, unknown>> {
    try {
      return await this.callAPI('/subscriptions', 'POST', subscription);
    } catch (error) {
      console.error('Failed to create subscription:', error);
      throw error;
    }
  }

  /**
   * Test connectivity to Microsoft Graph API
   * @returns Promise<GraphConnectivityTest> - Test results
   */
  async testConnectivity(): Promise<GraphConnectivityTest> {
    const startTime = Date.now();
    const tests: Array<{ name: string; success: boolean; duration: number; error?: string }> = [];

    // Test 1: Get user info
    try {
      const userStart = Date.now();
      await this.getUser();
      tests.push({
        name: 'user_info',
        success: true,
        duration: Date.now() - userStart,
      });
    } catch (error) {
      tests.push({
        name: 'user_info',
        success: false,
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Test 2: Get mailbox settings  
    try {
      const settingsStart = Date.now();
      await this.getMailboxSettings();
      tests.push({
        name: 'mailbox_settings',
        success: true,
        duration: Date.now() - settingsStart,
      });
    } catch (error) {
      const settingsStart = Date.now();
      tests.push({
        name: 'mailbox_settings',
        success: false,
        duration: Date.now() - settingsStart,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Test 3: Get messages (limited)
    try {
      const messagesStart = Date.now();
      await this.getMessages({ $top: 1, $select: 'id,subject' });
      tests.push({
        name: 'messages_access',
        success: true,
        duration: Date.now() - messagesStart,
      });
    } catch (error) {
      const messagesStart = Date.now();
      tests.push({
        name: 'messages_access',
        success: false,
        duration: Date.now() - messagesStart,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    const totalDuration = Date.now() - startTime;
    const allPassed = tests.every(test => test.success);

    return {
      success: allPassed,
      total_duration: totalDuration,
      account_id: this.accountId,
      timestamp: new Date().toISOString(),
      tests,
    };
  }

  /**
   * Determine rate limit operation type based on endpoint and method
   * @param endpoint - Graph API endpoint
   * @param method - HTTP method
   * @returns RateLimitOperationType
   */
  private determineOperationType(endpoint: string, method: string): 'email_read' | 'webhook_create' | 'bulk_operation' {
    if (endpoint.includes('/subscriptions') && method === 'POST') {
      return 'webhook_create';
    }
    
    if (endpoint.includes('/messages') || endpoint.includes('/mailFolders')) {
      return 'email_read';
    }
    
    if (method !== 'GET' || endpoint.includes('/$batch')) {
      return 'bulk_operation';
    }
    
    return 'email_read';
  }
}

// ============================================================================
// ERROR CLASSES
// ============================================================================

export class GraphAPIError extends Error {
  constructor(
    public code: string,
    message: string,
    public endpoint: string,
    public method: string
  ) {
    super(message);
    this.name = 'GraphAPIError';
  }
}

export class GraphRateLimitError extends Error {
  constructor(public rateLimitResult: { current_count: number; limit: number; reset_time: string }) {
    const retryAfter = Math.ceil((new Date(rateLimitResult.reset_time).getTime() - Date.now()) / 1000);
    super(`Rate limit exceeded: ${rateLimitResult.current_count}/${rateLimitResult.limit}. Retry after ${retryAfter} seconds`);
    this.name = 'GraphRateLimitError';
  }
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface GraphQueryOptions {
  $top?: number;
  $skip?: number;
  $filter?: string;
  $select?: string;
  $orderby?: string;
  $expand?: string;
}

export interface EmailMessage {
  subject: string;
  body: {
    contentType: 'text' | 'html';
    content: string;
  };
  toRecipients: Array<{
    emailAddress: {
      address: string;
      name?: string;
    };
  }>;
  ccRecipients?: Array<{
    emailAddress: {
      address: string;
      name?: string;
    };
  }>;
  bccRecipients?: Array<{
    emailAddress: {
      address: string;
      name?: string;
    };
  }>;
}

export interface WebhookSubscription {
  changeType: string;
  notificationUrl: string;
  resource: string;
  expirationDateTime: string;
  clientState?: string;
}

export interface GraphConnectivityTest {
  success: boolean;
  total_duration: number;
  account_id: string;
  timestamp: string;
  tests: Array<{
    name: string;
    success: boolean;
    duration: number;
    error?: string;
  }>;
}

export interface MicrosoftUserInfo {
  id: string;
  displayName: string;
  mail?: string | null;
  userPrincipalName: string;
  jobTitle?: string | null;
  officeLocation?: string | null;
  mobilePhone?: string | null;
  businessPhones?: string[];
}

// ============================================================================
// FACTORY FUNCTION
// ============================================================================

/**
 * Create a new Microsoft Graph client instance
 * @param accountId - The email account ID
 * @returns MicrosoftGraphClient - Configured Graph client
 */
export function createGraphClient(accountId: string): MicrosoftGraphClient {
  return new MicrosoftGraphClient(accountId);
}

// Export default for convenience
export { MicrosoftGraphClient as default };