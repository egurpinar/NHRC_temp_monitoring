#!/usr/bin/env node
/**
 * Tests for the new boathouse timelapse on the website - the Worker's side
 * (camera/cloudflare_worker.js: the frames the Pis send, the videos the builder
 * sends back, what everyone may read) and the Pi's (camera/snapshot_service.js:
 * sending each finished day's frames, TIMELAPSE_PUBLISH). The real Worker code,
 * with an in-memory R2 (scripts/worker_harness.js); the real service, in
 * process and as a process. No network.
 *
 * The builder - frames into a video - has its own suite: scripts/test_build_timelapse.js.
 *
 * Run: node camera/test_timelapse_web.js        (TEST_ONLY=<regex> runs some)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadWorker, memoryR2, serveWorker } = require('../scripts/worker_harness.js');

// The service reads its settings when loaded; these tests give it theirs.
process.env.TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-tlweb-'));
const S = require('./snapshot_service.js');

const ONLY = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
let passed = 0, failed = 0;
const failures = [];
const queue = [];
function test(name, fn, ms = 20000) { if (!ONLY || ONLY.test(name)) queue.push([name, fn, ms]); }
function section(title) { queue.push([title, null]); }
async function run() {
  for (const [name, fn, ms] of queue) {
    if (!fn) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); continue; }
    try {
      await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000} s`)), ms).unref())]);
      passed++; console.log(`  PASS  ${name}`);
    } catch (e) {
      failed++; failures.push([name, e]);
      console.log(`  FAIL  ${name}\n        ${String((e && e.message) || e).split('\n').slice(0, 12).join('\n        ')}`);
    }
  }
  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failed} failed${ONLY ? ` (only ${ONLY})` : ''}`);
  console.log('='.repeat(60));
  process.exitCode = failed ? 1 : 0;
}

const PI_SECRET = 'a'.repeat(64);
const BUILDER_SECRET = 'b'.repeat(64);
const HOST = 'https://nhrc-camera.example.workers.dev';
const env = (extra = {}) => Object.assign({ UPLOAD_SECRET: PI_SECRET, TIMELAPSE_SECRET: BUILDER_SECRET, BUCKET: memoryR2() }, extra);
const pi = (extra = {}) => Object.assign({ Authorization: `Bearer ${PI_SECRET}` }, extra);
const builder = (extra = {}) => Object.assign({ Authorization: `Bearer ${BUILDER_SECRET}` }, extra);

/** A small JPEG-shaped file: the start and end markers, n bytes in all. */
const jpeg = (n = 64, fill = 7) => { const b = Buffer.alloc(n, fill); b[0] = 0xFF; b[1] = 0xD8; b[2] = 0xFF; b[n - 2] = 0xFF; b[n - 1] = 0xD9; return b; };
/** An MP4-shaped file: a box size, then 'ftyp'. */
const mp4 = (n = 4096) => { const b = Buffer.alloc(n, 1); b.writeUInt32BE(32, 0); b.write('ftypisom', 4, 'latin1'); return b; };

/** The ET calendar day `n` days from today (by the calendar: a 25-hour day is still one day). */
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const etDay = (n = 0) => S.dayBefore(today(), -n);

let W = null;
const worker = async () => (W = W || await loadWorker());
async function call(e, method, p, { headers = {}, body } = {}) {
  const h = new Headers(headers);
  if (body !== undefined && !h.has('content-length')) h.set('content-length', String(Buffer.byteLength(body)));
  return (await worker()).fetch(new Request(`${HOST}${p}`, { method, headers: h, body }), e);
}
const putFrame = (e, day, hhmm, body = jpeg(), headers = pi({ 'Content-Type': 'image/jpeg', 'X-Camera-Pi': 'main' })) =>
  call(e, 'PUT', `/timelapse/frames/${day}/${hhmm}.jpg`, { headers, body });
const jsonOf = async (r) => JSON.parse(await r.text());

/** A valid index day for `day`. */
const indexDay = (day, extra = {}) => Object.assign({ date: day, video: `videos/${day}-0123456789ab.mp4`, poster: `posters/${day}-0123456789ab.jpg`,
  frames: 112, first: '06:35', last: '16:15', seconds: 11.2, bytes: 6000000, width: 1280, height: 720, set: 'abcdef012345' }, extra);

// ═══════════════════════════════════════════════════════════════════════════
section('1. The Worker: the frames the Pis send');
// ═══════════════════════════════════════════════════════════════════════════

test('a Pi sends a frame: kept under the day, with which Pi sent it - and the website\'s photo is not touched', async () => {
  const e = env();
  const day = etDay(-1);
  const r = await putFrame(e, day, '0705');
  assert.strictEqual(r.status, 200, await r.text());
  const o = e.BUCKET.stored(`timelapse/frames/${day}/0705.jpg`);
  assert.ok(o, e.BUCKET.keys().join(', '));
  assert.strictEqual(o.customMetadata.pi, 'main');
  assert.strictEqual(o.httpMetadata.contentType, 'image/jpeg');
  assert.strictEqual(e.BUCKET.stored('latest.jpg'), null, 'a frame never becomes the photo');
  // And the photo's own upload is as before.
  const photo = await call(e, 'PUT', '/latest.jpg', { headers: pi({ 'Content-Type': 'image/jpeg' }), body: jpeg() });
  assert.strictEqual(photo.status, 200);
  assert.ok(e.BUCKET.stored('latest.jpg'));
});

test('only the Pis\' secret may send frames - not the builder\'s, not none', async () => {
  const e = env();
  const day = etDay(-1);
  assert.strictEqual((await putFrame(e, day, '0705', jpeg(), { 'Content-Type': 'image/jpeg' })).status, 401);
  assert.strictEqual((await putFrame(e, day, '0705', jpeg(), builder({ 'Content-Type': 'image/jpeg' }))).status, 401);
  assert.strictEqual((await putFrame(e, day, '0705', jpeg(), { Authorization: 'Bearer wrong', 'Content-Type': 'image/jpeg' })).status, 401);
  assert.strictEqual((await putFrame(env({ UPLOAD_SECRET: undefined }), day, '0705')).status, 401, 'no secret on the Worker: nobody');
  assert.deepStrictEqual(e.BUCKET.keys(), []);
});

test('a frame must be a JPEG, not empty, not over 8 MB - and labelled as an image', async () => {
  const e = env();
  const day = etDay(-1);
  assert.strictEqual((await putFrame(e, day, '0705', Buffer.from('<html>not a picture</html>'))).status, 415);
  assert.strictEqual((await putFrame(e, day, '0710', Buffer.alloc(0))).status, 400);
  assert.strictEqual((await putFrame(e, day, '0715', jpeg(8 * 1024 * 1024 + 10))).status, 413);
  assert.strictEqual((await putFrame(e, day, '0720', jpeg(), pi({ 'Content-Type': 'text/html' }))).status, 415);
  assert.deepStrictEqual(e.BUCKET.keys(), []);
});

test('the day and time must be real, and the day recent: tomorrow at most, 40 days back at most', async () => {
  const e = env();
  assert.strictEqual((await putFrame(e, '2026-02-30', '0705')).status, 404, 'no such day: no such address');
  assert.strictEqual((await putFrame(e, etDay(-1), '2460')).status, 404);
  assert.strictEqual((await putFrame(e, etDay(-1), '0760')).status, 404);
  assert.strictEqual((await putFrame(e, etDay(-60), '0705')).status, 400);
  assert.strictEqual((await putFrame(e, etDay(5), '0705')).status, 400);
  assert.strictEqual((await putFrame(e, etDay(1), '0705')).status, 200, 'a Pi a little ahead of the clock');
  assert.strictEqual((await putFrame(e, etDay(-35), '0705')).status, 200);
});

test('a frame already there is kept: the main Pi\'s and the standby\'s never overwrite each other', async () => {
  const e = env();
  const day = etDay(-1);
  await putFrame(e, day, '1200', jpeg(100, 1));
  const r = await putFrame(e, day, '1200', jpeg(200, 2), pi({ 'Content-Type': 'image/jpeg', 'X-Camera-Pi': 'standby' }));
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await jsonOf(r)).kept, true);
  assert.strictEqual(e.BUCKET.bytes(`timelapse/frames/${day}/1200.jpg`).length, 100);
  assert.strictEqual(e.BUCKET.stored(`timelapse/frames/${day}/1200.jpg`).customMetadata.pi, 'main');
});

test('a Pi says it has sent all of a day\'s frames: done-main / done-standby, with the count and the Worker\'s time', async () => {
  const e = env();
  const day = etDay(-1);
  const send = (who, body, h = pi({ 'Content-Type': 'application/json' })) => call(e, 'PUT', `/timelapse/frames/${day}/done-${who}.json`, { headers: h, body });
  assert.strictEqual((await send('main', '{"frames": 112}')).status, 200);
  const rec = JSON.parse(e.BUCKET.bytes(`timelapse/frames/${day}/done-main.json`).toString());
  assert.strictEqual(rec.pi, 'main');
  assert.strictEqual(rec.frames, 112);
  assert.ok(Math.abs(Date.parse(rec.at) - Date.now()) < 5000);
  assert.strictEqual((await send('standby', '{"frames": 0}')).status, 200);
  assert.strictEqual((await send('main', 'not json')).status, 400);
  assert.strictEqual((await send('main', '{"frames": 1.5}')).status, 400);
  assert.strictEqual((await send('main', '{"frames": -1}')).status, 400);
  assert.strictEqual((await send('main', JSON.stringify({ frames: 1, pad: 'x'.repeat(2000) }))).status, 413);
  assert.strictEqual((await send('main', '{"frames": 1}', builder())).status, 401);
  assert.strictEqual((await send('other', '{"frames": 1}')).status, 404);
});

