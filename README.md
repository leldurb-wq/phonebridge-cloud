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
4. Cloud Windows Agent pairing and tasks additionally require `002_device_command_relay.sql` (agent credentials, one-use enrollments, task queue, grants and RLS), followed by `003_device_relay_functions.sql` (service-role-only claim and completion RPCs). Review and apply migrations in order `001` → `002` → `003` only with approval. Render does not run database migrations automatically. If any are already applied, do not rerun blindly.
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
5. Render does not apply database migrations. Pairing and Agent tasks remain unavailable until migrations 001, 002 and 003 are confirmed in place. This repository contains no migration 004.
6. Deploy only after configuration and migration state are reviewed, then verify `/health` and `/config` without copying the returned anon key into logs or reports.
7. Add the Render URL to Supabase Auth redirect allow-list.

## ThinkPad outbound worker

The worker makes outbound HTTPS requests only; it opens no inbound listening port and requires no Tailscale, public IP, or router forwarding.

For normal users, download `https://phonebridge-cloud.onrender.com/downloads/PhoneBridge-Agent-Windows.zip`, extract it, install Node.js 20+, and double-click `Start-PhoneBridge-Agent.cmd`. It configures the cloud URL automatically and prompts for the six-digit code. Keep its terminal window open while the computer should stay connected.

For developers running from this repository, use a trusted Node.js 20+ environment:
```powershell
$env:PHONEBRIDGE_CLOUD_URL="https://your-render-service.onrender.com"
npm run agent -- "YOUR_SIX_DIGIT_PAIRING_CODE"
```

The six-digit code is generated in the signed-in PhoneBridge workspace, expires after five minutes, and is single-use. Enter it in the Windows agent to approve the computer. It is exchanged for a per-device token, which is saved with owner-only permissions beneath `%LOCALAPPDATA%\PhoneBridge\Agent\cloud-device.json`. The agent accepts and repairs the existing ThinkPad credential format in place. If cloud access is revoked, it prompts for a new code and rotates the token on the existing owner-bound device record. The worker polls the cloud command queue and only performs allowlisted workspace, system-information, and approved app actions. Its default workspace is `%USERPROFILE%\PhoneBridge`.

## WhatsApp verification
WhatsApp is not a native Supabase Auth OTP channel. Add it only through an approved WhatsApp Business Platform/Meta Cloud API or a supported verification provider after business setup, templates, phone-number ownership, delivery and cost are configured. Never collect a WhatsApp password or pretend a WhatsApp code was sent when it was not.

## Important release boundary
The current legacy Phone Bridge server still uses shared local JSON metadata and one shared files directory. The cloud app now has its own account-bound outbound Windows-agent enrollment and pairing flow, but it is not yet a migration of the legacy Drive, notes, sync, preview, audit or media endpoints or the old local pairing-session protocol. Do not connect legacy endpoints to public accounts until each endpoint is migrated to enforce the authenticated user's ID and the private storage policies are tested with two separate accounts. Keep the old private service running separately until migration and backup/restore tests are complete.

## Security checklist before public launch
- Configure production SMTP; verify confirmation and password-reset flows.
- Configure Google OAuth and SMS OTP; test account linking and rate limits.
- Add CAPTCHA/bot protection and abuse throttling before public registration.
- Test RLS using two independent users; prove neither can read, write, preview or delete the other's records or objects.
- Add account deletion/export, secure device sessions, audit retention and recovery procedures.
- Set upload limits, MIME validation, malware scanning policy, quotas and cost alerts.
- Never expose Supabase service-role secrets in client code or Render logs.
