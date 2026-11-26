import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { paths, uninstall, planClaude, agentOwned, summary, writeDiagnostic } from '../src/uninstall.mjs';

const put = (f, s) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, s); };
const agent = (label, exe) => `<plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${exe}</string><string>sync</string></array></dict></plist>`;

function fakeMac({ claude = 'ours-with-original', foreignAgent = false, extraAum = false, foreignApp = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aum-uninstall-'));
  const p = paths(home);
  put(join(p.app, 'Contents', 'Info.plist'), `<key>CFBundleIdentifier</key><string>${foreignApp ? 'com.other.app' : 'app.aiusagemonitor.collector'}</string>`);
  put(join(p.app, 'Contents', 'MacOS', 'AI-Usage-Monitor'), 'bin');
  for (const { label, path } of p.agents) put(path, agent(label, foreignAgent ? '/usr/local/bin/other' : label.endsWith('menubar') ? p.executables[1] : p.executables[0]));
  for (const f of ['config.json', 'state.json', 'status.json', 'collector.log', 'bin/aum-collector', 'state/claude-allowance.json']) put(join(p.aum, f), 'x');
  put(join(p.aum, 'backup', 'claude-settings-2026-10-05T10-00-00-000Z.json'), '{}');
  if (extraAum) put(join(p.aum, 'my-notes.txt'), 'user file');
  // Real user data that must never be touched.
  put(join(home, '.claude', 'projects', 'a', 's.jsonl'), 'history');
  put(join(home, '.local', 'share', 'opencode', 'opencode.db'), 'db');
  put(join(home, 'Library', 'LaunchAgents', 'com.other.agent.plist'), 'other');
  const shim = { command: `'${p.executables[0]}' statusline` };
  if (claude === 'ours-with-original') { put(p.claudeSettings, JSON.stringify({ theme: 'dark', statusLine: shim })); put(p.original, JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } })); }
  if (claude === 'ours-no-previous') { put(p.claudeSettings, JSON.stringify({ theme: 'dark', statusLine: shim })); put(p.original, JSON.stringify({ statusLine: null })); }
  if (claude === 'ours-missing-record') put(p.claudeSettings, JSON.stringify({ statusLine: shim }));
  if (claude === 'user-modified') { put(p.claudeSettings, JSON.stringify({ statusLine: { command: 'their-own' } })); put(p.original, JSON.stringify({ statusLine: null })); }
  if (claude === 'malformed') put(p.claudeSettings, '{not json');
  return { home, p };
}
const deps = (calls = []) => ({ run: (c, a) => { calls.push([c, ...a]); return { status: 0, stdout: '' }; }, uid: 501, deleteKeychain: () => true, selfPid: 1 });
const untouched = (home) => {
  expect(readFileSync(join(home, '.claude', 'projects', 'a', 's.jsonl'), 'utf8')).toBe('history');
  expect(existsSync(join(home, '.local', 'share', 'opencode', 'opencode.db'))).toBe(true);
  expect(existsSync(join(home, 'Library', 'LaunchAgents', 'com.other.agent.plist'))).toBe(true);
};

