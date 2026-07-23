# Legacy Next.js app — reference docs (DOES NOT describe this app)

⚠️ **These documents are from the PREVIOUS version of Get Home Realty**, which ran on
**Next.js + Vercel + MongoDB Atlas + NextAuth**. They are archived here for historical reference
only.

**This app (`myapp`) is a different stack** — **NestJS + Prisma + PostgreSQL** (API in `server/`)
and a **Vite + React SPA** (`client/`), with **Sanctum-cookie** auth, **self-hosted** (not Vercel).

Do **not** follow these for deploying or configuring `myapp`. Almost everything in them —
`MONGODB_URI`, `NEXTAUTH_SECRET`, `JWT_SECRET`, all `NEXT_PUBLIC_*`, Vercel cron jobs,
Puppeteer-on-Lambda, the `SMTP_*`/`EMAIL_*` env scheme (this app stores mail accounts per-user in
the `mail_accounts` table instead) — **does not apply here**.

For this app's real environment + the MLS/AMPRE setup that *does* carry over, see
[`../MLS_AND_ENV.md`](../MLS_AND_ENV.md).

## Files
- `ENV_KEYS_AND_SETUP.md` — legacy env templates (Production/UAT/Vercel)
- `HOW_TO_GET_LIVE_API_KEYS.md` — legacy step-by-step for obtaining each third-party key
- `PRODUCTION_DEPLOYMENT_GUIDE.md` — legacy Vercel deployment checklist
- `vercel-environment-variables.md` — legacy Vercel env var list

## The only part relevant to `myapp`
The **MLS feed**: provider **AMPRE** (via **TRREB**), `MLS_API_URL=https://query.ampre.ca/odata/Property`,
`MLS_ACCESS_TOKEN` = a JWT obtained by data contract from the board. That carries over verbatim and
is documented for this app in [`../MLS_AND_ENV.md`](../MLS_AND_ENV.md).
