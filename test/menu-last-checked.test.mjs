import { test, expect } from 'bun:test';
import { lastCheckedLine, relativeAge, menuRows } from '../src/local-status.mjs';
const now = Date.parse('2026-11-12T14:00:00Z');
const at = (min) => new Date(now - min * 60_000).toISOString();
test('relative ages', () => {
  expect(relativeAge(20_000)).toBe('just now');
  expect(relativeAge(60_000)).toBe('1 minute ago');
  expect(relativeAge(2 * 60_000)).toBe('2 minutes ago');
  expect(relativeAge(3 * 3600_000)).toBe('3 hours ago');
});
test('success uses completed check time', () => {
  expect(lastCheckedLine({ completedAt: at(2), outcome: 'success' }, now).text).toBe('Last checked: 2 minutes ago');
});
test('never checked', () => expect(lastCheckedLine({}, now).text).toBe('Not checked yet'));
test('failed and partial', () => {
  expect(lastCheckedLine({ completedAt: at(5), outcome: 'failed' }, now)).toEqual({ text: 'Last check failed · 5 minutes ago', role: 'problem' });
  expect(lastCheckedLine({ completedAt: at(5), outcome: 'partial' }, now).text).toBe('Last checked: 5 minutes ago · some checks failed');
});
test('no check for over 45 minutes', () => {
  expect(lastCheckedLine({ completedAt: at(46), outcome: 'success' }, now).text).toBe('Not checked recently · last 46 minutes ago');
});
test('successful check does not make outdated Claude current', () => {
  const s = { completedAt: at(1), outcome: 'success', tools: {} };
  const claude = { observedAt: at(120), windows: { five_hour: { usedPercentage: 10, resetsAt: new Date(now + 3600_000).toISOString() } } };
  const row = menuRows(s, now, claude).find(r => r.outdatedDisplay?.label === '5-hour limit');
  expect(row.validUntil).toBe(0);
  expect(row.text).toContain('outdated');
});
