#!/usr/bin/env node
/* ============================================================================
   FEED RACE — ESPN vs MLB StatsAPI
   ----------------------------------------------------------------------------
   Answers, with data instead of vibes:
     1. LATENCY   — when a run scores / the count changes, which feed sees it
                    first, and by how many seconds?
     2. CACHE TTL — how often does each feed ACTUALLY change? If ESPN returns
                    byte-identical JSON for 30s, that's its cache floor and
                    polling faster than that is pointless.
     3. RICHNESS  — does StatsAPI carry live state (count / runners / current
                    at-bat) that ESPN's scoreboard doesn't?

   WHY NOT JUST WATCH TWO APPS: that measures app rendering + push behaviour,
   not feed latency. This hits both endpoints from the same machine at the same
   moment, with no browser and no CORS proxy in the way. Pure feed-to-feed.

   USAGE:
     node feed-race.js                 → auto-picks a live MLB game
     node feed-race.js 776543          → track a specific MLB gamePk
     node feed-race.js --secs 2        → poll interval (default 3s)
     node feed-race.js --mins 20       → how long to run (default 15)

   Run it on your Windows box (needs Node 18+, which has fetch built in).
   Ctrl-C any time; it prints the summary on exit.
   ========================================================================== */

const args = process.argv.slice(2);
const argVal = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const POLL_SECS = parseFloat(argVal('--secs', 3));
const RUN_MINS  = parseFloat(argVal('--mins', 15));
const FORCED_PK = args.find(a => /^\d+$/.test(a)) || null;

const ESPN_SB   = 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard';
const STATS_SB  = 'https://statsapi.mlb.com/api/v1/schedule?sportId=1';
const STATS_GAME = pk => `https://statsapi.mlb.com/api/v1.1/game/${pk}/feed/live`;

const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(7) + 's';

// ── state we diff against ────────────────────────────────────────────────────
let lastEspn = null, lastStats = null;
let espnChanges = 0, statsChanges = 0;
let espnPolls = 0, statsPolls = 0;
let espnIdenticalRun = 0, statsIdenticalRun = 0;
let espnMaxIdentical = 0, statsMaxIdentical = 0;
const events = [];   // { at, feed, desc }

// ── pull the interesting bits out of each feed ───────────────────────────────
function espnDigest(json, teamAbbr) {
  const ev = (json.events || []).find(e =>
    (e.competitions?.[0]?.competitors || []).some(c => c.team?.abbreviation === teamAbbr));
  if (!ev) return null;
  const comp = ev.competitions[0];
  const away = comp.competitors.find(c => c.homeAway === 'away') || {};
  const home = comp.competitors.find(c => c.homeAway === 'home') || {};
  const sit  = comp.situation || {};
  return {
    score: `${away.team?.abbreviation} ${away.score} - ${home.score} ${home.team?.abbreviation}`,
    state: ev.status?.type?.state,
    label: ev.status?.type?.shortDetail,
    // ESPN's scoreboard situation is coarse — this is the point of comparison
    count: (sit.balls != null) ? `${sit.balls}-${sit.strikes}, ${sit.outs} out` : '(none)',
    onBase: [sit.onFirst && '1B', sit.onSecond && '2B', sit.onThird && '3B'].filter(Boolean).join(',') || '—',
  };
}

function statsDigest(json) {
  const ls = json.liveData?.linescore || {};
  const plays = json.liveData?.plays || {};
  const cur = plays.currentPlay || {};
  const cnt = cur.count || {};
  const off = ls.offense || {};
  return {
    score: `${json.gameData?.teams?.away?.abbreviation} ${ls.teams?.away?.runs ?? 0} - ${ls.teams?.home?.runs ?? 0} ${json.gameData?.teams?.home?.abbreviation}`,
    state: json.gameData?.status?.abstractGameState,
    label: `${ls.inningState || ''} ${ls.currentInningOrdinal || ''}`.trim(),
    count: (cnt.balls != null) ? `${cnt.balls}-${cnt.strikes}, ${cnt.outs} out` : '(none)',
    onBase: [off.first && '1B', off.second && '2B', off.third && '3B'].filter(Boolean).join(',') || '—',
    // richness StatsAPI has that ESPN's scoreboard does NOT:
    atBat: cur.matchup?.batter?.fullName || null,
    pitcher: cur.matchup?.pitcher?.fullName || null,
    lastPlay: cur.result?.description || null,
  };
}

