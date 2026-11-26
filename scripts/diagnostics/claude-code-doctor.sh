#!/bin/bash
# AI Usage Monitor — Claude Code structure doctor (read-only, redacted).
# Reads ~/.claude/projects/**/*.jsonl and prints ONLY structure: counts,
# field names, model names and repeat statistics. Never prints prompts,
# responses, code, tool output, file names, paths or ID values.
# Writes nothing. Uses only built-in macOS tools (JavaScript for Automation).
set -euo pipefail
ROOT="${HOME}/.claude/projects"
if [ ! -d "$ROOT" ]; then echo "RESULT: ~/.claude/projects not found"; exit 0; fi

/usr/bin/osascript -l JavaScript - "$ROOT" <<'JXA'
ObjC.import("Foundation");
function run(argv) {
  const root = argv[0];
  const fm = $.NSFileManager.defaultManager;
  const en = fm.enumeratorAtPath(root);
  const files = []; let p;
  while ((p = en.nextObject) && !p.isNil()) {
    const s = ObjC.unwrap(p);
    if (s.endsWith(".jsonl")) files.push(root + "/" + s);
  }
  const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  const r = { files: files.length, dirs: {}, nestedFiles: 0, lines: 0, blank: 0, malformed: 0,
    incompleteFinalLine: 0, types: {}, topKeys: {}, msgKeys: {}, usageKeys: {}, usageNested: {},
    models: {}, withUsage: 0, idPresence: {}, synthetic: 0, apiError: 0, sidechain: 0,
    zeroUsage: 0, stopReasons: {}, cacheReadGtInput: 0, costField: 0,
    sessionIdMatchesFile: 0, sessionIdDiffersFile: 0, tsParseable: 0, tsMissing: 0 };
  const groups = {}; const msgOnly = {}; const crossSession = {};
  for (const f of files) {
    const rel = f.slice(root.length + 1).split("/");
    inc(r.dirs, rel[0]); if (rel.length > 2) r.nestedFiles++;
    const fileId = rel[rel.length - 1].replace(/\.jsonl$/, "");
    const str = $.NSString.stringWithContentsOfFileEncodingError(f, $.NSUTF8StringEncoding, null);
    if (str.isNil()) continue;
    const text = ObjC.unwrap(str);
    if (text.length && !text.endsWith("\n")) r.incompleteFinalLine++;
    for (const line of text.split("\n")) {
      if (!line.trim()) { r.blank++; continue; }
      r.lines++;
      let o; try { o = JSON.parse(line); } catch (e) { r.malformed++; continue; }
      inc(r.types, String(o.type));
      for (const k of Object.keys(o)) inc(r.topKeys, k);
      if (o.isSidechain) r.sidechain++;
      if (o.isApiErrorMessage) r.apiError++;
      if ("costUSD" in o) r.costField++;
      const m = o.message && typeof o.message === "object" ? o.message : null;
      const u = m && m.usage && typeof m.usage === "object" ? m.usage : null;
      if (!u) continue;
      r.withUsage++;
      for (const k of Object.keys(m)) inc(r.msgKeys, k);
      for (const k of Object.keys(u)) {
        inc(r.usageKeys, k);
        if (u[k] && typeof u[k] === "object") for (const k2 of Object.keys(u[k])) inc(r.usageNested, k + "." + k2);
      }
      inc(r.models, String(m.model));
      if (m.model === "<synthetic>") r.synthetic++;
      inc(r.stopReasons, String(m.stop_reason));
      const num = (x) => (typeof x === "number" ? x : 0);
      const sum = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      if (sum === 0) r.zeroUsage++;
      if (num(u.cache_read_input_tokens) > num(u.input_tokens)) r.cacheReadGtInput++;
      for (const [k, v] of [["sessionId", o.sessionId], ["message.id", m.id], ["requestId", o.requestId], ["uuid", o.uuid], ["timestamp", o.timestamp]]) inc(r.idPresence, k + (v ? ":present" : ":missing"));
      if (o.sessionId) { if (o.sessionId === fileId) r.sessionIdMatchesFile++; else r.sessionIdDiffersFile++; }
      if (o.timestamp && !isNaN(Date.parse(o.timestamp))) r.tsParseable++; else r.tsMissing++;
      const sig = JSON.stringify([u.input_tokens, u.output_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]);
      if (m.id) {
        const key = (o.sessionId || "") + "|" + m.id + "|" + (o.requestId || "");
        (groups[key] = groups[key] || []).push(sig);
        (msgOnly[m.id] = msgOnly[m.id] || new Set()).add(key);
        (crossSession[m.id] = crossSession[m.id] || new Set()).add(o.sessionId || "");
      }
    }
  }
  const g = Object.values(groups);
  const dup = g.filter((x) => x.length > 1);
  const out = [];
  const pr = (k, v) => out.push(k + ": " + (typeof v === "object" ? JSON.stringify(v) : v));
  pr("session_files", r.files); pr("project_folders", Object.keys(r.dirs).length); pr("files_in_subfolders", r.nestedFiles);
  pr("lines", r.lines); pr("blank_lines", r.blank); pr("malformed_lines", r.malformed); pr("files_ending_without_newline", r.incompleteFinalLine);
  pr("record_types", r.types); pr("top_level_fields", r.topKeys);
  pr("usage_records", r.withUsage); pr("message_fields", r.msgKeys); pr("usage_fields", r.usageKeys); pr("usage_nested_fields", r.usageNested);
  pr("models", r.models); pr("stop_reasons", r.stopReasons); pr("id_presence_on_usage_records", r.idPresence);
  pr("sessionId_equals_filename", r.sessionIdMatchesFile); pr("sessionId_differs_filename", r.sessionIdDiffersFile);
  pr("timestamp_parseable", r.tsParseable); pr("timestamp_missing", r.tsMissing);
  pr("synthetic_model_records", r.synthetic); pr("api_error_records", r.apiError); pr("sidechain_records", r.sidechain);
  pr("zero_usage_records", r.zeroUsage); pr("cache_read_greater_than_input", r.cacheReadGtInput); pr("records_with_costUSD", r.costField);
  pr("distinct_session+message+request_keys", g.length);
  pr("keys_repeated_more_than_once", dup.length);
  pr("max_repeats_of_one_key", g.reduce((a, x) => Math.max(a, x.length), 0));
  pr("repeated_keys_with_identical_usage", dup.filter((x) => new Set(x).size === 1).length);
  pr("repeated_keys_with_differing_usage", dup.filter((x) => new Set(x).size > 1).length);
  pr("message_ids_with_multiple_requestIds", Object.values(msgOnly).filter((s) => s.size > 1).length);
  pr("message_ids_seen_in_multiple_sessions", Object.values(crossSession).filter((s) => s.size > 1).length);
  return out.join("\n");
}
JXA
