import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('real syncOnce uploads unchanged token fields, reads Copilot and publishes partial/unchanged-Claude truth', () => {
  const home = mkdtempSync(join(tmpdir(), 'aum-menu-flow-'));
  const root = resolve(import.meta.dir, '..');
  try {
    const script = `
      import { Database } from 'bun:sqlite';
      import { mkdirSync } from 'node:fs';
      mkdirSync(process.env.HOME + '/.aum', { recursive: true });
      const dbPath = process.env.HOME + '/opencode.db';
      const db = new Database(dbPath);
      db.exec('CREATE TABLE message (id TEXT, data TEXT)');
      db.prepare('INSERT INTO message VALUES (?, ?)').run('fixture-1', JSON.stringify({ id:'fixture-1', sessionID:'fixture-session', tokens:{input:10,output:20,cache:{read:30,write:40}},time:{created:Date.now()} }));
      db.close(); process.env.AUM_OPENCODE_DB = dbPath;
      const { syncOnce } = await import(${JSON.stringify(join(root, 'src/sync.mjs'))});
      const { runTrackedSync, readStatus } = await import(${JSON.stringify(join(root, 'src/local-status.mjs'))});
      const uploads = [];
      let offline = false;
      globalThis.fetch = async (url, opts) => {
        if (String(url).includes('copilot_internal')) return offline ? new Response('{}', {status:503}) : Response.json({copilot_plan:'free',quota_reset_date:'2026-12-01',quota_snapshots:{chat:{entitlement:200,remaining:183,percent_remaining:91.5}}});
        if (String(url).includes('/ingest')) { const p=JSON.parse(opts.body); uploads.push(p); return Response.json({usageInserted:p.usage.length}); }
        throw new Error('Unexpected endpoint');
      };
      const first=await runTrackedSync(syncOnce,{Database,log:()=>{}});
      const record=uploads.find(p=>p.provider==='opencode').usage[0];
      const firstStatus=readStatus(); offline=true;
      const second=await runTrackedSync(syncOnce,{Database,log:()=>{}});
      console.log(JSON.stringify({first:first.outcome,second:second.outcome,total:record.totalTokens,parts:[record.inputTokens,record.outputTokens,record.cacheReadTokens,record.cacheWriteTokens],session:record.sessionId,copilot:firstStatus.tools['github-copilot'].allowances[0].allowanceRemaining,claude:readStatus().claudeReadingNew}));
    `;
    const run = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, HOME: home, AUM_HOME: join(home, '.aum'), AUM_TOKEN: 'fixture-pairing-not-real', AUM_API_BASE: 'https://fixture.invalid', COPILOT_GITHUB_TOKEN: 'fixture-github-not-real' } });
    expect(run.exitCode).toBe(0);
    const result = JSON.parse(run.stdout.toString().trim());
    expect(result).toEqual({ first: 'success', second: 'partial', total: 100, parts: [10, 20, 30, 40], session: 'fixture-session', copilot: 183, claude: false });
  } finally { rmSync(home, { recursive: true, force: true }); }
});