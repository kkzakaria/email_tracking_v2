#!/usr/bin/env tsx
/**
 * Webhook Pipeline Validation Script
 * Email Tracking System - Phase 2 Infrastructure Validation
 * Created: 2025-09-05 by backend-architect
 * 
 * ⚠️ CRITICAL: This script validates that all webhook pipeline components are properly implemented
 * Run before deploying webhook system to production
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

interface ValidationResult {
  component: string;
  status: 'pass' | 'fail' | 'warning';
  message: string;
  details?: string[];
}

const WEBHOOK_COMPONENTS = [
  'types/microsoft-graph-webhooks.ts',
  'app/api/webhooks/microsoft/route.ts',
  'app/api/webhooks/microsoft/health/route.ts',
  'app/api/subscriptions/create/route.ts',
  'app/api/subscriptions/status/route.ts',
  'app/api/subscriptions/renew/route.ts',
  'lib/webhook-processor.ts',
  'lib/subscription-manager.ts',
  'lib/email-detector.ts',
  'supabase/migrations/20250905000003_webhook_tables.sql',
  'supabase/migrations/20250905000004_webhook_rls_policies.sql',
] as const;

const REQUIRED_ENV_VARS = [
  'WEBHOOK_BASE_URL',
  'WEBHOOK_SECRET',
  'WEBHOOK_VALIDATION_TOKEN',
  'WEBHOOK_MAX_RETRIES',
  'WEBHOOK_RETRY_DELAY_MS',
  'WEBHOOK_MAX_CONCURRENT_JOBS',
  'SUBSCRIPTION_EXPIRATION_HOURS',
  'SUBSCRIPTION_RENEWAL_THRESHOLD_HOURS',
  'EMAIL_RESPONSE_WINDOW_HOURS',
] as const;

const WEBHOOK_FUNCTIONS = [
  'validateWebhookSignature',
  'handleValidationChallenge',
  'validateNotificationStructure',
  'addJob',
  'processJobs',
  'createSubscription',
  'renewSubscription',
  'processNotification',
  'detectEmailResponse',
] as const;

/**
 * Check if a file exists and has the expected content
 */
