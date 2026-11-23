PHONEBRIDGE WINDOWS AGENT

Requirements: Windows 10/11 and Node.js 20 or later.

FIRST-TIME SETUP
1. Install Node.js 20 or later from https://nodejs.org/.
2. Extract this ZIP file to a folder on your computer.
3. Open PhoneBridge in your browser and sign in.
4. In Your PhoneBridge workspace, choose Pair a computer and generate a six-digit code.
5. Double-click Start-PhoneBridge-Agent.cmd in this folder.
6. Enter the six-digit code when the agent asks you to approve this computer.
7. Keep the agent window open while you want the computer connected.

The code expires after five minutes and can only be used once. Only enter a code you generated while signed in to your own PhoneBridge account.

The agent connects outbound over HTTPS. It does not require Tailscale, a public IP address, or router port forwarding.

The agent currently supports system information, listing and reading files in the PhoneBridge workspace, creating folders, writing files after owner approval, and launching approved applications. Screen sharing and remote mouse/keyboard control are not available.

Agent credentials are stored locally under your Windows user profile in AppData\Local\PhoneBridge\Agent.
