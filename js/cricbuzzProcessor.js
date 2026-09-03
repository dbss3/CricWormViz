/**
 * cricbuzzProcessor.js
 * Converts Cricbuzz commentary JSON → the same internal format as
 * dataProcessor.js so wormChart.js can render it without changes.
 *
 * Server endpoints (via server.py):
 *   GET /cricbuzz/match/{id}                   → match info
 *   GET /cricbuzz/commentary/{id}/{inningsId}   → all balls for one innings
 */

export async function loadCricbuzzMatch(matchId) {
  /* 1 — match info (team names, innings count, status) */
  const info      = await get(`/cricbuzz/match/${matchId}`);
  const matchMeta = parseMeta(info, matchId);

  /* 2 — fetch each innings */
  const inningsData = [];
  for (const innInfo of matchMeta.inningsList) {
    const raw = await get(`/cricbuzz/commentary/${matchId}/${innInfo.inningsId}`);
    const balls = raw.commentaryList ?? [];
    if (!balls.length) continue;

    const inn = buildInnings(balls, innInfo, inningsData.length);
    if (inn) inningsData.push(inn);
  }

  computeTargets(inningsData);

  return {
    matchInfo: {
      teams:     matchMeta.teams,
      matchType: matchMeta.matchType,
      venue:     matchMeta.venue,
      dates:     matchMeta.dates,
      outcome:   matchMeta.outcome,
    },
    innings: inningsData,
    isLive:  matchMeta.isLive,
    matchId,
  };
}

/* ── meta extraction ──────────────────────────────────────────────────── */

function parseMeta(data, matchId) {
  /* Cricbuzz match-info shape:
     { matchInfo: { team1: {teamName}, team2: {teamName}, matchFormat, state,
                    venueInfo: {ground}, startDate, result: {resultType} },
       matchScore: { team1Score: { inngs1: {inningsId,...}, inngs2? },
                     team2Score: { inngs1: {inningsId,...}, inngs2? } } } */

  const mi = data?.matchInfo ?? data?.match?.matchInfo ?? data;

  const t1     = mi?.team1?.teamName ?? mi?.team1?.longName ?? "Team 1";
  const t2     = mi?.team2?.teamName ?? mi?.team2?.longName ?? "Team 2";
  const format = mi?.matchFormat ?? mi?.seriesMatchInfo?.matchType ?? "MATCH";
  const state  = mi?.state ?? mi?.status ?? "";
  const isLive = /progress|live/i.test(state);
  const venue  = mi?.venueInfo?.ground ?? mi?.ground ?? "";
  const dates  = [mi?.startDate].filter(Boolean);
  const outcome= mi?.result?.resultType ?? mi?.result?.winningTeam ?? state;

  /* Collect innings IDs from matchScore */
  const ms = data?.matchScore ?? {};
  const inningsList = [];
  const push = (teamName, scoreObj) => {
    if (!scoreObj) return;
    for (const key of ["inngs1", "inngs2"]) {
      const inn = scoreObj[key];
      if (inn?.inningsId != null) {
        inningsList.push({ inningsId: inn.inningsId, team: teamName });
      }
    }
  };
  push(t1, ms.team1Score);
  push(t2, ms.team2Score);

  /* Sort by inningsId so innings come out in chronological order */
  inningsList.sort((a, b) => a.inningsId - b.inningsId);

  /* Fallback: if matchScore is absent assume at least 1 innings */
  if (!inningsList.length) {
    inningsList.push({ inningsId: 1, team: t1 });
  }

  return { teams: [t1, t2], matchType: format, venue, dates, outcome, isLive, inningsList };
}

/* ── innings processing ───────────────────────────────────────────────── */

