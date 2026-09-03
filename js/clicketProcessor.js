/**
 * clicketProcessor.js
 * Converts Clicket! simulated-cricket game data → the internal innings format
 * used by wormChart.js.
 *
 * Clicket API: https://clicket-game.com/api
 *   GET /game/{id}  → { homeTeam, awayTeam, log: [...], fbattingCard, sbattingCard, ... }
 *
 * Each log entry with tag="ball-comm" has:
 *   label  "O.B: BowlerName to BatterName..."
 *   value  "·" | "1" | "2" | "3" | "4" | "6" | "W" | "Wd" | "Nb"
 *   desc   narrative text (contains dismissal type on wickets)
 */

export async function loadClicketMatch(gameId) {
  const data = await get(`/clicket/game/${gameId}`);

  const innings = parseInnings(data);
  computeTargets(innings);

  const status     = data.status ?? 'played';
  const isLive     = status === 'live' || status === 'in_progress';
  const homeScore  = data.bfRuns  != null ? `${data.bfRuns}/${data.bfWickets}` : '';
  const awayScore  = data.bsRuns  != null ? `${data.bsRuns}/${data.bsWickets}` : '';

  return {
    matchInfo: {
      teams:     [innings[0]?.team ?? data.homeTeam, innings[1]?.team ?? data.awayTeam],
      matchType: `Clicket! Season ${data.season ?? '?'}, Match ${data.match ?? gameId}`,
      venue:     'Simulated',
      dates:     [],
      outcome:   data.result ?? (status === 'played' ? 'Complete' : status),
    },
    innings,
    isLive,
    matchId: `clicket_${gameId}`,
  };
}

/* ── innings parsing ──────────────────────────────────────────────────────── */

function parseInnings(data) {
  const log = data.log ?? [];

  /* Split log into innings at innings-comm boundaries */
  const groups = [];
  let current  = [];

  for (const entry of log) {
    if (entry.tag === 'innings-comm') {
      if (current.length) { groups.push(current); current = []; }
    } else if (entry.tag === 'ball-comm') {
      current.push(entry);
    }
  }
  if (current.length) groups.push(current);

  /* Determine team names for each innings from batting cards */
  const inn1Names = new Set((data.fbattingCard ?? []).map(p => p.player).filter(Boolean));
  const inn2Names = new Set((data.sbattingCard ?? []).map(p => p.player).filter(Boolean));

  const teamForInnings = (balls) => {
    /* Check first few batters against the batting cards */
    const firstBatters = balls.slice(0, 6).map(b => parseBallLabel(b.label).batter);
    const matchesF = firstBatters.filter(n => inn1Names.has(n)).length;
    const matchesS = firstBatters.filter(n => inn2Names.has(n)).length;
    if (matchesF >= matchesS) return 'batting-first';
    return 'batting-second';
  };

  return groups.map((balls, idx) => {
    /* Guess team name from batting cards */
    const side     = groups.length === 1 || idx === 0
      ? teamForInnings(balls)
      : (teamForInnings(groups[0]) === 'batting-first' ? 'batting-second' : 'batting-first');
    const teamName = side === 'batting-first' ? data.homeTeam : data.awayTeam;

    return buildInnings(balls, idx, teamName, data);
  });
}

