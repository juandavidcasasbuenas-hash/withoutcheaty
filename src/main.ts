import './style.css';

type Gameweek = { event: number; actual: number; points: number; removedPoints: number; captainPoints: number; benchPoints: number; liveAdjustment?: number; transferCost: number; captain: string; viceCaptain: string; effectiveCaptain: string | null; subsIn: string[]; subsOut: string[]; pending: string[]; chip: string | null };
type Row = { entry: number; team: string; manager: string; actualRank: number; actualPoints: number; points: number; removedPoints: number; captainPoints: number; benchPoints: number; sourceAdjustment?: number; transferCost: number; transfers: number; rank: number; rankChange: number; gameweeks: Gameweek[] };
type LeagueResult = { league: { id: number; name: string }; asOf: string; gameweek: number; startEvent: number; provisional: boolean; removedFixtures: number; entries: number; pendingFixtures: string[]; standings: Row[]; warnings: string[] };
type StreamMessage = { type: 'progress'; message: string; completed?: number; total?: number } | { type: 'result'; data: LeagueResult } | { type: 'error'; message: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $('league-form') as HTMLFormElement;
const input = $('league-id') as HTMLInputElement;
const submit = $('submit-button') as HTMLButtonElement;
let result: LeagueResult | null = null;
let currentRequest: AbortController | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let loadedId = '';

function escape(value: unknown): string { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!)); }
function signed(value: number): string { return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '—'; }
function toast(message: string) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2600); }
function setLoading(loading: boolean) { $('loading').hidden = !loading; submit.disabled = loading; ($('refresh-button') as HTMLButtonElement).disabled = loading; submit.innerHTML = loading ? 'Calculating…' : 'Reveal the table <span aria-hidden="true">↗</span>'; }
function setInputError(message: string) { $('input-error').textContent = message; $('input-error').hidden = !message; input.setAttribute('aria-invalid', String(Boolean(message))); }

async function loadLeague(id: string, updateUrl = true) {
  if (!/^[1-9]\d{0,8}$/.test(id)) { setInputError('Enter a numeric league ID, such as 309341.'); input.focus(); return; }
  currentRequest?.abort();
  const request = new AbortController();
  currentRequest = request;
  setInputError('');
  $('request-error').hidden = true;
  $('loading-message').textContent = 'Finding your league…';
  $('loading-detail').textContent = 'We’re checking each gameweek, captain and substitute.';
  setLoading(true);
  // Do not leave a previous league on screen under a new league number.
  if (loadedId !== id) { $('results').hidden = true; result = null; }
  let receivedResult = false;
  const timeout = setTimeout(() => request.abort(new Error('This league took too long to calculate. Please try again.')), 260_000);
  try {
    const response = await fetch(`/api/league?id=${encodeURIComponent(id)}`, { signal: request.signal });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.message || payload?.error || 'The league could not be loaded. Please try again.');
    }
    if (!response.body) throw new Error('Your browser could not read the live calculation. Please try again.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = (line: string) => {
      if (!line.trim()) return;
      const message = JSON.parse(line) as StreamMessage;
      if (message.type === 'error') throw new Error(message.message);
      if (message.type === 'progress') {
        $('loading-message').textContent = message.message;
        $('loading-detail').textContent = message.total ? `${message.completed ?? 0} of ${message.total} checked. Every captain and substitute counts.` : 'Large leagues can take a little longer. We’ll keep you posted.';
      } else if (message.type === 'result') {
        result = message.data;
        loadedId = id;
        receivedResult = true;
        renderResult(result);
        if (updateUrl) { const url = new URL(location.href); url.searchParams.set('league', id); history.replaceState({}, '', url); }
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop() || '';
      for (const line of lines) consume(line);
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!receivedResult) throw new Error('The calculation was interrupted. Please try again.');
  } catch (error) {
    if (currentRequest !== request) return;
    if (request.signal.aborted && !(request.signal.reason instanceof Error && request.signal.reason.name !== 'AbortError')) return;
    $('request-error').textContent = error instanceof Error ? error.message : 'Something went wrong. Please try again.';
    $('request-error').hidden = false;
  } finally {
    clearTimeout(timeout);
    if (currentRequest === request) { currentRequest = null; setLoading(false); }
  }
}

