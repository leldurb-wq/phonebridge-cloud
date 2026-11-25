# PhoneBridge cloud workspace status

## Customer flow
- The signed-in PhoneBridge dashboard remains the main customer app. No Agent Console, terminal, arbitrary remote command interface, or separate agent UI is exposed.
- The phone approves a six-digit computer-generated pairing code. Codes expire after five minutes and are single-use.
- The Windows connector runs silently in the background and uses outbound HTTPS only. It retains existing per-device credentials and reports authenticated online/offline status.

## Phone-to-PC file transfer
- The phone starts an account-owned transfer assigned to one online paired Windows computer.
- Files are split into 8 MiB chunks. Each chunk is SHA-256 checked, stored in the private `transfer-chunks` bucket, and can be retried independently.
- The paired connector claims only transfers assigned to its own device ID, downloads each chunk over HTTPS, verifies it again, and assembles the file through a temporary file before atomic rename.
- Completed files are saved under `Documents\PhoneBridge\Incoming`. The connector cannot select arbitrary paths or execute arbitrary computer tasks.
- Maximum file size is 2 GiB. The separate private cloud Drive retains its 250 MiB per-file and 10 GiB per-account limits.
- Migration `005_resumable_pc_file_transfers.sql` is required after migrations 001 through 004. Render does not apply database migrations.

## Feature boundary
- The cloud task APIs remain disabled. Legacy task tables and RPC migrations remain for compatibility but are not used by the connector.
- Screen streaming, remote input, audio/video streaming, and full folder synchronization remain unavailable in this cloud release.
- Real production transfers require migration 005 to be applied, the updated Windows connector package to be installed, deployment, and an end-to-end test with a real file.