test('what the Worker has of a day: its frames in order with their sizes, and which Pis are done - to either secret, not to everyone', async () => {
  const e = env();
  const day = etDay(-1);
  for (const [t, n] of [['1610', 300], ['0705', 100], ['1200', 200]]) await putFrame(e, day, t, jpeg(n));
  await call(e, 'PUT', `/timelapse/frames/${day}/done-main.json`, { headers: pi(), body: '{"frames":3}' });
  for (const h of [pi(), builder()]) {
    const r = await call(e, 'GET', `/timelapse/frames/${day}/`, { headers: h });
    assert.strictEqual(r.status, 200);
    const d = await jsonOf(r);
    assert.deepStrictEqual(d.frames, [{ name: '0705.jpg', size: 100 }, { name: '1200.jpg', size: 200 }, { name: '1610.jpg', size: 300 }]);
    assert.strictEqual(d.done.main.frames, 3);
    assert.strictEqual(d.done.standby, null);
  }
  assert.strictEqual((await call(e, 'GET', `/timelapse/frames/${day}/`)).status, 401);
  const empty = await jsonOf(await call(e, 'GET', `/timelapse/frames/${etDay(-2)}/`, { headers: pi() }));
  assert.deepStrictEqual([empty.frames, empty.done], [[], { main: null, standby: null }]);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. The Worker: what only the builder may do');
// ═══════════════════════════════════════════════════════════════════════════

test('without TIMELAPSE_SECRET on the Worker, every builder route says so plainly (503) - and nothing is done', async () => {
  const e = env({ TIMELAPSE_SECRET: undefined });
  const day = etDay(-1);
  await putFrame(e, day, '0705');
  const before = e.BUCKET.keys();
  for (const [m, p, body] of [['GET', '/timelapse/frames/'], ['DELETE', `/timelapse/frames/${day}/`], ['PUT', '/timelapse/index.json', '{}'],
    ['PUT', `/timelapse/videos/${day}-0123456789ab.mp4`, mp4()], ['DELETE', `/timelapse/posters/${day}-0123456789ab.jpg`]]) {
    const r = await call(e, m, p, { headers: builder({ 'Content-Type': 'video/mp4' }), body });
    assert.strictEqual(r.status, 503, `${m} ${p}`);
    assert.ok(/TIMELAPSE_SECRET is not set/.test(await r.text()));
  }
  assert.deepStrictEqual(e.BUCKET.keys(), before);
  // The Pis' part goes on regardless: frames can wait there for the builder.
  assert.strictEqual((await call(e, 'GET', `/timelapse/frames/${day}/`, { headers: pi() })).status, 200);
});

test('a builder secret that is short, or the same as the Pis\', is refused as if there were none - said what is wrong', async () => {
  for (const [secret, why] of [['short-secret', /TIMELAPSE_SECRET is too short/], [PI_SECRET, /TIMELAPSE_SECRET must not be the same as UPLOAD_SECRET/]]) {
    const e = env({ TIMELAPSE_SECRET: secret });
    const day = etDay(-1);
    await putFrame(e, day, '0705');
    const r = await call(e, 'GET', '/timelapse/frames/', { headers: { Authorization: `Bearer ${secret}` } });
    assert.strictEqual(r.status, 503);
    assert.ok(why.test(await r.text()));
    // Nor can that secret read a frame, or a day as the builder.
    assert.strictEqual((await call(e, 'GET', `/timelapse/frames/${day}/0705.jpg`, { headers: { Authorization: `Bearer ${secret}` } })).status, 401);
    const put = await call(e, 'PUT', '/timelapse/index.json', { headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ days: [] }) });
    assert.strictEqual(put.status, 503);
    assert.strictEqual(e.BUCKET.stored('timelapse/index.json'), null);
  }
});

test('the builder\'s secret as pasted, with a line break or spaces around it, still works; the Pis\' secret sent by mistake is named', async () => {
  // "openssl rand -hex 32 | pbcopy" copies a line break too; a request's header never ends with one.
  for (const stored of [`${BUILDER_SECRET}\n`, ` ${BUILDER_SECRET} \r\n`, `\t${BUILDER_SECRET}`]) {
    const e = env({ TIMELAPSE_SECRET: stored });
    const r = await call(e, 'GET', '/timelapse/frames/', { headers: builder() });
    assert.strictEqual(r.status, 200, JSON.stringify(stored));
  }
  const e = env();
  // Another secret: refused, nothing said about it.
  let r = await call(e, 'GET', '/timelapse/frames/', { headers: { Authorization: `Bearer ${'c'.repeat(64)}` } });
  assert.deepStrictEqual([r.status, await r.text()], [401, 'Unauthorized']);
  // The Pis' secret on a builder route: said which one came - on every builder route.
  for (const [m, p] of [['GET', '/timelapse/frames/'], ['PUT', '/timelapse/index.json'], ['GET', `/timelapse/frames/${etDay(-1)}/0705.jpg`],
    ['DELETE', `/timelapse/frames/${etDay(-1)}/`], ['GET', `/timelapse/segments/${etDay(-1)}.mp4`]]) {
    r = await call(e, m, p, { headers: pi(), body: m === 'PUT' ? '{}' : undefined });
    assert.strictEqual(r.status, 401, `${m} ${p}`);
    assert.ok(/that is the Pis' UPLOAD_SECRET - the builder needs TIMELAPSE_SECRET/.test(await r.text()), `${m} ${p}`);
  }
  // The same secret as the Pis', but for a line break: still the same secret - refused as before.
  const same = env({ TIMELAPSE_SECRET: `${PI_SECRET}\n` });
  r = await call(same, 'GET', '/timelapse/frames/', { headers: pi() });
  assert.strictEqual(r.status, 503);
  assert.ok(/must not be the same as UPLOAD_SECRET/.test(await r.text()));
});

test('the days that have frames - for the builder only', async () => {
  const e = env();
  for (const d of [etDay(-3), etDay(-1), etDay(-2)]) await putFrame(e, d, '0705');
  await e.BUCKET.put('timelapse/frames/junk/0705.jpg', 'x');
  const r = await call(e, 'GET', '/timelapse/frames/', { headers: builder() });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await jsonOf(r)).days, [etDay(-3), etDay(-2), etDay(-1)]);
  assert.strictEqual((await call(e, 'GET', '/timelapse/frames/', { headers: pi() })).status, 401);
  assert.strictEqual((await call(e, 'GET', '/timelapse/frames/')).status, 401);
});

