#!/usr/bin/env node
/**
 * Every test suite with the clock set to the moments that matter, not only to
 * the time of day someone happens to run them. The 2 Nov 2026 email did not
 * go out: two tests passed in the afternoon and failed at 1:58 AM, when the
 * email job ran them - and a failing test stops the send.
 *
 *   node scripts/test_time_travel.js                     # every suite, every moment
 *   node scripts/test_time_travel.js --list              # only print the moments
 *   node scripts/test_time_travel.js --suite daily_email # only this suite (repeatable)
 *   node scripts/test_time_travel.js 2026-11-03T06:58:00Z ...   # only these moments
 *
 * The moments: tomorrow and the day after at the email job's hours (it waits
 * for 1 AM; GitHub can start it hours late, up to the 5 AM cutoff) and the
 * morning window's edges (5 and 11 AM); the next two daylight-saving changes,
 * through the hour that is skipped or repeated; the season's edges (March 15,
 * November 15) and the new year. Always from now on, never back: the
 * repository's own readings are real and must not be newer than the clock.
 * The two suites that take minutes run at three of the moments.
 *
 * The clock moves for every process a suite starts: node through fakenow.js
 * (NODE_OPTIONS), `date` through a stand-in on PATH. The stand-in needs GNU
 * date, as on GitHub's runners - where there is none (a Mac), the shell
 * suites are skipped, and say so. Not moved: files' times and git's. TZ=UTC,
 * as on GitHub's runners.
 *
 * Two runs at a time by default - the email suite takes about 1 GB of memory;
 * TT_JOBS=4 where there is room.
 */
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const PRELOAD = path.join(__dirname, 'fakenow.js');
const JOBS = Math.max(1, Math.floor(Number(process.env.TT_JOBS)) || 2);
const RUN_LIMIT_MS = 20 * 60000;   // the camera suite alone takes minutes