function buildInnings(balls, innInfo, idx) {
  if (!balls.length) return null;

  const batterMap    = {};
  const bowlerMap    = {};
  const wicketEvents = [];
  const battingOrder = [];
  const bowlingOrder = [];
  const deliveries   = [];

  let cumRuns    = 0;
  let wicketCount = 0;

  for (const ball of balls) {
    /* ── x position ─────────────────────────────────────────────── */
    const over  = ball.overNum  ?? ball.over  ?? 0;
    const bnum  = ball.ball     ?? ball.ballNbr ?? 1;
    const x     = parseInt(over) + parseInt(bnum) / 6;

    /* ── batters ─────────────────────────────────────────────────── */
    /* Cricbuzz puts current batter stats in each ball's batsman1/2 */
    const b1info = ball.batsman1 ?? {};
    const b2info = ball.batsman2 ?? {};
    const batter     = b1info.batName ?? ball.batsmanName ?? "?";
    const nonStriker = b2info.batName ?? ball.nonStrikerName ?? "";

    /* ── bowler ──────────────────────────────────────────────────── */
    const bwlInfo = ball.bowler1 ?? ball.bowler ?? {};
    const bowler  = bwlInfo.bowlName ?? ball.bowlerName ?? "?";

    /* ── runs ────────────────────────────────────────────────────── */
    const score     = ball.score ?? {};
    const newTotal  = score.runs ?? cumRuns;
    const batRuns   = b1info.batRuns != null
      ? b1info.batRuns - (batterMap[batter]?.personalRuns ?? 0)
      : parseInt(ball.event === "FOUR" ? 4 : ball.event === "SIX" ? 6 : 0);
    const totalRuns = newTotal - cumRuns;
    const extraRuns = Math.max(0, totalRuns - batRuns);

    /* ── legal delivery? ─────────────────────────────────────────── */
    const evt      = (ball.event ?? "").toUpperCase();
    const isWide   = evt === "WIDE"   || ball.isWide;
    const isNoBall = evt === "NO_BALL"|| ball.isNoBall;
    const isIllegal = isWide || isNoBall;

    const prevCumRuns = cumRuns;
    cumRuns = newTotal;

    /* ── init entries ────────────────────────────────────────────── */
    if (!batterMap[batter]) {
      battingOrder.push(batter);
      batterMap[batter] = mkBatter(batter, battingOrder.length - 1, x, prevCumRuns);
    }
    if (nonStriker && !batterMap[nonStriker]) {
      battingOrder.push(nonStriker);
      batterMap[nonStriker] = mkBatter(nonStriker, battingOrder.length - 1, x, prevCumRuns);
    }
    if (!bowlerMap[bowler]) {
      bowlingOrder.push(bowler);
      bowlerMap[bowler] = mkBowler(bowler, bowlingOrder.length - 1);
    }

    /* ── sync batter personal runs from Cricbuzz snapshot ────────── */
    /* Cricbuzz's batsman1.batRuns IS the cumulative total, so we use
       it directly rather than incrementing — it's more reliable. */
    batterMap[batter].personalRuns = b1info.batRuns ?? batterMap[batter].personalRuns;
    if (!isIllegal) batterMap[batter].balls = b1info.batBalls ?? batterMap[batter].balls + 1;

    batterMap[batter].data.push({
      x, y: batterMap[batter].entryY + batterMap[batter].personalRuns, onStrike: true,
    });
    if (nonStriker && batterMap[nonStriker]) {
      batterMap[nonStriker].data.push({
        x, y: batterMap[nonStriker].entryY + batterMap[nonStriker].personalRuns, onStrike: false,
      });
    }

    /* ── bowler stats ────────────────────────────────────────────── */
    const bowlerRunsNow = bwlInfo.bowlRuns ?? bowlerMap[bowler].runsConceded;
    const bowlerBalls   = oversToLegal(bwlInfo.bowlOvers ?? "0");
    bowlerMap[bowler].runsConceded = bowlerRunsNow;
    bowlerMap[bowler].balls        = bowlerBalls;
    bowlerMap[bowler].data.push({ x, runs: bowlerRunsNow });

    /* ── wicket ──────────────────────────────────────────────────── */
    let isWicket = false;
    if (evt === "WICKET" || ball.isWicket || ball.wicket) {
      const wi  = ball.wicket ?? {};
      const playerOut = wi.player?.longName ?? wi.batsman?.batName ?? batter;
      const kind      = wi.dismissalType ?? wi.type ?? "out";
      const bowlerCredit = !/run.?out|retired|obstruct/i.test(kind);

      if (batterMap[playerOut]) {
        batterMap[playerOut].dismissed    = true;
        batterMap[playerOut].dismissalX   = x;
        batterMap[playerOut].dismissalKind = kind;
      }
      wicketCount++;
      isWicket = true;

      if (bowlerCredit) {
        bowlerMap[bowler].wickets++;
        bowlerMap[bowler].wicketMarkers.push({ x, runs: bowlerRunsNow });
      }

      wicketEvents.push({
        x, batterName: playerOut, bowlerName: bowler, kind,
        teamRuns: cumRuns, bowlerRuns: bowlerRunsNow,
      });
    }

    deliveries.push({
      x, y: cumRuns, wickets: wicketCount,
      batter, nonStriker, bowler,
      batRuns, extraRuns,
      isLegal: !isIllegal, isWicket,
      batterRuns:       batterMap[batter].personalRuns,
      batterBalls:      batterMap[batter].balls,
      nonStrikerRuns:   nonStriker ? (batterMap[nonStriker]?.personalRuns ?? 0) : 0,
      nonStrikerBalls:  nonStriker ? (batterMap[nonStriker]?.balls        ?? 0) : 0,
      bowlerRunsNow,
      bowlerBalls,
      bowlerWicketsNow: bowlerMap[bowler].wickets,
    });
  }

  const last = deliveries.at(-1);
  return {
    idx,
    team:           innInfo.team,
    deliveries,
    batters:        batterMap,
    battersOrdered: battingOrder,
    bowlers:        bowlerMap,
    bowlersOrdered: bowlingOrder,
    wicketEvents,
    maxOvers:     Math.ceil(last?.x ?? 1),
    maxRuns:      cumRuns,
    maxBowlerRuns: Math.max(...Object.values(bowlerMap).map(b => b.runsConceded), 1),
    totalWickets: wicketCount,
  };
}

