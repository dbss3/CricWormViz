/**
 * wormChart.js
 * Renders the full cricket worm visualisation using D3 v7.
 *
 * Layout per innings panel (SVG):
 *   [marginTop]
 *   ┌─────────────────────────────────────────┐
 *   │  BOWLER PANEL  (runs conceded, top→down)│  BOWLER_H px
 *   └─────────────────────────────────────────┘
 *   [PANEL_GAP]
 *   ┌─────────────────────────────────────────┐
 *   │  MAIN WORM  (cumulative team runs)      │  WORM_H px
 *   └─────────────────────────────────────────┘
 *   [PANEL_GAP]
 *   ┌─────────────────────────────────────────┐
 *   │  BATTER PANEL  (personal runs, 0-based) │  BATTER_H px
 *   └─────────────────────────────────────────┘
 *   [marginBottom]
 *
 * Wicket connector lines span all three panels.
 * Bowler lines: full colour when bowling, faded between spells.
 */

/* ── palette — dark mode (matches CSS :root custom properties) ────── */
const SERIES = ['#3987e5','#d95926','#199e70','#c98500','#d55181','#22c55e','#9085e9','#e66767'];
const WICKET_COL = '#e34948';
const MUTED      = '#898781';
const GRID_COL   = '#2c2c2a';
const GOLD       = '#f0b429';
const SILVER     = '#a8a8a0';

/* One main colour per team slot (matches CSS --s1 / --s2) */
const TEAM_COLORS = ['#3987e5', '#d95926'];

/* ── layout constants ─────────────────────────────────────────────── */
const ML = 60, MR = 20, MT = 16, MB = 44;
const PANEL_H   = 200;          // all three panels share the same height
const BOWLER_H  = PANEL_H;
const WORM_H    = PANEL_H;
const BATTER_H  = PANEL_H;
const PANEL_GAP = 12;
const CONTENT_W = 620;
const TOTAL_CONTENT_H = PANEL_H * 3 + PANEL_GAP * 2;
const SVG_W = ML + CONTENT_W + MR;
const SVG_H = MT + TOTAL_CONTENT_H + MB;

/* y-offsets (in root-g space) for each panel's top edge */
const BOWLER_TOP  = 0;
const WORM_TOP    = PANEL_H + PANEL_GAP;
const BATTER_TOP  = PANEL_H * 2 + PANEL_GAP * 2;

/* ── entry point ──────────────────────────────────────────────────── */
export function renderChart(rootEl, matchData) {
  const { matchInfo, innings, isLive } = matchData;

  /* header */
  document.getElementById('match-title').textContent =
    `${matchInfo.teams[0]} vs ${matchInfo.teams[1]}`;
  document.getElementById('match-meta').textContent =
    [matchInfo.matchType, matchInfo.venue, matchInfo.dates?.[0]].filter(Boolean).join(' · ');

  /* headline scores */
  const headlineEl = document.getElementById('match-headline');
  if (headlineEl && innings.length) {
    headlineEl.innerHTML = innings.map(inn => {
      const overs = fmtOvers(inn.maxOvers);
      const scoreStr = inn.totalWickets >= 10 ? `${inn.maxRuns}` : `${inn.maxRuns}/${inn.totalWickets}`;
      return `<span class="hl-inn">${inn.team}: <strong>${scoreStr}</strong> <span class="hl-ov">(${overs})</span></span>`;
    }).join('<span class="hl-sep">·</span>');
  }

  /* result */
  const resultEl = document.getElementById('match-result');
  if (resultEl && matchInfo.outcome) {
    resultEl.textContent = matchInfo.outcome;
  }

  /* scrollable flex column of innings panels */
  const scrollDiv = d3.select(rootEl).append('div').attr('class', 'innings-scroll');

  innings.forEach((inn, i) => {
    const teamIdx   = matchInfo.teams.indexOf(inn.team);
    const teamColor = TEAM_COLORS[teamIdx >= 0 ? teamIdx : i % 2];

    const prevInn   = i > 0 ? innings[i - 1] : null;
    const prevIdx   = prevInn ? matchInfo.teams.indexOf(prevInn.team) : -1;
    const prevColor = prevInn ? TEAM_COLORS[prevIdx >= 0 ? prevIdx : (i - 1) % 2] : null;

    /* isTest: first innings lasted >50 overs, or there are already 3+ innings */
    const isTest    = innings.length > 2 || (innings[0]?.maxOvers ?? 0) > 50;
    const isLiveInn = isLive && i === innings.length - 1;
    const panelDiv = scrollDiv.append('div').attr('class', 'innings-panel').node();
    renderPanel(panelDiv, inn, teamColor, i, prevInn, prevColor, isLiveInn, isTest);
  });
}

function fmtOvers(x) {
  const ov = Math.floor(x);
  const b  = Math.round((x - ov) * 6);
  return b === 0 ? `${ov} ov` : `${ov}.${b} ov`;
}

