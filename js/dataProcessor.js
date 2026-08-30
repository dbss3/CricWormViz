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
  return {
    matchInfo: {
      teams:     raw.info.teams,
      matchType: raw.info.match_type,
      venue:     raw.info.venue,
      dates:     raw.info.dates,
      outcome:   raw.info.outcome,
      players:   raw.info.players,
    },
    innings: raw.innings.map(processInnings),
  };
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