// gate: the email job runs it before sending. few: minutes a run, so three moments.
const SUITES = [
  { name: 'daily_email',      cmd: ['node', 'scripts/test_daily_email.js'], gate: true },
  { name: 'send_window',      cmd: ['bash', 'scripts/test_send_window.sh'], gate: true, shell: true },
  { name: 'refresh_checkout', cmd: ['bash', 'scripts/test_refresh_checkout.sh'], gate: true, shell: true },
  // The "no report today" notice: what the email job sends when the three above fail.
  { name: 'send_notice',      cmd: ['node', 'scripts/test_send_notice.js'] },
  { name: 'map',              cmd: ['node', 'scripts/test_map.js'] },
  { name: 'offline',          cmd: ['node', 'scripts/test_offline.js'] },
  { name: 'site_theme',       cmd: ['node', 'scripts/test_site_theme.js'] },
  { name: 'hazard_map',       cmd: ['node', 'scripts/test_hazard_map.js'] },
  { name: 'pi_check',         cmd: ['node', 'camera/test_pi_check.js'] },
  { name: 'fetch_temp',       cmd: ['bash', 'scripts/test_fetch_temp.sh'], shell: true, few: true },
  // The new boathouse timelapse: the Worker's side and the Pi's, then the videos (real ffmpeg).
  { name: 'timelapse_web',    cmd: ['node', 'camera/test_timelapse_web.js'], few: true },
  { name: 'build_timelapse',  cmd: ['node', 'scripts/test_build_timelapse.js'], few: true },
  { name: 'newboathouse',     cmd: ['node', 'scripts/test_newboathouse.js'] },
  // heavy: real 1080p video through UDP - run with nothing else beside it, as
  // a busy machine drops packets the "clean" tests count.
  { name: 'snapshot_service', cmd: ['node', 'camera/test_snapshot_service.js'], few: true, heavy: true },
];

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function nyParts(ms) {
  const o = {};
  for (const p of NY.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return o;
}
/** Every moment that reads y-m-d h:mi in New York: none in the hour clocks skip, two in the hour they repeat. */
function ny(y, m, d, h, mi) {
  return [4, 5].map(off => Date.UTC(y, m - 1, d, h + off, mi)).filter(ms => {
    const p = nyParts(ms);
    return p.year === y && p.month === m && p.day === d && p.hour === h && p.minute === mi;
  });
}
const label = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short',
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function moments(now = Date.now()) {
  const today = nyParts(now);
  const dayPlus = (n) => {
    const t = new Date(Date.UTC(today.year, today.month - 1, today.day + n, 12));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  };
  const offset = ([y, m, d]) => nyParts(Date.UTC(y, m - 1, d, 12)).hour - 12;   // -4 EDT, -5 EST
  const out = new Set();
  const add = (ymd, hours) => { for (const [h, mi] of hours) for (const ms of ny(...ymd, h, mi)) out.add(ms); };

  const DAY = [[0, 30], [1, 0], [1, 58], [3, 0], [4, 30], [4, 59], [5, 0], [7, 0], [10, 59], [11, 0], [13, 0], [15, 0], [19, 0], [23, 30]];
  add(dayPlus(1), DAY);
  add(dayPlus(2), DAY);
  const CHANGE = [[0, 30], [1, 30], [2, 30], [3, 30], [5, 0], [7, 0], [11, 0], [15, 0]];
  let change = null;
  for (let n = 1, found = 0; n <= 400 && found < 2; n++) {
    if (offset(dayPlus(n)) !== offset(dayPlus(n - 1))) {
      add(dayPlus(n), CHANGE);
      if (!found) change = ny(...dayPlus(n), 1, 30).pop();   // in the autumn, the second 1:30
      found++;
    }
  }
  const next = (m, d) => { for (let n = 1; n <= 400; n++) { const t = dayPlus(n); if (t[1] === m && t[2] === d) return t; } return null; };
  for (const [m, d, h, mi] of [[3, 14, 23, 30], [3, 15, 1, 58], [11, 15, 23, 30], [11, 16, 1, 58], [12, 31, 23, 30], [1, 1, 1, 58]]) {
    const t = next(m, d);
    if (t) add(t, [[h, mi]]);
  }
  const all = [...out].filter(ms => ms > now).sort((a, b) => a - b);
  const few = [ny(...dayPlus(1), 1, 58)[0], ny(...dayPlus(1), 15, 0)[0], change].filter(ms => Number.isFinite(ms) && ms > now);
  return { all, few };
}

// `date`, moved: "now", and the times given relative to now ("-10 minutes",
// "tomorrow 01:00"). Times given in full ("2026-11-03 01:00", "@1793685480")
// and files' times are left as they are.
const REAL_DATE = (() => {
  const r = spawnSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
})();
const GNU_DATE = !!REAL_DATE && (spawnSync(REAL_DATE, ['-u', '-d', '@0', '+%Y'], { encoding: 'utf8' }).stdout || '').trim() === '1970';
const fakeDate = (real) => [
  '#!/bin/bash',
  '# date, moved by FAKE_OFFSET_MS (see test_time_travel.js)',
  "REAL='__REAL__'",
  'fake=$(( $("$REAL" +%s) + ${FAKE_OFFSET_MS:-0} / 1000 ))',
  'move() {',
  '  case "$1" in',
  '    @*|*[12][0-9][0-9][0-9]-[0-9]*|*[12][0-9][0-9][0-9]/[0-9]*) printf %s "$1" ;;',
  '    *[0-9]:[0-9]*|*[0-9][aApP][mM]*|*[0-9]\\ [aApP][mM]*) printf "%s %s" "$("$REAL" -d "@$fake" +%Y-%m-%d)" "$1" ;;',
  '    *) printf "%s %s" "$("$REAL" -u -d "@$fake" "+%Y-%m-%d %H:%M:%S UTC")" "$1" ;;',
  '  esac',
  '}',
  'args=(); given=0',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -d|--date) args+=("$1" "$(move "$2")"); given=1; shift 2 ;;',
  '    --date=*) args+=("--date=$(move "${1#--date=}")"); given=1; shift ;;',
  '    -d*) args+=(-d "$(move "${1#-d}")"); given=1; shift ;;',
  '    -r|--reference|-f|--file|-s|--set) args+=("$1" "$2"); given=1; shift 2 ;;',
  '    --reference=*|--file=*|--set=*|-r*|-f*|-s*) args+=("$1"); given=1; shift ;;',
  '    *) args+=("$1"); shift ;;',
  '  esac',
  'done',
  '[ "$given" = 1 ] && exec "$REAL" "${args[@]}"',
  'exec "$REAL" -d "@$fake" "${args[@]}"',
  '',
].join('\n').split('__REAL__').join(real);