function buildInnings(balls, idx, teamName, data) {
  const batterMap    = {};
  const bowlerMap    = {};
  const wicketEvents = [];
  const battingOrder = [];
  const bowlingOrder = [];
  const deliveries   = [];

  let cumRuns     = 0;
  let wicketCount = 0;

  /* Pre-compute who is the non-striker on each ball */
  const nonStrikers = computeNonStrikers(balls);

  for (let bi = 0; bi < balls.length; bi++) {
    const ball = balls[bi];
    const { x, bowler, batter } = parseBallLabel(ball.label);
    if (x < 0) continue;

    const nonStriker = nonStrikers[bi] ?? '';

    const value      = ball.value ?? '·';
    const isWide     = value === 'Wd' || value === 'wd';
    const isNoBall   = value === 'Nb' || value === 'nb';
    const isIllegal  = isWide || isNoBall;
    const isWicket   = value === 'W';
    const runs       = parseValue(value);

    cumRuns += runs;

    /* Init striker */
    if (!batterMap[batter]) {
      battingOrder.push(batter);
      batterMap[batter] = mkBatter(batter, battingOrder.length - 1, x, cumRuns - runs);
    }
    /* Init non-striker (if known and new) */
    if (nonStriker && !batterMap[nonStriker]) {
      battingOrder.push(nonStriker);
      batterMap[nonStriker] = mkBatter(nonStriker, battingOrder.length - 1, x, cumRuns - runs);
    }
    /* Init bowler */
    if (!bowlerMap[bowler]) {
      bowlingOrder.push(bowler);
      bowlerMap[bowler] = mkBowler(bowler, bowlingOrder.length - 1);
    }

    /* Update striker */
    if (!isIllegal) batterMap[batter].balls += 1;
    const batRunsThisBall = isWicket || isIllegal ? 0 : runs;
    batterMap[batter].personalRuns += batRunsThisBall;

    batterMap[batter].data.push({
      x,
      y:        batterMap[batter].entryY + batterMap[batter].personalRuns,
      onStrike: true,
    });

    /* Add off-strike data point for non-striker (score unchanged this ball) */
    if (nonStriker && batterMap[nonStriker]) {
      batterMap[nonStriker].data.push({
        x,
        y:        batterMap[nonStriker].entryY + batterMap[nonStriker].personalRuns,
        onStrike: false,
      });
    }

    /* Update bowler */
    bowlerMap[bowler].runsConceded += runs;
    if (!isIllegal) bowlerMap[bowler].balls += 1;
    bowlerMap[bowler].data.push({ x, runs: bowlerMap[bowler].runsConceded });

    /* Wicket */
    if (isWicket) {
      const kind = parseDismissalKind(ball.desc ?? '');
      batterMap[batter].dismissed     = true;
      batterMap[batter].dismissalX    = x;
      batterMap[batter].dismissalKind = kind;
      wicketCount++;

      const bowlerCredit = !/run.?out|retired|obstruct/i.test(kind);
      if (bowlerCredit) {
        bowlerMap[bowler].wickets++;
        bowlerMap[bowler].wicketMarkers.push({ x, runs: bowlerMap[bowler].runsConceded });
      }

      wicketEvents.push({
        x, batterName: batter, bowlerName: bowler, kind,
        teamRuns: cumRuns, bowlerRuns: bowlerMap[bowler].runsConceded,
      });
    }

    const ns = batterMap[nonStriker];
    deliveries.push({
      x, y: cumRuns, wickets: wicketCount,
      batter, nonStriker, bowler,
      batRuns: batRunsThisBall, extraRuns: isIllegal ? runs : 0,
      isLegal: !isIllegal, isWicket,
      batterRuns:       batterMap[batter].personalRuns,
      batterBalls:      batterMap[batter].balls,
      nonStrikerRuns:   ns?.personalRuns ?? 0,
      nonStrikerBalls:  ns?.balls        ?? 0,
      bowlerRunsNow:    bowlerMap[bowler].runsConceded,
      bowlerBalls:      bowlerMap[bowler].balls,
      bowlerWicketsNow: bowlerMap[bowler].wickets,
    });
  }

  const last = deliveries.at(-1);
  return {
    idx,
    team:           teamName,
    deliveries,
    batters:        batterMap,
    battersOrdered: battingOrder,
    bowlers:        bowlerMap,
    bowlersOrdered: bowlingOrder,
    wicketEvents,
    maxOvers:       Math.ceil(last?.x ?? 1),
    maxRuns:        cumRuns,
    maxBowlerRuns:  Math.max(...Object.values(bowlerMap).map(b => b.runsConceded), 1),
    totalWickets:   wicketCount,
  };
}

/* ── non-striker tracking ─────────────────────────────────────────────────── */

/*
 * For each ball, work out who is the non-striker.
 * We maintain an "at crease" pair: the striker is whoever the label names;
 * the non-striker is the other person currently at crease.
 *
 * Edge case: the opening non-striker is unknown until they first face a ball.
 * After the pass we backfill those leading unknowns with the first name we see.
 */