/* ── target computation (identical to dataProcessor.js) ──────────────── */

function computeTargets(innings) {
  const attach = (inn, target, label) => {
    if (target < 1) return;
    inn.target          = target;
    inn.targetLabel     = label;
    inn.requiredRunRate = inn.maxOvers > 0 ? target / inn.maxOvers : null;
  };
  if (innings.length >= 2) attach(innings[1], innings[0].maxRuns + 1, 'Lead target');
  if (innings.length >= 3) {
    const i3 = innings[2];
    const def = i3.team === innings[0].team
      ? innings[1].maxRuns - innings[0].maxRuns
      : innings[0].maxRuns - innings[1].maxRuns;
    attach(i3, def + 1, 'Deficit');
  }
  if (innings.length >= 4) {
    const chaser = innings.at(-1).team;
    const setterTotal = innings.filter(i => i.team !== chaser).reduce((s, i) => s + i.maxRuns, 0);
    const chaserPrev  = innings.slice(0, -1).filter(i => i.team === chaser).reduce((s, i) => s + i.maxRuns, 0);
    attach(innings.at(-1), setterTotal - chaserPrev + 1, 'Target');
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function oversToLegal(oversStr) {
  const [o = 0, b = 0] = String(oversStr).split('.').map(Number);
  return o * 6 + b;
}

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${path}`);
  return r.json();
}

function mkBatter(name, colorIdx, entryX, entryY) {
  return { name, colorIdx, entryX, entryY, personalRuns: 0, balls: 0, data: [],
           dismissed: false, dismissalX: null, dismissalKind: null };
}
function mkBowler(name, colorIdx) {
  return { name, colorIdx, runsConceded: 0, balls: 0, wickets: 0, data: [], wicketMarkers: [] };
}
