/**
 * Microsoft Graph API Test Endpoint
 * Email Tracking System - Graph API Connectivity Testing
 * Created: 2025-09-05
 * 
 * ⚠️ CRITICAL: This endpoint tests Microsoft Graph API connectivity
 * Used for validating authentication and API access
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '../../auth/[...nextauth]/route';
import { supabaseAdmin } from '@/lib/supabase';
import { createGraphClient } from '@/lib/microsoft-graph-client';
import { rateLimiter } from '@/lib/rate-limiter';
import { auditLogger, AuditEventType, AuditSeverity } from '@/lib/audit-logger';

/**
 * GET /api/graph/test
 * Test Microsoft Graph API connectivity for all user accounts or specific account
 */
export async function GET(request: NextRequest) {
  try {
    // Get current session
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const accountId = searchParams.get('account_id');
    const testType = searchParams.get('test_type') || 'basic'; // basic, full, connectivity
    const includeRateLimit = searchParams.get('include_rate_limit') === 'true';

    let accounts = [];

    if (accountId) {
      // Get specific account
      const { data: account, error } = await supabaseAdmin!
        .from('email_accounts')
        .select('id, email_address, display_name, is_active')
        .eq('id', accountId)
        .eq('user_id', session.user.id)
        .eq('provider', 'microsoft')
        .single();

      if (error || !account) {
        return NextResponse.json(
          { error: 'Account not found', message: 'Microsoft account not found' },
          { status: 404 }
        );
      }

      accounts = [account];
    } else {
      // Get all active Microsoft accounts
      const { data, error } = await supabaseAdmin!
        .from('email_accounts')
        .select('id, email_address, display_name, is_active')
        .eq('user_id', session.user.id)
        .eq('provider', 'microsoft')
        .eq('is_active', true);

      if (error) {
        console.error('Failed to fetch Microsoft accounts:', error);
        return NextResponse.json(
          { error: 'Database error', message: 'Failed to fetch accounts' },
          { status: 500 }
        );
      }

      accounts = data || [];
    }

    if (accounts.length === 0) {
      return NextResponse.json({
        success: false,
        message: 'No Microsoft accounts found',
        tests: [],
      });
    }

    // Run tests for each account
    const testResults = await Promise.all(
      accounts.map(async (account) => {
        const testResult: any = {
          account_id: account.id,
          email_address: account.email_address,
          display_name: account.display_name,
          success: false,
          tests: [],
          timestamp: new Date().toISOString(),
        };

        try {
          const graphClient = createGraphClient(account.id);

          // Basic test: Get user info
          if (testType === 'basic' || testType === 'full') {
            try {
              const startTime = Date.now();
              const userInfo = await graphClient.getUser();
              testResult.tests.push({
                name: 'user_info',
                success: true,
                duration: Date.now() - startTime,
                data: {
                  id: userInfo.id,
                  displayName: userInfo.displayName,
                  email: userInfo.mail || userInfo.userPrincipalName,
                },
              });
            } catch (error) {
              testResult.tests.push({
                name: 'user_info',
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }

          // Full test: Additional API calls
          if (testType === 'full') {
            // Test mailbox settings
            try {
              const startTime = Date.now();
              await graphClient.getMailboxSettings();
              testResult.tests.push({
                name: 'mailbox_settings',
                success: true,
                duration: Date.now() - startTime,
              });
            } catch (error) {
              testResult.tests.push({
                name: 'mailbox_settings',
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }

            // Test messages access
            try {
              const startTime = Date.now();
              const messages = await graphClient.getMessages({ $top: 1, $select: 'id,subject,receivedDateTime' });
              testResult.tests.push({
                name: 'messages_access',
                success: true,
                duration: Date.now() - startTime,
                data: {
                  message_count: messages?.value?.length || 0,
                },
              });
            } catch (error) {
              testResult.tests.push({
                name: 'messages_access',
                success: false,
                error: error instanceof Error ? error.message : 'Unknown error',
              });
            }
          }

          // Connectivity test: Comprehensive connectivity check
          if (testType === 'connectivity') {
            const connectivityResult = await graphClient.testConnectivity();
            testResult.tests = connectivityResult.tests;
            testResult.connectivity_result = connectivityResult;
          }

          // Include rate limit status if requested
          if (includeRateLimit) {
            try {
              testResult.rate_limit_status = await rateLimiter.getStatus(account.id);
            } catch (error) {
              testResult.rate_limit_error = error instanceof Error ? error.message : 'Unknown error';
            }
          }

          // Determine overall success
          testResult.success = testResult.tests.length > 0 && testResult.tests.every((test: any) => test.success);

          // Log the test
          await auditLogger.logEvent({
            event_type: 'graph_api_test',
            user_id: session.user.id,
            account_id: account.id,
            severity: AuditSeverity.LOW,
            details: {
              test_type: testType,
              success: testResult.success,
              test_count: testResult.tests.length,
              failed_tests: testResult.tests.filter((test: any) => !test.success).map((test: any) => test.name),
            },
          });

        } catch (error) {
          console.error(`Graph API test failed for account ${account.id}:`, error);
          
          testResult.success = false;
          testResult.error = error instanceof Error ? error.message : 'Unknown error';

          await auditLogger.logEvent({
            event_type: AuditEventType.GRAPH_API_FAILED,
            user_id: session.user.id,
            account_id: account.id,
            severity: AuditSeverity.HIGH,
            details: {
              test_type: testType,
              error: testResult.error,
            },
          });
        }

        return testResult;
      })
    );

    const overallSuccess = testResults.every(result => result.success);

    return NextResponse.json({
      success: overallSuccess,
      test_type: testType,
      account_count: testResults.length,
      results: testResults,
      summary: {
        total_accounts: testResults.length,
        successful_accounts: testResults.filter(r => r.success).length,
        failed_accounts: testResults.filter(r => !r.success).length,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Graph API test endpoint failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/graph/test',
        method: 'GET',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Graph API test failed' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/graph/test
 * Run specific Graph API tests with custom parameters
 */
export async function POST(request: NextRequest) {
  try {
    // Get current session
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized', message: 'Authentication required' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { account_id, endpoints = [], force_refresh = false } = body;

    if (!account_id) {
      return NextResponse.json(
        { error: 'Missing parameter', message: 'account_id is required' },
        { status: 400 }
      );
    }

    // Verify account belongs to user
    const { data: account, error: accountError } = await supabaseAdmin!
      .from('email_accounts')
      .select('id, email_address, display_name')
      .eq('id', account_id)
      .eq('user_id', session.user.id)
      .eq('provider', 'microsoft')
      .single();

    if (accountError || !account) {
      return NextResponse.json(
        { error: 'Account not found', message: 'Microsoft account not found' },
        { status: 404 }
      );
    }

    const graphClient = createGraphClient(account_id);
    const testResults = [];

    // Default endpoints to test if none specified
    const endpointsToTest = endpoints.length > 0 ? endpoints : [
      { path: '/me', method: 'GET', name: 'user_info' },
      { path: '/me/mailboxSettings', method: 'GET', name: 'mailbox_settings' },
      { path: '/me/messages', method: 'GET', name: 'messages', params: { $top: 1, $select: 'id,subject' } },
    ];

    // Test each specified endpoint
    for (const endpoint of endpointsToTest) {
      try {
        const startTime = Date.now();
        
        // Check rate limits before making call
        const rateLimitResult = await rateLimiter.checkAndRecord(account_id, 'email_read');
        
        if (!rateLimitResult.allowed) {
          testResults.push({
            name: endpoint.name,
            success: false,
            error: 'Rate limit exceeded',
            rate_limit_result: rateLimitResult,
          });
          continue;
        }

        // Build endpoint path with parameters
        let endpointPath = endpoint.path;
        if (endpoint.params) {
          const params = new URLSearchParams();
          Object.entries(endpoint.params).forEach(([key, value]) => {
            params.append(key, String(value));
          });
          endpointPath += `?${params.toString()}`;
        }

        // Make API call
        const response = await graphClient.callAPI(
          endpointPath,
          endpoint.method || 'GET',
          endpoint.body
        );

        testResults.push({
          name: endpoint.name,
          success: true,
          duration: Date.now() - startTime,
          endpoint: endpointPath,
          response_summary: {
            has_data: !!response,
            data_type: typeof response,
            array_length: Array.isArray(response?.value) ? response.value.length : undefined,
          },
        });

      } catch (error) {
        testResults.push({
          name: endpoint.name,
          success: false,
          endpoint: endpoint.path,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const overallSuccess = testResults.every(result => result.success);

    // Log custom test
    await auditLogger.logEvent({
      event_type: 'graph_api_custom_test',
      user_id: session.user.id,
      account_id: account_id,
      severity: AuditSeverity.MEDIUM,
      details: {
        success: overallSuccess,
        endpoints_tested: endpointsToTest.length,
        successful_endpoints: testResults.filter(r => r.success).length,
        endpoints: endpointsToTest.map(e => e.path),
      },
    });

    return NextResponse.json({
      success: overallSuccess,
      account_id,
      results: testResults,
      summary: {
        total_tests: testResults.length,
        successful_tests: testResults.filter(r => r.success).length,
        failed_tests: testResults.filter(r => !r.success).length,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Graph API custom test failed:', error);
    
    await auditLogger.logEvent({
      event_type: AuditEventType.SYSTEM_ERROR,
      severity: AuditSeverity.HIGH,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
        endpoint: '/api/graph/test',
        method: 'POST',
      },
    });

    return NextResponse.json(
      { error: 'Internal server error', message: 'Custom Graph API test failed' },
      { status: 500 }
    );
  }
}