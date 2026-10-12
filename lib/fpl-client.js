const ORIGIN = 'https://fantasy.premierleague.com';
const ACTIVE_TTL = 30_000;
const COMPLETE_TTL = 6 * 60 * 60 * 1_000;

export class FplError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'FplError';
    this.status = status;
  }
}

export function parseLeagueId(value) {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value) || Number(value) < 1) {
    throw new FplError('Enter a numeric FPL league ID containing 1–9 digits.', 400);
  }
  return Number(value);
}

/** Bounded opportunistic cache: correctness never depends on a warm process. */
export class FplCache {
  constructor({ maxEntries = 2_500, maxBytes = 48 * 1024 * 1024, now = Date.now } = {}) {
    this.entries = new Map();
    this.bytes = 0;
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.now = now;
  }
  get(key) {
    const item = this.entries.get(key);
    if (!item) return undefined;
    this.entries.delete(key);
    if (item.expires <= this.now()) {
      this.bytes -= item.size;
      return undefined;
    }
    this.entries.set(key, item);
    return item.value;
  }
  set(key, value, ttl, size) {
    const previous = this.entries.get(key);
    if (previous) this.bytes -= previous.size;
    this.entries.delete(key);
    if (size > this.maxBytes || ttl <= 0) return;
    this.entries.set(key, { value, expires: this.now() + ttl, size });
    this.bytes += size;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      this.bytes -= this.entries.get(oldest).size;
      this.entries.delete(oldest);
    }
  }
}

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }
  async acquire(signal) {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      waiter.abort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(signal.reason);
      };
      signal?.addEventListener('abort', waiter.abort, { once: true });
      this.queue.push(waiter);
    });
    return () => this.release();
  }
  release() {
    const next = this.queue.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.abort);
      next.resolve();
    } else {
      this.active--;
    }
  }
}

const upstreamSlots = new Semaphore(7);
const upstreamCache = new FplCache();

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 999_999_999) {
    throw new FplError(`Invalid ${label}.`, 400);
  }
  return value;
}

async function delay(milliseconds, signal) {
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class FplClient {
  constructor({ fetchImpl = globalThis.fetch, cache = upstreamCache, timeoutMs = 20_000, sleep = delay } = {}) {
    this.fetchImpl = fetchImpl;
    this.cache = cache;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  async get(path, { signal, ttl = ACTIVE_TTL } = {}) {
    // Paths are constructed exclusively by the typed endpoint methods below.
    if (!/^\/api\/[a-z0-9_/?=&-]+$/.test(path) || path.includes('//')) {
      throw new FplError('Invalid FPL API endpoint.', 400);
    }
    signal?.throwIfAborted();
    const cached = this.cache?.get(path);
    if (cached !== undefined) return cached;
    for (let attempt = 0; attempt < 3; attempt++) {
      const release = await upstreamSlots.acquire(signal);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new FplError('The FPL API took too long to respond. Please try again.', 504)), this.timeoutMs);
      let retryAfter = null;
      try {
        const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
        const response = await this.fetchImpl(`${ORIGIN}${path}`, {
          headers: { Accept: 'application/json', 'User-Agent': 'WithoutCheaty/1.0 (public FPL mini-league analysis)' },
          signal: combined,
          redirect: 'error',
        });
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const header = response.headers.get('retry-after');
          const seconds = Number(header);
          const advised = header && Number.isFinite(seconds) ? seconds * 1_000 : 500 * 2 ** attempt;
          retryAfter = Math.min(3_000, Math.max(250, advised));
          await response.body?.cancel();
        } else if (!response.ok) {
          console.warn('FPL upstream request failed', { path, status: response.status, contentType: response.headers.get('content-type') });
          await response.body?.cancel();
          if (response.status === 404) throw new FplError('This FPL resource was not found.', 404);
          if (response.status === 401 || response.status === 403) {
            throw new FplError('The FPL API is not allowing access right now. Please try again later.', 503);
          }
          throw new FplError(response.status === 429
            ? 'The FPL API is busy. Please wait a moment and try again.'
            : `The FPL API returned an error (${response.status}). Please try again.`, 502);
        } else {
          const body = await response.text();
          let result;
          try { result = JSON.parse(body); } catch {
            throw new FplError('The FPL API returned an unreadable response. Please try again.');
          }
          this.cache?.set(path, result, ttl, body.length * 3);
          return result;
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (timeout.signal.aborted) throw timeout.signal.reason;
        if (error instanceof FplError) throw error;
        throw new FplError('Could not reach the FPL API. Please try again.');
      } finally {
        clearTimeout(timer);
        release();
      }
      if (retryAfter !== null) await this.sleep(retryAfter, signal);
    }
    throw new FplError('The FPL API is temporarily unavailable.');
  }

  bootstrap(signal) { return this.get('/api/bootstrap-static/', { signal }); }
  fixtures(signal) { return this.get('/api/fixtures/', { signal }); }
  standings(id, page, signal, newPage = 1) {
    return this.get(`/api/leagues-classic/${integer(id, 'league ID')}/standings/?page_standings=${integer(page, 'page')}&page_new_entries=${integer(newPage, 'page')}`, { signal });
  }
  headToHead(id, signal) {
    return this.get(`/api/leagues-h2h/${integer(id, 'league ID')}/standings/`, { signal });
  }
  live(event, completed, signal) {
    return this.get(`/api/event/${integer(event, 'gameweek')}/live/`, { signal, ttl: completed ? COMPLETE_TTL : ACTIVE_TTL });
  }
  picks(entry, event, completed, signal) {
    return this.get(`/api/entry/${integer(entry, 'entry ID')}/event/${integer(event, 'gameweek')}/picks/`, { signal, ttl: completed ? COMPLETE_TTL : ACTIVE_TTL });
  }
}

export async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}
