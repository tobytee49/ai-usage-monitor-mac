import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ca from "../src/connectors/claude-allowance.mjs";

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aum-ca-"));
  process.env.AUM_HOME = join(dir, "aum");
  process.env.AUM_CLAUDE_SETTINGS = join(dir, "claude", "settings.json");
});
const settings = () => JSON.parse(readFileSync(process.env.AUM_CLAUDE_SETTINGS, "utf8"));
const writeSettings = (o) => { mkdirSync(join(dir, "claude"), { recursive: true }); writeFileSync(process.env.AUM_CLAUDE_SETTINGS, JSON.stringify(o)); };
const input = (rl) => JSON.stringify({ session_id: "s", transcript_path: "/secret/path", cwd: "/x", rate_limits: rl });

test("inspect is read-only; declining leaves settings byte-identical", () => {
  writeSettings({ model: "opus", statusLine: { type: "command", command: "echo hi" } });
  const before = readFileSync(process.env.AUM_CLAUDE_SETTINGS, "utf8");
  expect(ca.inspect()).toMatchObject({ hasStatusLine: true, installed: false });
  expect(readFileSync(process.env.AUM_CLAUDE_SETTINGS, "utf8")).toBe(before);
  expect(existsSync(process.env.AUM_HOME)).toBe(false);
});

test("no settings / no status line: installs, shim prints nothing", () => {
  const r = ca.install("/Users/me/.aum/bin/aum-collector");
  expect(r.preservedExisting).toBe(false);
  expect(settings().statusLine.command).toBe("'/Users/me/.aum/bin/aum-collector' statusline");
  const out = ca.runShim(input({ five_hour: { used_percentage: 3, resets_at: 1790000000 } }));
  expect(out).toEqual({ stdout: "", stderr: "", status: 0 });
  ca.restore();
  expect(settings().statusLine).toBeUndefined();
});

test("existing status line: backup, preserved keys, forwarded output and exit code, idempotent, restore", () => {
  const script = join(dir, "sl.sh");
  writeFileSync(script, "#!/bin/sh\ncat >/dev/null\necho MY-LINE\nexit 3\n"); chmodSync(script, 0o755);
  const orig = { type: "command", command: script, padding: 2, refreshInterval: 10 };
  writeSettings({ model: "opus", statusLine: orig });
  const r = ca.install("/x/aum-collector");
  expect(r.preservedExisting).toBe(true);
  expect(readdirSync(join(process.env.AUM_HOME, "backup")).length).toBe(1);
  expect(settings()).toMatchObject({ model: "opus", statusLine: { padding: 2, refreshInterval: 10 } });
  expect(ca.install("/x/aum-collector").changed).toBe(false);
  const out = ca.runShim(input({ seven_day: { used_percentage: 8, resets_at: 1790000000 } }));
  expect(out.stdout.trim()).toBe("MY-LINE");
  expect(out.status).toBe(3);
  ca.restore();
  expect(settings().statusLine).toEqual(orig);
});

test("invalid settings JSON is never overwritten", () => {
  mkdirSync(join(dir, "claude")); writeFileSync(process.env.AUM_CLAUDE_SETTINGS, "{oops");
  expect(() => ca.install("/x/aum-collector")).toThrow();
  expect(readFileSync(process.env.AUM_CLAUDE_SETTINGS, "utf8")).toBe("{oops");
});

test("rate_limits present: only four numbers stored", () => {
  ca.runShim(input({ five_hour: { used_percentage: 0, resets_at: 1790816400 }, seven_day: { used_percentage: 8.5, resets_at: 1791072000 }, spend_limit: { used_percentage: 5 } }), { now: new Date("2026-10-01T00:00:00Z") });
  const s = ca.readAllowanceState();
  expect(s.windows).toEqual({ five_hour: { usedPercentage: 0, resetsAt: new Date(1790816400e3).toISOString() }, seven_day: { usedPercentage: 8.5, resetsAt: new Date(1791072000e3).toISOString() } });
  const raw = readFileSync(ca.statePath(), "utf8");
  expect(raw).not.toContain("secret"); expect(raw).not.toContain("session");
  const obs = ca.toObservations(s);
  expect(obs.map((o) => o.category)).toEqual(["five_hour", "seven_day"]);
  for (const o of obs) { expect(o.unit).toBe("percent"); expect(o.allowanceTotal).toBeUndefined(); }
});

test("rate_limits absent / null / malformed keep previous state; single window ok", () => {
  ca.runShim(input({ seven_day: { used_percentage: 8, resets_at: 1790000000 } }), { now: new Date(1789990000e3) });
  const first = readFileSync(ca.statePath(), "utf8");
  ca.runShim(JSON.stringify({ session_id: "s" }));
  ca.runShim(input(null));
  ca.runShim("not json");
  expect(readFileSync(ca.statePath(), "utf8")).toBe(first);
  expect(ca.toObservations(ca.readAllowanceState()).length).toBe(1);
  expect(ca.toObservations(null)).toEqual([]);
});
