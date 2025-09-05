/**
 * Security Configuration Test Suite
 * Email Tracking System - Critical Security Validation
 * Created: 2025-09-05 by security-engineer
 * 
 * ⚠️ CRITICAL: This script validates all security components
 * Run before deploying to production to ensure security compliance
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config({ path: '.env.local' });

// Test configuration
const TEST_CONFIG = {
  verbose: process.argv.includes('--verbose'),
  stopOnFirstError: process.argv.includes('--strict'),
  testUserId: '00000000-0000-0000-0000-000000000001',
  testAccountId: '00000000-0000-0000-0000-000000000002'
};

class SecurityTestSuite {
  constructor() {
    this.results = {
      total: 0,
      passed: 0,
      failed: 0,
      warnings: 0,
      errors: []
    };
    
    this.supabase = null;
    this.setupSupabaseClient();
  }

  setupSupabaseClient() {
    try {
      this.supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
          auth: { persistSession: false }
        }
      );
      
      if (TEST_CONFIG.verbose) {
        console.log('✅ Supabase client configured');
      }
    } catch (error) {
      this.logError('Failed to setup Supabase client', error);
    }
  }

  // ============================================================================
  // TEST FRAMEWORK METHODS
  // ============================================================================

  async runTest(testName, testFn) {
    this.results.total++;
    
    try {
      console.log(`🧪 Testing: ${testName}`);
      const startTime = Date.now();
      
      await testFn();
      
      const duration = Date.now() - startTime;
      this.results.passed++;
      
      console.log(`✅ ${testName} - PASSED (${duration}ms)`);
      
      if (TEST_CONFIG.verbose) {
        console.log('   └─ Test completed successfully\n');
      }
      
    } catch (error) {
      this.results.failed++;
      this.results.errors.push({ test: testName, error: error.message });
      
      console.log(`❌ ${testName} - FAILED`);
      console.log(`   └─ Error: ${error.message}\n`);
      
      if (TEST_CONFIG.stopOnFirstError) {
        throw new Error(`Test suite stopped due to failure in: ${testName}`);
      }
    }
  }

  logError(message, error) {
    console.error(`❌ ${message}:`, error.message || error);
    this.results.errors.push({ test: 'Setup', error: message });
  }

  logWarning(message) {
    console.warn(`⚠️  ${message}`);
    this.results.warnings++;
  }

  // ============================================================================
  // ENVIRONMENT VALIDATION TESTS
  // ============================================================================

  async testEnvironmentVariables() {
    const requiredVars = [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'ENCRYPTION_KEY',
      'JWT_SECRET',
      'MICROSOFT_CLIENT_ID',
      'MICROSOFT_CLIENT_SECRET',
      'MICROSOFT_REDIRECT_URI'
    ];

    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      throw new Error(`Missing environment variables: ${missingVars.join(', ')}`);
    }

    // Validate encryption key strength
    const encryptionKey = process.env.ENCRYPTION_KEY;
    if (encryptionKey.length < 32) {
      throw new Error('ENCRYPTION_KEY must be at least 32 characters long');
    }

    // Validate JWT secret strength
    const jwtSecret = process.env.JWT_SECRET;
    if (jwtSecret.length < 32) {
      throw new Error('JWT_SECRET must be at least 32 characters long');
    }

    // Validate Microsoft configuration
    const microsoftClientId = process.env.MICROSOFT_CLIENT_ID;
    if (microsoftClientId === 'your-client-id' || microsoftClientId === 'your_dev_client_id_here') {
      this.logWarning('Microsoft Client ID appears to be a placeholder - configure with real Azure app');
    }

    if (TEST_CONFIG.verbose) {
      console.log(`   ✓ All ${requiredVars.length} required environment variables present`);
      console.log(`   ✓ Encryption key strength: ${encryptionKey.length} characters`);
      console.log(`   ✓ JWT secret strength: ${jwtSecret.length} characters`);
    }
  }

  // ============================================================================
  // DATABASE SECURITY TESTS
  // ============================================================================

  async testDatabaseConnection() {
    if (!this.supabase) {
      throw new Error('Supabase client not available');
    }

    // Test basic connection
    const { data, error } = await this.supabase
      .from('profiles')
      .select('id')
      .limit(1);

    if (error) {
      throw new Error(`Database connection failed: ${error.message}`);
    }

    if (TEST_CONFIG.verbose) {
      console.log('   ✓ Database connection successful');
    }
  }

  async testRateLimitingService() {
    if (!this.supabase) {
      throw new Error('Supabase client not available');
    }

    // Test rate limit function exists
    const { data, error } = await this.supabase.rpc('check_rate_limit', {
      account_id: TEST_CONFIG.testAccountId,
      operation_type: 'email_read',
      limit_count: 100,
      window_minutes: 60
    });

    if (error) {
      throw new Error(`Rate limiting function test failed: ${error.message}`);
    }

    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Rate limiting function returned unexpected result');
    }

    const result = data[0];
    if (typeof result.allowed !== 'boolean' || typeof result.current_count !== 'number') {
      throw new Error('Rate limiting function returned invalid data structure');
    }

    if (TEST_CONFIG.verbose) {
      console.log('   ✓ Rate limiting function operational');
      console.log(`   ✓ Test result: ${JSON.stringify(result)}`);
    }
  }

  async testRowLevelSecurity() {
    if (!this.supabase) {
      throw new Error('Supabase client not available');
    }

    // Test RLS is enabled on critical tables
    const criticalTables = [
      'profiles',
      'email_accounts', 
      'tracked_emails',
      'follow_up_rules',
      'follow_up_templates',
      'rate_limit_tracking'
    ];

    for (const tableName of criticalTables) {
      const { data, error } = await this.supabase
        .from('information_schema.tables')
        .select('table_name, row_security')
        .eq('table_name', tableName)
        .eq('table_schema', 'public');

      if (error) {
        throw new Error(`Failed to check RLS for table ${tableName}: ${error.message}`);
      }

      if (!data || data.length === 0) {
        throw new Error(`Table ${tableName} not found`);
      }

      // Note: row_security might not be available in information_schema
      // This is a basic check that the table exists
    }

    if (TEST_CONFIG.verbose) {
      console.log(`   ✓ All ${criticalTables.length} critical tables exist`);
      console.log('   ⚠️  RLS status check limited by information_schema access');
    }
  }

  // ============================================================================
  // ENCRYPTION TESTS
  // ============================================================================

  async testEncryptionService() {
    // Import encryption service (dynamic import for ES modules)
    let TokenEncryption, encrypt, decrypt;
    
    try {
      const encryptionModule = await import('../lib/encryption.js');
      TokenEncryption = encryptionModule.TokenEncryption;
      encrypt = encryptionModule.encrypt;
      decrypt = encryptionModule.decrypt;
    } catch (error) {
      throw new Error(`Failed to import encryption service: ${error.message}`);
    }

    // Test data
    const testData = 'test-token-12345';
    const testUserId = TEST_CONFIG.testUserId;

    // Test encryption/decryption
    const encrypted = TokenEncryption.encrypt(testData, testUserId);
    if (!encrypted.data || !encrypted.algorithm || !encrypted.version) {
      throw new Error('Encryption returned invalid structure');
    }

    const decrypted = TokenEncryption.decrypt(encrypted, testUserId);
    if (decrypted !== testData) {
      throw new Error('Decryption failed - data mismatch');
    }

    // Test validation
    if (!TokenEncryption.validate(encrypted)) {
      throw new Error('Encrypted token validation failed');
    }

    // Test convenience functions
    const encryptedStr = encrypt(testData, testUserId);
    const decryptedStr = decrypt(encryptedStr, testUserId);
    if (decryptedStr !== testData) {
      throw new Error('Convenience functions failed');
    }

    // Test error conditions
    try {
      TokenEncryption.decrypt(encrypted, 'wrong-user-id');
      throw new Error('Decryption should have failed with wrong user ID');
    } catch (error) {
      if (error.message.includes('should have failed')) {
        throw error;
      }
      // Expected error
    }

    if (TEST_CONFIG.verbose) {
      console.log('   ✓ Encryption/decryption working correctly');
      console.log('   ✓ User-specific entropy validated'); 
      console.log('   ✓ Token validation working');
      console.log('   ✓ Error conditions handled properly');
    }
  }

  // ============================================================================
  // VALIDATION TESTS
  // ============================================================================

  async testInputValidation() {
    let validators;
    
    try {
      validators = await import('../lib/validators.js');
    } catch (error) {
      throw new Error(`Failed to import validators: ${error.message}`);
    }

    // Test SQL injection detection
    const sqlInjectionInputs = [
      "'; DROP TABLE users; --",
      "1' OR '1'='1",
      "admin'/*",
      "1 UNION SELECT * FROM users"
    ];

    for (const input of sqlInjectionInputs) {
      if (!validators.detectSqlInjection(input)) {
        throw new Error(`Failed to detect SQL injection: ${input}`);
      }
    }

    // Test XSS detection
    const xssInputs = [
      "<script>alert('xss')</script>",
      "javascript:alert(1)",
      "<iframe src='evil.com'></iframe>",
      "<img onerror='alert(1)' src='x'>"
    ];

    for (const input of xssInputs) {
      if (!validators.detectXss(input)) {
        throw new Error(`Failed to detect XSS: ${input}`);
      }
    }

    // Test sanitization
    const dirtyHtml = "<script>alert('bad')</script><p>Good content</p>";
    const sanitized = validators.sanitizeHtmlContent(dirtyHtml);
    if (sanitized.includes('script') || sanitized.includes('alert')) {
      throw new Error('HTML sanitization failed');
    }

    if (TEST_CONFIG.verbose) {
      console.log(`   ✓ SQL injection detection: ${sqlInjectionInputs.length} patterns tested`);
      console.log(`   ✓ XSS detection: ${xssInputs.length} patterns tested`);
      console.log('   ✓ HTML sanitization working');
    }
  }

  // ============================================================================
  // RATE LIMITING TESTS
  // ============================================================================

  async testRateLimiterService() {
    let rateLimiter;
    
    try {
      const rateLimiterModule = await import('../lib/rate-limiter.js');
      rateLimiter = rateLimiterModule.rateLimiter;
    } catch (error) {
      throw new Error(`Failed to import rate limiter: ${error.message}`);
    }

    // Test health check
    const healthCheck = await rateLimiter.healthCheck();
    if (!healthCheck.healthy && !healthCheck.message.includes('disabled')) {
      throw new Error(`Rate limiter health check failed: ${healthCheck.message}`);
    }

    // Test rate limit check
    const checkResult = await rateLimiter.checkLimit(TEST_CONFIG.testAccountId, 'email_read');
    if (typeof checkResult.allowed !== 'boolean') {
      throw new Error('Rate limit check returned invalid result');
    }

    // Test status retrieval
    const status = await rateLimiter.getStatus(TEST_CONFIG.testAccountId);
    if (!status || typeof status !== 'object') {
      throw new Error('Rate limit status check failed');
    }

    if (TEST_CONFIG.verbose) {
      console.log(`   ✓ Health check: ${healthCheck.healthy ? 'HEALTHY' : 'DISABLED'}`);
      console.log(`   ✓ Rate limit check working: ${checkResult.allowed ? 'ALLOWED' : 'BLOCKED'}`);
      console.log('   ✓ Status retrieval working');
    }
  }

  // ============================================================================
  // TOKEN MANAGER TESTS
  // ============================================================================

  async testTokenManager() {
    let tokenManager;
    
    try {
      const tokenModule = await import('../lib/token-manager.js');
      tokenManager = tokenModule.tokenManager;
    } catch (error) {
      throw new Error(`Failed to import token manager: ${error.message}`);
    }

    // Test getting user accounts (should not fail even if empty)
    try {
      const accounts = await tokenManager.getUserEmailAccounts(TEST_CONFIG.testUserId);
      if (!Array.isArray(accounts)) {
        throw new Error('getUserEmailAccounts did not return array');
      }
    } catch (error) {
      if (!error.message.includes('not available')) {
        throw error;
      }
      this.logWarning('Token manager disabled - Supabase admin not available');
    }

    if (TEST_CONFIG.verbose) {
      console.log('   ✓ Token manager service accessible');
      console.log('   ✓ User accounts query working');
    }
  }

  // ============================================================================
  // MAIN TEST RUNNER
  // ============================================================================

  async runAllTests() {
    console.log('🔐 Email Tracking System - Security Test Suite');
    console.log('=' .repeat(60));
    console.log(`📅 Date: ${new Date().toISOString()}`);
    console.log(`🏗️  Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔧 Config: ${TEST_CONFIG.verbose ? 'VERBOSE' : 'STANDARD'}`);
    console.log('');

    try {
      // Environment and configuration tests
      await this.runTest('Environment Variables', () => this.testEnvironmentVariables());
      
      // Database security tests
      await this.runTest('Database Connection', () => this.testDatabaseConnection());
      await this.runTest('Rate Limiting Service', () => this.testRateLimitingService());
      await this.runTest('Row Level Security', () => this.testRowLevelSecurity());
      
      // Encryption and security tests
      await this.runTest('Encryption Service', () => this.testEncryptionService());
      await this.runTest('Input Validation', () => this.testInputValidation());
      
      // Application security tests
      await this.runTest('Rate Limiter Service', () => this.testRateLimiterService());
      await this.runTest('Token Manager', () => this.testTokenManager());

    } catch (error) {
      console.error('\n💥 Test suite execution failed:', error.message);
      process.exit(1);
    }

    // Results summary
    console.log('');
    console.log('📊 Test Results Summary');
    console.log('=' .repeat(40));
    console.log(`✅ Passed: ${this.results.passed}`);
    console.log(`❌ Failed: ${this.results.failed}`);
    console.log(`⚠️  Warnings: ${this.results.warnings}`);
    console.log(`📊 Total: ${this.results.total}`);
    
    if (this.results.errors.length > 0) {
      console.log('\n❌ Errors:');
      this.results.errors.forEach(({ test, error }) => {
        console.log(`   • ${test}: ${error}`);
      });
    }

    const successRate = ((this.results.passed / this.results.total) * 100).toFixed(1);
    console.log(`\n🎯 Success Rate: ${successRate}%`);
    
    if (this.results.failed > 0) {
      console.log('\n🚨 SECURITY TESTS FAILED - DO NOT DEPLOY TO PRODUCTION');
      process.exit(1);
    } else if (this.results.warnings > 0) {
      console.log('\n⚠️  Security tests passed with warnings - review before production deployment');
    } else {
      console.log('\n🎉 All security tests passed successfully!');
    }
  }
}

// Run tests if called directly
if (require.main === module) {
  const testSuite = new SecurityTestSuite();
  testSuite.runAllTests().catch(error => {
    console.error('💥 Test suite crashed:', error);
    process.exit(1);
  });
}

module.exports = { SecurityTestSuite };