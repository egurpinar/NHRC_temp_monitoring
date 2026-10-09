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
let currentSection = '';

// Async tests run one at a time, after the synchronous ones, and are genuinely
// awaited. This harness used to call fn() and count it as passed on return - so
// an async test was "passed" the moment it STARTED, and an assertion failing
// inside it could never register. Verified: a deliberately failing assertion in
// the Buttondown key test reported PASS. Serial execution also stops tests that
// stub globals (fetch, env vars) from interleaving with each other.
let asyncChain = Promise.resolve();

function record(name, err, note = '') {
  if (!err) { passed++; console.log(`  PASS  ${name}${note}`); return; }
  failed++;
  failures.push({ name, err });
  console.log(`  FAIL  ${name}${note}`);
  console.log(`        ${err.message}`);
}

// The workflow runs this suite before sending, inside the 1-5 AM window. A test
// that never settles would hold the send until the job timed out - so no
// email. Each async test therefore gets a hard deadline.
const ASYNC_TEST_TIMEOUT_MS = 30000;

function test(name, fn) {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    const where = currentSection;
    asyncChain = asyncChain.then(async () => {
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ASYNC_TEST_TIMEOUT_MS / 1000}s`)),
          ASYNC_TEST_TIMEOUT_MS);
      });
      try { await Promise.race([fn(), deadline]); record(name, null, `  [async: ${where}]`); }
      catch (err) { record(name, err, `  [async: ${where}]`); }
      finally { clearTimeout(timer); }
    });
    return;
  }
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      throw new Error('test returned a promise but is not declared async; it would be counted before it finished');
    }
    record(name, null);
  } catch (err) {
    record(name, err);
  }
}

function section(title) {
  currentSection = title;
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

test('SAFETY every river label names exactly the boats the flood table restricts or cautions', () => {
  // The label is what people read - on the summary tile, the river card and in
  // the email - so it must agree with getFloodStatus() boat for boat. At
  // 11-12 ft it used to read "Singles & doubles restricted, 4x / 8+ caution",
  // silent on the fours the table restricts; at 10-11 ft it left out that the
  // fours need caution.
  const BOATS = ['1x', '2-', '2x', '4+', '4-', '4x', '8+'];
  for (const ft of [0.5, 3, 7.99, 8, 8.01, 8.5, 9, 9.01, 9.5, 10, 10.01, 10.5, 11, 11.01, 11.5, 12, 12.01, 13, 20]) {
    const { text, cls } = logic.floodSummaryLabel(ft);
    const expectNo = BOATS.filter(b => logic.getFloodStatus(b, ft) === 'no');
    const expectCaution = BOATS.filter(b => logic.getFloodStatus(b, ft) === 'caution');
    let saidNo = [], saidCaution = [];
    if (/^All boats restricted/.test(text)) saidNo = BOATS.slice();
    else if (text !== 'No river-level restrictions') {
      for (const part of text.split(',')) {
        const boats = part.match(/\d[x+-]/g) || [];
        if (/restricted/.test(part)) saidNo.push(...boats);
        else if (/caution/.test(part)) saidCaution.push(...boats);
        else assert.fail(`${ft} ft: cannot read "${part}" in "${text}"`);
      }
    }
    assert.deepStrictEqual(saidNo.sort(), expectNo.sort(), `${ft} ft "${text}": restricted boats`);
    assert.deepStrictEqual(saidCaution.sort(), expectCaution.sort(), `${ft} ft "${text}": caution boats`);
    assert.strictEqual(cls === 'rp-normal', !expectNo.length && !expectCaution.length,
      `${ft} ft: green pill only when nothing is restricted`);
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

test('river level: the email makes the website\'s decision, with the website\'s function', () => {
  assert.strictEqual(logic.RIVER_STALE_MS, 6 * 3600000, '6 h staleness');
  assert.strictEqual(logic.RIVER_FORECAST_MAX_GAP_MS, 12 * 3600000, 'forecast within 12 h of now');
  assert.strictEqual(M.STALE_MS, logic.RIVER_STALE_MS);
  assert.strictEqual(typeof logic.pickRiverLevel, 'function', 'pickRiverLevel must be exported to the email');
  const src = require('fs').readFileSync(path.join(__dirname, 'daily_email.js'), 'utf8');
  assert.ok(/logic\.pickRiverLevel\(/.test(src), 'loadRiver must delegate to the site\'s pickRiverLevel');
});

test('pickRiverLevel: every branch, at the exact boundaries', () => {
  const now = Date.parse('2026-10-03T09:00:00Z');
  const H = 3600000;
  const obs = (ageH, ft = 3.1) => [{ ts: now - 30 * H, ft: 2 }, { ts: now - ageH * H, ft }];
  const fc = (offH, ft = 4.4) => [{ ts: now + offH * H, ft }];
  const pick = (o, f) => logic.pickRiverLevel(o, f, now);
  let p = pick(obs(0.25), fc(1));
  assert.deepStrictEqual([p.level, p.isEstimate, p.stale], [3.1, false, false], 'fresh reading wins');
  p = pick(obs(6), fc(1));
  assert.deepStrictEqual([p.level, p.isEstimate, p.stale], [3.1, false, false], 'exactly 6 h is not yet stale');
  p = logic.pickRiverLevel(obs(6), fc(1), now + 1);
  assert.deepStrictEqual([p.level, p.isEstimate, p.stale], [4.4, true, true], '6 h + 1 ms: forecast estimate');
  assert.strictEqual(p.estimateTs, now + H);
  p = pick(obs(7), fc(-12));
  assert.deepStrictEqual([p.level, p.isEstimate], [4.4, true], 'a forecast point 12 h away still counts');
  p = pick(obs(7), fc(12.01));
  assert.deepStrictEqual([p.level, p.isEstimate, p.stale], [3.1, false, true],
    'a forecast more than 12 h from now is not an estimate of now: the stale reading, flagged stale');
  p = pick(obs(7), []);
  assert.deepStrictEqual([p.level, p.isEstimate, p.stale], [3.1, false, true], 'no forecast');
  p = pick([], fc(2));
  assert.deepStrictEqual([p.level, p.isEstimate, p.stale, p.lastObsTs, p.ageMs], [4.4, true, true, null, null], 'no readings');
  p = pick([], []);
  assert.deepStrictEqual([p.level, p.isEstimate], [null, false], 'nothing at all');
  p = pick(obs(8), [{ ts: now - 5 * H, ft: 5 }, { ts: now + 2 * H, ft: 6 }, { ts: now + 8 * H, ft: 7 }]);
  assert.strictEqual(p.level, 6, 'the forecast point nearest to now');
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

function staleRiverEmail(river) {
  const digest = M.computeDigest(logic, { raw: makeRaw(75), history: historyAtTemp(75) },
    Object.assign({ failed: false, stale: true }, river), { available: false }, new Date());
  return M.renderEmailHtml(digest);
}

test('stale gauge: a gauge silent for hours says hours - never "0 days"', () => {
  const now = Date.now();
  const html = staleRiverEmail({ level: 3.4, isEstimate: true, ageMs: 7.5 * 3600000, lastObsTs: now - 7.5 * 3600000 });
  assert.ok(/not updated in 7 hours/.test(html), html.match(/River gauge data is stale[^<]*<\/strong>[^<]*/)[0]);
  assert.ok(!/0 days/.test(html));
  assert.ok(/estimated from NOAA&(rsquo|#8217);s forecast/.test(html), 'the level is the forecast estimate');
});

test('stale gauge with no forecast: the level is called the last reading, not an estimate', () => {
  const now = Date.now();
  const html = staleRiverEmail({ level: 3.4, isEstimate: false, ageMs: 3 * 86400000, lastObsTs: now - 3 * 86400000 });
  assert.ok(/not updated in 3 days/.test(html));
  assert.ok(/that last reading, not a current one/.test(html));
  assert.ok(!/estimated from/.test(html), 'there was no forecast, so nothing was estimated');
});

test('stale gauge with no observed readings at all says so, rather than "an extended period"', () => {
  const html = staleRiverEmail({ level: 3.2, isEstimate: true, ageMs: null, lastObsTs: null });
  assert.ok(/observed readings for this gauge are unavailable/.test(html));
  assert.ok(/estimated from NOAA/.test(html));
});

test('stale gauge: the website and the email use the same words', async () => {
  const now = Date.now();
  const obsTs = now - 9 * 3600000;
  const series = (fc) => ({ data: fc
    ? [{ validTime: new Date(now + 3600e3).toISOString(), primary: 3.6 }]
    : [{ validTime: new Date(obsTs).toISOString(), primary: 3.4 }] });
  const { site, els } = loadSite(now, (url) => okJson(series(!/observed$/.test(url))));
  await site.loadRiverData();
  const note = logic.riverStaleNote(now - obsTs, obsTs, true);
  assert.ok(els['river-content'].innerHTML.includes(note), 'site river card: ' + els['river-content'].innerHTML.slice(0, 300));
  const html = staleRiverEmail({ level: 3.6, isEstimate: true, ageMs: now - obsTs, lastObsTs: obsTs });
  assert.ok(html.includes(M.toAsciiEntities(note)), 'email');
  assert.ok(/Forecast estimate/.test(els['sum-river'].innerHTML), 'summary tile marks the estimate');
});

test('stale gauge, no forecast: the summary tile says the reading is not current', async () => {
  const now = Date.now();
  const obsTs = now - 30 * 3600000;
  const { site, els } = loadSite(now, (url) => okJson(/observed$/.test(url)
    ? { data: [{ validTime: new Date(obsTs).toISOString(), primary: 3.4 }] } : { data: [] }));
  await site.loadRiverData();
  assert.ok(/3\.4 ft/.test(els['sum-river'].innerHTML));
  assert.ok(/not current/.test(els['sum-river'].innerHTML), els['sum-river'].innerHTML);
  assert.ok(!/Stevenson Dam gauge</.test(els['sum-river'].innerHTML), 'must not present it as a live gauge reading');
  assert.ok(/that last reading, not a current one/.test(els['river-content'].innerHTML));
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

test('a stale water reading is marked in the SUBJECT too - many members read only that', () => {
  const now = new Date();
  const mk = (ageH) => M.computeDigest(logic, { raw: makeRaw(66.3, new Date(now - ageH * 3600000)), history: historyAtTemp(66) },
    { level: 2.5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: now.getTime() }, { available: false }, now);
  const stale = M.renderSubject(mk(5), now), fresh = M.renderSubject(mk(0.5), now);
  assert.ok(/- 66\.3F \(old reading\) - river 2\.5 ft$/.test(stale), stale);
  assert.ok(/- 66\.3F - river 2\.5 ft$/.test(fresh), fresh);
  assert.ok(!/old reading/.test(M.renderSubject(mk(2.9), now)), 'under 3 hours is not stale');
  assert.ok(/^[\x20-\x7e]+$/.test(stale), 'still pure ASCII');
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

  // No restriction from either rule set is reported as exactly that - never as
  // "clear", which reads as a statement about conditions (Safety Committee,
  // October 2026).
  assert.ok(/No temp\/river restrictions/.test(mk(72, 5)), mk(72, 5));
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
    assert.ok(html.trimStart().startsWith('<table'),
      'email must be a fragment beginning with a table');
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
section('8a2. EMAIL CLIENT COMPATIBILITY (root-cause guards)');
// ═══════════════════════════════════════════════════════════════════════════
//
// Buttondown's free plan wraps our content in its own template, so anything
// that only works as a standalone document is silently discarded. These rules
// exist because breaking them produced black text, white-on-grey text, and an
// unreadable table on real devices.

function everyDigest() {
  const out = [];
  for (const [tempF, level] of [[72, 5], [72, 10.4], [48, 11.5], [35, 5], [72, 13]]) {
    out.push(M.computeDigest(logic,
      { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
      { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
      { available: true, code: 3, tempF: 70, feelsF: 69, windMph: 8,
        gustMph: 14, dir: 'NW', precip: '0.00' },
      new Date()));
  }
  // plus the fully-degraded case
  out.push(M.computeDigest(logic,
    { raw: makeRaw(72), history: [] },
    { level: null, isEstimate: false, failed: true, stale: true, ageMs: null, lastObsTs: null },
    { available: false }, new Date()));
  return out;
}

test('email is a FRAGMENT — no document wrapper', () => {
  for (const d of everyDigest()) {
    const html = M.renderEmailHtml(d);
    for (const forbidden of ['<!DOCTYPE', '<html', '</html>', '<head', '</head>', '<body', '</body>']) {
      assert.ok(!new RegExp(forbidden, 'i').test(html),
        `found ${forbidden} — Buttondown nests this inside its own document, so the client discards our head`);
    }
  }
});

test('no <style> blocks (they live in head and get dropped)', () => {
  for (const d of everyDigest()) {
    assert.ok(!/<style/i.test(M.renderEmailHtml(d)), 'found a <style> block');
  }
});

test('no media queries (they cannot survive without a style block)', () => {
  for (const d of everyDigest()) {
    assert.ok(!/@media/i.test(M.renderEmailHtml(d)), 'found a media query');
  }
});

test('no class attributes (no stylesheet exists to match them)', () => {
  for (const d of everyDigest()) {
    assert.ok(!/\sclass=/i.test(M.renderEmailHtml(d)), 'found a class attribute');
  }
});

test('no rgba() colours (several clients drop alpha entirely)', () => {
  for (const d of everyDigest()) {
    assert.ok(!/rgba\(/i.test(M.renderEmailHtml(d)), 'found an rgba() colour');
  }
});

test('every element carrying text also sets an explicit colour', () => {
  // Inheriting colour is precisely how our text ended up black: Buttondown's
  // template colour won wherever we did not state our own.
  for (const d of everyDigest()) {
    const html = M.renderEmailHtml(d);
    const tags = html.match(/<(td|div|span|a)\b[^>]*>/gi) || [];
    for (const tag of tags) {
      const style = (tag.match(/style="([^"]*)"/) || [])[1] || '';
      // Structural cells with no styling at all hold only nested markup.
      if (!style) continue;
      // font-size:0 marks a decorative spacer/rule that renders no text.
      if (/font-size\s*:\s*0\b/.test(style)) continue;
      if (/font-size|font-weight/.test(style)) {
        assert.ok(/(^|;)\s*color\s*:/.test(style),
          `text-bearing element has no explicit colour: ${tag.slice(0, 140)}`);
      }
    }
  }
});

test('every coloured text block also states its own background', () => {
  for (const d of everyDigest()) {
    const html = M.renderEmailHtml(d);
    const tags = html.match(/<(td|div)\b[^>]*style="[^"]*"[^>]*>/gi) || [];
    let checked = 0;
    for (const tag of tags) {
      const style = (tag.match(/style="([^"]*)"/) || [])[1] || '';
      if (!/(^|;)\s*color\s*:/.test(style)) continue;
      // <a> inherits its parent block; block elements must be opaque.
      assert.ok(/background-color\s*:/.test(style),
        `coloured block does not set a background, so it inherits the client's: ${tag.slice(0, 140)}`);
      checked++;
    }
    assert.ok(checked > 5, `expected many coloured blocks, saw ${checked}`);
  }
});

test('layout is fluid — no fixed width beyond the 600px shell', () => {
  for (const d of everyDigest()) {
    const html = M.renderEmailHtml(d);
    const widths = (html.match(/width="(\d+)"/g) || []).map(w => parseInt(w.match(/\d+/)[0], 10));
    for (const w of widths) {
      assert.ok(w <= 600, `fixed width ${w}px will overflow a 320px phone`);
    }
    assert.ok(/max-width:600px/.test(html), 'shell should cap at 600px');
    assert.ok(/width:100%/.test(html), 'shell should be fluid below that cap');
  }
});

test('no row has more than three real columns', () => {
  // The old five-column grid is what made the table unreadable on a phone.
  // Count only cells that belong to the row itself — a naive regex also counts
  // cells of nested tables, which are laid out independently.
  function maxColumnsPerRow(html) {
    const tokens = html.match(/<table\b|<\/table>|<tr\b|<\/tr>|<td\b/gi) || [];
    let tableDepth = 0;
    const rowStack = [];   // {depth, count}
    let max = 0;
    for (const t of tokens) {
      const tok = t.toLowerCase();
      if (tok.startsWith('<table')) tableDepth++;
      else if (tok === '</table>') tableDepth--;
      else if (tok.startsWith('<tr')) rowStack.push({ depth: tableDepth, count: 0 });
      else if (tok === '</tr>') {
        const r = rowStack.pop();
        if (r) max = Math.max(max, r.count);
      } else if (tok.startsWith('<td')) {
        const r = rowStack[rowStack.length - 1];
        // Only count the cell if it sits directly in the current row's table.
        if (r && r.depth === tableDepth) r.count++;
      }
    }
    return max;
  }
  for (const d of everyDigest()) {
    const cols = maxColumnsPerRow(M.renderEmailHtml(d));
    assert.ok(cols <= 3,
      `widest row has ${cols} columns; more than 3 cannot fit a 320px screen`);
  }
});

