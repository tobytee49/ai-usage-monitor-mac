#!/usr/bin/env bash
set -euo pipefail
# Builds the unsigned (ad-hoc signed) Apple Silicon app and ZIP.
# Run from the repository root:  bash scripts/build-mac-app.sh [output-folder]
# Needs: bun, zig and rcodesign on PATH. If zig/rcodesign are missing but Nix
# is installed, they are run through Nix (the toolchain used for 0.14.0).
OUT="${1:-/tmp/aum-menu-release}"
run_tool() { local t="$1"; shift; if command -v "$t" >/dev/null 2>&1; then "$t" "$@"; else nix run "nixpkgs#$t" -- "$@"; fi; }
APP="$OUT/AI Usage Monitor.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
bun build src/desktop.mjs --compile --target=bun-darwin-arm64 --outfile "$APP/Contents/Resources/aum-collector"
run_tool zig cc -target aarch64-macos-none -mmacosx-version-min=13.0 -Os native/menu.c -o "$APP/Contents/MacOS/AI-Usage-Monitor"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>AI-Usage-Monitor</string>
<key>CFBundleIdentifier</key><string>app.aiusagemonitor.collector</string>
<key>CFBundleName</key><string>AI Usage Monitor</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.14.0</string>
<key>CFBundleVersion</key><string>17</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF
cat > "$OUT/entitlements.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
EOF
# Ad-hoc signature only. No Apple Developer ID or notarisation (free distribution).
run_tool rcodesign sign --code-signature-flags runtime --entitlements-xml-file "$OUT/entitlements.plist" "$APP/Contents/Resources/aum-collector"
run_tool rcodesign sign --code-signature-flags runtime "$APP"
python3 - "$OUT" <<'PY'
import sys, pathlib, zipfile
root = pathlib.Path(sys.argv[1])
app = root / 'AI Usage Monitor.app'
with zipfile.ZipFile(root / 'AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(app.rglob('*')):
        z.write(p, p.relative_to(root))
PY
( cd "$OUT" && shasum -a 256 AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip > SHA256SUMS.txt 2>/dev/null || sha256sum AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip > SHA256SUMS.txt )
echo "Built $OUT/AI-Usage-Monitor-Menu-Bar-0.14.0-mac-arm64.zip"
