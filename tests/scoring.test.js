import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareGameweek, scoreEntry, ScoringError } from "../lib/scoring.js";

function explanation(fixture, points, minutes = 90, redCards = 0, yellowCards = 0) {
  return { fixture, stats: [
    { identifier: "minutes", points: 0, value: minutes },
    { identifier: "red_cards", points: 0, value: redCards },
    { identifier: "yellow_cards", points: 0, value: yellowCards },
    { identifier: "fixture_points", points, value: points },
  ] };
}

function synthetic({ changes = {}, chip = null, captain = 9, viceCaptain = 5,
  final = true, hit = 0, autoSubs = [], city = 15 } = {}) {
  const types = [1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 1, 2, 2, 3];
  const event = { id: 1, finished: final, data_checked: final };
  const bootstrap = {
    teams: [{ id: city, short_name: "MCI" }], events: [event],
    elements: types.map((element_type, i) => ({ id: i + 1, element_type, web_name: `P${i + 1}` })),
  };
  const fixtures = [
    { id: 1, event: 1, team_h: 1, team_a: 2, finished: true, finished_provisional: true },
    { id: 2, event: 1, team_h: city, team_a: 3, finished: true, finished_provisional: true },
    { id: 3, event: 1, team_h: 4, team_a: 5, finished: false, finished_provisional: false },
  ];
  const live = { elements: types.map((_, i) => {
    const explain = (changes[i + 1] ?? [[1, 2, 90]]).map((args) => explanation(...args));
    return { id: i + 1, explain, stats: { total_points: explain.reduce((n, x) => n + x.stats.reduce((v, s) => v + s.points, 0), 0) } };
  }) };
  const picks = types.map((element_type, i) => ({
    element: i + 1, position: i + 1, element_type,
    multiplier: i < 11 || chip === "bboost" ? (i + 1 === captain ? (chip === "3xc" ? 3 : 2) : 1) : 0,
    is_captain: i + 1 === captain, is_vice_captain: i + 1 === viceCaptain,
  }));
  for (const [incoming, outgoing] of autoSubs) {
    const a = picks[incoming - 1];
    const b = picks[outgoing - 1];
    [a.position, b.position] = [b.position, a.position];
    a.multiplier = 1;
    b.multiplier = 0;
  }
  picks.sort((a, b) => a.position - b.position);
  const points = picks.reduce((total, p) => total + p.multiplier * live.elements[p.element - 1].stats.total_points, 0);
  const payload = {
    active_chip: chip,
    automatic_subs: autoSubs.map(([element_in, element_out]) => ({ element_in, element_out })),
    entry_history: { event: 1, points, event_transfers_cost: hit, event_transfers: hit ? 2 : 0 },
    picks,
  };
  return {
    bootstrap, fixtures, gameweeks: [{ event, live }],
    picksByEvent: { 1: payload },
    manager: { entry: 123, entry_name: "Example", player_name: "Manager", rank: 1, total: points - hit },
  };
}

function assertDecomposition(row) {
  for (const gw of row.gameweeks) {
    assert.equal(gw.points, gw.actual - gw.removedPoints + gw.captainPoints + gw.benchPoints + gw.liveAdjustment);
  }
  assert.equal(row.points, row.actualPoints - row.removedPoints + row.captainPoints + row.benchPoints + row.sourceAdjustment);
}

function snapshot() {
  const compact = JSON.parse(readFileSync(new URL("./fixtures/fpl-scoring-snapshot.json", import.meta.url)));
  const bootstrap = {
    teams: [{ id: compact.city, short_name: "MCI" }],
    events: compact.events.map(([id, finished, data_checked]) => ({ id, finished, data_checked })),
    elements: compact.players.map(([id, element_type, web_name]) => ({ id, element_type, web_name })),
  };
  const fixtures = compact.fixtures.map(([id, event, team_h, team_a, finished, finished_provisional]) => ({
    id, event, team_h, team_a, finished, finished_provisional,
  }));
  const gameweeks = bootstrap.events.map((event) => ({ event, live: {
    elements: compact.live[event.id].map(([id, total_points, fixturesForPlayer]) => ({
      id, stats: { total_points }, explain: fixturesForPlayer.map((args) => explanation(...args)),
    })),
  } }));
  const entries = Object.entries(compact.entries).map(([id, entry]) => ({
    bootstrap, fixtures, gameweeks,
    manager: { entry: Number(id), entry_name: `Team ${id}`, player_name: `Manager ${id}`, rank: entry.rank, total: entry.total },
    picksByEvent: Object.fromEntries(Object.entries(entry.weeks).map(([event, data]) => [event, {
      active_chip: data.chip,
      automatic_subs: data.subs.map(([element_in, element_out]) => ({ element_in, element_out })),
      entry_history: { event: Number(event), points: data.history[0], event_transfers_cost: data.history[1], event_transfers: data.history[2] },
      picks: data.picks.map(([element, position, multiplier, flags]) => ({
        element, position, multiplier, is_captain: (flags & 1) !== 0, is_vice_captain: (flags & 2) !== 0,
      })),
    }])),
  }));
  return { ...compact, bootstrap, fixtures, gameweeks, entries };
}

