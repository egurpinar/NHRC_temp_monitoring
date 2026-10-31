#!/usr/bin/env node
/**
 * Tests for the page on a phone with no signal: sw.js (the service worker) and
 * the web app manifest.
 *
 *  1. What is kept: the home page, its pictures, and the readings whose time
 *     the page shows - never forecasts, NWS alerts or the camera.
 *  2. Network first: a kept copy only when the network does not answer (or is
 *     too slow), stamped X-NHRC-Saved so the page can say so; an answer that
 *     is an error is passed on, not replaced.
 *  3. Pages: the home page kept and used offline; any other page never kept,
 *     so an old redirect page can never stand in for the home page.
 *  4. Install and activate: the shell kept up front, old copies dropped.
 *  5. The manifest and its icons.
 *
 * Run: node scripts/test_offline.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const SW = require('../sw.js');
const HERE = 'https://roworno.com';

let passed = 0, failed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function section(t) { queue.push([null, t]); }

// ── Stand-ins: the Cache API, the network, the service worker's global ──────

function fakeCaches() {
  const stores = new Map();
  const norm = (k) => (typeof k === 'string' ? new URL(k, HERE + '/').href : k.url);
  const api = {
    stores,
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        async put(k, res) { m.set(norm(k), { body: await res.arrayBuffer(), status: res.status, headers: [...res.headers] }); },
        async match(k) { const v = m.get(norm(k)); return v ? new Response(v.body.slice(0), { status: v.status, headers: v.headers }) : undefined; },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
  };
  return api;
}

/** A network: route(url, request) -> a Response, an Error (thrown), or a Promise of either. */
function fakeNet(route) {
  const calls = [];
  const fetch = async (input, init) => {
    const url = typeof input === 'string' ? new URL(input, HERE + '/').href : input.url;
    calls.push(url);
    const r = await route(url, input, init);
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

/** sw.js as a browser runs it: its listeners, on a stand-in global. */
function serviceWorker({ caches = fakeCaches(), fetch, timers } = {}) {
  const listeners = {};
  const self = { location: { origin: HERE }, addEventListener: (t, f) => { listeners[t] = f; },
    skipWaiting: () => { self.skipped = true; return Promise.resolve(); }, clients: { claim: () => { self.claimed = true; return Promise.resolve(); } } };
  const ctx = { self, caches, fetch, Response, Request, Headers, URL, console,
    setTimeout: timers ? timers.setTimeout : setTimeout, clearTimeout: timers ? timers.clearTimeout : clearTimeout };
  vm.runInNewContext(SRC, ctx);
  return { self, listeners, caches };
}

/** A fetch event: what respondWith was given (or null), and the waitUntil promises. */
function fetchEvent(sw, url, { method = 'GET', mode = 'cors' } = {}) {
  let responded = null;
  const request = { url, method, mode, clone() { return this; } };
  sw.listeners.fetch({ request, respondWith: (p) => { responded = Promise.resolve(p); } });
  return responded;
}

const json = (o, extra = {}) => new Response(JSON.stringify(o), { status: 200, headers: Object.assign({ 'Content-Type': 'application/json' }, extra) });
const offline = () => new TypeError('Failed to fetch');

// ═════════════════════════════════════════════════════════════════════════════
section('1. What is kept');

test('the readings whose time the page shows are kept, under their address without a cache-buster', () => {
  const k = (u) => SW.keyFor(u, HERE);
  assert.strictEqual(k(`${HERE}/data.json?_=1793461234567`), `${HERE}/data.json`);
  assert.strictEqual(k(`${HERE}/history.json?_=1`), `${HERE}/history.json`);
  assert.strictEqual(k(`${SW.WORKER}/water/latest.json`), `${SW.WORKER}/water/latest.json`);
  assert.strictEqual(k(`${SW.WORKER}/water/recent.json`), `${SW.WORKER}/water/recent.json`);
  assert.strictEqual(k('https://api.water.noaa.gov/nwps/v1/gauges/STVC3/stageflow/observed'), 'https://api.water.noaa.gov/nwps/v1/gauges/STVC3/stageflow/observed');
  assert.strictEqual(k('https://api.water.noaa.gov/nwps/v1/gauges/STVC3/stageflow/forecast'), 'https://api.water.noaa.gov/nwps/v1/gauges/STVC3/stageflow/forecast');
  assert.strictEqual(k('https://api.weather.gov/stations/KOXC/observations?limit=15'), 'https://api.weather.gov/stations/KOXC/observations');
  assert.strictEqual(k(`${HERE}/nhrc-logo-header.png`), `${HERE}/nhrc-logo-header.png`);
});

test('forecasts, NWS alerts, the camera, the map and libraries are never kept - an old one cannot be told from a current one', () => {
  for (const u of [
    'https://api.weather.gov/alerts/active?point=41.3685,-73.1478', 'https://api.weather.gov/points/41.3685,-73.1478',
    'https://api.weather.gov/gridpoints/OKX/58,76/forecast/hourly', 'https://api.weather.gov/stations/KBDR/observations',
    'https://api.open-meteo.com/v1/forecast?latitude=41.37', `${SW.WORKER}/latest.jpg`, `${SW.WORKER}/status`, `${SW.WORKER}/water/poll.json`,
    `${HERE}/map/wind-map.js?v=1`, `${HERE}/map/hazard-map.json`, `${HERE}/trial/`, `${HERE}/`, `${HERE}/index.html`, `${HERE}/sw.js`,
    'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js', 'https://evil.example/data.json', 'not a url',
  ]) assert.strictEqual(SW.keyFor(u, HERE), null, u);
});

// ═════════════════════════════════════════════════════════════════════════════
section('2. Network first');

test('a reading: the network\'s answer, and a copy kept with the time it was kept', async () => {
  const caches = fakeCaches();
  const net = fakeNet(() => json({ t: 1 }));
  const sw = serviceWorker({ caches, fetch: net.fetch });
  const res = await fetchEvent(sw, `${HERE}/data.json?_=5`);
  assert.deepStrictEqual(await res.json(), { t: 1 });
  assert.strictEqual(res.headers.get(SW.SAVED_HEADER), null, 'a fresh answer is not marked');
  await new Promise(r => setTimeout(r, 10));
  const kept = await (await caches.open(SW.CACHE)).match(`${HERE}/data.json`);
  assert.ok(kept && Number.isFinite(Date.parse(kept.headers.get(SW.SAVED_HEADER))));
  assert.deepStrictEqual(await kept.json(), { t: 1 });
});

test('no connection: the kept copy, marked X-NHRC-Saved; nothing kept: the error, as without it', async () => {
  const caches = fakeCaches();
  let up = true;
  const sw = serviceWorker({ caches, fetch: fakeNet(() => (up ? json({ v: 'kept' }) : offline())).fetch });
  await fetchEvent(sw, `${SW.WORKER}/water/latest.json`);
  await new Promise(r => setTimeout(r, 10));
  up = false;
  const res = await fetchEvent(sw, `${SW.WORKER}/water/latest.json`);
  assert.deepStrictEqual(await res.json(), { v: 'kept' });
  assert.ok(Date.parse(res.headers.get(SW.SAVED_HEADER)) <= Date.now());
  await assert.rejects(fetchEvent(sw, `${SW.WORKER}/water/recent.json`), /Failed to fetch/, 'never kept: the network\'s own error');
});

test('an answer that is an error (503, 404) is passed on as it is - never replaced by an old copy, never kept', async () => {
  const caches = fakeCaches();
  let answer = json({ v: 'good' });
  const sw = serviceWorker({ caches, fetch: fakeNet(() => answer).fetch });
  await fetchEvent(sw, `${HERE}/data.json?_=1`);
  await new Promise(r => setTimeout(r, 10));
  answer = new Response('busy', { status: 503 });
  const res = await fetchEvent(sw, `${HERE}/data.json?_=2`);
  assert.strictEqual(res.status, 503);
  await new Promise(r => setTimeout(r, 10));
  assert.deepStrictEqual(await (await (await caches.open(SW.CACHE)).match(`${HERE}/data.json`)).json(), { v: 'good' }, 'the good copy stays');
});

test('one bar of signal: past 7 s the kept copy - and the late answer is kept for next time', async () => {
  const caches = fakeCaches();
  let release = null;
  let slow = false;
  const net = fakeNet(() => (slow ? new Promise(r => { release = () => r(json({ v: 'late' })); }) : json({ v: 'first' })));
  const pending = [];
  const timers = { setTimeout: (f, ms) => { pending.push({ f, ms }); return pending.length; }, clearTimeout: () => {} };
  const sw = serviceWorker({ caches, fetch: net.fetch, timers });
  await fetchEvent(sw, `${HERE}/data.json`);
  await new Promise(r => setTimeout(r, 10));
  slow = true;
  const p = fetchEvent(sw, `${HERE}/data.json`);
  await new Promise(r => setTimeout(r, 10));
  const deadline = pending.filter(x => x.ms === SW.DATA_TIMEOUT_MS).pop();   // this request's, not the first one's
  assert.ok(deadline, 'a 7 s deadline');
  assert.strictEqual(SW.DATA_TIMEOUT_MS, 7000);
  deadline.f();
  const res = await p;
  assert.deepStrictEqual(await res.json(), { v: 'first' });
  assert.ok(res.headers.get(SW.SAVED_HEADER));
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.deepStrictEqual(await (await (await caches.open(SW.CACHE)).match(`${HERE}/data.json`)).json(), { v: 'late' });
});

test('forecasts and alerts go to the network as usual - the service worker does not answer them at all', () => {
  const sw = serviceWorker({ fetch: fakeNet(() => json({})).fetch });
  assert.strictEqual(fetchEvent(sw, 'https://api.weather.gov/alerts/active?point=41.3685,-73.1478'), null);
  assert.strictEqual(fetchEvent(sw, 'https://api.open-meteo.com/v1/forecast?x=1'), null);
  assert.strictEqual(fetchEvent(sw, `${SW.WORKER}/latest.jpg`), null);
  assert.strictEqual(fetchEvent(sw, `${HERE}/data.json`, { method: 'POST' }), null, 'only GET');
  assert.strictEqual(fetchEvent(sw, 'https://other.example/', { mode: 'navigate' }), null, 'another site\'s page');
  assert.doesNotThrow(() => sw.listeners.fetch({ request: null, respondWith() { throw new Error('no'); } }), 'a broken event changes nothing');
});

// ═════════════════════════════════════════════════════════════════════════════
section('3. Pages');

test('the home page: the network\'s, kept; with no connection the kept one; with none kept, a plain message', async () => {
  const caches = fakeCaches();
  let up = true;
  const page = () => new Response('<html>home v2</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  const sw = serviceWorker({ caches, fetch: fakeNet(() => (up ? page() : offline())).fetch });
  const empty = serviceWorker({ caches: fakeCaches(), fetch: fakeNet(() => offline()).fetch });
  const none = await fetchEvent(empty, `${HERE}/`, { mode: 'navigate' });
  assert.strictEqual(none.status, 503);
  assert.ok(/No connection, and this phone has no saved copy/.test(await none.text()));
  assert.strictEqual(await (await fetchEvent(sw, `${HERE}/?fresh=1`, { mode: 'navigate' })).text(), '<html>home v2</html>');
  await new Promise(r => setTimeout(r, 10));
  up = false;
  for (const u of [`${HERE}/`, `${HERE}/index.html`, `${HERE}/#river-map`]) {
    assert.strictEqual(await (await fetchEvent(sw, u, { mode: 'navigate' })).text(), '<html>home v2</html>', u);
  }
});

test('another page (the old trial address, a redirect) is never kept - and never stands in for the home page', async () => {
  const caches = fakeCaches();
  let up = true;
  const sw = serviceWorker({ caches, fetch: fakeNet((u) => (!up ? offline()
    : new Response(/trial/.test(u) ? '<meta http-equiv="refresh" content="0; url=../#river-map">' : '<html>home</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))).fetch });
  await fetchEvent(sw, `${HERE}/`, { mode: 'navigate' });
  await fetchEvent(sw, `${HERE}/trial/`, { mode: 'navigate' });
  await new Promise(r => setTimeout(r, 10));
  up = false;
  assert.strictEqual(await (await fetchEvent(sw, `${HERE}/`, { mode: 'navigate' })).text(), '<html>home</html>', 'the home page, not the redirect');
  assert.strictEqual((await fetchEvent(sw, `${HERE}/trial/`, { mode: 'navigate' })).status, 503);
});

// ═════════════════════════════════════════════════════════════════════════════
section('4. Install and activate');

test('install keeps the home page and its pictures; one that fails does not stop the rest; it takes over at once', async () => {
  const caches = fakeCaches();
  const net = fakeNet((u) => (/icon-192/.test(u) ? offline() : new Response('x', { status: 200 })));
  const sw = serviceWorker({ caches, fetch: net.fetch });
  let done;
  sw.listeners.install({ waitUntil: (p) => { done = p; } });
  await done;
  const store = caches.stores.get(SW.CACHE);
  assert.deepStrictEqual([...store.keys()].sort(), [`${HERE}/`, `${HERE}/favicon-32.png`, `${HERE}/manifest.webmanifest`, `${HERE}/nhrc-logo-header.png`]);
  assert.ok(sw.self.skipped);
  assert.deepStrictEqual(SW.SHELL.filter(p => p !== '/').map(p => fs.existsSync(path.join(ROOT, p.slice(1)))), [true, true, true, true], 'every file it keeps exists');
});

test('activate drops the copies an earlier version kept - and nothing else - and takes over the open pages', async () => {
  const caches = fakeCaches();
  await caches.open('nhrc-2026-10-01'); await caches.open(SW.CACHE); await caches.open('someone-else');
  const sw = serviceWorker({ caches, fetch: fakeNet(() => offline()).fetch });
  let done;
  sw.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepStrictEqual((await caches.keys()).sort(), [SW.CACHE, 'someone-else']);
  assert.ok(sw.self.claimed);
});

// ═════════════════════════════════════════════════════════════════════════════
section('5. The page and the manifest');

test('the page asks for the service worker only over https, after it has loaded, and never fails over it', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const main = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
  assert.ok(/window\.addEventListener\('load', \(\) => \{\s*try \{\s*if \(typeof navigator !== 'undefined' && navigator\.serviceWorker && typeof location !== 'undefined' && location\.protocol === 'https:'\) \{\s*navigator\.serviceWorker\.register\('sw\.js'\)\.catch/.test(main));
  assert.ok(/<link rel="manifest" href="manifest\.webmanifest"\/>/.test(html));
});

test('the manifest: name, start page, colours, and icons that exist at the sizes it gives', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(m.name, 'NHRC Rowing Conditions');
  assert.strictEqual(m.short_name, 'NHRC');
  assert.strictEqual(m.start_url, './');
  assert.strictEqual(m.display, 'standalone');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.strictEqual(m.theme_color, html.match(/<meta name="theme-color" content="([^"]+)"/)[1]);
  assert.ok(m.icons.some(i => i.purpose === 'maskable') && m.icons.some(i => i.sizes === '192x192'));
  for (const i of m.icons) {
    const png = fs.readFileSync(path.join(ROOT, i.src));
    const [w, h] = i.sizes.split('x').map(Number);
    assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [w, h], i.src);
    assert.ok(png.length < 40 * 1024, `${i.src}: ${png.length} bytes`);
  }
  assert.ok(!/safe|clear to row/i.test(JSON.stringify(m)));
});

test('the offline page never says it is safe or clear to row', () => {
  assert.ok(!/safe|clear to row|good to row/i.test(SRC.match(/const OFFLINE_PAGE = ([\s\S]*?);\n/)[1]));
});

// ── Run ─────────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of queue) {
    if (name === null) { console.log(`\n${fn}\n${'-'.repeat(fn.length)}`); continue; }
    // A test that never settles fails after 10 s, rather than ending the run in silence.
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out after 10 s')), 10000); });
    try { await Promise.race([fn(), deadline]); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${String(e && e.message).split('\n')[0]}`); }
    finally { clearTimeout(timer); }
  }
  console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failed} failed\n${'='.repeat(60)}`);
  if (failed) process.exit(1);
})();
