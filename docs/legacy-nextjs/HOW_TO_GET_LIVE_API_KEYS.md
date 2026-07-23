# How to Get Live API Keys — Step-by-Step

> ⚠️ Legacy Next.js/Vercel/MongoDB app. Does not describe `myapp`. See `README.md` in this folder.

Every environment variable the legacy app needs, how to generate or obtain it, and where to paste it.

---

## Quick Reference Table

| # | Variable(s) | Service | Free Tier? | Time to Set Up |
|---|-------------|---------|------------|----------------|
| 1 | `JWT_SECRET`, `NEXTAUTH_SECRET`, `CRON_SECRET` | Local terminal | N/A | 1 min |
| 2 | `MONGODB_URI` | MongoDB Atlas | Yes (M0) | 10 min |
| 3 | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_TWIML_APP_SID` | Twilio | Trial available | 15 min |
| 4 | `EMAIL_USER`, `EMAIL_PASSWORD`, `SMTP_HOST`, `SMTP_PORT`, `IMAP_HOST`, `IMAP_PORT`, `SMTP_USER`, `SMTP_PASS`, `ADMIN_EMAIL` | Gmail | Yes | 5 min |
| 5 | `INVOICE_SMTP_USER`, `INVOICE_SMTP_PASS` | Gmail (optional 2nd) | Yes | 5 min |
| 6 | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | Google Cloud | Yes | 15 min |
| 7 | `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` | Google Cloud | $200/mo free | 5 min |
| 8 | `NEXT_PUBLIC_GEMINI_API_KEY` | Google AI Studio | Yes | 2 min |
| 9 | `NEXT_PUBLIC_OPENAI_API_KEY` | OpenAI | Pay-as-you-go | 2 min |
| 10 | `MLS_ACCESS_TOKEN`, `MLS_API_URL` | TRREB / AMPRE | By contract | Varies |
| 11 | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_WEBHOOK_VERIFY_TOKEN`, `FACEBOOK_WEBHOOK_SECRET` | Meta Developers | Yes | 20 min |
| 12 | URL variables | Your domain | — | 1 min |
| 13 | Template constants | Your business info | — | 1 min |

---

## 1. Security Secrets (JWT, NextAuth, Cron)

**Variables:** `JWT_SECRET`, `NEXTAUTH_SECRET`, `CRON_SECRET`

Random strings the app uses to sign tokens and protect cron endpoints. Generate them yourself.

```bash
openssl rand -base64 32
```

Run it three times (one per secret). Rules: each different, 32+ chars, never shared.

```env
JWT_SECRET=paste_first_output_here
NEXTAUTH_SECRET=paste_second_output_here
CRON_SECRET=paste_third_output_here
```

## 2. MongoDB Atlas (`MONGODB_URI`)

1. https://cloud.mongodb.com — sign up.
2. Build a Database → M0 (free) for dev, M10+ for production; pick region near Vercel.
3. Database Access → add user (Autogenerate password, save it), readWrite.
4. Network Access → Allow Access from Anywhere (`0.0.0.0/0`) for Vercel's dynamic IPs.
5. Connect → Drivers → copy the string; replace `<password>` and add a db name:

```env
MONGODB_URI=mongodb+srv://ghr-app:YOUR_PASSWORD@cluster0.abc123.mongodb.net/gethomerealty?retryWrites=true&w=majority
```

## 3. Twilio (SMS & Voice)

- Console dashboard → **Account SID** (`AC...`) + **Auth Token**.
- Buy a number with SMS + Voice → E.164 (`+14155551234`).
- API keys & tokens → Create API Key (Standard) → copy **SID** (`SK...`) + **Secret** (shown once).
- Voice → TwiML Apps → Create → Voice URL `https://your-prod-domain.com/api/twilio/voice` → copy **SID** (`AP...`).
- Configure the number's SMS webhook `.../api/twilio/incoming-sms` and Voice webhook `.../api/twilio/voice`.

```env
TWILIO_ACCOUNT_SID=ACxxxx
TWILIO_AUTH_TOKEN=xxxx
TWILIO_PHONE_NUMBER=+14155551234
NEXT_PUBLIC_TWILIO_PHONE_NUMBER=+14155551234
TWILIO_API_KEY=SKxxxx
TWILIO_API_SECRET=xxxx
TWILIO_TWIML_APP_SID=APxxxx
```

