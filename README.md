# AI Usage Monitor for Mac

**See how much of your AI tools' allowances you have left — right from your Mac's menu bar.**

AI Usage Monitor is a small menu bar app for Apple Silicon Macs. It checks the AI coding tools you use, shows how much allowance is left and when it resets, and keeps a history in your private online dashboard at [ambient-ai-watch.lovable.app](https://ambient-ai-watch.lovable.app).

It is free.

## What is open source, and what is not

| Part | Open source? |
| --- | --- |
| Mac menu bar app | Yes, Apache-2.0 (this repository) |
| Local collector (the part that reads usage on your Mac) | Yes, Apache-2.0 (this repository) |
| Provider connectors (OpenCode, Claude Code, Claude subscription limits, GitHub Copilot) | Yes, Apache-2.0 (this repository) |
| Hosted dashboard website and backend | **No.** These are proprietary and run by the AI Usage Monitor team |

You can read every line of code that runs on your Mac. The website that stores your history is a hosted service and is not included here.

## Supported tools

| Tool | What you see |
| --- | --- |
| **OpenCode** | Token usage from OpenCode's local database |
| **Claude Code** | Token usage from Claude Code's local session files |
| **Claude subscription limits** (Pro/Max) | 5-hour and weekly limit used, with reset times. Optional; you switch it on |
| **GitHub Copilot** | Chat, code completion and premium request allowances, with reset date. You connect your GitHub account |

## Install (about 3 minutes)

1. Download `AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip` from the [Releases page](../../releases) or the Collector page on the website.
2. Double-click the ZIP to unzip it, then double-click **AI Usage Monitor**.
3. macOS will warn that it can't check the app. **This is expected**, because the app is not paid-signed by Apple. Click **Done** (or **Cancel**).
4. Open **System Settings → Privacy & Security**, scroll down to **Security**, and click **Open Anyway** next to AI Usage Monitor. Confirm with your password or Touch ID.
5. The app opens your browser. Sign in (or create a free account) and click **Allow this Mac**.
6. The AI Usage Monitor icon appears in your menu bar. You're done.

Full step-by-step guide with troubleshooting: [docs/INSTALL.md](docs/INSTALL.md).

## Uninstall

Click the menu bar icon, choose **Uninstall AI Usage Monitor…**, then confirm. Details: [docs/UNINSTALL.md](docs/UNINSTALL.md).

## Your data: what stays on your Mac and what is sent

**Stays on your Mac, always:**
- Your prompts, AI replies, code and file names
- Your tools' raw databases and session files
- Your GitHub sign-in (stored in the macOS Keychain)
- Your Claude account sign-in (the app never reads it)

**Sent to the hosted service** (only after you approve this Mac in your account):
- Numbers: input, output and cache token counts per request, and request counts where available
- The AI model name, the tool name, a session ID and the time of each request
- Allowance readings: total, used, remaining, percent used and reset time
- A short status for each tool, such as "connected" or "could not be read", plus the app version

The app never sends cost estimates it can't confirm, and never fills in numbers a tool did not report.

Each Mac gets its own private pairing key when you click **Allow this Mac**. Your history is visible only to your account.

## Important limitations

- **Apple Silicon Macs only** (M1 or newer), macOS 13 or later.
- **Not Apple-notarised.** You need the one-time **Open Anyway** step above.
- **GitHub Copilot uses an unofficial GitHub endpoint.** GitHub doesn't publish an official API for personal Copilot allowances. The app reads the same allowance data GitHub shows you, from an internal endpoint that GitHub can change or remove at any time. If that happens, Copilot shows "unavailable" and your other tools keep working.
- **Claude subscription limits only update while you use Claude Code.** Readings come from Claude Code's status line, and only on Claude Pro or Max. If you haven't used Claude Code recently, the reading is marked outdated and no percentage is shown. A successful sync does not mean the Claude reading was refreshed.
- **The website can't reach your Mac directly.** "Check now" on the website is picked up by your Mac within about a minute.

More: [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## For developers

- Build from source: [docs/BUILDING.md](docs/BUILDING.md)
- Add support for a new AI tool: [docs/CONNECTORS.md](docs/CONNECTORS.md)
- Contribute: [CONTRIBUTING.md](CONTRIBUTING.md)
- Report a security issue: [SECURITY.md](SECURITY.md)

## Licence

The code in this repository is licensed under the [Apache License 2.0](LICENSE). The hosted AI Usage Monitor service, website and backend are not covered by this licence.
