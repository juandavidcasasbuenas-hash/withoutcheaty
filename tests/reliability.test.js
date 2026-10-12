import test from 'node:test';
import assert from 'node:assert/strict';
import { FplClient } from '../lib/fpl-client.js';
import { LeagueSnapshots, MAX_SNAPSHOT_AGE_MS } from '../lib/league-snapshots.js';
import { readSavedLeague, reusableLeague, saveLeague } from '../src/saved-leagues.ts';

const instant = Date.parse('2026-10-12T18:00:00Z');
const table = (id = 123, at = instant) => ({
  league: { id, name: 'Test league' }, asOf: new Date(at).toISOString(),
  gameweek: 1, startEvent: 1, provisional: false, removedFixtures: 1,
  entries: 1, pendingFixtures: [], warnings: [], standings: [{
    entry: 1, team: 'Test team', manager: 'Test manager', actualRank: 1,
    actualPoints: 10, points: 5, removedPoints: 5, captainPoints: 0, benchPoints: 0,
    transferCost: 0, transfers: 0, rank: 1, rankChange: 0,
    gameweeks: [{ event: 1, actual: 10, points: 5, removedPoints: 5, captainPoints: 0,
      benchPoints: 0, transferCost: 0, captain: 'A', viceCaptain: 'B',
      effectiveCaptain: 'B', subsIn: [], subsOut: [], pending: [], chip: null }],
  }],
});

test('transient network failures retry and recover; persistent failures stop after three attempts', async () => {
  let calls = 0;
  const client = new FplClient({ cache: null, sleep: async () => {}, fetchImpl: async () => {
    if (++calls < 3) throw new TypeError('fetch failed');
    return Response.json({ okay: true });
  } });
  assert.deepEqual(await client.bootstrap(), { okay: true });
  assert.equal(calls, 3);
  calls = 0;
  client.fetchImpl = async () => { calls++; throw new TypeError('fetch failed'); };
  await assert.rejects(client.bootstrap(), error => error.code === 'FPL_NETWORK_ERROR' && error.allowSaved);
  assert.equal(calls, 3);
});

test('individual timeouts retry, caller cancellation does not', async () => {
  let calls = 0;
  const client = new FplClient({ cache: null, timeoutMs: 5, sleep: async () => {}, fetchImpl: async (url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  await assert.rejects(client.bootstrap(), error => error.code === 'FPL_TIMEOUT' && error.allowSaved);
  assert.equal(calls, 3);
  const controller = new AbortController();
  calls = 0;
  client.fetchImpl = async () => { calls++; controller.abort(); throw controller.signal.reason; };
  await assert.rejects(client.bootstrap(controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('Retry-After is respected without retrying early when the wait is too long', async () => {
  let calls = 0;
  const waits = [];
  const client = new FplClient({ cache: null, sleep: async ms => { waits.push(ms); }, fetchImpl: async () => {
    calls++;
    return new Response('', { status: 429, headers: { 'Retry-After': calls === 1 ? '2' : '60' } });
  } });
  await assert.rejects(client.bootstrap(), error => error.code === 'FPL_RATE_LIMITED' && error.allowSaved);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
});

test('missing or unreadable upstream data cannot become a saved fallback', async () => {
  for (const response of [new Response('', { status: 404 }), new Response('<html>bad response</html>')]) {
    let calls = 0;
    const client = new FplClient({ cache: null, fetchImpl: async () => { calls++; return response; } });
    await assert.rejects(client.bootstrap(), error => error.allowSaved === false);
    assert.equal(calls, 1);
  }
});

test('whole tables survive new cache instances, refresh from shared storage and keep the original age', async () => {
  let now = instant;
  const shared = new Map();
  const remote = { get: async key => shared.get(key), set: async (key, value) => { shared.set(key, structuredClone(value)); } };
  const first = new LeagueSnapshots({ remote, now: () => now });
  await first.set(123, table());
  const second = new LeagueSnapshots({ remote, now: () => now });
  assert.deepEqual(await second.get(123), table());
  now += 60_000;
  const updated = table(123, now);
  await first.set(123, updated);
  assert.deepEqual(await second.get(123), updated);
  await first.set(123, { ...updated, freshness: { state: 'saved', reason: 'offline' } });
  assert.equal((await second.get(123)).freshness, undefined);
  now += MAX_SNAPSHOT_AGE_MS;
  assert.equal(await second.get(123), undefined);
});

test('unavailable cache fails open; wrong-league and future snapshots are rejected', async () => {
  const cache = new LeagueSnapshots({ now: () => instant, operationTimeoutMs: 5, remote: {
    get: async () => new Promise(() => {}), set: async () => { throw new Error('unavailable'); },
  } });
  assert.equal(await cache.get(123), undefined);
  await cache.set(123, table());
  assert.deepEqual(await cache.get(123), table());
  for (const value of [table(456), table(123, instant + 1), table(123, instant - MAX_SNAPSHOT_AGE_MS)]) {
    const invalid = new LeagueSnapshots({ now: () => instant, remote: { get: async () => value } });
    assert.equal(await invalid.get(123), undefined);
  }
});

function storage() {
  let value = '[]';
  return { getItem: () => value, setItem: (key, next) => { value = next; } };
}

test('browser fallback survives reload and retains only three recent successful leagues', () => {
  const store = storage();
  for (let id = 1; id <= 4; id++) saveLeague(table(id), store, instant);
  assert.equal(readSavedLeague(1, store, instant), null);
  assert.deepEqual(readSavedLeague(2, store, instant + 60_000), table(2));
  saveLeague({ ...table(2, instant + 60_000), freshness: { state: 'saved', reason: 'offline' } }, store, instant + 60_000);
  assert.equal(readSavedLeague(2, store, instant + 60_000).asOf, table(2).asOf);
  assert.equal(readSavedLeague(2, store, instant + MAX_SNAPSHOT_AGE_MS), null);
});

test('untrusted browser snapshots and unavailable storage cannot corrupt a table or break a fresh lookup', () => {
  const valid = table();
  assert.equal(reusableLeague(valid, 123, instant), true);
  const unsafe = structuredClone(valid);
  unsafe.standings[0].points = '<img src=x onerror=alert(1)>';
  assert.equal(reusableLeague(unsafe, 123, instant), false);
  const incomplete = structuredClone(valid);
  delete incomplete.standings[0].gameweeks[0].subsIn;
  assert.equal(reusableLeague(incomplete, 123, instant), false);
  assert.equal(reusableLeague(valid, 456, instant), false);
  assert.equal(reusableLeague(valid, 123, instant - 1), false);
  for (const store of [
    { getItem: () => 'not JSON' },
    { getItem: () => { throw new Error('disabled'); } },
    { getItem: () => '[]', setItem: () => { throw new Error('full'); } },
  ]) {
    assert.equal(readSavedLeague(123, store, instant), null);
    assert.doesNotThrow(() => saveLeague(valid, store, instant));
  }
  // Storage can be absent entirely (or its property getter can throw).
  assert.doesNotThrow(() => saveLeague(valid, undefined, instant));
  assert.equal(readSavedLeague(123, undefined, instant), null);
});
