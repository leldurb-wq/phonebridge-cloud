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
4. Apply these migrations in order: `001_phone_bridge_multiuser.sql`, `002_device_command_relay.sql`, `003_device_relay_functions.sql`, `004_computer_initiated_pairing.sql`, `005_resumable_pc_file_transfers.sql`, `006_bidirectional_phone_transfers.sql`, `007_multi_account_device_access.sql`, and `008_workspace_services.sql`. Migrations 005 and 006 add resumable bidirectional transfers; migration 007 adds a private device-access membership table and backfills existing device owners; migration 008 adds persistent Drive folders, sync manifests and version history, note versions, and account-scoped workspace services. One physical computer can be paired with up to ten PhoneBridge accounts. Render does not run migrations automatically.
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
5. Render does not apply database migrations. Review the production schema and migration history before deployment. Apply migration 008 only after confirming migrations 001 through 007 are present.
6. Deploy only after configuration and migration state are reviewed, then verify `/health` and `/config` without copying the returned anon key into logs or reports.
7. Add the Render URL to Supabase Auth redirect allow-list.

## ThinkPad outbound worker

The background connector makes outbound HTTPS requests to the cloud and exposes a small pairing bridge only on 127.0.0.1. It does not open a network-facing port and requires no Tailscale, public IP, or router forwarding.

For normal users, download `https://phonebridge-cloud.onrender.com/downloads/PhoneBridge-Agent-Windows.zip`, extract it, install Node.js 20+, and double-click `Start-PhoneBridge.cmd`. The connector runs silently in the background. In the computer browser, sign in to PhoneBridge and tap Pair this computer. The computer displays a six-digit code that expires after five minutes. On each phone, sign in to that person's own PhoneBridge account, enter the fresh code, and tap Connect. The approval assigns the code to the approving account, so the computer browser can stay signed in to its original account. Repeat with a new code for each person; the ThinkPad supports up to ten authorized accounts. The computer connects automatically after approval.

For developers running from this repository, use a trusted Windows Node.js 20+ environment:
```powershell
$env:PHONEBRIDGE_CLOUD_URL="https://phonebridge-cloud.onrender.com"
npm run agent
```

The computer-generated pairing code is stored only as a server-keyed hash, expires after five minutes, and can be redeemed once only after the signed-in phone approves it. The connector receives a per-device token; only its hash is stored in Supabase. The token is saved with Windows user-only permissions beneath %LOCALAPPDATA%\PhoneBridge\Agent\cloud-device.json. Existing valid device credentials continue to authenticate. The silent background connector polls only for authorized file-transfer jobs; it does not expose a terminal, execute arbitrary commands, or provide remote task controls. Phone-to-PC and PC-to-phone transfers use verified 8 MiB chunks, three concurrent chunk requests, and a resumable cloud queue; files up to 2 GB are assembled atomically in Documents\PhoneBridge\Incoming on the paired ThinkPad. Completed Drive files can be downloaded with HTTP byte ranges and can be resumed by clients that support Range requests. Browser media previews stream the original first when the container is a native-play candidate; if the browser rejects the codec, PhoneBridge can fall back to FFmpeg conversion for preview without changing the stored original. Supported file extensions are listed in `lib/media-formats.js`; playback still depends on the browser's codecs and available server-side FFmpeg decoders. Completed transfer chunks remain private for up to 24 hours so the PhoneBridge app can show transfer history and reopen or save a recent transfer; expired chunks are cleaned up when transfer history is refreshed. The separate PhoneBridge Drive continues to store account-owned cloud files in the private user-files bucket, with a 250 MB per-file limit and 10 GB per-account limit. The server validates the signed-in user or paired computer token for every transfer operation and keeps the service-role key server-side. File synchronization, screen streaming and remote input are not available in this cloud release. Browser media preview and streaming are available for supported media; codec playback depends on the browser, and server-side FFmpeg fallback is used when the original cannot be played directly.

## WhatsApp verification
WhatsApp is not a native Supabase Auth OTP channel. Add it only through an approved WhatsApp Business Platform/Meta Cloud API or a supported verification provider after business setup, templates, phone-number ownership, delivery and cost are configured. Never collect a WhatsApp password or pretend a WhatsApp code was sent when it was not.

## Important release boundary
The current legacy Phone Bridge server still uses shared local JSON metadata and one shared files directory. The cloud app has account-bound outbound Windows computer enrollment and the computer-generated, phone-approved pairing flow, but it is not yet a migration of the legacy Drive, notes, sync, preview, audit or media endpoints or all old local pairing-session features. Do not connect legacy endpoints to public accounts until each endpoint is migrated to enforce the authenticated user's ID and the private storage policies are tested with two separate accounts. Keep the old private service running separately until migration and backup/restore tests are complete.

## Security checklist before public launch
- Configure production SMTP; verify confirmation and password-reset flows.
- Configure Google OAuth and SMS OTP; test account linking and rate limits.
- Add CAPTCHA/bot protection and abuse throttling before public registration.
- Test RLS using two independent users; prove neither can read, write, preview or delete the other's records or objects.
- Add account deletion/export, secure device sessions, audit retention and recovery procedures.
- Set upload limits, MIME validation, malware scanning policy, quotas and cost alerts.
- Never expose Supabase service-role secrets in client code or Render logs.

## Transfer recovery details

- Interrupted browser uploads remain in the cloud queue. Select the same file again in the same browser to resume; PhoneBridge checks the filename, size, modified time, first/last chunk fingerprints and the server's verified chunk manifest. Changed chunks are uploaded again instead of being skipped.
- Phone browser receives use Origin Private File System (OPFS) when available. Each chunk is hash-checked and committed at its file offset, so reopening PhoneBridge can verify and reuse completed chunks. Browsers without OPFS are limited to 256 MiB for the in-memory fallback; larger transfers remain queued rather than risking a browser memory crash.
- The Windows connector resolves the actual Windows Documents known folder (including redirected folders) before using Documents\PhoneBridge\Incoming.
- The current integrity contract verifies every 8 MiB chunk and the final file size. A sender-provided whole-file SHA-256 check is not yet implemented.
