# PhoneBridge cloud workspace status

## Customer flow

- The customer dashboard is the main signed-in experience. It keeps the original PhoneBridge branding and navigation; Agent Console and remote task tools are not exposed.
- The signed-in phone generates a short-lived six-digit code. The user enters it in the Windows Agent console to bind that computer to the phone's account.
- Pairing codes expire after five minutes and are single-use. Only a keyed hash is stored. The per-device token is returned to the Agent after redemption and is stored locally with Windows user-only permissions.
- The background connector is retained for enrollment and heartbeat status. Existing installed credentials continue to work; old command-poll requests update status only.

## Feature boundary

- The customer workspace shows paired computers and online/offline status. Computer task controls and task history have been removed, and the cloud task APIs return 410.
- The legacy command tables and RPC migration remain in the repository for compatibility, but the cloud server and Agent do not use them. No command rows are deleted.
- File transfer, cloud Drive, synchronization, media streaming, screen viewing, mouse control, and keyboard control are not implemented in this cloud release. The local backup's corresponding endpoints depend on the ThinkPad-hosted server and are not enabled in the cloud application.

## Database and release boundary

- Migrations 001, 002, and 003 remain the ordered database chain. Phone-generated pairing uses the existing `device_enrollments` table from migration 002; no migration 004 is required.
- The Windows Agent redeems the phone-generated code through `/api/agent/enroll`; the cloud reports a computer Online only after a recent authenticated Agent heartbeat.
- Render does not run migrations. Verify that the existing production database has migrations 001 through 003 before relying on pairing and device status.
- Tests can verify code paths and source consistency, but they cannot prove production enrollment or ThinkPad authentication. Real pairing and status require production migration review, deployment, and live verification.