/* ── single innings panel ─────────────────────────────────────────── */
function renderPanel(el, inn, teamColor, panelIdx, prevInn = null, prevColor = null, isLiveInn = false, isTest = false) {
  const score   = inn.totalWickets >= 10 ? `${inn.maxRuns}` : `${inn.maxRuns}/${inn.totalWickets}`;
  const lastDel = inn.deliveries.at(-1);
  const overs   = lastDel ? fmtOvers(lastDel.x) : '';
  const liveTag = isLiveInn ? ' <span class="inn-live-badge">LIVE</span>' : '';
  const label   = `${ordinal(inn.idx + 1)} Innings – ${inn.team}  ${score}  (${overs})`;
  d3.select(el).append('div').attr('class', 'innings-title').html(esc(label) + liveTag);

  /* two-column layout: chart left, [current over middle for live,] scorecard right */
  const row = d3.select(el).append('div').attr('class', 'innings-row');
  const chartCol = row.append('div').attr('class', 'innings-chart-col');
  if (isLiveInn) {
    renderCurrentOver(row.append('div').attr('class', 'current-over-col').node(), inn);
  }
  renderScorecard(row.append('div').attr('class', 'innings-scorecard-col').node(), inn, teamColor);

  const svg = chartCol
    .append('svg')
    .attr('width', SVG_W)
    .attr('height', SVG_H)
    .attr('class', 'innings-svg');

  const root = svg.append('g').attr('transform', `translate(${ML},${MT})`);

  /* ── scales ──────────────────────────────────────────────────── */
  const xScale = d3.scaleLinear()
    .domain([0, inn.maxOvers])
    .range([0, CONTENT_W]);

  /* bowler panel: 0 at top → maxRuns at bottom */
  const bYScale = d3.scaleLinear()
    .domain([0, inn.maxBowlerRuns * 1.1])
    .range([0, BOWLER_H]);

  /* main worm: 0 at bottom → max at top; extend for target */
  const wYTop = Math.max(inn.maxRuns, inn.target ?? 0) * 1.08;
  const wYScale = d3.scaleLinear()
    .domain([0, wYTop])
    .range([WORM_H, 0]);

  /* batter panel: personal runs, 0 at bottom → max at top */
  const maxPersonal = Math.max(
    ...Object.values(inn.batters).map(b => b.personalRuns), 1
  );
  const batYScale = d3.scaleLinear()
    .domain([0, maxPersonal * 1.1])
    .range([BATTER_H, 0]);

  const bowlerG = root.append('g').attr('class', 'bowler-panel')
    .attr('transform', `translate(0,${BOWLER_TOP})`);
  const wormG   = root.append('g').attr('class', 'worm-panel')
    .attr('transform', `translate(0,${WORM_TOP})`);
  const batterG = root.append('g').attr('class', 'batter-panel')
    .attr('transform', `translate(0,${BATTER_TOP})`);

  /* cache partnerships once per innings (used by both batter panel and tooltip) */
  inn._partnerships = computePartnerships(inn);

  drawBowlerPanel(bowlerG, inn, xScale, bYScale);
  drawWormPanel(wormG, inn, xScale, wYScale, teamColor, prevInn, prevColor);
  drawBatterPanel(batterG, inn, xScale, batYScale);
  drawWicketConnectors(root, inn, xScale, bYScale, wYScale, batYScale);
  drawAxes(root, inn, xScale, wYScale, bYScale, batYScale);
  setupHover(svg, root, inn, xScale, wYScale, bYScale, batYScale, teamColor, panelIdx, isTest);
  setupZoom(svg);
}

/* ── bowler panel ─────────────────────────────────────────────────── */
function drawBowlerPanel(g, inn, xS, yS) {
  drawOverGridlines(g, xS, BOWLER_H);

  yS.ticks(4).forEach(t => {
    g.append('line').attr('class', 'h-grid')
      .attr('x1', 0).attr('x2', CONTENT_W)
      .attr('y1', yS(t)).attr('y2', yS(t));
  });

  const line = d3.line().x(d => xS(d.x)).y(d => yS(d.runs)).curve(d3.curveLinear);

  inn.bowlersOrdered.forEach(name => {
    const b     = inn.bowlers[name];
    const color = SERIES[b.colorIdx % SERIES.length];
    if (b.data.length === 0) return;

    /* split into active-spell / between-spell segments */
    const segments = bowlerSpells(b.data);
    segments.forEach(seg => {
      g.append('path').datum(seg.pts)
        .attr('class', 'bowler-worm')
        .attr('stroke', color)
        .attr('opacity', seg.active ? 1 : 0.22)
        .attr('d', line);
    });

    /* W markers sit ON the line; gold fill for 5-wicket hauls */
    const fifer = b.wickets >= 5;
    b.wicketMarkers.forEach(wm => {
      g.append('text').attr('class', 'w-label')
        .attr('x', xS(wm.x)).attr('y', yS(wm.runs) - 3)
        .attr('text-anchor', 'middle')
        .attr('fill', fifer ? GOLD : null)
        .text('W');
    });
  });

  /* ── deconflicted name labels ───────────────────────────────────── */
  const bowlerLabels = inn.bowlersOrdered
    .filter(name => inn.bowlers[name].data.length > 0)
    .map(name => {
      const b    = inn.bowlers[name];
      const last = b.data[b.data.length - 1];
      const lx   = xS(last.x);
      return {
        x:     lx > CONTENT_W - 60 ? lx - 3 : lx + 3,
        anchor: lx > CONTENT_W - 60 ? 'end' : 'start',
        y:     yS(last.runs),
        color: SERIES[b.colorIdx % SERIES.length],
        text:  shortName(name),
      };
    });

  deconflictLabels(bowlerLabels, 11, 4, BOWLER_H - 4);
  bowlerLabels.forEach(l => {
    g.append('text').attr('class', 'worm-legend')
      .attr('x', l.x).attr('y', l.y + 4)
      .attr('text-anchor', l.anchor)
      .attr('fill', l.color).text(l.text);
  });
}

