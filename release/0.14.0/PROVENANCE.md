# Source ↔ release correspondence for 0.14.0

The 0.14.0 ZIP was built from the same app source that is in this repository's first commit.

How it was checked (by the maintainers, before publication):
- **Collector part** (`Contents/Resources/aum-collector`). A fresh `bun build src/desktop.mjs --target=bun` bundle (Bun 1.4.4) was compared line by line with the JavaScript embedded in the released binary. All 1,122 meaningful lines match. The only differences are five lines the compiler removes when building for macOS (the `process.platform !== "darwin"` guard).
- **Menu bar part** (`Contents/MacOS/AI-Usage-Monitor`). Rebuilding `native/menu.c` with zig 0.16 gives the same machine code. Only the Mach-O header (sizes, build UUID) and the code-signature area differ.

Differences between this repository and the internal source tree the ZIP was built from. None of these affect the app:
- `test/menu-sync-e2e.test.mjs`: file paths updated for the repository layout.
- `scripts/build-mac-app.sh`: renamed, paths updated, uses zig/rcodesign from PATH when available, and writes SHA256SUMS.txt.
- Added: documentation, an example connector with tests, GitHub Actions workflows and templates.
- Not included: four tests that check the private website, and one diagnostic script that is no longer used.
