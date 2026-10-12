/** Re-score the submitted FPL squads as though the excluded fixtures were blank. */
const SUPPORTED_CHIPS = new Set([null, undefined, "", "wildcard", "freehit", "bboost", "3xc"]);

export class ScoringError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScoringError";
  }
}

function requireNumber(value, description) {
  if (!Number.isFinite(value)) throw new ScoringError(`Missing or invalid ${description}.`);
  return value;
}

function cityId(bootstrap, provided) {
  if (provided != null) return provided;
  const city = bootstrap.teams?.find((team) => team.short_name === "MCI");
  if (!city) throw new ScoringError("Manchester City could not be identified in the FPL team data.");
  return city.id;
}

function eventIsFinal(event) {
  return event.finished === true && event.data_checked === true;
}

/**
 * Prepare once per gameweek, then share the result across every manager.
 * `full` and `excluded` are Maps keyed by player id, containing points,
 * played, pending and available. Pending fixtures retain their lineup slots.
 */
export function prepareGameweek(bootstrap, fixtures, live, eventId, removedTeamId) {
  const removed = cityId(bootstrap, removedTeamId);
  const event = bootstrap.events?.find((item) => item.id === eventId) ?? { id: eventId };
  const fixtureMap = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const removedFixtures = new Set(fixtures
    .filter((fixture) => fixture.team_h === removed || fixture.team_a === removed)
    .map((fixture) => fixture.id));
  const warnings = [];
  const full = new Map();
  const excluded = new Map();

  function statsFor(explanations) {
    let points = 0;
    let played = false;
    let pending = false;
    for (const explanation of explanations) {
      const fixture = fixtureMap.get(explanation.fixture);
      if (!fixture) throw new ScoringError(`GW${eventId}: fixture ${explanation.fixture} is missing.`);
      if (fixture.event !== eventId) {
        throw new ScoringError(`GW${eventId}: player data refers to a fixture in another gameweek.`);
      }
      // finished_provisional, unlike finished, becomes true at the final whistle.
      pending ||= fixture.finished_provisional !== true && fixture.finished !== true;
      for (const stat of explanation.stats ?? []) {
        points += requireNumber(stat.points, `fixture points in GW${eventId}`);
        // FPL counts an appearance OR receiving a yellow/red card as playing.
        played ||= ["minutes", "yellow_cards", "red_cards"].includes(stat.identifier) && stat.value > 0;
      }
    }
    return { points, played, pending, available: played || pending };
  }

  for (const player of live.elements ?? []) {
    const explanations = player.explain ?? [];
    const original = statsFor(explanations);
    const filtered = statsFor(explanations.filter((item) => !removedFixtures.has(item.fixture)));
    const reported = player.stats?.total_points;
    if (reported != null && original.points !== reported) {
      const message = `GW${eventId}: player ${player.id} fixture points (${original.points}) do not match the FPL total (${reported}).`;
      if (eventIsFinal(event)) throw new ScoringError(message);
      warnings.push(message);
    }
    full.set(player.id, original);
    excluded.set(player.id, filtered);
  }
  return { eventId, removedTeamId: removed, full, excluded, removedFixtures, warnings };
}

function combinations(items, count) {
  if (!count) return [[]];
  const result = [];
  function visit(start, selected) {
    if (selected.length === count) {
      result.push([...selected]);
      return;
    }
    for (let i = start; i <= items.length - (count - selected.length); i += 1) {
      selected.push(items[i]);
      visit(i + 1, selected);
      selected.pop();
    }
  }
  visit(0, []);
  return result;
}

function validFormation(ids, types) {
  const counts = [0, 0, 0, 0, 0];
  for (const id of ids) counts[types.get(id)] += 1;
  return ids.size === 11 && counts[1] === 1
    && counts[2] >= 3 && counts[2] <= 5
    && counts[3] >= 2 && counts[3] <= 5
    && counts[4] >= 1 && counts[4] <= 3;
}

