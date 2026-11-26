# Installing AI Usage Monitor

**You need:** a Mac with Apple Silicon (M1 or newer), macOS 13 Ventura or later, and a free account at https://ambient-ai-watch.lovable.app (you can create it during setup).

## 1. Download

Get `AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip` from either:
- this repository's **Releases** page, or
- the **Collector** page after signing in to the website.

Optional, for extra safety: check the file matches the published checksum. Open Terminal (press Cmd + Space, type `Terminal`, press Return) and paste:

```
shasum -a 256 ~/Downloads/AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip
```

The long code it prints must match the one in the release's `SHA256SUMS.txt`:
`96dcbc21051d1f8a12ff794c04ca25c6796b158aa9bb1d1abcaa19ffec741a9d`

## 2. Unzip and open

Double-click the ZIP in Downloads. Double-click **AI Usage Monitor**.

## 3. Allow the app to open (one time only)

The app isn't notarised by Apple (that costs a yearly fee), so macOS blocks it the first time.

1. A message says Apple could not verify the app. Click **Done** (on older macOS, **Cancel**). Do **not** click Move to Bin.
2. Open the **Apple menu → System Settings → Privacy & Security**.
3. Scroll down to the **Security** section. You'll see *"AI Usage Monitor" was blocked…*. Click **Open Anyway**.
4. Enter your Mac password or use Touch ID. Click **Open Anyway** again if asked.

On macOS 15 Sequoia and later, right-clicking the app and choosing Open no longer skips this. Use the System Settings steps above.

## 4. Connect your account

The app opens your browser to the website. Sign in or create an account, then click **Allow this Mac**. The app copies itself into your user Library and starts at login, so you can delete the downloaded copy.

## 5. Optional connections

- **GitHub Copilot:** the app shows a short code. Click to open GitHub, paste the code and approve. Your GitHub sign-in is saved in your Mac's Keychain.
- **Claude subscription limits:** the app asks before changing anything. If you agree, it adds a small forwarder to Claude Code's status line and keeps a backup of your previous setting. If you decline, nothing changes.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Damaged and can't be opened" | Download again with Safari or Chrome. Don't unzip with a third-party tool. |
| No Open Anyway button | Try opening the app once more, then look in Privacy & Security again. The button only appears for about an hour after a blocked attempt. |
| macOS says it can run in the background | This is normal. The app checks your tools every 15 minutes. |
| Website says "Never synced" | Open the menu bar icon and choose **Check now**. Make sure you approved this Mac while signed in to the right account. |
