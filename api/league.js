import { FplClient, FplError, parseLeagueId, settleAll } from '../lib/fpl-client.js';
import { prepareGameweek, scoreEntry } from '../lib/scoring.js';

const MEMBER_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 250_000;
const encoder = new TextEncoder();

function assertPayload(test, message) {
  if (!test) throw new FplError(`FPL returned incomplete data: ${message}. Please try again.`);
}

function progress(message, completed = 0, total = 0) {
  return { type: 'progress', message, completed, total };
}

function isFinal(event) {
  return Boolean(event.finished && event.data_checked);
}

async function loadMembers(client, id, signal) {
  let first;
  try {
    first = await client.standings(id, 1, signal);
  } catch (error) {
    if (error.status !== 404) throw error;
    // Classic and head-to-head IDs occupy different endpoints.
    try {
      await client.headToHead(id, signal);
    } catch (h2hError) {
      if (h2hError.status !== 404) throw h2hError;
      throw new FplError('League not found. Check the numeric ID in your FPL league URL.', 404);
    }
    throw new FplError('Head-to-head leagues are not supported. Enter a classic mini-league ID.', 422);
  }
  assertPayload(first?.league && Array.isArray(first?.standings?.results), 'league standings are missing');
  if (first.league.scoring && first.league.scoring !== 'c') {
    throw new FplError('Head-to-head leagues are not supported. Enter a classic mini-league ID.', 422);
  }
  const ranked = new Map();
  const waiting = new Map();
  const add = (payload, kind) => {
    const section = payload[kind];
    assertPayload(Array.isArray(section?.results), `${kind} page is missing`);
    for (const item of section.results) {
      assertPayload(Number.isSafeInteger(item.entry) && item.entry > 0, 'a manager entry ID is missing');
      const target = kind === 'standings' ? ranked : waiting;
      if (target.has(item.entry)) throw new FplError('FPL standings changed while loading. Please try again.');
      target.set(item.entry, item);
    }
    if (new Set([...ranked.keys(), ...waiting.keys()]).size > MEMBER_LIMIT) {
      throw new FplError('This tool supports classic mini-leagues with up to 200 members. No partial table has been calculated.', 422);
    }
  };
  add(first, 'standings');
  let page = 1;
  let payload = first;
  while (payload.standings.has_next) {
    if (page >= MEMBER_LIMIT || !payload.standings.results.length) {
      throw new FplError('FPL returned inconsistent pagination. No partial table has been calculated.');
    }
    if (ranked.size >= MEMBER_LIMIT) {
      throw new FplError('This tool supports classic mini-leagues with up to 200 members. No partial table has been calculated.', 422);
    }
    payload = await client.standings(id, ++page, signal);
    assertPayload(payload?.league?.id === first.league.id, 'league changed between pages');
    add(payload, 'standings');
  }
  if (first.new_entries) {
    add(first, 'new_entries');
    page = 1;
    payload = first;
    while (payload.new_entries.has_next) {
      if (page >= MEMBER_LIMIT || !payload.new_entries.results.length) {
        throw new FplError('FPL returned inconsistent pagination. No partial table has been calculated.');
      }
      if (new Set([...ranked.keys(), ...waiting.keys()]).size >= MEMBER_LIMIT) {
        throw new FplError('This tool supports classic mini-leagues with up to 200 members. No partial table has been calculated.', 422);
      }
      payload = await client.standings(id, 1, signal, ++page);
      add(payload, 'new_entries');
    }
  }
  return { league: first.league, managers: [...ranked.values()], waiting: [...waiting.keys()].filter(entry => !ranked.has(entry)).length };
}

export function rankStandings(rows) {
  rows.sort((a, b) => b.points - a.points || a.transfers - b.transfers || a.actualRank - b.actualRank || a.entry - b.entry);
  return rows.map((row, index) => {
    const previous = rows[index - 1];
    row.rank = previous && row.points === previous.points && row.transfers === previous.transfers ? previous.rank : index + 1;
    row.rankChange = Number.isFinite(row.actualRank) ? row.actualRank - row.rank : 0;
    return row;
  });
}

