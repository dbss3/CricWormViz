const GRID = document.getElementById('match-grid');

const ESPN_HEADER = 'https://site.web.api.espn.com/apis/v2/scoreboard/header'
  + '?sport=cricket&lang=en&region=gb&limit=200&showAirings=true';
const ESPN_PBP = 'https://site.web.api.espn.com/apis/site/v2/sports/cricket';

document.getElementById('refresh-btn').addEventListener('click', loadESPN);

/* ══ ESPN ════════════════════════════════════════════════════════════════ */

async function loadESPN() {
  GRID.innerHTML = '<div class="loading-msg">Fetching matches…</div>';
  try {
    const data = await get(ESPN_HEADER);
    const matches = [];
    for (const sport of data.sports ?? []) {
      for (const league of sport.leagues ?? []) {
        for (const evt of league.events ?? []) {
          if (!evt.id) continue;
          const comps = evt.competitors ?? [];
          const home  = comps.find(c => c.homeAway === 'home') ?? comps[0] ?? {};
          const away  = comps.find(c => c.homeAway === 'away') ?? comps[1] ?? {};
          const st    = evt.status?.type ?? {};
          matches.push({
            matchId:    `${league.id}_${evt.id}`,
            league:     league.name ?? '',
            homeTeam:   home.displayName ?? '',
            awayTeam:   away.displayName ?? '',
            homeScore:  home.score ?? '',
            awayScore:  away.score ?? '',
            status:     st.state ?? '',
            statusText: evt.status?.longSummary ?? st.shortDetail ?? '',
            isLive:     st.state === 'in',
            date:       evt.date ?? '',
          });
        }
      }
    }
    renderESPN(matches);
  } catch (err) {
    GRID.innerHTML = `
      <div class="error-msg">
        <strong>Could not reach ESPN.</strong><br><br>
        <small style="opacity:0.5">${esc(err.message)}</small>
      </div>`;
  }
}

function renderESPN(matches) {
  if (!matches.length) {
    GRID.innerHTML = '<div class="loading-msg">No cricket matches found.</div>';
    return;
  }
  GRID.innerHTML = '';
  const cardEls = matches.map(m => {
    const el = espnCard(m);
    GRID.appendChild(el);
    return { el, m };
  });
  checkPBPAsync(cardEls);
}

async function checkPBPAsync(cardEls) {
  await Promise.all(cardEls.map(async ({ el, m }) => {
    if (!m.matchId) return;
    const [lid, eid] = m.matchId.split('_');
    try {
      const r    = await fetch(`${ESPN_PBP}/${lid}/playbyplay?event=${eid}&page=1`);
      const data = await r.json();
      const count = data?.commentary?.count ?? 0;
      if (!count) el.remove();
    } catch { /* keep card if check fails */ }
  }));
}

function espnCard(m) {
  const isLive = m.isLive;
  const el     = document.createElement('div');
  el.className = 'match-card' + (isLive ? ' live' : '');

  const dateStr = m.date ? new Date(m.date).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short' }) : '';

  el.innerHTML = `
    ${m.league ? `<div class="card-league">${esc(m.league)}</div>` : ''}
    <div class="card-teams">
      ${isLive ? '<span class="live-dot"></span>' : ''}
      <div class="card-team-row">
        <span class="card-team-name">${esc(m.homeTeam)}</span>
        ${m.homeScore ? `<span class="card-team-score">${esc(m.homeScore)}</span>` : ''}
      </div>
      <div class="card-team-row">
        <span class="card-team-name">${esc(m.awayTeam)}</span>
        ${m.awayScore ? `<span class="card-team-score">${esc(m.awayScore)}</span>` : ''}
      </div>
    </div>
    <div class="card-footer-row">
      <span class="card-status">${esc(m.statusText || '')}</span>
      ${dateStr ? `<span class="card-date">${esc(dateStr)}</span>` : ''}
    </div>
    <button class="view-btn">View →</button>
  `;

  el.addEventListener('click', () => {
    location.href = `viz.html?matchId=${encodeURIComponent(m.matchId)}`;
  });
  return el;
}

/* ══ Helpers ═════════════════════════════════════════════════════════════ */

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ══ Start ═══════════════════════════════════════════════════════════════ */
loadESPN();
