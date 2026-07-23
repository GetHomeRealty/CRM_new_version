# Environment Keys & Setup (Production + UAT)

> ⚠️ Legacy Next.js/Vercel/MongoDB app. Does not describe `myapp`. See `README.md` in this folder.

This doc explains:
1. How to create `production.env` / `uat.env` from the `*.env.example` templates.
2. Where to get each third-party key/secret.
3. What values must be different between Production and UAT.

## 1) Create env files

Use these templates (under **`config/env/`**):
- `config/env/production.env.example` — copy to **`production.env`** in the project root (gitignored)
- `config/env/uat.env.example` — copy to **`uat.env`** in the project root (gitignored)
- `config/env/vercel.env.example` — copy to **`vercel.env`** in the project root (gitignored) or paste values into the Vercel dashboard

Do **not** commit real secrets to git.

For Vercel: set environment variables in the Vercel dashboard instead of committing `production.env`.

## 2) Generate security secrets

Run this locally:

```bash
openssl rand -base64 32
```

Use the output for:
- `JWT_SECRET`
- `NEXTAUTH_SECRET`
- `CRON_SECRET`

## 3) Where to get each key/secret

### MongoDB Atlas
- Go to MongoDB Atlas -> your cluster -> **Connect** -> **Drivers** -> **connection string**
- Set `MONGODB_URI`

UAT:
- Either use a separate Atlas cluster/database or a separate DB name in the same cluster.
- Keep the same app code; just change `MONGODB_URI`.

### Twilio (SMS + Voice)
- Twilio Console -> Account
  - `TWILIO_ACCOUNT_SID` (Account SID)
  - `TWILIO_AUTH_TOKEN` (Auth Token)
- Phone number purchased in Twilio:
  - `TWILIO_PHONE_NUMBER` (E.164, e.g. `+1785xxxxxxx`)
- Voice/calling (if you use voice features):
  - `TWILIO_API_KEY` / `TWILIO_API_SECRET`
  - `TWILIO_TWIML_APP_SID`

### Email (SMTP/IMAP)
This project uses SMTP + IMAP for some flows.

Gmail:
- Create an App Password in Google account (if using 2FA)
- Set:
  - `EMAIL_USER` / `EMAIL_PASSWORD`
  - `SMTP_HOST` / `SMTP_PORT`
  - `IMAP_HOST` / `IMAP_PORT`
  - `SMTP_USER` / `SMTP_PASS`
  - `ADMIN_EMAIL`

Invoice emails:
- `INVOICE_SMTP_USER` / `INVOICE_SMTP_PASS`
  - Often same values as `SMTP_USER` / `SMTP_PASS` unless you want a separate mailbox.

### Gemini / OpenAI
- Gemini:
  - Google AI Studio / Gemini API keys -> `NEXT_PUBLIC_GEMINI_API_KEY`
- OpenAI:
  - OpenAI dashboard -> API keys -> `NEXT_PUBLIC_OPENAI_API_KEY` (optional)

### Google Calendar OAuth (Google Integrations)
- Google Cloud Console -> APIs & Services -> OAuth consent screen
- Credentials -> OAuth Client ID (Web application)
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `GOOGLE_REDIRECT_URI`

Redirect URI must match exactly:
- `.../api/auth/google-calendar/callback` for your environment domain

### Google Maps API
- Google Cloud -> APIs & Services -> enable Maps/Geocoding as required
- Get API key -> `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`

### MLS API (AMPRE)
- Request an API access token + endpoint from your MLS provider
  - `MLS_ACCESS_TOKEN`
  - `MLS_API_URL` (from provider docs)

### Facebook Meta (Lead Ads / Webhooks) (Optional)
- Meta Developers -> your Facebook app:
  - `FACEBOOK_APP_ID`
  - `FACEBOOK_APP_SECRET`
  - Webhook:
    - `FACEBOOK_WEBHOOK_VERIFY_TOKEN`
    - `FACEBOOK_WEBHOOK_SECRET`

### Facebook Lead Ads page permissions
If you use the Facebook integration:
- Ensure the app has required permissions approved in **App Review**
- The user connecting must be an admin of the pages they want to sync

## 4) What changes between Production and UAT

