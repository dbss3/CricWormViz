/**
 * wormChart.js
 * Renders the full cricket worm visualisation using D3 v7.
 *
 * Layout per innings panel (SVG):
 *   [marginTop]
 *   ┌─────────────────────────────────────────┐
 *   │  BOWLER PANEL  (runs conceded, top→down)│  bowlerH px
 *   └─────────────────────────────────────────┘
 *   [panelGap]
 *   ┌─────────────────────────────────────────┐
 *   │  MAIN WORM + batter sub-worms           │  wormH px
 *   └─────────────────────────────────────────┘
 *   [marginBottom]
 *
 * Wicket connector lines span across both panels inside the root <g>.
 */

/* ── palette ──────────────────────────────────────────────────────── */
const SERIES = ['#2a78d6','#eb6834','#1baf7a','#eda100','#e87ba4','#008300','#4a3aa7','#e34948'];
const WICKET_COL = '#d03b3b';
const MUTED      = '#898781';
const GRID_COL   = '#e1e0d9';

/* One main colour per team slot (matches CSS --s1 / --s2) */
const TEAM_COLORS = ['#2a78d6', '#eb6834'];

/* ── layout constants ─────────────────────────────────────────────── */
const ML = 60, MR = 20, MT = 16, MB = 44;
const BOWLER_H = 130;
const PANEL_GAP = 14;
const WORM_H  = 360;
const CONTENT_W = 620;
const SVG_W = ML + CONTENT_W + MR;
const SVG_H = MT + BOWLER_H + PANEL_GAP + WORM_H + MB;

/* ── entry point ──────────────────────────────────────────────────── */
export function renderChart(rootEl, matchData) {
  const { matchInfo, innings } = matchData;

  /* header */
  document.getElementById('match-title').textContent =
    `${matchInfo.teams[0]} vs ${matchInfo.teams[1]}`;
  document.getElementById('match-meta').textContent =
    [matchInfo.matchType, matchInfo.venue, matchInfo.dates?.[0]].filter(Boolean).join(' · ');

  /* scrollable flex row */
  const scrollDiv = d3.select(rootEl).append('div').attr('class', 'innings-scroll');

  innings.forEach((inn, i) => {
    const teamIdx  = matchInfo.teams.indexOf(inn.team);
    const teamColor = TEAM_COLORS[teamIdx >= 0 ? teamIdx : i % 2];

    const panelDiv = scrollDiv.append('div').attr('class', 'innings-panel').node();
    renderPanel(panelDiv, inn, teamColor, i);
  });
}

/* ── single innings panel ─────────────────────────────────────────── */
function renderPanel(el, inn, teamColor, panelIdx) {
  /* title */
  const score = `${inn.maxRuns}/${inn.totalWickets}`;
  const label = `${ordinal(inn.idx + 1)} Innings – ${inn.team}  ${score}`;
  d3.select(el).append('div').attr('class', 'innings-title').text(label);

  const svg = d3.select(el)
    .append('svg')
    .attr('width', SVG_W)
    .attr('height', SVG_H)
    .attr('class', 'innings-svg');

  const root = svg.append('g').attr('transform', `translate(${ML},${MT})`);

  /* ── scales ──────────────────────────────────────────────────── */
  const xScale = d3.scaleLinear()
    .domain([0, inn.maxOvers])
    .range([0, CONTENT_W]);

  /* bowler panel: 0 runs at top, maxBowlerRuns at bottom */
  const bYScale = d3.scaleLinear()
    .domain([0, inn.maxBowlerRuns * 1.1])
    .range([0, BOWLER_H]);

  /* main worm: 0 runs at bottom; extend top to target if chasing */
  const wormTop = Math.max(inn.maxRuns, inn.target ?? 0) * 1.08;
  const wYScale = d3.scaleLinear()
    .domain([0, wormTop])
    .range([WORM_H, 0]);

  const bowlerG = root.append('g').attr('class', 'bowler-panel');
  const wormG   = root.append('g').attr('class', 'worm-panel')
    .attr('transform', `translate(0,${BOWLER_H + PANEL_GAP})`);

  drawBowlerPanel(bowlerG, inn, xScale, bYScale);
  drawWormPanel(wormG, inn, xScale, wYScale, teamColor);
  drawBatterWorms(wormG, inn, xScale, wYScale);
  drawWicketConnectors(root, inn, xScale, bYScale, wYScale);
  drawAxes(root, inn, xScale, wYScale, bYScale);
  setupHover(svg, root, inn, xScale, wYScale, bYScale, teamColor, panelIdx);
}

