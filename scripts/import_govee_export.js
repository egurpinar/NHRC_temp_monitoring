#!/usr/bin/env node
/**
 * Readings from the Govee Home app's data export, into history.json - only
 * where the record has none.
 *
 * WHY: the website reads the water sensor through Govee's official API, which
 * gives the current reading only - no history. When the boathouse internet is
 * down, the sensor reports nothing to Govee and the Worker records nothing (as
 * it should: Govee's last value is not a reading of now). Whatever the sensor
 * and its gateway upload to Govee after the outage can only be had from the
 * app, which keeps the sensor's history and exports it to a CSV file.
 *
 * WHAT IT DOES: reads the export, keeps one reading per 15 minutes (the
 * Worker's own pace) - the first in each quarter hour - and adds it only to a
 * quarter hour that neither history.json nor the Worker's last 16 days has a
 * reading in. Nothing already recorded is changed or removed. Readings outside
 * 28-100 F, or in the future, are left out, as the Worker and fetch_temp.sh
 * leave them out. Without --write it only says what it would add.
 *
 *   node scripts/import_govee_export.js ~/Downloads/export.csv           # what it would add
 *   node scripts/import_govee_export.js ~/Downloads/export.csv --write   # add it to history.json
 *
 * Options:
 *   --write              change history.json (otherwise nothing is written)
 *   --unit F|C           the file's unit, when its header does not say
 *   --tz ZONE            the clock the file's times are in (America/New_York: the phone's)
 *   --history PATH       history.json elsewhere (default: the repository's)
 *   --no-worker          do not ask the Worker for its last 16 days
 *   --worker-file PATH   the Worker's recent.json from a file instead (tests)
 *   --now ISO            the time to count as now (tests)
 *
 * The website and the morning email read history.json together with the
 * Worker's days, so the readings added show on both once it is pushed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SLOT_MS = 15 * 60_000;
const PLAUSIBLE_F = [28, 100];   // as camera/cloudflare_worker.js and scripts/fetch_temp.sh
const WORKER_RECENT_URL = 'https://nhrc-camera.gurpinar-emre.workers.dev/water/recent.json';
const WORKER_TIMEOUT_MS = 15_000;
const DEFAULT_TZ = 'America/New_York';

/** Two decimals, cut rather than rounded, as history.json's readings always were. */
const cut2 = (v) => Math.trunc(v * 100 + (v >= 0 ? 1e-6 : -1e-6)) / 100;
/** history.json's form of an instant: seconds, no milliseconds, Z. */
const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ─── The file ────────────────────────────────────────────────────────────────

/** One CSV line into its fields: quoted fields may hold the delimiter, "" is a quote. */
function splitLine(line, delim) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur.trim() === '') { quoted = true; cur = ''; }
    else if (c === delim) { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const TIME_HEADER = /time/i;
const DATE_HEADER = /date/i;
const TEMP_HEADER = /temp|°|℉|℃/i;
/** The unit a header or a value names: 'F', 'C' or null. */
function unitIn(s) {
  const t = String(s);
  if (/fahrenheit|℉|°\s*f\b|\(\s*f\s*\)|\bdeg(ree)?s?\s*f\b|[_\s-]f\)?\s*$/i.test(t)) return 'F';
  if (/celsius|centigrade|℃|°\s*c\b|\(\s*c\s*\)|\bdeg(ree)?s?\s*c\b|[_\s-]c\)?\s*$/i.test(t)) return 'C';
  return null;
}

/**
 * The header and its columns: the first line naming a time and a temperature
 * (an export may start with a line or two about the device). The time may be
 * one column ("Time", "Date/Time", "Timestamp ...") or a date and a time side
 * by side. Throws, in plain words, when there is no such line.
 */
