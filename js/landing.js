const GRID         = document.getElementById('match-grid');
const CLICKET_GRID = document.getElementById('clicket-grid');

document.getElementById('refresh-btn').addEventListener('click', loadESPN);

/* ══ Source picker ═══════════════════════════════════════════════════════ */

let espnLoaded    = false;
let clicketLoaded = false;

window.showSource = function(src) {
  document.getElementById('espn-section').classList.toggle('hidden', src !== 'espn');
  document.getElementById('clicket-section').classList.toggle('hidden', src !== 'clicket');
  document.getElementById('btn-espn').classList.toggle('active', src === 'espn');
  document.getElementById('btn-clicket').classList.toggle('active', src === 'clicket');

  if (src === 'espn' && !espnLoaded)    loadESPN();
  if (src === 'clicket' && !clicketLoaded) loadClicket();
};

/* ══ ESPN ════════════════════════════════════════════════════════════════ */

async function loadESPN() {
  espnLoaded = false;
  GRID.innerHTML = '<div class="loading-msg">Fetching matches…</div>';
  try {
    const matches = await get('/espn/live');
    renderESPN(matches);
    espnLoaded = true;
  } catch (err) {
    GRID.innerHTML = `
      <div class="error-msg">
        <strong>Could not reach ESPN.</strong><br><br>
        Make sure the server is running:<br>
        <code>python3 server.py</code><br><br>
        <small style="opacity:0.5">${esc(err.message)}</small>
      </div>`;
  }
}

function renderESPN(matches) {
  if (!matches.length) {
    GRID.innerHTML = '<div class="loading-msg">No cricket matches found in the last 7 days.</div>';
    return;
  }
  GRID.innerHTML = '';
  const cardEls = matches.map(m => {
    const el = espnCard(m);
    GRID.appendChild(el);
    return { el, m };
  });
  /* Fire async PBP checks — update each card when the result arrives */
  checkPBPAsync(cardEls);
}

async function checkPBPAsync(cardEls) {
  await Promise.all(cardEls.map(async ({ el, m }) => {
    if (!m.matchId) return;
    const [lid, eid] = m.matchId.split('_');
    try {
      const { hasPBP } = await get(`/espn/check-pbp/${lid}/${eid}`);
      if (!hasPBP) el.remove();
    } catch { /* silent — keep the card if check fails */ }
  }));
}

function espnCard(m) {
  const isLive = m.isLive || m.status === 'in';
  const el     = document.createElement('div');
  el.className = 'match-card' + (isLive ? ' live' : '');

  const dateStr = m.date ? new Date(m.date).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short' }) : '';

  const homeScore = m.homeScore || '';
  const awayScore = m.awayScore || '';
  const hasScore  = homeScore || awayScore;

  el.innerHTML = `
    ${m.league ? `<div class="card-league">${esc(m.league)}</div>` : ''}
    <div class="card-teams">
      ${isLive ? '<span class="live-dot"></span>' : ''}
      <div class="card-team-row">
        <span class="card-team-name">${esc(m.homeTeam)}</span>
        ${homeScore ? `<span class="card-team-score">${esc(homeScore)}</span>` : ''}
      </div>
      <div class="card-team-row">
        <span class="card-team-name">${esc(m.awayTeam)}</span>
        ${awayScore ? `<span class="card-team-score">${esc(awayScore)}</span>` : ''}
      </div>
    </div>
    <div class="card-footer-row">
      <span class="card-status">${esc(m.statusText || '')}</span>
      ${dateStr ? `<span class="card-date">${esc(dateStr)}</span>` : ''}
    </div>
    ${m.matchId ? `<button class="view-btn">View →</button>` : ''}
  `;

  if (m.matchId) {
    el.addEventListener('click', () => {
      location.href = `viz.html?matchId=${encodeURIComponent(m.matchId)}`;
    });
  }
  return el;
}

/* ══ Clicket ═════════════════════════════════════════════════════════════ */

async function loadClicket() {
  clicketLoaded = false;
  CLICKET_GRID.innerHTML = '<div class="loading-msg">Fetching Clicket matches…</div>';
  try {
    const [liveId, seasons] = await Promise.all([
      get('/clicket/live').catch(() => null),
      get('/clicket/seasons'),
    ]);

    const latestSeason = Math.max(...seasons);
    const seasonFetches = [latestSeason, latestSeason - 1].filter(n => n > 0)
      .map(n => get(`/clicket/season/${n}`));
    const seasonData = (await Promise.all(seasonFetches)).flat();

    /* Sort by matchID descending (most recent first) */
    const sorted = [...seasonData].sort((a, b) => (b.matchID ?? 0) - (a.matchID ?? 0));

    /* Separate live match from played matches */
    const liveMatch  = liveId ? sorted.find(m => String(m.matchID) === String(liveId)) : null;
    const played     = sorted.filter(m => m.matchPlayed && String(m.matchID) !== String(liveId));
    const recent     = played.slice(0, 10);

    renderClicket(liveMatch, liveId, recent);
    clicketLoaded = true;
  } catch (err) {
    CLICKET_GRID.innerHTML = `<div class="error-msg">Could not load Clicket matches: ${esc(err.message)}</div>`;
  }
}

function renderClicket(liveMatch, liveId, recentMatches) {
  CLICKET_GRID.innerHTML = '';

  if (liveId) {
    const card = liveMatch
      ? clicketCard(liveMatch, true)
      : clicketCard({ matchID: liveId, homeTeamName: 'Live Match', awayTeamName: '…' }, true);
    CLICKET_GRID.appendChild(card);
  }

  if (!recentMatches.length && !liveId) {
    CLICKET_GRID.innerHTML = '<div class="loading-msg">No Clicket matches found.</div>';
    return;
  }

  if (recentMatches.length) {
    const heading = document.createElement('div');
    heading.className = 'sub-heading';
    heading.textContent = 'Recently Played';
    CLICKET_GRID.appendChild(heading);
    recentMatches.forEach(m => CLICKET_GRID.appendChild(clicketCard(m, false)));
  }
}

function clicketCard(m, isLive = false) {
  const el = document.createElement('div');
  el.className = 'match-card clicket' + (isLive ? ' live' : '');

  const status = isLive ? 'Live now'
    : (m.result ?? (m.matchPlayed ? 'Complete' : 'Upcoming'));
  const seasonLabel = m.season != null
    ? `Season ${m.season} · Match ${m.matchNo ?? ''}`
    : `#${m.matchID}`;

  el.innerHTML = `
    <div class="card-league sim-badge">SIM · ${esc(seasonLabel)}</div>
    <div class="card-teams">
      ${isLive ? '<span class="live-dot"></span>' : ''}
      <div class="card-team-row">
        <span class="card-team-name">${esc(m.homeTeamName ?? 'Team A')}</span>
      </div>
      <div class="card-team-row">
        <span class="card-team-name">${esc(m.awayTeamName ?? 'Team B')}</span>
      </div>
    </div>
    <div class="card-footer-row">
      <span class="card-status ${isLive ? 'status-live' : ''}">${esc(status)}</span>
    </div>
    <button class="view-btn clicket-view">View →</button>
  `;

  el.addEventListener('click', () => {
    location.href = `viz.html?matchId=clicket_${m.matchID}`;
  });
  return el;
}

/* ══ Helpers ═════════════════════════════════════════════════════════════ */

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${r.status}`);
  }
  return r.json();
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ══ Start ═══════════════════════════════════════════════════════════════ */
loadESPN();