function computeNonStrikers(balls) {
  const result  = new Array(balls.length).fill('');
  const atCrease = [];   // ordered list, max 2: [oldest, newest arrival]

  for (let i = 0; i < balls.length; i++) {
    const { batter } = parseBallLabel(balls[i].label);
    const isWicket   = balls[i].value === 'W';

    if (batter && batter !== '?' && !atCrease.includes(batter)) {
      atCrease.push(batter);
      if (atCrease.length > 2) atCrease.splice(0, 1); // keep newest 2
    }

    result[i] = atCrease.find(b => b !== batter) ?? '';

    if (isWicket) {
      const idx = atCrease.indexOf(batter);
      if (idx >= 0) atCrease.splice(idx, 1);
    }
  }

  /* Backfill empty slots: wherever ns is unknown, look ahead for the next
   * ball where a *different* batter is on strike — that person is at crease
   * as non-striker right now (new batter walking in, or opener not yet faced). */
  for (let i = 0; i < result.length; i++) {
    if (result[i] !== '') continue;
    const { batter } = parseBallLabel(balls[i].label);
    for (let j = i + 1; j < balls.length; j++) {
      const { batter: b2 } = parseBallLabel(balls[j].label);
      if (b2 && b2 !== '?' && b2 !== batter) { result[i] = b2; break; }
    }
  }

  return result;
}

/* ── label parsing ────────────────────────────────────────────────────────── */

function parseBallLabel(label) {
  /* "0.1: Ron Looking to Nandy Woman..." → { x, bowler, batter } */
  try {
    const colonIdx = label.indexOf(':');
    if (colonIdx < 0) return { x: -1, bowler: '?', batter: '?' };
    const overBall = label.slice(0, colonIdx).trim();
    const rest     = label.slice(colonIdx + 2).replace(/\.{2,}$/, '').trim();

    const [overStr, ballStr] = overBall.split('.');
    const over = parseInt(overStr, 10);
    const ball = parseInt(ballStr, 10);
    const x    = over + (ball > 0 ? ball / 6 : 0);

    const toIdx = rest.indexOf(' to ');
    if (toIdx < 0) return { x, bowler: rest, batter: '?' };

    const bowler = rest.slice(0, toIdx).trim();
    const batter = rest.slice(toIdx + 4).trim();
    return { x, bowler, batter };
  } catch {
    return { x: -1, bowler: '?', batter: '?' };
  }
}

function parseValue(value) {
  if (!value || value === '·') return 0;
  if (value === 'W')           return 0;
  if (value === 'Wd' || value === 'wd') return 1;
  if (value === 'Nb' || value === 'nb') return 1;
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

function parseDismissalKind(desc) {
  const d = desc.toLowerCase();
  if (d.includes('run out'))  return 'Run out';
  if (d.includes('stumped'))  return 'Stumped';
  if (d.includes('caught'))   return 'Caught';
  if (d.includes('bowled'))   return 'Bowled';
  if (d.includes('lbw'))      return 'LBW';
  if (d.includes('hit wicket')) return 'Hit wicket';
  return 'Out';
}

/* ── target computation ───────────────────────────────────────────────────── */

function computeTargets(innings) {
  const attach = (inn, target) => {
    if (target < 1) return;
    inn.target          = target;
    inn.targetLabel     = 'Target';
    inn.requiredRunRate = inn.maxOvers > 0 ? target / inn.maxOvers : null;
  };
  if (innings.length >= 2) attach(innings[1], innings[0].maxRuns + 1);
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function mkBatter(name, colorIdx, entryX, entryY) {
  return {
    name, colorIdx, entryX, entryY: Math.max(0, entryY),
    personalRuns: 0, balls: 0, data: [],
    dismissed: false, dismissalX: null, dismissalKind: null,
  };
}

function mkBowler(name, colorIdx) {
  return { name, colorIdx, runsConceded: 0, balls: 0, wickets: 0, data: [], wicketMarkers: [] };
}

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${path}`);
  return r.json();
}
