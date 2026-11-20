#!/usr/bin/env node
/**
 * Each end-to-end test of the camera service on its own, begun just before a
 * slot mark, with the clock moved there (scripts/test_time_travel.js): half a
 * second before a quarter hour, where a dock photo and a timelapse slot begin,
 * and 3 s before a 5-minute mark, where a timelapse slot does. A test
 * that counts one slot's captures must wait until the mark has passed
 * (awayFromSlotMark in test_snapshot_service.js): five did not, and failed
 * whenever they happened to begin a few seconds before one. A run that fails
 * prints why under it (the service's errors first), then everything it printed.
 *
 *   node camera/test_at_slot_marks.js        # a few minutes
 *   node camera/test_at_slot_marks.js 10 5   # only the 11th to the 15th test
 */
'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'test_time_travel.js');
const src = fs.readFileSync(path.join(__dirname, 'test_snapshot_service.js'), 'utf8');
const all = [...src.matchAll(/test\('((?:[^'\\]|\\.)*)'/g)]
  .map(m => m[1].replace(/\\(.)/g, '$1')).filter(n => /^end to end/.test(n));
const first = Number(process.argv[2]) || 0, count = Number(process.argv[3]) || all.length;
const names = all.slice(first, first + count);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The first quarter hour at least an hour away, and the 5-minute mark after it (not a quarter).
const QUARTER = 15 * 60000, FIVE = 5 * 60000;
const quarter = Math.ceil((Date.now() + 3600000) / QUARTER) * QUARTER;
const moments = [quarter - 500, quarter + FIVE - 3000];

let ran = 0;
const failed = [];
for (const ms of moments) {
  const iso = new Date(ms).toISOString();
  for (const name of names) {
    const r = spawnSync(process.execPath, [RUNNER, '--suite', 'snapshot_service', iso], {
      cwd: ROOT, encoding: 'utf8', timeout: 5 * 60000,
      env: Object.assign({}, process.env, { TEST_ONLY: `^${esc(name)}$`, TT_JOBS: '1' }),
    });
    const out = r.stdout || '';
    const line = out.split('\n').find(l => /^(ok|FAIL) /.test(l)) || '';
    const sum = (line.match(/(\d+) passed, (\d+) failed/) || []);
    if (sum[0] && Number(sum[1]) + Number(sum[2]) === 0) continue;   // not here (no ffmpeg or ssh server)
    ran++;
    const ok = r.status === 0 && /^ok /.test(line);
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${iso}  ${name}`);
    if (!ok) {
      failed.push(`${iso}  ${name}`);
      // Why, as the time-travel run gave it: the indented lines under its
      // FAIL line - for the run page's annotation too (run_suite.js). Until
      // 20 November 2026 only the FAIL lines were kept, and a failure on
      // GitHub said nothing about its cause.
      const lines = out.split('\n');
      const at = lines.findIndex(l => /^FAIL /.test(l));
      for (let j = at + 1; at >= 0 && j < lines.length && /^\s{6,}\S/.test(lines[j]); j++) console.log(`        ${lines[j].trim()}`);
      // And all that run printed, for the run's log: the file it is in is
      // gone once GitHub's job ends.
      const log = (out.match(/full output: (\S+)/) || [])[1];
      let text = '';
      try { text = log ? fs.readFileSync(log, 'utf8') : ''; } catch (e) { /* gone already */ }
      if (text) {
        console.log(`  --- everything it printed (${log}) ---`);
        for (const l of text.split('\n')) console.log(`  | ${l}`);
        console.log('  --- end ---');
      }
    }
  }
}
console.log('='.repeat(60));
console.log(failed.length ? `${failed.length} of ${ran} runs FAILED` : `all ${ran} runs passed (${names.length} of the ${all.length} end-to-end tests, 2 moments)`);
process.exitCode = failed.length ? 1 : 0;