function renderResult(data: LeagueResult) {
  document.body.classList.add('has-results');
  $('results').hidden = false;
  $('league-title').textContent = data.league.name;
  $('results-kicker').textContent = `LEAGUE ${data.league.id} / THE TABLE, RECONSIDERED`;
  const eventLabel = data.gameweek ? `GW ${data.startEvent}–${data.gameweek}` : 'Season not started';
  $('results-scope').textContent = `${eventLabel} · ${data.entries} ${data.entries === 1 ? 'manager' : 'managers'} · ${data.removedFixtures} City ${data.removedFixtures === 1 ? 'fixture' : 'fixtures'} removed`;
  const asOf = new Date(data.asOf);
  $('results-updated').textContent = `Checked ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short', timeZone: 'Europe/London' }).format(asOf)}`;
  $('provisional-note').hidden = !data.provisional;
  $('provisional-note').textContent = `PROVISIONAL · Gameweek ${data.gameweek} is not final. Includes projected automatic substitutions.${data.pendingFixtures.length ? ` Still to finish: ${data.pendingFixtures.join(', ')}.` : ' Final points and FPL corrections can still change the result.'}`;
  const leader = data.standings[0];
  const riser = [...data.standings].sort((a, b) => b.rankChange - a.rankChange)[0];
  const ties = data.standings.filter(r => r.rank === 1);
  $('result-story').innerHTML = !leader ? 'There are no scored teams in this league yet.' : ties.length > 1 ? `<strong>${ties.length} teams share first place</strong> on ${leader.points} points.` : `<strong>${escape(leader.team)}</strong> ${leader.actualRank === 1 ? 'keeps' : 'takes'} the lead on <strong>${leader.points}</strong> points.${riser && riser.rankChange > 0 ? ` ${escape(riser.team)} climbs ${riser.rankChange} ${riser.rankChange === 1 ? 'place' : 'places'}.` : ' The points tell a different story.'}`;
  $('standings-body').innerHTML = data.standings.map(row => `<tr class="${row.rank === 1 ? 'leader' : ''}"><td class="rank-cell">${row.rank}</td><td><button class="team-button" type="button" data-entry="${row.entry}" aria-expanded="false" aria-controls="breakdown-${row.entry}"><span><span class="team-name">${escape(row.team)}</span><span class="manager-name">${escape(row.manager)}</span></span><span class="team-chevron" aria-hidden="true">⌄</span></button></td><td class="number actual-cell">${row.actualPoints}</td><td class="number alternative-cell">${row.points}</td><td class="number change-cell">${signed(row.points - row.actualPoints)}</td><td class="movement-cell ${row.rankChange > 0 ? 'up' : row.rankChange < 0 ? 'down' : 'unchanged'}"><span aria-label="${row.rankChange > 0 ? `Up ${row.rankChange}` : row.rankChange < 0 ? `Down ${-row.rankChange}` : 'Unchanged'}">${row.rankChange > 0 ? `↑ ${row.rankChange}` : row.rankChange < 0 ? `↓ ${-row.rankChange}` : '—'}</span></td></tr><tr class="breakdown-row" id="breakdown-${row.entry}" hidden><td colspan="6">${renderBreakdown(row)}</td></tr>`).join('');
  const source = $('source-link') as HTMLAnchorElement;
  source.href = `https://fantasy.premierleague.com/api/leagues-classic/${data.league.id}/standings/`;
  $('result-warnings').hidden = !data.warnings?.length;
  $('result-warnings').innerHTML = data.warnings?.length ? `<details><summary>Notes on live points (${data.warnings.length}) <span aria-hidden="true">+</span></summary>${data.warnings.map(w => `<p>${escape(w)}</p>`).join('')}</details>` : '';
  document.title = `${data.league.name} — withoutcheaty`;
}

