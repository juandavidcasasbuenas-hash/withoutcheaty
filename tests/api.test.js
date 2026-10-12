import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeagueHandler, rankStandings } from '../api/league.js';
import { FplCache, FplClient, FplError } from '../lib/fpl-client.js';

const event = (id, final = true) => ({ id, finished: final, data_checked: final, is_current: id === 1 });
const manager = (entry, total = 10) => ({ entry, entry_name: `Team ${entry}`, player_name: `Manager ${entry}`, rank: entry, total });
const league = { id: 123, name: 'The test league', scoring: 'c', start_event: 1 };
const page = (results, has_next = false, overrides = {}) => ({ league, standings: { results, has_next }, new_entries: { results: [], has_next: false }, ...overrides });
const bootstrap = { events: [event(1)], elements: [], teams: [{ id: 1, name: 'Man City', short_name: 'MCI' }, { id: 2, name: 'Arsenal', short_name: 'ARS' }] };
const picks = (points = 10) => ({ picks: [], entry_history: { points } });
const fixtures = [{ id: 1, event: 1, team_h: 1, team_a: 2, finished: true, finished_provisional: true }];

function mockClient(overrides = {}) {
  return {
    standings: async () => page([manager(1)]),
    headToHead: async () => { throw new FplError('Not found', 404); },
    bootstrap: async () => structuredClone(bootstrap), fixtures: async () => structuredClone(fixtures),
    live: async () => ({ elements: [] }), picks: async () => picks(),
    ...overrides,
  };
}

function scorer({ manager: entry, picksByEvent }) {
  const gameweeks = Object.entries(picksByEvent).map(([id, value]) => ({ event: Number(id), actual: value.entry_history.points }));
  return {
    entry: entry.entry, team: entry.entry_name, manager: entry.player_name,
    actualRank: entry.rank, actualPoints: entry.total, points: 5,
    transfers: 0, removedPoints: 5, captainPoints: 0, benchPoints: 0,
    transferCost: 0, gameweeks, warnings: [],
  };
}

async function run(client = mockClient(), query = '123', options = {}) {
  const handler = createLeagueHandler({ client, scorer, prepare: () => ({}), now: () => new Date('2026-10-12T18:00:00Z'), ...options });
  const response = await handler.fetch(new Request(`http://localhost/api/league?id=${encodeURIComponent(query)}`));
  const messages = (await response.text()).trim().split('\n').map(JSON.parse);
  return { response, messages, result: messages.find(message => message.type === 'result')?.data, error: messages.find(message => message.type === 'error')?.message };
}

test('rejects invalid IDs before touching upstream', async () => {
  let touched = false;
  const client = mockClient({ standings: async () => { touched = true; } });
  for (const input of ['0', '-1', '1.2', '1234567890', 'abc', 'https://example.com', '']) {
    const result = await run(client, input);
    assert.equal(result.response.status, 400);
    assert.match(result.error, /numeric FPL league ID/);
  }
  assert.equal(touched, false);
});

test('streams progress and a complete ranked result', async () => {
  const { result, messages, response } = await run();
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  assert.equal(messages[0].type, 'progress');
  assert.equal(messages.at(-1).type, 'result');
  assert.deepEqual(result.league, { id: 123, name: 'The test league' });
  assert.equal(result.asOf, '2026-10-12T18:00:00.000Z');
  assert.equal(result.removedFixtures, 1);
  assert.equal(result.standings[0].rank, 1);
});

test('missing leagues and head-to-head leagues have specific errors', async () => {
  const missing = async () => { throw new FplError('Not found', 404); };
  assert.match((await run(mockClient({ standings: missing }))).error, /League not found/);
  assert.match((await run(mockClient({ standings: missing, headToHead: async () => ({}) }))).error, /Head-to-head/);
  assert.match((await run(mockClient({ standings: async () => page([], false, { league: { ...league, scoring: 'h' } }) }))).error, /Head-to-head/);
});