function findColumns(lines) {
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const line = lines[i];
    const delim = [',', ';', '\t'].map((d) => [d, line.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const cells = splitLine(line, delim);
    if (cells.length < 2) continue;
    let time = cells.findIndex((c) => TIME_HEADER.test(c));
    let date = cells.findIndex((c, j) => j !== time && DATE_HEADER.test(c) && !TIME_HEADER.test(c));
    if (time < 0) { time = date; date = -1; }
    const temps = cells.map((c, j) => [c, j]).filter(([c, j]) => j !== time && j !== date && TEMP_HEADER.test(c));
    if (time < 0 || !temps.length) continue;
    // A column that says its unit, if there is one: Fahrenheit first, as the app shows it here.
    const temp = temps.find(([c]) => unitIn(c) === 'F') || temps.find(([c]) => unitIn(c) === 'C') || temps[0];
    return { headerAt: i, delim, time, date, temp: temp[1], unit: unitIn(temp[0]), header: cells };
  }
  throw new Error('no header with a time and a temperature column in its first 20 lines - is this the Govee Home export?');
}

/** A temperature cell: { value, unit } or null. A decimal comma only where the comma is not the delimiter. */
function parseTemp(cell, delim) {
  let s = String(cell).trim().replace(/^"|"$/g, '');
  if (delim !== ',') s = s.replace(/^(-?\d+),(\d+)/, '$1.$2');
  const m = /^(-?\d+(?:\.\d+)?)\s*(°\s*[FCfc]|℉|℃|[FCfc])?$/.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isFinite(value) ? { value, unit: m[2] ? (/f|℉/i.test(m[2]) ? 'F' : 'C') : null } : null;
}

// ─── Times ───────────────────────────────────────────────────────────────────

const offsetCache = new Map();
/** Minutes the zone is ahead of UTC at an instant (New York: -240 in summer, -300 in winter). */
function zoneOffsetMin(ms, tz) {
  const key = `${tz}|${Math.floor(ms / 3_600_000)}`;
  if (offsetCache.has(key)) return offsetCache.get(key);
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric',
    day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(ms))) {
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  }
  const whole = Math.floor(ms / 1000) * 1000;
  const off = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole) / 60_000);
  offsetCache.set(key, off);
  return off;
}

/**
 * The instants a wall-clock time in a zone can be, earliest first: none for a
 * time the clocks skip in spring, two for one they repeat in the fall.
 */
function wallToInstants(y, mo, d, h, mi, s, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const found = new Set();
  for (const probe of [wall - 12 * 3_600_000, wall + 12 * 3_600_000]) {
    const off = zoneOffsetMin(probe, tz);
    const at = wall - off * 60_000;
    if (zoneOffsetMin(at, tz) === off) found.add(at);
  }
  return [...found].sort((a, b) => a - b);
}

const ISO = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const SLASHED = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?$/;
const EPOCH = /^\d{10}(\d{3})?$/;

/**
 * A time cell, as its parts - or { at } for one that names its own instant
 * (an offset, Z, or seconds since 1970). dayFirst: 13/11/2026, not 11/13/2026.
 */
function parseTimeParts(cell, dayFirst) {
  const s = String(cell).trim().replace(/^"|"$/g, '');
  if (EPOCH.test(s)) return { at: s.length === 13 ? Number(s) : Number(s) * 1000 };
  let m = ISO.exec(s);
  if (m) {
    const [y, mo, d, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] || 0].map(Number);
    if (m[7]) {
      const z = m[7].toUpperCase() === 'Z' ? 0 : (m[7][0] === '-' ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(-2)));
      return valid(y, mo, d, h, mi, sec) ? { at: Date.UTC(y, mo - 1, d, h, mi, sec) - z * 60_000 } : null;
    }
    return valid(y, mo, d, h, mi, sec) ? { y, mo, d, h, mi, s: sec } : null;
  }
  m = SLASHED.exec(s);
  if (m) {
    let [a, b, y, h, mi, sec] = [m[1], m[2], m[3], m[4], m[5], m[6] || 0].map(Number);
    const [mo, d] = dayFirst ? [b, a] : [a, b];
    if (m[7]) {
      if (h < 1 || h > 12) return null;
      const pm = /p/i.test(m[7]);
      h = (h % 12) + (pm ? 12 : 0);
    }
    return valid(y, mo, d, h, mi, sec) ? { y, mo, d, h, mi, s: sec } : null;
  }
  return null;
}
function valid(y, mo, d, h, mi, s) {
  if (!(y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && h >= 0 && h <= 23 && mi >= 0 && mi <= 59 && s >= 0 && s <= 59)) return false;
  return d >= 1 && d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// ─── Reading the export ──────────────────────────────────────────────────────

/**
 * The export's readings: { readings: [{ at, tempF }], rejected: { reason: count }, examples,
 * unit, dayFirst, order }. opts: { unit, tz }.
 */
function readExport(text, opts = {}) {
  const tz = opts.tz || DEFAULT_TZ;
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/).filter((l) => l.trim() !== '');
  const cols = findColumns(lines);
  if (opts.unit && cols.unit && opts.unit !== cols.unit) throw new Error(`--unit ${opts.unit}, but the file's header says °${cols.unit}`);
  const rows = lines.slice(cols.headerAt + 1).map((l) => splitLine(l, cols.delim));
  const timeOf = (r) => (cols.date >= 0 ? `${r[cols.date] || ''} ${r[cols.time] || ''}` : String(r[cols.time] || '')).trim();
  // Day first only if some day could not be a month (13/11/2026) and no month could not be a day.
  const firstTwo = rows.map((r) => SLASHED.exec(timeOf(r))).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
  const dayFirst = firstTwo.some(([a]) => a > 12) && !firstTwo.some(([, b]) => b > 12);
  const rejected = {}, examples = {};
  const reject = (why, row) => { rejected[why] = (rejected[why] || 0) + 1; if (!examples[why]) examples[why] = row.join(cols.delim).slice(0, 80); };

  // First the times (some need their neighbours to settle: the hour the clocks repeat).
  const parsed = [];
  for (const r of rows) {
    const t = parseTimeParts(timeOf(r), dayFirst);
    if (!t) { reject('a time it cannot read', r); continue; }
    const temp = parseTemp(r[cols.temp], cols.delim);
    if (!temp) { reject('a temperature it cannot read', r); continue; }
    const unit = temp.unit || cols.unit || opts.unit || null;
    if (!unit) throw new Error('the file does not say whether it is in °F or °C - run again with --unit F or --unit C');
    const tempF = unit === 'F' ? temp.value : temp.value * 9 / 5 + 32;
    if (t.at !== undefined) { parsed.push({ at: t.at, tempF, row: r }); continue; }
    const at = wallToInstants(t.y, t.mo, t.d, t.h, t.mi, t.s, tz);
    if (!at.length) { reject('a time the clocks skip (spring forward)', r); continue; }
    parsed.push({ at: at.length === 1 ? at[0] : null, choices: at, tempF, row: r });
  }
  // Oldest first, or newest first? Settled by the times that are certain.
  let up = 0, down = 0, prev = null;
  for (const p of parsed) { if (p.at === null) continue; if (prev !== null) { if (p.at > prev) up++; else if (p.at < prev) down++; } prev = p.at; }
  const ascending = up >= down;
  // The repeated hour in the fall: the first time through it is the earlier instant.
  prev = null;
  for (const p of parsed) {
    if (p.at === null) {
      const [a, b] = p.choices;
      if (prev === null) p.at = ascending ? a : b;
      else if (ascending) p.at = a >= prev ? a : b;
      else p.at = b <= prev ? b : a;
    }
    prev = p.at;
  }
  const now = opts.now !== undefined ? opts.now : Date.now();
  const readings = [];
  for (const p of parsed) {
    if (p.tempF < PLAUSIBLE_F[0] || p.tempF > PLAUSIBLE_F[1]) { reject(`outside ${PLAUSIBLE_F[0]}-${PLAUSIBLE_F[1]} °F`, p.row); continue; }
    if (p.at > now + 5 * 60_000) { reject('in the future', p.row); continue; }
    readings.push({ at: p.at, tempF: p.tempF });
  }
  readings.sort((a, b) => a.at - b.at);
  return { readings, rejected, examples, unit: cols.unit || opts.unit || null, dayFirst, ascending, header: cols.header };
}