export async function* calculateLeague(id, { client, signal, now = () => new Date(), scorer = scoreEntry, prepare = prepareGameweek } = {}) {
  client ??= new FplClient();
  yield progress('Connecting to the official FPL API…');
  const [roster, bootstrap, fixtures] = await settleAll([
    loadMembers(client, id, signal), client.bootstrap(signal), client.fixtures(signal),
  ]);
  assertPayload(Array.isArray(bootstrap?.events) && Array.isArray(bootstrap?.teams) && Array.isArray(bootstrap?.elements), 'season information is missing');
  assertPayload(Array.isArray(fixtures), 'fixtures are missing');
  const { league, managers, waiting } = roster;
  const startEvent = Number(league.start_event) || 1;
  const current = bootstrap.events.find(event => event.is_current);
  const gameweek = current?.id ?? Math.max(0, ...bootstrap.events.filter(event => event.finished).map(event => event.id));
  const events = bootstrap.events.filter(event => event.id >= startEvent && event.id <= gameweek).sort((a, b) => a.id - b.id);
  const provisional = events.some(event => !isFinal(event));
  const city = bootstrap.teams.find(team => team.short_name === 'MCI' || /^man(chester)? city$/i.test(team.name));
  assertPayload(city, 'Manchester City could not be identified');
  const names = new Map(bootstrap.teams.map(team => [team.id, team.short_name || team.name]));
  const relevantFixtures = fixtures.filter(fixture => fixture.event >= startEvent && fixture.event <= gameweek);
  const pendingFixtures = relevantFixtures.filter(fixture => !fixture.finished && !fixture.finished_provisional)
    .map(fixture => `${names.get(fixture.team_h)} vs ${names.get(fixture.team_a)} (GW${fixture.event})`);
  const warnings = [];
  if (waiting) warnings.push(`${waiting} new ${waiting === 1 ? 'entrant is' : 'entrants are'} awaiting FPL’s next league update and ${waiting === 1 ? 'has' : 'have'} no published league standing yet.`);
  if (!managers.length) warnings.push('This league has no published standings yet. Try again after FPL’s next points update.');
  if (!events.length) warnings.push(gameweek < startEvent ? `Scoring has not started for this league (first gameweek: ${startEvent}).` : 'The season has not started yet.');
  if (provisional) warnings.push('Current gameweek points are provisional. Automatic substitutions and vice-captain changes are projected; players with a remaining fixture keep their place until that fixture is played.');
  yield progress(`Found ${managers.length} managers. Loading ${events.length} gameweeks…`, 0, managers.length);
  const livePayloads = managers.length ? await settleAll(events.map(event => client.live(event.id, isFinal(event), signal))) : [];
  const gameweeks = livePayloads.map((live, index) => ({ event: events[index], live }));
  const contexts = new Map(gameweeks.map(({ event, live }) => [event.id, prepare(bootstrap, fixtures, live, event.id, city.id)]));
  const rows = [];
  if (!events.length) {
    rows.push(...managers.map(manager => ({
      entry: manager.entry, team: manager.entry_name, manager: manager.player_name,
      actualRank: manager.rank, actualPoints: manager.total || 0, points: 0,
      removedPoints: 0, captainPoints: 0, benchPoints: 0, liveAdjustment: 0,
      leagueTotalAdjustment: 0, sourceAdjustment: 0,
      transferCost: 0, transfers: 0, gameweeks: [], warnings: [],
    })));
  }
  // Batches bound outstanding promises; the shared client caps all upstream IO at seven.
  for (let offset = 0; events.length && offset < managers.length; offset += 7) {
    signal?.throwIfAborted();
    const batch = await settleAll(managers.slice(offset, offset + 7).map(async manager => {
      const responses = await settleAll(events.map(async event => {
        try {
          return await client.picks(manager.entry, event.id, isFinal(event), signal);
        } catch (error) {
          if (error.status === 404) return null;
          throw error;
        }
      }));
      const firstAvailable = responses.findIndex(Boolean);
      const picksByEvent = {};
      responses.forEach((payload, index) => {
        if (!payload) {
          if (firstAvailable >= 0 && index > firstAvailable) {
            throw new FplError(`FPL is missing ${manager.entry_name}’s GW${events[index].id} team after their season started. No partial table has been calculated.`);
          }
          return;
        }
        assertPayload(Array.isArray(payload.picks) && payload.entry_history, `${manager.entry_name}’s GW${events[index].id} team is missing`);
        picksByEvent[events[index].id] = payload;
      });
      if (events.length && firstAvailable < 0) {
        throw new FplError(`FPL has no gameweek teams for ${manager.entry_name}. Try again after the next FPL update.`);
      }
      return scorer({ bootstrap, fixtures, gameweeks, manager, picksByEvent, leagueStartEvent: startEvent, contexts, removedTeamId: city.id });
    }));
    rows.push(...batch);
    yield progress(`Recalculated ${rows.length} of ${managers.length} managers…`, rows.length, managers.length);
  }
  for (const row of rows) {
    warnings.push(...(row.warnings || []));
    const published = managers.find(manager => manager.entry === row.entry)?.total;
    const reconstructed = row.gameweeks.reduce((sum, event) => sum + event.actual, 0);
    if (events.length && Number.isFinite(published) && reconstructed !== published) {
      const message = `${row.team}: the reconstructed original total is ${reconstructed}; FPL’s published league total is ${published}.`;
      if (!provisional) throw new FplError(`${message} The source data do not reconcile, so no alternative table has been returned.`);
      warnings.push(`${message} Live league totals may lag projected substitutions and point updates.`);
    }
  }
  yield { type: 'result', data: {
    league: { id: league.id, name: league.name },
    asOf: now().toISOString(), gameweek, startEvent, provisional,
    removedFixtures: relevantFixtures.filter(fixture => fixture.team_h === city.id || fixture.team_a === city.id).length,
    entries: rows.length, pendingFixtures,
    standings: rankStandings(rows), warnings: [...new Set(warnings)],
  } };
}

