/**
 * espnProcessor.js
 * Calls the ESPN cricket API directly (CORS is open on site.web.api.espn.com).
 * Converts ball-by-ball commentary into the internal innings format for wormChart.js.
 */

const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports/cricket';

export async function loadESPNMatch(matchId) {
  const [leagueId, eventId] = matchId.split('_');

  /* Fetch page 1 to discover pageCount, then all remaining pages in parallel */
  const page1    = await espnGet(`/${leagueId}/playbyplay?event=${eventId}&page=1`);
  const comm1    = page1.commentary ?? {};
  const total    = comm1.pageCount ?? 1;
  const items1   = comm1.items ?? [];

  if (!items1.length && comm1.count === 0) {
    const info = await getMatchInfo(leagueId, eventId);
    throw new Error(
      `ESPN does not provide ball-by-ball data for this match` +
      (info ? ` (${info.homeTeam} v ${info.awayTeam})` : '') +
      `. Only matches with Play-by-Play available can be visualised.`
    );
  }

  /* Fetch remaining pages + match info in parallel */
  const pageNums = Array.from({ length: total - 1 }, (_, i) => i + 2);
  const [morePages, info] = await Promise.all([
    Promise.all(pageNums.map(p =>
      espnGet(`/${leagueId}/playbyplay?event=${eventId}&page=${p}`)
        .then(d => d.commentary?.items ?? [])
        .catch(() => [])
    )),
    getMatchInfo(leagueId, eventId),
  ]);

  const allItems = [...items1, ...morePages.flat()];

  /* Derive team names from ball data if scoreboard unavailable */
  const firstBall = allItems[0];
  const homeTeam  = info?.homeTeam ?? firstBall?.batsman?.team?.displayName  ?? 'Team 1';
  const awayTeam  = info?.awayTeam ?? firstBall?.bowler?.team?.displayName   ?? 'Team 2';
  const homeId    = info?.homeId   ?? firstBall?.batsman?.team?.id           ?? '';

  const matchInfo = { homeTeam, awayTeam, homeId };
  const inningsData = buildAllInnings(allItems, matchInfo);
  computeTargets(inningsData);

  return {
    matchInfo: {
      teams:     [homeTeam, awayTeam],
      matchType: info?.league  ?? 'Cricket',
      venue:     info?.venue   ?? '',
      dates:     [],
      outcome:   info?.statusText ?? '',
    },
    innings: inningsData,
    isLive:  info?.isLive ?? false,
    matchId,
  };
}

/* ── Fetch match info from today's scoreboard (falls back up to 14 days) ──── */

async function getMatchInfo(leagueId, eventId) {
  const today = new Date();
  const dates = Array.from({ length: 14 }, (_, d) => {
    const dt = new Date(today);
    dt.setDate(today.getDate() - d);
    return dt.toISOString().slice(0, 10).replace(/-/g, '');
  });

  const results = await Promise.all(dates.map(async dateStr => {
    try {
      const data = await espnGet(`/${leagueId}/scoreboard?dates=${dateStr}`);
      const lname = data.leagues?.[0]?.name ?? '';
      for (const evt of data.events ?? []) {
        if (String(evt.id) !== String(eventId)) continue;
        const comp  = evt.competitions?.[0] ?? {};
        const teams = comp.competitors ?? [];
        const home  = teams.find(t => t.homeAway === 'home') ?? teams[0] ?? {};
        const away  = teams.find(t => t.homeAway === 'away') ?? teams[1] ?? {};
        const st    = evt.status?.type ?? {};
        return {
          homeTeam:   home.team?.displayName ?? home.displayName ?? '',
          awayTeam:   away.team?.displayName ?? away.displayName ?? '',
          homeId:     home.id ?? '',
          isLive:     st.state === 'in',
          statusText: st.shortDetail ?? st.description ?? '',
          league:     lname,
          venue:      comp.venue?.fullName ?? '',
        };
      }
    } catch {}
    return null;
  }));

  return results.find(r => r != null) ?? null;
}

/* ── Innings parsing ───────────────────────────────────────────────────────── */

