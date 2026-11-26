import { homedir } from "node:os";
import { join } from "node:path";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";

/**
 * Claude Code connector (local, read-only, usage only).
 *
 * Reads Claude Code's session files (~/.claude/projects/**\/*.jsonl) and turns
 * assistant records that carry a `message.usage` block into normalised token
 * usage. Only numbers, model name, session ID and timestamps leave this
 * machine — never prompts, replies, code, tool output or file paths.
 *
 * Claude Code does not write cost, an allowance or a reset date to these
 * files, so none are reported.
 */

export const slug = "claude-code";
export const UNAVAILABLE = "Claude Code usage could not be read on this Mac.";

export function defaultRoot() {
  return process.env.AUM_CLAUDE_DIR || join(homedir(), ".claude", "projects");
}

export function detect(root = defaultRoot()) {
  try {
    return existsSync(root) && statSync(root).isDirectory();
  } catch {
    return false;
  }
}

/** Recursively lists *.jsonl files. No hard-coded project names. */
export function findSessionFiles(root = defaultRoot()) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * TOTAL TOKENS — explicit accounting rule.
 *
 * Claude Code writes Anthropic's Messages API usage block. Per Anthropic's
 * contract the three input fields are a disjoint partition of the prompt:
 *   input_tokens                 = uncached input only
 *   cache_read_input_tokens      = input served from the prompt cache
 *   cache_creation_input_tokens  = input written to the prompt cache
 * The real-device doctor run agreed (cache reads larger than input_tokens
 * occur, impossible if input included cache reads).
 *
 * So total = input + output + cache read + cache write, each counted once —
 * the same meaning OpenCode's total has in this product. If any of the four
 * is missing or not a number, total is left null rather than guessed; the
 * individual fields are still sent. Change here if Claude Code's schema changes.
 */
export function claudeTotal(u) {
  const parts = [u?.input_tokens, u?.output_tokens, u?.cache_read_input_tokens, u?.cache_creation_input_tokens];
  return parts.every(isNum) ? parts.reduce((a, b) => a + b, 0) : null;
}

/** Pure normalisation of one parsed JSONL object. Returns null to skip. */
export function normaliseClaudeRecord(o) {
  if (!o || typeof o !== "object") return null;
  const m = o.message && typeof o.message === "object" ? o.message : null;
  const u = m && m.usage && typeof m.usage === "object" ? m.usage : null;
  if (!u || !m.id) return null;
  if (m.model === "<synthetic>") return null;
  const ms = Date.parse(o.timestamp);
  if (!Number.isFinite(ms)) return null;
  const num = (v) => (isNum(v) ? v : null);
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheWrite) return null; // zero usage
  // Dedup key confirmed by the doctor: session + message + request.
  const externalId = [o.sessionId || "", m.id, o.requestId || ""].join("|").slice(0, 200);
  return {
    externalId,
    occurredAt: new Date(ms).toISOString(),
    model: typeof m.model === "string" ? m.model.slice(0, 200) : null,
    tool: "claude-code",
    sessionId: typeof o.sessionId === "string" ? o.sessionId.slice(0, 200) : null,
    usageUnit: "tokens",
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: claudeTotal(u),
    requests: 1,
    messages: 1,
    cost: null,
  };
}

/**
 * Reads only complete new lines after the checkpoint. A half-written final
 * line is left for the next run. If the file shrank or was replaced, it is
 * read again from the start (server dedup prevents double counting).
 */
export function readNewLines(path, checkpoint) {
  const fd = openSync(path, "r");
  try {
    const st = fstatSync(fd);
    const same = checkpoint && checkpoint.ino === st.ino && checkpoint.dev === st.dev && st.size >= checkpoint.offset;
    let offset = same ? checkpoint.offset : 0;
    const length = st.size - offset;
    const next = { ino: st.ino, dev: st.dev, size: st.size, offset };
    if (length <= 0) return { lines: [], checkpoint: next };
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, offset + read);
      if (n <= 0) break;
      read += n;
    }
    const lastNl = buf.lastIndexOf(0x0a, read - 1);
    if (lastNl < 0) return { lines: [], checkpoint: next };
    const text = buf.subarray(0, lastNl + 1).toString("utf8");
    next.offset = offset + lastNl + 1;
    return { lines: text.split("\n").filter((l) => l.trim()), checkpoint: next };
  } finally {
    closeSync(fd);
  }
}

/**
 * Collects new records across all session files.
 * Returns records (deduplicated within the run) and the checkpoints to save
 * once the upload succeeded.
 */
export function collect({ root = defaultRoot(), checkpoints = {} } = {}) {
  const files = findSessionFiles(root);
  const next = {};
  const byId = new Map();
  for (const f of files) {
    let res;
    try {
      res = readNewLines(f, checkpoints[f]);
    } catch {
      if (checkpoints[f]) next[f] = checkpoints[f];
      continue;
    }
    next[f] = res.checkpoint;
    for (const line of res.lines) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue; // malformed line
      }
      const r = normaliseClaudeRecord(o);
      if (r && !byId.has(r.externalId)) byId.set(r.externalId, r);
    }
  }
  const records = [...byId.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  return { records, checkpoints: next, files: files.length };
}
