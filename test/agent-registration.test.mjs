import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAgent } from '../src/agent-registration.mjs';

for (const [name, existing, loaded, expected] of [
  ['already loaded and identical', 'same', true, ['print']],
  ['inactive after restart', 'same', false, ['print', 'load']],
  ['changed configuration', 'old', true, ['print', 'unload', 'load']],
  ['first installation', null, false, ['print', 'load']],
]) test(`background registration: ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'aum-agent-'));
  const path = join(root, 'job.plist');
  try {
    if (existing) writeFileSync(path, existing);
    const calls = [];
    const run = (command, args) => { calls.push(args[0]); if (args[0] === 'print') {
      expect(args[1]).toBe('gui/501/app.aiusagemonitor.collector.checknow');
      if (!loaded) throw new Error('not loaded');
    } };
    ensureAgent(path, 'same', 'app.aiusagemonitor.collector.checknow', { run, uid: 501 });
    expect(calls).toEqual(expected);
    expect(readFileSync(path, 'utf8')).toBe('same');
  } finally { rmSync(root, { recursive: true, force: true }); }
});