/* ── bowler panel ─────────────────────────────────────────────────── */
function drawBowlerPanel(g, inn, xS, yS) {
  /* bg */
  g.append('rect').attr('class', 'panel-bg')
    .attr('width', CONTENT_W).attr('height', BOWLER_H)
    .attr('fill', 'transparent');

  g.append('text').attr('class', 'panel-label')
    .attr('x', 3).attr('y', 11)
    .text('Bowlers – runs conceded ↓');

  /* over gridlines */
  drawOverGridlines(g, xS, BOWLER_H);

  /* horizontal reference lines */
  yS.ticks(4).forEach(t => {
    g.append('line').attr('class', 'h-grid')
      .attr('x1', 0).attr('x2', CONTENT_W)
      .attr('y1', yS(t)).attr('y2', yS(t));
  });

  /* bowler worms */
  const line = d3.line().x(d => xS(d.x)).y(d => yS(d.runs)).curve(d3.curveLinear);

  inn.bowlersOrdered.forEach(name => {
    const b     = inn.bowlers[name];
    const color = SERIES[b.colorIdx % SERIES.length];

    if (b.data.length === 0) return;

    g.append('path').datum(b.data)
      .attr('class', 'bowler-worm')
      .attr('stroke', color)
      .attr('d', line);

    /* W markers */
    b.wicketMarkers.forEach(wm => {
      g.append('text').attr('class', 'w-label')
        .attr('x', xS(wm.x)).attr('y', yS(wm.runs) - 3)
        .attr('text-anchor', 'middle').text('W');
    });

    /* inline name at end of line */
    const last = b.data[b.data.length - 1];
    g.append('text').attr('class', 'worm-legend')
      .attr('x', xS(last.x) + 3).attr('y', yS(last.runs) + 3)
      .attr('fill', color)
      .text(shortName(name));
  });
}

/* ── main worm panel ──────────────────────────────────────────────── */
function drawWormPanel(g, inn, xS, yS, teamColor) {
  g.append('rect').attr('class', 'panel-bg')
    .attr('width', CONTENT_W).attr('height', WORM_H)
    .attr('fill', 'transparent');

  /* over gridlines */
  drawOverGridlines(g, xS, WORM_H);

  /* horizontal gridlines */
  yS.ticks(8).forEach(t => {
    g.append('line').attr('class', 'h-grid')
      .attr('x1', 0).attr('x2', CONTENT_W)
      .attr('y1', yS(t)).attr('y2', yS(t));
  });

  /* ── target & required-rate lines ─────────────────────────────── */
  if (inn.target != null) {
    const tY = yS(inn.target);

    /* required-rate diagonal — slope = target / maxOvers */
    g.append('line').attr('class', 'req-rate-line')
      .attr('x1', xS(0)).attr('y1', yS(0))
      .attr('x2', xS(inn.maxOvers)).attr('y2', tY)
      .attr('stroke', '#52514e')
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '6 4')
      .attr('opacity', 0.55);

    /* target horizontal */
    g.append('line').attr('class', 'target-line')
      .attr('x1', xS(0)).attr('y1', tY)
      .attr('x2', xS(inn.maxOvers)).attr('y2', tY)
      .attr('stroke', WICKET_COL)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '8 4')
      .attr('opacity', 0.8);

    /* target label */
    g.append('text').attr('class', 'target-label')
      .attr('x', xS(0) + 4)
      .attr('y', tY - 5)
      .attr('fill', WICKET_COL)
      .attr('font-size', 10)
      .attr('font-weight', 600)
      .text(`Target: ${inn.target}`);

    /* required run rate label */
    if (inn.requiredRunRate != null) {
      g.append('text').attr('class', 'target-label')
        .attr('x', xS(inn.maxOvers / 2))
        .attr('y', yS(inn.target / 2) + 12)
        .attr('fill', '#52514e')
        .attr('font-size', 10)
        .attr('text-anchor', 'middle')
        .text(`RRR ${inn.requiredRunRate.toFixed(2)}`);
    }
  }

  /* main worm */
  const line = d3.line().x(d => xS(d.x)).y(d => yS(d.y)).curve(d3.curveLinear);

  g.append('path').datum(inn.deliveries)
    .attr('class', 'main-worm')
    .attr('stroke', teamColor)
    .attr('d', line);

  /* wicket W on main worm */
  inn.deliveries.filter(d => d.isWicket).forEach(d => {
    g.append('text').attr('class', 'w-label')
      .attr('x', xS(d.x)).attr('y', yS(d.y) - 5)
      .attr('text-anchor', 'middle').text('W');
  });
}

