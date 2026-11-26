import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

// Same labels and schedules; avoid re-registering already-loaded jobs when
// their configuration is unchanged. macOS security notices are not suppressed.
export function ensureAgent(path, plist, label, { run = execFileSync, uid = process.getuid?.() } = {}) {
  let unchanged = false;
  try { unchanged = readFileSync(path, 'utf8') === plist; } catch {}
  let loaded = false;
  try { run('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'ignore' }); loaded = true; } catch {}
  if (unchanged && loaded) return { changed: false, registered: false };
  if (!unchanged) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, plist, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  if (loaded) run('launchctl', ['unload', path], { stdio: 'ignore' });
  run('launchctl', ['load', path], { stdio: 'ignore' });
  return { changed: !unchanged, registered: true };
}