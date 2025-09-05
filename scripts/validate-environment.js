/**
 * Environment Validation Script
 * Email Tracking System - Environment Setup Validation
 * Created: 2025-09-05
 * 
 * Simple Node.js script to validate environment configuration
 * without TypeScript dependencies
 */

require('dotenv').config({ path: '.env.local' });

function validateEnvironment() {
  console.log('🔍 Validating Microsoft OAuth2 Environment Configuration');
  console.log('=' .repeat(70));
  
  let allValid = true;
  const errors = [];

  // Required environment variables
  const requiredVars = [
    // Supabase
    { name: 'NEXT_PUBLIC_SUPABASE_URL', description: 'Supabase URL' },
    { name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY', description: 'Supabase Anonymous Key' },
    { name: 'SUPABASE_SERVICE_ROLE_KEY', description: 'Supabase Service Role Key' },
    
    // Microsoft OAuth2
    { name: 'MICROSOFT_CLIENT_ID', description: 'Microsoft Client ID' },
    { name: 'MICROSOFT_CLIENT_SECRET', description: 'Microsoft Client Secret' },
    { name: 'MICROSOFT_SCOPES', description: 'Microsoft API Scopes' },
    
    // NextAuth
    { name: 'NEXTAUTH_URL', description: 'NextAuth URL' },
    { name: 'NEXTAUTH_SECRET', description: 'NextAuth Secret' },
    
    // Security
    { name: 'ENCRYPTION_KEY', description: 'Encryption Key' },
    { name: 'JWT_SECRET', description: 'JWT Secret' },
  ];

  console.log('📋 Checking required environment variables:\n');

  for (const { name, description } of requiredVars) {
    const value = process.env[name];
    
    if (!value) {
      console.log(`❌ ${name} (${description}): MISSING`);
      errors.push(`${name} is required but not set`);
      allValid = false;
    } else if (value.includes('your_') || value.includes('_here')) {
      console.log(`⚠️  ${name} (${description}): PLACEHOLDER VALUE`);
      errors.push(`${name} contains placeholder value, replace with actual credentials`);
      allValid = false;
    } else if (name.includes('SECRET') || name.includes('KEY')) {
      if (value.length < 32) {
        console.log(`⚠️  ${name} (${description}): TOO SHORT (${value.length} chars, minimum 32)`);
        errors.push(`${name} should be at least 32 characters long for security`);
        allValid = false;
      } else {
        console.log(`✅ ${name} (${description}): OK (${value.length} chars)`);
      }
    } else {
      console.log(`✅ ${name} (${description}): OK`);
    }
  }

  // Validate specific formats
  console.log('\n🔍 Validating specific formats:\n');

  // Validate URLs
  const urlVars = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXTAUTH_URL'];
  for (const name of urlVars) {
    const value = process.env[name];
    if (value) {
      try {
        new URL(value);
        console.log(`✅ ${name}: Valid URL format`);
      } catch (error) {
        console.log(`❌ ${name}: Invalid URL format`);
        errors.push(`${name} is not a valid URL`);
        allValid = false;
      }
    }
  }

  // Validate Microsoft Client ID (should be UUID format)
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  if (clientId && !clientId.includes('your_')) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRegex.test(clientId)) {
      console.log(`✅ MICROSOFT_CLIENT_ID: Valid UUID format`);
    } else {
      console.log(`⚠️  MICROSOFT_CLIENT_ID: Not a valid UUID format (might be valid but uncommon)`);
    }
  }

  // Validate Microsoft Scopes
  const scopes = process.env.MICROSOFT_SCOPES;
  if (scopes && !scopes.includes('your_')) {
    const requiredScopes = ['User.Read', 'Mail.Read'];
    const hasRequired = requiredScopes.every(scope => scopes.includes(scope));
    
    if (hasRequired) {
      console.log(`✅ MICROSOFT_SCOPES: Contains required scopes`);
    } else {
      console.log(`❌ MICROSOFT_SCOPES: Missing required scopes (User.Read, Mail.Read)`);
      errors.push('MICROSOFT_SCOPES must include User.Read and Mail.Read');
      allValid = false;
    }
  }

  // Validate environment consistency
  console.log('\n🔧 Checking environment consistency:\n');

  const nextAuthUrl = process.env.NEXTAUTH_URL;
  const microsoftRedirectUri = process.env.MICROSOFT_REDIRECT_URI;
  
  if (nextAuthUrl && microsoftRedirectUri) {
    if (microsoftRedirectUri.startsWith(nextAuthUrl)) {
      console.log(`✅ Microsoft redirect URI is consistent with NextAuth URL`);
    } else {
      console.log(`⚠️  Microsoft redirect URI domain doesn't match NextAuth URL`);
    }
  }

  // Summary
  console.log('\n' + '=' .repeat(70));
  console.log('📊 VALIDATION SUMMARY');
  console.log('=' .repeat(70));

  if (allValid) {
    console.log('🎉 ALL VALIDATIONS PASSED!');
    console.log('\n✅ Your environment is configured correctly for Microsoft OAuth2.');
    console.log('\n📝 Next steps:');
    console.log('1. Ensure your Azure App Registration has the correct redirect URI');
    console.log('2. Grant admin consent for the API permissions');
    console.log('3. Start your development server: pnpm dev');
    console.log('4. Test the authentication flow');
    
    return true;
  } else {
    console.log(`❌ ${errors.length} VALIDATION ERROR${errors.length > 1 ? 'S' : ''} FOUND`);
    console.log('\n🚨 Issues to fix:');
    errors.forEach((error, index) => {
      console.log(`  ${index + 1}. ${error}`);
    });
    
    console.log('\n🛠️  How to fix:');
    console.log('1. Copy .env.example to .env.local if you haven\'t already');
    console.log('2. Replace all placeholder values with actual credentials');
    console.log('3. Ensure all secrets are at least 32 characters long');
    console.log('4. Set up Microsoft Azure App Registration:');
    console.log('   - Go to https://portal.azure.com');
    console.log('   - Navigate to Azure Active Directory > App registrations');
    console.log('   - Create new registration or use existing');
    console.log('   - Add redirect URI: http://localhost:3000/api/auth/callback/microsoft');
    console.log('   - Add API permissions: User.Read, Mail.Read, Mail.Send, MailboxSettings.ReadWrite');
    console.log('   - Generate client secret');
    console.log('   - Copy Application (client) ID and client secret to .env.local');

    return false;
  }
}

