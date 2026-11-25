# Phone Bridge Cloud foundation

This is a separate cloud-ready application workspace. It does not replace or modify the existing private ThinkPad service.

## Architecture
- Render runs the Node/Express web application.
- Supabase Auth manages email/password, Google OAuth and SMS OTP.
- Supabase Postgres stores per-user metadata with Row Level Security (RLS).
- Supabase private Storage stores each user's files under `<auth.uid()>/<object>`.
- The Supabase service-role key is used only by the trusted cloud server for device enrollment and command brokering. It is never sent to the browser.

## Local validation
```powershell
Copy-Item .env.example .env
# Fill all placeholder values from your Supabase and Render settings.
npm ci
npm start
```
Open http://localhost:3000 for local validation. Without Supabase credentials, the page intentionally reports that authentication is not configured.

Required environment variables:
- `SUPABASE_URL`: Supabase project URL.
- `SUPABASE_ANON_KEY`: browser-safe anon/publishable key.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only secret key. Never place it in browser code, `.env.example`, Git, or logs.
- `APP_ORIGIN`: exact public Render URL, `https://phonebridge-cloud.onrender.com` for the existing production service.
- `PORT`: supplied automatically by Render.

Keep `SUPABASE_SERVICE_ROLE_KEY` only in Render's environment settings.

## Supabase setup
1. Open the existing PhoneBridge project in the Supabase Dashboard. Do not create a new project.
2. Get the project URL from its **Connect** dialog. Get the `anon` and `service_role` keys from **Project Settings > API Keys**. Set them as `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the appropriate environments. The anon key is intended for browser use with RLS enabled. The service-role key bypasses RLS: keep it only on the trusted server (for example, in Render's environment settings), never expose it in browser code, and never commit it to Git.
3. Before touching the database, compare Supabase migration history and the live schema with the migration files. The base `devices` table and owner RLS from `001_phone_bridge_multiuser.sql` are required.
4. Cloud device pairing and status use migrations `001_phone_bridge_multiuser.sql`, `002_device_command_relay.sql`, and `003_device_relay_functions.sql` in order. Phone-generated pairing codes are stored in `device_enrollments` from migration 002; migration 004 is not used. Render does not run migrations automatically. Compare production history and schema before applying any missing migration.
5. Authentication > URL Configuration: set the production Site URL and add the Render URL to Redirect URLs.
6. Enable Email provider and configure SMTP for production email delivery. Use a verified sender domain.
7. Enable Google provider and configure Google OAuth client ID/secret and the Supabase callback URL in Google Cloud Console.
8. Enable Phone provider and configure an SMS provider supported by Supabase Auth. Test Ghana (+233) delivery and rate limits.
9. Do not enable public registration until SMTP, OAuth, SMS, RLS, and storage policies have been tested.

## Render setup
1. Use the existing Render web service `phonebridge-cloud` at `https://phonebridge-cloud.onrender.com`. Do not create another service for this checkout.
2. The production entry point is `server.js`; the service build command is `npm ci` and its start command is `npm start`.
3. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `APP_ORIGIN=https://phonebridge-cloud.onrender.com` in that existing service's environment. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only; never put it in browser code or commit it to Git.
4. The included `render.yaml` currently names a service `phone-bridge`, so do not use/sync that Blueprint for the existing `phonebridge-cloud` service unless its service identity is first reconciled.
5. Render does not apply database migrations. The existing production database must be reviewed for migrations 001 through 003 before deploying this pairing flow. No new pairing migration is required; phone-generated codes use the existing `device_enrollments` table from migration 002.
6. Deploy only after configuration and migration state are reviewed, then verify `/health` and `/config` without copying the returned anon key into logs or reports.
7. Add the Render URL to Supabase Auth redirect allow-list.

## ThinkPad outbound worker

The worker makes outbound HTTPS requests only; it opens no inbound listening port and requires no Tailscale, public IP, or router forwarding.

For normal users, download `https://phonebridge-cloud.onrender.com/downloads/PhoneBridge-Agent-Windows.zip`, extract it, install Node.js 20+, and double-click `Start-PhoneBridge-Agent.cmd`. On the phone, sign in to PhoneBridge and choose Pair a device > Generate pairing code. In the Windows Agent window, press P then Enter if pairing/re-pairing, and type the six-digit code shown on the phone. Keep the Agent window open while it completes enrollment.

For developers running from this repository, use a trusted Windows Node.js 20+ environment:
```powershell
$env:PHONEBRIDGE_CLOUD_URL="https://phonebridge-cloud.onrender.com"
npm run agent
# To force a fresh phone-generated pairing with an existing saved device:
npm run agent -- --pair
```

The phone-generated six-digit code is stored only as a server-keyed hash, expires after five minutes, and can be redeemed once by the Windows Agent. The Agent receives a per-device token; only its hash is stored in Supabase. The token is saved with Windows user-only permissions beneath `%LOCALAPPDATA%\PhoneBridge\Agent\cloud-device.json`. Existing valid ThinkPad credentials continue to authenticate; use the Agent's P pairing option to re-pair and rotate the token on the same owner-bound device. The worker maintains enrollment and reports online/offline status only. It does not inspect or modify files, launch apps, or execute remote tasks. Screen streaming, file transfer, media streaming, Drive and synchronization are not available in this cloud release.

## WhatsApp verification
WhatsApp is not a native Supabase Auth OTP channel. Add it only through an approved WhatsApp Business Platform/Meta Cloud API or a supported verification provider after business setup, templates, phone-number ownership, delivery and cost are configured. Never collect a WhatsApp password or pretend a WhatsApp code was sent when it was not.

## Important release boundary
The current legacy Phone Bridge server still uses shared local JSON metadata and one shared files directory. The cloud app has account-bound outbound Windows-Agent enrollment and the phone-generated pairing flow, but it is not yet a migration of the legacy Drive, notes, sync, preview, audit or media endpoints or all old local pairing-session features. Do not connect legacy endpoints to public accounts until each endpoint is migrated to enforce the authenticated user's ID and the private storage policies are tested with two separate accounts. Keep the old private service running separately until migration and backup/restore tests are complete.

## Security checklist before public launch
- Configure production SMTP; verify confirmation and password-reset flows.
- Configure Google OAuth and SMS OTP; test account linking and rate limits.
- Add CAPTCHA/bot protection and abuse throttling before public registration.
- Test RLS using two independent users; prove neither can read, write, preview or delete the other's records or objects.
- Add account deletion/export, secure device sessions, audit retention and recovery procedures.
- Set upload limits, MIME validation, malware scanning policy, quotas and cost alerts.
- Never expose Supabase service-role secrets in client code or Render logs.