test("both real league snapshots reproduce independent full-rule totals and finalized original scores", () => {
  const data = snapshot();
  const contexts = new Map(data.gameweeks.map(({ event, live }) => [event.id,
    prepareGameweek(data.bootstrap, data.fixtures, live, event.id)]));
  const results = new Map();
  for (const args of data.entries) {
    const row = scoreEntry({ ...args, contexts });
    results.set(row.entry, row);
    assert.equal(row.points, data.expected[row.entry], `entry ${row.entry}`);
    assertDecomposition(row);
    assert.ok(row.warnings.every((warning) => warning.includes("GW6")));
  }
  for (const league of data.leagues) {
    assert.ok(league.members.every((entry) => results.has(entry)), `all members of league ${league.id}`);
  }
  assert.equal(results.get(1634056).gameweeks.slice(0, 5).reduce((n, gw) => n + gw.points, 0), 336);
  assert.equal(results.get(5499077).transferCost, 4);
});

test("double gameweek keeps retained fixture points and captain when they played there", () => {
  const row = scoreEntry(synthetic({ changes: { 9: [[2, 10, 90], [1, 4, 90]] } }));
  assert.equal(row.points, 28);
  assert.equal(row.removedPoints, 20);
  assert.equal(row.captainPoints, 0);
  assert.equal(row.gameweeks[0].effectiveCaptain, "P9");
  assert.deepEqual(row.gameweeks[0].subsIn, []);
  assertDecomposition(row);
});

test("captain transfers to vice-captain and bench follows order, not points", () => {
  const row = scoreEntry(synthetic({ changes: { 9: [[2, 10, 90]], 13: [[1, 1, 90]], 14: [[1, 15, 90]] } }));
  assert.equal(row.points, 23);
  assert.equal(row.captainPoints, 2);
  assert.deepEqual(row.gameweeks[0].subsIn, ["P13"]);
  assert.equal(row.gameweeks[0].effectiveCaptain, "P5");
  assertDecomposition(row);
});

test("triple captain multiplier transfers to an eligible vice-captain", () => {
  const row = scoreEntry(synthetic({ chip: "3xc", changes: { 9: [[2, 10, 90]], 5: [[1, 7, 90]] } }));
  assert.equal(row.points, 41);
  assert.equal(row.captainPoints, 14);
  assert.equal(row.removedPoints, 30);
  assertDecomposition(row);
});

test("neither captain eligible means no captain bonus, including triple captain", () => {
  const row = scoreEntry(synthetic({ chip: "3xc", changes: { 9: [[2, 10, 90]], 5: [[2, 7, 90]] } }));
  assert.equal(row.points, 22);
  assert.equal(row.captainPoints, 0);
  assert.equal(row.gameweeks[0].effectiveCaptain, null);
});

test("bench boost scores all retained players with no substitute duplication", () => {
  const row = scoreEntry(synthetic({ chip: "bboost", changes: { 9: [[2, 10, 90]], 13: [[2, 5, 90]] } }));
  assert.equal(row.points, 28);
  assert.equal(row.benchPoints, 0);
  assert.deepEqual(row.gameweeks[0].subsIn, []);
  assertDecomposition(row);
});

test("formation rules skip a higher-priority midfielder when three defenders are required", () => {
  const args = synthetic({ changes: { 2: [[2, 8, 90]], 13: [[1, 3, 90]], 15: [[1, 20, 90]] } });
  const picks = args.picksByEvent[1].picks;
  [picks[12].position, picks[14].position] = [picks[14].position, picks[12].position];
  const row = scoreEntry(args);
  assert.deepEqual(row.gameweeks[0].subsIn, ["P14"]);
  assert.equal(row.points, 24);
});

test("removing negative fixture points raises the score and remains in the decomposition", () => {
  const row = scoreEntry(synthetic({ changes: { 6: [[2, -3, 90]] } }));
  assert.equal(row.removedPoints, -3);
  assert.equal(row.points - row.actualPoints, 5);
  assertDecomposition(row);
});

test("original automatic substitutions are undone before selecting a fresh legal bench", () => {
  const row = scoreEntry(synthetic({
    changes: { 9: [[1, 0, 0]], 13: [[2, 6, 90]], 14: [[1, 7, 90]], 15: [[1, 8, 90]] },
    captain: 10, autoSubs: [[13, 9]],
  }));
  assert.deepEqual(row.gameweeks[0].subsIn, ["P14"]);
  assert.deepEqual(row.gameweeks[0].subsOut, ["P9"]);
  assert.equal(row.benchPoints, 7);
  assertDecomposition(row);
});