test('a frame is read by the builder only: the frames are never public', async () => {
  const e = env();
  const day = etDay(-1);
  await putFrame(e, day, '0705', jpeg(123));
  const r = await call(e, 'GET', `/timelapse/frames/${day}/0705.jpg`, { headers: builder() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.strictEqual(Buffer.from(await r.arrayBuffer()).length, 123);
  assert.strictEqual((await call(e, 'GET', `/timelapse/frames/${day}/0705.jpg`)).status, 401);
  assert.strictEqual((await call(e, 'GET', `/timelapse/frames/${day}/0705.jpg`, { headers: pi() })).status, 401);
  assert.strictEqual((await call(e, 'GET', `/timelapse/frames/${day}/0710.jpg`, { headers: builder() })).status, 404);
});

test('the builder deletes a day\'s frames and marks - that day only', async () => {
  const e = env();
  const [a, b] = [etDay(-2), etDay(-1)];
  for (const t of ['0705', '0710']) { await putFrame(e, a, t); await putFrame(e, b, t); }
  await call(e, 'PUT', `/timelapse/frames/${a}/done-main.json`, { headers: pi(), body: '{"frames":2}' });
  assert.strictEqual((await call(e, 'DELETE', `/timelapse/frames/${a}/`, { headers: pi() })).status, 401);
  const r = await call(e, 'DELETE', `/timelapse/frames/${a}/`, { headers: builder() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await jsonOf(r)).deleted, 3);
  assert.deepStrictEqual(e.BUCKET.keys(), [`timelapse/frames/${b}/0705.jpg`, `timelapse/frames/${b}/0710.jpg`]);
});

test('a video: straight to storage, then checked for an MP4\'s start - anything else is removed again', async () => {
  const e = env();
  const day = etDay(-1);
  const key = `/timelapse/videos/${day}-0123456789ab.mp4`;
  const put = (body, h = {}) => call(e, 'PUT', key, { headers: builder(Object.assign({ 'Content-Type': 'video/mp4' }, h)), body });
  assert.strictEqual((await put(mp4(5000))).status, 200);
  assert.strictEqual(e.BUCKET.stored(key.slice(1)).size, 5000);
  assert.strictEqual(e.BUCKET.stored(key.slice(1)).httpMetadata.contentType, 'video/mp4');
  const other = `/timelapse/videos/${day}-ba9876543210.mp4`;
  const r = await call(e, 'PUT', other, { headers: builder({ 'Content-Type': 'video/mp4' }), body: Buffer.from('<script>alert(1)</script>') });
  assert.strictEqual(r.status, 415);
  assert.strictEqual(e.BUCKET.stored(other.slice(1)), null, 'not kept');
  assert.strictEqual((await put(mp4(), { 'Content-Type': 'text/html' })).status, 415);
  assert.strictEqual((await put(mp4(), { 'Content-Length': String(96 * 1024 * 1024) })).status, 413);
  assert.strictEqual((await call(e, 'PUT', key, { headers: pi({ 'Content-Type': 'video/mp4' }), body: mp4() })).status, 401);
  assert.strictEqual((await call(e, 'PUT', `/timelapse/videos/${day}-XYZ.mp4`, { headers: builder({ 'Content-Type': 'video/mp4' }), body: mp4() })).status, 404);
  assert.strictEqual((await call(e, 'PUT', `/timelapse/videos/${day}-0123456789ab.jpg`, { headers: builder(), body: jpeg() })).status, 404);
  assert.strictEqual((await call(e, 'DELETE', key, { headers: builder() })).status, 200);
  assert.strictEqual(e.BUCKET.stored(key.slice(1)), null);
});

test('a video without a length is refused (411): storage needs to know it', async () => {
  const e = env();
  const req = new Request(`${HOST}/timelapse/videos/${etDay(-1)}-0123456789ab.mp4`, { method: 'PUT',
    headers: builder({ 'Content-Type': 'video/mp4' }), body: mp4() });
  assert.strictEqual(req.headers.get('content-length'), null);
  assert.strictEqual((await (await worker()).fetch(req, e)).status, 411);
});

test('a poster: a JPEG of 2 MB at most, from the builder', async () => {
  const e = env();
  const p = `/timelapse/posters/${etDay(-1)}-0123456789ab.jpg`;
  assert.strictEqual((await call(e, 'PUT', p, { headers: builder({ 'Content-Type': 'image/jpeg' }), body: jpeg(500) })).status, 200);
  assert.strictEqual((await call(e, 'PUT', p, { headers: builder(), body: Buffer.from('GIF89a') })).status, 415);
  assert.strictEqual((await call(e, 'PUT', p, { headers: builder(), body: jpeg(2 * 1024 * 1024 + 1) })).status, 413);
  assert.strictEqual((await call(e, 'PUT', p, { headers: pi(), body: jpeg() })).status, 401);
  assert.strictEqual(e.BUCKET.bytes(p.slice(1)).length, 500);
});

test('the index: kept only well formed, rebuilt from what is known, newest day first', async () => {
  const e = env();
  const [a, b] = [etDay(-2), etDay(-1)];
  const put = (obj, h = builder()) => call(e, 'PUT', '/timelapse/index.json', { headers: h, body: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  const r = await put({ days: [indexDay(a, { extra: '<script>' }), indexDay(b, { poster: null })], junk: 1 });
  assert.strictEqual(r.status, 200, await r.text());
  const stored = JSON.parse(e.BUCKET.bytes('timelapse/index.json').toString());
  assert.deepStrictEqual(stored.days.map((d) => d.date), [b, a]);
  assert.strictEqual(stored.days[1].extra, undefined, 'only the known fields');
  assert.strictEqual(stored.junk, undefined);
  assert.strictEqual(stored.days[0].poster, null);
  assert.ok(Date.parse(stored.updated) > 0);
  for (const bad of [
    'not json', '{}', { days: 'x' }, { days: [null] },
    { days: [indexDay('2026-02-30')] },
    { days: [indexDay(a, { video: `videos/${b}-0123456789ab.mp4` })] },
    { days: [indexDay(a, { video: `../latest.jpg` })] },
    { days: [indexDay(a, { poster: `posters/${a}-0123456789ab.png` })] },
    { days: [indexDay(a, { frames: 0 })] }, { days: [indexDay(a, { frames: 2.5 })] },
    { days: [indexDay(a, { first: '16:15', last: '06:35' })] }, { days: [indexDay(a, { first: '25:00' })] },
    { days: [indexDay(a, { seconds: 0 })] }, { days: [indexDay(a, { seconds: 'ten' })] },
    { days: [indexDay(a, { width: 1e6 })] }, { days: [indexDay(a, { set: 'NOT-HEX' })] },
    { days: [indexDay(a), indexDay(a)] },
  ]) {
    assert.strictEqual((await put(bad)).status, 400, JSON.stringify(bad).slice(0, 120));
  }
  assert.strictEqual((await put('x'.repeat(1024 * 1024 + 1))).status, 413);
  assert.strictEqual((await put({ days: [] }, pi())).status, 401);
  assert.deepStrictEqual(JSON.parse(e.BUCKET.bytes('timelapse/index.json').toString()).days.map((d) => d.date), [b, a], 'the good one stays');
});

test('each day\'s piece of the continuous timelapse: the builder\'s alone - kept, read back, deleted; never public, never the Pis\'', async () => {
  const e = env();
  const p = `/timelapse/segments/${etDay(-1)}.mp4`;
  const body = mp4(3000);
  assert.strictEqual((await call(e, 'PUT', p, { headers: pi({ 'Content-Type': 'video/mp4' }), body })).status, 401);
  assert.strictEqual((await call(e, 'PUT', p, { headers: builder({ 'Content-Type': 'video/mp4' }), body: Buffer.from('<html>') })).status, 415);
  assert.strictEqual((await call(e, 'PUT', p, { headers: builder({ 'Content-Type': 'video/mp4' }), body })).status, 200);
  for (const h of [{}, pi()]) {
    const r = await call(e, 'GET', p, { headers: h });
    assert.strictEqual(r.status, 401, 'not public, not the Pis\'');
  }
  const r = await call(e, 'GET', p, { headers: builder() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(body));
  assert.strictEqual((await call(e, 'GET', `/timelapse/segments/${etDay(-2)}.mp4`, { headers: builder() })).status, 404);
  assert.strictEqual((await call(e, 'GET', '/timelapse/segments/2026-02-30.mp4', { headers: builder() })).status, 404);
  assert.strictEqual((await call(e, 'DELETE', p, { headers: builder() })).status, 200);
  assert.strictEqual(e.BUCKET.stored(p.slice(1)), null);
});

test('the continuous timelapse\'s chunks: from the 1st, 11th or 21st only; made by the builder; public, in pieces (Range)', async () => {
  const e = env();
  const start = `${etDay(-1).slice(0, 8)}11`;
  const p = `/timelapse/whole/${start}-0123456789ab.mp4`;
  const body = mp4(8000);
  assert.strictEqual((await call(e, 'PUT', p, { headers: pi({ 'Content-Type': 'video/mp4' }), body })).status, 401);
  assert.strictEqual((await call(e, 'PUT', p, { headers: builder({ 'Content-Type': 'video/mp4' }), body })).status, 200);
  let r = await call(e, 'GET', p, { headers: { Range: 'bytes=0-99' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), 'bytes 0-99/8000');
  assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  for (const bad of [`/timelapse/whole/${start.slice(0, 8)}05-0123456789ab.mp4`, `/timelapse/whole/${start}-XYZ.mp4`, `/timelapse/whole/${start}.mp4`]) {
    r = await call(e, 'PUT', bad, { headers: builder({ 'Content-Type': 'video/mp4' }), body });
    assert.strictEqual(r.status, 404, bad);
  }
  assert.strictEqual((await call(e, 'DELETE', p, { headers: pi() })).status, 401);
  assert.strictEqual((await call(e, 'DELETE', p, { headers: builder() })).status, 200);
  assert.strictEqual((await call(e, 'GET', p)).status, 404);
});

test('the index\'s continuous timelapse: kept only when every part fits - its days in their chunk, its frames counted right', async () => {
  const e = env();
  const d = etDay(-1);
  const start = `${d.slice(0, 8)}${Number(d.slice(8)) <= 10 ? '01' : Number(d.slice(8)) <= 20 ? '11' : '21'}`;
  const chunk = (extra = {}) => Object.assign({ start, video: `whole/${start}-0123456789ab.mp4`, frames: 3, seconds: 0.3, bytes: 9000,
    days: [{ date: d, set: 'abcdef012345', times: '0700,0715,1200' }] }, extra);
  const tl = (extra = {}, c = [chunk()]) => Object.assign({ fps: 10, slotMinutes: 15, chunks: c }, extra);
  const put = (obj) => call(e, 'PUT', '/timelapse/index.json', { headers: builder(), body: JSON.stringify(obj) });
  const day = indexDay(d, { timeline: '0700,0715,1200' });
  let r = await put({ days: [day], timeline: tl() });
  assert.strictEqual(r.status, 200, await r.text());
  const stored = JSON.parse(e.BUCKET.bytes('timelapse/index.json').toString());
  assert.deepStrictEqual(stored.timeline, tl());
  assert.strictEqual(stored.days[0].timeline, '0700,0715,1200');
  const other = `${start.slice(0, 8)}${start.endsWith('01') ? '11' : '01'}`;
  for (const [why, obj] of [
    ['a day\'s times out of order', { days: [indexDay(d, { timeline: '0715,0700' })] }],
    ['a day\'s time twice', { days: [indexDay(d, { timeline: '0700,0700' })] }],
    ['a day\'s time not a time', { days: [indexDay(d, { timeline: '0760' })] }],
    ['a day\'s time past midnight', { days: [indexDay(d, { timeline: '2400' })] }],
    ['a day\'s times ending in a comma', { days: [indexDay(d, { timeline: '0700,' })] }],
    ['a day\'s times with a space', { days: [indexDay(d, { timeline: '0700, 0715' })] }],
    ['a day\'s times empty', { days: [indexDay(d, { timeline: '' })] }],
    ['a day\'s time of three digits', { days: [indexDay(d, { timeline: '700' })] }],
    ['a day with 97 times', { days: [indexDay(d, { timeline: Array.from({ length: 97 }, (_, i) => `${String(Math.floor(i * 5 / 60)).padStart(2, '0')}${String(i * 5 % 60).padStart(2, '0')}`).join(',') })] }],
    ['a day\'s times not a list', { days: [indexDay(d, { timeline: ['0700'] })] }],
    ['fps', { days: [day], timeline: tl({ fps: 0 }) }],
    ['a chunk not from the 1st, 11th or 21st', { days: [day], timeline: tl({}, [chunk({ start: `${start.slice(0, 8)}05`, video: `whole/${start.slice(0, 8)}05-0123456789ab.mp4` })]) }],
    ['another chunk\'s video', { days: [day], timeline: tl({}, [chunk({ video: `whole/${other}-0123456789ab.mp4` })]) }],
    ['a video elsewhere', { days: [day], timeline: tl({}, [chunk({ video: 'videos/../latest.jpg' })]) }],
    ['a day outside its chunk', { days: [day], timeline: tl({}, [chunk({ days: [{ date: dayOutside(start), set: 'abcdef012345', times: '0700,0715,1200' }] })]) }],
    ['frames miscounted', { days: [day], timeline: tl({}, [chunk({ frames: 4 })]) }],
    ['no days', { days: [day], timeline: tl({}, [chunk({ days: [] })]) }],
    ['a day twice', { days: [day], timeline: tl({}, [chunk({ frames: 6, days: [{ date: d, set: 'abcdef012345', times: '0700,0715,1200' }, { date: d, set: 'abcdef012345', times: '0700,0715,1200' }] })]) }],
    ['chunks out of order', { days: [day], timeline: tl({}, [chunk(), chunk()]) }],
    ['not an object', { days: [day], timeline: 'x' }],
  ]) {
    assert.strictEqual((await put(obj)).status, 400, why);
  }
  assert.deepStrictEqual(JSON.parse(e.BUCKET.bytes('timelapse/index.json').toString()).timeline, tl(), 'the good one stays');
  // Every quarter hour of a day - 96 times, the most there can be - is a day.
  const all = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}${String(i % 4 * 15).padStart(2, '0')}`).join(',');
  r = await put({ days: [indexDay(d, { timeline: all })], timeline: tl({}, [chunk({ frames: 96, days: [{ date: d, set: 'abcdef012345', times: all }] })]) });
  assert.strictEqual(r.status, 200, await r.text());
});

test('three years of days in the index: taken whole, checked quickly (a Worker on the free plan has 10 ms of CPU a request)', async () => {
  const days = [], chunks = new Map();
  const times = Array.from({ length: 60 }, (_, i) => { const m = 6 * 60 + i * 15; return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`; }).join(',');
  let t = Date.parse(`${etDay(-1)}T12:00:00Z`) - 1094 * 86400000;
  for (let i = 0; i < 1095; i++, t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    days.push(indexDay(date, { timeline: times }));
    const n = Number(date.slice(8, 10));
    const start = `${date.slice(0, 8)}${n <= 10 ? '01' : n <= 20 ? '11' : '21'}`;
    if (!chunks.has(start)) chunks.set(start, []);
    chunks.get(start).push({ date, set: 'abcdef012345', times });
  }
  const timeline = { fps: 10, slotMinutes: 15, chunks: [...chunks].map(([start, ds]) => ({ start, video: `whole/${start}-0123456789ab.mp4`,
    frames: ds.length * 60, seconds: ds.length * 6, bytes: 9000, days: ds })) };
  const body = JSON.stringify({ days: days.reverse(), timeline });
  assert.ok(body.length < 1024 * 1024 && body.length > 900 * 1024, `${body.length} bytes`);
  const e = env();
  await call(e, 'PUT', '/timelapse/index.json', { headers: builder(), body });   // once to warm up
  const t0 = process.hrtime.bigint();
  const r = await call(e, 'PUT', '/timelapse/index.json', { headers: builder(), body });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(r.status, 200, await r.text());
  assert.strictEqual(JSON.parse(e.BUCKET.bytes('timelapse/index.json').toString()).days.length, 1095);
  // Loose on purpose (machines differ): what it guards against is checking that grows out of hand.
  assert.ok(ms < 100, `${ms.toFixed(1)} ms`);
});
/** A day in another chunk than the one starting at `start`. */
const dayOutside = (start) => S.dayBefore(start, 1);

// ═══════════════════════════════════════════════════════════════════════════
section('3. The Worker: what everyone may read');
// ═══════════════════════════════════════════════════════════════════════════

async function withVideo(size = 10000) {
  const e = env();
  const day = etDay(-1);
  const p = `/timelapse/videos/${day}-0123456789ab.mp4`;
  const body = mp4(size);
  for (let i = 12; i < size; i++) body[i] = i % 251;
  await call(e, 'PUT', p, { headers: builder({ 'Content-Type': 'video/mp4' }), body });
  return { e, p, body };
}

test('the index, for the website and the email: JSON, any origin, cached 5 minutes; none yet is a 404 the page can read', async () => {
  const e = env();
  let r = await call(e, 'GET', '/timelapse/index.json');
  assert.strictEqual(r.status, 404);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  await call(e, 'PUT', '/timelapse/index.json', { headers: builder(), body: JSON.stringify({ days: [indexDay(etDay(-1))] }) });
  r = await call(e, 'GET', '/timelapse/index.json');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/json');
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
  assert.strictEqual(r.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual((await jsonOf(r)).days[0].date, etDay(-1));
});

test('a video, whole: video/mp4, kept by browsers for good (its name changes when it is made again), with an ETag', async () => {
  const { e, p, body } = await withVideo();
  const r = await call(e, 'GET', p);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'video/mp4');
  assert.strictEqual(r.headers.get('accept-ranges'), 'bytes');
  assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.ok(/^".+"$/.test(r.headers.get('etag')));
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(body));
  const again = await call(e, 'GET', p, { headers: { 'If-None-Match': r.headers.get('etag') } });
  assert.strictEqual(again.status, 304);
});

test('a video in pieces (Range) - what Safari and iPhones ask for first, or play nothing', async () => {
  const { e, p, body } = await withVideo(10000);
  const piece = async (range) => { const r = await call(e, 'GET', p, { headers: { Range: range } }); return { r, b: Buffer.from(await r.arrayBuffer()) }; };
  let { r, b } = await piece('bytes=0-1');
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), 'bytes 0-1/10000');
  assert.ok(b.equals(body.subarray(0, 2)));
  ({ r, b } = await piece('bytes=9000-'));
  assert.strictEqual(r.headers.get('content-range'), 'bytes 9000-9999/10000');
  assert.ok(b.equals(body.subarray(9000)));
  ({ r, b } = await piece('bytes=-100'));
  assert.strictEqual(r.headers.get('content-range'), 'bytes 9900-9999/10000');
  assert.ok(b.equals(body.subarray(9900)));
  ({ r, b } = await piece('bytes=5000-999999'));
  assert.strictEqual(r.headers.get('content-range'), 'bytes 5000-9999/10000', 'past the end: up to the end');
  ({ r } = await piece('bytes=10000-'));
  assert.strictEqual(r.status, 416);
  assert.strictEqual(r.headers.get('content-range'), 'bytes */10000');
  ({ r } = await piece('bytes=-0'));
  assert.strictEqual(r.status, 416);
  for (const ignored of ['bytes=5-2', 'bytes=0-1,5-6', 'items=0-1', 'bytes=-', 'nonsense']) {
    ({ r, b } = await piece(ignored));
    assert.strictEqual(r.status, 200, ignored);
    assert.strictEqual(b.length, 10000, `${ignored}: the whole file`);
  }
  const h = await call(e, 'HEAD', p);
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.headers.get('content-length'), '10000');
  assert.strictEqual(Buffer.from(await h.arrayBuffer()).length, 0);
});

