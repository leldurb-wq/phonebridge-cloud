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
- `APP_ORIGIN`: exact public Render URL, for example `https://phone-bridge.onrender.com`.
- `PORT`: supplied automatically by Render.

Keep `SUPABASE_SERVICE_ROLE_KEY` only in Render's environment settings.

## Supabase setup
1. Create a Supabase project.
2. In SQL Editor, review and run migration `001_phone_bridge_multiuser.sql` only if its tables, policies, and trigger are not already present.
3. Authentication > URL Configuration: set the production Site URL and add the Render URL to Redirect URLs.
4. Enable Email provider and configure SMTP for production email delivery. Use a verified sender domain.
5. Enable Google provider and configure Google OAuth client ID/secret and the Supabase callback URL in Google Cloud Console.
6. Enable Phone provider and configure an SMS provider supported by Supabase Auth. Test Ghana (+233) delivery and rate limits.
7. Do not enable public registration until SMTP, OAuth, SMS, RLS, and storage policies have been tested.

## Render setup
1. Push this `cloud-app` directory to a private Git repository.
2. Create a Render Web Service with root directory `cloud-app` (or use the included Blueprint).
3. Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `APP_ORIGIN` as environment variables. Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only; never put it in browser code or commit it to Git.
4. Do not apply migration 004. It is intentionally a no-op; the server and worker now allow only actions implemented by the cloud worker. Do not apply or rerun any migrations without first confirming live migration state and approval.
4. Deploy and verify `/health` and `/config`.
5. Add the Render URL to Supabase Auth redirect allow-list.

## ThinkPad outbound worker

The worker makes outbound HTTPS requests only; it opens no inbound listening port and requires no Tailscale, public IP, or router forwarding.

On the ThinkPad, from a trusted Node.js 20+ environment:
```powershell
$env:PHONEBRIDGE_CLOUD_URL="https://your-render-service.onrender.com"
npm run agent -- "YOUR_ONE_TIME_ENROLLMENT_TICKET"
```

The one-time ticket is exchanged for a per-device token, which is saved with owner-only permissions beneath `%LOCALAPPDATA%\PhoneBridge\Agent\cloud-device.json`. The worker polls the cloud command queue and only performs allowlisted workspace, system-information, and approved app actions. Its default workspace is `%USERPROFILE%\PhoneBridge`.

## WhatsApp verification
WhatsApp is not a native Supabase Auth OTP channel. Add it only through an approved WhatsApp Business Platform/Meta Cloud API or a supported verification provider after business setup, templates, phone-number ownership, delivery and cost are configured. Never collect a WhatsApp password or pretend a WhatsApp code was sent when it was not.

## Important release boundary
The current legacy Phone Bridge server still uses shared local JSON metadata and one shared files directory. This cloud app is an isolated authentication and data-model foundation, not yet a migration of the existing Drive, notes, sync, pairing, preview, audit or media endpoints. Do not connect legacy endpoints to public accounts until each endpoint is migrated to enforce the authenticated user's ID and the private storage policies are tested with two separate accounts. Keep the old private service running separately until migration and backup/restore tests are complete.

## Security checklist before public launch
- Configure production SMTP; verify confirmation and password-reset flows.
- Configure Google OAuth and SMS OTP; test account linking and rate limits.
- Add CAPTCHA/bot protection and abuse throttling before public registration.
- Test RLS using two independent users; prove neither can read, write, preview or delete the other's records or objects.
- Add account deletion/export, secure device sessions, audit retention and recovery procedures.
- Set upload limits, MIME validation, malware scanning policy, quotas and cost alerts.
- Never expose Supabase service-role secrets in client code or Render logs.
