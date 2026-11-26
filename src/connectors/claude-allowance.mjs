import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Claude account allowance (subscription capacity), separate from the
 * Claude Code token-usage connector.
 *
 * Source: the documented Claude Code status line. Claude Code pipes a JSON
 * object to the configured statusLine command; for Pro/Max subscribers it
 * contains rate_limits.five_hour / seven_day { used_percentage, resets_at }.
 * Our shim keeps ONLY those four numbers plus the time it saw them. It never
 * reads credentials, never calls Anthropic, and never stores prompts, paths
 * or other session data.
 *
 * ~/.claude/settings.json is modified ONLY by install(), which the desktop
 * app calls after the user explicitly chooses "Enable Claude subscription
 * limits". The original statusLine is backed up and is still run by the shim.
 */

export const slug = "claude-code"; // reported on the existing Claude connection
export const SHIM_ARG = "statusline";

const aumDir = () => process.env.AUM_HOME || join(homedir(), ".aum");
export const settingsPath = () => process.env.AUM_CLAUDE_SETTINGS || join(homedir(), ".claude", "settings.json");
export const statePath = () => join(aumDir(), "state", "claude-allowance.json");
export const originalPath = () => join(aumDir(), "state", "claude-statusline-original.json");
const backupDir = () => join(aumDir(), "backup");

export const WINDOWS = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
};

function writeAtomic(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.aum-tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

export const shimCommand = (executable) => `'${String(executable).replaceAll("'", "'\\''")}' ${SHIM_ARG}`;
const isShim = (statusLine) =>
  typeof statusLine?.command === "string" && /aum-collector'?\s+statusline\s*$/.test(statusLine.command);

/** Throws if settings exist but are not valid JSON, so we never clobber them. */
function readSettings() {
  const p = settingsPath();
  if (!existsSync(p)) return { exists: false, settings: {}, raw: null };
  const raw = readFileSync(p, "utf8");
  const settings = raw.trim() ? JSON.parse(raw) : {};
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Claude settings are not a JSON object.");
  return { exists: true, settings, raw };
}

/** Read-only detection. Never changes anything. */
export function inspect() {
  try {
    const { exists, settings } = readSettings();
    return {
      settingsExists: exists,
      hasStatusLine: Boolean(settings.statusLine),
      installed: isShim(settings.statusLine),
      readable: true,
    };
  } catch {
    return { settingsExists: true, hasStatusLine: false, installed: false, readable: false };
  }
}

/**
 * Explicit-consent install. Backs up settings, saves the original
 * statusLine, then points statusLine at our shim. Idempotent.
 */
export function install(executable, now = new Date()) {
  const { exists, settings, raw } = readSettings();
  if (isShim(settings.statusLine)) return { changed: false, installed: true, backup: null, preservedExisting: existsSync(originalPath()) && Boolean(readOriginal()) };
  let backup = null;
  if (exists) {
    backup = join(backupDir(), `claude-settings-${now.toISOString().replace(/[:.]/g, "-")}.json`);
    writeAtomic(backup, raw);
  }
  const original = settings.statusLine ?? null;
  writeAtomic(originalPath(), JSON.stringify({ statusLine: original, savedAt: now.toISOString() }, null, 2));
  const next = {
    ...settings,
    statusLine: {
      ...(original && typeof original === "object" ? original : {}),
      type: "command",
      command: shimCommand(executable),
    },
  };
  const mode = exists ? statSync(settingsPath()).mode & 0o777 : 0o644;
  writeAtomic(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, mode);
  const verified = inspect().installed;
  if (!verified) throw new Error("Claude settings could not be updated.");
  return { changed: true, installed: true, backup, preservedExisting: Boolean(original) };
}

function readOriginal() {
  try {
    return JSON.parse(readFileSync(originalPath(), "utf8")).statusLine ?? null;
  } catch {
    return null;
  }
}

/** Puts the user's original statusLine back (or removes ours). */
export function restore() {
  const { exists, settings } = readSettings();
  if (!exists || !isShim(settings.statusLine)) return { changed: false };
  const original = readOriginal();
  const next = { ...settings };
  if (original) next.statusLine = original;
  else delete next.statusLine;
  writeAtomic(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, statSync(settingsPath()).mode & 0o777);
  return { changed: true };
}

const pct = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null);
const epoch = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? new Date(v * 1000).toISOString() : null);
const WINDOW_MS = { five_hour: 5 * 3_600_000, seven_day: 7 * 86_400_000 };
const SKEW_MS = 10 * 60_000;
/** Reset must fall within one window length of the observation. */
export function plausibleWindow(key, usedPercentage, resetsAt, observedAt) {
  const len = WINDOW_MS[key];
  if (!len || pct(usedPercentage) == null || !resetsAt) return false;
  const r = Date.parse(resetsAt);
  const o = Date.parse(observedAt);
  return Number.isFinite(r) && Number.isFinite(o) && r >= o - SKEW_MS && r <= o + len + SKEW_MS;
}

/** Pure: keeps only plausible readings of the two windows. Null when none. */
export function extractRateLimits(input, now = new Date()) {
  const rl = input && typeof input === "object" ? input.rate_limits : null;
  if (!rl || typeof rl !== "object") return null;
  const windows = {};
  for (const key of Object.keys(WINDOWS)) {
    const w = rl[key];
    const usedPercentage = pct(w?.used_percentage);
    const resetsAt = epoch(w?.resets_at);
    if (usedPercentage == null || !plausibleWindow(key, usedPercentage, resetsAt, now.toISOString())) continue;
    windows[key] = { usedPercentage, resetsAt };
  }
  return Object.keys(windows).length ? windows : null;
}

/**
 * The shim. Records allowance state (if present), then forwards the exact
 * same stdin to the user's original status line and returns its output.
 * Never throws: Claude Code's display must not break because of us.
 */
export function runShim(stdinText, { now = new Date(), run = spawnSync } = {}) {
  try {
    const windows = extractRateLimits(JSON.parse(stdinText), now);
    if (windows) {
      writeAtomic(statePath(), JSON.stringify({ version: 1, observedAt: now.toISOString(), windows }, null, 2));
    }
  } catch {
    // Malformed input or unwritable state: leave the previous state as is.
  }
  const original = readOriginal();
  if (original?.type === "command" && typeof original.command === "string" && original.command.trim()) {
    const res = run("/bin/sh", ["-c", original.command], { input: stdinText, encoding: "utf8", maxBuffer: 1 << 20 });
    return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: typeof res.status === "number" ? res.status : 0 };
  }
  return { stdout: "", stderr: "", status: 0 };
}

export function readAllowanceState() {
  try {
    const s = JSON.parse(readFileSync(statePath(), "utf8"));
    return s && s.windows && typeof s.observedAt === "string" ? s : null;
  } catch {
    return null;
  }
}

/** Allowance observations: percent only. No totals, tokens or cost invented. */
export function toObservations(state) {
  if (!state) return [];
  return Object.entries(WINDOWS)
    .filter(([key]) => {
      const w = state.windows[key];
      // Never upload an implausible reading (e.g. old diagnostic state).
      return w && plausibleWindow(key, w.usedPercentage, w.resetsAt, state.observedAt);
    })
    .map(([key, label]) => ({
      unit: "percent",
      percentUsed: state.windows[key].usedPercentage,
      resetAt: state.windows[key].resetsAt,
      observedAt: state.observedAt,
      category: key,
      categoryLabel: label,
      planLabel: "Claude subscription",
    }));
}
