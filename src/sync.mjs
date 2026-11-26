import { createRequire } from "node:module";
import { readConfig, readState, writeState } from "./config.mjs";
import * as opencode from "./connectors/opencode.mjs";
import * as copilot from "./connectors/copilot.mjs";
import { keychainStoreAdapter } from "./github-device-auth.mjs";
import { getAccessToken, recoverFromUnauthorized } from "./github-credential.mjs";
import * as claudeCode from "./connectors/claude-code.mjs";
import * as claudeAllowance from "./connectors/claude-allowance.mjs";
import { recordUpload, VERSION } from './local-status.mjs';

const require = createRequire(process.argv[1] ?? `${process.cwd()}/`);
const BATCH_SIZE = 1000;

function loadSqlite() {
  try {
    return require("better-sqlite3");
  } catch {
    throw new Error("better-sqlite3 is not installed. Run `npm install` inside the collector folder.");
  }
}

async function post(apiBase, token, payload) {
  let res;
  try { res = await fetch(`${apiBase}/api/public/collector/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  }); } catch (err) { recordUpload(payload, false); throw err; }
  recordUpload(payload, res.ok);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(body.error || `Ingest failed (${res.status})`);
  return body;
}

const COLLECTOR_VERSION = VERSION;

/**
 * Claude account allowance (subscription capacity). Reads only the local
 * state file written by the status-line shim. Uploads percentages only when
 * the reading changed since the last successful upload. Fully isolated.
 */
export async function syncClaudeAllowance({ log = console.log } = {}) {
  try {
    const config = readConfig();
    if (!config.token) return { sent: 0 };
    const state = claudeAllowance.readAllowanceState();
    const allowances = claudeAllowance.toObservations(state);
    if (!allowances.length) return { sent: 0, unavailable: true };
    const key = JSON.stringify(state);
    if (readState().claudeAllowanceSent === key) return { sent: 0, unchanged: true };
    await post(config.apiBase, config.token, {
      provider: claudeAllowance.slug,
      collectorVersion: COLLECTOR_VERSION,
      platform: process.platform,
      usage: [],
      allowances,
    });
    writeState({ claudeAllowanceSent: key });
    log(`Recorded ${allowances.length} Claude subscription limit reading(s).`);
    return { sent: allowances.length };
  } catch (err) {
    log(`Claude subscription limits not uploaded: ${err instanceof Error ? err.message : "error"}`);
    return { sent: 0, error: true };
  }
}

/**
 * Claude Code usage sync. Fully isolated: any failure is reported as
 * "unavailable" and swallowed so OpenCode and Copilot are never affected.
 * Checkpoints are saved only after every batch uploaded successfully.
 */
export async function syncClaudeCode({ log = console.log, root } = {}) {
  const config = readConfig();
  if (!config.token) return { sent: 0, inserted: 0, error: "not paired" };
  if (!claudeCode.detect(root)) return { sent: 0, inserted: 0, skipped: true };
  const base = { provider: claudeCode.slug, collectorVersion: COLLECTOR_VERSION, platform: process.platform };
  try {
    const state = readState();
    const { records, checkpoints } = claudeCode.collect({ root, checkpoints: state.claudeCodeFiles ?? {} });
    let sent = 0;
    let inserted = 0;
    if (records.length === 0) {
      await post(config.apiBase, config.token, { ...base, usage: [] });
    }
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      const result = await post(config.apiBase, config.token, { ...base, usage: batch });
      sent += batch.length;
      inserted += Number(result.usageInserted ?? result.inserted ?? 0);
    }
    writeState({ claudeCodeFiles: checkpoints });
    log(records.length ? `Synced ${sent} Claude Code record(s); ${inserted} new.` : "No new Claude Code usage since the last sync.");
    return { sent, inserted, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : claudeCode.UNAVAILABLE;
    log(`${claudeCode.UNAVAILABLE} ${message}`);
    await post(config.apiBase, config.token, {
      ...base,
      usage: [],
      status: { ok: false, state: "unavailable", message: claudeCode.UNAVAILABLE },
    }).catch(() => {});
    return { sent: 0, inserted: 0, error: message };
  }
}

async function reportCopilot(config, allowances, status) {
  return post(config.apiBase, config.token, {
    provider: copilot.slug,
    collectorVersion: COLLECTOR_VERSION,
    platform: process.platform,
    usage: [],
    allowances,
    status,
  });
}

/**
 * Copilot allowance sync. Fully isolated: any failure is reported and
 * swallowed so it can never affect OpenCode or the rest of the run.
 *
 * `interactive` is true only when the user opened the app themselves.
 * Background (scheduled) syncs NEVER start a GitHub login, open a browser,
 * or show a dialog — unless the user clicked Connect on the website.
 */
export async function syncCopilot({ log = console.log, onGitHubLoginNeeded, interactive = false, deleteCredential, credentialStore = keychainStoreAdapter, fetchImpl = fetch } = {}) {
  const config = readConfig();
  if (!config.token) return { allowances: 0, error: "not paired" };

  const send = async (allowances, status) => {
    try {
      return await reportCopilot(config, allowances, status);
    } catch (err) {
      log(`${copilot.UNAVAILABLE}: ${err instanceof Error ? err.message : "upload failed"}`);
      return null;
    }
  };

  const login = async (ackRequest) => {
    try {
      const token = await onGitHubLoginNeeded({
        onWaiting: () => send([], { ok: false, state: "awaiting_approval", message: "Waiting for approval on GitHub.", ackRequest }),
      });
      return { token };
    } catch (err) {
      const message = err instanceof Error ? err.message : "GitHub connection was not completed.";
      log(`GitHub connection incomplete: ${message}`);
      await send([], { ok: false, state: "not_connected", message: copilot.NOT_SIGNED_IN, ackRequest });
      return { token: null };
    }
  };

  const readAndReport = async (token, ackRequest) => {
    // Our own credential: refresh silently when the 8-hour token is near expiry.
    let cred = null;
    if (!token) {
      const got = await getAccessToken(credentialStore, { fetchImpl }).catch(() => ({ token: null }));
      if (got.dead) {
        deleteCredential?.();
        log(copilot.DISCONNECTED);
        return { res: await send([], { ok: false, state: "disconnected", message: copilot.DISCONNECTED, ackRequest }), result: { allowances: [], error: copilot.DISCONNECTED } };
      }
      if (got.refreshed) log("GitHub sign-in renewed.");
      token = got.token;
      cred = got.cred ?? null;
    }
    let result = await copilot.collectAllowances(token ? { token, fetchImpl } : { fetchImpl });
    if (result.unauthorized && cred?.refreshToken) {
      // One refresh + retry before giving up. Temporary failures keep the credential.
      const r = await recoverFromUnauthorized(credentialStore, cred, { fetchImpl }).catch(() => ({ temporary: true }));
      if (r.token) {
        log("GitHub sign-in renewed.");
        result = await copilot.collectAllowances({ token: r.token, fetchImpl });
      } else if (r.temporary) {
        log(copilot.UNAVAILABLE);
        return { res: await send([], { ok: false, state: "unavailable", message: copilot.UNAVAILABLE, ackRequest }), result: { allowances: [], error: copilot.UNAVAILABLE } };
      }
    }
    if (result.unauthorized) {
      deleteCredential?.();
      log(copilot.DISCONNECTED);
      return { res: await send([], { ok: false, state: "disconnected", message: copilot.DISCONNECTED, ackRequest }), result };
    }
    if (result.notSignedIn) {
      return { res: await send([], { ok: false, state: "not_connected", message: copilot.NOT_SIGNED_IN, ackRequest }), result };
    }
    if (result.error || result.allowances.length === 0) {
      const message = result.error ?? copilot.UNAVAILABLE;
      log(message);
      return { res: await send([], { ok: false, state: "unavailable", message, ackRequest }), result };
    }
    const res = await send(result.allowances, { ok: true, state: "connected", ackRequest });
    if (res) log(`Recorded ${result.allowances.length} Copilot allowance reading(s).`);
    return { res, result };
  };

  let { res, result } = await readAndReport(null, undefined);

  // First-time / explicit app open with nothing saved: ask once.
  if (result.notSignedIn && interactive && onGitHubLoginNeeded) {
    const { token } = await login(undefined);
    if (token) ({ res, result } = await readAndReport(token, undefined));
  }

  // A Connect / Disconnect the user clicked on the website.
  const request = res?.request ?? null;
  if (request === "disconnect") {
    deleteCredential?.();
    log("GitHub Copilot disconnected.");
    await send([], { ok: false, state: "not_connected", message: copilot.NOT_SIGNED_IN, ackRequest: "disconnect" });
    return { allowances: 0, error: copilot.NOT_SIGNED_IN };
  }
  if (request === "connect" && onGitHubLoginNeeded) {
    if (result.allowances?.length) {
      await send(result.allowances, { ok: true, state: "connected", ackRequest: "connect" });
    } else {
      const { token } = await login("connect");
      if (token) ({ res, result } = await readAndReport(token, "connect"));
    }
  }

  return { allowances: result.allowances?.length ?? 0, error: result.error ?? null };
}

export async function syncOnce({ log = console.log, Database: suppliedDatabase, onGitHubLoginNeeded, interactive = false, deleteCredential } = {}) {
  const config = readConfig();
  if (!config.token) {
    throw new Error("No pairing key saved. Run `aum-collector login` first.");
  }

  const dbPath = opencode.resolveDbPath(config.openCodeDb);
  if (!dbPath && claudeCode.detect()) {
    // No OpenCode on this Mac, but Claude Code is present: sync the others.
    const claudeResult = await syncClaudeCode({ log }).catch(() => ({ sent: 0 }));
    await syncClaudeAllowance({ log });
    const copilotResult = await syncCopilot({ log, onGitHubLoginNeeded, interactive, deleteCredential }).catch(() => ({ allowances: 0 }));
    return { sent: 0, inserted: 0, claudeCode: claudeResult, copilot: copilotResult };
  }
  if (!dbPath) {
    throw new Error(
      "Could not find OpenCode's local database. Set it with `aum-collector set-db <path>`.",
    );
  }

  const state = readState();
  const sinceMs = state.opencodeLastOccurredMs ?? 0;

  const Database = suppliedDatabase ?? loadSqlite();
  const records = opencode.collect({ Database, dbPath, sinceMs });

  if (records.length === 0) {
    await post(config.apiBase, config.token, {
      provider: opencode.slug,
      collectorVersion: "0.2.0",
      platform: process.platform,
      usage: [],
    });
    log("No new OpenCode usage since the last sync.");
    const claudeResult = await syncClaudeCode({ log }).catch(() => ({ sent: 0 }));
    await syncClaudeAllowance({ log });
    const copilotResult = await syncCopilot({ log, onGitHubLoginNeeded, interactive, deleteCredential }).catch(() => ({ allowances: 0 }));
    return { sent: 0, inserted: 0, claudeCode: claudeResult, copilot: copilotResult };
  }

  let sent = 0;
  let inserted = 0;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const result = await post(config.apiBase, config.token, {
      provider: opencode.slug,
      collectorVersion: "0.1.0",
      platform: process.platform,
      usage: batch,
    });
    sent += batch.length;
    inserted += Number(result.usageInserted ?? result.inserted ?? 0);

    const last = batch[batch.length - 1];
    writeState({ opencodeLastOccurredMs: new Date(last.occurredAt).getTime() });
  }

  log(`Synced ${sent} OpenCode record(s); ${inserted} new.`);
  const claudeResult = await syncClaudeCode({ log }).catch(() => ({ sent: 0 }));
    await syncClaudeAllowance({ log });
  const copilotResult = await syncCopilot({ log, onGitHubLoginNeeded, interactive, deleteCredential }).catch(() => ({ allowances: 0 }));
  return { sent, inserted, claudeCode: claudeResult, copilot: copilotResult };
}
