// Complete, conservative uninstall for the Mac app. Every resource is
// verified as ours before removal; anything unexpected is left untouched
// and reported. Never touches OpenCode, Claude Code history, GitHub, VS Code
// or other applications' files, and never deletes cloud account data.
import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, lstatSync, writeFileSync, renameSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const LABELS = ['app.aiusagemonitor.collector', 'app.aiusagemonitor.collector.checknow', 'app.aiusagemonitor.menubar'];
export const BUNDLE_ID = 'app.aiusagemonitor.collector';
// Exact files the app creates in ~/.aum. Nothing else there is removed.
export const AUM_FILES = ['config.json', 'state.json', 'status.json', 'sync.lock', 'menu.lock', 'collector.log', 'bin/aum-collector', 'bin/aum-collector.new', 'state/claude-allowance.json', 'state/claude-statusline-original.json'];
const SHIM_RE = /aum-collector'?\s+statusline\s*$/;

export function paths(home, claudeSettings = join(home, '.claude', 'settings.json')) {
  const aum = join(home, '.aum');
  const supportDir = join(home, 'Library', 'Application Support', 'AI Usage Monitor');
  const app = join(supportDir, 'AI Usage Monitor.app');
  return {
    home, aum, supportDir, app, claudeSettings,
    agents: LABELS.map((label) => ({ label, path: join(home, 'Library', 'LaunchAgents', `${label}.plist`) })),
    executables: [join(aum, 'bin', 'aum-collector'), join(app, 'Contents', 'MacOS', 'AI-Usage-Monitor'), join(app, 'Contents', 'Resources', 'aum-collector')],
    original: join(aum, 'state', 'claude-statusline-original.json'),
  };
}

const short = (p, home) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
const plistString = (xml, key) => xml.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;
const unxml = (s) => s.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/** LaunchAgent is ours only if its Label matches and it runs our executable. */
export function agentOwned(xml, label, executables) {
  if (plistString(xml, 'Label') !== label) return false;
  const first = xml.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1];
  return first != null && executables.includes(unxml(first));
}

