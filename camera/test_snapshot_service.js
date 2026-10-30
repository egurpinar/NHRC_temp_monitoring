#!/usr/bin/env node
/**
 * Tests for the camera snapshot service.
 *
 * Covers everything that does not require Ring credentials: configuration
 * validation, the active-hours window, atomic token persistence, upload
 * behaviour, and retry logic. The Ring calls themselves are stubbed.
 *
 * Run: node camera/test_snapshot_service.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./snapshot_service.js');

// A private temporary folder for this run, so checks for left-behind files are
// not confused by another test run on the same machine.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-camtest-'));

let passed = 0, failed = 0;
const failures = [];
// Async tests run one after another, each with a deadline, and the summary
// waits for all of them. It used to wait a fixed 200 ms: a slow async test
// would report after the exit code had already been decided.
let asyncChain = Promise.resolve();
const ASYNC_DEADLINE_MS = 30000;
// The whole run takes a few minutes (real ffmpeg, real service processes).
// TEST_SHARD=2/3 runs every third async test, starting with the second (the
// quick synchronous tests run in every shard); TEST_ONLY=<regex> runs the
// tests whose names match.
const SHARD = /^(\d+)\/(\d+)$/.exec(process.env.TEST_SHARD || '');
const ONLY = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
let asyncIndex = 0;

function test(name, fn, deadlineMs = ASYNC_DEADLINE_MS) {
  if (ONLY && !ONLY.test(name)) return;
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    const index = asyncIndex++;
    if (SHARD && index % Number(SHARD[2]) !== Number(SHARD[1]) - 1) return;
    asyncChain = asyncChain.then(async () => {
      let timer;
      // A test that times out while it has console output captured must not
      // swallow everything printed after it - the summary included.
      const ol = console.log, oe = console.error;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { console.log = ol; console.error = oe; reject(new Error(`timed out after ${deadlineMs} ms`)); }, deadlineMs);
      });
      const t0 = Date.now();
      const took = () => { const s = (Date.now() - t0) / 1000; return s >= 3 ? `  (${s.toFixed(0)} s)` : ''; };
      try { await Promise.race([fn(), deadline]); passed++; console.log(`  PASS  ${name}${took()}`); }
      catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
      finally { clearTimeout(timer); }
    });
    return;
  }
  try {
    const r = fn();
    if (r && typeof r.then === 'function') throw new Error('returns a promise but is not declared async - it would not be awaited');
    passed++; console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++; failures.push([name, e]);
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

const baseCfg = {
  tokenFile: '/tmp/nhrc-test-token',
  cameraName: '',
  uploadUrl: 'https://cam.roworno.com/latest.jpg',
  // A realistic value: 64 hex characters, as `openssl rand -hex 32` produces.
  // This was once 'a-sufficiently-long-secret', which the placeholder-prose
  // guard now correctly rejects — the fixture itself was unrealistic.
  uploadSecret: '9f3c1e7d2b8a4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d',
  intervalMinutes: 15,
  slowAfterHour: 10,
  slowIntervalMinutes: 30,
  activeStartHour: 5,
  activeEndHour: 21,
  timeZone: 'America/New_York',
  retries: 3,
  retryDelaySeconds: 0,
};

// ═══════════════════════════════════════════════════════════════════════════
section('1. Configuration validation');
// ═══════════════════════════════════════════════════════════════════════════

test('a valid configuration reports no problems', () => {
  assert.deepStrictEqual(S.validateConfig(baseCfg), []);
});

test('missing upload URL and secret are caught', () => {
  const p = S.validateConfig({ ...baseCfg, uploadUrl: '', uploadSecret: '' });
  assert.ok(p.some(x => /CAMERA_UPLOAD_URL/.test(x)));
  assert.ok(p.some(x => /CAMERA_UPLOAD_SECRET/.test(x)));
});

test('a plaintext http upload URL is rejected', () => {
  // The shared secret travels in a header; over http it would be readable.
  const p = S.validateConfig({ ...baseCfg, uploadUrl: 'http://cam.roworno.com/latest.jpg' });
  assert.ok(p.some(x => /https/.test(x)), p.join('; '));
});

test('an unedited placeholder upload URL is rejected', () => {
  // Regression: --check once reported "Configuration looks valid" for the
  // literal setup-guide placeholder, so the real failure only appeared later as
  // an opaque DNS error mid-upload.
  for (const u of ['https://nhrc-camera.YOUR-SUBDOMAIN.workers.dev/latest.jpg',
                   'https://cam.example.com/latest.jpg',
                   'https://CHANGEME/latest.jpg']) {
    const p = S.validateConfig({ ...baseCfg, uploadUrl: u });
    assert.ok(p.some(x => /placeholder/.test(x)), `accepted placeholder URL: ${u}`);
  }
  // The real URL must still pass.
  assert.deepStrictEqual(S.validateConfig({ ...baseCfg, uploadUrl: 'https://cam.roworno.com/latest.jpg' }), []);
});

test('a short upload secret is rejected', () => {
  const p = S.validateConfig({ ...baseCfg, uploadSecret: 'short' });
  assert.ok(p.some(x => /too short/.test(x)));
});

test('placeholder prose is rejected as a secret', () => {
  // Regression: the Pi ran for several cycles with the literal text
  // "the-secret-i-generated-earlier" as its secret. It passed the length check,
  // so the only symptom was an HTTP 401 — identical to a missing Worker binding.
  for (const s of ['the-same-secret-as-the-worker',
                   'the-secret-i-generated-earlier',
                   'paste-the-value-from-cloudflare']) {
    const p = S.validateConfig({ ...baseCfg, uploadSecret: s });
    assert.ok(p.some(x => /placeholder/.test(x)), `accepted prose secret: ${s}`);
  }
});

test('a real random secret is not mistaken for prose', () => {
  // The guard must not reject legitimate values. Hex, base64 and a two-word
  // hyphenated value all have to survive.
  const real = [
    'a'.repeat(64),
    require('crypto').randomBytes(32).toString('hex'),
    require('crypto').randomBytes(24).toString('base64'),
    require('crypto').randomBytes(24).toString('base64url'),
    'correct-horsebatterystaple',   // two words: not the prose pattern
  ];
  for (const s of real) {
    assert.deepStrictEqual(S.validateConfig({ ...baseCfg, uploadSecret: s }), [],
      `rejected a valid secret: ${s.slice(0, 8)}...`);
  }
});

test('a secret with whitespace is rejected', () => {
  // A trailing newline or space survives a copy-paste and is invisible in a
  // terminal, but changes the bytes and produces the same opaque 401.
  for (const s of ['abcdefghijklmnop qrstuvwxyz012345', 'abcdefghijklmnopqrstuvwxyz\t0123']) {
    assert.ok(S.validateConfig({ ...baseCfg, uploadSecret: s })
      .some(x => /whitespace/.test(x)), `accepted secret with whitespace: ${JSON.stringify(s)}`);
  }
});

test('an interval below 5 minutes is rejected', () => {
  // Ring throttles battery cameras to roughly one snapshot per 10 minutes, and
  // every capture costs battery on a solar-topped camera.
  assert.ok(S.validateConfig({ ...baseCfg, intervalMinutes: 1 }).length > 0);
  assert.deepStrictEqual(S.validateConfig({ ...baseCfg, intervalMinutes: 15 }), []);
});

test('out-of-range active hours are rejected', () => {
  assert.ok(S.validateConfig({ ...baseCfg, activeStartHour: 25 }).length > 0);
  assert.ok(S.validateConfig({ ...baseCfg, activeEndHour: -1 }).length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. Active-hours window');
// ═══════════════════════════════════════════════════════════════════════════

// 12:00 UTC is 08:00 ET in summer, 07:00 ET in winter.
const at = (h) => new Date(Date.UTC(2026, 6, 15, h, 0, 0)); // July, EDT (UTC-4)

test('daytime is inside the window, small hours are outside', () => {
  assert.strictEqual(S.isWithinActiveHours(at(12), baseCfg), true, '08:00 ET');
  assert.strictEqual(S.isWithinActiveHours(at(20), baseCfg), true, '16:00 ET');
  assert.strictEqual(S.isWithinActiveHours(at(6), baseCfg), false, '02:00 ET');
});

test('the window is evaluated in the boathouse timezone, not UTC', () => {
  // 03:00 UTC is 23:00 the previous day in New York — outside a 05:00-21:00
  // window. A naive UTC check would call it 03:00 and also say outside, so use
  // a case where the two genuinely disagree: 23:00 UTC is 19:00 ET (inside).
  const d = new Date(Date.UTC(2026, 6, 15, 23, 0, 0));
  assert.strictEqual(d.getUTCHours(), 23, 'sanity: UTC hour is 23');
  assert.strictEqual(S.isWithinActiveHours(d, baseCfg), true,
    '19:00 ET is inside the window even though UTC says 23:00');
});

test('setting both hours to 0 disables the window', () => {
  const cfg = { ...baseCfg, activeStartHour: 0, activeEndHour: 0 };
  for (const h of [0, 6, 12, 23]) {
    assert.strictEqual(S.isWithinActiveHours(at(h), cfg), true, `hour ${h}`);
  }
});

test('a half-hour start is honoured to the minute', () => {
  // "4:30" must not round down to 4:00 — that would capture 30 minutes early,
  // every day, on a battery camera.
  const cfg = { ...baseCfg, activeStartHour: S.parseHourSetting('4:30'), activeEndHour: 19 };
  assert.strictEqual(cfg.activeStartHour, 4.5, 'parsed value');
  const et = (h, m) => new Date(Date.UTC(2026, 6, 15, h, m, 0)); // July = EDT (UTC-4)
  assert.strictEqual(S.isWithinActiveHours(et(8, 29), cfg), false, '04:29 ET');
  assert.strictEqual(S.isWithinActiveHours(et(8, 30), cfg), true,  '04:30 ET');
  assert.strictEqual(S.isWithinActiveHours(et(22, 59), cfg), true, '18:59 ET');
  assert.strictEqual(S.isWithinActiveHours(et(23, 0), cfg), false, '19:00 ET');
});

test('hour settings accept both "19" and "4:30"', () => {
  assert.strictEqual(S.parseHourSetting('19'), 19);
  assert.strictEqual(S.parseHourSetting('4:30'), 4.5);
  assert.strictEqual(S.parseHourSetting('04:45'), 4.75);
  assert.strictEqual(S.parseHourSetting(21), 21);
  assert.strictEqual(S.parseHourSetting('', 4.5), 4.5, 'empty falls back');
  assert.strictEqual(S.parseHourSetting(undefined, 7), 7, 'unset falls back');
  assert.ok(Number.isNaN(S.parseHourSetting('half past four')), 'garbage is NaN, not 0');
  // NaN must be rejected by validation rather than silently becoming a window.
  assert.ok(S.validateConfig({ ...baseCfg, activeStartHour: NaN }).length > 0);
});

test('fractional hours render readably in --check', () => {
  assert.strictEqual(S.formatHourSetting(4.5), '4:30');
  assert.strictEqual(S.formatHourSetting(19), '19:00');
  assert.strictEqual(S.formatHourSetting(4.75), '4:45');
});

test('a window wrapping midnight works', () => {
  const cfg = { ...baseCfg, activeStartHour: 22, activeEndHour: 4 };
  assert.strictEqual(S.isWithinActiveHours(at(3), cfg), true, '23:00 ET');
  assert.strictEqual(S.isWithinActiveHours(at(16), cfg), false, '12:00 ET');
});

// ═══════════════════════════════════════════════════════════════════════════
section('2b. Two-speed capture schedule');
// ═══════════════════════════════════════════════════════════════════════════

const schedCfg = { ...baseCfg, activeStartHour: 4, activeEndHour: 19,
                   intervalMinutes: 15, slowAfterHour: 10, slowIntervalMinutes: 30 };
// 2026-08-15 is EDT (UTC-4), so ET hour = UTC hour - 4.
const etAt = (h, m = 0) => new Date(Date.UTC(2026, 7, 15, h + 4, m, 0));

test('mornings capture every 15 minutes', () => {
  for (const [h, m] of [[4, 0], [6, 30], [9, 59]]) {
    assert.strictEqual(S.intervalForTime(etAt(h, m), schedCfg), 15, `${h}:${m}`);
  }
});

test('after 10am the interval drops to 30 minutes', () => {
  for (const [h, m] of [[10, 0], [12, 0], [18, 59]]) {
    assert.strictEqual(S.intervalForTime(etAt(h, m), schedCfg), 30, `${h}:${m}`);
  }
});

test('the switch happens exactly at 10:00, not 9:59', () => {
  assert.strictEqual(S.intervalForTime(etAt(9, 59), schedCfg), 15);
  assert.strictEqual(S.intervalForTime(etAt(10, 0), schedCfg), 30);
});

test('the rate is read in boathouse time, not UTC', () => {
  // 14:00 UTC is 10:00 ET in summer. A naive UTC read would call it 14:00 and
  // still say "slow", so use 13:00 UTC = 09:00 ET, where the two disagree.
  const d = new Date(Date.UTC(2026, 7, 15, 13, 0, 0));
  assert.strictEqual(d.getUTCHours(), 13, 'sanity');
  assert.strictEqual(S.intervalForTime(d, schedCfg), 15,
    '09:00 ET is still the fast rate even though UTC reads 13:00');
});

test('the rate follows DST rather than a fixed offset', () => {
  // In EST (UTC-5), 10:00 ET is 15:00 UTC. The same wall-clock hour must switch.
  const estNine = new Date(Date.UTC(2026, 0, 15, 14, 0, 0)); // 09:00 EST
  const estTen  = new Date(Date.UTC(2026, 0, 15, 15, 0, 0)); // 10:00 EST
  assert.strictEqual(S.intervalForTime(estNine, schedCfg), 15);
  assert.strictEqual(S.intervalForTime(estTen, schedCfg), 30);
});

test('the two-speed schedule can be turned off', () => {
  const off = { ...schedCfg, slowAfterHour: 4 }; // equal to window start
  for (const h of [4, 10, 18]) {
    assert.strictEqual(S.intervalForTime(etAt(h), off), 15, `hour ${h}`);
  }
});

test('a slow-after hour past the window close is rejected', () => {
  // It would silently never apply, leaving the fast rate running all day —
  // exactly the battery drain the setting exists to prevent.
  const p = S.validateConfig({ ...schedCfg, slowAfterHour: 20 });
  assert.ok(p.some(x => /never take effect/.test(x)), p.join('; '));
});

test('a nonsense slow interval is rejected', () => {
  assert.ok(S.validateConfig({ ...schedCfg, slowIntervalMinutes: 1 }).length > 0);
  assert.ok(S.validateConfig({ ...schedCfg, slowAfterHour: NaN }).length > 0);
});

test('the daily capture count matches the intended schedule', () => {
  // 4am-10am at 15 min = 24, 10am-7pm at 30 min = 18. Guards against an
  // off-by-one in the boundary that would quietly double the afternoon load.
  let n = 0;
  for (let m = 0; m < 1440; m++) {
    const d = new Date(Date.UTC(2026, 7, 15, 4, 0, 0) + m * 60000);
    if (!S.isWithinActiveHours(d, schedCfg)) continue;
    const iv = S.intervalForTime(d, schedCfg);
    const local = S.localHour(d, schedCfg);
    const mins = Math.round(local * 60);
    if (mins % iv === 0) n++;
  }
  assert.strictEqual(n, 42, `expected 42 captures a day, got ${n}`);
});

test('the schedule description reads correctly', () => {
  assert.strictEqual(S.describeSchedule(schedCfg),
    'Capturing every 15 min until 10:00, then every 30 min.');
  assert.strictEqual(S.describeSchedule({ ...schedCfg, slowAfterHour: 4 }),
    'Capturing every 15 min.');
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. Token persistence (the safety-critical part)');
// ═══════════════════════════════════════════════════════════════════════════

const tmpToken = path.join(os.tmpdir(), 'nhrc-token-test-' + process.pid);
const tokenCfg = { ...baseCfg, tokenFile: tmpToken };

test('a written token reads back exactly', () => {
  S.writeToken('token-abc-123', tokenCfg);
  assert.strictEqual(S.readToken(tokenCfg), 'token-abc-123');
});

test('a rotated token replaces the old one', () => {
  S.writeToken('first', tokenCfg);
  S.writeToken('second', tokenCfg);
  assert.strictEqual(S.readToken(tokenCfg), 'second');
});

test('the token file is not world-readable', () => {
  // It is as sensitive as the Ring account password.
  S.writeToken('secret-token', tokenCfg);
  const mode = fs.statSync(tmpToken).mode & 0o777;
  assert.strictEqual(mode & 0o077, 0,
    `token file mode ${mode.toString(8)} allows group/other access`);
});

test('writes are atomic — no temp file is left behind', () => {
  S.writeToken('atomic-check', tokenCfg);
  const leftovers = fs.readdirSync(path.dirname(tmpToken))
    .filter(f => f.startsWith('.' + path.basename(tmpToken)) && f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'temp file left behind');
});

test('a missing token file reads as null rather than throwing', () => {
  assert.strictEqual(S.readToken({ ...baseCfg, tokenFile: '/tmp/definitely-not-here-' + Date.now() }), null);
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. Upload');
// ═══════════════════════════════════════════════════════════════════════════

test('a successful upload sends the secret and the image', async () => {
  let seen = null;
  const fakeFetch = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200 }; };
  await S.uploadSnapshot(Buffer.from('jpegbytes'), baseCfg, fakeFetch);
  assert.strictEqual(seen.url, baseCfg.uploadUrl);
  assert.strictEqual(seen.opts.method, 'PUT');
  assert.strictEqual(seen.opts.headers.Authorization, `Bearer ${baseCfg.uploadSecret}`);
  assert.strictEqual(seen.opts.headers['Content-Type'], 'image/jpeg');
});

test('the upload survives a REAL fetch against a real server', async () => {
  // Every other upload test injects a fake fetch, which records headers without
  // validating them. This one uses the genuine global fetch against a loopback
  // server, so the request is really constructed and really transmitted.
  // NOTE: this does NOT by itself catch a manually-set Content-Length — Node 22
  // accepts one where Node 20 throws. The static check below is the guard for
  // that. What this test does cover is that the body arrives intact and the
  // auth and content-type headers survive a real round trip.
  const http = require('http');
  const received = {};
  const server = http.createServer((req, res) => {
    received.method = req.method;
    received.auth = req.headers.authorization;
    received.type = req.headers['content-type'];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.body = Buffer.concat(chunks);
      res.writeHead(200); res.end('OK');
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const payload = Buffer.from('\xFF\xD8\xFFhello-jpeg\xFF\xD9', 'binary');
    const cfg = { ...baseCfg, uploadUrl: `http://127.0.0.1:${port}/latest.jpg` };
    await S.uploadSnapshot(payload, cfg); // real global fetch, no stub
    assert.strictEqual(received.method, 'PUT');
    assert.strictEqual(received.auth, `Bearer ${cfg.uploadSecret}`);
    assert.strictEqual(received.type, 'image/jpeg');
    assert.strictEqual(received.body.length, payload.length, 'body truncated');
    assert.ok(received.body.equals(payload), 'body corrupted in transit');
  } finally {
    await new Promise(r => server.close(r));
  }
});

test('Content-Length is never set by hand', () => {
  // THIS is the load-bearing guard, not the live test above: whether undici
  // rejects a caller-supplied Content-Length depends on its version. Node 20 on
  // the Pi throws UND_ERR_INVALID_ARG; Node 22 accepts it silently. So a live
  // test can pass on the dev machine while the Pi fails, and did.
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const start = src.indexOf('async function uploadSnapshot');
  assert.ok(start > 0, 'uploadSnapshot not found — test needs updating');
  // End at the next top-level function so the slice cannot silently collapse.
  // An earlier version ended at the string "// Ring", which first occurs in a
  // config comment ABOVE this function: the slice came out empty and the
  // assertion passed against nothing. A vacuous test is worse than no test.
  const rest = src.slice(start + 1);
  const endRel = rest.search(/\n(?:async )?function /);
  const uploadFn = rest.slice(0, endRel === -1 ? rest.length : endRel);
  assert.ok(uploadFn.length > 200 && /fetchImpl\(/.test(uploadFn),
    `extracted uploadSnapshot body looks wrong (${uploadFn.length} chars)`);
  assert.ok(!/['"]Content-Length['"]\s*:/.test(uploadFn),
    'uploadSnapshot sets Content-Length; undici rejects it with UND_ERR_INVALID_ARG');
});

test('Ring status polling is explicitly disabled', () => {
  // The camera runs on battery and solar with very little margin, so it must be
  // contacted only when a snapshot is actually wanted. ring-client-api skips
  // polling when these are falsy, but relying on that default means a library
  // update could silently start regular traffic against a camera we are trying
  // hard not to wake.
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const start = src.indexOf('new RingApi(');
  assert.ok(start > 0, 'RingApi construction not found — test needs updating');
  const opts = src.slice(start, src.indexOf('})', start));
  assert.ok(/cameraStatusPollingSeconds:\s*0/.test(opts),
    'cameraStatusPollingSeconds must be explicitly 0');
  assert.ok(/locationModePollingSeconds:\s*0/.test(opts),
    'locationModePollingSeconds must be explicitly 0');
});

test('a transport failure names the real cause, not just "fetch failed"', async () => {
  // Node's fetch throws a bare "fetch failed" and buries the reason on .cause.
  // A log line that only says "fetch failed" cost a full debugging round trip.
  const inner = Object.assign(new Error('connect ENETUNREACH 2606:4700:3035::ac43:ba62:443'),
    { code: 'ENETUNREACH' });
  const outer = Object.assign(new Error('fetch failed'), { cause: inner });
  const fakeFetch = async () => { throw outer; };
  await assert.rejects(
    () => S.uploadSnapshot(Buffer.from('x'), baseCfg, fakeFetch),
    (e) => {
      assert.ok(/ENETUNREACH/.test(e.message), `cause not surfaced: ${e.message}`);
      assert.ok(/cam\.roworno\.com/.test(e.message), `host not named: ${e.message}`);
      return true;
    });
});

test('a nested AggregateError surfaces the per-address failures', async () => {
  // Multi-address connects (A + AAAA) fail as an AggregateError; the useful
  // detail is in .errors, which a plain .cause walk would miss.
  const agg = Object.assign(new AggregateError(
    [Object.assign(new Error('connect EHOSTUNREACH ipv6'), { code: 'EHOSTUNREACH' })],
    'all attempts failed'), {});
  const outer = Object.assign(new Error('fetch failed'), { cause: agg });
  assert.ok(/EHOSTUNREACH/.test(S.describeCause(outer)), S.describeCause(outer));
});

test('error messages name the host but never the secret', () => {
  // The upload secret sits next to the URL in config; a careless log leaks it.
  assert.strictEqual(S.hostOf('https://cam.roworno.com/latest.jpg'), 'cam.roworno.com');
  const msg = S.describeCause(Object.assign(new Error('fetch failed'),
    { cause: new Error('boom') }));
  assert.ok(!msg.includes(baseCfg.uploadSecret));
});

test('a rejected upload throws with the status', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });
  await assert.rejects(
    () => S.uploadSnapshot(Buffer.from('x'), baseCfg, fakeFetch),
    /401/);
});

// ═══════════════════════════════════════════════════════════════════════════
section('5. Capture retry');
// ═══════════════════════════════════════════════════════════════════════════

test('a snapshot that fails once then succeeds is retried', async () => {
  let calls = 0;
  const camera = { getSnapshot: async () => {
    calls++;
    if (calls === 1) throw new Error('camera is recording');
    return Buffer.from('image-data');
  }};
  const buf = await S.captureWithRetry(camera, { ...baseCfg, retryDelaySeconds: 0 });
  assert.strictEqual(calls, 2);
  assert.strictEqual(buf.toString(), 'image-data');
});

test('retries are bounded and the last error surfaces', async () => {
  let calls = 0;
  const camera = { getSnapshot: async () => { calls++; throw new Error('still recording'); } };
  await assert.rejects(
    () => S.captureWithRetry(camera, { ...baseCfg, retries: 3, retryDelaySeconds: 0 }),
    /still recording/);
  assert.strictEqual(calls, 3, 'should stop after the configured number of retries');
});

test('an empty snapshot buffer counts as a failure', async () => {
  // Ring can return an empty body rather than an error when a battery camera is
  // mid-recording; treating that as success would publish a broken image.
  const camera = { getSnapshot: async () => Buffer.alloc(0) };
  await assert.rejects(
    () => S.captureWithRetry(camera, { ...baseCfg, retries: 2, retryDelaySeconds: 0 }),
    /empty snapshot/);
});

// ═══════════════════════════════════════════════════════════════════════════
section('6. Cycle behaviour');
// ═══════════════════════════════════════════════════════════════════════════

// Every cycle test is hermetic: a fixed clock and a fake network. This test
// used to read the real clock, so between 5 and 6 AM it really captured and
// tried to upload to the real endpoint - and failed for lack of a network.
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0xFF, 0xD9]);
const prodCfg = { ...baseCfg, activeStartHour: 5, activeEndHour: 16,
                  intervalMinutes: 30, slowAfterHour: 10, slowIntervalMinutes: 60, retryDelaySeconds: 0 };
// A New York wall-clock time on a given date, whatever the offset that day.
function ny(ymd, h, m = 0, s = 0) {
  const [y, mo, d] = ymd.split('-').map(Number);
  for (const off of [4, 5]) {
    const t = new Date(Date.UTC(y, mo - 1, d, h + off, m, s));
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(t);
    const g = k => p.find(x => x.type === k).value;
    if (`${g('year')}-${g('month')}-${g('day')}` === ymd && +g('hour') === h && +g('minute') === m) return t;
  }
  throw new Error(`no such New York time ${ymd} ${h}:${m}`);
}
const nyClock = (t) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit',
  minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(t);

test('outside the window the camera is never woken and nothing is uploaded', async () => {
  let woken = 0, uploads = 0;
  const camera = { getSnapshot: async () => { woken++; return JPEG; } };
  const fakeFetch = async () => { uploads++; return { ok: true }; };
  for (const [h, m] of [[0, 0], [4, 59], [16, 0], [23, 59]]) {
    const sent = await S.runCycle(camera, prodCfg, ny('2026-08-15', h, m), fakeFetch);
    assert.strictEqual(sent, false, `${h}:${m}`);
  }
  assert.strictEqual(woken, 0, 'camera woken outside the window');
  assert.strictEqual(uploads, 0);
});

test('inside the window a cycle captures once and uploads that frame', async () => {
  const calls = [];
  const camera = { getSnapshot: async () => JPEG };
  const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  const sent = await S.runCycle(camera, prodCfg, ny('2026-08-15', 5, 0), fakeFetch);
  assert.strictEqual(sent, true);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, prodCfg.uploadUrl);
  assert.strictEqual(calls[0].opts.method, 'PUT');
  assert.ok(Buffer.compare(calls[0].opts.body, JPEG) === 0, 'the captured frame is what is uploaded');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6b. Capture timetable (fixed slots, no drift)');
// ═══════════════════════════════════════════════════════════════════════════
//
// The loop used to sleep a fixed interval AFTER each cycle, so every cycle's
// duration pushed the schedule later and the first frame of the day landed
// anywhere from 5:00 to 5:29. These run whole days on a fake clock.

// Runs the real scheduler from `from` to `to` on a fake clock. Each cycle
// "takes" cycleMs, advancing the clock as a real capture would.
async function simulate(cfg, from, to, { cycleMs = 20000, fail = () => false } = {}) {
  let t = from.getTime();
  const captures = [], sleeps = [];
  let pending = null;
  const tick = S.createScheduler(cfg, {
    now: () => new Date(t),
    setTimer: (fn, ms) => { pending = { fn, ms }; sleeps.push(ms); },
    cycle: async () => { captures.push(new Date(t)); t += cycleMs; if (fail(new Date(t))) throw new Error('camera busy'); },
  });
  await tick();
  while (pending && t + pending.ms <= to.getTime()) {
    const p = pending; pending = null;
    t += p.ms;
    await p.fn();
  }
  return { captures, sleeps };
}
const PROD_SLOTS = ['05:00', '05:30', '06:00', '06:30', '07:00', '07:30', '08:00', '08:30', '09:00', '09:30',
                    '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];
const hhmm = (d) => nyClock(d).slice(0, 5);

test('a whole day: captures at exactly the slot times, first frame at 5:00', async () => {
  const { captures } = await simulate(prodCfg, ny('2026-08-15', 0, 0), ny('2026-08-16', 0, 0));
  assert.deepStrictEqual(captures.map(hhmm), PROD_SLOTS);
  for (const c of captures) {
    const sec = Number(nyClock(c).slice(6, 8));
    assert.ok(sec <= 1, `capture at ${nyClock(c)} is not on the slot boundary`);
  }
});

test('slow captures do not push the timetable later (no drift)', async () => {
  // Three minutes per cycle - a capture that needed all its retries - every time.
  const { captures } = await simulate(prodCfg, ny('2026-08-15', 0, 0), ny('2026-08-18', 0, 0), { cycleMs: 3 * 60000 });
  assert.strictEqual(captures.length, 48, 'three days of 16');
  assert.deepStrictEqual(captures.slice(32).map(hhmm), PROD_SLOTS, 'day three is still on the slots');
});

test('daylight-saving days keep the same local timetable', async () => {
  for (const [day, next] of [['2026-03-08', '2026-03-09'], ['2026-11-01', '2026-11-02']]) {
    const { captures } = await simulate(prodCfg, ny(day, 0, 0), ny(next, 0, 0));
    assert.deepStrictEqual(captures.map(hhmm), PROD_SLOTS, day);
  }
});

test('the loop wakes at least every 30 minutes, so a clock change can never cost a morning', async () => {
  const { sleeps } = await simulate(prodCfg, ny('2026-08-15', 0, 0), ny('2026-08-17', 0, 0));
  assert.ok(Math.max(...sleeps) <= 30 * 60000 + 500, `longest sleep ${Math.max(...sleeps)} ms`);
  assert.ok(Math.min(...sleeps) >= 1000, 'and never spins');
});

test('a restart mid-slot captures straight away, then rejoins the timetable', async () => {
  const { captures } = await simulate(prodCfg, ny('2026-08-15', 7, 12), ny('2026-08-15', 9, 0));
  assert.deepStrictEqual(captures.map(hhmm), ['07:12', '07:30', '08:00', '08:30']);
});

test('a failed capture is not retried until the next slot', async () => {
  let r = await simulate(prodCfg, ny('2026-08-15', 4, 50), ny('2026-08-15', 6, 5), { fail: () => true });
  assert.deepStrictEqual(r.captures.map(hhmm), ['05:00', '05:30', '06:00'], 'one attempt per slot, failures included');
  // In the hourly afternoon the loop also wakes at the half hour (its 30-minute
  // cap); a failed slot must not be re-attempted then, draining the battery.
  r = await simulate(prodCfg, ny('2026-08-15', 10, 0), ny('2026-08-15', 12, 5), { fail: () => true });
  assert.deepStrictEqual(r.captures.map(hhmm), ['10:00', '11:00', '12:00']);
  assert.ok(r.sleeps.some(ms => ms <= 30 * 60000 + 500 && ms > 29 * 60000), 'sanity: it did wake at the half hour');
});

test('the window boundaries: 4:59:59 closed, 5:00:00 open, 15:59:59 open, 16:00:00 closed', () => {
  assert.strictEqual(S.captureSlot(ny('2026-08-15', 4, 59, 59), prodCfg), null);
  assert.strictEqual(S.captureSlot(ny('2026-08-15', 5, 0, 0), prodCfg).offsetSecs, 0);
  assert.strictEqual(S.captureSlot(ny('2026-08-15', 9, 59, 59), prodCfg).offsetSecs, 4.5 * 3600, '9:59 is in the 9:30 slot');
  assert.strictEqual(S.captureSlot(ny('2026-08-15', 10, 0, 0), prodCfg).offsetSecs, 5 * 3600, '10:00 starts the slow rate');
  assert.strictEqual(S.captureSlot(ny('2026-08-15', 15, 59, 59), prodCfg).offsetSecs, 10 * 3600, '15:59 is in the 15:00 slot');
  assert.strictEqual(S.captureSlot(ny('2026-08-15', 16, 0, 0), prodCfg), null);
  const a = S.captureSlot(ny('2026-08-15', 5, 31), prodCfg), b = S.captureSlot(ny('2026-08-15', 5, 59, 59), prodCfg);
  assert.strictEqual(a.key, b.key, 'one key per slot');
  assert.notStrictEqual(a.key, S.captureSlot(ny('2026-08-15', 6, 0), prodCfg).key);
});

test('the sleep until the next slot is exact', () => {
  const at = (h, m, s) => S.secondsUntilNextSlot(ny('2026-08-15', h, m, s), prodCfg);
  assert.strictEqual(at(4, 45, 0), 15 * 60, '4:45 -> 5:00');
  assert.strictEqual(at(4, 59, 59), 1);
  assert.strictEqual(at(5, 0, 0), 30 * 60);
  assert.strictEqual(at(9, 45, 0), 15 * 60, '9:45 -> 10:00, the last fast slot ends at the switch');
  assert.strictEqual(at(10, 0, 1), 30 * 60, 'an hour to 11:00, capped at 30 min');
  assert.strictEqual(at(15, 0, 0), 30 * 60, 'no 16:00 slot: next is tomorrow, capped');
  assert.strictEqual(at(23, 50, 0), 30 * 60);
});

test('the old 4am-7pm, 15/30-minute settings still give 42 captures a day', async () => {
  const { captures } = await simulate(schedCfg, ny('2026-08-15', 0, 0), ny('2026-08-16', 0, 0));
  assert.strictEqual(captures.length, 42);
  assert.strictEqual(hhmm(captures[0]), '04:00');
  assert.strictEqual(hhmm(captures[23]), '09:45');
  assert.strictEqual(hhmm(captures[24]), '10:00');
  assert.strictEqual(hhmm(captures[41]), '18:30');
});

test('a slow-rate hour off the fast grid starts its own slots', async () => {
  const cfg = { ...prodCfg, slowAfterHour: 10.25 }; // "10:15"
  const { captures } = await simulate(cfg, ny('2026-08-15', 9, 0), ny('2026-08-15', 12, 30));
  assert.deepStrictEqual(captures.map(hhmm), ['09:00', '09:30', '10:00', '10:15', '11:15', '12:15']);
});

test('always-on (0/0) and a window across midnight both work', async () => {
  const always = { ...prodCfg, activeStartHour: 0, activeEndHour: 0, slowAfterHour: 0, intervalMinutes: 60 };
  assert.strictEqual((await simulate(always, ny('2026-08-15', 0, 0), ny('2026-08-16', 0, 0))).captures.length, 24);
  const night = { ...prodCfg, activeStartHour: 22, activeEndHour: 2, slowAfterHour: 22, intervalMinutes: 60 };
  const { captures } = await simulate(night, ny('2026-08-15', 12, 0), ny('2026-08-16', 12, 0));
  assert.deepStrictEqual(captures.map(hhmm), ['22:00', '23:00', '00:00', '01:00']);
});

test('the service uses the timetable, not a fixed sleep after each cycle', () => {
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert.ok(/createScheduler\(CONFIG/.test(main), 'main() must run the slot scheduler');
  assert.ok(!/intervalForTime\(/.test(main), 'main() must not sleep an interval after each cycle');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6c. Two cameras: Dock Wired around the clock, Downstream Lot as a sparing backup');
// ═══════════════════════════════════════════════════════════════════════════
//
// The battery camera must never be woken while the dock camera is answering;
// once the dock has missed two captures in a row it takes over, but only on
// its own daylight timetable, and goes back to sleep the moment the dock
// answers again. Whole days on a fake clock, as above.

// The real defaults - what the Pi runs with the documented env file.
const dualCfg = Object.assign({}, S.CONFIG, {
  uploadUrl: baseCfg.uploadUrl, uploadSecret: baseCfg.uploadSecret, tokenFile: baseCfg.tokenFile,
  cameraName: 'Dock Wired', backupCameraName: 'Downstream Lot', timeZone: 'America/New_York',
  retries: 3, retryDelaySeconds: 0,
});

// cameras: { primaryDown(at), backupDown(at), uploadDown(at) } - each a
// predicate on the time of the attempt.
async function simulateDual(cfg, from, to, opts = {}) {
  const { primaryDown = () => false, backupDown = () => false, uploadDown = () => false,
          hasPrimary = true, hasBackup = true, cycleMs = 20000 } = opts;
  let t = from.getTime();
  const attempts = [];
  let pending = null;
  const tick = S.createScheduler(cfg, {
    now: () => new Date(t),
    setTimer: (fn, ms) => { pending = { fn, ms }; },
    hasPrimary, hasBackup,
    cycle: async (role) => {
      const at = new Date(t);
      t += cycleMs;
      const down = role === 'backup' ? backupDown(at) : primaryDown(at);
      attempts.push({ role, at, ok: !down });
      if (down) throw Object.assign(new Error(`${role} offline`), { stage: 'capture' });
      if (uploadDown(at)) throw Object.assign(new Error('worker unreachable'), { stage: 'upload' });
    },
  });
  await tick();
  while (pending && t + pending.ms <= to.getTime()) {
    const p = pending; pending = null;
    t += p.ms;
    await p.fn();
  }
  return {
    attempts,
    primary: attempts.filter(a => a.role === 'primary'),
    backup: attempts.filter(a => a.role === 'backup'),
  };
}
const between = (fromH, toH) => (at) => { const h = Number(nyClock(at).slice(0, 2)) + Number(nyClock(at).slice(3, 5)) / 60;
  return fromH <= toH ? (h >= fromH && h < toH) : (h >= fromH || h < toH); };
const DAY = '2026-08-15', NEXT = '2026-08-16';

test('the defaults are the agreed schedule', () => {
  assert.strictEqual(S.describeSchedule(dualCfg), 'Capturing every 15 min.');
  assert.strictEqual(S.describeWindow(dualCfg), 'around the clock');
  const b = S.backupConfig(dualCfg);
  assert.strictEqual(S.describeSchedule(b), 'Capturing every 30 min until 10:00, then every 60 min.');
  assert.strictEqual(S.describeWindow(b), '5:00-16:00 America/New_York');
  assert.strictEqual(dualCfg.backup.afterMisses, 2);
  assert.deepStrictEqual(S.validateConfig(dualCfg), []);
});

test('a normal day: the dock camera every 15 minutes, the battery camera never woken', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 0, 0), ny(NEXT, 0, 0));
  assert.strictEqual(r.primary.length, 96, '96 dock captures');
  assert.strictEqual(r.backup.length, 0, 'the battery camera must sleep');
  assert.deepStrictEqual(r.primary.slice(0, 3).map(a => hhmm(a.at)), ['00:00', '00:15', '00:30']);
  assert.strictEqual(hhmm(r.primary[95].at), '23:45');
});

test('one missed dock capture does not wake the battery camera', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 0), { primaryDown: between(9, 9.1) });
  assert.strictEqual(r.backup.length, 0);
  assert.strictEqual(r.primary.filter(a => !a.ok).length, 1);
});

test('two misses in a row: the backup takes over, on its own timetable', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 5), { primaryDown: between(9, 12) });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['09:15', '09:30', '10:00', '11:00'],
    'second miss at 9:15, then the 9:30 slot, then hourly after 10');
  assert.ok(r.primary.every(a => Number(nyClock(a.at).slice(3, 5)) % 15 === 0), 'the dock is still tried every 15 minutes');
  assert.ok(r.primary.filter(a => hhmm(a.at) === '12:00')[0].ok, 'and found again at 12:00');
});

test('the dock answering again sends the battery camera back to sleep', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 16, 0), { primaryDown: between(9, 10) });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['09:15', '09:30']);
});

test('the miss count starts again after the dock answers: a later single miss does not wake the backup', async () => {
  // Down 9:00-9:29 (two misses: backup at 9:15), fine from 9:30, then one
  // failed capture at 11:00. That is one miss in a row, not three.
  const down = (at) => between(9, 9.5)(at) || between(11, 11.1)(at);
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 0), { primaryDown: down });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['09:15']);
});

test('at night the battery camera stays asleep even with the dock down; it starts at 5:00', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 21, 0), ny(NEXT, 6, 20), { primaryDown: between(22, 6) });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['05:00', '05:30'],
    'nothing from 22:00 to 4:59, then its 5:00 and 5:30 slots - and the dock is back at 6:00');
  assert.ok(r.primary.find(a => hhmm(a.at) === '06:00').ok);
});

test('a whole day with the dock down: the battery camera is woken 16 times, all in daylight', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 0, 0), ny(NEXT, 0, 0), { primaryDown: () => true });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['05:00', '05:30', '06:00', '06:30', '07:00', '07:30', '08:00',
    '08:30', '09:00', '09:30', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00']);
  assert.strictEqual(r.primary.length, 96, 'the dock is still tried every slot');
});

test('a failed upload is not a camera outage: the battery camera is not woken', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 0), { uploadDown: () => true });
  assert.strictEqual(r.backup.length, 0, 'its frame would fail to upload the same way');
});

test('if the backup fails too, each of its slots is tried once - no retry storm on a battery', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 5),
    { primaryDown: () => true, backupDown: () => true });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['08:15', '08:30', '09:00', '09:30', '10:00', '11:00', '12:00']);
});

test('without a backup camera, a dock outage is just a gap', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 0), { primaryDown: () => true, hasBackup: false });
  assert.strictEqual(r.backup.length, 0);
});

test('dock camera missing from the account: the backup runs on its timetable from the first slot', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 4, 50), ny(DAY, 7, 0), { hasPrimary: false });
  assert.strictEqual(r.primary.length, 0);
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['05:00', '05:30', '06:00', '06:30']);
});

test('BACKUP_AFTER_MISSES=1 switches at the first miss', async () => {
  const cfg = Object.assign({}, dualCfg, { backup: Object.assign({}, dualCfg.backup, { afterMisses: 1 }) });
  const r = await simulateDual(cfg, ny(DAY, 8, 0), ny(DAY, 9, 20), { primaryDown: between(9, 10) });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['09:00']);
});

test('camera names: the full name wins, a unique part is accepted, an ambiguous part is refused', () => {
  const cams = [{ name: 'Dock' }, { name: 'Dock Wired' }, { name: 'Downstream Lot' }];
  assert.strictEqual(S.findCamera(cams, 'Dock').name, 'Dock', 'exact beats the longer name containing it');
  assert.strictEqual(S.findCamera(cams, 'dock wired').name, 'Dock Wired', 'case-insensitive');
  assert.strictEqual(S.findCamera(cams, '  Downstream Lot ').name, 'Downstream Lot', 'surrounding spaces ignored');
  assert.strictEqual(S.findCamera(cams, 'wired').name, 'Dock Wired', 'a unique part');
  assert.throws(() => S.findCamera(cams, 'do'), /matches several cameras/, 'never guess between cameras');
  assert.strictEqual(S.findCamera(cams, 'garage'), null);
  assert.strictEqual(S.findCamera(cams, ''), null);
});

test('picking cameras on the account: every case states what it does', async () => {
  const cams = [{ name: 'Dock Wired' }, { name: 'Downstream Lot' }, { name: 'Front Door' }];
  const api = { getCameras: async () => cams };
  const pick = (over) => S.pickCameras(api, Object.assign({}, dualCfg, over));
  let r = await pick({});
  assert.deepStrictEqual([r.primary.name, r.backup.name], ['Dock Wired', 'Downstream Lot']);
  await assert.rejects(pick({ cameraName: '', backupCameraName: '' }), /RING_CAMERA_NAME is unset/,
    'with several cameras, an unset name must not pick the first one (it may be the battery camera)');
  r = await pick({ backupCameraName: 'Garage' });
  assert.deepStrictEqual([r.primary.name, r.backup], ['Dock Wired', null], 'a missing backup only disables the fallback');
  r = await pick({ cameraName: 'Dock Camera' });
  assert.deepStrictEqual([r.primary, r.backup.name], [null, 'Downstream Lot'], 'a missing dock camera leaves the backup running');
  await assert.rejects(pick({ cameraName: 'Garage', backupCameraName: 'Shed' }), /No camera matching "Garage" or "Shed"/);
  await assert.rejects(pick({ cameraName: 'Dock Wired', backupCameraName: 'wired' }), /pick the same camera/);
  const one = await S.pickCameras({ getCameras: async () => [{ name: 'Solo' }] }, Object.assign({}, dualCfg, { cameraName: '', backupCameraName: '' }));
  assert.strictEqual(one.primary.name, 'Solo', 'a single camera needs no name');
});

test('the backup settings are validated like the primary\'s', () => {
  const bad = (b, extra = {}) => S.validateConfig(Object.assign({}, dualCfg, extra, { backup: Object.assign({}, dualCfg.backup, b) }));
  assert.ok(bad({ intervalMinutes: 2 }).some(p => /BACKUP_INTERVAL_MINUTES/.test(p)));
  assert.ok(bad({ afterMisses: 0 }).some(p => /BACKUP_AFTER_MISSES/.test(p)));
  assert.ok(bad({ afterMisses: 1.5 }).some(p => /BACKUP_AFTER_MISSES/.test(p)));
  assert.ok(bad({ activeEndHour: 25 }).some(p => /BACKUP_ACTIVE_END_HOUR/.test(p)));
  assert.ok(bad({ slowAfterHour: 17 }).some(p => /BACKUP_SLOW_AFTER_HOUR is at or after BACKUP_ACTIVE_END_HOUR/.test(p)));
  assert.ok(bad({}, { backupCameraName: 'dock wired' }).some(p => /name the same camera/.test(p)));
  assert.deepStrictEqual(bad({}, { backupCameraName: '' , backup: { intervalMinutes: 1 } }).filter(p => /BACKUP_/.test(p)), [],
    'no backup configured: its settings are not checked');
  // An always-on window has no close, so a slow-rate hour cannot be "after" it.
  assert.deepStrictEqual(S.validateConfig(Object.assign({}, dualCfg, { slowAfterHour: 10 })), []);
});

test('every upload says which camera took it; odd characters never reach a header', async () => {
  const calls = [];
  const fakeFetch = async (url, opts) => { calls.push(opts.headers); return { ok: true }; };
  await S.uploadSnapshot(JPEG, baseCfg, fakeFetch, { role: 'backup', name: 'Downstream Lot' });
  await S.uploadSnapshot(JPEG, baseCfg, fakeFetch, { role: 'primary', name: 'Dock Wired™\n' });
  await S.uploadSnapshot(JPEG, baseCfg, fakeFetch, { role: 'admin', name: '' });
  assert.deepStrictEqual([calls[0]['X-Camera-Role'], calls[0]['X-Camera-Name']], ['backup', 'Downstream Lot']);
  assert.deepStrictEqual([calls[1]['X-Camera-Role'], calls[1]['X-Camera-Name']], ['primary', 'DockWired']);
  assert.ok(!('X-Camera-Role' in calls[2]) && !('X-Camera-Name' in calls[2]), 'unknown roles and empty names are not sent');
});

test('a cycle carries its role to the upload, and says which stage failed', async () => {
  let headers;
  const fakeFetch = async (url, opts) => { headers = opts.headers; return { ok: true }; };
  await S.runCycle({ name: 'Downstream Lot', getSnapshot: async () => JPEG }, S.backupConfig(dualCfg),
    ny(DAY, 9, 0), fakeFetch, 'backup');
  assert.deepStrictEqual([headers['X-Camera-Role'], headers['X-Camera-Name']], ['backup', 'Downstream Lot']);
  await assert.rejects(S.runCycle({ name: 'Dock Wired', getSnapshot: async () => { throw new Error('offline'); } },
    dualCfg, ny(DAY, 9, 0), fakeFetch, 'primary'), (e) => e.stage === 'capture' && /Dock Wired/.test(e.message));
  await assert.rejects(S.runCycle({ name: 'Dock Wired', getSnapshot: async () => JPEG },
    dualCfg, ny(DAY, 9, 0), async () => { throw new Error('ECONNRESET'); }, 'primary'), (e) => e.stage === 'upload');
  assert.strictEqual(await S.runCycle({ name: 'Downstream Lot', getSnapshot: async () => { throw new Error('woken!'); } },
    S.backupConfig(dualCfg), ny(DAY, 23, 0), fakeFetch, 'backup'), false, 'outside its window the backup is never woken');
});

test('the service wires both cameras into the scheduler', () => {
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert.ok(/pickCameras\(api\)/.test(main));
  assert.ok(/hasBackup: !!backup/.test(main) && /hasPrimary: !!primary/.test(main));
  assert.ok(/runCycle\(backup, backupCfg/.test(main), 'the backup runs on its own timetable');
});

test('the timetables read the way they are written', () => {
  assert.strictEqual(S.describeTimetable(dualCfg), 'every 15 min, around the clock');
  assert.strictEqual(S.describeTimetable(S.backupConfig(dualCfg)),
    'every 30 min until 10:00, then every 60 min, 5:00-16:00 America/New_York');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6c2. End to end: the real service process, a stand-in Ring library and network');
// ═══════════════════════════════════════════════════════════════════════════
//
// main() itself - argument handling, camera selection, the scheduler wiring,
// the upload headers and the check-ins - run as a separate process. A fake
// ring-client-api sits where npm would put the real one (and notes every call
// made to it), and a preload sends the service's requests to the REAL Worker
// code, served from this process over HTTP with an in-memory R2. Nothing
// leaves the machine.

const WORKER_HOST = 'nhrc-camera.club-acct.workers.dev';
const openHosts = [];

/**
 * The real Worker over HTTP. `intercept(entry)` may answer a request itself (an
 * old or broken Worker); `workerSource`, other Worker code (the one deployed before).
 */
async function workerHost(opts = {}) {
  const w = opts.workerSource ? await workerFrom(opts.workerSource) : await worker();
  const env = { UPLOAD_SECRET: SECRET, BUCKET: memoryR2() };
  const requests = [];
  const http = require('http');
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const entry = { method: req.method, path: req.url, role: req.headers['x-camera-role'] || null,
      name: req.headers['x-camera-name'] || null, pi: req.headers['x-camera-pi'] || null, bytes: body.length, json: null };
    if (/json/.test(req.headers['content-type'] || '')) { try { entry.json = JSON.parse(body.toString('utf8')); } catch (e) { /* kept as null */ } }
    requests.push(entry);
    const canned = opts.intercept && opts.intercept(entry);
    if (canned) { res.writeHead(canned.status, { 'Content-Type': 'text/plain' }); res.end(canned.body || ''); return; }
    const headers = {};
    for (const k of ['authorization', 'content-type', 'x-camera-role', 'x-camera-name', 'x-camera-pi']) {
      if (req.headers[k]) headers[k] = req.headers[k];
    }
    const r = await w.fetch(new Request(`https://${WORKER_HOST}${req.url}`, { method: req.method, headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env);
    const out = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(out);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const host = {
    env, requests, port: server.address().port,
    uploads: () => requests.filter(r => r.method === 'PUT'),
    checkIns: (pi) => requests.filter(r => r.path === '/heartbeat' && (!pi || (r.json && r.json.pi === pi))),
    status: async () => (await w.fetch(new Request(`https://${WORKER_HOST}/status`), env)).json(),
    // As the website asks for the photo.
    get: (p = '/latest.jpg', method = 'GET') => w.fetch(new Request(`https://${WORKER_HOST}${p}`, { method }), env),
    close: () => new Promise(r => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  };
  openHosts.push(host);
  return host;
}

// A Ring token as ring-client-api writes it: base64 JSON holding the refresh
// token and the device id ("hid") it signs in as.
const ringToken = (hid) => Buffer.from(JSON.stringify({ rt: 'refresh-' + hid, hid })).toString('base64');

async function e2eSandbox(cameras, hostOpts, opts = {}) {
  const host = await workerHost(hostOpts);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-cam-e2e-'));
  // opts.serviceSource: other service code (the one the main Pi runs now, say).
  if (opts.serviceSource) fs.writeFileSync(path.join(dir, 'snapshot_service.js'), opts.serviceSource);
  else fs.copyFileSync(path.join(__dirname, 'snapshot_service.js'), path.join(dir, 'snapshot_service.js'));
  const pkg = path.join(dir, 'node_modules', 'ring-client-api');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'ring-client-api', type: 'module', exports: './index.js' }));
  const ringLog = path.join(dir, 'ring.log');
  fs.writeFileSync(path.join(pkg, 'index.js'), `
    import fs from 'fs';
    const cams = ${JSON.stringify(cameras)};
    const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0xFF, 0xD9]);
    const note = (o) => fs.appendFileSync(${JSON.stringify(ringLog)}, JSON.stringify(o) + String.fromCharCode(10));
    const failAuth = process.env.TEST_RING_FAIL_AUTH === '1';
    export class RingApi {
      constructor(opts) {
        this.opts = opts; this.onRefreshTokenUpdated = { subscribe() {} };
        note({ ev: 'construct', displayName: opts.controlCenterDisplayName });
      }
      async getCameras() {
        note({ ev: 'getCameras' });
        if (failAuth) throw new Error('Refresh token is not valid.');
        return cams.map(c => ({ name: c.name, async getSnapshot() {
          note({ ev: 'snapshot', camera: c.name });
          if (c.down) throw new Error(c.name + ' is offline'); return JPEG; } }));
      }
      async fetchRingDevices() {
        note({ ev: 'devices' });
        if (failAuth) throw new Error('Refresh token is not valid.');
        return { allCameras: cams.map(c => ({ description: c.name, alerts: { connection: c.down ? 'offline' : 'online' } })) };
      }
      disconnect() { note({ ev: 'disconnect' }); }
    }`);
  fs.writeFileSync(path.join(dir, 'token'), 'stand-in-refresh-token');
  fs.writeFileSync(path.join(dir, 'fakefetch.js'), `
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = new URL(String(url));
      if (u.host !== ${JSON.stringify(WORKER_HOST)}) throw new Error('test: no network access to ' + u.host);
      return realFetch('http://127.0.0.1:${host.port}' + u.pathname + u.search, opts);
    };`);
  // TEST_CLOCK_SPEED runs the service's clock - and its timers - that many
  // times faster, so a test can watch it across several 5-minute slots.
  fs.writeFileSync(path.join(dir, 'clock.js'), `
    const speed = Number(process.env.TEST_CLOCK_SPEED || 1);
    if (speed !== 1) {
      const RealDate = Date, realNow = RealDate.now.bind(RealDate), t0 = realNow();
      const start = Number(process.env.TEST_CLOCK_START || t0);
      const now = () => start + (realNow() - t0) * speed;
      globalThis.Date = class extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(now()); }
        static now() { return now(); }
      };
      const st = globalThis.setTimeout, si = globalThis.setInterval;
      globalThis.setTimeout = (fn, ms, ...rest) => st(fn, Math.max(0, Number(ms) || 0) / speed, ...rest);
      globalThis.setInterval = (fn, ms, ...rest) => si(fn, Math.max(1, (Number(ms) || 0) / speed), ...rest);
    }`);
  const ringEvents = () => (fs.existsSync(ringLog)
    ? fs.readFileSync(ringLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
  const uploads = () => host.uploads().map(u => ({ method: u.method, role: u.role, name: u.name, pi: u.pi, bytes: u.bytes }));
  // Runs the service. The long-running mode is stopped once `stopAfter`
  // uploads have arrived or `until()` holds (then `settleMs` more), or after maxMs.
  const run = (args, env = {}, opts = {}) => new Promise((resolve) => {
    const { stopAfter = 0, settleMs = 0, until = null, maxMs = 8000 } = opts;
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-r', path.join(dir, 'fakefetch.js'), '-r', path.join(dir, 'clock.js'),
      path.join(dir, 'snapshot_service.js'), ...args], {
      cwd: dir,
      env: Object.assign({ PATH: process.env.PATH, HOME: dir, RING_TOKEN_FILE: path.join(dir, 'token'),
        CAMERA_UPLOAD_URL: `https://${WORKER_HOST}/latest.jpg`, CAMERA_UPLOAD_SECRET: baseCfg.uploadSecret,
        RING_CAMERA_NAME: 'Dock Wired', RING_BACKUP_CAMERA_NAME: 'Downstream Lot',
        CAMERA_RETRIES: '1', CAMERA_RETRY_DELAY_SECONDS: '0' }, env),
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const started = Date.now();
    let seenAt = null;
    const poll = setInterval(() => {
      const done = (stopAfter && host.uploads().length >= stopAfter) || (until && until(out));
      if (done && seenAt === null) seenAt = Date.now();
      if ((seenAt !== null && Date.now() - seenAt >= settleMs) || Date.now() - started > maxMs) child.kill();
    }, 25);
    child.on('exit', (code, signal) => { clearInterval(poll); resolve({ code, signal, out, uploads: uploads() }); });
  });
  const reset = () => { host.requests.length = 0; if (fs.existsSync(ringLog)) fs.unlinkSync(ringLog); };
  const setToken = (t) => fs.writeFileSync(path.join(dir, 'token'), t);
  return { dir, host, run, reset, ringEvents, uploads, setToken };
}

test('end to end: --once and --once-backup upload from the right camera, with its role', async () => {
  const box = await e2eSandbox([{ name: 'Front Door' }, { name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  let r = await box.run(['--once'], {});
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.uploads.map(u => [u.method, u.role, u.name]), [['PUT', 'primary', 'Dock Wired']]);
  assert.ok(/Cameras on this account: "Front Door", "Dock Wired", "Downstream Lot"/.test(r.out), r.out);
  box.reset();
  r = await box.run(['--once-backup'], {});
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.uploads.map(u => [u.role, u.name]), [['backup', 'Downstream Lot']]);
  assert.strictEqual((await box.host.status()).camera, 'Downstream Lot', 'and the real Worker stored it');
});

test('end to end: the running service uploads the dock camera, and leaves the battery camera alone', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  const r = await box.run([], {}, { stopAfter: 1, settleMs: 1500 });
  assert.deepStrictEqual(r.uploads.map(u => u.role), ['primary'], r.out);
  assert.ok(/Primary camera: "Dock Wired" — every 15 min, around the clock/.test(r.out), r.out);
  assert.ok(/Backup camera: "Downstream Lot" — only after 2 missed primary captures in a row/.test(r.out));
  assert.deepStrictEqual(box.ringEvents().filter(e => e.ev === 'snapshot').map(e => e.camera), ['Dock Wired'],
    'the battery camera was never asked for a snapshot');
});

test('end to end: with the dock camera down, the running service switches to the backup', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired', down: true }, { name: 'Downstream Lot' }]);
  // One miss is enough here, and the backup window is opened all day, so the
  // test does not depend on the time it runs.
  const r = await box.run([], { BACKUP_AFTER_MISSES: '1', BACKUP_ACTIVE_START_HOUR: '0', BACKUP_ACTIVE_END_HOUR: '0',
                                BACKUP_SLOW_AFTER_HOUR: '0' }, { stopAfter: 1, settleMs: 300 });
  assert.deepStrictEqual(r.uploads.map(u => [u.role, u.name]), [['backup', 'Downstream Lot']], r.out);
  assert.ok(/primary cycle failed: CAPTURE stage \(primary "Dock Wired"\)/.test(r.out), r.out);
  assert.ok(/using the backup on its own timetable/.test(r.out));
});

test('end to end: a missing backup only disables the fallback; missing cameras stop it with a list', async () => {
  let box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Garage' }]);
  let r = await box.run([], {}, { stopAfter: 1, settleMs: 300 });
  assert.deepStrictEqual(r.uploads.map(u => u.role), ['primary']);
  assert.ok(/No camera matching RING_BACKUP_CAMERA_NAME "Downstream Lot".*Running without a backup/.test(r.out), r.out);
  box = await e2eSandbox([{ name: 'Front Door' }, { name: 'Garage' }]);
  r = await box.run([], {});
  assert.strictEqual(r.code, 1);
  assert.ok(/No camera matching "Dock Wired" or "Downstream Lot"\. Available: "Front Door", "Garage"/.test(r.out), r.out);
  assert.strictEqual(r.uploads.length, 0);
  box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  r = await box.run(['--once'], { RING_CAMERA_NAME: '', RING_BACKUP_CAMERA_NAME: '' });
  assert.strictEqual(r.code, 1);
  assert.ok(/RING_CAMERA_NAME is unset/.test(r.out), 'two cameras and no name: refuse to guess');
  assert.strictEqual(r.uploads.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
section('6d. The Worker, run for real (in-memory R2)');
// ═══════════════════════════════════════════════════════════════════════════
//
// The Worker's own fetch handler, with Node's Request/Response and an R2
// bucket stand-in - so uploads, staleness and the headers the website reads
// are exercised, not just pattern-matched.

let workerModule = null;
async function worker() {
  if (workerModule) return workerModule;
  workerModule = await workerFrom(fs.readFileSync(path.join(__dirname, 'cloudflare_worker.js'), 'utf8'));
  return workerModule;
}
/** A Worker's fetch handler from its source text. */
async function workerFrom(src) {
  const tmp = path.join(os.tmpdir(), `nhrc-worker-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    return (await import(require('url').pathToFileURL(tmp).href)).default;
  } finally {
    fs.unlinkSync(tmp);
  }
}
/**
 * A file as git has it at a commit - the code running at the boathouse before
 * this release - or null where git or that commit is not to hand.
 */
function atCommit(commit, file) {
  const r = require('child_process').spawnSync('git', ['show', `${commit}:camera/${file}`],
    { cwd: __dirname, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 && r.stdout ? r.stdout : null;
}
// What ran at the boathouse on 14 October 2026, before the standby release.
const DEPLOYED_SERVICE = 'a1b441df', DEPLOYED_WORKER = '4f5201fb';
// An R2 bucket stand-in: the photo plus one small record per Pi. get() gives
// what R2 gives - body, text(), json() - and failNext lets a test make the
// next read fail, as R2 occasionally does.
function memoryR2() {
  const objects = new Map();
  let failReads = 0;
  const bucket = {
    async put(key, body, opts = {}) {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body);
      objects.set(key, { key, bytes, customMetadata: Object.assign({}, opts.customMetadata),
                         httpMetadata: opts.httpMetadata, uploaded: new Date(), size: bytes.byteLength });
    },
    async get(key) {
      if (failReads > 0) { failReads--; throw new Error('R2: internal error'); }
      const o = objects.get(key);
      if (!o) return null;
      const text = () => new TextDecoder().decode(o.bytes);
      return Object.assign({}, o, { body: o.bytes, text: async () => text(), json: async () => JSON.parse(text()) });
    },
    async head(key) { return objects.get(key) || null; },
    stored: (key = 'latest.jpg') => objects.get(key) || null,
    record: (pi) => { const o = objects.get(`pi/${pi}.json`); return o ? JSON.parse(new TextDecoder().decode(o.bytes)) : null; },
    setRecord: (pi, rec) => bucket.put(`pi/${pi}.json`, JSON.stringify(rec)),
    failNext: (n = 1) => { failReads = n; },
    keys: () => [...objects.keys()],
  };
  return bucket;
}
const W_URL = 'https://nhrc-camera.example.workers.dev/latest.jpg';
const SECRET = baseCfg.uploadSecret;
const env = () => ({ UPLOAD_SECRET: SECRET, BUCKET: memoryR2() });
const put = async (e, headers, body = JPEG) => (await worker()).fetch(new Request(W_URL, { method: 'PUT',
  headers: Object.assign({ Authorization: `Bearer ${SECRET}`, 'Content-Type': 'image/jpeg' }, headers), body }), e);
const get = async (e, url = W_URL, method = 'GET') => (await worker()).fetch(new Request(url, { method }), e);
const ageBy = (e, minutes) => { e.BUCKET.stored().customMetadata.capturedAt = new Date(Date.now() - minutes * 60000).toISOString(); };

test('Worker: a frame keeps which camera took it, and the website may read that', async () => {
  const e = env();
  assert.strictEqual((await put(e, { 'X-Camera-Role': 'primary', 'X-Camera-Name': 'Dock Wired' })).status, 200);
  const r = await get(e);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('X-Camera-Role'), 'primary');
  assert.strictEqual(r.headers.get('X-Camera-Name'), 'Dock Wired');
  assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), '*');
  const exposed = r.headers.get('Access-Control-Expose-Headers') || '';
  for (const h of ['X-Camera-Role', 'X-Camera-Name']) assert.ok(exposed.includes(h), `${h} must be exposed to the website`);
  assert.ok(Number.isFinite(Date.parse(r.headers.get('Last-Modified'))), 'capture time');
  assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), JPEG);
  assert.strictEqual(r.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('Worker: camera names and roles are reduced to safe values before storing', async () => {
  const e = env();
  await put(e, { 'X-Camera-Role': 'ADMIN', 'X-Camera-Name': 'Dock<script>alert(1)</script> "x"' });
  const m = e.BUCKET.stored().customMetadata;
  assert.strictEqual(m.role, '', 'unknown role dropped');
  assert.ok(!/[<>"()]/.test(m.camera), m.camera);
  await put(e, { 'X-Camera-Role': ' Backup ', 'X-Camera-Name': 'x'.repeat(200) });
  assert.strictEqual(e.BUCKET.stored().customMetadata.role, 'backup');
  assert.strictEqual(e.BUCKET.stored().customMetadata.camera.length, 60);
});

test('Worker: a dock frame is stale after an hour, a backup frame after 130 minutes', async () => {
  const cases = [['primary', 59, 200], ['primary', 61, 404], ['backup', 61, 200], ['backup', 129, 200],
                 ['backup', 131, 404], ['', 129, 200], ['', 131, 404]];
  for (const [role, minutes, status] of cases) {
    const e = env();
    await put(e, role ? { 'X-Camera-Role': role } : {});
    ageBy(e, minutes);
    const r = await get(e);
    assert.strictEqual(r.status, status, `${role || 'no role'} at ${minutes} min`);
    assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), '*', 'a stale answer is readable by the page too');
  }
});

test('Worker: /status says which camera, how old, and whether it is still served', async () => {
  const e = env();
  await put(e, { 'X-Camera-Role': 'backup', 'X-Camera-Name': 'Downstream Lot' });
  ageBy(e, 90);
  const st = await (await get(e, 'https://nhrc-camera.example.workers.dev/status')).json();
  assert.deepStrictEqual([st.ok, st.camera, st.role, st.staleAfterSeconds], [true, 'Downstream Lot', 'backup', 7800]);
  assert.ok(st.ageSeconds >= 5390 && st.ageSeconds <= 5410, String(st.ageSeconds));
  await put(e, { 'X-Camera-Role': 'primary', 'X-Camera-Name': 'Dock Wired' });
  ageBy(e, 90);
  const st2 = await (await get(e, 'https://nhrc-camera.example.workers.dev/status')).json();
  assert.deepStrictEqual([st2.ok, st2.staleAfterSeconds], [false, 3600]);
});

test('Worker: uploads still need the secret and real JPEG bytes', async () => {
  const e = env();
  const w = await worker();
  const r1 = await w.fetch(new Request(W_URL, { method: 'PUT', headers: { Authorization: 'Bearer wrong', 'Content-Type': 'image/jpeg' }, body: JPEG }), e);
  assert.strictEqual(r1.status, 401);
  assert.strictEqual((await put(e, {}, Buffer.from('<svg onload=alert(1)>'))).status, 415);
  assert.strictEqual((await put(e, {}, Buffer.alloc(0))).status, 400);
  assert.strictEqual((await get(e)).status, 404, 'nothing stored by any of them');
  const head = await get(env(), W_URL, 'HEAD');
  assert.strictEqual(head.status, 404);
});

// ── The Worker's side of the two-Pi setup ────────────────────────────────────

const HB_URL = 'https://nhrc-camera.example.workers.dev/heartbeat';
const ST_URL = 'https://nhrc-camera.example.workers.dev/status';
const beat = async (e, body, secret = SECRET) => (await worker()).fetch(new Request(HB_URL, { method: 'POST',
  headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body) }), e);
const status = async (e) => (await (await get(e, ST_URL)).json());
const ago = (e, pi, minutes) => { const r = e.BUCKET.record(pi); r.at = Date.now() - minutes * 60000; return e.BUCKET.setRecord(pi, r); };
const HEX_A = '0123456789abcdef', HEX_B = 'fedcba9876543210';

test('Worker: check-ins need the secret, JSON, and a known Pi', async () => {
  const e = env();
  assert.strictEqual((await beat(e, { pi: 'main' }, 'wrong')).status, 401);
  assert.strictEqual((await beat({ BUCKET: memoryR2() }, { pi: 'main' })).status, 401, 'no secret configured: nobody gets in');
  assert.strictEqual((await beat(e, 'not json')).status, 400);
  assert.strictEqual((await beat(e, 'null')).status, 400);
  assert.strictEqual((await beat(e, { pi: 'backup' })).status, 400);
  assert.strictEqual((await beat(e, { pi: 'main', pad: 'x'.repeat(3000) })).status, 413);
  assert.deepStrictEqual(e.BUCKET.keys(), [], 'none of them stored anything');
  const r = await (await worker()).fetch(new Request(HB_URL, { method: 'GET' }), e);
  assert.strictEqual(r.status, 404, 'a GET is not a check-in (it asks for the photo, and there is none)');
  assert.strictEqual((await (await worker()).fetch(new Request('https://nhrc-camera.example.workers.dev/other', { method: 'POST' }), e)).status, 405);
  assert.deepStrictEqual(e.BUCKET.keys(), []);
});

test('Worker: a check-in is timed by the Worker\'s own clock, and the answer describes both Pis', async () => {
  const e = env();
  // A Pi just back from a power cut has no real-time clock: it may think it is
  // 1970 until NTP catches up. Nothing it sends is used as a time.
  let r = await beat(e, { pi: 'main', state: 'capturing', ring: 'ok', ringId: HEX_A, instance: HEX_B, at: 0 });
  assert.strictEqual(r.status, 200);
  let a = await r.json();
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.main.lastSeenSecondsAgo, 0);
  assert.deepStrictEqual([a.main.state, a.main.ring, a.main.ringId, a.main.conflict], ['capturing', 'ok', HEX_A, false]);
  assert.strictEqual(a.standby, null, 'never heard from');
  assert.strictEqual(a.photo, null);
  const rec = e.BUCKET.record('main');
  assert.ok(Math.abs(rec.at - Date.now()) < 5000, 'stored with the Worker\'s time');
  await ago(e, 'main', 20);
  a = await (await beat(e, { pi: 'standby', state: 'standing-by', ring: 'ok', ringId: HEX_B })).json();
  assert.ok(a.main.lastSeenSecondsAgo >= 1195 && a.main.lastSeenSecondsAgo <= 1205, String(a.main.lastSeenSecondsAgo));
  assert.strictEqual(a.standby.lastSeenSecondsAgo, 0);
  assert.strictEqual(a.standby.ringId, HEX_B);
  r = await beat(e, { pi: ' MAIN ' });
  assert.strictEqual(r.status, 200, 'the name is read leniently');
});

test('Worker: states and ids are reduced to safe values before storing', async () => {
  const e = env();
  await beat(e, { pi: 'standby', state: '<script>', ring: 'pwned', ringId: 'NOT-HEX!', instance: 'a'.repeat(64) });
  const rec = e.BUCKET.record('standby');
  assert.deepStrictEqual([rec.state, rec.ring, rec.ringId, rec.instance], ['unknown', 'unknown', '', '']);
  for (const s of ['starting', 'capturing', 'standing-by', 'blocked', 'ring-failed']) {
    await beat(e, { pi: 'standby', state: s, ring: 'failed' });
    assert.deepStrictEqual([e.BUCKET.record('standby').state, e.BUCKET.record('standby').ring], [s, 'failed']);
  }
});

test('Worker: a photo counts as hearing from the Pi that sent it - an unlabelled one from the main Pi', async () => {
  // From the standby: says nothing about the main Pi.
  let e = env();
  await put(e, { 'X-Camera-Role': 'primary', 'X-Camera-Name': 'Dock Wired', 'X-Camera-Pi': 'standby' });
  let a = await (await beat(e, { pi: 'standby', state: 'capturing' })).json();
  assert.strictEqual(a.main, null, 'a standby photo is not a sign of life from the main Pi');
  assert.strictEqual(a.photo.pi, 'standby');
  // From the main Pi: counts, and a newer photo beats an older check-in.
  e = env();
  await beat(e, { pi: 'main', state: 'capturing' });
  await ago(e, 'main', 30);
  await put(e, { 'X-Camera-Role': 'primary', 'X-Camera-Pi': 'main' });
  ageBy(e, 2);
  a = await (await beat(e, { pi: 'standby' })).json();
  assert.ok(a.main.lastSeenSecondsAgo >= 115 && a.main.lastSeenSecondsAgo <= 125, String(a.main.lastSeenSecondsAgo));
  // From software older than the standby (no X-Camera-Pi): there was only the main Pi.
  e = env();
  await put(e, { 'X-Camera-Role': 'primary' });
  ageBy(e, 3);
  a = await (await beat(e, { pi: 'standby' })).json();
  assert.ok(a.main && a.main.lastSeenSecondsAgo >= 175 && a.main.lastSeenSecondsAgo <= 185, JSON.stringify(a.main));
  assert.strictEqual(a.main.state, null, 'known only from its photo');
  assert.strictEqual(a.photo.pi, null);
});

test('Worker: a probe (--status) is answered but recorded nowhere', async () => {
  const e = env();
  const a = await (await beat(e, { pi: 'standby', probe: true, ringId: HEX_A })).json();
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.standby, null);
  assert.deepStrictEqual(e.BUCKET.keys(), []);
});

test('Worker: two Pis checking in under one name are flagged, for an hour', async () => {
  const e = env();
  await beat(e, { pi: 'main', instance: HEX_A });
  let a = await (await beat(e, { pi: 'main', instance: HEX_A })).json();
  assert.strictEqual(a.conflict, false, 'the same Pi again');
  a = await (await beat(e, { pi: 'main', instance: HEX_B })).json();
  assert.strictEqual(a.conflict, true, 'a different Pi within 15 minutes');
  assert.strictEqual((await status(e)).pis.main.conflict, true, '/status says so too');
  const rec = e.BUCKET.record('main');
  rec.conflictAt = Date.now() - 61 * 60000;
  await e.BUCKET.setRecord('main', rec);
  a = await (await beat(e, { pi: 'main', instance: HEX_B })).json();
  assert.strictEqual(a.conflict, false, 'cleared an hour after it last happened');
  // A Pi replaced after a long silence is not a conflict.
  await ago(e, 'main', 20);
  a = await (await beat(e, { pi: 'main', instance: HEX_A })).json();
  assert.strictEqual(a.conflict, false);
});

test('Worker: storage trouble is never reported as "the main Pi is quiet"', async () => {
  const e = env();
  await beat(e, { pi: 'main' });
  e.BUCKET.failNext(1);
  const r = await beat(e, { pi: 'standby' });
  assert.strictEqual(r.status, 503, 'an error, which the standby treats as no news');
  // A damaged record reads as none - and the Pi's next check-in rewrites it.
  await e.BUCKET.put('pi/main.json', '{ not json');
  let a = await (await beat(e, { pi: 'standby' })).json();
  assert.strictEqual(a.main, null);
  await beat(e, { pi: 'main' });
  a = await (await beat(e, { pi: 'standby' })).json();
  assert.strictEqual(a.main.lastSeenSecondsAgo, 0);
  // /status stays up, saying the Pis cannot be read.
  await put(e, { 'X-Camera-Role': 'primary' });
  e.BUCKET.failNext(1);
  const st = await status(e);
  assert.strictEqual(st.pis, 'unavailable');
  assert.strictEqual(st.role, 'primary', 'the photo part still answers');
});

test('Worker: /status shows both Pis - without their Ring ids - and which Pi sent the photo', async () => {
  const e = env();
  let st = await status(e);
  assert.deepStrictEqual(st.pis, { main: null, standby: null }, 'shown even before the first photo');
  await beat(e, { pi: 'main', state: 'capturing', ring: 'ok', ringId: HEX_A, instance: HEX_B });
  await beat(e, { pi: 'standby', state: 'standing-by', ring: 'ok', ringId: HEX_B, instance: HEX_A });
  await put(e, { 'X-Camera-Role': 'primary', 'X-Camera-Name': 'Dock Wired', 'X-Camera-Pi': 'main' });
  st = await status(e);
  assert.strictEqual(st.pi, 'main');
  assert.deepStrictEqual(Object.keys(st.pis.main).sort(), ['conflict', 'lastSeenSecondsAgo', 'ring', 'state']);
  assert.deepStrictEqual([st.pis.standby.state, st.pis.standby.ring], ['standing-by', 'ok']);
  assert.ok(!JSON.stringify(st).includes(HEX_A) && !JSON.stringify(st).includes(HEX_B), 'no device ids in public');
  // The website's view of the photo is unchanged by any of this.
  const img = await get(e);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('X-Camera-Role'), 'primary');
});

test('Worker: an upload records the Pi that sent it; anything else is dropped', async () => {
  const e = env();
  await put(e, { 'X-Camera-Pi': 'Standby' });
  assert.strictEqual(e.BUCKET.stored().customMetadata.pi, 'standby');
  await put(e, { 'X-Camera-Pi': 'laptop' });
  assert.strictEqual(e.BUCKET.stored().customMetadata.pi, '');
  await put(e, {});
  assert.strictEqual(e.BUCKET.stored().customMetadata.pi, '');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6e. Two Pis: check-ins, the standby\'s decision, whole days on a fake clock');
// ═══════════════════════════════════════════════════════════════════════════
//
// The standby must take over when - and only when - the main Pi has gone
// quiet, hand back the moment it returns, and never wake a camera on a
// guess. Everything here runs the real functions on a fake clock.

const mainCfg = Object.assign({}, dualCfg, { pi: 'main', takeoverMinutes: 15 });
const standbyCfg = Object.assign({}, dualCfg, { pi: 'standby', takeoverMinutes: 15 });
const ID_STANDBY = { ringId: '1111111111111111', instance: '2222222222222222' };
const ID_MAIN_RING = '3333333333333333';

/** Runs fn with console output captured; returns the lines. */
async function captureLogs(fn) {
  const lines = [];
  const ol = console.log, oe = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = ol; console.error = oe; }
  return lines;
}
const flush = () => new Promise(r => setImmediate(r));

test('the defaults: this Pi is the main one, and a standby takes over after 15 quiet minutes', () => {
  assert.strictEqual(S.CONFIG.pi, 'main');
  assert.strictEqual(S.CONFIG.takeoverMinutes, 15);
  assert.strictEqual(S.CHECK_IN_SECONDS, 300, 'both Pis check in every 5 minutes');
  assert.strictEqual(S.STANDBY_WAKE_OFFSET_MS, 30000, 'the standby looks 30 s into each slot');
  assert.deepStrictEqual(S.validateConfig(standbyCfg), []);
  assert.deepStrictEqual(S.validateConfig(mainCfg), []);
});

test('CAMERA_PI and STANDBY_TAKEOVER_MINUTES are validated', () => {
  const v = (over) => S.validateConfig(Object.assign({}, dualCfg, over));
  assert.ok(v({ pi: 'backup' }).some(p => /CAMERA_PI must be "main" or "standby"/.test(p)));
  assert.ok(v({ pi: '' }).some(p => /CAMERA_PI/.test(p)));
  for (const m of [9, 1441, 12.5, NaN, 0, -15]) {
    assert.ok(v({ pi: 'standby', takeoverMinutes: m }).some(p => /STANDBY_TAKEOVER_MINUTES/.test(p)), String(m));
  }
  for (const m of [10, 15, 60, 1440]) assert.deepStrictEqual(v({ pi: 'standby', takeoverMinutes: m }), [], String(m));
  assert.deepStrictEqual(S.validateConfig(baseCfg), [], 'a config from before the standby existed is still valid');
  for (const m of [5, NaN, 0]) {
    assert.deepStrictEqual(v({ pi: 'main', takeoverMinutes: m }), [], `the main Pi has no use for it: ${m} never stops its photos`);
  }
});

test('the standby decision: 15 quiet minutes, or a main Pi never heard from - and nothing else', () => {
  const d = (main) => S.standbyDecision({ ok: true, main }, standbyCfg);
  const checkedIn = (seconds) => ({ lastSeenSecondsAgo: seconds, state: 'capturing' });
  assert.deepStrictEqual(d(null), { capture: true, seen: null, reason: 'never' });
  assert.deepStrictEqual(d({ lastSeenSecondsAgo: null }), { capture: true, seen: null, reason: 'never' });
  assert.strictEqual(d(checkedIn(0)).capture, false);
  assert.strictEqual(d(checkedIn(899)).capture, false, '14:59 is not yet');
  assert.strictEqual(d(checkedIn(900)).capture, true, '15:00 is');
  assert.strictEqual(d(checkedIn(86400)).capture, true);
  for (const odd of [{}, { lastSeenSecondsAgo: '900' }, { lastSeenSecondsAgo: -5 }, { lastSeenSecondsAgo: NaN }, 'main', 42]) {
    assert.strictEqual(d(odd).capture, false, `unreadable is not a yes: ${JSON.stringify(odd)}`);
  }
  assert.strictEqual(S.standbyDecision({ ok: true }, standbyCfg).capture, false, 'an answer without "main" (an old Worker)');
  assert.strictEqual(S.standbyDecision(null, standbyCfg).capture, false);
  assert.strictEqual(S.standbyDecision({ ok: true, main: checkedIn(1000) },
    Object.assign({}, standbyCfg, { takeoverMinutes: 20 })).capture, false, 'follows STANDBY_TAKEOVER_MINUTES');
  // A main Pi known only by its photos runs software from before check-ins:
  // it uploads every 15 minutes, sometimes later - a late photo is not a dead Pi.
  for (const seen of [600, 900, 3600, 86400]) {
    assert.deepStrictEqual(d({ lastSeenSecondsAgo: seen, state: null }), { capture: false, seen, reason: 'no-check-ins' }, String(seen));
  }
});

test('Ring device ids: a one-way hash of the id inside the token, the same however the token rotates', () => {
  const a = S.ringIdentity(ringToken('hid-pi-one'));
  const rotated = Buffer.from(JSON.stringify({ rt: 'a-much-newer-refresh-token', hid: 'hid-pi-one', pnc: { x: 1 } })).toString('base64');
  assert.ok(/^[0-9a-f]{16}$/.test(a), a);
  assert.strictEqual(S.ringIdentity(rotated), a, 'the refresh token changes hourly; the device does not');
  assert.notStrictEqual(S.ringIdentity(ringToken('hid-pi-two')), a);
  assert.strictEqual(S.ringIdentity('stand-in-refresh-token'), '', 'a raw token carries no device id');
  assert.strictEqual(S.ringIdentity(Buffer.from('{"rt":"x"}').toString('base64')), '', 'no hid');
  assert.strictEqual(S.ringIdentity(''), '');
  assert.strictEqual(S.ringIdentity(null), '');
  assert.ok(!ringToken('hid-pi-one').includes(a) && !a.includes('hid'), 'nothing of the token in the id');
});

test('machine ids are a stable one-way hash', () => {
  const m = S.machineIdentity();
  assert.ok(/^[0-9a-f]{16}$/.test(m), m);
  assert.strictEqual(S.machineIdentity(), m);
  assert.ok(!m.includes(os.hostname()));
});

test('durations read naturally in the log', () => {
  const cases = [[0, '0 s'], [42, '42 s'], [89, '89 s'], [90, '2 min'], [900, '15 min'], [5340, '89 min'],
                 [5400, '1 h 30 min'], [7170, '2 h 00 min'], [86399, '24 h 00 min'], [172800, '2 days'], [-5, '0 s'], ['x', '0 s']];
  for (const [s, want] of cases) assert.strictEqual(S.fmtAgo(s), want, String(s));
});

test('a check-in POSTs to /heartbeat beside the upload URL, with the secret, and returns the answer', async () => {
  let seen;
  const reply = { ok: true, conflict: false, main: null, standby: null, photo: null };
  const f = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => reply }; };
  assert.deepStrictEqual(await S.checkIn({ pi: 'standby', state: 'starting' }, baseCfg, f), reply);
  assert.strictEqual(seen.url, 'https://cam.roworno.com/heartbeat');
  assert.strictEqual(seen.opts.method, 'POST');
  assert.strictEqual(seen.opts.headers.Authorization, `Bearer ${baseCfg.uploadSecret}`);
  assert.strictEqual(seen.opts.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual(JSON.parse(seen.opts.body), { pi: 'standby', state: 'starting' });
  assert.ok(seen.opts.signal, 'bounded by a deadline');
});

test('a failed check-in says why - and an old Worker is named as the cause', async () => {
  const answer = (status, body) => async () => ({ ok: status < 300, status, text: async () => body,
    json: async () => JSON.parse(body) });
  await assert.rejects(S.checkIn({ pi: 'main' }, baseCfg, answer(405, 'Method not allowed')), /HTTP 405.*update it/);
  await assert.rejects(S.checkIn({ pi: 'main' }, baseCfg, answer(401, 'Unauthorized')),
    (e) => /HTTP 401/.test(e.message) && !/update it/.test(e.message));
  await assert.rejects(S.checkIn({ pi: 'main' }, baseCfg, answer(200, 'OK')), /something unexpected/, 'not JSON');
  await assert.rejects(S.checkIn({ pi: 'main' }, baseCfg, answer(200, '{"ok":false}')), /something unexpected/);
  const down = async () => { throw Object.assign(new Error('fetch failed'), { cause: Object.assign(
    new Error('getaddrinfo ENOTFOUND cam.roworno.com'), { code: 'ENOTFOUND' }) }); };
  await assert.rejects(S.checkIn({ pi: 'main' }, baseCfg, down),
    (e) => /ENOTFOUND/.test(e.message) && /cam\.roworno\.com/.test(e.message) && !e.message.includes(baseCfg.uploadSecret));
});

test('a check-in that gets no answer gives up at its deadline', async () => {
  const hang = (url, opts) => new Promise((_, reject) => opts.signal.addEventListener('abort',
    () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))));
  const t0 = Date.now();
  await assert.rejects(S.checkIn({ pi: 'standby' }, baseCfg, hang, 150), /no answer within/);
  assert.ok(Date.now() - t0 < 2000);
});

test('the main Pi checks in as "main"; a failing Worker is logged once an hour, not every 5 minutes', async () => {
  let t = ny(DAY, 9, 0).getTime();
  const bodies = [];
  let fail = false;
  const hb = S.createMainCheckIn(mainCfg, { now: () => new Date(t), identity: { ringId: ID_MAIN_RING, instance: '4444444444444444' },
    checkIn: async (b) => { bodies.push(b); if (fail) throw new Error('check-in failed: HTTP 503 Storage unavailable'); return { ok: true, conflict: false, main: null, standby: null }; } });
  const lines = await captureLogs(async () => {
    await hb();
    fail = true;
    for (let i = 0; i < 24; i++) { t += 5 * 60000; await hb(); }   // two hours of failures
    fail = false;
    t += 5 * 60000;
    await hb();
  });
  assert.deepStrictEqual(bodies[0], { pi: 'main', state: 'capturing', ring: 'ok', ringId: ID_MAIN_RING, instance: '4444444444444444' });
  assert.strictEqual(bodies.length, 26);
  assert.strictEqual(lines.filter(l => /HTTP 503/.test(l)).length, 2, `at the first failure and an hour later: ${lines.join(' | ')}`);
  assert.ok(lines.some(l => /The cameras carry on/.test(l)));
  assert.strictEqual(lines.filter(l => /working again/.test(l)).length, 1);
  await hb();   // a rejected check-in never escapes
});

test('the main Pi warns when another Pi also checks in as main, or the standby shares its Ring device', async () => {
  let t = ny(DAY, 9, 0).getTime();
  const hb = S.createMainCheckIn(mainCfg, { now: () => new Date(t), identity: { ringId: ID_MAIN_RING, instance: '4444444444444444' },
    checkIn: async () => ({ ok: true, conflict: true, main: {}, standby: { lastSeenSecondsAgo: 5, ringId: ID_MAIN_RING } }) });
  const lines = await captureLogs(async () => { await hb(); t += 5 * 60000; await hb(); t += 60 * 60000; await hb(); });
  assert.strictEqual(lines.filter(l => /Two different Pis have checked in as the MAIN Pi/.test(l)).length, 2, 'hourly');
  assert.strictEqual(lines.filter(l => /standby Pi signs in to Ring as the same device/.test(l)).length, 2);
});

/** createStandby with a scripted Worker; every check-in and Ring call is recorded. */
function fakeStandby(opts = {}) {
  let t = (opts.start || ny(DAY, 9, 0)).getTime();
  const calls = { checkIns: [], connects: 0, ringChecks: 0, disconnects: 0 };
  const w = { mainSeen: 60, fail: false, mainRingId: '', conflict: false, odd: false };
  const sb = S.createStandby(Object.assign({}, standbyCfg, opts.cfg || {}), {
    now: () => new Date(t),
    identity: opts.identity || ID_STANDBY,
    ringWaitMs: opts.ringWaitMs || 50,
    checkIn: async (b) => {
      calls.checkIns.push(Object.assign({ at: t }, b));
      if (w.fail) throw new Error('check-in with nhrc-camera.example.workers.dev failed: ECONNREFUSED');
      if (w.odd) return { ok: true };
      return { ok: true, conflict: w.conflict, standby: null,
        main: w.mainSeen === null ? null : { lastSeenSecondsAgo: w.mainSeen, state: 'capturing', ringId: w.mainRingId || null } };
    },
    connect: opts.connect || (async () => { calls.connects++; if (opts.connectFails && opts.connectFails()) throw new Error('Refresh token is not valid.'); }),
    ringCheck: opts.ringCheck || (async () => { calls.ringChecks++; if (opts.ringCheckFails && opts.ringCheckFails()) throw new Error('ETIMEDOUT'); return '"Dock Wired" online, "Downstream Lot" online'; }),
    disconnect: () => { calls.disconnects++; },
  });
  return { sb, calls, w, advance: (ms) => { t += ms; } };
}

test('the standby signs in to Ring only after the Worker has answered, then stands by', async () => {
  const f = fakeStandby();
  f.w.fail = true;
  let lines = await captureLogs(async () => { assert.strictEqual(await f.sb.gate(), false); });
  assert.strictEqual(f.calls.connects, 0, 'no Ring call before the Worker has confirmed who the main Pi is');
  assert.strictEqual(f.sb.state(), 'starting');
  assert.ok(lines.some(l => /ECONNREFUSED.*Not capturing until the Worker answers/.test(l)), lines.join(' | '));
  f.w.fail = false;
  f.advance(5 * 60000);
  lines = await captureLogs(async () => { assert.strictEqual(await f.sb.gate(), false); await flush(); });
  assert.strictEqual(f.calls.connects, 1);
  assert.deepStrictEqual([f.sb.state(), f.sb.ring()], ['standing-by', 'ok']);
  assert.ok(lines.some(l => /working again/.test(l)));
  assert.ok(lines.some(l => /Standing by: the main Pi checked in 60 s ago\. This Pi takes over if it is quiet for 15 min/.test(l)), lines.join(' | '));
  const last = f.calls.checkIns[f.calls.checkIns.length - 1];
  assert.deepStrictEqual([last.pi, last.state, last.ring, last.ringId], ['standby', 'standing-by', 'ok', ID_STANDBY.ringId],
    'the Worker is told about the change straight away');
  f.advance(5 * 60000);
  await f.sb.gate();
  assert.strictEqual(f.calls.connects, 1, 'signed in once, not at every check');
});

test('the standby takes over at 15 quiet minutes, and hands back the moment the main Pi checks in', async () => {
  const f = fakeStandby();
  const lines = await captureLogs(async () => {
    f.w.mainSeen = 899;
    assert.strictEqual(await f.sb.gate(), false, '14:59');
    f.w.mainSeen = 900;
    assert.strictEqual(await f.sb.gate(), true, '15:00');
    assert.strictEqual(f.sb.state(), 'capturing');
    f.w.mainSeen = 1200;
    assert.strictEqual(await f.sb.gate(), true, 'still quiet');
    f.w.mainSeen = 30;
    assert.strictEqual(await f.sb.gate(), false, 'back');
    assert.strictEqual(f.sb.state(), 'standing-by');
  });
  assert.ok(lines.some(l => /has not checked in for 15 min - this Pi is taking over the cameras/.test(l)), lines.join(' | '));
  assert.ok(lines.some(l => /checking in again \(30 s ago\) - this Pi is back to standing by/.test(l)));
  assert.strictEqual(lines.filter(l => /taking over/.test(l)).length, 1, 'logged at the change, not every 5 minutes');
});

test('a main Pi never heard from: the standby runs the cameras', async () => {
  const f = fakeStandby();
  f.w.mainSeen = null;
  const lines = await captureLogs(async () => { assert.strictEqual(await f.sb.gate(), true); });
  assert.ok(lines.some(l => /never checked in with the Worker - this Pi is running the cameras/.test(l)));
});

test('no news is not news: a Worker outage never switches the standby on - or off', async () => {
  const f = fakeStandby();
  await captureLogs(async () => {
    await f.sb.gate();                       // standing by
    f.w.fail = true;
    f.w.mainSeen = 3600;
    for (let i = 0; i < 12; i++) { f.advance(5 * 60000); assert.strictEqual(await f.sb.gate(), false, 'standing by stays standing by'); }
    f.w.fail = false;
    assert.strictEqual(await f.sb.gate(), true, 'and takes over once the Worker says so');
    f.w.fail = true;
    for (let i = 0; i < 12; i++) { f.advance(5 * 60000); assert.strictEqual(await f.sb.gate(), true, 'capturing stays capturing'); }
  });
});

test('an answer it cannot read keeps the standby doing what it was doing', async () => {
  const f = fakeStandby();
  await captureLogs(async () => {
    await f.sb.gate();
    f.w.odd = true;
    assert.strictEqual(await f.sb.gate(), false);
    f.w.odd = false; f.w.mainSeen = 3600;
    assert.strictEqual(await f.sb.gate(), true);
    f.w.odd = true;
    assert.strictEqual(await f.sb.gate(), true);
  });
});

test('same Ring device as the main Pi: blocked - no Ring call at all, even with the main Pi quiet', async () => {
  const f = fakeStandby();
  f.w.mainRingId = ID_STANDBY.ringId;
  f.w.mainSeen = 3600;
  const lines = await captureLogs(async () => {
    for (let i = 0; i < 5; i++) { assert.strictEqual(await f.sb.gate(), false); f.advance(5 * 60000); }
  });
  assert.strictEqual(f.calls.connects, 0, 'it never signs in to Ring');
  assert.strictEqual(f.sb.state(), 'blocked');
  assert.strictEqual(lines.filter(l => /same device as the main Pi/.test(l)).length, 1, 'said once, clearly');
  assert.ok(f.calls.checkIns.slice(1).every(c => c.state === 'blocked'), '/status shows why');
  // A main Pi whose token carries no device id cannot be compared, and is not a match.
  const g = fakeStandby();
  g.w.mainRingId = '';
  await captureLogs(() => g.sb.gate());
  assert.strictEqual(g.calls.connects, 1);
});

test('a standby that cannot sign in to Ring reports it, retries hourly, and cannot take over meanwhile', async () => {
  let failing = true;
  const f = fakeStandby({ connectFails: () => failing });
  f.w.mainSeen = 3600;
  const lines = await captureLogs(async () => {
    for (let i = 0; i < 12; i++) { assert.strictEqual(await f.sb.gate(), false); f.advance(5 * 60000); }
    assert.strictEqual(f.sb.state(), 'ring-failed');
    assert.strictEqual(f.calls.connects, 1, 'one attempt in the first hour');
    assert.strictEqual(await f.sb.gate(), false, 'the hourly retry, still failing');
    assert.strictEqual(f.calls.connects, 2);
    failing = false;
    for (let i = 0; i < 11; i++) { f.advance(5 * 60000); assert.strictEqual(await f.sb.gate(), false); }
    f.advance(5 * 60000);
    assert.strictEqual(await f.sb.gate(), true, 'signed in at the next hourly attempt - and the main Pi is quiet');
  });
  assert.strictEqual(f.calls.connects, 3);
  assert.ok(lines.some(l => /Could not sign in to Ring: Refresh token is not valid\. Trying again in an hour/.test(l)));
  assert.ok(f.calls.checkIns.some(c => c.state === 'ring-failed' && c.ring === 'failed'), '/status shows it');
});

test('the Ring sign-in is re-proved every 6 hours while standing by - never while capturing', async () => {
  let checkFails = false;
  const f = fakeStandby({ ringCheckFails: () => checkFails });
  const lines = await captureLogs(async () => {
    for (let i = 0; i < 288; i++) { await f.sb.gate(); f.advance(5 * 60000); }   // a day standing by
  });
  assert.strictEqual(f.calls.ringChecks, 3, 'at 6, 12 and 18 hours');
  assert.strictEqual(lines.filter(l => /Ring sign-in still works \("Dock Wired" online, "Downstream Lot" online\)/.test(l)).length, 3);
  f.w.mainSeen = 3600;
  await captureLogs(async () => { for (let i = 0; i < 288; i++) { await f.sb.gate(); f.advance(5 * 60000); } });
  assert.strictEqual(f.calls.ringChecks, 3, 'none while capturing: the captures prove it');
  // Back to standing by, it is checked at the next wake. A failed check is
  // visible, and looked at again an hour later.
  f.w.mainSeen = 60;
  checkFails = true;
  await captureLogs(async () => { await f.sb.gate(); });
  assert.strictEqual(f.calls.ringChecks, 3, 'not at the hand-back itself');
  await captureLogs(async () => { f.advance(5 * 60000); await f.sb.gate(); await flush(); });
  const before = f.calls.ringChecks;
  assert.strictEqual(before, 4);
  assert.strictEqual(f.sb.ring(), 'failed');
  assert.deepStrictEqual(f.calls.checkIns.slice(-1).map(c => [c.state, c.ring]), [['standing-by', 'failed']],
    'the Worker hears about it at once');
  await captureLogs(async () => { for (let i = 0; i < 12; i++) { f.advance(5 * 60000); await f.sb.gate(); } });
  assert.strictEqual(f.calls.ringChecks, before + 1, 'retried after an hour, not every 5 minutes');
  checkFails = false;
  await captureLogs(async () => { for (let i = 0; i < 12; i++) { f.advance(5 * 60000); await f.sb.gate(); } });
  assert.strictEqual(f.sb.ring(), 'ok');
});

test('a Ring sign-in that hangs never stops the standby checking in; it is adopted when it finishes', async () => {
  // ring-client-api retries an unreachable server for ever - a Pi-hole
  // blocklist covering ring.com would do it. The standby must keep checking in.
  let finish;
  const f = fakeStandby({ connect: () => new Promise(r => { finish = r; }) });
  f.w.mainSeen = 3600;
  const lines = await captureLogs(async () => {
    const t0 = Date.now();
    assert.strictEqual(await f.sb.gate(), false);
    assert.ok(Date.now() - t0 < 1000, 'waited only ringWaitMs');
    assert.strictEqual(f.sb.state(), 'starting');
    for (let i = 0; i < 3; i++) { f.advance(5 * 60000); assert.strictEqual(await f.sb.gate(), false, 'still checking in, still not capturing'); }
    finish();
    await flush();
    f.advance(5 * 60000);
    assert.strictEqual(await f.sb.gate(), true, 'signed in at last - and the main Pi is quiet');
  });
  assert.strictEqual(lines.filter(l => /Signing in to Ring is taking more than a minute/.test(l)).length, 1, lines.join(' | '));
  assert.strictEqual(f.calls.checkIns.filter(c => c.state === 'starting').length >= 4, true);
});

test('a Ring check that hangs is waited for briefly, then left to finish in the background', async () => {
  let checks = 0;
  const f = fakeStandby({ ringCheck: () => { checks++; return new Promise(() => {}); } });
  const lines = await captureLogs(async () => {
    for (let i = 0; i < 12 * 7; i++) { await f.sb.gate(); f.advance(5 * 60000); }   // seven hours
  });
  assert.strictEqual(checks, 1, 'one check at 6 hours, not a new one every 5 minutes behind it');
  assert.strictEqual(lines.filter(l => /Ring check is taking more than a minute/.test(l)).length, 1);
});

test('blocked after signing in: the standby signs out, and a sign-in still in progress is let go', async () => {
  const f = fakeStandby();
  await captureLogs(async () => {
    await f.sb.gate();                                     // signed in, standing by
    f.w.mainRingId = ID_STANDBY.ringId;                    // the main Pi now claims this Pi's Ring device
    f.advance(5 * 60000);
    assert.strictEqual(await f.sb.gate(), false);
  });
  assert.strictEqual(f.sb.state(), 'blocked');
  assert.strictEqual(f.calls.disconnects, 1, 'signed out at once');
  // A sign-in that was still under way when the block came is discarded when it lands.
  let finish;
  const g = fakeStandby({ connect: () => new Promise(r => { finish = r; }) });
  await captureLogs(async () => {
    await g.sb.gate();                                     // signing in (hangs)
    g.w.mainRingId = ID_STANDBY.ringId;
    g.advance(5 * 60000);
    await g.sb.gate();                                     // blocked
    finish();
    await flush(); await flush();
  });
  assert.strictEqual(g.sb.state(), 'blocked');
  assert.strictEqual(g.calls.disconnects, 1, 'the late sign-in is signed straight out again');
  g.w.mainSeen = 3600;
  await captureLogs(async () => { g.advance(5 * 60000); assert.strictEqual(await g.sb.gate(), false, 'and never captures'); });
});

test('two Pis checking in as the standby are warned about, hourly', async () => {
  const f = fakeStandby();
  f.w.conflict = true;
  const lines = await captureLogs(async () => { for (let i = 0; i < 13; i++) { await f.sb.gate(); f.advance(5 * 60000); } });
  assert.strictEqual(lines.filter(l => /checked in as the STANDBY Pi/.test(l)).length, 2);
});

test('the Ring readiness check names each camera and its connection, waking none', async () => {
  const api = { fetchRingDevices: async () => ({ allCameras: [
    { description: 'Dock Wired', alerts: { connection: 'online' } }, { description: 'Downstream Lot', alerts: { connection: 'offline' } },
    { description: 'Front Door', alerts: {} }] }) };
  assert.strictEqual(await S.ringReadiness(api, dualCfg), '"Dock Wired" online, "Downstream Lot" offline');
  assert.strictEqual(await S.ringReadiness(api, Object.assign({}, dualCfg, { backupCameraName: 'Garage' })),
    '"Dock Wired" online, "Garage" is not on the account');
  assert.strictEqual(await S.ringReadiness(api, Object.assign({}, dualCfg, { cameraName: '', backupCameraName: '' })), '3 cameras on the account');
  await assert.rejects(S.ringReadiness({ fetchRingDevices: async () => { throw new Error('401'); } }, dualCfg), /401/);
});

// ── The scheduler with a standby gate, whole days ──────────────────────────
//
// The main Pi is modelled as checking in at every 5-minute boundary (plus half
// a second) whenever it is alive; mainDead(at) says when it is not.

async function simulateStandby(from, to, opts = {}) {
  const { mainDead = () => false, primaryDown = () => false, backupDown = () => false,
          workerDown = () => false, connectFails = () => false } = opts;
  let t = from.getTime();
  const captures = [], checkIns = [], sleeps = [];
  let pending = null;
  const lastMainCheckIn = (now) => {
    let c = Math.floor((now - 500) / 300000) * 300000 + 500;
    for (let i = 0; i < 3000 && mainDead(new Date(c)); i++) c -= 300000;
    return mainDead(new Date(c)) ? null : c;
  };
  const sb = S.createStandby(standbyCfg, {
    now: () => new Date(t),
    identity: ID_STANDBY,
    checkIn: async (b) => {
      checkIns.push({ at: new Date(t), state: b.state });
      if (workerDown(new Date(t))) throw new Error('ECONNREFUSED');
      const c = lastMainCheckIn(t);
      return { ok: true, conflict: false, standby: null,
        main: c === null ? null : { lastSeenSecondsAgo: Math.round((t - c) / 1000), state: 'capturing', ringId: ID_MAIN_RING } };
    },
    connect: async () => { if (connectFails(new Date(t))) throw new Error('Refresh token is not valid.'); },
    ringCheck: async () => '"Dock Wired" online',
  });
  const tick = S.createScheduler(standbyCfg, {
    now: () => new Date(t),
    setTimer: (fn, ms) => { pending = { fn, ms }; sleeps.push(ms); },
    hasPrimary: () => true, hasBackup: () => true,
    gate: sb.gate, wakeOffsetMs: S.STANDBY_WAKE_OFFSET_MS, maxSleepSeconds: S.CHECK_IN_SECONDS,
    cycle: async (role) => {
      const at = new Date(t);
      t += 20000;
      const down = role === 'backup' ? backupDown(at) : primaryDown(at);
      captures.push({ role, at, ok: !down });
      if (down) throw Object.assign(new Error(`${role} offline`), { stage: 'capture' });
    },
  });
  await captureLogs(async () => {
    await tick();
    while (pending && t + pending.ms <= to.getTime()) {
      const p = pending; pending = null;
      t += p.ms;
      await p.fn();
    }
    await flush();
  });
  return { captures, checkIns, sleeps, sb, primary: captures.filter(c => c.role === 'primary'), backup: captures.filter(c => c.role === 'backup') };
}

test('a normal day: the main Pi checks in all day, and the standby never touches a camera', async () => {
  const r = await simulateStandby(ny(DAY, 0, 0), ny(NEXT, 0, 0));
  assert.strictEqual(r.captures.length, 0);
  const regular = r.checkIns.filter(c => nyClock(c.at).slice(6, 8) === '30');
  assert.ok(regular.length >= 287, `checks in every 5 minutes, 30 s into the slot (${regular.length})`);
  assert.ok(Math.max(...r.sleeps) <= 300000 + 30000, 'never sleeps more than 5 minutes');
  assert.strictEqual(r.sb.state(), 'standing-by');
});

test('the main Pi dies at 9:02: the standby takes over at 9:15 and captures every 15 minutes; hands back at 11:00', async () => {
  const r = await simulateStandby(ny(DAY, 8, 0), ny(DAY, 12, 0), { mainDead: between(9 + 2 / 60, 11) });
  const times = r.primary.map(c => nyClock(c.at));
  assert.deepStrictEqual(times, ['09:15:30', '09:30:30', '09:45:30', '10:00:30', '10:15:30', '10:30:30', '10:45:30'],
    'from 15 minutes after the last check-in at 9:00, on the main Pi\'s own slots, until it is back');
  assert.strictEqual(r.backup.length, 0);
  assert.ok(!times.includes('11:00:30'), 'the main Pi checked in at 11:00:00; the standby saw it at 11:00:30');
});

test('the main Pi alive but its dock camera down: the standby leaves both cameras alone', async () => {
  // The main Pi is using the battery camera; a second Pi waking it too would double the drain.
  const r = await simulateStandby(ny(DAY, 0, 0), ny(NEXT, 0, 0), { primaryDown: () => true });
  assert.strictEqual(r.captures.length, 0);
});

test('takeover with the dock down: the standby runs the main Pi\'s backup timetable, and stops it on hand-back', async () => {
  const r = await simulateStandby(ny(DAY, 8, 0), ny(DAY, 13, 0), { mainDead: between(8, 12), primaryDown: between(8, 13) });
  assert.strictEqual(nyClock(r.primary[0].at), '08:10:30', 'last main check-in 7:55:00, so quiet for 15 min at 8:10');
  assert.deepStrictEqual(r.backup.map(c => hhmm(c.at)), ['08:15', '08:30', '09:00', '09:30', '10:00', '11:00'],
    'after two dock misses (8:10, 8:15), then its own slots - nothing at 12:00, the main Pi is back');
});

test('a second takeover starts afresh from the dock camera - two new misses before the battery camera', async () => {
  // First outage 8:00-8:30: the standby misses the dock, uses the battery
  // camera, then hands back. Second outage from 9:00: it must not carry those
  // misses over - the battery camera only after two new ones (9:10, 9:15).
  const mainDead = (at) => between(8, 8.5)(at) || between(9, 10)(at);
  const r = await simulateStandby(ny(DAY, 7, 30), ny(DAY, 10, 30), { mainDead, primaryDown: () => true });
  assert.deepStrictEqual(r.backup.map(c => hhmm(c.at)), ['08:15', '09:15', '09:30'], 'not 9:10');
});

test('a standby question that throws means standing by', async () => {
  let t = ny(DAY, 9, 0).getTime(), pending = null, captures = 0;
  const lines = await captureLogs(async () => {
    const tick = S.createScheduler(standbyCfg, { now: () => new Date(t), setTimer: (fn, ms) => { pending = { fn, ms }; },
      gate: async () => { throw new Error('bug'); }, cycle: async () => { captures++; } });
    await tick();
    for (let i = 0; i < 5; i++) { const p = pending; t += p.ms; await p.fn(); }
  });
  assert.strictEqual(captures, 0);
  assert.ok(lines.some(l => /standby check failed: bug/.test(l)));
});

test('the main Pi dies at night with the dock down: the battery camera still sleeps until 5:00', async () => {
  const r = await simulateStandby(ny(DAY, 21, 0), ny(NEXT, 7, 0), { mainDead: between(22, 6), primaryDown: between(22, 6) });
  assert.deepStrictEqual(r.backup.map(c => hhmm(c.at)), ['05:00', '05:30']);
  assert.strictEqual(r.primary.length, 32, 'the dock was tried every 15 minutes all night: the 22:00 slot at 22:10, then 22:15 to 5:45');
  assert.ok(!r.primary.some(c => hhmm(c.at) === '06:00'), 'handed back at 6:00');
});

test('a Worker outage while the main Pi is quiet: no takeover on no news', async () => {
  const r = await simulateStandby(ny(DAY, 8, 0), ny(DAY, 12, 0), { mainDead: between(9, 12), workerDown: between(9, 10) });
  assert.strictEqual(nyClock(r.primary[0].at), '10:00:30', 'not before the Worker can say the main Pi is quiet');
  assert.strictEqual(r.primary.length, 8, '10:00 to 11:45, every 15 minutes');
});

test('a Worker outage while capturing: the standby carries on', async () => {
  const r = await simulateStandby(ny(DAY, 8, 0), ny(DAY, 12, 0), { mainDead: between(9, 12), workerDown: between(10, 10.5) });
  assert.strictEqual(nyClock(r.primary[0].at), '09:10:30');
  assert.strictEqual(r.primary.length, 12, 'every slot from 9:00 (at 9:10) to 11:45, the outage included');
});

test('a standby that cannot sign in to Ring does not capture until it can', async () => {
  const r = await simulateStandby(ny(DAY, 8, 0), ny(DAY, 12, 0), { mainDead: () => true, connectFails: (at) => hhmm(at) < '10:00' });
  assert.ok(r.primary.length > 0, 'it does, once signed in');
  assert.ok(hhmm(r.primary[0].at) >= '10:00', nyClock(r.primary[0].at));
});

// ── The main Pi's side: check-ins never get in the way of a capture ─────────

async function simulateMain(cfg, from, to, heartbeat) {
  let t = from.getTime();
  const captures = [], sleeps = [];
  let pending = null;
  const tick = S.createScheduler(cfg, {
    now: () => new Date(t),
    setTimer: (fn, ms) => { pending = { fn, ms }; sleeps.push(ms); },
    hasPrimary: true, hasBackup: true,
    cycle: async (role) => { captures.push({ role, at: new Date(t) }); t += 20000; },
    heartbeat, maxSleepSeconds: S.CHECK_IN_SECONDS,
  });
  await tick();
  while (pending && t + pending.ms <= to.getTime()) {
    const p = pending; pending = null;
    t += p.ms;
    await p.fn();
  }
  return { captures, sleeps };
}

test('the main Pi checks in on every 5-minute mark - 288 a day - and its captures are unchanged', async () => {
  let beats = 0;
  const r = await simulateMain(mainCfg, ny(DAY, 0, 0), ny(NEXT, 0, 0), () => { beats++; });
  assert.strictEqual(r.captures.length, 96, 'the dock camera every 15 minutes, as without a standby');
  assert.strictEqual(beats, 288);
  assert.deepStrictEqual(r.captures.slice(0, 3).map(c => nyClock(c.at)), ['00:00:00', '00:15:00', '00:30:00'], 'on the slot, to the second');
  assert.ok(r.sleeps.every(ms => ms <= 300500), 'never more than 5 minutes between check-ins');
});

test('a check-in that hangs, throws or rejects never delays or stops a capture', async () => {
  for (const hb of [() => new Promise(() => {}), () => { throw new Error('boom'); }, async () => { throw new Error('boom'); }]) {
    const r = await simulateMain(mainCfg, ny(DAY, 0, 0), ny(NEXT, 0, 0), hb);
    assert.strictEqual(r.captures.length, 96);
    assert.ok(r.captures.every(c => Number(nyClock(c.at).slice(6, 8)) <= 1), 'on the slot, not after a check-in');
  }
});

test('with a daytime-only timetable the main Pi still checks in every 5 minutes, and captures no more', async () => {
  let beats = 0;
  const r = await simulateMain(prodCfg, ny(DAY, 0, 0), ny(NEXT, 0, 0), () => { beats++; });
  assert.deepStrictEqual(r.captures.map(c => hhmm(c.at)), PROD_SLOTS);
  assert.ok(beats >= 287 && beats <= 289, String(beats));
  assert.ok(Math.max(...r.sleeps) <= 300500);
});

test('every upload says which Pi sent it', async () => {
  const calls = [];
  const f = async (url, opts) => { calls.push(opts.headers); return { ok: true }; };
  await S.uploadSnapshot(JPEG, mainCfg, f, { role: 'primary', name: 'Dock Wired' });
  await S.uploadSnapshot(JPEG, S.backupConfig(standbyCfg), f, { role: 'backup', name: 'Downstream Lot' });
  await S.uploadSnapshot(JPEG, baseCfg, f, { role: 'primary', name: 'Dock Wired' });
  assert.deepStrictEqual(calls.map(h => h['X-Camera-Pi']), ['main', 'standby', undefined]);
});

test('the service wires the check-ins: the main Pi beats, the standby asks before every slot', () => {
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const main = src.slice(src.indexOf('async function main()'), src.indexOf('async function runStandby('));
  assert.ok(/heartbeat: createMainCheckIn\(CONFIG/.test(main), 'the main Pi checks in from its capture loop');
  assert.ok(/maxSleepSeconds: CHECK_IN_SECONDS/.test(main));
  const standby = src.slice(src.indexOf('async function runStandby('));
  assert.ok(/gate: standby\.gate/.test(standby) && /wakeOffsetMs: STANDBY_WAKE_OFFSET_MS/.test(standby));
  assert.ok(/'NHRC Boathouse Camera \(standby\)'/.test(src), 'listed separately in Ring Control Center');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6f. Two Pis end to end: real service processes and the real Worker');
// ═══════════════════════════════════════════════════════════════════════════

const STANDBY_ENV = { CAMERA_PI: 'standby' };
const seedMain = (box, minutesAgo, extra = {}) => box.host.env.BUCKET.setRecord('main', Object.assign({
  at: Date.now() - minutesAgo * 60000, state: 'capturing', ring: 'ok', instance: 'aaaaaaaaaaaaaaaa',
  ringId: S.ringIdentity(ringToken('hid-main-pi')), conflictAt: null }, extra));

test('end to end: the main Pi checks in with the real Worker, and its photos say they are from it', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  box.setToken(ringToken('hid-main-pi'));
  const r = await box.run([], {}, { stopAfter: 1, settleMs: 400 });
  assert.deepStrictEqual(r.uploads.map(u => [u.role, u.pi]), [['primary', 'main']], r.out);
  const rec = box.host.env.BUCKET.record('main');
  assert.deepStrictEqual([rec.state, rec.ring, rec.ringId], ['capturing', 'ok', S.ringIdentity(ringToken('hid-main-pi'))]);
  assert.ok(/^[0-9a-f]{16}$/.test(rec.instance));
  const st = await box.host.status();
  assert.strictEqual(st.pi, 'main');
  assert.strictEqual(st.pis.main.lastSeenSecondsAgo, 0);
  assert.ok(/This is the MAIN Pi\. It checks in with the Worker every 5 min/.test(r.out));
  assert.ok(!r.out.includes(ringToken('hid-main-pi')), 'the token never reaches the log');
  assert.ok(box.ringEvents().some(e => e.ev === 'construct' && e.displayName === 'NHRC Boathouse Camera'));
});

test('end to end: the standby stands by while the main Pi checks in - signed in to Ring, no camera touched', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  box.setToken(ringToken('hid-standby-pi'));
  await seedMain(box, 1);
  const r = await box.run([], STANDBY_ENV, { until: (out) => /Standing by: the main Pi checked in/.test(out), settleMs: 700 });
  assert.deepStrictEqual(r.uploads, [], r.out);
  assert.ok(!box.ringEvents().some(e => e.ev === 'snapshot'), 'no camera woken');
  assert.ok(box.ringEvents().some(e => e.ev === 'construct' && e.displayName === 'NHRC Boathouse Camera (standby)'));
  assert.ok(box.ringEvents().some(e => e.ev === 'getCameras'), 'signed in and found the cameras, ready');
  const rec = box.host.env.BUCKET.record('standby');
  assert.deepStrictEqual([rec.state, rec.ring], ['standing-by', 'ok'], JSON.stringify(rec));
  assert.ok(/This is the STANDBY Pi/.test(r.out) && /Standing by: the main Pi checked in 60 s ago/.test(r.out), r.out);
  assert.deepStrictEqual((await box.host.status()).pis.standby.state, 'standing-by');
});

test('end to end: the main Pi quiet for 20 minutes - the standby takes over, and says its photos are its own', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  box.setToken(ringToken('hid-standby-pi'));
  await seedMain(box, 20);
  const r = await box.run([], STANDBY_ENV, { stopAfter: 1, settleMs: 500 });
  assert.deepStrictEqual(r.uploads.map(u => [u.role, u.name, u.pi]), [['primary', 'Dock Wired', 'standby']], r.out);
  assert.ok(/The main Pi has not checked in for 20 min - this Pi is taking over the cameras/.test(r.out), r.out);
  assert.strictEqual(box.host.env.BUCKET.record('standby').state, 'capturing');
  const st = await box.host.status();
  assert.strictEqual(st.pi, 'standby');
  assert.ok(st.pis.main.lastSeenSecondsAgo >= 1195, 'the standby\'s photo does not make the main Pi look alive');
});

test('end to end: a standby with the main Pi\'s Ring device never signs in to Ring, even with the main Pi quiet', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  box.setToken(ringToken('hid-main-pi'));   // a copied token file
  await seedMain(box, 30);
  let r = await box.run([], STANDBY_ENV, { until: (out) => /same device as the main Pi/.test(out), settleMs: 700 });
  assert.deepStrictEqual(box.ringEvents(), [], 'not one call to the Ring library');
  assert.deepStrictEqual(r.uploads, []);
  assert.strictEqual(box.host.env.BUCKET.record('standby').state, 'blocked');
  assert.ok(r.code === null || r.code === 0 || r.signal, 'it stays up, saying why');
  r = await box.run(['--once'], STANDBY_ENV);
  assert.strictEqual(r.code, 1, r.out);
  assert.ok(/same device as the main Pi/.test(r.out));
  assert.deepStrictEqual(box.ringEvents(), [], '--once refuses before touching Ring too');
  r = await box.run(['--status'], STANDBY_ENV);
  assert.strictEqual(r.code, 1, '--status reports it as a failure');
});

test('end to end: against a Worker that predates check-ins, the standby never touches Ring; the main Pi carries on', async () => {
  const old = { intercept: (e) => (e.path === '/heartbeat' ? { status: 405, body: 'Method not allowed' } : null) };
  let box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }], old);
  box.setToken(ringToken('hid-standby-pi'));
  let r = await box.run([], STANDBY_ENV, { until: (out) => /HTTP 405/.test(out), settleMs: 700 });
  assert.deepStrictEqual(box.ringEvents(), []);
  assert.deepStrictEqual(r.uploads, []);
  assert.ok(/does not know check-ins yet: update it/.test(r.out), r.out);
  box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }], old);
  r = await box.run([], {}, { stopAfter: 1, settleMs: 500 });
  assert.deepStrictEqual(r.uploads.map(u => u.role), ['primary'], 'the cameras do not depend on check-ins');
  assert.ok(/does not know check-ins yet/.test(r.out));
});

test('end to end: a standby that cannot sign in to Ring keeps running and says so', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  box.setToken(ringToken('hid-standby-pi'));
  await seedMain(box, 30);
  const r = await box.run([], Object.assign({ TEST_RING_FAIL_AUTH: '1' }, STANDBY_ENV),
    { until: (out) => /Could not sign in to Ring/.test(out), settleMs: 700 });
  assert.ok(r.signal === 'SIGTERM', `still running when stopped (exit ${r.code}): ${r.out}`);
  assert.deepStrictEqual(r.uploads, []);
  const rec = box.host.env.BUCKET.record('standby');
  assert.deepStrictEqual([rec.state, rec.ring], ['ring-failed', 'failed'], JSON.stringify(rec));
});

test('end to end: both Pis running together - every photo comes from the main Pi', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  // Two sandboxes would mean two Workers; instead the two processes share one,
  // each with its own token file.
  const standbyToken = path.join(box.dir, 'token-standby');
  fs.writeFileSync(standbyToken, ringToken('hid-standby-pi'));
  box.setToken(ringToken('hid-main-pi'));
  const mainRun = box.run([], {}, { maxMs: 3500 });
  await new Promise(r => setTimeout(r, 700));     // the main Pi starts first, as after a reboot of both
  const standbyRun = box.run([], Object.assign({ RING_TOKEN_FILE: standbyToken }, STANDBY_ENV),
    { until: (out) => /Standing by/.test(out), settleMs: 600 });
  const [m, s] = await Promise.all([mainRun, standbyRun]);
  assert.ok(box.uploads().length >= 1, m.out);
  assert.ok(box.uploads().every(u => u.pi === 'main'), JSON.stringify(box.uploads()));
  assert.ok(/Standing by: the main Pi checked in \d+ s ago/.test(s.out), s.out);
  assert.ok(!/taking over/.test(s.out));
  const st = await box.host.status();
  assert.deepStrictEqual([st.pis.main.state, st.pis.standby.state], ['capturing', 'standing-by']);
  assert.strictEqual(st.pis.main.conflict || st.pis.standby.conflict, false);
});

test('end to end (clock x60): the standby takes over, captures each slot, and hands back when the main Pi returns', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  box.setToken(ringToken('hid-standby-pi'));
  await seedMain(box, 20);
  let returned = false;
  const r = await box.run([], Object.assign({ TEST_CLOCK_SPEED: '60' }, STANDBY_ENV), {
    until: (out) => {
      // After two standby photos, the main Pi comes back.
      if (!returned && box.uploads().length >= 2) { returned = true; seedMain(box, 0); }
      return /back to standing by/.test(out);
    },
    settleMs: 6000,                                   // a further simulated 6 minutes: one more check, no capture
    maxMs: 25000,
  });
  assert.ok(/taking over the cameras/.test(r.out) && /The main Pi is checking in again .* back to standing by/.test(r.out), r.out);
  const ups = box.uploads();
  assert.ok(ups.length >= 2 && ups.length <= 3, `${ups.length} standby photos`);
  assert.ok(ups.every(u => u.pi === 'standby' && u.role === 'primary'));
  assert.strictEqual(box.host.env.BUCKET.record('standby').state, 'standing-by');
  const snaps = box.ringEvents().filter(e => e.ev === 'snapshot').length;
  assert.strictEqual(snaps, ups.length, 'no capture after handing back');
});

test('end to end: --check and --status describe the Pi; CAMERA_PI is read leniently and checked', async () => {
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  box.setToken(ringToken('hid-standby-pi'));
  let r = await box.run(['--check'], { CAMERA_PI: ' Standby ' });
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/this Pi {6}: the STANDBY - runs the cameras only when the main Pi has not checked in for 15 min/.test(r.out), r.out);
  r = await box.run(['--check'], {});
  assert.ok(/the MAIN Pi - runs the cameras, and checks in with the Worker every 5 min/.test(r.out));
  r = await box.run(['--check'], { CAMERA_PI: 'backup' });
  assert.strictEqual(r.code, 1);
  assert.ok(/CAMERA_PI must be "main" or "standby"/.test(r.out));
  r = await box.run(['--check'], { CAMERA_PI: 'standby', STANDBY_TAKEOVER_MINUTES: '5' });
  assert.strictEqual(r.code, 1);
  await seedMain(box, 2);
  r = await box.run(['--status'], STANDBY_ENV);
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(/main Pi {4}: checked in 2 min ago \(capturing\)/.test(r.out), r.out);
  assert.ok(/standby Pi : has never checked in/.test(r.out));
  assert.ok(/Ring login : separate from the other Pi's/.test(r.out));
  assert.ok(/This standby would stand by: it takes over after 15 min/.test(r.out));
  assert.deepStrictEqual(box.ringEvents(), [], '--status makes no Ring call');
  assert.strictEqual(box.host.env.BUCKET.record('standby'), null, 'and records nothing');
});

/**
 * A stand-in ring-client-api, installed in dir, whose live view is a real
 * 1080p stream (ffmpeg sending RTP through a relay, as Ring's would arrive),
 * noting every call - and which Pi made it - in ringLog.
 */
function liveRingLibrary(dir, ringLog) {
  const pkg = path.join(dir, 'node_modules', 'ring-client-api');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ring-client-api', type: 'module',
    exports: { '.': './index.js', './util': './util.js' } }));
  // Like ring-client-api/util: the service hands it a logger.
  fs.writeFileSync(path.join(pkg, 'util.js'), 'export function useLogger(l) { globalThis.ringLogger = l; }');
  fs.writeFileSync(path.join(pkg, 'index.js'), `
    import fs from 'fs'; import dgram from 'dgram'; import { spawn } from 'child_process';
    const note = (o) => fs.appendFileSync(${JSON.stringify(ringLog)}, JSON.stringify(Object.assign({ pi: process.env.CAMERA_PI || 'main' }, o)) + String.fromCharCode(10));
    const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, 1, 104, 2, 128, 3, 1, 34, 0, 2, 17, 1, 3, 17, 1, 0xFF, 0xD9]);
    let ffmpegPath = null;
    class Call {
      constructor() { this.h = []; this.ended = false; this.subs = []; this.msgs = []; this.msgSubs = []; this.answered = false; this.ans = [];
        this.onCallEnded = { subscribe: (fn) => { if (this.ended) fn(); else this.h.push(fn); return { unsubscribe() {} }; } };
        this.onVideoRtp = { subscribe: (fn) => { this.subs.push(fn); return { unsubscribe: () => { this.subs = []; } }; } };
        this.connection = {
          onMessage: { subscribe: (fn) => { this.msgs.forEach(fn); this.msgSubs.push(fn); return { unsubscribe() {} }; } },
          onCallAnswered: { subscribe: (fn) => { if (this.answered) fn('v=0'); else this.ans.push(fn); return { unsubscribe() {} }; } } }; }
      message(m) { this.msgs.push(m); this.msgSubs.forEach(fn => fn(m)); }
      end() { if (this.ended) return; this.ended = true; note({ ev: 'call-ended' });
        try { this.sender && this.sender.kill('SIGKILL'); } catch (e) {}
        try { this.ff && this.ff.kill('SIGTERM'); } catch (e) {}
        for (const s of [this.relay, this.out]) { try { s && s.close(); } catch (e) {} }
        this.h.forEach(f => f()); }
      stop() { this.end(); }
      async startTranscoding(o) {
        this.message({ method: 'session_created', body: {} });
        this.answered = true; this.message({ method: 'sdp', body: {} }); this.ans.forEach(fn => fn('v=0'));
        const closing = !!process.env.FAKE_RING_CLOSE;
        if (closing) {
          // Ring closes the live view before ffmpeg has the stream's description,
          // and says so through the library's logger - as ring-client-api does.
          setTimeout(() => {
            const body = { reason: { code: 42, text: 'stand-in camera busy' }, token: 'S3CRET-T0KEN' };
            if (globalThis.ringLogger) { globalThis.ringLogger.logError('Video stream closed'); globalThis.ringLogger.logError(body); }
            this.message({ method: 'close', body });
            this.end();
          }, 1500);
        }
        const rp = 45000 + Math.floor(Math.random() * 4000) * 2, vp = rp + 9000;
        const sdpFile = ${JSON.stringify(dir)} + '/s' + rp + '.sdp';
        // The camera's ffmpeg: another name (a link), no report - see FakeLiveCall.
        const senderEnv = Object.assign({}, process.env); delete senderEnv.FFREPORT;
        this.sender = spawn(${JSON.stringify(path.join(dir, 'ffsender'))}, ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=15', '-t', '40',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-bf', '0', '-an', '-f', 'rtp', '-sdp_file', sdpFile, 'rtp://127.0.0.1:' + rp],
          { env: senderEnv });
        this.relay = dgram.createSocket('udp4'); this.out = dgram.createSocket('udp4');
        this.relay.on('message', (m) => { const nal = m[12] & 31;
          if (closing && (nal === 7 || nal === 8 || nal === 24)) return;
          const seq = m.readUInt16BE(2); this.subs.forEach(fn => fn({ header: { sequenceNumber: seq }, payload: m.subarray(12) }));
          if (!this.ended) this.out.send(m, vp, '127.0.0.1'); });
        this.relay.bind(rp, '127.0.0.1');
        for (let k = 0; k < 100 && !fs.existsSync(sdpFile); k++) await new Promise(r => setTimeout(r, 50));
        const sdp = fs.readFileSync(sdpFile, 'utf8').replace(/m=video \\d+/, 'm=video ' + vp);
        const args = ['-hide_banner', '-protocol_whitelist', 'pipe,udp,rtp,file,crypto', '-f', 'sdp', ...(o.input || []), '-i', 'pipe:',
          ...(o.audio || []), ...(o.video || []), ...(o.output || [])];
        note({ ev: 'ffmpeg', path: ffmpegPath, args });
        this.ff = spawn(ffmpegPath || 'ffmpeg', args.map(String), { stdio: ['pipe', 'ignore', 'ignore'] });
        this.ff.on('error', () => this.end());
        this.ff.on('exit', () => this.end());
        this.ff.stdin.on('error', () => {});
        this.ff.stdin.end(sdp);
      }
    }
    export class RingApi {
      constructor(opts) { ffmpegPath = opts.ffmpegPath || null; note({ ev: 'construct', ffmpegPath: opts.ffmpegPath || null });
        this.onRefreshTokenUpdated = { subscribe() {} }; }
      async getCameras() {
        note({ ev: 'getCameras' });
        // Stands in for a Pi Zero's slow sign-in to Ring.
        if (process.env.FAKE_SLOW_CAMERAS_MS) await new Promise(r => setTimeout(r, Number(process.env.FAKE_SLOW_CAMERAS_MS)));
        return ['Dock Wired', 'Downstream Lot'].map(name => ({ name, id: name === 'Dock Wired' ? 101 : 202,
          async getSnapshot() { note({ ev: 'snapshot', camera: name }); return JPEG; },
          // Ring's health report, as the real library fetches it.
          async getHealth() { note({ ev: 'health', camera: name });
            return { battery_percentage: process.env.FAKE_BATTERY || '87', latest_signal_strength: -61 }; },
          async startLiveCall() { note({ ev: 'live', camera: name });
            // Stands in for the service being killed mid-capture (for memory, say).
            if (process.env.FAKE_DIE_ON_LIVE) process.kill(process.pid, 'SIGKILL');
            return new Call(); } }));
      }
      async fetchRingDevices() { note({ ev: 'devices' });
        return { allCameras: [{ description: 'Dock Wired', id: 101, alerts: { connection: 'online' } },
          { description: 'Downstream Lot', id: 202, alerts: { connection: 'online' } }] }; }
      disconnect() { note({ ev: 'disconnect' }); }
    }`);
  fs.symlinkSync('/usr/bin/ffmpeg', path.join(dir, 'ffsender'));
}

// ═══════════════════════════════════════════════════════════════════════════
section('6g. Timelapse: full-resolution frames at set times, gentle on the Pi');
// ═══════════════════════════════════════════════════════════════════════════
//
// The Pi also serves the house's DNS. The timelapse must never disturb the
// dock photos, never save a damaged picture, always clean up after itself,
// and stop every step at a deadline.

const HAVE_FFMPEG = fs.existsSync('/usr/bin/ffmpeg') && fs.existsSync('/usr/bin/ffprobe');
const tlDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-test-'));
const tlCfg = (dir, over = {}) => Object.assign({}, S.CONFIG, {
  timeZone: 'America/New_York', cameraName: 'Dock Wired', backupCameraName: 'Downstream Lot',
  uploadUrl: baseCfg.uploadUrl, uploadSecret: baseCfg.uploadSecret,
  // The set times, recording the whole 8 s (no early stop), no battery check:
  // as the timelapse was first built. The every-few-minutes tests set more.
  timelapse: Object.assign({ times: S.parseTimeList('8:00,12:00,15:00'), everyMinutes: 0, from: 'sunrise', until: 'sunset',
    latitude: 41.437, longitude: -73.119, cameraName: 'Downstream Lot', dir,
    ffmpegPath: '/usr/bin/ffmpeg', recordSeconds: 8, targetHeight: 0, minBattery: 0, workDir: '', maxRssMb: 160,
    minDiskMb: 100, minMemoryMb: 40, snapshotPauseSeconds: 20 }, over),
});
/** What is in a folder, without the hidden note of the times tried. */
const visible = (dir) => fs.readdirSync(dir).filter(f => !f.startsWith('.'));
/** A minimal JPEG whose start-of-frame says w x h - enough for jpegSize. */
const fakeJpeg = (w, h) => Buffer.from([0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255,
  3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xFF, 0xD9]);
async function captureLogs(fn) {
  const lines = [];
  const ol = console.log, oe = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = ol; console.error = oe; }
  return lines;
}
const leftoverWorkDirs = () => fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('nhrc-timelapse-'));

test('the timelapse decodes single-threaded, refuses damaged frames, and is bounded at every step', () => {
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const decode = src.slice(src.indexOf('async function decodeKeyframe'), src.indexOf('/** Counts RTP packets'));
  assert.ok(/'-threads', '1'/.test(decode) && decode.indexOf("'-threads'") < decode.indexOf("'-i'"), 'decoder limited to one thread');
  assert.ok(/'-xerror', '-err_detect', 'explode'/.test(decode), 'a damaged keyframe is an error, not a picture');
  const tool = src.slice(src.indexOf('function runTool'), src.indexOf('/** Keyframe times'));
  assert.ok(/const kill = \(\) => \{ try \{ p\.kill\('SIGKILL'\)/.test(tool) && /setTimeout\(kill, timeoutMs\)/.test(tool),
    'every ffmpeg run is killed at its deadline');
  assert.ok(/if \(halt\) halt\.kills\.add\(kill\)/.test(tool), '... and at once when the capture is stopped');
  assert.strictEqual(S.CAPTURE_TIMEOUT_MS, 6 * 60 * 1000);
  assert.strictEqual(S.MAX_KEYFRAMES_TRIED, 4);
});

test('timelapse times are read leniently and checked', () => {
  assert.deepStrictEqual(S.parseTimeList('8:00,12:00,15:00').map(t => [t.label, t.minutes]), [['08:00', 480], ['12:00', 720], ['15:00', 900]]);
  assert.deepStrictEqual(S.parseTimeList(' 15:00, 8 ,12:30,8:00 ').map(t => t.label), ['08:00', '12:30', '15:00'], 'sorted, each once');
  assert.deepStrictEqual(S.parseTimeList(''), []);
  assert.deepStrictEqual(S.parseTimeList(undefined), []);
  for (const bad of ['25:00', '8:61', 'noon', '8:5']) {
    assert.ok(Number.isNaN(S.parseTimeList(bad)[0].minutes), bad);
    assert.ok(S.validateConfig(tlCfg('/tmp/x', { times: S.parseTimeList(bad) })).some(p => /TIMELAPSE_TIMES/.test(p)), bad);
  }
});

test('the timelapse is OFF unless TIMELAPSE_EVERY_MINUTES or TIMELAPSE_TIMES is set, and its settings are validated', () => {
  assert.strictEqual(S.timelapseOn(S.CONFIG), false, 'off by default: installing the code changes nothing');
  assert.strictEqual(S.intervalOn(S.CONFIG), false);
  assert.deepStrictEqual(S.validateConfig(tlCfg('/opt/nhrc-camera/timelapse')), []);
  const v = (over) => S.validateConfig(tlCfg('/opt/nhrc-camera/timelapse', over));
  assert.ok(v({ cameraName: '' }).some(p => /TIMELAPSE_CAMERA_NAME/.test(p)));
  for (const s of [3, 61, 7.5, NaN]) assert.ok(v({ recordSeconds: s }).some(p => /TIMELAPSE_RECORD_SECONDS must be a whole number from 4 to 60/.test(p)), String(s));
  for (const s of [4, 20, 45, 60]) assert.deepStrictEqual(v({ recordSeconds: s }), [], String(s));
  assert.strictEqual(S.CONFIG.timelapse.recordSeconds, 45, 'up to 45 s by default, to give the camera time to reach 1080p');
  assert.ok(v({ dir: 'timelapse' }).some(p => /TIMELAPSE_DIR/.test(p)));
  assert.ok(v({ ffmpegPath: 'ffmpeg' }).some(p => /FFMPEG_PATH/.test(p)));
  assert.ok(v({ minDiskMb: 50 }).some(p => /TIMELAPSE_MIN_DISK_MB/.test(p)));
  for (const m of [0, 10, 19, NaN]) assert.ok(v({ minMemoryMb: m }).some(p => /TIMELAPSE_MIN_MEMORY_MB must be at least 20/.test(p)), String(m));
  assert.deepStrictEqual(v({ minMemoryMb: 20 }), []);
  for (const p of [-1, 121, 2.5, NaN]) assert.ok(v({ snapshotPauseSeconds: p }).some(x => /TIMELAPSE_SNAPSHOT_PAUSE_SECONDS/.test(x)), String(p));
  assert.deepStrictEqual(v({ snapshotPauseSeconds: 0 }), []);
  assert.strictEqual(S.CONFIG.timelapse.snapshotPauseSeconds, 20);
  assert.deepStrictEqual(S.validateConfig(baseCfg), [], 'configs without a timelapse are untouched');
  assert.strictEqual(S.CONFIG.timelapse.minMemoryMb, 40, 'by default 40 MB is kept for Pi-hole');
  assert.strictEqual(S.CONFIG.timelapse.minDiskMb, 500);
  assert.strictEqual(S.LIVE_MEMORY_NEED_MB, 40, 'so the live video starts only with 80 MB available');
  // The timelapse's problems never stop the service: they are kept apart.
  assert.deepStrictEqual(S.serviceProblems(tlCfg('/x', { recordSeconds: 3 })), []);
  assert.ok(S.timelapseProblems(tlCfg('/x', { recordSeconds: 3 })).length === 1);
});

test('a time is due for one dock slot (15 minutes), once: not before, not after, not twice', () => {
  const cfg = tlCfg('/nowhere');
  const none = () => false;
  const due = (h, m, s = 0, exists = none, tried = new Set()) => S.timelapseDue(ny(DAY, h, m, s), cfg, exists, tried).map(j => j.time.label);
  assert.deepStrictEqual(due(7, 59, 59), []);
  assert.deepStrictEqual(due(8, 0, 1), ['08:00']);
  assert.deepStrictEqual(due(8, 14, 59), ['08:00'], 'a restart at 8:14 still catches it');
  assert.deepStrictEqual(due(8, 15, 0), []);
  assert.deepStrictEqual(due(12, 0, 1), ['12:00']);
  assert.deepStrictEqual(due(15, 0, 1), ['15:00']);
  assert.deepStrictEqual(due(8, 0, 1, (f) => /2026-08-15_0800\.jpg$/.test(f)), [], 'already saved');
  assert.deepStrictEqual(due(8, 0, 1, (f) => /2026-08-15_0800_snapshot\.jpg$/.test(f)), [], 'saved as a snapshot counts too');
  assert.deepStrictEqual(due(8, 0, 1, none, new Set(['2026-08-15 08:00'])), [], 'tried already today');
  assert.strictEqual(path.basename(S.timelapseFile(cfg, '2026-08-15', S.parseTimeList('8:00')[0])), '2026-08-15_0800.jpg');
  assert.strictEqual(path.basename(S.timelapseFile(cfg, '2026-08-15', S.parseTimeList('15:00')[0], 'snapshot')), '2026-08-15_1500_snapshot.jpg');
});

/** createTimelapse with a scripted live view and camera; records what it was asked. */
function fakeTimelapse(dir, opts = {}) {
  let t = (opts.start || ny(DAY, 8, 0, 1)).getTime();
  const calls = { live: 0, snap: 0 };
  const camera = opts.noCamera ? null : {
    name: 'Downstream Lot',
    getSnapshot: async () => { calls.snap++; if (opts.snapFails) throw new Error('Snapshot for Downstream Lot failed to refresh after 15 seconds'); return fakeJpeg(640, 360); },
  };
  const tl = S.createTimelapse(tlCfg(dir, opts.cfg || {}), {
    camera: () => camera,
    now: () => new Date(t),
    captureTimeoutMs: opts.captureTimeoutMs,
    afterLiveMs: opts.afterLiveMs || 0,
    snapshotRetryMs: opts.snapshotRetryMs || 0,
    liveFrame: opts.liveFrame || (async (cam, workDir) => {
      calls.live++;
      if (opts.liveFails) throw new Error('no clean keyframe (8.1 s damaged; 300 of 900 packets missing)');
      const frame = path.join(workDir, 'frame.jpg');
      fs.writeFileSync(frame, fakeJpeg(1920, 1080));
      return { frame, liveSeconds: 26, missing: 2, received: 768, checked: ['8.1 s clean'] };
    }),
  });
  return { tl, calls, advance: (ms) => { t += ms; } };
}

test('at 8:00 a full-resolution frame is saved on the Pi, once, and the temporary files are removed', async () => {
  const dir = tlDir();
  const before = leftoverWorkDirs().length;
  const f = fakeTimelapse(dir);
  const lines = await captureLogs(async () => { await f.tl.maybeCapture(); f.advance(5 * 60000); await f.tl.maybeCapture(); });
  assert.deepStrictEqual(visible(dir), ['2026-08-15_0800.jpg']);
  assert.strictEqual(f.calls.live, 1, 'not captured twice in its window');
  assert.strictEqual(f.calls.snap, 0, 'the battery camera woken once only');
  assert.strictEqual(fs.statSync(path.join(dir, '2026-08-15_0800.jpg')).mode & 0o777, 0o644, 'readable for copying off');
  assert.ok(lines.some(l => /Timelapse 2026-08-15 08:00: saved 2026-08-15_0800\.jpg - 1920x1080, \d+ KB, from live video \(26 s; 2 of 770 packets missing; keyframes checked: 8\.1 s clean\); took \d+ s\. Memory: this program \d+ MB/.test(l)), lines.join(' | '));
  assert.strictEqual(leftoverWorkDirs().length, before, 'temporary folder removed');
});

test('when the live video fails, the 640x360 snapshot is saved instead - the day is not missed', async () => {
  const dir = tlDir();
  const f = fakeTimelapse(dir, { liveFails: true });
  const lines = await captureLogs(() => f.tl.maybeCapture());
  assert.deepStrictEqual(visible(dir), ['2026-08-15_0800_snapshot.jpg']);
  assert.ok(lines.some(l => /live video failed \(no clean keyframe.*\); saved the snapshot instead: 2026-08-15_0800_snapshot\.jpg - 640x360/.test(l)), lines.join(' | '));
});

test('when both fail, nothing is saved, it is said why, and it is not retried at every wake', async () => {
  const dir = tlDir();
  const f = fakeTimelapse(dir, { liveFails: true, snapFails: true });
  const lines = await captureLogs(async () => { await f.tl.maybeCapture(); f.advance(60000); await f.tl.maybeCapture(); });
  assert.deepStrictEqual(visible(dir), []);
  assert.strictEqual(f.calls.live, 1);
  assert.strictEqual(f.calls.snap, 2, 'the snapshot was tried twice');
  assert.ok(lines.some(l => /live video failed \(.*\); the snapshot failed too, 2 tries \(Snapshot for Downstream Lot failed to refresh/.test(l)), lines.join(' | '));
});

test('after a live view, the camera gets a moment before the snapshot - and a second try', async () => {
  // As on the Pi, 7 October: straight after the live view the battery camera
  // could not take a snapshot ("unable to capture snapshots while streaming").
  const dir = tlDir();
  let snaps = 0;
  const times = [];
  const t0 = Date.now();
  const cam = { name: 'Downstream Lot', getSnapshot: async () => {
    times.push(Date.now() - t0);
    if (++snaps === 1) throw new Error('failed to refresh after 15 seconds.  This is normal behavior since this camera is unable to capture snapshots while streaming');
    return fakeJpeg(640, 360);
  } };
  const tl = S.createTimelapse(tlCfg(dir), { camera: () => cam, now: () => ny(DAY, 12, 0, 5), afterLiveMs: 300, snapshotRetryMs: 200,
    liveFrame: async () => { const e = new Error('nothing was recorded (722 video packets arrived, 3 missing, in 21 s)');
      e.cameraStreamed = true; e.lowestMemory = 151.6; throw e; } });
  const lines = await captureLogs(() => tl.maybeCapture());
  assert.deepStrictEqual(visible(dir), ['2026-08-15_1200_snapshot.jpg']);
  assert.strictEqual(snaps, 2);
  assert.ok(times[0] >= 280, `first try after the pause: ${times[0]} ms`);
  assert.ok(times[1] - times[0] >= 180, `second try after another: ${times[1] - times[0]} ms`);
  assert.ok(lines.some(l => /Timelapse 2026-08-15 12:00: live video failed \(nothing was recorded \(722 video packets arrived, 3 missing, in 21 s\)\); saved the snapshot instead: 2026-08-15_1200_snapshot\.jpg - 640x360, 0 KB\. Memory: this program \d+ MB.*; the Pi had at least 152 MB available throughout\./.test(l)), lines.join(' | '));
});

test('when the camera was never asked for live video, the snapshot is taken at once', async () => {
  const dir = tlDir();
  const t0 = Date.now();
  let at = null;
  const cam = { name: 'Downstream Lot', startLiveCall: async () => { throw new Error('woken'); },
    getSnapshot: async () => { at = Date.now() - t0; return fakeJpeg(640, 360); } };
  const tl = S.createTimelapse(tlCfg(dir, { ffmpegPath: fakeFfmpeg(), readMemory: () => 60 }),
    { camera: () => cam, now: () => ny(DAY, 8, 0, 5), afterLiveMs: 5000 });
  await captureLogs(() => tl.maybeCapture());
  assert.deepStrictEqual(visible(dir), ['2026-08-15_0800_snapshot.jpg']);
  assert.ok(at !== null && at < 2000, `no pause: ${at} ms`);
});

test('what ffmpeg said is boiled down to its errors and missed packets', () => {
  const f = path.join(tlDir(), 'ffmpeg.log');
  fs.writeFileSync(f, [
    'ffmpeg started on 2026-10-07 at 12:00:20', 'Report written to "/tmp/x/ffmpeg.log"', 'Log level: 32', 'Command line:',
    '/usr/bin/ffmpeg -hide_banner -protocol_whitelist pipe,udp,rtp,file,crypto -f sdp -buffer_size 8388608 -i pipe: -an -vcodec copy -t 8 -f matroska -y /tmp/x/clip.mkv',
    '[sdp @ 0x55d1c0a2b3c0] RTP: missed 5 packets', '[sdp @ 0x55d1c0a2b3c0] RTP: missed 2 packets',
    'Input #0, sdp, from \'pipe:\':', '  Stream #0:0: Video: h264, none, 90k tbr, 90k tbn',
    '[matroska @ 0x55d1c0a31f00] dimensions not set',
    'Could not write header for output file #0 (incorrect codec parameters ?): Invalid argument',
    'frame=    0 fps=0.0 q=0.0 Lsize=       0kB time=00:00:00.00 bitrate=N/A speed=   0x\r'].join('\n'));
  assert.strictEqual(S.ffmpegSummary(f),
    'ffmpeg: [matroska] dimensions not set / Could not write header for output file #0 (incorrect codec parameters ?): Invalid argument; ffmpeg missed 7 packets',
    'the cause first, no memory addresses, nothing from the command line');
  assert.strictEqual(S.ffmpegSummary(path.join(os.tmpdir(), 'no-such-ffmpeg.log')), '', 'no report, nothing said');
});

test('a nearly full SD card: nothing is saved and the camera is not even woken', async () => {
  const dir = tlDir();
  const f = fakeTimelapse(dir, { cfg: { minDiskMb: 1e12 } });
  const lines = await captureLogs(() => f.tl.maybeCapture());
  assert.deepStrictEqual(visible(dir), []);
  assert.deepStrictEqual([f.calls.live, f.calls.snap], [0, 0]);
  assert.ok(lines.some(l => /only \d+ MB free on the SD card \(it keeps 1000000000000 MB free\); nothing saved/.test(l)), lines.join(' | '));
});

test('no timelapse camera on the account: said plainly, nothing woken', async () => {
  const dir = tlDir();
  const f = fakeTimelapse(dir, { noCamera: true });
  const lines = await captureLogs(() => f.tl.maybeCapture());
  assert.deepStrictEqual(visible(dir), []);
  assert.ok(lines.some(l => /no camera "Downstream Lot" on the account; skipped/.test(l)));
});

test('a capture that hangs is abandoned at the deadline - and the next cannot start until it has wound down', async () => {
  const dir = tlDir();
  let release;
  const f = fakeTimelapse(dir, { captureTimeoutMs: 200,
    liveFrame: () => new Promise((resolve, reject) => { release = () => reject(new Error('live view ended')); }) });
  let lines = await captureLogs(() => f.tl.maybeCapture());
  assert.ok(lines.some(l => /the capture took longer than 0 s/.test(l)), lines.join(' | '));
  assert.strictEqual(f.tl.busy(), true, 'still winding down');
  lines = await captureLogs(() => f.tl.captureNow());
  assert.ok(lines.some(l => /a timelapse capture is already running; skipped/.test(l)), 'no overlap');
  release();
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(f.tl.busy(), false);
});

test('a test capture (SIGUSR2) goes under tests/, so it never joins the timelapse', async () => {
  const dir = tlDir();
  const f = fakeTimelapse(dir, { start: ny(DAY, 20, 31, 7) });
  await captureLogs(() => f.tl.captureNow());
  assert.deepStrictEqual(fs.readdirSync(dir), ['tests']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'tests')), ['2026-08-15_203107.jpg']);
});

test('a whole day: 96 dock photos as always, and the timelapse at 8:00, 12:00 and 15:00, each after its dock photo', async () => {
  const dir = tlDir();
  const cfg = tlCfg(dir, {});
  Object.assign(cfg, { intervalMinutes: 15, activeStartHour: 0, activeEndHour: 0, slowAfterHour: 0 });
  let t = ny(DAY, 0, 0).getTime();
  const events = [];
  let pending = null;
  const tl = S.createTimelapse(cfg, { camera: () => ({ name: 'Downstream Lot', getSnapshot: async () => fakeJpeg(640, 360) }),
    now: () => new Date(t),
    liveFrame: async (cam, workDir) => {
      events.push(['timelapse', hhmm(new Date(t))]);
      t += 45000;   // a slow Pi: 45 s
      const frame = path.join(workDir, 'frame.jpg');
      fs.writeFileSync(frame, fakeJpeg(1920, 1080));
      return { frame, liveSeconds: 30, missing: 0, received: 700, checked: ['8.1 s clean'] };
    } });
  const tick = S.createScheduler(cfg, {
    now: () => new Date(t), setTimer: (fn, ms) => { pending = { fn, ms }; },
    hasPrimary: true, hasBackup: true,
    cycle: async (role) => { events.push([role, hhmm(new Date(t))]); t += 3000; },
    afterSlot: () => tl.maybeCapture(),
  });
  await captureLogs(async () => {
    await tick();
    while (pending && t + pending.ms <= ny(NEXT, 0, 0).getTime()) { const p = pending; pending = null; t += p.ms; await p.fn(); }
  });
  const dock = events.filter(e => e[0] === 'primary');
  assert.strictEqual(dock.length, 96, 'the dock timetable is untouched');
  assert.ok(dock.every(e => Number(e[1].slice(3)) % 15 === 0), 'still on the quarter hours, slow timelapse or not');
  assert.deepStrictEqual(events.filter(e => e[0] === 'timelapse').map(e => e[1]), ['08:00', '12:00', '15:00']);
  for (const time of ['08:00', '12:00', '15:00']) {
    const i = events.findIndex(e => e[0] === 'timelapse' && e[1] === time);
    assert.deepStrictEqual(events[i - 1], ['primary', time], `the ${time} dock photo comes first`);
  }
  assert.deepStrictEqual(visible(dir).sort(), ['2026-08-15_0800.jpg', '2026-08-15_1200.jpg', '2026-08-15_1500.jpg']);
  assert.ok(!events.some(e => e[0] === 'backup'), 'the timelapse never sets off the backup logic');
});

test('daylight-saving days: still three frames, at the local times', async () => {
  for (const day of ['2026-03-08', '2026-11-01']) {
    const dir = tlDir();
    const cfg = tlCfg(dir, {});
    let t = ny(day, 0, 0).getTime();
    const tl = S.createTimelapse(cfg, { camera: () => ({ name: 'L' }), now: () => new Date(t),
      liveFrame: async (cam, workDir) => { const frame = path.join(workDir, 'f.jpg'); fs.writeFileSync(frame, fakeJpeg(1920, 1080));
        return { frame, liveSeconds: 1, missing: 0, received: 1, checked: [] }; } });
    await captureLogs(async () => { for (let m = 0; m < 24 * 60; m += 15) { t = ny(day, 0, 0).getTime() + m * 60000 + 1000; await tl.maybeCapture(); } });
    const ymd = day;
    assert.deepStrictEqual(visible(dir).sort(), [`${ymd}_0800.jpg`, `${ymd}_1200.jpg`, `${ymd}_1500.jpg`], day);
  }
});

test('a timelapse that throws can never stop the dock photos', async () => {
  let t = ny(DAY, 7, 50).getTime(), pending = null, dock = 0;
  const lines = await captureLogs(async () => {
    const tick = S.createScheduler(prodCfg, { now: () => new Date(t), setTimer: (fn, ms) => { pending = { fn, ms }; },
      cycle: async () => { dock++; }, afterSlot: () => { throw new Error('boom'); } });
    await tick();
    for (let i = 0; i < 6; i++) { const p = pending; t += p.ms; await p.fn(); }
  });
  assert.ok(dock >= 3, `dock photos went on: ${dock}`);
  assert.ok(lines.some(l => /after-slot task failed: boom/.test(l)));
});

test('the README\'s Pi steps match the code, and its printf lines write exactly the intended files', () => {
  const md = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const sec = md.slice(md.indexOf('## Timelapse (optional)'), md.indexOf('## Battery'));
  assert.ok(sec.length > 1000, 'the Timelapse section is there');
  const sh = (fmt) => require('child_process').spawnSync('bash', ['-c', `printf '${fmt}'`], { encoding: 'utf8' }).stdout;
  const sysctl = /printf '(.*?)' \| sudo tee \/etc\/sysctl\.d\/90-nhrc-camera\.conf\n/.exec(sec);
  assert.ok(sysctl, 'the sysctl line');
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const buf = Number(/const SOCKET_BUFFER_BYTES = (\d+) \* 1024 \* 1024;/.exec(src)[1]) * 1048576;
  assert.strictEqual(sh(sysctl[1]), `net.core.rmem_max=${buf}\nnet.core.rmem_default=${buf}\n`, 'the buffers ffmpeg asks for');
  const dropIn = /printf '(.*?)' \| sudo tee \/etc\/systemd\/system\/nhrc-camera\.service\.d\/timelapse\.conf\n/.exec(sec);
  assert.ok(dropIn, 'the drop-in line');
  assert.strictEqual(sh(dropIn[1]),
    '[Service]\nNice=10\nCPUWeight=20\nOOMScoreAdjust=500\nRestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK\n'
    + 'RuntimeDirectory=nhrc-camera\nRuntimeDirectoryMode=0700\n');
  // The unit file in the repo (the standby's) has every drop-in line already, so
  // the drop-in is only for a Pi whose unit came from an earlier README.
  const unitLines = fs.readFileSync(path.join(__dirname, 'nhrc-camera.service'), 'utf8').split('\n');
  for (const line of sh(dropIn[1]).split('\n').filter(l => l && l !== '[Service]')) {
    assert.ok(unitLines.includes(line), `the unit file has the drop-in's ${line}`);
  }
  assert.ok(/unit file \(section 6\) has them already/.test(sec), 'the README says who needs the drop-in');
  assert.ok(/\nsudo systemctl daemon-reload\n/.test(sec), 'systemd reads the drop-in');
  // The env lines: every 5 minutes, recorded in the folder the drop-in makes; the old lines removed first.
  const lines = [...sec.matchAll(/echo '([A-Z_]+)=([^']+)' \| sudo tee -a \/opt\/nhrc-camera\/env/g)].map(m => [m[1], m[2]]);
  const env = Object.fromEntries(lines);
  assert.strictEqual(env.TIMELAPSE_EVERY_MINUTES, '5');
  assert.strictEqual(env.TIMELAPSE_WORK_DIR, '/run/nhrc-camera', 'the folder RuntimeDirectory=nhrc-camera makes');
  assert.deepStrictEqual(S.parseTimeList(env.TIMELAPSE_TIMES).map(t => t.label), ['08:00', '12:00', '15:00'], 'the set times, to go back to');
  const sed = /sudo sed -i '([^']+)' \/opt\/nhrc-camera\/env\necho 'TIMELAPSE_EVERY_MINUTES=5'/.exec(sec);
  assert.ok(sed, 'the old lines are removed before the new ones are added');
  for (const name of ['TIMELAPSE_TIMES', 'TIMELAPSE_RECORD_SECONDS', 'TIMELAPSE_EVERY_MINUTES', 'TIMELAPSE_WORK_DIR']) {
    assert.ok(sed[1].includes(`/^${name}=/d`), name);
  }
  // Run the setup's sed and echo lines on a copy of an env from the first version: the result is valid, every 5 minutes.
  const envFile = path.join(tlDir(), 'env');
  fs.writeFileSync(envFile, 'CAMERA_UPLOAD_URL=x\nTIMELAPSE_TIMES=8:00,12:00,15:00\nTIMELAPSE_RECORD_SECONDS=20\n');
  const setup = sec.slice(sec.indexOf('sudo sed -i \'/^TIMELAPSE_TIMES=/d;'), sec.indexOf("echo 'TIMELAPSE_WORK_DIR=/run/nhrc-camera' | sudo tee -a /opt/nhrc-camera/env") + 200).split('\n```')[0];
  const run = require('child_process').spawnSync('bash', ['-c', setup.replace(/sudo /g, '').replace(/\/opt\/nhrc-camera\/env/g, envFile)], { encoding: 'utf8' });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), 'CAMERA_UPLOAD_URL=x\nTIMELAPSE_EVERY_MINUTES=5\nTIMELAPSE_WORK_DIR=/run/nhrc-camera\n');
  for (const [name, key] of [['TIMELAPSE_MIN_MEMORY_MB', 'minMemoryMb'], ['TIMELAPSE_MIN_DISK_MB', 'minDiskMb'], ['TIMELAPSE_RECORD_SECONDS', 'recordSeconds'],
    ['TIMELAPSE_TARGET_HEIGHT', 'targetHeight'], ['TIMELAPSE_MIN_BATTERY', 'minBattery'], ['TIMELAPSE_MAX_RSS_MB', 'maxRssMb'],
    ['TIMELAPSE_SNAPSHOT_PAUSE_SECONDS', 'snapshotPauseSeconds']]) {
    const row = new RegExp('\\| `' + name + '` \\| (\\d+) \\|').exec(sec);
    assert.ok(row && Number(row[1]) === S.CONFIG.timelapse[key], `${name} in the README table is the default`);
  }
  // Every timelapse setting the service reads is in the table.
  for (const name of new Set([...src.matchAll(/process\.env\.(TIMELAPSE_[A-Z_]+)/g)].map(m => m[1]))) {
    assert.ok(sec.includes('`' + name + '`'), `${name} is in the README`);
  }
});

test('the sharpest keyframe is tried first, then the latest; the resolution timeline reads plainly', () => {
  // As on the Pi: Ring stepped up to 1280x720, then dropped back to 848x480.
  const frames = [{ t: 0.1, width: 640, height: 360 }, { t: 2.2, width: 848, height: 480 }, { t: 10.2, width: 1280, height: 720 },
    { t: 12.3, width: 1280, height: 720 }, { t: 16.4, width: 848, height: 480 }, { t: 18.3, width: 848, height: 480 }];
  assert.deepStrictEqual(S.keyframeOrder(frames).map(f => f.t), [12.3, 10.2, 18.3, 16.4], 'at most four: 720p latest first, then 480p');
  assert.deepStrictEqual(S.keyframeOrder(frames, 2).map(f => f.t), [12.3, 10.2]);
  assert.strictEqual(S.resolutionTimeline(frames), '640x360 from 0.1 s, 848x480 from 2.2 s, 1280x720 from 10.2 s, 848x480 from 16.4 s');
  const same = [{ t: 2, width: 1920, height: 1080 }, { t: 4, width: 1920, height: 1080 }];
  assert.deepStrictEqual(S.keyframeOrder(same).map(f => f.t), [4, 2], 'one resolution: the latest first, as before');
  assert.strictEqual(S.resolutionTimeline(same), '1920x1080 from 2.0 s');
  assert.deepStrictEqual(S.keyframeOrder([]), []);
});

// ── Memory for Pi-hole, and no restart loops ──

test('the memory available is read from /proc/meminfo', () => {
  const mb = S.availableMb();
  assert.ok(typeof mb === 'number' && mb > 0, String(mb));
});

test('the memory watch keeps the lowest reading, and calls for a stop once, at the first below the floor', async () => {
  const readings = [300, 120, null, 90, 35, 20, 25, 400];
  let i = 0;
  const lows = [];
  const w = S.watchMemory(40, (mb) => lows.push(mb), () => readings[Math.min(i++, readings.length - 1)], 5);
  await new Promise(r => setTimeout(r, 150));
  w.stop();
  const n = i;
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(i, n, 'no readings once stopped');
  assert.deepStrictEqual(lows, [35]);
  assert.strictEqual(w.lowest, 20);
});

/** Empty stand-ins for ffmpeg and ffprobe: enough for the "is ffmpeg installed" check. */
function fakeFfmpeg() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-bin-'));
  for (const f of ['ffmpeg', 'ffprobe']) fs.writeFileSync(path.join(d, f), '');
  return path.join(d, 'ffmpeg');
}

test('short of memory: the live video is not started - the camera is not even woken - and the snapshot is saved', async () => {
  const dir = tlDir();
  let woken = 0, snaps = 0;
  const cam = { name: 'Downstream Lot', startLiveCall: async () => { woken++; throw new Error('woken'); },
    getSnapshot: async () => { snaps++; return fakeJpeg(640, 360); } };
  const tl = S.createTimelapse(tlCfg(dir, { ffmpegPath: fakeFfmpeg(), readMemory: () => 75 }),
    { camera: () => cam, now: () => ny(DAY, 8, 0, 5) });
  const lines = await captureLogs(() => tl.maybeCapture());
  assert.deepStrictEqual([woken, snaps], [0, 1]);
  assert.deepStrictEqual(visible(dir), ['2026-08-15_0800_snapshot.jpg']);
  assert.ok(lines.some(l => /live video failed \(not started: only 75 MB of memory available; the live video starts with 80 MB or more \(40 MB is kept for Pi-hole\)\); saved the snapshot instead/.test(l)), lines.join(' | '));
});

test('with just enough memory (40 + 40 MB) the live view is tried', async () => {
  let woken = 0;
  const cam = { name: 'Downstream Lot', startLiveCall: async () => { woken++; throw new Error('the camera did not answer'); } };
  await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { ffmpegPath: fakeFfmpeg(), readMemory: () => 80 }), os.tmpdir()),
    /the camera did not answer/);
  assert.strictEqual(woken, 1);
});

test('each time is noted on disk before its capture starts', async () => {
  const dir = tlDir();
  let noted = null;
  const f = fakeTimelapse(dir, { liveFrame: async (cam, workDir) => {
    noted = fs.readFileSync(path.join(dir, '.tried'), 'utf8');
    const frame = path.join(workDir, 'frame.jpg');
    fs.writeFileSync(frame, fakeJpeg(1920, 1080));
    return { frame, liveSeconds: 20, missing: 0, received: 700, checked: ['8.1 s clean'] };
  } });
  await captureLogs(() => f.tl.maybeCapture());
  assert.strictEqual(noted, '2026-08-15 08:00\n');
});

test('a capture that brought the service down is not tried again after the restart - no restart loop', async () => {
  const dir = tlDir();
  // The service "dies" in its 8:00 capture: the capture never comes back.
  let release;
  const first = fakeTimelapse(dir, { captureTimeoutMs: 100,
    liveFrame: () => new Promise((res, rej) => { release = () => rej(new Error('gone')); }) });
  await captureLogs(() => first.tl.maybeCapture());
  // systemd restarts it 90 seconds later, still inside the 8:00 window.
  const second = fakeTimelapse(dir, { start: ny(DAY, 8, 1, 30) });
  let lines = await captureLogs(async () => { await second.tl.maybeCapture(); second.advance(10 * 60000); await second.tl.maybeCapture(); });
  assert.deepStrictEqual([second.calls.live, second.calls.snap], [0, 0], 'the camera is not woken again');
  assert.strictEqual(lines.filter(l => /Timelapse 2026-08-15 08:00: already tried before the service restarted; not tried again today\./.test(l)).length, 1, lines.join(' | '));
  // The later times that day are captured as usual...
  second.advance(ny(DAY, 12, 0, 10).getTime() - ny(DAY, 8, 11, 30).getTime());
  await captureLogs(() => second.tl.maybeCapture());
  assert.deepStrictEqual(visible(dir), ['2026-08-15_1200.jpg']);
  // ... and 8:00 the next day, with only that day kept in the note.
  const third = fakeTimelapse(dir, { start: ny(NEXT, 8, 0, 5) });
  await captureLogs(() => third.tl.maybeCapture());
  assert.strictEqual(third.calls.live, 1);
  assert.deepStrictEqual(visible(dir).sort(), ['2026-08-15_1200.jpg', '2026-08-16_0800.jpg']);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.tried'), 'utf8'), '2026-08-16 08:00\n');
  release();
});

test('a restart after a saved frame says nothing and takes nothing again', async () => {
  const dir = tlDir();
  await captureLogs(() => fakeTimelapse(dir).tl.maybeCapture());
  const again = fakeTimelapse(dir, { start: ny(DAY, 8, 5, 0) });
  const lines = await captureLogs(() => again.tl.maybeCapture());
  assert.strictEqual(again.calls.live, 0);
  assert.ok(!lines.some(l => /already tried/.test(l)), lines.join(' | '));
});

test('if the note cannot be written, it says so - and the capture goes ahead as before', async () => {
  const dir = tlDir();
  fs.mkdirSync(path.join(dir, '.tried'));   // a folder where the note goes: it cannot be written
  const f = fakeTimelapse(dir);
  const lines = await captureLogs(() => f.tl.maybeCapture());
  assert.ok(lines.some(l => /Timelapse: could not note the attempt in \S+\.tried/.test(l)), lines.join(' | '));
  assert.deepStrictEqual(visible(dir), ['2026-08-15_0800.jpg']);
});

// ═══════════════════════════════════════════════════════════════════════════
section('6h. Timelapse every 5 minutes, sunrise to sunset - and still gentle on the Pi');
// ═══════════════════════════════════════════════════════════════════════════
//
// About 110 (December) to 180 (June) live views a day of a battery camera,
// from a Pi that serves the house's DNS: the timetable, the sun, and every
// guard - battery, the website's backup, failures, crashes, memory, files.

// The US Naval Observatory's almanac for the boathouse (41.437 N, 73.119 W), local time.
const USNO = [['2026-03-08', '07:16', '18:51'], ['2026-03-20', '06:56', '19:05'], ['2026-06-21', '05:19', '20:30'],
  ['2026-10-13', '07:02', '18:14'], ['2026-11-01', '06:24', '16:47'], ['2026-12-21', '07:15', '16:26']];

test('sun times at the boathouse: the US Naval Observatory\'s almanac, to the minute', () => {
  const at = (ms) => nyClock(new Date(Math.round(ms / 60000) * 60000)).slice(0, 5);
  for (const [day, rise, set] of USNO) {
    const t = S.sunTimes(day, 41.437, -73.119);
    assert.strictEqual(at(t.sunrise), rise, `${day} sunrise`);
    assert.strictEqual(at(t.sunset), set, `${day} sunset`);
  }
});

test('sun times all year: every day has its window, 9.2 to 15.2 hours of daylight; none where the sun never sets', () => {
  const cfg = tlCfg('/x', { everyMinutes: 5 });
  let shortest = Infinity, longest = 0;
  for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 86400000) {
    const day = new Date(d).toISOString().slice(0, 10);
    const w = S.daylightMinutes(day, cfg);
    assert.ok(w && w.from < w.until, day);
    shortest = Math.min(shortest, w.until - w.from);
    longest = Math.max(longest, w.until - w.from);
  }
  assert.ok(shortest > 9.1 * 60 && shortest < 9.3 * 60, `shortest ${(shortest / 60).toFixed(2)} h`);
  assert.ok(longest > 15.1 * 60 && longest < 15.3 * 60, `longest ${(longest / 60).toFixed(2)} h`);
  assert.strictEqual(S.sunTimes('2026-06-21', 70, 20), null, 'midnight sun: no sunset');
  assert.strictEqual(S.sunTimes('2026-12-21', 70, 20), null, 'polar night: no sunrise');
  assert.strictEqual(S.daylightMinutes('2026-06-21', tlCfg('/x', { everyMinutes: 5, latitude: 70, longitude: 20 })), null);
  assert.deepStrictEqual(S.daylightMinutes('2026-06-21', tlCfg('/x', { everyMinutes: 5, from: '6:30', until: '19:00' })), { from: 390, until: 1140 });
});

test('the window\'s ends: sunrise, sunset or a local time', () => {
  assert.deepStrictEqual(S.parseWindowEdge('sunrise'), { sun: 'sunrise' });
  assert.deepStrictEqual(S.parseWindowEdge(' Sunset '), { sun: 'sunset' });
  assert.deepStrictEqual(S.parseWindowEdge('7:30'), { minutes: 450 });
  assert.deepStrictEqual(S.parseWindowEdge('07:05'), { minutes: 425 });
  assert.deepStrictEqual(S.parseWindowEdge('0:00'), { minutes: 0 });
  for (const bad of ['', 'dawn', '7', '24:00', '7:60', '7.30', null, undefined, 'sunrise+30']) {
    assert.strictEqual(S.parseWindowEdge(bad), null, String(bad));
  }
});

test('the every-few-minutes settings are checked; a mistake is named, never read as "off"', () => {
  const v = (over) => S.validateConfig(tlCfg('/opt/nhrc-camera/timelapse', Object.assign({ times: [], everyMinutes: 5 }, over)));
  assert.deepStrictEqual(v({}), []);
  for (const every of [5, 6, 10, 12, 15, 20, 30, 60]) assert.deepStrictEqual(v({ everyMinutes: every }), [], String(every));
  for (const every of [1, 4, 7, 25, 45, 90, -5, 2.5, NaN, Number('five')]) {
    assert.ok(v({ everyMinutes: every }).some(p => /TIMELAPSE_EVERY_MINUTES must be 5, 6, 10, 12, 15, 20, 30 or 60/.test(p)), String(every));
  }
  assert.ok(v({ times: S.parseTimeList('8:00') }).some(p => /TIMELAPSE_TIMES and TIMELAPSE_EVERY_MINUTES are both set/.test(p)));
  for (const [from, until] of [['dawn', 'sunset'], ['sunrise', 'dusk'], ['7', 'sunset']]) {
    assert.ok(v({ from, until }).some(p => /is not sunrise, sunset or a time like 7:30/.test(p)), `${from}-${until}`);
  }
  for (const [from, until] of [['sunset', 'sunrise'], ['sunrise', 'sunrise'], ['18:00', '7:00'], ['9:00', '9:00']]) {
    assert.ok(v({ from, until }).some(p => /TIMELAPSE_FROM must come before TIMELAPSE_UNTIL/.test(p)), `${from}-${until}`);
  }
  for (const [from, until] of [['6:30', '19:00'], ['sunrise', '12:00'], ['9:00', 'sunset']]) assert.deepStrictEqual(v({ from, until }), [], `${from}-${until}`);
  for (const lat of [66, -70, NaN]) assert.ok(v({ latitude: lat }).some(p => /TIMELAPSE_LATITUDE/.test(p)), String(lat));
  for (const lon of [181, NaN]) assert.ok(v({ longitude: lon }).some(p => /TIMELAPSE_LONGITUDE/.test(p)), String(lon));
  for (const h of [0, 240, 1080, 2160]) assert.deepStrictEqual(v({ targetHeight: h }), [], String(h));
  for (const h of [239, 2161, 1080.5, NaN]) assert.ok(v({ targetHeight: h }).some(p => /TIMELAPSE_TARGET_HEIGHT/.test(p)), String(h));
  for (const b of [0, 40, 85]) assert.deepStrictEqual(v({ minBattery: b }), [], String(b));
  for (const b of [-1, 86, 40.5, NaN]) assert.ok(v({ minBattery: b }).some(p => /TIMELAPSE_MIN_BATTERY/.test(p)), String(b));
  assert.ok(v({ workDir: 'run/nhrc-camera' }).some(p => /TIMELAPSE_WORK_DIR must be an absolute path/.test(p)));
  assert.deepStrictEqual(v({ workDir: '/run/nhrc-camera' }), []);
  for (const m of [119, NaN]) assert.ok(v({ maxRssMb: m }).some(p => /TIMELAPSE_MAX_RSS_MB must be at least 120/.test(p)), String(m));
  // The defaults: off; when on, sunrise to sunset at the boathouse, 1080 lines, 40% battery, 160 MB.
  const d = S.CONFIG.timelapse;
  assert.deepStrictEqual([d.everyMinutes, d.from, d.until, d.latitude, d.longitude, d.targetHeight, d.minBattery, d.maxRssMb, d.workDir],
    [0, 'sunrise', 'sunset', 41.437, -73.119, 1080, 40, 160, '']);
  assert.strictEqual(S.intervalOn(tlCfg('/x', { times: [], everyMinutes: 5 })), true);
  assert.strictEqual(S.timelapseOn(tlCfg('/x', { times: [], everyMinutes: 5 })), true);
  assert.strictEqual(S.intervalOn(tlCfg('/x', { everyMinutes: NaN })), false, 'a mistake is off (and named by the check)');
});

test('the slots: on the clock\'s 5-minute marks, from the first after sunrise to the last before sunset', () => {
  const cfg = tlCfg('/x', { times: [], everyMinutes: 5 });
  const slot = (h, m, s = 0) => S.intervalSlot(ny('2026-10-13', h, m, s), cfg);
  // Sunrise 07:02:13, sunset 18:14:27 on 13 October.
  assert.deepStrictEqual([slot(7, 4, 59).label, slot(7, 4, 59).inWindow], ['07:00', false]);
  assert.deepStrictEqual([slot(7, 5, 0).label, slot(7, 5, 0).inWindow], ['07:05', true]);
  assert.deepStrictEqual([slot(18, 14, 59).label, slot(18, 14, 59).inWindow], ['18:10', true]);
  assert.deepStrictEqual([slot(18, 15, 0).label, slot(18, 15, 0).inWindow], ['18:15', false]);
  assert.strictEqual(slot(12, 7, 30).end - slot(12, 7, 30).start, 5 * 60000);
  assert.strictEqual(slot(12, 7, 30).start, ny('2026-10-13', 12, 5).getTime());
  assert.strictEqual(slot(2, 0).inWindow, false);
  const ten = tlCfg('/x', { times: [], everyMinutes: 10, from: '6:30', until: '19:00' });
  assert.deepStrictEqual([6, 7, 18, 19].map(h => S.intervalSlot(ny('2026-10-13', h, 0, 30), ten).inWindow), [false, true, true, true]);
  assert.deepStrictEqual(S.intervalSlot(ny('2026-10-13', 6, 30, 30), ten).inWindow, true, 'a fixed edge is inclusive');
  assert.deepStrictEqual(S.intervalSlot(ny('2026-10-13', 19, 10, 0), ten).inWindow, false);
});

test('every day of the year, daylight-saving days included: one slot per 5 minutes of daylight, local times, none twice', () => {
  const cfg = tlCfg('/x', { times: [], everyMinutes: 5 });
  const expect = { '2026-03-08': [139, '07:20', '18:50'], '2026-11-01': [125, '06:25', '16:45'],
    '2026-06-21': [182, '05:20', '20:25'], '2026-12-21': [110, '07:20', '16:25'], '2026-10-13': [134, '07:05', '18:10'] };
  for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 86400000) {
    const day = new Date(d).toISOString().slice(0, 10);
    const labels = new Map();
    // Half a minute into every 5-minute slot of the local day (23 or 25 hours on the changeover days).
    for (let t = ny(day, 0, 0).getTime() + 30000; S.localDateParts(new Date(t), cfg).date === day; t += 5 * 60000) {
      const s = S.intervalSlot(new Date(t), cfg);
      if (s.inWindow) labels.set(s.start, s.label);
    }
    const list = [...labels.values()];
    assert.strictEqual(new Set(list).size, list.length, `${day}: a label twice`);
    assert.ok(list.every(l => Number(l.slice(3)) % 5 === 0), day);
    if (expect[day]) assert.deepStrictEqual([list.length, list[0], list[list.length - 1]], expect[day], day);
    assert.ok(list.length >= 110 && list.length <= 183, `${day}: ${list.length}`);
  }
});

// The SPS (sequence parameter set) of real x264 streams, as the camera sends
// them before each keyframe: [hex, width, height, what].
const SPS_FIXTURES = [
  ['67640028acb200f0044fcb8088000003000800000300f078c19240', 1920, 1080, 'High, cropped from 1088'],
  ['67640028acd94078044fde0220000003002000000783e2c5b2c0', 1920, 1080, 'High, interlaced'],
  ['6764001facb200a00b760220000003002000000303c1e30649', 1280, 720, 'High'],
  ['674d401eeca06a1ed80880000003008000000f078b16cb', 848, 480, 'Main'],
  ['6742c016da0280bfe5c044000003000400000300783c58ba80', 640, 360, 'Constrained Baseline'],
  ['67f40016919b281405ff138088000003000800000300f078b16cb0', 640, 360, 'High 4:4:4'],
  ['676e0028a6cb403c0113f2e0220000030002000003003c1e306540', 1920, 1080, 'High 10'],
  ['6742c028da01e0089ea6c044000003000400000300783c60ca80', 1918, 1078, 'odd size, cropped'],
  ['6742c028da01e0089b0110000003001000000301e0f1832a', 1920, 1088, 'uncropped'],
  ['6742c032da00a002d6c044000003000400000300783c60ca80', 2560, 1440, 'Baseline 1440p'],
];

test('a keyframe\'s size from its SPS: real x264 streams, every profile, cropping and interlacing', () => {
  for (const [hex, w, h, what] of SPS_FIXTURES) {
    assert.deepStrictEqual(S.spsResolution(Buffer.from(hex, 'hex')), { width: w, height: h }, what);
  }
});

/** An H.264 SPS written bit by bit (ITU-T H.264 7.3.2.1.1), with emulation prevention. */
function writeSps({ profile = 100, scaling = null, width, height, frameMbsOnly = 1, crop = null, pocType = 0, zeros = false }) {
  const bits = [];
  const u = (n, v) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  const ue = (v) => { const x = v + 1, n = Math.floor(Math.log2(x)); u(n, 0); u(n + 1, x); };
  const se = (v) => ue(v > 0 ? 2 * v - 1 : -2 * v);
  u(8, profile); u(8, 0); u(8, zeros ? 0 : 40);                   // constraint flags, level
  // seq_parameter_set_id. `zeros`: level 0 and an id of 63 (beyond the
  // standard's 31) put 22 zero bits in a row - an emulation-prevention byte.
  ue(zeros ? 63 : 0);
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    ue(1); ue(0); ue(0); u(1, 0);                                 // 4:2:0, 8 bit, no qpprime bypass
    u(1, scaling ? 1 : 0);
    if (scaling) {
      for (let i = 0; i < 8; i++) {
        const list = scaling[i];
        u(1, list ? 1 : 0);
        if (list) for (const delta of list) se(delta);
      }
    }
  }
  ue(0);                                                          // log2_max_frame_num - 4
  ue(pocType);
  if (pocType === 0) ue(2);
  else if (pocType === 1) { u(1, 0); se(-3); se(7); ue(2); se(1); se(-1); }
  ue(1); u(1, 0);                                                 // max_num_ref_frames, gaps
  const mbW = Math.ceil(width / 16), mapH = Math.ceil(height / 16 / (2 - frameMbsOnly));
  ue(mbW - 1); ue(mapH - 1);
  u(1, frameMbsOnly);
  if (!frameMbsOnly) u(1, 0);
  u(1, 1);                                                        // direct_8x8_inference
  u(1, crop ? 1 : 0);
  if (crop) crop.forEach(ue);
  u(1, 0);                                                        // no VUI
  bits.push(1); while (bits.length % 8) bits.push(0);            // rbsp trailing bits
  const raw = [];
  for (let i = 0; i < bits.length; i += 8) raw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const out = [0x67];
  let zerosRun = 0;
  for (const b of raw) {
    if (zerosRun >= 2 && b <= 3) { out.push(3); zerosRun = 0; }
    out.push(b);
    zerosRun = b === 0 ? zerosRun + 1 : 0;
  }
  return Buffer.from(out);
}

test('a keyframe\'s size from its SPS: scaling matrices, picture-order types and emulation-prevention bytes are read through', () => {
  // 16-entry lists for 4x4 (i < 6), 64-entry for 8x8; a delta of -8 first means "use the default" and ends the list.
  const full16 = Array.from({ length: 16 }, (_, j) => (j % 3) - 1);
  const full64 = Array.from({ length: 64 }, (_, j) => (j % 5) - 2);
  const scaling = [full16, [-8], null, full16, [-8], full16, full64, [-8]];
  const cases = [
    [{ width: 1920, height: 1080, crop: [0, 0, 0, 4], scaling }, 1920, 1080],
    [{ width: 1280, height: 720, scaling: [null, null, null, null, null, null, full64, full64] }, 1280, 720],
    [{ width: 1920, height: 1088, frameMbsOnly: 0, crop: [0, 0, 0, 2] }, 1920, 1080],
    [{ width: 848, height: 480, pocType: 1 }, 848, 480],
    [{ width: 640, height: 368, pocType: 2, crop: [0, 0, 0, 4] }, 640, 360],
    [{ width: 1920, height: 1088, profile: 66, crop: [0, 0, 0, 4] }, 1920, 1080],
    [{ width: 1920, height: 1088, profile: 66, crop: [0, 0, 0, 4], zeros: true }, 1920, 1080],
  ];
  for (const [spec, w, h] of cases) {
    const nal = writeSps(spec);
    assert.deepStrictEqual(S.spsResolution(nal), { width: w, height: h }, `${JSON.stringify(spec).slice(0, 80)} ${nal.toString('hex')}`);
  }
  assert.ok(writeSps({ width: 1920, height: 1088, profile: 66, zeros: true }).includes(Buffer.from([0, 0, 3])),
    'the zeros case really has an emulation-prevention byte to step over');
});

test('SPS packets: alone or in a STAP-A, as RTP carries them; anything else, or damaged, gives nothing and never throws', () => {
  const sps = Buffer.from(SPS_FIXTURES[0][0], 'hex'), pps = Buffer.from('68ebe3cb22c0', 'hex');
  const stap = Buffer.concat([Buffer.from([0x78, 0, sps.length]), sps, Buffer.from([0, pps.length]), pps]);
  assert.deepStrictEqual(S.spsNals(sps).map(S.spsResolution), [{ width: 1920, height: 1080 }], 'a single NAL unit');
  assert.deepStrictEqual(S.spsNals(stap).map(S.spsResolution), [{ width: 1920, height: 1080 }], 'in a STAP-A, with its PPS');
  assert.deepStrictEqual(S.spsNals(pps), [], 'a PPS');
  assert.deepStrictEqual(S.spsNals(Buffer.from([0x65, 0x88, 0x84])), [], 'a keyframe slice');
  assert.deepStrictEqual(S.spsNals(Buffer.from([0x7c, 0x87, 0x64, 0, 0x28])), [], 'a fragment (FU-A)');
  assert.deepStrictEqual(S.spsNals(Buffer.from([0x78, 0xff, 0xff, 0x67, 0x64])), [], 'a STAP-A whose sizes do not add up');
  for (const x of [null, undefined, Buffer.alloc(0), Buffer.from([0x67])]) assert.deepStrictEqual(S.spsNals(x).map(S.spsResolution).filter(Boolean), [], String(x));
  for (const x of [Buffer.from([0x67, 0x64]), Buffer.from([0x67]), Buffer.alloc(0), sps.subarray(0, 6)]) assert.strictEqual(S.spsResolution(x), null);
  let bad = 0;
  for (let k = 0; k < 20000; k++) {
    const b = Buffer.alloc(1 + (k % 40));
    for (let j = 0; j < b.length; j++) b[j] = (k * 7919 + j * 104729 + (k >> 3) * j) & 255;
    b[0] = k % 2 ? 0x67 : 0x78;
    try {
      for (const n of S.spsNals(b)) { const r = S.spsResolution(n); if (r && !(r.width > 0 && r.height > 0)) bad++; }
      const r = S.spsResolution(b); if (r && !(r.width > 0 && r.height > 0)) bad++;
    } catch (e) { bad++; }
  }
  assert.strictEqual(bad, 0, 'damaged data: never a throw, never a nonsense size');
});

test('the battery is read fresh from the camera\'s health report, in whatever form Ring sends it', async () => {
  const cam = (health) => ({ name: 'Downstream Lot', getHealth: async () => { if (health instanceof Error) throw health; return health; } });
  const read = (h) => S.readBattery(cam(h), 200);
  assert.deepStrictEqual(await read({ battery_percentage: 85, latest_signal_strength: -61 }), { level: 85, signal: -61, why: '' });
  assert.deepStrictEqual(await read({ battery_percentage: '72', latest_signal_strength: '-70' }), { level: 72, signal: -70, why: '' });
  assert.deepStrictEqual(await read({ battery_percentage: 99.6 }), { level: 100, signal: null, why: '' });
  assert.deepStrictEqual(await read({ battery_percentage: 'NA' }), { level: null, signal: null, why: 'Ring gave "NA"' });
  assert.deepStrictEqual(await read({ battery_percentage: null }), { level: null, signal: null, why: 'Ring gave "null"' });
  assert.deepStrictEqual(await read({ battery_percentage: 140 }), { level: null, signal: null, why: 'Ring gave "140"' });
  assert.deepStrictEqual(await read({}), { level: null, signal: null, why: 'Ring gave no battery level' });
  assert.deepStrictEqual(await read(null), { level: null, signal: null, why: 'Ring gave no battery level' });
  assert.deepStrictEqual(await read(new Error('HTTP 503')), { level: null, signal: null, why: 'HTTP 503' });
  const hung = { name: 'L', getHealth: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.deepStrictEqual(await S.readBattery(hung, 150), { level: null, signal: null, why: 'reading the battery took longer than 0 s' });
  assert.ok(Date.now() - t0 < 1000, 'a hung request is given up');
  assert.deepStrictEqual(await S.readBattery({ name: 'L' }), { level: null, signal: null, why: 'this camera gives no health report' });
  // No number in the health report: the camera list, fetched fresh - its health, else the lower of its batteries.
  const listed = (cams) => async () => ({ allCameras: cams });
  const lot = (health) => Object.assign(cam(health), { id: 202 });
  assert.deepStrictEqual(await S.readBattery(lot({ battery_percentage: 'NA', latest_signal_strength: -58 }), 200,
    listed([{ id: 101, battery_life: 99 }, { id: 202, health: { battery_percentage: 64 }, battery_life: '80' }])), { level: 64, signal: -58, why: '' });
  assert.deepStrictEqual(await S.readBattery(lot(new Error('HTTP 503')), 200, listed([{ id: 202, battery_life: '71', battery_life_2: 45 }])),
    { level: 45, signal: null, why: '' }, 'two batteries: the lower');
  assert.deepStrictEqual(await S.readBattery(lot({}), 200, listed([{ id: 202, battery_life: 4003 }])),
    { level: null, signal: null, why: 'Ring gave no battery level; nor did the camera list' }, '4003 is not a percentage');
  assert.deepStrictEqual(await S.readBattery(lot({}), 200, listed([{ id: 101, battery_life: 50 }])),
    { level: null, signal: null, why: 'Ring gave no battery level; the camera is not in the camera list' });
  assert.deepStrictEqual(await S.readBattery(lot({}), 200, async () => { throw new Error('HTTP 429'); }),
    { level: null, signal: null, why: 'Ring gave no battery level; the camera list: HTTP 429' });
  let asked = 0;
  assert.deepStrictEqual(await S.readBattery(lot({ battery_percentage: 77 }), 200, async () => { asked++; return { allCameras: [] }; }),
    { level: 77, signal: null, why: '' });
  assert.strictEqual(asked, 0, 'the list is fetched only when the health report has no level');
});

/**
 * The every-few-minutes timelapse on a fake clock, as the service runs it.
 * opts: day, start [h, m], frames(i) -> { width, height } | Error | 'hang',
 * battery(now) -> what Ring reports (or an Error), captureMs (each capture,
 * on the fake clock), dockBusy, backupInUse, rss(now) MB, files(now), cfg.
 */
function intervalRig(dir, opts = {}) {
  const day = opts.day || '2026-10-13';
  let t = ny(day, ...(opts.start || [0, 0])).getTime();
  const calls = { live: 0, snap: 0, health: 0, exits: [], liveAt: [] };
  let pending = null;
  // Captures that hang (as when the service is about to die in one), until released.
  const hangs = [];
  const cfg = tlCfg(dir, Object.assign({ times: [], everyMinutes: 5, minBattery: 40, targetHeight: 1080, recordSeconds: 45 }, opts.cfg || {}));
  const camera = opts.noCamera ? null : {
    name: 'Downstream Lot',
    getSnapshot: async () => { calls.snap++; return fakeJpeg(640, 360); },
    getHealth: async () => {
      calls.health++;
      const b = opts.battery ? opts.battery(new Date(t)) : 87;
      if (b instanceof Error) throw b;
      return { battery_percentage: b, latest_signal_strength: -61 };
    },
  };
  const tl = S.createTimelapse(cfg, {
    camera: () => camera,
    now: () => new Date(t),
    setTimer: (fn, ms) => { pending = { fn, ms }; },
    dockBusy: opts.dockBusy, backupInUse: opts.backupInUse,
    exit: (code) => calls.exits.push([code, hhmm(new Date(t))]),
    rssBytes: () => (opts.rss ? opts.rss(new Date(t)) : 90) * 1048576,
    openFiles: () => (opts.files ? opts.files(new Date(t)) : 30),
    strays: () => [],
    dockWaitMs: opts.dockWaitMs !== undefined ? opts.dockWaitMs : 300, dockPollMs: 5,
    // A standby Pi's hooks, when a test gives them.
    standingBy: opts.standingBy, confirm: opts.confirm, quietSummary: opts.quietSummary, wakeDelayMs: opts.wakeDelayMs,
    liveFrame: async (cam, workDir) => {
      const i = calls.live++;
      calls.liveAt.push(hhmm(new Date(t)));
      const f = opts.frames ? opts.frames(i, new Date(t)) : { width: 1920, height: 1080 };
      if (f === 'hang') return new Promise((resolve, reject) => hangs.push(reject));
      t += opts.captureMs !== undefined ? opts.captureMs : 40000;
      if (f instanceof Error) throw f;
      const frame = path.join(workDir, 'frame.jpg');
      fs.writeFileSync(frame, fakeJpeg(f.width, f.height));
      return { frame, liveSeconds: 13, missing: 0, received: 950, checked: ['9.8 s clean'], resolutions: `640x360 from 0.0 s, ${f.width}x${f.height} from 9.8 s`,
        target: 1080, stoppedEarly: f.height >= 1080 ? { at: 12.8, size: f } : null, largest: f };
    },
  });
  // The clock runs on to `until`, waking when the timelapse asks, as setTimeout would.
  const runUntil = async (until) => {
    if (!pending) await tl.intervalTick();
    while (pending && t + pending.ms <= until.getTime()) { const p = pending; pending = null; t += p.ms; await p.fn(); }
  };
  // The next wake-up, not waited for: for a capture that is to hang.
  const startNext = () => { const p = pending; pending = null; t += p.ms; return p.fn(); };
  const release = () => hangs.splice(0).forEach(reject => reject(new Error('released by the test')));
  return { tl, calls, cfg, runUntil, startNext, release, now: () => new Date(t), pending: () => pending, setNow: (d) => { t = d.getTime(); } };
}

test('a day of it (13 October): a frame every 5 minutes from 07:05 to 18:10 - 134, in that day\'s folder - none at night, then the day in one line', async () => {
  const dir = tlDir();
  const rig = intervalRig(dir);
  const wakes = [];
  const lines = await captureLogs(async () => {
    await rig.tl.intervalTick();
    while (rig.pending() && rig.now().getTime() + rig.pending().ms <= ny('2026-10-14', 0, 0).getTime()) {
      const p = rig.pending(); wakes.push(p.ms); rig.setNow(new Date(rig.now().getTime() + p.ms)); await p.fn();
    }
  });
  assert.strictEqual(rig.calls.live, 134);
  assert.deepStrictEqual([rig.calls.liveAt[0], rig.calls.liveAt[133]], ['07:05', '18:10']);
  assert.ok(rig.calls.liveAt.every((x, i) => i === 0 || x > rig.calls.liveAt[i - 1]), 'one per slot, in order');
  assert.deepStrictEqual(visible(dir), ['2026-10-13'], 'one folder for the day - nothing else in sight');
  const files = fs.readdirSync(path.join(dir, '2026-10-13'));
  assert.strictEqual(files.length, 134);
  assert.ok(files.includes('2026-10-13_0705.jpg') && files.includes('2026-10-13_1810.jpg'), files.slice(0, 3).join(', '));
  assert.ok(wakes.every(ms => ms <= 5 * 60000 + 2000), `it never sleeps more than a slot: ${Math.max(...wakes)}`);
  assert.strictEqual(rig.calls.health, 134, 'the battery read before each live view - never at night');
  assert.strictEqual(rig.calls.snap, 0, 'never a snapshot');
  const saved = lines.filter(l => /Timelapse 2026-10-13 \d\d:\d\d: saved 2026-10-13_\d{4}\.jpg - 1920x1080, 0 KB, from live video \(13 s; stopped once 1920x1080 had arrived; 0 of 950 packets missing; resolution 640x360 from 0\.0 s, 1920x1080 from 9\.8 s; keyframes checked: 9\.8 s clean\); took \d+ s\. Battery 87%\. Memory: this program \d+ MB/.test(l));
  assert.strictEqual(saved.length, 134, lines.find(l => /saved/.test(l)));
  const summary = lines.filter(l => /Timelapse 2026-10-13: 134 frames saved \(134 at 1920x1080\); battery 87%, Wi-Fi signal -61 dBm at the last reading; memory: this program \d+ MB/.test(l));
  assert.strictEqual(summary.length, 1, lines.slice(-2).join(' | '));
  assert.ok(lines.indexOf(summary[0]) > lines.findIndex(l => /18:10: saved/.test(l)), 'the summary after the last frame');
  const notes = fs.readFileSync(path.join(dir, '.interval-log'), 'utf8').trim().split('\n');
  assert.strictEqual(notes.length, 268, 'a start and a done for each');
  assert.deepStrictEqual(notes.slice(0, 2), ['2026-10-13 07:05 start', '2026-10-13 07:05 done']);
});

test('the next day starts afresh: its own folder, the note keeps that day only, and resolutions are counted by size', async () => {
  const dir = tlDir();
  const rig = intervalRig(dir, { start: [17, 0], frames: (i) => (i % 3 ? { width: 1280, height: 720 } : { width: 1920, height: 1080 }) });
  const lines = await captureLogs(() => rig.runUntil(ny('2026-10-14', 7, 31)));
  assert.deepStrictEqual(visible(dir), ['2026-10-13', '2026-10-14']);
  assert.strictEqual(fs.readdirSync(path.join(dir, '2026-10-13')).length, 15, '17:00-18:10');
  assert.ok(lines.some(l => /Timelapse 2026-10-13: 15 frames saved \(5 at 1920x1080, 10 at 1280x720\);/.test(l)), lines.filter(l => /frames saved/.test(l)).join(' | '));
  const notes = fs.readFileSync(path.join(dir, '.interval-log'), 'utf8');
  assert.ok(!/2026-10-13/.test(notes) && /2026-10-14 07:30 done/.test(notes), notes);
});

test('the battery: paused under 40%, resumed at 55% - a line each way - and the camera is not woken meanwhile', async () => {
  const dir = tlDir();
  // 50% at 9:00, falling a point every 10 minutes to 38% at 11:00, then
  // charging (sun on the panel) 2 points every 5 minutes from noon.
  const level = (now) => { const m = (now - ny('2026-10-13', 9, 0)) / 60000; return m < 120 ? Math.round(50 - m / 10) : m < 180 ? 38 : Math.round(38 + (m - 180) / 5 * 2); };
  const rig = intervalRig(dir, { start: [9, 0], battery: level });
  const lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 13, 1)));
  const paused = lines.filter(l => /Timelapse paused: "Downstream Lot" battery at 39%: paused under 40%, until it is back to 55%, so the camera keeps its charge for the website's backup\./.test(l));
  assert.strictEqual(paused.length, 1, lines.filter(l => /paused|resumed/.test(l)).join(' | '));
  const resumed = lines.filter(l => /Timelapse resumed at 12:45\./.test(l));
  assert.strictEqual(resumed.length, 1, lines.filter(l => /paused|resumed/.test(l)).join(' | '));
  // 40% at 10:40 still films; 39% at 10:45 pauses; 54% at 12:40 is not yet enough.
  assert.ok(!rig.calls.liveAt.some(x => x > '10:40' && x < '12:45'), `no live view while paused: ${rig.calls.liveAt.join(' ')}`);
  assert.ok(rig.calls.liveAt.includes('10:40') && rig.calls.liveAt.includes('12:45') && rig.calls.liveAt.includes('13:00'), rig.calls.liveAt.join(' '));
  assert.ok(lines.some(l => /12:45: saved .* Battery 56%\./.test(l)), 'the level in each line, to watch the trend');
});

test('a battery level that cannot be read: it carries on, says so once - and a pause stays a pause', async () => {
  const dir = tlDir();
  let mode = 'error';
  const rig = intervalRig(dir, { start: [9, 0], battery: () => (mode === 'error' ? new Error('HTTP 503') : mode === 'low' ? 30 : 'NA') });
  let lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 31)));
  assert.strictEqual(rig.calls.live, 7, 'carried on');
  assert.strictEqual(lines.filter(l => /the battery level of "Downstream Lot" could not be read \(HTTP 503\); carrying on until it can be\./.test(l)).length, 1, lines.join(' | '));
  mode = 'low';
  lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 36)));
  assert.ok(lines.some(l => /Timelapse paused: "Downstream Lot" battery at 30%/.test(l)));
  mode = 'unknown';
  const before = rig.calls.live;
  lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 10, 1)));
  assert.strictEqual(rig.calls.live, before, 'paused while the level cannot be read');
  assert.ok(lines.some(l => /could not be read \(Ring gave "NA"\); still paused until it can be\./.test(l)), lines.join(' | '));
});

test('no battery check at TIMELAPSE_MIN_BATTERY=0: Ring is not even asked', async () => {
  const rig = intervalRig(tlDir(), { start: [9, 0], cfg: { minBattery: 0 }, battery: () => 5 });
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 31)));
  assert.deepStrictEqual([rig.calls.live, rig.calls.health], [7, 0]);
});

test('while the website uses the camera as its backup, the timelapse waits - and resumes when the dock answers', async () => {
  let onBackup = false;
  const rig = intervalRig(tlDir(), { start: [9, 0], backupInUse: () => onBackup });
  const lines = await captureLogs(async () => {
    await rig.runUntil(ny('2026-10-13', 9, 11));
    onBackup = true;
    await rig.runUntil(ny('2026-10-13', 9, 41));
    onBackup = false;
    await rig.runUntil(ny('2026-10-13', 9, 51));
  });
  assert.deepStrictEqual(rig.calls.liveAt, ['09:00', '09:05', '09:10', '09:45', '09:50']);
  assert.strictEqual(lines.filter(l => /Timelapse paused: the website is using "Downstream Lot" as its backup camera, until the dock camera answers again\./.test(l)).length, 1);
  assert.strictEqual(lines.filter(l => /Timelapse resumed at 09:45\./.test(l)).length, 1);
});

test('six failed live views in a row: a rest of an hour, then it tries again; a success resets the count', async () => {
  const dir = tlDir();
  let failing = true;
  const rig = intervalRig(dir, { start: [9, 0], frames: () => (failing ? new Error('the live view gave no video (not answered)') : { width: 1920, height: 1080 }) });
  const lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 10, 31)));
  assert.deepStrictEqual(rig.calls.liveAt, ['09:00', '09:05', '09:10', '09:15', '09:20', '09:25', '10:30'],
    'six tries, an hour off, then again');
  assert.ok(lines.some(l => /Timelapse 2026-10-13 09:00: live video failed \(the live view gave no video \(not answered\)\); no frame this time\. Memory:/.test(l)), lines[0]);
  assert.ok(lines.some(l => /Timelapse: 6 live views in a row failed; resting until 10:25\./.test(l)), lines.join(' | '));
  assert.ok(lines.some(l => /Timelapse paused: resting until 10:25 after 6 failed live views in a row\./.test(l)));
  assert.ok(lines.some(l => /Timelapse resumed at 10:30\./.test(l)));
  assert.strictEqual(rig.calls.snap, 0, 'never a snapshot instead');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '2026-10-13')), [], 'nothing saved');
  failing = false;
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 10, 36)));
  failing = true;
  const lines2 = await captureLogs(() => rig.runUntil(ny('2026-10-13', 11, 6)));
  // 10:30 failed, 10:35 worked: 10:40-11:05 are six failures in a row again, so the rest comes after 11:05 - not before it.
  assert.deepStrictEqual(rig.calls.liveAt.filter(x => x > '10:30'), ['10:35', '10:40', '10:45', '10:50', '10:55', '11:00', '11:05'],
    'the count started again after the success');
  assert.ok(lines2.some(l => /Timelapse: 6 live views in a row failed; resting until 12:05\./.test(l)), lines2.join(' | '));
});

test('a capture that brought the service down is not taken again; after two in a day it stops until the next day', async () => {
  const dir = tlDir();
  // The service dies during its 9:05 capture (killed for memory, say): the
  // capture is noted as started and never as done. (The real thing - the
  // service killed mid-capture - is in the end-to-end tests.)
  const first = intervalRig(dir, { start: [9, 0], frames: (i) => (i === 1 ? 'hang' : { width: 1920, height: 1080 }) });
  await captureLogs(() => first.runUntil(ny('2026-10-13', 9, 1)));
  const dying = first.startNext();   // the 9:05 capture, which never finishes
  await new Promise(r => setTimeout(r, 30));
  assert.deepStrictEqual(first.calls.liveAt, ['09:00', '09:05']);
  assert.ok(/2026-10-13 09:05 start\n$/.test(fs.readFileSync(path.join(dir, '.interval-log'), 'utf8')), 'noted before it started');
  // systemd starts it again a minute later, still in the 9:05 slot.
  const second = intervalRig(dir, { start: [9, 7], frames: (i) => (i === 1 ? 'hang' : { width: 1920, height: 1080 }) });
  let lines = await captureLogs(() => second.runUntil(ny('2026-10-13', 9, 11)));
  assert.ok(lines.some(l => /Timelapse 2026-10-13: the capture at 09:05 never finished \(the service stopped during it\)\./.test(l)), lines.join(' | '));
  assert.deepStrictEqual(second.calls.liveAt, ['09:10'], '9:05 not taken again');
  const dyingAgain = second.startNext();   // 9:15 brings it down too
  await new Promise(r => setTimeout(r, 30));
  const third = intervalRig(dir, { start: [9, 17] });
  lines = await captureLogs(() => third.runUntil(ny('2026-10-13', 18, 0)));
  assert.ok(lines.some(l => /the captures at 09:05, 09:15 never finished \(the service stopped during them\)\./.test(l)), lines.join(' | '));
  assert.strictEqual(lines.filter(l => /Timelapse paused: stopped for today: 2 captures today never finished or ended in a restart \(see above\); it starts again tomorrow\./.test(l)).length, 1, lines.join(' | '));
  assert.strictEqual(third.calls.live, 0, 'the camera not woken again that day');
  assert.strictEqual(third.calls.health, 0);
  lines = await captureLogs(() => third.runUntil(ny('2026-10-14', 7, 6)));
  assert.deepStrictEqual(third.calls.liveAt, ['07:05'], 'the next day it starts again');
  assert.ok(lines.some(l => /Timelapse resumed at 07:05\./.test(l)));
  await captureLogs(async () => { first.release(); second.release(); await dying; await dyingAgain; });
});

test('stopped by systemd during a capture (SIGTERM): noted, and not taken for a crash', async () => {
  const dir = tlDir();
  const first = intervalRig(dir, { start: [9, 0], frames: () => 'hang' });
  const one = first.tl.intervalTick();   // the 9:00 capture, under way when systemd stops the service
  await new Promise(r => setTimeout(r, 30));
  first.tl.noteStopping();
  const again = intervalRig(dir, { start: [9, 3], frames: () => 'hang' });
  await captureLogs(() => again.runUntil(ny('2026-10-13', 9, 4)));
  const two = again.startNext();   // 9:05, stopped too
  await new Promise(r => setTimeout(r, 30));
  again.tl.noteStopping();
  const third = intervalRig(dir, { start: [9, 8] });
  const lines = await captureLogs(() => third.runUntil(ny('2026-10-13', 9, 21)));
  assert.ok(!lines.some(l => /never finished|stopped for today/.test(l)), lines.join(' | '));
  assert.deepStrictEqual(third.calls.liveAt, ['09:10', '09:15', '09:20']);
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, '.interval-log'), 'utf8').split('\n').filter(l => / (start|stopped)$/.test(l)).slice(0, 4),
    ['2026-10-13 09:00 start', '2026-10-13 09:00 stopped', '2026-10-13 09:05 start', '2026-10-13 09:05 stopped']);
  third.tl.noteStopping();
  assert.strictEqual(fs.readFileSync(path.join(dir, '.interval-log'), 'utf8').split('\n').filter(l => / stopped$/.test(l)).length, 2,
    'nothing noted when no capture is under way');
  await captureLogs(async () => { first.release(); again.release(); await one; await two; });
});

test('a restart inside a slot does not take that slot twice', async () => {
  const dir = tlDir();
  await captureLogs(() => intervalRig(dir, { start: [9, 0] }).runUntil(ny('2026-10-13', 9, 1)));
  const again = intervalRig(dir, { start: [9, 2] });
  await captureLogs(() => again.runUntil(ny('2026-10-13', 9, 6)));
  assert.deepStrictEqual(again.calls.liveAt, ['09:05']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '2026-10-13')).sort(), ['2026-10-13_0900.jpg', '2026-10-13_0905.jpg']);
});

test('started mid-slot, or after a capture that ran into the next slot: that slot is taken at once - late, rather than not at all', async () => {
  const dir = tlDir();
  const rig = intervalRig(dir, { start: [9, 3], frames: (i) => ({ width: 1920, height: 1080 }), captureMs: 40000 });
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 4)));
  assert.deepStrictEqual(rig.calls.liveAt, ['09:03'], 'a restart at 9:03 takes the 9:00 slot then');
  const dir2 = tlDir();
  const slow = intervalRig(dir2, { start: [9, 0], captureMs: 6 * 60000 });
  await captureLogs(() => slow.runUntil(ny('2026-10-13', 9, 31)));
  assert.deepStrictEqual(slow.calls.liveAt, ['09:00', '09:06', '09:12', '09:18', '09:24', '09:30'],
    'each 6-minute capture is followed at once by the slot it ran into');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir2, '2026-10-13')).map(f => f.slice(11, 15)), ['0900', '0905', '0910', '0915', '0920', '0930'],
    'the 9:25 slot, run over from start to end, is missed');
});

test('nothing to film with - no camera, no ffmpeg, a full SD card: paused, said once, nothing woken', async () => {
  let rig = intervalRig(tlDir(), { start: [9, 0], noCamera: true });
  let lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 31)));
  assert.strictEqual(lines.filter(l => /Timelapse paused: no camera "Downstream Lot" on the account\./.test(l)).length, 1, lines.join(' | '));
  assert.strictEqual(rig.calls.live, 0);
  rig = intervalRig(tlDir(), { start: [9, 0], cfg: { ffmpegPath: '/nonexistent/ffmpeg' } });
  lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 31)));
  assert.strictEqual(lines.filter(l => /Timelapse paused: ffmpeg is not installed at \/nonexistent\/ffmpeg \(sudo apt install -y --no-install-recommends ffmpeg\)\./.test(l)).length, 1);
  assert.deepStrictEqual([rig.calls.live, rig.calls.health], [0, 0]);
  rig = intervalRig(tlDir(), { start: [9, 0], cfg: { minDiskMb: 1e12 } });
  lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 31)));
  assert.strictEqual(lines.filter(l => /Timelapse paused: only \d+ MB free on the SD card \(it keeps 1000000000000 MB free\): copy the frames off and delete them\./.test(l)).length, 1);
  assert.deepStrictEqual([rig.calls.live, rig.calls.health], [0, 0], 'the camera not woken, Ring not asked');
});

test('a frame due with a dock photo waits for it; a dock photo that never ends does not stop the timelapse', async () => {
  let busyPolls = 0, filmedAfter = null;
  const rig = intervalRig(tlDir(), { start: [9, 0], dockBusy: () => (busyPolls++ < 5),
    frames: () => { filmedAfter = busyPolls; return { width: 1920, height: 1080 }; } });
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 1)));
  assert.deepStrictEqual([filmedAfter, rig.calls.liveAt], [6, ['09:00']], 'filmed once the dock photo was done');
  const stuck = intervalRig(tlDir(), { start: [9, 0], dockBusy: () => true, dockWaitMs: 100 });
  const t0 = Date.now();
  await captureLogs(() => stuck.runUntil(ny('2026-10-13', 9, 1)));
  assert.ok(Date.now() - t0 >= 90 && stuck.calls.live === 1, 'waited its limit, then filmed anyway');
});

test('a test capture (SIGUSR2) under way when slots come: they are skipped, never doubled', async () => {
  const dir = tlDir();
  const rig = intervalRig(dir, { start: [9, 4], frames: (i) => (i === 0 ? 'hang' : { width: 1920, height: 1080 }) });
  const testCapture = rig.tl.captureNow();   // hangs until released
  await new Promise(r => setTimeout(r, 20));
  const lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 6)));
  assert.ok(lines.some(l => /Timelapse 2026-10-13 09:00: skipped - another capture is still running\./.test(l)), lines.join(' | '));
  assert.ok(lines.some(l => /Timelapse 2026-10-13 09:05: skipped - another capture is still running\./.test(l)), lines.join(' | '));
  assert.strictEqual(rig.calls.live, 1, 'only the test capture');
  await captureLogs(async () => { rig.release(); await testCapture; });
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 11)));
  assert.deepStrictEqual(rig.calls.liveAt, ['09:04', '09:10'], 'and then on as usual');
});

test('memory or open files over their limits at two checks in a row: the service restarts itself - not during a capture or a dock photo, at most twice a day', async () => {
  const dir = tlDir();
  let rss = 90, files = 30;
  const rig = intervalRig(dir, { start: [9, 0], rss: () => rss, files: () => files });
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 11)));
  assert.deepStrictEqual(rig.calls.exits, []);
  rss = 170;   // over 160 MB
  let lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 16)));
  assert.deepStrictEqual(rig.calls.exits, [], 'once is a peak, not a leak');
  lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 21)));
  assert.deepStrictEqual(rig.calls.exits, [[75, '09:20']], lines.join(' | '));
  assert.ok(lines.some(l => /Timelapse: this program uses 170 MB of memory \(TIMELAPSE_MAX_RSS_MB is 160\) - restarting the service to start afresh \(systemd starts it again a minute later\)\./.test(l)), lines.join(' | '));
  // The restarted service: memory back to normal, then files leak.
  rss = 90; files = 500;
  const again = intervalRig(dir, { start: [9, 22], rss: () => rss, files: () => files });
  lines = await captureLogs(() => again.runUntil(ny('2026-10-13', 9, 26)));
  assert.deepStrictEqual(again.calls.exits, [[75, '09:25']], 'checked at 9:22 and after the 9:25 capture');
  assert.deepStrictEqual(again.calls.liveAt, ['09:25'], 'the 9:20 slot was taken before the restart');
  assert.ok(lines.some(l => /it has 500 files and connections open \(at most 400 are expected\) - restarting/.test(l)), lines.join(' | '));
  // A third time that day: no more restarts; the timelapse stays stopped and the service carries on.
  const third = intervalRig(dir, { start: [9, 32], rss: () => 999 });
  lines = await captureLogs(() => third.runUntil(ny('2026-10-13', 10, 1)));
  assert.deepStrictEqual(third.calls.exits, []);
  assert.strictEqual(third.calls.live, 0);
  assert.ok(lines.some(l => /Timelapse paused: stopped for today: 2 captures today never finished or ended in a restart/.test(l)), lines.join(' | '));
  assert.strictEqual(lines.filter(l => /but the service has restarted itself 2 times today already: the timelapse stays stopped until tomorrow, and the service carries on\./.test(l)).length, 1, lines.join(' | '));
  // Never in the middle of a dock photo.
  const docking = intervalRig(tlDir(), { start: [9, 0], rss: () => 999, dockBusy: () => true, dockWaitMs: 0 });
  await captureLogs(() => docking.runUntil(ny('2026-10-13', 9, 31)));
  assert.deepStrictEqual(docking.calls.exits, []);
});

test('the every-few-minutes timetable described for --check and the journal', () => {
  const cfg = tlCfg('/opt/nhrc-camera/timelapse', { times: [], everyMinutes: 5, recordSeconds: 45, targetHeight: 1080, minBattery: 40, minDiskMb: 500 });
  assert.strictEqual(S.describeTimelapse(cfg, ny('2026-10-13', 12, 0)),
    '"Downstream Lot" every 5 min from sunrise to sunset (today 07:02-18:14, 134 frames) -> /opt/nhrc-camera/timelapse/YYYY-MM-DD/ '
    + '(the sharpest frame of up to 45 s of live video, stopping once a 1080-line keyframe has arrived; a frame that fails is skipped; '
    + 'paused under 40% battery; keeps 40 MB of memory for Pi-hole and 500 MB of disk free)');
  assert.ok(/every 10 min from 06:30 to 19:00 \(today 06:30-19:00, 76 frames\)/.test(S.describeTimelapse(tlCfg('/x', { times: [], everyMinutes: 10, from: '6:30', until: '19:00' }), ny('2026-10-13', 12, 0))));
  assert.ok(/no battery check/.test(S.describeTimelapse(tlCfg('/x', { times: [], everyMinutes: 5, minBattery: 0 }))));
  assert.ok(/the sharpest frame of 8 s of live video; the snapshot if that fails/.test(S.describeTimelapse(tlCfg('/x'))), 'set times, no early stop');
});

test('the dock scheduler says when its photos are being taken, and when the website is on the backup', async () => {
  let t = ny(DAY, 8, 0).getTime(), pending = null, release;
  const busyDuring = [];
  let tick;
  tick = S.createScheduler(Object.assign({}, prodCfg, { activeStartHour: 0, activeEndHour: 0, intervalMinutes: 15, slowAfterHour: 0 }), {
    now: () => new Date(t), setTimer: (fn, ms) => { pending = { fn, ms }; }, hasPrimary: true, hasBackup: true,
    cycle: async (role) => { busyDuring.push([role, tick.busy()]); if (role === 'primary') throw new Error('offline'); },
  });
  assert.deepStrictEqual([tick.busy(), tick.onBackup()], [false, false]);
  await captureLogs(async () => { await tick(); t += pending.ms; await pending.fn(); });
  assert.deepStrictEqual(busyDuring, [['primary', true], ['primary', true], ['backup', true]]);
  assert.deepStrictEqual([tick.busy(), tick.onBackup()], [false, true], 'after two misses the website is on the backup');
  assert.ok(release === undefined);
});

test('two camera objects for one camera are recognised (the service lists the cameras twice)', () => {
  assert.strictEqual(S.sameCamera({ id: 5, name: 'A' }, { id: 5, name: 'A' }), true);
  assert.strictEqual(S.sameCamera({ id: 5, name: 'A' }, { id: 6, name: 'A' }), false);
  assert.strictEqual(S.sameCamera({ name: 'A' }, { name: 'A' }), true);
  assert.strictEqual(S.sameCamera({ name: 'A' }, null), false);
  assert.strictEqual(S.sameCamera(null, null), false);
});

test('recordings are made in TIMELAPSE_WORK_DIR when it can be used (in memory on the Pi), else the temp folder - and left-overs are swept at start', () => {
  const dir = tlDir();
  const work = path.join(dir, 'run', 'nhrc-camera');
  let r = S.resolveWorkRoot({ workDir: work });
  assert.deepStrictEqual([r.dir, r.note], [work, '']);
  assert.strictEqual(fs.statSync(work).mode & 0o777, 0o700, 'only the service can read the recordings');
  r = S.resolveWorkRoot({ workDir: '/proc/nhrc-camera' });
  assert.strictEqual(r.dir, os.tmpdir());
  assert.ok(/^TIMELAPSE_WORK_DIR \/proc\/nhrc-camera cannot be used \(E[A-Z]+\)$/.test(r.note), r.note);
  assert.deepStrictEqual(S.resolveWorkRoot({ workDir: '' }), { dir: os.tmpdir(), inMemory: S.inMemory(os.tmpdir()), note: '' });
  if (fs.existsSync('/dev/shm')) assert.strictEqual(S.inMemory('/dev/shm'), true, '/dev/shm is in memory');
  assert.strictEqual(S.inMemory('/nonexistent'), null);
  assert.ok(/^\/run\/nhrc-camera-test-\d+ - not there yet \(systemd makes it when the service starts: RuntimeDirectory=\)$/.test(S.describeWorkRoot({ workDir: `/run/nhrc-camera-test-${process.pid}` })));
  for (const name of ['nhrc-timelapse-abc', 'nhrc-timelapse-def', 'keep-me']) fs.mkdirSync(path.join(work, name));
  fs.writeFileSync(path.join(work, 'nhrc-timelapse-abc', 'clip.mkv'), 'x');
  assert.strictEqual(S.sweepWorkRoot(work), 2);
  assert.deepStrictEqual(fs.readdirSync(work), ['keep-me'], 'only the timelapse\'s own left-overs');
  assert.strictEqual(S.sweepWorkRoot('/nonexistent'), 0);
});

test('a capture is made in the work folder it was given, and nothing is left there', async () => {
  const dir = tlDir();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-workroot-'));
  let seen = null;
  const tl = S.createTimelapse(tlCfg(dir), { camera: () => ({ name: 'L' }), now: () => ny(DAY, 20, 0), workRoot: { dir: work },
    liveFrame: async (cam, workDir) => { seen = workDir; const frame = path.join(workDir, 'f.jpg'); fs.writeFileSync(frame, fakeJpeg(1920, 1080));
      return { frame, liveSeconds: 1, missing: 0, received: 1, checked: [] }; } });
  await captureLogs(() => tl.captureNow());
  assert.strictEqual(path.dirname(seen), work);
  assert.deepStrictEqual(fs.readdirSync(work), []);
});

test('an ffmpeg still running after a capture is stopped - it can never sit on memory Pi-hole needs', async () => {
  // A stand-in "ffmpeg" (a copy of sleep), started by this process and left running.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-bin-'));
  fs.copyFileSync('/bin/sleep', path.join(bin, 'ffmpeg'));
  fs.chmodSync(path.join(bin, 'ffmpeg'), 0o755);
  const stray = require('child_process').spawn(path.join(bin, 'ffmpeg'), ['30'], { stdio: 'ignore' });
  await new Promise(r => setTimeout(r, 100));
  assert.deepStrictEqual(S.strayFfmpeg(), [stray.pid], 'found as a child of this process');
  const tl = S.createTimelapse(tlCfg(tlDir()), { camera: () => ({ name: 'L' }), now: () => ny(DAY, 20, 0),
    liveFrame: async (cam, workDir) => { const frame = path.join(workDir, 'f.jpg'); fs.writeFileSync(frame, fakeJpeg(1920, 1080));
      return { frame, liveSeconds: 1, missing: 0, received: 1, checked: [] }; } });
  const exited = new Promise(r => stray.on('exit', (code, signal) => r(signal)));
  const lines = await captureLogs(() => tl.captureNow());
  assert.strictEqual(await exited, 'SIGKILL');
  assert.ok(lines.some(l => /Timelapse test: 1 ffmpeg still running after the capture; stopped\./.test(l)), lines.join(' | '));
  assert.deepStrictEqual(S.strayFfmpeg(), []);
  assert.deepStrictEqual(S.strayFfmpeg(1), [], 'only children of the given process');
  fs.rmSync(bin, { recursive: true, force: true });
});

test('folders are made one level at a time: a path the kernel refuses (under /proc) fails at once instead of hanging the service', () => {
  // fs.mkdirSync(..., { recursive: true }) never returns for /proc/x on Node 22.
  const base = tlDir();
  S.makeDir(path.join(base, 'a', 'b', 'c'), 0o700);
  assert.ok(fs.statSync(path.join(base, 'a', 'b', 'c')).isDirectory());
  assert.strictEqual(fs.statSync(path.join(base, 'a')).mode & 0o777, 0o700);
  S.makeDir(path.join(base, 'a', 'b', 'c'));   // already there: fine
  const t0 = Date.now();
  assert.throws(() => S.makeDir('/proc/nhrc-camera-test/x'), /ENOENT/);
  assert.ok(Date.now() - t0 < 1000);
  fs.writeFileSync(path.join(base, 'file'), '');
  assert.throws(() => S.makeDir(path.join(base, 'file', 'x')), /ENOTDIR/);
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  assert.ok(!/mkdirSync\([^)]*recursive/.test(src), 'no recursive mkdirSync anywhere in the service');
});

test('open files are counted', () => {
  const n = S.openFileCount();
  assert.ok(n === null || (n > 2 && n < S.MAX_OPEN_FILES), String(n));
});

test('after the live view, ffmpeg is given time to finish its file - then killed, never left running', async () => {
  // ring-client-api stops ffmpeg with one SIGTERM; a recording ffmpeg acts on
  // it only when its next packet comes, or after 10 s without one.
  const { spawn } = require('child_process');
  const dir = tlDir();
  const alive = (p) => () => (p.exitCode === null && p.signalCode === null ? [p.pid] : []);
  // One that finishes 600 ms later, writing its last words: waited for, never signalled again.
  const report = path.join(dir, 'ffmpeg.log');
  fs.writeFileSync(report, 'ffmpeg started\n');
  let signals = 0;
  const slow = spawn('bash', ['-c', `trap 'echo TERM >> ${dir}/signals' TERM; sleep 0.6; echo "Exiting normally, received signal 15." >> ${report}; exit 255`]);
  await new Promise(r => setTimeout(r, 50));
  let t0 = Date.now();
  assert.strictEqual(await S.finishFfmpeg(report, alive(slow), { maxMs: 3000 }), true);
  assert.ok(Date.now() - t0 >= 400 && Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
  signals = fs.existsSync(path.join(dir, 'signals')) ? fs.readFileSync(path.join(dir, 'signals'), 'utf8').split('\n').filter(Boolean).length : 0;
  assert.strictEqual(signals, 0, 'no second signal: it would stop ffmpeg writing the end of its file');
  // One that never finishes: killed at the limit.
  const stuck = spawn('bash', ['-c', "trap '' TERM; while true; do sleep 0.05; done"]);
  const exited = new Promise(r => stuck.on('exit', (code, signal) => r(signal)));
  const report2 = path.join(dir, 'ffmpeg2.log');
  fs.writeFileSync(report2, 'ffmpeg started\n');
  t0 = Date.now();
  assert.strictEqual(await S.finishFfmpeg(report2, alive(stuck), { maxMs: 400 }), false);
  assert.strictEqual(await exited, 'SIGKILL', 'killed in the end');
  assert.ok(Date.now() - t0 < 1500);
  assert.strictEqual(S.FFMPEG_FINISH_MS, 15000, 'longer than ffmpeg\'s own 10 s wait for packets');
  // Gone without a word (killed): no wait.
  fs.writeFileSync(report2, 'ffmpeg started\n');
  t0 = Date.now();
  assert.strictEqual(await S.finishFfmpeg(report2, () => [], { maxMs: 3000 }), false);
  assert.ok(Date.now() - t0 < 300);
  assert.strictEqual(await S.finishFfmpeg(path.join(dir, 'none.log'), () => { throw new Error('not asked'); }), false, 'no report: no ffmpeg was started');
  fs.writeFileSync(report2, 'video:4526kB audio:0kB subtitle:0kB other streams:0kB global headers:0kB muxing overhead: 0.031%\n');
  t0 = Date.now();
  assert.strictEqual(await S.finishFfmpeg(report2, () => { throw new Error('not asked'); }), true, 'already finished');
  assert.ok(Date.now() - t0 < 100);
  assert.strictEqual(S.ffmpegDone(report2), true);
});

test('no room for the recording where it is made: not started - the camera not even woken', async () => {
  let woken = 0;
  const cam = { name: 'Downstream Lot', startLiveCall: async () => { woken++; throw new Error('woken'); } };
  await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { ffmpegPath: fakeFfmpeg(), readMemory: () => 400, freeMbAt: () => 20 }), '/run/nhrc-camera/nhrc-timelapse-x'),
    /^Error: not started: only 20 MB free in \/run\/nhrc-camera for the recording; it starts with 24 MB or more$/);
  assert.strictEqual(woken, 0);
  await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { ffmpegPath: fakeFfmpeg(), readMemory: () => 400, freeMbAt: () => 24 }), os.tmpdir()), /woken/);
  assert.strictEqual(woken, 1, 'with 24 MB free (8 for the recording, 16 left) it goes ahead');
  assert.deepStrictEqual([S.CLIP_MAX_MB, S.CLIP_MIN_MB, S.WORK_KEEP_FREE_MB], [32, 8, 16]);
});

// ── The real recording and decoding, with a real 1080p H.264 live stream ──
//
// The camera is stood in for by ffmpeg streaming a 1920x1080 test picture over
// RTP, through a relay that can lose packets, and the recording ffmpeg is
// started with the arguments ring-client-api builds around ours.

const dgram = require('dgram');
const { spawn: spawnProc } = require('child_process');
// The stand-in camera's ffmpeg, under another name (see FakeLiveCall).
const SENDER = path.join(os.tmpdir(), 'ffsender');
if (HAVE_FFMPEG && !fs.existsSync(SENDER)) fs.symlinkSync('/usr/bin/ffmpeg', SENDER);
class FakeLiveCall {
  constructor(opts = {}) {
    this.opts = opts; this.handlers = []; this.ended = false; this.rtpSubs = [];
    this.keyframeRequests = 0; this.spsAllowed = false;
    this.onCallEnded = { subscribe: (fn) => { if (this.ended) fn(); else this.handlers.push(fn); return { unsubscribe() {} }; } };
    this.onVideoRtp = { subscribe: (fn) => { this.rtpSubs.push(fn); return { unsubscribe: () => { this.rtpSubs = []; } }; } };
    // Like ring-client-api's connection: Ring's signalling messages and the
    // answer, both replayed to late subscribers.
    this.messages = []; this.msgSubs = []; this.answered = false; this.answerSubs = [];
    this.connection = {
      onMessage: { subscribe: (fn) => { this.messages.forEach(fn); this.msgSubs.push(fn); return { unsubscribe: () => { this.msgSubs = this.msgSubs.filter(f => f !== fn); } }; } },
      onCallAnswered: { subscribe: (fn) => { if (this.answered) fn('v=0'); else this.answerSubs.push(fn); return { unsubscribe() {} }; } },
    };
  }
  message(m) { this.messages.push(m); this.msgSubs.forEach(fn => fn(m)); }
  answer() { this.answered = true; this.message({ method: 'sdp', body: {} }); this.answerSubs.forEach(fn => fn('v=0')); }
  requestKeyFrame() { this.keyframeRequests++; this.spsAllowed = true; }
  end() {
    if (this.ended) return; this.ended = true;
    try { this.sender && this.sender.kill('SIGKILL'); } catch (e) { /* gone */ }
    for (const s of [this.relay, this.out]) { try { s && s.close(); } catch (e) { /* gone */ } }
    this.handlers.forEach(f => f());
    // As ring-client-api does: the recording ffmpeg gets SIGTERM and stops in
    // good order - on a slow Pi, its last words come a little after the call ended.
    const term = () => { try { this.ff && this.ff.kill('SIGTERM'); } catch (e) { /* gone */ } };
    if (this.opts.termDelayMs) setTimeout(term, this.opts.termDelayMs); else term();
  }
  stop() { this.end(); }
  async startTranscoding(o) {
    this.message({ method: 'session_created', body: {} });
    if (this.opts.noAnswer) { await new Promise(r => this.onCallEnded.subscribe(r)); return; }
    this.answer();
    if (this.opts.ringCloseAfterMs) {
      // Ring ends the live view (a token in the message, which must never reach the log).
      setTimeout(() => { this.message({ method: 'close', body: { reason: { code: 42, text: 'stand-in camera busy' }, token: 'S3CRET-T0KEN' } }); this.end(); },
        this.opts.ringCloseAfterMs);
    }
    const relayPort = 43000 + Math.floor(Math.random() * 4000) * 2, recvPort = relayPort + 9000;
    const sdpFile = path.join(os.tmpdir(), `nhrc-fake-${relayPort}.sdp`);
    // The camera: a live 1920x1080 test picture (or `size`), or a ready-made
    // H.264 stream (`source`) - one whose resolution steps up, as Ring's does.
    const input = this.opts.source
      ? ['-re', '-f', 'h264', '-framerate', '15', '-i', this.opts.source, '-c:v', 'copy']
      : ['-re', '-f', 'lavfi', '-i', `testsrc2=size=${this.opts.size || '1920x1080'}:rate=15`, '-t', '40',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-bf', '0'];
    // The camera's ffmpeg runs under another name (a link): on the Pi the
    // recording ffmpeg is the service's only one, and it is found by name.
    // Nor does it get the report setting: that is the recording ffmpeg's alone.
    const senderEnv = Object.assign({}, process.env);
    delete senderEnv.FFREPORT;
    this.sender = spawnProc(SENDER, ['-v', 'error', ...input, '-an', '-f', 'rtp', '-sdp_file', sdpFile, `rtp://127.0.0.1:${relayPort}`],
      { env: senderEnv });
    this.relay = dgram.createSocket('udp4'); this.out = dgram.createSocket('udp4');
    let start = null, i = 0;
    this.relay.on('message', (msg) => {
      i++;
      const t = start === null ? -1 : (Date.now() - start) / 1000;
      const nal = msg.length > 12 ? msg[12] & 0x1F : 0;   // H.264 NAL type, after the 12-byte RTP header
      const description = nal === 7 || nal === 8 || nal === 24;   // SPS, PPS, or both in one STAP-A
      // Loss right after the first SPS: the keyframe it announces arrives damaged.
      if (description && nal !== 8 && this.firstSpsAt === undefined) this.firstSpsAt = Date.now();
      const afterSps = this.firstSpsAt !== undefined && Date.now() - this.firstSpsAt < 400;
      const drop = (this.opts.loss === 'late' && t >= 5.5 && i % 2 === 0) || (this.opts.loss === 'random' && Math.random() < 0.15)
        || (this.opts.loss === 'sps' && description)
        || (this.opts.loss === 'spsUntilAsked' && description && !this.spsAllowed)
        || (this.opts.loss === 'afterFirstSps' && afterSps && !description && i % 3 === 0);
      // As werift hands them to ring-client-api: the header, and the payload after the 12-byte RTP header.
      if (!drop) { const seq = msg.readUInt16BE(2); this.rtpSubs.forEach(fn => fn({ header: { sequenceNumber: seq }, payload: msg.subarray(12) })); }
      if (!drop && !this.ended) this.out.send(msg, recvPort, '127.0.0.1');
    });
    this.relay.bind(relayPort, '127.0.0.1');
    for (let k = 0; k < 100 && !fs.existsSync(sdpFile); k++) await new Promise(r => setTimeout(r, 50));
    const sdp = fs.readFileSync(sdpFile, 'utf8').replace(/m=video \d+/, `m=video ${recvPort}`);
    fs.unlinkSync(sdpFile);
    const args = ['-hide_banner', '-protocol_whitelist', 'pipe,udp,rtp,file,crypto', '-acodec', 'libopus', '-f', 'sdp',
      ...(o.input || []), '-i', 'pipe:', ...(o.audio || []), ...(o.video || []), ...(o.output || [])];
    this.args = args;
    start = Date.now();
    this.ff = spawnProc(this.opts.ffmpeg || '/usr/bin/ffmpeg', args.map(String), { stdio: ['pipe', 'ignore', 'ignore'] });
    this.ff.on('exit', () => this.end());
    this.ff.stdin.end(sdp);
  }
}
const liveCamera = (opts) => {
  const cam = { name: 'Downstream Lot', calls: [], async startLiveCall() { const c = new FakeLiveCall(opts); cam.calls.push(c); return c; },
    async getSnapshot() { return fakeJpeg(640, 360); } };
  return cam;
};
/** Live (not zombie) child processes of this test run with that name. */
const childrenNamed = (name) => {
  try {
    return fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).filter(pid => {
      try {
        const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
        return st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')) === name && rest[0] !== 'Z'
          && Number(rest[1]) === process.pid;
      } catch (e) { return false; }
    }).length;
  } catch (e) { return 0; }
};
const ffmpegChildren = () => childrenNamed('ffmpeg');

if (HAVE_FFMPEG) {
  test('a clean live stream: the latest keyframe, 1920x1080, recorded without decoding, nothing left behind', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const cam = liveCamera({});
    const r = await S.captureLiveFrame(cam, tlCfg('/tmp'), work);
    const probe = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1920,1080');
    assert.strictEqual(r.missing, 0);
    assert.ok(r.received > 100, String(r.received));
    assert.ok(/^[\d.]+ s 1920x1080 clean$/.test(r.checked[0]), r.checked.join(', '));
    assert.ok(/^1920x1080 from [\d.]+ s$/.test(r.resolutions), r.resolutions);
    await new Promise(res => setTimeout(res, 300));
    const a = cam.calls[0].args.join(' ');
    assert.ok(/-f sdp -buffer_size 8388608 -i pipe: -an -vcodec copy -t 8 -fs (\d+) -f matroska -y \S+clip\.mkv$/.test(a), a);
    const fsLimit = Number(/-fs (\d+)/.exec(a)[1]);
    assert.ok(fsLimit >= S.CLIP_MIN_MB * 1048576 && fsLimit <= S.CLIP_MAX_MB * 1048576, `the recording is capped: ${fsLimit}`);
    assert.strictEqual(process.env.FFREPORT, undefined, 'the ffmpeg report setting is put back');
    assert.strictEqual(ffmpegChildren(), 0, 'no ffmpeg left running');
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('the resolution drops during the recording: the sharper keyframe is kept, and the log says how it went', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const { spawnSync } = require('child_process');
    // Two seconds at 1280x720, then two at 848x480, each keyframe with its own SPS/PPS - as Ring does.
    const seg = (size, out) => spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=15`, '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-bf', '0', '-f', 'h264', '-y', out]);
    seg('1280x720', path.join(work, 'a.h264'));
    seg('848x480', path.join(work, 'b.h264'));
    fs.writeFileSync(path.join(work, 'c.h264'), Buffer.concat([fs.readFileSync(path.join(work, 'a.h264')), fs.readFileSync(path.join(work, 'b.h264'))]));
    const clip = path.join(work, 'clip.mkv');
    assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-f', 'h264', '-framerate', '15', '-i', path.join(work, 'c.h264'),
      '-c', 'copy', '-f', 'matroska', '-y', clip]).status, 0);
    const r = await S.pickKeyframe('/usr/bin/ffmpeg', '/usr/bin/ffprobe', clip, path.join(work, 'frame.jpg'));
    assert.ok(r.frame, r.checked.join(', '));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1280,720', 'the 1280x720 keyframe, not the later 848x480 ones');
    assert.ok(/^1280x720 from [\d.]+ s, 848x480 from [\d.]+ s$/.test(r.resolutions), r.resolutions);
    assert.ok(/^[\d.]+ s 1280x720 clean$/.test(r.checked[0]), r.checked.join(', '));
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('packets lost late in the recording: damaged keyframes are skipped for an earlier clean one', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const r = await S.captureLiveFrame(liveCamera({ loss: 'late' }), tlCfg('/tmp'), work);
    assert.ok(r.checked.some(c => /damaged/.test(c)), r.checked.join(', '));
    assert.ok(/clean$/.test(r.checked[r.checked.length - 1]));
    const check = require('child_process').spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', r.frame, '-f', 'null', '-']);
    assert.strictEqual(check.status, 0, 'what is returned decodes cleanly');
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('packets lost throughout: no damaged picture is passed off - it throws, for the snapshot fallback', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    // Usually every keyframe tried is damaged. Sometimes none survives at all,
    // or the stream's description (SPS/PPS) is lost so often that ffmpeg cannot
    // start the recording ("dimensions not set", about 1 run in 6). All three
    // throw, and nothing is saved from the live video.
    await assert.rejects(S.captureLiveFrame(liveCamera({ loss: 'random' }), tlCfg('/tmp', { recordSeconds: 4 }), work),
      /no clean keyframe \(.*damaged.*packets missing.*\)|the recording has no keyframe|nothing was recorded \(\d+ video packets arrived/);
    await new Promise(res => setTimeout(res, 300));
    assert.strictEqual(ffmpegChildren(), 0);
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('the stream\'s description (SPS/PPS) never arrives: ffmpeg gives up, nothing is saved, the log says why', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const cam = liveCamera({ loss: 'sps' });
    const t0 = Date.now();
    // ffmpeg gives up by itself once it has read 5 MB (its probesize); the
    // keyframe requests went unanswered; the log has the whole story.
    await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { keyframeAskMs: 500 }), work),
      /^Error: nothing was recorded \(\d+ video packets arrived, \d+ missing; answered after [\d.]+ s; video [\d.]+-[\d.]+ s; ended at [\d.]+ s; \d+ keyframe requests; Ring: session_created, sdp; ffmpeg: .*(dimensions not set|Could not find codec parameters|unspecified size)/);
    assert.ok(cam.calls[0].keyframeRequests >= 2, `asked ${cam.calls[0].keyframeRequests} times`);
    assert.ok(Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
    await new Promise(res => setTimeout(res, 1000));
    assert.strictEqual(ffmpegChildren(), 0);
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('the stream\'s description comes only when asked: asking for a keyframe gets the recording going', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const cam = liveCamera({ loss: 'spsUntilAsked' });
    const r = await S.captureLiveFrame(cam, tlCfg('/tmp', { keyframeAskMs: 500 }), work);
    const probe = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1920,1080');
    assert.ok(cam.calls[0].keyframeRequests >= 1, 'a keyframe was asked for');
    // Every 0.5 s until ffmpeg starts the file (a few seconds), not for all the 8 s after.
    assert.ok(cam.calls[0].keyframeRequests < 14, `and no more once the recording had started (${cam.calls[0].keyframeRequests})`);
    await new Promise(res => setTimeout(res, 1000));
    assert.strictEqual(ffmpegChildren(), 0);
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('Ring ends the live view early: the log says how far it got and what Ring said - never a token', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    // No description yet, so nothing recorded, when Ring closes the call at 1.5 s.
    const cam = liveCamera({ loss: 'sps', ringCloseAfterMs: 1500, termDelayMs: 400 });
    const err = await S.captureLiveFrame(cam, tlCfg('/tmp'), work).then(() => null, (e) => e);
    assert.ok(err, 'it failed');
    assert.ok(/^nothing was recorded \(\d+ video packets arrived, \d+ missing; answered after [\d.]+ s; video [\d.]+-[\d.]+ s; ended at [\d.]+ s; Ring: session_created, sdp, close \{"reason":\{"code":42,"text":"stand-in camera busy"\},"token":"\(hidden\)"\}; .*ffmpeg was stopped \(signal 15\)/.test(err.message), err.message);
    assert.ok(!/S3CRET-T0KEN/.test(err.message), 'the token never reaches the log');
    assert.strictEqual(err.cameraStreamed, true, 'the fallback snapshot will wait for the camera');
    await new Promise(res => setTimeout(res, 1000));
    assert.strictEqual(ffmpegChildren(), 0);
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('a live view that never answers is ended at its deadline', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const cam = liveCamera({ noAnswer: true });
    const t0 = Date.now();
    await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { recordSeconds: 4, liveExtraMs: 1000 }), work), /the live view gave no video \(not answered; no video; ended at [\d.]+ s; Ring: session_created\)/);
    assert.ok(Date.now() - t0 < 10000);
    assert.strictEqual(cam.calls[0].ended, true, 'the live view was ended');
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('a live view that starts only after we gave up on it is ended at once', async () => {
    let lateCall = null, resolveStart;
    const cam = { name: 'Downstream Lot', startLiveCall: () => new Promise((r) => { resolveStart = r; }) };
    await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { startTimeoutMs: 100 }), os.tmpdir()),
      /starting the live view took longer than 0 s/);
    lateCall = new FakeLiveCall({});
    resolveStart(lateCall);
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(lateCall.ended, true, 'stopped as soon as it appeared: the battery camera does not stream for nobody');
  });

  test('ffmpeg missing: the camera is not even woken for the live view', async () => {
    const cam = liveCamera({});
    await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { ffmpegPath: '/nonexistent/ffmpeg' }), os.tmpdir()), /sudo apt install/);
    assert.strictEqual(cam.calls.length, 0);
  });

  test('four captures in a row: no memory creep, no ffmpeg left behind, no temporary files', async () => {
    const dir = tlDir();
    const before = leftoverWorkDirs().length;
    const cfg = tlCfg(dir, { recordSeconds: 4 });
    const cam = liveCamera({});
    const tl = S.createTimelapse(cfg, { camera: () => cam, now: () => new Date() });
    const rss = [];
    await captureLogs(async () => {
      for (let i = 0; i < 4; i++) {
        await tl.captureNow();
        if (global.gc) global.gc();
        rss.push(process.memoryUsage().rss);
        await new Promise(r => setTimeout(r, 1100));   // a new second, a new test file name
      }
    });
    assert.strictEqual(fs.readdirSync(path.join(dir, 'tests')).length, 4, 'four frames saved');
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(ffmpegChildren(), 0);
    assert.strictEqual(leftoverWorkDirs().length, before);
    const growth = (rss[3] - rss[1]) / 1048576;
    assert.ok(growth < 20, `memory grew ${growth.toFixed(1)} MB from capture 2 to 4`);
  }, 120000);

  test('memory running short during the live video: the live view and ffmpeg are stopped at once', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const cam = liveCamera({});
    const t0 = Date.now();
    let reads = 0;
    // Plenty at first; two seconds in, the Pi is short.
    const readMemory = () => { reads++; return Date.now() - t0 < 2000 ? 400 : 30; };
    await assert.rejects(S.captureLiveFrame(cam, tlCfg('/tmp', { readMemory, memoryCheckMs: 100 }), work),
      /^Error: stopped: the memory available fell to 30 MB, below the 40 MB kept for Pi-hole$/);
    const took = Date.now() - t0;
    assert.ok(took < 5000, `stopped after ${took} ms, not at the end of the 8 s recording`);
    assert.strictEqual(cam.calls[0].ended, true, 'the live view was ended');
    await new Promise(r => setTimeout(r, 1000));
    assert.strictEqual(ffmpegChildren(), 0, 'no ffmpeg left running');
    const n = reads;
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(reads, n, 'the memory watch ended with the capture');
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('memory running short once the recording is under way: ffmpeg is killed at once, not left waiting for packets', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const clip = path.join(work, 'clip.mkv');
    let recordingSince = null;
    // Plenty until ffmpeg has been writing the file for 1.5 s - past its start-up, when one signal no longer stops it.
    const readMemory = () => {
      if (recordingSince === null && fs.existsSync(clip) && fs.statSync(clip).size > 0) recordingSince = Date.now();
      return recordingSince !== null && Date.now() - recordingSince > 1500 ? 30 : 400;
    };
    await assert.rejects(S.captureLiveFrame(liveCamera({}), tlCfg('/tmp', { recordSeconds: 20, readMemory, memoryCheckMs: 100 }), work),
      /^Error: stopped: the memory available fell to 30 MB, below the 40 MB kept for Pi-hole$/);
    assert.ok(recordingSince !== null, 'it was recording');
    await new Promise(r => setTimeout(r, 500));
    assert.strictEqual(ffmpegChildren(), 0, 'the recording ffmpeg is gone');
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('memory running short while a keyframe is decoded: the decoder is killed at once', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    // A decoder that would take 30 s (its own deadline is 45 s); the real ffprobe.
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-bin-'));
    fs.writeFileSync(path.join(bin, 'ffmpeg'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    fs.symlinkSync('/usr/bin/ffprobe', path.join(bin, 'ffprobe'));
    let decoding = null;
    const readMemory = () => {
      if (decoding === null && childrenNamed('sleep') > 0) decoding = Date.now();
      return decoding === null ? 400 : 30;
    };
    await assert.rejects(S.captureLiveFrame(liveCamera({}),
      tlCfg('/tmp', { ffmpegPath: path.join(bin, 'ffmpeg'), recordSeconds: 4, readMemory, memoryCheckMs: 100 }), work),
      /stopped: the memory available fell to 30 MB/);
    assert.ok(decoding !== null, 'the decoder was running when memory ran short');
    assert.ok(Date.now() - decoding < 3000, `killed at once, not at its deadline (${Date.now() - decoding} ms)`);
    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(childrenNamed('sleep'), 0, 'the decoder is gone');
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });

  test('a saved frame says how little memory the Pi had during the capture', async () => {
    const dir = tlDir();
    let reads = 0;
    const tl = S.createTimelapse(tlCfg(dir, { recordSeconds: 4, memoryCheckMs: 100,
      readMemory: () => { reads++; return reads === 3 ? 151.2 : 250; } }), { camera: () => liveCamera({}), now: () => new Date() });
    const lines = await captureLogs(() => tl.captureNow());
    assert.ok(lines.some(l => /Timelapse test: saved \S+\.jpg - 1920x1080.*; the Pi had at least 151 MB available throughout\.$/.test(l)), lines.join(' | '));
    const n = reads;
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(reads, n, 'the memory watch ended with the capture');
  });
  // ── The real service process, end to end ──
  // A stand-in ring-client-api whose live view is the same real 1080p stream.
  function timelapseSandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-e2e-'));
    fs.copyFileSync(path.join(__dirname, 'snapshot_service.js'), path.join(dir, 'snapshot_service.js'));
    const ringLog = path.join(dir, 'ring.log');
    liveRingLibrary(dir, ringLog);
    fs.writeFileSync(path.join(dir, 'token'), 'stand-in-refresh-token');
    const uploads = path.join(dir, 'uploads.log');
    // Uploads are counted; a check-in (the main Pi's, every 5 minutes) is
    // answered as a Worker that has heard from no other Pi would.
    fs.writeFileSync(path.join(dir, 'fakefetch.js'), `
      const fs = require('fs');
      globalThis.fetch = async (url, opts) => {
        if (new URL(String(url)).pathname === '/heartbeat') {
          return { ok: true, status: 200, json: async () => ({ ok: true, conflict: false, main: null, standby: null, photo: null }) };
        }
        fs.appendFileSync(${JSON.stringify(uploads)}, JSON.stringify({ role: opts.headers['X-Camera-Role'] || null }) + String.fromCharCode(10));
        return { ok: true, status: 200, text: async () => 'OK' };
      };`);
    const tlOut = path.join(dir, 'timelapse');
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const events = () => (fs.existsSync(ringLog) ? fs.readFileSync(ringLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
    const run = (args, env, { until = null, maxMs = 40000, onStart = null } = {}) => new Promise((resolve) => {
      const { spawn: sp } = require('child_process');
      const child = sp(process.execPath, ['-r', path.join(dir, 'fakefetch.js'), path.join(dir, 'snapshot_service.js'), ...args], {
        cwd: dir,
        // Its own temp folder: the service sweeps left-over recordings there at start.
        env: Object.assign({ PATH: process.env.PATH, HOME: dir, TMPDIR: tmp, RING_TOKEN_FILE: path.join(dir, 'token'),
          CAMERA_UPLOAD_URL: 'https://nhrc-camera.club-acct.workers.dev/latest.jpg', CAMERA_UPLOAD_SECRET: baseCfg.uploadSecret,
          RING_CAMERA_NAME: 'Dock Wired', RING_BACKUP_CAMERA_NAME: 'Downstream Lot', TIMELAPSE_DIR: tlOut,
          CAMERA_RETRIES: '1', CAMERA_RETRY_DELAY_SECONDS: '0' }, env),
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      if (onStart) onStart(child, () => out);
      const started = Date.now();
      const poll = setInterval(() => {
        if ((until && until(out)) || Date.now() - started > maxMs) child.kill('SIGKILL');
      }, 100);
      child.on('exit', (code, signal) => { clearInterval(poll); resolve({ code, signal, out }); });
    });
    const nowLabel = () => { const p = S.localDateParts(new Date(), { timeZone: 'America/New_York' });
      return { date: p.date, label: `${String(Math.floor(p.minutes / 60)).padStart(2, '0')}:${String(p.minutes % 60).padStart(2, '0')}` }; };
    return { dir, tlOut, tmp, run, events, nowLabel, uploads: () => (fs.existsSync(uploads) ? fs.readFileSync(uploads, 'utf8').split('\n').filter(Boolean).length : 0) };
  }

  test('end to end: the running service saves a 1920x1080 frame at its time, right after the dock photo', async () => {
    const box = timelapseSandbox();
    const now = box.nowLabel();
    const r = await box.run([], { TIMELAPSE_TIMES: now.label, TIMELAPSE_RECORD_SECONDS: '4' }, { until: (o) => /Timelapse \S+ \S+: (saved|live video failed)|Timelapse.*: no camera/.test(o) });
    assert.ok(/Timelapse: "Downstream Lot" at \d\d:\d\d -> \S+timelapse \(the sharpest frame of up to 4 s of live video, stopping once a 1080-line keyframe has arrived; the snapshot if that fails; keeps 40 MB of memory for Pi-hole and 500 MB of disk free\); recorded in \S+( \((in memory|on the SD card)\))?\. Test it now with: sudo kill -USR2 \d+/.test(r.out), r.out);
    assert.ok(/saved \d{4}-\d\d-\d\d_\d{4}\.jpg - 1920x1080, \d+ KB, from live video/.test(r.out), r.out);
    assert.ok(/; the Pi had at least \d+ MB available throughout\./.test(r.out), 'the real /proc/meminfo was watched');
    const files = fs.readdirSync(box.tlOut).filter(f => f.endsWith('.jpg'));
    assert.strictEqual(files.length, 1, files.join(', '));
    assert.ok(box.uploads() >= 1, 'the dock photo was uploaded');
    assert.ok(r.out.indexOf('Snapshot uploaded') < r.out.indexOf('Timelapse ' + now.date), 'dock photo first');
    const ev = box.events();
    assert.strictEqual(ev.find(e => e.ev === 'construct').ffmpegPath, '/usr/bin/ffmpeg');
    assert.deepStrictEqual(ev.filter(e => e.ev === 'live').map(e => e.camera), ['Downstream Lot']);
    assert.ok(!ev.some(e => e.ev === 'snapshot' && e.camera === 'Downstream Lot'), 'no snapshot of the battery camera needed');
  }, 60000);

  test('end to end: a test capture on request (SIGUSR2), inside the running service', async () => {
    const box = timelapseSandbox();
    const r = await box.run([], { TIMELAPSE_TIMES: '3:00', TIMELAPSE_RECORD_SECONDS: '4' }, {
      onStart: (child, out) => { const iv = setInterval(() => { if (/Test it now with/.test(out())) { clearInterval(iv); child.kill('SIGUSR2'); } }, 100); },
      until: (o) => /Timelapse test: (saved|live video failed)/.test(o) });
    assert.ok(/Timelapse test requested\./.test(r.out), r.out);
    assert.ok(/Timelapse test: saved \S+\.jpg - 1920x1080/.test(r.out), r.out);
    assert.strictEqual(fs.readdirSync(path.join(box.tlOut, 'tests')).filter(f => f.endsWith('.jpg')).length, 1);
    assert.strictEqual(r.signal, 'SIGKILL', 'still running after the test capture (stopped by the test)');
  }, 60000);

  test('end to end: a test signal while the service is still starting does not stop it', async () => {
    const box = timelapseSandbox();
    let sent = false;
    const r = await box.run([], { TIMELAPSE_TIMES: '3:00', TIMELAPSE_RECORD_SECONDS: '4', FAKE_SLOW_CAMERAS_MS: '1500' }, {
      // Sent while it is still signing in to Ring, as on the Pi 12 s after a restart.
      onStart: (child) => { const iv = setInterval(() => {
        if (box.events().some(e => e.ev === 'construct')) { clearInterval(iv); sent = true; child.kill('SIGUSR2'); } }, 20); },
      until: (o) => /Snapshot uploaded/.test(o) });
    assert.ok(sent, 'the signal was sent');
    assert.ok(/Timelapse test requested while the service is still starting; send it again once the journal says "Test it now"\./.test(r.out), r.out);
    assert.ok(/Test it now with: sudo kill -USR2 \d+/.test(r.out) && /Snapshot uploaded/.test(r.out), 'it started up as usual');
    assert.strictEqual(r.signal, 'SIGKILL', 'still running until the test stopped it - not ended by the signal');
    assert.ok(!box.events().some(e => e.ev === 'live'), 'a signal that came too early takes no picture');
  }, 60000);

  test('end to end: with the timelapse off, a test signal says so and stops nothing', async () => {
    const box = timelapseSandbox();
    const r = await box.run([], {}, {
      onStart: (child, out) => { const iv = setInterval(() => { if (/Snapshot uploaded/.test(out())) { clearInterval(iv); child.kill('SIGUSR2'); } }, 50); },
      until: (o) => /Timelapse test requested/.test(o), maxMs: 15000 });
    assert.ok(/Timelapse test requested, but the timelapse is off \(neither TIMELAPSE_EVERY_MINUTES nor TIMELAPSE_TIMES is set\)\./.test(r.out), r.out);
    assert.strictEqual(r.signal, 'SIGKILL', 'still running until the test stopped it');
  });

  test('end to end: a capture that kills the service is not tried again when systemd restarts it', async () => {
    const box = timelapseSandbox();
    const now = box.nowLabel();
    // The service dies the moment its live view starts.
    let r = await box.run([], { TIMELAPSE_TIMES: now.label, FAKE_DIE_ON_LIVE: '1' }, { maxMs: 30000 });
    assert.strictEqual(r.signal, 'SIGKILL', r.out);
    assert.strictEqual(box.events().filter(e => e.ev === 'live').length, 1);
    // Restarted, still inside the window: the dock photo as usual, no second live view.
    r = await box.run([], { TIMELAPSE_TIMES: now.label }, { until: (o) => /already tried before the service restarted/.test(o) });
    assert.ok(/Snapshot uploaded/.test(r.out), r.out);
    assert.ok(new RegExp(`Timelapse ${now.date} ${now.label}: already tried before the service restarted; not tried again today\\.`).test(r.out), r.out);
    await new Promise(res => setTimeout(res, 300));
    assert.strictEqual(box.events().filter(e => e.ev === 'live').length, 1, 'the camera was not woken again');
    assert.deepStrictEqual(fs.readdirSync(box.tlOut).filter(f => f.endsWith('.jpg')), []);
  }, 90000);

  test('end to end: Ring ends the live view - the journal says what Ring and ffmpeg did, then the snapshot is saved', async () => {
    const box = timelapseSandbox();
    const now = box.nowLabel();
    const r = await box.run([], { TIMELAPSE_TIMES: now.label, FAKE_RING_CLOSE: '1', TIMELAPSE_SNAPSHOT_PAUSE_SECONDS: '1' },
      { until: (o) => /saved the snapshot instead|the snapshot failed too/.test(o), maxMs: 45000 });
    assert.ok(/live video failed \(nothing was recorded \(\d+ video packets arrived, \d+ missing; answered after [\d.]+ s; video [\d.]+-[\d.]+ s; ended at [\d.]+ s; Ring: session_created, sdp, close \{"reason":\{"code":42,"text":"stand-in camera busy"\},"token":"\(hidden\)"\}; Ring error: Video stream closed \/ error: \{"reason":\{"code":42,"text":"stand-in camera busy"\},"token":"\(hidden\)"\}; .*ffmpeg was stopped \(signal 15\)\)\); saved the snapshot instead: \S+_snapshot\.jpg - 640x360/.test(r.out), r.out);
    assert.ok(!/S3CRET-T0KEN/.test(r.out), 'no token in the journal');
    assert.ok(box.events().some(e => e.ev === 'snapshot' && e.camera === 'Downstream Lot'), 'the fallback snapshot was taken');
  }, 60000);

  test('end to end: no ffmpeg - said at start, the snapshot is saved instead, the service carries on', async () => {
    const box = timelapseSandbox();
    const now = box.nowLabel();
    const r = await box.run([], { TIMELAPSE_TIMES: now.label, FFMPEG_PATH: '/nonexistent/ffmpeg' }, { until: (o) => /saved the snapshot instead|the snapshot failed/.test(o) });
    assert.ok(/Timelapse: ffmpeg is not installed at \/nonexistent\/ffmpeg - frames will be 640x360 snapshots/.test(r.out), r.out);
    assert.ok(/saved the snapshot instead: \S+_snapshot\.jpg - 640x360/.test(r.out), r.out);
    assert.ok(!box.events().some(e => e.ev === 'live'), 'no live view without ffmpeg');
    assert.ok(box.uploads() >= 1, 'the dock photo went up as usual');
  }, 60000);

  test('end to end: --check describes the timelapse; a bad setting fails --check, and the service runs without the timelapse', async () => {
    const box = timelapseSandbox();
    let r = await box.run(['--check'], { TIMELAPSE_TIMES: '8:00,12:00,15:00' });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(/Configuration looks valid\./.test(r.out), r.out);
    assert.ok(/timelapse {4}: "Downstream Lot" at 08:00, 12:00, 15:00 -> \S+ \(the sharpest frame of up to 45 s of live video, stopping once a 1080-line keyframe has arrived; the snapshot if that fails; keeps 40 MB of memory for Pi-hole and 500 MB of disk free\); ffmpeg found/.test(r.out), r.out);
    assert.ok(/recordings {3}: \S+ - (in memory|on the SD card)/.test(r.out), r.out);
    r = await box.run(['--check'], {});
    assert.ok(/timelapse {4}: off/.test(r.out), r.out);
    assert.ok(!/recordings/.test(r.out), r.out);
    r = await box.run(['--check'], { TIMELAPSE_TIMES: '8:00,noon' });
    assert.strictEqual(r.code, 1, '--check fails, so a deploy is stopped before the restart');
    assert.ok(/TIMELAPSE_TIMES: "noon" is not a time/.test(r.out) && /timelapse {4}: OFF - its settings have problems/.test(r.out), r.out);
    // The service itself: the dock photos go on, the timelapse is off and says why.
    r = await box.run([], { TIMELAPSE_TIMES: '8:00,noon' }, { until: (o) => /Snapshot uploaded/.test(o), maxMs: 15000 });
    assert.strictEqual(r.signal, 'SIGKILL', `still running: ${r.out}`);
    assert.ok(/Timelapse settings problems - the timelapse is OFF until they are fixed \(the dock photos are not affected\):\n {2}- TIMELAPSE_TIMES: "noon" is not a time/.test(r.out), r.out);
    assert.ok(/Snapshot uploaded/.test(r.out) && box.uploads() >= 1, 'the website still gets its photos');
    assert.ok(!box.events().some(e => e.ev === 'live'), 'no live view');
    assert.strictEqual(box.events().find(e => e.ev === 'construct').ffmpegPath, null, 'the Ring library built as without a timelapse');
  }, 60000);

  test('end to end: with the timelapse off, the service is exactly as before - no ffmpeg, no live view', async () => {
    const box = timelapseSandbox();
    const r = await box.run([], {}, { until: (o) => /Snapshot uploaded/.test(o), maxMs: 10000 });
    assert.ok(!/Timelapse/.test(r.out), r.out);
    const ev = box.events();
    assert.strictEqual(ev.find(e => e.ev === 'construct').ffmpegPath, null, 'RingApi built exactly as before');
    assert.ok(!ev.some(e => e.ev === 'live'));
    assert.ok(!ev.some(e => e.ev === 'health'), 'nor any battery reading');
  });

  // ── Stopping early once 1080 lines have arrived (real ffmpeg) ──

  test('it stops once a 1080-line keyframe has arrived whole: 1920x1080 in seconds, not the 30 allowed', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const t0 = Date.now();
    const r = await S.captureLiveFrame(liveCamera({}), tlCfg('/tmp', { recordSeconds: 30, targetHeight: 1080 }), work);
    const took = (Date.now() - t0) / 1000;
    assert.ok(r.stoppedEarly && r.stoppedEarly.size.width === 1920 && r.stoppedEarly.size.height === 1080, JSON.stringify(r.stoppedEarly));
    assert.ok(r.liveSeconds < 10 && took < 15, `live ${r.liveSeconds} s, all ${took} s`);
    const probe = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1920,1080');
    assert.ok(/^[\d.]+ s 1920x1080 clean$/.test(r.checked[0]), r.checked.join(', '));
    await new Promise(res => setTimeout(res, 300));
    assert.strictEqual(ffmpegChildren(), 0);
    fs.rmSync(work, { recursive: true, force: true });
  });

  test('1080 never comes (a 1280x720 stream): the whole recording, its sharpest frame, and the log says so', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const r = await S.captureLiveFrame(liveCamera({ size: '1280x720' }), tlCfg('/tmp', { recordSeconds: 6, targetHeight: 1080 }), work);
    assert.strictEqual(r.stoppedEarly, null);
    assert.deepStrictEqual(r.largest, { width: 1280, height: 720 });
    assert.strictEqual(r.target, 1080);
    assert.ok(r.liveSeconds >= 6, String(r.liveSeconds));
    const probe = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1280,720');
    // And in the journal line:
    const dir = tlDir();
    const tl = S.createTimelapse(tlCfg(dir, { recordSeconds: 4, targetHeight: 1080 }), { camera: () => liveCamera({ size: '1280x720' }), now: () => new Date() });
    const lines = await captureLogs(() => tl.captureNow());
    assert.ok(lines.some(l => /Timelapse test: saved \S+ - 1280x720, \d+ KB, from live video \(\d+ s; 1080 lines not reached \(1280x720 at most\); 0 of \d+ packets missing; resolution 1280x720 from [\d.]+ s; keyframes checked: /.test(l)), lines.join(' | '));
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('Ring\'s step up from 640x360 to 1920x1080: it stops once 1080 has arrived, and keeps that frame - even when ffmpeg is slow to finish its file, as on a Pi', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const { spawnSync } = require('child_process');
    // 3 s at 640x360 (a keyframe a second), then 1920x1080 with a single
    // keyframe - so the 1080 frame is the last thing ffmpeg writes, when it stops.
    const seg = (size, secs, gop, out) => spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=15`, '-t', String(secs),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', String(gop), '-bf', '0', '-f', 'h264', '-y', out]);
    seg('640x360', 3, 15, path.join(work, 'a.h264'));
    seg('1920x1080', 8, 150, path.join(work, 'b.h264'));
    const src = path.join(work, 'steps.h264');
    fs.writeFileSync(src, Buffer.concat([fs.readFileSync(path.join(work, 'a.h264')), fs.readFileSync(path.join(work, 'b.h264'))]));
    const cam = liveCamera({ source: src, termDelayMs: 1500 });
    const r = await S.captureLiveFrame(cam, tlCfg('/tmp', { recordSeconds: 20, targetHeight: 1080 }), work);
    assert.ok(r.stoppedEarly, 'stopped early');
    assert.ok(r.liveSeconds < 12, String(r.liveSeconds));
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1920,1080', `the 1080 keyframe, written as ffmpeg finished: ${r.checked.join(', ')}`);
    assert.ok(/^640x360 from [\d.]+ s, 1920x1080 from [\d.]+ s$/.test(r.resolutions), r.resolutions);
    await new Promise(res => setTimeout(res, 300));
    assert.strictEqual(ffmpegChildren(), 0);
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('packets lost right after the 1080-line keyframe: it waits for the next one rather than stop on a damaged picture', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const r = await S.captureLiveFrame(liveCamera({ loss: 'afterFirstSps' }), tlCfg('/tmp', { recordSeconds: 30, targetHeight: 1080 }), work);
    assert.ok(r.stoppedEarly, 'stopped early, in the end');
    // The first keyframe (damaged) came at once, the next 2 s later; 3 s after that it stops.
    assert.ok(r.stoppedEarly.at >= 4.5 && r.stoppedEarly.at < 12, `stopped at ${r.stoppedEarly.at} s`);
    assert.ok(r.missing > 0, 'packets were lost');
    const check = require('child_process').spawnSync('ffmpeg', ['-v', 'error', '-xerror', '-err_detect', 'explode', '-i', r.frame, '-f', 'null', '-']);
    assert.strictEqual(check.status, 0, 'what is returned decodes cleanly');
    const probe = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1920,1080');
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('Ring ends the live view mid-recording: ffmpeg is given the time to finish its file - the last keyframe is kept, no ffmpeg left', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const t0 = Date.now();
    // Keyframes every 2 s; Ring closes the live view at 7 s.
    const r = await S.captureLiveFrame(liveCamera({ ringCloseAfterMs: 7000 }), tlCfg('/tmp', { recordSeconds: 20 }), work);
    const took = Date.now() - t0;
    assert.ok(took > 12000 && took < 30000, `ffmpeg waited its 10 s for packets, then finished: ${took} ms`);
    const probe = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r.frame], { encoding: 'utf8' });
    assert.strictEqual(probe.stdout.trim(), '1920,1080');
    // The file was finished properly - the end written, the last keyframe in it - and that keyframe is the one kept.
    const clip = path.join(work, 'clip.mkv');
    const ends = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', clip], { encoding: 'utf8' });
    assert.ok(!/ended prematurely/.test(ends.stderr), ends.stderr);
    const keys = ends.stdout.trim().split('\n').map(Number);
    assert.ok(keys.length >= 2, `keyframes every 2 s: ${keys}`);
    assert.strictEqual(r.checked[0], `${keys[keys.length - 1].toFixed(1)} s 1920x1080 clean`, `the last keyframe: ${r.checked.join(', ')}`);
    const report = fs.readFileSync(path.join(work, 'ffmpeg.log'), 'utf8');
    assert.ok(/received signal 15/.test(report) && !/Immediate exit requested/.test(report), 'it finished on the one signal, the end of its file written');
    await new Promise(res => setTimeout(res, 300));
    assert.strictEqual(ffmpegChildren(), 0, 'nothing left running');
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('at its deadline the recording is stopped while the video still flows: ffmpeg finishes at once, not 10 s later', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const t0 = Date.now();
    // A deadline 5 s in (20 s asked for, less 15): the stream is still running.
    const r = await S.captureLiveFrame(liveCamera({}), tlCfg('/tmp', { recordSeconds: 20, liveExtraMs: -15000 }), work);
    const took = Date.now() - t0;
    assert.ok(took < 10000, `finished at once: ${took} ms`);
    assert.ok(r.liveSeconds >= 4.5 && r.liveSeconds < 8, String(r.liveSeconds));
    const ends = require('child_process').spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(work, 'clip.mkv')], { encoding: 'utf8' });
    assert.ok(!/ended prematurely/.test(ends.stderr), ends.stderr);
    await new Promise(res => setTimeout(res, 300));
    assert.strictEqual(ffmpegChildren(), 0);
    fs.rmSync(work, { recursive: true, force: true });
  }, 45000);

  test('the recording is capped to the room where it is made', async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-work-'));
    const cam = liveCamera({});
    await S.captureLiveFrame(cam, tlCfg('/tmp', { recordSeconds: 4, freeMbAt: () => 30 }), work);
    assert.ok(/-t 4 -fs 14680064 -f matroska/.test(cam.calls[0].args.join(' ')), '30 MB free: 14 MB for the recording, 16 MB left');
    fs.rmSync(work, { recursive: true, force: true });
  });

  // ── Every 5 minutes, end to end: the real service process ──

  const allDay = { TIMELAPSE_EVERY_MINUTES: '5', TIMELAPSE_FROM: '0:00', TIMELAPSE_UNTIL: '23:59' };

  test('end to end: every 5 minutes (all day, for the test) - the first frame right after the first dock photo, in the day\'s folder, noted on disk', async () => {
    const box = timelapseSandbox();
    const t0 = Date.now();
    const r = await box.run([], Object.assign({ TIMELAPSE_RECORD_SECONDS: '20', TIMELAPSE_WORK_DIR: path.join(box.dir, 'run') }, allDay),
      { until: (o) => /Timelapse \S+ \S+: (saved|live video failed)/.test(o), maxMs: 45000 });
    assert.ok(/Timelapse: "Downstream Lot" every 5 min from 00:00 to 23:59 \(today 00:00-23:59, 288 frames\) -> \S+timelapse\/YYYY-MM-DD\/ \(the sharpest frame of up to 20 s of live video, stopping once a 1080-line keyframe has arrived; a frame that fails is skipped; paused under 40% battery; keeps 40 MB of memory for Pi-hole and 500 MB of disk free\); recorded in \S+\/run( \((in memory|on the SD card)\))?\. Test it now with: sudo kill -USR2 \d+/.test(r.out), r.out);
    const saved = /Timelapse (\d{4}-\d\d-\d\d) (\d\d):(\d\d): saved (\S+) - 1920x1080, \d+ KB, from live video \(\d+ s; stopped once 1920x1080 had arrived; \d+ of \d+ packets missing; resolution 1920x1080 from [\d.]+ s; keyframes checked: [\d.]+ s 1920x1080 clean\); took \d+ s\. Battery 87%\. Memory: this program \d+ MB.*; the Pi had at least \d+ MB available throughout\./.exec(r.out);
    assert.ok(saved, r.out);
    const [, date, h, m, file] = saved;
    assert.strictEqual(file, `${date}_${h}${m}.jpg`);
    assert.ok(Number(m) % 5 === 0, 'named for its slot');
    assert.ok(fs.existsSync(path.join(box.tlOut, date, file)), 'in the day\'s folder');
    assert.ok(Date.now() - t0 < 30000, 'it stopped early - not the whole 20 s and more');
    assert.ok(r.out.indexOf('Snapshot uploaded') < r.out.indexOf(': saved'), 'the dock photo first');
    const notes = fs.readFileSync(path.join(box.tlOut, '.interval-log'), 'utf8');
    assert.strictEqual(notes, `${date} ${h}:${m} start\n${date} ${h}:${m} done\n`);
    const ev = box.events().filter(e => e.camera === 'Downstream Lot').map(e => e.ev);
    assert.deepStrictEqual(ev, ['health', 'live'], 'the battery read, then the live view - never a snapshot of the battery camera');
    assert.deepStrictEqual(fs.readdirSync(path.join(box.dir, 'run')), [], 'nothing left where it recorded');
  }, 60000);

  test('end to end: the battery under 40% - no live view, said once; the dock photos as usual', async () => {
    const box = timelapseSandbox();
    const r = await box.run([], Object.assign({ FAKE_BATTERY: '30' }, allDay), { until: (o) => /Timelapse paused/.test(o) && /Snapshot uploaded/.test(o), maxMs: 20000 });
    assert.ok(/Timelapse paused: "Downstream Lot" battery at 30%: paused under 40%, until it is back to 55%, so the camera keeps its charge for the website's backup\./.test(r.out), r.out);
    assert.ok(!box.events().some(e => e.ev === 'live'), 'not woken');
    assert.ok(box.uploads() >= 1);
  });

  test('end to end: stopped by systemd (SIGTERM) during a capture - noted, ended as always, and the next start carries on', async () => {
    const box = timelapseSandbox();
    const env = Object.assign({ TIMELAPSE_RECORD_SECONDS: '20', TIMELAPSE_TARGET_HEIGHT: '0' }, allDay);
    let r = await box.run([], env, { maxMs: 30000, onStart: (child) => {
      const iv = setInterval(() => { if (box.events().some(e => e.ev === 'live')) { clearInterval(iv); setTimeout(() => child.kill('SIGTERM'), 1000); } }, 50);
    } });
    require('child_process').spawnSync('pkill', ['-KILL', '-f', box.dir]);   // its ffmpegs, as systemd would
    assert.strictEqual(r.signal, 'SIGTERM', `ended by the signal, as before: ${r.code} ${r.out}`);
    const notes = fs.readFileSync(path.join(box.tlOut, '.interval-log'), 'utf8');
    assert.ok(/^(\S+ \d\d:\d\d) start\n\1 stopped\n$/.test(notes), notes);
    r = await box.run([], env, { until: (o) => /Snapshot uploaded/.test(o), maxMs: 15000 });
    require('child_process').spawnSync('pkill', ['-KILL', '-f', box.dir]);
    assert.ok(!/never finished/.test(r.out), r.out);
  }, 60000);

  test('end to end: killed during a capture (as the kernel would, for memory) - the next start says so, and does not film that slot again', async () => {
    const box = timelapseSandbox();
    let r = await box.run([], Object.assign({ FAKE_DIE_ON_LIVE: '1' }, allDay), { maxMs: 30000 });
    assert.strictEqual(r.signal, 'SIGKILL', r.out);
    const first = fs.readFileSync(path.join(box.tlOut, '.interval-log'), 'utf8');
    assert.ok(/^\S+ \d\d:\d\d start\n$/.test(first), first);
    const slot = first.split(' ')[1];
    r = await box.run([], Object.assign({ TIMELAPSE_RECORD_SECONDS: '4' }, allDay), { until: (o) => /never finished/.test(o) && /Snapshot uploaded/.test(o), maxMs: 15000 });
    require('child_process').spawnSync('pkill', ['-KILL', '-f', box.dir]);
    assert.ok(new RegExp(`Timelapse \\S+: the capture at ${slot} never finished \\(the service stopped during it\\)\\.`).test(r.out), r.out);
    const starts = fs.readFileSync(path.join(box.tlOut, '.interval-log'), 'utf8').split('\n').filter(l => l.endsWith(' start'));
    assert.strictEqual(starts.filter(l => l.split(' ')[1] === slot).length, 1, 'that slot was not filmed again');
  }, 60000);

  test('end to end: --check in the every-few-minutes mode, and where it records', async () => {
    const box = timelapseSandbox();
    let r = await box.run(['--check'], { TIMELAPSE_EVERY_MINUTES: '5', TIMELAPSE_WORK_DIR: `/run/nhrc-camera-e2e-${process.pid}` });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(/timelapse {4}: "Downstream Lot" every 5 min from sunrise to sunset \(today \d\d:\d\d-\d\d:\d\d, \d+ frames\) -> \S+\/YYYY-MM-DD\/ \(the sharpest frame of up to 45 s of live video, stopping once a 1080-line keyframe has arrived; a frame that fails is skipped; paused under 40% battery; keeps 40 MB of memory for Pi-hole and 500 MB of disk free\); ffmpeg found/.test(r.out), r.out);
    assert.ok(new RegExp(`recordings {3}: /run/nhrc-camera-e2e-${process.pid} - not there yet \\(systemd makes it when the service starts: RuntimeDirectory=\\)`).test(r.out), r.out);
    assert.ok(!fs.existsSync(`/run/nhrc-camera-e2e-${process.pid}`), '--check creates nothing');
    r = await box.run(['--check'], { TIMELAPSE_EVERY_MINUTES: '5', TIMELAPSE_TIMES: '8:00' });
    assert.strictEqual(r.code, 1);
    assert.ok(/TIMELAPSE_TIMES and TIMELAPSE_EVERY_MINUTES are both set: use one or the other/.test(r.out), r.out);
    r = await box.run(['--check'], { TIMELAPSE_EVERY_MINUTES: 'five' });
    assert.strictEqual(r.code, 1);
    assert.ok(/TIMELAPSE_EVERY_MINUTES must be 5, 6, 10, 12, 15, 20, 30 or 60/.test(r.out), r.out);
  });

  test('end to end: a work folder that cannot be used - the temp folder instead, said at start; left-overs swept', async () => {
    const box = timelapseSandbox();
    fs.mkdirSync(path.join(box.tmp, 'nhrc-timelapse-left-behind'));
    fs.writeFileSync(path.join(box.tmp, 'nhrc-timelapse-left-behind', 'clip.mkv'), 'x');
    const r = await box.run([], Object.assign({ TIMELAPSE_WORK_DIR: '/proc/nhrc-camera', TIMELAPSE_RECORD_SECONDS: '8' }, allDay),
      { until: (o) => /Timelapse \S+ \S+: (saved|live video failed)/.test(o), maxMs: 45000 });
    require('child_process').spawnSync('pkill', ['-KILL', '-f', box.dir]);
    assert.ok(/Timelapse: TIMELAPSE_WORK_DIR \/proc\/nhrc-camera cannot be used \(E[A-Z]+\); recording in \S+\/tmp instead\./.test(r.out), r.out);
    assert.ok(/Timelapse: removed 1 recording left behind by an earlier run\./.test(r.out), r.out);
    assert.ok(/: saved \S+ - 1920x1080/.test(r.out), r.out);
    assert.deepStrictEqual(fs.readdirSync(box.tmp).filter(f => f.startsWith('nhrc-timelapse-')), []);
  }, 60000);
} else {
  test('(real ffmpeg tests skipped: ffmpeg is not installed here)', () => {});
}

// ═══════════════════════════════════════════════════════════════════════════
section('6i. Copying the frames to iCloud: the Pi\'s read-only export, the Mac\'s evening copy');
// ═══════════════════════════════════════════════════════════════════════════
//
// Every evening the Mac fetches each finished day it does not have yet, with
// a key the Pi lets list and fetch frames - nothing else. The Mac side runs
// here with a stand-in for ssh that does what the Pi's forced command does.

const EXPORT_SH = path.join(__dirname, 'timelapse_export.sh');
const ICLOUD_SH = path.join(__dirname, 'timelapse_to_icloud.sh');
const POSIX_SH = fs.existsSync('/usr/bin/dash') ? '/usr/bin/dash' : '/bin/sh';   // the Pi's /bin/sh is dash
const { spawnSync: run2 } = require('child_process');

/** The Pi's timelapse folder: three days in folders, and what else lies there. */
function piFolder() {
  const dir = tlDir();
  const day = (d, n) => {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(path.join(dir, d, `${d}_${String(705 + i * 5).padStart(4, '0')}.jpg`), fakeJpeg(1920, 1080 + i));
    }
  };
  day('2026-10-12', 3); day('2026-10-13', 2); day('2026-10-14', 4);
  fs.writeFileSync(path.join(dir, '2026-10-14', '.2026-10-14_0725.jpg.tmp'), 'half written');
  fs.writeFileSync(path.join(dir, '2026-10-13', 'notes.txt'), 'not a frame');
  fs.writeFileSync(path.join(dir, '2026-10-07_1500.jpg'), fakeJpeg(1280, 720));   // the set times, before
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', '2026-10-13_210102.jpg'), fakeJpeg(1920, 1080));
  fs.writeFileSync(path.join(dir, '.interval-log'), '2026-10-14 07:05 start\n');
  return { dir, day };
}

/** The Pi's forced command, asked `request` (SSH_ORIGINAL_COMMAND). */
const exportAsk = (dir, request) => run2(POSIX_SH, [EXPORT_SH], { env: { PATH: process.env.PATH,
  NHRC_TIMELAPSE_DIR: dir, SSH_ORIGINAL_COMMAND: request } });

/** A Mac (its own HOME) and a stand-in ssh that refuses unless it could never ask for a password. */
function macRig() {
  const pi = piFolder();
  const home = tlDir();
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-bin-'));
  const fakeSsh = path.join(bin, 'ssh');
  fs.writeFileSync(fakeSsh, [
    '#!/bin/bash',
    // The Pi asked: the argument before the request. The standby has its own folder (and home).
    'host="${@: -2:1}"; req="${@: -1}"; dir="$FAKE_PI_DIR"; home="${FAKE_PI_HOME:-}"',
    '[ "$host" = emre@standby ] && { dir="$FAKE_PI_DIR_STANDBY"; home="${FAKE_PI_HOME_STANDBY:-}"; }',
    'case ",${FAKE_SSH_DOWN:-}," in *",1,"*|*",$host,"*) echo "ssh: connect to host ${host#*@} port 22: Operation timed out" >&2; exit 255 ;; esac',
    'batch=no; key=; prev=; for a in "$@"; do [ "$a" = BatchMode=yes ] && batch=yes; [ "$prev" = -i ] && key="$a"; prev="$a"; done',
    // Without BatchMode, ssh would ask for the Pi's password. With FAKE_SSH_PASSWORD the Pi lets the
    // install in, and runs what it sends as that user (the export installed where FAKE_HELPER says).
    'if [ "$batch" != yes ]; then',
    '  [ -n "${FAKE_SSH_PASSWORD:-}" ] || { echo "ssh would have asked for a password" >&2; exit 99; }',
    '  exec env HOME="$home" bash -c "${req//\\/usr\\/local\\/bin\\/nhrc-timelapse-export/$FAKE_HELPER}"',
    'fi',
    // With the key: refused unless that Pi has it, tied to the export (FAKE_SSH_KEYCHECK).
    'if [ -n "${FAKE_SSH_KEYCHECK:-}" ] && ! grep -qxF "restrict,command=\\"/usr/local/bin/nhrc-timelapse-export\\" $(cat "$key.pub")" "$home/.ssh/authorized_keys" 2>/dev/null; then',
    '  echo "$host: Permission denied (publickey)." >&2; exit 255',
    'fi',
    // Like ssh, it reads what it is given unless told not to (-n): in a loop that would swallow the rest of the list.
    'nostdin=no; for a in "$@"; do [ "$a" = -n ] && nostdin=yes; done',
    '[ "$nostdin" = yes ] || cat > /dev/null',
    'if [ -n "${FAKE_SSH_CUT:-}" ] && [ "${req#get }" != "$req" ]; then',
    '  SSH_ORIGINAL_COMMAND="$req" NHRC_TIMELAPSE_DIR="$dir" "$FAKE_SH" "$FAKE_EXPORT" | head -c 2000; exit 0',
    'fi',
    'SSH_ORIGINAL_COMMAND="$req" NHRC_TIMELAPSE_DIR="$dir" exec "$FAKE_SH" "$FAKE_EXPORT"',
  ].join('\n'), { mode: 0o755 });
  const dest = path.join(home, 'iCloud', 'NHRC Timelapse');
  const support = path.join(home, 'Library', 'Application Support', 'NHRC Timelapse');
  const logFile = path.join(home, 'Library', 'Logs', 'nhrc-timelapse.log');
  // A standby Pi's folder: empty until a test has it film.
  const standby = { dir: tlDir() };
  standby.day = (d, ...times) => {
    fs.mkdirSync(path.join(standby.dir, d), { recursive: true });
    for (const hm of times) fs.writeFileSync(path.join(standby.dir, d, `${d}_${hm}.jpg`), fakeJpeg(1280, 720));
  };
  const exec = (args, env = {}) => run2('bash', [ICLOUD_SH, ...args], { encoding: 'utf8', env: Object.assign({
    PATH: process.env.PATH, HOME: home, NHRC_TIMELAPSE_SSH: fakeSsh, NHRC_TIMELAPSE_DEST: dest,
    FAKE_PI_DIR: pi.dir, FAKE_PI_DIR_STANDBY: standby.dir, FAKE_EXPORT: EXPORT_SH, FAKE_SH: POSIX_SH }, env) });
  const copy = (today, hour, env = {}, pis = ['emre@pihole2']) => exec(['run', ...pis],
    Object.assign({ NHRC_TIMELAPSE_TODAY: today, NHRC_TIMELAPSE_HOUR: hour }, env));
  const lastLog = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').pop();
  const state = () => fs.readFileSync(path.join(support, 'days-copied'), 'utf8');
  const logLines = () => fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => l.slice(20));
  return { pi, standby, home, dest, support, exec, copy, lastLog, logLines, state };
}

test('the Pi\'s export: lists the days and sends one whole - and nothing else, whatever it is asked', () => {
  const { dir } = piFolder();
  let r = exportAsk(dir, 'list');
  assert.strictEqual(r.status, 0, r.stderr.toString());
  assert.strictEqual(r.stdout.toString(), '2026-10-12 3\n2026-10-13 2\n2026-10-14 4\n', 'day folders only; frames only - not a half-written one, nor anything else');
  r = exportAsk(dir, 'get 2026-10-14');
  assert.strictEqual(r.status, 0, r.stderr.toString());
  const tarFile = path.join(tlDir(), 'day.tar');
  fs.writeFileSync(tarFile, r.stdout);
  const listed = run2('tar', ['-tf', tarFile], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
  assert.deepStrictEqual(listed, ['2026-10-14/', '2026-10-14/2026-10-14_0705.jpg', '2026-10-14/2026-10-14_0710.jpg',
    '2026-10-14/2026-10-14_0715.jpg', '2026-10-14/2026-10-14_0720.jpg'], 'the frames, not the half-written one');
  for (const bad of ['', 'ls', 'get', ' list', 'list ', 'list; cat /etc/passwd', 'get 2026-10-1', 'get 2026-10-14 ',
    'get 2026-10-14; id', 'get 2026-10-14 && id', 'get 2026-10-14|id', 'get $(id)', 'get `id`', 'get ../2026-10-14',
    'get 2026-10-1?', 'get 2026-10-1*', 'get 2026-10-14/../../etc', 'get /etc', 'tar -cf - /', 'rsync --server --sender . /']) {
    r = exportAsk(dir, bad);
    assert.strictEqual(r.status, 1, JSON.stringify(bad));
    assert.strictEqual(r.stdout.length, 0, JSON.stringify(bad));
    assert.ok(/not allowed: this key can only list and fetch timelapse days/.test(r.stderr.toString()), JSON.stringify(bad));
  }
  r = exportAsk(dir, 'get 2026-10-09');
  assert.strictEqual(r.status, 1);
  assert.ok(/no such day: 2026-10-09/.test(r.stderr.toString()));
});

test('the Mac copies each finished day once, whole - never a day still being filmed - and catches up on days it missed', () => {
  const m = macRig();
  let r = m.copy('2026-10-14', '21');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(m.dest).sort(), ['2026-10-12', '2026-10-13', '2026-10-14'],
    'the days only: no half-written frame, no hidden folder, nothing from the set times or tests');
  assert.deepStrictEqual(fs.readdirSync(path.join(m.dest, '2026-10-14')).sort(),
    ['2026-10-14_0705.jpg', '2026-10-14_0710.jpg', '2026-10-14_0715.jpg', '2026-10-14_0720.jpg']);
  assert.ok(fs.readFileSync(path.join(m.dest, '2026-10-12', '2026-10-12_0715.jpg')).equals(fs.readFileSync(path.join(m.pi.dir, '2026-10-12', '2026-10-12_0715.jpg'))));
  assert.strictEqual(m.state(), 'emre@pihole2 2026-10-12\nemre@pihole2 2026-10-13\nemre@pihole2 2026-10-14\n');
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d copied 3 days, 9 frames, from emre@pihole2 to iCloud Drive\/NHRC Timelapse$/.test(m.lastLog()), m.lastLog());
  // Again: nothing to do.
  m.copy('2026-10-14', '22');
  assert.ok(/ nothing new to copy$/.test(m.lastLog()), m.lastLog());
  // The next morning a day is under way: left alone until the evening.
  m.pi.day('2026-10-15', 2);
  m.copy('2026-10-15', '08');
  assert.ok(!fs.existsSync(path.join(m.dest, '2026-10-15')));
  m.copy('2026-10-15', '21');
  assert.ok(/ copied 1 day, 2 frames, from emre@pihole2 to iCloud Drive\/NHRC Timelapse$/.test(m.lastLog()), m.lastLog());
  // The Mac was away for two evenings: the next copy brings both, but not the day in progress.
  m.pi.day('2026-10-16', 2); m.pi.day('2026-10-17', 1); m.pi.day('2026-10-18', 1);
  m.copy('2026-10-18', '07');
  assert.ok(/ copied 2 days, 3 frames/.test(m.lastLog()), m.lastLog());
  assert.ok(!fs.existsSync(path.join(m.dest, '2026-10-18')));
  assert.deepStrictEqual(fs.readdirSync(m.dest).filter(f => f.startsWith('.')), [], 'nothing hidden left behind');
  assert.deepStrictEqual(fs.readdirSync(m.support).filter(f => f.startsWith('incoming')), [], 'nor anything on the way');
  assert.deepStrictEqual(fs.readdirSync(path.join(m.dest, '2026-10-13')).sort(), ['2026-10-13_0705.jpg', '2026-10-13_0710.jpg'], 'frames only');
  // A Mac whose clock is a day behind the Pi's: a day it thinks is still to come is left alone.
  const behind = macRig();
  behind.copy('2026-10-13', '21');
  assert.deepStrictEqual(fs.readdirSync(behind.dest).sort(), ['2026-10-12', '2026-10-13']);
});

test('the Mac\'s copy when things go wrong: Pi unreachable, a transfer cut short, iCloud not writable - said plainly, tried again next time', () => {
  let m = macRig();
  let r = m.copy('2026-10-14', '21', { FAKE_SSH_DOWN: '1' });
  assert.strictEqual(r.status, 0);
  assert.ok(/ could not reach emre@pihole2 \(ssh: connect to host pihole2 port 22: Operation timed out\); trying again tomorrow at 21:30, or when this Mac wakes$/.test(m.lastLog()), m.lastLog());
  assert.strictEqual(m.state(), '');
  // Cut short: that day is not counted as copied, nothing half-copied is left in iCloud.
  m.copy('2026-10-14', '21', { FAKE_SSH_CUT: '1' });
  const lines = fs.readFileSync(path.join(m.home, 'Library', 'Logs', 'nhrc-timelapse.log'), 'utf8');
  assert.ok(/could not copy 2026-10-12 from emre@pihole2: \d of its 3 frames arrived \(.*\); trying again next time/.test(lines), lines);
  assert.ok(!fs.existsSync(path.join(m.dest, '2026-10-12')) || fs.readdirSync(path.join(m.dest, '2026-10-12')).length === 0);
  assert.deepStrictEqual(fs.readdirSync(m.dest).filter(f => f.startsWith('.')), []);
  assert.deepStrictEqual(fs.readdirSync(m.support).filter(f => f.startsWith('incoming')), [], 'the part that arrived is not left lying');
  assert.strictEqual(m.state(), '');
  m.copy('2026-10-14', '21');
  assert.ok(/ copied 3 days, 9 frames/.test(m.lastLog()), m.lastLog());
  // A frame already there is never overwritten; an empty day is passed over.
  m = macRig();
  fs.mkdirSync(path.join(m.dest, '2026-10-13'), { recursive: true });
  fs.writeFileSync(path.join(m.dest, '2026-10-13', '2026-10-13_0705.jpg'), 'mine');
  fs.mkdirSync(path.join(m.pi.dir, '2026-10-11'));
  m.copy('2026-10-14', '21');
  assert.strictEqual(fs.readFileSync(path.join(m.dest, '2026-10-13', '2026-10-13_0705.jpg'), 'utf8'), 'mine');
  assert.strictEqual(fs.readdirSync(path.join(m.dest, '2026-10-13')).length, 2);
  assert.ok(!fs.existsSync(path.join(m.dest, '2026-10-11')));
  assert.strictEqual(m.state(), 'emre@pihole2 2026-10-11\nemre@pihole2 2026-10-12\nemre@pihole2 2026-10-13\nemre@pihole2 2026-10-14\n');
  // iCloud Drive not writable (macOS has not allowed it): said, with what to do.
  m = macRig();
  fs.mkdirSync(path.dirname(m.dest), { recursive: true });
  fs.chmodSync(path.dirname(m.dest), 0o555);
  m.copy('2026-10-14', '21');
  fs.chmodSync(path.dirname(m.dest), 0o755);
  assert.ok(/ could not write to iCloud Drive \(.*(Permission denied|not permitted).*\) - allow "NHRC Timelapse" in System Settings > Privacy & Security > Files & Folders$/.test(m.lastLog()), m.lastLog());
  // iCloud Drive off: the folder would never be uploaded - said, nothing copied.
  m = macRig();
  run2('bash', [ICLOUD_SH, 'run', 'emre@pihole2'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: m.home,
    NHRC_TIMELAPSE_SSH: '/bin/false', NHRC_TIMELAPSE_TODAY: '2026-10-14', NHRC_TIMELAPSE_HOUR: '21' } });
  assert.ok(/ iCloud Drive cannot be found: is it on \(System Settings > Apple Account > iCloud\), and may "NHRC Timelapse" use it/.test(m.lastLog()), m.lastLog());
});

test('two Pis: the standby\'s frames join the main Pi\'s in each day\'s folder - each Pi\'s days copied once, a frame never over another', () => {
  const m = macRig();
  const both = ['emre@pihole2', 'emre@standby'];
  // 14 October: the main Pi filmed 07:05-07:20 and died; the standby took over at 07:30.
  m.standby.day('2026-10-14', '0730', '0735', '0740');
  // 13 October, 07:05 from both (the main Pi back mid-slot): one frame - the first copied, the main Pi's.
  m.standby.day('2026-10-13', '0705');
  const r = m.copy('2026-10-14', '21', {}, both);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(path.join(m.dest, '2026-10-14')).sort(), ['2026-10-14_0705.jpg', '2026-10-14_0710.jpg',
    '2026-10-14_0715.jpg', '2026-10-14_0720.jpg', '2026-10-14_0730.jpg', '2026-10-14_0735.jpg', '2026-10-14_0740.jpg']);
  assert.ok(fs.readFileSync(path.join(m.dest, '2026-10-13', '2026-10-13_0705.jpg'))
    .equals(fs.readFileSync(path.join(m.pi.dir, '2026-10-13', '2026-10-13_0705.jpg'))), 'the main Pi\'s frame, not overwritten');
  assert.deepStrictEqual(m.logLines(), ['copied 3 days, 9 frames, from emre@pihole2 to iCloud Drive/NHRC Timelapse',
    'copied 2 days, 3 frames, from emre@standby to iCloud Drive/NHRC Timelapse']);
  assert.strictEqual(m.state(), 'emre@pihole2 2026-10-12\nemre@pihole2 2026-10-13\nemre@pihole2 2026-10-14\n'
    + 'emre@standby 2026-10-13\nemre@standby 2026-10-14\n');
  m.copy('2026-10-14', '22', {}, both);
  assert.strictEqual(m.lastLog().slice(20), 'nothing new to copy');
  // The standby away one evening: the main Pi's day is copied; the standby's the next time.
  m.pi.day('2026-10-15', 2);
  m.standby.day('2026-10-15', '1200');
  m.copy('2026-10-15', '21', { FAKE_SSH_DOWN: 'emre@standby' }, both);
  assert.deepStrictEqual(m.logLines().slice(-2), ['copied 1 day, 2 frames, from emre@pihole2 to iCloud Drive/NHRC Timelapse',
    'could not reach emre@standby (ssh: connect to host standby port 22: Operation timed out); trying again tomorrow at 21:30, or when this Mac wakes']);
  assert.ok(!fs.existsSync(path.join(m.dest, '2026-10-15', '2026-10-15_1200.jpg')));
  m.copy('2026-10-16', '21', {}, both);
  assert.strictEqual(m.lastLog().slice(20), 'copied 1 day, 1 frame, from emre@standby to iCloud Drive/NHRC Timelapse');
  assert.strictEqual(fs.readdirSync(path.join(m.dest, '2026-10-15')).length, 3);
  // The main Pi away, the standby with nothing new: said - and not that there was nothing new, which is not known.
  m.copy('2026-10-16', '22', { FAKE_SSH_DOWN: 'emre@pihole2' }, both);
  assert.deepStrictEqual(m.logLines().slice(-2), ['copied 1 day, 1 frame, from emre@standby to iCloud Drive/NHRC Timelapse',
    'could not reach emre@pihole2 (ssh: connect to host pihole2 port 22: Operation timed out); trying again tomorrow at 21:30, or when this Mac wakes']);
  // Neither there: two lines, nothing copied, nothing lost.
  m.copy('2026-10-16', '22', { FAKE_SSH_DOWN: '1' }, both);
  assert.deepStrictEqual(m.logLines().slice(-2).map(l => l.split(' (')[0]), ['could not reach emre@pihole2', 'could not reach emre@standby']);
  assert.deepStrictEqual(fs.readdirSync(m.support).filter(f => f.startsWith('incoming')), []);
});

test('the days an earlier version copied (listed bare) count as the main Pi\'s - given first - and the standby\'s are still copied', () => {
  const m = macRig();
  fs.mkdirSync(m.support, { recursive: true });
  fs.writeFileSync(path.join(m.support, 'days-copied'), '2026-10-12\n2026-10-13\n');
  m.standby.day('2026-10-13', '1100');
  m.copy('2026-10-14', '21', {}, ['emre@pihole2', 'emre@standby']);
  assert.ok(!fs.existsSync(path.join(m.dest, '2026-10-12')), 'not fetched again from the main Pi');
  assert.deepStrictEqual(fs.readdirSync(path.join(m.dest, '2026-10-13')), ['2026-10-13_1100.jpg'],
    'the standby\'s frame of a day whose main Pi frames were copied before');
  assert.strictEqual(fs.readdirSync(path.join(m.dest, '2026-10-14')).length, 4);
  assert.deepStrictEqual(m.logLines(), ['copied 1 day, 4 frames, from emre@pihole2 to iCloud Drive/NHRC Timelapse',
    'copied 1 day, 1 frame, from emre@standby to iCloud Drive/NHRC Timelapse']);
  assert.strictEqual(m.state(), '2026-10-12\n2026-10-13\nemre@pihole2 2026-10-14\nemre@standby 2026-10-13\n');
  // The bare days are the first Pi's only: had the standby been given first, its 13 October would have counted as copied.
  const n = macRig();
  fs.mkdirSync(n.support, { recursive: true });
  fs.writeFileSync(path.join(n.support, 'days-copied'), '2026-10-13\n');
  n.standby.day('2026-10-13', '1100');
  n.copy('2026-10-14', '21', {}, ['emre@pihole2', 'emre@standby']);
  assert.ok(fs.existsSync(path.join(n.dest, '2026-10-13', '2026-10-13_1100.jpg')), 'second in line: its days are its own');
});

test('the Mac\'s copy takes a Pi only as user@address - nothing ssh could read as an option, nothing that breaks the app\'s command', () => {
  const m = macRig();
  for (const bad of ['-oProxyCommand=touch /tmp/x', 'emre@-oProxyCommand=x', 'emre@pihole2;id', 'emre@pihole 2', 'pihole2', '@pihole2',
    'emre@', 'emre@pi"hole', "emre@pi'hole", 'emre@pihole2\nid', 'emre@$(id)']) {
    let r = m.copy('2026-10-14', '21', {}, [bad]);
    assert.strictEqual(r.status, 0, bad);
    assert.strictEqual(m.lastLog().slice(20), `not a Pi: "${bad.replace(/[^A-Za-z0-9@._:-]/g, '?')}" - give each as user@address`, bad);
    r = m.exec(['install', bad]);
    assert.ok(r.status !== 0 && /Give the Pi as user@address/.test(r.stderr), bad);
  }
  assert.ok(!fs.existsSync(m.dest) || fs.readdirSync(m.dest).length === 0, 'nothing reached, nothing copied');
  assert.strictEqual(m.state(), '');
  // One bad, one good: the good one is copied.
  m.copy('2026-10-14', '21', {}, ['emre@pi"hole', 'emre@pihole2']);
  assert.strictEqual(m.lastLog().slice(20), 'copied 3 days, 9 frames, from emre@pihole2 to iCloud Drive/NHRC Timelapse');
  for (const good of ['emre@pihole2', 'emre@192.0.2.10', 'pi_user@pihole-2.local', 'emre@fe80::1']) {
    assert.strictEqual(run2('bash', ['-c', `source <(sed -n '/^valid_pi()/,/^}/p' "${ICLOUD_SH}"); valid_pi "$1"`, 'x', good]).status, 0, good);
  }
});

test('the Mac\'s copy: one at a time; a lock left by a copy that died is taken over', () => {
  const m = macRig();
  const lock = path.join(m.support, '.running');
  fs.mkdirSync(lock, { recursive: true });
  m.copy('2026-10-14', '21');
  assert.ok(/ another copy is running; this one stops$/.test(m.lastLog()), m.lastLog());
  assert.ok(!fs.existsSync(m.dest) || fs.readdirSync(m.dest).length === 0);
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  fs.utimesSync(lock, old, old);
  m.copy('2026-10-14', '21');
  assert.ok(/ copied 3 days/.test(m.lastLog()), m.lastLog());
  assert.ok(!fs.existsSync(lock), 'the lock is let go');
});

if (fs.existsSync('/usr/sbin/sshd') && fs.existsSync('/usr/bin/ssh-keygen')) {
  test('end to end, with a real ssh server: the Mac\'s key copies the days, and can do nothing else - no command, no shell, no scp, no sftp', async () => {
    const m = macRig();
    const t = tlDir();
    const user = require('os').userInfo().username;
    const key = path.join(m.home, '.ssh', 'nhrc_timelapse');
    fs.mkdirSync(path.dirname(key), { recursive: true });
    run2('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(t, 'hostkey')]);
    run2('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'nhrc-timelapse (read-only frames)', '-f', key]);
    // The line the Mac's install puts on the Pi - here with the export's test folder.
    fs.writeFileSync(path.join(t, 'authorized_keys'),
      `restrict,command="NHRC_TIMELAPSE_DIR=${m.pi.dir} ${POSIX_SH} ${EXPORT_SH}" ${fs.readFileSync(key + '.pub', 'utf8')}`, { mode: 0o600 });
    const port = 30000 + Math.floor(Math.random() * 20000);
    fs.writeFileSync(path.join(t, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${t}/hostkey`, `PidFile ${t}/sshd.pid`,
      `AuthorizedKeysFile ${t}/authorized_keys`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
      'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes'].join('\n') + '\n');
    const sshd = require('child_process').spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(t, 'sshd_config')], { stdio: 'ignore' });
    try {
      fs.writeFileSync(path.join(t, 'ssh_config'), `Host pi\n  HostName 127.0.0.1\n  Port ${port}\n  User ${user}\n`
        + `  UserKnownHostsFile ${t}/known_hosts\n  StrictHostKeyChecking no\n  LogLevel ERROR\n`);
      const wrapper = path.join(t, 'ssh');
      fs.writeFileSync(wrapper, `#!/bin/bash\nexec ssh -F ${t}/ssh_config "$@"\n`, { mode: 0o755 });
      await new Promise(r => setTimeout(r, 700));
      const r = run2('bash', [ICLOUD_SH, 'run', `${user}@pi`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: m.home,
        NHRC_TIMELAPSE_SSH: wrapper, NHRC_TIMELAPSE_DEST: m.dest, NHRC_TIMELAPSE_TODAY: '2026-10-14', NHRC_TIMELAPSE_HOUR: '21' } });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(m.lastLog().slice(20), `copied 3 days, 9 frames, from ${user}@pi to iCloud Drive/NHRC Timelapse`);
      assert.deepStrictEqual(fs.readdirSync(m.dest).sort(), ['2026-10-12', '2026-10-13', '2026-10-14']);
      const as = (args, opts = {}) => run2(args[0], args.slice(1), Object.assign({ encoding: 'utf8', timeout: 10000 }, opts));
      const base = ['-F', `${t}/ssh_config`, '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes'];
      let x = as(['ssh', ...base, 'pi', 'id']);
      assert.ok(x.status === 1 && /not allowed/.test(x.stderr) && !/uid=/.test(x.stdout), 'no other command');
      x = as(['ssh', ...base, '-tt', 'pi']);
      assert.ok(x.status !== 0 && !/\$ |# /.test(x.stdout), 'no shell');
      x = as(['scp', ...base, 'pi:/etc/passwd', path.join(t, 'stolen')]);
      assert.ok(x.status !== 0 && !fs.existsSync(path.join(t, 'stolen')), 'no scp');
      x = as(['sftp', ...base, 'pi'], { input: 'ls /\n' });
      assert.ok(x.status !== 0 && !/etc|usr/.test(x.stdout), 'no sftp');
    } finally {
      sshd.kill('SIGTERM');
    }
  }, 60000);

  test('end to end, with two real ssh servers - the main Pi and the standby: one evening\'s copy brings both Pis\' frames into the same days', async () => {
    const m = macRig();
    m.standby.day('2026-10-14', '0730', '0735');
    const t = tlDir();
    const user = require('os').userInfo().username;
    const key = path.join(m.home, '.ssh', 'nhrc_timelapse');
    fs.mkdirSync(path.dirname(key), { recursive: true });
    run2('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'nhrc-timelapse (read-only frames)', '-f', key]);
    const servers = [];
    let config = '';
    try {
      // Each Pi: its own ssh server, the Mac's one key tied to that Pi's export and folder.
      for (const [alias, folder] of [['main', m.pi.dir], ['standby', m.standby.dir]]) {
        const d = path.join(t, alias);
        fs.mkdirSync(d);
        run2('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(d, 'hostkey')]);
        fs.writeFileSync(path.join(d, 'authorized_keys'),
          `restrict,command="NHRC_TIMELAPSE_DIR=${folder} ${POSIX_SH} ${EXPORT_SH}" ${fs.readFileSync(key + '.pub', 'utf8')}`, { mode: 0o600 });
        const port = 30000 + Math.floor(Math.random() * 20000);
        fs.writeFileSync(path.join(d, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${d}/hostkey`, `PidFile ${d}/sshd.pid`,
          `AuthorizedKeysFile ${d}/authorized_keys`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
          'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes'].join('\n') + '\n');
        servers.push(require('child_process').spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(d, 'sshd_config')], { stdio: 'ignore' }));
        config += `Host ${alias}\n  HostName 127.0.0.1\n  Port ${port}\n  UserKnownHostsFile ${t}/known_hosts\n  StrictHostKeyChecking no\n  LogLevel ERROR\n`;
      }
      fs.writeFileSync(path.join(t, 'ssh_config'), config);
      const wrapper = path.join(t, 'ssh');
      fs.writeFileSync(wrapper, `#!/bin/bash\nexec ssh -F ${t}/ssh_config "$@"\n`, { mode: 0o755 });
      await new Promise(r => setTimeout(r, 700));
      const r = run2('bash', [ICLOUD_SH, 'run', `${user}@main`, `${user}@standby`], { encoding: 'utf8', env: { PATH: process.env.PATH,
        HOME: m.home, NHRC_TIMELAPSE_SSH: wrapper, NHRC_TIMELAPSE_DEST: m.dest, NHRC_TIMELAPSE_TODAY: '2026-10-14', NHRC_TIMELAPSE_HOUR: '21' } });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.deepStrictEqual(m.logLines(), [`copied 3 days, 9 frames, from ${user}@main to iCloud Drive/NHRC Timelapse`,
        `copied 1 day, 2 frames, from ${user}@standby to iCloud Drive/NHRC Timelapse`]);
      assert.deepStrictEqual(fs.readdirSync(path.join(m.dest, '2026-10-14')).sort(), ['2026-10-14_0705.jpg', '2026-10-14_0710.jpg',
        '2026-10-14_0715.jpg', '2026-10-14_0720.jpg', '2026-10-14_0730.jpg', '2026-10-14_0735.jpg']);
      assert.ok(fs.readFileSync(path.join(m.dest, '2026-10-14', '2026-10-14_0730.jpg')).equals(fs.readFileSync(path.join(m.standby.dir, '2026-10-14', '2026-10-14_0730.jpg'))));
    } finally {
      for (const sv of servers) sv.kill('SIGTERM');
    }
  }, 60000);
}

test('the Mac\'s script: refuses what it cannot do, schedules 21:30 through its own app, and keeps to the Mac\'s bash 3.2', () => {
  const m = macRig();
  let r = m.exec([]);
  assert.strictEqual(r.status, 1);
  assert.ok(/Usage: bash \S+ install\|run user@pi-address \[user@standby-address\], or: bash \S+ uninstall/.test(r.stderr), r.stderr);
  r = m.exec(['install', 'pihole2']);
  assert.ok(r.status !== 0 && /Give the Pi as user@address/.test(r.stderr), r.stderr);
  r = m.exec(['install', 'emre@pihole2']);
  assert.ok(r.status !== 0 && /This part runs on your Mac\./.test(r.stderr), r.stderr);
  const src = fs.readFileSync(ICLOUD_SH, 'utf8');
  // The schedule, as launchd will read it.
  const plist = /cat > "\$PLIST" <<PLIST\n([\s\S]*?)\nPLIST\n/.exec(src)[1]
    .replace(/\$LABEL/g, 'com.nhrc.timelapse-to-icloud').replace(/\$APP/g, '/Users/emre/Library/Application Support/NHRC Timelapse/NHRC Timelapse.app')
    .replace(/\$RUN_HOUR/g, '21').replace(/\$RUN_MINUTE/g, '30').replace(/\$LOG/g, '/Users/emre/Library/Logs/nhrc-timelapse.log');
  assert.ok(!/\$/.test(plist), 'every value filled in');
  const py = run2('python3', ['-c', 'import plistlib,sys,json; print(json.dumps(plistlib.loads(sys.stdin.buffer.read())))'], { input: plist, encoding: 'utf8' });
  if (py.status === 0) {
    assert.deepStrictEqual(JSON.parse(py.stdout), {
      Label: 'com.nhrc.timelapse-to-icloud',
      ProgramArguments: ['/usr/bin/open', '-W', '-g', '/Users/emre/Library/Application Support/NHRC Timelapse/NHRC Timelapse.app'],
      StartCalendarInterval: { Hour: 21, Minute: 30 },
      StandardOutPath: '/Users/emre/Library/Logs/nhrc-timelapse.log', StandardErrorPath: '/Users/emre/Library/Logs/nhrc-timelapse.log' });
  }
  // The app runs the copy - from each Pi given - and never shows an error dialog in the evening (the log says what happened).
  assert.ok(/-e 'try'[\s\S]*-e "do shell script \\"\/bin\/bash \\" & quoted form of \\"\$SCRIPT\\" & \\" run\\"\$pis"[\s\S]*-e 'end try'/.test(src));
  const loop = /\n {2}(for PI in "\$@"; do pis="\$pis & [^\n]*; done)\n/.exec(src);
  assert.ok(loop, 'the Pis\' part of the app\'s command');
  const built = run2('bash', ['-c', `pis=''; ${loop[1]}; printf '%s' "$pis"`, 'x', 'emre@pihole2', 'emre@standby'], { encoding: 'utf8' }).stdout;
  assert.strictEqual(built, ' & " " & quoted form of "emre@pihole2" & " " & quoted form of "emre@standby"',
    'AppleScript: run \'emre@pihole2\' \'emre@standby\', each quoted for the shell');
  // The key goes on the Pi tied to the export: list and fetch, nothing else.
  assert.ok(/printf 'restrict,command="%s" %s\\n' "\$HELPER"/.test(src) && /HELPER="\/usr\/local\/bin\/nhrc-timelapse-export"/.test(src));
  // bash 3.2, as on every Mac: none of bash 4's additions.
  for (const [what, re] of [['associative arrays', /declare -A|local -A/], ['mapfile', /\bmapfile\b|\breadarray\b/], ['case changes', /\$\{\w+(,,|\^\^)\}/],
    ['&>>', /&>>/], ['|&', /\|&/], ['coproc', /\bcoproc\b/], ['namerefs', /(local|declare) -n\b/]]) {
    assert.ok(!re.test(src), `no ${what}`);
  }
  // Every run is fenced from asking for a password, from waiting for ever, and from reading the list it loops over.
  assert.ok(/"\$SSH" -n -i "\$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20/.test(src));
});

test('the Mac\'s install, run here with stand-ins for macOS: the key goes on each Pi once, tied to the export; the app copies from both Pis', () => {
  const m = macRig();
  m.standby.day('2026-10-14', '0730');
  // Stand-ins for what only a Mac has: uname, osacompile (noting what the app is to run), launchctl, and open
  // (running the app: its AppleScript command, worked out as macOS would).
  const mac = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tl-macos-'));
  const tool = (name, body) => fs.writeFileSync(path.join(mac, name), body, { mode: 0o755 });
  tool('uname', '#!/bin/bash\necho Darwin\n');
  tool('launchctl', `#!/bin/bash\necho "$*" >> ${mac}/launchctl.log\n`);
  fs.writeFileSync(path.join(mac, 'osacompile.js'), `const fs = require('fs'); const a = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(mac)} + '/osacompile.json', JSON.stringify(a)); fs.mkdirSync(a[a.indexOf('-o') + 1], { recursive: true });`);
  tool('osacompile', `#!/bin/bash\nexec "${process.execPath}" ${mac}/osacompile.js "$@"\n`);
  fs.writeFileSync(path.join(mac, 'open.js'), `const fs = require('fs'); const a = process.argv.slice(2);
    const osa = JSON.parse(fs.readFileSync(${JSON.stringify(mac)} + '/osacompile.json', 'utf8'));
    if (a[0] !== '-W' || a[1] !== osa[osa.indexOf('-o') + 1]) { console.error('open: not the app: ' + a.join(' ')); process.exit(2); }
    const cmd = osa.find(x => x.startsWith('do shell script '));
    let e = cmd.slice('do shell script '.length), i = 0, out = '';
    const lit = () => { let v = ''; i++; while (e[i] !== '"') { if (e[i] === '\\\\') i++; v += e[i++]; } i++; return v; };
    while (i < e.length) {
      if (e.startsWith('quoted form of ', i)) { i += 15; out += "'" + lit().split("'").join("'\\\\''") + "'"; }
      else if (e[i] === '"') out += lit(); else { console.error('open: cannot read ' + e.slice(i)); process.exit(2); }
      while (e[i] === ' ') i++;
      if (i < e.length) { if (e[i] !== '&') { console.error('open: expected & at ' + e.slice(i)); process.exit(2); } i++; while (e[i] === ' ') i++; }
    }
    fs.writeFileSync(${JSON.stringify(mac)} + '/ran', out);
    process.exit(require('child_process').spawnSync('/bin/sh', ['-c', out], { stdio: 'inherit' }).status);`);
  tool('open', `#!/bin/bash\nexec "${process.execPath}" ${mac}/open.js "$@"\n`);
  tool('nhrc-timelapse-export', `#!/bin/sh\nexec ${POSIX_SH} ${EXPORT_SH} "$@"\n`);
  const piHome = tlDir(), standbyHome = tlDir();
  const env = { PATH: `${mac}:${process.env.PATH}`, FAKE_SSH_PASSWORD: '1', FAKE_SSH_KEYCHECK: '1', FAKE_HELPER: path.join(mac, 'nhrc-timelapse-export'),
    FAKE_PI_HOME: piHome, FAKE_PI_HOME_STANDBY: standbyHome, NHRC_TIMELAPSE_TODAY: '2026-10-14', NHRC_TIMELAPSE_HOUR: '21' };
  let r = m.exec(['install', 'emre@pihole2', 'emre@standby'], env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const keyLine = `restrict,command="/usr/local/bin/nhrc-timelapse-export" ${fs.readFileSync(path.join(m.home, '.ssh', 'nhrc_timelapse.pub'), 'utf8').trim()}`;
  const keysOn = (home) => fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8');
  for (const home of [piHome, standbyHome]) {
    assert.strictEqual(keysOn(home), keyLine + '\n', 'the one line, tied to the export');
    assert.strictEqual(fs.statSync(path.join(home, '.ssh', 'authorized_keys')).mode & 0o777, 0o600);
  }
  assert.ok(/emre@pihole2 answers: 3 days of frames there\.\nAdding this Mac's key to emre@standby[\s\S]*emre@standby answers: 1 day of frames there\./.test(r.stdout), r.stdout);
  // The app: what osacompile was given, and the command it ran.
  const support = path.join(m.home, 'Library', 'Application Support', 'NHRC Timelapse');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(mac, 'osacompile.json'), 'utf8')), ['-o', path.join(support, 'NHRC Timelapse.app'),
    '-e', 'try', '-e', `do shell script "/bin/bash " & quoted form of "${path.join(support, 'timelapse_to_icloud.sh')}" & " run" & " " & quoted form of "emre@pihole2" & " " & quoted form of "emre@standby"`,
    '-e', 'end try']);
  assert.strictEqual(fs.readFileSync(path.join(mac, 'ran'), 'utf8'), `/bin/bash '${path.join(support, 'timelapse_to_icloud.sh')}' run 'emre@pihole2' 'emre@standby'`);
  assert.ok(/bootstrap gui\/\d+ \S+com\.nhrc\.timelapse-to-icloud\.plist/.test(fs.readFileSync(path.join(mac, 'launchctl.log'), 'utf8')));
  // Its first copy, through the app: both Pis.
  assert.deepStrictEqual(m.logLines(), ['copied 3 days, 9 frames, from emre@pihole2 to iCloud Drive/NHRC Timelapse',
    'copied 1 day, 1 frame, from emre@standby to iCloud Drive/NHRC Timelapse']);
  assert.ok(fs.existsSync(path.join(m.dest, '2026-10-14', '2026-10-14_0730.jpg')));
  // Installed again: nothing added twice, nothing copied twice.
  r = m.exec(['install', 'emre@pihole2', 'emre@standby'], env);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/Adding this Mac's key/.test(r.stdout), 'the key works already: not added again');
  assert.strictEqual(m.lastLog().slice(20), 'nothing new to copy');
  // A Pi whose export fails although the key is there: the install says so - and still leaves one line.
  fs.rmSync(m.standby.dir, { recursive: true });
  fs.writeFileSync(m.standby.dir, 'not a folder');
  r = m.exec(['install', 'emre@pihole2', 'emre@standby'], env);
  assert.ok(r.status !== 0 && /The key does not work on emre@standby yet: /.test(r.stderr), r.stdout + r.stderr);
  assert.strictEqual(keysOn(standbyHome), keyLine + '\n', 'the line already there was not added again');
  // A Pi without the export installed: said - and nothing is put on it.
  const newHome = tlDir();
  r = m.exec(['install', 'emre@standby'], Object.assign({}, env, { FAKE_PI_HOME_STANDBY: newHome, FAKE_HELPER: '/nonexistent/nhrc-timelapse-export' }));
  assert.ok(r.status !== 0 && /First install \S+ on the Pi - see camera\/README\.md/.test(r.stderr), r.stderr);
  assert.ok(!fs.existsSync(path.join(newHome, '.ssh', 'authorized_keys')));
});

test('the Pi\'s export on a Pi that has never filmed (a standby): no days - not an error', () => {
  const missing = path.join(tlDir(), 'timelapse');
  const r = exportAsk(missing, 'list');
  assert.strictEqual(r.status, 0, r.stderr.toString());
  assert.strictEqual(r.stdout.toString(), '');
  assert.strictEqual(exportAsk(missing, 'get 2026-10-14').status, 1);
  // The Mac then copies the main Pi's days, and has nothing to say about the standby.
  const m = macRig();
  m.copy('2026-10-14', '21', { FAKE_PI_DIR_STANDBY: missing }, ['emre@pihole2', 'emre@standby']);
  assert.deepStrictEqual(m.logLines(), ['copied 3 days, 9 frames, from emre@pihole2 to iCloud Drive/NHRC Timelapse']);
});

test('the README\'s iCloud steps match the scripts: where the export goes, the commands, what the log can say', () => {
  const md = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const sec = md.slice(md.indexOf('### Copying the frames to iCloud, every evening'), md.indexOf('### Turning it off'));
  assert.ok(sec.length > 1000, 'the section is there');
  const src = fs.readFileSync(ICLOUD_SH, 'utf8');
  const helper = /HELPER="([^"]+)"/.exec(src)[1];
  assert.ok(sec.includes(`sudo curl -fsSL -o ${helper} https://raw.githubusercontent.com/egurpinar/NHRC_temp_monitoring/main/camera/timelapse_export.sh`),
    'installed where the key\'s forced command points');
  assert.ok(sec.includes(`sudo chmod 755 ${helper}`) && sec.includes('SSH_ORIGINAL_COMMAND=list nhrc-timelapse-export'));
  assert.ok(sec.includes('bash camera/timelapse_to_icloud.sh install emre@pihole2') && sec.includes('bash camera/timelapse_to_icloud.sh uninstall'));
  assert.ok(sec.includes('~/Library/Application\\ Support/NHRC\\ Timelapse/timelapse_to_icloud.sh run emre@pihole2'), 'the copy the install leaves behind');
  for (const said of ['copied 1 day, 134 frames, from emre@pihole2 to iCloud Drive/NHRC Timelapse', 'nothing new to copy', 'could not reach emre@pihole2 (',
    'could not copy 2026-10-14 from emre@pihole2: 80 of its 134 frames arrived', 'could not write to iCloud Drive (', 'iCloud Drive cannot be found']) {
    assert.ok(sec.includes(said), `the README explains "${said}"`);
  }
  for (const said of ['copied $copied day', 'from $PI to iCloud Drive/$NAME', 'nothing new to copy', 'could not reach $PI (',
    'could not write to iCloud Drive (', 'iCloud Drive cannot be found', 'could not copy $day from $PI: $got of its $count frames arrived']) {
    assert.ok(src.includes(said), `the script says "${said}"`);
  }
  assert.ok(/RUN_HOUR=21\nRUN_MINUTE=30/.test(src) && sec.includes('At\n21:30'), 'the time the README gives');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6j. Two Pis and the timelapse: the standby films only while it has taken over');
// ═══════════════════════════════════════════════════════════════════════════
//
// The battery camera must never be filmed by both Pis. The standby films only
// while it runs the cameras; each frame comes after the slot's check and dock
// photo, as the main Pi's come after its photo; it asks the Worker again just
// before each live view; and while standing by it makes no camera call at all
// - not even for the battery level - says nothing, and writes nothing.

const TL_DAY = '2026-10-13', TL_NEXT = '2026-10-14';   // sunrise 07:02, sunset 18:14: frames 07:05 to 18:10

/** The frame names from one time to another on TL_DAY, every 5 minutes. */
function framesBetween(from, to) {
  const min = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const out = [];
  for (let m = min(from); m <= min(to); m += 5) {
    out.push(`${TL_DAY}_${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}.jpg`);
  }
  return out;
}

/**
 * One Pi on a fake clock: its dock photos' loop and its every-5-minutes
 * timelapse, wired as main() and runStandby() wire them, sharing one clock as
 * setTimeout would run them (each wake runs to its end before the next; the
 * stand-ins add a dock photo's 20 s and a live view's 40 s to the clock). The
 * Worker knows when the main Pi last checked in: on every 5-minute mark
 * (+0.5 s) unless mainDead(at), and at each of mainStarts (a restart).
 */
async function twoPiDay(role, from, to, opts = {}) {
  const { mainDead = () => false, mainStarts = [], workerDown = () => false, primaryDown = () => false,
          sameRing = false, heartbeat = true } = opts;
  const dir = tlDir();
  const cfg = Object.assign({}, role === 'standby' ? standbyCfg : mainCfg, {
    timelapse: tlCfg(dir, { times: [], everyMinutes: 5, minBattery: 40, targetHeight: 1080, recordSeconds: 45 }).timelapse });
  let t = from.getTime(), seq = 0;
  const timers = [];
  const now = () => new Date(t);
  const setTimer = (fn, ms) => { timers.push({ at: t + Math.max(0, ms), seq: seq++, fn }); };
  const rec = { photos: [], live: [], health: 0, probes: [], beats: 0 };
  const worker = () => {
    if (workerDown(now())) throw new Error('check-in with nhrc-camera.example.workers.dev failed: ECONNREFUSED');
    let c = Math.floor((t - 500) / 300000) * 300000 + 500;
    for (let i = 0; i < 3000 && mainDead(new Date(c)); i++) c -= 300000;
    if (mainDead(new Date(c))) c = null;
    for (const s of mainStarts) if (s.getTime() <= t && (c === null || s.getTime() > c)) c = s.getTime();
    return { ok: true, conflict: false, standby: null, main: c === null ? null
      : { lastSeenSecondsAgo: Math.round((t - c) / 1000), state: 'capturing', ringId: sameRing ? ID_STANDBY.ringId : ID_MAIN_RING } };
  };
  const camera = { name: 'Downstream Lot', id: 202,
    getHealth: async () => { rec.health++; return { battery_percentage: 87, latest_signal_strength: -61 }; } };
  let tick = null, sb = null;
  if (role === 'standby') {
    sb = S.createStandby(cfg, { now, identity: ID_STANDBY, ringWaitMs: 50, checkIn: async () => worker(),
      connect: async () => {}, ringCheck: async () => '"Dock Wired" online, "Downstream Lot" online' });
  }
  const tl = S.createTimelapse(cfg, Object.assign({
    camera: () => camera, now, setTimer,
    exists: () => true,                                // ffmpeg, wherever the tests run
    dockBusy: () => !!(tick && tick.busy()),
    backupInUse: () => !!(tick && tick.onBackup()),
    exit: () => {}, rssBytes: () => 90 * 1048576, openFiles: () => 30, strays: () => [],
    dockWaitMs: 300, dockPollMs: 5,
    liveFrame: async (cam, workDir) => {
      rec.live.push(nyClock(now()));
      t += 40000;
      const frame = path.join(workDir, 'frame.jpg');
      fs.writeFileSync(frame, fakeJpeg(1920, 1080));
      return { frame, liveSeconds: 13, missing: 0, received: 950, checked: ['9.8 s clean'], resolutions: '1920x1080 from 9.8 s',
        target: 1080, stoppedEarly: { at: 12.8, size: { width: 1920, height: 1080 } }, largest: { width: 1920, height: 1080 } };
    },
  }, role === 'standby' ? {
    // As runStandby wires them.
    standingBy: () => sb.state() !== 'capturing',
    confirm: async () => {
      rec.probes.push(nyClock(now()));
      const reply = worker();
      return S.standbyDecision(reply, cfg).capture && !S.sameRingDevice(reply.main, ID_STANDBY);
    },
    quietSummary: true,
    wakeDelayMs: S.STANDBY_WAKE_OFFSET_MS + S.INTERVAL_WAKE_MS,
  } : {}));
  tick = S.createScheduler(cfg, Object.assign({
    now, setTimer, hasPrimary: true, hasBackup: true,
    cycle: async (which) => {
      const at = now();
      t += 20000;
      const down = which === 'primary' && primaryDown(at);
      rec.photos.push({ role: which, at: nyClock(at), ok: !down });
      if (down) throw Object.assign(new Error(`${which} offline`), { stage: 'capture' });
    },
  }, role === 'standby' ? { gate: sb.gate, wakeOffsetMs: S.STANDBY_WAKE_OFFSET_MS, maxSleepSeconds: S.CHECK_IN_SECONDS }
    : heartbeat ? { heartbeat: () => { rec.beats++; }, maxSleepSeconds: S.CHECK_IN_SECONDS } : {}));
  const lines = await captureLogs(async () => {
    await tick();
    await tl.intervalTick();   // after the first dock photo, as main() and runStandby() start it
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers[0];
      if (!next || next.at > to.getTime()) break;
      timers.shift();
      t = Math.max(t, next.at);
      await next.fn();
    }
    await flush();
  });
  const frames = [];
  for (const d of fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d$/.test(f)).sort()) {
    frames.push(...fs.readdirSync(path.join(dir, d)).filter(f => f.endsWith('.jpg')).sort());
  }
  const plain = (l) => l.replace(/^\S+ - (ERROR: )?/, '');
  return { rec, lines, frames, dir, sb, tlLines: lines.filter(l => /Timelapse/.test(l)).map(plain),
           pauses: lines.filter(l => /Timelapse (paused|resumed)/.test(l)).map(plain) };
}

test('a normal day for the standby: the main Pi checks in all day - no live view, no battery reading, not a word about the timelapse, nothing written', async () => {
  const r = await twoPiDay('standby', ny(TL_DAY, 0, 0), ny(TL_NEXT, 0, 0));
  assert.deepStrictEqual([r.rec.live.length, r.rec.health, r.rec.probes.length, r.rec.photos.length], [0, 0, 0, 0]);
  assert.deepStrictEqual(r.tlLines, [], r.tlLines.join(' | '));
  assert.deepStrictEqual(fs.readdirSync(r.dir), [], 'nothing on its SD card - not even the note of captures');
  assert.strictEqual(r.sb.state(), 'standing-by');
});

test('the main Pi dies at 9:02 and is back at 11:00: the standby films 9:15 to 10:55, each frame after its check and dock photo, then stops', async () => {
  const r = await twoPiDay('standby', ny(TL_DAY, 8, 0), ny(TL_NEXT, 0, 0), { mainDead: between(9 + 2 / 60, 11) });
  assert.deepStrictEqual(r.frames, framesBetween('09:15', '10:55'), 'from the takeover slot; none after the hand-back');
  assert.deepStrictEqual(r.rec.photos.map(p => p.at), ['09:15:30', '09:30:30', '09:45:30', '10:00:30', '10:15:30', '10:30:30', '10:45:30']);
  // 30 s into the slot, after the check - on a quarter hour after the dock photo too.
  for (const at of r.rec.live) assert.strictEqual(at.slice(6), Number(at.slice(3, 5)) % 15 === 0 ? '50' : '32', at);
  assert.strictEqual(r.rec.probes.length, 21, 'the Worker asked again before each of the 21 live views');
  assert.deepStrictEqual(r.pauses, [], 'the hand-back was seen by its check, before the frame was due');
  assert.ok(r.tlLines.some(l => /^Timelapse 2026-10-13: 21 frames saved \(21 at 1920x1080\)/.test(l)), 'the day in one line after sunset - it filmed that day');
  assert.strictEqual(r.sb.state(), 'standing-by');
});

test('the main Pi back mid-slot, just after the standby\'s check (11:00:31): asked again before the live view, the standby does not film', async () => {
  const back = ny(TL_DAY, 11, 0, 31);
  const r = await twoPiDay('standby', ny(TL_DAY, 8, 0), ny(TL_DAY, 12, 0),
    { mainDead: (at) => at >= ny(TL_DAY, 9, 2) && at < back, mainStarts: [back] });
  assert.ok(r.rec.photos.some(p => p.at === '11:00:30'), 'its check at 11:00:30 had not seen it: that dock photo was taken');
  assert.deepStrictEqual(r.frames, framesBetween('09:15', '10:55'), 'but not the 11:00 frame');
  assert.deepStrictEqual(r.rec.probes.slice(-1), ['11:00:50'], 'the question that stopped it');
  assert.deepStrictEqual(r.pauses, ['Timelapse paused: the Worker does not confirm that the main Pi is still away (it may be back).']);
  assert.strictEqual(r.sb.state(), 'standing-by', 'and at its next check, 11:05:30, it stood by');
});

test('a Worker outage while the standby has taken over: the dock photos go on, the timelapse pauses - no answer is not a yes - and resumes after', async () => {
  const r = await twoPiDay('standby', ny(TL_DAY, 8, 0), ny(TL_DAY, 12, 0), { mainDead: between(8, 12), workerDown: between(10, 10.5) });
  assert.deepStrictEqual(r.frames, [...framesBetween('08:10', '09:55'), ...framesBetween('10:30', '11:55')]);
  assert.deepStrictEqual(r.rec.photos.filter(p => p.at >= '10:00' && p.at < '10:30').map(p => p.at), ['10:00:30', '10:15:30'],
    'the dock photos went on');
  assert.deepStrictEqual(r.pauses, ['Timelapse paused: the Worker does not confirm that the main Pi is still away (it may be back).',
    'Timelapse resumed at 10:30.'], 'said when it began and when it ended - not every 5 minutes');
});

test('takeover with the dock camera down: the standby films until the website needs the battery camera as its backup, then pauses, as the main Pi does', async () => {
  const r = await twoPiDay('standby', ny(TL_DAY, 8, 0), ny(TL_DAY, 13, 0), { mainDead: between(8, 12), primaryDown: () => true });
  assert.deepStrictEqual(r.frames, [`${TL_DAY}_0810.jpg`], 'the takeover slot, before the second dock miss');
  assert.deepStrictEqual(r.rec.photos.filter(p => p.role === 'backup').map(p => p.at.slice(0, 5)),
    ['08:15', '08:30', '09:00', '09:30', '10:00', '11:00'], 'the main Pi\'s backup timetable');
  assert.deepStrictEqual(r.pauses, ['Timelapse paused: the website is using "Downstream Lot" as its backup camera, until the dock camera answers again.']);
  // Never two things at once from the battery camera: its one live view ended before the first backup photo.
  assert.deepStrictEqual(r.rec.live, ['08:10:50']);
});

test('a standby with the main Pi\'s Ring device never films - even with the main Pi gone since 6:00', async () => {
  const r = await twoPiDay('standby', ny(TL_DAY, 0, 0), ny(TL_NEXT, 0, 0), { mainDead: (at) => at >= ny(TL_DAY, 6, 0), sameRing: true });
  assert.deepStrictEqual([r.rec.live.length, r.rec.health, r.rec.photos.length, r.frames.length], [0, 0, 0, 0]);
  assert.strictEqual(r.sb.state(), 'blocked');
  assert.deepStrictEqual(r.tlLines, []);
});

test('the main Pi\'s day with its check-ins is its day without them: 96 dock photos and 134 frames, in the same slots - and 288 check-ins', async () => {
  const withThem = await twoPiDay('main', ny(TL_DAY, 0, 0), ny(TL_NEXT, 0, 0));
  const before = await twoPiDay('main', ny(TL_DAY, 0, 0), ny(TL_NEXT, 0, 0), { heartbeat: false });
  assert.strictEqual(withThem.rec.photos.length, 96);
  assert.ok(withThem.rec.photos.every(p => /^\d\d:(00|15|30|45):00$/.test(p.at)), 'on the quarter hour, to the second');
  assert.strictEqual(withThem.rec.beats, 288);
  assert.deepStrictEqual(withThem.frames, framesBetween('07:05', '18:10'));
  assert.deepStrictEqual(withThem.frames, before.frames);
  assert.deepStrictEqual(withThem.rec.live.map(x => x.slice(0, 5)), before.rec.live.map(x => x.slice(0, 5)), 'each frame in the same minute');
  assert.deepStrictEqual(withThem.rec.photos.map(p => p.at.slice(0, 5)), before.rec.photos.map(p => p.at.slice(0, 5)));
  assert.deepStrictEqual([withThem.rec.probes.length, withThem.pauses.length], [0, 0], 'the main Pi never asks before filming');
  assert.ok(withThem.tlLines.some(l => /^Timelapse 2026-10-13: 134 frames saved \(134 at 1920x1080\)/.test(l)));
});

test('while the standby asks the Worker, the slot is busy - so a frame due waits for the answer', async () => {
  let answer;
  const t = ny(TL_DAY, 9, 15, 30).getTime();
  const tick = S.createScheduler(standbyCfg, { now: () => new Date(t), setTimer: () => {}, cycle: async () => {},
    gate: () => new Promise(r => { answer = r; }) });
  const done = tick();
  assert.strictEqual(tick.busy(), true, 'busy while it asks');
  answer(false);
  await done;
  assert.strictEqual(tick.busy(), false, 'free once answered');
  const failing = S.createScheduler(standbyCfg, { now: () => new Date(t), setTimer: () => {}, cycle: async () => {},
    gate: async () => { throw new Error('bug'); } });
  await captureLogs(() => failing());
  assert.strictEqual(failing.busy(), false, 'and once a question fails');
  let mt = ny(TL_DAY, 9, 15, 0).getTime();
  const main = S.createScheduler(mainCfg, { now: () => new Date(mt), setTimer: () => {}, cycle: async () => {},
    heartbeat: () => new Promise(() => {}) });
  await main();                                        // the 9:15 dock photo
  mt = ny(TL_DAY, 9, 20, 0).getTime() + 500;
  main();                                              // 9:20: only a check-in, which never answers
  assert.strictEqual(main.busy(), false, 'the main Pi\'s check-in never holds a frame back');
});

test('at the takeover the frame due waits for the standby\'s answer, then is filmed in that same slot', async () => {
  const dir = tlDir();
  let standing = true, asking = true;
  // 9:15:32: the check (and dock photo) under way; it answers 60 ms later - taking over.
  const rig = intervalRig(dir, { start: [9, 15, 32], dockBusy: () => asking, standingBy: () => standing, dockWaitMs: 5000 });
  setTimeout(() => { standing = false; asking = false; }, 60);
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 16)));
  assert.deepStrictEqual(rig.calls.liveAt, ['09:15'], 'not lost: asked before the answer, it would have been');
  // Standing by, the frame is not filmed - and nothing is read, not even the battery.
  const dir2 = tlDir();
  const idle = intervalRig(dir2, { start: [9, 15, 32], standingBy: () => true, quietSummary: true });
  const lines = await captureLogs(() => idle.runUntil(ny('2026-10-13', 18, 30)));
  assert.deepStrictEqual([idle.calls.live, idle.calls.health, idle.calls.snap], [0, 0, 0]);
  assert.deepStrictEqual(lines, [], 'not a word');
});

test('the standby asks before every live view; a refusal, a throw or a hang-up is not a yes - and the battery camera is not woken', async () => {
  for (const confirm of [async () => false, async () => { throw new Error('ECONNREFUSED'); }, async () => 'yes', async () => undefined]) {
    const dir = tlDir();
    const rig = intervalRig(dir, { start: [9, 15], standingBy: () => false, confirm });
    const lines = await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 40)));
    assert.strictEqual(rig.calls.live, 0, String(confirm));
    assert.strictEqual(lines.filter(l => /Timelapse paused: the Worker does not confirm/.test(l)).length, 1, 'said once');
  }
  const dir = tlDir();
  let asked = 0;
  const rig = intervalRig(dir, { start: [9, 15], standingBy: () => false, confirm: async () => { asked++; return true; } });
  await captureLogs(() => rig.runUntil(ny('2026-10-13', 9, 40)));
  assert.deepStrictEqual([rig.calls.live, asked], [5, 5], 'a yes before each of the five');
});

test('the standby\'s day summary: only for a day it filmed', async () => {
  const quiet = intervalRig(tlDir(), { start: [17, 0], standingBy: () => true, quietSummary: true });
  let lines = await captureLogs(() => quiet.runUntil(ny('2026-10-13', 18, 30)));
  assert.deepStrictEqual(lines, []);
  let standing = false;
  const filmed = intervalRig(tlDir(), { start: [17, 0], standingBy: () => standing, quietSummary: true, confirm: async () => true });
  lines = await captureLogs(async () => {
    await filmed.runUntil(ny('2026-10-13', 17, 20));
    standing = true;                                   // handed back at 17:20
    await filmed.runUntil(ny('2026-10-13', 18, 30));
  });
  assert.ok(lines.some(l => /Timelapse 2026-10-13: 4 frames saved \(4 at 1920x1080\)/.test(l)), lines.join(' | '));
  // Filmed, but every frame failed: it tried that day, so it says how it went.
  let standingNow = false;
  const failing = intervalRig(tlDir(), { start: [17, 0], standingBy: () => standingNow, quietSummary: true, confirm: async () => true,
    frames: () => new Error('the camera did not answer') });
  lines = await captureLogs(async () => {
    await failing.runUntil(ny('2026-10-13', 17, 20));
    standingNow = true;
    await failing.runUntil(ny('2026-10-13', 18, 30));
  });
  assert.ok(lines.some(l => /Timelapse 2026-10-13: 0 frames saved; 4 failed/.test(l)), lines.join(' | '));
  // The main Pi (no quietSummary) sums up a day even with nothing filmed.
  const main = intervalRig(tlDir(), { start: [17, 0], battery: () => 30 });
  lines = await captureLogs(() => main.runUntil(ny('2026-10-13', 18, 30)));
  assert.ok(lines.some(l => /Timelapse 2026-10-13: 0 frames saved/.test(l)), lines.join(' | '));
});

test('the service wires the standby\'s timelapse: films only while capturing, asks before each live view, after the slot\'s check', () => {
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const standby = src.slice(src.indexOf('async function runStandby('), src.indexOf('module.exports'));
  assert.ok(/standingBy: \(\) => standby\.state\(\) !== 'capturing'/.test(standby));
  assert.ok(/wakeDelayMs: STANDBY_WAKE_OFFSET_MS \+ INTERVAL_WAKE_MS/.test(standby));
  assert.ok(/confirm: async \(\) => \{\s*const reply = await checkIn\(\{ pi: 'standby', probe: true,[^}]*\}, CONFIG\);\s*return standbyDecision\(reply, CONFIG\)\.capture && !sameRingDevice\(reply\.main, identity\);/.test(standby),
    'a probe - recorded nowhere - and the same decision as the check, the same Ring rule');
  const main = src.slice(src.indexOf('async function main()'), src.indexOf('async function runStandby('));
  assert.ok(/setUpTimelapse\(\{ camera: \(\) => camera, backup: \(\) => backup, api: \(\) => api, scheduler: \(\) => tick \}\)/.test(main),
    'the main Pi films as before: no standby hooks');
  const setup = src.slice(src.indexOf('function setUpTimelapse('), src.indexOf('async function main()'));
  assert.ok(/quietSummary: !!hooks\.standingBy/.test(setup) && /wakeDelayMs: hooks\.wakeDelayMs/.test(setup));
});

test('the README\'s standby section matches the code: the timetable it runs, what the journal says, the commands', () => {
  const md = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const sec = md.slice(md.indexOf('## 8. A standby Pi'), md.indexOf('## Settings worth knowing'));
  assert.ok(sec.length > 3000, 'the section is there');
  const flat = (x) => x.replace(/\s+/g, ' ');
  const text = flat(sec);
  assert.ok(text.includes(`quiet for \`STANDBY_TAKEOVER_MINUTES\` (${S.CONFIG.takeoverMinutes})`));
  assert.ok(text.includes(`the dock camera every ${S.CONFIG.intervalMinutes} minutes, the battery camera only after two dock misses`)
    && S.CONFIG.backup.afterMisses === 2, 'today\'s timetable, not the 5 minutes and six misses of 4 October');
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  const code = flat(src).replace(/\\'/g, "'");   // as the strings read, not as they are escaped
  for (const said of ['This is the STANDBY Pi', 'Standing by: the main Pi checked in', 'separate from the other Pi\'s',
    'this standby would stand by', 'Timelapse paused: the Worker does not confirm that the main Pi is still away', 'Timelapse resumed at',
    'the STANDBY', 'is taking over the cameras', 'back to standing by']) {
    assert.ok(text.includes(said), `the README quotes "${said}"`);
    // (A pause is said as "Timelapse paused: " and its reason.)
    assert.ok(code.toLowerCase().includes(said.replace(/^Timelapse paused: /, '').toLowerCase()), `the service says "${said}"`);
  }
  // The commands: the same checks as the timelapse's, the unit file from the repo, no drop-in.
  assert.ok(sec.includes("sudo -u nhrccam bash -c 'set -a; . /opt/nhrc-camera/env; /usr/local/bin/node /opt/nhrc-camera/snapshot_service.js --check'"));
  assert.ok(sec.includes("sudo -u nhrccam bash -c 'set -a; . /opt/nhrc-camera/env; /usr/local/bin/node /opt/nhrc-camera/snapshot_service.js --status'"));
  assert.ok(sec.includes('sudo curl -fsSL -o /etc/systemd/system/nhrc-camera.service https://raw.githubusercontent.com/egurpinar/NHRC_temp_monitoring/main/camera/nhrc-camera.service'));
  assert.ok(!/timelapse\.conf/.test(sec), 'no drop-in on the standby: the unit file has those settings');
  const unit = fs.readFileSync(path.join(__dirname, 'nhrc-camera.service'), 'utf8');
  assert.ok(sec.includes('cat /proc/$(systemctl show -p MainPID --value nhrc-camera)/oom_score_adj'), 'the protection that does apply, checked');
  assert.ok(!/MemoryMax=\d/.test(sec), 'no cap promised that Raspberry Pi OS does not enforce');
  // Every command block is paste-safe: top level, one command a line, no heredoc.
  for (const [, block] of sec.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const line of block.split('\n').filter(Boolean)) {
      assert.ok(!/^\s/.test(line) && !/<<|\\$/.test(line), `paste-safe: ${line}`);
    }
  }
  // The settings: the main Pi's env, with CAMERA_PI=standby - run on a copy (one with an old line too).
  const envFile = path.join(tlDir(), 'env');
  fs.writeFileSync(envFile, 'CAMERA_UPLOAD_URL=x\nCAMERA_PI=main\nTIMELAPSE_EVERY_MINUTES=5\n');
  const lines = [/sudo sed -i '\/\^CAMERA_PI=\/d' \/opt\/nhrc-camera\/env\n/, /echo 'CAMERA_PI=standby' \| sudo tee -a \/opt\/nhrc-camera\/env\n/]
    .map(re => { const m = re.exec(sec); assert.ok(m, String(re)); return m[0]; }).join('');
  const r = require('child_process').spawnSync('bash', ['-c', lines.replace(/sudo /g, '').replace(/\/opt\/nhrc-camera\/env/g, envFile)], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(envFile, 'utf8'), 'CAMERA_UPLOAD_URL=x\nTIMELAPSE_EVERY_MINUTES=5\nCAMERA_PI=standby\n');
  // The token goes where the env says, owned by the service alone.
  assert.ok(sec.includes('sudo mv ~/.nhrc-ring-token /opt/nhrc-camera/ring-token') && sec.includes('sudo chmod 600 /opt/nhrc-camera/ring-token'));
  assert.ok(sec.includes('sudo install -m 600 -o nhrccam -g nhrccam /tmp/env.main /opt/nhrc-camera/env') && sec.includes('rm /tmp/env.main'),
    'the copy of the secret is made private, and removed');
});

// ── What runs at the boathouse now, against this release ──
//
// The Worker is updated first. Until the main Pi is updated too, it must take
// the main Pi's photos and serve them exactly as before - and a standby must
// not take over from a main Pi that does not check in.

test('the Worker update is safe for the main Pi as it runs now: its photos go up and are served as before, and a standby does not take over from it', async () => {
  const deployed = atCommit(DEPLOYED_SERVICE, 'snapshot_service.js');
  if (!deployed) { console.log(`    (skipped: git does not have ${DEPLOYED_SERVICE} here)`); return; }
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }], {}, { serviceSource: deployed });
  box.setToken(ringToken('hid-main-pi'));
  let r = await box.run([], {}, { stopAfter: 1, settleMs: 1500 });
  assert.deepStrictEqual(r.uploads.map(u => [u.method, u.role, u.name, u.pi]), [['PUT', 'primary', 'Dock Wired', null]], r.out);
  assert.deepStrictEqual(box.host.checkIns(), [], 'it does not know check-ins');
  assert.ok(!/ERROR/.test(r.out), r.out);
  const img = await box.host.get();
  assert.strictEqual(img.status, 200);
  assert.deepStrictEqual([img.headers.get('X-Camera-Role'), img.headers.get('X-Camera-Name')], ['primary', 'Dock Wired'], 'what the website reads');
  assert.ok(img.headers.get('Last-Modified'));
  let st = await box.host.status();
  assert.deepStrictEqual([st.ok, st.role, st.camera, st.pi], [true, 'primary', 'Dock Wired', null]);
  assert.deepStrictEqual([st.pis.main.state, st.pis.standby], [null, null], 'the main Pi known by its photo only');
  // A standby on this release, the main Pi's photo 20 minutes old: it stands by.
  fs.copyFileSync(path.join(__dirname, 'snapshot_service.js'), path.join(box.dir, 'snapshot_service.js'));
  const standbyToken = path.join(box.dir, 'token-standby');
  fs.writeFileSync(standbyToken, ringToken('hid-standby-pi'));
  ageBy(box.host.env, 20);
  box.reset();
  r = await box.run([], Object.assign({ RING_TOKEN_FILE: standbyToken }, STANDBY_ENV),
    { until: (out) => /Standing by: the main Pi's last photo came/.test(out), settleMs: 700 });
  assert.ok(/The main Pi sends photos but has never checked in with the Worker: it runs older software/.test(r.out), r.out);
  assert.ok(/Standing by: the main Pi's last photo came 20 min ago, but it does not check in yet - this Pi will not take over until it does\./.test(r.out), r.out);
  assert.deepStrictEqual(r.uploads, []);
  assert.ok(!box.ringEvents().some(e => e.ev === 'snapshot'), 'no camera woken');
  st = await box.host.status();
  assert.strictEqual(st.pis.standby.state, 'standing-by');
});

test('the main Pi updated before the Worker: the Worker as deployed takes its photos as before; its check-ins are refused, said once, and change nothing', async () => {
  const oldWorker = atCommit(DEPLOYED_WORKER, 'cloudflare_worker.js');
  if (!oldWorker) { console.log(`    (skipped: git does not have ${DEPLOYED_WORKER} here)`); return; }
  const box = await e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }], { workerSource: oldWorker });
  box.setToken(ringToken('hid-main-pi'));
  const r = await box.run([], {}, { stopAfter: 1, settleMs: 1500 });
  assert.deepStrictEqual(r.uploads.map(u => [u.role, u.name, u.pi]), [['primary', 'Dock Wired', 'main']], r.out);
  assert.ok(/Snapshot uploaded/.test(r.out), r.out);
  assert.strictEqual((r.out.match(/check-in failed: HTTP 405/g) || []).length, 1, r.out);
  assert.ok(/this Worker does not know check-ins yet: update it \(camera\/README\.md\)\. The cameras carry on\./.test(r.out), r.out);
  assert.ok(!/a standby Pi will take over/.test(r.out), 'no standby can take over through that Worker either: not said');
  const img = await box.host.get();
  assert.strictEqual(img.status, 200);
  assert.deepStrictEqual([img.headers.get('X-Camera-Role'), img.headers.get('X-Camera-Name')], ['primary', 'Dock Wired']);
  const st = await box.host.status();
  assert.deepStrictEqual([st.ok, st.role, st.camera], [true, 'primary', 'Dock Wired']);
});

// ── Both Pis for real, with the timelapse: real ffmpeg, the real Worker ──

if (HAVE_FFMPEG) {
  /**
   * Both Pis for real, with the timelapse every 5 minutes (all day, for the
   * tests): the service processes, the stand-in Ring library whose live view
   * is a real 1080p stream, and the real Worker over HTTP - one Worker for both,
   * each Pi with its own Ring login, timelapse folder and recording folder.
   */
  const twoPiBox = async (hostOpts) => {
    const host = await workerHost(hostOpts);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-2pi-e2e-'));
    fs.copyFileSync(path.join(__dirname, 'snapshot_service.js'), path.join(dir, 'snapshot_service.js'));
    const ringLog = path.join(dir, 'ring.log');
    liveRingLibrary(dir, ringLog);
    for (const pi of ['main', 'standby']) {
      fs.writeFileSync(path.join(dir, `token-${pi}`), ringToken(`hid-${pi}-pi`));
      fs.mkdirSync(path.join(dir, `tmp-${pi}`));
      fs.mkdirSync(path.join(dir, `run-${pi}`));
    }
    fs.writeFileSync(path.join(dir, 'fakefetch.js'), `
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, opts) => {
        const u = new URL(String(url));
        if (u.host !== ${JSON.stringify(WORKER_HOST)}) throw new Error('test: no network access to ' + u.host);
        return realFetch('http://127.0.0.1:${host.port}' + u.pathname + u.search, opts);
      };`);
    // TEST_CLOCK_SPEED runs the service's clock and timers that many times faster.
    fs.writeFileSync(path.join(dir, 'clock.js'), `
      const speed = Number(process.env.TEST_CLOCK_SPEED || 1);
      if (speed !== 1) {
        const RealDate = Date, realNow = RealDate.now.bind(RealDate), t0 = realNow();
        const now = () => t0 + (realNow() - t0) * speed;
        globalThis.Date = class extends RealDate {
          constructor(...a) { if (a.length) super(...a); else super(now()); }
          static now() { return now(); }
        };
        const st = globalThis.setTimeout, si = globalThis.setInterval;
        globalThis.setTimeout = (fn, ms, ...rest) => st(fn, Math.max(0, Number(ms) || 0) / speed, ...rest);
        globalThis.setInterval = (fn, ms, ...rest) => si(fn, Math.max(1, (Number(ms) || 0) / speed), ...rest);
      }`);
    const events = (pi) => (fs.existsSync(ringLog) ? fs.readFileSync(ringLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [])
      .filter(e => !pi || e.pi === pi);
    const tlOut = (pi) => path.join(dir, `timelapse-${pi}`);
    const run = (pi, args, env = {}, opts = {}) => new Promise((resolve) => {
      const { until = null, settleMs = 0, maxMs = 40000, onStart = null } = opts;
      const child = require('child_process').spawn(process.execPath, ['-r', path.join(dir, 'fakefetch.js'), '-r', path.join(dir, 'clock.js'),
        path.join(dir, 'snapshot_service.js'), ...args], {
        cwd: dir,
        env: Object.assign({ PATH: process.env.PATH, HOME: dir, TMPDIR: path.join(dir, `tmp-${pi}`), CAMERA_PI: pi,
          RING_TOKEN_FILE: path.join(dir, `token-${pi}`), TIMELAPSE_DIR: tlOut(pi), TIMELAPSE_WORK_DIR: path.join(dir, `run-${pi}`),
          CAMERA_UPLOAD_URL: `https://${WORKER_HOST}/latest.jpg`, CAMERA_UPLOAD_SECRET: baseCfg.uploadSecret,
          RING_CAMERA_NAME: 'Dock Wired', RING_BACKUP_CAMERA_NAME: 'Downstream Lot', CAMERA_RETRIES: '1', CAMERA_RETRY_DELAY_SECONDS: '0',
          TIMELAPSE_EVERY_MINUTES: '5', TIMELAPSE_FROM: '0:00', TIMELAPSE_UNTIL: '23:59', TIMELAPSE_RECORD_SECONDS: '20' }, env),
      });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      if (onStart) onStart(child, () => out);
      const started = Date.now();
      let seenAt = null;
      const poll = setInterval(() => {
        if (seenAt === null && until && until(out)) seenAt = Date.now();
        if ((seenAt !== null && Date.now() - seenAt >= settleMs) || Date.now() - started > maxMs) child.kill('SIGKILL');
      }, 50);
      child.on('exit', (code, signal) => { clearInterval(poll); resolve({ code, signal, out }); });
    });
    // The camera's stand-in ffmpegs, and any recording one, once the services have gone.
    const cleanup = () => require('child_process').spawnSync('pkill', ['-KILL', '-f', dir]);
    return { dir, host, run, events, tlOut, cleanup, uploads: () => host.uploads().map(u => ({ role: u.role, name: u.name, pi: u.pi })) };
  };
  const anyFrame = (o) => /Timelapse \S+ \S+: (saved|live video failed)/.test(o);

  test('end to end, both Pis with the timelapse: the main Pi films; the standby, standing by, touches no camera - not even for the battery - and says nothing about it', async () => {
    const box = await twoPiBox();
    try {
      let mainDone = false;
      const mainRun = box.run('main', [], {}, { until: anyFrame, settleMs: 500, maxMs: 45000 }).then((r) => { mainDone = true; return r; });
      // The standby starts once the main Pi has checked in, as when both have been running.
      for (let i = 0; i < 200 && !box.host.checkIns('main').length; i++) await new Promise(r => setTimeout(r, 50));
      const standbyRun = box.run('standby', [], {}, { until: () => mainDone, maxMs: 50000 });
      const [m, s] = await Promise.all([mainRun, standbyRun]);
      assert.ok(/Timelapse \S+ \S+: saved \S+ - 1920x1080/.test(m.out), m.out);
      assert.ok(/Standing by: the main Pi checked in \d+ s ago/.test(s.out), s.out);
      assert.ok(/Timelapse: "Downstream Lot" every 5 min .*; on this standby Pi only while it has taken over\. Test it now/.test(s.out), s.out);
      assert.ok(!/Timelapse (\d{4}-\d\d-\d\d|paused|resumed)/.test(s.out), s.out);
      assert.deepStrictEqual(box.events('standby').map(e => e.ev).filter(ev => ev !== 'construct' && ev !== 'getCameras'), [],
        'not one camera call from the standby');
      assert.deepStrictEqual(box.events('main').filter(e => e.camera === 'Downstream Lot').map(e => e.ev), ['health', 'live']);
      assert.ok(!fs.existsSync(box.tlOut('standby')) || fs.readdirSync(box.tlOut('standby')).length === 0, 'nothing written on the standby');
      assert.ok(box.uploads().length >= 1 && box.uploads().every(u => u.pi === 'main'), JSON.stringify(box.uploads()));
      const st = await box.host.status();
      assert.deepStrictEqual([st.pis.main.state, st.pis.standby.state], ['capturing', 'standing-by']);
      assert.strictEqual(st.pis.main.conflict || st.pis.standby.conflict, false);
    } finally {
      box.cleanup();
    }
  }, 70000);

  test('end to end: the main Pi quiet for 20 minutes - the standby takes over and films the timelapse into its own folder, after its dock photo', async () => {
    const box = await twoPiBox();
    try {
      await seedMain(box, 20);
      const r = await box.run('standby', [], {}, { until: anyFrame, settleMs: 300, maxMs: 45000 });
      assert.ok(/The main Pi has not checked in for 20 min - this Pi is taking over the cameras/.test(r.out), r.out);
      const saved = /Timelapse (\d{4}-\d\d-\d\d) (\d\d):(\d\d): saved (\S+) - 1920x1080, \d+ KB, from live video/.exec(r.out);
      assert.ok(saved, r.out);
      assert.ok(fs.existsSync(path.join(box.tlOut('standby'), saved[1], saved[4])), 'in the standby\'s own folder');
      assert.ok(r.out.indexOf('Snapshot uploaded') < r.out.indexOf(': saved'), 'the dock photo first');
      assert.deepStrictEqual(box.uploads().map(u => [u.role, u.pi]), [['primary', 'standby']]);
      const probes = box.host.checkIns('standby').filter(c => c.json && c.json.probe === true);
      assert.strictEqual(probes.length, 1, 'the Worker asked again just before the live view');
      assert.deepStrictEqual(box.events('standby').filter(e => e.camera).map(e => [e.ev, e.camera]),
        [['snapshot', 'Dock Wired'], ['health', 'Downstream Lot'], ['live', 'Downstream Lot']]);
      assert.strictEqual(box.host.env.BUCKET.record('standby').state, 'capturing');
      assert.strictEqual(box.host.env.BUCKET.record('main').state, 'capturing', 'the probe recorded nothing');
      const notes = fs.readFileSync(path.join(box.tlOut('standby'), '.interval-log'), 'utf8');
      assert.strictEqual(notes, `${saved[1]} ${saved[2]}:${saved[3]} start\n${saved[1]} ${saved[2]}:${saved[3]} done\n`);
    } finally {
      box.cleanup();
    }
  }, 60000);

  test('end to end: the main Pi back between the standby\'s check and its live view - the Worker, asked again, says so: the camera is not woken', async () => {
    let box = null, back = false;
    box = await twoPiBox({ intercept: (e) => {
      // The main Pi checks in again just as the standby is about to film.
      if (!back && e.json && e.json.probe === true && e.json.pi === 'standby') { back = true; seedMain(box, 0); }
      return null;
    } });
    try {
      await seedMain(box, 20);
      const r = await box.run('standby', [], {}, { until: (o) => /Timelapse paused: /.test(o), settleMs: 500, maxMs: 30000 });
      assert.ok(back, 'the standby asked');
      assert.ok(/taking over the cameras/.test(r.out) && /Snapshot uploaded/.test(r.out), r.out);
      assert.ok(/Timelapse paused: the Worker does not confirm that the main Pi is still away \(it may be back\)\./.test(r.out), r.out);
      assert.ok(!box.events('standby').some(e => e.ev === 'live'), 'no live view');
      assert.ok(!fs.existsSync(path.join(box.tlOut('standby'), '.interval-log')), 'nothing started, nothing noted');
    } finally {
      box.cleanup();
    }
  }, 45000);

  test('end to end (clock x60): after the hand-back the standby\'s timelapse goes quiet - not even a battery reading', async () => {
    const box = await twoPiBox();
    try {
      await seedMain(box, 20);
      let returned = false, healthAtReturn = null;
      // The battery under 40%: the standby's timelapse reads it every 5 minutes while it has taken over, and films nothing.
      const r = await box.run('standby', [], { TEST_CLOCK_SPEED: '60', FAKE_BATTERY: '30' }, {
        until: (out) => {
          if (!returned && box.uploads().length >= 1 && /Timelapse paused/.test(out)) { returned = true; seedMain(box, 0); }
          if (healthAtReturn === null && /back to standing by/.test(out)) healthAtReturn = box.events('standby').filter(e => e.ev === 'health').length;
          return healthAtReturn !== null;
        },
        settleMs: 12000,                                  // a further simulated 12 minutes: two more 5-minute marks
        maxMs: 40000,
      });
      assert.ok(/taking over the cameras/.test(r.out) && /The main Pi is checking in again .* back to standing by/.test(r.out), r.out);
      assert.ok(/Timelapse paused: "Downstream Lot" battery at 30%/.test(r.out), r.out);
      assert.ok(healthAtReturn >= 1, String(healthAtReturn));
      assert.strictEqual(box.events('standby').filter(e => e.ev === 'health').length, healthAtReturn, 'no camera call after the hand-back');
      assert.ok(!box.events('standby').some(e => e.ev === 'live'));
      assert.strictEqual(box.host.env.BUCKET.record('standby').state, 'standing-by');
    } finally {
      box.cleanup();
    }
  }, 60000);

  test('end to end: the standby\'s timelapse test (SIGUSR2) works while it stands by - so it can be tried before it is needed', async () => {
    const box = await twoPiBox();
    try {
      await seedMain(box, 0);
      const r = await box.run('standby', [], {}, {
        onStart: (child, out) => { const iv = setInterval(() => {
          if (/Standing by: the main Pi checked in/.test(out()) && /Test it now with/.test(out())) { clearInterval(iv); child.kill('SIGUSR2'); } }, 100); },
        until: (o) => /Timelapse test: (saved|live video failed)/.test(o), settleMs: 300, maxMs: 45000 });
      assert.ok(/Timelapse test: saved \S+\.jpg - 1920x1080/.test(r.out), r.out);
      assert.strictEqual(fs.readdirSync(path.join(box.tlOut('standby'), 'tests')).filter(f => f.endsWith('.jpg')).length, 1);
      assert.deepStrictEqual(box.uploads(), [], 'no photo: it is standing by');
      assert.ok(!/Timelapse \d{4}-\d\d-\d\d/.test(r.out), 'and no timelapse frame');
    } finally {
      box.cleanup();
    }
  }, 60000);

  test('end to end: a timelapse camera name that cannot be settled never stops the standby taking over the dock photos', async () => {
    const box = await twoPiBox();
    try {
      await seedMain(box, 20);
      // "o" is in both cameras' names: ambiguous, refused rather than guessed.
      const r = await box.run('standby', [], { TIMELAPSE_CAMERA_NAME: 'o' }, { until: (o) => /Snapshot uploaded/.test(o), settleMs: 1500, maxMs: 20000 });
      assert.ok(/Timelapse: .*"o"/.test(r.out), r.out);
      assert.ok(/taking over the cameras/.test(r.out), r.out);
      assert.deepStrictEqual(box.uploads().map(u => [u.role, u.pi]), [['primary', 'standby']], 'the website still gets its photo');
      assert.ok(!box.events('standby').some(e => e.ev === 'live'), 'and no camera is guessed for the timelapse');
    } finally {
      box.cleanup();
    }
  }, 40000);

  test('end to end: the standby\'s --check says it films only while it has taken over', async () => {
    const box = await twoPiBox();
    const r = await box.run('standby', ['--check'], {}, {});
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(/this Pi {6}: the STANDBY/.test(r.out), r.out);
    assert.ok(/timelapse {4}: "Downstream Lot" every 5 min from 00:00 to 23:59 .*, while this standby has taken over; ffmpeg found/.test(r.out), r.out);
    assert.deepStrictEqual(box.events(), [], '--check makes no Ring call');
  });
} else {
  test('(two-Pi timelapse end-to-end tests skipped: ffmpeg is not installed here)', () => {});
}

// ═══════════════════════════════════════════════════════════════════════════
section('7. Security guards');
// ═══════════════════════════════════════════════════════════════════════════

test('the upload secret is never written to logs', () => {
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  // Logging the secret or the Ring token would leak them into journalctl,
  // which is world-readable on a default Raspberry Pi OS install.
  assert.ok(!/log\([^)]*uploadSecret/.test(src), 'uploadSecret appears in a log call');
  assert.ok(!/log\([^)]*newRefreshToken/.test(src), 'refresh token appears in a log call');
  assert.ok(!/console\.(log|error)\([^)]*readToken\(\)[^)]*\)/.test(src.replace(/\?\s*'present'[\s\S]*?'MISSING'/g, '')),
    'token value may be printed');
});

test('the Worker verifies JPEG magic bytes, not just the header', () => {
  const w = fs.readFileSync(path.join(__dirname, 'cloudflare_worker.js'), 'utf8');
  assert.ok(/looksLikeJpeg/.test(w), 'no magic-byte check present');
  assert.ok(/0xFF.*0xD8.*0xFF/.test(w), 'JPEG start-of-image marker not checked');
  assert.ok(/0xD9/.test(w), 'JPEG end-of-image marker not checked');
});

test('the Worker sets nosniff on served images', () => {
  const w = fs.readFileSync(path.join(__dirname, 'cloudflare_worker.js'), 'utf8');
  assert.ok(/X-Content-Type-Options.*nosniff/.test(w),
    'without nosniff a crafted upload could be sniffed as HTML and executed on our origin');
});

test('the Worker compares the secret in constant time', () => {
  const w = fs.readFileSync(path.join(__dirname, 'cloudflare_worker.js'), 'utf8');
  assert.ok(/timingSafeEqual/.test(w), 'no constant-time comparison');
  assert.ok(!/auth === expected|expected === auth/.test(w), 'naive string comparison found');
});

test('the Worker refuses to serve a stale frame', () => {
  const w = fs.readFileSync(path.join(__dirname, 'cloudflare_worker.js'), 'utf8');
  assert.ok(/MAX_AGE_MS/.test(w), 'no staleness cutoff');
  assert.ok(/status: 404/.test(w), 'stale frames should 404 so the site hides the card');
});

test('the ESM-only Ring package is imported, not required', () => {
  // ring-client-api v14+ ships as an ES module. require()ing it from this
  // CommonJS file throws ERR_REQUIRE_ESM at runtime — and because the tests stub
  // the Ring API entirely, only a real run on the Pi surfaced it.
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  assert.ok(!/require\(['"]ring-client-api['"]\)/.test(src),
    'ring-client-api must not be require()d — it is ESM-only');
  assert.ok(/await import\(['"]ring-client-api['"]\)/.test(src),
    'ring-client-api should be loaded with a dynamic import()');
});

test('the systemd unit in the repo keeps its protections, and is the one the README installs', () => {
  const unit = fs.readFileSync(path.join(__dirname, 'nhrc-camera.service'), 'utf8');
  for (const line of ['User=nhrccam', 'EnvironmentFile=/opt/nhrc-camera/env',
                      'ExecStart=/usr/local/bin/node /opt/nhrc-camera/snapshot_service.js', 'Restart=always',
                      'Environment=NODE_OPTIONS=--dns-result-order=ipv4first', 'MemoryMax=300M',
                      'NoNewPrivileges=true', 'PrivateTmp=true', 'PrivateDevices=true', 'ProtectSystem=strict', 'ProtectHome=true',
                      'ProtectKernelTunables=true', 'ProtectKernelModules=true', 'ProtectControlGroups=true',
                      'RestrictNamespaces=true', 'LockPersonality=true',
                      'RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK', 'ReadWritePaths=/opt/nhrc-camera',
                      // Pi-hole first, and the timelapse's recordings in memory.
                      'Nice=10', 'CPUWeight=20', 'OOMScoreAdjust=500',
                      'RuntimeDirectory=nhrc-camera', 'RuntimeDirectoryMode=0700']) {
    assert.ok(unit.split('\n').includes(line), `unit file is missing: ${line}`);
  }
  // Each setting once: a second RestrictAddressFamilies= line would widen the first.
  const keys = unit.split('\n').filter(l => /^[A-Za-z]+=/.test(l)).map(l => l.split('=')[0]);
  assert.deepStrictEqual(keys.filter((k, i) => keys.indexOf(k) !== i), [], 'no setting twice');
  assert.ok(!/AF_UNIX|AF_PACKET/.test(unit), 'no local or raw sockets');
  const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  assert.ok(readme.includes('main/camera/nhrc-camera.service'), 'the README installs the file from the repo');
  assert.ok(!/^\[Service\]$/m.test(readme), 'no second, drifting copy of the unit inside the README');
});

test('the memory cap, where a kernel enforces one, fits what a live view uses - and the README says Raspberry Pi OS does not enforce it', () => {
  const unit = fs.readFileSync(path.join(__dirname, 'nhrc-camera.service'), 'utf8');
  const cap = Number(/\nMemoryMax=(\d+)M\n/.exec(unit)[1]);
  // Node up to the size at which it restarts itself, ffmpeg (86 MB at most in the October tests), the recording in memory.
  const need = S.CONFIG.timelapse.maxRssMb + 90 + S.CLIP_MAX_MB;
  assert.ok(cap >= need, `${cap}M must hold ${need}M, or a live view would get the service killed mid-capture`);
  assert.ok(cap <= 320, 'and still leave a 427 MB Pi room for Pi-hole');
  assert.ok(/cgroup\.controllers/.test(unit), 'the unit says how to tell whether it applies');
  const md = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
  const sec = md.slice(md.indexOf('### Supply chain'), md.indexOf('### What this does NOT protect against'));
  assert.ok(/`MemoryMax` is not enforced on Raspberry Pi OS/.test(sec) && sec.includes('cat /sys/fs/cgroup/cgroup.controllers'), sec);
  assert.ok(!/200 MB memory cap|caps the service at 200 MB/.test(md), 'no cap claimed that does not apply');
});

test('a check-in never carries the token or the secret in its body', async () => {
  let body;
  await S.checkIn({ pi: 'main', ringId: S.ringIdentity(ringToken('hid-x')) }, baseCfg,
    async (url, opts) => { body = opts.body; return { ok: true, status: 200, json: async () => ({ ok: true }) }; });
  assert.ok(!body.includes(baseCfg.uploadSecret) && !body.includes('hid-x') && !body.includes(ringToken('hid-x')));
  const src = fs.readFileSync(path.join(__dirname, 'snapshot_service.js'), 'utf8');
  assert.ok(!/checkIn\(\{[^}]*readToken\(/.test(src), 'the token is never put in a check-in');
});

test('no address of the home network in anything published: the README, the code, the scripts, the website', () => {
  const files = ['README.md', 'snapshot_service.js', 'cloudflare_worker.js', 'timelapse_export.sh', 'timelapse_to_icloud.sh',
    'pi_health.sh', 'pi_check.sh', 'test_pi_check.js',
    'nhrc-camera.service', 'test_snapshot_service.js', path.join('..', 'index.html')];
  const lan = /\b(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/;
  for (const f of files) {
    const p = path.join(__dirname, f);
    if (!fs.existsSync(p)) continue;
    const m = lan.exec(fs.readFileSync(p, 'utf8'));
    assert.ok(!m, `${f}: ${m && m[0]}`);
  }
});

test('secrets and captures are gitignored', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  for (const pattern of ['camera/env', 'ring-token', '*.jpg']) {
    assert.ok(gi.includes(pattern), `.gitignore is missing ${pattern}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
asyncChain.then(async () => {
  // The Worker hosts the end-to-end tests served; left open they would keep
  // this process alive after the summary.
  await Promise.all(openHosts.map(h => h.close()));
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed${SHARD ? ` (shard ${SHARD[1]} of ${SHARD[2]})` : ''}${ONLY ? ` (only ${ONLY})` : ''}`);
  console.log('='.repeat(60));
  try { fs.unlinkSync(tmpToken); } catch (e) {}
  if (failed) {
    failures.forEach(([n, e]) => console.log(`  - ${n}: ${e.message}`));
    process.exit(1);
  }
  process.exit(0);
});
