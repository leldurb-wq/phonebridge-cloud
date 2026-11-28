PHONEBRIDGE WINDOWS CONNECTOR

Requirements: Windows 10/11 and Node.js 20 or later.

FIRST START
1. Install Node.js 20 or later from https://nodejs.org/.
2. Extract the entire ZIP into a normal folder (do not run files from inside the ZIP).
3. Double-click Start-PhoneBridge.cmd. Keep internet access enabled while the first-run runtimes install. The launcher installs FFmpeg and WebRTC automatically into your Windows user profile, then starts PhoneBridge quietly.
4. Open https://phonebridge.msbundle.store on your computer and sign in.
5. Select Pair this computer. The computer displays a six-digit code that expires after five minutes.
6. Open PhoneBridge on your phone, sign in, enter the code and tap Connect.

IMPORTANT: Always start the connector by double-clicking Start-PhoneBridge.cmd. Do not launch cloud-worker.js directly; the launcher prepares the FFmpeg and WebRTC module paths first.

The connector uses localhost and outbound HTTPS. It does not require Tailscale, a public IP address, router port forwarding, or an inbound firewall port. The connector accepts local browser requests only from the official PhoneBridge website.

Files received from the phone are verified and saved under Documents\PhoneBridge\Incoming. Transfers use verified 8 MB chunks and support files up to 2 GB. A private diagnostic log is written to AppData\Local\PhoneBridge\Agent\connector.log. Remote mouse/keyboard input is not enabled.

Existing device credentials remain under AppData\Local\PhoneBridge\Agent.
