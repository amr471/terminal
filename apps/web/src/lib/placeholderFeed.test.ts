import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACEHOLDER_NEWS_ITEMS,
  PLACEHOLDER_CALENDAR_EVENTS,
  newsHeadlineFor,
  nextPlaceholderEvent,
  calendarEventName,
} from './placeholderFeed.js';

test('newsHeadlineFor selects the locale-appropriate headline text', () => {
  const item = PLACEHOLDER_NEWS_ITEMS[0];
  assert.ok(item);
  assert.equal(newsHeadlineFor('en', item), item.en);
  assert.equal(newsHeadlineFor('ru', item), item.ru);
});

test('nextPlaceholderEvent picks the soonest upcoming event today', () => {
  // 10:00 UTC — the 12:00 UTC event (2h out) is sooner than 18:00 (8h out)
  // and sooner than tomorrow's 01:00 (wraps to +15h).
  const now = new Date('2026-07-13T10:00:00.000Z');
  const result = nextPlaceholderEvent(now);
  assert.equal(result.hoursUntil, 2);
  assert.equal(result.event.utcHour, 12);
});

test('nextPlaceholderEvent wraps to tomorrow once every hour has passed today', () => {
  // 23:00 UTC — every event (01:00, 12:00, 18:00) has already happened
  // today; the soonest is tomorrow's 01:00, 2h out.
  const now = new Date('2026-07-13T23:00:00.000Z');
  const result = nextPlaceholderEvent(now);
  assert.equal(result.hoursUntil, 2);
  assert.equal(result.event.utcHour, 1);
});

test('nextPlaceholderEvent rounds up and never returns 0 hours', () => {
  // 11:59:30 UTC — 30 seconds before the 12:00 event; ceil'd up to 1h, not 0.
  const now = new Date('2026-07-13T11:59:30.000Z');
  const result = nextPlaceholderEvent(now);
  assert.equal(result.hoursUntil, 1);
  assert.equal(result.event.utcHour, 12);
});

test('nextPlaceholderEvent always resolves against the non-empty const list', () => {
  assert.ok(PLACEHOLDER_CALENDAR_EVENTS.length > 0);
});

test('calendarEventName selects the locale-appropriate event name', () => {
  const event = PLACEHOLDER_CALENDAR_EVENTS[0];
  assert.ok(event);
  assert.equal(calendarEventName('en', event), event.en);
  assert.equal(calendarEventName('ru', event), event.ru);
});
