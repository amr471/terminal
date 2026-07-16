import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  t,
  en,
  ru,
  negotiateLocale,
  formatDec,
  formatPercentFromFraction,
  roundDec,
  shiftDec,
  formatAge,
  isSessionOpen,
  activeSessions,
  sessionOverlaps,
  nyClock,
  isValidTimezone,
} from './index.js';

const NBSP = '\u00a0';

// ── catalogs & translator ────────────────────────────────────────────────────

test('ru catalog covers every en key', () => {
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
});

test('t() interpolates params', () => {
  assert.equal(t('en', 'status.next_event', { hours: 3 }), 'Next high-impact event in 3h');
  assert.equal(t('ru', 'status.next_event', { hours: 3 }), 'Следующее важное событие через 3ч');
});

test('t() resolves Russian plural categories (one/few/many)', () => {
  assert.equal(t('ru', 'screener.results', { count: 1 }), '1 результат');
  assert.equal(t('ru', 'screener.results', { count: 2 }), '2 результата');
  assert.equal(t('ru', 'screener.results', { count: 5 }), '5 результатов');
  assert.equal(t('ru', 'screener.results', { count: 21 }), '21 результат');
  assert.equal(t('en', 'screener.results', { count: 1 }), '1 result');
  assert.equal(t('en', 'screener.results', { count: 7 }), '7 results');
});

test('negotiateLocale handles Accept-Language shapes', () => {
  assert.equal(negotiateLocale('ru-RU,ru;q=0.9,en;q=0.8'), 'ru');
  assert.equal(negotiateLocale('en-US,en;q=0.9'), 'en');
  assert.equal(negotiateLocale('de-DE,fr;q=0.9'), 'en'); // fallback
  assert.equal(negotiateLocale(undefined), 'en');
});

// ── string-decimal formatting (no float round-trips) ─────────────────────────

test('roundDec: half-up string rounding, carry included', () => {
  assert.equal(roundDec('64123.456', 2), '64123.46');
  assert.equal(roundDec('999.95', 1), '1000.0');
  assert.equal(roundDec('-0.055', 2), '-0.06');
  assert.equal(roundDec('1.005', 2), '1.01'); // floats infamously get this wrong
  assert.equal(roundDec('42', 2), '42');
});

test('shiftDec: ×10^n by moving the point, not multiplying', () => {
  assert.equal(shiftDec('-0.052', 2), '-5.2');
  assert.equal(shiftDec('0.0001', 2), '0.01');
  assert.equal(shiftDec('1.5', 3), '1500');
  assert.equal(shiftDec('0', 2), '0');
});

test('formatDec: precision survives values that break floats', () => {
  // 18-significant-digit value — Number() would corrupt it
  assert.equal(
    formatDec('123456789012345678.99', 'en', { maxFrac: 2 }),
    '123,456,789,012,345,678.99',
  );
  assert.equal(formatDec('64123.5', 'en', { minFrac: 2 }), '64,123.50');
  assert.equal(formatDec('64123.5', 'ru', { minFrac: 2 }), `64${NBSP}123,50`);
  assert.equal(formatDec('-1234.5678', 'en', { maxFrac: 2 }), '-1,234.57');
  assert.equal(formatDec('42', 'en', { explicitSign: true }), '+42');
});

test('formatPercentFromFraction: fraction → % per locale', () => {
  assert.equal(formatPercentFromFraction('-0.052', 'en'), '-5.2%');
  assert.equal(formatPercentFromFraction('-0.052', 'ru'), `-5,2${NBSP}%`);
  assert.equal(formatPercentFromFraction('0.0001', 'en'), '0.01%');
  assert.equal(formatPercentFromFraction('0.031', 'en', { explicitSign: true }), '+3.1%');
});

test('formatAge for stale badges', () => {
  assert.equal(formatAge(12_000, 'en'), '12s');
  assert.equal(formatAge(3 * 60_000, 'ru'), '3мин');
  assert.equal(formatAge(26 * 3_600_000, 'en'), '1d');
});

// ── fixed session clock (user timezone must play no role) ────────────────────

test('NY clock switches EST/EDT automatically', () => {
  assert.equal(nyClock(new Date('2026-01-15T17:00:00Z')).abbreviation, 'EST');
  assert.equal(nyClock(new Date('2026-07-15T17:00:00Z')).abbreviation, 'EDT');
  assert.equal(nyClock(new Date('2026-07-15T17:00:00Z')).time, '13:00:00');
});

test('DST boundary 2026: NY springs forward Mar 8', () => {
  // 06:59Z Mar 8 2026 = 01:59 EST; 08:00Z = 04:00 EDT (03:00 never exists)
  assert.equal(nyClock(new Date('2026-03-08T06:59:00Z')).abbreviation, 'EST');
  assert.equal(nyClock(new Date('2026-03-08T08:00:00Z')).abbreviation, 'EDT');
});

test('London/NY overlap is detected on a summer weekday', () => {
  // Wed 2026-07-15 14:00 UTC: London 15:00 BST (open), NY 10:00 EDT (open),
  // Tokyo 23:00 (closed), Sydney 00:00 Thu (closed).
  const d = new Date('2026-07-15T14:00:00Z');
  assert.deepEqual(activeSessions(d), ['london', 'new_york']);
  assert.deepEqual(sessionOverlaps(d), [['london', 'new_york']]);
});

test('Tokyo/London do not overlap in summer (BST); Sydney/Tokyo do', () => {
  // 2026-07-15 01:00 UTC: Tokyo 10:00 (open), Sydney 11:00 AEST (open),
  // London 02:00 (closed), NY 21:00 prev (closed).
  const d = new Date('2026-07-15T01:00:00Z');
  assert.deepEqual(activeSessions(d), ['sydney', 'tokyo']);
});

test('weekends: everything closed (local weekday check)', () => {
  const saturday = new Date('2026-07-18T12:00:00Z');
  assert.deepEqual(activeSessions(saturday), []);
  assert.equal(isSessionOpen('london', saturday), false);
});

test('session boundaries are half-open [open, close)', () => {
  // London opens 08:00 local. 2026-01-14 is a Wednesday; London = UTC in winter.
  assert.equal(isSessionOpen('london', new Date('2026-01-14T07:59:00Z')), false);
  assert.equal(isSessionOpen('london', new Date('2026-01-14T08:00:00Z')), true);
  assert.equal(isSessionOpen('london', new Date('2026-01-14T16:59:00Z')), true);
  assert.equal(isSessionOpen('london', new Date('2026-01-14T17:00:00Z')), false);
});

// ── user-timezone clock (P1.4a) ───────────────────────────────────────────────

test('isValidTimezone accepts real IANA zones and rejects garbage', () => {
  assert.equal(isValidTimezone('America/New_York'), true);
  assert.equal(isValidTimezone('Asia/Tokyo'), true);
  assert.equal(isValidTimezone('UTC'), true);
  assert.equal(isValidTimezone('Not/AZone'), false);
  assert.equal(isValidTimezone(''), false);
  assert.equal(isValidTimezone('garbage-string'), false);
});