test('a poster: image/jpeg, kept for good; a video or poster that is not there: 404', async () => {
  const e = env();
  const p = `/timelapse/posters/${etDay(-1)}-0123456789ab.jpg`;
  await call(e, 'PUT', p, { headers: builder(), body: jpeg(300) });
  const r = await call(e, 'GET', p);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.strictEqual((await call(e, 'GET', `/timelapse/posters/${etDay(-2)}-0123456789ab.jpg`)).status, 404);
  assert.strictEqual((await call(e, 'GET', `/timelapse/videos/${etDay(-2)}-0123456789ab.mp4`)).status, 404);
});

test('anything else under /timelapse/ is a 404 - never the website\'s photo; the photo\'s addresses are as before', async () => {
  const e = env();
  await call(e, 'PUT', '/latest.jpg', { headers: pi({ 'Content-Type': 'image/jpeg' }), body: jpeg(77) });
  for (const p of ['/timelapse/', '/timelapse/latest.jpg', '/timelapse/videos/', '/timelapse/x.mp4', '/timelapse/frames/2026-11-09',
    '/timelapse/frames/2026-11-09/0705.png', '/timelapse/index.json/']) {
    const r = await call(e, 'GET', p);
    assert.strictEqual(r.status, p === '/timelapse/frames/2026-11-09/0705.png' ? 404 : 404, p);
    assert.notStrictEqual(r.headers.get('content-type'), 'image/jpeg', `${p} served the photo`);
  }
  for (const p of ['/', '/latest.jpg', '/anything.jpg']) {
    const r = await call(e, 'GET', p);
    assert.strictEqual(r.status, 200, p);
    assert.strictEqual(Buffer.from(await r.arrayBuffer()).length, 77);
  }
  assert.strictEqual((await call(e, 'POST', '/timelapse/index.json', { body: '{}' })).status, 405);
});

test('a preflight for the public files says GET and Range from any origin', async () => {
  const r = await call(env(), 'OPTIONS', '/timelapse/index.json');
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  assert.ok(/GET/.test(r.headers.get('access-control-allow-methods')));
  assert.ok(/Range/.test(r.headers.get('access-control-allow-headers')));
});

test('storage trouble is a 503 - never a wrong answer', async () => {
  const e = env();
  e.BUCKET.failNext(1);
  assert.strictEqual((await call(e, 'GET', '/timelapse/index.json')).status, 503);
  e.BUCKET.failNext(1);
  assert.strictEqual((await call(e, 'GET', `/timelapse/frames/${etDay(-1)}/`, { headers: pi() })).status, 503);
  e.BUCKET.failNext(1);
  assert.strictEqual((await putFrame(e, etDay(-1), '0705')).status, 503);
});

test('/status says the newest day with a video, and how many there are', async () => {
  const e = env();
  await call(e, 'PUT', '/latest.jpg', { headers: pi({ 'Content-Type': 'image/jpeg' }), body: jpeg() });
  let st = await jsonOf(await call(e, 'GET', '/status'));
  assert.deepStrictEqual(st.timelapse, { latest: null, days: 0 });
  await call(e, 'PUT', '/timelapse/index.json', { headers: builder(), body: JSON.stringify({ days: [indexDay(etDay(-2)), indexDay(etDay(-1))] }) });
  st = await jsonOf(await call(e, 'GET', '/status'));
  assert.deepStrictEqual(st.timelapse, { latest: etDay(-1), days: 2 });
});

// ═══════════════════════════════════════════════════════════════════════════
section('4. The Pi: sending each finished day\'s frames (TIMELAPSE_PUBLISH)');
// ═══════════════════════════════════════════════════════════════════════════

