import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Example connector — a complete, working template for new providers.
 *
 * It reads a local JSON Lines file where an imaginary AI tool records one line
 * per request, and turns each line into a normalised usage record that matches
 * the data contract in docs/CONNECTORS.md.
 *
 * Rules every connector follows (and this one demonstrates):
 *  - Read-only: never write to, move or delete the provider's files.
 *  - Usage numbers only: never copy prompts, replies, code, file paths or
 *    credentials into a record.
 *  - Stable externalId: the same request always produces the same ID, so a
 *    re-run never double counts.
 *  - Never guess: a missing number stays null; it is not estimated.
 *  - Incremental: a checkpoint remembers how far we read.
 */

export const slug = "example-provider";
export const UNAVAILABLE = "Example Provider usage could not be read on this Mac.";

export function defaultFile() {
  return process.env.AUM_EXAMPLE_FILE || join(homedir(), ".example-provider", "usage.jsonl");
}

/** True when the provider appears to be installed on this Mac. */
export function detect(file = defaultFile()) {
  try {
    return existsSync(file) && statSync(file).isFile();
  } catch {
    return false;
  }
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Converts one provider line into a normalised record, or null to skip it. */
export function toRecord(line) {
  if (!line || typeof line !== "object") return null;
  if (typeof line.request_id !== "string" || !line.request_id) return null;
  const when = new Date(line.timestamp);
  if (Number.isNaN(when.getTime())) return null;

  const inputTokens = count(line.usage?.input);
  const outputTokens = count(line.usage?.output);
  // Only add up a total when every part is known. Otherwise leave it empty.
  const totalTokens = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;

  return {
    externalId: `${slug}:${line.request_id}`,
    occurredAt: when.toISOString(),
    model: typeof line.model === "string" ? line.model.slice(0, 200) : null,
    tool: slug,
    sessionId: typeof line.session_id === "string" ? line.session_id.slice(0, 200) : null,
    usageUnit: "tokens",
    inputTokens,
    outputTokens,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens,
    cost: null, // The provider does not report cost, so we do not invent one.
    // Deliberately NOT copied: line.prompt, line.reply, line.cwd, line.api_key.
  };
}

/**
 * Reads new lines since the last checkpoint.
 * @returns {{ records: object[], checkpoints: { lines: number } }}
 */
export function collect({ file = defaultFile(), checkpoints = {} } = {}) {
  const lines = readFileSync(file, "utf8").split("\n");
  const start = Number.isInteger(checkpoints.lines) && checkpoints.lines < lines.length ? checkpoints.lines : 0;
  const seen = new Set();
  const records = [];
  let complete = start;
  // The piece after the final newline is empty, or a line still being written:
  // it is read on the next run once it ends with a newline.
  for (let i = start; i < lines.length - 1; i++) {
    const raw = lines[i];
    complete = i + 1;
    if (!raw.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { continue; } // malformed lines are skipped, never fatal
    const record = toRecord(parsed);
    if (record && !seen.has(record.externalId)) {
      seen.add(record.externalId);
      records.push(record);
    }
  }
  return { records, checkpoints: { lines: complete } };
}