test('status colours are legible pairings, and distinct from each other', () => {
  // Rough relative-luminance contrast check on the text/background pairs.
  function lum(hex) {
    const n = parseInt(hex.slice(1), 16);
    const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  }
  const html = M.renderEmailHtml(everyDigest()[1]);
  const pills = html.match(/background-color:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/gi) || [];
  assert.ok(pills.length > 0, 'no status pills found');
  for (const p of pills) {
    const [, bg, fg] = p.match(/background-color:(#[0-9a-f]{6});color:(#[0-9a-f]{6})/i);
    const ratio = contrast(bg, fg);
    assert.ok(ratio >= 4.5,
      `contrast ${ratio.toFixed(2)}:1 between ${fg} on ${bg} is below the 4.5:1 readability floor`);
  }
});

test('body is sent through the Markdown pipeline, not the WYSIWYG', () => {
  // Fancy mode re-parses HTML into Buttondown's editor schema and normalises
  // away inline styles and nested tables. Markdown passes block HTML through.
  const src = require('fs').readFileSync(path.join(__dirname, 'daily_email.js'), 'utf8');
  assert.ok(/buttondown-editor-mode: plaintext/.test(src),
    'must declare plaintext (Markdown) editor mode');
  assert.ok(!/buttondown-editor-mode: fancy/.test(src),
    'fancy mode strips our inline styles');
});

test('unsubscribe link and disclaimer survive in every variant', () => {
  for (const d of everyDigest()) {
    const html = M.renderEmailHtml(d);
    assert.ok(html.includes('{{ unsubscribe_url }}'), 'missing unsubscribe token');
    assert.ok(/guidance only/i.test(html), 'missing safety disclaimer');
  }
});

test('no unclosed tags in any variant', () => {
  for (const d of everyDigest()) {
    const html = M.renderEmailHtml(d);
    for (const tag of ['table', 'tr', 'td', 'div', 'span', 'a']) {
      const open = (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length;
      const close = (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
      assert.strictEqual(open, close, `<${tag}> unbalanced: ${open} open vs ${close} close`);
    }
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






test('no icon is emitted when weather is unavailable', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(/Weather data unavailable/.test(html));
  // Check specifically for WMO icon codepoints. A blanket "no 4-digit entity"
  // check is wrong now that all non-ASCII is entity-encoded — the em dash in
  // the tier labels is legitimately &#8212;.
  const iconCodes = Object.values(M.WMO_ICONS_FALLBACK)
    .concat([M.DEFAULT_WEATHER_ICON])
    .map(e => e.replace(/[^0-9]/g, ''));
  for (const code of iconCodes) {
    assert.ok(!html.includes('&#' + code + ';'),
      `weather icon &#${code}; rendered despite no weather data`);
  }
});

async function emailWeatherWith(current) {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ current,
    daily: { sunrise: ['2026-10-03T06:53'], sunset: ['2026-10-03T18:32'] } }) });
  try { return await M.loadWeather(); } finally { global.fetch = realFetch; }
}
const CURRENT_OK = { temperature_2m: 58.4, apparent_temperature: 56.2, weather_code: 3, wind_speed_10m: 9.4,
  wind_gusts_10m: 23.8, wind_direction_10m: 310, precipitation: 0 };

test('every line of the email has a font set - none falls back to the client default (Times)', async () => {
  const w = await emailWeatherWith(CURRENT_OK);
  const html = M.renderEmailHtml(M.computeDigest(logic, { raw: makeRaw(66), history: historyAtTemp(66) },
    { level: 9.5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() }, w, new Date()));
  // Walk the markup with a stack: each text node must have an ancestor (or
  // itself) whose inline style sets font-family.
  const stack = [], bare = [];
  const re = /<(\/?)([a-z0-9]+)\b([^>]*?)(\/?)>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[5] !== undefined) {
      const text = m[5].replace(/&nbsp;|&#160;/g, '').trim();
      if (text && !stack.some(e => e.font)) bare.push(text.slice(0, 40));
      continue;
    }
    const [, close, tag, attrs, selfClose] = m;
    if (/^(br|img|hr|meta)$/i.test(tag) || selfClose) continue;
    if (close) { while (stack.length && stack.pop().tag !== tag.toLowerCase()); continue; }
    stack.push({ tag: tag.toLowerCase(), font: /font-family\s*:/.test(attrs) });
  }
  assert.deepStrictEqual(bare, [], 'text with no font-family on itself or any ancestor');
});

test('email weather: a missing temperature or wind is "unavailable" - never 0°F or 0 mph', async () => {
  // Math.round(null) is 0: an API gap used to print "Overcast, 0°F".
  for (const k of ['temperature_2m', 'wind_speed_10m']) {
    for (const bad of [null, undefined, 'x', NaN]) {
      const w = await emailWeatherWith(Object.assign({}, CURRENT_OK, { [k]: bad }));
      assert.strictEqual(w.available, false, `${k} = ${bad}`);
    }
  }
  assert.strictEqual((await emailWeatherWith(null)).available, false, 'no current block at all');
  const ok = await emailWeatherWith(CURRENT_OK);
  assert.deepStrictEqual([ok.available, ok.tempF, ok.windMph, ok.gustMph, ok.dir], [true, 58, 9, 24, 'NW']);
});

test('email weather: missing secondary values show "--", and the line still reads cleanly', async () => {
  const w = await emailWeatherWith(Object.assign({}, CURRENT_OK,
    { apparent_temperature: null, wind_gusts_10m: null, wind_direction_10m: null, precipitation: null }));
  assert.deepStrictEqual([w.feelsF, w.gustMph, w.dir, w.precip], ['--', '--', '--', '--']);
  const digest = M.computeDigest(logic, { raw: makeRaw(66), history: historyAtTemp(66) },
    { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() }, w, new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(/Wind 9 mph, gusts --</.test(html), html.match(/Wind [^<]*/)[0]);
  assert.ok(/Feels like --/.test(html) && /Precipitation --</.test(html));
  assert.ok(!/[^0-9.]0&#176;F|null|undefined|NaN/.test(html), 'no standalone 0°F, no null/undefined/NaN');
});

test('email weather: says what time the conditions are from (they are 1 AM conditions)', async () => {
  const w = await emailWeatherWith(CURRENT_OK);
  const now = etDate('2026-10-03', 1, 4);
  const digest = M.computeDigest(logic, { raw: makeRaw(66, now), history: historyAtTemp(66) },
    { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: now.getTime() }, w, now);
  const html = M.renderEmailHtml(digest);
  assert.ok(/Conditions as of 1:04(&#8239;| )AM EDT, when this email was prepared/.test(html),
    (html.match(/Conditions as of[^<]*/) || ['(missing)'])[0]);
  const none = M.renderEmailHtml(M.computeDigest(logic, { raw: makeRaw(66, now), history: historyAtTemp(66) },
    { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: now.getTime() }, { available: false }, now));
  assert.ok(!/Conditions as of/.test(none), 'no time stamp for weather that is not there');
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

test('every scheduled cron leads to a 1am send across DST', () => {
  // The job no longer depends on the trigger being punctual: it is scheduled
  // early and waits. So the requirement is not "a cron lands inside the window"
  // but "every cron either sends or waits", for both EDT and EST.
  const { execFileSync } = require('child_process');
  const script = path.join(__dirname, 'send_window.sh');
  const crons = [1, 2, 5, 6]; // UTC hours, must match daily_email.yml
  const dates = [[2026,0,15],[2026,2,7],[2026,2,8],[2026,5,15],[2026,7,6],[2026,10,1],[2026,10,2],[2026,11,25]];
  for (const [y, mo, dy] of dates) {
    for (const h of crons) {
      const epoch = Math.floor(Date.UTC(y, mo, dy, h, 0, 0) / 1000);
      const out = execFileSync('bash', [script], {
        env: { ...process.env, NOW_OVERRIDE: String(epoch) }, encoding: 'utf8',
      }).trim();
      assert.ok(/^(SEND|WAIT )/.test(out),
        `${y}-${mo+1}-${dy} ${h}:00 UTC produced "${out}" - no send would happen`);
    }
  }
});

test('a run delayed by hours still sends, up to the 5am cutoff', () => {
  // The real failure: a 1am trigger that started at 5am Eastern, which the old
  // gate refused outright, so no email went out and the run stayed green.
  const { execFileSync } = require('child_process');
  const script = path.join(__dirname, 'send_window.sh');
  const decide = (epoch) => execFileSync('bash', [script], {
    env: { ...process.env, NOW_OVERRIDE: String(epoch) }, encoding: 'utf8' }).trim();

  const base = Math.floor(Date.UTC(2026, 6, 15, 1, 0, 0) / 1000); // 9pm EDT trigger
  for (const delayHours of [0, 1, 2, 3, 4, 5, 6]) {
    const out = decide(base + delayHours * 3600);
    assert.ok(/^(SEND|WAIT )/.test(out),
      `a ${delayHours}h delay produced "${out}"`);
    if (out.startsWith('WAIT ')) {
      // Waiting must actually land inside the window, not merely defer.
      const after = base + delayHours * 3600 + Number(out.split(' ')[1]);
      assert.strictEqual(decide(after), 'SEND',
        `after waiting from a ${delayHours}h delay, the run still would not send`);
    }
  }
  // Eight hours late is 5am: genuinely too late to help anyone.
  assert.ok(decide(base + 8 * 3600).startsWith('SKIP'),
    'a run starting at 5am should skip rather than send stale advice');
});

test('the send window never extends past 5am', () => {
  // A digest arriving after 5am is too late to be useful before dawn practice.
  const { execFileSync } = require('child_process');
  const script = path.join(__dirname, 'send_window.sh');
  for (const [h, expect] of [[4, 'SEND'], [5, 'SKIP'], [9, 'SKIP']]) {
    const epoch = Math.floor(Date.UTC(2026, 6, 15, h + 4, 0, 0) / 1000); // EDT
    const out = execFileSync('bash', [script], {
      env: { ...process.env, NOW_OVERRIDE: String(epoch) }, encoding: 'utf8' }).trim();
    assert.ok(out.startsWith(expect), `${h}:00 ET gave "${out}", expected ${expect}`);
  }
});

test('the workflow crons match what the tests assume', () => {
  // These tests are only meaningful if they check the schedule that is actually
  // deployed. Pin them together so editing one without the other fails here.
  const fs2 = require('fs');
  const wf = fs2.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily_email.yml'), 'utf8');
  const crons = [...wf.matchAll(/cron:\s*'(\d+)\s+(\d+)\s+\*\s+\*\s+\*'/g)].map(m => Number(m[2]));
  assert.deepStrictEqual(crons.sort((a,b)=>a-b), [1, 2, 5, 6],
    'daily_email.yml cron hours changed; update the tests above to match');
  assert.ok(/scripts\/send_window\.sh/.test(wf),
    'the workflow should delegate the timing decision to send_window.sh');
  assert.ok(/cancel-in-progress:\s*false/.test(wf),
    'a sleeping run must not be cancelled mid-send by a later trigger');
});

test('SAFETY the email is built from the latest readings, not the checkout made before the wait', () => {
  // A run triggered at 9 PM checks out the repo, sleeps until 1 AM, and used to
  // build the email from that 9 PM checkout: the 1 Oct digest reported "Water
  // sensor may be offline" 90 minutes after a reading. The refresh must sit
  // after the wait and before both the tests and the build.
  const wf = require('fs').readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily_email.yml'), 'utf8');
  const at = (re) => { const m = wf.match(re); return m ? m.index : -1; };
  const gate = at(/id:\s*gate/), refresh = at(/run:\s*bash scripts\/refresh_checkout\.sh/);
  const tests = at(/node scripts\/test_daily_email\.js/), build = at(/daily_email\.js --json/);
  const send = at(/daily_email\.js --send/);
  assert.ok(refresh > 0, 'the workflow must run scripts/refresh_checkout.sh');
  assert.ok(gate < refresh && refresh < tests && refresh < build && refresh < send,
    'refresh must come after the wait and before the tests, the build and the send');
  assert.ok(/bash scripts\/test_refresh_checkout\.sh/.test(wf), 'and its own tests must run before sending');
});

test('the email job runs on a supported Node (20 reached end of life in April 2026)', () => {
  const wf = require('fs').readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily_email.yml'), 'utf8');
  const v = (wf.match(/node-version:\s*'(\d+)'/) || [])[1];
  assert.ok(v && Number(v) >= 22, `node-version ${v}`);
});

// ═══════════════════════════════════════════════════════════════════════════
section('8d. Duplicate-send prevention');
// ═══════════════════════════════════════════════════════════════════════════
//
// Members received the digest twice. The cause: the send window deliberately
// spans 1-4am ET so a delayed run still goes out, which means BOTH scheduled
// crons are eligible in summer (05:00 UTC = 1am ET, 06:00 UTC = 2am ET). The
// only thing stopping the second was an assumption that Buttondown rejects a
// duplicate slug — which it does not. These tests pin the real guard.

test('BOTH scheduled crons are eligible in summer — so a guard is required', () => {
  function etHour(utcHour, y, mo, dy) {
    const d = new Date(Date.UTC(y, mo, dy, utcHour, 0, 0));
    return parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(d), 10);
  }
  // August: 05:00 UTC -> 1am ET, 06:00 UTC -> 2am ET. Both inside 1-4.
  const hours = [5, 6].map(h => etHour(h, 2026, 7, 7));
  const eligible = hours.filter(h => h >= 1 && h <= 4);
  assert.strictEqual(eligible.length, 2,
    `expected both crons eligible in summer, got ET hours ${hours}`);
});

test('exactly one cron is the primary 1am run', () => {
  const primaries = [5, 6].filter(h =>
    M.isPrimarySendHour(new Date(Date.UTC(2026, 7, 7, h, 0, 0))));
  assert.strictEqual(primaries.length, 1,
    'exactly one scheduled hour should be the primary 1am ET run (summer)');
  const primariesWinter = [5, 6].filter(h =>
    M.isPrimarySendHour(new Date(Date.UTC(2026, 0, 15, h, 0, 0))));
  assert.strictEqual(primariesWinter.length, 1,
    'exactly one scheduled hour should be the primary 1am ET run (winter)');
});

test('the primary hour differs between summer and winter', () => {
  const summer = [5, 6].find(h => M.isPrimarySendHour(new Date(Date.UTC(2026, 7, 7, h))));
  const winter = [5, 6].find(h => M.isPrimarySendHour(new Date(Date.UTC(2026, 0, 15, h))));
  assert.strictEqual(summer, 5, 'summer primary should be 05:00 UTC');
  assert.strictEqual(winter, 6, 'winter primary should be 06:00 UTC');
});

test('alreadySentToday reports unknown rather than false without an API key', async () => {
  // Was a plain function returning a promise, which the old harness counted as
  // passed before the promise settled - so this duplicate-send guard was never
  // actually checked.
  const saved = process.env.BUTTONDOWN_API_KEY;
  delete process.env.BUTTONDOWN_API_KEY;
  try {
    const r = await M.alreadySentToday(new Date());
    assert.strictEqual(r.known, false,
      'must not claim to know the answer when it cannot ask');
    assert.strictEqual(r.found, false);
  } finally {
    if (saved !== undefined) process.env.BUTTONDOWN_API_KEY = saved;
  }
});

test('the slug is a per-day marker the duplicate check can match on', () => {
  const a = M.dailySlug(new Date(Date.UTC(2026, 7, 7, 5, 0)));  // 1am ET
  const b = M.dailySlug(new Date(Date.UTC(2026, 7, 7, 6, 0)));  // 2am ET, same day
  assert.strictEqual(a, b, 'both scheduled runs must compute the same marker');
  // Buttondown may uniquify a repeated slug, so matching is by prefix.
  assert.ok((a + '-2').startsWith(a), 'prefix matching must catch uniquified slugs');
});

test('documentation no longer claims slug is an idempotency key', () => {
  const src = require('fs').readFileSync(path.join(__dirname, 'daily_email.js'), 'utf8');
  assert.ok(!/Buttondown rejects a duplicate slug/.test(src),
    'stale claim: the API does not guarantee slug uniqueness');
  assert.ok(/NOT an idempotency key/.test(src),
    'the corrected reasoning should be recorded next to the code');
});

// ═══════════════════════════════════════════════════════════════════════════
section('8e. Sunrise / sunset');
// ═══════════════════════════════════════════════════════════════════════════

test('naive local times are read literally, not reinterpreted as UTC', () => {
  // Open-Meteo returns daily times already in the requested timezone and with
  // NO offset ("2026-08-07T05:52"). Passing that to new Date() would treat it
  // as UTC and shift it by hours, so sunrise would read 1:52 AM in summer.
  const cases = [
    ['2026-08-07T05:52', '5:52 AM'],
    ['2026-08-07T20:01', '8:01 PM'],
    ['2026-01-15T00:07', '12:07 AM'],
    ['2026-01-15T12:00', '12:00 PM'],
    ['2026-06-01T13:05', '1:05 PM'],
    ['2026-11-15T16:30', '4:30 PM'],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(M.formatLocalClock(input), expected, `for ${input}`);
  }
});

test('every API response shape yields the SAME correct clock time', () => {
  // The exact shape is not pinned down by the docs, and an hours-off sunrise
  // looks perfectly plausible — so all three forms must agree.
  const expected = '5:52 AM';
  assert.strictEqual(M.formatLocalClock('2026-08-07T05:52'), expected, 'naive local');
  assert.strictEqual(M.formatLocalClock('2026-08-07T05:52-04:00'), expected, 'with offset');
  assert.strictEqual(M.formatLocalClock('2026-08-07T09:52Z'), expected, 'UTC Z');
  assert.strictEqual(M.formatLocalClock(Math.floor(Date.UTC(2026, 7, 7, 9, 52) / 1000)),
    expected, 'unix seconds');
  // And across DST, where a fixed offset assumption would break.
  assert.strictEqual(M.formatLocalClock('2026-01-15T07:15-05:00'), '7:15 AM', 'winter offset');
});

test('sunrise times are plausible for the boathouse latitude', () => {
  // Guards against a whole-hours timezone error slipping through unnoticed:
  // at 41 N, sunrise never falls outside roughly 4am-8am.
  for (const iso of ['2026-06-21T05:19', '2026-12-21T07:16', '2026-08-07T05:52']) {
    const out = M.formatLocalClock(iso);
    const [, h, , suffix] = out.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
    const hour24 = suffix === 'AM' ? (h === '12' ? 0 : Number(h)) : Number(h) + 12;
    assert.ok(hour24 >= 4 && hour24 <= 8,
      `sunrise ${out} is implausible for 41N — suspect a timezone shift`);
  }
});

test('malformed or missing times degrade to null, never NaN', () => {
  for (const bad of [undefined, null, '', 'not-a-time', 42, {}]) {
    assert.strictEqual(M.formatLocalClock(bad), null, `for ${JSON.stringify(bad)}`);
  }
});

test('sunrise and sunset appear in the email when available', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: true, code: 0, tempF: 70, feelsF: 69, windMph: 5, gustMph: 9,
      dir: 'NW', precip: '0.00', sunrise: '5:52 AM', sunset: '8:01 PM' },
    new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(/Sunrise 5:52 AM/.test(html), 'sunrise missing from email');
  assert.ok(/Sunset 8:01 PM/.test(html), 'sunset missing from email');
});

test('the email omits the line entirely when sun times are unavailable', () => {
  const digest = M.computeDigest(logic,
    { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 5, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: true, code: 0, tempF: 70, feelsF: 69, windMph: 5, gustMph: 9,
      dir: 'NW', precip: '0.00' },
    new Date());
  const html = M.renderEmailHtml(digest);
  assert.ok(!/Sunrise/.test(html), 'should not render a sunrise line with no data');
  assert.ok(!/undefined|null/.test(html.replace(/\{\{[^}]*\}\}/g, '')),
    'no placeholder leakage');
});

test('boathouse coordinates are the shared source for weather', () => {
  assert.ok(M.BOATHOUSE && typeof M.BOATHOUSE.lat === 'number',
    'coordinates should be a named constant, not scattered literals');
  // Sanity: within Connecticut, and not Waterbury-Oxford Airport (41.4786,-73.1352).
  assert.ok(M.BOATHOUSE.lat > 41 && M.BOATHOUSE.lat < 42, 'latitude out of range');
  assert.ok(M.BOATHOUSE.lon > -74 && M.BOATHOUSE.lon < -72, 'longitude out of range');
  const dLat = Math.abs(M.BOATHOUSE.lat - 41.4786);
  assert.ok(dLat > 0.01, 'coordinates should be the boathouse, not the airport');
});

// ===========================================================================
section('8f. Character encoding (mojibake prevention)');
// ===========================================================================
//
// The email is a FRAGMENT, so it cannot carry a <meta charset>. Encoding is
// therefore decided by Buttondown's wrapper and the receiving client, and when
// they disagree UTF-8 is read as Latin-1: a degree sign arrives as "\u00c2\u00b0" and
// an em dash as "\u00e2\u0080\u0094". Members saw both. Emitting pure ASCII removes the
// possibility entirely.

function nonAsciiChars(s) {
  const out = [];
  for (const ch of String(s)) if (ch.codePointAt(0) > 127) out.push(ch);
  return out;
}

test('rendered email body contains NO non-ASCII characters', () => {
  for (const d of everyDigest()) {
    const bad = nonAsciiChars(M.renderEmailHtml(d));
    assert.strictEqual(bad.length, 0,
      `found ${bad.length} raw non-ASCII chars (would mojibake): ${JSON.stringify(bad.slice(0, 8))}`);
  }
});

test('subject line contains NO non-ASCII characters', () => {
  for (const d of everyDigest()) {
    const subject = M.renderSubject(d);
    const bad = nonAsciiChars(subject);
    assert.strictEqual(bad.length, 0,
      `subject has non-ASCII (entities do not work in subjects): ${JSON.stringify(bad)} in "${subject}"`);
  }
});

test('entities decode back to the intended characters', () => {
  const d = everyDigest()[1];
  const html = M.renderEmailHtml(d);
  const decoded = html.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  assert.ok(/\u00b0F/.test(decoded), 'degree sign should decode correctly');
  assert.ok(/Tier 2 \u2014 Intermediate/.test(decoded),
    'the em dash in tier labels should decode correctly');
});

test('data pulled from index.html is encoded too, not just our own strings', () => {
  // The tier labels come from ZONE_TIERS in index.html and contain an em dash.
  // Escaping only hard-coded strings would have missed them.
  const html = M.renderEmailHtml(everyDigest()[0]);
  assert.ok(/Tier 2 &#8212; Intermediate/.test(html),
    'tier label em dash should be an entity');
  assert.ok(!/Tier 2 \u2014/.test(html), 'raw em dash leaked through');
});

test('toAsciiEntities leaves existing entities and ASCII untouched', () => {
  assert.strictEqual(M.toAsciiEntities('&nbsp;&middot; plain ASCII'), '&nbsp;&middot; plain ASCII');
  assert.strictEqual(M.toAsciiEntities('a\u00b0b'), 'a&#176;b');
  assert.strictEqual(M.toAsciiEntities(''), '');
});

test('toAsciiSubject degrades punctuation readably', () => {
  assert.strictEqual(M.toAsciiSubject('A \u2014 B'), 'A - B');
  assert.strictEqual(M.toAsciiSubject('72.4\u00b0F'), '72.4F');
  assert.strictEqual(M.toAsciiSubject('a \u00b7 b'), 'a - b');
  assert.strictEqual(nonAsciiChars(M.toAsciiSubject('\u2018q\u2019 \u201cd\u201d \u00a0 \u20ac')).length, 0);
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
section('10. Wording: nothing may read as a go-ahead');
// ═══════════════════════════════════════════════════════════════════════════
//
// Safety Committee decision, October 2026: the site and email know the water
// temperature, river level and forecast - not fog, wind, current or debris on
// the water. So nothing may tell members it is clear to row. Boats the rules
// permit are "Allowed", and every email and page says that is not a go-ahead.

const fsT = require('fs');
const vmT = require('vm');
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const GO_AHEAD = /all boats clear|clear to row|safe to row|good to row|normal rowing conditions|ok to row/i;

test('boatStatusLabel is shared from index.html and never says Go, Row or Clear', () => {
  assert.strictEqual(typeof logic.boatStatusLabel, 'function', 'boatStatusLabel not extracted');
  assert.strictEqual(logic.boatStatusLabel('go', null), 'Allowed');
  assert.strictEqual(logic.boatStatusLabel('go', 'Certified only'), 'Cond.');
  assert.strictEqual(logic.boatStatusLabel('caution', null), 'Caution');
  assert.strictEqual(logic.boatStatusLabel('no', 'w/ launch'), 'No');
});

test('email boat labels equal the site label for every boat in every scenario', () => {
  let n = 0;
  for (const tempF of [30, 45, 55, 72]) {
    for (const level of [null, 5, 8.5, 9.5, 10.4, 11.5, 13]) {
      const d = M.computeDigest(logic, { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
        { level, isEstimate: false, failed: level === null, stale: false, ageMs: 0, lastObsTs: Date.now() },
        { available: false }, new Date());
      for (const tier of d.rows) for (const b of tier.boats) {
        assert.strictEqual(b.label, logic.boatStatusLabel(b.status, b.note),
          `@${tempF}F/${level}ft ${tier.name}/${b.name}`);
        assert.ok(!/^(Go|Row|Clear)$/.test(b.label), `go-ahead label "${b.label}"`);
        n++;
      }
    }
  }
  assert.ok(n > 300, `expected a broad sweep, ran ${n}`);
});

test('the normal zone is named for the rule, not the conditions', () => {
  const d = M.computeDigest(logic, { raw: makeRaw(72), history: historyAtTemp(72) },
    { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, new Date());
  assert.strictEqual(d.zone, 'normal', 'sanity');
  assert.strictEqual(d.zoneLabel, 'No temperature restrictions');
});

test('river summary says "no river-level restrictions", never "clear"', () => {
  assert.strictEqual(logic.floodSummaryLabel(5).text, 'No river-level restrictions');
  for (const ft of [0, 3, 7.9, 8, 8.5, 9.5, 10.5, 11.5, 12.5]) {
    assert.ok(!/clear/i.test(logic.floodSummaryLabel(ft).text), `${ft} ft: "${logic.floodSummaryLabel(ft).text}"`);
  }
});

test('SAFETY: no subject ever contains "clear", in any scenario', () => {
  let n = 0;
  for (const tempF of [30, 38, 45, 52, 58, 65, 72, 80]) {
    for (const level of [null, 2.5, 7.9, 8.5, 9, 10, 10.4, 11, 12, 15]) {
      const s = M.renderSubject(M.computeDigest(logic,
        { raw: makeRaw(tempF), history: historyAtTemp(tempF) },
        { level, isEstimate: false, failed: level === null, stale: false, ageMs: 0, lastObsTs: Date.now() },
        { available: false }, new Date()));
      assert.ok(!/clear/i.test(s), `@${tempF}F/${level}ft: "${s}"`);
      n++;
    }
  }
  assert.ok(n >= 80);
});

// ═══════════════════════════════════════════════════════════════════════════
section('11. Fog outlook logic (real forecasts for real mornings)');
// ═══════════════════════════════════════════════════════════════════════════
//
// Fixtures are the archived Open-Meteo responses for four real mornings,
// fetched with the same eight models and units the site requests (sha256 of
// the canonical JSON: de5cc6c4...). Expected levels come from what those
// models actually said, cross-checked against observations.

const FOG_FX = require('./fixtures/fog_mornings.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

// The UTC instant whose New York wall clock reads ymd hh:mm (first occurrence).
function etDate(ymd, hour, minute = 0) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const [y, m, d] = ymd.split('-').map(Number);
  for (const off of [4, 5]) {
    const cand = new Date(Date.UTC(y, m - 1, d, hour + off, minute));
    const p = fmt.formatToParts(cand); const g = t => p.find(x => x.type === t).value;
    if (`${g('year')}-${g('month')}-${g('day')}` === ymd && +g('hour') === hour && +g('minute') === minute) return cand;
  }
  throw new Error(`no New York time ${ymd} ${hour}:${minute}`);
}
const assess = (name, water, alerts = null, response) =>
  logic.assessFogRisk(response || FOG_FX[name].response, FOG_FX[name].date,
    water === undefined ? FOG_FX[name].waterTempF : water, alerts);

test('every fog export reaches the email (extraction skips missing names silently)', () => {
  for (const fn of ['assessFogRisk', 'fogText', 'fogTarget', 'fogOutlookUrl', 'fogAlertsUrl', 'fogAdvisory']) {
    assert.strictEqual(typeof logic[fn], 'function', `${fn} missing from the email's copy of the site logic`);
  }
  for (const k of ['FOG_MODELS', 'FOG_RULES', 'FOG_LAUNCH_RULE', 'BOATHOUSE_POINT', 'ALLOWED_NOTE_HTML']) {
    assert.ok(logic[k] !== undefined, `${k} missing`);
  }
});

test('the calibrated configuration is exactly what was backtested', () => {
  // The calibration notes in index.html describe THESE values. Changing any of
  // them changes what those numbers mean: re-run the backtest, then update both.
  assert.deepStrictEqual(plain(logic.FOG_MODELS), ['gfs_seamless', 'ncep_nbm_conus', 'ecmwf_ifs025',
    'icon_seamless', 'gem_seamless', 'meteofrance_seamless', 'ukmo_seamless', 'jma_seamless']);
  assert.deepStrictEqual(plain(logic.FOG_RULES), { windowStartHour: 4, windowEndHour: 9, spreadMaxF: 2,
    windMaxMph: 8, steamDiffF: 18, minModels: 3, nextDayFromHour: 10 });
});

test('the picket-fence rule is quoted exactly as the Safety Handbook gives it', () => {
  assert.strictEqual(logic.FOG_LAUNCH_RULE,
    'If you cannot see the house with the picket fence, do not launch.');
});

test('REGRESSION 2 Oct 2026: the dense-fog morning that prompted this is LIKELY', () => {
  const a = assess('likely_2026_10_02');
  assert.strictEqual(a.level, 'likely');
  assert.strictEqual(a.modelsTotal, 8);
  assert.strictEqual(a.modelsFavorable, 7);
});

test('2 Oct: the default model on its own would have missed it', () => {
  // HRRR, which the site's weather card uses, had a 2.4F spread at best.
  const gfs = assess('likely_2026_10_02').perModel.find(m => m.model === 'gfs_seamless');
  assert.strictEqual(gfs.spreadF, 2.4);
  assert.strictEqual(gfs.favorable, false);
});

test('a 2.0F spread counts - float noise must not exclude it', () => {
  // NBM on 2 Oct: 64.4 - 62.4 = 2.0000000000000142 in floating point. Without
  // rounding, this one model's vote flips, and it was decisive at the margin.
  assert.ok(64.4 - 62.4 > 2, 'sanity: raw float subtraction overshoots');
  const nbm = assess('likely_2026_10_02').perModel.find(m => m.model === 'ncep_nbm_conus');
  assert.strictEqual(nbm.spreadF, 2);
  assert.strictEqual(nbm.favorable, true);
});

test('9 Sep 2026: five of eight models -> POSSIBLE', () => {
  const a = assess('possible');
  assert.strictEqual(a.modelsFavorable, 5);
  assert.strictEqual(a.level, 'possible');
});

test('31 May 2026: steam fog over warm water -> POSSIBLE with dry air', () => {
  const a = assess('steam_2026_05_31');
  assert.strictEqual(a.modelsFavorable, 1, 'sanity: the air itself was not saturated');
  assert.strictEqual(a.steam, true);
  assert.ok(a.waterMinusAirF >= 18 && a.waterMinusAirF < 22, `water-air ${a.waterMinusAirF}`);
  assert.strictEqual(a.level, 'possible');
});

test('the steam case depends on the water: without a water reading it is LOW', () => {
  assert.strictEqual(assess('steam_2026_05_31', null).level, 'low');
});

test('19 Sep 2026: dry air, 16.5F water-air gap -> LOW', () => {
  const a = assess('dry');
  assert.strictEqual(a.modelsFavorable, 0);
  assert.strictEqual(a.steam, false);
  assert.strictEqual(a.level, 'low');
});

test('only the 4-9 AM window counts: saturated air at 3 AM and 10 AM is ignored', () => {
  const r = clone(FOG_FX.dry.response);
  const h = r.hourly;
  for (const m of logic.FOG_MODELS) for (const hr of [0, 1, 2, 3, 10, 11]) {
    h['dew_point_2m_' + m][hr] = h['temperature_2m_' + m][hr];
    h['wind_speed_10m_' + m][hr] = 0;
  }
  assert.strictEqual(logic.assessFogRisk(r, '2026-09-19', 60, null).level, 'low');
});

test('the window is inclusive at both ends: 4 AM and 9 AM count', () => {
  for (const hr of [4, 9]) {
    const r = clone(FOG_FX.dry.response);
    for (const m of logic.FOG_MODELS) {
      r.hourly['dew_point_2m_' + m][hr] = r.hourly['temperature_2m_' + m][hr];
      r.hourly['wind_speed_10m_' + m][hr] = 2;
    }
    assert.strictEqual(logic.assessFogRisk(r, '2026-09-19', 60, null).level, 'likely', `${hr} AM`);
  }
});

test('the date must match: tomorrow\'s fog is not reported for this morning', () => {
  assert.strictEqual(logic.assessFogRisk(FOG_FX.likely_2026_10_02.response, '2026-10-03', 65, null).level,
    'unknown', 'a date absent from the forecast is unknown, not low');
});

test('SAFETY: a missing reading is skipped, never read as zero spread and zero wind', () => {
  // isFinite(null) is true - the trap fogNum() avoids. Null every dew point in
  // the dry fixture: if nulls were read as 0 the spread would be huge, but if
  // temperature were nulled and read as 0 alongside a 0 dew point, the spread
  // would be ZERO - perfect fog. Both must simply drop the model.
  const r = clone(FOG_FX.dry.response);
  for (const m of logic.FOG_MODELS) {
    r.hourly['temperature_2m_' + m] = r.hourly['temperature_2m_' + m].map(() => null);
    r.hourly['dew_point_2m_' + m] = r.hourly['dew_point_2m_' + m].map(() => null);
  }
  const a = logic.assessFogRisk(r, '2026-09-19', 72, null);
  assert.strictEqual(a.modelsTotal, 0);
  assert.strictEqual(a.level, 'unknown');
});

test('SAFETY: thin data is "unknown", never "low"', () => {
  const r = clone(FOG_FX.dry.response);
  for (const m of logic.FOG_MODELS.slice(2)) delete r.hourly['temperature_2m_' + m];
  const a = logic.assessFogRisk(r, '2026-09-19', 72, null);
  assert.strictEqual(a.modelsTotal, 2);
  assert.strictEqual(a.level, 'unknown', 'two models are not enough to reassure anyone');
  for (const bad of [null, undefined, {}, { hourly: null }, { hourly: { time: 'x' } }, 'garbage']) {
    assert.strictEqual(logic.assessFogRisk(bad, '2026-09-19', 72, null).level, 'unknown', JSON.stringify(bad));
  }
});

test('levels are decided in integer arithmetic at the two-thirds and one-third lines', () => {
  // Build N models of which F are favourable, by editing the dry fixture.
  function scenario(n, f) {
    const r = clone(FOG_FX.dry.response);
    logic.FOG_MODELS.forEach((m, i) => {
      if (i >= n) { delete r.hourly['temperature_2m_' + m]; return; }
      if (i < f) {
        r.hourly['dew_point_2m_' + m][6] = r.hourly['temperature_2m_' + m][6] - 1;
        r.hourly['wind_speed_10m_' + m][6] = 3;
      }
    });
    return logic.assessFogRisk(r, '2026-09-19', 60, null).level;
  }
  assert.strictEqual(scenario(6, 4), 'likely', '4 of 6 is exactly two thirds');
  assert.strictEqual(scenario(6, 3), 'possible');
  assert.strictEqual(scenario(6, 2), 'possible', '2 of 6 is exactly one third');
  assert.strictEqual(scenario(6, 1), 'low');
  assert.strictEqual(scenario(8, 6), 'likely');
  assert.strictEqual(scenario(8, 5), 'possible');
  assert.strictEqual(scenario(8, 3), 'possible');
  assert.strictEqual(scenario(8, 2), 'low');
  assert.strictEqual(scenario(3, 2), 'likely');
});

test('wind above 8 mph disqualifies a saturated model', () => {
  const r = clone(FOG_FX.dry.response);
  for (const m of logic.FOG_MODELS) {
    r.hourly['dew_point_2m_' + m][6] = r.hourly['temperature_2m_' + m][6];
    r.hourly['wind_speed_10m_' + m][6] = 8.1;
  }
  assert.strictEqual(logic.assessFogRisk(r, '2026-09-19', 60, null).level, 'low');
});

// The next 9:00 AM in New York, strictly in the future, as the feed writes it
// (local time with offset). Advisories that have ended are now ignored, so a
// fixed date here would turn these tests into a time bomb.
function nextNineAmEt() {
  const ymdNY = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
  let t = etDate(ymdNY(new Date()), 9);
  if (t.getTime() <= Date.now()) t = etDate(ymdNY(new Date(Date.now() + 86400000)), 9);
  const off = /EDT/.test(logic.nyTzAbbr(t.getTime())) ? '-04:00' : '-05:00';
  return `${ymdNY(t)}T09:00:00${off}`;
}
const NINE_AM = nextNineAmEt();

// Shaped exactly like the live api.weather.gov feed (checked 2 Oct 2026).
function nwsAlerts(props) {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: Object.assign({
    event: 'Dense Fog Advisory', status: 'Actual', messageType: 'Alert', severity: 'Minor',
    headline: 'Dense Fog Advisory issued October 3 at 3:12AM EDT until October 3 at 9:00AM EDT by NWS Upton NY',
    onset: new Date(Date.now() - 2 * 3600000).toISOString(), ends: NINE_AM, expires: NINE_AM,
  }, props) }] };
}

test('an NWS Dense Fog Advisory makes it LIKELY, whatever the models say', () => {
  assert.strictEqual(assess('dry', 60, nwsAlerts({})).level, 'likely');
  const a = logic.assessFogRisk(null, '2026-09-19', null, nwsAlerts({}));
  assert.strictEqual(a.level, 'likely', 'even with no model data at all');
  assert.strictEqual(a.advisory.event, 'Dense Fog Advisory');
});

test('NWS test messages, cancellations and non-fog alerts are ignored', () => {
  // The live feed carried a "Test Message" when this was built.
  assert.strictEqual(assess('dry', 60, nwsAlerts({ status: 'Test' })).level, 'low');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ status: 'Exercise' })).level, 'low');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ messageType: 'Cancel' })).level, 'low');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ event: 'Small Craft Advisory' })).level, 'low');
  assert.strictEqual(assess('dry', 60, { features: 'nonsense' }).level, 'low');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ event: 'Freezing Fog Advisory' })).level, 'likely');
});

