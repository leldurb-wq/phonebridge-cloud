# Remote device relay — implementation status

## Implemented locally

- Supabase multi-user foundation is present in migration 001. Core tables (devices, profiles, notes) are live in the configured Supabase project.
- Migration 002 has been applied successfully to the live Supabase project. Read-only REST checks returned HTTP 200 for `device_agents`, `device_enrollments`, and `device_commands`.
- Migration 003 has been applied successfully to the live Supabase project. Both `phonebridge_claim_device_command` and `phonebridge_complete_device_command` were invoked with deliberately invalid device credentials and returned the expected authentication rejection (`28000`), confirming the functions exist and reject invalid credentials. No device command was executed.
- Cloud server verifies Supabase owner sessions for enrollment and command creation.
- Enrollment creates a random six-digit, single-use pairing code, stores only a server-keyed HMAC, and expires it after five minutes.
- Agent enrollment exchanges the pairing code for a random per-device token. Only the token hash is stored; the raw token is returned once.
- Agent claim and result endpoints authenticate the per-device token and use server-side RPCs.
- Added owner command API. It checks device ownership and validates action names, paths, app names, and payload sizes. Writes and folder creation require a confirmation in the dashboard.
- Browser roles are not granted direct INSERT permission on device_commands in migration 002; command insertion is brokered by the authenticated server.
- Added a signed-in dashboard for device enrolment, device listing, task queueing, recent task status/results, and sign-out.
- Added PhoneBridge-Agent/cloud-worker.js as an outbound-only HTTPS poller. It has no inbound listener and no arbitrary shell execution. It supports system info, workspace list/read/write, folder creation, and approved app launch. Remote file reads are limited to 12 KB; writes are limited to 1 MB.
- The worker prompts for the pairing code in its terminal. Credentials are saved locally under %LOCALAPPDATA%/PhoneBridge/Agent/cloud-device.json with owner-only permissions. The current ThinkPad file schema (cloudUrl, deviceId, agentToken, enrolledAt) is accepted and repaired in place.
- Agent tests pass 9/9 locally. Cloud server, dashboard, and agent JavaScript syntax checks pass. Local HTTP checks confirmed /health returns 200, missing Supabase config returns 503, and unauthenticated device listing is rejected.

## Live Supabase checks

- Existing core tables devices, profiles, and notes return HTTP 200.
- Relay tables device_agents, device_enrollments, and device_commands return HTTP 200 after migration 002.
- Both relay RPC functions exist and reject deliberately invalid device credentials after migration 003.
- No live device enrollment or valid cloud command has been tested yet. The existing local ThinkPad credential shape was inspected without printing token values; it is structurally valid and targets phonebridge-cloud.onrender.com.

## Not deployed / not operational

- The credential recovery and six-digit pairing changes in this checkout have not been deployed to Render.
- No live enrollment or cloud command has been tested with these changes.
- The local ThinkPad has a credential file, but live cloud authentication was not attempted during this task.
- Screen capture/audio, mouse/keyboard control, and unrestricted terminal execution are not part of this cloud worker.
- The dashboard confirmation is an owner-facing confirmation step, not a separate cryptographic approval mechanism. Stronger policy controls, audit history, and device revocation UI remain to be implemented.
- An authenticated MCP gateway and supported ChatGPT connection are not implemented. The local stdio MCP server is separate.

## Next steps

1. Deploy the cloud app with HTTPS and verify health/auth configuration without exposing the service-role secret.
2. Enrol the ThinkPad using the one-time ticket and save its token locally.
3. Run end-to-end tests for claim, action execution, result reporting, expiry, replay, and revocation.
4. Add device revocation, audit events, stronger approval/policy controls, and then a secure ChatGPT-facing MCP integration.

Do not expose the ThinkPad agent directly to the public internet and do not configure router port forwarding. The intended design is outbound-only HTTPS from the ThinkPad to the cloud broker.
