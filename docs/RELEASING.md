# Releasing

1. Update the version in `src/local-status.mjs` (`VERSION`) and in `scripts/build-mac-app.sh` (Info.plist and ZIP name).
2. Push a tag such as `v0.14.1`. The **Build release** GitHub Action runs the tests, builds the ZIP and creates a **draft** release with the ZIP and `SHA256SUMS.txt`.
3. A maintainer downloads the draft ZIP and tests it on a real Mac: Open Anyway, pairing, Check now, uninstall.
4. Only then edit the draft, add release notes and click **Publish release**.

The first public release (0.14.0) is the exact ZIP that was already tested on a Mac. It was uploaded by hand, not rebuilt by CI. See `release/0.14.0/`.
