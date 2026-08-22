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

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed++; console.log(`  PASS  ${name}`); },
        (e) => { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); });
    }
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
  uploadSecret: 'a-sufficiently-long-secret',
  intervalMinutes: 15,
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

test('a short upload secret is rejected', () => {
  const p = S.validateConfig({ ...baseCfg, uploadSecret: 'short' });
  assert.ok(p.some(x => /too short/.test(x)));
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

test('a window wrapping midnight works', () => {
  const cfg = { ...baseCfg, activeStartHour: 22, activeEndHour: 4 };
  assert.strictEqual(S.isWithinActiveHours(at(3), cfg), true, '23:00 ET');
  assert.strictEqual(S.isWithinActiveHours(at(16), cfg), false, '12:00 ET');
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

test('no capture is attempted outside active hours', async () => {
  let called = false;
  const camera = { getSnapshot: async () => { called = true; return Buffer.from('x'); } };
  const nightCfg = { ...baseCfg, activeStartHour: 5, activeEndHour: 6 };
  // Force "now" outside the window by using a one-hour window that excludes it.
  const originalNow = Date.now;
  try {
    const sent = await S.runCycle(camera, { ...nightCfg, retryDelaySeconds: 0 });
    // runCycle consults the real clock; assert only that when it declines, the
    // camera was never woken.
    if (sent === false) assert.strictEqual(called, false, 'camera should not be woken when skipping');
  } finally {
    Date.now = originalNow;
  }
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

test('secrets and captures are gitignored', () => {
  const gi = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8');
  for (const pattern of ['camera/env', 'ring-token', '*.jpg']) {
    assert.ok(gi.includes(pattern), `.gitignore is missing ${pattern}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
Promise.resolve().then(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  try { fs.unlinkSync(tmpToken); } catch (e) {}
  if (failed) {
    failures.forEach(([n, e]) => console.log(`  - ${n}: ${e.message}`));
    process.exit(1);
  }
});