function buildAllInnings(items, matchInfo) {
  if (!items.length) return [];
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

  const firstBall     = balls[0];
  const battingTeamId = firstBall?.batsman?.team?.id ?? '';
  const battingTeam   = firstBall?.batsman?.team?.displayName
    ?? (battingTeamId === matchInfo.homeId ? matchInfo.homeTeam : matchInfo.awayTeam)
    ?? `Team ${idx + 1}`;

  for (const ball of balls) {
    const actual  = ball.over?.actual ?? 0;
    const overNum = Math.floor(actual);
    const ballNum = Math.round((actual - overNum) * 10);
    const x = overNum + (ballNum > 0 ? ballNum / 6 : 0);

    const batter     = ball.batsman?.athlete?.displayName    ?? '?';
    const nonStriker = ball.otherBatsman?.athlete?.displayName ?? '';
    const bowler     = ball.bowler?.athlete?.displayName     ?? '?';

    const runsOnBall    = ball.scoreValue ?? 0;
    cumRuns += runsOnBall;

    const batterTotal      = ball.batsman?.totalRuns  ?? 0;
    const batterBalls      = ball.batsman?.faced       ?? 0;
    const bowlerConceded   = ball.bowler?.conceded     ?? 0;
    const bowlerBallsFaced = oversToLegal(ball.bowler?.overs ?? 0);
    const bowlerWkts       = ball.bowler?.wickets      ?? 0;

    const playDesc  = (ball.playType?.description ?? '').toLowerCase();
    const isIllegal = playDesc.includes('wide') || playDesc.includes('no ball') || playDesc.includes('no-ball');

    if (!batterMap[batter]) {
      battingOrder.push(batter);
      batterMap[batter] = mkBatter(batter, battingOrder.length - 1, x, cumRuns - batterTotal);
    }
    if (nonStriker && !batterMap[nonStriker]) {
      battingOrder.push(nonStriker);
      batterMap[nonStriker] = mkBatter(nonStriker, battingOrder.length - 1, x,
        cumRuns - (ball.otherBatsman?.totalRuns ?? 0));
    }
    if (!bowlerMap[bowler]) {
      bowlingOrder.push(bowler);
      bowlerMap[bowler] = mkBowler(bowler, bowlingOrder.length - 1);
    }

    batterMap[batter].personalRuns = batterTotal;
    if (!isIllegal) batterMap[batter].balls = batterBalls;
    batterMap[batter].data.push({ x, y: batterMap[batter].entryY + batterTotal, onStrike: true });

    if (nonStriker && batterMap[nonStriker]) {
      const nsTotal = ball.otherBatsman?.totalRuns ?? batterMap[nonStriker].personalRuns;
      batterMap[nonStriker].personalRuns = nsTotal;
      batterMap[nonStriker].data.push({ x, y: batterMap[nonStriker].entryY + nsTotal, onStrike: false });
    }

    bowlerMap[bowler].runsConceded = bowlerConceded;
    bowlerMap[bowler].balls        = bowlerBallsFaced;
    bowlerMap[bowler].wickets      = bowlerWkts;
    bowlerMap[bowler].data.push({ x, runs: bowlerConceded });

    let isWicket = false;
    const dism = ball.dismissal ?? {};
    if (dism.dismissal === true) {
      const playerOut = dism.batsman?.athlete?.displayName ?? batter;
      const kind      = dism.type ?? 'out';
      if (batterMap[playerOut]) {
        batterMap[playerOut].dismissed     = true;
        batterMap[playerOut].dismissalX    = x;
        batterMap[playerOut].dismissalKind = kind;
      }
      wicketCount++;
      isWicket = true;
      if (!/run.?out|retired|obstruct/i.test(kind))
        bowlerMap[bowler].wicketMarkers.push({ x, runs: bowlerConceded });
      wicketEvents.push({ x, batterName: playerOut, bowlerName: bowler, kind,
        teamRuns: cumRuns, bowlerRuns: bowlerConceded });
    }

    const batRunsThisBall = ball.batsman?.runs ?? runsOnBall;
    deliveries.push({
      x, y: cumRuns, wickets: wicketCount,
      batter, nonStriker, bowler,
      batRuns:          batRunsThisBall,
      extraRuns:        Math.max(0, runsOnBall - batRunsThisBall),
      isLegal:          !isIllegal,
      isWicket,
      batterRuns:       batterTotal,
      batterBalls,
      nonStrikerRuns:   nonStriker ? (batterMap[nonStriker]?.personalRuns ?? 0) : 0,
      nonStrikerBalls:  nonStriker ? (ball.otherBatsman?.faced ?? 0) : 0,
      bowlerRunsNow:    bowlerConceded,
      bowlerBalls:      bowlerBallsFaced,
      bowlerWicketsNow: bowlerWkts,
    });
  }

  const last = deliveries.at(-1);
  return {
    idx, team: battingTeam, deliveries,
    batters: batterMap, battersOrdered: battingOrder,
    bowlers: bowlerMap, bowlersOrdered: bowlingOrder,
    wicketEvents,
    maxOvers:      Math.ceil(last?.x ?? 1),
    maxRuns:       cumRuns,
    maxBowlerRuns: Math.max(...Object.values(bowlerMap).map(b => b.runsConceded), 1),
    totalWickets:  wicketCount,
  };
}

/* ── Target computation ───────────────────────────────────────────────────── */

function computeTargets(innings) {
  const attach = (inn, target, label) => {
    if (target < 1) return;
    inn.target = target; inn.targetLabel = label;
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
    const chaser      = innings.at(-1).team;
    const setterTotal = innings.filter(i => i.team !== chaser).reduce((s, i) => s + i.maxRuns, 0);
    const chaserPrev  = innings.slice(0, -1).filter(i => i.team === chaser).reduce((s, i) => s + i.maxRuns, 0);
    attach(innings.at(-1), setterTotal - chaserPrev + 1, 'Target');
  }
}

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function oversToLegal(oversVal) {
  const [o = 0, b = 0] = String(oversVal).split('.').map(Number);
  return o * 6 + b;
}

async function espnGet(path) {
  const r = await fetch(ESPN + path);
  if (!r.ok) throw new Error(`ESPN API ${r.status}`);
  return r.json();
}

function mkBatter(name, colorIdx, entryX, entryY) {
  return { name, colorIdx, entryX, entryY: Math.max(0, entryY),
           personalRuns: 0, balls: 0, data: [],
           dismissed: false, dismissalX: null, dismissalKind: null };
}

function mkBowler(name, colorIdx) {
  return { name, colorIdx, runsConceded: 0, balls: 0, wickets: 0, data: [], wicketMarkers: [] };
}