// ─── What to add ─────────────────────────────────────────────────────────────

/** The quarter hours that hold a reading already: history.json's and the Worker's. */
function filledSlots(...lists) {
  const slots = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const h of list) {
      const t = h && Date.parse(h.ts);
      if (Number.isFinite(t)) slots.add(Math.floor(t / SLOT_MS));
    }
  }
  return slots;
}

/**
 * The readings to add: the first of the export's in each quarter hour that
 * has none yet, as history.json keeps them ({ ts, tempC, tempF }).
 */
function toAdd(readings, filled) {
  const first = new Map();
  for (const r of readings) {
    const slot = Math.floor(r.at / SLOT_MS);
    if (filled.has(slot)) continue;
    const cur = first.get(slot);
    if (!cur || r.at < cur.at) first.set(slot, r);
  }
  return [...first.values()].sort((a, b) => a.at - b.at)
    .map((r) => ({ ts: isoZ(r.at), tempC: cut2((r.tempF - 32) * 5 / 9), tempF: cut2(r.tempF) }));
}

/** The added readings as runs of quarter hours one after another: [{ from, to, count }]. */
function runsOf(added) {
  const runs = [];
  for (const e of added) {
    const t = Date.parse(e.ts), slot = Math.floor(t / SLOT_MS), last = runs[runs.length - 1];
    if (last && slot - last.slot <= 1) { last.to = t; last.count++; last.slot = slot; }
    else runs.push({ from: t, to: t, count: 1, slot });
  }
  return runs.map(({ from, to, count }) => ({ from, to, count }));
}

/** Where each reading of history.json's list starts and ends in its text: [{ start, end }]. */
function entrySpans(raw) {
  const spans = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '[' || c === '{') { depth++; if (depth === 2) start = i; }
    else if (c === ']' || c === '}') { if (depth === 2) spans.push({ start, end: i + 1 }); depth--; }
  }
  return spans;
}

/**
 * history.json with the readings added, each where its time puts it - laid
 * out as jq lays it out. The readings already there are copied as they are,
 * character for character (45.0 stays 45.0), so the change is only the
 * readings added.
 */
