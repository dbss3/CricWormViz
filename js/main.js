import { loadESPNMatch } from './espnProcessor.js';
import { processMatch }  from './dataProcessor.js';
import { renderChart }   from './wormChart.js';

const params  = new URLSearchParams(location.search);
const matchId = params.get('matchId');
const root    = document.getElementById('chart-root');

if (matchId) {
  loadESPN(matchId);
} else {
  loadLocal();
}

/* ── ESPN match ─────────────────────────────────────────────────────────── */

async function loadESPN(id) {
  setMsg('Loading match data…');
  try {
    const matchData = await loadESPNMatch(id);
    root.innerHTML  = '';
    renderChart(root, matchData);
    if (matchData.isLive) scheduleRefresh(id);
  } catch (err) {
    root.innerHTML = errBox(id, err);
    console.error(err);
  }
}

/* ── Local demo match (Cricsheet JSON) ──────────────────────────────────── */

async function loadLocal() {
  try {
    const raw       = await fetch('./data/match.json').then(r => r.json());
    const matchData = processMatch(raw);
    renderChart(root, matchData);
  } catch (err) {
    root.textContent = 'Error loading data: ' + err.message;
    console.error(err);
  }
}

/* ── Auto-refresh ────────────────────────────────────────────────────────── */

function scheduleRefresh(id) {
  const t = setInterval(async () => {
    try {
      const d = await loadESPNMatch(id);
      root.innerHTML = '';
      renderChart(root, d);
      if (!d.isLive) clearInterval(t);
    } catch { /* silent */ }
  }, 30_000);
}

/* ── Utilities ───────────────────────────────────────────────────────────── */

function setMsg(html) {
  root.innerHTML = `<div class="loading-msg">${html}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function errBox(matchId, err) {
  const msg      = err.message ?? String(err);
  const isNoData = msg.includes('does not provide ball-by-ball');
  const eventId  = matchId?.includes('_') ? matchId.split('_')[1] : matchId;

  const externalLink = eventId
    ? `<a href="https://www.espncricinfo.com/matches/engine/match/${encodeURIComponent(eventId)}.html"
         target="_blank" rel="noopener" style="color:#3987e5;font-weight:600">View on ESPNcricinfo ↗</a>`
    : '';

  return `
    <div class="loading-msg">
      <strong>${isNoData ? 'No ball-by-ball data available' : `Could not load match ${esc(matchId)}.`}</strong><br><br>
      ${isNoData
        ? `<span style="opacity:0.7">${esc(msg)}</span>`
        : `<small style="opacity:0.5">${esc(msg)}</small>`
      }<br><br>
      ${externalLink ? externalLink + '<br><br>' : ''}
      <a href="index.html" style="color:#898781">← Back to match list</a>
    </div>`;
}
