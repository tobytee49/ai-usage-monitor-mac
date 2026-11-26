import { test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSyncLock, allowanceCurrent, FRESH_MS, menuRows, readStatus, recordUpload, runTrackedSync, writeStatus } from '../src/local-status.mjs';
import { menuAgentPlist, writeMenuAgent } from '../src/menu-install.mjs';
let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'aum-menu-')); process.env.AUM_HOME = root; });
afterEach(() => { delete process.env.AUM_HOME; rmSync(root, { recursive: true, force: true }); });
const now = Date.parse('2026-11-04T03:00:00Z');
const allowance = { categoryLabel: 'Chat', allowanceTotal: 200, allowanceRemaining: 183, percentUsed: 8.5, observedAt: new Date(now - 60_000).toISOString(), resetAt: new Date(now + 3_600_000).toISOString() };

test('current Copilot allowance shows 91.5% remaining, not used percentage', () => {
  const rows = menuRows({ tools: { 'github-copilot': { connection: 'connected', allowances: [allowance] } } }, now, null);
  expect(rows.some(r => r.text?.startsWith('Chat: 91.5% remaining · Current'))).toBe(true);
});
test('30-minute-old allowance never appears current', () => {
  const a = { ...allowance, observedAt: new Date(now - FRESH_MS).toISOString() };
  expect(allowanceCurrent(a, now)).toBe(false);
  expect(menuRows({ tools: { 'github-copilot': { allowances: [a] } } }, now, null).some(r => r.text === 'Chat: Unavailable · outdated' && r.validUntil <= now / 1000)).toBe(true);
});
test('reset rollover invalidates the reading immediately', () => {
  expect(allowanceCurrent({ ...allowance, resetAt: new Date(now).toISOString() }, now)).toBe(false);
});
test('zero premium entitlement shows Not included with no percentage', () => {
  const a = { ...allowance, categoryLabel: 'Premium requests', allowanceTotal: 0, allowanceRemaining: 0, percentUsed: null };
  expect(menuRows({ tools: { 'github-copilot': { allowances: [a] } } }, now, null).some(r => r.text?.startsWith('Premium requests: Not included') && !r.text.includes('%'))).toBe(true);
});
test('stale Claude weekly and five-hour limits are outdated even before reset', () => {
  const claude = { observedAt: new Date(now - FRESH_MS).toISOString(), windows: {
    five_hour: { usedPercentage: 23, resetsAt: new Date(now + 3_600_000).toISOString() },
    seven_day: { usedPercentage: 20, resetsAt: new Date(now + 86_400_000).toISOString() },
  } };
  const rows = menuRows({}, now, claude);
  expect(rows.some(r => r.text?.startsWith('5-hour limit: Unavailable') && !r.text.includes('%'))).toBe(true);
  expect(rows.some(r => r.text?.startsWith('Weekly limit: Unavailable') && !r.text.includes('%'))).toBe(true);
});
test('manual check calls normal sync exactly once and records success', async () => {
  let calls = 0;
  const result = await runTrackedSync(async () => { calls++; recordUpload({ provider: 'opencode', usage: [] }, true); return {}; });
  expect(calls).toBe(1); expect(result.outcome).toBe('success'); expect(readStatus().syncing).toBe(false);
  expect(readStatus().tools.opencode.lastSuccessAt).toBeDefined();
});
test('manual check reports partial provider failure', async () => {
  const result = await runTrackedSync(async () => { recordUpload({ provider: 'opencode', usage: [] }, true); recordUpload({ provider: 'github-copilot', status: { ok: false, state: 'disconnected' } }, true); return { copilot: { error: 'not connected' } }; });
  expect(result.outcome).toBe('partial'); expect(readStatus().tools['github-copilot'].outcome).toBe('failed');
});
test('manual check reports total failure without inventing successful timestamps', async () => {
  const result = await runTrackedSync(async () => { throw new Error('offline'); });
  expect(result.outcome).toBe('failed'); expect(readStatus().tools.opencode).toBeUndefined();
});
test('successful sync cannot claim unchanged Claude source was refreshed', async () => {
  writeStatus({ tools: {}, claudeSourceObservedAt: '2026-11-01T00:00:00Z' });
  await runTrackedSync(async () => { recordUpload({ provider: 'claude-code', usage: [] }, true); return {}; });
  expect(readStatus().claudeReadingNew).toBe(false);
  expect(readStatus().claudeSourceObservedAt).toBeUndefined();
});
test('scheduled, poll and manual sync cannot overlap', async () => {
  const release = acquireSyncLock(); expect(typeof release).toBe('function');
  let called = false; const result = await runTrackedSync(async () => { called = true; });
  expect(result.busy).toBe(true); expect(called).toBe(false); release?.();
});
test('restart recovers a dead process lock and interrupted sync state', async () => {
  writeFileSync(join(root, 'sync.lock'), '2147483647');
  writeStatus({ tools: {}, syncing: true, ownerPid: 2147483647 });
  await runTrackedSync(async () => { recordUpload({ provider: 'opencode', usage: [] }, true); return {}; });
  expect(readStatus().syncing).toBe(false); expect(existsSync(join(root, 'sync.lock'))).toBe(false);
});
test('poll does not acknowledge a website request while another sync holds the lock', async () => {
  const release = acquireSyncLock(); let polled = false;
  await runTrackedSync(async () => {}, {}, { beforeSync: async () => { polled = true; return true; } });
  expect(polled).toBe(false); release?.();
});
test('install is idempotent and login agent opens interface, not another sync schedule', () => {
  const path = join(root, 'LaunchAgents', 'menu.plist');
  const executable = '/Users/Test & User/AI Usage Monitor.app/Contents/MacOS/AI-Usage-Monitor';
  writeMenuAgent(executable, path); const first = readFileSync(path, 'utf8'); writeMenuAgent(executable, path);
  expect(readFileSync(path, 'utf8')).toBe(first);
  expect(first).toBe(menuAgentPlist(executable)); expect(first).toContain('<key>RunAtLoad</key><true/>');
  expect(first).toContain('Test &amp; User'); expect(first).not.toContain('StartInterval'); expect(first).not.toContain('<string>sync</string>');
});
test('snapshot does not retain credentials, raw source or token usage fields', async () => {
  await runTrackedSync(async () => { recordUpload({ provider: 'github-copilot', credentials: 'private-value', usage: [{ prompt: 'private-prompt' }], allowances: [{ ...allowance, raw: 'private-raw' }] }, true); return {}; });
  const value = readFileSync(join(root, 'status.json'), 'utf8');
  expect(value).not.toContain('private-value'); expect(value).not.toContain('private-prompt'); expect(value).not.toContain('private-raw');
});