function renderBreakdown(row: Row): string {
  const chips: Record<string, string> = { bboost: 'Bench Boost', '3xc': 'Triple Captain', wildcard: 'Wildcard', freehit: 'Free Hit' };
  const math = (n: number) => `${n < 0 ? '−' : '+'} ${Math.abs(n)}`;
  const drift = row.gameweeks.some(gw => gw.liveAdjustment);
  return `<div class="breakdown"><div class="breakdown-top"><h3>${escape(row.team)} · the working</h3><p>${row.actualPoints} ${math(-row.removedPoints)} removed ${math(row.captainPoints)} captaincy ${math(row.benchPoints)} bench${row.sourceAdjustment ? ` ${math(row.sourceAdjustment)} live correction` : ''} = <strong>${row.points}</strong></p></div><div class="breakdown-scroll"><table class="breakdown-table"><thead><tr><th scope="col">GW</th><th scope="col" class="number">FPL</th><th scope="col" class="number">Removed</th><th scope="col" class="number">Captaincy</th><th scope="col" class="number">Bench</th>${drift ? '<th scope="col" class="number">Live correction</th>' : ''}<th scope="col" class="number">New total</th><th scope="col">On the teamsheet</th></tr></thead><tbody>${row.gameweeks.map(gw => `<tr><td>${gw.event}${gw.chip ? `<br><span class="text-small">${escape(chips[gw.chip] || gw.chip)}</span>` : ''}</td><td class="number">${gw.actual}</td><td class="number">${signed(-gw.removedPoints)}</td><td class="number">${signed(gw.captainPoints)}</td><td class="number">${signed(gw.benchPoints)}</td>${drift ? `<td class="number">${signed(gw.liveAdjustment || 0)}</td>` : ''}<td class="number"><strong>${gw.points}</strong></td><td class="detail-cell"><p><strong>Captain:</strong> ${escape(gw.effectiveCaptain || 'No eligible captain')}${gw.effectiveCaptain !== gw.captain ? ` (was ${escape(gw.captain)})` : ''}</p>${gw.subsIn.length ? `<p><strong>In:</strong> ${gw.subsIn.map(escape).join(', ')}</p>` : ''}${gw.subsOut.length ? `<p><strong>Out:</strong> ${gw.subsOut.map(escape).join(', ')}</p>` : ''}${gw.pending.length ? `<p><strong>Awaiting fixture:</strong> ${gw.pending.map(escape).join(', ')}</p>` : ''}${gw.transferCost ? `<p>−${gw.transferCost} transfer hit retained</p>` : ''}</td></tr>`).join('')}</tbody></table></div><p class="breakdown-note">Transfer hits are included in both totals. “Bench” is the net change from recalculating substitutions; “captaincy” is the extra captain bonus after removing the fixture points. Negative match points are removed too.${row.sourceAdjustment || drift ? ' Live corrections reconcile FPL’s player, gameweek and league totals while updates are processing.' : ''}</p></div>`;
}

form.addEventListener('submit', event => { event.preventDefault(); void loadLeague(input.value.trim()); });
input.addEventListener('input', () => { if (!$('input-error').hidden) setInputError(''); });
$('try-example').addEventListener('click', () => { input.value = '309341'; void loadLeague('309341'); });
$('refresh-button').addEventListener('click', () => { if (loadedId) void loadLeague(loadedId); });
$('cancel-button').addEventListener('click', () => { currentRequest?.abort(); toast('Calculation cancelled.'); });
$('standings-body').addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-entry]');
  if (!button) return;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  $(`breakdown-${button.dataset.entry}`).hidden = !open;
});
$('share-button').addEventListener('click', async () => {
  if (!result) return;
  const url = new URL(location.origin); url.searchParams.set('league', String(result.league.id));
  try { await navigator.clipboard.writeText(url.href); toast('League link copied.'); } catch { toast('Copy the league link from your address bar.'); }
});
$('download-button').addEventListener('click', () => {
  if (!result) return;
  const cell = (value: unknown) => { const raw = String(value); const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; };
  const rows: unknown[][] = [['Alternative rank', 'Team', 'Manager', 'Actual rank', 'FPL points', 'Without City', 'Points change', 'Position change', 'Removed fixture points', 'Captaincy adjustment', 'Bench adjustment', 'Live correction', 'Transfer hits', 'As of', 'Provisional']];
  for (const row of result.standings) rows.push([row.rank, row.team, row.manager, row.actualRank, row.actualPoints, row.points, row.points - row.actualPoints, row.rankChange, row.removedPoints, row.captainPoints, row.benchPoints, row.sourceAdjustment || 0, row.transferCost, result.asOf, result.provisional]);
  const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a'); link.href = url; link.download = `withoutcheaty-${result.league.id}.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
const initial = new URLSearchParams(location.search).get('league');
if (initial) { input.value = initial; void loadLeague(initial, false); }
window.addEventListener('pagehide', () => currentRequest?.abort());