function restoreSubmittedPicks(payload, players, label) {
  if (!Array.isArray(payload.picks) || payload.picks.length !== 15) {
    throw new ScoringError(`${label}: expected a complete 15-player squad.`);
  }
  const picks = payload.picks.map((pick) => ({
    ...pick,
    element_type: pick.element_type ?? players.get(pick.element)?.element_type,
  }));
  if (new Set(picks.map((pick) => pick.element)).size !== 15
    || new Set(picks.map((pick) => pick.position)).size !== 15
    || picks.some((pick) => ![1, 2, 3, 4].includes(pick.element_type)
      || !Number.isInteger(pick.position) || pick.position < 1 || pick.position > 15)) {
    throw new ScoringError(`${label}: invalid player positions or duplicate picks.`);
  }
  const byId = new Map(picks.map((pick) => [pick.element, pick]));
  for (const substitution of payload.automatic_subs ?? []) {
    const incoming = byId.get(substitution.element_in);
    const outgoing = byId.get(substitution.element_out);
    if (!incoming || !outgoing) throw new ScoringError(`${label}: invalid original automatic substitution.`);
    [incoming.position, outgoing.position] = [outgoing.position, incoming.position];
  }
  picks.sort((a, b) => a.position - b.position);
  const types = new Map(picks.map((pick) => [pick.element, pick.element_type]));
  if (!validFormation(new Set(picks.slice(0, 11).map((pick) => pick.element)), types)) {
    throw new ScoringError(`${label}: the restored starting formation is invalid.`);
  }
  if (picks.filter((pick) => pick.is_captain).length !== 1
    || picks.filter((pick) => pick.is_vice_captain).length !== 1) {
    throw new ScoringError(`${label}: expected one captain and one vice-captain.`);
  }
  return picks;
}

function scoringLineup(picks, stats, chip) {
  const starters = picks.slice(0, 11).map((pick) => pick.element);
  if (chip === "bboost") return { selected: new Set(picks.map((pick) => pick.element)), ins: [], outs: [] };
  const starting = new Set(starters);
  const absent = starters.filter((id) => !stats.get(id).available);
  const bench = picks.slice(11).map((pick) => pick.element);
  const eligibleBench = bench.filter((id) => stats.get(id).available);
  const types = new Map(picks.map((pick) => [pick.element, pick.element_type]));
  // Enumerate legal sets, filling as many vacancies as possible and respecting
  // bench order. Score is deliberately never used to choose a substitute.
  for (let count = Math.min(absent.length, eligibleBench.length); count >= 0; count -= 1) {
    for (const ins of combinations(eligibleBench, count)) {
      for (const outs of combinations(absent, count)) {
        const selected = new Set([...starting].filter((id) => !outs.includes(id)).concat(ins));
        if (validFormation(selected, types)) return { selected, ins, outs };
      }
    }
  }
  throw new ScoringError("No valid automatic-substitution formation could be found.");
}

function captainFor(picks, stats) {
  const captain = picks.find((pick) => pick.is_captain).element;
  const viceCaptain = picks.find((pick) => pick.is_vice_captain).element;
  const effectiveCaptain = stats.get(captain).available ? captain
    : stats.get(viceCaptain).available ? viceCaptain : null;
  return { captain, viceCaptain, effectiveCaptain };
}

function totalFor(selected, stats, effectiveCaptain, chip) {
  let points = 0;
  for (const id of selected) points += stats.get(id).points;
  if (selected.has(effectiveCaptain)) {
    points += stats.get(effectiveCaptain).points * (chip === "3xc" ? 2 : 1);
  }
  return points;
}

/**
 * `manager` is a classic-league standings result; `picksByEvent` is keyed by GW.
 * `gameweeks` contains {event: bootstrap event, live: FPL live payload} objects.
 * Optional `contexts` is a Map or GW-keyed object of prepareGameweek results.
 * All returned scores are net of transfer hits, including per-gameweek actual.
 */
