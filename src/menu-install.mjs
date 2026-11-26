import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
export const MENU_LABEL = 'app.aiusagemonitor.menubar';
export const menuAppPath = () => join(homedir(), 'Library', 'Application Support', 'AI Usage Monitor', 'AI Usage Monitor.app');
export const menuAgentPath = () => join(homedir(), 'Library', 'LaunchAgents', `${MENU_LABEL}.plist`);
export const xml = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function menuAgentPlist(executable) {
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${MENU_LABEL}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>ProcessType</key><string>Interactive</string></dict></plist>`;
}
export function writeMenuAgent(executable, path = menuAgentPath()) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(`${path}.tmp`, menuAgentPlist(executable), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}