#!/bin/bash

# Security Configuration Validator
# Email Tracking System - Quick Security Check
# Created: 2025-09-05 by security-engineer
# 
# Usage: ./scripts/validate-security.sh [--verbose]

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Verbose flag
VERBOSE=false
if [[ "$1" == "--verbose" ]]; then
    VERBOSE=true
fi

echo -e "${BLUE}🔐 Email Tracking System - Security Configuration Validator${NC}"
echo "=================================================================="
echo ""

# Check if .env.local exists
if [ ! -f ".env.local" ]; then
    echo -e "${RED}❌ .env.local file not found${NC}"
    exit 1
fi

echo -e "${GREEN}✅ .env.local file found${NC}"

# Source environment variables
source .env.local

# Critical environment variables check
CRITICAL_VARS=(
    "NEXT_PUBLIC_SUPABASE_URL"
    "NEXT_PUBLIC_SUPABASE_ANON_KEY" 
    "SUPABASE_SERVICE_ROLE_KEY"
    "ENCRYPTION_KEY"
    "JWT_SECRET"
    "MICROSOFT_CLIENT_ID"
    "MICROSOFT_CLIENT_SECRET"
    "MICROSOFT_REDIRECT_URI"
)

echo ""
echo -e "${BLUE}🔍 Checking Critical Environment Variables${NC}"
echo "------------------------------------------"

missing_vars=0
weak_vars=0