test('TIMELAPSE_PUBLISH: 1/yes/true/on sends, 0/no/false/off and unset do not; anything else is a problem that stops only the sending', () => {
  const c = (publish, extra = {}) => ({ timelapse: Object.assign({ publish, everyMinutes: 5, times: [] }, extra) });
  for (const v of ['1', 'yes', 'TRUE', ' on ']) assert.ok(S.publishOn(c(v.trim().toLowerCase())), v);
  for (const v of ['', '0', 'no', 'false', 'off']) { assert.ok(!S.publishOn(c(v)), v); assert.deepStrictEqual(S.publishProblems(c(v)), []); }
  assert.ok(/TIMELAPSE_PUBLISH must be 1 .* or 0 .*; it is "maybe"/.test(S.publishProblems(c('maybe'))[0]));
  assert.ok(/works with TIMELAPSE_EVERY_MINUTES only/.test(S.publishProblems(c('1', { everyMinutes: 0, times: [{ minutes: 480, label: '08:00' }] }))[0]));
  assert.deepStrictEqual(S.timelapseProblems(Object.assign(c('maybe'), {})).filter((p) => /PUBLISH/.test(p)), [], 'never among the timelapse\'s own problems');
});

/** A Pi's timelapse folder, with frames of some days: { day: ['0705', ...] }. */
function piDir(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-pub-'));
  for (const [day, times] of Object.entries(days)) {
    fs.mkdirSync(path.join(dir, day), { recursive: true });
    for (const t of times) fs.writeFileSync(path.join(dir, day, `${day}_${t}.jpg`), jpeg(1000 + Number(t)));
  }
  return dir;
}
const piCfg = (dir, extra = {}) => ({ uploadUrl: `${HOST}/latest.jpg`, uploadSecret: PI_SECRET, pi: extra.pi || 'main', timeZone: 'America/New_York',
  // Filming 7:00-17:00 whatever the season: 6:00 is before it, 12:00 in it, 20:00 after it.
  timelapse: Object.assign({ dir, everyMinutes: 5, times: [], from: '7:00', until: '17:00', latitude: 41.437, longitude: -73.119,
    minMemoryMb: 40, publish: '1' }, extra.timelapse || {}) });