/**
 * Split a bowler's data into active-spell and between-spell segments.
 * A gap > 1.1 fractional overs between consecutive points = end of spell.
 * Between spells the line is flat (runs unchanged) and faded.
 */
function bowlerSpells(data) {
  const SPELL_GAP = 1.1;
  const segs = [];
  let spellStart = 0;

  for (let i = 1; i <= data.length; i++) {
    const atEnd = i === data.length;
    const isGap = !atEnd && (data[i].x - data[i - 1].x) > SPELL_GAP;

    if (isGap || atEnd) {
      /* active spell */
      segs.push({ active: true,  pts: data.slice(spellStart, i) });

      if (isGap) {
        /* flat faded bridge to next spell */
        segs.push({ active: false, pts: [
          data[i - 1],
          { x: data[i].x, runs: data[i - 1].runs },
        ]});
        spellStart = i;
      }
    }
  }
  return segs;
}

/* ── main worm panel ──────────────────────────────────────────────── */
function drawWormPanel(g, inn, xS, yS, teamColor, prevInn = null, prevColor = null) {
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

  const line = d3.line().x(d => xS(d.x)).y(d => yS(d.y)).curve(d3.curveLinear);

  /* ── previous innings overlay (light, no W markers) ──────────── */
  if (prevInn?.deliveries?.length) {
    g.append('path').datum(prevInn.deliveries)
      .attr('fill', 'none')
      .attr('stroke', prevColor ?? MUTED)
      .attr('stroke-width', 2.5)
      .attr('opacity', 0.75)
      .attr('d', line);
  }

  /* ── target line (horizontal) ─────────────────────────────────── */
  if (inn.target != null) {
    const tY = yS(inn.target);

    g.append('line').attr('class', 'target-line')
      .attr('x1', xS(0)).attr('y1', tY)
      .attr('x2', xS(inn.maxOvers)).attr('y2', tY)
      .attr('stroke', WICKET_COL)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '8 4')
      .attr('opacity', 0.8);

    g.append('text').attr('class', 'target-label')
      .attr('x', xS(0) + 4).attr('y', tY - 5)
      .attr('fill', WICKET_COL).attr('font-size', 10).attr('font-weight', 600)
      .text(`Target: ${inn.target}`);
  }

  /* ── main worm ────────────────────────────────────────────────── */
  g.append('path').datum(inn.deliveries)
    .attr('class', 'main-worm')
    .attr('stroke', teamColor)
    .attr('d', line);

  /* ── wicket W markers on the main worm ───────────────────────── */
  inn.wicketEvents.forEach(evt => {
    g.append('text').attr('class', 'w-label')
      .attr('x', xS(evt.x))
      .attr('y', yS(evt.teamRuns) - 5)
      .attr('text-anchor', 'middle').text('W');
  });
}

