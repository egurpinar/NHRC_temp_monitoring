/* roworno.com on a phone with no signal.
 *
 * Network first, always: a request goes to the network, and only when the
 * network does not answer is a kept copy used. Kept, each time they load:
 *   - the page itself (the home page only) and its pictures, so it opens with
 *     no signal;
 *   - the readings whose time the page shows beside them - the water sensor
 *     (data.json, history.json, the Worker's /water/ files), the river gauge
 *     and the airport's observations - so an old one reads as old.
 * A kept reading comes back with X-NHRC-Saved (when it was kept), and the page
 * says it is showing what this phone saved, and from when. Forecasts, NWS
 * alerts and the camera are never kept: an old forecast or alert list cannot
 * be told from a current one.
 *
 * Changing VERSION drops every kept copy at the next visit. To switch this off
 * for everyone, replace this file with one that unregisters itself (see
 * scripts/README.md, "On a phone with no signal").
 */
'use strict';

const VERSION = '2026-11-01';
const CACHE = `nhrc-${VERSION}`;
// The home page and the pictures it shows before any data.
const SHELL = ['/', '/nhrc-logo-header.png', '/favicon-32.png', '/icon-192.png', '/manifest.webmanifest'];
const PAGE_TIMEOUT_MS = 8000;     // a page with one bar of signal: the kept copy after this
const DATA_TIMEOUT_MS = 7000;     // a reading: just inside the page's own 8 s for the Worker
const SAVED_HEADER = 'X-NHRC-Saved';
const WORKER = 'https://nhrc-camera.gurpinar-emre.workers.dev';

/**
 * The key a reading or a picture of the page is kept under - its address
 * without a cache-buster - or null for anything that is not kept.
 */
function keyFor(url, here) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  if (u.origin === here) {
    if (/^\/(data|history)\.json$/.test(u.pathname)) return u.origin + u.pathname;
    return SHELL.includes(u.pathname) && u.pathname !== '/' ? u.origin + u.pathname : null;
  }
  if (u.origin === WORKER) return /^\/water\/(latest|recent)\.json$/.test(u.pathname) ? u.origin + u.pathname : null;
  if (u.origin === 'https://api.water.noaa.gov') {
    return /^\/nwps\/v1\/gauges\/STVC3\/stageflow\/(observed|forecast)$/.test(u.pathname) ? u.origin + u.pathname : null;
  }
  if (u.origin === 'https://api.weather.gov') {
    return /^\/stations\/KOXC\/observations$/.test(u.pathname) ? u.origin + u.pathname : null;
  }
  return null;
}

/** Whether a navigation is to the home page: the only page kept. */
function isHome(url, here) {
  try { const u = new URL(url); return u.origin === here && /^\/(index\.html)?$/.test(u.pathname); } catch (e) { return false; }
}

/** A promise that gives up after ms (rejects), without stopping the original. */
function within(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * Keeps a copy of a good answer, stamped with when it was kept. The copy is
 * taken at once, before the page reads the answer. Never throws.
 */
function keep(key, res) {
  try {
    if (!res || !res.ok) return Promise.resolve();
    const copy = res.clone();
    return (async () => {
      try {
        const body = await copy.arrayBuffer();
        const headers = new Headers(copy.headers);
        headers.set(SAVED_HEADER, new Date().toISOString());
        const cache = await caches.open(CACHE);
        await cache.put(key, new Response(body, { status: 200, statusText: 'OK', headers }));
      } catch (e) { /* the network's answer is what matters */ }
    })();
  } catch (e) { return Promise.resolve(); }
}

async function kept(key) {
  try { const c = await caches.open(CACHE); return (await c.match(key)) || null; } catch (e) { return null; }
}

const OFFLINE_PAGE = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<title>NHRC Rowing Conditions</title><p style="font:16px sans-serif;padding:24px">No connection, and this phone has no '
  + 'saved copy of this page yet. Try again when you have a signal.</p>';

/** A page: the network's - the home page kept for next time; the kept home page when there is no answer. */
async function page(request, here) {
  const home = isHome(request.url, here);
  try {
    const res = await within(fetch(request), PAGE_TIMEOUT_MS);
    if (home) keep(here + '/', res);
    return res;
  } catch (e) {
    const copy = home ? await kept(here + '/') : null;
    return copy || new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
}

/** A reading: the network's, kept; the kept one (stamped) when there is no answer in time. */
async function reading(request, key) {
  const net = fetch(request);
  try {
    const res = await within(net, DATA_TIMEOUT_MS);
    keep(key, res);
    return res;
  } catch (e) {
    // A slow answer that comes after all is kept for next time.
    net.then((res) => keep(key, res), () => {});
    const copy = await kept(key);
    return copy || net;             // nothing kept: the network's own answer or error, as without this
  }
}

if (typeof self !== 'undefined' && self.addEventListener) {
  self.addEventListener('install', (event) => {
    // The page and its pictures, ready for a visit with no signal. One that
    // cannot be fetched does not stop the rest.
    event.waitUntil(caches.open(CACHE)
      .then((c) => Promise.all(SHELL.map((p) => fetch(p, { cache: 'reload' })
        .then((res) => (res.ok ? keep(self.location.origin + p, res) : null)).catch(() => null))))
      .catch(() => null)
      .then(() => self.skipWaiting()));
  });

  self.addEventListener('activate', (event) => {
    // Copies kept by an earlier version go.
    event.waitUntil(caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nhrc-') && k !== CACHE).map((k) => caches.delete(k))))
      .catch(() => null)
      .then(() => self.clients.claim()));
  });

  self.addEventListener('fetch', (event) => {
    try {
      const request = event.request;
      if (request.method !== 'GET') return;
      const here = self.location.origin;
      if (request.mode === 'navigate') {
        if (new URL(request.url).origin === here) event.respondWith(page(request, here));
        return;
      }
      const key = keyFor(request.url, here);
      if (key) event.respondWith(reading(request, key));
      // Everything else - forecasts, alerts, the camera, the map, libraries - the browser as usual.
    } catch (e) { /* the browser as usual */ }
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { VERSION, CACHE, SHELL, PAGE_TIMEOUT_MS, DATA_TIMEOUT_MS, SAVED_HEADER, WORKER, keyFor, isHome, page, reading, keep, kept, within };
}
