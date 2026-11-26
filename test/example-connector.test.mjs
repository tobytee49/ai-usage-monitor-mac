import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as example from "../examples/connectors/example-provider.mjs";

const FIXTURE = join(import.meta.dir, "..", "examples", "connectors", "fixtures", "example-usage.jsonl");

test("turns synthetic provider lines into normalised records", () => {
  const { records } = example.collect({ file: FIXTURE });
  expect(records.map((r) => r.externalId)).toEqual(["example-provider:req-001", "example-provider:req-002"]);
  expect(records[0]).toMatchObject({ inputTokens: 120, outputTokens: 45, totalTokens: 165, cost: null, model: "example-large" });
});

test("leaves the total empty when a part is missing", () => {
  const { records } = example.collect({ file: FIXTURE });
  expect(records[1].outputTokens).toBeNull();
  expect(records[1].totalTokens).toBeNull();
});

test("never uploads prompts, paths or keys", () => {
  const text = JSON.stringify(example.collect({ file: FIXTURE }).records);
  expect(text).not.toContain("SYNTHETIC PROMPT");
  expect(text).not.toContain("/Users/synthetic");
  expect(text).not.toContain("synthetic-not-a-real-key");
});

test("a second run with the checkpoint sends nothing new", () => {
  const dir = mkdtempSync(join(tmpdir(), "aum-example-"));
  const file = join(dir, "usage.jsonl");
  try {
    writeFileSync(file, '{"request_id":"a","timestamp":"2026-01-01T00:00:00Z","usage":{"input":1,"output":2}}\n');
    const first = example.collect({ file });
    expect(first.records).toHaveLength(1);
    expect(example.collect({ file, checkpoints: first.checkpoints }).records).toHaveLength(0);
    appendFileSync(file, '{"request_id":"b","timestamp":"2026-01-01T00:01:00Z","usage":{"input":3,"output":4}}\n');
    expect(example.collect({ file, checkpoints: first.checkpoints }).records.map((r) => r.externalId)).toEqual(["example-provider:b"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detect is false when the provider is not installed", () => {
  expect(example.detect("/nonexistent/example/usage.jsonl")).toBe(false);
});