// Test database connection (simplified)
async function testDatabaseConnection() {
  console.log('\n🔌 Testing Supabase Connection...');
  
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    
    if (!supabaseUrl || !supabaseKey) {
      console.log('❌ Supabase credentials not configured');
      return false;
    }

    // Simple HTTP request to test connection
    const response = await fetch(`${supabaseUrl}/rest/v1/`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      }
    });

    if (response.status === 200) {
      console.log('✅ Supabase connection successful');
      return true;
    } else {
      console.log(`❌ Supabase connection failed with status: ${response.status}`);
      return false;
    }
  } catch (error) {
    console.log(`❌ Supabase connection failed: ${error.message}`);
    return false;
  }
}

// Run validation
async function main() {
  const envValid = validateEnvironment();
  
  if (envValid) {
    const dbConnected = await testDatabaseConnection();
    
    if (dbConnected) {
      console.log('\n🚀 Environment validation complete - Ready for development!');
      process.exit(0);
    } else {
      console.log('\n⚠️  Environment valid but database connection failed');
      console.log('Make sure Supabase is running: pnpm db:start');
      process.exit(1);
    }
  } else {
    process.exit(1);
  }
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('\n💥 Unhandled Promise Rejection:', error.message);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('\n💥 Uncaught Exception:', error.message);
  process.exit(1);
});

// Run validation
main().catch((error) => {
  console.error('\n💥 Validation failed:', error.message);
  process.exit(1);
});