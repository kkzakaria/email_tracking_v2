# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an email tracking system designed to automatically track unanswered emails and send automated follow-ups. The project is built as a Next.js application using modern web technologies.

**Tech Stack:**

- Next.js 15.5.2 with App Router and Turbopack
- React 19.1.0 with TypeScript
- Tailwind CSS v4 with shadcn/ui components
- Planned integrations: Supabase (auth + database), Microsoft Graph API (email webhooks), Vercel (deployment)

## Development Commands

```bash
# Development server with Turbopack (faster than webpack)
pnpm dev

# Production build with Turbopack optimization  
pnpm build

# Start production server
pnpm start

# Run ESLint
pnpm lint
```

**Note:** This project uses `pnpm` as the package manager (evident from `pnpm-lock.yaml`).

## Architecture & Code Organization

### Directory Structure

```text
app/                    # Next.js App Router pages and layouts
├── layout.tsx         # Root layout with Geist fonts
├── page.tsx           # Home page (default Next.js starter)
├── globals.css        # Tailwind CSS with custom theme
└── favicon.ico        # App icon

components/
├── ui/                # shadcn/ui components
│   └── button.tsx     # Button component with variants

lib/
└── utils.ts           # Utility functions (cn helper for Tailwind)
```

### Styling Architecture

- **Tailwind CSS v4** with CSS-in-JS configuration in `globals.css`
- **shadcn/ui** component library with "New York" style variant
- **Design system** uses CSS custom properties for theming with light/dark mode support
- **Typography** leverages Geist Sans and Geist Mono fonts from Google Fonts

### Configuration Files

- `components.json` - shadcn/ui configuration with path aliases
- `tsconfig.json` - TypeScript config with path aliases (`@/*` points to root)
- `eslint.config.mjs` - ESLint with Next.js core-web-vitals and TypeScript rules
- `next.config.ts` - Next.js configuration (minimal setup)

## Path Aliases & Import Patterns

The project uses TypeScript path aliases defined in both `tsconfig.json` and `components.json`:

```typescript
import { cn } from "@/lib/utils"           // Utility functions
import Component from "@/components/ui/*"  // UI components
import { hook } from "@/hooks/*"           // Custom hooks (planned)
```

## Component Architecture

### UI Components (shadcn/ui)

- Components use **Radix UI** primitives for accessibility
- **Class Variance Authority (CVA)** for variant-based styling
- **Tailwind merge** utility for dynamic className composition
- Components follow the **compound component pattern** with `asChild` prop support

### Styling Patterns

- Tailwind classes with semantic color variables (`--primary`, `--secondary`, etc.)
- Focus states with ring utilities for accessibility
- Dark mode support through CSS custom properties

## Framework Specifics

### Next.js App Router

- Uses React Server Components by default
- File-based routing in `/app` directory  
- Layout.tsx provides root HTML structure and font loading

### TypeScript Configuration

- Strict mode enabled
- Path aliases configured for clean imports
- ESNext module resolution with bundler strategy

## Architecture Documentation

The system architecture has been designed and documented in the `claudedocs/` directory:

- **[System Architecture](./claudedocs/system-architecture.md)** - High-level system design, database schema, API structure, and component hierarchy
- **[Technical Implementation Guide](./claudedocs/technical-implementation-guide.md)** - 3-phase implementation roadmap with concrete code patterns
- **[Security & Compliance Guide](./claudedocs/security-compliance-guide.md)** - GDPR compliance, encryption, and security measures
- **[Deployment & Operations Guide](./claudedocs/deployment-operations-guide.md)** - CI/CD pipeline, monitoring, and operational procedures

### Key Architectural Decisions

**Database Design:**

- Supabase PostgreSQL with Row Level Security (RLS)
- Encrypted token storage for Microsoft Graph API
- Audit logging for compliance and security

**API Structure:**

- RESTful endpoints following Next.js App Router patterns
- Webhook processing for Microsoft Graph notifications
- Background job processing for follow-up automation

**Security Framework:**

- OAuth 2.0 with Microsoft Graph API
- End-to-end encryption for sensitive data
- GDPR-compliant data handling and user rights

## Implementation Phases

1. **Phase 1 (Weeks 1-2):** Authentication, basic email account management, core database schema
2. **Phase 2 (Weeks 3-5):** Email tracking engine, basic follow-up system, dashboard UI  
3. **Phase 3 (Weeks 6-8):** Advanced features, analytics, and performance optimization

## Development Guidelines

### Official Documentation Access

**IMPORTANT:** Always consult official documentation for each technology before implementation. Use the Context7 MCP server or web search to access current documentation:

```bash
# Use Context7 MCP server for official docs
/context7 next.js routing        # Next.js documentation
/context7 supabase auth          # Supabase authentication
/context7 microsoft graph api    # Microsoft Graph API
/context7 tailwind css           # Tailwind CSS documentation
/context7 react hooks            # React hooks documentation
```

**Key Documentation Sources:**

- **Next.js 15:** <https://nextjs.org/docs> - App Router patterns, API routes, middleware
- **Supabase:** <https://supabase.com/docs> - Authentication, database, real-time features
- **Microsoft Graph API:** <https://docs.microsoft.com/graph> - Email APIs, webhooks, OAuth
- **Tailwind CSS v4:** <https://tailwindcss.com/docs> - Latest syntax and features
- **shadcn/ui:** <https://ui.shadcn.com> - Component documentation and examples
- **TypeScript:** <https://typescriptlang.org/docs> - Type definitions and patterns

### Implementation Best Practices

1. **Always verify current API patterns** before implementing new features
2. **Check for breaking changes** in framework versions  
3. **Follow official authentication flows** for Microsoft Graph integration
4. **Use official Supabase client patterns** for database operations
5. **Reference latest Tailwind CSS syntax** for styling

## Current State

This is a fresh Next.js project with shadcn/ui setup and complete architecture documentation. The foundational setup includes one example UI component (Button) from shadcn/ui, ready for implementation following the documented architecture.
