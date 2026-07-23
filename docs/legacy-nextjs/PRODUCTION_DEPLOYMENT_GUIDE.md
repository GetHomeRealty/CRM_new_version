# Production Deployment Guide — Get Home Realty (LEGACY Next.js/Vercel)

> ⚠️ Legacy Next.js/Vercel/MongoDB app. Does not describe `myapp`. See `README.md` in this folder.
> `myapp` is NestJS + Postgres, self-hosted — none of the Vercel/Mongo/Puppeteer steps below apply.

Step-by-step checklist to take the legacy app from local dev to production on **Vercel** with
**MongoDB Atlas**, **Twilio**, **Google APIs**, and supporting services.

## 1. Prerequisites
- GitHub repo with latest code pushed
- Vercel account (Pro recommended for cron + longer timeouts)
- MongoDB Atlas account
- Twilio account (SMS/Voice)
- Google Cloud project (Calendar OAuth + Maps)
- Gmail (or SMTP provider) for transactional email
- (Optional) Meta Developer account; Google AI Studio key
- Node.js 18+ and `openssl` locally

## 2. Step 1 — Secure the Repository
- Verify `.gitignore` blocks `.env`, `.env.local`, `.env.*.local`, `vercel.env`, `production.env`, `uat.env`.
- Rotate any previously-committed secrets (Mongo password, Twilio token/API secret, JWT/NextAuth secrets, email app passwords, Google OAuth secret, MLS token, Facebook app secret).
- Purge secrets from git history with git-filter-repo / BFG if they were ever committed:
  ```bash
  git log --all --diff-filter=A -- "vercel.env" ".env"
  ```

## 3. Step 2 — Provision MongoDB Atlas (Production)
- New project `gethomerealty-prod`; cluster M10+ (not M0) in the region matching Vercel.
- Database Access → user with readWrite; save the strong password.
- Network Access → `0.0.0.0/0` (Vercel dynamic IPs), or Private Endpoints on Enterprise.
- Connect → Drivers → copy `mongodb+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/<dbname>?retryWrites=true&w=majority`.
- Recommended indexes after first deploy:
  ```javascript
  db.transactions.createIndex({ assignedTo: 1 })
  db.transactions.createIndex({ transactionType: 1 })
  db.transactions.createIndex({ serialNo: -1 })
  db.leads.createIndex({ assignedTo: 1 })
  db.leads.createIndex({ email: 1 })
  db.users.createIndex({ email: 1 }, { unique: true })
  ```

## 4. Step 3 — Generate Security Secrets
```bash
openssl rand -base64 32   # JWT_SECRET
openssl rand -base64 32   # NEXTAUTH_SECRET
openssl rand -base64 32   # CRON_SECRET
```
Do not reuse the same value.

## 5. Step 4 — Configure Third-Party Services
- **Twilio:** Account SID + Auth Token; buy E.164 number; TwiML App SID; API Key + Secret; set Voice URL `.../api/twilio/voice`, SMS webhook `.../api/twilio/incoming-sms`.
- **Email:** dedicated Gmail, 2FA on, App Password (16 chars). Optional 2nd mailbox for invoices.
- **Google Calendar OAuth:** enable Calendar API; OAuth Client ID (Web); redirect `.../api/auth/google-calendar/callback`.
- **Google Maps:** enable Maps JavaScript + Geocoding; API key restricted to domain.
- **MLS (AMPRE):** vendor token from AMPRE/TRREB; endpoint `https://query.ampre.ca/odata/Property`.
- **AI (optional):** Gemini via AI Studio; OpenAI via dashboard.
- **Facebook (optional):** Business app → App ID + Secret; webhooks.

## 6. Step 5 — Set Up Vercel Project
- Add New → Project → import repo; Vercel auto-detects Next.js.
- Build: framework Next.js, `npm run build`, output `.next`, install `npm install`, Node 18.x/20.x.
- Root directory `/`.

## 7. Step 6 — Configure Vercel Environment Variables
Project Settings → Environment Variables → add for **Production** (reference `config/env/production.env.example`).

Required: `NODE_ENV`, `MONGODB_URI`, `JWT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `CRON_SECRET`,
`NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_URL`, all `TWILIO_*` + `NEXT_PUBLIC_TWILIO_PHONE_NUMBER`,
`NEXT_PUBLIC_APP_TWILIO_URL`, email (`EMAIL_*`, `SMTP_*`, `IMAP_*`, `ADMIN_EMAIL`), `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`,
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`, `MLS_ACCESS_TOKEN`, `MLS_API_URL`, `NEXT_PUBLIC_GEMINI_API_KEY`.

