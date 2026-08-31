/**
 * dataProcessor.js
 * Converts raw Cricsheet JSON → viz-ready structures.
 *
 * Cricsheet format:
 *   info.teams, info.match_type, info.venue, info.dates, info.outcome
 *   innings[].team
 *   innings[].overs[].over          (0-indexed over number)
 *   innings[].overs[].deliveries[]
 *     .actual_delivery  "over.ball"  e.g. "18.6"
 *     .batter / .non_striker / .bowler
 *     .runs.batter / .runs.extras / .runs.total
 *     .extras.wides / .extras.noballs / .extras.byes / .extras.legbyes
 *     .wickets[].player_out / .kind / .fielders[]
 */

export function processMatch(raw) {
  const innings = raw.innings.map(processInnings);
  computeTargets(innings);
  return {
    matchInfo: {
      teams:     raw.info.teams,
      matchType: raw.info.match_type,
      venue:     raw.info.venue,
      dates:     raw.info.dates,
      outcome:   raw.info.outcome,
      players:   raw.info.players,
    },
    innings,
  };
}

/**
 * Attach `target`, `requiredRunRate`, and `targetLabel` to innings that are
 * chasing a total (required runs positive).
 *
 * Innings 2 — first-innings lead:
 *   Team B needs innings[0].runs + 1 to take lead.
 *
 * Innings 3 — erase deficit (only if the batting team trails):
 *   Triggered when innings[1] team leads after innings 1+2.
 *
 * Innings 4 — match target:
 *   target = setter's total across all innings − chaser's total so far + 1.
 *   Works for both standard (A-B-A-B) and follow-on (A-B-B-A) order because
 *   we group by team name rather than by index.
 */
function computeTargets(innings) {
  const attach = (inn, target, label) => {
    if (target < 1) return;
    inn.target          = target;
    inn.targetLabel     = label;
    inn.requiredRunRate = inn.maxOvers > 0 ? target / inn.maxOvers : null;
  };

  // ── Innings 2: first-innings lead ──────────────────────────────
  if (innings.length >= 2) {
    attach(innings[1], innings[0].maxRuns + 1, 'Lead target');
  }

  // ── Innings 3: erase deficit (if behind after 2 innings) ───────
  if (innings.length >= 3) {
    const inn3 = innings[2];
    // If same team as innings[0] (standard order): behind if inn2 > inn1
    // If same team as innings[1] (follow-on):      behind if inn1 > inn2 and they follow on
    const sameAsFirst = inn3.team === innings[0].team;
    const deficit = sameAsFirst
      ? innings[1].maxRuns - innings[0].maxRuns   // B's total − A's total
      : innings[0].maxRuns - innings[1].maxRuns;  // follow-on: A − B
    attach(inn3, deficit + 1, 'Deficit');
  }

  // ── Innings 4: match target ────────────────────────────────────
  if (innings.length >= 4) {
    const chaserTeam = innings[innings.length - 1].team;
    const setterTotal   = innings.filter(i => i.team !== chaserTeam)
                                 .reduce((s, i) => s + i.maxRuns, 0);
    const chaserPrevTotal = innings.slice(0, -1).filter(i => i.team === chaserTeam)
                                   .reduce((s, i) => s + i.maxRuns, 0);
    attach(innings[innings.length - 1], setterTotal - chaserPrevTotal + 1, 'Target');
  }
}