test('an alert with no end time falls back to its expiry (12 of 423 live alerts had none)', () => {
  const a = assess('dry', 60, nwsAlerts({ ends: null }));
  assert.strictEqual(a.advisory.until, NINE_AM);
  assert.ok(/until 9:00 AM/.test(logic.fogText(a, 'this morning').headline), logic.fogText(a, 'this morning').headline);
});

test('an advisory past its end time is over, even while the feed still lists it', () => {
  // The active feed keeps an alert until it "expires", which can be after it
  // "ends"; at 9:30 the page would have said "in effect until 9:00 AM".
  const past = new Date(Date.now() - 30 * 60000).toISOString();
  const later = new Date(Date.now() + 30 * 60000).toISOString();
  assert.strictEqual(assess('dry', 60, nwsAlerts({ ends: past, expires: later })).level, 'low', 'ended');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ ends: null, expires: past })).level, 'low', 'expired, no end time');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ ends: later, expires: later })).level, 'likely', 'still running');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ ends: null, expires: null })).level, 'likely',
    'no times at all: trust the feed that it is active');
  assert.strictEqual(assess('dry', 60, nwsAlerts({ ends: 'garbage', expires: null })).level, 'likely',
    'an unreadable time is not a reason to drop an advisory');
});

test('SECURITY: text from the NWS feed is escaped before it reaches any HTML', () => {
  const a = assess('dry', 60, nwsAlerts({ event: 'Fog <img src=x onerror=alert(1)>' }));
  const t = logic.fogText(a, 'this morning');
  for (const s of [t.headline, t.detail]) {
    assert.ok(!/<img/i.test(s), `unescaped markup: ${s}`);
    assert.ok(/&lt;img/.test(s), `expected escaped markup: ${s}`);
  }
});