/* ── batter sub-worms ─────────────────────────────────────────────── */
function drawBatterWorms(g, inn, xS, yS) {
  const line = d3.line().x(d => xS(d.x)).y(d => yS(d.y)).curve(d3.curveLinear);

  inn.battersOrdered.forEach(name => {
    const b     = inn.batters[name];
    const color = SERIES[b.colorIdx % SERIES.length];

    if (b.data.length < 2) return;

    /* split into on-strike / off-strike segments for opacity */
    const segs = segmentByStrike(b.data);
    segs.forEach(seg => {
      if (seg.pts.length < 2) return;
      g.append('path').datum(seg.pts)
        .attr('class', 'batter-worm')
        .attr('stroke', color)
        .attr('opacity', seg.onStrike ? 1 : 0.28)
        .attr('d', line);
    });

    /* W marker at dismissal */
    if (b.dismissed && b.dismissalX !== null) {
      const dismissY = b.entryY + b.personalRuns;
      g.append('text').attr('class', 'w-label')
        .attr('x', xS(b.dismissalX)).attr('y', yS(dismissY) + 11)
        .attr('text-anchor', 'middle').text('W');
    }

    /* inline name at end */
    const last = b.data[b.data.length - 1];
    g.append('text').attr('class', 'worm-legend')
      .attr('x', xS(last.x) + 3).attr('y', yS(last.y) + 3)
      .attr('fill', color)
      .text(shortName(name));
  });
}

/* ── wicket connector lines ───────────────────────────────────────── */
function drawWicketConnectors(root, inn, xS, bYS, wYS) {
  inn.wicketEvents.forEach(evt => {
    const px = xS(evt.x);
    /* bowler panel: from wicket y down to bottom of panel */
    root.append('line').attr('class', 'wicket-vline')
      .attr('x1', px).attr('x2', px)
      .attr('y1', bYS(evt.bowlerRuns))
      .attr('y2', BOWLER_H);

    /* gap + worm panel: from top of worm panel down to team run level */
    const wormTop = BOWLER_H + PANEL_GAP;
    root.append('line').attr('class', 'wicket-vline')
      .attr('x1', px).attr('x2', px)
      .attr('y1', wormTop)
      .attr('y2', wormTop + wYS(evt.teamRuns));
  });
}

/* ── axes ─────────────────────────────────────────────────────────── */
function drawAxes(root, inn, xS, wYS, bYS) {
  const wormTop = BOWLER_H + PANEL_GAP;

  /* x axis */
  root.append('g').attr('class', 'x-axis')
    .attr('transform', `translate(0,${wormTop + WORM_H})`)
    .call(
      d3.axisBottom(xS)
        .ticks(Math.min(Math.ceil(inn.maxOvers / 10), 16))
        .tickFormat(d => d)
    );

  /* runs (left y axis, worm panel) */
  root.append('g').attr('class', 'y-axis')
    .attr('transform', `translate(0,${wormTop})`)
    .call(d3.axisLeft(wYS).ticks(8));

  /* bowler runs (left y axis, bowler panel — values) */
  root.append('g').attr('class', 'y-axis y-bowler')
    .call(d3.axisLeft(bYS).ticks(4));

  /* axis labels */
  root.append('text').attr('class', 'axis-label')
    .attr('x', CONTENT_W / 2)
    .attr('y', wormTop + WORM_H + 36)
    .attr('text-anchor', 'middle')
    .text('Overs');

  root.append('text').attr('class', 'axis-label')
    .attr('transform', 'rotate(-90)')
    .attr('x', -(wormTop + WORM_H / 2))
    .attr('y', -46)
    .attr('text-anchor', 'middle')
    .text('Runs');
}

/* ── hover / crosshair / tooltip ─────────────────────────────────── */
function setupHover(svg, root, inn, xS, wYS, bYS, teamColor, panelIdx) {
  const ttEl = document.getElementById('tooltip');

  /* vertical crosshair across full panel height */
  const crosshair = root.append('line').attr('class', 'crosshair')
    .attr('y1', 0).attr('y2', BOWLER_H + PANEL_GAP + WORM_H);

  /* invisible overlay rect covering the whole area */
  root.append('rect')
    .attr('width', CONTENT_W).attr('height', BOWLER_H + PANEL_GAP + WORM_H)
    .attr('fill', 'none').attr('pointer-events', 'all')
    .on('mousemove', function(event) {
      const [mx] = d3.pointer(event);
      const overVal = xS.invert(Math.max(0, mx));
      const bisect  = d3.bisector(d => d.x).left;
      const idx     = Math.min(bisect(inn.deliveries, overVal), inn.deliveries.length - 1);
      const d       = inn.deliveries[idx];
      if (!d) return;

      crosshair.attr('x1', xS(d.x)).attr('x2', xS(d.x)).style('opacity', 0.8);

      renderTooltip(ttEl, d, inn, teamColor, event);
    })
    .on('mouseleave', () => {
      crosshair.style('opacity', 0);
      ttEl.style.display = 'none';
    });
}

