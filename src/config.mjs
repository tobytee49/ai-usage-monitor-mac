import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";

export const CONFIG_DIR = join(homedir(), ".aum");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STATE_PATH = join(CONFIG_DIR, "state.json");

export const DEFAULT_API_BASE = "https://project--90f1947c-aecf-4a7d-b306-1bb570686772.lovable.app";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(path, value) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Config holds the pairing key — never log or print it back. */
export function readConfig() {
  const config = readJson(CONFIG_PATH, {});
  return {
    apiBase: process.env.AUM_API_BASE || config.apiBase || DEFAULT_API_BASE,
    token: process.env.AUM_TOKEN || config.token || null,
    openCodeDb: process.env.AUM_OPENCODE_DB || config.openCodeDb || null,
    intervalMinutes: Number(process.env.AUM_INTERVAL || config.intervalMinutes || 15),
  };
}

export function writeConfig(patch) {
  const current = readJson(CONFIG_PATH, {});
  writeJson(CONFIG_PATH, { ...current, ...patch });
}

/** Local high-water mark so each run only uploads new rows. Never leaves the machine. */
export function readState() {
  return readJson(STATE_PATH, {});
}

export function writeState(patch) {
  const current = readJson(STATE_PATH, {});
  writeJson(STATE_PATH, { ...current, ...patch });
}