## 4. Gmail SMTP & IMAP

Dedicated Gmail → enable 2-Step Verification → https://myaccount.google.com/apppasswords → Mail/Other → 16-char password (remove spaces).

```env
EMAIL_USER=your-app-email@gmail.com
EMAIL_PASSWORD=abcdefghijklmnop
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
IMAP_HOST=imap.gmail.com
IMAP_PORT=993
SMTP_USER=your-app-email@gmail.com
SMTP_PASS=abcdefghijklmnop
ADMIN_EMAIL=admin@gethomerealty.ca
```

## 5. Invoice Email (optional 2nd mailbox)

```env
INVOICE_SMTP_USER=invoices@yourdomain.com
INVOICE_SMTP_PASS=abcdefghijklmnop
```

## 6. Google Calendar OAuth

Google Cloud project → enable Google Calendar API → OAuth consent screen (External) → Credentials → OAuth Client ID (Web) → Authorized redirect URIs:
- Local `http://localhost:3000/api/auth/google-calendar/callback`
- Prod `https://your-prod-domain.com/api/auth/google-calendar/callback`

```env
GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx
GOOGLE_REDIRECT_URI=https://your-prod-domain.com/api/auth/google-calendar/callback
```

Publish the app to allow non-test users.

## 7. Google Maps API Key

Enable Maps JavaScript API, Places API, Geocoding API → Create API Key → restrict to your domains.

```env
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=AIzaSyxxxx
```

$200/month free credit; billing account required.

## 8. Google Gemini API Key

https://aistudio.google.com/apikey → Create API Key.

```env
NEXT_PUBLIC_GEMINI_API_KEY=AIzaSyxxxx
```

## 9. OpenAI API Key (optional)

https://platform.openai.com/api-keys → Create new secret key (shown once).

```env
NEXT_PUBLIC_OPENAI_API_KEY=sk-proj-xxxx
```

## 10. MLS API — AMPRE / TRREB

Not self-service. You must be a licensed brokerage or have a data agreement with your board.

1. Contact **TRREB** (or your local board's IT/data team).
2. Request **vendor API access** for property data feeds.
3. They provide a **JWT access token** (`eyJ...`) + an **API endpoint URL**.
4. The token may expire — track and renew.

```env
MLS_ACCESS_TOKEN=eyJhbGciOiJIUzI1NiJ9.xxxx
MLS_API_URL=https://query.ampre.ca/odata/Property
```

## 11. Facebook / Meta (optional — Lead Ads)

Create a Business app → note **App ID** + **App Secret** (Settings → Basic). Add Webhooks product → Page topic → Callback `https://your-prod-domain.com/api/facebook/webhook` + a Verify Token you invent. Submit for App Review (`pages_manage_metadata`, `leads_retrieval`, `pages_show_list`).

```env
FACEBOOK_APP_ID=123456789012345
FACEBOOK_APP_SECRET=abcdef0123456789abcdef0123456789
FACEBOOK_WEBHOOK_VERIFY_TOKEN=my_ghr_verify_token_2026
FACEBOOK_WEBHOOK_SECRET=abcdef0123456789abcdef0123456789
```

## 12. URL Variables

```env
NEXT_PUBLIC_APP_URL=https://app.gethomerealty.ca
NEXT_PUBLIC_BASE_URL=https://app.gethomerealty.ca
NEXT_PUBLIC_APP_TWILIO_URL=https://app.gethomerealty.ca
NEXTAUTH_URL=https://app.gethomerealty.ca
NODE_ENV=production
```

## 13. Template Constants

```env
NEXT_PUBLIC_AGENT_EMAIL=info@gethomerealty.ca
NEXT_PUBLIC_AGENT_PHONE=+1 (905) 565-9933
NEXT_PUBLIC_AGENT_NAME=Get Home Realty
```

---

## Checklist

- [ ] `openssl rand -base64 32` run 3 separate times for the 3 secrets
- [ ] MongoDB string has real password + database name
- [ ] Twilio number in E.164 (`+`)
- [ ] Gmail App Password has no spaces
- [ ] Google OAuth redirect URI matches Cloud Console exactly
- [ ] Google Maps key has billing attached
- [ ] All URL vars use https + real production domain
- [ ] MLS token valid, not expired
- [ ] No secret duplicated or left as placeholder
