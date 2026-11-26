# AI Usage Monitor 0.14.0: first public beta

Free, open-source menu bar app for Apple Silicon Macs that shows how much of your AI tools' allowances you have left.

**Download:** `AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip`
**SHA-256:** `96dcbc21051d1f8a12ff794c04ca25c6796b158aa9bb1d1abcaa19ffec741a9d`

This is the exact build that was tested on a Mac before release. It was not rebuilt.

## Included
- Menu bar view of GitHub Copilot allowances, Claude subscription limits (optional), OpenCode and Claude Code checks
- "Last checked" status and **Check now**
- Safe **Uninstall** from the menu
- Automatic checks every 15 minutes; website "Check now" picked up within about a minute

## Install
Unzip, open, then System Settings → Privacy & Security → **Open Anyway** (the app isn't notarised by Apple). Full steps: docs/INSTALL.md.

## Known limitations
- Apple Silicon only, macOS 13+
- GitHub Copilot allowance uses an unofficial GitHub endpoint that may change
- Claude subscription limits refresh only while you use Claude Code (Pro/Max)

See docs/LIMITATIONS.md.