test('uninstall removes everything the app owns and nothing else', () => {
  const { home, p } = fakeMac(); const calls = [];
  try {
    const r = uninstall(p, deps(calls));
    expect(r.ok).toBe(true);
    for (const { path } of p.agents) expect(existsSync(path)).toBe(false);
    expect(calls.filter((c) => c[1] === 'bootout').map((c) => c[2])).toEqual(['gui/501/app.aiusagemonitor.collector', 'gui/501/app.aiusagemonitor.collector.checknow', 'gui/501/app.aiusagemonitor.menubar']);
    expect(existsSync(p.supportDir)).toBe(false);
    expect(existsSync(p.aum)).toBe(false);
    expect(JSON.parse(readFileSync(p.claudeSettings, 'utf8'))).toEqual({ theme: 'dark', statusLine: { type: 'command', command: 'my-line' } });
    untouched(home);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('Claude status line is removed when there was no previous one, other settings kept', () => {
  const { home, p } = fakeMac({ claude: 'ours-no-previous' });
  try { uninstall(p, deps()); expect(JSON.parse(readFileSync(p.claudeSettings, 'utf8'))).toEqual({ theme: 'dark' }); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test('user-modified Claude status line is left exactly as is', () => {
  const { home, p } = fakeMac({ claude: 'user-modified' });
  try { const before = readFileSync(p.claudeSettings, 'utf8'); uninstall(p, deps()); expect(readFileSync(p.claudeSettings, 'utf8')).toBe(before); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

for (const kind of ['malformed', 'ours-missing-record']) test(`unsafe Claude settings (${kind}) are untouched and the shim keeps working`, () => {
  const { home, p } = fakeMac({ claude: kind });
  try {
    const before = readFileSync(p.claudeSettings, 'utf8');
    const r = uninstall(p, deps());
    expect(r.ok).toBe(false);
    expect(readFileSync(p.claudeSettings, 'utf8')).toBe(before);
    expect(existsSync(join(p.aum, 'bin', 'aum-collector'))).toBe(true);
    expect(r.steps.find((s) => s.step === 'Claude Code status line').status).toBe('kept');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('background jobs that do not point to our app are never removed', () => {
  const { home, p } = fakeMac({ foreignAgent: true }); const calls = [];
  try {
    const r = uninstall(p, deps(calls));
    for (const { path } of p.agents) expect(existsSync(path)).toBe(true);
    expect(calls.some((c) => c[1] === 'bootout')).toBe(false);
    expect(r.ok).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('an unrecognised app bundle at our location is kept', () => {
  const { home, p } = fakeMac({ foreignApp: true });
  try { expect(uninstall(p, deps()).ok).toBe(false); expect(existsSync(p.app)).toBe(true); }
  finally { rmSync(home, { recursive: true, force: true }); }
});

test('files in ~/.aum the app did not create are kept', () => {
  const { home, p } = fakeMac({ extraAum: true });
  try {
    uninstall(p, deps());
    expect(readFileSync(join(p.aum, 'my-notes.txt'), 'utf8')).toBe('user file');
    expect(existsSync(join(p.aum, 'config.json'))).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('only processes running our exact executables are stopped', () => {
  const { home, p } = fakeMac(); const killed = []; const orig = process.kill;
  process.kill = (pid) => { killed.push(pid); };
  try {
    uninstall(p, { ...deps(), run: (c) => ({ status: 0, stdout: c === 'ps' ? `  11 ${p.executables[1]}\n  12 /Applications/Other.app/Contents/MacOS/aum-collector\n  13 ${p.executables[0]}\n   1 ${p.executables[0]}\n` : '' }) });
    expect(killed).toEqual([11, 13]);
  } finally { process.kill = orig; rmSync(home, { recursive: true, force: true }); }
});

test('agent ownership requires both our label and our executable', () => {
  expect(agentOwned(agent('app.aiusagemonitor.collector', '/x/aum'), 'app.aiusagemonitor.collector', ['/x/aum'])).toBe(true);
  expect(agentOwned(agent('app.aiusagemonitor.collector', '/y/aum'), 'app.aiusagemonitor.collector', ['/x/aum'])).toBe(false);
  expect(agentOwned(agent('com.evil', '/x/aum'), 'app.aiusagemonitor.collector', ['/x/aum'])).toBe(false);
});

test('diagnostic log is private and contains no file contents', () => {
  const { home, p } = fakeMac({ claude: 'malformed' });
  try {
    put(join(p.aum, 'config.json'), JSON.stringify({ token: 'aum_SECRET_TOKEN' }));
    const r = uninstall(p, deps());
    const file = writeDiagnostic(r, home);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain(home);
    expect(existsSync(join(home, 'Desktop'))).toBe(false);
    expect(summary(r, home)).toContain('Claude Code status line');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
