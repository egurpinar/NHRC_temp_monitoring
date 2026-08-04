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

test('renders every tier and all four boat columns', () => {
  const html = M.renderEmailHtml(sampleDigest());
  for (const t of ['Tier 1 — Novice', 'Tier 2 — Intermediate', 'Tier 3 — Senior']) {
    assert.ok(html.includes(t), `missing ${t}`);
  }
  for (const c of ['1x / 2-', '2x', '4+ / 4-', '4x / 8+']) {
    assert.ok(html.includes(c), `missing column ${c}`);
  }
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

test('subject line reflects zone and temperature', () => {
  const d = sampleDigest();
  const s = M.renderSubject(d);
  assert.ok(s.includes('NHRC'), s);
  assert.ok(s.includes('72.4'), s);
  assert.ok(/Normal conditions|Cold Water|Four Oar|Winter/.test(s), s);
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
