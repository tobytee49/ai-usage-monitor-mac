import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { readAllowanceState, plausibleWindow } from './connectors/claude-allowance.mjs';

export const VERSION = '0.14.0';
export const FRESH_MS = 30 * 60_000;
const home = () => process.env.AUM_HOME || join(homedir(), '.aum');
export const statusPath = () => join(home(), 'status.json');
const lockPath = () => join(home(), 'sync.lock');
export function readStatus() {
  try { return JSON.parse(readFileSync(statusPath(), 'utf8')); } catch { return { version: VERSION, tools: {} }; }
}
export function writeStatus(s) {
  mkdirSync(dirname(statusPath()), { recursive: true, mode: 0o700 });
  const tmp = `${statusPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  renameSync(tmp, statusPath());
}

// One lock for app launch, manual refresh, poll and scheduled sync. A dead
// PID (including after reboot) can be recovered; a live owner is never evicted.
export function acquireSyncLock() {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(lockPath(), 'wx', 0o600);
      writeFileSync(fd, String(process.pid)); closeSync(fd);
      return () => { try { if (readFileSync(lockPath(), 'utf8') === String(process.pid)) unlinkSync(lockPath()); } catch {} };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid;
      try { pid = Number(readFileSync(lockPath(), 'utf8')); } catch { return null; }
      if (!Number.isInteger(pid) || pid <= 0) return null;
      try { process.kill(pid, 0); return null; } catch (err) { if (err.code !== 'ESRCH') return null; }
      try { unlinkSync(lockPath()); } catch { return null; }
    }
  }
  return null;
}

let active = null;
// Called only with normalized upload data. Credentials, responses and raw
// source data never enter the snapshot.
export function recordUpload(payload, ok) {
  if (!active) return;
  const key = payload.provider;
  const t = active.tools[key] ?? {};
  const good = ok && payload.status?.ok !== false;
  if (key === 'claude-code' && good && payload.allowances?.length) active.claudeUploadedAt = payload.allowances[0].observedAt;
  const checkedAt = new Date().toISOString();
  active.tools[key] = { ...t, checkedAt, outcome: good ? 'success' : 'failed',
    connection: good ? 'connected' : (payload.status?.state ?? 'unavailable'),
    lastSuccessAt: good ? checkedAt : t.lastSuccessAt,
    allowances: good && key === 'github-copilot' ? (payload.allowances ?? []).map(a => ({
      category: a.category, categoryLabel: a.categoryLabel, allowanceTotal: a.allowanceTotal,
      allowanceRemaining: a.allowanceRemaining, percentUsed: a.percentUsed,
      unlimited: a.unlimited, observedAt: a.observedAt, resetAt: a.resetAt,
    })) : t.allowances,
  };
  active.attempts[key] = good && active.attempts[key] !== false;
}

export function allowanceCurrent(a, now = Date.now(), key) {
  const observed = Date.parse(a.observedAt);
  const reset = Date.parse(a.resetAt);
  if (!Number.isFinite(observed) || now < observed - 60_000 || now - observed >= FRESH_MS || !Number.isFinite(reset) || now >= reset) return false;
  return !key || plausibleWindow(key, a.percentUsed, a.resetAt, a.observedAt);
}
const resetLabel = (s) => {
  const time = Date.parse(s);
  return Number.isFinite(time) ? new Date(time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
};
// Presentation only: these roles never change source allowances or freshness rules.
export function capacityEmphasis(a) {
  if (a.unlimited) return { role: 'capacity', state: 'unlimited' };
  if (a.allowanceTotal === 0) return { role: 'neutral', state: 'not-included' };
  const remaining = Number.isFinite(a.percentUsed) && a.percentUsed >= 0 && a.percentUsed <= 100
    ? 100 - a.percentUsed : null;
  if (remaining === 0 || (remaining === null && a.allowanceRemaining === 0)) return { role: 'problem', state: 'exhausted' };
  if (remaining !== null && remaining <= 20) return { role: 'attention', state: 'low' };
  return { role: remaining !== null || Number.isFinite(a.allowanceRemaining) ? 'capacity' : 'neutral', state: remaining !== null || Number.isFinite(a.allowanceRemaining) ? 'current' : 'unavailable' };
}
function capacityRow(label, a, now, key, exists = true) {
  const current = exists && allowanceCurrent(a, now, key);
  const emphasis = capacityEmphasis(a);
  const available = a.unlimited ? 'Unlimited' : a.allowanceTotal === 0 ? 'Not included' :
    Number.isFinite(a.percentUsed) && a.percentUsed >= 0 && a.percentUsed <= 100 ? `${Math.round((100 - a.percentUsed) * 10) / 10}% remaining` :
    Number.isFinite(a.allowanceRemaining) ? `${a.allowanceRemaining} requests remaining` : 'Unavailable';
  const detail = a.allowanceTotal === 0 ? '' : `Resets ${resetLabel(a.resetAt)}`;
  const status = emphasis.state === 'low' ? 'Low · Current' : emphasis.state === 'exhausted' ? 'Exhausted · Current' : 'Current';
  const currentText = `${label}: ${available} · Current${detail ? ` · ${detail.toLowerCase()}` : ''}`;
  const outdatedText = `${label}: Unavailable · ${exists ? 'outdated' : 'awaiting reading'}`;
  // A rejected observation must not be revived by the native expiry selector.
  const validUntil = current ? Math.min(Date.parse(a.observedAt) + FRESH_MS, Date.parse(a.resetAt)) / 1000 : 0;
  return { text: current ? currentText : outdatedText, currentText, outdatedText, validUntil,
    currentDisplay: { label, value: available, status, detail, role: emphasis.role, state: emphasis.state },
    outdatedDisplay: { label, value: 'Unavailable', status: exists ? 'Outdated' : 'Awaiting reading', role: 'neutral', state: 'outdated' } };
}
export function menuRows(s, now = Date.now(), claude = readAllowanceState()) {
  const rows = [{ text: 'Claude subscription', heading: true }];
  for (const [key, label] of [['five_hour', '5-hour limit'], ['seven_day', 'Weekly limit']]) {
    const w = claude?.windows?.[key];
    rows.push(capacityRow(label, { percentUsed: w?.usedPercentage, resetAt: w?.resetsAt, observedAt: claude?.observedAt }, now, key, Boolean(w)));
  }
  rows.push({ separator: true });
  const copilot = s.tools?.['github-copilot'];
  rows.push({ text: `GitHub Copilot${copilot?.outcome === 'failed' ? ' · Check failed' : ''}`, heading: true, role: copilot?.outcome === 'failed' ? 'problem' : 'neutral' });
  const allowances = copilot?.allowances ?? [];
  const capacityRows = allowances.map(a => capacityRow(a.categoryLabel || a.category, a, now));
  const resetRows = capacityRows.filter(r => r.validUntil > now / 1000 && r.currentDisplay.detail);
  const sharedReset = resetRows.length > 1 && resetRows.every(r => r.currentDisplay.detail === resetRows[0].currentDisplay.detail);
  if (sharedReset) for (const row of resetRows) row.currentDisplay.detail = '';
  rows.push(...capacityRows);
  if (sharedReset) {
    const text = resetRows[0].currentText.split(' · resets ')[1];
    rows.push({ text: `Resets ${text}`, currentText: `Resets ${text}`, outdatedText: '', secondary: true,
      validUntil: Math.max(...resetRows.map(r => r.validUntil)) });
  }
  if (!allowances.length) rows.push({ text: copilot?.connection === 'disconnected' ? 'Disconnected · reconnect in dashboard' : 'Allowances unavailable', role: 'attention' });
  rows.push({ separator: true });
  for (const [key, name] of [['opencode', 'OpenCode'], ['claude-code', 'Claude Code']]) {
    const t = s.tools?.[key];
    const success = Date.parse(t?.lastSuccessAt);
    const connected = t?.connection === 'connected' && t?.outcome !== 'failed';
    const validUntil = connected && Number.isFinite(success) && success <= now + 60_000 ? (success + FRESH_MS) / 1000 : 0;
    const status = t?.connection === 'disconnected' ? 'Disconnected' : t?.outcome === 'failed' ? 'Check failed' : connected ? 'Check outdated' : 'Unavailable';
    const currentText = `${name} · Current`, outdatedText = `${name} · ${status}`;
    rows.push({ text: now / 1000 < validUntil ? currentText : outdatedText, currentText, outdatedText, validUntil,
      currentDisplay: { label: name, value: 'Check current', role: 'healthy', state: 'current' },
      outdatedDisplay: { label: name, value: status, role: t?.outcome === 'failed' ? 'problem' : 'neutral', state: 'outdated' } });
  }
  return rows;
}

// "Last checked" describes the collector run only; provider rows keep their own
// freshness, so a successful check never makes an outdated reading look current.
export const CHECK_STALE_MS = 45 * 60_000;
export function relativeAge(ms) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'just now';
  const [n, unit] = m < 60 ? [m, 'minute'] : m < 1440 ? [Math.floor(m / 60), 'hour'] : [Math.floor(m / 1440), 'day'];
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}
export function lastCheckedLine(s, now = Date.now()) {
  const done = Date.parse(s?.completedAt);
  if (!Number.isFinite(done)) return { text: 'Not checked yet', role: 'attention' };
  const age = relativeAge(now - done);
  if (now - done > CHECK_STALE_MS) return { text: `Not checked recently · last ${age}`, role: 'attention' };
  if (s.outcome === 'failed') return { text: `Last check failed · ${age}`, role: 'problem' };
  if (s.outcome === 'partial') return { text: `Last checked: ${age} · some checks failed`, role: 'attention' };
  return { text: `Last checked: ${age}`, role: 'secondary' };
}

export async function runTrackedSync(sync, options = {}, { beforeSync } = {}) {
  const release = acquireSyncLock();
  if (!release) return { busy: true };
  try { if (beforeSync && !await beforeSync()) { release(); return { skipped: true }; } }
  catch (e) { release(); throw e; }
  const prior = readStatus();
  const start = new Date().toISOString();
  active = { tools: { ...prior.tools }, attempts: {} };
  writeStatus({ ...prior, version: VERSION, syncing: true, startedAt: start, ownerPid: process.pid });
  let error = false;
  let result;
  try { result = await sync(options); } catch { error = true; }
  try {
    // Results report local failures even when no upload was attempted.
    for (const [key, r] of [['claude-code', result?.claudeCode], ['github-copilot', result?.copilot]]) {
      if (r?.error) {
        active.attempts[key] = false;
        active.tools[key] = { ...active.tools[key], outcome: 'failed', connection: active.tools[key]?.outcome === 'failed' ? active.tools[key].connection : 'unavailable' };
      }
    }
    const successes = Object.values(active.attempts).filter(Boolean).length;
    const failures = Object.values(active.attempts).filter(v => !v).length + Number(error);
    const outcome = failures ? (successes ? 'partial' : 'failed') : successes ? 'success' : 'failed';
    const oldObserved = prior.claudeSourceObservedAt;
    const claude = readAllowanceState();
    const claudeReadingNew = Boolean(claude?.observedAt && claude.observedAt !== oldObserved && active.claudeUploadedAt === claude.observedAt);
    const snapshot = { version: VERSION, tools: active.tools, syncing: false, startedAt: start,
      completedAt: new Date().toISOString(), outcome, claudeSourceObservedAt: claude?.observedAt,
      claudeReadingNew, summary: outcome === 'success' ? 'Tool check complete' : outcome === 'partial' ? 'Some tool checks failed' : 'Check failed',
    };
    snapshot.rows = menuRows(snapshot);
    writeStatus(snapshot);
    return { ...result, outcome };
  } finally { active = null; release(); }
}