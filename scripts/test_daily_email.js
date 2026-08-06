#!/usr/bin/env node
/**
 * Test suite for the NHRC daily conditions email.
 *
 * Run: node scripts/test_daily_email.js
 *
 * The most important property under test is PARITY: the email's boat
 * restrictions must always equal what index.html would display for the same
 * inputs. These are safety decisions, so a silent divergence is the worst
 * possible failure mode. We verify parity by computing the expected result
 * using the site's own functions and comparing against the email pipeline's
 * output across a wide matrix of temperatures and river levels.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const M = require('./daily_email.js');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

// The extracted site logic runs inside a `vm` context, so arrays/objects it
// creates belong to a different realm and have a different Array.prototype.
// assert.deepStrictEqual compares prototypes, so cross-realm values must be
// normalised through JSON before structural comparison.
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// Build synthetic history that guarantees a given zone is "earned" via the
// 3-morning streak, so we can drive the pipeline into every zone deliberately.
// Readings MUST land inside the 5:00-11:00 AM America/New_York window that
// checkMorningStreak looks at — computed properly rather than assuming a fixed
// UTC offset, so these tests stay correct across DST.
function historyAtTemp(tempF, days = 10) {
  const out = [];
  const now = new Date();
  const nyToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [y, m, d] = nyToday.split('-').map(Number);

  // Same offset derivation index.html uses, so 7am/9am really are 7am/9am ET.
  function nyBound(yy, mm, dd, hour) {
    const noonUTC = new Date(Date.UTC(yy, mm - 1, dd, 12, 0, 0));
    const nyHourAtNoon = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(noonUTC), 10);
    const offsetHours = nyHourAtNoon - 12;
    return Date.UTC(yy, mm - 1, dd, hour - offsetHours, 0, 0);
  }

  for (let ago = 1; ago <= days; ago++) {
    const target = new Date(Date.UTC(y, m - 1, d - ago, 12, 0, 0));
    for (const hour of [7, 9]) {
      out.push({
        ts: nyBound(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), hour),
        tempF,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function makeRaw(tempF, fetchedAt = new Date()) {
  const tempC = (tempF - 32) * 5 / 9;
  return {
    data: { devices: [{
      deviceName: 'NHRC Water Sensor',
      deviceExt: { lastDeviceData: JSON.stringify({ online: true, tem: Math.round(tempC * 100), hum: 0 }) },
    }]},
    fetchedAt: fetchedAt.toISOString(),
  };
}

const logic = M.loadSiteLogic();

// ═══════════════════════════════════════════════════════════════════════════
section('1. Logic extraction from index.html');
// ═══════════════════════════════════════════════════════════════════════════

test('extracts all required functions', () => {
  for (const fn of ['getEffectiveLevel', 'floodStatusForBoat', 'combineStatus',
                    'floodSummaryLabel', 'extractTemp', 'nyTzAbbr', 'getFloodStatus']) {
    assert.strictEqual(typeof logic[fn], 'function', `${fn} missing`);
  }
  assert.strictEqual(typeof logic.state, 'object');
  assert.deepStrictEqual(plain(Object.keys(logic.ZONE_TIERS).sort()),
    ['coldWater', 'fourOar', 'normal', 'winter']);
});

test('every tier lists all four boat classes (no merged rows)', () => {
  // Regression guard for the Tier 3 "2x / 4+/-" merge bug: merged rows took the
  // worse of two boats' flood statuses and over-restricted 4+/4-.
  const expected = ['1x / 2-', '2x', '4+ / 4-', '4x / 8+'];
  for (const [zone, tiers] of Object.entries(logic.ZONE_TIERS)) {
    for (const tier of tiers) {
      assert.deepStrictEqual(
        plain(tier.boats.map(b => b.name)), expected,
        `${zone} / ${tier.name} has non-standard boat rows`);
    }
  }
});

test('extractTemp reads the Govee data.json shape', () => {
  const c = logic.extractTemp(makeRaw(72.0));
  assert.ok(Math.abs((c * 9 / 5 + 32) - 72.0) < 0.2, `got ${c}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. PARITY: email output === website output (safety critical)');
// ═══════════════════════════════════════════════════════════════════════════

// Recompute expected statuses using the site's own functions, exactly as
// index.html's renderRowingStatus does, and compare to the pipeline.
function expectedRowsFromSite(tempF, history, riverLevel, fetchedAt) {
  logic.state.allHistory = history;
  logic.state.lastTempF = tempF;
  logic.state.lastFetchedAt = fetchedAt;
  logic.state.riverLevel = riverLevel;
  const eff = logic.getEffectiveLevel(tempF);
  return {
    zone: eff.zone,
    rows: logic.ZONE_TIERS[eff.zone].map(tier => ({
      name: tier.name,
      boats: tier.boats.map(b => ({
        name: b.name,
        status: logic.combineStatus(b.s, logic.floodStatusForBoat(b.name, riverLevel)),
      })),
    })),
  };
}

const TEMPS = [30, 38, 39.9, 40, 45, 50, 50.1, 55, 60, 60.1, 65, 72, 80];
const LEVELS = [null, 2.5, 7.9, 8, 8.5, 9, 9.5, 10, 10.4, 11, 11.5, 12, 12.1, 15];

test(`boat statuses match the site across ${TEMPS.length}x${LEVELS.length} = ${TEMPS.length * LEVELS.length} scenarios`, () => {
  let checks = 0;
  for (const tempF of TEMPS) {
    for (const level of LEVELS) {
      const hist = historyAtTemp(tempF);
      const fetchedAt = new Date();
      const raw = makeRaw(tempF, fetchedAt);

      const expected = expectedRowsFromSite(tempF, hist, level, fetchedAt);

      const river = { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() };
      const digest = M.computeDigest(logic, { raw, history: hist }, river,
        { available: false }, new Date());

      assert.strictEqual(digest.zone, expected.zone,
        `zone mismatch @ ${tempF}F / ${level}ft`);

      for (let i = 0; i < expected.rows.length; i++) {
        for (let j = 0; j < expected.rows[i].boats.length; j++) {
          const e = expected.rows[i].boats[j];
          const a = digest.rows[i].boats[j];
          assert.strictEqual(a.name, e.name);
          assert.strictEqual(a.status, e.status,
            `status mismatch @ ${tempF}F / ${level}ft — ${expected.rows[i].name} / ${e.name}: site=${e.status} email=${a.status}`);
          checks++;
        }
      }
    }
  }
  assert.ok(checks > 2000, `expected many checks, ran ${checks}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. Flood restrictions are honoured (never under-restrict)');
// ═══════════════════════════════════════════════════════════════════════════

test('warm water + high river still restricts small boats', () => {
  // 75F water alone = Normal (everything Go). River at 11.5ft must override.
  const hist = historyAtTemp(75);
  const digest = M.computeDigest(logic, { raw: makeRaw(75), history: hist },
    { level: 11.5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());

  assert.strictEqual(digest.zone, 'normal');
  for (const tier of digest.rows) {
    const single = tier.boats.find(b => b.name === '1x / 2-');
    const dbl    = tier.boats.find(b => b.name === '2x');
    assert.strictEqual(single.status, 'no',
      `${tier.name}: singles/pairs must be restricted at 11.5ft, got ${single.status}`);
    assert.strictEqual(dbl.status, 'no',
      `${tier.name}: doubles must be restricted at 11.5ft, got ${dbl.status}`);
  }
});

test('river above 12 ft restricts every boat in every tier', () => {
  const hist = historyAtTemp(75);
  const digest = M.computeDigest(logic, { raw: makeRaw(75), history: hist },
    { level: 12.5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  for (const tier of digest.rows) {
    for (const b of tier.boats) {
      assert.strictEqual(b.status, 'no',
        `${tier.name} / ${b.name} should be No above 12ft, got ${b.status}`);
    }
  }
});

test('combined status is always the MORE restrictive of temp and flood', () => {
  const rank = { go: 0, caution: 1, no: 2 };
  for (const tempF of [35, 45, 55, 70]) {
    for (const level of [5, 9, 10, 11, 12, 13]) {
      const hist = historyAtTemp(tempF);
      const digest = M.computeDigest(logic, { raw: makeRaw(tempF), history: hist },
        { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
        { available: false }, new Date());
      const tiers = logic.ZONE_TIERS[digest.zone];
      digest.rows.forEach((row, i) => {
        row.boats.forEach((b, j) => {
          const tempS  = tiers[i].boats[j].s;
          const floodS = logic.floodStatusForBoat(b.name, level);
          assert.ok(rank[b.status] >= rank[tempS] && rank[b.status] >= rank[floodS],
            `@${tempF}F/${level}ft ${b.name}: combined=${b.status} temp=${tempS} flood=${floodS}`);
        });
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. Cold-water zones');
// ═══════════════════════════════════════════════════════════════════════════

test('freezing water forces winter zone regardless of warm history', () => {
  const hist = historyAtTemp(75); // warm history
  const digest = M.computeDigest(logic, { raw: makeRaw(35), history: hist },
    { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  // Zone is the safety-relevant output and must always be winter below 40F.
  // (The `immediate` flag is intentionally NOT asserted here: it depends on
  // whether the run happens inside the 5-11am ET window, because the live cold
  // reading is folded into today's morning streak. Both outcomes are correct
  // site behaviour; parity with index.html is covered by the section-2 matrix.)
  assert.strictEqual(digest.zone, 'winter', 'below 40F must be Winter Rowing');
});

test('every zone the email reports is a zone the site defines', () => {
  for (const tempF of [20, 35, 42, 48, 52, 58, 62, 75, 90]) {
    const digest = M.computeDigest(logic,
      { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
      { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
      { available: false }, new Date());
    assert.ok(Object.prototype.hasOwnProperty.call(logic.ZONE_TIERS, digest.zone),
      `unknown zone ${digest.zone} @ ${tempF}F`);
    assert.ok(digest.zoneLabel && digest.zoneLabel !== digest.zone,
      `zone ${digest.zone} has no human-readable label`);
  }
});

test('no history at all falls back to the most restrictive zone', () => {
  const digest = M.computeDigest(logic, { raw: makeRaw(75), history: [] },
    { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  assert.strictEqual(digest.zone, 'winter',
    'with no history the site stays in Winter; email must agree');
});

// ═══════════════════════════════════════════════════════════════════════════
section('5. River staleness and fallback');
// ═══════════════════════════════════════════════════════════════════════════

test('stale threshold constant matches index.html (6h)', () => {
  assert.strictEqual(M.STALE_MS, 6 * 3600000);
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/const STALE_MS = 6 \* 3600000/.test(html),
    'index.html no longer uses a 6h river staleness threshold — keep these in sync');
});

test('parseGaugeSeries drops null/zero readings and sorts ascending', () => {
  const out = M.parseGaugeSeries({ data: [
    { validTime: '2026-08-03T12:00:00Z', primary: 5 },
    { validTime: '2026-08-03T06:00:00Z', primary: 4 },
    { validTime: '2026-08-03T18:00:00Z', primary: null },
    { validTime: '2026-08-03T20:00:00Z', primary: 0 },
    { validTime: 'garbage', primary: 9 },
  ]});
  assert.strictEqual(out.length, 2);
  assert.ok(out[0].ts < out[1].ts, 'must be sorted ascending');
  assert.deepStrictEqual(out.map(o => o.ft), [4, 5]);
});

test('stale river surfaces a warning in the email body', () => {
  const hist = historyAtTemp(75);
  const digest = M.computeDigest(logic, { raw: makeRaw(75), history: hist },
    { level: 10, isEstimate: true, failed: false, stale: true,
      ageMs: 25 * 86400000, lastObsTs: Date.now() - 25 * 86400000 },
    { available: true, tempF: 78, feelsF: 80, cond: 'Clear sky', windMph: 5,
      gustMph: 9, dir: 'NW', precip: '0.00' }, new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(/River gauge data is stale/.test(html), 'missing stale warning');
  assert.ok(/25 days/.test(html), 'should state how stale');
});

test('total NOAA failure warns and does not fabricate a level', () => {
  const hist = historyAtTemp(75);
  const digest = M.computeDigest(logic, { raw: makeRaw(75), history: hist },
    { level: null, isEstimate: false, failed: true, stale: true, ageMs: null, lastObsTs: null },
    { available: false }, new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(/River level unavailable/.test(html));
  assert.ok(/--/.test(html), 'level should render as -- not a made-up number');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6. Sensor staleness');
// ═══════════════════════════════════════════════════════════════════════════

test('offline sensor (>3h) produces a warning', () => {
  const old = new Date(Date.now() - 5 * 3600000);
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72, old), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  assert.strictEqual(digest.sensorStale, true);
  assert.ok(/Water sensor may be offline/.test(M.renderEmailHtml(digest)));
});

test('fresh sensor produces no offline warning', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72, new Date()), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  assert.strictEqual(digest.sensorStale, false);
  assert.ok(!/Water sensor may be offline/.test(M.renderEmailHtml(digest)));
});

// ═══════════════════════════════════════════════════════════════════════════
section('7. Timezone / DST correctness');
// ═══════════════════════════════════════════════════════════════════════════

test('nyTzAbbr returns EDT in summer and EST in winter', () => {
  assert.strictEqual(logic.nyTzAbbr(Date.UTC(2026, 6, 15, 12)), 'EDT');
  assert.strictEqual(logic.nyTzAbbr(Date.UTC(2026, 0, 15, 12)), 'EST');
});

test('the 4am ET schedule fires at 4am local in BOTH DST regimes', () => {
  // The workflow runs at 08:00 and 09:00 UTC, and the script self-gates so only
  // the run matching 4am America/New_York proceeds. Verify that gate.
  function localHourFor(utcHour, year, month, day) {
    const d = new Date(Date.UTC(year, month, day, utcHour, 0, 0));
    return parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(d), 10);
  }
  // Summer (EDT, UTC-4): 08:00 UTC === 4am ET
  assert.strictEqual(localHourFor(8, 2026, 6, 15), 4, 'Jul: 08 UTC should be 4am EDT');
  assert.notStrictEqual(localHourFor(9, 2026, 6, 15), 4, 'Jul: 09 UTC must NOT be 4am');
  // Winter (EST, UTC-5): 09:00 UTC === 4am ET
  assert.strictEqual(localHourFor(9, 2026, 0, 15), 4, 'Jan: 09 UTC should be 4am EST');
  assert.notStrictEqual(localHourFor(8, 2026, 0, 15), 4, 'Jan: 08 UTC must NOT be 4am');
  // Exactly one of the two cron times is 4am on any given day
  for (const [y, mo, dy] of [[2026,0,15],[2026,2,10],[2026,6,15],[2026,10,5],[2026,11,31]]) {
    const hits = [8, 9].filter(h => localHourFor(h, y, mo, dy) === 4);
    assert.strictEqual(hits.length, 1,
      `${y}-${mo+1}-${dy}: expected exactly one 4am-ET run, got ${hits.length}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('7b. Rowing season gate');
// ═══════════════════════════════════════════════════════════════════════════

// Noon ET (16:00/17:00 UTC depending on DST) — unambiguous for date-only checks.
function etNoon(month, day, year = 2026) {
  return new Date(Date.UTC(year, month - 1, day, 17, 0, 0));
}

test('configured season is March 15 - November 15', () => {
  assert.deepStrictEqual(
    { sm: M.SEASON.startMonth, sd: M.SEASON.startDay, em: M.SEASON.endMonth, ed: M.SEASON.endDay },
    { sm: 3, sd: 15, em: 11, ed: 15 });
});

test('mid-season months are all in season', () => {
  for (const mo of [4, 5, 6, 7, 8, 9, 10]) {
    assert.strictEqual(M.isInSeason(etNoon(mo, 15)), true, `month ${mo} should be in season`);
  }
});

test('deep off-season months are all out', () => {
  for (const [mo, dy] of [[12, 15], [1, 15], [2, 15]]) {
    assert.strictEqual(M.isInSeason(etNoon(mo, dy)), false, `${mo}/${dy} should be off season`);
  }
});

test('start boundary: Mar 14 out, Mar 15 in (inclusive)', () => {
  assert.strictEqual(M.isInSeason(etNoon(3, 14)), false, 'Mar 14 must be off season');
  assert.strictEqual(M.isInSeason(etNoon(3, 15)), true,  'Mar 15 must be in season');
  assert.strictEqual(M.isInSeason(etNoon(3, 16)), true,  'Mar 16 must be in season');
});

test('end boundary: Nov 15 in (inclusive), Nov 16 out', () => {
  assert.strictEqual(M.isInSeason(etNoon(11, 14)), true,  'Nov 14 must be in season');
  assert.strictEqual(M.isInSeason(etNoon(11, 15)), true,  'Nov 15 must be in season');
  assert.strictEqual(M.isInSeason(etNoon(11, 16)), false, 'Nov 16 must be off season');
});

test('partial months are handled: early March out, late November out', () => {
  assert.strictEqual(M.isInSeason(etNoon(3, 1)), false, 'Mar 1 is before the season starts');
  assert.strictEqual(M.isInSeason(etNoon(3, 31)), true, 'Mar 31 is after the season starts');
  assert.strictEqual(M.isInSeason(etNoon(11, 1)), true, 'Nov 1 is before the season ends');
  assert.strictEqual(M.isInSeason(etNoon(11, 30)), false, 'Nov 30 is after the season ends');
});

test('season is evaluated in Eastern time, not UTC (boundary day)', () => {
  // 2026-11-16T02:00Z is still Nov 15 (9pm) in New York — the final day of the
  // season. A naive UTC check would read November 16 and stop a day early.
  const d = new Date(Date.UTC(2026, 10, 16, 2, 0, 0));
  assert.strictEqual(d.getUTCDate(), 16, 'sanity: UTC date is the 16th');
  assert.strictEqual(M.isInSeason(d), true,
    'Nov 15 9pm ET is still in season even though UTC says Nov 16');

  // Mirror case at the start: 2026-03-15T02:00Z is Mar 14 (9pm) ET — still out.
  const d2 = new Date(Date.UTC(2026, 2, 15, 2, 0, 0));
  assert.strictEqual(d2.getUTCDate(), 15, 'sanity: UTC date is the 15th');
  assert.strictEqual(M.isInSeason(d2), false,
    'Mar 14 9pm ET is still off season even though UTC says Mar 15');
});

test('the actual 4am ET send time is in season on both boundary days', () => {
  // The real send happens at 4am ET. Verify the gate agrees on the exact
  // first and last mornings of the season.
  const firstMorning = new Date(Date.UTC(2026, 2, 15, 8, 0, 0));  // Mar 15, 4am EDT
  const lastMorning  = new Date(Date.UTC(2026, 10, 15, 9, 0, 0)); // Nov 15, 4am EST
  const dayBefore    = new Date(Date.UTC(2026, 2, 14, 8, 0, 0));  // Mar 14, 4am EDT
  const dayAfter     = new Date(Date.UTC(2026, 10, 16, 9, 0, 0)); // Nov 16, 4am EST

  assert.strictEqual(M.isInSeason(firstMorning), true, 'first send of the season');
  assert.strictEqual(M.isInSeason(lastMorning), true, 'last send of the season');
  assert.strictEqual(M.isInSeason(dayBefore), false, 'no send the day before');
  assert.strictEqual(M.isInSeason(dayAfter), false, 'no send the day after');
});

test('a season that wraps the new year works', () => {
  const winter = { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31 };
  for (const [mo, dy] of [[11, 1], [12, 25], [1, 15], [3, 31]]) {
    assert.strictEqual(M.isInSeason(etNoon(mo, dy), winter), true,
      `${mo}/${dy} should be inside a Nov 1 - Mar 31 season`);
  }
  for (const [mo, dy] of [[10, 31], [4, 1], [7, 15]]) {
    assert.strictEqual(M.isInSeason(etNoon(mo, dy), winter), false,
      `${mo}/${dy} should be outside a Nov 1 - Mar 31 season`);
  }
});

test('every day of the year resolves to a definite in/out answer', () => {
  let inCount = 0, outCount = 0;
  for (let mo = 1; mo <= 12; mo++) {
    const daysInMonth = new Date(Date.UTC(2026, mo, 0)).getUTCDate();
    for (let dy = 1; dy <= daysInMonth; dy++) {
      const r = M.isInSeason(etNoon(mo, dy));
      assert.strictEqual(typeof r, 'boolean', `${mo}/${dy} returned ${r}`);
      r ? inCount++ : outCount++;
    }
  }
  // Mar 15 - Nov 15 inclusive is 246 days in a non-leap year.
  assert.strictEqual(inCount, 246, `expected 246 in-season days, got ${inCount}`);
  assert.strictEqual(inCount + outCount, 365, 'should cover the whole year');
});

test('season config values are valid calendar dates', () => {
  for (const [m, d] of [[M.SEASON.startMonth, M.SEASON.startDay],
                        [M.SEASON.endMonth, M.SEASON.endDay]]) {
    assert.ok(Number.isInteger(m) && m >= 1 && m <= 12, `bad month ${m}`);
    const maxDay = new Date(Date.UTC(2026, m, 0)).getUTCDate();
    assert.ok(Number.isInteger(d) && d >= 1 && d <= maxDay,
      `day ${d} is not valid for month ${m} (max ${maxDay})`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('8. Rendering');
// ═══════════════════════════════════════════════════════════════════════════

function sampleDigest(overrides = {}) {
  return M.computeDigest(logic,
    { raw: makeRaw(72.4), history: historyAtTemp(72.4) },
    Object.assign({ level: 10, isEstimate: false, failed: false, stale: false,
                    ageMs: 0, lastObsTs: Date.now() }, overrides.river || {}),
    { available: true, tempF: 78, feelsF: 80, cond: 'Partly cloudy',
      windMph: 8, gustMph: 14, dir: 'NW', precip: '0.00' },
    new Date());
}

function sampleDigestWithCode(code) {
  return M.computeDigest(logic,
    { raw: makeRaw(72.4), history: historyAtTemp(72.4) },
    { level: 10, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: true, code, tempF: 78, feelsF: 80,
      windMph: 8, gustMph: 14, dir: 'NW', precip: '0.00' },
    new Date());
}

test('renders every tier and all four boat columns', () => {
  const html = M.renderEmailHtml(sampleDigest());
  // Tier labels are abbreviated ("T1 Novice") so the five-column table fits a
  // phone screen without wrapping, but every tier must still be identifiable.
  for (const t of ['T1 Novice', 'T2 Intermediate', 'T3 Senior']) {
    assert.ok(html.includes(t), `missing ${t}`);
  }
  for (const c of ['1x / 2-', '2x', '4+ / 4-', '4x / 8+']) {
    assert.ok(html.includes(c), `missing column ${c}`);
  }
});

test('mobile and dark-mode hardening is present', () => {
  const html = M.renderEmailHtml(sampleDigest());
  assert.ok(/name="color-scheme"/.test(html),
    'missing color-scheme meta — iOS will invert the palette');
  assert.ok(/supported-color-schemes/.test(html), 'missing supported-color-schemes meta');
  assert.ok(/-webkit-text-size-adjust:100%/.test(html),
    'missing text-size-adjust — iOS inflates fonts and breaks the table');
  assert.ok(/@media only screen and \(max-width:480px\)/.test(html),
    'missing phone breakpoint');
  assert.ok(/@media \(prefers-color-scheme: dark\)/.test(html),
    'missing dark-mode colour pinning');
});

test('status pills use opaque colours (clients drop alpha)', () => {
  const html = M.renderEmailHtml(sampleDigest());
  const pills = html.match(/class="bd-pill[^"]*"[^>]*style="([^"]+)"/g) || [];
  assert.ok(pills.length > 0, 'no status pills rendered');
  for (const p of pills) {
    assert.ok(!/rgba\(/.test(p), `pill uses rgba(), which some clients drop: ${p}`);
  }
});

test('boat labels and pills do not wrap mid-token', () => {
  const html = M.renderEmailHtml(sampleDigest());
  assert.ok(/white-space:nowrap/.test(html),
    'boat labels need nowrap or they break across lines on narrow screens');
});

test('includes an unsubscribe link (legally required for bulk email)', () => {
  const html = M.renderEmailHtml(sampleDigest());
  assert.ok(/unsubscribe/i.test(html), 'no unsubscribe link');
  assert.ok(html.includes('{{ unsubscribe_url }}'),
    'must use Buttondown\'s unsubscribe template variable');
});

test('includes the safety disclaimer', () => {
  const html = M.renderEmailHtml(sampleDigest());
  assert.ok(/guidance only/i.test(html), 'missing verify-at-boathouse disclaimer');
});

test('produces balanced HTML tables', () => {
  const html = M.renderEmailHtml(sampleDigest());
  const open = (html.match(/<table/g) || []).length;
  const close = (html.match(/<\/table>/g) || []).length;
  assert.strictEqual(open, close, `unbalanced <table>: ${open} open, ${close} close`);
  const tdO = (html.match(/<td[\s>]/g) || []).length;
  const tdC = (html.match(/<\/td>/g) || []).length;
  assert.strictEqual(tdO, tdC, `unbalanced <td>: ${tdO} vs ${tdC}`);
});

test('escapes HTML to prevent injection from upstream data', () => {
  const digest = sampleDigest();
  digest.weather.cond = '<script>alert(1)</script>';
  const html = M.renderEmailHtml(digest);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw script tag leaked into email');
  assert.ok(html.includes('&lt;script&gt;'), 'should be escaped');
});

test('subject line includes club, temperature and river level', () => {
  const d = sampleDigest();
  const s = M.renderSubject(d);
  assert.ok(s.includes('NHRC'), s);
  assert.ok(s.includes('72.4'), s);
  assert.ok(/river/.test(s), `subject must surface the river level: ${s}`);
});

test('SAFETY: subject never claims "clear" when any boat is restricted', () => {
  // Regression guard. The subject used to be built from the temperature zone
  // alone, so it read "Normal conditions" even at 13 ft when nobody could row.
  let checked = 0;
  for (const tempF of [30, 38, 45, 52, 58, 65, 72, 80]) {
    for (const level of [2.5, 7.9, 8.5, 9, 9.5, 10, 10.4, 11, 11.5, 12, 12.1, 15]) {
      const digest = M.computeDigest(logic,
        { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
        { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
        { available: false }, new Date());
      const subject = M.renderSubject(digest);
      const restricted = digest.rows.flatMap(r => r.boats).filter(b => b.status !== 'go');
      if (restricted.length > 0) {
        assert.ok(!/all boats clear/i.test(subject),
          `@${tempF}F/${level}ft — ${restricted.length} boats restricted but subject says clear: "${subject}"`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 90, `expected a broad sweep, ran ${checked}`);
});

test('SAFETY: subject shouts when NO boat may launch', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 13, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  assert.ok(digest.rows.flatMap(r => r.boats).every(b => b.status === 'no'),
    'sanity: every boat should be restricted at 13 ft');
  assert.ok(/ALL BOATS RESTRICTED/.test(M.renderSubject(digest)),
    `subject should state that nobody can row: "${M.renderSubject(digest)}"`);
});

test('SAFETY: subject does not claim clear when the river reading is missing', () => {
  // With no river data the flood rules cannot run, so every boat looks clear.
  // The subject must not present that absence of data as a safe all-clear.
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: null, isEstimate: false, failed: true, stale: true, ageMs: null, lastObsTs: null },
    { available: false }, new Date());
  const s = M.renderSubject(digest);
  assert.ok(!/all boats clear/i.test(s), `must not assert all-clear without river data: "${s}"`);
  assert.ok(/check river|river n\/a/i.test(s), `should flag the missing reading: "${s}"`);
});

test('subject names the binding constraint (temperature, river, or both)', () => {
  const mk = (tempF, level) => M.renderSubject(M.computeDigest(logic,
    { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
    { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date()));

  assert.ok(/All boats clear/.test(mk(72, 5)), mk(72, 5));
  assert.ok(/high river/.test(mk(72, 10.4)), mk(72, 10.4));
  assert.ok(/Four Oar Rule/.test(mk(48, 5)), mk(48, 5));
  const both = mk(48, 11.5);
  assert.ok(/Four Oar Rule/.test(both) && /high river/.test(both),
    `both causes should appear: "${both}"`);
});

test('subject marks an estimated river level as an estimate', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 10, isEstimate: true, failed: false, stale: true,
      ageMs: 25 * 86400000, lastObsTs: Date.now() - 25 * 86400000 },
    { available: false }, new Date());
  assert.ok(/est\./.test(M.renderSubject(digest)),
    `estimated levels should be labelled: "${M.renderSubject(digest)}"`);
});

test('subject stays a reasonable length for mobile inboxes', () => {
  for (const [tempF, level] of [[72, 5], [48, 11.5], [72, 13], [35, 5]]) {
    const s = M.renderSubject(M.computeDigest(logic,
      { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
      { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
      { available: false }, new Date()));
    assert.ok(s.length <= 78, `subject too long (${s.length}): "${s}"`);
  }
});

test('renders without throwing in every zone', () => {
  for (const tempF of [30, 45, 55, 75]) {
    const digest = M.computeDigest(logic,
      { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
      { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
      { available: false }, new Date());
    const html = M.renderEmailHtml(digest);
    assert.ok(html.length > 1000, `suspiciously short email for ${tempF}F`);
    assert.ok(html.includes('<!DOCTYPE html>'));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('8a. Club logo');
// ═══════════════════════════════════════════════════════════════════════════

test('the logo PNG exists and was generated from the SVG', () => {
  const fs = require('fs');
  const png = path.join(__dirname, '..', 'nhrc_email_logo.png');
  const svg = path.join(__dirname, '..', 'NHRC_logo.svg');
  assert.ok(fs.existsSync(svg), 'NHRC_logo.svg (the source) is missing');
  assert.ok(fs.existsSync(png), 'nhrc_email_logo.png is missing — regenerate it (see scripts/README.md)');
  const buf = fs.readFileSync(png);
  assert.ok(buf.length > 2000, `logo PNG looks truncated (${buf.length} bytes)`);
  // PNG magic number
  assert.deepStrictEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'not a valid PNG');
});

test('the email references the logo by absolute URL', () => {
  const html = M.renderEmailHtml(sampleDigest());
  const m = html.match(/<img[^>]+src="([^"]+)"[^>]*alt="NHRC"/);
  assert.ok(m, 'no logo <img> found in the email header');
  assert.ok(/^https:\/\//.test(m[1]),
    `logo src must be an absolute https URL (mail clients cannot read repo files), got: ${m[1]}`);
});

test('the email does NOT reference the SVG (unsupported in email)', () => {
  const html = M.renderEmailHtml(sampleDigest());
  assert.ok(!/\.svg/i.test(html),
    'email must not reference an SVG — Gmail, Outlook and Apple Mail will not render it');
});

test('logo has alt text so it degrades when images are blocked', () => {
  // Many clients block images by default; the club name must still be readable.
  const html = M.renderEmailHtml(sampleDigest());
  assert.ok(/<img[^>]+alt="NHRC"/.test(html), 'logo needs alt text');
  assert.ok(html.includes('New Haven Rowing Club'),
    'club name must appear as real text, not only inside the image');
});

test('logo has explicit width and height (prevents layout shift in Outlook)', () => {
  const html = M.renderEmailHtml(sampleDigest());
  const tag = html.match(/<img[^>]+alt="NHRC"[^>]*>/)[0];
  assert.ok(/width="\d+"/.test(tag), 'missing width attribute');
  assert.ok(/height="\d+"/.test(tag), 'missing height attribute');
});

test('logo URL can be overridden for pre-merge previews', () => {
  const saved = process.env.EMAIL_LOGO_URL;
  try {
    delete require.cache[require.resolve('./daily_email.js')];
    process.env.EMAIL_LOGO_URL = 'https://example.com/test-logo.png';
    const Fresh = require('./daily_email.js');
    assert.strictEqual(Fresh.LOGO_URL, 'https://example.com/test-logo.png');
  } finally {
    if (saved === undefined) delete process.env.EMAIL_LOGO_URL;
    else process.env.EMAIL_LOGO_URL = saved;
    delete require.cache[require.resolve('./daily_email.js')];
    require('./daily_email.js');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('8b. Weather icons');
// ═══════════════════════════════════════════════════════════════════════════

test('icon mapping is extracted from index.html, not duplicated', () => {
  assert.ok(logic.WMO_ICONS, 'WMO_ICONS should be extracted from the site');
  assert.ok(logic.WMO_CODES, 'WMO_CODES should be extracted from the site');
  // The email must use the same icons the website shows.
  for (const code of [0, 3, 61, 71, 95]) {
    assert.strictEqual(M.describeWeatherCode(code, logic).icon, logic.WMO_ICONS[code],
      `code ${code} icon should match the site's`);
    assert.strictEqual(M.describeWeatherCode(code, logic).cond, logic.WMO_CODES[code],
      `code ${code} label should match the site's`);
  }
});

test('every documented WMO code maps to a distinct-looking icon and label', () => {
  for (const code of Object.keys(M.WMO_CODES_FALLBACK)) {
    const { cond, icon } = M.describeWeatherCode(Number(code), logic);
    assert.notStrictEqual(cond, 'Unknown', `code ${code} has no label`);
    assert.ok(/^&#\d+;$/.test(icon), `code ${code} icon is not an HTML entity: ${icon}`);
  }
});

test('unmapped weather codes fall back to a default icon, not a blank', () => {
  const { cond, icon } = M.describeWeatherCode(12345, logic);
  assert.strictEqual(cond, 'Unknown');
  assert.strictEqual(icon, M.DEFAULT_WEATHER_ICON);
  assert.ok(icon && icon.length > 0, 'must never render an empty icon');
});

test('resolution works even if extraction from index.html fails', () => {
  // Passing no logic object simulates extraction failure — a cosmetic lookup
  // must never be able to break a send.
  const { cond, icon } = M.describeWeatherCode(0, null);
  assert.strictEqual(cond, 'Clear sky');
  assert.ok(/^&#\d+;$/.test(icon));
});

test('an existing label is not clobbered when no code is present', () => {
  // Regression: computeDigest previously overwrote a caller-supplied `cond`
  // with "Unknown" whenever weather.code was absent.
  const out = M.withWeatherDescription(
    { available: true, cond: 'Partly cloudy', tempF: 78 }, logic);
  assert.strictEqual(out.cond, 'Partly cloudy', 'existing label must survive');
  assert.strictEqual(out.icon, M.DEFAULT_WEATHER_ICON, 'should still get an icon');
});

test('a real weather code resolves through computeDigest into the email', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: true, code: 61, tempF: 60, feelsF: 58, windMph: 10,
      gustMph: 18, dir: 'NE', precip: '0.12' },
    new Date());
  assert.strictEqual(digest.weather.cond, logic.WMO_CODES[61], 'should be the rain label');
  const html = M.renderEmailHtml(digest);
  assert.ok(html.includes(logic.WMO_ICONS[61]), 'rain icon missing from email');
  assert.ok(html.includes('Light rain'), 'rain label missing from email');
});

test('weather icon is white and bold, not black on navy', () => {
  // Sun/cloud/snow/storm glyphs are BMP characters rendered as monochrome TEXT,
  // inheriting the surrounding colour — black by default, unreadable on navy.
  const html = M.renderEmailHtml(sampleDigestWithCode(3)); // overcast cloud
  const iconSpan = html.match(/<span style="color:#ffffff;font-weight:bold;">&#\d+;<\/span>/);
  assert.ok(iconSpan, 'icon must be wrapped in a white, bold span');

  const cell = html.match(/<td[^>]*font-size:32px[^>]*>/);
  assert.ok(cell && /color:#ffffff/.test(cell[0]),
    `icon cell should also set white as a fallback, got: ${cell && cell[0]}`);
});

test('icons must NOT force emoji presentation (it overrides colour)', () => {
  // U+FE0F requests a colour emoji, which ignores CSS colour entirely — that is
  // why the cloud stayed black despite the colour being set. Regression guard.
  const html = M.renderEmailHtml(sampleDigestWithCode(3));
  assert.ok(!/&#65039;/.test(html),
    'U+FE0F must not be present — it makes the glyph ignore the white colour');
});

test('icon is styled in both the weather block and the air-temp card', () => {
  const html = M.renderEmailHtml(sampleDigestWithCode(3));
  const styled = (html.match(/<span style="color:#ffffff;font-weight:bold;">&#\d+;<\/span>/g) || []).length;
  assert.strictEqual(styled, 2,
    `expected the styled icon in both places, found ${styled}`);
});

test('icons render as raw entities, not double-escaped', () => {
  const digest = sampleDigestWithCode(0);
  const html = M.renderEmailHtml(digest);
  assert.ok(html.includes('&#9728;'), 'sun entity should be present');
  assert.ok(!html.includes('&amp;#9728;'), 'icon entity must not be double-escaped');
});

test('icon appears in both the weather block and the air-temp card', () => {
  const digest = sampleDigestWithCode(0);
  const html = M.renderEmailHtml(digest);
  const occurrences = (html.match(/&#9728;/g) || []).length;
  assert.ok(occurrences >= 2,
    `expected the icon in the stat card and the weather row, found ${occurrences}`);
});

test('no icon is emitted when weather is unavailable', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(/Weather data unavailable/.test(html));
  assert.ok(!/&#\d{4,};/.test(html), 'should not render weather entities with no data');
});

// ═══════════════════════════════════════════════════════════════════════════
section('8c. Send scheduling and idempotency');
// ═══════════════════════════════════════════════════════════════════════════

test('daily slug is stable within a day and changes across days', () => {
  const a = M.dailySlug(new Date(Date.UTC(2026, 7, 6, 5, 30)));   // 1:30am ET
  const b = M.dailySlug(new Date(Date.UTC(2026, 7, 6, 8, 15)));   // 4:15am ET same day
  const c = M.dailySlug(new Date(Date.UTC(2026, 7, 7, 5, 30)));   // next day
  assert.strictEqual(a, b, 'same Eastern day must produce the same slug');
  assert.notStrictEqual(a, c, 'a new day must produce a new slug');
  assert.ok(/^nhrc-\d{4}-\d{2}-\d{2}$/.test(a), `unexpected slug format: ${a}`);
});

test('slug uses the Eastern date, not UTC', () => {
  // 02:00 UTC on Aug 7 is still 10pm on Aug 6 in New York. Keying off UTC would
  // roll the slug a day early and permit a second send within one Eastern day.
  const d = new Date(Date.UTC(2026, 7, 7, 2, 0));
  assert.strictEqual(d.getUTCDate(), 7, 'sanity: UTC date is the 7th');
  assert.strictEqual(M.dailySlug(d), 'nhrc-2026-08-06',
    'slug must follow the boathouse date, not UTC');
});

test('the send window covers every scheduled cron across DST', () => {
  // Crons fire at 05:00 and 06:00 UTC; the job proceeds when the Eastern hour
  // is 1-4. Every date must have at least one eligible run.
  function etHour(utcHour, y, mo, dy) {
    const d = new Date(Date.UTC(y, mo, dy, utcHour, 0, 0));
    return parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(d), 10);
  }
  const dates = [[2026,0,15],[2026,2,7],[2026,2,8],[2026,5,15],[2026,7,6],[2026,10,1],[2026,10,2],[2026,11,25]];
  for (const [y, mo, dy] of dates) {
    const eligible = [5, 6].filter(h => {
      const et = etHour(h, y, mo, dy);
      return et >= 1 && et <= 4;
    });
    assert.ok(eligible.length >= 1,
      `${y}-${mo+1}-${dy}: no run falls inside the 1-4am ET window`);
  }
});

test('the send window never extends past 5am', () => {
  // A digest arriving after 5am is too late to be useful before dawn practice.
  const fs2 = require('fs');
  const wf = fs2.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily_email.yml'), 'utf8');
  assert.ok(/-ge 1 \] && \[ "\$ET_HOUR" -le 4/.test(wf),
    'workflow gate should accept only the 1-4am Eastern hours');
});

// ═══════════════════════════════════════════════════════════════════════════
section('9. Failure modes');
// ═══════════════════════════════════════════════════════════════════════════

test('missing temperature data throws rather than sending a blank email', () => {
  assert.throws(() => {
    M.computeDigest(logic, { raw: { data: { devices: [] } }, history: [] },
      { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
      { available: false }, new Date());
  }, /water temperature/i);
});

test('weather outage degrades gracefully', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(/Weather data unavailable/.test(html));
  assert.ok(!/NaN|undefined|null/.test(html.replace(/\{\{[^}]*\}\}/g, '')),
    'no NaN/undefined leaking into the rendered email');
});

test('no NaN or undefined in a fully-degraded email', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: [] },
    { level: null, isEstimate: false, failed: true, stale: true, ageMs: null, lastObsTs: null },
    { available: false }, new Date());
  const html = M.renderEmailHtml(digest).replace(/\{\{[^}]*\}\}/g, '');
  assert.ok(!/NaN/.test(html), 'NaN leaked');
  assert.ok(!/undefined/.test(html), 'undefined leaked');
});

test('sendViaButtondown refuses to run without an API key', async () => {
  const saved = process.env.BUTTONDOWN_API_KEY;
  delete process.env.BUTTONDOWN_API_KEY;
  let threw = false;
  try { await M.sendViaButtondown('s', '<p>b</p>'); }
  catch (e) { threw = /BUTTONDOWN_API_KEY/.test(e.message); }
  finally { if (saved) process.env.BUTTONDOWN_API_KEY = saved; }
  assert.ok(threw, 'should refuse to send without a key');
});

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
if (failed > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f.name}\n    ${f.err.stack.split('\n').slice(0,3).join('\n    ')}`));
  process.exit(1);
}