test('fog wording for each level', () => {
  const t = (name, water, alerts) => logic.fogText(assess(name, water, alerts), 'this morning');
  assert.ok(/^Fog likely at dawn this morning$/.test(t('likely_2026_10_02').headline));
  assert.ok(/7 of 8 forecast models/.test(t('likely_2026_10_02').detail));
  assert.ok(/^Fog possible at dawn this morning$/.test(t('possible').headline));
  assert.ok(/steam fog/.test(t('steam_2026_05_31').detail), 'steam case should explain itself');
  assert.ok(/^Fog not indicated this morning$/.test(t('dry').headline));
  assert.ok(/can still form/.test(t('dry').detail), '"not indicated" must not read as "no fog"');
  assert.strictEqual(logic.fogText(logic.assessFogRisk(null, '2026-09-19', null, null), 'x').headline,
    'Fog outlook unavailable');
  for (const s of [t('likely_2026_10_02'), t('possible'), t('dry')]) {
    assert.ok(!GO_AHEAD.test(s.headline + s.detail));
    assert.strictEqual(nonAsciiChars(s.headline + s.detail).length, 0, 'fog text must be pure ASCII');
  }
});

test('fogTarget: this morning until 10 AM, then tomorrow - by calendar, across DST and year-end', () => {
  const T = (d) => plain(logic.fogTarget(d));
  assert.deepStrictEqual(T(etDate('2026-10-02', 0, 0)), { date: '2026-10-02', label: 'this morning' });
  assert.deepStrictEqual(T(etDate('2026-10-02', 1, 0)), { date: '2026-10-02', label: 'this morning' });
  assert.deepStrictEqual(T(etDate('2026-10-02', 9, 59)), { date: '2026-10-02', label: 'this morning' });
  assert.deepStrictEqual(T(etDate('2026-10-02', 10, 0)), { date: '2026-10-03', label: 'tomorrow morning' });
  assert.deepStrictEqual(T(etDate('2026-10-02', 23, 59)), { date: '2026-10-03', label: 'tomorrow morning' });
  assert.deepStrictEqual(T(etDate('2026-10-31', 11, 0)), { date: '2026-11-01', label: 'tomorrow morning' });
  assert.deepStrictEqual(T(etDate('2026-12-31', 15, 0)), { date: '2027-01-01', label: 'tomorrow morning' });
  assert.deepStrictEqual(T(etDate('2028-02-28', 12, 0)), { date: '2028-02-29', label: 'tomorrow morning' });
  // Spring forward (8 Mar 2026): 2 AM never happens.
  assert.deepStrictEqual(T(etDate('2026-03-08', 1, 30)), { date: '2026-03-08', label: 'this morning' });
  assert.deepStrictEqual(T(etDate('2026-03-08', 3, 30)), { date: '2026-03-08', label: 'this morning' });
  assert.deepStrictEqual(T(etDate('2026-03-08', 10, 30)), { date: '2026-03-09', label: 'tomorrow morning' });
  // Fall back (1 Nov 2026): 1:30 AM happens twice; both are this morning.
  assert.deepStrictEqual(T(new Date(Date.UTC(2026, 10, 1, 5, 30))), { date: '2026-11-01', label: 'this morning' });
  assert.deepStrictEqual(T(new Date(Date.UTC(2026, 10, 1, 6, 30))), { date: '2026-11-01', label: 'this morning' });
  // The email's own send time.
  assert.strictEqual(logic.fogTarget(etDate('2026-07-15', 1, 0)).label, 'this morning');
});

