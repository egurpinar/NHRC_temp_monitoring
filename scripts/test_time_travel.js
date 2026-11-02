#!/usr/bin/env node
/**
 * test_daily_email.js at the hours the email job really runs it, and around
 * the edges the rules and the email care about - not only at the time of day
 * someone happens to run it. The 2 Nov 2026 email did not go out: two tests
 * passed in the afternoon and failed at 1:58 AM, when the job ran them, and a
 * failing test stops the send.
 *
 *   node scripts/test_time_travel.js            # all 50 or so, a few minutes
 *   node scripts/test_time_travel.js --list     # only print the moments
 *   node scripts/test_time_travel.js 2026-11-03T06:58:00Z ...   # these moments
 *
 * Each run starts the clock at one moment (fakenow.js) and lets it run on:
 * tomorrow and the day after, at the job's hours (1-2 AM) and the morning
 * window's edges (5 and 11 AM); the next two daylight-saving changes; the
 * season's edges (March 15, November 15) and the new year. Always from now
 * on, never back: the repository's own readings are real, and must not be
 * newer than the clock. TZ=UTC, as on GitHub's runners.
 *
 * Each run takes about 1 GB of memory: two at a time by default, TT_JOBS=4
 * on a machine with the room.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.join(__dirname, '..');
const SUITE = path.join(__dirname, 'test_daily_email.js');
const PRELOAD = path.join(__dirname, 'fakenow.js');
const JOBS = Math.max(1, Math.floor(Number(process.env.TT_JOBS)) || 2);
const RUN_LIMIT_MS = 5 * 60000;

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

function moments(now = Date.now()) {
  const today = nyParts(now);
  const dayPlus = (n) => {
    const t = new Date(Date.UTC(today.year, today.month - 1, today.day + n, 12));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  };
  const offset = ([y, m, d]) => nyParts(Date.UTC(y, m - 1, d, 12)).hour - 12;   // -4 EDT, -5 EST
  const out = new Set();
  const add = (ymd, hours) => { for (const [h, mi] of hours) for (const ms of ny(...ymd, h, mi)) out.add(ms); };

  // The job's hours: the 8-9 PM triggers wait for 1 AM; GitHub can start one
  // hours late, up to the 5 AM cutoff. Then the morning window's edges.
  const DAY = [[0, 30], [1, 0], [1, 58], [3, 0], [4, 30], [4, 59], [5, 0], [7, 0], [10, 59], [11, 0], [13, 0], [15, 0], [19, 0], [23, 30]];
  add(dayPlus(1), DAY);
  add(dayPlus(2), DAY);
  // The next two daylight-saving changes, through the hour that is skipped or repeated.
  const CHANGE = [[0, 30], [1, 30], [2, 30], [3, 30], [5, 0], [7, 0], [11, 0], [15, 0]];
  for (let n = 1, found = 0; n <= 400 && found < 2; n++) {
    if (offset(dayPlus(n)) !== offset(dayPlus(n - 1))) { add(dayPlus(n), CHANGE); found++; }
  }
  // The season's edges and the new year: the next of each.
  const next = (m, d) => { for (let n = 1; n <= 400; n++) { const t = dayPlus(n); if (t[1] === m && t[2] === d) return t; } return null; };
  for (const [m, d, h, mi] of [[3, 14, 23, 30], [3, 15, 1, 58], [11, 15, 23, 30], [11, 16, 1, 58], [12, 31, 23, 30], [1, 1, 1, 58]]) {
    const t = next(m, d);
    if (t) add(t, [[h, mi]]);
  }
  return [...out].filter(ms => ms > now).sort((a, b) => a - b);
}

function runOne(ms) {
  const iso = new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return new Promise((resolve) => {
    // Its own temporary folder: the suite writes a file there under a fixed name.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tt-'));
    const child = spawn(process.execPath, ['-r', PRELOAD, SUITE], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { FAKE_NOW: iso, TZ: 'UTC', TMPDIR: tmp }),
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_LIMIT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.rmSync(tmp, { recursive: true, force: true });
      const sum = (out.match(/^\d+ passed, \d+ failed$/m) || [])[0]
        || (signal ? `stopped (${signal}) - out of memory? Try TT_JOBS=1` : 'no summary');
      const fails = out.split('\n').filter(l => /^\s*FAIL\s/.test(l)).map(l => l.trim());
      let log = null;
      if (code !== 0) {
        log = path.join(os.tmpdir(), `nhrc-time-travel-${iso.replace(/:/g, '-')}.log`);
        fs.writeFileSync(log, out);
      }
      resolve({ iso, ms, ok: code === 0, sum, fails, log });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const ms of moments()) console.log(new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') + '  ' + label(ms));
    return;
  }
  const list = args.length ? args.map(a => Date.parse(a)) : moments();
  const badArg = args.find(a => !Number.isFinite(Date.parse(a)));
  if (badArg !== undefined) { console.error(`Not a time: ${badArg}`); process.exitCode = 2; return; }

  console.log(`test_daily_email.js at ${list.length} moments, ${JOBS} at a time (TT_JOBS), TZ=UTC`);
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const r = await runOne(list[next++]);
      results.push(r);
      console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.iso}  ${label(r.ms).padEnd(28)}  ${r.sum}`);
      for (const f of r.fails) console.log(`        ${f}`);
      if (r.log) console.log(`        full output: ${r.log}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, list.length) }, worker));
  const bad = results.filter(r => !r.ok);
  console.log('='.repeat(60));
  console.log(bad.length ? `${bad.length} of ${results.length} moments FAILED - do not push until they pass`
                         : `all ${results.length} moments passed`);
  process.exitCode = bad.length ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