/** The slot at a local (ET) time on a day: '2026-11-09', '20:00'. */
const slotAt = (cfg, day, hm) => {
  const probe = new Date(`${day}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(probe)
    .find((p) => p.type === 'timeZoneName').value;   // "GMT-5"
  const h = Number(/GMT([+-]\d+)/.exec(offset)[1]);
  return S.intervalSlot(new Date(Date.parse(`${day}T${hm}:00Z`) - h * 3600000), cfg);
};
/** The real Worker, in process, as the Pi's fetch: every request noted. */
function workerFetch(e, log = []) {
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    const headers = new Headers(opts.headers || {});
    if (opts.body !== undefined && opts.body !== null) headers.set('content-length', String(Buffer.byteLength(opts.body)));
    log.push({ method: opts.method || 'GET', path: u.pathname, pi: headers.get('x-camera-pi') });
    return (await worker()).fetch(new Request(`${HOST}${u.pathname}`, { method: opts.method || 'GET', headers, body: opts.body }), e);
  };
  f.log = log;
  return f;
}
/**
 * The publisher, its clock at the start of whatever slot tickAt(day, '20:00')
 * gives it (2 s in, as the timelapse wakes), its log lines in `lines`.
 */
function publisher(cfg, e, extra = {}) {
  const lines = [];
  const fetch = extra.fetch || workerFetch(e);
  const clock = { t: Date.now() };
  const p = S.createPublisher(cfg, Object.assign({
    fetch, now: () => new Date(clock.t), availableMb: () => 300, pause: async (ms) => { clock.t += ms; },
    log: (m) => lines.push(`LOG ${m}`), logError: (m) => lines.push(`ERR ${m}`),
  }, extra.deps || {}));
  const tickAt = async (day, hm) => { const slot = slotAt(cfg, day, hm); clock.t = slot.start + 2000; await p.tick(slot); };
  return { p, lines, fetch, clock, tickAt };
}

// Days around today - the Worker takes frames of recent days only, and these
// tests also run with the clock moved (scripts/test_time_travel.js).
const DAY = etDay(0), PREV = etDay(-1), D2 = etDay(-2), OLD = etDay(-4);

test('during the filming hours nothing is sent - not even yesterday\'s; today\'s only once its last frame is taken', async () => {
  const dir = piDir({ [PREV]: ['0700', '0705'], [DAY]: ['0700', '0705'] });
  const cfg = piCfg(dir);
  const e = env();
  const { tickAt, fetch } = publisher(cfg, e);
  await tickAt(DAY, '12:00');
  assert.strictEqual(fetch.log.length, 0, 'in the window: nothing');
  await tickAt(DAY, '06:00');   // before filming: yesterday's, not today's
  assert.deepStrictEqual(fetch.log.filter((r) => r.method === 'PUT').map((r) => r.path),
    [`/timelapse/frames/${PREV}/0700.jpg`, `/timelapse/frames/${PREV}/0705.jpg`, `/timelapse/frames/${PREV}/done-main.json`]);
  fetch.log.length = 0;
  await tickAt(DAY, '20:00');   // after filming: today's
  assert.deepStrictEqual(fetch.log.filter((r) => r.method === 'PUT').map((r) => r.path),
    [`/timelapse/frames/${DAY}/0700.jpg`, `/timelapse/frames/${DAY}/0705.jpg`, `/timelapse/frames/${DAY}/done-main.json`]);
});

test('a finished day: each frame once, in order, saying which Pi - then "done", noted on disk; the next slot sends nothing', async () => {
  const dir = piDir({ [DAY]: ['1610', '0700', '1200'] });
  fs.writeFileSync(path.join(dir, DAY, `${DAY}_0705_snapshot.jpg`), jpeg());
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'tests', `${DAY}_120000.jpg`), jpeg());
  fs.writeFileSync(path.join(dir, DAY, `${PREV}_0800.jpg`), jpeg());     // another day's name: not this day's
  fs.writeFileSync(path.join(dir, DAY, 'notes.txt'), 'x');
  const cfg = piCfg(dir);
  const e = env();
  const { tickAt, lines, fetch } = publisher(cfg, e);
  await tickAt(DAY, '20:00');
  assert.deepStrictEqual(fetch.log.map((r) => `${r.method} ${r.path} ${r.pi}`), [
    `GET /timelapse/frames/${DAY}/ main`,
    `PUT /timelapse/frames/${DAY}/0700.jpg main`, `PUT /timelapse/frames/${DAY}/1200.jpg main`, `PUT /timelapse/frames/${DAY}/1610.jpg main`,
    `PUT /timelapse/frames/${DAY}/done-main.json main`]);
  assert.deepStrictEqual(e.BUCKET.keys().filter((k) => k.endsWith('.jpg')).map((k) => k.split('/').pop()), ['0700.jpg', '1200.jpg', '1610.jpg']);
  assert.ok(e.BUCKET.bytes(`timelapse/frames/${DAY}/1200.jpg`).equals(fs.readFileSync(path.join(dir, DAY, `${DAY}_1200.jpg`))));
  assert.strictEqual(JSON.parse(e.BUCKET.bytes(`timelapse/frames/${DAY}/done-main.json`).toString()).frames, 3);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.published'), 'utf8'), `${DAY}\n`);
  assert.ok(lines.some((l) => new RegExp(`^LOG Timelapse ${DAY}: sent to the website - 3 frames, [\\d.]+ MB, in \\d+ s\\.$`).test(l)), lines.join('\n'));
  fetch.log.length = 0;
  await tickAt(DAY, '20:05');
  assert.deepStrictEqual(fetch.log, [], 'already sent: not even a question');
  // The frames stay on the Pi, for the Mac's copy.
  assert.strictEqual(fs.readdirSync(path.join(dir, DAY)).filter((f) => /_\d{4}\.jpg$/.test(f)).length, 4);
});

test('frames the Worker has already are not sent again (a restart mid-day, the record lost)', async () => {
  const dir = piDir({ [DAY]: ['0700', '0705', '0710'] });
  const cfg = piCfg(dir);
  const e = env();
  await putFrame(e, DAY, '0705');
  const { tickAt, lines, fetch } = publisher(cfg, e);
  await tickAt(DAY, '20:00');
  assert.deepStrictEqual(fetch.log.filter((r) => /\.jpg$/.test(r.path)).map((r) => r.path.split('/').pop()), ['0700.jpg', '0710.jpg']);
  // All there already: said so, still marked done.
  fs.unlinkSync(path.join(dir, '.published'));
  fetch.log.length = 0;
  await tickAt(DAY, '20:05');
  assert.deepStrictEqual(fetch.log.map((r) => r.method), ['GET', 'PUT']);
  assert.ok(lines.some((l) => l === `LOG Timelapse ${DAY}: already on the website (3 frames).`), lines.join('\n'));
});

test('as on the Pi: the dock photo is taken 0.5 s into every slot and lasts a few seconds, the sender wakes 2 s in - it waits, then sends the whole day in that slot', async () => {
  // 115 frames, 7:00 to 16:30. The live Worker showed the dock photo done 3.3 s into its slot.
  const times = [];
  for (let m = 7 * 60; m <= 16 * 60 + 30; m += 5) times.push(`${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`);
  for (const dockMs of [3600, 9000]) {
    const dir = piDir({ [DAY]: times });
    const cfg = piCfg(dir);
    const e = env();
    const clock = { t: 0 };
    const busy = () => { const into = clock.t % 300000; return into >= 500 && into < dockMs; };
    const base = workerFetch(e);
    const during = [];
    const fetch = async (url, opts) => { if (busy()) during.push(url); clock.t += 300; return base(url, opts); };   // each request: 300 ms
    fetch.log = base.log;
    const lines = [];
    const p = S.createPublisher(cfg, { fetch, now: () => new Date(clock.t), availableMb: () => 300, dockBusy: busy,
      pause: async (ms) => { clock.t += ms; }, log: (m) => lines.push(m), logError: (m) => lines.push(`ERR ${m}`) });
    const slot = slotAt(cfg, DAY, '20:00');
    clock.t = slot.start + 2000;
    await p.tick(slot);
    assert.strictEqual(e.BUCKET.keys().filter((k) => k.endsWith('.jpg')).length, 115, `dock photo ${dockMs} ms: ${lines.join(' | ')}`);
    assert.ok(e.BUCKET.keys().some((k) => /done-main/.test(k)), 'and said so, in that slot');
    assert.deepStrictEqual(during, [], 'nothing sent while the dock photo was being taken');
    assert.ok(clock.t < slot.end - S.PUBLISH_SLOT_MARGIN_MS, 'done well before the next slot');
  }
});

test('a dock photo that outlasts the slot\'s time: it stops, and carries on at the next slot where it left off', async () => {
  const dir = piDir({ [DAY]: ['0700', '0705', '0710', '0715'] });
  const cfg = piCfg(dir);
  const e = env();
  let busy = false, sent = 0;
  const base = workerFetch(e);
  const fetch = async (url, opts) => { const r = await base(url, opts); if (opts && opts.method === 'PUT' && /\d{4}\.jpg$/.test(url) && ++sent === 2) busy = true; return r; };
  fetch.log = base.log;
  const { tickAt, clock } = publisher(cfg, e, { fetch, deps: { dockBusy: () => busy } });
  await tickAt(DAY, '20:00');
  assert.strictEqual(sent, 2);
  // It waits for the dock photo as long as this slot's sending may last: 4 minutes, and never into its last 15 s.
  const slot = slotAt(cfg, DAY, '20:00');
  const deadline = Math.min(slot.start + 2000 + S.PUBLISH_BUDGET_MS, slot.end - S.PUBLISH_SLOT_MARGIN_MS);
  assert.ok(clock.t <= deadline && clock.t >= deadline - 1000, `stopped waiting ${(deadline - clock.t) / 1000} s before its deadline`);
  assert.ok(!fs.existsSync(path.join(dir, '.published')), 'not done yet');
  assert.ok(!e.BUCKET.keys().some((k) => /done-/.test(k)));
  busy = false;
  await tickAt(DAY, '20:05');
  assert.strictEqual(sent, 4, 'the other two');
  assert.ok(e.BUCKET.keys().some((k) => /done-main/.test(k)));
});

test('memory short (under TIMELAPSE_MIN_MEMORY_MB + 20 MB): nothing read or sent until it is back', async () => {
  const dir = piDir({ [DAY]: ['0700', '0705'] });
  const cfg = piCfg(dir);
  const e = env();
  let mb = 59;
  const { tickAt, fetch, lines } = publisher(cfg, e, { deps: { availableMb: () => mb } });
  await tickAt(DAY, '20:00');
  assert.deepStrictEqual(fetch.log.map((r) => r.method), ['GET'], 'it asked, and sent nothing');
  // Said - not a silent night - and only hourly while it lasts.
  await tickAt(DAY, '20:05');
  await tickAt(DAY, '20:10');
  const said = lines.filter((l) => /not sending to the website yet - 59 MB of memory available, it waits for 60 MB/.test(l));
  assert.strictEqual(said.length, 1, lines.join('\n'));
  mb = 60;
  await tickAt(DAY, '20:15');
  assert.strictEqual(fetch.log.filter((r) => r.method === 'PUT').length, 3);
  // Where memory cannot be read (not Linux), it is not a reason to stop.
  const dir2 = piDir({ [DAY]: ['0700'] });
  const two = publisher(piCfg(dir2), env(), { deps: { availableMb: () => null } });
  await two.tickAt(DAY, '20:00');
  assert.strictEqual(two.fetch.log.filter((r) => r.method === 'PUT').length, 2);
});

test('it never runs into the next slot: it stops 15 s before it, and carries on at that slot', async () => {
  const times = Array.from({ length: 20 }, (_, i) => { const m = 7 * 60 + i * 5; return `${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`; });
  const dir = piDir({ [DAY]: times });
  const cfg = piCfg(dir);
  const slot = slotAt(cfg, DAY, '20:00');
  const e = env();
  let t = slot.start + 2000;
  const base = workerFetch(e);
  const fetch = async (url, opts) => { t += 30000; return base(url, opts); };   // each request: 30 s
  fetch.log = base.log;
  const { p } = publisher(cfg, e, { fetch, deps: { now: () => new Date(t) } });
  await p.tick(slot);
  const frames = () => e.BUCKET.keys().filter((k) => k.endsWith('.jpg')).length;
  const first = frames();
  assert.ok(first >= 7 && first <= 9, `${first} frames in the first slot`);
  assert.ok(t <= slot.end + 30000, 'the last request began before the margin');
  assert.ok(!e.BUCKET.keys().some((k) => /done-/.test(k)));
  t = slot.end + 2000;
  await p.tick(slotAt(cfg, DAY, '20:05'));
  t = slot.end + 300000 + 2000;
  await p.tick(slotAt(cfg, DAY, '20:10'));
  assert.strictEqual(frames(), 20);
  assert.ok(e.BUCKET.keys().some((k) => /done-main/.test(k)));
});

test('the Worker unreachable: said once with the reason, tried again 30 minutes later (not every slot), said hourly while it lasts, then that it works again', async () => {
  const dir = piDir({ [DAY]: ['0700'] });
  const cfg = piCfg(dir);
  const e = env();
  let down = true, t = 0;
  const base = workerFetch(e);
  const calls = [];
  const fetch = async (url, opts) => { calls.push(t); if (down) { const err = new TypeError('fetch failed'); err.cause = { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }; throw err; } return base(url, opts); };
  const { p, lines } = publisher(cfg, e, { fetch, deps: { now: () => new Date(t) } });
  t = slotAt(cfg, DAY, '19:00').start + 2000;
  const tick = () => p.tick(S.intervalSlot(new Date(t), cfg));
  for (let i = 0; i < 24; i++) { await tick(); t += 5 * 60000; }   // two hours of slots
  assert.strictEqual(calls.length, 4, `tried every 30 minutes: ${calls.length}`);
  const errs = lines.filter((l) => l.startsWith('ERR'));
  assert.strictEqual(errs.length, 2, errs.join('\n'));
  assert.ok(/could not send the frames to the website \(nhrc-camera\.example\.workers\.dev could not be reached \(fetch failed <- ENOTFOUND getaddrinfo ENOTFOUND\)\); trying again in 30 min\./.test(errs[0]), errs[0]);
  down = false;
  t += 30 * 60000;
  await tick();
  assert.ok(lines.some((l) => /^LOG Timelapse: sending to the website works again/.test(l)), lines.join('\n'));
  assert.ok(e.BUCKET.keys().some((k) => /done-main/.test(k)));
});

test('a Worker without the timelapse yet (404) or a refused secret (401): said what to do, nothing marked done', async () => {
  for (const [status, hint] of [[404, /does not take timelapse frames yet: update it/], [401, /the upload secret was refused/]]) {
    const dir = piDir({ [DAY]: ['0700'] });
    const cfg = piCfg(dir);
    const fetch = async () => ({ ok: false, status, text: async () => (status === 404 ? 'No snapshot yet' : 'Unauthorized') });
    const { tickAt, lines } = publisher(cfg, env(), { fetch });
    await tickAt(DAY, '20:00');
    assert.ok(lines.some((l) => /^ERR /.test(l) && hint.test(l)), lines.join('\n'));
    assert.ok(!fs.existsSync(path.join(dir, '.published')));
  }
});

test('an answer far larger than any the Worker gives is cut off at 256 KB, never held whole - a failure, tried again later', async () => {
  const dir = piDir({ [DAY]: ['0700'] });
  const cfg = piCfg(dir);
  let pulled = 0, cancelled = false;
  const fetch = async () => new Response(new ReadableStream({
    pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); },   // endless
    cancel() { cancelled = true; },
  }), { status: 200 });
  const { tickAt, lines, p } = publisher(cfg, env(), { fetch });
  await tickAt(DAY, '20:00');
  assert.ok(lines.some((l) => /^ERR Timelapse: could not send the frames to the website \(.*the Worker's answer is over 256 KB/.test(l)), lines.join('\n'));
  assert.ok(pulled <= 6, `${pulled} pieces of 64 KB read`);
  assert.ok(cancelled, 'the rest of it was refused');
  assert.ok(p.state().retryAt > 0, 'tried again later');
  assert.ok(!fs.existsSync(path.join(dir, '.published')));
});

test('what the Worker says goes into the journal as one line of plain text - no line breaks, no terminal codes', async () => {
  const dir = piDir({ [DAY]: ['0700'] });
  const cfg = piCfg(dir);
  const fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized\n2026-11-09T20:00:00.000Z - Snapshot uploaded\u001b[31m\r' });
  const { tickAt, lines } = publisher(cfg, env(), { fetch });
  await tickAt(DAY, '20:00');
  const err = lines.find((l) => l.startsWith('ERR '));
  assert.ok(err && /HTTP 401 \(Unauthorized 2026-11-09T20:00:00\.000Z - Snapshot uploaded \[31m\)/.test(err), err);
  assert.ok(!/[\n\r\u001b]/.test(err), JSON.stringify(err));
});

test('a damaged frame on the card, or one the Worker refuses, is left out - the rest still go, and the day is still done', async () => {
  const dir = piDir({ [DAY]: ['0700', '0705', '0710', '0715'] });
  fs.writeFileSync(path.join(dir, DAY, `${DAY}_0705.jpg`), Buffer.from('half a picture'));
  const cfg = piCfg(dir);
  const e = env();
  const base = workerFetch(e);
  const fetch = async (url, opts) => (/0710\.jpg$/.test(url) ? { ok: false, status: 413, text: async () => 'Too large' } : base(url, opts));
  fetch.log = base.log;
  const { tickAt, lines } = publisher(cfg, e, { fetch });
  await tickAt(DAY, '20:00');
  assert.deepStrictEqual(e.BUCKET.keys().filter((k) => k.endsWith('.jpg')).map((k) => k.split('/').pop()), ['0700.jpg', '0715.jpg']);
  assert.ok(e.BUCKET.keys().some((k) => /done-main/.test(k)));
  assert.ok(lines.some((l) => /sent to the website - 2 frames, .*; 2 damaged, not sent \(0705\.jpg, 0710\.jpg\)\.$/.test(l)), lines.join('\n'));
});

test('days more than 3 days old are not sent - said once; the days before yesterday still are', async () => {
  const dir = piDir({ [OLD]: ['0700'], [D2]: ['0700'], [PREV]: ['0700'] });
  const cfg = piCfg(dir);
  const e = env();
  const { tickAt, lines } = publisher(cfg, e);
  await tickAt(DAY, '06:00');
  await tickAt(DAY, '06:05');
  assert.deepStrictEqual(e.BUCKET.keys().filter((k) => k.endsWith('.jpg')), [`timelapse/frames/${D2}/0700.jpg`, `timelapse/frames/${PREV}/0700.jpg`]);
  assert.strictEqual(lines.filter((l) => l.includes(`Timelapse ${OLD}: not sent to the website - more than 3 days old now`)).length, 1);
  assert.ok(lines.some((l) => l.includes(`TIMELAPSE_PUBLISH_SINCE=${OLD} sends it`)), 'and how to send it after all');
});

test('without a catch-up, only the week before is said: the old days of months past are not listed at every restart', async () => {
  const [week, month] = [etDay(-9), etDay(-10)];
  const dir = piDir({ [week]: ['0700'], [month]: ['0700'], [etDay(-40)]: ['0700'] });
  const { tickAt, lines } = publisher(piCfg(dir), env());
  await tickAt(DAY, '06:00');
  assert.strictEqual(lines.filter((l) => / not sent to the website - more than 3 days old/.test(l)).length, 1, lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`LOG Timelapse ${week}:`)));
});

/** Days, each a folder of frames: the catch-up's days, at 0700 and 1200. */
const catchUpDir = (days) => piDir(Object.fromEntries(days.map((d) => [d, ['0700', '1200']])));

test('a one-time catch-up (TIMELAPSE_PUBLISH_SINCE): every finished day from it, oldest first, remembered - then said caught up, and nothing more', async () => {
  const days = [etDay(-20), etDay(-12), etDay(-6), PREV];
  const dir = catchUpDir(days.concat([DAY]));
  const cfg = piCfg(dir, { timelapse: { publishSince: days[0] } });
  const e = env();
  const { tickAt, lines, fetch } = publisher(cfg, e);
  await tickAt(DAY, '20:00');
  const dones = fetch.log.filter((r) => /done-main\.json$/.test(r.path)).map((r) => r.path.split('/')[3]);
  assert.deepStrictEqual(dones, days.concat([DAY]), 'oldest first, today\'s too once filmed');
  assert.strictEqual(e.BUCKET.keys().filter((k) => k.endsWith('.jpg')).length, 10);
  // Remembered back to the catch-up's first day (not only 10 days): never asked about again.
  assert.deepStrictEqual(fs.readFileSync(path.join(dir, '.published'), 'utf8').trim().split('\n'), days.concat([DAY]));
  assert.ok(lines.some((l) => l === `LOG Timelapse: caught up - every day from ${days[0]} is on the website (or on its way to it). `
    + 'The TIMELAPSE_PUBLISH_SINCE line can go now (camera/README.md).'), lines.join('\n'));
  fetch.log.length = 0;
  await tickAt(DAY, '20:05');
  await tickAt(DAY, '20:10');
  assert.deepStrictEqual(fetch.log, [], 'nothing more to ask');
  assert.strictEqual(lines.filter((l) => /caught up/.test(l)).length, 1, 'said once');
  // Days before the catch-up's first are not its business.
  const dir2 = catchUpDir([etDay(-25), etDay(-20)]);
  const two = publisher(piCfg(dir2, { timelapse: { publishSince: etDay(-20) } }), env());
  await two.tickAt(DAY, '06:00');
  assert.deepStrictEqual(two.fetch.log.filter((r) => /done-/.test(r.path)).map((r) => r.path.split('/')[3]), [etDay(-20)]);
  assert.ok(!two.lines.some((l) => l.includes(etDay(-25))), two.lines.join('\n'));
});

test('a catch-up reaching further back than the Worker takes (40 days): those days said once and left, the rest sent', async () => {
  const [tooOld, older, ok] = [etDay(-45), etDay(-41), etDay(-38)];
  const dir = catchUpDir([tooOld, older, ok, PREV]);
  const { tickAt, lines, fetch } = publisher(piCfg(dir, { timelapse: { publishSince: tooOld } }), env());
  await tickAt(DAY, '06:00');
  assert.deepStrictEqual(fetch.log.filter((r) => /done-/.test(r.path)).map((r) => r.path.split('/')[3]), [ok, PREV]);
  assert.ok(!fetch.log.some((r) => r.path.includes(tooOld) || r.path.includes(older)), 'not even asked about');
  for (const d of [tooOld, older]) {
    assert.strictEqual(lines.filter((l) => l === `LOG Timelapse ${d}: not sent to the website - older than the 40 days the Worker takes (its frames stay on this Pi).`).length, 1, lines.join('\n'));
  }
  await tickAt(DAY, '06:05');
  assert.strictEqual(lines.filter((l) => l.includes(tooOld)).length, 1, 'said once');
});

test('the set-time frames of the first days (beside the folders, YYYY-MM-DD_HHMM.jpg) go too - not their snapshots, not other files', async () => {
  const first = etDay(-25), both = etDay(-24);
  const dir = catchUpDir([both]);
  for (const name of [`${first}_0800.jpg`, `${first}_1200.jpg`, `${first}_1600_snapshot.jpg`, `${first}_notes.txt`, `${both}_1200.jpg`, `${both}_1500.jpg`]) {
    fs.writeFileSync(path.join(dir, name), jpeg(500));
  }
  const e = env();
  const { tickAt } = publisher(piCfg(dir, { timelapse: { publishSince: first } }), e);
  await tickAt(DAY, '06:00');
  const sent = (d) => e.BUCKET.keys().filter((k) => k.startsWith(`timelapse/frames/${d}/`) && k.endsWith('.jpg')).map((k) => k.split('/').pop());
  assert.deepStrictEqual(sent(first), ['0800.jpg', '1200.jpg']);
  // A day with both: the folder's frame where they share a time, and the other set time too.
  assert.deepStrictEqual(sent(both), ['0700.jpg', '1200.jpg', '1500.jpg']);
  assert.ok(e.BUCKET.bytes(`timelapse/frames/${both}/1200.jpg`).equals(fs.readFileSync(path.join(dir, both, `${both}_1200.jpg`))), 'the folder\'s');
});

test('a day the Worker will not take at all (400 for the day): said once and left - never tried again every 30 minutes', async () => {
  const dir = catchUpDir([D2]);
  const e = env();
  const base = workerFetch(e);
  const fetch = async (url, opts) => (/done-main\.json$/.test(url)
    ? new Response('Not a day the Pi can be sending frames for', { status: 400 }) : base(url, opts));
  fetch.log = base.log;
  const { tickAt, lines, p } = publisher(piCfg(dir), e, { fetch });
  await tickAt(DAY, '06:00');
  assert.ok(lines.some((l) => l === `LOG Timelapse ${D2}: not sent to the website - the Worker would not take it (Not a day the Pi can be sending frames for); its frames stay on this Pi.`), lines.join('\n'));
  assert.strictEqual(p.state().retryAt, 0, 'not a failure to try again');
  base.log.length = 0;
  await tickAt(DAY, '06:05');
  assert.deepStrictEqual(base.log, [], 'and not asked about again');
});

test('TIMELAPSE_PUBLISH_SINCE must be a real day: anything else is a problem that stops only the sending', () => {
  const cfg = (since) => piCfg('/tmp', { timelapse: { publishSince: since } });
  assert.deepStrictEqual(S.publishProblems(cfg('2026-10-14')), []);
  assert.deepStrictEqual(S.publishProblems(cfg('')), []);
  for (const bad of ['2026-02-30', '14/10/2026', 'yesterday', '2026-10-14T00:00']) {
    assert.ok(/TIMELAPSE_PUBLISH_SINCE must be a day like 2026-10-14/.test(S.publishProblems(cfg(bad)).join()), bad);
  }
  assert.strictEqual(S.PUBLISH_MAX_DAYS, 39, 'within the Worker\'s 40 days');
});

test('a day with no frames (every live view failed) is simply noted - no request', async () => {
  const dir = piDir({ [DAY]: [] });
  const cfg = piCfg(dir);
  const { tickAt, fetch } = publisher(cfg, env());
  await tickAt(DAY, '20:00');
  assert.deepStrictEqual(fetch.log, []);
  assert.strictEqual(fs.readFileSync(path.join(dir, '.published'), 'utf8'), `${DAY}\n`);
});

test('the record of days sent keeps the last 10 days only, and an unreadable one only means asking the Worker again', async () => {
  const dir = piDir({ [DAY]: ['0700'] });
  fs.writeFileSync(path.join(dir, '.published'), [etDay(-20), etDay(-10), etDay(-3), 'junk', ''].join('\n'));
  const cfg = piCfg(dir);
  const { tickAt } = publisher(cfg, env());
  await tickAt(DAY, '20:00');
  assert.strictEqual(fs.readFileSync(path.join(dir, '.published'), 'utf8'), `${etDay(-10)}\n${etDay(-3)}\n${DAY}\n`);
});

test('the standby sends what it filmed, as the standby - and the main Pi\'s frames and its own sit side by side', async () => {
  const e = env();
  const mainDir = piDir({ [DAY]: ['0700', '0705'] });
  const standbyDir = piDir({ [DAY]: ['1200', '1205'] });
  const m = publisher(piCfg(mainDir), e);
  const s = publisher(piCfg(standbyDir, { pi: 'standby' }), e);
  await m.tickAt(DAY, '20:00');
  await s.tickAt(DAY, '20:00');
  assert.ok(s.fetch.log.every((r) => r.pi === 'standby'));
  const day = await jsonOf(await call(e, 'GET', `/timelapse/frames/${DAY}/`, { headers: builder() }));
  assert.deepStrictEqual(day.frames.map((f) => f.name), ['0700.jpg', '0705.jpg', '1200.jpg', '1205.jpg']);
  assert.deepStrictEqual([day.done.main.frames, day.done.standby.frames], [2, 2]);
  assert.strictEqual(e.BUCKET.stored(`timelapse/frames/${DAY}/1200.jpg`).customMetadata.pi, 'standby');
});

test('it never throws, and never runs twice at once: a record that cannot be written is said, and tried again', async () => {
  const dir = piDir({ [DAY]: ['0700'] });
  const cfg = piCfg(dir);
  fs.mkdirSync(path.join(dir, '.published'));           // a folder where the record goes: it cannot be written
  const e = env();
  let release;
  const gate = new Promise((r) => { release = r; });
  const base = workerFetch(e);
  const fetch = async (url, opts) => { await gate; return base(url, opts); };
  const { p, lines, clock } = publisher(cfg, e, { fetch });
  const slot = slotAt(cfg, DAY, '20:00');
  clock.t = slot.start + 2000;
  const one = p.tick(slot);
  await p.tick(slot);                                    // while the first is still running: nothing
  release();
  await one;
  assert.ok(lines.some((l) => /^ERR Timelapse: could not send the frames to the website \(.*(EISDIR|illegal operation)/i.test(l)), lines.join('\n'));
  assert.strictEqual(p.state().running, false);
});

// ═══════════════════════════════════════════════════════════════════════════
section('5. End to end: the real service process sends a finished day to the real Worker');
// ═══════════════════════════════════════════════════════════════════════════

const CLOCK_ENV = Object.fromEntries(['NODE_OPTIONS', 'FAKE_OFFSET_MS', 'NO_NETWORK_LOG'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));

/** A box for the service: a stand-in Ring library, its fetch sent to a local real Worker. */
async function serviceBox() {
  const e = env();
  const host = await serveWorker({ env: e });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-pub-e2e-'));
  fs.copyFileSync(path.join(__dirname, 'snapshot_service.js'), path.join(dir, 'snapshot_service.js'));
  const pkg = path.join(dir, 'node_modules', 'ring-client-api');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'ring-client-api', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), `
    const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 0xFF, 0xD9]);
    export class RingApi {
      constructor() { this.onRefreshTokenUpdated = { subscribe() {} }; }
      async getCameras() { return ['Dock Wired', 'Downstream Lot'].map((name) => ({ name, async getSnapshot() { return JPEG; } })); }
      async fetchRingDevices() { return { allCameras: [] }; }
      disconnect() {}
    }`);
  fs.writeFileSync(path.join(dir, 'token'), 'stand-in-refresh-token');
  fs.writeFileSync(path.join(dir, 'fakefetch.js'), `
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const u = new URL(String(url));
      if (u.host !== 'nhrc-camera.example.workers.dev') throw new Error('test: no network access to ' + u.host);
      return realFetch('${host.url}' + u.pathname + u.search, opts);
    };`);
  const tl = path.join(dir, 'timelapse');
  // Stopped `settleMs` after until() first holds (or after maxMs).
  const run = (args, extraEnv = {}, { until = null, maxMs = 20000, settleMs = 0 } = {}) => new Promise((resolve) => {
    const child = require('child_process').spawn(process.execPath, ['-r', path.join(dir, 'fakefetch.js'), path.join(dir, 'snapshot_service.js'), ...args], {
      cwd: dir,
      env: Object.assign({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, RING_TOKEN_FILE: path.join(dir, 'token'),
        CAMERA_UPLOAD_URL: `${HOST}/latest.jpg`, CAMERA_UPLOAD_SECRET: PI_SECRET,
        RING_CAMERA_NAME: 'Dock Wired', RING_BACKUP_CAMERA_NAME: 'Downstream Lot', TIMELAPSE_DIR: tl,
        CAMERA_RETRIES: '1', CAMERA_RETRY_DELAY_SECONDS: '0' }, CLOCK_ENV, extraEnv),
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const started = Date.now();
    let seenAt = null;
    const poll = setInterval(() => {
      if (seenAt === null && until && until(out)) seenAt = Date.now();
      if ((seenAt !== null && Date.now() - seenAt >= settleMs) || Date.now() - started > maxMs) child.kill('SIGKILL');
    }, 50);
    child.on('exit', (code, signal) => { clearInterval(poll); resolve({ code, signal, out }); });
  });
  return { e, host, dir, tl, run, close: () => host.close() };
}

/** Local (ET) now: the day and minutes, and a filming window that is not now - ended, or still to come. */
function windowAwayFromNow() {
  const p = S.localDateParts(new Date(), { timeZone: 'America/New_York' });
  const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  // Ended half an hour ago (today's frames are due too), or - just after midnight - still to come today.
  return p.minutes >= 70 ? { day: p.date, from: hm(p.minutes - 60), until: hm(p.minutes - 30), todayDue: true }
    : { day: p.date, from: hm(p.minutes + 30), until: hm(p.minutes + 60), todayDue: false };
}

test('end to end: at start, outside the filming hours, the service sends yesterday\'s (and today\'s finished) frames to the Worker', async () => {
  const box = await serviceBox();
  try {
    const w = windowAwayFromNow();
    const yesterday = S.dayBefore(w.day);
    for (const [day, times] of [[yesterday, ['0700', '1200']], [w.day, ['0005', '0010']]]) {
      fs.mkdirSync(path.join(box.tl, day), { recursive: true });
      for (const t of times) fs.writeFileSync(path.join(box.tl, day, `${day}_${t}.jpg`), jpeg(2000));
    }
    const r = await box.run([], { TIMELAPSE_EVERY_MINUTES: '5', TIMELAPSE_FROM: w.from, TIMELAPSE_UNTIL: w.until, TIMELAPSE_PUBLISH: '1',
      FFMPEG_PATH: process.execPath },
      { until: (o) => new RegExp(`Timelapse ${w.todayDue ? w.day : yesterday}: sent to the website`).test(o), maxMs: 25000 });
    assert.ok(/Each evening after the last frame, the day's frames go to the website \(nhrc-camera\.example\.workers\.dev\) for its video\./.test(r.out), r.out);
    assert.ok(new RegExp(`Timelapse ${yesterday}: sent to the website - 2 frames`).test(r.out), r.out);
    const keys = box.e.BUCKET.keys();
    assert.ok(keys.includes(`timelapse/frames/${yesterday}/0700.jpg`) && keys.includes(`timelapse/frames/${yesterday}/done-main.json`), keys.join('\n'));
    assert.strictEqual(keys.includes(`timelapse/frames/${w.day}/0005.jpg`), w.todayDue, keys.join('\n'));
    assert.ok(keys.includes('latest.jpg'), 'the dock photo first, as ever');
    const order = box.host.requests.map((q) => `${q.method} ${q.path}`);
    assert.ok(order.indexOf('PUT /latest.jpg') < order.findIndex((q) => q.startsWith('PUT /timelapse/')), order.join('\n'));
  } finally { await box.close(); }
}, 40000);

test('end to end: --check says where the frames go; a bad TIMELAPSE_PUBLISH fails --check, and the running service films on without sending', async () => {
  const box = await serviceBox();
  try {
    const base = { TIMELAPSE_EVERY_MINUTES: '5', FFMPEG_PATH: process.execPath };
    let r = await box.run(['--check'], Object.assign({ TIMELAPSE_PUBLISH: '1' }, base));
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(/to website {3}: each evening after the last frame, the day's frames -> https:\/\/nhrc-camera\.example\.workers\.dev\/timelapse\/ \(TIMELAPSE_PUBLISH=1\)/.test(r.out), r.out);
    r = await box.run(['--check'], base);
    assert.strictEqual(r.code, 0, r.out);
    assert.ok(/to website {3}: off - the frames stay on this Pi/.test(r.out), r.out);
    r = await box.run(['--check'], Object.assign({ TIMELAPSE_PUBLISH: 'sometimes' }, base));
    assert.strictEqual(r.code, 1, r.out);
    assert.ok(/Timelapse publishing settings problems - the frames are NOT sent to the website until they are fixed \(the timelapse itself carries on\):\n {2}- TIMELAPSE_PUBLISH must be 1/.test(r.out), r.out);
    assert.ok(/to website {3}: NOT SENT - TIMELAPSE_PUBLISH has problems/.test(r.out), r.out);
    assert.ok(/Configuration looks valid/.test(r.out), 'the timelapse itself is fine');
    const w = windowAwayFromNow();
    const yesterday = S.dayBefore(w.day);
    fs.mkdirSync(path.join(box.tl, yesterday), { recursive: true });
    fs.writeFileSync(path.join(box.tl, yesterday, `${yesterday}_0700.jpg`), jpeg());
    r = await box.run([], Object.assign({ TIMELAPSE_PUBLISH: 'sometimes', TIMELAPSE_FROM: w.from, TIMELAPSE_UNTIL: w.until }, base),
      { until: (o) => /Snapshot uploaded/.test(o) && /Test it now/.test(o), settleMs: 2000, maxMs: 15000 });
    assert.ok(/Timelapse: "Downstream Lot" every 5 min/.test(r.out) && !/Each evening after the last frame/.test(r.out), r.out);
    assert.ok(!box.e.BUCKET.keys().some((k) => k.startsWith('timelapse/')), 'nothing sent');
  } finally { await box.close(); }
}, 60000);

test('end to end: without TIMELAPSE_PUBLISH the service sends nothing of the timelapse - exactly as before', async () => {
  const box = await serviceBox();
  try {
    const w = windowAwayFromNow();
    const yesterday = S.dayBefore(w.day);
    fs.mkdirSync(path.join(box.tl, yesterday), { recursive: true });
    fs.writeFileSync(path.join(box.tl, yesterday, `${yesterday}_0700.jpg`), jpeg());
    const r = await box.run([], { TIMELAPSE_EVERY_MINUTES: '5', TIMELAPSE_FROM: w.from, TIMELAPSE_UNTIL: w.until, FFMPEG_PATH: process.execPath },
      { until: (o) => /Snapshot uploaded/.test(o) && /Test it now/.test(o), settleMs: 2000, maxMs: 15000 });
    assert.ok(/Snapshot uploaded/.test(r.out), r.out);
    assert.ok(!box.host.requests.some((q) => q.path.startsWith('/timelapse/')), box.host.requests.map((q) => q.path).join('\n'));
    assert.ok(!fs.existsSync(path.join(box.tl, '.published')));
  } finally { await box.close(); }
}, 40000);

run();