test('the forecast URL asks for exactly the calibrated models, variables and units', () => {
  const u = new URL(logic.fogOutlookUrl(41.437, -73.119));
  assert.strictEqual(u.hostname, 'api.open-meteo.com');
  assert.strictEqual(u.searchParams.get('models'), logic.FOG_MODELS.join(','));
  assert.strictEqual(u.searchParams.get('hourly'), 'temperature_2m,dew_point_2m,wind_speed_10m');
  assert.strictEqual(u.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.strictEqual(u.searchParams.get('wind_speed_unit'), 'mph');
  assert.strictEqual(u.searchParams.get('timezone'), 'America/New_York');
  assert.strictEqual(u.searchParams.get('forecast_days'), '2', 'must cover tomorrow\'s dawn after 10 AM');
  assert.strictEqual(new URL(logic.fogAlertsUrl(41.437, -73.119)).hostname, 'api.weather.gov');
});

test('the email and the site forecast the same point', () => {
  assert.strictEqual(M.BOATHOUSE.lat, logic.BOATHOUSE_POINT.lat);
  assert.strictEqual(M.BOATHOUSE.lon, logic.BOATHOUSE_POINT.lon);
});

// ═══════════════════════════════════════════════════════════════════════════
section('12. Fog and wording in the email');
// ═══════════════════════════════════════════════════════════════════════════

// The digest as the 1 AM run would build it on a fixture's morning.
function fogDigest(name, opts = {}) {
  const fx = FOG_FX[name];
  const now = opts.now || etDate(fx.date, 1, 0);
  const water = opts.water !== undefined ? opts.water : fx.waterTempF;
  const level = opts.riverLevel !== undefined ? opts.riverLevel : 3.1;
  return M.computeDigest(logic,
    { raw: makeRaw(water, now), history: historyAtTemp(water) },
    { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: now.getTime() },
    { available: true, code: 0, tempF: 64, feelsF: 64, windMph: 3, gustMph: 6, dir: 'S', precip: '0.00' },
    now,
    opts.inputs !== undefined ? opts.inputs : { response: fx.response, alerts: opts.alerts || null });
}
function fogVariants() {
  return [
    fogDigest('likely_2026_10_02'),
    fogDigest('possible'),
    fogDigest('steam_2026_05_31'),
    fogDigest('dry'),
    fogDigest('dry', { alerts: nwsAlerts({}) }),
    fogDigest('dry', { inputs: null }),
    fogDigest('likely_2026_10_02', { riverLevel: 11.5, water: 45 }),
  ];
}

test('the digest carries the site\'s fog verdict, using the water temperature for steam fog', () => {
  assert.strictEqual(fogDigest('likely_2026_10_02').fog.level, 'likely');
  assert.strictEqual(fogDigest('possible').fog.level, 'possible');
  const steam = fogDigest('steam_2026_05_31');
  assert.strictEqual(steam.fog.level, 'possible');
  assert.strictEqual(steam.fog.steam, true, 'the email must pass the river temperature through');
  assert.strictEqual(fogDigest('dry').fog.level, 'low');
  assert.strictEqual(fogDigest('dry', { inputs: null }).fog.level, 'unknown');
  assert.strictEqual(fogDigest('dry', { inputs: { response: null, alerts: null } }).fog.level, 'unknown');
});

test('SAFETY: unreadable fog data can never stop the email from being built', () => {
  // The email carries the boat restrictions. Fog is a heads-up; a surprise in
  // its data must degrade to "unavailable", never throw out of computeDigest.
  const bomb = new Proxy({}, { get() { throw new Error('boom'); } });
  for (const inputs of [{ response: bomb, alerts: null }, { response: null, alerts: bomb },
                        { response: { hourly: bomb }, alerts: { features: bomb } }]) {
    let d;
    assert.doesNotThrow(() => { d = fogDigest('likely_2026_10_02', { inputs }); });
    assert.strictEqual(d.fog.level, 'unknown');
    const html = M.renderEmailHtml(d);
    assert.ok(/Fog outlook unavailable/.test(html));
    assert.ok(/Allowed/.test(html), 'boat restrictions still rendered');
    assert.ok(!/FOG RISK/.test(M.renderSubject(d)));
  }
});

test('SAFETY: fog never changes which boats are allowed', () => {
  for (const [tempF, level] of [[72, 3], [55, 9.5], [45, 10.4], [35, 5]]) {
    const base = { raw: makeRaw(tempF, etDate('2026-10-02', 1)), history: historyAtTemp(tempF) };
    const river = { level, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() };
    const withFog = M.computeDigest(logic, base, river, { available: false }, etDate('2026-10-02', 1),
      { response: FOG_FX.likely_2026_10_02.response, alerts: nwsAlerts({}) });
    const noFog = M.computeDigest(logic, base, river, { available: false }, etDate('2026-10-02', 1), null);
    assert.strictEqual(withFog.fog.level, 'likely', 'sanity');
    assert.deepStrictEqual(plain(withFog.rows), plain(noFog.rows), `@${tempF}F/${level}ft`);
    assert.strictEqual(withFog.zone, noFog.zone);
  }
});

test('subject leads with FOG RISK on a likely-fog morning, and only then', () => {
  const s = M.renderSubject(fogDigest('likely_2026_10_02'), etDate('2026-10-02', 1));
  assert.ok(/^NHRC Oct 2 - FOG RISK - /.test(s), s);
  assert.ok(/^NHRC [A-Z][a-z]{2} \d{1,2} - FOG RISK - /.test(
    M.renderSubject(fogDigest('dry', { alerts: nwsAlerts({}) }))), 'an NWS advisory is a fog risk');
  for (const name of ['possible', 'steam_2026_05_31', 'dry']) {
    assert.ok(!/FOG/.test(M.renderSubject(fogDigest(name))), `${name}: "possible" and below stay out of the subject`);
  }
  assert.ok(!/FOG/.test(M.renderSubject(fogDigest('dry', { inputs: null }))));
});

test('subject length: within 78 normally; with FOG RISK the warning survives any truncation', () => {
  const worst = M.renderSubject(M.computeDigest(logic,
    { raw: makeRaw(48, etDate('2026-09-30', 1)), history: historyAtTemp(48) },
    { level: 11.5, isEstimate: true, failed: false, stale: true, ageMs: 0, lastObsTs: Date.now() },
    { available: false }, etDate('2026-09-30', 1),
    { response: null, alerts: nwsAlerts({}) }), etDate('2026-09-30', 1));
  assert.ok(/FOG RISK/.test(worst), `sanity: ${worst}`);
  assert.ok(worst.length <= 85, `${worst.length}: "${worst}"`);
  assert.ok(worst.indexOf('FOG RISK') <= 15, `the warning must sit at the front: "${worst}"`);
  for (const name of ['possible', 'dry']) {
    const s = M.renderSubject(fogDigest(name));
    assert.ok(s.length <= 78, `${s.length}: "${s}"`);
  }
});

test('a likely-fog email shows the warning box, the picket-fence rule, and that boats are unaffected', () => {
  const html = M.renderEmailHtml(fogDigest('likely_2026_10_02'));
  assert.ok(html.includes('Fog likely at dawn this morning'));
  assert.ok(html.includes('Club rule: If you cannot see the house with the picket fence, do not launch.'));
  assert.ok(html.includes('Fog does not change which boats are allowed.'));
  assert.ok(html.indexOf('Fog likely at dawn') < html.indexOf('Boat restrictions'),
    'the fog warning belongs above the boat list');
});

test('a "not indicated" or "unavailable" email still carries the fog line and the rule', () => {
  for (const d of [fogDigest('dry'), fogDigest('dry', { inputs: null })]) {
    const html = M.renderEmailHtml(d);
    assert.ok(/Fog not indicated this morning|Fog outlook unavailable/.test(html));
    assert.ok(html.includes('picket fence'), 'the rule applies every day');
    assert.ok(!html.includes('Fog does not change which boats'), 'no warning box on a quiet morning');
  }
});

test('an NWS advisory renders in the red style; a model-only warning in amber', () => {
  const adv = M.renderEmailHtml(fogDigest('dry', { alerts: nwsAlerts({}) }));
  assert.ok(/NWS Dense Fog Advisory in effect until 9:00 AM/.test(adv), 'advisory headline');
  assert.ok(adv.includes('background-color:#fdeaea'), 'advisory should use the "no" palette');
  const likely = M.renderEmailHtml(fogDigest('likely_2026_10_02'));
  assert.ok(likely.includes('background-color:#fdf2d8'), 'model warning should use the caution palette');
});

test('every email says "Allowed" is not a go-ahead', () => {
  for (const d of [...everyDigest(), ...fogVariants()]) {
    const html = M.renderEmailHtml(d);
    assert.ok(/is not a go-ahead/.test(html), 'missing the not-a-go-ahead note');
    assert.ok(/Fog, wind and water conditions are not measured here/.test(html));
  }
});

test('SAFETY: no email variant contains go-ahead language or a Go pill', () => {
  for (const d of [...everyDigest(), ...fogVariants()]) {
    const html = M.renderEmailHtml(d);
    assert.ok(!GO_AHEAD.test(html), `go-ahead phrase: ${(html.match(GO_AHEAD) || [])[0]}`);
    assert.ok(!/>(Go|Row|Clear)<\/span>/.test(html), 'go-ahead status pill');
  }
});

test('fog variants pass every email-client constraint the main sweep enforces', () => {
  for (const d of fogVariants()) {
    const html = M.renderEmailHtml(d);
    assert.ok(!/<style|@media|\sclass=|rgba\(/i.test(html), 'style, media query, class or rgba');
    assert.ok(!/<!DOCTYPE|<html|<head|<body/i.test(html), 'document wrapper');
    assert.strictEqual(nonAsciiChars(html).length, 0, 'non-ASCII in body');
    assert.strictEqual(nonAsciiChars(M.renderSubject(d)).length, 0, 'non-ASCII in subject');
    for (const tag of html.match(/<(td|div)\b[^>]*style="[^"]*"[^>]*>/gi) || []) {
      const style = tag.match(/style="([^"]*)"/)[1];
      if (/(^|;)\s*color\s*:/.test(style)) assert.ok(/background-color\s*:/.test(style), `no background: ${tag}`);
      if (/font-size|font-weight/.test(style) && !/font-size\s*:\s*0\b/.test(style)) {
        assert.ok(/(^|;)\s*color\s*:/.test(style), `no colour: ${tag}`);
      }
    }
    const opens = (html.match(/<(table|tr|td|div)\b/gi) || []).length;
    const closes = (html.match(/<\/(table|tr|td|div)>/gi) || []).length;
    assert.strictEqual(opens, closes, 'unbalanced tags');
    assert.ok(html.includes('{{ unsubscribe_url }}') && /guidance only/i.test(html));
    assert.ok(!/undefined|NaN|\[object/.test(html), 'leaked undefined/NaN/object');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('13. Website rendering (index.html in a DOM stub)');
// ═══════════════════════════════════════════════════════════════════════════
//
// The email shares the site's logic, but the site's own render functions are
// separate code. Run the real page script with a DOM that remembers what was
// written, at a fixed clock, and read the result back.

// nowMs: a fixed clock in ms, or a function returning the current ms (for tests
// that let time pass). opts overrides parts of the environment: Chart,
// AbortController, setTimeout, clearTimeout, Image.
function loadSite(nowMs, fetchImpl, opts = {}) {
  const clock = typeof nowMs === 'function' ? nowMs : () => nowMs;
  const src = (opts.transform || (x => x))(fsT.readFileSync(INDEX_PATH, 'utf8').match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1]);
  const els = {};
  const el = id => els[id] || (els[id] = {
    id, innerHTML: '', textContent: '', className: '', style: {}, value: '',
    getContext: () => ({ createLinearGradient: () => ({ addColorStop() {} }) }),
    addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {},
    click() { this.clicked = (this.clicked || 0) + 1; }, remove() { this.removed = true; },
    get parentElement() { return el(id + '__parent'); },
  });
  class FixedDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock()); }
    static now() { return clock(); }
  }
  // The chart's range buttons, so their click handlers get attached and can be
  // fired - without them nothing tests that clicking "7 days" updates anything.
  const rangeButtons = [1, 7, 30, 90, 0].map(d => ({
    dataset: { d: String(d) }, classList: { add() {}, remove() {}, toggle() {} }, handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
  }));
  els.__rangeButtons = rangeButtons;
  // Page-level event listeners, so tests can fire DOMContentLoaded,
  // visibilitychange and pageshow.
  const listeners = { document: {}, window: {} };
  const on = (bucket) => (type, fn) => { (listeners[bucket][type] = listeners[bucket][type] || []).push(fn); };
  els.__listeners = listeners;
  els.__fire = (bucket, type, event = {}) => (listeners[bucket][type] || []).forEach(fn => fn(event));
  const logged = [];
  els.__logged = logged;
  const blobs = { made: 0, live: new Set(), revoked: [] };
  els.__blobs = blobs;
  const document = { getElementById: el, querySelectorAll: (sel) => (/#range-btns/.test(sel) ? rangeButtons : []),
    querySelector: () => null, addEventListener: on('document'), createElement: () => el('__created'),
    visibilityState: 'visible', body: el('__body') };
  els.__document = document;
  const sandbox = {
    document,
    window: { addEventListener: on('window') }, fetch: fetchImpl || (() => new Promise(() => {})),
    // Shaped like Chart.js where the page touches it: data and options come
    // from the config it was built with.
    Chart: opts.Chart || function (ctx, cfg) { return { data: cfg && cfg.data, options: (cfg && cfg.options) || {}, destroy() {}, update() {} }; },
    moment: {},
    setInterval: opts.setInterval || (() => 0), setTimeout: opts.setTimeout || (() => 0), clearTimeout: opts.clearTimeout || (() => {}),
    AbortController: opts.AbortController,
    console: { log() {}, warn: (...a) => logged.push(['warn', ...a]), error: (...a) => logged.push(['error', ...a]) },
    URL: { createObjectURL() { const u = 'blob:fake-' + (++blobs.made); blobs.live.add(u); return u; },
           revokeObjectURL(u) { blobs.live.delete(u); blobs.revoked.push(u); } },
    Blob: function (parts, o) { this.parts = parts; this.type = o && o.type; els.__blobParts = parts; els.__blobType = this.type; },
    // By default an image fails to load, as it would with no network, and
    // says so asynchronously like a browser.
    Image: opts.Image || function () {
      const self = this; let src = '';
      Object.defineProperty(self, 'src', { get: () => src, set: (v) => { src = v; Promise.resolve().then(() => self.onerror && self.onerror()); } });
    },
    Intl, Date: FixedDate, Math, JSON, isNaN, parseInt, parseFloat, Number, Array, Object, String,
  };
  const ctx = vmT.createContext(sandbox);
  vmT.runInContext(src + '\n;this.__site = { state, renderRowingStatus, renderFogOutlook, renderFloodGrid, renderDashboard,' +
    ' renderSummaryWeather, renderSummaryRiver, renderRiverCardUnavailable, updateStats, loadWeather, loadRiverData,' +
    ' loadData, loadHistory, refreshAll, loadFogOutlook, loadCameraSnapshot, historyNeedsRefresh, pickRiverLevel,' +
    ' fetchWithTimeout, renderRiverCard, renderChartData, updateFreshnessWarnings, updateInfoBar, isCameraBackupAsleep,' +
    ' cameraCaption, cameraMissingMessage, CAMERA_SNAPSHOT_URL, nearestReading, downloadCSV, withGapBreaks,' +
    ' checkCameraForNewPhoto };',
    ctx, { timeout: 10000 });
  return { site: ctx.__site, els };
}

test('site: every zone shows "Allowed", never Row/Go/Clear, with the not-a-go-ahead note first', () => {
  const { site, els } = loadSite(Date.now());
  for (const tempF of [35, 45, 55, 72]) {
    site.state.allHistory = historyAtTemp(tempF);
    site.state.riverLevel = 3;
    site.renderRowingStatus(tempF);
    const grid = els['tiers-grid'].innerHTML, notes = els['rowing-notes'].innerHTML;
    assert.ok(!/>(Row|Go|Clear)</.test(grid), `${tempF}F: go-ahead pill in the site grid`);
    if (tempF === 72) assert.ok(/>Allowed</.test(grid), 'normal zone should show Allowed');
    assert.ok(/^<div class="allowed-note"><strong>&ldquo;Allowed&rdquo; is not a go-ahead/.test(notes),
      `${tempF}F: the note must come first: ${notes.slice(0, 80)}`);
    assert.ok(!GO_AHEAD.test(els['rule-banner'].innerHTML), els['rule-banner'].innerHTML);
  }
  assert.ok(/No temperature restrictions/.test(els['rule-banner'].innerHTML));
});

test('site: the river panel labels permitted boats "Allowed"', () => {
  const { site, els } = loadSite(Date.now());
  site.renderFloodGrid(3);
  assert.ok(/>Allowed</.test(els['flood-grid'].innerHTML));
  assert.ok(!/>Clear</.test(els['flood-grid'].innerHTML));
});

test('site: the page never flashes an all-clear before data loads', () => {
  const html = fsT.readFileSync(INDEX_PATH, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const markup = html.slice(0, html.indexOf('<script>'));
  assert.ok(/id="rule-banner" class="rule-banner neutral"/.test(markup), 'placeholder must be neutral, not green');
  assert.ok(!GO_AHEAD.test(markup), `go-ahead phrase in static markup: ${(markup.match(GO_AHEAD) || [])[0]}`);
  assert.ok(!/Current Conditions/.test(markup), 'the rules card must not claim to show current conditions');
});

test('site: 5 AM on 2 Oct shows fog LIKELY in the card and the top banner, with the rule', () => {
  const { site, els } = loadSite(etDate('2026-10-02', 5).getTime());
  Object.assign(site.state, { fogLoaded: true, fogResponse: FOG_FX.likely_2026_10_02.response,
    fogAlerts: null, lastTempF: 65.7 });
  site.renderFogOutlook();
  const box = els['fog-outlook'].innerHTML;
  assert.ok(/fog-pill likely/.test(box) && /Fog likely at dawn this morning/.test(box), box);
  assert.ok(/If you cannot see the house with the picket fence, do not launch\./.test(box));
  assert.strictEqual(els['warn-fog'].style.display, 'flex');
  assert.ok(/picket fence/.test(els['warn-fog-text'].innerHTML));
  assert.ok(/does not change which boats are allowed/.test(els['warn-fog-text'].innerHTML));
});

test('site: a quiet morning shows the outlook but no banner; nothing renders before loading', () => {
  const { site, els } = loadSite(etDate('2026-09-19', 6).getTime());
  site.renderFogOutlook();
  assert.strictEqual(els['fog-outlook'].innerHTML, '', 'must not render before the forecast has loaded');
  Object.assign(site.state, { fogLoaded: true, fogResponse: FOG_FX.dry.response, fogAlerts: null, lastTempF: 72.3 });
  site.renderFogOutlook();
  assert.ok(/Fog not indicated this morning/.test(els['fog-outlook'].innerHTML));
  assert.ok(/picket fence/.test(els['fog-outlook'].innerHTML));
  assert.strictEqual(els['warn-fog'].style.display, 'none');
});

test('site: a failed fog fetch says "unavailable" - never silence, never "not indicated"', () => {
  const { site, els } = loadSite(etDate('2026-10-02', 5).getTime());
  Object.assign(site.state, { fogLoaded: true, fogResponse: null, fogAlerts: null, lastTempF: 65 });
  site.renderFogOutlook();
  assert.ok(/Fog outlook unavailable/.test(els['fog-outlook'].innerHTML));
  assert.ok(!/not indicated/.test(els['fog-outlook'].innerHTML));
});

test('site: after 10 AM the outlook is about tomorrow morning', () => {
  const { site, els } = loadSite(etDate('2026-10-01', 14).getTime());
  Object.assign(site.state, { fogLoaded: true, fogResponse: FOG_FX.likely_2026_10_02.response,
    fogAlerts: null, lastTempF: 65.7 });
  site.renderFogOutlook();
  assert.ok(/Fog likely at dawn tomorrow morning/.test(els['fog-outlook'].innerHTML), els['fog-outlook'].innerHTML);
});

// Forecast data that throws the moment anything reads it - standing in for any
// shape of surprise the API, a proxy or a browser extension might produce.
const EXPLODING = new Proxy({}, { get() { throw new Error('boom: unreadable forecast'); } });

test('SAFETY site: a fog failure cannot suppress the stale-data or offline-sensor warnings', () => {
  // renderFogOutlook used to run BEFORE updateFreshnessWarnings() and the
  // offline banner, so an exception in it would have skipped both.
  const now = Date.now();
  const { site, els } = loadSite(now);
  site.state.allHistory = historyAtTemp(72);
  Object.assign(site.state, { fogLoaded: true, fogResponse: EXPLODING, fogAlerts: null });
  const fourHoursAgo = new Date(now - 4 * 3600000);
  const tempC = (72 - 32) * 5 / 9;
  assert.doesNotThrow(() => site.renderDashboard(tempC, makeRaw(72, fourHoursAgo)));
  assert.strictEqual(els['warn-offline'].style.display, 'flex', 'offline banner must still appear');
  assert.strictEqual(els['status-text'].textContent, 'Sensor offline');
  assert.ok(/Fog outlook unavailable/.test(els['fog-outlook'].innerHTML), 'fog failure must be stated');
});

test('site: renderFogOutlook never throws, whatever the forecast data looks like', () => {
  const { site, els } = loadSite(etDate('2026-10-02', 5).getTime());
  for (const bad of [EXPLODING, { hourly: EXPLODING }, { hourly: { time: EXPLODING } }, 42, 'x', [], { hourly: [] }]) {
    Object.assign(site.state, { fogLoaded: true, fogResponse: bad, fogAlerts: bad, lastTempF: 65 });
    assert.doesNotThrow(() => site.renderFogOutlook());
    assert.ok(/Fog outlook unavailable|Fog not indicated/.test(els['fog-outlook'].innerHTML),
      els['fog-outlook'].innerHTML.slice(0, 120));
    assert.strictEqual(els['warn-fog'].style.display, 'none', 'no banner from unreadable data');
  }
});

test('site: footer status describes the sensor feed, never "Normal"', () => {
  const now = Date.now();
  const tempC = (72 - 32) * 5 / 9;
  for (const [ageMin, expected] of [[1, 'Sensor live'], [44, 'Sensor live'], [60, 'Sensor delayed'],
                                    [179, 'Sensor delayed'], [181, 'Sensor offline'], [3000, 'Sensor offline']]) {
    const { site, els } = loadSite(now);
    site.state.allHistory = historyAtTemp(72);
    site.renderDashboard(tempC, makeRaw(72, new Date(now - ageMin * 60000)));
    assert.strictEqual(els['status-text'].textContent, expected, `${ageMin} min old`);
  }
});

test('site: the steam-fog check uses the river temperature once it arrives', () => {
  const { site, els } = loadSite(etDate('2026-05-31', 2).getTime());
  Object.assign(site.state, { fogLoaded: true, fogResponse: FOG_FX.steam_2026_05_31.response,
    fogAlerts: null, lastTempF: null });
  site.renderFogOutlook();
  assert.ok(/Fog not indicated/.test(els['fog-outlook'].innerHTML), 'no water reading yet');
  site.state.lastTempF = 63.25;
  site.renderFogOutlook();
  assert.ok(/Fog possible at dawn this morning/.test(els['fog-outlook'].innerHTML));
  assert.ok(/steam fog/.test(els['fog-outlook'].innerHTML));
});

// ═══════════════════════════════════════════════════════════════════════════
section('13b. Conditions summary and history stats');
// ═══════════════════════════════════════════════════════════════════════════
//
// Top of the page: a snapshot at first sight - water, weather (with a fog
// line), river - each tile from its own source. Min/max/avg moved into the
// Temperature History card and follow its range buttons.

const okJson = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const WEATHER_NOW = { current: { temperature_2m: 63.4, apparent_temperature: 63, weather_code: 0,
  wind_speed_10m: 3.2, wind_gusts_10m: 6.1, wind_direction_10m: 190, precipitation: 0 },
  daily: { sunrise: ['2026-10-03T06:53'], sunset: ['2026-10-03T18:32'] } };

test('layout: summary at the top, stats inside the history chart, nothing left in between', () => {
  const html = fsT.readFileSync(INDEX_PATH, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const markup = html.slice(0, html.indexOf('<script>'));
  const at = (s) => markup.indexOf(s);
  assert.ok(/<h2>Conditions Summary<\/h2>/.test(markup), 'heading');
  assert.ok(at('class="summary-grid"') > 0 && at('class="summary-grid"') < at('class="rowing-status-card"'),
    'the summary must sit above the rules card');
  for (const id of ['current-f', 'sum-weather', 'sum-fog', 'sum-river']) {
    assert.ok(at(`id="${id}"`) > at('class="summary-grid"') && at(`id="${id}"`) < at('class="rowing-status-card"'), id);
  }
  for (const id of ['min-val', 'max-val', 'avg-val', 'min-label']) {
    assert.ok(at(`id="${id}"`) > at('class="chart-card"'), `${id} must live in the Temperature History card`);
  }
  assert.ok(!/temp-hero|id="device-name"/.test(markup), 'old hero box and sensor-name heading are gone');
});

test('summary water tile: shows the reading, and still turns red when the sensor is stale', () => {
  const now = Date.now();
  const tempC = (66.3 - 32) * 5 / 9;
  let { site, els } = loadSite(now);
  site.state.allHistory = historyAtTemp(66);
  site.renderDashboard(tempC, makeRaw(66.3, new Date(now - 10 * 60000)));
  assert.strictEqual(String(els['current-f'].textContent), '66.3');
  assert.strictEqual(els['current-f'].style.color, 'var(--white)');
  assert.ok(/^Water sensor reading: /.test(els['last-updated'].textContent), els['last-updated'].textContent);
  ({ site, els } = loadSite(now));
  site.state.allHistory = historyAtTemp(66);
  site.renderDashboard(tempC, makeRaw(66.3, new Date(now - 4 * 3600000)));
  assert.strictEqual(els['current-f'].style.color, 'var(--bad)', 'stale water reading must still be flagged red (the theme\'s red)');
});

test('summary weather tile: filled by the real weather loader - temp, condition, wind', async () => {
  const { site, els } = loadSite(Date.now(), () => okJson(WEATHER_NOW));
  await site.loadWeather();
  const t = els['sum-weather'].innerHTML;
  assert.ok(/63°F/.test(t) && /Clear sky/.test(t) && /Wind 3 mph S, gusts 6/.test(t), t);
  assert.ok(!/summary-alert/.test(t), 'no alert in calm weather');
  assert.ok(/63°F/.test(els['weather-content'].innerHTML), 'the detailed weather card still renders too');
});

test('summary weather tile: carries the same alert as the weather card (wind, storms)', async () => {
  const windy = JSON.parse(JSON.stringify(WEATHER_NOW));
  windy.current.wind_speed_10m = 22; windy.current.wind_gusts_10m = 31;
  const { site, els } = loadSite(Date.now(), () => okJson(windy));
  await site.loadWeather();
  assert.ok(/summary-alert danger/.test(els['sum-weather'].innerHTML), els['sum-weather'].innerHTML);
  assert.ok(/High wind/.test(els['sum-weather'].innerHTML));
  assert.ok(/High wind/.test(els['weather-content'].innerHTML), 'and the card below agrees');
});

test('summary weather tile: an outage says "Weather unavailable" and breaks nothing', async () => {
  const { site, els } = loadSite(Date.now(), () => Promise.reject(new Error('offline')));
  await site.loadWeather();
  assert.ok(/Weather unavailable/.test(els['sum-weather'].innerHTML));
  assert.ok(/Could not load weather/.test(els['weather-content'].innerHTML));
  assert.doesNotThrow(() => site.renderSummaryWeather({ get tempF() { throw new Error('boom'); } }));
});

test('summary river tile: filled by the real river loader - level, gauge, restriction', async () => {
  const now = Date.now();
  const series = (dir) => ({ data: Array.from({ length: 12 }, (_, i) => ({
    validTime: new Date(now + dir * (11 - i) * 3600e3).toISOString(), primary: 3.1 })) });
  const { site, els } = loadSite(now, (url) => okJson(/observed$/.test(url) ? series(-1) : series(1)));
  await site.loadRiverData();
  const r = els['sum-river'].innerHTML;
  assert.ok(/3\.1 ft/.test(r) && /Stevenson Dam gauge/.test(r) && /No river-level restrictions/.test(r), r);
  assert.ok(/river-status-pill rp-normal/.test(r));
});

test('summary river tile: restrictions, forecast estimates and outages are all stated', () => {
  const { site, els } = loadSite(Date.now());
  Object.assign(site.state, { riverLevel: 10.4, riverLevelIsEstimate: false });
  site.renderSummaryRiver();
  assert.ok(/10\.4 ft/.test(els['sum-river'].innerHTML));
  assert.ok(els['sum-river'].innerHTML.includes(logic.floodSummaryLabel(10.4).text), 'same words as the river card');
  Object.assign(site.state, { riverLevel: 3.1, riverLevelIsEstimate: true });
  site.renderSummaryRiver();
  assert.ok(/Forecast estimate/.test(els['sum-river'].innerHTML), 'an estimate must never look like a live gauge');
  // After a failed refresh state.riverLevel still holds the OLD reading; the
  // summary must not keep showing it as current.
  site.renderRiverCardUnavailable('Could not load river data.');
  assert.ok(/River level unavailable/.test(els['sum-river'].innerHTML));
  assert.ok(!/3\.1 ft/.test(els['sum-river'].innerHTML));
  Object.assign(site.state, { riverLevel: null });
  site.renderSummaryRiver();
  assert.ok(/River level unavailable/.test(els['sum-river'].innerHTML));
});

test('summary fog line: same verdict as the fog outlook, naming which morning', () => {
  let { site, els } = loadSite(etDate('2026-10-02', 5).getTime());
  Object.assign(site.state, { fogLoaded: true, fogResponse: FOG_FX.likely_2026_10_02.response, fogAlerts: null, lastTempF: 65.7 });
  site.renderFogOutlook();
  assert.ok(/Fog this morning:/.test(els['sum-fog'].innerHTML) && /fog-pill likely">Likely/.test(els['sum-fog'].innerHTML),
    els['sum-fog'].innerHTML);
  ({ site, els } = loadSite(etDate('2026-10-01', 14).getTime()));
  Object.assign(site.state, { fogLoaded: true, fogResponse: FOG_FX.likely_2026_10_02.response, fogAlerts: null, lastTempF: 65.7 });
  site.renderFogOutlook();
  assert.ok(/Fog tomorrow morning:/.test(els['sum-fog'].innerHTML), els['sum-fog'].innerHTML);
  ({ site, els } = loadSite(etDate('2026-10-02', 5).getTime()));
  Object.assign(site.state, { fogLoaded: true, fogResponse: null, fogAlerts: null });
  site.renderFogOutlook();
  assert.ok(/fog-pill unknown">Unavailable/.test(els['sum-fog'].innerHTML), 'an outage is stated in the summary too');
});

// Readings at known temperatures in known age bands, so every range has a
// different correct answer.
function bandedHistory(now) {
  const out = [];
  const band = (fromH, toH, tempF) => { for (let h = fromH; h < toH; h += 1) out.push({ ts: now - h * 3600e3, tempF }); };
  band(1, 23, 72);        // last day
  band(30, 160, 60);      // 2-7 days ago
  band(200, 700, 50);     // 8-30 days ago
  band(800, 2100, 40);    // 1-3 months ago
  band(2300, 3000, 30);   // older than 3 months
  out.push({ ts: now - 2 * 3600e3, tempF: 74 });
  return out.sort((a, b) => a.ts - b.ts);
}

test('history stats follow the chart range, and say which range', () => {
  const now = Date.now();
  const { site, els } = loadSite(now);
  site.state.allHistory = bandedHistory(now);
  const expect = { 1: ['24h', 72, 74], 7: ['7 days', 60, 74], 30: ['30 days', 50, 74], 90: ['3 months', 40, 74], 0: ['all time', 30, 74] };
  for (const [range, [label, min, max]] of Object.entries(expect)) {
    site.state.currentRange = Number(range);
    site.updateStats();
    assert.strictEqual(els['min-label'].textContent, `Min (${label})`);
    assert.strictEqual(els['avg-label'].textContent, `Avg (${label})`);
    assert.strictEqual(els['min-val'].textContent, `${min.toFixed(1)}°F`, `min over ${label}`);
    assert.strictEqual(els['max-val'].textContent, `${max.toFixed(1)}°F`, `max over ${label}`);
  }
});

test('clicking a range button updates the stats, not just the chart', () => {
  const now = Date.now();
  const { site, els } = loadSite(now);
  site.state.allHistory = bandedHistory(now);
  site.state.currentRange = 1;
  site.updateStats();
  assert.strictEqual(els['min-val'].textContent, '72.0°F', 'sanity: 24h');
  const seven = els.__rangeButtons.find(b => b.dataset.d === '7');
  assert.strictEqual(typeof seven.handlers.click, 'function', 'the page must wire a click handler to the range buttons');
  seven.handlers.click();
  assert.strictEqual(els['min-label'].textContent, 'Min (7 days)');
  assert.strictEqual(els['min-val'].textContent, '60.0°F');
});

test('the beta notice is gone from the top; the disclaimer sits at the bottom, out of the way', () => {
  const html = fsT.readFileSync(INDEX_PATH, 'utf8');
  const markup = html.slice(0, html.indexOf('<script>')).replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/This website is in beta|Beta — data may not be accurate/.test(markup), 'no beta banner');
  const dash = markup.indexOf('<div id="dashboard">'), summary = markup.indexOf('class="dash-top"');
  const between = markup.slice(dash, summary);
  assert.ok(!/guidance only|thermometer/.test(between), 'nothing standing between the top of the page and the summary');
  const disc = markup.match(/<div id="site-disclaimer"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(disc, 'the disclaimer exists');
  const text = disc[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
  assert.ok(/guidance only/.test(text) && /thermometer on the side of the dock at the boathouse/.test(text)
    && /before making rowing decisions/.test(text), text);
  assert.ok(markup.indexOf('id="site-disclaimer"') > markup.indexOf('Daily Conditions Email'), 'after the last card');
  assert.ok(markup.indexOf('id="site-disclaimer"') > markup.lastIndexOf('</div>\n\n  <!-- FOOTER -->') ||
    markup.indexOf('id="site-disclaimer"') > markup.indexOf('id="status-text"'), 'at the bottom, by the footer');
  assert.ok(!/id="site-disclaimer"[^>]*display:\s*none/.test(markup), 'and visible');
});

test('the email sign-up box tells members about the fog outlook', () => {
  const html = fsT.readFileSync(INDEX_PATH, 'utf8');
  const box = html.slice(html.indexOf('<div class="section-label">Daily Conditions Email</div>'), html.indexOf('<form action="https://buttondown.com'));
  assert.ok(/dawn fog outlook/.test(box), 'the sign-up box should say the email includes fog');
  assert.ok(/FOG RISK/.test(box), 'and what a FOG RISK subject line means');
  assert.ok(!/rowing status/i.test(box));
});

test('history stats: "all time" survives the full 525,600-reading history cap', () => {
  // Math.min(...readings) throws past ~65,000 values in Safari and ~120,000 in
  // Chrome; the history file is allowed to reach 525,600.
  const now = Date.now();
  const { site, els } = loadSite(now);
  const big = new Array(525600);
  for (let i = 0; i < big.length; i++) big[i] = { ts: now - (big.length - i) * 60000, tempF: 50 + (i % 200) / 10 };
  site.state.allHistory = big;
  site.state.currentRange = 0;
  assert.doesNotThrow(() => site.updateStats());
  assert.strictEqual(els['min-val'].textContent, '50.0°F');
  assert.strictEqual(els['max-val'].textContent, '69.9°F');
});

test('history stats: an empty range shows "--", never the previous numbers', () => {
  const now = Date.now();
  const { site, els } = loadSite(now);
  site.state.allHistory = bandedHistory(now);
  site.state.currentRange = 1;
  site.updateStats();
  assert.notStrictEqual(els['min-val'].textContent, '--', 'sanity');
  site.state.allHistory = [];
  site.updateStats();
  assert.strictEqual(els['min-val'].textContent, '--');
  assert.strictEqual(els['avg-val'].textContent, '--');
});

// ═══════════════════════════════════════════════════════════════════════════
section('13c. Website resilience: failed refreshes, slow networks, missing libraries');
// ═══════════════════════════════════════════════════════════════════════════
//
// The page runs for hours on phones with one bar of signal at the river. Each
// test drives the real loaders through a fake network, with a clock the test
// moves forward.

const HOUR = 3600000;
// A fake network: [regex, handler] pairs, every call recorded.
function fakeNet(routes) {
  const calls = [];
  const fetch = (url, opts) => {
    url = String(url); calls.push(url);
    for (const [re, h] of routes) if (re.test(url)) return h(url, opts);
    return Promise.reject(new Error('unexpected request ' + url));
  };
  return { fetch, calls, count: (re) => calls.filter(u => re.test(u)).length };
}
const reply = (body, status = 200) =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });
const offline = () => Promise.reject(new TypeError('Failed to fetch'));
const settle = async (rounds = 20) => { for (let i = 0; i < rounds; i++) await new Promise(r => setImmediate(r)); };
// history.json as the site serves it: a reading every 15 minutes, ISO strings,
// ending exactly at endMs (the time data.json's fetchedAt carries).
function histUpTo(endMs, tempF, days = 10) {
  const out = [];
  for (let ts = endMs - days * 24 * HOUR; ts <= endMs; ts += 15 * 60000) out.push({ ts: new Date(ts).toISOString(), tempF });
  if (Date.parse(out[out.length - 1].ts) !== endMs) out.push({ ts: new Date(endMs).toISOString(), tempF });
  return out;
}
const riverSeries = (t0, ft, kind) => ({ data: kind === 'observed'
  ? Array.from({ length: 24 }, (_, i) => ({ validTime: new Date(t0 - (23 - i) * 15 * 60000).toISOString(), primary: ft }))
  : Array.from({ length: 12 }, (_, i) => ({ validTime: new Date(t0 + (1 + i * 6) * HOUR).toISOString(), primary: ft + 0.3 })) });

test('a failed refresh keeps the last reading on screen - it used to replace the whole page', async () => {
  let t = Date.now(), up = true, reading = t - 10 * 60000;
  const net = fakeNet([
    [/^data\.json/, () => up ? reply(makeRaw(66.3, new Date(reading))) : offline()],
    [/^history\.json/, () => reply(histUpTo(reading, 66))],
  ]);
  const { site, els } = loadSite(() => t, net.fetch);
  await site.loadData();
  assert.strictEqual(els['dashboard'].style.display, 'block');
  assert.strictEqual(els['pill-text'].textContent, 'Live');
  up = false; t += 60000;
  await site.loadData();
  assert.strictEqual(els['dashboard'].style.display, 'block', 'the dashboard must stay');
  assert.notStrictEqual(els['error-view'].style.display, 'block', 'no error page over good data');
  assert.strictEqual(String(els['current-f'].textContent), '66.3', 'the last reading stays');
  assert.strictEqual(els['pill-text'].textContent, 'Reconnecting…', 'and the pill says it could not refresh');
  // The reading keeps ageing while the connection is down: the warnings still come.
  t += 4 * HOUR;
  await site.loadData();
  assert.strictEqual(els['warn-offline'].style.display, 'flex', 'offline banner after 3 h, even with no connection');
  assert.strictEqual(els['status-text'].textContent, 'Sensor offline');
  assert.strictEqual(els['current-f'].style.color, 'var(--bad)');
  // Back online with a fresh reading: everything recovers.
  up = true; reading = t - 5 * 60000;
  await site.loadData();
  assert.strictEqual(els['pill-text'].textContent, 'Live');
  assert.strictEqual(els['warn-offline'].style.display, 'none');
});

test('a data.json with no usable reading, after a good load, is treated as a failed refresh', async () => {
  let t = Date.now(), body = makeRaw(64.0, new Date(t - 5 * 60000));
  const net = fakeNet([[/^data\.json/, () => reply(body)], [/^history\.json/, () => reply(histUpTo(t - 5 * 60000, 64))]]);
  const { site, els } = loadSite(() => t, net.fetch);
  await site.loadData();
  for (const bad of [{ error: true }, { data: { devices: [] } }, null]) {
    body = bad; t += 60000;
    await site.loadData();
    assert.strictEqual(els['dashboard'].style.display, 'block', JSON.stringify(bad));
    assert.strictEqual(String(els['current-f'].textContent), '64');
    assert.strictEqual(els['pill-text'].textContent, 'Reconnecting…');
  }
});

test('a failed FIRST load shows an error written for members, not for the repository owner', async () => {
  const { site, els } = loadSite(Date.now(), () => offline());
  await site.loadData();
  assert.strictEqual(els['error-view'].style.display, 'block');
  assert.strictEqual(els['dashboard'].style.display, 'none');
  const html = fsT.readFileSync(INDEX_PATH, 'utf8');
  const view = html.slice(html.indexOf('<div id="error-view">'), html.indexOf('<div id="dashboard">'));
  assert.ok(!/Actions|repo|workflow|GitHub/i.test(view), 'no developer instructions on the public page');
  assert.ok(/onclick="refreshAll\(\)"/.test(view), 'a Try again button');
  assert.ok(/thermometer on the dock/.test(view), 'and what to do instead');
});

test('history.json is downloaded only when it lacks the latest reading - not every minute', async () => {
  let t = Date.now(), reading = t - 3 * 60000, served = reading;
  const net = fakeNet([
    [/^data\.json/, () => reply(makeRaw(66, new Date(reading)))],
    [/^history\.json/, () => reply(histUpTo(served, 66))],
  ]);
  const { site } = loadSite(() => t, net.fetch);
  const hist = () => net.count(/^history\.json/);
  await site.loadData();
  assert.strictEqual(hist(), 1, 'first load');
  for (let i = 0; i < 10; i++) { t += 60000; await site.loadData(); }
  assert.strictEqual(net.count(/^data\.json/), 11, 'data.json every minute');
  assert.strictEqual(hist(), 1, 'history not re-downloaded while it already has the reading');
  // A new reading arrives in both files.
  reading = served = t - 30000; t += 60000;
  await site.loadData();
  assert.strictEqual(hist(), 2, 'fetched once for the new reading');
  t += 60000; await site.loadData();
  assert.strictEqual(hist(), 2, 'and not again');
  // history.json lags behind data.json: retried, but at most every 2 minutes.
  reading = t - 10000; t += 60000;
  await site.loadData();
  assert.strictEqual(hist(), 3, 'fetched for the new reading, still behind');
  t += 60000; await site.loadData();
  assert.strictEqual(hist(), 3, 'not again within 2 minutes');
  t += 61000; await site.loadData();
  assert.strictEqual(hist(), 4, 'retried after 2 minutes');
  served = reading; t += 2 * 60000 + 1000; await site.loadData();
  assert.strictEqual(hist(), 5, 'caught up');
  t += 3 * 60000; await site.loadData();
  assert.strictEqual(hist(), 5, 'and then left alone');
});

test('history: readings stored as strings are parsed; junk rows are dropped, not fatal', async () => {
  const t = Date.now();
  const rows = histUpTo(t - 60000, 66).map((r, i) => i % 2 ? { ts: r.ts, tempF: String(r.tempF) } : r);
  rows.push({ ts: 'garbage', tempF: 70 }, { ts: new Date(t - 30000).toISOString(), tempF: '' }, { ts: new Date(t - 20000).toISOString() });
  const net = fakeNet([[/^data\.json/, () => reply(makeRaw(66, new Date(t - 60000)))], [/^history\.json/, () => reply(rows)]]);
  const { site, els } = loadSite(t, net.fetch);
  await site.loadData();
  assert.ok(site.state.allHistory.every(h => typeof h.tempF === 'number' && Number.isFinite(h.tempF)));
  assert.strictEqual(site.state.allHistory.length, histUpTo(t - 60000, 66).length, 'every real reading kept, the three junk rows dropped');
  assert.strictEqual(els['min-val'].textContent, '66.0°F');
});

test('river: a failed refresh keeps the last good data - card, summary and rules agree', async () => {
  let t = Date.now(), up = true;
  const t0 = t;
  const net = fakeNet([
    [/^data\.json/, () => reply(makeRaw(72, new Date(t - 5 * 60000)))],
    [/^history\.json/, () => reply(histUpTo(t - 5 * 60000, 72))],
    [/stageflow\/observed$/, () => up ? reply(riverSeries(t0, 10.5, 'observed')) : offline()],
    [/stageflow\/forecast$/, () => up ? reply(riverSeries(t0, 10.5, 'forecast')) : offline()],
  ]);
  const { site, els } = loadSite(() => t, net.fetch);
  await site.loadData();
  await site.loadRiverData();
  const twoX = () => (els['tiers-grid'].innerHTML.match(/<span class="boat-name">2x<\/span>\s*<span class="boat-status (\w+-\w+)"/) || [])[1];
  assert.ok(/10\.5 ft/.test(els['sum-river'].innerHTML), 'sanity: summary');
  assert.strictEqual(twoX(), 'bs-no', 'sanity: at 10.5 ft the river restricts 2x');
  // NOAA unreachable for one refresh.
  up = false; t += 15 * 60000;
  await site.loadRiverData();
  assert.ok(/10\.5 ft/.test(els['sum-river'].innerHTML), 'the summary keeps the level: ' + els['sum-river'].innerHTML);
  assert.ok(!/Could not load|unavailable/i.test(els['river-content'].innerHTML), 'the card keeps it too');
  assert.strictEqual(twoX(), 'bs-no', 'and the rules still apply it');
  // Seven hours of outage: the reading is stale, the forecast stands in - labelled.
  t = t0 + 7 * HOUR + 15 * 60000;
  await site.loadRiverData();
  assert.ok(/Forecast estimate/.test(els['sum-river'].innerHTML), els['sum-river'].innerHTML);
  assert.ok(/10\.8 ft/.test(els['sum-river'].innerHTML), 'the forecast value');
  assert.ok(/forecast estimate/.test(els['rowing-notes'].innerHTML), 'the rules card says so too');
  assert.ok(/River gauge data is stale/.test(els['river-content'].innerHTML));
  // Five days: even the forecast has run out. The last reading, flagged stale.
  t = t0 + 5 * 24 * HOUR;
  await site.loadRiverData();
  assert.ok(/10\.5 ft/.test(els['sum-river'].innerHTML) && /not current/.test(els['sum-river'].innerHTML), els['sum-river'].innerHTML);
  assert.ok(/that last reading, not a current one/.test(els['river-content'].innerHTML));
  assert.ok(/last gauge reading, not current/.test(els['rowing-notes'].innerHTML));
  assert.strictEqual(twoX(), 'bs-no', 'still restricting, and saying why');
});

test('river: with no data at all, card, summary and rules all say no flood restrictions are applied', async () => {
  const t = Date.now();
  const net = fakeNet([
    [/^data\.json/, () => reply(makeRaw(72, new Date(t - 5 * 60000)))],
    [/^history\.json/, () => reply(histUpTo(t - 5 * 60000, 72))],
    [/stageflow/, () => offline()],
  ]);
  const { site, els } = loadSite(t, net.fetch);
  await site.loadData();
  await site.loadRiverData();
  assert.ok(/Could not load river data\. Flood restrictions not applied\./.test(els['river-content'].innerHTML));
  assert.ok(/River level unavailable/.test(els['sum-river'].innerHTML));
  assert.ok(!/bs-no|bs-caution/.test(els['tiers-grid'].innerHTML), 'no river restriction applied at 72°F');
  assert.ok(!/River level:/.test(els['rowing-notes'].innerHTML), 'no river level claimed in the rules card');
});

test('river: NOAA answering with errors is a failed refresh too, not an empty river', async () => {
  let t = Date.now(), status = 200;
  const t0 = t;
  const net = fakeNet([
    [/stageflow\/observed$/, () => status === 200 ? reply(riverSeries(t0, 3.1, 'observed')) : reply({ error: 'x' }, status)],
    [/stageflow\/forecast$/, () => status === 200 ? reply(riverSeries(t0, 3.1, 'forecast')) : reply({ error: 'x' }, status)],
  ]);
  const { site, els } = loadSite(() => t, net.fetch);
  await site.loadRiverData();
  status = 503; t += 15 * 60000;
  await site.loadRiverData();
  assert.ok(/3\.1 ft/.test(els['sum-river'].innerHTML), els['sum-river'].innerHTML);
  assert.ok(/Stevenson Dam gauge/.test(els['sum-river'].innerHTML), 'a 15-minute-old reading is still the live gauge');
});

test('chart library missing: the river card still shows the level, the pill and the boat grid', async () => {
  const t = Date.now();
  const net = fakeNet([[/stageflow\/(observed|forecast)$/, (u) => reply(riverSeries(t, 9.5, /observed$/.test(u) ? 'observed' : 'forecast'))]]);
  const { site, els } = loadSite(t, net.fetch, { Chart: function () { throw new ReferenceError('Chart is not defined'); } });
  await site.loadRiverData();
  const card = els['river-content'].innerHTML;
  assert.ok(/9\.5/.test(card) && /river-status-pill rp-caution/.test(card), 'level and pill');
  assert.ok(!/Could not load/.test(card), 'not declared unavailable');
  assert.ok(/1x/.test(els['flood-grid'].innerHTML) && /No/.test(els['flood-grid'].innerHTML), 'boat grid');
  assert.ok(/9\.5 ft/.test(els['sum-river'].innerHTML), 'summary');
  assert.ok(/Chart unavailable/.test(els['river-chart__parent'].innerHTML), 'the chart area says why it is empty');
});

test('chart library missing: the history stats, info bar and rules still update', async () => {
  const t = Date.now();
  const net = fakeNet([[/^data\.json/, () => reply(makeRaw(66, new Date(t - 60000)))], [/^history\.json/, () => reply(histUpTo(t - 60000, 66))]]);
  const { site, els } = loadSite(t, net.fetch, { Chart: function () { throw new ReferenceError('Chart is not defined'); } });
  await site.loadData();
  assert.strictEqual(els['min-val'].textContent, '66.0°F');
  assert.ok(/readings/.test(els['info-count'].textContent));
  assert.ok(/Allowed/.test(els['tiers-grid'].innerHTML), 'rules rendered');
  assert.ok(/Chart unavailable/.test(els['chart-single-msg'].innerHTML));
  assert.strictEqual(els['dashboard'].style.display, 'block');
  els.__rangeButtons.find(b => b.dataset.d === '7').handlers.click();
  assert.strictEqual(els['min-label'].textContent, 'Min (7 days)', 'range buttons still update the stats');
});

test('a chart library of a different shape cannot break the range buttons or the history loader', async () => {
  const t = Date.now();
  const net = fakeNet([[/^data\.json/, () => reply(makeRaw(66, new Date(t - 60000)))], [/^history\.json/, () => reply(histUpTo(t - 60000, 66))]]);
  // Constructs fine, but has no options/scales and its update throws.
  const odd = function () { return { data: { datasets: [{}] }, update() { throw new Error('no date adapter'); }, destroy() {} }; };
  const { site, els } = loadSite(t, net.fetch, { Chart: odd });
  await site.loadData();
  assert.strictEqual(els['min-val'].textContent, '66.0°F');
  assert.doesNotThrow(() => els.__rangeButtons.find(b => b.dataset.d === '30').handlers.click());
  assert.strictEqual(els['min-label'].textContent, 'Min (30 days)');
  assert.ok(els.__logged.some(l => /temperature chart/.test(String(l[1]))), 'the failure is logged, not swallowed silently');
});

test('weather: a missing temperature is "unavailable", never 0°F; missing extras show "--"', async () => {
  const w = JSON.parse(JSON.stringify(WEATHER_NOW));
  w.current.temperature_2m = null;
  let { site, els } = loadSite(Date.now(), () => okJson(w));
  await site.loadWeather();
  assert.ok(/Weather unavailable/.test(els['sum-weather'].innerHTML));
  assert.ok(!/0°F/.test(els['sum-weather'].innerHTML + els['weather-content'].innerHTML));
  const w2 = JSON.parse(JSON.stringify(WEATHER_NOW));
  w2.current.wind_gusts_10m = null; w2.current.wind_direction_10m = null; w2.current.precipitation = null;
  w2.current.apparent_temperature = undefined;
  ({ site, els } = loadSite(Date.now(), () => okJson(w2)));
  await site.loadWeather();
  const sum = els['sum-weather'].innerHTML, card = els['weather-content'].innerHTML;
  assert.ok(/63°F/.test(sum) && /Wind 3 mph, gusts --/.test(sum), sum);
  assert.ok(/Feels like --°F/.test(card) && !/NaN|null|undefined/.test(card), card.slice(0, 400));
  ({ site, els } = loadSite(Date.now(), () => reply({ error: true, reason: 'quota' }, 429)));
  await site.loadWeather();
  assert.ok(/Weather unavailable/.test(els['sum-weather'].innerHTML), 'an HTTP error is an outage');
});

test('one request per source at a time: a slow network cannot pile up overlapping refreshes', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const t = Date.now();
  const net = fakeNet([
    [/^data\.json/, () => gate.then(() => reply(makeRaw(66, new Date(t - 60000))))],
    [/^history\.json/, () => reply(histUpTo(t - 60000, 66))],
  ]);
  const { site } = loadSite(t, net.fetch);
  const a = site.loadData(), b = site.loadData(), c = site.loadData();
  await settle();
  assert.strictEqual(net.count(/^data\.json/), 1, 'one request while the first is outstanding');
  release();
  await Promise.all([a, b, c]);
  await site.loadData();
  assert.strictEqual(net.count(/^data\.json/), 2, 'and the next refresh runs once it is done');
});

test('a request that never answers is abandoned after 20 s, and refreshing works again', async () => {
  const timers = [];
  const hang = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const net = fakeNet([[/^data\.json/, hang]]);
  const { site, els } = loadSite(Date.now(), net.fetch, {
    AbortController, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
  });
  const p = site.loadData();
  await settle();
  assert.strictEqual(timers.length, 1, 'a deadline was set');
  assert.strictEqual(timers[0].ms, 20000);
  timers[0].fn();
  await p;
  assert.strictEqual(els['error-view'].style.display, 'block', 'the stuck first load ends in the error view');
  site.loadData();
  await settle();
  assert.strictEqual(net.count(/^data\.json/), 2, 'the next refresh is not blocked by the stuck one');
});

test('returning to the tab after more than a minute refreshes everything; a quick glance does not', async () => {
  let t = Date.now();
  const net = fakeNet([
    [/^data\.json/, () => reply(makeRaw(66, new Date(t - 60000)))],
    [/^history\.json/, () => reply(histUpTo(t - 60000, 66))],
    [/api\.open-meteo\.com.*models=/, () => reply(FOG_FX.dry.response)],
    [/api\.open-meteo\.com/, () => reply(WEATHER_NOW)],
    [/api\.weather\.gov/, () => reply({ features: [] })],
    [/stageflow/, (u) => reply(riverSeries(t, 3, /observed$/.test(u) ? 'observed' : 'forecast'))],
  ]);
  const { site, els } = loadSite(() => t, net.fetch);
  const counts = () => ['data\\.json', 'forecast\\?latitude.*current=', 'models=', 'weather\\.gov', 'stageflow/observed']
    .map(p => net.count(new RegExp(p)));
  els.__fire('window', 'DOMContentLoaded');
  await settle();
  assert.deepStrictEqual(counts(), [1, 1, 1, 1, 1], 'page load fetches every source once');
  const away = async (ms) => {
    els.__document.visibilityState = 'hidden'; els.__fire('document', 'visibilitychange');
    t += ms;
    els.__document.visibilityState = 'visible'; els.__fire('document', 'visibilitychange');
    await settle();
  };
  await away(30000);
  assert.deepStrictEqual(counts(), [1, 1, 1, 1, 1], 'back after 30 s: nothing refetched');
  await away(8 * HOUR);
  assert.deepStrictEqual(counts(), [2, 2, 2, 2, 2], 'back after a night away: everything refreshed');
  els.__fire('window', 'pageshow', { persisted: false });
  await settle();
  assert.deepStrictEqual(counts(), [2, 2, 2, 2, 2], 'an ordinary page show changes nothing');
  els.__fire('window', 'pageshow', { persisted: true });
  await settle();
  assert.deepStrictEqual(counts(), [3, 3, 3, 3, 3], 'restored from the back/forward cache: refreshed');
});

test('data-gap banner: whole minutes (never "6h 60m"), days once it is days, boathouse time', () => {
  const now = etDate('2026-10-03', 7, 0).getTime();
  const gap = (ageMs) => {
    const { site, els } = loadSite(now);
    site.state.lastFetchedAt = new Date(now - ageMs);
    site.updateFreshnessWarnings();
    assert.strictEqual(els['warn-gap'].style.display, 'flex');
    return els['warn-gap-text'].textContent;
  };
  let t = gap(6 * HOUR + 59.6 * 60000);
  assert.ok(/for 7h 0m\./.test(t), t);
  t = gap(6 * HOUR + 59.4 * 60000);
  assert.ok(/for 6h 59m\./.test(t), t);
  t = gap(51 * HOUR);
  assert.ok(/for 2 days 3h\./.test(t), t);
  assert.ok(/Last reading: Oct 1, 4:00(\u202f| )AM EDT\./.test(t), t);
  assert.ok(!/GitHub|Actions/.test(t), 'no developer jargon on the public page');
});

test('delayed-data banner speaks to members, not to the repository owner', () => {
  const now = Date.now();
  const { site, els } = loadSite(now);
  site.state.lastFetchedAt = new Date(now - 50 * 60000);
  site.updateFreshnessWarnings();
  assert.strictEqual(els['warn-stale'].style.display, 'flex');
  assert.ok(/50 minutes ago/.test(els['warn-stale-text'].textContent));
  assert.ok(!/GitHub|Actions tab/.test(els['warn-stale-text'].textContent), els['warn-stale-text'].textContent);
});

test('the chart info bar gives the last reading in boathouse time', async () => {
  const t = etDate('2026-10-03', 6, 30).getTime();
  const net = fakeNet([[/^data\.json/, () => reply(makeRaw(66, new Date(t - 15 * 60000)))], [/^history\.json/, () => reply(histUpTo(t - 15 * 60000, 66))]]);
  const { site, els } = loadSite(t, net.fetch);
  await site.loadData();
  assert.ok(/^Last reading: Oct 3, 6:15(\u202f| )AM EDT \(15 min ago\)$/.test(els['info-last'].textContent), els['info-last'].textContent);
});

test('chart scrubber: the nearest READING, never a gap-break point (it used to throw at every gap)', () => {
  const { site } = loadSite(Date.now());
  const H = HOUR;
  const pts = site.withGapBreaks([{ x: 0, y: 60 }, { x: H, y: 61 }, { x: 30 * H, y: 62 }, { x: 31 * H, y: 63 }]);
  assert.ok(pts.some(p => p.y === null), 'sanity: the gap is broken with null points');
  for (const ts of [H + 1, H + 2, 2 * H, 15 * H, 29.9 * H, 30 * H - 1]) {
    const p = site.nearestReading(pts, ts);
    assert.ok(p && typeof p.y === 'number', `at ${ts / H} h: ${JSON.stringify(p)}`);
  }
  assert.strictEqual(site.nearestReading(pts, H + 1).y, 61);
  assert.strictEqual(site.nearestReading(pts, 30 * H - 1).y, 62);
  assert.strictEqual(site.nearestReading([{ x: 0, y: null }], 0), null, 'nothing to show is null, not a crash');
  assert.strictEqual(site.nearestReading([], 0), null);
});

test('CSV download: UTF-8 marked for Excel, boathouse date in the name, link attached while clicked', () => {
  const now = etDate('2026-10-03', 23, 30).getTime();   // already Oct 4 in UTC
  const { site, els } = loadSite(now);
  site.state.allHistory = [{ ts: now - 2 * HOUR, tempF: 65.4 }, { ts: now - HOUR, tempF: 65.25 }];
  site.downloadCSV();
  const text = els.__blobParts.join('');
  assert.ok(text.startsWith('\ufeffTimestamp (UTC),Temperature (°F),Temperature (°C)\n'), JSON.stringify(text.slice(0, 60)));
  assert.strictEqual(text.trim().split('\n').length, 3);
  assert.ok(/charset=utf-8/.test(els.__blobType));
  const a = els['__created'];
  assert.strictEqual(a.download, 'NHRC_water_temp_2026-10-03.csv', 'not the UTC date');
  assert.strictEqual(a.clicked, 1);
  assert.ok(a.removed, 'the temporary link is removed afterwards');
});

test('the Refresh button refreshes the whole summary, not just the water reading', () => {
  const html = fsT.readFileSync(INDEX_PATH, 'utf8');
  const btn = html.match(/<button[^>]*>Refresh<\/button>/);
  assert.ok(btn && /onclick="refreshAll\(\)"/.test(btn[0]), btn && btn[0]);
  const body = html.match(/function refreshAll\(\) \{([\s\S]*?)\n\}/)[1];
  for (const f of ['loadData', 'loadWeather', 'loadRiverData', 'loadCameraSnapshot', 'loadFogOutlook']) {
    assert.ok(new RegExp(f + '\\(\\)').test(body), `refreshAll must call ${f}`);
  }
});

test('fog: a failed refresh keeps the previous outlook for up to 6 hours, then says unavailable', async () => {
  const start = etDate('2026-10-02', 2).getTime();
  let t = start, up = true;
  const net = fakeNet([
    [/models=/, () => up ? reply(FOG_FX.likely_2026_10_02.response) : offline()],
    [/api\.weather\.gov/, () => up ? reply({ features: [] }) : offline()],
  ]);
  const { site, els } = loadSite(() => t, net.fetch);
  site.state.lastTempF = 65.7;
  await site.loadFogOutlook();
  assert.ok(/Fog likely at dawn this morning/.test(els['fog-outlook'].innerHTML), 'sanity');
  up = false; t = start + 30 * 60000;
  await site.loadFogOutlook();
  assert.ok(/Fog likely at dawn this morning/.test(els['fog-outlook'].innerHTML), 'one failed refresh keeps the outlook');
  assert.strictEqual(els['warn-fog'].style.display, 'flex', 'and the banner');
  t = start + 6 * HOUR + 60000;
  await site.loadFogOutlook();
  assert.ok(/Fog outlook unavailable/.test(els['fog-outlook'].innerHTML), 'past 6 hours it is stated as unavailable');
  assert.strictEqual(els['warn-fog'].style.display, 'none');
});

test('fog: an NWS advisory that has ended is not shown as in effect', async () => {
  let t = etDate('2026-10-02', 9, 30).getTime();
  const alerts = { features: [{ properties: { event: 'Dense Fog Advisory', status: 'Actual', messageType: 'Alert',
    ends: new Date(etDate('2026-10-02', 9).getTime()).toISOString(), expires: new Date(etDate('2026-10-02', 10).getTime()).toISOString() } }] };
  const net = fakeNet([[/models=/, () => reply(FOG_FX.dry.response)], [/api\.weather\.gov/, () => reply(alerts)]]);
  const { site, els } = loadSite(() => t, net.fetch);
  await site.loadFogOutlook();
  assert.ok(!/NWS Dense Fog Advisory in effect/.test(els['fog-outlook'].innerHTML), els['fog-outlook'].innerHTML.slice(0, 200));
  t = etDate('2026-10-02', 8, 30).getTime();
  await site.loadFogOutlook();
  assert.ok(/NWS Dense Fog Advisory in effect until 9:00/.test(els['fog-outlook'].innerHTML), 'before its end it is shown');
});

// ═══════════════════════════════════════════════════════════════════════════
section('13d. Boathouse camera on the website');
// ═══════════════════════════════════════════════════════════════════════════

// An image element that loads (or fails) as the test decides.
const imageThat = (ok) => function () {
  const self = this; let src = '';
  Object.defineProperty(self, 'src', { get: () => src,
    set: (v) => { src = v; Promise.resolve().then(() => (ok(v) ? self.onload && self.onload() : self.onerror && self.onerror())); } });
};
// The Worker's answer: the frame, when it was taken, and (from the current
// Worker) which camera took it.
const frameReply = (lastModified, role, name) => Promise.resolve({ ok: true, status: 200,
  headers: { get: (h) => ({ 'last-modified': lastModified, 'x-camera-role': role, 'x-camera-name': name })[h.toLowerCase()] || null },
  blob: () => Promise.resolve({ size: 48213, type: 'image/jpeg' }) });
const camUrl = /nhrc-camera\./;

test('camera: the caption says when the photo was TAKEN, from the Worker\'s Last-Modified', async () => {
  const t = etDate('2026-10-03', 7, 42).getTime();
  const taken = new Date(etDate('2026-10-03', 7, 30).getTime()).toUTCString();
  const net = fakeNet([[camUrl, () => frameReply(taken)]]);
  const { site, els } = loadSite(t, net.fetch, { Image: imageThat(() => true) });
  await site.loadCameraSnapshot();
  const note = els['camera-note'].textContent;
  assert.ok(/taken 7:30(\u202f| )AM EDT \(12 min ago\)/.test(note), note);
  assert.ok(!/60 min/.test(note), 'no more "up to 60 min older" promise');
  assert.ok(/^blob:fake-/.test(els['camera-img'].src), 'shown from the fetched bytes');
  assert.strictEqual(els['camera-card'].style.display, '');
});

test('camera: an old photo says how old - the Worker serves up to 130 minutes', async () => {
  const t = etDate('2026-10-03', 17, 5).getTime();
  const taken = new Date(etDate('2026-10-03', 15, 0).getTime()).toUTCString();
  const { site, els } = loadSite(t, fakeNet([[camUrl, () => frameReply(taken)]]).fetch, { Image: imageThat(() => true) });
  await site.loadCameraSnapshot();
  assert.ok(/taken 3:00(\u202f| )PM EDT \(2 h 5 min ago\)/.test(els['camera-note'].textContent), els['camera-note'].textContent);
});

test('camera: if the fetch route fails, the plain image route still shows the photo, with an honest bound', async () => {
  const t = etDate('2026-10-03', 8, 0).getTime();
  const net = fakeNet([[camUrl, () => Promise.reject(new TypeError('CORS'))]]);
  const { site, els } = loadSite(t, net.fetch, { Image: imageThat((src) => /^https:/.test(src)) });
  await site.loadCameraSnapshot();
  assert.ok(/^https:\/\/nhrc-camera\./.test(els['camera-img'].src), 'the plain URL, cache-busted');
  assert.ok(/[?&]_=\d+$/.test(els['camera-img'].src));
  assert.ok(/can be up to 2 hours older/.test(els['camera-note'].textContent), els['camera-note'].textContent);
});

test('camera: no photo explains itself - at night the backup is asleep by design, by day it is a fault', async () => {
  const msg = async (h, m) => {
    const { site, els } = loadSite(etDate('2026-10-03', h, m).getTime(),
      fakeNet([[camUrl, () => reply({}, 404)]]).fetch);
    await site.loadCameraSnapshot();
    assert.strictEqual(els['camera-img__parent'].style.display, 'none', 'no broken image');
    assert.strictEqual(els['camera-card'].style.display, '', 'but the card stays');
    assert.strictEqual(els['camera-badge'].style.display, 'none');
    return els['camera-note'].textContent;
  };
  for (const [h, m] of [[0, 30], [4, 59], [16, 0], [23, 30]]) {
    const t = await msg(h, m);
    assert.ok(/dock camera is not responding, and the backup camera only runs 5am–4pm/.test(t), `${h}:${m} ${t}`);
  }
  for (const [h, m] of [[5, 0], [9, 0], [15, 59]]) {
    const t = await msg(h, m);
    assert.ok(/the boathouse cameras could not be reached/.test(t), `${h}:${m} ${t}`);
  }
  assert.ok(/water temperature, river level and weather on this page are unaffected/.test(await msg(12, 0)));
});

test('camera: the dock camera\'s photo is captioned as the dock\'s, with no badge', async () => {
  const t = etDate('2026-10-03', 2, 20).getTime();   // around the clock: a 2 AM photo is normal
  const taken = new Date(etDate('2026-10-03', 2, 15).getTime()).toUTCString();
  const { site, els } = loadSite(t, fakeNet([[camUrl, () => frameReply(taken, 'primary', 'Dock Wired')]]).fetch,
    { Image: imageThat(() => true) });
  await site.loadCameraSnapshot();
  assert.ok(/^View from the dock camera, taken 2:15(\u202f| )AM EDT \(5 min ago\)\.$/.test(els['camera-note'].textContent),
    els['camera-note'].textContent);
  assert.strictEqual(els['camera-badge'].style.display, 'none');
});

test('camera: a backup photo is labelled as the backup - on the photo and in the caption', async () => {
  let t = etDate('2026-10-03', 9, 20).getTime(), role = 'backup';
  const net = fakeNet([[camUrl, () => frameReply(new Date(t - 5 * 60000).toUTCString(), role, role === 'backup' ? 'Downstream Lot' : 'Dock Wired')]]);
  const { site, els } = loadSite(() => t, net.fetch, { Image: imageThat(() => true) });
  await site.loadCameraSnapshot();
  const note = els['camera-note'].textContent;
  assert.ok(/^Backup view from the Downstream Lot camera, taken 9:15(\u202f| )AM EDT \(5 min ago\) — the dock camera is not responding\.$/.test(note), note);
  assert.strictEqual(els['camera-badge'].style.display, '', 'the badge is shown');
  assert.strictEqual(els['camera-badge'].textContent, 'Backup view — Downstream Lot');
  // The dock camera answers again: the badge goes.
  role = 'primary'; t += 15 * 60000;
  await site.loadCameraSnapshot();
  assert.strictEqual(els['camera-badge'].style.display, 'none');
  assert.ok(/^View from the dock camera/.test(els['camera-note'].textContent));
});

test('camera: an unknown or missing role is never presented as the dock camera', async () => {
  for (const role of [null, '', 'admin']) {
    const t = etDate('2026-10-03', 9, 20).getTime();
    const { site, els } = loadSite(t, fakeNet([[camUrl, () => frameReply(new Date(t).toUTCString(), role, 'X')]]).fetch,
      { Image: imageThat(() => true) });
    await site.loadCameraSnapshot();
    assert.ok(/^View from the boathouse camera, taken/.test(els['camera-note'].textContent), `${role}: ${els['camera-note'].textContent}`);
    assert.strictEqual(els['camera-badge'].style.display, 'none');
  }
});

test('camera: the title states the around-the-clock cadence, and no daylight window', () => {
  const { site, els } = loadSite(Date.now());
  site.loadCameraSnapshot();
  assert.strictEqual(els['camera-title'].textContent, 'Boathouse Camera — Still Image, Updates every 15 min');
  const html = fsT.readFileSync(INDEX_PATH, 'utf8');
  assert.ok(!/paused overnight|first photo of the day|returns at 5:00/.test(html), 'no leftovers from the daylight-only camera');
});

test('camera: what the page says about the Pi matches the Pi\'s own defaults', () => {
  // The page describes the Pi's timetable in constants it cannot read from the
  // Pi. In October 2026 the two drifted: the page said "every 5 min" while the
  // Pi ran every 15. Tie them to the service's defaults.
  const html = fsT.readFileSync(INDEX_PATH, 'utf8');
  const svc = fsT.readFileSync(path.join(__dirname, '..', 'camera', 'snapshot_service.js'), 'utf8');
  const piMinutes = Number(/CAMERA_INTERVAL_MINUTES \|\| (\d+)\)/.exec(svc)[1]);
  const label = /const CAMERA_CADENCE_LABEL = 'every (\d+) min';/.exec(html);
  assert.ok(label, 'CAMERA_CADENCE_LABEL not found');
  assert.strictEqual(Number(label[1]), piMinutes, `page says every ${label[1]} min, the Pi's default is ${piMinutes}`);
  const piStart = Number(/BACKUP_ACTIVE_START_HOUR, (\d+)\)/.exec(svc)[1]);
  const piEnd = Number(/BACKUP_ACTIVE_END_HOUR, (\d+)\)/.exec(svc)[1]);
  assert.strictEqual(Number(/const CAMERA_BACKUP_START_HOUR = (\d+);/.exec(html)[1]), piStart);
  assert.strictEqual(Number(/const CAMERA_BACKUP_END_HOUR = (\d+);/.exec(html)[1]), piEnd);
});

