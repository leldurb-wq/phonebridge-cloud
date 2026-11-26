# PhoneBridge media and file support

## Cloud features available in this release

- Sign-in and account-scoped cloud file access through Supabase Auth and the private `user-files` bucket.
- Phone-to-PC and PC-to-phone file transfer through the paired PhoneBridge connector, with verified 8 MiB chunks, retry/recovery and a 2 GB per-transfer file ceiling.
- Private PhoneBridge Drive uploads up to 250 MB per file and 10 GB per account.
- Drive preview for images, PDF, text, common Office documents, audio and video where the browser or preview converter can decode the content.
- Download links are short-lived and owner-scoped. Normal cloud objects are served by Supabase Storage signed URLs; transfer-backed Drive files use range-aware streaming with chunk SHA-256 verification.

## Media extensions recognized

Audio: `.mp3`, `.m4a`, `.wav`, `.aac`, `.flac`, `.ogg`, `.opus`, `.oga`, `.wma`, `.aiff`, `.aif`.

Video: `.mp4`, `.m4v`, `.mov`, `.webm`, `.ogv`, `.3gp`, `.3g2`, `.mpeg`, `.mpg`, `.mpe`, `.m2v`, `.avi`, `.mkv`, `.wmv`, `.flv`, `.f4v`, `.ts`, `.m2ts`, `.mts`, `.vob`.

These are recognized file extensions, not a promise that every codec inside every container is browser-playable. Actual decoding depends on the user's browser, operating system and codecs.

## Preview behavior

1. PhoneBridge creates a short-lived preview session only after checking the signed-in user's ownership of the file.
2. For selected common containers, the app attempts to stream the original first. Transfer-backed files use byte ranges and a bounded cache of verified chunks. Ordinary cloud files use a short-lived signed Storage URL so the Storage service handles range requests.
3. If the browser reports a media decode or playback error, the client retries once with `?convert=1`. If the container is not selected for direct playback, conversion is used from the start.
4. FFmpeg writes a browser-ready MP4 (H.264/AAC) or MP3 into a temporary directory. The stored original is not overwritten. Temporary converted files are removed when their session expires or conversion fails.
5. If FFmpeg cannot decode the source, preview shows an error and the original remains available for download.

The conversion job currently runs in the request path; it is not yet a durable background job with progress tracking. A server restart invalidates in-memory preview/download session tokens and temporary conversion files. The user can request a fresh session from Drive.

## Download and resume behavior

- Transfer-backed files support HTTP byte ranges (`206`), unsatisfiable range responses (`416`), `Accept-Ranges`, `ETag`, `If-Range` and `HEAD`.
- Range reads fetch only the chunks covering the requested bytes and verify each chunk against its stored SHA-256 digest.
- Normal cloud objects are redirected to short-lived private Storage signed URLs; Storage handles the actual object range delivery.
- Browser download resume depends on the browser/client retaining the response validator and issuing a later `Range` request.

## Phone receive limits

The phone browser uses Origin Private File System (OPFS) when `getDirectory` and the returned file handle's `createWritable` API are available. Existing chunks are re-hashed before reuse. If OPFS is unavailable or cannot be opened, PhoneBridge can use a memory fallback for files up to 256 MiB. Larger files remain queued with an actionable error rather than being buffered into phone memory. Actual OPFS quota and behavior must be tested on the target phone/browser.

## Not included in this cloud release

Folder synchronization, notes/version history, remote screen viewing, remote mouse/keyboard input, and host-only security/audit tools remain unavailable in the customer cloud workspace. Do not present these as live features. The paired computer status and approved file-transfer connector are supported; it does not provide arbitrary remote command execution.

## Presentation verification checklist

- Sign in with a prepared test account.
- Pair the computer using the six-digit code and approve it from the signed-in phone.
- Verify the paired computer appears online before starting a transfer.
- Send one small file from phone to PC and confirm it appears under `Documents/PhoneBridge/Incoming`.
- Send one small file from PC to phone and open/save it from the phone.
- Upload a small image or PDF to Drive and preview it.
- Upload a short MP4 and MP3 to Drive; verify video and audio preview and download.
- Test one transfer-backed media file, not only one uploaded directly to Drive.
- Verify sign-out/reload does not accidentally expose another account's files.
- Explain clearly that folder sync, notes and remote screen/control are not part of this cloud release.

For the presentation, use small/medium test media first and keep a downloaded original copy available. Automated test success does not replace this physical-device checklist.