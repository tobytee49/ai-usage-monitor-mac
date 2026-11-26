# Security policy

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Use GitHub's private reporting: go to this repository's **Security** tab → **Report a vulnerability**. We aim to reply within 7 days.

Please include the affected version, steps to reproduce and impact. Never include real tokens or other people's data.

## Scope

In scope: the Mac app, collector and connectors in this repository, and how they talk to the hosted service.

The hosted website and backend are proprietary. You can report issues you notice with them the same way, but don't run automated scans, load tests or attempts to access other users' data against the live service.

## How the app protects you

- Each Mac has its own pairing key, created only after you approve the Mac while signed in. The key is stored in `~/.aum/config.json`, readable only by your user (mode 600). It can upload data for your account only, and can be revoked from the website.
- The GitHub Copilot sign-in uses this project's own GitHub App (device flow, `read:user` scope). It is stored only in the macOS Keychain (service `ai-usage-monitor-github`) and never sent to the hosted service.
- The public GitHub App **client ID** in the source code is not a secret. The device flow doesn't use a client secret.
- The hosted service address in the source code is public. Everything it stores is protected per user. Uploads without a valid pairing key are refused.
- The app never reads other apps' credentials, prompts, replies or code.

## Supported versions

Only the latest release receives fixes during the beta.