/* ── batter panel (personal runs, separate subplot) ───────────────── */
function drawBatterPanel(g, inn, xS, yS) {
  drawOverGridlines(g, xS, BATTER_H);

  yS.ticks(5).forEach(t => {
    g.append('line').attr('class', 'h-grid')
      .attr('x1', 0).attr('x2', CONTENT_W)
      .attr('y1', yS(t)).attr('y2', yS(t));
  });

  /* y=0 baseline */
  g.append('line')
    .attr('x1', 0).attr('x2', CONTENT_W)
    .attr('y1', yS(0)).attr('y2', yS(0))
    .attr('stroke', '#c3c2b7').attr('stroke-width', 1);

  /* milestone lines: 50 (silver) and 100 (gold) */
  const [domMin, domMax] = yS.domain();
  if (domMax >= 50) {
    g.append('line').attr('class', 'milestone-line')
      .attr('x1', 0).attr('x2', CONTENT_W)
      .attr('y1', yS(50)).attr('y2', yS(50))
      .attr('stroke', SILVER).attr('stroke-width', 1).attr('stroke-dasharray', '5 4').attr('opacity', 0.7);
    g.append('text').attr('class', 'milestone-label')
      .attr('x', CONTENT_W + 2).attr('y', yS(50) + 3)
      .attr('font-size', 8).attr('fill', SILVER).attr('opacity', 0.8)
      .text('50');
  }
  if (domMax >= 100) {
    g.append('line').attr('class', 'milestone-line')
      .attr('x1', 0).attr('x2', CONTENT_W)
      .attr('y1', yS(100)).attr('y2', yS(100))
      .attr('stroke', GOLD).attr('stroke-width', 1).attr('stroke-dasharray', '5 4').attr('opacity', 0.7);
    g.append('text').attr('class', 'milestone-label')
      .attr('x', CONTENT_W + 2).attr('y', yS(100) + 3)
      .attr('font-size', 8).attr('fill', GOLD).attr('opacity', 0.8)
      .text('100');
  }

  /* ── partnerships: colored band + top-centre label ─────────────── */
  const parts = inn._partnerships ?? computePartnerships(inn);

  parts.forEach(p => {
    const ba = inn.batters[p.b1];
    const bb = inn.batters[p.b2];
    const junior = (ba?.colorIdx ?? 0) > (bb?.colorIdx ?? 0) ? ba : bb;
    const color  = SERIES[junior?.colorIdx % SERIES.length] ?? SERIES[0];

    const x1 = xS(p.startX);
    const x2 = xS(p.endX);
    const w  = Math.max(x2 - x1, 1);

    g.append('rect')
      .attr('x', x1).attr('y', 0)
      .attr('width', w).attr('height', BATTER_H)
      .attr('fill', color).attr('opacity', 0.07)
      .attr('stroke', 'none');

    if (p.startX > 0) {
      g.append('line')
        .attr('x1', x1).attr('x2', x1)
        .attr('y1', 0).attr('y2', BATTER_H)
        .attr('stroke', color).attr('stroke-width', 1).attr('opacity', 0.45);
    }

    /* partnership total + overs centred at the top of the band */
    if (w > 16) {
      const oversTxt = fmtOv(p.overs);
      g.append('text')
        .attr('x', x1 + w / 2).attr('y', 14)
        .attr('text-anchor', 'middle')
        .attr('font-size', 9).attr('fill', color).attr('opacity', 0.8)
        .text(w > 50 ? `${p.runs} (${oversTxt})` : p.runs);
    }
  });

  /* ── batter lines ───────────────────────────────────────────────── */
  const line = d3.line()
    .x(d => xS(d.x))
    .y(d => yS(d.personalRuns))
    .curve(d3.curveLinear);

  inn.battersOrdered.forEach(name => {
    const b     = inn.batters[name];
    const color = SERIES[b.colorIdx % SERIES.length];
    if (b.data.length < 2) return;

    /* map raw data to personal-run coordinates */
    const pts = b.data.map(pt => ({
      x:            pt.x,
      personalRuns: pt.y - b.entryY,
      onStrike:     pt.onStrike,
    }));

    /* on-strike / off-strike segments */
    const segs = segmentByOnStrike(pts);
    segs.forEach(seg => {
      if (seg.pts.length < 2) return;
      g.append('path').datum(seg.pts)
        .attr('class', 'batter-worm')
        .attr('stroke', color)
        .attr('opacity', seg.onStrike ? 1 : 0.25)
        .attr('d', line);
    });

    /* W marker ON the line at the dismissal point */
    if (b.dismissed && b.dismissalX !== null) {
      g.append('text').attr('class', 'w-label')
        .attr('x', xS(b.dismissalX))
        .attr('y', yS(b.personalRuns) - 4)
        .attr('text-anchor', 'middle').text('W');
    }
  });

  /* ── deconflicted batter name labels ────────────────────────────── */
  const batterLabels = inn.battersOrdered
    .filter(name => inn.batters[name].data.length >= 2)
    .map(name => {
      const b     = inn.batters[name];
      const color = SERIES[b.colorIdx % SERIES.length];
      const lastPt = b.data.map(pt => ({
        x: pt.x, personalRuns: pt.y - b.entryY,
      })).at(-1);
      const lx = xS(lastPt.x);
      return {
        x:      lx > CONTENT_W - 70 ? lx - 3 : lx + 3,
        anchor: lx > CONTENT_W - 70 ? 'end' : 'start',
        y:      yS(lastPt.personalRuns),
        color, text: shortName(name),
      };
    });

  deconflictLabels(batterLabels, 11, 4, BATTER_H - 4);
  batterLabels.forEach(l => {
    g.append('text').attr('class', 'worm-legend')
      .attr('x', l.x).attr('y', l.y + 4)
      .attr('text-anchor', l.anchor)
      .attr('fill', l.color).text(l.text);
  });
}

/**
 * Compute partnerships from delivery-level data.
 * A partnership lasts while the same two batters are at the crease.
 * Pair key is sorted names so end-swaps don't create new partnerships.
 * Returns batter names (to drive colors) and per-delivery cumulative pts.
 */
