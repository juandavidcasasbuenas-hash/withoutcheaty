import type { LeagueResult } from './main.ts';

const KEY = 'withoutcheaty:saved-leagues:v1';
const MAX_AGE = 24 * 60 * 60 * 1000;
type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const numbers = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'number' && Number.isFinite(value[key]));

/** Stored browser data is untrusted; validate everything interpolated as HTML. */
export function reusableLeague(value: unknown, id: number, now = Date.now()): value is LeagueResult {
  if (!value || typeof value !== 'object') return false;
  const data = value as LeagueResult;
  const age = now - Date.parse(data.asOf);
  return data.league?.id === id && typeof data.league.name === 'string' && age >= 0 && age < MAX_AGE
    && numbers(data as unknown as Record<string, unknown>, ['gameweek', 'startEvent', 'removedFixtures', 'entries'])
    && typeof data.provisional === 'boolean' && strings(data.pendingFixtures) && strings(data.warnings)
    && Array.isArray(data.standings) && data.standings.every(row => row && typeof row.team === 'string' && typeof row.manager === 'string'
      && numbers(row as unknown as Record<string, unknown>, ['entry', 'actualRank', 'actualPoints', 'points', 'removedPoints', 'captainPoints', 'benchPoints', 'transferCost', 'transfers', 'rank', 'rankChange'])
      && (row.sourceAdjustment === undefined || Number.isFinite(row.sourceAdjustment))
      && Array.isArray(row.gameweeks) && row.gameweeks.every(gw => gw
        && numbers(gw as unknown as Record<string, unknown>, ['event', 'actual', 'points', 'removedPoints', 'captainPoints', 'benchPoints', 'transferCost'])
        && (gw.liveAdjustment === undefined || Number.isFinite(gw.liveAdjustment))
        && typeof gw.captain === 'string' && typeof gw.viceCaptain === 'string'
        && (gw.effectiveCaptain === null || typeof gw.effectiveCaptain === 'string')
        && (gw.chip === null || typeof gw.chip === 'string')
        && strings(gw.subsIn) && strings(gw.subsOut) && strings(gw.pending)));
}

export function readSavedLeague(id: number, storage?: StorageAccess, now = Date.now()): LeagueResult | null {
  try {
    storage ??= localStorage;
    const records: unknown = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(records) ? records.find(value => reusableLeague(value, id, now)) ?? null : null;
  } catch { return null; }
}

export function saveLeague(data: LeagueResult, storage?: StorageAccess, now = Date.now()) {
  if (data.freshness || !reusableLeague(data, data.league.id, now)) return;
  try {
    storage ??= localStorage;
    const stored: unknown = JSON.parse(storage.getItem(KEY) || '[]');
    const previous = Array.isArray(stored) ? stored.filter(value => value?.league?.id !== data.league.id && reusableLeague(value, value?.league?.id, now)) : [];
    storage.setItem(KEY, JSON.stringify([data, ...previous].slice(0, 3)));
  } catch { /* Storage may be disabled or full; fresh lookups still work. */ }
}
