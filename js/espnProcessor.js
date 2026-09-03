/**
 * espnProcessor.js
 * Converts ESPN sports API data → the same internal format as dataProcessor.js
 * so wormChart.js can render it without changes.
 *
 * Server endpoints (via server.py):
 *   GET /espn/live                         → active match list
 *   GET /espn/match/{leagueId}/{eventId}   → match info
 *   GET /espn/commentary/{leagueId}/{eventId} → all deliveries (flat, oldest first)
 */

export async function loadESPNMatch(matchId) {
  /* matchId is "{leagueId}_{eventId}" */
  const [leagueId, eventId] = matchId.split('_');

  const [info, commentary] = await Promise.all([
    get(`/espn/match/${leagueId}/${eventId}`),
    get(`/espn/commentary/${leagueId}/${eventId}`),
  ]);

  const items = commentary.items ?? [];
  if (!items.length) {
    throw new Error(
      `ESPN does not provide ball-by-ball data for this match (${info.homeTeam} v ${info.awayTeam}). ` +
      `Only matches flagged as "Play-by-Play Available" can be visualised.`
    );
  }
  const inningsData = buildAllInnings(items, info);
  computeTargets(inningsData);

  return {
    matchInfo: {
      teams:     [info.homeTeam, info.awayTeam],
      matchType: info.league ?? 'Cricket',
      venue:     info.venue ?? '',
      dates:     [],
      outcome:   info.statusText ?? '',
    },
    innings: inningsData,
    isLive:  info.isLive ?? false,
    matchId,
  };
}

/* ── innings parsing ──────────────────────────────────────────────────────── */

function buildAllInnings(items, matchInfo) {
  if (!items.length) return [];

  /* Group items by innings.number */
  const innMap = new Map();
  for (const item of items) {
    const innNum = item.innings?.number ?? 1;
    if (!innMap.has(innNum)) innMap.set(innNum, []);
    innMap.get(innNum).push(item);
  }

  const inningsData = [];
  for (const [innNum, balls] of [...innMap.entries()].sort((a, b) => a[0] - b[0])) {
    const inn = buildInnings(balls, innNum, inningsData.length, matchInfo);
    if (inn) inningsData.push(inn);
  }
  return inningsData;
}

