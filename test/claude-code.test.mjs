import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collect, normaliseClaudeRecord, claudeTotal } from "../src/connectors/claude-code.mjs";

const rec = (o = {}) => JSON.stringify({
  type: "assistant", sessionId: o.s ?? "s1", requestId: o.r ?? "req1", timestamp: o.t ?? "2026-09-29T10:00:00.000Z",
  message: { id: o.m ?? "msg1", model: o.model ?? "claude-sonnet-4-5", content: [{ type: "text", text: "SECRET PROMPT" }],
    usage: o.u ?? { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 30 } },
}) + "\n";

let root;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "cc-")); mkdirSync(join(root, "projA")); mkdirSync(join(root, "projB", "sub"), { recursive: true }); });

test("total is sum of four disjoint fields; cache read > input ok", () => {
  expect(claudeTotal({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 30 })).toBe(560);
});
test("missing field leaves total null but keeps parts", () => {
  const r = normaliseClaudeRecord(JSON.parse(rec({ u: { input_tokens: 5, output_tokens: 7 } })));
  expect(r.totalTokens).toBeNull(); expect(r.inputTokens).toBe(5); expect(r.cost).toBeNull();
});
test("no content leaks into the record", () => {
  expect(JSON.stringify(normaliseClaudeRecord(JSON.parse(rec())))).not.toContain("SECRET");
});
test("synthetic and zero usage skipped", () => {
  expect(normaliseClaudeRecord(JSON.parse(rec({ model: "<synthetic>" })))).toBeNull();
  expect(normaliseClaudeRecord(JSON.parse(rec({ u: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })))).toBeNull();
});
test("repeated content-block lines, malformed, incomplete final line, multi projects", () => {
  const f = join(root, "projA", "s1.jsonl");
  writeFileSync(f, rec() + rec() + rec() + "{not json\n" + rec({ m: "msg2", r: "req2" }) + rec({ m: "msg3" }).trimEnd());
  writeFileSync(join(root, "projB", "sub", "s2.jsonl"), rec({ s: "s2" }));
  const out = collect({ root });
  expect(out.records.length).toBe(3); // msg1(s1), msg2(s1), msg1(s2); msg3 incomplete waits
  expect(out.files).toBe(2);
  // repeat sync adds nothing
  expect(collect({ root, checkpoints: out.checkpoints }).records.length).toBe(0);
  // finishing the half line + appending adds only new
  appendFileSync(f, "\n" + rec({ m: "msg4", r: "req4" }));
  const again = collect({ root, checkpoints: out.checkpoints });
  expect(again.records.map((r) => r.externalId).sort()).toEqual(["s1|msg3|req1", "s1|msg4|req4"]);
});
test("truncated or replaced file rescans from start", () => {
  const f = join(root, "projA", "s1.jsonl");
  writeFileSync(f, rec() + rec({ m: "msg2" }));
  const first = collect({ root });
  writeFileSync(f, rec()); // shrank
  expect(collect({ root, checkpoints: first.checkpoints }).records.length).toBe(1);
  const tmp = join(root, "x.tmp"); writeFileSync(tmp, rec() + rec({ m: "msg2" }) + rec({ m: "msg5" }));
  renameSync(tmp, f); // replaced (new inode)
  expect(collect({ root, checkpoints: first.checkpoints }).records.length).toBe(3);
  rmSync(root, { recursive: true });
});