test('paginates all scored entries and rejects duplicate pages', async () => {
  const calls = [];
  const client = mockClient({ standings: async (id, number) => {
    calls.push(number);
    return number === 1 ? page([manager(1)], true) : page([manager(2)]);
  } });
  assert.equal((await run(client)).result.entries, 2);
  assert.deepEqual(calls, [1, 2]);
  const duplicate = await run(mockClient({ standings: async () => page([manager(1)], true) }));
  assert.match(duplicate.error, /changed while loading/);
  assert.equal(duplicate.result, undefined);
});

test('over 200 members fails without calculating a partial table', async () => {
  let pickCalls = 0;
  const result = await run(mockClient({
    standings: async () => page(Array.from({ length: 200 }, (_, index) => manager(index + 1)), true),
    picks: async () => { pickCalls++; return picks(); },
  }));
  assert.match(result.error, /up to 200 members.*No partial table/);
  assert.equal(result.result, undefined);
  assert.equal(pickCalls, 0);
});

test('preseason and empty leagues return explanatory empty or zero standings', async () => {
  const empty = await run(mockClient({ standings: async () => page([]) }));
  assert.equal(empty.result.entries, 0);
  assert.match(empty.result.warnings.join(' '), /no published standings/);
  const preseason = await run(mockClient({ bootstrap: async () => ({ ...bootstrap, events: [{ ...event(1, false), is_current: false }] }) }));
  assert.equal(preseason.result.gameweek, 0);
  assert.equal(preseason.result.standings[0].points, 0);
});

test('respects league start_event and permits 404 only before first available picks', async () => {
  const calls = [];
  const events = [{ ...event(1), is_current: false }, { ...event(2), is_current: true }, { ...event(3), is_current: false }];
  const later = await run(mockClient({
    bootstrap: async () => ({ ...bootstrap, events }),
    standings: async () => page([manager(1)], false, { league: { ...league, start_event: 2 } }),
    picks: async (entry, gw) => { calls.push(gw); return picks(); },
  }));
  assert.deepEqual(calls, [2]);
  assert.equal(later.result.startEvent, 2);
  const currentTwo = [{ ...event(1), is_current: false }, { ...event(2), is_current: true }];
  const lateEntry = await run(mockClient({
    bootstrap: async () => ({ ...bootstrap, events: currentTwo }),
    picks: async (entry, gw) => { if (gw === 1) throw new FplError('Not found', 404); return picks(); },
  }));
  assert.equal(lateEntry.result.entries, 1);
  const missingAfter = await run(mockClient({
    bootstrap: async () => ({ ...bootstrap, events: currentTwo }),
    picks: async (entry, gw) => { if (gw === 2) throw new FplError('Not found', 404); return picks(); },
  }));
  assert.match(missingAfter.error, /missing .*GW2 team/);
  assert.equal(missingAfter.result, undefined);
});

test('completed source mismatch fails; unfinished source mismatch warns', async () => {
  const completed = await run(mockClient({ picks: async () => picks(8) }));
  assert.match(completed.error, /source data do not reconcile/);
  assert.equal(completed.result, undefined);
  const live = await run(mockClient({ picks: async () => picks(8), bootstrap: async () => ({ ...bootstrap, events: [event(1, false)] }) }));
  assert.equal(live.result.provisional, true);
  assert.match(live.result.warnings.join(' '), /Live league totals may lag/);
});

test('pending fixture status uses finished_provisional', async () => {
  const result = await run(mockClient({
    fixtures: async () => [{ ...fixtures[0], finished: false, finished_provisional: true }, { ...fixtures[0], id: 2, finished: false, finished_provisional: false }],
  }));
  assert.deepEqual(result.result.pendingFixtures, ['MCI vs ARS (GW1)']);
});