for var in "${CRITICAL_VARS[@]}"; do
    if [ -z "${!var}" ]; then
        echo -e "${RED}❌ $var is not set${NC}"
        ((missing_vars++))
    else
        echo -e "${GREEN}✅ $var is set${NC}"
        
        # Check for common weak patterns
        value="${!var}"
        if [[ "$var" == "ENCRYPTION_KEY" || "$var" == "JWT_SECRET" ]]; then
            if [ ${#value} -lt 32 ]; then
                echo -e "${YELLOW}   ⚠️  Warning: $var is less than 32 characters${NC}"
                ((weak_vars++))
            fi
            
            # Check for weak patterns
            if [[ "$value" =~ ^(dev_|test_|password|secret|key|123) ]]; then
                echo -e "${YELLOW}   ⚠️  Warning: $var appears to use a weak pattern${NC}"
                ((weak_vars++))
            fi
        fi
        
        # Check for placeholder values
        if [[ "$value" =~ (your_|placeholder|example|dev_.*_here) ]]; then
            echo -e "${YELLOW}   ⚠️  Warning: $var appears to be a placeholder${NC}"
            ((weak_vars++))
        fi
        
        if [ "$VERBOSE" = true ]; then
            # Show first/last 4 characters for verification
            if [ ${#value} -gt 8 ]; then
                preview="${value:0:4}...${value: -4}"
                echo -e "${BLUE}   📋 Preview: $preview${NC}"
            fi
        fi
    fi
done

echo ""

# Security files check
echo -e "${BLUE}🔍 Checking Security Implementation Files${NC}"
echo "---------------------------------------"

SECURITY_FILES=(
    "lib/encryption.ts"
    "lib/token-manager.ts"
    "lib/validators.ts" 
    "lib/audit-logger.ts"
    "middleware.ts"
    "scripts/test-security-basic.js"
)

missing_files=0
for file in "${SECURITY_FILES[@]}"; do
    if [ -f "$file" ]; then
        echo -e "${GREEN}✅ $file exists${NC}"
        if [ "$VERBOSE" = true ]; then
            lines=$(wc -l < "$file")
            echo -e "${BLUE}   📊 Lines: $lines${NC}"
        fi
    else
        echo -e "${RED}❌ $file is missing${NC}"
        ((missing_files++))
    fi
done

echo ""

# Rate limiting configuration check
echo -e "${BLUE}🔍 Checking Rate Limiting Configuration${NC}"
echo "--------------------------------------"

RATE_LIMIT_VARS=(
    "GRAPH_RATE_LIMIT_EMAIL_OPS"
    "GRAPH_RATE_LIMIT_WEBHOOKS"
    "GRAPH_RATE_LIMIT_BULK"
    "GRAPH_RATE_LIMIT_WINDOW_MINUTES"
)

for var in "${RATE_LIMIT_VARS[@]}"; do
    if [ -n "${!var}" ]; then
        value="${!var}"
        if [[ "$value" =~ ^[0-9]+$ ]]; then
            echo -e "${GREEN}✅ $var = $value${NC}"
        else
            echo -e "${YELLOW}⚠️  $var is not a valid number: $value${NC}"
            ((weak_vars++))
        fi
    else
        echo -e "${RED}❌ $var is not set${NC}"
        ((missing_vars++))
    fi
done

echo ""

# Package.json check
echo -e "${BLUE}🔍 Checking Security Dependencies${NC}"
echo "--------------------------------"

if [ -f "package.json" ]; then
    echo -e "${GREEN}✅ package.json found${NC}"
    
    # Check for security dependencies
    SECURITY_DEPS=("bcryptjs" "jsonwebtoken" "zod")
    
    for dep in "${SECURITY_DEPS[@]}"; do
        if grep -q "\"$dep\"" package.json; then
            version=$(grep "\"$dep\"" package.json | sed 's/.*".*": "\(.*\)".*/\1/')
            echo -e "${GREEN}✅ $dep: $version${NC}"
        else
            echo -e "${RED}❌ $dep not found${NC}"
            ((missing_files++))
        fi
    done
else
    echo -e "${RED}❌ package.json not found${NC}"
    ((missing_files++))
fi

echo ""

# Test execution
echo -e "${BLUE}🧪 Running Security Tests${NC}"
echo "------------------------"

if [ -f "scripts/test-security-basic.js" ]; then
    echo -e "${GREEN}✅ Security test script found${NC}"
    echo -e "${BLUE}Running basic security tests...${NC}"
    
    if [ "$VERBOSE" = true ]; then
        node scripts/test-security-basic.js
        test_result=$?
    else
        test_output=$(node scripts/test-security-basic.js 2>&1)
        test_result=$?
        
        if [ $test_result -eq 0 ]; then
            success_rate=$(echo "$test_output" | grep "Success Rate" | sed 's/.*Success Rate: \([0-9.]*\)%.*/\1/')
            echo -e "${GREEN}✅ Security tests passed (${success_rate}%)${NC}"
        else
            echo -e "${RED}❌ Security tests failed${NC}"
            if [ "$VERBOSE" = true ]; then
                echo "$test_output"
            fi
        fi
    fi
else
    echo -e "${RED}❌ Security test script not found${NC}"
    test_result=1
fi

echo ""

# Final summary
echo -e "${BLUE}📊 Security Configuration Summary${NC}"
echo "=================================="

total_issues=$((missing_vars + weak_vars + missing_files))

if [ $missing_vars -eq 0 ] && [ $weak_vars -eq 0 ] && [ $missing_files -eq 0 ] && [ $test_result -eq 0 ]; then
    echo -e "${GREEN}🎉 SECURITY CONFIGURATION COMPLETE${NC}"
    echo -e "${GREEN}✅ All critical variables configured${NC}"
    echo -e "${GREEN}✅ All security files present${NC}" 
    echo -e "${GREEN}✅ All security tests passing${NC}"
    echo ""
    echo -e "${GREEN}🚀 Ready for OAuth2 implementation by python-expert${NC}"
    exit 0
elif [ $missing_vars -gt 0 ] || [ $missing_files -gt 0 ] || [ $test_result -ne 0 ]; then
    echo -e "${RED}🚨 CRITICAL SECURITY ISSUES FOUND${NC}"
    echo -e "${RED}❌ Missing variables: $missing_vars${NC}"
    echo -e "${RED}❌ Missing files: $missing_files${NC}"
    echo -e "${RED}❌ Test failures: $test_result${NC}"
    echo ""
    echo -e "${RED}🛑 DO NOT PROCEED TO PRODUCTION${NC}"
    exit 1
else
    echo -e "${YELLOW}⚠️  SECURITY WARNINGS DETECTED${NC}"
    echo -e "${YELLOW}⚠️  Weak configurations: $weak_vars${NC}"
    echo ""
    echo -e "${YELLOW}🔧 Review configuration before production deployment${NC}"
    exit 0
fi