const key = d => d ? `${d.score}|${d.label}|${d.count}|${d.onBase}` : '';

// ── find a live game ─────────────────────────────────────────────────────────
async function findLiveGame() {
  if (FORCED_PK) return { pk: FORCED_PK, abbr: null };
  const j = await (await fetch(STATS_SB)).json();
  const games = (j.dates?.[0]?.games) || [];
  const live = games.find(g => g.status?.abstractGameState === 'Live');
  if (!live) {
    const any = games[0];
    if (!any) throw new Error('No MLB games on the schedule today.');
    console.log('⚠  No LIVE game right now — tracking the first scheduled game so you can still see cache behaviour.');
    return { pk: any.gamePk, abbr: any.teams?.home?.team?.abbreviation };
  }
  return { pk: live.gamePk, abbr: live.teams?.home?.team?.abbreviation };
}

// ── main loop ────────────────────────────────────────────────────────────────

/* ============================================================================
   MEDIA DISCOVERY MODE  —  node feed-race.js --media
   ----------------------------------------------------------------------------
   Answers the question that decides whether we ever need Twitter:
   "Does MLB's own API expose a playable highlight clip per big play, and how
    fast does it appear after the play happens?"

   Mike's example: Ben Rice's late-game triple — official MLB posted it to X
   within MINUTES. X has no free read API, so it's off the table. But if MLB's
   OWN feed carries the same clip on a similar timeline, we get the latency win
   with no Twitter at all.

   This mode dumps EVERY media surface MLB exposes for a game, so we can see
   exactly what's available and in what form:
     • liveData.plays.allPlays[].playEvents[]  → does a scoring play carry media?
     • the game "content" endpoint             → highlights.highlights.items[]
       (this is where MLB's cut highlight clips live: title, description,
        duration, and playbacks[] with direct .mp4 URLs at several bitrates)
     • how OLD each highlight is vs. when the play actually happened (the
       latency number we actually care about)
     • whether the playback URLs are plain .mp4 (no player, no ads) or an
       HLS/DAI stream (which is where ad-insertion would live)

   ADS: Mike has YouTube Premium so YT is clean, but MLB is an unknown. The tell
   is the URL shape — a bare .mp4 on mlb-cuts-diamond.mlb.com is just a file and
   cannot carry a pre-roll. An HLS manifest routed through a DAI/ad-stitching
   host is a different story. This prints the raw URLs so we can SEE which it is.
   ========================================================================== */