test('ranking breaks equal points by transfers and preserves remaining shared rank', () => {
  const ranked = rankStandings([
    { entry: 1, points: 50, transfers: 5, actualRank: 1 },
    { entry: 2, points: 50, transfers: 2, actualRank: 2 },
    { entry: 3, points: 50, transfers: 2, actualRank: 3 },
  ]);
  assert.deepEqual(ranked.map(row => [row.entry, row.rank]), [[2, 1], [3, 1], [1, 3]]);
});

test('upstream retries only 429/5xx and stays on the fixed API origin', async () => {
  const urls = [];
  let attempts = 0;
  const client = new FplClient({ cache: null, sleep: async () => {}, fetchImpl: async (url, options) => {
    urls.push(url);
    assert.equal(options.redirect, 'error');
    attempts++;
    return attempts < 3 ? new Response('{}', { status: attempts === 1 ? 429 : 503 }) : Response.json({ events: [] });
  } });
  assert.deepEqual(await client.bootstrap(), { events: [] });
  assert.equal(attempts, 3);
  assert.ok(urls.every(url => url === 'https://fantasy.premierleague.com/api/bootstrap-static/'));
  await assert.rejects(client.get('https://example.com/'), /Invalid FPL API endpoint/);
  let forbiddenCalls = 0;
  const forbidden = new FplClient({ cache: null, fetchImpl: async () => { forbiddenCalls++; return new Response('{}', { status: 403 }); } });
  await assert.rejects(forbidden.bootstrap(), /not allowing access/);
  assert.equal(forbiddenCalls, 1);
});

test('client permits constructed pagination parameters and limits global upstream concurrency', async () => {
  let active = 0;
  let maximum = 0;
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return Response.json({ okay: true });
  };
  const a = new FplClient({ cache: null, fetchImpl });
  const b = new FplClient({ cache: null, fetchImpl });
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? a : b).standings(123, index + 1, undefined, 2)));
  assert.equal(maximum, 7);
  assert.ok(urls.every(url => new URL(url).searchParams.get('page_new_entries') === '2'));
});

test('paginates awaiting entrants and explains why they have no scored row', async () => {
  const calls = [];
  const result = await run(mockClient({ standings: async (id, number, signal, newPage = 1) => {
    calls.push(newPage);
    return page([manager(1)], false, {
      new_entries: { results: [manager(newPage + 1)], has_next: newPage === 1 },
    });
  } }));
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.result.entries, 1);
  assert.match(result.result.warnings.join(' '), /2 new entrants are awaiting/);
});

test('cache expires live data and bounds retained entries and bytes', () => {
  let now = 0;
  const cache = new FplCache({ maxEntries: 2, maxBytes: 10, now: () => now });
  cache.set('a', 1, 30_000, 4);
  cache.set('b', 2, 30_000, 4);
  cache.set('c', 3, 30_000, 4);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.entries.size, 2);
  assert.equal(cache.bytes, 8);
  now = 30_001;
  assert.equal(cache.get('b'), undefined);
  cache.set('oversized', 4, 30_000, 20);
  assert.equal(cache.get('oversized'), undefined);
});

test('whole-request timeout aborts upstream work and returns no result', async () => {
  let aborted = false;
  const client = mockClient({ bootstrap: async signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) });
  const result = await run(client, '123', { timeoutMs: 10 });
  assert.equal(aborted, true);
  assert.match(result.error, /took too long/);
  assert.equal(result.result, undefined);
});

test('cancelling the stream aborts outstanding upstream work', async () => {
  let started;
  const hasStarted = new Promise(resolve => { started = resolve; });
  let aborted = false;
  const client = mockClient({ bootstrap: async signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    started();
  }) });
  const handler = createLeagueHandler({ client, scorer, prepare: () => ({}) });
  const response = await handler.fetch(new Request('http://localhost/api/league?id=123'));
  const reader = response.body.getReader();
  await reader.read();
  await hasStarted;
  await reader.cancel();
  assert.equal(aborted, true);
});
