PHONEBRIDGE WINDOWS AGENT

Requirements: Windows 10/11 and Node.js 20 or later.

FIRST-TIME SETUP
1. Install Node.js 20 or later from https://nodejs.org/.
2. Extract this ZIP file to a folder on your computer.
3. Double-click Start-PhoneBridge-Agent.cmd in this folder. The Agent requests a temporary code and opens it in Notepad.
4. On your phone, open PhoneBridge and sign in to the account that should own this computer.
5. Choose Pair a Device and enter the six-digit code shown in Notepad.
6. Keep the Agent window open while it completes enrollment and while you want the computer connected.

The code expires after five minutes and can only be approved once by the signed-in PhoneBridge account that should own the computer. Do not share the code.

The agent connects outbound over HTTPS. It does not require Tailscale, a public IP address, or router port forwarding.

The Agent maintains secure cloud enrollment and reports online/offline connection status only. It does not inspect or modify computer files, launch apps, or execute remote tasks. File transfer, screen streaming, and media streaming are not available in this cloud release.

Agent credentials are stored locally under your Windows user profile in AppData\Local\PhoneBridge\Agent.