async function mediaDiscovery(pk) {
  const CONTENT = `https://statsapi.mlb.com/api/v1/game/${pk}/content`;

  console.log('═'.repeat(78));
  console.log(`MEDIA DISCOVERY — gamePk ${pk}`);
  console.log('═'.repeat(78));

  // ── 1. the content endpoint: MLB's cut highlights ──────────────────────────
  let content;
  try {
    content = await (await fetch(CONTENT)).json();
  } catch (e) {
    console.log('content endpoint failed:', e.message);
    return;
  }

  const items = content?.highlights?.highlights?.items
             || content?.highlights?.live?.items
             || [];

  console.log(`\nHIGHLIGHT CLIPS FOUND: ${items.length}`);
  if (!items.length) {
    console.log('(none yet — run this DURING or just after a game with scoring)');
  }

  const now = Date.now();
  items.slice(0, 12).forEach((it, i) => {
    const title = it.headline || it.title || '(untitled)';
    const dur   = it.duration || '?';
    const when  = it.date || it.timestamp;
    const ageMin = when ? ((now - new Date(when).getTime()) / 60000).toFixed(1) : '?';

    // playbacks[] holds the actual media URLs, several renditions
    const pb = it.playbacks || [];
    const mp4s = pb.filter(p => /\.mp4/i.test(p.url || ''));
    const hls  = pb.filter(p => /\.m3u8/i.test(p.url || ''));

    console.log(`\n  [${i + 1}] ${title.slice(0, 62)}`);
    console.log(`      duration: ${dur}   posted: ${ageMin} min ago`);
    console.log(`      renditions: ${pb.length}  (mp4: ${mp4s.length}, hls: ${hls.length})`);
    if (mp4s.length) {
      const best = mp4s[mp4s.length - 1];
      console.log(`      ✅ DIRECT MP4: ${(best.url || '').slice(0, 90)}`);
      console.log(`         → a bare .mp4 file. No player, NO PRE-ROLL possible.`);
    }
    if (hls.length && !mp4s.length) {
      console.log(`      ⚠  HLS ONLY: ${(hls[0].url || '').slice(0, 90)}`);
      console.log(`         → manifest-based; check host for ad-stitching (DAI).`);
    }
    // keywords tell us what KIND of play it is — useful for matching a clip to a Brain moment
    const kw = (it.keywordsAll || it.keywords || []).map(k => k.value || k.displayName).filter(Boolean);
    if (kw.length) console.log(`      keywords: ${kw.slice(0, 8).join(', ')}`);
  });

  // ── 2. can we tie a clip to a SPECIFIC play? (the takeover use-case) ───────
  console.log('\n' + '─'.repeat(78));
  console.log('PLAY → CLIP LINKAGE (can a Brain moment fetch ITS clip?)');
  console.log('─'.repeat(78));
  try {
    const live = await (await fetch(`https://statsapi.mlb.com/api/v1.1/game/${pk}/feed/live`)).json();
    const scoring = (live.liveData?.plays?.scoringPlays || []);
    const all = live.liveData?.plays?.allPlays || [];
    console.log(`scoring plays in this game: ${scoring.length}`);

    // MLB tags highlight items with the playId / guid of the play they came from
    const withGuid = items.filter(it => (it.guid || it.mediaPlaybackId));
    console.log(`highlights carrying a guid/playbackId: ${withGuid.length} of ${items.length}`);

    scoring.slice(-3).forEach(idx => {
      const p = all[idx];
      if (!p) return;
      const desc = p.result?.description || '';
      const playAt = p.about?.endTime;
      const lagMin = playAt ? ((now - new Date(playAt).getTime()) / 60000).toFixed(1) : '?';
      console.log(`\n  PLAY: ${desc.slice(0, 66)}`);
      console.log(`        happened ${lagMin} min ago`);
      // try to find a highlight whose headline mentions the batter
      const batter = p.matchup?.batter?.lastName || p.matchup?.batter?.fullName || '';
      const match = items.find(it => batter && (it.headline || '').includes(batter));
      console.log(match
        ? `        ✅ MATCHING CLIP: "${(match.headline || '').slice(0, 54)}"`
        : `        ✗  no clip yet for this play`);
    });
  } catch (e) {
    console.log('live feed failed:', e.message);
  }

  console.log('\n' + '═'.repeat(78));
  console.log('WHAT TO LOOK FOR:');
  console.log('  1. Do clips appear within MINUTES of the play? → replaces Twitter entirely.');
  console.log('  2. Are the URLs bare .mp4? → no ads possible, drop straight into a <video>.');
  console.log('  3. Can a clip be matched to a specific play? → the Brain can fetch ITS clip');
  console.log('     for a takeover (Rice triple → that exact triple, seconds later).');
  console.log('═'.repeat(78));
  process.exit(0);
}