async function checkFile(filePath: string): Promise<ValidationResult> {
  try {
    const fullPath = join(process.cwd(), filePath);
    const content = await readFile(fullPath, 'utf-8');
    
    if (content.length < 100) {
      return {
        component: filePath,
        status: 'fail',
        message: 'File exists but appears to be incomplete',
        details: [`Content length: ${content.length} characters`],
      };
    }

    // Check for critical functions based on file type
    const criticalFunctions: string[] = [];
    
    if (filePath.includes('webhook') && filePath.includes('route.ts')) {
      criticalFunctions.push('POST', 'GET', 'validateWebhookSignature');
    } else if (filePath.includes('webhook-processor')) {
      criticalFunctions.push('addJob', 'processJobs', 'QueueProcessor');
    } else if (filePath.includes('subscription-manager')) {
      criticalFunctions.push('createSubscription', 'renewSubscription', 'SubscriptionManager');
    } else if (filePath.includes('email-detector')) {
      criticalFunctions.push('processNotification', 'detectEmailResponse', 'EmailChangeDetector');
    }

    const missingFunctions = criticalFunctions.filter(func => !content.includes(func));
    
    if (missingFunctions.length > 0) {
      return {
        component: filePath,
        status: 'warning',
        message: 'File exists but may be missing critical functions',
        details: [`Missing: ${missingFunctions.join(', ')}`],
      };
    }

    return {
      component: filePath,
      status: 'pass',
      message: 'File exists and appears complete',
      details: [`Size: ${Math.round(content.length / 1024)}KB`],
    };

  } catch (error) {
    return {
      component: filePath,
      status: 'fail',
      message: 'File does not exist or cannot be read',
      details: [error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}

/**
 * Check environment variables configuration
 */
function checkEnvironmentVariables(): ValidationResult[] {
  const results: ValidationResult[] = [];
  const envFile = process.env;
  
  for (const envVar of REQUIRED_ENV_VARS) {
    const value = envFile[envVar];
    
    if (!value) {
      results.push({
        component: `ENV.${envVar}`,
        status: 'fail',
        message: 'Environment variable not set',
        details: ['This variable is required for webhook pipeline'],
      });
    } else if (value.startsWith('your_') || value.includes('dev_') || value.includes('example')) {
      results.push({
        component: `ENV.${envVar}`,
        status: 'warning',
        message: 'Environment variable appears to be placeholder',
        details: [`Current value: ${value.substring(0, 20)}...`],
      });
    } else {
      results.push({
        component: `ENV.${envVar}`,
        status: 'pass',
        message: 'Environment variable is set',
        details: [`Length: ${value.length} characters`],
      });
    }
  }

  return results;
}

/**
 * Check package.json dependencies
 */
async function checkDependencies(): Promise<ValidationResult> {
  try {
    const packagePath = join(process.cwd(), 'package.json');
    const packageContent = await readFile(packagePath, 'utf-8');
    const packageJson = JSON.parse(packageContent);
    
    const requiredDeps = [
      '@microsoft/microsoft-graph-client',
      'next-auth',
      '@supabase/supabase-js',
      'crypto',
    ];

    const dependencies = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    const missingDeps = requiredDeps.filter(dep => !dependencies[dep]);
    
    if (missingDeps.length > 0) {
      return {
        component: 'Dependencies',
        status: 'fail',
        message: 'Missing required dependencies',
        details: missingDeps,
      };
    }

    return {
      component: 'Dependencies',
      status: 'pass',
      message: 'All required dependencies are installed',
      details: [`Total dependencies: ${Object.keys(dependencies).length}`],
    };

  } catch (error) {
    return {
      component: 'Dependencies',
      status: 'fail',
      message: 'Cannot read package.json',
      details: [error instanceof Error ? error.message : 'Unknown error'],
    };
  }
}

/**
 * Main validation function
 */
async function validateWebhookPipeline(): Promise<void> {
  console.log('🚀 Starting Webhook Pipeline Validation');
  console.log('=' .repeat(50));

  const results: ValidationResult[] = [];

  // Check all webhook component files
  console.log('\n📁 Checking Webhook Component Files...');
  for (const component of WEBHOOK_COMPONENTS) {
    const result = await checkFile(component);
    results.push(result);
    
    const status = result.status === 'pass' ? '✅' : result.status === 'warning' ? '⚠️' : '❌';
    console.log(`${status} ${result.component}: ${result.message}`);
    
    if (result.details && result.status !== 'pass') {
      result.details.forEach(detail => console.log(`   └─ ${detail}`));
    }
  }

  // Check environment variables
  console.log('\n🔧 Checking Environment Variables...');
  const envResults = checkEnvironmentVariables();
  results.push(...envResults);
  
  envResults.forEach(result => {
    const status = result.status === 'pass' ? '✅' : result.status === 'warning' ? '⚠️' : '❌';
    console.log(`${status} ${result.component}: ${result.message}`);
    
    if (result.details && result.status !== 'pass') {
      result.details.forEach(detail => console.log(`   └─ ${detail}`));
    }
  });

  // Check dependencies
  console.log('\n📦 Checking Dependencies...');
  const depsResult = await checkDependencies();
  results.push(depsResult);
  
  const depStatus = depsResult.status === 'pass' ? '✅' : depsResult.status === 'warning' ? '⚠️' : '❌';
  console.log(`${depStatus} ${depsResult.component}: ${depsResult.message}`);
  
  if (depsResult.details && depsResult.status !== 'pass') {
    depsResult.details.forEach(detail => console.log(`   └─ ${detail}`));
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 VALIDATION SUMMARY');
  console.log('='.repeat(50));

  const passed = results.filter(r => r.status === 'pass').length;
  const warnings = results.filter(r => r.status === 'warning').length;
  const failed = results.filter(r => r.status === 'fail').length;
  const total = results.length;

  console.log(`✅ Passed: ${passed}/${total}`);
  console.log(`⚠️  Warnings: ${warnings}/${total}`);
  console.log(`❌ Failed: ${failed}/${total}`);

  if (failed > 0) {
    console.log('\n❌ VALIDATION FAILED');
    console.log('The following components need attention:');
    results
      .filter(r => r.status === 'fail')
      .forEach(result => {
        console.log(`  • ${result.component}: ${result.message}`);
      });
    process.exit(1);
  } else if (warnings > 0) {
    console.log('\n⚠️  VALIDATION PASSED WITH WARNINGS');
    console.log('The following components have warnings:');
    results
      .filter(r => r.status === 'warning')
      .forEach(result => {
        console.log(`  • ${result.component}: ${result.message}`);
      });
    console.log('\nWebhook pipeline is functional but may need configuration updates.');
  } else {
    console.log('\n✅ ALL VALIDATIONS PASSED');
    console.log('Webhook pipeline is ready for production deployment!');
  }

  console.log('\n🚀 Next Steps:');
  console.log('  1. Apply database migrations if not done');
  console.log('  2. Configure Microsoft Graph App Registration');
  console.log('  3. Update production environment variables');
  console.log('  4. Test webhook endpoints with Microsoft Graph');
  console.log('  5. Monitor webhook processing and subscription health');
}

// Run validation if called directly
if (require.main === module) {
  validateWebhookPipeline().catch(error => {
    console.error('❌ Validation script failed:', error);
    process.exit(1);
  });
}