function errorResponse(message, status) {
  return new Response(`${JSON.stringify({ type: 'error', message })}\n`, {
    status, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function createLeagueHandler({ client, timeoutMs = REQUEST_TIMEOUT_MS, now, scorer, prepare } = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'GET') return errorResponse('Use GET to load a league.', 405);
      let id;
      try { id = parseLeagueId(new URL(request.url).searchParams.get('id')); }
      catch (error) { return errorResponse(error.message, error.status || 400); }
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal.reason || new FplError('Request cancelled.', 499));
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      const timer = setTimeout(() => controller.abort(new FplError('This league took too long to calculate. Please try again; the FPL API may be busy.', 504)), timeoutMs);
      const cleanUp = () => { clearTimeout(timer); request.signal.removeEventListener('abort', abort); };
      const iterator = calculateLeague(id, { client, signal: controller.signal, now, scorer, prepare });
      let cancelled = false;
      const stream = new ReadableStream({
        async pull(output) {
          try {
            controller.signal.throwIfAborted();
            const next = await iterator.next();
            if (next.done) { cleanUp(); output.close(); return; }
            output.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
          } catch (error) {
            cleanUp();
            controller.abort(error);
            const message = error instanceof Error ? error.message : 'The league could not be calculated. Please try again.';
            if (!cancelled) {
              output.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', message })}\n`));
              output.close();
            }
            await iterator.return();
          }
        },
        async cancel() {
          cancelled = true;
          controller.abort(new FplError('Request cancelled.', 499));
          cleanUp();
          await iterator.return();
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Accel-Buffering': 'no',
        },
      });
    },
  };
}

export default createLeagueHandler();
