#!/bin/bash

# Email Tracking System - Infrastructure Validation Script
# Created: 2025-09-05 by backend-architect
# Usage: ./scripts/validate-setup.sh

echo "🔧 Email Tracking System - Infrastructure Validation"
echo "=================================================="

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Supabase CLI is installed
echo -n "📦 Checking Supabase CLI... "
if command -v supabase &> /dev/null; then
    echo -e "${GREEN}✅ Installed$(tput sgr0)"
else
    echo -e "${RED}❌ Not installed$(tput sgr0)"
    echo "   Install with: npm install -g @supabase/cli"
    exit 1
fi

# Check if Supabase is running
echo -n "🚀 Checking Supabase status... "
if supabase status &> /dev/null; then
    echo -e "${GREEN}✅ Running$(tput sgr0)"
else
    echo -e "${YELLOW}⚠️  Not running$(tput sgr0)"
    echo "   Starting Supabase..."
    supabase start
fi

# Check if environment variables are set
echo -n "🔧 Checking environment variables... "
if [ -f ".env.local" ]; then
    echo -e "${GREEN}✅ .env.local exists$(tput sgr0)"
    
    # Check critical variables
    missing_vars=()
    
    if ! grep -q "NEXT_PUBLIC_SUPABASE_URL" .env.local; then
        missing_vars+=("NEXT_PUBLIC_SUPABASE_URL")
    fi
    
    if ! grep -q "NEXT_PUBLIC_SUPABASE_ANON_KEY" .env.local; then
        missing_vars+=("NEXT_PUBLIC_SUPABASE_ANON_KEY")
    fi
    
    if ! grep -q "SUPABASE_SERVICE_ROLE_KEY" .env.local; then
        missing_vars+=("SUPABASE_SERVICE_ROLE_KEY")
    fi
    
    if [ ${#missing_vars[@]} -gt 0 ]; then
        echo -e "${YELLOW}⚠️  Missing variables:$(tput sgr0)"
        for var in "${missing_vars[@]}"; do
            echo "     - $var"
        done
    else
        echo -e "   ${GREEN}✅ All critical variables present$(tput sgr0)"
    fi
else
    echo -e "${RED}❌ .env.local not found$(tput sgr0)"
    echo "   Copy .env.example to .env.local and configure"
    exit 1
fi

# Check if project builds
echo -n "🏗️  Checking build... "
if pnpm build &> /dev/null; then
    echo -e "${GREEN}✅ Build successful$(tput sgr0)"
else
    echo -e "${RED}❌ Build failed$(tput sgr0)"
    echo "   Run 'pnpm build' for details"
    exit 1
fi

# Run Supabase infrastructure tests if possible
echo "🧪 Running infrastructure tests..."
if [ -f "scripts/test-supabase.js" ]; then
    node scripts/test-supabase.js
else
    echo -e "${YELLOW}⚠️  Test script not found, skipping$(tput sgr0)"
fi

echo ""
echo -e "${GREEN}🎉 Infrastructure validation completed!$(tput sgr0)"
echo ""
echo "Next steps:"
echo "  1. Configure Microsoft Graph credentials in .env.local"
echo "  2. Run 'pnpm dev' to start development server"
echo "  3. Access Supabase Studio at: http://127.0.0.1:54323"
echo ""
echo -e "${GREEN}Ready for development! 🚀$(tput sgr0)"