(async () => {
  const { pk, abbr } = await findLiveGame();

  // ── --media : dump every media surface MLB exposes, then exit ──────────────
  if (args.includes('--media')) { await mediaDiscovery(pk); return; }


  // resolve the team abbr from StatsAPI so we can find the same game in ESPN
  let teamAbbr = abbr;
  if (!teamAbbr) {
    const g = await (await fetch(STATS_GAME(pk))).json();
    teamAbbr = g.gameData?.teams?.home?.abbreviation;
  }

  console.log('═'.repeat(78));
  console.log(`FEED RACE — MLB gamePk ${pk} (${teamAbbr})`);
  console.log(`polling every ${POLL_SECS}s for ${RUN_MINS} min · started ${new Date().toLocaleTimeString()}`);
  console.log('═'.repeat(78));
  console.log('Watching for: score changes, count changes, inning changes, FINAL flip.');
  console.log('');

  const deadline = Date.now() + RUN_MINS * 60000;

  const poll = async () => {
    const now = Date.now();

    // fire both in parallel so neither gets a head start
    const [espnRes, statsRes] = await Promise.allSettled([
      fetch(ESPN_SB).then(r => r.json()),
      fetch(STATS_GAME(pk)).then(r => r.json()),
    ]);

    if (espnRes.status === 'fulfilled') {
      espnPolls++;
      const d = espnDigest(espnRes.value, teamAbbr);
      const k = key(d);
      if (d && k !== key(lastEspn)) {
        espnChanges++;
        espnMaxIdentical = Math.max(espnMaxIdentical, espnIdenticalRun);
        espnIdenticalRun = 0;
        events.push({ at: now, feed: 'ESPN ', d });
        console.log(`${stamp()}  ESPN   ${d.score.padEnd(18)} ${String(d.label).padEnd(12)} ${d.count.padEnd(14)} on:${d.onBase}`);
        lastEspn = d;
      } else espnIdenticalRun++;
    }

    if (statsRes.status === 'fulfilled') {
      statsPolls++;
      const d = statsDigest(statsRes.value);
      const k = key(d);
      if (k !== key(lastStats)) {
        statsChanges++;
        statsMaxIdentical = Math.max(statsMaxIdentical, statsIdenticalRun);
        statsIdenticalRun = 0;
        events.push({ at: now, feed: 'STATS', d });
        console.log(`${stamp()}  STATS  ${d.score.padEnd(18)} ${String(d.label).padEnd(12)} ${d.count.padEnd(14)} on:${d.onBase}` +
                    (d.atBat ? `  AB:${d.atBat}` : ''));
        lastStats = d;
      } else statsIdenticalRun++;
    }

    if (Date.now() < deadline) setTimeout(poll, POLL_SECS * 1000);
    else summary();
  };

  // ── summary ────────────────────────────────────────────────────────────────
  function summary() {
    console.log('');
    console.log('═'.repeat(78));
    console.log('SUMMARY');
    console.log('═'.repeat(78));
    console.log(`ESPN  : ${espnPolls} polls, ${espnChanges} changes.  Longest identical run: ${espnMaxIdentical} polls (~${(espnMaxIdentical*POLL_SECS).toFixed(0)}s)`);
    console.log(`STATS : ${statsPolls} polls, ${statsChanges} changes.  Longest identical run: ${statsMaxIdentical} polls (~${(statsMaxIdentical*POLL_SECS).toFixed(0)}s)`);
    console.log('');
    console.log('→ The "longest identical run" is each feed\'s effective CACHE FLOOR.');
    console.log('  Polling faster than that returns the same bytes and buys you nothing.');
    console.log('');

    // pair up score changes to measure latency
    const scoreEvents = events.filter((e, i) => {
      const prev = events.slice(0, i).reverse().find(p => p.feed === e.feed);
      return !prev || prev.d.score !== e.d.score;
    });
    const espnScores  = scoreEvents.filter(e => e.feed === 'ESPN ');
    const statsScores = scoreEvents.filter(e => e.feed === 'STATS');

    console.log('SCORE-CHANGE LATENCY (who saw each run first):');
    if (!espnScores.length && !statsScores.length) {
      console.log('  (no runs scored during the run — try again during a busier stretch)');
    } else {
      statsScores.forEach(se => {
        const match = espnScores.find(ee => ee.d.score === se.d.score);
        if (match) {
          const delta = (match.at - se.at) / 1000;
          const who = delta > 0 ? `StatsAPI FIRST by ${delta.toFixed(1)}s`
                    : delta < 0 ? `ESPN FIRST by ${(-delta).toFixed(1)}s`
                    : 'tie';
          console.log(`  ${se.d.score.padEnd(20)} → ${who}`);
        }
      });
    }
    console.log('');
    console.log('RICHNESS: does StatsAPI carry live state ESPN\'s scoreboard lacks?');
    const lastS = events.filter(e => e.feed === 'STATS').pop();
    if (lastS) {
      console.log(`  StatsAPI at-bat : ${lastS.d.atBat || '(none)'}`);
      console.log(`  StatsAPI pitcher: ${lastS.d.pitcher || '(none)'}`);
      console.log(`  StatsAPI lastPlay: ${(lastS.d.lastPlay || '(none)').slice(0, 60)}`);
      console.log('  → If these are populated, AB/P + B/S/O come FREE from StatsAPI.');
    }
    process.exit(0);
  }

  process.on('SIGINT', summary);
  poll();
})();