function renderTooltip(el, d, inn, teamColor, event) {
  const batter    = inn.batters[d.batter];
  const nonStrike = inn.batters[d.nonStriker];
  const bowler    = inn.bowlers[d.bowler];

  const batterSR  = d.batterBalls > 0 ? (d.batterRuns / d.batterBalls * 100).toFixed(1) : '–';
  const bowlerEco = d.bowlerBalls > 0
    ? (d.bowlerRunsNow / d.bowlerBalls * 6).toFixed(2)
    : '–';
  const teamRR    = d.x > 0 ? (d.y / d.x).toFixed(2) : '–';

  const oc  = SERIES[batter?.colorIdx % SERIES.length] ?? teamColor;
  const noc = SERIES[nonStrike?.colorIdx % SERIES.length] ?? '#888';
  const bc  = SERIES[bowler?.colorIdx % SERIES.length] ?? '#888';

  el.innerHTML = `
    <div class="tooltip-over">Over ${formatOver(d.x)} &nbsp;·&nbsp; ${d.y}/${d.wickets}</div>
    <div class="tooltip-row">
      <span class="tooltip-label"><span class="tt-dot" style="background:${oc}"></span>${shortName(d.batter)}*</span>
      <span class="tooltip-val">${d.batterRuns} (${d.batterBalls}b) SR ${batterSR}</span>
    </div>
    ${nonStrike ? `<div class="tooltip-row">
      <span class="tooltip-label"><span class="tt-dot" style="background:${noc}"></span>${shortName(d.nonStriker)}</span>
      <span class="tooltip-val">${d.nonStrikerRuns} (${d.nonStrikerBalls}b)</span>
    </div>` : ''}
    <hr class="tooltip-sep">
    <div class="tooltip-row">
      <span class="tooltip-label"><span class="tt-dot" style="background:${bc}"></span>${shortName(d.bowler)}</span>
      <span class="tooltip-val">${d.bowlerRunsNow}/${d.bowlerWicketsNow} ER ${bowlerEco}</span>
    </div>
    <div class="tooltip-row">
      <span class="tooltip-label">Run rate</span>
      <span class="tooltip-val">${teamRR}</span>
    </div>`;

  el.style.display = 'block';
  positionTooltip(el, event);
}

function positionTooltip(el, event) {
  const pad  = 12;
  const rect = el.getBoundingClientRect();
  let left   = event.clientX + pad;
  let top    = event.clientY + pad;
  if (left + rect.width  > window.innerWidth)  left = event.clientX - rect.width - pad;
  if (top  + rect.height > window.innerHeight) top  = event.clientY - rect.height - pad;
  el.style.left = left + 'px';
  el.style.top  = top  + 'px';
}

/* ── helpers ──────────────────────────────────────────────────────── */

function drawOverGridlines(g, xS, height) {
  const maxOvers = Math.ceil(xS.domain()[1]);
  for (let i = 0; i <= maxOvers; i++) {
    g.append('line')
      .attr('class', i % 10 === 0 ? 'v-grid major' : 'v-grid')
      .attr('x1', xS(i)).attr('x2', xS(i))
      .attr('y1', 0).attr('y2', height);
  }
}

function segmentByStrike(data) {
  const segs = [];
  let cur    = null;
  for (const pt of data) {
    if (!cur || cur.onStrike !== pt.onStrike) {
      if (cur) segs.push(cur);
      cur = { onStrike: pt.onStrike, pts: [] };
      // carry over last point for visual continuity
      if (segs.length > 0) {
        const prev = segs[segs.length - 1];
        cur.pts.push({ ...prev.pts[prev.pts.length - 1] });
      }
    }
    cur.pts.push({ x: pt.x, y: pt.y });
  }
  if (cur) segs.push(cur);
  return segs;
}

function shortName(name) {
  if (!name) return '';
  const parts = name.trim().split(' ');
  if (parts.length === 1) return name;
  return parts[0][0] + ' ' + parts.slice(1).join(' ');
}

function formatOver(x) {
  const over = Math.floor(x);
  const ball = Math.round((x - over) * 6);
  return ball === 0 ? `${over}.0` : `${over}.${ball}`;
}

function ordinal(n) {
  return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
}