function processInnings(inn, idx) {
  const deliveries   = [];
  const batterMap    = {};
  const bowlerMap    = {};
  const wicketEvents = [];
  const battingOrder = [];
  const bowlingOrder = [];

  let cumRuns    = 0;
  let wicketCount = 0;

  for (const over of inn.overs) {
    for (const ball of over.deliveries) {

      /* ── x position ──────────────────────────────────────────── */
      const [overStr, ballStr] = ball.actual_delivery.split('.');
      const x = parseInt(overStr) + parseInt(ballStr) / 6;

      /* ── legal vs extra ──────────────────────────────────────── */
      const isWide   = !!(ball.extras?.wides);
      const isNoBall = !!(ball.extras?.noballs);
      const isIllegal = isWide || isNoBall;

      const prevCumRuns = cumRuns;
      cumRuns += ball.runs.total;

      const { batter, non_striker: nonStriker, bowler } = ball;

      /* ── init batter entries ─────────────────────────────────── */
      if (!batterMap[batter]) {
        battingOrder.push(batter);
        batterMap[batter] = mkBatter(batter, battingOrder.length - 1, x, prevCumRuns);
      }
      if (!batterMap[nonStriker]) {
        battingOrder.push(nonStriker);
        batterMap[nonStriker] = mkBatter(nonStriker, battingOrder.length - 1, x, prevCumRuns);
      }

      /* ── init bowler entries ─────────────────────────────────── */
      if (!bowlerMap[bowler]) {
        bowlingOrder.push(bowler);
        bowlerMap[bowler] = mkBowler(bowler, bowlingOrder.length - 1);
      }

      /* ── update striker ──────────────────────────────────────── */
      batterMap[batter].personalRuns += ball.runs.batter;
      if (!isIllegal) batterMap[batter].balls++;

      /* ── batter data points ──────────────────────────────────── */
      batterMap[batter].data.push({
        x,
        y:        batterMap[batter].entryY + batterMap[batter].personalRuns,
        onStrike: true,
      });
      batterMap[nonStriker].data.push({
        x,
        y:        batterMap[nonStriker].entryY + batterMap[nonStriker].personalRuns,
        onStrike: false,
      });

      /* ── update bowler ───────────────────────────────────────── */
      // Byes & leg-byes count to team total but NOT to bowler's figures
      const bowlerRuns = ball.runs.total
        - (ball.extras?.byes    || 0)
        - (ball.extras?.legbyes || 0);
      bowlerMap[bowler].runsConceded += bowlerRuns;
      if (!isWide) bowlerMap[bowler].balls++;

      /* ── wickets ─────────────────────────────────────────────── */
      let isWicket = false;
      if (ball.wickets) {
        for (const w of ball.wickets) {
          const bowlerCredit = !['run out', 'retired hurt', 'obstructing the field']
            .includes(w.kind);

          batterMap[w.player_out].dismissed   = true;
          batterMap[w.player_out].dismissalX  = x;
          batterMap[w.player_out].dismissalKind = w.kind;
          wicketCount++;
          isWicket = true;

          if (bowlerCredit) {
            bowlerMap[bowler].wickets++;
            bowlerMap[bowler].wicketMarkers.push({
              x,
              runs: bowlerMap[bowler].runsConceded,
            });
          }

          wicketEvents.push({
            x,
            batterName: w.player_out,
            bowlerName: bowler,
            kind:       w.kind,
            teamRuns:   cumRuns,
            bowlerRuns: bowlerMap[bowler].runsConceded,
          });
        }
      }

      bowlerMap[bowler].data.push({ x, runs: bowlerMap[bowler].runsConceded });

      /* ── delivery record (for main worm & tooltip) ───────────── */
      deliveries.push({
        x,
        y:         cumRuns,
        wickets:   wicketCount,
        batter,
        nonStriker,
        bowler,
        batRuns:   ball.runs.batter,
        extraRuns: ball.runs.extras,
        isLegal:   !isIllegal,
        isWicket,
        // running stats for tooltip (snapshot at this delivery)
        batterRuns:          batterMap[batter].personalRuns,
        batterBalls:         batterMap[batter].balls,
        nonStrikerRuns:      batterMap[nonStriker].personalRuns,
        nonStrikerBalls:     batterMap[nonStriker].balls,
        bowlerRunsNow:       bowlerMap[bowler].runsConceded,
        bowlerBalls:         bowlerMap[bowler].balls,
        bowlerWicketsNow:    bowlerMap[bowler].wickets,
      });
    }
  }

  /* ── derived extents ─────────────────────────────────────────── */
  const lastDelivery = deliveries[deliveries.length - 1];
  const maxOvers     = Math.ceil(lastDelivery?.x ?? 1);
  const maxRuns      = cumRuns;
  const maxBowlerRuns = Math.max(
    ...Object.values(bowlerMap).map(b => b.runsConceded), 1
  );

  return {
    idx,
    team:           inn.team,
    deliveries,
    batters:        batterMap,
    battersOrdered: battingOrder,
    bowlers:        bowlerMap,
    bowlersOrdered: bowlingOrder,
    wicketEvents,
    maxOvers,
    maxRuns,
    maxBowlerRuns,
    totalWickets:   wicketCount,
  };
}

/* ── helpers ─────────────────────────────────────────────────────── */

function mkBatter(name, colorIdx, entryX, entryY) {
  return {
    name, colorIdx,
    entryX, entryY,
    personalRuns: 0,
    balls:        0,
    data:         [],
    dismissed:    false,
    dismissalX:   null,
    dismissalKind: null,
  };
}

function mkBowler(name, colorIdx) {
  return {
    name, colorIdx,
    runsConceded:  0,
    balls:         0,
    wickets:       0,
    data:          [],
    wicketMarkers: [],
  };
}
