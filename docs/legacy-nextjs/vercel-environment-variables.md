# Vercel environment variables — Get Home Realty (LEGACY)

> ⚠️ Legacy Next.js/Vercel/MongoDB app. Does not describe `myapp`. See `README.md` in this folder.

Production app: **https://gethomerealty.vercel.app**

Add these in **Vercel → project → Settings → Environment Variables**. Enable **Production** (and
**Preview** if used). **Redeploy** after changes. Do not commit real secrets.

## App URLs (required) — no trailing slash
| Variable | Value |
|----------|--------|
| `NEXTAUTH_URL` | `https://gethomerealty.vercel.app` |
| `NEXT_PUBLIC_APP_URL` | `https://gethomerealty.vercel.app` |
| `NEXT_PUBLIC_BASE_URL` | `https://gethomerealty.vercel.app` |
| `NEXT_PUBLIC_APP_TWILIO_URL` | `https://gethomerealty.vercel.app` (or dedicated Twilio voice app URL) |

## Facebook / Meta (Lead Ads OAuth)
`FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN`, `FACEBOOK_WEBHOOK_SECRET` (optional).
Valid OAuth Redirect URIs (Meta → Facebook Login for Business → Settings):
```
http://localhost:3000/api/auth/facebook/callback
https://gethomerealty.vercel.app/api/auth/facebook/callback
```
App domains: `gethomerealty.vercel.app`. Optional `FACEBOOK_GRAPH_API_VERSION` (`v21.0` default).

## Auth & database
`MONGODB_URI`, `JWT_SECRET` (32+ chars), `NEXTAUTH_SECRET`, `CRON_SECRET`.

## Twilio
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `NEXT_PUBLIC_TWILIO_PHONE_NUMBER`,
`TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_TWIML_APP_SID`.

## Email (SMTP)
`SMTP_HOST` (`smtp.gmail.com`), `SMTP_PORT` (`587`), `SMTP_USER`, `SMTP_PASS` (app password),
`ADMIN_EMAIL`, `EMAIL_USER`, `EMAIL_PASSWORD`, `IMAP_HOST` (`imap.gmail.com`), `IMAP_PORT` (`993`),
`INVOICE_SMTP_USER`, `INVOICE_SMTP_PASS`.

## Agent branding (public)
`NEXT_PUBLIC_AGENT_EMAIL=info@gethomerealty.ca`, `NEXT_PUBLIC_AGENT_PHONE=+1 (905) 565-9933`,
`NEXT_PUBLIC_AGENT_NAME=Get Home Realty Team`.

## Google
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REDIRECT_URI=https://gethomerealty.vercel.app/api/auth/google-calendar/callback`,
`NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (restrict to domain).

## MLS & AI (optional)
`MLS_ACCESS_TOKEN`, `MLS_API_URL=https://query.ampre.ca/odata/Property`,
`NEXT_PUBLIC_GEMINI_API_KEY`, `NEXT_PUBLIC_OPENAI_API_KEY` (or `OPENAI_API_KEY` if server-only).

## Node
`NODE_ENV` — **do not add manually.** Vercel sets `production` at runtime. Setting it in the
dashboard before install can make `npm` skip devDependencies and break the build (PostCSS /
`tailwindcss` / `lucide-react`).

## Quick copy block (URLs only)
```env
NEXTAUTH_URL=https://gethomerealty.vercel.app
NEXT_PUBLIC_APP_URL=https://gethomerealty.vercel.app
NEXT_PUBLIC_BASE_URL=https://gethomerealty.vercel.app
NEXT_PUBLIC_APP_TWILIO_URL=https://gethomerealty.vercel.app
GOOGLE_REDIRECT_URI=https://gethomerealty.vercel.app/api/auth/google-calendar/callback
```

## After updating
1. Save all variables. 2. Redeploy latest. 3. Test Facebook connect at `/settings`.
4. Confirm the Facebook login URL contains `redirect_uri=...gethomerealty.vercel.app%2Fapi%2Fauth%2Ffacebook%2Fcallback`.
