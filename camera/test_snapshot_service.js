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

let passed = 0, failed = 0;
const failures = [];
// Async tests run one after another, each with a deadline, and the summary
// waits for all of them. It used to wait a fixed 200 ms: a slow async test
// would report after the exit code had already been decided.
let asyncChain = Promise.resolve();
const ASYNC_DEADLINE_MS = 30000;

function test(name, fn) {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
    asyncChain = asyncChain.then(async () => {
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ASYNC_DEADLINE_MS} ms`)), ASYNC_DEADLINE_MS);
      });
      try { await Promise.race([fn(), deadline]); passed++; console.log(`  PASS  ${name}`); }
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
  assert.strictEqual(S.describeSchedule(dualCfg), 'Capturing every 5 min.');
  assert.strictEqual(S.describeWindow(dualCfg), 'around the clock');
  const b = S.backupConfig(dualCfg);
  assert.strictEqual(S.describeSchedule(b), 'Capturing every 30 min until 10:00, then every 60 min.');
  assert.strictEqual(S.describeWindow(b), '5:00-16:00 America/New_York');
  assert.strictEqual(dualCfg.backup.afterMisses, 6, 'six misses at 5 minutes: the half hour agreed for the switch');
  assert.deepStrictEqual(S.validateConfig(dualCfg), []);
});

test('a normal day: the dock camera every 5 minutes, the battery camera never woken', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 0, 0), ny(NEXT, 0, 0));
  assert.strictEqual(r.primary.length, 288, '288 dock captures');
  assert.strictEqual(r.backup.length, 0, 'the battery camera must sleep');
  assert.deepStrictEqual(r.primary.slice(0, 3).map(a => hhmm(a.at)), ['00:00', '00:05', '00:10']);
  assert.strictEqual(hhmm(r.primary[287].at), '23:55');
});

test('up to 25 minutes of missed dock captures does not wake the battery camera', async () => {
  // Five misses in a row (9:00 to 9:20), dock back at 9:25.
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 0), { primaryDown: between(9, 9 + 25 / 60) });
  assert.strictEqual(r.primary.filter(a => !a.ok).length, 5);
  assert.strictEqual(r.backup.length, 0);
});

test('six misses in a row (about half an hour): the backup takes over, on its own timetable', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 5), { primaryDown: between(9, 12) });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['09:25', '09:30', '10:00', '11:00'],
    'sixth miss at 9:25, then the 9:30 slot, then hourly after 10');
  assert.ok(r.primary.every(a => Number(nyClock(a.at).slice(3, 5)) % 5 === 0), 'the dock is still tried every 5 minutes');
  assert.ok(r.primary.filter(a => hhmm(a.at) === '12:00')[0].ok, 'and found again at 12:00');
});

test('the dock answering again sends the battery camera back to sleep', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 16, 0), { primaryDown: between(9, 10) });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['09:25', '09:30']);
});

test('the miss count starts again after the dock answers: later short outages do not wake the backup', async () => {
  // Down 9:00-9:34 (backup at 9:25 and 9:30), fine from 9:35, then five
  // misses from 11:00. Counted from scratch that is five, under the six.
  const down = (at) => between(9, 9 + 35 / 60)(at) || between(11, 11 + 25 / 60)(at);
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 0), { primaryDown: down });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['09:25', '09:30']);
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
  assert.strictEqual(r.primary.length, 288, 'the dock is still tried every slot');
});

test('a failed upload is not a camera outage: the battery camera is not woken', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 0), { uploadDown: () => true });
  assert.strictEqual(r.backup.length, 0, 'its frame would fail to upload the same way');
});

test('if the backup fails too, each of its slots is tried once - no retry storm on a battery', async () => {
  const r = await simulateDual(dualCfg, ny(DAY, 8, 0), ny(DAY, 12, 5),
    { primaryDown: () => true, backupDown: () => true });
  assert.deepStrictEqual(r.backup.map(a => hhmm(a.at)), ['08:25', '08:30', '09:00', '09:30', '10:00', '11:00', '12:00']);
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
  assert.strictEqual(S.describeTimetable(dualCfg), 'every 5 min, around the clock');
  assert.strictEqual(S.describeTimetable(S.backupConfig(dualCfg)),
    'every 30 min until 10:00, then every 60 min, 5:00-16:00 America/New_York');
});

// ═══════════════════════════════════════════════════════════════════════════
section('6c2. End to end: the real service process, a stand-in Ring library and network');
// ═══════════════════════════════════════════════════════════════════════════
//
// main() itself - argument handling, camera selection, the scheduler wiring
// and the upload headers - run as a separate process. A fake ring-client-api
// sits where npm would put the real one, and a preload replaces fetch, so
// nothing leaves the machine.

function e2eSandbox(cameras) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-cam-e2e-'));
  fs.copyFileSync(path.join(__dirname, 'snapshot_service.js'), path.join(dir, 'snapshot_service.js'));
  const pkg = path.join(dir, 'node_modules', 'ring-client-api');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'),
    JSON.stringify({ name: 'ring-client-api', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), `
    const cams = ${JSON.stringify(cameras)};
    const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0xFF, 0xD9]);
    export class RingApi {
      constructor(opts) { this.opts = opts; this.onRefreshTokenUpdated = { subscribe() {} }; }
      async getCameras() {
        return cams.map(c => ({ name: c.name, async getSnapshot() {
          if (c.down) throw new Error(c.name + ' is offline'); return JPEG; } }));
      }
    }`);
  fs.writeFileSync(path.join(dir, 'token'), 'stand-in-refresh-token');
  const uploads = path.join(dir, 'uploads.log');
  fs.writeFileSync(path.join(dir, 'fakefetch.js'), `
    const fs = require('fs');
    globalThis.fetch = async (url, opts) => {
      fs.appendFileSync(${JSON.stringify(uploads)}, JSON.stringify({ url, method: opts.method,
        role: opts.headers['X-Camera-Role'] || null, name: opts.headers['X-Camera-Name'] || null,
        bytes: opts.body.length }) + String.fromCharCode(10));
      return { ok: true, status: 200, text: async () => 'OK' };
    };`);
  const read = () => (fs.existsSync(uploads) ? fs.readFileSync(uploads, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []);
  // Runs the service; for the long-running mode, stops it once `stopAfter`
  // uploads have arrived (or after a few seconds).
  const run = (args, env, stopAfter = 0, settleMs = 0) => new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, ['-r', path.join(dir, 'fakefetch.js'), path.join(dir, 'snapshot_service.js'), ...args], {
      cwd: dir,
      env: Object.assign({ PATH: process.env.PATH, HOME: dir, RING_TOKEN_FILE: path.join(dir, 'token'),
        CAMERA_UPLOAD_URL: 'https://nhrc-camera.club-acct.workers.dev/latest.jpg', CAMERA_UPLOAD_SECRET: baseCfg.uploadSecret,
        RING_CAMERA_NAME: 'Dock Wired', RING_BACKUP_CAMERA_NAME: 'Downstream Lot',
        CAMERA_RETRIES: '1', CAMERA_RETRY_DELAY_SECONDS: '0' }, env),
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const started = Date.now();
    let seenAt = null;
    const poll = setInterval(() => {
      if (stopAfter && read().length >= stopAfter && seenAt === null) seenAt = Date.now();
      if ((seenAt !== null && Date.now() - seenAt >= settleMs) || Date.now() - started > 8000) child.kill();
    }, 50);
    child.on('exit', (code, signal) => { clearInterval(poll); resolve({ code, signal, out, uploads: read() }); });
  });
  const reset = () => { if (fs.existsSync(uploads)) fs.unlinkSync(uploads); };
  return { dir, run, reset };
}

test('end to end: --once and --once-backup upload from the right camera, with its role', async () => {
  const box = e2eSandbox([{ name: 'Front Door' }, { name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  let r = await box.run(['--once'], {});
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.uploads.map(u => [u.method, u.role, u.name]), [['PUT', 'primary', 'Dock Wired']]);
  assert.ok(/Cameras on this account: "Front Door", "Dock Wired", "Downstream Lot"/.test(r.out), r.out);
  box.reset();
  r = await box.run(['--once-backup'], {});
  assert.strictEqual(r.code, 0, r.out);
  assert.deepStrictEqual(r.uploads.map(u => [u.role, u.name]), [['backup', 'Downstream Lot']]);
});

test('end to end: the running service uploads the dock camera, and leaves the battery camera alone', async () => {
  const box = e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
  const r = await box.run([], {}, 1, 1500);
  assert.deepStrictEqual(r.uploads.map(u => u.role), ['primary'], r.out);
  assert.ok(/Primary camera: "Dock Wired" — every 5 min, around the clock/.test(r.out), r.out);
  assert.ok(/Backup camera: "Downstream Lot" — only after 6 missed primary captures in a row/.test(r.out));
});

test('end to end: with the dock camera down, the running service switches to the backup', async () => {
  const box = e2eSandbox([{ name: 'Dock Wired', down: true }, { name: 'Downstream Lot' }]);
  // One miss is enough here, and the backup window is opened all day, so the
  // test does not depend on the time it runs.
  const r = await box.run([], { BACKUP_AFTER_MISSES: '1', BACKUP_ACTIVE_START_HOUR: '0', BACKUP_ACTIVE_END_HOUR: '0',
                                BACKUP_SLOW_AFTER_HOUR: '0' }, 1, 300);
  assert.deepStrictEqual(r.uploads.map(u => [u.role, u.name]), [['backup', 'Downstream Lot']], r.out);
  assert.ok(/primary cycle failed: CAPTURE stage \(primary "Dock Wired"\)/.test(r.out), r.out);
  assert.ok(/using the backup on its own timetable/.test(r.out));
});

test('end to end: a missing backup only disables the fallback; missing cameras stop it with a list', async () => {
  let box = e2eSandbox([{ name: 'Dock Wired' }, { name: 'Garage' }]);
  let r = await box.run([], {}, 1, 300);
  assert.deepStrictEqual(r.uploads.map(u => u.role), ['primary']);
  assert.ok(/No camera matching RING_BACKUP_CAMERA_NAME "Downstream Lot".*Running without a backup/.test(r.out), r.out);
  box = e2eSandbox([{ name: 'Front Door' }, { name: 'Garage' }]);
  r = await box.run([], {});
  assert.strictEqual(r.code, 1);
  assert.ok(/No camera matching "Dock Wired" or "Downstream Lot"\. Available: "Front Door", "Garage"/.test(r.out), r.out);
  assert.strictEqual(r.uploads.length, 0);
  box = e2eSandbox([{ name: 'Dock Wired' }, { name: 'Downstream Lot' }]);
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
  const src = fs.readFileSync(path.join(__dirname, 'cloudflare_worker.js'), 'utf8');
  const tmp = path.join(os.tmpdir(), `nhrc-worker-${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  workerModule = (await import(require('url').pathToFileURL(tmp).href)).default;
  fs.unlinkSync(tmp);
  return workerModule;
}
function memoryR2() {
  let stored = null;
  return {
    async put(key, body, opts) {
      stored = { key, bytes: new Uint8Array(body), customMetadata: Object.assign({}, opts.customMetadata),
                 uploaded: new Date(), size: body.byteLength };
    },
    async get(key) { return stored && stored.key === key ? Object.assign({}, stored, { body: stored.bytes }) : null; },
    async head(key) { return stored && stored.key === key ? stored : null; },
    stored: () => stored,
  };
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

test('secrets and captures are gitignored', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  for (const pattern of ['camera/env', 'ring-token', '*.jpg']) {
    assert.ok(gi.includes(pattern), `.gitignore is missing ${pattern}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
asyncChain.then(async () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  try { fs.unlinkSync(tmpToken); } catch (e) {}
  if (failed) {
    failures.forEach(([n, e]) => console.log(`  - ${n}: ${e.message}`));
    process.exit(1);
  }
});