Optional: `NEXT_PUBLIC_OPENAI_API_KEY`, `FACEBOOK_*`, `INVOICE_SMTP_*`, `NEXT_PUBLIC_AGENT_*`.

## 8. Step 7 — Deploy to Vercel
- Deploy (or push to `main`); Vercel runs install → build → deploy (~2–5 min).
- Build-time `NEXT_PUBLIC_*` vars must be set before build.

## 9. Step 8 — Post-Deploy Verification
- Core: login, dashboard, user creation (welcome email), leads, transactions, **MLS search returns results**.
- Comms: test SMS, test email, test voice call.
- Docs/PDFs: invoice PDF, Notice of Sale, document upload.
- Integrations: Google Calendar sync, Maps autocomplete, Facebook webhook.
- Crons: trigger each endpoint.

## 10. Step 9 — Domain & SSL
- Project Settings → Domains → add domain; set DNS records; Vercel auto-provisions SSL.
- After the custom domain, update `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_BASE_URL`, `NEXTAUTH_URL`,
  `NEXT_PUBLIC_APP_TWILIO_URL`, `GOOGLE_REDIRECT_URI`, plus Twilio webhooks, Google OAuth redirect,
  Facebook webhook URL. Redeploy.

## 11. Step 10 — Cron Jobs (Vercel)
Defined in `vercel.json` (Vercel Pro required):
- `/api/cron/document-reminders` — daily 9am UTC
- `/api/cron/send-client-review-emails` — daily 10am UTC
- `/api/cron/lawyer-details-reminders` — Tue & Fri 9am UTC
- `/api/cron/void-cheque-reminders` — daily 9am UTC
- `/api/cron/listing-expiry-reminders` — daily 9am UTC

Endpoints validate `Authorization: Bearer <CRON_SECRET>`. Test:
```bash
curl -X POST https://your-domain.com/api/cron/document-reminders -H "Authorization: Bearer YOUR_CRON_SECRET"
```

## 12. Step 11 — Puppeteer / PDF on Vercel
Lambda has no Chromium. Use `@sparticuz/chromium` + `puppeteer-core`:
```typescript
import chromium from '@sparticuz/chromium'
import puppeteerCore from 'puppeteer-core'
const browser = await puppeteerCore.launch({
  args: chromium.args, defaultViewport: chromium.defaultViewport,
  executablePath: await chromium.executablePath(), headless: chromium.headless,
})
```
Per PDF route: `export const maxDuration = 60` and `export const dynamic = 'force-dynamic'`.

## 13. Step 12 — Monitoring & Logging
Vercel Analytics + Function logs; add UptimeRobot / Sentry / Datadog / Better Stack; Atlas alerts.

## 14. Step 13 — Security Hardening
Secrets only in env vars; `NEXT_PUBLIC_*` contains no secrets; JWT 32+ chars; bcrypt passwords;
minimal Mongo user; cron secret validation; security headers in `next.config.js`
(`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`); rate-limit public routes.

## 15. Step 14 — Backup & DR
Atlas M10+ automated backups (test restore). **File uploads under `public/uploads/` are ephemeral on
Vercel** — migrate to Vercel Blob / S3 / R2 (critical, else uploads vanish on redeploy). Protect `main`, tag releases.

## 16. Step 15 — Go-Live Checklist
Infra (M10+ backups, Vercel Pro, domain+SSL, DNS), env (all vars, `NODE_ENV=production`, prod URLs,
OAuth redirects), third-party (Twilio/Google/Facebook webhooks on prod domain, MLS token valid),
app (build ok, login, SMS/email/voice, PDFs, crons, persistent uploads), security (rotated secrets,
no secrets in `NEXT_PUBLIC_*`, headers, strong admin password), monitoring (uptime, error tracking, Atlas alerts).

## Appendix B — Troubleshooting
- **Build "Module not found"** — runtime deps must be in `dependencies`; prefer `puppeteer-core` + `@sparticuz/chromium`.
- **"MONGODB_URI is not defined"** — case-sensitive; set for Production env.
- **Emails not sending** — regenerate Gmail App Password after password changes; check SMTP vars/logs.
- **Crons not running** — Vercel Pro required; valid `vercel.json`.
- **Uploads disappear** — Vercel FS is ephemeral; move to Blob/S3/R2.
- **PDF timeouts** — raise `maxDuration`; use `@sparticuz/chromium`.

*Last updated: April 2026 (legacy).*