function runOne(suite, ms) {
  const iso = isoOf(ms);
  return new Promise((resolve) => {
    // Its own temporary folder (the suites write files there under fixed names) and the moved `date`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tt-'));
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    if (GNU_DATE) fs.writeFileSync(path.join(bin, 'date'), fakeDate(REAL_DATE), { mode: 0o755 });
    const env = Object.assign({}, process.env, {
      FAKE_NOW: iso, FAKE_OFFSET_MS: String(ms - Date.now()), TZ: 'UTC', TMPDIR: tmp,
      PATH: bin + path.delimiter + process.env.PATH,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${PRELOAD}"`.trim(),
    });
    const [cmd, ...args] = suite.cmd;
    const child = spawn(cmd === 'node' ? process.execPath : cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_LIMIT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      const sum = (out.match(/^\d+ passed, \d+ failed\b.*$/m) || [])[0]
        || (signal ? `stopped (${signal}) - out of memory or too slow? Try TT_JOBS=1` : `no summary (exit ${code})`);
      // Each failing test with what it said - the indented lines after it -
      // so the run page (run_suite.js's annotations) has the reason too.
      const lines = out.split('\n'), fails = [];
      lines.forEach((l, i) => {
        if (!/^\s*FAIL\b/.test(l)) return;
        const why = [];
        for (let j = i + 1; j < lines.length && why.length < 4 && /^\s{6,}/.test(lines[j]); j++) if (lines[j].trim()) why.push(lines[j].trim());
        fails.push([l.trim(), ...why.map(w => w.slice(0, 300))].join('\n        '));
      });
      let log = null;
      if (code !== 0) {
        log = path.join(os.tmpdir(), `nhrc-time-travel-${suite.name}-${iso.replace(/:/g, '-')}.log`);
        fs.writeFileSync(log, out);
      }
      resolve({ suite, iso, ms, ok: code === 0, sum, fails, log });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const m = moments();
  if (args.includes('--list')) {
    for (const ms of m.all) console.log(`${isoOf(ms)}  ${label(ms).padEnd(28)}${m.few.includes(ms) ? '  (all suites)' : ''}`);
    return;
  }
  const names = [];
  const times = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--suite') names.push(args[++i]);
    else times.push(args[i]);
  }
  const unknown = names.find(n => !SUITES.some(s => s.name === n));
  if (unknown !== undefined) { console.error(`No suite "${unknown}". Suites: ${SUITES.map(s => s.name).join(', ')}`); process.exitCode = 2; return; }
  const badTime = times.find(a => !Number.isFinite(Date.parse(a)));
  if (badTime !== undefined) { console.error(`Not a time: ${badTime}`); process.exitCode = 2; return; }

  const suites = names.length ? SUITES.filter(s => names.includes(s.name)) : SUITES;
  const jobs = [];
  for (const s of suites) {
    if (s.shell && !GNU_DATE) { console.log(`skipped  ${s.name}: no GNU date here to move (it runs on GitHub's runners)`); continue; }
    for (const ms of (times.length ? times.map(Date.parse) : (s.few ? m.few : m.all))) jobs.push([s, ms]);
  }
  jobs.sort((a, b) => a[1] - b[1]);
  console.log(`${jobs.length} runs: ${suites.length} suites at up to ${times.length || m.all.length} moments, ${JOBS} at a time (TT_JOBS), TZ=UTC`);

  const results = [];
  const report = (r) => {
    results.push(r);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.suite.name.padEnd(17)} ${r.iso}  ${label(r.ms).padEnd(28)}  ${r.sum}`);
    for (const f of r.fails) console.log(`        ${f}`);
    if (r.log) console.log(`        full output: ${r.log}`);
  };
  // JOBS at a time; then the heavy ones, one at a time.
  const light = jobs.filter(([s]) => !s.heavy), heavy = jobs.filter(([s]) => s.heavy);
  let next = 0;
  const worker = async () => { while (next < light.length) { const [s, ms] = light[next++]; report(await runOne(s, ms)); } };
  await Promise.all(Array.from({ length: Math.min(JOBS, light.length) }, worker));
  for (const [s, ms] of heavy) report(await runOne(s, ms));
  const bad = results.filter(r => !r.ok);
  console.log('='.repeat(60));
  console.log(bad.length ? `${bad.length} of ${results.length} runs FAILED - do not push until they pass`
                         : `all ${results.length} runs passed`);
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
