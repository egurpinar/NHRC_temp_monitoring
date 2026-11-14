#!/usr/bin/env node
/**
 * Tests for scripts/import_govee_export.js: the Govee Home app's export read
 * whichever way the app writes it (its columns, its times in New York's clock
 * across daylight saving, °F or °C), one reading a quarter hour added only
 * where the record has none, history.json otherwise left exactly as it was,
 * and nothing written without --write. No network.
 *
 *   node scripts/test_import_govee_export.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./import_govee_export.js');

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function section(title) { queue.push([title, null]); }

const HOUR = 3_600_000, MIN = 60_000;
/** New York wall-clock rows, one a minute (or every step), from a start, as the app would write them. */
function rows(startIso, count, stepMin = 1, temp = (i) => (53 - i * 0.001).toFixed(2), fmt = isoWall) {
  const out = [];
  const start = Date.parse(startIso);
  for (let i = 0; i < count; i++) out.push(`${fmt(start + i * stepMin * MIN)},${temp(i)}`);
  return out;
}
/** An instant as New York's wall clock: 2026-11-14 08:30:00. */
function isoWall(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
const HEADER = 'Timestamp for sample frequency every 1 min min,Temperature_Fahrenheit';
const NOW = Date.parse('2026-11-16T17:00:00Z');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'govee-import-')); }
function jqLike(list) { return `${JSON.stringify(list, null, 2)}\n`; }
async function run(argv) {
  const lines = [];
  const code = await G.main(argv, (s) => lines.push(String(s)));
  return { code, out: lines.join('\n') };
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. Reading the export, however the app writes it');
// ═══════════════════════════════════════════════════════════════════════════

test('its columns: a time (one column, or a date and a time), a temperature and its unit - after any lines about the device', () => {
  const c = (text) => G.findColumns(text.split('\n'));
  assert.deepStrictEqual((({ time, date, temp, unit, delim }) => ({ time, date, temp, unit, delim }))(c(HEADER)),
    { time: 0, date: -1, temp: 1, unit: 'F', delim: ',' });
  assert.strictEqual(c('Time,Temperature(℃)').unit, 'C');
  assert.strictEqual(c('Time,"Temp (°F)"').unit, 'F');
  assert.strictEqual(c('Time,Temperature (F)').unit, 'F');
  assert.strictEqual(c('Time,Temperature_C').unit, 'C');
  assert.strictEqual(c('Time,Temperature').unit, null, 'no unit said');
  const both = c('Date,Time,Temperature_Celsius,Temperature_Fahrenheit');
  assert.deepStrictEqual([both.date, both.time, both.temp, both.unit], [0, 1, 3, 'F'], 'a date and a time side by side; °F preferred');
  const semi = c('Date/Time;Temperature Celsius');
  assert.deepStrictEqual([semi.delim, semi.time, semi.date, semi.unit], [';', 0, -1, 'C']);
  assert.strictEqual(c('Device name: Water\nModel: H5109\n' + HEADER).headerAt, 2, 'lines about the device first');
  assert.strictEqual(c('Time\tTemperature (°C)').delim, '\t');
  assert.throws(() => c('Reading,Value\n1,2'), /no header with a time and a temperature column.*Govee Home export/);
});

test('times: as ISO, as the US writes them (with AM/PM), day first when it must be, seconds since 1970, or with Z or an offset - nonsense refused', () => {
  const t = (s, dayFirst = false) => G.parseTimeParts(s, dayFirst);
  assert.deepStrictEqual(t('2026-11-14 08:30:00'), { y: 2026, mo: 11, d: 14, h: 8, mi: 30, s: 0 });
  assert.deepStrictEqual(t('2026-11-14T08:30'), { y: 2026, mo: 11, d: 14, h: 8, mi: 30, s: 0 });
  assert.deepStrictEqual(t('11/14/2026 8:30 PM'), { y: 2026, mo: 11, d: 14, h: 20, mi: 30, s: 0 });
  assert.deepStrictEqual(t('11/14/2026 12:05 AM'), { y: 2026, mo: 11, d: 14, h: 0, mi: 5, s: 0 });
  assert.deepStrictEqual(t('11/14/2026 12:05 PM'), { y: 2026, mo: 11, d: 14, h: 12, mi: 5, s: 0 });
  assert.deepStrictEqual(t('14/11/2026 08:30', true), { y: 2026, mo: 11, d: 14, h: 8, mi: 30, s: 0 });
  assert.deepStrictEqual(t('1794666600'), { at: 1794666600000 });
  assert.deepStrictEqual(t('1794666600123'), { at: 1794666600123 });
  assert.deepStrictEqual(t('2026-11-14T13:30:00Z'), { at: Date.parse('2026-11-14T13:30:00Z') });
  assert.deepStrictEqual(t('2026-11-14 08:30:00-05:00'), { at: Date.parse('2026-11-14T13:30:00Z') });
  for (const bad of ['', 'yesterday', '2026-13-01 08:00', '2026-02-30 08:00', '2026-11-14', '11/14/2026 13:00 PM', '2026-11-14 24:00', '12345'])
    assert.strictEqual(t(bad), null, bad);
});

test('New York\'s clock across daylight saving: the hour repeated in the fall, oldest first or newest first; the hour skipped in spring left out', () => {
  // 1 November 2026: 1:00-1:59 AM happens twice (EDT, then EST).
  const fall = [HEADER].concat(rows('2026-11-01T04:00:00Z', 12, 15));   // 12:00 AM EDT to 2:45 AM EST, every 15 minutes
  for (const order of ['oldest first', 'newest first']) {
    const text = order === 'oldest first' ? fall.join('\n') : [fall[0]].concat(fall.slice(1).reverse()).join('\n');
    const r = G.readExport(text, { now: NOW });
    assert.deepStrictEqual(r.readings.map((x) => new Date(x.at).toISOString()), Array.from({ length: 12 }, (_, i) =>
      new Date(Date.parse('2026-11-01T04:00:00Z') + i * 15 * MIN).toISOString()), order);
    assert.strictEqual(r.ascending, order === 'oldest first');
  }
  // 14 March 2027: 2:00-2:59 AM never happens.
  const spring = G.readExport([HEADER, '2027-03-14 01:45:00,50', '2027-03-14 02:30:00,50', '2027-03-14 03:00:00,50'].join('\n'), { now: Date.parse('2027-03-15T00:00:00Z') });
  assert.deepStrictEqual(spring.readings.map((x) => new Date(x.at).toISOString()), ['2027-03-14T06:45:00.000Z', '2027-03-14T07:00:00.000Z']);
  assert.strictEqual(spring.rejected['a time the clocks skip (spring forward)'], 1);
  // Summer and winter: four and five hours behind UTC.
  assert.strictEqual(G.readExport([HEADER, '2026-07-04 08:00:00,75'].join('\n'), { now: NOW }).readings[0].at, Date.parse('2026-07-04T12:00:00Z'));
  assert.strictEqual(G.readExport([HEADER, '2026-01-04 08:00:00,40'].join('\n'), { now: NOW }).readings[0].at, Date.parse('2026-01-04T13:00:00Z'));
  // Another clock, if the phone was elsewhere.
  assert.strictEqual(G.readExport([HEADER, '2026-01-04 08:00:00,40'].join('\n'), { now: NOW, tz: 'America/Los_Angeles' }).readings[0].at,
    Date.parse('2026-01-04T16:00:00Z'));
});

test('temperatures: °F or °C from the header or the value, a decimal comma where commas do not split the columns; 28-100 °F only; nothing from the future; no unit at all - it asks', () => {
  const read = (lines, o = {}) => G.readExport(lines.join('\n'), Object.assign({ now: NOW }, o));
  const c = read(['Time,Temperature(℃)', '2026-11-14 08:30:00,11.75']).readings[0];
  assert.ok(Math.abs(c.tempF - 53.15) < 1e-9, String(c.tempF));
  assert.strictEqual(read(['Time,Temperature', '2026-11-14 08:30:00,53.2°F']).readings[0].tempF, 53.2, 'the unit in the value');
  assert.ok(Math.abs(read(['Time;Temperatur °C', '14.11.2026 08:30;11,75']).readings[0].tempF - 53.15) < 1e-9, 'a decimal comma, day first');
  const odd = read(['Time,Temperature_Fahrenheit', '2026-11-14 08:30:00,0', '2026-11-14 08:45:00,150', '2026-11-14 09:00:00,27.9',
    '2026-11-14 09:15:00,28', '2026-11-14 09:30:00,100', '2026-11-14 09:45:00,n/a', '2026-11-20 08:00:00,50', 'whenever,50']);
  assert.deepStrictEqual(odd.readings.map((x) => x.tempF), [28, 100]);
  assert.deepStrictEqual(odd.rejected, { 'outside 28-100 °F': 3, 'a temperature it cannot read': 1, 'in the future': 1, 'a time it cannot read': 1 });
  assert.throws(() => read(['Time,Temperature', '2026-11-14 08:30:00,12']), /does not say whether it is in °F or °C.*--unit F or --unit C/);
  assert.strictEqual(read(['Time,Temperature', '2026-11-14 08:30:00,12'], { unit: 'C' }).readings[0].tempF, 53.6);
  assert.throws(() => read([HEADER, '2026-11-14 08:30:00,53'], { unit: 'C' }), /--unit C, but the file's header says °F/);
  assert.strictEqual(read(['﻿' + HEADER + '\r', '2026-11-14 08:30:00,53\r']).readings.length, 1, 'a byte-order mark and Windows line ends');
});

test('a whole file read the same way: month first unless a day says otherwise (11/05 is November 5); a date and a time in two columns joined', () => {
  const read = (lines) => G.readExport(lines.join('\n'), { now: NOW });
  const us = read(['Time,Temperature_Fahrenheit', '11/05/2026 8:00 AM,55', '11/06/2026 8:00 AM,55']);
  assert.deepStrictEqual(us.readings.map((x) => new Date(x.at).toISOString()), ['2026-11-05T13:00:00.000Z', '2026-11-06T13:00:00.000Z']);
  assert.strictEqual(us.dayFirst, false);
  const eu = read(['Time,Temperature_Fahrenheit', '05/11/2026 08:00,55', '14/11/2026 08:00,55']);
  assert.deepStrictEqual(eu.readings.map((x) => new Date(x.at).toISOString()), ['2026-11-05T13:00:00.000Z', '2026-11-14T13:00:00.000Z']);
  assert.strictEqual(eu.dayFirst, true);
  const two = read(['Date,Time,Temp (°F)', '2026-11-14,08:30:00,53', '11/14/2026,9:45 AM,52.5']);
  assert.deepStrictEqual(two.readings.map((x) => [new Date(x.at).toISOString(), x.tempF]), [['2026-11-14T13:30:00.000Z', 53], ['2026-11-14T14:45:00.000Z', 52.5]]);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. What it adds');
// ═══════════════════════════════════════════════════════════════════════════

test('one reading a quarter hour - the first in it - and only where history.json and the Worker have none', () => {
  const r = G.readExport([HEADER].concat(rows('2026-11-14T13:00:00Z', 240)).join('\n'), { now: NOW });   // 8:00-11:59 AM, every minute
  const history = [{ ts: '2026-11-14T13:00:19Z', tempC: 11.75, tempF: 53.16 }, { ts: '2026-11-14T13:15:19Z', tempC: 11.75, tempF: 53.16 }];
  const worker = [{ ts: '2026-11-14T16:15:19Z', tempC: 11.6, tempF: 52.88 }];
  const added = G.toAdd(r.readings, G.filledSlots(history, worker));
  assert.strictEqual(added.length, 16 - 3);
  // The 30th and 45th minute's readings (53 °F less a thousandth a minute), cut to two decimals as history.json keeps them.
  const at = (i) => { const f = Number((53 - i * 0.001).toFixed(2)); return { tempC: Math.trunc((f - 32) * 5 / 9 * 100 + 1e-6) / 100, tempF: f }; };
  assert.deepStrictEqual(added.slice(0, 2), [Object.assign({ ts: '2026-11-14T13:30:00Z' }, at(30)), Object.assign({ ts: '2026-11-14T13:45:00Z' }, at(45))]);
  assert.deepStrictEqual(added[0], { ts: '2026-11-14T13:30:00Z', tempC: 11.65, tempF: 52.97 });
  assert.ok(added.every((e) => /^\d{4}-\d\d-\d\dT\d\d:(00|15|30|45):00Z$/.test(e.ts)), 'the first of each quarter hour');
  assert.ok(!added.some((e) => e.ts.startsWith('2026-11-14T16:15')), 'the Worker\'s quarter hour is left alone');
  assert.deepStrictEqual(G.runsOf(added).map((x) => [new Date(x.from).toISOString(), x.count]),
    [['2026-11-14T13:30:00.000Z', 11], ['2026-11-14T16:30:00.000Z', 2]]);
  // A quarter hour whose first minute is missing: its next.
  const late = G.readExport([HEADER, '2026-11-14 12:07:00,52', '2026-11-14 12:09:00,51'].join('\n'), { now: NOW });
  assert.deepStrictEqual(G.toAdd(late.readings, new Set()).map((e) => [e.ts, e.tempF]), [['2026-11-14T17:07:00Z', 52]]);
  assert.deepStrictEqual(G.toAdd([], new Set()), []);
  assert.deepStrictEqual(G.filledSlots(null, [{}], [{ ts: 'nope' }]).size, 0);
});

test('history.json: the readings go where their times put them, and everything already there is copied character for character (45.0 stays 45.0)', () => {
  const raw = '[\n  {\n    "ts": "2026-03-29T19:49:59Z",\n    "tempC": 7.26,\n    "tempF": 45.0\n  },\n  {\n    "ts": "2026-11-14T13:15:19Z",\n' +
    '    "tempC": 11.75,\n    "tempF": 53.16\n  },\n  {\n    "ts": "2026-11-14T17:00:19Z",\n    "tempC": 11.6,\n    "tempF": 52.88\n  }\n]\n';
  assert.strictEqual(G.merged(raw, []), raw, 'nothing added: the same file');
  const added = [{ ts: '2026-01-01T00:00:00Z', tempC: 1, tempF: 33.8 }, { ts: '2026-11-14T13:30:00Z', tempC: 11.73, tempF: 53.13 },
    { ts: '2026-11-20T00:00:00Z', tempC: 9, tempF: 48.2 }];
  const out = G.merged(raw, added);
  assert.deepStrictEqual(JSON.parse(out).map((e) => e.ts), ['2026-01-01T00:00:00Z', '2026-03-29T19:49:59Z', '2026-11-14T13:15:19Z',
    '2026-11-14T13:30:00Z', '2026-11-14T17:00:19Z', '2026-11-20T00:00:00Z']);
  assert.ok(out.includes('"tempF": 45.0\n'), 'the old literal kept');
  assert.strictEqual(out, jqLike(JSON.parse(out)).replace('"tempF": 45\n', '"tempF": 45.0\n'), 'laid out as jq lays it out');
  assert.strictEqual(G.merged('[]\n', []), '[]\n');
  assert.strictEqual(G.merged('[]', added.slice(0, 1)), jqLike(added.slice(0, 1)));
  assert.strictEqual(G.entrySpans('[{"ts":"a{b}"},{"ts":"c\\"}"}]').length, 2, 'braces and quotes inside strings');
});

test('the repository\'s own history.json: read and laid out again exactly as it is', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'history.json'), 'utf8');
  assert.strictEqual(G.entrySpans(raw).length, JSON.parse(raw).length);
  assert.strictEqual(G.merged(raw, []), raw);
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. The command');
// ═══════════════════════════════════════════════════════════════════════════

test('a look first: what it would add, in New York time, and nothing written; --write adds it; the same export again adds nothing', async () => {
  const dir = tmpdir();
  const hist = path.join(dir, 'history.json'), worker = path.join(dir, 'recent.json'), csv = path.join(dir, 'export.csv');
  const before = jqLike([{ ts: '2026-11-14T13:00:19Z', tempC: 11.75, tempF: 53.16 }, { ts: '2026-11-14T13:15:19Z', tempC: 11.75, tempF: 53.16 }]);
  fs.writeFileSync(hist, before);
  fs.writeFileSync(worker, JSON.stringify([{ ts: '2026-11-14T16:15:19Z', tempC: 11.6, tempF: 52.88 }]));
  fs.writeFileSync(csv, [HEADER].concat(rows('2026-11-14T13:00:00Z', 240)).join('\n'));
  const base = [csv, '--history', hist, '--worker-file', worker, '--now', new Date(NOW).toISOString()];
  const look = await run(base);
  assert.strictEqual(look.code, 0);
  assert.ok(/export\.csv: 240 readings in °F, Sat, Nov 14, 8:00 AM to Sat, Nov 14, 11:59 AM/.test(look.out), look.out);
  assert.ok(/Would add 13 readings where the record has none:\n  Sat, Nov 14, 8:30 AM to Sat, Nov 14, 11:00 AM: 11 readings\n  Sat, Nov 14, 11:30 AM to Sat, Nov 14, 11:45 AM: 2 readings/.test(look.out), look.out);
  assert.ok(/Nothing written/.test(look.out));
  assert.strictEqual(fs.readFileSync(hist, 'utf8'), before, 'untouched');
  const write = await run(base.concat('--write'));
  assert.ok(/Adding 13 readings/.test(write.out) && /history\.json now has 15 readings/.test(write.out), write.out);
  const after = JSON.parse(fs.readFileSync(hist, 'utf8'));
  assert.strictEqual(after.length, 15);
  assert.ok(after.every((e, i) => i === 0 || Date.parse(e.ts) > Date.parse(after[i - 1].ts)), 'in time order');
  assert.ok(!fs.existsSync(`${hist}.tmp`), 'no file left over');
  const again = await run(base.concat('--write'));
  assert.ok(/Nothing to add/.test(again.out), again.out);
  assert.strictEqual(JSON.parse(fs.readFileSync(hist, 'utf8')).length, 15);
});

test('several exports at once; the Worker left out on request; bad options, files and history.json said plainly', async () => {
  const dir = tmpdir();
  const hist = path.join(dir, 'history.json');
  fs.writeFileSync(hist, '[]\n');
  const a = path.join(dir, 'a.csv'), b = path.join(dir, 'b.csv');
  fs.writeFileSync(a, [HEADER].concat(rows('2026-11-14T13:00:00Z', 30)).join('\n'));
  fs.writeFileSync(b, ['Time,Temperature(℃)', '2026-11-14 09:00:00,11.5', '2026-11-14 08:00:00,11.9'].join('\n'));
  const two = await run([a, b, '--history', hist, '--no-worker', '--now', new Date(NOW).toISOString()]);
  assert.ok(/Would add 3 readings/.test(two.out), two.out);   // 8:00 and 8:15 from a (8:00 first), 9:00 from b
  assert.strictEqual((await run([])).code, 2, 'no file: how to use it');
  assert.strictEqual((await run(['--help'])).code, 0);
  await assert.rejects(run([a, '--unit', 'K']), /--unit is F or C/);
  await assert.rejects(run([a, '--tz', 'Mars/Olympus']), /not a time zone/);
  await assert.rejects(run([a, '--frobnicate']), /unknown option --frobnicate/);
  await assert.rejects(run([a, '--now', 'soon']), /--now: not a time/);
  await assert.rejects(run([path.join(dir, 'missing.csv'), '--history', hist, '--no-worker']), /ENOENT/);
  fs.writeFileSync(hist, '{"ts":1}');
  await assert.rejects(run([a, '--history', hist, '--no-worker']), /is not a list of readings/);
  fs.writeFileSync(hist, '[1, 2]\n');
  await assert.rejects(run([a, '--history', hist, '--no-worker', '--write']), /is not laid out as a list of readings/);
  assert.strictEqual(fs.readFileSync(hist, 'utf8'), '[1, 2]\n', 'and left as it was');
});

test('a big export - a month, one reading a minute - in a few seconds', () => {
  const lines = [HEADER].concat(rows('2026-10-01T04:00:00Z', 30 * 1440, 1, (i) => (50 + (i % 600) / 100).toFixed(2)));
  const t0 = Date.now();
  const r = G.readExport(lines.join('\n'), { now: NOW });
  const added = G.toAdd(r.readings, new Set());
  const ms = Date.now() - t0;
  assert.strictEqual(r.readings.length, 30 * 1440);
  assert.strictEqual(added.length, 30 * 96, 'one a quarter hour');
  assert.ok(ms < 15000, `${ms} ms`);
});

test('guard rails: it reads only the Worker\'s days from the network, changes no file but history.json and only with --write, runs nothing else', () => {
  const src = fs.readFileSync(path.join(__dirname, 'import_govee_export.js'), 'utf8');
  const urls = [...src.matchAll(/https?:\/\/[^\s'"`]+/g)].map((m) => m[0]);
  assert.deepStrictEqual(urls, ['https://nhrc-camera.gurpinar-emre.workers.dev/water/recent.json']);
  assert.strictEqual((src.match(/fetch\(/g) || []).length, 1);
  assert.ok(!/child_process|eval\(|new Function|require\('https?'\)/.test(src));
  const writes = [...src.matchAll(/fs\.(writeFileSync|renameSync|appendFileSync|unlinkSync|rmSync)\(/g)];
  assert.strictEqual(writes.length, 2, 'one write and one rename');
  const at = src.indexOf('if (!o.write)');
  assert.ok(at > 0 && writes.every((m) => m.index > at), 'both after the --write check');
  assert.ok(/PLAUSIBLE_F = \[28, 100\]/.test(src), 'the same range as the Worker and fetch_temp.sh');
});

test('the website and the email take what it adds: they read history.json with the Worker\'s days, one reading per moment', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/function mergeHistory\(archive, recent\)/.test(page));
  assert.ok(/!recentGap\(state\.recent, Date\.now\(\)\)/.test(page), 'a gap in the Worker\'s week: the archive is fetched too');
  const email = fs.readFileSync(path.join(__dirname, 'daily_email.js'), 'utf8');
  assert.ok(/logic\.mergeHistory\(local \? local\.history : \[\], logic\.normalizeHistory\(recent\)\)/.test(email));
});

(async () => {
  for (const [name, fn] of queue) {
    if (!fn) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); continue; }
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String((e && e.message) || e).split('\n').slice(0, 12).join('\n        ')}`); }
  }
  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exitCode = failed ? 1 : 0;
})();
