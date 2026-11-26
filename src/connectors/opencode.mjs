import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * OpenCode connector (local, read-only).
 *
 * Mirrors `src/lib/connectors/opencode.ts` in the web app so both sides agree
 * on the normalised shape. Raw rows, prompts and file paths stay on this
 * machine — only the normalised fields below are ever uploaded.
 */

export const slug = "opencode";

const CANDIDATE_PATHS = [
  join(homedir(), ".local", "share", "opencode", "opencode.db"),
  join(homedir(), "Library", "Application Support", "opencode", "opencode.db"),
  join(homedir(), ".opencode", "opencode.db"),
];

export function resolveDbPath(configured) {
  if (configured) return existsSync(configured) ? configured : null;
  return CANDIDATE_PATHS.find((p) => existsSync(p)) ?? null;
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  const n = Number(value);
  if (!Number.isFinite(n)) return new Date(value).toISOString();
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Pure normalisation: a decoded OpenCode message -> the product's usage shape. */
export function normaliseOpenCodeMessage(row) {
  const tokens = row.tokens ?? {};
  const cache = tokens.cache ?? {};
  const input = num(tokens.input);
  const output = num(tokens.output);
  const cacheRead = num(cache.read);
  const cacheWrite = num(cache.write);
  const total = num(tokens.total) ?? (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  return {
    externalId: String(row.id),
    occurredAt: toIso(row.time?.completed ?? row.time?.created ?? null),
    model: row.modelID ?? null,
    tool: "opencode",
    sessionId: row.sessionID ?? null,
    usageUnit: "tokens",
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: total,
    cost: num(row.cost),
  };
}

function listTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all()
    .map((r) => r.name);
}

function safeParse(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/**
 * Reads assistant messages with usage out of OpenCode's local SQLite database.
 * OpenCode stores each record as a JSON blob, so we decode defensively rather
 * than assuming a fixed column layout.
 */
export function collect({ Database, dbPath, sinceMs }) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = listTables(db);
    const table = ["message", "messages", "kv"].find((t) => tables.includes(t));
    if (!table) {
      throw new Error(
        `No recognised OpenCode table found (saw: ${tables.join(", ") || "none"}). ` +
          "Run with AUM_DEBUG=1 and report this so the connector can be updated.",
      );
    }

    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const jsonColumn = ["data", "value", "json", "body"].find((c) => columns.includes(c));
    if (!jsonColumn) {
      throw new Error(`OpenCode table "${table}" has no JSON payload column.`);
    }
    const keyColumn = ["id", "key", "rowid"].find((c) => columns.includes(c)) ?? "rowid";

    const rows = db.prepare(`SELECT ${keyColumn} AS k, ${jsonColumn} AS payload FROM ${table}`).all();

    const records = [];
    for (const row of rows) {
      const parsed = safeParse(row.payload);
      if (!parsed) continue;
      const message = parsed.tokens || parsed.time ? parsed : parsed.message ?? null;
      if (!message || typeof message !== "object") continue;
      if (!message.tokens && message.cost == null) continue;

      const record = normaliseOpenCodeMessage({
        ...message,
        id: message.id ?? String(row.k),
      });
      if (!record.totalTokens && !record.cost) continue;
      if (sinceMs && new Date(record.occurredAt).getTime() <= sinceMs) continue;
      records.push(record);
    }

    records.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return records;
  } finally {
    db.close();
  }
}

/** OpenCode exposes no quota or allowance, so we never invent one. */
export const providesAllowance = false;
