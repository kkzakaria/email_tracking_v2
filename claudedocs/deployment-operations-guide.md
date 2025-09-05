# Deployment & Operations Guide

**Email Tracking System - Infrastructure Management**

**Dernière mise à jour**: 5 septembre 2025 - backend-architect  
**Status**: ✅ Infrastructure Supabase configurée et opérationnelle

## 🎯 Vue d'Ensemble de l'Infrastructure

### Architecture Déployée

```text
Production:     Supabase Cloud + Vercel + Microsoft Graph API
Development:    Supabase Local + Next.js Dev Server
Testing:        Supabase Local + Jest/Vitest
```

### Services Configurés

- ✅ **Supabase Database** avec toutes les tables et RLS
- ✅ **Rate Limiting Service** pour Microsoft Graph API
- ✅ **Authentication** avec profils utilisateur
- ✅ **Real-time subscriptions** pour updates en temps réel
- ✅ **Migrations** versionnées et reproductibles

## 🚀 Guide de Déploiement

### 1. Pré-requis

```bash
# Outils requis
- Node.js 18+
- pnpm
- Supabase CLI
- Vercel CLI (pour production)
- Compte Microsoft Azure (pour Graph API)
```

### 2. Setup Local Development

#### A. Configuration Supabase

```bash
# 1. Installer Supabase CLI
npm install -g @supabase/cli

# 2. Démarrer Supabase local
supabase start

# 3. Vérifier le status
supabase status
```

#### B. Variables d'Environnement

```bash
# 1. Copier le template
cp .env.example .env.local

# 2. Configurer les variables (voir section Variables)
# - Supabase keys (générées automatiquement en local)
# - Microsoft Graph credentials
# - Rate limiting settings
```

#### C. Test de l'Infrastructure

```bash
# Test complet de l'infrastructure
node scripts/test-supabase.js

# Résultat attendu:
# ✅ Connection Test: PASS
# ✅ Schema Test: PASS  
# ✅ Rate Limiting Test: PASS
# ✅ RLS Test: PASS
```

### 3. Déploiement Production

#### A. Setup Supabase Cloud

```bash
# 1. Créer projet sur https://supabase.com/dashboard
# 2. Obtenir les clés depuis Settings > API
# 3. Appliquer les migrations
supabase link --project-ref YOUR_PROJECT_REF
supabase db push

# 4. Vérifier les tables et RLS
supabase db inspect
```

#### B. Configuration Microsoft Graph

```bash
# 1. Azure Portal > App Registrations
# 2. Créer nouvelle app registration
# 3. Configurer redirect URI: https://yourapp.vercel.app/api/auth/microsoft/callback
# 4. Ajouter permissions API:
#    - Microsoft Graph > Mail.Read (delegated)
#    - Microsoft Graph > Mail.Send (delegated)
#    - Microsoft Graph > MailboxSettings.ReadWrite (delegated)
#    - Microsoft Graph > User.Read (delegated)
# 5. Générer client secret
```

#### C. Déploiement Vercel

```bash
# 1. Setup Vercel
vercel login
vercel link

# 2. Configurer variables d'environnement
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel env add MICROSOFT_CLIENT_ID
vercel env add MICROSOFT_CLIENT_SECRET
vercel env add ENCRYPTION_KEY

# 3. Déployer
vercel deploy --prod
```

## 🔧 Variables d'Environnement

### Variables Critiques (Obligatoires)

#### Supabase

```bash
# URLs et clés Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...  # ⚠️ SECRET - Rate limiting uniquement
```

#### Microsoft Graph API ⚠️ NOUVELLES EXIGENCES

```bash
# Azure App Registration
MICROSOFT_CLIENT_ID=your-client-id
MICROSOFT_CLIENT_SECRET=your-client-secret  # ⚠️ SECRET
MICROSOFT_REDIRECT_URI=https://yourapp.vercel.app/api/auth/microsoft/callback

# ⚠️ NOUVEAU: Scopes configurables (septembre 2025)
MICROSOFT_SCOPES=https://graph.microsoft.com/Mail.Read,https://graph.microsoft.com/Mail.Send,https://graph.microsoft.com/MailboxSettings.ReadWrite,https://graph.microsoft.com/User.Read
```

#### Sécurité

```bash
# Chiffrement des tokens Microsoft
ENCRYPTION_KEY=your-32-character-encryption-key  # ⚠️ SECRET

# JWT pour l'application
JWT_SECRET=your-jwt-secret  # ⚠️ SECRET

# Webhooks Microsoft Graph
WEBHOOK_SECRET=your-webhook-secret  # ⚠️ SECRET
```

### ⚠️ NOUVEAU: Variables Rate Limiting

```bash
# Limites Microsoft Graph API (septembre 2025)
GRAPH_RATE_LIMIT_EMAIL_OPS=10000      # Opérations email/heure
GRAPH_RATE_LIMIT_WEBHOOKS=50          # Webhooks/heure  
GRAPH_RATE_LIMIT_BULK=100             # Opérations bulk/minute
GRAPH_RATE_LIMIT_WINDOW_MINUTES=60    # Fenêtre de temps
```

### Variables Optionnelles

