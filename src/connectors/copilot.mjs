import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { keychainReadToken } from "../github-device-auth.mjs";

/**
 * GitHub Copilot connector (local, read-only) — EXPERIMENTAL.
 *
 * Copilot publishes an allowance and a reset date but no usage events, so this
 * connector records allowance observations only. Nothing is ever estimated.
 *
 * The credential is the one the Copilot editor extension already stored on
 * this machine. It is read locally, used locally for a single HTTPS request,
 * and NEVER uploaded. Only the normalised numbers are sent to the cloud.
 *
 * The quota endpoint is the one GitHub's own editor extensions call. It is not
 * a supported public API: every failure here is swallowed and reported as
 * "Copilot allowance unavailable" so the collector run, OpenCode and every
 * other provider carry on untouched.
 */

export const slug = "github-copilot";

export const UNAVAILABLE = "Copilot allowance unavailable";

const QUOTA_URL = "https://api.github.com/copilot_internal/user";

const CONFIG_DIRS = [
  join(homedir(), ".config", "github-copilot"),
  join(homedir(), "Library", "Application Support", "github-copilot"),
  join(homedir(), ".copilot"),
  join(homedir(), "Library", "Application Support", "GitHub Copilot"),
];

export const NOT_SIGNED_IN =
  "GitHub Copilot is not connected. Choose Connect GitHub Copilot to connect it.";

export const DISCONNECTED =
  "GitHub no longer accepts this Mac's connection. Choose Connect GitHub Copilot to reconnect.";

const TOKEN_PATTERN = /\b(gho_|ghu_|ghp_|ghs_|github_pat_)[A-Za-z0-9_]{20,}\b/;

const CATEGORY_LABELS = {
  chat: "Chat",
  completions: "Code completions",
  premium_interactions: "Premium requests",
  premium_requests: "Premium requests",
  ai_credits: "AI credits",
};

function categoryLabel(category) {
  return (
    CATEGORY_LABELS[category] ??
    String(category).replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Finds the OAuth token the Copilot editor extension stored locally.
 * Returns null when Copilot is not signed in on this machine.
 */
function scanFileForToken(path) {
  try {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "latin1");
    const match = text.match(TOKEN_PATTERN);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

export function findLocalToken() {
  // 1. Our own credential, stored in the macOS Keychain by the device login.
  const own = keychainReadToken();
  if (own) return own;

  // 2. Environment credentials, if the user already exports one.
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 10) return value;
  }

  // 3. GitHub CLI, only when it is already installed and signed in. Never
  //    required — most users will not have it.
  try {
    const which = spawnSync("which", ["gh"], { encoding: "utf8" });
    if (which.status === 0) {
      const res = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
      const token = res.status === 0 ? res.stdout.trim() : "";
      if (token.length > 10) return token;
    }
  } catch {
    // gh is absent; fall through to legacy files.
  }

  // 4. Copilot / Copilot CLI legacy JSON credential files (Neovim-era).
  for (const dir of CONFIG_DIRS) {
    for (const file of ["apps.json", "hosts.json"]) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const json = readJson(path);
      if (!json || typeof json !== "object") continue;
      for (const entry of Object.values(json)) {
        const token = entry && typeof entry === "object" ? entry.oauth_token : null;
        if (typeof token === "string" && token.length > 10) return token;
      }
    }
  }

  // 5. Newer local stores (auth.db and friends). Read locally, in memory only.
  for (const dir of CONFIG_DIRS) {
    for (const file of ["auth.db", "credentials.json", "token.json"]) {
      const token = scanFileForToken(join(dir, file));
      if (token) return token;
    }
  }

  return null;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseResetDate(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const raw = value.trim();
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw;
  const time = new Date(candidate).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** Pure normalisation: the account's quota response -> allowance observations. */
export function normaliseQuota(response, observedAt = new Date().toISOString()) {
  if (!response || typeof response !== "object") return [];
  const snapshots = response.quota_snapshots;
  if (!snapshots || typeof snapshots !== "object") return [];

  const planLabel =
    typeof response.copilot_plan === "string" && response.copilot_plan.trim() !== ""
      ? response.copilot_plan.trim()
      : null;
  const resetAt = parseResetDate(response.quota_reset_date);

  const out = [];
  for (const [category, snapshot] of Object.entries(snapshots)) {
    if (!snapshot || typeof snapshot !== "object") continue;

    const unlimited = snapshot.unlimited === true;
    const entitlement = finiteOrNull(snapshot.entitlement);
    const remaining = finiteOrNull(snapshot.remaining);
    const percentRemaining = finiteOrNull(snapshot.percent_remaining);

    if (!unlimited && entitlement == null && remaining == null && percentRemaining == null) {
      continue;
    }

    const used =
      entitlement != null && remaining != null ? Math.max(entitlement - remaining, 0) : null;
    const percentUsed =
      entitlement === 0
        ? null
        : percentRemaining != null
          ? Math.min(Math.max(100 - percentRemaining, 0), 100)
          : entitlement != null && entitlement > 0 && used != null
            ? Math.min((used / entitlement) * 100, 100)
            : null;

    out.push({
      unit: "requests",
      category,
      categoryLabel: categoryLabel(category),
      planLabel,
      unlimited,
      allowanceTotal: unlimited ? null : entitlement,
      allowanceUsed: unlimited ? null : used,
      allowanceRemaining: unlimited ? null : remaining,
      percentUsed: unlimited ? null : percentUsed,
      periodStart: null,
      resetAt,
      observedAt,
    });
  }
  return out;
}

/**
 * Reads the account's current quota. Never throws: an unreachable or changed
 * endpoint, a missing credential or an unexpected response all return
 * `{ allowances: [], error }`.
 */
export async function collectAllowances({ fetchImpl = fetch, token: suppliedToken } = {}) {
  const token = suppliedToken ?? findLocalToken();
  if (!token) {
    return { allowances: [], error: NOT_SIGNED_IN, notSignedIn: true };
  }

  try {
    const res = await fetchImpl(QUOTA_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": "AIUsageMonitorCollector",
        "editor-version": "AIUsageMonitor/1.0",
      },
    });
    if (!res.ok) {
      if (res.status === 401) {
        return { allowances: [], error: DISCONNECTED, unauthorized: true };
      }
      return { allowances: [], error: `${UNAVAILABLE} (${res.status})` };
    }
    const body = await res.json();
    const allowances = normaliseQuota(body);
    if (allowances.length === 0) {
      return { allowances: [], error: `${UNAVAILABLE} (nothing reported)` };
    }
    return { allowances, error: null, raw: body };
  } catch {
    return { allowances: [], error: UNAVAILABLE };
  }
}
