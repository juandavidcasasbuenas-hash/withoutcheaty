import { getCache } from '@vercel/functions';
import { FplCache } from './fpl-client.js';

export const FRESH_MS = 30_000;
export const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;

export function usableSnapshot(data, leagueId, now = Date.now()) {
  const age = now - Date.parse(data?.asOf);
  return data?.league?.id === leagueId && Array.isArray(data.standings)
    && !data.freshness && age >= 0 && age < MAX_SNAPSHOT_AGE_MS;
}

/** Cache whole, reconciled tables. Never combine stale inputs with fresh scores. */
export class LeagueSnapshots {
  constructor({ remote = null, now = Date.now, operationTimeoutMs = 1_000 } = {}) {
    this.remote = remote;
    this.now = now;
    this.operationTimeoutMs = operationTimeoutMs;
    this.local = new FplCache({ maxEntries: 100, maxBytes: 24 * 1024 * 1024, now });
  }
  async remoteOperation(operation) {
    if (!this.remote) return undefined;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cache timeout')), this.operationTimeoutMs); }),
      ]);
    } catch {
      console.warn('League snapshot cache unavailable; continuing without it');
      return undefined;
    } finally { clearTimeout(timer); }
  }
  async get(id) {
    const local = this.local.get(String(id));
    if (usableSnapshot(local, id, this.now()) && this.now() - Date.parse(local.asOf) < FRESH_MS) return local;
    const stored = await this.remoteOperation(() => this.remote.get(String(id)));
    if (!usableSnapshot(stored, id, this.now()) || (usableSnapshot(local, id, this.now()) && Date.parse(local.asOf) > Date.parse(stored.asOf))) {
      return usableSnapshot(local, id, this.now()) ? local : undefined;
    }
    this.local.set(String(id), stored, MAX_SNAPSHOT_AGE_MS - (this.now() - Date.parse(stored.asOf)), JSON.stringify(stored).length * 3);
    return stored;
  }
  async set(id, data) {
    if (!usableSnapshot(data, id, this.now())) return;
    const json = JSON.stringify(data);
    const remainingMs = MAX_SNAPSHOT_AGE_MS - (this.now() - Date.parse(data.asOf));
    this.local.set(String(id), data, remainingMs, json.length * 3);
    // Runtime Cache has a 2 MB item limit. Oversized tables still work normally.
    if (Buffer.byteLength(json) < 1_900_000) {
      await this.remoteOperation(() => this.remote.set(String(id), data, { ttl: Math.max(1, Math.floor(remainingMs / 1_000)), name: 'league-result' }));
    }
  }
}

export const leagueSnapshots = new LeagueSnapshots({
  remote: process.env.VERCEL === '1' ? getCache({ namespace: 'withoutcheaty:league-results:v1' }) : null,
});
