/**
 * The week tour's plan (Phase 3 Task 7, ruling 12): pure, from a week and
 * the week's events to at most eight stops between the exchange's ends.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOUR } from '../shared/market-rules.js';
import { tourPlan, weekOf, type TourEvent } from '../shared/tour.js';

/** A Wednesday afternoon, local time. */
const WED = new Date(2026, 10, 11, 15, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ev(kind: TourEvent['kind'], at: number, towerId: string, title: string, over: Partial<TourEvent> = {}): TourEvent {
  return { kind, at: new Date(at).toISOString(), towerId, floorId: null, agentId: null, firmId: null, repo: null, title, ...over };
}

test('weekOf runs from Monday 00:00 local to the next Monday and names the Monday', () => {
  const w = weekOf(WED);
  assert.equal(w.week, '2026-11-09');
  assert.equal(w.from, new Date(2026, 10, 9, 0, 0, 0).toISOString());
  assert.equal(w.to, new Date(2026, 10, 16, 0, 0, 0).toISOString());
  // A Monday belongs to the week it starts, and a Sunday night to the week that is ending.
  assert.equal(weekOf(new Date(2026, 10, 9, 0, 0, 0).getTime()).week, '2026-11-09');
  assert.equal(weekOf(new Date(2026, 10, 15, 23, 59, 0).getTime()).week, '2026-11-09');
  // The Monday's key names the same week.
  assert.deepEqual(weekOf('2026-11-09'), w);
});

test('a tour has at most eight stops in time order, starts and ends at the exchange, drops a tower that no longer stands, and is null with one event', () => {
  const w = weekOf(WED);
  const monday = new Date(2026, 10, 9, 9, 0, 0).getTime();
  const events: TourEvent[] = [];
  // Eleven merges across the week, one of them on a tower that has since gone, plus a scar, a ribbon and a skyline.
  for (let i = 0; i < 11; i++) events.push(ev('merged', monday + i * 10 * HOUR, i === 3 ? 'gone/repo#founding' : `acme/r${i % 4}#founding`, `Quickset laid floor ${i + 1} on r${i % 4}`, { repo: `acme/r${i % 4}`, floorId: `acme/r${i % 4}#job-${i}` }));
  events.push(ev('scar', monday + 2 * DAY + HOUR, 'acme/r1#founding', 'Kumo left a scar on r1', { repo: 'acme/r1' }));
  events.push(ev('ribbon', monday + 3 * DAY, 'acme/r2#founding', 'Ashlar & Vane laid its first PR floor on r2', { repo: 'acme/r2', firmId: 'ashlar' }));
  events.push(ev('skyline', monday + 4 * DAY, 'acme/r0#founding', 'The skyline passed to r0', { repo: 'acme/r0' }));
  // An event from the week before and one from the week after are not this week's.
  events.push(ev('merged', monday - 2 * DAY, 'acme/r0#founding', 'last week'));
  events.push(ev('merged', monday + 8 * DAY, 'acme/r0#founding', 'next week'));
  const standing = new Set(['acme/r0#founding', 'acme/r1#founding', 'acme/r2#founding', 'acme/r3#founding']);

  const t = tourPlan(w, events, standing);
  assert.ok(t);
  assert.equal(t.week, '2026-11-09');
  assert.equal(t.from, w.from);
  assert.equal(t.to, w.to);
  const stops = t.stops.filter((s) => s.kind !== 'exchange');
  assert.equal(stops.length, TOUR.maxStops);
  assert.equal(t.stops[0].kind, 'exchange');
  assert.equal(t.stops[t.stops.length - 1].kind, 'exchange');
  assert.equal(t.stops.length, TOUR.maxStops + 2);
  for (let i = 1; i < stops.length; i++) assert.ok(stops[i - 1].at <= stops[i].at, 'stops run in time order');
  // The rarer kinds are kept over merges when the week has more than eight events.
  assert.ok(stops.some((s) => s.kind === 'skyline'));
  assert.ok(stops.some((s) => s.kind === 'ribbon'));
  assert.ok(stops.some((s) => s.kind === 'scar'));
  assert.equal(stops.filter((s) => s.kind === 'merged').length, TOUR.maxStops - 3);
  assert.ok(!t.stops.some((s) => s.towerId === 'gone/repo#founding'), 'a tower that no longer stands is not a stop');
  assert.ok(!t.stops.some((s) => /week/.test(s.title)), 'other weeks are not in the tour');
  // Captions name the day: "Quickset laid floor 1 on r0, Monday".
  assert.equal(stops[0].caption, `${stops[0].title}, Monday`);
  for (const s of stops) assert.match(s.caption, /, (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/);
  for (const s of stops) assert.doesNotMatch(s.caption, /—|–|--|\p{Extended_Pictographic}/u);
  // Every stop dwells six seconds; the exchange three; the glide into each stop is four, none into the first.
  for (const s of stops) assert.equal(s.dwell, TOUR.dwell);
  assert.equal(t.stops[0].dwell, TOUR.exchange);
  assert.equal(t.stops[t.stops.length - 1].dwell, TOUR.exchange);
  assert.equal(t.stops[0].glide, 0);
  for (const s of t.stops.slice(1)) assert.equal(s.glide, TOUR.glide);

  // One event is no tour; two is the least.
  assert.equal(tourPlan(w, [events[0]], standing), null);
  assert.equal(tourPlan(w, [], standing), null);
  const two = tourPlan(w, [events[0], events[1]], standing);
  assert.equal(two?.stops.filter((s) => s.kind !== 'exchange').length, 2);
  // Two events on a tower that fell are no tour either.
  assert.equal(tourPlan(w, [events[0], events[1]], new Set()), null);
  // The same floor twice is one stop.
  assert.equal(tourPlan(w, [events[0], events[0], events[1]], standing)?.stops.length, 4);
});

test("the tour's seconds equal the dwells, the glides and the exchange's ends", () => {
  const w = weekOf(WED);
  const monday = new Date(2026, 10, 9, 9, 0, 0).getTime();
  const standing = new Set(['acme/r0#founding']);
  for (const n of [2, 5, 8]) {
    const events: TourEvent[] = [];
    for (let i = 0; i < n; i++) events.push(ev('merged', monday + i * HOUR, 'acme/r0#founding', `floor ${i}`, { floorId: `f${i}` }));
    const t = tourPlan(w, events, standing);
    assert.ok(t);
    const sum = t.stops.reduce((a, s) => a + s.dwell + s.glide, 0);
    assert.equal(t.seconds, sum);
    assert.equal(t.seconds, n * TOUR.dwell + 2 * TOUR.exchange + (n + 1) * TOUR.glide);
  }
  // About 90 seconds at eight stops.
  const eight = tourPlan(w, Array.from({ length: 8 }, (_, i) => ev('merged', monday + i * HOUR, 'acme/r0#founding', `floor ${i}`, { floorId: `f${i}` })), standing);
  assert.equal(eight?.seconds, 90);
});
