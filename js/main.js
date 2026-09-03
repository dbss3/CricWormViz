import { processMatch }      from './dataProcessor.js';
import { loadESPNMatch }     from './espnProcessor.js';
import { loadClicketMatch }  from './clicketProcessor.js';
import { renderChart }       from './wormChart.js';

const params  = new URLSearchParams(location.search);
const matchId = params.get('matchId');
const root    = document.getElementById('chart-root');

if (matchId?.startsWith('clicket_')) {
  loadClicket(matchId.slice(8));         // strip "clicket_" prefix
} else if (matchId) {
  loadESPN(matchId);
} else {
  loadLocal();
}

/* ── Clicket simulated match ────────────────────────────────── */

async function loadClicket(gameId) {
  setMsg('Loading Clicket match…');
  try {
    const matchData = await loadClicketMatch(gameId);
    root.innerHTML  = '';
    renderChart(root, matchData);
    if (matchData.isLive) scheduleRefreshClicket(gameId);
  } catch (err) {
    root.innerHTML = errBox(`Clicket match ${esc(gameId)}`, err, `clicket_${gameId}`);
    console.error(err);
  }
}

/* ── ESPN live match ────────────────────────────────────────── */

async function loadESPN(id) {
  setMsg('Loading match data…');
  try {
    const matchData = await loadESPNMatch(id);
    root.innerHTML  = '';
    renderChart(root, matchData);
    if (matchData.isLive) scheduleRefreshESPN(id);
  } catch (err) {
    root.innerHTML = errBox(`match ${esc(id)}`, err, id);
    console.error(err);
  }
}

/* ── Local demo match (Cricsheet JSON) ──────────────────────── */

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

/* ── Auto-refresh helpers ────────────────────────────────────── */

function scheduleRefreshESPN(id) {
  const t = setInterval(async () => {
    try {
      const d = await loadESPNMatch(id);
      root.innerHTML = '';
      renderChart(root, d);
      if (!d.isLive) clearInterval(t);
    } catch { /* silent */ }
  }, 30_000);
}

function scheduleRefreshClicket(gameId) {
  const t = setInterval(async () => {
    try {
      const d = await loadClicketMatch(gameId);
      root.innerHTML = '';
      renderChart(root, d);
      if (!d.isLive) clearInterval(t);
    } catch { /* silent */ }
  }, 10_000);  // Clicket updates faster
}

/* ── Utilities ───────────────────────────────────────────────── */

function setMsg(html) {
  root.innerHTML = `<div class="loading-msg">${html}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function errBox(label, err, matchId = null) {
  const msg       = err.message ?? String(err);
  const isNoData  = msg.includes('does not provide ball-by-ball');
  const isClicket = matchId?.startsWith('clicket_');

  let externalLink = '';
  if (isClicket) {
    const gameId = matchId.slice(8);
    externalLink = `<a href="https://clicket-game.com/match/${encodeURIComponent(gameId)}" target="_blank" rel="noopener"
      style="color:#f97316;font-weight:600">View on Clicket! ↗</a>`;
  } else if (matchId) {
    const eventId = matchId.includes('_') ? matchId.split('_')[1] : matchId;
    externalLink = `<a href="https://www.espncricinfo.com/matches/engine/match/${encodeURIComponent(eventId)}.html" target="_blank" rel="noopener"
      style="color:#3987e5;font-weight:600">View on ESPNcricinfo ↗</a>`;
  }

  return `
    <div class="loading-msg">
      <strong>${isNoData ? 'No ball-by-ball data available' : `Could not load ${label}.`}</strong><br><br>
      ${isNoData
        ? `<span style="opacity:0.7">${esc(msg)}</span>`
        : `Make sure <code>server.py</code> is running.<br><small style="opacity:0.5">${esc(msg)}</small>`
      }<br><br>
      ${externalLink ? externalLink + '<br><br>' : ''}
      <a href="index.html" style="color:#898781">← Back to match list</a>
    </div>`;
}
