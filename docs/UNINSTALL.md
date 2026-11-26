# Uninstalling AI Usage Monitor

## The easy way

Click the AI Usage Monitor icon in the menu bar → **Uninstall AI Usage Monitor…** → confirm.

## What is removed

Only things the app can prove it created:
- The app in `~/Library/Application Support/AI Usage Monitor/`
- Its three background jobs in `~/Library/LaunchAgents/` (labels `app.aiusagemonitor.collector`, `app.aiusagemonitor.collector.checknow`, `app.aiusagemonitor.menubar`). Each is removed only when it both has our label and runs our program.
- Its own files in `~/.aum/`, including this Mac's pairing key
- The Claude status-line forwarder, but only if the app installed it. Your previous status line is restored from the saved backup.
- The GitHub Copilot sign-in saved in the Keychain by this app

## What is never touched

- OpenCode, Claude Code and their history files
- Your GitHub, VS Code or any other app's data
- Any file or setting the app doesn't recognise as its own. These are kept and listed in the confirmation, so you can decide yourself.
- Your account and history on the website. To delete those, sign in and use your account settings, or contact the maintainers.

If something goes wrong, a private log (readable only by you) is saved at `~/Library/Logs/AI Usage Monitor/uninstall.log`. It contains no file contents or keys.

## If the menu bar app won't open

Download the same version again, open it, and choose Uninstall from its menu.
