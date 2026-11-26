# Known limitations (0.14.0 beta)

- **Apple Silicon only.** No Intel build yet.
- **Unsigned / not notarised.** Ad-hoc signature only; users must use System Settings → Privacy & Security → Open Anyway once.
- **GitHub Copilot allowance endpoint is unofficial.** GitHub has no published API for an individual's Copilot allowance. The app calls `https://api.github.com/copilot_internal/user` using your own GitHub sign-in, through this project's GitHub App with the `read:user` scope. GitHub may change or remove this endpoint without notice. When it fails, Copilot is marked unavailable and other tools are unaffected. The app doesn't use GitHub's billing API, other apps' GitHub credentials, or the GitHub CLI.
- **No per-request Copilot usage.** Only allowance readings are recorded. Copilot token counts are never invented.
- **Claude subscription limits** come only from Claude Code's documented status-line data (Claude Code 2.1.80+, Pro/Max). They refresh only while Claude Code is in use. Readings are shown only when plausible (0–100 %, and the reset time is within the limit window) and current (not older than the window, not past the reset). Otherwise they show as outdated or unavailable.
- **Claude Code and OpenCode cost** is left empty. Their local files don't record a confirmed price.
- **Check now from the website** reaches the Mac through a small background job that asks the service about once a minute. Macs never accept incoming connections.
- **Hosted service required** for history and the dashboard. The service is proprietary. The app can be pointed at another compatible service with `AUM_API_BASE`, but no open-source server is provided.
