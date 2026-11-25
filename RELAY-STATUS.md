# PhoneBridge cloud workspace status

## Customer flow

- The customer dashboard is the main signed-in experience. It keeps the original PhoneBridge branding and navigation; Agent Console and remote task tools are not exposed.
- The Windows connector requests a short-lived six-digit code and displays it in Notepad. A signed-in phone approves the code to bind the computer to that account.
- Pairing codes expire after five minutes and are single-use. Codes and agent poll secrets are stored as hashes. The per-device token is returned only after approval and is stored locally with Windows user-only permissions.
- The background connector is retained for enrollment and heartbeat status. Existing installed credentials continue to work; old command-poll requests update status only.

## Feature boundary

- The customer workspace shows paired computers and online/offline status. Computer task controls and task history have been removed, and the cloud task APIs return 410.
- The legacy command tables and RPC migration remain in the repository for compatibility, but the cloud server and Agent do not use them. No command rows are deleted.
- File transfer, cloud Drive, synchronization, media streaming, screen viewing, mouse control, and keyboard control are not implemented in this cloud release. The local backup's corresponding endpoints depend on the ThinkPad-hosted server and are not enabled in the cloud application.

## Database and release boundary

- Migrations 001, 002, and 004 are required for the current account/device pairing and status flow. Migration 003 remains in the ordered migration chain for compatibility. Migration 004 adds the computer-generated pairing request and its service-role-only completion function.
- Migration 004 is new in this checkout. Production migration history and schema have not been verified from this environment, and no migration has been applied here.
- Render does not run migrations. Deploying the updated Agent and pairing API before migration 004 is applied will leave the new pairing route unavailable; the older code-generated enrollment endpoint remains for older Agent binaries.
- Tests can verify code paths and source consistency, but they cannot prove production enrollment or ThinkPad authentication. Real pairing and status require production migration review, deployment, and live verification.