/* ── current over panel (live matches) ───────────────────────────── */
function renderCurrentOver(el, inn) {
  if (!inn.deliveries.length) return;
  const lastDel  = inn.deliveries.at(-1);
  const curOver  = Math.floor(lastDel.x);
  const overBalls = inn.deliveries.filter(d => Math.floor(d.x) === curOver);
  if (!overBalls.length) return;

  const d3el = d3.select(el);
  d3el.append('div').attr('class', 'co-heading')
    .text(`Over ${curOver + 1}`);

  const row = d3el.append('div').attr('class', 'co-balls-row');
  overBalls.forEach(d => {
    let label, cls;
    if (d.isWicket) {
      label = 'W'; cls = 'co-ball co-ball-wkt';
    } else if (!d.isLegal) {
      label = d.batRuns > 0 ? `nb+${d.batRuns}` : (d.extraRuns > 0 ? 'wd' : 'nb');
      cls = 'co-ball co-ball-extra';
    } else {
      const runs = d.batRuns + (d.extraRuns ?? 0);
      label = runs === 0 ? '·' : String(runs);
      cls = runs === 6 ? 'co-ball co-ball-six'
          : runs === 4 ? 'co-ball co-ball-four'
          : runs === 0 ? 'co-ball co-ball-dot'
          : 'co-ball';
    }
    row.append('span').attr('class', cls).text(label);
  });

  /* over summary: bowler, runs, wickets */
  const overRuns    = overBalls.reduce((s, d) => s + (d.batRuns ?? 0) + (d.extraRuns ?? 0), 0);
  const overWkts    = overBalls.filter(d => d.isWicket).length;
  const bowlerName  = overBalls[0]?.bowler ?? '';
  d3el.append('div').attr('class', 'co-summary')
    .text(`${shortName(bowlerName)}  ${overRuns} run${overRuns !== 1 ? 's' : ''}${overWkts ? `, ${overWkts}W` : ''}`);
}

/* ── innings scorecard ────────────────────────────────────────────── */
function renderScorecard(el, inn, teamColor) {
  const d3el = d3.select(el);

  /* ── batting ── */
  d3el.append('div').attr('class', 'sc-heading').text('Batting');
  const batTable = d3el.append('table').attr('class', 'sc-table');
  batTable.append('thead').append('tr').html(
    '<th>Batter</th><th>R</th><th>B</th><th>SR</th><th>How</th>'
  );
  const batBody = batTable.append('tbody');

  inn.battersOrdered.forEach(name => {
    const b  = inn.batters[name];
    if (!b) return;
    const sr = b.balls > 0 ? (b.personalRuns / b.balls * 100).toFixed(0) : '–';
    const how = b.dismissed
      ? dismissalAbbr(b.dismissalKind ?? 'out')
      : (inn.totalWickets >= 10 ? 'not out' : 'not out');
    const tr = batBody.append('tr');
    tr.append('td').attr('class', 'sc-name')
      .html(`<span class="sc-dot" style="background:${SERIES[b.colorIdx % SERIES.length]}"></span>${esc(shortName(name))}`);
    tr.append('td').attr('class', 'sc-num').text(b.personalRuns);
    tr.append('td').attr('class', 'sc-num sc-dim').text(b.balls);
    tr.append('td').attr('class', 'sc-num sc-dim').text(sr);
    tr.append('td').attr('class', 'sc-how').text(how);
  });

  /* extras row */
  const batExtras = inn.deliveries.reduce((s, d) => s + (d.extraRuns ?? 0), 0);
  if (batExtras > 0) {
    batBody.append('tr').attr('class', 'sc-extras')
      .html(`<td colspan="5">Extras: ${batExtras}</td>`);
  }

  /* total row */
  const lastDel = inn.deliveries.at(-1);
  const totalOv = lastDel ? fmtOvers(lastDel.x) : '–';
  const totalScore = inn.totalWickets >= 10 ? `${inn.maxRuns}` : `${inn.maxRuns}/${inn.totalWickets}`;
  const totalLegalBalls = inn.deliveries.filter(d => d.isLegal).length;
  const totalSR = totalLegalBalls > 0 ? (inn.maxRuns / totalLegalBalls * 100).toFixed(0) : '–';
  batBody.append('tr').attr('class', 'sc-total')
    .html(`<td colspan="2"><strong>Total: ${totalScore}</strong></td><td class="sc-dim">${totalOv}</td><td class="sc-dim">SR ${totalSR}</td><td></td>`);

  /* ── bowling ── */
  d3el.append('div').attr('class', 'sc-heading sc-heading-bowl').text('Bowling');
  const bowlTable = d3el.append('table').attr('class', 'sc-table');
  bowlTable.append('thead').append('tr').html(
    '<th>Bowler</th><th>O</th><th>R</th><th>W</th><th>ER</th>'
  );
  const bowlBody = bowlTable.append('tbody');

  inn.bowlersOrdered.forEach(name => {
    const bw = inn.bowlers[name];
    if (!bw || bw.balls === 0) return;
    const ovStr = `${Math.floor(bw.balls / 6)}${bw.balls % 6 ? '.' + (bw.balls % 6) : ''}`;
    const er = bw.balls > 0 ? (bw.runsConceded / (bw.balls / 6)).toFixed(1) : '–';
    const tr = bowlBody.append('tr');
    tr.append('td').attr('class', 'sc-name').text(shortName(name));
    tr.append('td').attr('class', 'sc-num sc-dim').text(ovStr);
    tr.append('td').attr('class', 'sc-num sc-dim').text(bw.runsConceded);
    tr.append('td').attr('class', 'sc-num').attr('style', bw.wickets ? `color:${teamColor}` : '').text(bw.wickets);
    tr.append('td').attr('class', 'sc-num sc-dim').text(er);
  });
}