// A camera Worker whose photo changes when the test says so; HEAD and GET
// requests are counted separately.
function cameraWorker(clock) {
  const w = { photoAt: clock() - 60000, role: 'primary', status: 200, heads: 0, gets: 0, headFails: false };
  w.route = [camUrl, (url, opts) => {
    const head = opts && opts.method === 'HEAD';
    if (head) { w.heads++; if (w.headFails) return Promise.reject(new TypeError('CORS')); }
    else w.gets++;
    if (w.status !== 200) return reply({}, w.status);
    return frameReply(new Date(w.photoAt).toUTCString(), w.role, w.role === 'backup' ? 'Downstream Lot' : 'Dock Wired');
  }];
  return w;
}

test('camera: every minute the page asks for a newer photo, and downloads only a changed one', async () => {
  let t = etDate('2026-10-03', 9, 0, ).getTime() + 30000;
  const w = cameraWorker(() => t);
  w.photoAt = etDate('2026-10-03', 9, 0).getTime();
  // With AbortController, as in every browser: the request deadline path is
  // the one that must still send HEAD.
  const { site, els } = loadSite(() => t, fakeNet([w.route]).fetch, { Image: imageThat(() => true), AbortController });
  await site.loadCameraSnapshot();
  assert.deepStrictEqual([w.gets, w.heads], [1, 0]);
  assert.ok(/taken 9:00(\u202f| )AM EDT \(1 min ago\)/.test(els['camera-note'].textContent), els['camera-note'].textContent);
  // Forty-five minutes, a check each minute, a new photo every fifteen.
  for (let minute = 1; minute <= 45; minute++) {
    t += 60000;
    if (minute % 15 === 0) w.photoAt = t - 20000;   // the Pi uploads a little after each slot
    await site.checkCameraForNewPhoto();
  }
  assert.strictEqual(w.heads, 45, 'one small check a minute');
  assert.strictEqual(w.gets, 1 + 3, 'the photo itself only when it changed');
  assert.ok(/\(0 min ago\)|just now/.test(els['camera-note'].textContent), els['camera-note'].textContent);
  // A minute later, with no new photo, only the caption's age moves on.
  t += 60000;
  await site.checkCameraForNewPhoto();
  assert.strictEqual(w.gets, 4);
  assert.ok(/\(1 min ago\)/.test(els['camera-note'].textContent), els['camera-note'].textContent);
});