function buildInnings(balls, innNum, idx, matchInfo) {
  if (!balls.length) return null;

  const batterMap    = {};
  const bowlerMap    = {};
  const wicketEvents = [];
  const battingOrder = [];
  const bowlingOrder = [];
  const deliveries   = [];

  let cumRuns    = 0;
  let wicketCount = 0;

  /* Determine batting team from first ball's batsman.team.id */
  const firstBall     = balls[0];
  const battingTeamId = firstBall?.batsman?.team?.id ?? '';
  const battingTeam   = firstBall?.batsman?.team?.displayName
    ?? (battingTeamId === matchInfo.homeId ? matchInfo.homeTeam : matchInfo.awayTeam)
    ?? `Team ${idx + 1}`;

  for (const ball of balls) {
    /* ── x position (fractional over) ────────────────────────────────── */
    const actual = ball.over?.actual ?? 0;
    /* ESPN format: O.B  (0.1 = over 0, ball 1)  → x = O + B/6 */
    const overNum = Math.floor(actual);
    const ballNum = Math.round((actual - overNum) * 10);  // 1-6
    const x = overNum + (ballNum > 0 ? ballNum / 6 : 0);

    /* ── player names ─────────────────────────────────────────────────── */
    const batter      = ball.batsman?.athlete?.displayName    ?? '?';
    const nonStriker  = ball.otherBatsman?.athlete?.displayName ?? '';
    const bowler      = ball.bowler?.athlete?.displayName     ?? '?';

    /* ── runs ─────────────────────────────────────────────────────────── */
    const runsOnBall = ball.scoreValue ?? 0;
    cumRuns += runsOnBall;

    /* Batter's personal total from ESPN snapshot (cumulative) */
    const batterTotal = ball.batsman?.totalRuns ?? 0;
    const batterBalls = ball.batsman?.faced     ?? 0;

    /* Bowler's totals from ESPN snapshot */
    const bowlerConceded = ball.bowler?.conceded ?? 0;
    const bowlerBallsFaced = oversToLegal(ball.bowler?.overs ?? 0);
    const bowlerWkts       = ball.bowler?.wickets ?? 0;

    /* ── is legal delivery (not wide/no-ball)? ───────────────────────── */
    const playDesc = (ball.playType?.description ?? '').toLowerCase();
    const isWide   = playDesc.includes('wide');
    const isNoBall = playDesc.includes('no ball') || playDesc.includes('no-ball');
    const isIllegal = isWide || isNoBall;

    /* ── init batter/bowler entries ───────────────────────────────────── */
    if (!batterMap[batter]) {
      battingOrder.push(batter);
      batterMap[batter] = mkBatter(batter, battingOrder.length - 1, x, cumRuns - batterTotal);
    }
    if (nonStriker && !batterMap[nonStriker]) {
      battingOrder.push(nonStriker);
      const nsTotal = ball.otherBatsman?.totalRuns ?? 0;
      batterMap[nonStriker] = mkBatter(nonStriker, battingOrder.length - 1, x, cumRuns - nsTotal);
    }
    if (!bowlerMap[bowler]) {
      bowlingOrder.push(bowler);
      bowlerMap[bowler] = mkBowler(bowler, bowlingOrder.length - 1);
    }

    /* ── update batter from snapshot ─────────────────────────────────── */
    batterMap[batter].personalRuns = batterTotal;
    if (!isIllegal) batterMap[batter].balls = batterBalls;

    batterMap[batter].data.push({
      x,
      y: batterMap[batter].entryY + batterTotal,
      onStrike: true,
    });
    if (nonStriker && batterMap[nonStriker]) {
      const nsTotal = ball.otherBatsman?.totalRuns ?? batterMap[nonStriker].personalRuns;
      batterMap[nonStriker].personalRuns = nsTotal;
      batterMap[nonStriker].data.push({
        x,
        y: batterMap[nonStriker].entryY + nsTotal,
        onStrike: false,
      });
    }

    /* ── update bowler from snapshot ─────────────────────────────────── */
    bowlerMap[bowler].runsConceded = bowlerConceded;
    bowlerMap[bowler].balls        = bowlerBallsFaced;
    bowlerMap[bowler].wickets      = bowlerWkts;
    bowlerMap[bowler].data.push({ x, runs: bowlerConceded });

    /* ── wicket ────────────────────────────────────────────────────────── */
    let isWicket = false;
    const dism = ball.dismissal ?? {};
    if (dism.dismissal === true) {
      const playerOut = dism.batsman?.athlete?.displayName
        ?? ball.batsman?.athlete?.displayName
        ?? batter;
      const kind = dism.type ?? 'out';

      if (batterMap[playerOut]) {
        batterMap[playerOut].dismissed     = true;
        batterMap[playerOut].dismissalX    = x;
        batterMap[playerOut].dismissalKind = kind;
      }
      wicketCount++;
      isWicket = true;

      const bowlerCredit = !/run.?out|retired|obstruct/i.test(kind);
      if (bowlerCredit) {
        bowlerMap[bowler].wicketMarkers.push({ x, runs: bowlerConceded });
      }

      wicketEvents.push({
        x, batterName: playerOut, bowlerName: bowler, kind,
        teamRuns: cumRuns, bowlerRuns: bowlerConceded,
      });
    }

    const batRunsThisBall = ball.batsman?.runs ?? runsOnBall;

    deliveries.push({
      x,
      y:       cumRuns,
      wickets: wicketCount,
      batter,
      nonStriker,
      bowler,
      batRuns:    batRunsThisBall,
      extraRuns:  Math.max(0, runsOnBall - batRunsThisBall),
      isLegal:    !isIllegal,
      isWicket,
      batterRuns:       batterTotal,
      batterBalls:      batterBalls,
      nonStrikerRuns:   nonStriker ? (batterMap[nonStriker]?.personalRuns ?? 0) : 0,
      nonStrikerBalls:  nonStriker ? (ball.otherBatsman?.faced ?? 0) : 0,
      bowlerRunsNow:    bowlerConceded,
      bowlerBalls:      bowlerBallsFaced,
      bowlerWicketsNow: bowlerWkts,
    });
  }

  const last = deliveries.at(-1);
  return {
    idx,
    team:           battingTeam,
    deliveries,
    batters:        batterMap,
    battersOrdered: battingOrder,
    bowlers:        bowlerMap,
    bowlersOrdered: bowlingOrder,
    wicketEvents,
    maxOvers:      Math.ceil(last?.x ?? 1),
    maxRuns:       cumRuns,
    maxBowlerRuns: Math.max(...Object.values(bowlerMap).map(b => b.runsConceded), 1),
    totalWickets:  wicketCount,
  };
}

/* ── target computation (same as dataProcessor.js) ───────────────────────── */

function computeTargets(innings) {
  const attach = (inn, target, label) => {
    if (target < 1) return;
    inn.target          = target;
    inn.targetLabel     = label;
    inn.requiredRunRate = inn.maxOvers > 0 ? target / inn.maxOvers : null;
  };
  if (innings.length >= 2) attach(innings[1], innings[0].maxRuns + 1, 'Lead target');
  if (innings.length >= 3) {
    const i3  = innings[2];
    const def = i3.team === innings[0].team
      ? innings[1].maxRuns - innings[0].maxRuns
      : innings[0].maxRuns - innings[1].maxRuns;
    attach(i3, def + 1, 'Deficit');
  }
  if (innings.length >= 4) {
    const chaser     = innings.at(-1).team;
    const setterTotal = innings.filter(i => i.team !== chaser).reduce((s, i) => s + i.maxRuns, 0);
    const chaserPrev  = innings.slice(0, -1).filter(i => i.team === chaser).reduce((s, i) => s + i.maxRuns, 0);
    attach(innings.at(-1), setterTotal - chaserPrev + 1, 'Target');
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

function oversToLegal(oversVal) {
  /* ESPN stores overs as O.B (e.g., 3.4 = 3 complete overs + 4 balls) */
  const str = String(oversVal);
  const [o = 0, b = 0] = str.split('.').map(Number);
  return o * 6 + b;
}

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${path}`);
  return r.json();
}

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
