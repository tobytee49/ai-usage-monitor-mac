import { test, expect } from 'bun:test';
import { menuRows, FRESH_MS } from '../src/local-status.mjs';
const now = Date.parse('2026-11-09T01:00:00Z');
const source = (age) => ({ observedAt: new Date(now - age).toISOString(), windows: {
  five_hour: { usedPercentage: 23, resetsAt: new Date(now + 60_000).toISOString() },
  seven_day: { usedPercentage: 20, resetsAt: new Date(now + 86_400_000).toISOString() },
} });
test('successful token sync does not make old Claude allowances current', () => {
  const rows = menuRows({ claudeReadingNew: false, tools: { 'claude-code': {
    connection: 'connected', outcome: 'success', lastSuccessAt: new Date(now).toISOString(),
  } } }, now, source(FRESH_MS));
  expect(rows.find(r => r.text?.startsWith('Claude Code'))?.validUntil).toBe((now + FRESH_MS) / 1000);
  const limits = rows.filter(r => r.text?.startsWith('5-hour limit') || r.text?.startsWith('Weekly limit'));
  expect(limits.length).toBe(2);
  for (const row of limits) { expect(row.validUntil).toBeLessThanOrEqual(now / 1000); expect(row.text.includes('%')).toBe(false); }
});
test('current Claude remaining percentages expire at their source reset, not a sync timestamp', () => {
  const rows = menuRows({}, now, source(60_000));
  const five = rows.find(r => r.text?.startsWith('5-hour limit'));
  const weekly = rows.find(r => r.text?.startsWith('Weekly limit'));
  expect(five?.text).toContain('77% remaining');
  expect(five?.validUntil).toBe((now + 60_000) / 1000);
  expect(weekly?.text).toContain('80% remaining');
  expect(weekly?.validUntil).toBe((now - 60_000 + FRESH_MS) / 1000);
});