test("unplayed retained fixtures hold captaincy and lineup slots until resolved", () => {
  const args = synthetic({ final: false, changes: { 9: [[2, 10, 90], [3, 0, 0]] } });
  const row = scoreEntry(args);
  assert.equal(row.points, 20);
  assert.equal(row.gameweeks[0].effectiveCaptain, "P9");
  assert.deepEqual(row.gameweeks[0].pending, ["P9"]);
  assert.deepEqual(row.gameweeks[0].subsIn, []);
});

test("zero-minute red card still prevents an automatic substitution", () => {
  const row = scoreEntry(synthetic({ changes: { 6: [[1, -3, 0, 1]] } }));
  assert.equal(row.points, row.actualPoints);
  assert.deepEqual(row.gameweeks[0].subsIn, []);
});

test("zero-minute yellow card counts as playing under the FPL substitution rules", () => {
  const row = scoreEntry(synthetic({ changes: { 6: [[1, -1, 0, 0, 1]] } }));
  assert.equal(row.points, row.actualPoints);
  assert.deepEqual(row.gameweeks[0].subsIn, []);
});

test("a pending first substitute retains priority over a later bench player's points", () => {
  const row = scoreEntry(synthetic({ final: false, changes: { 6: [[2, 2, 90]], 13: [[3, 0, 0]], 14: [[1, 20, 90]] } }));
  assert.deepEqual(row.gameweeks[0].subsIn, ["P13"]);
  assert.deepEqual(row.gameweeks[0].pending, ["P13"]);
  assert.equal(row.points, 22);
});

test("goalkeepers can only be replaced by the bench goalkeeper", () => {
  const row = scoreEntry(synthetic({ changes: { 1: [[2, 5, 90]], 12: [[1, 7, 90]], 13: [[1, 15, 90]] } }));
  assert.deepEqual(row.gameweeks[0].subsIn, ["P12"]);
  assert.equal(row.points, 29);
});

test("ranking transfer count excludes wildcard and free-hit transfers", () => {
  for (const chip of ["wildcard", "freehit"]) {
    const args = synthetic({ chip });
    args.picksByEvent[1].entry_history.event_transfers = 12;
    assert.equal(scoreEntry(args).transfers, 0);
  }
});

test("City id is discovered dynamically and home/away fixtures are both removed", () => {
  const args = synthetic({ city: 88, changes: { 6: [[2, 5, 90]] } });
  [args.fixtures[1].team_h, args.fixtures[1].team_a] = [args.fixtures[1].team_a, args.fixtures[1].team_h];
  const context = prepareGameweek(args.bootstrap, args.fixtures, args.gameweeks[0].live, 1);
  assert.equal(context.removedTeamId, 88);
  assert.equal(scoreEntry({ ...args, contexts: { 1: context } }).removedPoints, 5);
});

test("unsupported chips and finalized discrepancies are errors; live discrepancies warn", () => {
  assert.throws(() => scoreEntry(synthetic({ chip: "manager" })), /chip is not supported/);
  const args = synthetic();
  args.picksByEvent[1].entry_history.points += 1;
  assert.throws(() => scoreEntry(args), ScoringError);
  args.bootstrap.events[0].finished = false;
  const row = scoreEntry(args);
  assert.ok(row.warnings.length > 0);
  assertDecomposition(row);
});

test("missing fixture-point data fails validation for a finalized gameweek", () => {
  const args = synthetic();
  args.gameweeks[0].live.elements[0].stats.total_points += 1;
  assert.throws(() => scoreEntry(args), /fixture points .* do not match/);
});

test("finalized league total mismatch fails, but live drift has an exact source adjustment", () => {
  const args = synthetic();
  args.manager.total += 5;
  assert.throws(() => scoreEntry(args), /finalized totals could not be reconciled/);
  args.bootstrap.events[0].finished = false;
  args.picksByEvent[1].entry_history.points += 2;
  const row = scoreEntry(args);
  assert.equal(row.sourceAdjustment, -5);
  assert.equal(row.liveAdjustment, -2);
  assert.equal(row.leagueTotalAdjustment, -3);
  assert.ok(row.warnings.some((warning) => warning.startsWith("Example:")));
  assertDecomposition(row);
});

test("late entrants skip early absent picks but missing picks after entry are errors", () => {
  const args = synthetic();
  const before = { event: { id: 0, finished: true }, live: { elements: [] } };
  args.gameweeks.unshift(before);
  assert.equal(scoreEntry({ ...args, leagueStartEvent: 0 }).points, 24);
  args.gameweeks.push({ event: { id: 2, finished: true }, live: { elements: [] } });
  assert.throws(() => scoreEntry(args), /missing after the entry started/);
});

test("league start event limits both alternative totals and transfer costs", () => {
  const data = snapshot();
  const args = data.entries.find((entry) => entry.manager.entry === 5499077);
  const row = scoreEntry({ ...args, leagueStartEvent: 5 });
  assert.equal(row.points, 64);
  assert.equal(row.transferCost, 0);
  assert.deepEqual(row.gameweeks.map((gw) => gw.event), [5, 6]);
});
