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

function test(name, fn, deadlineMs = ASYNC_DEADLINE_MS) {
  if (fn.constructor && fn.constructor.name === 'AsyncFunction') {
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
  assert.ok(/Primary camera: "Dock Wired" — every 15 min, around the clock/.test(r.out), r.out);
  assert.ok(/Backup camera: "Downstream Lot" — only after 2 missed primary captures in a row/.test(r.out));
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
section('6e. Timelapse: full-resolution frames at set times, gentle on the Pi');
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
  timelapse: Object.assign({ times: S.parseTimeList('8:00,12:00,15:00'), cameraName: 'Downstream Lot', dir,
    ffmpegPath: '/usr/bin/ffmpeg', recordSeconds: 8, minDiskMb: 100, minMemoryMb: 40, snapshotPauseSeconds: 20 }, over),
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

test('the timelapse is OFF unless TIMELAPSE_TIMES is set, and its settings are validated', () => {
  assert.strictEqual(S.timelapseOn(S.CONFIG), false, 'off by default: installing the code changes nothing');
  assert.deepStrictEqual(S.validateConfig(tlCfg('/opt/nhrc-camera/timelapse')), []);
  const v = (over) => S.validateConfig(tlCfg('/opt/nhrc-camera/timelapse', over));
  assert.ok(v({ cameraName: '' }).some(p => /TIMELAPSE_CAMERA_NAME/.test(p)));
  for (const s of [3, 21, 7.5, NaN]) assert.ok(v({ recordSeconds: s }).some(p => /TIMELAPSE_RECORD_SECONDS/.test(p)), String(s));
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
    '[Service]\nNice=10\nCPUWeight=20\nOOMScoreAdjust=500\nRestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK\n');
  assert.ok(/\nRestrictAddressFamilies=AF_INET AF_INET6\n/.test(md), 'the unit allows these two; the drop-in adds netlink only');
  const times = /echo 'TIMELAPSE_TIMES=([^']+)' \| sudo tee -a \/opt\/nhrc-camera\/env/.exec(sec);
  assert.deepStrictEqual(S.parseTimeList(times[1]).map(t => t.label), ['08:00', '12:00', '15:00'], 'the times the member asked for');
  for (const [name, key] of [['TIMELAPSE_MIN_MEMORY_MB', 'minMemoryMb'], ['TIMELAPSE_MIN_DISK_MB', 'minDiskMb'], ['TIMELAPSE_RECORD_SECONDS', 'recordSeconds']]) {
    const row = new RegExp('\\| `' + name + '` \\| (\\d+) \\|').exec(sec);
    assert.ok(row && Number(row[1]) === S.CONFIG.timelapse[key], `${name} in the README table is the default`);
  }
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

// ── The real recording and decoding, with a real 1080p H.264 live stream ──
//
// The camera is stood in for by ffmpeg streaming a 1920x1080 test picture over
// RTP, through a relay that can lose packets, and the recording ffmpeg is
// started with the arguments ring-client-api builds around ours.

const dgram = require('dgram');
const { spawn: spawnProc } = require('child_process');
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
    this.sender = spawnProc('ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=15', '-t', '40',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-bf', '0', '-an',
      '-f', 'rtp', '-sdp_file', sdpFile, `rtp://127.0.0.1:${relayPort}`]);
    this.relay = dgram.createSocket('udp4'); this.out = dgram.createSocket('udp4');
    let start = null, i = 0;
    this.relay.on('message', (msg) => {
      i++;
      const t = start === null ? -1 : (Date.now() - start) / 1000;
      const nal = msg.length > 12 ? msg[12] & 0x1F : 0;   // H.264 NAL type, after the 12-byte RTP header
      const description = nal === 7 || nal === 8 || nal === 24;   // SPS, PPS, or both in one STAP-A
      const drop = (this.opts.loss === 'late' && t >= 5.5 && i % 2 === 0) || (this.opts.loss === 'random' && Math.random() < 0.15)
        || (this.opts.loss === 'sps' && description)
        || (this.opts.loss === 'spsUntilAsked' && description && !this.spsAllowed);
      if (!drop) { const seq = msg.readUInt16BE(2); this.rtpSubs.forEach(fn => fn({ header: { sequenceNumber: seq } })); }
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
    assert.ok(/clean$/.test(r.checked[0]), r.checked.join(', '));
    await new Promise(res => setTimeout(res, 300));
    const a = cam.calls[0].args.join(' ');
    assert.ok(/-f sdp -buffer_size 8388608 -i pipe: -an -vcodec copy -t 8 -f matroska -y \S+clip\.mkv$/.test(a), a);
    assert.strictEqual(process.env.FFREPORT, undefined, 'the ffmpeg report setting is put back');
    assert.strictEqual(ffmpegChildren(), 0, 'no ffmpeg left running');
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
    const pkg = path.join(dir, 'node_modules', 'ring-client-api');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ring-client-api', type: 'module',
      exports: { '.': './index.js', './util': './util.js' } }));
    // Like ring-client-api/util: the service hands it a logger.
    fs.writeFileSync(path.join(pkg, 'util.js'), 'export function useLogger(l) { globalThis.ringLogger = l; }');
    const ringLog = path.join(dir, 'ring.log');
    fs.writeFileSync(path.join(pkg, 'index.js'), `
      import fs from 'fs'; import dgram from 'dgram'; import { spawn } from 'child_process';
      const note = (o) => fs.appendFileSync(${JSON.stringify(ringLog)}, JSON.stringify(o) + String.fromCharCode(10));
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
          this.sender = spawn('ffmpeg', ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=15', '-t', '40',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '30', '-bf', '0', '-an', '-f', 'rtp', '-sdp_file', sdpFile, 'rtp://127.0.0.1:' + rp]);
          this.relay = dgram.createSocket('udp4'); this.out = dgram.createSocket('udp4');
          this.relay.on('message', (m) => { const nal = m[12] & 31;
            if (closing && (nal === 7 || nal === 8 || nal === 24)) return;
            const seq = m.readUInt16BE(2); this.subs.forEach(fn => fn({ header: { sequenceNumber: seq } }));
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
          return ['Dock Wired', 'Downstream Lot'].map(name => ({ name,
            async getSnapshot() { note({ ev: 'snapshot', camera: name }); return JPEG; },
            async startLiveCall() { note({ ev: 'live', camera: name });
              // Stands in for the service being killed mid-capture (for memory, say).
              if (process.env.FAKE_DIE_ON_LIVE) process.kill(process.pid, 'SIGKILL');
              return new Call(); } }));
        }
      }`);
    fs.writeFileSync(path.join(dir, 'token'), 'stand-in-refresh-token');
    const uploads = path.join(dir, 'uploads.log');
    fs.writeFileSync(path.join(dir, 'fakefetch.js'), `
      const fs = require('fs');
      globalThis.fetch = async (url, opts) => {
        fs.appendFileSync(${JSON.stringify(uploads)}, JSON.stringify({ role: opts.headers['X-Camera-Role'] || null }) + String.fromCharCode(10));
        return { ok: true, status: 200, text: async () => 'OK' };
      };`);
    const tlOut = path.join(dir, 'timelapse');
    const events = () => (fs.existsSync(ringLog) ? fs.readFileSync(ringLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);
    const run = (args, env, { until = null, maxMs = 40000, onStart = null } = {}) => new Promise((resolve) => {
      const { spawn: sp } = require('child_process');
      const child = sp(process.execPath, ['-r', path.join(dir, 'fakefetch.js'), path.join(dir, 'snapshot_service.js'), ...args], {
        cwd: dir,
        env: Object.assign({ PATH: process.env.PATH, HOME: dir, RING_TOKEN_FILE: path.join(dir, 'token'),
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
    return { dir, tlOut, run, events, nowLabel, uploads: () => (fs.existsSync(uploads) ? fs.readFileSync(uploads, 'utf8').split('\n').filter(Boolean).length : 0) };
  }

  test('end to end: the running service saves a 1920x1080 frame at its time, right after the dock photo', async () => {
    const box = timelapseSandbox();
    const now = box.nowLabel();
    const r = await box.run([], { TIMELAPSE_TIMES: now.label, TIMELAPSE_RECORD_SECONDS: '4' }, { until: (o) => /Timelapse \S+ \S+: (saved|live video failed)|Timelapse.*: no camera/.test(o) });
    assert.ok(/Timelapse: "Downstream Lot" at \d\d:\d\d -> \S+timelapse \(a frame from the end of 4 s of live video; the snapshot if that fails; keeps 40 MB of memory for Pi-hole and 500 MB of disk free\)\. Test it now with: sudo kill -USR2 \d+/.test(r.out), r.out);
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
    assert.ok(/Timelapse test requested, but the timelapse is off \(TIMELAPSE_TIMES is not set\)\./.test(r.out), r.out);
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

  test('end to end: --check describes the timelapse; a bad time stops it before it starts', async () => {
    const box = timelapseSandbox();
    let r = await box.run(['--check'], { TIMELAPSE_TIMES: '8:00,12:00,15:00' });
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(/timelapse {4}: "Downstream Lot" at 08:00, 12:00, 15:00 -> \S+ \(a frame from the end of 20 s of live video; the snapshot if that fails; keeps 40 MB of memory for Pi-hole and 500 MB of disk free\); ffmpeg found/.test(r.out), r.out);
    r = await box.run(['--check'], {});
    assert.ok(/timelapse {4}: off/.test(r.out), r.out);
    r = await box.run([], { TIMELAPSE_TIMES: '8:00,noon' });
    assert.strictEqual(r.code, 1);
    assert.ok(/TIMELAPSE_TIMES: "noon" is not a time/.test(r.out), r.out);
  });

  test('end to end: with the timelapse off, the service is exactly as before - no ffmpeg, no live view', async () => {
    const box = timelapseSandbox();
    const r = await box.run([], {}, { until: (o) => /Snapshot uploaded/.test(o), maxMs: 10000 });
    assert.ok(!/Timelapse/.test(r.out), r.out);
    const ev = box.events();
    assert.strictEqual(ev.find(e => e.ev === 'construct').ffmpegPath, null, 'RingApi built exactly as before');
    assert.ok(!ev.some(e => e.ev === 'live'));
  });
} else {
  test('(real ffmpeg tests skipped: ffmpeg is not installed here)', () => {});
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