export function scoreEntry({ bootstrap, fixtures, gameweeks, manager, picksByEvent,
  leagueStartEvent = 1, contexts, removedTeamId }) {
  const players = new Map(bootstrap.elements.map((player) => [player.id, player]));
  const name = (id) => id == null ? null : players.get(id)?.web_name ?? `Player ${id}`;
  const warnings = [];
  const scores = [];
  const teamLabel = manager.entry_name || `Entry ${manager.entry}`;
  let started = false;
  let hasProvisionalGameweek = false;
  for (const { event, live } of [...gameweeks].sort((a, b) => a.event.id - b.event.id)) {
    if (event.id < leagueStartEvent) continue;
    const payload = picksByEvent instanceof Map ? picksByEvent.get(event.id) : picksByEvent[event.id];
    if (!payload) {
      if (started) throw new ScoringError(`${teamLabel}: picks for GW${event.id} are missing after the entry started.`);
      continue;
    }
    started = true;
    const label = `${teamLabel}, GW${event.id}`;
    hasProvisionalGameweek ||= !eventIsFinal(event);
    if (!SUPPORTED_CHIPS.has(payload.active_chip)) {
      throw new ScoringError(`${label}: the '${payload.active_chip}' chip is not supported; this score cannot be calculated reliably.`);
    }
    const context = (contexts instanceof Map ? contexts.get(event.id) : contexts?.[event.id])
      ?? prepareGameweek(bootstrap, fixtures, live, event.id, removedTeamId);
    if (context.eventId !== event.id || context.removedTeamId !== cityId(bootstrap, removedTeamId)) {
      throw new ScoringError(`${label}: the shared scoring context does not match this gameweek or excluded team.`);
    }
    warnings.push(...context.warnings);
    const picks = restoreSubmittedPicks(payload, players, label);
    for (const pick of picks) {
      if (!context.full.has(pick.element) || !context.excluded.has(pick.element)) {
        throw new ScoringError(`${label}: live points for player ${pick.element} are missing.`);
      }
    }
    const chip = payload.active_chip || null;
    const history = payload.entry_history;
    const transferCost = requireNumber(history?.event_transfers_cost, `${label} transfer cost`);
    const actualGross = requireNumber(history?.points, `${label} official points`);
    const fullLineup = scoringLineup(picks, context.full, chip);
    const fullCaptain = captainFor(picks, context.full);
    const baseline = totalFor(fullLineup.selected, context.full, fullCaptain.effectiveCaptain, chip);
    if (baseline !== actualGross) {
      const message = `${label}: recalculated original score ${baseline} differs from FPL's ${actualGross}${eventIsFinal(event) ? "." : "; live substitutions or points may still be processing."}`;
      if (eventIsFinal(event)) throw new ScoringError(message);
      warnings.push(message);
    }
    const lineup = scoringLineup(picks, context.excluded, chip);
    const captain = captainFor(picks, context.excluded);
    const gross = totalFor(lineup.selected, context.excluded, captain.effectiveCaptain, chip);
    let removedPoints = 0;
    let strippedGross = 0;
    let originalMultiplierGross = 0;
    const existingScorers = new Set();
    for (const pick of payload.picks) {
      const multiplier = requireNumber(pick.multiplier, `${label} player multiplier`);
      if (multiplier > 0) existingScorers.add(pick.element);
      const original = context.full.get(pick.element).points;
      const filtered = context.excluded.get(pick.element).points;
      removedPoints += multiplier * (original - filtered);
      strippedGross += multiplier * filtered;
      originalMultiplierGross += multiplier * original;
    }
    if (originalMultiplierGross !== actualGross) {
      const message = `${label}: published lineup points (${originalMultiplierGross}) differ from the official gameweek score (${actualGross}).`;
      if (eventIsFinal(event)) throw new ScoringError(message);
      warnings.push(message);
    }
    const fixedGross = totalFor(existingScorers, context.excluded, captain.effectiveCaptain, chip);
    scores.push({
      event: event.id,
      actual: actualGross - transferCost,
      points: gross - transferCost,
      removedPoints,
      captainPoints: fixedGross - strippedGross,
      benchPoints: gross - fixedGross,
      // Usually zero; exposed so live source updates cannot masquerade as subs.
      liveAdjustment: originalMultiplierGross - actualGross,
      transferCost,
      // FPL's classic-league tiebreak excludes wildcard and free-hit transfers.
      transfers: ["wildcard", "freehit"].includes(chip) ? 0
        : requireNumber(history.event_transfers, `${label} transfer count`),
      captain: name(captain.captain),
      viceCaptain: name(captain.viceCaptain),
      effectiveCaptain: name(captain.effectiveCaptain),
      subsIn: lineup.ins.map(name),
      subsOut: lineup.outs.map(name),
      pending: picks.filter((pick) => lineup.selected.has(pick.element)
        && context.excluded.get(pick.element).pending).map((pick) => name(pick.element)),
      chip,
    });
  }
  if (!scores.length) throw new ScoringError(`${teamLabel}: no gameweek picks were available in this league's scoring period.`);
  const sum = (field) => scores.reduce((total, score) => total + score[field], 0);
  const actualPoints = requireNumber(manager.total, `official total for entry ${manager.entry}`);
  const leagueTotalAdjustment = sum("actual") - actualPoints;
  if (leagueTotalAdjustment !== 0) {
    const message = `${teamLabel}: gameweek totals (${sum("actual")}) differ from the published league total (${actualPoints})${hasProvisionalGameweek ? "; league totals may still be updating." : "; the finalized totals could not be reconciled."}`;
    if (!hasProvisionalGameweek) throw new ScoringError(message);
    warnings.push(message);
  }
  return {
    entry: manager.entry,
    team: manager.entry_name,
    manager: manager.player_name,
    actualRank: manager.rank,
    actualPoints,
    points: sum("points"),
    removedPoints: sum("removedPoints"),
    captainPoints: sum("captainPoints"),
    benchPoints: sum("benchPoints"),
    liveAdjustment: sum("liveAdjustment"),
    leagueTotalAdjustment,
    // Keeps the public-total decomposition exact while live feeds synchronize.
    sourceAdjustment: sum("liveAdjustment") + leagueTotalAdjustment,
    transferCost: sum("transferCost"),
    transfers: sum("transfers"),
    gameweeks: scores,
    warnings: [...new Set(warnings)],
  };
}