function dismissalAbbr(kind) {
  if (!kind) return '';
  const k = kind.toLowerCase();
  if (k.includes('bowled'))    return 'b.';
  if (k.includes('caught'))    return 'c.';
  if (k.includes('lbw') || k.includes('leg before')) return 'lbw';
  if (k.includes('run out'))   return 'run out';
  if (k.includes('stumped'))   return 'st.';
  if (k.includes('hit wicket')) return 'hit wkt';
  if (k.includes('retired'))   return 'retired';
  return kind.toLowerCase();
}

function computePartnerships(inn) {
  const parts = [];
  if (!inn.deliveries.length) return parts;

  let curKey = null, startX = 0, runs = 0, cumPts = [];
  let b1 = null, b2 = null;

  const flush = (endX) => {
    parts.push({ b1, b2, startX, endX, runs, cumPts, overs: endX - startX });
  };

  for (const d of inn.deliveries) {
    const names = [d.batter, d.nonStriker].sort();
    const key   = names.join('|');
    if (key !== curKey) {
      if (curKey !== null) flush(d.x);
      curKey = key; b1 = names[0]; b2 = names[1];
      startX = d.x; runs = 0; cumPts = [];
    }
    runs += d.batRuns;
    cumPts.push({ x: d.x, y: runs });
  }

  const last = inn.deliveries[inn.deliveries.length - 1];
  if (curKey !== null) flush(last.x);

  return parts;
}

/* ── wicket connector lines (bowler W → worm W → batter W) ────────── */
function drawWicketConnectors(root, inn, xS, bYS, wYS, batYS) {
  inn.wicketEvents.forEach(evt => {
    const px = xS(evt.x);
    const batter = inn.batters[evt.batterName];

    /* top: bowler W marker position in root-g coords */
    const y1 = BOWLER_TOP  + bYS(evt.bowlerRuns);
    /* bottom: batter W marker position in root-g coords */
    const y2 = BATTER_TOP  + batYS(batter ? batter.personalRuns : 0);

    /* one continuous dashed vertical from bowler panel to batter panel */
    root.append('line').attr('class', 'wicket-vline')
      .attr('x1', px).attr('x2', px)
      .attr('y1', y1).attr('y2', y2);
  });
}

/* ── axes ─────────────────────────────────────────────────────────── */
function drawAxes(root, inn, xS, wYS, bYS, batYS) {
  /* x axis — at the bottom of the batter panel */
  root.append('g').attr('class', 'x-axis')
    .attr('transform', `translate(0,${BATTER_TOP + BATTER_H})`)
    .call(
      d3.axisBottom(xS)
        .ticks(Math.min(Math.ceil(inn.maxOvers / 10), 16))
        .tickFormat(d => d)
    );

  /* cumulative runs (left y axis, worm panel) */
  root.append('g').attr('class', 'y-axis')
    .attr('transform', `translate(0,${WORM_TOP})`)
    .call(d3.axisLeft(wYS).ticks(8));

  /* bowler runs (left y axis, bowler panel) */
  root.append('g').attr('class', 'y-axis y-bowler')
    .attr('transform', `translate(0,${BOWLER_TOP})`)
    .call(d3.axisLeft(bYS).ticks(4));

  /* personal runs (left y axis, batter panel) */
  root.append('g').attr('class', 'y-axis y-batter')
    .attr('transform', `translate(0,${BATTER_TOP})`)
    .call(d3.axisLeft(batYS).ticks(4));

  /* axis labels */
  root.append('text').attr('class', 'axis-label')
    .attr('x', CONTENT_W / 2)
    .attr('y', BATTER_TOP + BATTER_H + 36)
    .attr('text-anchor', 'middle')
    .text('Overs');

  /* Worm panel y-axis label */
  root.append('text').attr('class', 'axis-label')
    .attr('transform', 'rotate(-90)')
    .attr('x', -(WORM_TOP + WORM_H / 2))
    .attr('y', -46)
    .attr('text-anchor', 'middle')
    .text('Runs');

  /* Bowler panel y-axis label */
  root.append('text').attr('class', 'axis-label')
    .attr('transform', 'rotate(-90)')
    .attr('x', -(BOWLER_TOP + BOWLER_H / 2))
    .attr('y', -46)
    .attr('text-anchor', 'middle')
    .text('Runs conceded');

  /* Batter panel y-axis label */
  root.append('text').attr('class', 'axis-label')
    .attr('transform', 'rotate(-90)')
    .attr('x', -(BATTER_TOP + BATTER_H / 2))
    .attr('y', -46)
    .attr('text-anchor', 'middle')
    .text('Personal runs');
}

