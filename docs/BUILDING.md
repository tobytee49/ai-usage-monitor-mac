# Building and testing

## Run the tests

1. Install [Bun](https://bun.sh) 1.x.
2. In the repository folder run:

```
bun test
```

The tests use only synthetic data and never contact real services.

## Build the Mac app

Needs `bun`, [`zig`](https://ziglang.org) (0.16) and [`rcodesign`](https://github.com/indygreg/apple-platform-rs) on your PATH. If you have Nix instead, the script runs zig and rcodesign through Nix. Building works on Linux or macOS.

```
bash scripts/build-mac-app.sh /tmp/aum-build
```

This produces `AI-Usage-Monitor-Menu-Bar-<version>-mac-arm64.zip` with an ad-hoc signature, plus `SHA256SUMS.txt`.

**Builds are not byte-for-byte reproducible.** Compiler UUIDs and signatures differ between builds. Official releases are only the ZIPs maintainers have tested on a real Mac.

## Where the app connects

`src/config.mjs` and `src/desktop.mjs` contain the hosted service address. In 0.14.0 this is `https://project--90f1947c-aecf-4a7d-b306-1bb570686772.lovable.app`, the API address of the same published app whose pages are served at `https://ambient-ai-watch.lovable.app` (the API address answers only `/api/public/*`). Both addresses are public and contain no credentials. For development you can override it:

```
AUM_API_BASE=https://your-test-server.example ./bin/aum-collector.mjs sync
```

## How releases are made

See [RELEASING.md](RELEASING.md).
