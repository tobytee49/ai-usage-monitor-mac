# Writing a connector

A **connector** teaches AI Usage Monitor to read one AI tool's usage on the Mac. This guide takes you from nothing to a pull request. A complete working example lives in [`examples/connectors/example-provider.mjs`](../examples/connectors/example-provider.mjs), with synthetic data and tests in [`test/example-connector.test.mjs`](../test/example-connector.test.mjs).

## 1. How the pieces fit

```text
 AI tool's local files / your own account API
            |
            v
   src/connectors/<tool>.mjs      read-only, returns normalised records
            |
            v
   src/sync.mjs                   batches records, keeps checkpoints,
            |                     isolates failures per tool
            v
   POST /api/public/collector/ingest   (hosted service, needs this Mac's pairing key)
```

A connector **only reads and converts**. Uploading, retries, pairing keys and scheduling are handled by `src/sync.mjs`. A connector never sees the pairing key.

## 2. The connector interface

Copy `examples/connectors/example-provider.mjs` to `src/connectors/<your-tool>.mjs` and keep these exports:

| Export | Purpose |
| --- | --- |
| `slug` | Lowercase ID, e.g. `"my-tool"`. Must match a provider the hosted service knows (see step 6). |
| `UNAVAILABLE` | Short, user-friendly message shown when reading fails. No paths or error dumps. |
| `detect(location?)` | Returns `true` if the tool seems installed. Must never throw. |
| `collect({ ...location, checkpoints })` | Returns `{ records, checkpoints }`. `checkpoints` is any small JSON object you need to resume where you stopped. |

Allowance-only providers (like GitHub Copilot) return observations instead of records. See `src/connectors/copilot.mjs`.

## 3. The data contract

The hosted service rejects anything that doesn't match this shape. Unknown fields are dropped.

### Usage record (one per request)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `externalId` | string, 1–200 chars | yes | **Stable and unique.** Same request → same ID, every run. Prefix with your slug. It is how duplicates are removed. |
| `occurredAt` | ISO-8601 date-time | yes | When the request happened. |
| `model` | string ≤ 200 | no | Model name as the tool reports it. |
| `tool` | string ≤ 200 | no | Usually your slug. |
| `sessionId` | string ≤ 200 | no | The tool's own session ID. Never a file path. |
| `usageUnit` | `tokens` \| `requests` \| `messages` \| `credits` | no (default `tokens`) | |
| `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens` | non-negative integer or `null` | no | **Never estimate.** Use `null` when not reported. Only compute `totalTokens` when every part is known and you have checked the provider's documentation that the parts don't overlap. |
| `requests`, `messages` | non-negative integer or `null` | no | |
| `credits`, `cost` | non-negative number or `null` | no | Only if the tool itself reports it. Never calculate prices. |

### Allowance observation (optional)

| Field | Type | Notes |
| --- | --- | --- |
| `unit` | `tokens` \| `requests` \| `messages` \| `credits` \| `percent` | |
| `allowanceTotal`, `allowanceUsed`, `allowanceRemaining` | number ≥ 0 or `null` | A total of `0` means "Not included", never "100 % used". |
| `percentUsed` | number 0–1000 or `null` | |
| `periodStart`, `resetAt` | ISO date string or `null` | |
| `observedAt` | ISO date string | required |
| `category`, `categoryLabel` | string | For several allowances, e.g. `chat` / "Chat". |
| `planLabel` | string | e.g. "Free" |
| `unlimited` | boolean | |

Limits per upload: 1,000 usage records, 20 allowances.

## 4. Security and privacy requirements (all mandatory)

A connector is rejected if it does any of these:

1. **Uploads content.** No prompts, replies, code, tool output, file names, file paths, repository names or email addresses.
2. **Reads someone else's credentials.** Never read tokens, cookies or keys belonging to another app, browser, IDE or CLI (for example VS Code, Safari, Chrome, the GitHub CLI). If an account sign-in is needed, use the provider's official public sign-in flow under this project's own app registration, and store the result only in the macOS Keychain.
3. **Requires a command-line tool** the user must install, or asks the user to paste tokens.
4. **Writes to the tool's files or settings** without explicit, opt-in user consent and a backup (see the Claude status-line consent flow in `src/connectors/claude-allowance.mjs`).
5. **Logs secrets.** Never print, log or include a token, key or device code in errors.
6. **Guesses numbers.** Missing stays `null`. No invented costs, totals or allowances.
7. **Breaks other connectors.** Every failure must be caught and reported through `UNAVAILABLE`. One tool failing must never stop another.
8. **Adds network calls** other than the provider's own documented API. No analytics or third-party services.
9. **Adds dependencies** without a clear need. Prefer Node/Bun built-ins.

Document in your connector's header comment exactly which files or endpoints it reads, and whether any endpoint is undocumented.

## 5. Testing

- Put **synthetic** fixtures next to your test or under `examples/` or a `fixtures/` folder. Never commit real logs, real session files, real IDs, real tokens or screenshots of real accounts. Make fake IDs obviously fake (`req-001`, `synthetic-not-a-real-key`).
- Include in the fixture a field that must **not** be uploaded (a fake prompt, path or key), and assert it doesn't appear in the output, as `test/example-connector.test.mjs` does.
- Cover: normal records, duplicates, missing numbers (`null` total), malformed lines, resuming from a checkpoint, and the tool not being installed.
- Run everything:

```
bun test
```

Point a connector at a fixture with an environment variable (the example uses `AUM_EXAMPLE_FILE`), so tests never read the developer's real files.

## 6. Wiring it in

1. Add a `syncMyTool()` function to `src/sync.mjs`, modelled on `syncClaudeCode()`. Read the checkpoint from state, call `collect`, post in batches, save the checkpoint only after success, and catch every error.
2. Call it from `syncOnce()` alongside the others.
3. If the menu should show it, add a row in `menuRows()` in `src/local-status.mjs`, with tests.

**The hosted service must know your slug.** Until a maintainer adds it to the service's provider catalogue, uploads are refused with "Unknown provider". Say in your pull request what name, description and units the provider should have. Maintainers handle that step.

## 7. Submitting

1. Fork the repository and create a branch.
2. Make your change with tests. Run `bun test`.
3. Open a pull request using the template. Tick the security checklist honestly.
4. A maintainer reviews the code, checks the fixtures are synthetic, and tests on a real Mac before merging. Connectors are never merged without maintainer review.

Questions? Open an issue with the **New connector proposal** template before writing a lot of code.