/* ── hover / crosshair / tooltip ─────────────────────────────────── */
function setupHover(svg, root, inn, xS, wYS, bYS, batYS, teamColor, panelIdx, isTest = false) {
  const ttEl = document.getElementById('tooltip');

  /* vertical crosshair spanning all three panels */
  const crosshair = root.append('line').attr('class', 'crosshair')
    .attr('y1', 0).attr('y2', TOTAL_CONTENT_H);

  /* invisible overlay rect covering all three panels */
  root.append('rect')
    .attr('width', CONTENT_W).attr('height', TOTAL_CONTENT_H)
    .attr('fill', 'none').attr('pointer-events', 'all')
    .on('mousemove', function(event) {
      if (event.buttons !== 0) return;   // suppress hover during pan drag
      const [mx] = d3.pointer(event);
      const overVal = xS.invert(Math.max(0, mx));
      const bisect  = d3.bisector(d => d.x).left;
      const idx     = Math.min(bisect(inn.deliveries, overVal), inn.deliveries.length - 1);
      const d       = inn.deliveries[idx];
      if (!d) return;

      crosshair.attr('x1', xS(d.x)).attr('x2', xS(d.x)).style('opacity', 0.8);

      renderTooltip(ttEl, d, inn, teamColor, event, isTest);
    })
    .on('mouseleave', () => {
      crosshair.style('opacity', 0);
      ttEl.style.display = 'none';
    });
}

/* ── zoom / pan (viewBox-based) ───────────────────────────────────── */
function setupZoom(svg) {
  const W = +svg.attr('width');
  const H = +svg.attr('height');
  let vx = 0, vy = 0, vw = W, vh = H;

  svg.attr('viewBox', `0 0 ${W} ${H}`).style('cursor', 'crosshair');

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function applyViewBox() {
    svg.attr('viewBox', `${vx} ${vy} ${vw} ${vh}`);
  }

  /* ── wheel to zoom ──────────────────────────────────────────────── */
  svg.node().addEventListener('wheel', event => {
    event.preventDefault();
    const factor   = event.deltaY > 0 ? 1.15 : 1 / 1.15;
    const rect     = svg.node().getBoundingClientRect();
    // Mouse position in SVG content coordinates
    const mx = (event.clientX - rect.left)  / rect.width  * vw + vx;
    const my = (event.clientY - rect.top)   / rect.height * vh + vy;

    const newVw = clamp(vw * factor, W / 30, W);
    const newVh = clamp(vh * factor, H / 30, H);
    vx = clamp(mx - (mx - vx) * newVw / vw, 0, W - newVw);
    vy = clamp(my - (my - vy) * newVh / vh, 0, H - newVh);
    vw = newVw;
    vh = newVh;
    applyViewBox();
  }, { passive: false });

  /* ── drag to pan ────────────────────────────────────────────────── */
  let dragStart = null;

  svg.on('mousedown.pan', event => {
    if (event.button !== 0) return;
    dragStart = { cx: event.clientX, cy: event.clientY, vx, vy, vw, vh };
    svg.style('cursor', 'grabbing');
  });

  svg.on('mousemove.pan', event => {
    if (!dragStart) return;
    const rect = svg.node().getBoundingClientRect();
    const dx   = (event.clientX - dragStart.cx) / rect.width  * dragStart.vw;
    const dy   = (event.clientY - dragStart.cy) / rect.height * dragStart.vh;
    vx = clamp(dragStart.vx - dx, 0, W - vw);
    vy = clamp(dragStart.vy - dy, 0, H - vh);
    applyViewBox();
  });

  svg.on('mouseup.pan mouseleave.pan', () => {
    dragStart = null;
    svg.style('cursor', 'crosshair');
  });

  /* double-click to reset */
  svg.on('dblclick.zoom', () => {
    vx = 0; vy = 0; vw = W; vh = H;
    applyViewBox();
  });
}

