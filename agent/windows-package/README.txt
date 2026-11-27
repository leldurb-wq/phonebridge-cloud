PHONEBRIDGE WINDOWS BACKGROUND CONNECTOR

Requirements: Windows 10/11 and Node.js 20 or later.

ONE-TIME SETUP
1. Install Node.js 20 or later from https://nodejs.org/.
2. Extract this package to a folder on your computer.
3. Double-click Start-PhoneBridge.cmd. It starts the PhoneBridge connector quietly in the background. No terminal or Agent window is shown.
4. Open https://phonebridge-cloud.onrender.com in your computer browser and sign in.
5. In PhoneBridge on the computer, tap Pair this computer. A six-digit code appears and expires after five minutes.
6. Open PhoneBridge on your phone, sign in to the same account, enter the code and tap Connect.
7. The computer connects automatically after approval.

The connector runs locally on 127.0.0.1 and makes outbound HTTPS connections to PhoneBridge Cloud. It does not require Tailscale, a public IP address, router port forwarding, or opening a firewall port.

The local browser connection accepts requests only from the official PhoneBridge website. Pairing codes are short-lived and single-use. The phone must be signed in to the same account that owns the computer.

The connector maintains secure enrollment and quietly checks for authorized file transfers. It writes only completed, integrity-checked transfers to Documents\PhoneBridge\Incoming. Files are delivered in 8 MB chunks, up to 2 GB per file. Temporary network interruptions are retried; verified chunks and completed files are checked again before resuming, so retries do not create duplicate files. A private diagnostic log is written to AppData\Local\PhoneBridge\Agent\connector.log. It does not expose a terminal, launch apps, or execute arbitrary remote tasks. Live screen viewing uses a direct WebRTC video connection when the network allows it, targeting 30 FPS at 720p and adapting to available network capacity. A JPEG compatibility preview remains available when direct peer-to-peer connectivity cannot be established. The first launch downloads the FFmpeg and WebRTC screen runtime. Remote mouse/keyboard input and system audio are not enabled.

Existing device credentials remain in the current Windows user profile under AppData\Local\PhoneBridge\Agent.
