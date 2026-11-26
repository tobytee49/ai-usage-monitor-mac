import { test, expect } from 'bun:test';
import { capacityEmphasis, menuRows, FRESH_MS } from '../src/local-status.mjs';

const now = Date.parse('2026-11-12T03:00:00Z');
const allowance = { category: 'chat', categoryLabel: 'Chat', allowanceTotal: 200, allowanceRemaining: 40, percentUsed: 80,
  observedAt: new Date(now - 60_000).toISOString(), resetAt: new Date(now + 3_600_000).toISOString() };
const rowFor = (a) => menuRows({ tools: { 'github-copilot': { allowances: [a] } } }, now, null).find(r => r.currentDisplay?.label === 'Chat');

test('20 percent remaining is low; above 20 is ordinary capacity', () => {
  expect(capacityEmphasis(allowance).state).toBe('low');
  expect(capacityEmphasis({ ...allowance, percentUsed: 79.9 }).state).toBe('current');
});
test('zero remaining is exhausted rather than merely low', () => {
  expect(capacityEmphasis({ ...allowance, percentUsed: 100, allowanceRemaining: 0 }).state).toBe('exhausted');
});
test('unlimited allowance is not a low-capacity warning', () => {
  expect(capacityEmphasis({ ...allowance, unlimited: true, percentUsed: 100 }).state).toBe('unlimited');
});
test('0/0 entitlement is not included, never exhausted', () => {
  expect(capacityEmphasis({ ...allowance, allowanceTotal: 0, allowanceRemaining: 0, percentUsed: null }).state).toBe('not-included');
});
test('future-dated rejected reading cannot be revived by native expiry selection', () => {
  expect(rowFor({ ...allowance, observedAt: new Date(now + 120_000).toISOString() })?.validUntil).toBe(0);
});
test('exact 30-minute expiry disables native current display', () => {
  expect(rowFor({ ...allowance, observedAt: new Date(now - FRESH_MS).toISOString() })?.validUntil).toBe(0);
});
test('reset reached disables native current display', () => {
  expect(rowFor({ ...allowance, resetAt: new Date(now).toISOString() })?.validUntil).toBe(0);
});
test('genuine failed check is kept independent of a current allowance', () => {
  const rows = menuRows({ tools: { 'github-copilot': { outcome: 'failed', allowances: [allowance] } } }, now, null);
  expect(rows.find(r => r.heading && r.role === 'problem')).toBeDefined();
  expect(rows.find(r => r.currentDisplay?.label === 'Chat')?.validUntil).toBeGreaterThan(now / 1000);
});