test('camera: the switch to the backup reaches the page at the next check', async () => {
  let t = etDate('2026-10-03', 9, 30).getTime();
  const w = cameraWorker(() => t);
  const { site, els } = loadSite(() => t, fakeNet([w.route]).fetch, { Image: imageThat(() => true) });
  await site.loadCameraSnapshot();
  assert.strictEqual(els['camera-badge'].style.display, 'none');
  w.role = 'backup'; w.photoAt = t + 30000; t += 60000;
  await site.checkCameraForNewPhoto();
  assert.strictEqual(els['camera-badge'].style.display, '', 'badge shown within the minute');
  assert.ok(/^Backup view from the Downstream Lot camera/.test(els['camera-note'].textContent));
});

test('camera: a photo going stale is noticed at the next check, and its return too', async () => {
  let t = etDate('2026-10-03', 12, 0).getTime();
  const w = cameraWorker(() => t);
  // The plain image route gets the same answer from the Worker as fetch does.
  const { site, els } = loadSite(() => t, fakeNet([w.route]).fetch, { Image: imageThat((src) => /^blob:/.test(src) || w.status === 200) });
  await site.loadCameraSnapshot();
  w.status = 404; t += 60000;
  await site.checkCameraForNewPhoto();
  assert.ok(/could not be reached/.test(els['camera-note'].textContent), els['camera-note'].textContent);
  const gets = w.gets;
  t += 60000;
  await site.checkCameraForNewPhoto();
  assert.strictEqual(w.gets, gets, 'still stale: nothing to download');
  w.status = 200; w.photoAt = t; t += 60000;
  await site.checkCameraForNewPhoto();
  assert.ok(/^View from the dock camera/.test(els['camera-note'].textContent), 'back as soon as there is a photo');
});