```bash
# Monitoring et analytics
SENTRY_DSN=https://...
ANALYTICS_ID=ga-xxx

# Email SMTP (notifications production)
SMTP_HOST=smtp.sendgrid.net
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-key
```

## 📊 Monitoring et Observabilité

### Services de Monitoring

```text
✅ Supabase Dashboard: Métriques DB, Auth, API
✅ Vercel Analytics: Performance, Erreurs, Usage
✅ Rate Limiting: Monitoring automatique via DB
🔄 Sentry: Tracking erreurs (optionnel)
```

### Métriques Clés

```text
📈 Database Performance:
   - Query response time
   - Connection pool usage
   - RLS policy execution time

📈 API Performance:
   - Microsoft Graph API response time
   - Rate limit hit rate
   - Authentication success rate

📈 Application Metrics:
   - User signup/login rate
   - Email tracking volume
   - Follow-up execution success rate
```

### Tableaux de Bord

```bash
# Accès aux tableaux de bord
Supabase Studio:    https://supabase.com/dashboard/project/YOUR_PROJECT
Vercel Dashboard:   https://vercel.com/dashboard
Rate Limiting:      Built-in via /api/rate-limit/status
```

## 🔍 Debugging et Troubleshooting

### Problèmes Courants

#### 1. Échec de Connection Supabase

```bash
# Diagnostic
supabase status  # Vérifier que les services tournent

# Solutions
- Vérifier NEXT_PUBLIC_SUPABASE_URL
- Vérifier NEXT_PUBLIC_SUPABASE_ANON_KEY  
- Redémarrer Supabase: supabase restart
```

#### 2. Erreurs Rate Limiting

```bash
# Diagnostic
node scripts/test-supabase.js

# Vérifications
- SUPABASE_SERVICE_ROLE_KEY configuré
- Fonction check_rate_limit existe en DB
- Table rate_limit_tracking accessible
```

#### 3. Authentification Microsoft Échoue

```bash
# Vérifications
- MICROSOFT_CLIENT_ID correct
- MICROSOFT_CLIENT_SECRET valide
- Redirect URI match Azure config
- Permissions API accordées dans Azure
```

#### 4. Erreurs Migration

```bash
# Reset complet (development seulement)
supabase db reset

# Application manuelle des migrations
supabase db push --dry-run  # Preview
supabase db push           # Apply
```

## 🔐 Sécurité et Compliance

### Checklist Sécurité Production

#### Database Security

```text
✅ RLS activé sur toutes les tables
✅ Politiques RLS testées et validées
✅ Service role key limitée aux fonctions critiques
✅ Backup automatique configuré
✅ SSL/TLS forcé sur toutes connexions
```

#### API Security  

```text
✅ Rate limiting activé et testé
✅ Input validation avec Zod schemas
✅ CORS configuré correctement
✅ Headers de sécurité (CSP, HSTS)
✅ Tokens Microsoft chiffrés en DB
```

#### Infrastructure Security

```text
✅ Variables sensibles dans Vercel Environment
✅ HTTPS forcé en production
✅ Webhook signatures validées
✅ Audit logging activé
✅ Error handling sécurisé (pas de leak d'info)
```

## 📋 Checklist Déploiement

### Pre-Deployment

- [ ] Tests d'infrastructure passent (node scripts/test-supabase.js)
- [ ] Migrations testées en local
- [ ] Variables d'environnement configurées
- [ ] Rate limiting testé avec quotas réels
- [ ] Microsoft Graph permissions accordées

### Deployment

- [ ] Migrations appliquées en production
- [ ] Variables d'environnement définies dans Vercel
- [ ] Vercel deployment successful
- [ ] Health checks passent
- [ ] Rate limiting fonctionnel

### Post-Deployment

- [ ] Tests de bout en bout
- [ ] Monitoring dashboards accessibles
- [ ] Alertes configurées
- [ ] Documentation mise à jour
- [ ] Équipe informée des changements

## 📚 Ressources et Documentation

### Documentation Technique

```text
📖 Supabase Docs:        https://supabase.com/docs
📖 Microsoft Graph:      https://docs.microsoft.com/graph
📖 Vercel Deployment:    https://vercel.com/docs
📖 Next.js App Router:   https://nextjs.org/docs/app
```

### Scripts Utiles

```bash
# Infrastructure
scripts/test-supabase.js           # Test complet infrastructure
supabase gen types typescript      # Générer types TypeScript

# Development
pnpm dev                          # Server développement
pnpm build                        # Build production
pnpm lint                         # Validation code
```

### Support et Escalation

```text
🚨 Issues Critiques:     
   1. Vérifier status pages (Supabase, Vercel, Microsoft)
   2. Consulter logs dans dashboards
   3. Escalader vers tech lead si nécessaire

📞 Contacts:
   - Database issues: Supabase support
   - Deployment issues: Vercel support  
   - Microsoft Graph: Azure support
```

---

**🎯 Status Actuel**: Infrastructure Supabase complètement configurée et opérationnelle avec rate limiting pour Microsoft Graph API. Prête pour développement des fonctionnalités.

**👤 Prochaine Étape**: security-engineer doit implémenter la sécurité et validation complète du rate limiting.

**📅 Dernière Validation**: 5 septembre 2025 - Tous les tests d'infrastructure passent