function merged(raw, added) {
  const spans = entrySpans(raw);
  const pieces = [];
  const fresh = (e) => JSON.stringify(e, null, 2).split('\n').map((l) => `  ${l}`).join('\n');
  let k = 0;
  for (const { start, end } of spans) {
    const t = Date.parse(JSON.parse(raw.slice(start, end)).ts);
    while (k < added.length && Date.parse(added[k].ts) < t) pieces.push(fresh(added[k++]));
    pieces.push(`  ${raw.slice(start, end)}`);
  }
  while (k < added.length) pieces.push(fresh(added[k++]));
  return pieces.length ? `[\n${pieces.join(',\n')}\n]\n` : '[]\n';
}

// ─── Running it ──────────────────────────────────────────────────────────────

function nyTime(ms, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

function args(argv) {
  const o = { files: [], write: false, unit: null, tz: DEFAULT_TZ, history: path.join(__dirname, '..', 'history.json'),
    worker: true, workerFile: null, now: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--write') o.write = true;
    else if (a === '--unit') { o.unit = next().toUpperCase().replace(/^°/, ''); if (!['F', 'C'].includes(o.unit)) throw new Error('--unit is F or C'); }
    else if (a === '--tz') o.tz = next();
    else if (a === '--history') o.history = next();
    else if (a === '--no-worker') o.worker = false;
    else if (a === '--worker-file') o.workerFile = next();
    else if (a === '--now') { o.now = Date.parse(next()); if (!Number.isFinite(o.now)) throw new Error('--now: not a time'); }
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else o.files.push(a);
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: o.tz }); } catch (e) { throw new Error(`--tz: not a time zone: ${o.tz}`); }
  return o;
}

async function workerDays(o, log) {
  if (o.workerFile) return JSON.parse(fs.readFileSync(o.workerFile, 'utf8'));
  if (!o.worker) return [];
  try {
    const res = await fetch(WORKER_RECENT_URL, { signal: AbortSignal.timeout(WORKER_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const days = await res.json();
    return Array.isArray(days) ? days : [];
  } catch (e) {
    log(`(The Worker's last 16 days could not be read - ${e.message || e}; going by history.json alone.)`);
    return [];
  }
}

async function main(argv, log = console.log) {
  const o = args(argv);
  if (o.help || !o.files.length) {
    log('Usage: node scripts/import_govee_export.js EXPORT.csv [more.csv ...] [--write] [--unit F|C] [--tz ZONE]');
    return o.help ? 0 : 2;
  }
  const raw = fs.readFileSync(o.history, 'utf8');
  const history = JSON.parse(raw);
  if (!Array.isArray(history)) throw new Error(`${o.history} is not a list of readings`);
  if (entrySpans(raw).length !== history.length) throw new Error(`${o.history} is not laid out as a list of readings`);
  const worker = await workerDays(o, log);

  let readings = [];
  for (const f of o.files) {
    const r = readExport(fs.readFileSync(f, 'utf8'), { unit: o.unit, tz: o.tz, now: o.now });
    readings = readings.concat(r.readings);
    log(`${path.basename(f)}: ${r.readings.length} readings in °${r.unit || o.unit}` +
      (r.readings.length ? `, ${nyTime(r.readings[0].at, o.tz)} to ${nyTime(r.readings[r.readings.length - 1].at, o.tz)}` : ''));
    for (const [why, n] of Object.entries(r.rejected)) log(`  left out ${n}: ${why}, e.g. ${r.examples[why]}`);
  }
  const added = toAdd(readings, filledSlots(history, worker));
  if (!added.length) {
    log('Nothing to add: every quarter hour the export covers already has a reading.');
    return 0;
  }
  const plural = (n) => `${n} reading${n === 1 ? '' : 's'}`;
  log(`${o.write ? 'Adding' : 'Would add'} ${plural(added.length)} where the record has none:`);
  for (const run of runsOf(added)) {
    log(`  ${run.count === 1 ? nyTime(run.from, o.tz) : `${nyTime(run.from, o.tz)} to ${nyTime(run.to, o.tz)}`}: ${plural(run.count)}`);
  }
  if (!o.write) { log('Nothing written. To add them: run again with --write, then commit and push history.json.'); return 0; }
  const tmp = `${o.history}.tmp`;
  fs.writeFileSync(tmp, merged(raw, added));
  fs.renameSync(tmp, o.history);
  log(`history.json now has ${history.length + added.length} readings. Commit and push it to show them on the website and in the email.`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`import_govee_export: ${e.message || e}`);
    process.exitCode = 1;
  });
} else {
  module.exports = { SLOT_MS, PLAUSIBLE_F, splitLine, findColumns, unitIn, parseTemp, zoneOffsetMin, wallToInstants,
    parseTimeParts, readExport, filledSlots, toAdd, runsOf, entrySpans, merged, args, main };
}