test('camera: with an older Worker that cannot be asked, the photo still refreshes every 5 minutes', async () => {
  let t = etDate('2026-10-03', 12, 0).getTime();
  const w = cameraWorker(() => t);
  w.headFails = true;
  const { site } = loadSite(() => t, fakeNet([w.route]).fetch, { Image: imageThat(() => true) });
  await site.loadCameraSnapshot();
  for (let minute = 1; minute <= 10; minute++) { t += 60000; await site.checkCameraForNewPhoto(); }
  assert.strictEqual(w.gets, 3, 'at load, then after 5 and 10 minutes');
});

test('camera: the page runs the check every minute (not a full download every 5)', () => {
  const intervals = [];
  const { site, els } = loadSite(Date.now(), () => new Promise(() => {}),
    { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; } });
  els.__fire('window', 'DOMContentLoaded');
  const cam = intervals.filter(i => i.fn === site.checkCameraForNewPhoto);
  assert.deepStrictEqual(cam.map(i => i.ms), [60000]);
  assert.ok(!intervals.some(i => i.fn && i.fn.name === 'loadCameraSnapshot'), 'no blind 5-minute re-download');
});

test('camera: each new photo releases the previous one\'s memory', async () => {
  let t = etDate('2026-10-03', 8, 0).getTime();
  const { site, els } = loadSite(() => t, fakeNet([[camUrl, () => frameReply(new Date(t - 60000).toUTCString())]]).fetch,
    { Image: imageThat(() => true) });
  for (let i = 0; i < 5; i++) { await site.loadCameraSnapshot(); t += 5 * 60000; }
  assert.strictEqual(els.__blobs.made, 5);
  assert.strictEqual(els.__blobs.live.size, 1, 'only the photo on screen is kept');
});

test('camera: a photo that fails to decode is released too, and the card says why', async () => {
  const t = etDate('2026-10-03', 9, 0).getTime();
  const { site, els } = loadSite(t, fakeNet([[camUrl, () => frameReply(new Date(t).toUTCString())]]).fetch,
    { Image: imageThat(() => false) });
  await site.loadCameraSnapshot();
  assert.strictEqual(els.__blobs.live.size, 0);
  assert.ok(/could not be reached/.test(els['camera-note'].textContent));
});

test('camera: an image that never settles cannot block later refreshes', async () => {
  const timers = [];
  const net = fakeNet([[camUrl, () => frameReply(new Date().toUTCString())]]);
  const { site } = loadSite(etDate('2026-10-03', 9, 0).getTime(), net.fetch,
    { Image: function () { this.src = ''; }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return 1; } });
  const p = site.loadCameraSnapshot();
  await settle();
  const safety = timers.find(x => x.ms === 30000);
  assert.ok(safety, 'a 30-second safety timer');
  safety.fn();
  await p;
  site.loadCameraSnapshot();
  await settle();
  assert.strictEqual(net.count(camUrl), 2, 'the next refresh runs');
});

// ═══════════════════════════════════════════════════════════════════════════
section('13e. Safety Committee manual zone setting (ZONE_OVERRIDE)');
// ═══════════════════════════════════════════════════════════════════════════
//
// Dormant today (null), but the committee can set it any morning; it must
// work, read honestly, and survive a typo.

const withOverride = (v) => (src) => {
  const out = src.replace('const ZONE_OVERRIDE = null;', `const ZONE_OVERRIDE = ${JSON.stringify(v)};`);
  assert.notStrictEqual(out, src, 'ZONE_OVERRIDE anchor not found');
  return out;
};
function overrideSite(v, tempF = 72) {
  const r = loadSite(Date.now(), undefined, { transform: withOverride(v) });
  r.site.state.allHistory = historyAtTemp(tempF);
  r.site.state.riverLevel = 3;
  r.site.renderRowingStatus(tempF);
  return r.els;
}

test('override: each zone is stated as set by the committee, with that zone\'s rules', () => {
  const expect = {
    winter: [/WINTER ROWING in effect \(set by the Safety Committee\)/, /Eight Oar Rule:/],
    fourOar: [/FOUR OAR RULE in effect \(set by the Safety Committee\)/, /Four Oar Rule:/],
    coldWater: [/COLD WATER restrictions apply \(set by the Safety Committee\)/, /Tier 1 may row 4\+/],
    normal: [/No temperature restrictions \(set by the Safety Committee\)/, /Buddy Boat/],
  };
  for (const [zone, [ruleRe, notesRe]] of Object.entries(expect)) {
    const els = overrideSite(zone);
    const rule = els['rule-banner'].innerHTML, notes = els['rowing-notes'].innerHTML;
    assert.ok(ruleRe.test(rule), `${zone}: ${rule}`);
    assert.ok(!/awaiting|3-day confirmed/.test(rule), `${zone}: a manual setting is not a confirmation: ${rule}`);
    assert.ok(notesRe.test(notes), `${zone}: the zone's rules must still be shown`);
    assert.ok(/Safety Committee Notice/.test(notes), `${zone}: notice`);
    assert.ok(!GO_AHEAD.test(rule + notes), `${zone}: go-ahead wording: ${(rule + notes).match(GO_AHEAD)}`);
    assert.ok(!/Normal conditions/i.test(notes), `${zone}: "Normal conditions" is banned wording`);
  }
});

test('override: the tiers follow the set zone, and river restrictions still apply on top', () => {
  const r = loadSite(Date.now(), undefined, { transform: withOverride('normal') });
  r.site.state.allHistory = historyAtTemp(45);
  r.site.state.riverLevel = 10.5;
  r.site.renderRowingStatus(45);   // 45F would be Four Oar automatically
  const grid = r.els['tiers-grid'].innerHTML;
  const status = (tier, boat) => {
    const block = grid.split('tier-card').filter(b => b.includes(tier))[0];
    return (block.match(new RegExp(boat.replace(/[+/]/g, '\\$&') + '</span>\\s*<span class="boat-status (\\w+-\\w+)"')) || [])[1];
  };
  assert.strictEqual(status('Tier 1', '1x / 2-'), 'bs-no', 'river at 10.5 ft still restricts singles');
  assert.strictEqual(status('Tier 1', '4x / 8+'), 'bs-go', 'the override, not 45F, decides the temperature rule');
  assert.ok(/River-level restrictions still apply/.test(r.els['rowing-notes'].innerHTML));
});

test('override: a typo cannot break the page - it is ignored, and the card says so', () => {
  for (const bad of ['cold', 'Winter', 'four oar', '<b>x</b>', 42]) {
    let els;
    assert.doesNotThrow(() => { els = overrideSite(bad, 72); }, String(bad));
    assert.ok(/No temperature restrictions \(water > 60°F, 3-day confirmed\)/.test(els['rule-banner'].innerHTML),
      `${bad}: automatic rules: ${els['rule-banner'].innerHTML}`);
    assert.ok(/is not recognised/.test(els['rowing-notes'].innerHTML), `${bad}: the mistake is visible`);
    assert.ok(!/<b>x<\/b>/.test(els['rowing-notes'].innerHTML), 'and cannot inject markup');
  }
});

test('override: the email labels it too, and gives the same tiers', () => {
  const tmp = path.join(require('os').tmpdir(), 'nhrc_override_index.html');
  const html = fsT.readFileSync(INDEX_PATH, 'utf8');
  for (const zone of ['winter', 'fourOar', 'coldWater', 'normal']) {
    fsT.writeFileSync(tmp, html.replace('const ZONE_OVERRIDE = null;', `const ZONE_OVERRIDE = '${zone}';`));
    const L = M.loadSiteLogic(tmp);
    const d = M.computeDigest(L, { raw: makeRaw(72), history: historyAtTemp(72) },
      { level: 3, isEstimate: false, failed: false, stale: false, ageMs: 0, lastObsTs: Date.now() }, { available: false }, new Date());
    assert.strictEqual(d.zone, zone);
    assert.ok(/\(set by the Safety Committee\)$/.test(d.zoneLabel), d.zoneLabel);
    assert.deepStrictEqual(d.rows.map(r => r.boats.map(b => b.status)),
      L.ZONE_TIERS[zone].map(t => t.boats.map(b => b.s === 'go' ? 'go' : b.s)), `${zone}: tiers`);
  }
  fsT.unlinkSync(tmp);
});

// ═══════════════════════════════════════════════════════════════════════════
section('14. Fog network loader');
// ═══════════════════════════════════════════════════════════════════════════

test('loadFogInputs: both sources fetched, NWS gets a User-Agent, one failure does not hide the other', async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), headers: opts.headers || {} });
    if (/api\.weather\.gov/.test(url)) throw new Error('NWS down');
    return { ok: true, json: async () => FOG_FX.likely_2026_10_02.response };
  };
  try {
    const r = await M.loadFogInputs(logic);
    assert.strictEqual(calls.length, 2);
    const nws = calls.find(c => /api\.weather\.gov/.test(c.url));
    assert.ok(nws && /roworno\.com/.test(nws.headers['User-Agent']), 'NWS rejects requests without a User-Agent');
    assert.ok(!/@/.test(nws.headers['User-Agent']), 'no personal address in the User-Agent');
    assert.ok(calls.some(c => c.url === logic.fogOutlookUrl(M.BOATHOUSE.lat, M.BOATHOUSE.lon)));
    assert.strictEqual(r.alerts, null, 'a failed source comes back null');
    assert.ok(r.response && r.response.hourly, 'the other source still arrives');
  } finally {
    global.fetch = realFetch;
  }
});

test('loadFogInputs: total network failure yields nulls, which assess as "unknown"', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    const r = await M.loadFogInputs(logic);
    assert.deepStrictEqual(r, { response: null, alerts: null });
    assert.strictEqual(logic.assessFogRisk(r.response, '2026-10-02', 65, r.alerts).level, 'unknown');
  } finally {
    global.fetch = realFetch;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Report only once every async test has actually finished.
asyncChain.then(() => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach(f => console.log(`  - ${f.name}\n    ${f.err.stack.split('\n').slice(0,3).join('\n    ')}`));
    process.exit(1);
  }
});