function renderTooltip(el, d, inn, teamColor, event, isTest = false) {
  const batter    = inn.batters[d.batter];
  const nonStrike = inn.batters[d.nonStriker];
  const bowler    = inn.bowlers[d.bowler];

  const batterSR   = d.batterBalls    > 0 ? (d.batterRuns    / d.batterBalls    * 100).toFixed(1) : '–';
  const nonSR      = d.nonStrikerBalls > 0 ? (d.nonStrikerRuns / d.nonStrikerBalls * 100).toFixed(1) : '–';
  const bowlerEco  = d.bowlerBalls    > 0 ? (d.bowlerRunsNow / d.bowlerBalls    * 6).toFixed(2)   : '–';
  const teamRR     = d.x > 0 ? (d.y / d.x).toFixed(2) : '–';

  const oc  = SERIES[batter?.colorIdx    % SERIES.length] ?? teamColor;
  const noc = SERIES[nonStrike?.colorIdx % SERIES.length] ?? '#888';
  const bc  = SERIES[bowler?.colorIdx    % SERIES.length] ?? '#888';

  const requiredHtml = inn.target != null ? (() => {
    const req          = inn.target - d.y;
    const remO         = inn.maxOvers - d.x;
    /* Final chase = explicitly 'Target' (Test 4th inn), OR any target in a non-Test match */
    const isFinalChase = inn.targetLabel === 'Target' || (!isTest && inn.target != null);

    if (req <= 0) {
      if (isFinalChase) {
        return `<div class="tooltip-row" style="color:#22c55e;margin-top:2px">
          <span class="tooltip-label">Required</span>
          <span class="tooltip-val">&#10003; Won</span>
        </div>`;
      }
      /* intermediate innings — show first-innings lead instead of 'won' */
      const lead = 1 - req;   /* d.y − (target−1) = d.y − prevInningsTotal */
      return `<div class="tooltip-row" style="color:#22c55e;margin-top:2px">
        <span class="tooltip-label">Lead</span>
        <span class="tooltip-val">+${lead}</span>
      </div>`;
    }

    /* still chasing — show RRR only for limited-overs final chase */
    const rrr      = (remO > 0 && isFinalChase) ? ` · RRR ${(req / remO).toFixed(2)}` : '';
    const rowLabel = isFinalChase ? 'Required' : 'Deficit';
    return `<div class="tooltip-row" style="color:${WICKET_COL};margin-top:2px">
      <span class="tooltip-label">${rowLabel}</span>
      <span class="tooltip-val">${req}${rrr}</span>
    </div>`;
  })() : '';

  el.innerHTML = `
    <div class="tooltip-over">
      Over ${formatOver(d.x)} &nbsp;·&nbsp; ${d.y}/${d.wickets} &nbsp;·&nbsp; RR ${teamRR}
    </div>
    ${requiredHtml}
    <hr class="tooltip-sep">
    <div class="tooltip-section-label">Batting${(() => {
      const p = inn._partnerships?.find(p => d.x >= p.startX && d.x <= p.endX);
      return p != null ? ` · Partnership: ${p.runs} (${fmtOv(p.overs)})` : '';
    })()}</div>
    <div class="tooltip-row">
      <span class="tooltip-label"><span class="tt-dot" style="background:${oc}"></span>${shortName(d.batter)}*</span>
      <span class="tooltip-val">${d.batterRuns} (${d.batterBalls}b) SR ${batterSR}</span>
    </div>
    ${nonStrike ? `<div class="tooltip-row">
      <span class="tooltip-label"><span class="tt-dot" style="background:${noc}"></span>${shortName(d.nonStriker)}</span>
      <span class="tooltip-val">${d.nonStrikerRuns} (${d.nonStrikerBalls}b) SR ${nonSR}</span>
    </div>` : ''}
    ${(() => {
      if (!d.isWicket) return '';
      const wEvt = inn.wicketEvents.find(e => e.x === d.x);
      if (!wEvt) return '';
      const kind = wEvt.kind ? wEvt.kind.charAt(0).toUpperCase() + wEvt.kind.slice(1).toLowerCase() : 'Out';
      return `<div class="tooltip-row" style="color:${WICKET_COL};font-weight:600;margin-top:3px">
        <span class="tooltip-label">W</span>
        <span class="tooltip-val">${esc(wEvt.batterName)} — ${esc(kind)}</span>
      </div>`;
    })()}
    <hr class="tooltip-sep">
    <div class="tooltip-section-label">Bowling</div>
    <div class="tooltip-row">
      <span class="tooltip-label"><span class="tt-dot" style="background:${bc}"></span>${shortName(d.bowler)}</span>
      <span class="tooltip-val">${d.bowlerRunsNow}/${d.bowlerWicketsNow} · ER ${bowlerEco}</span>
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

/**
 * Deconflict label y-positions so they don't overlap.
 * Labels is [{x, y, anchor, color, text}].  y is SVG coords (0 = top).
 * Sorts by y, runs a forward pass (push down) then a backward pass (pull up)
 * to spread bunched labels, then clamps to [yMin, yMax].
 */
function deconflictLabels(labels, minGap = 11, yMin = 4, yMax = Infinity) {
  if (labels.length < 2) return labels;
  labels.sort((a, b) => a.y - b.y);

  for (let i = 1; i < labels.length; i++) {
    if (labels[i].y < labels[i - 1].y + minGap) {
      labels[i].y = labels[i - 1].y + minGap;
    }
  }
  for (let i = labels.length - 2; i >= 0; i--) {
    if (labels[i].y > labels[i + 1].y - minGap) {
      labels[i].y = labels[i + 1].y - minGap;
    }
  }
  labels.forEach(l => { l.y = Math.max(yMin, Math.min(yMax, l.y)); });
  return labels;
}

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

/* like segmentByStrike but for personalRuns coords in the batter panel */
function segmentByOnStrike(data) {
  const segs = [];
  let cur    = null;
  for (const pt of data) {
    if (!cur || cur.onStrike !== pt.onStrike) {
      if (cur) segs.push(cur);
      cur = { onStrike: pt.onStrike, pts: [] };
      if (segs.length > 0) {
        const prev = segs[segs.length - 1];
        cur.pts.push({ ...prev.pts[prev.pts.length - 1] });
      }
    }
    cur.pts.push({ x: pt.x, personalRuns: pt.personalRuns });
  }
  if (cur) segs.push(cur);
  return segs;
}

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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

/* Format a fractional-overs span as "N.B ov" (e.g. 3.4 ov) */
function fmtOv(span) {
  if (span == null || span <= 0) return '0 ov';
  const totalBalls = Math.round(span * 6);
  const overs = Math.floor(totalBalls / 6);
  const balls = totalBalls % 6;
  return balls === 0 ? `${overs} ov` : `${overs}.${balls} ov`;
}

function ordinal(n) {
  return n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
}
