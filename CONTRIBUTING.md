# Contributing

Thanks for helping! This repository contains the **open-source** parts of AI Usage Monitor: the Mac menu bar app, the local collector and the provider connectors. The hosted website and backend are proprietary and not in this repository.

## Ways to help

- Report bugs with the **Bug report** issue template. Never paste tokens, pairing keys, logs with personal data, or screenshots showing account details.
- Propose a connector for another AI tool. Start with the **New connector proposal** issue, then follow [docs/CONNECTORS.md](docs/CONNECTORS.md).
- Improve documentation.

## Development

```
bun test                              # all tests, synthetic data only
bash scripts/build-mac-app.sh /tmp/b  # optional: build the app
```

See [docs/BUILDING.md](docs/BUILDING.md).

## Pull request rules

1. One focused change per pull request.
2. Tests for new behaviour. `bun test` must pass (GitHub Actions runs it automatically).
3. **Synthetic test data only.** No real logs, IDs, tokens, emails or account screenshots.
4. **No credentials** anywhere: code, tests, fixtures, commit messages or issues.
5. Follow the connector security rules in [docs/CONNECTORS.md](docs/CONNECTORS.md#4-security-and-privacy-requirements-all-mandatory).
6. No new paid services, telemetry, or unnecessary dependencies.
7. Every pull request needs **maintainer review and approval** before merging. Connectors are also tested on a real Mac by a maintainer.

By submitting a contribution you agree it is licensed under the Apache License 2.0.

## Code of conduct

Be kind and constructive. Harassment or abuse isn't tolerated, and maintainers may remove comments or block participants who don't follow this.