/** The app bundle is ours only if it is a real directory with our bundle ID. */
export function appOwned(app) {
  try {
    if (lstatSync(app).isSymbolicLink()) return false;
    return plistString(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'), 'CFBundleIdentifier') === BUNDLE_ID;
  } catch { return false; }
}

/** Plans the Claude status-line change without writing anything. */
export function planClaude(settingsFile, originalFile) {
  if (!existsSync(settingsFile)) return { action: 'none', reason: 'no Claude settings' };
  let settings;
  try { settings = JSON.parse(readFileSync(settingsFile, 'utf8') || '{}'); } catch { return { action: 'keep', reason: 'Claude settings could not be read safely' }; }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { action: 'keep', reason: 'Claude settings have an unexpected format' };
  if (!SHIM_RE.test(settings.statusLine?.command ?? '')) return { action: 'none', reason: 'status line is not ours (left as you set it)' };
  let saved;
  try { saved = JSON.parse(readFileSync(originalFile, 'utf8')); } catch { return { action: 'keep', reason: 'previous Claude status line record is missing' }; }
  if (!saved || typeof saved !== 'object' || !('statusLine' in saved)) return { action: 'keep', reason: 'previous Claude status line record is incomplete' };
  const next = { ...settings };
  if (saved.statusLine) next.statusLine = saved.statusLine; else delete next.statusLine;
  return { action: 'restore', next };
}

function writeAtomic(path, text, mode) {
  const tmp = `${path}.aum-uninstall.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/**
 * Runs the uninstall. deps: run(cmd,args) -> {status, stdout}, uid, deleteKeychain() -> boolean,
 * selfPid. Returns { ok, steps:[{step, status:'done'|'skipped'|'kept'|'failed', detail}] }.
 * Step details contain only step names and ~-relative paths — no secrets, contents or account IDs.
 */
export function uninstall(p, deps) {
  const { run, uid, deleteKeychain, selfPid = process.pid } = deps;
  const steps = [];
  const log = (step, status, detail = '') => steps.push({ step, status, detail });
  let shimStillActive = false;

  // 1. Background jobs (verified by label and executable).
  for (const { label, path } of p.agents) {
    if (!existsSync(path)) { log(`Background job ${label}`, 'skipped', 'not installed'); continue; }
    let xml = '';
    try { if (lstatSync(path).isSymbolicLink()) throw new Error(); xml = readFileSync(path, 'utf8'); } catch { log(`Background job ${label}`, 'kept', 'could not be verified'); continue; }
    if (!agentOwned(xml, label, p.executables)) { log(`Background job ${label}`, 'kept', 'does not point to AI Usage Monitor'); continue; }
    try { run('launchctl', ['bootout', `gui/${uid}/${label}`]); } catch {}
    try { rmSync(path); log(`Background job ${label}`, 'done'); } catch { log(`Background job ${label}`, 'failed', 'could not remove'); }
  }

  // 2. Stop running AI Usage Monitor processes (verified by exact executable path).
  let stopped = 0;
  try {
    const out = run('ps', ['-axo', 'pid=,comm=']).stdout ?? '';
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (pid === selfPid || !p.executables.includes(m[2])) continue;
      try { process.kill(pid, 'SIGTERM'); stopped++; } catch {}
    }
    log('Stop running app', 'done', stopped ? `${stopped} stopped` : 'nothing running');
  } catch { log('Stop running app', 'failed', 'could not list processes'); }

  // 3. GitHub credential (only our Keychain service).
  try { log('GitHub credential in Keychain', deleteKeychain() ? 'done' : 'skipped', ''); } catch { log('GitHub credential in Keychain', 'failed', 'Keychain did not respond'); }

  // 4. Claude Code status line.
  const plan = planClaude(p.claudeSettings, p.original);
  if (plan.action === 'restore') {
    try {
      writeAtomic(p.claudeSettings, `${JSON.stringify(plan.next, null, 2)}\n`, statSync(p.claudeSettings).mode & 0o777);
      log('Claude Code status line', 'done', 'previous setting restored');
    } catch { shimStillActive = true; log('Claude Code status line', 'failed', 'settings could not be written'); }
  } else if (plan.action === 'keep') { shimStillActive = true; log('Claude Code status line', 'kept', plan.reason); }
  else log('Claude Code status line', 'skipped', plan.reason);

  // 5. Installed app copy.
  if (!existsSync(p.app)) log('Installed app', 'skipped', 'not found');
  else if (!appOwned(p.app)) log('Installed app', 'kept', 'not recognised as AI Usage Monitor');
  else { try { rmSync(p.app, { recursive: true }); log('Installed app', 'done'); } catch { log('Installed app', 'failed', 'could not remove'); } }
  removeIfEmpty(p.supportDir, p.home, log, 'App folder');

  // 6. Local configuration and state (exact file list only).
  const keepForClaude = shimStillActive ? new Set(['bin/aum-collector', 'state/claude-statusline-original.json', 'state/claude-allowance.json']) : new Set();
  let removed = 0;
  for (const rel of AUM_FILES) {
    const f = join(p.aum, rel);
    if (keepForClaude.has(rel) || !existsSync(f)) continue;
    try { if (lstatSync(f).isFile()) { rmSync(f); removed++; } } catch {}
  }
  if (!shimStillActive) {
    const backup = join(p.aum, 'backup');
    try { for (const n of readdirSync(backup)) if (/^claude-settings-[\dTZ-]+\.json$/.test(n)) { rmSync(join(backup, n)); removed++; } } catch {}
  }
  for (const d of ['backup', 'state', 'bin', '']) removeIfEmpty(join(p.aum, d), p.home, null);
  if (existsSync(p.aum)) log('Local settings', shimStillActive ? 'kept' : 'kept', shimStillActive ? 'files needed by your Claude status line were kept' : 'other files in ~/.aum were not created by the app and were left');
  else log('Local settings', 'done', `${removed} files removed`);

  const ok = !steps.some((s) => s.status === 'failed' || s.status === 'kept');
  return { ok, steps };
}

function removeIfEmpty(dir, home, log, name) {
  try {
    if (readdirSync(dir).length === 0) { rmdirSync(dir); log?.(name, 'done'); }
    else log?.(name, 'kept', `${short(dir, home)} contains other files`);
  } catch {}
}

export function summary(result, home) {
  const lines = result.steps.map((s) => `${s.status.toUpperCase()}: ${s.step}${s.detail ? ` — ${short(s.detail, home)}` : ''}`);
  return lines.join('\n');
}

/** Privacy-safe diagnostic log; written only when something needs attention. */
export function writeDiagnostic(result, home, now = new Date()) {
  const dir = join(home, 'Library', 'Logs', 'AI Usage Monitor');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'uninstall.log');
  writeFileSync(file, `AI Usage Monitor uninstall ${now.toISOString()}\n${summary(result, home)}\n`, { mode: 0o600 });
  return file;
}