Only URLs and environments must change:
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_BASE_URL`
- `NEXT_PUBLIC_APP_TWILIO_URL`
- `NEXTAUTH_URL`
- OAuth redirect URIs inside Google/Facebook provider settings

Optionally you can also keep separate credentials:
- `MONGODB_URI`
- Twilio app/IDs
- Firebase project
- Gemini/OpenAI keys (not strictly required but recommended)

## 5) Step-by-step: create a correct `.env` (Local / Development)

This section explains how to fill the exact keys used by the project when you run it locally using your root `.env` file.
If you are deploying to Vercel, use the Vercel dashboard environment variables instead (same keys, different values).

### 5.1 Generate secrets (do this first)
1. Open a terminal where you have OpenSSL.
2. Run:
   ```bash
   openssl rand -base64 32
   ```
3. Use the generated value for:
   - `JWT_SECRET`
   - `NEXTAUTH_SECRET`
   - `CRON_SECRET`

### 5.2 Database
1. Go to MongoDB Atlas (or your local MongoDB instance).
2. Create/select a cluster.
3. Get your connection string.
4. Set:
   - `MONGODB_URI` = your connection string

### 5.3 Twilio (SMS + Voice)
1. Go to Twilio Console.
2. Create/select a project.
3. Find:
   - `TWILIO_ACCOUNT_SID` (Account SID)
   - `TWILIO_AUTH_TOKEN` (Auth Token)
4. Buy/select a phone number for SMS/Voice and set:
   - `TWILIO_PHONE_NUMBER` (E.164, like `+1785xxxxxxx`)
5. For voice calls (voice SDK parts), create/locate:
   - `TWILIO_API_KEY` and `TWILIO_API_SECRET`
   - `TWILIO_TWIML_APP_SID`
6. Set:
   - `NEXT_PUBLIC_TWILIO_PHONE_NUMBER` (if your UI needs it)

### 5.4 Email (SMTP + IMAP, used by Nodemailer/email integrations)
1. Use a Gmail (or other SMTP provider) account.
2. If you use Gmail with 2FA enabled, create an App Password.
3. Set:
   - `EMAIL_USER` = your email address
   - `EMAIL_PASSWORD` = the App Password
4. Host settings:
   - `SMTP_HOST` (for Gmail usually `smtp.gmail.com`)
   - `SMTP_PORT` (for Gmail usually `587`)
   - `IMAP_HOST` (for Gmail usually `imap.gmail.com`)
   - `IMAP_PORT` (for Gmail usually `993`)
5. Project-specific aliases (used in some routes/templates):
   - `SMTP_USER` and `SMTP_PASS` (often same as `EMAIL_USER` / `EMAIL_PASSWORD`)
   - `ADMIN_EMAIL` = admin mailbox for admin email sending

### 5.5 MLS API (AMPRE)
1. Contact your MLS provider for API access (AMPRE in this project).
2. Get the access token:
   - `MLS_ACCESS_TOKEN`
3. Set the endpoint:
   - `MLS_API_URL` (example uses `https://query.ampre.ca/odata/Property`)

### 5.6 Google Integrations
You have 2 separate Google integrations: Calendar OAuth and Google Maps.

#### A) Calendar OAuth
1. Go to Google Cloud Console.
2. Create/select a project.
3. Enable OAuth and Calendar API as needed.
4. Create OAuth credentials:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
5. Set redirect URI (must match exactly):
   - Local: `http://localhost:3000/api/auth/google-calendar/callback`
   - Production: your domain `.../api/auth/google-calendar/callback`
6. Set:
   - `GOOGLE_REDIRECT_URI`

#### B) Google Maps API
1. Go to Google Cloud Console.
2. Enable Maps/Geocoding APIs.
3. Create an API key.
4. Set:
   - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`

### 5.7 Facebook Meta (Lead Ads / Webhooks) - Optional
1. Create a Meta app in Meta Developers.
2. Configure:
   - `FACEBOOK_APP_ID`
   - `FACEBOOK_APP_SECRET`
3. Webhook configuration:
   - `FACEBOOK_WEBHOOK_VERIFY_TOKEN`
   - `FACEBOOK_WEBHOOK_SECRET`
4. If using the Facebook integration, ensure App Review is done for required permissions (see `FACEBOOK_APP_SETUP_FOR_STAFF.md` and/or `FACEBOOK_INTEGRATION_GUIDE.md`).

### 5.8 AI keys
#### Gemini
- Create a Gemini API key and set:
  - `NEXT_PUBLIC_GEMINI_API_KEY`

#### OpenAI (optional)
- Prefer **server-only** key: `OPENAI_API_KEY` (used by `lib/openai.ts` if you wire that module).
- Older docs mentioned `NEXT_PUBLIC_OPENAI_API_KEY` — avoid exposing OpenAI keys to the browser.

### 5.9 URLs / App settings (these are not "third-party keys")
Set these based on where you run the app:
1. Local:
   - `NEXT_PUBLIC_APP_URL` = `http://localhost:3000`
   - `NEXT_PUBLIC_BASE_URL` = `http://localhost:3000`
   - `NEXTAUTH_URL` = `http://localhost:3000/`
2. Production/UAT:
   - use your deployed domain:
     - `NEXT_PUBLIC_APP_URL`
     - `NEXT_PUBLIC_BASE_URL`
     - `NEXTAUTH_URL`
3. Twilio voice base:
   - `NEXT_PUBLIC_APP_TWILIO_URL` = the deployed Twilio voice app URL (as used by your UI/routes)

### 5.10 Agent template constants (where they come from)
These values are for email/text templates and UI defaults:
- `NEXT_PUBLIC_AGENT_EMAIL` = your agent/team mailbox for templates
- `NEXT_PUBLIC_AGENT_PHONE` = phone shown in templates
- `NEXT_PUBLIC_AGENT_NAME` = agent/team name shown in templates

### 5.11 Invoice email mailbox (separate SMTP, if required)
If you want invoice emails from a separate mailbox:
- `INVOICE_SMTP_USER`
- `INVOICE_SMTP_PASS`

If you want invoice emails to use the same mailbox as SMTP:
- set `INVOICE_SMTP_USER` and `INVOICE_SMTP_PASS` to the same values as `SMTP_USER` / `SMTP_PASS`.
