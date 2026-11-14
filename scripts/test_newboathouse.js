#!/usr/bin/env node
/**
 * Tests for roworno.com/newboathouse (newboathouse/index.html): what it makes
 * of the Worker's list of days - only well formed days, only the Worker's own
 * videos - and how the page shows them, run against a small stand-in DOM; and
 * the page's guard rails: its Content-Security-Policy (with the hashes of its
 * own scripts, and one file of the site's: the season's art), no outside
 * scripts, no HTML built from data. No network. (Its seasons themselves:
 * scripts/test_site_theme.js, section 9.)
 *
 *   node scripts/test_newboathouse.js
 *   node scripts/test_newboathouse.js --fix-csp    after changing the page's scripts: puts their new hashes in the CSP
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const PAGE = path.join(__dirname, '..', 'newboathouse', 'index.html');
const WORKER = 'https://nhrc-camera.gurpinar-emre.workers.dev';
// The season's pixel art (8bit/seasons.js, as on the main page): the one script from a file this page may run.
const ART = 'https://roworno.com/8bit/seasons.js';

/** The page's inline scripts, in order: [{ id, text }]. */
const scriptsOf = (html) => [...html.matchAll(/<script(?: id="([^"]*)")?>([\s\S]*?)<\/script>/g)].map((m) => ({ id: m[1], text: m[2] }));
const hashOf = (text) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

if (process.argv.includes('--fix-csp')) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const fixed = html.replace(/script-src [^;]*;/, `script-src ${scriptsOf(html).map((s) => hashOf(s.text)).join(' ')} ${ART};`);
  fs.writeFileSync(PAGE, fixed);
  console.log(fixed === html ? 'The CSP already has the scripts\' hashes.' : 'The CSP now has the scripts\' new hashes.');
  process.exit(0);
}

let passed = 0, failed = 0;
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function section(title) { queue.push([title, null]); }
async function run() {
  for (const [name, fn] of queue) {
    if (!fn) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); continue; }
    try {
      await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 10 s')), 10000).unref())]);
      passed++; console.log(`  PASS  ${name}`);
    } catch (e) {
      failed++; console.log(`  FAIL  ${name}\n        ${String((e && e.message) || e).split('\n').slice(0, 12).join('\n        ')}`);
    }
  }
  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  process.exitCode = failed ? 1 : 0;
}

const html = fs.readFileSync(PAGE, 'utf8');
const pageScript = scriptsOf(html).find((s) => s.id === 'page').text;
/** The page's logic, as a module (no DOM). */
function logic() {
  const ctx = { module: { exports: {} }, console, Date, Math, JSON, Number, String, Array, Object, RegExp };
  vm.runInNewContext(pageScript, ctx);
  return ctx.module.exports;
}
// Plain values from the page's own context (its arrays and objects are not this one's).
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const raw = logic();
const P = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === 'function' ? (...a) => plain(v(...a)) : v]));

/** A well formed day of the index. */
const day = (date, extra = {}) => Object.assign({ date, video: `videos/${date}-0123456789ab.mp4`, poster: `posters/${date}-0123456789ab.jpg`,
  frames: 112, first: '06:35', last: '16:15', seconds: 11.2, bytes: 6000000, width: 1280, height: 720, set: 'abcdef012345' }, extra);

// ═══════════════════════════════════════════════════════════════════════════
section('1. What the page makes of the list');
// ═══════════════════════════════════════════════════════════════════════════

/** A chunk of the continuous timelapse: { start, video, frames, seconds, bytes, days }. */
const chunk = (start, days) => ({ start, video: `whole/${start}-0123456789ab.mp4`, bytes: 9000,
  frames: days.reduce((n, d) => n + d[1].split(',').length, 0), seconds: 1,
  days: days.map(([date, times]) => ({ date, set: 'abcdef012345', times })) });
/** Three days over two chunks: the 9th (3 frames) and 10th (2) in the 1st's, the 11th (4) in the 11th's - 9 frames. */
const TL = { fps: 10, slotMinutes: 15, chunks: [chunk('2026-11-01', [['2026-11-09', '0700,0715,1200'], ['2026-11-10', '0800,1600']]),
  chunk('2026-11-11', [['2026-11-11', '0700,0715,0730,0745']])] };
const INDEX = { days: [day('2026-11-09'), day('2026-11-11', { frames: 98 }), day('2026-11-10')], timeline: TL };
const THREE = Object.assign({}, INDEX, { timeline: Object.assign({}, TL, { chunks: TL.chunks.concat([chunk('2026-11-21', [['2026-11-21', '0700,0715']])]) }) });
/** Each chunk's frames, by its first day: how long the stand-in videos are. */
const CHUNK_FRAMES = { '2026-11-01': 5, '2026-11-11': 4, '2026-11-21': 2 };

test('only the Worker\'s own, well formed days are used - newest first, each once', () => {
  const days = P.daysFrom({ days: [
    day('2026-11-07'), day('2026-11-09'), day('2026-11-08'),
    day('2026-11-06', { video: '//evil.example/x.mp4' }),
    day('2026-11-05', { video: 'videos/../latest.jpg' }),
    day('2026-11-04', { video: 'javascript:alert(1)' }),
    day('2026-11-03', { video: 'videos/2026-11-02-0123456789ab.mp4' }),
    day('2026-02-30'), null, 'x', { date: '2026-11-01' },
    day('2026-11-09', { frames: 1 }),
  ] });
  assert.deepStrictEqual(days.map((d) => d.date), ['2026-11-09', '2026-11-08', '2026-11-07']);
  for (const bad of [undefined, null, {}, { days: 'x' }, []]) assert.deepStrictEqual(P.daysFrom(bad), []);
});

test('the continuous timelapse: its chunks in order, every frame counted from the first day', () => {
  const tl = P.timelineFrom(INDEX);
  assert.strictEqual(tl.total, 9);
  assert.deepStrictEqual(tl.chunks.map((c) => [c.start, c.offset, c.frames]), [['2026-11-01', 0, 5], ['2026-11-11', 5, 4]]);
  assert.deepStrictEqual(tl.chunks[0].days.map((d) => [d.date, d.offset]), [['2026-11-09', 0], ['2026-11-10', 3]]);
  for (const bad of [undefined, {}, { timeline: 'x' }, { timeline: { fps: 0, chunks: [] } }, { timeline: { fps: 10, chunks: [] } }]) {
    assert.strictEqual(P.timelineFrom(bad), null);
  }
});

test('a chunk that is not well formed ends the timelapse there - what is shown is one unbroken run from the first day', () => {
  const bad = (c) => P.timelineFrom({ timeline: Object.assign({}, TL, { chunks: [TL.chunks[0], c] }) });
  for (const c of [Object.assign({}, TL.chunks[1], { video: '//evil.example/x.mp4' }), Object.assign({}, TL.chunks[1], { video: 'whole/2026-11-01-0123456789ab.mp4' }),
    Object.assign({}, TL.chunks[1], { frames: 5 }), Object.assign({}, TL.chunks[1], { start: '2026-11-01' }),
    Object.assign({}, TL.chunks[1], { days: [{ date: '2026-11-11', times: '0745,0700' }] }), Object.assign({}, TL.chunks[1], { days: [] }), null]) {
    const tl = bad(c);
    assert.deepStrictEqual([tl.total, tl.chunks.length], [5, 1], JSON.stringify(c).slice(0, 80));
  }
  assert.strictEqual(P.timelineFrom({ timeline: Object.assign({}, TL, { chunks: [Object.assign({}, TL.chunks[0], { video: 'videos/x.mp4' }), TL.chunks[1]] }) }), null);
});

test('any frame of the whole timelapse: which chunk, which frame in it, which day and time - the ends held', () => {
  const tl = raw.timelineFrom(INDEX);
  const at = (g) => plain(raw.frameAt(tl, g));
  assert.deepStrictEqual(at(0), { chunk: 0, local: 0, date: '2026-11-09', hhmm: '0700' });
  assert.deepStrictEqual(at(2), { chunk: 0, local: 2, date: '2026-11-09', hhmm: '1200' });
  assert.deepStrictEqual(at(3), { chunk: 0, local: 3, date: '2026-11-10', hhmm: '0800' });
  assert.deepStrictEqual(at(4), { chunk: 0, local: 4, date: '2026-11-10', hhmm: '1600' });
  assert.deepStrictEqual(at(5), { chunk: 1, local: 0, date: '2026-11-11', hhmm: '0700' });
  assert.deepStrictEqual(at(8), { chunk: 1, local: 3, date: '2026-11-11', hhmm: '0745' });
  assert.deepStrictEqual(at(99), at(8));
  assert.deepStrictEqual(at(-4), at(0));
  assert.deepStrictEqual(at('x'), at(0));
});

test('where the page was, in a newer list: the same day and time - or the time before it; a day gone, the frame number, kept in range', () => {
  const tl = raw.timelineFrom(THREE);
  assert.strictEqual(raw.frameOf(tl, '2026-11-10', '1600', 0), 4);
  assert.strictEqual(raw.frameOf(tl, '2026-11-11', '0715', 0), 6);
  assert.strictEqual(raw.frameOf(tl, '2026-11-11', '0740', 0), 7, 'a time no longer there: the one before it');
  assert.strictEqual(raw.frameOf(tl, '2026-11-11', '0600', 0), 5, 'before the first: the first');
  assert.strictEqual(raw.frameOf(tl, '2026-11-21', '0715', 0), 10);
  assert.strictEqual(raw.frameOf(tl, '2026-10-01', '0700', 7), 7, 'a day not there: where it was');
  assert.strictEqual(raw.frameOf(tl, '2026-10-01', '0700', 99), 10);
  assert.strictEqual(raw.sameTimeline(raw.timelineFrom(INDEX), raw.timelineFrom(INDEX)), true);
  assert.strictEqual(raw.sameTimeline(raw.timelineFrom(INDEX), tl), false, 'a chunk more');
  const renamed = JSON.parse(JSON.stringify(INDEX));
  renamed.timeline.chunks[1].video = 'whole/2026-11-11-abcdefabcdef.mp4';
  assert.strictEqual(raw.sameTimeline(raw.timelineFrom(INDEX), raw.timelineFrom(renamed)), false, 'a chunk made again');
});

test('the words: the day, the time under the drag bar, the hours and the lengths', () => {
  assert.strictEqual(P.dayTitle('2026-11-09'), 'Monday, November 9, 2026');
  assert.strictEqual(P.shortDay('2026-11-09'), 'Mon, Nov 9');
  assert.strictEqual(P.mediumDay('2027-01-01'), 'Jan 1, 2027');
  assert.strictEqual(P.whenText('2026-11-09', '1615'), 'Mon, Nov 9, 2026 · 4:15 PM');
  assert.deepStrictEqual(['0005', '06:35', '1200', '1615'].map(P.clock12), ['12:05 AM', '6:35 AM', '12:00 PM', '4:15 PM']);
  const [d] = P.daysFrom({ days: [day('2026-11-09')] });
  assert.strictEqual(P.dayNote(d), '112 photos, 6:35 AM to 4:15 PM - 11 seconds');
  // The continuous timelapse's title: the days it spans, as they are.
  assert.strictEqual(P.spanTitle(raw.timelineFrom(INDEX)), 'Nov 9, 2026 to Nov 11, 2026 Timelapse');
  const quarters = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}${String((i % 4) * 15).padStart(2, '0')}`).join(',');
  const one = raw.timelineFrom({ timeline: { fps: 10, chunks: [chunk('2026-11-01', [['2026-11-09', quarters]])] } });
  assert.strictEqual(P.spanTitle(one), 'Nov 9, 2026 Timelapse');
  const across = raw.timelineFrom({ timeline: { fps: 10, chunks: [chunk('2026-09-01', [['2026-09-06', '0700']]), chunk('2026-12-01', [['2026-12-09', '0700']])] } });
  assert.strictEqual(P.spanTitle(across), 'Sep 6, 2026 to Dec 9, 2026 Timelapse');
  // Over the days below.
  assert.deepStrictEqual([1, 2, 28].map(P.lastDays), ['Last 1 day', 'Last 2 days', 'Last 28 days']);
});

test('a link to a day (#2026-11-08) is that day; anything else is none, and the day player shows the newest', () => {
  const days = P.daysFrom({ days: [day('2026-11-08'), day('2026-11-09')] });
  assert.strictEqual(P.askedDay(days, '#2026-11-08').date, '2026-11-08');
  for (const h of ['', '#', '#2026-11-01', '#<img src=x>', null]) {
    assert.strictEqual(P.askedDay(days, h), null);
    assert.strictEqual(P.pickDay(days, h).date, '2026-11-09');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. The page, on a stand-in DOM');
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Just enough DOM for the page: elements by id, the videos (src, time, ready,
 * play/pause, their events), the buttons it makes, timers and frames run by
 * the test (tick(), advance()).
 */
function dom(responses, opts = {}) {
  const listeners = {};
  const timers = [];
  const frames = [];
  const make = (tag, id) => {
    const el = {
      tagName: tag.toUpperCase(), id, hidden: false, className: '', children: [], attrs: {}, _text: '', handlers: {}, style: {}, value: '0',
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
      removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter((f) => f !== fn); },
      fire(type) { for (const fn of (this.handlers[type] || []).slice()) fn({ target: this, type }); },
      click() { this.fire('click'); },
      scrollIntoView() {},
    };
    return el;
  };
  const video = (id) => {
    const v = make('video', id);
    let src = '', time = 0, rate = 1;
    Object.assign(v, { readyState: 0, defaultPlaybackRate: 1, paused: true, plays: 0, loads: [], seeks: [], restarts: 0, duration: NaN });
    // opts.maxRate: a browser that will not play faster than that (it throws, as the standard says).
    Object.defineProperty(v, 'playbackRate', { get: () => rate, set: (x) => {
      if (opts.maxRate && x > opts.maxRate) throw new Error('NotSupportedError');
      rate = x;
    } });
    // The page moving the video: each move kept, with how far it had loaded then. The video playing on: v.playTo(t).
    Object.defineProperty(v, 'currentTime', { get: () => time, set: (x) => { time = Number(x); v.seeks.push({ t: time, readyState: v.readyState }); } });
    v.playTo = (t) => { time = t; };
    v.seeking = false;
    // A new picture on screen: v.present() (where the browser says so - not with opts.noFrameCallbacks).
    v.frameCallbacks = [];
    if (!opts.noFrameCallbacks) v.requestVideoFrameCallback = (fn) => { v.frameCallbacks.push(fn); return v.frameCallbacks.length; };
    v.present = () => { for (const fn of v.frameCallbacks.splice(0)) fn(0, { mediaTime: time }); };
    // A new video stops the one before: paused, nothing loaded, as browsers do on loading.
    Object.defineProperty(v, 'src', { get: () => src, set: (x) => { src = x; v.readyState = 0; time = 0; v.duration = NaN; v.paused = true; v.loads.push(x); } });
    // opts.slowPlay: play() still starting until paused - then refused, a moment later, as browsers do.
    const starting = [];
    v.play = () => {
      v.plays++;
      if (opts.refusePlay) { v.paused = true; return Promise.reject(new Error('NotAllowedError')); }
      // As Chrome does: on its last frame a video counts as over, and play() starts it again from the first.
      if (v.duration > 0 && time >= v.duration - 0.1 - 1e-9) { time = 0; v.restarts++; }
      v.paused = false;
      return opts.slowPlay ? new Promise((resolve, reject) => starting.push(reject)) : Promise.resolve();
    };
    v.pause = () => {
      v.paused = true;
      const cut = starting.splice(0);
      setImmediate(() => { for (const reject of cut) reject(new Error('AbortError: play() interrupted by pause()')); });
    };
    // Loaded: at the start its address asks for (#t=) - unless this browser ignores that - and,
    // as a browser may, at the default speed again.
    v.ready = () => {
      const start = /#t=([\d.]+)$/.exec(src);
      const chunkStart = /\/whole\/(\d{4}-\d\d-\d\d)-/.exec(src);
      v.readyState = 4;
      time = start && !opts.noFragments ? Number(start[1]) : 0;
      v.duration = chunkStart && CHUNK_FRAMES[chunkStart[1]] ? CHUNK_FRAMES[chunkStart[1]] / 10 : NaN;
      v.playbackRate = v.defaultPlaybackRate;
      for (const type of ['loadedmetadata', 'loadeddata', 'canplay']) v.fire(type);
    };
    return v;
  };
  const els = {};
  for (const id of ['whole-title', 'stage', 'tl-controls', 'tl-play', 'tl-range', 'tl-full', 'tl-when', 'tl-ends', 'tl-message', 'day-label',
    'day-card', 'day-title', 'day-note', 'day-message', 'days', 'theme-toggle']) els[id] = make('div', id);
  for (const id of ['stage', 'tl-controls', 'day-card', 'tl-message', 'day-message']) els[id].hidden = true;
  // Where the stage is on the screen (800 high): on it, unless the test scrolls it away.
  els.stage.rect = { top: 100, bottom: 400 };
  els.stage.getBoundingClientRect = () => els.stage.rect;
  els['tl-a'] = video('tl-a');
  els['tl-b'] = video('tl-b');
  // As in the page: the one behind is see-through (aria-hidden), not hidden.
  els['tl-b'].attrs['aria-hidden'] = 'true';
  els['day-player'] = video('day-player');
  // The speed buttons, as in the page.
  const speeds = [...html.matchAll(/<button type="button" data-rate="([\d.]+)" aria-pressed="(true|false)">/g)].map(([, r, pressed]) => {
    const b = make('button'); b.attrs['data-rate'] = r; b.attrs['aria-pressed'] = pressed; return b;
  });
  const all = (node) => [node, ...node.children.flatMap(all)];
  const meta = make('meta');
  const docEl = make('html');
  docEl.attrs['data-theme'] = 'dark';
  const document = {
    documentElement: docEl,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => make(tag),
    querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
    querySelectorAll: (sel) => (sel === '#tl-speeds button' ? speeds : sel === '#days button' ? all(els.days).filter((e) => e.tagName === 'BUTTON') : []),
  };
  const fetched = [];
  const fetchOpts = [];
  const location = { hash: opts.hash || '' };
  const storage = {};
  let now = 0;
  // The page's clock is the test's: Date.now() moves with advance().
  class PageDate extends Date { static now() { return 1.8e12 + now; } }
  const ctx = {
    document, location, console, Date: PageDate, Math, JSON, Number, String, Array, Object, RegExp, Promise, Error, AbortController,
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].fn = null; },
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame: (n) => { if (frames[n - 1]) frames[n - 1] = null; },
    history: { replaceState: (a, b, h) => { location.hash = h; } },
    localStorage: { getItem: (k) => storage[k] || null, setItem: (k, v) => { storage[k] = v; } },
    window: Object.assign({ addEventListener: (type, fn) => { listeners[type] = fn; }, matchMedia: (q) => ({ matches: !!(opts.reducedMotion && /reduce/.test(q)) }), innerHeight: 800 },
      // opts.navy: the page's colour as the browser has drawn it (the season's, in season).
      opts.navy === undefined ? {} : { getComputedStyle: (el) => ({ getPropertyValue: (n) => (el === docEl && n === '--navy' ? opts.navy : '') }) }),
    fetch: async (url, o) => {
      fetched.push(url);
      fetchOpts.push(o || {});
      const r = typeof responses === 'function' ? responses(url) : responses;
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) };
    },
    module: undefined,
  };
  ctx.window.document = document;
  vm.runInNewContext(pageScript, ctx);
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  return {
    els, speeds, fetched, fetchOpts, location, storage, docEl, meta, timers,
    a: els['tl-a'], b: els['tl-b'], range: els['tl-range'],
    visible: () => (els['tl-a'].getAttribute('aria-hidden') === 'true' ? els['tl-b'] : els['tl-a']),
    startPage: async () => { listeners.DOMContentLoaded(); await settle(); },
    settle,
    /** Runs the frames asked for so far (the drag bar following the video, a drag drawn). */
    tick: () => { const f = frames.splice(0); for (const fn of f) if (fn) fn(); },
    /** Moves the timers' clock on, running what falls due. */
    advance: async (ms) => { now += ms; for (const t of timers) if (t.fn && t.at <= now) { const fn = t.fn; t.fn = null; fn(); } await settle(); },
    drag: (g) => { els['tl-range'].value = String(g); els['tl-range'].fire('input'); },
    release: () => els['tl-range'].fire('change'),
    dayButtons: () => document.querySelectorAll('#days button'),
  };
}
const OK = { status: 200, body: INDEX };
const src = (c) => `${WORKER}/timelapse/whole/${c}-0123456789ab.mp4`;
/** A video's address without where it starts (#t=). */
const base = (v) => v.src.split('#')[0];
/** Exactly one of the two in front, neither ever taken out of the page. */
function oneInFront(d) {
  assert.ok(!d.a.hidden && !d.b.hidden, 'neither video hidden (display:none)');
  assert.deepStrictEqual([d.a, d.b].map((v) => v.getAttribute('aria-hidden')).sort(), ['true', null].sort());
}

test('it plays from the first day at once: the first chunk on screen, the next made ready behind it; the drag bar spans every frame', async () => {
  const d = dom(OK);
  await d.startPage();
  assert.deepStrictEqual(d.fetched, [`${WORKER}/timelapse/index.json`]);
  assert.strictEqual(d.els['whole-title'].textContent, 'Nov 9, 2026 to Nov 11, 2026 Timelapse', 'the days it spans');
  assert.strictEqual(d.els['tl-ends'].textContent, 'Nov 9, 2026 → Nov 11, 2026');
  assert.deepStrictEqual([d.els.stage.hidden, d.els['tl-controls'].hidden], [false, false]);
  assert.strictEqual(d.a.src, `${src('2026-11-01')}#t=0.050`, 'from its first frame');
  assert.strictEqual(d.b.src, `${src('2026-11-11')}#t=0.050`, 'the next chunk loading behind');
  assert.strictEqual(d.b.getAttribute('aria-hidden'), 'true');
  oneInFront(d);
  assert.strictEqual(d.a.getAttribute('poster'), `${WORKER}/timelapse/posters/2026-11-09-0123456789ab.jpg`, 'the first day\'s picture until it has its own');
  d.b.ready();
  assert.strictEqual(d.a.getAttribute('poster'), `${WORKER}/timelapse/posters/2026-11-09-0123456789ab.jpg`, 'the one behind loading changes nothing in front');
  assert.strictEqual(d.range.max, '8');
  assert.strictEqual(d.a.plays, 1);
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Pause');
  assert.strictEqual(d.els['tl-when'].textContent, 'Mon, Nov 9, 2026 · 7:00 AM');
  assert.strictEqual(d.range.getAttribute('aria-valuetext'), 'Mon, Nov 9, 2026 · 7:00 AM');
  assert.ok(!/so far|quarter hour/.test(Object.values(d.els).map((e) => e.textContent).join(' ')), 'no count of days and frames under it');
  assert.ok(!/The building going up|every day so far in one timelapse/.test(html), 'no line under the heading saying what the page is');
  // The bar follows the video, frame by frame; the poster goes once the video has a picture.
  d.a.ready();
  assert.strictEqual(d.a.getAttribute('poster'), null);
  d.a.currentTime = 0.35;
  d.tick();
  assert.strictEqual(d.range.value, '3');
  assert.strictEqual(d.els['tl-when'].textContent, 'Tue, Nov 10, 2026 · 8:00 AM');
});

test('one chunk runs into the next: the ready one plays at once, and the one after starts loading', async () => {
  const d = dom({ status: 200, body: THREE });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.a.currentTime = 0.5;
  d.a.fire('ended');
  assert.strictEqual(d.visible(), d.b, 'the second chunk on screen');
  assert.ok(d.a.getAttribute('aria-hidden') === 'true' && d.b.getAttribute('aria-hidden') === null);
  oneInFront(d);
  assert.strictEqual(d.b.plays, 1);
  assert.deepStrictEqual(d.b.seeks, [], 'ready at its first frame already: not moved');
  assert.strictEqual(base(d.a), src('2026-11-21'), 'the third loading behind');
  d.b.currentTime = 0.05;
  d.tick();
  assert.strictEqual(d.range.value, '5');
  assert.strictEqual(d.els['tl-when'].textContent, 'Wed, Nov 11, 2026 · 7:00 AM');
  // The hidden one ending is not the timelapse ending.
  d.a.fire('ended');
  assert.strictEqual(d.visible(), d.b);
});

test('after the last frame: a moment on today, then the first day again - for as long as it plays', async () => {
  const d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.a.fire('ended');
  d.b.fire('ended');
  assert.strictEqual(d.range.value, '8');
  await d.advance(1000);
  assert.strictEqual(d.visible(), d.b, 'still on today');
  await d.advance(600);
  assert.strictEqual(d.visible(), d.a, 'the first chunk again');
  assert.strictEqual(d.a.currentTime, 0.05, 'its first frame');
  assert.strictEqual(d.a.plays, 2);
  assert.strictEqual(d.range.value, '0');
});

test('dragging: the frame under the finger at once, in whichever chunk - and playing again on letting go', async () => {
  const d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(6);
  assert.strictEqual(d.a.paused, true, 'paused while dragging');
  d.tick();
  assert.strictEqual(d.visible(), d.b, 'the chunk that was ready');
  assert.strictEqual(d.b.currentTime, 0.15, 'frame 1 of it');
  assert.strictEqual(d.els['tl-when'].textContent, 'Wed, Nov 11, 2026 · 7:15 AM');
  d.drag(2);
  d.tick();
  assert.strictEqual(d.visible(), d.a);
  assert.strictEqual(d.a.currentTime, 0.25);
  d.release();
  assert.strictEqual(d.a.paused, false, 'playing again');
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Pause');
  // Paused before: still paused after.
  d.els['tl-play'].click();
  d.drag(4); d.tick(); d.release();
  assert.strictEqual(d.a.paused, true);
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Play');
  assert.strictEqual(d.a.currentTime, 0.45);
});

test('dragging to a chunk not loaded yet: it loads, starting at that frame, and plays from there on letting go', async () => {
  const d = dom({ status: 200, body: THREE });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(9);
  d.tick();
  const v = d.visible();
  assert.strictEqual(v.src, `${src('2026-11-21')}#t=0.050`, 'where to start, in its address');
  assert.strictEqual(v.currentTime, 0, 'not moved before it has loaded');
  assert.strictEqual(d.els['tl-when'].textContent, 'Sat, Nov 21, 2026 · 7:00 AM');
  d.release();
  d.tick();
  assert.strictEqual(d.els['tl-when'].textContent, 'Sat, Nov 21, 2026 · 7:00 AM', 'the words stay on that frame while it loads');
  v.ready();
  assert.strictEqual(v.currentTime, 0.05);
  assert.deepStrictEqual(v.seeks, [], 'there already: not moved');
  assert.strictEqual(v.paused, false);
  oneInFront(d);
  // The chunk behind not loaded yet either: the words stay on the frame let go on, not its chunk's first.
  const e = dom({ status: 200, body: THREE });
  await e.startPage();
  e.a.ready();
  e.drag(7); e.tick(); e.release();
  e.tick();
  assert.strictEqual(e.els['tl-when'].textContent, 'Wed, Nov 11, 2026 · 7:30 AM');
  assert.strictEqual(e.range.value, '7');
  e.b.ready();
  assert.deepStrictEqual(e.b.seeks.map((s) => s.t), [0.25], 'then moved there, once it has a picture');
});

test('dragging back into the chunk before: it loads behind, then comes to the front - the chunk that was in front waits behind as the next', async () => {
  const d = dom({ status: 200, body: THREE });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(6); d.tick();
  assert.deepStrictEqual([d.visible(), base(d.a)], [d.b, src('2026-11-21')], 'the 11th in front, the 21st behind');
  const bLoads = d.b.loads.length;
  d.drag(2); d.tick();
  assert.strictEqual(d.visible(), d.a);
  assert.strictEqual(d.a.src, `${src('2026-11-01')}#t=0.250`, 'the 9th\'s third frame, loaded behind and brought forward');
  assert.strictEqual(d.b.loads.length, bLoads, 'the 11th, now behind, not loaded again');
  oneInFront(d);
});

test('speed for both videos; the button pauses and plays; at the end it starts again from the first day', async () => {
  const d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  assert.deepStrictEqual(d.speeds.map((b) => b.getAttribute('data-rate')), ['0.5', '1', '2', '4', '8']);
  // It starts at twice the speed, and says so.
  assert.deepStrictEqual([d.a.playbackRate, d.b.playbackRate, d.a.defaultPlaybackRate], [2, 2, 2], 'starts at 2x');
  assert.deepStrictEqual(d.speeds.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true', 'false', 'false']);
  d.speeds[1].click();
  assert.deepStrictEqual([d.a.playbackRate, d.b.playbackRate], [1, 1], '1x when asked');
  d.speeds[4].click();
  assert.deepStrictEqual([d.a.playbackRate, d.b.playbackRate, d.a.defaultPlaybackRate], [8, 8, 8], '8x');
  d.speeds[3].click();
  assert.deepStrictEqual([d.a.playbackRate, d.b.playbackRate], [4, 4]);
  assert.deepStrictEqual(d.speeds.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'false', 'true', 'false']);
  d.els['tl-play'].click();
  assert.strictEqual(d.a.paused, true);
  d.drag(8); d.tick(); d.release();
  d.els['tl-play'].click();
  assert.strictEqual(d.visible(), d.a, 'from the first chunk');
  assert.strictEqual(d.a.currentTime, 0.05);
  assert.strictEqual(d.a.paused, false);
});

test('paused: the time under the video and the bar are the frame it stopped on - not the last ones drawn while it played', async () => {
  const d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.a.playTo(0.25); d.tick();
  assert.strictEqual(d.els['tl-when'].textContent, 'Mon, Nov 9, 2026 · 12:00 PM');
  // On a frame with nothing drawn since (at 8x, or a page the browser draws less often), then paused.
  d.a.playTo(0.35);
  d.els['tl-play'].click();
  assert.strictEqual(d.a.paused, true);
  assert.strictEqual(d.els['tl-when'].textContent, 'Tue, Nov 10, 2026 · 8:00 AM', 'the picture it stopped on');
  assert.strictEqual(d.range.value, '3');
  assert.strictEqual(d.range.getAttribute('aria-valuetext'), 'Tue, Nov 10, 2026 · 8:00 AM');
  d.tick();
  assert.strictEqual(d.els['tl-when'].textContent, 'Tue, Nov 10, 2026 · 8:00 AM', 'and stays');
});

test('let go on the last frame of a chunk: on into the next chunk - not that chunk again from its first day, as browsers would play it', async () => {
  const d = dom({ status: 200, body: THREE });
  await d.startPage();
  d.a.ready(); d.b.ready();
  // Playing; let go on the 10th's last frame, the first chunk's last.
  d.drag(4); d.tick(); d.release();
  assert.strictEqual(d.a.restarts, 0, 'the first chunk not started again');
  assert.strictEqual(d.visible(), d.b, 'on into the next chunk');
  assert.deepStrictEqual([d.b.currentTime, d.b.paused], [0.05, false]);
  d.tick();
  assert.strictEqual(d.range.value, '5');
  // Paused there, then Play: the same.
  d.els['tl-play'].click();
  d.drag(8); d.tick(); d.release();
  assert.strictEqual(d.b.paused, true, 'paused before: still paused');
  d.els['tl-play'].click();
  assert.strictEqual(d.b.restarts, 0);
  assert.strictEqual(d.visible(), d.a, 'the third chunk');
  assert.strictEqual(d.a.paused, false);
  d.a.ready();
  assert.strictEqual(d.a.currentTime, 0.05);
  // Let go on the very last frame: a moment on it, as when it gets there by itself, then the first day.
  const plays = d.a.plays;
  d.drag(10); d.tick(); d.release();
  assert.deepStrictEqual([d.a.restarts, d.a.plays], [0, plays], 'not played from there');
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Pause');
  assert.strictEqual(d.els['tl-when'].textContent, 'Sat, Nov 21, 2026 · 7:15 AM');
  await d.advance(1600);
  assert.strictEqual(base(d.visible()), src('2026-11-01'), 'the first day again');
  assert.strictEqual(d.visible().paused, false);
  assert.strictEqual(d.range.value, '0');
});

test('nothing is moved while a video loads: it starts where its address says, then goes to the last frame asked for, once', async () => {
  for (const noFragments of [false, true]) {
    const d = dom({ status: 200, body: THREE }, { reducedMotion: true, noFragments });
    await d.startPage();
    // Dragged about before anything has loaded.
    d.drag(4); d.tick();
    d.drag(1); d.tick();
    d.release();
    assert.deepStrictEqual(d.a.seeks, [], 'nothing set on a video still loading');
    assert.strictEqual(d.els['tl-when'].textContent, 'Mon, Nov 9, 2026 · 7:15 AM');
    d.a.ready();
    assert.deepStrictEqual(d.a.seeks.map((s) => s.t), [0.15], noFragments ? 'a browser that ignores #t=: moved once it has a picture' : 'moved once');
    assert.ok(d.a.seeks.every((s) => s.readyState >= 2));
    // A late "loaded" from the chunk before, after a new one has started loading: not taken for the new one.
    d.drag(9); d.tick();
    const v = d.visible();
    v.fire('loadeddata');
    d.drag(10); d.tick();
    assert.deepStrictEqual(v.seeks, [], 'still loading: not moved');
    v.ready();
    assert.deepStrictEqual(v.seeks.map((s) => s.t), [0.15]);
  }
});

test('let go without the browser saying "changed" (a touch taken over by scrolling): playing again, the bar following it again', async () => {
  for (const ending of ['touchcancel', 'pointercancel', 'pointerup', 'touchend', 'mouseup']) {
    const d = dom(OK);
    await d.startPage();
    d.a.ready(); d.b.ready();
    d.drag(6); d.tick();
    d.range.fire(ending);
    assert.strictEqual(d.b.paused, false, `${ending}: playing again`);
    d.b.currentTime = 0.35;
    d.tick();
    assert.strictEqual(d.range.value, '8', `${ending}: the bar follows it`);
    // A late "changed": nothing more.
    d.release();
    assert.deepStrictEqual([d.b.plays, d.b.currentTime], [1, 0.35]);
  }
  // A browser that says only "changed", with no dragging before it: the frame let go on, playing or not as it was.
  const d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.range.value = '6';
  d.release();
  assert.deepStrictEqual([d.visible(), d.b.currentTime, d.b.paused], [d.b, 0.15, false], 'playing, as it was');
  d.els['tl-play'].click();
  d.range.value = '2';
  d.release();
  assert.deepStrictEqual([d.visible(), d.a.currentTime, d.a.paused], [d.a, 0.25, true], 'paused, as it was');
});

test('a start cut short by dragging again at once: the button still says Pause while it plays', async () => {
  const d = dom(OK, { slowPlay: true });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(6); d.tick(); d.release();
  d.drag(7); d.tick(); d.release();
  await d.settle();
  assert.strictEqual(d.b.paused, false);
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Pause');
  d.tick();
  assert.strictEqual(d.range.value, '7', 'and the bar follows it');
});

/** Plays the video in front on for `ms`, 100 ms a frame of the page, showing a new picture each time when `pictures`. */
async function playOn(d, ms, pictures) {
  for (let i = 0; i < ms / 100; i++) {
    const v = d.visible();
    v.playTo(v.currentTime + 0.1);
    if (pictures) v.present();
    await d.advance(100);
    d.tick();
  }
}

test('a picture stuck while the clock runs on (as Safari has done): moved to where it is, so it draws again - twice a chunk at most', async () => {
  const d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  // Playing as it should: never moved.
  await playOn(d, 3000, true);
  assert.deepStrictEqual(d.a.seeks, [], 'new pictures all along');
  // Stuck: moved once it has played on 1.5 s with nothing new...
  await playOn(d, 1400, false);
  assert.deepStrictEqual(d.a.seeks, [], 'not yet');
  await playOn(d, 300, false);
  assert.strictEqual(d.a.seeks.length, 1, 'moved');
  assert.ok(Math.abs(d.a.seeks[0].t - d.a.currentTime) < 0.25, 'to where it was');
  // ...again 3 s later if still stuck, and then no more for this chunk.
  await playOn(d, 2500, false);
  assert.strictEqual(d.a.seeks.length, 1, 'not again so soon');
  await playOn(d, 1000, false);
  assert.strictEqual(d.a.seeks.length, 2);
  await playOn(d, 10000, false);
  assert.strictEqual(d.a.seeks.length, 2, 'twice a chunk at most');
});

test('not taken for stuck: paused, just let go after a long drag, loading, scrolled away, or a browser that cannot say', async () => {
  // Paused a long time on a frame dragged to, then playing again: the watch starts afresh.
  let d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.els['tl-play'].click();
  d.drag(3); d.tick(); d.release();
  await d.advance(10000);
  d.els['tl-play'].click();
  const before = d.a.seeks.length;
  await playOn(d, 1000, false);
  await playOn(d, 1000, true);
  assert.strictEqual(d.a.seeks.length, before, 'playing again: no picture yet is not stuck');
  // Still loading the chunk in front.
  d = dom({ status: 200, body: THREE });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(9); d.tick(); d.release();
  await playOn(d, 5000, false);
  assert.deepStrictEqual(d.visible().seeks, [], 'loading: left alone');
  // Scrolled away from it (a browser may not draw it there).
  d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.els.stage.rect = { top: -900, bottom: -600 };
  await playOn(d, 5000, false);
  assert.deepStrictEqual(d.a.seeks, []);
  // Its clock not moving either (waiting for more of the video): not stuck, only slow.
  d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  for (let i = 0; i < 50; i++) { await d.advance(100); d.tick(); }
  assert.deepStrictEqual(d.a.seeks, []);
  // A browser that does not say when it shows a picture.
  d = dom(OK, { noFrameCallbacks: true });
  await d.startPage();
  d.a.ready(); d.b.ready();
  await playOn(d, 5000, false);
  assert.deepStrictEqual(d.a.seeks, []);
});

test('a browser that will not start a video by itself: shown paused, the button says Play', async () => {
  const d = dom(OK, { refusePlay: true });
  await d.startPage();
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Play');
  assert.strictEqual(d.els['tl-play'].getAttribute('data-state'), 'paused');
});

test('reduced motion asked for, or a link to a day (the email\'s): nothing plays by itself - the link shows its day, in both players', async () => {
  let d = dom(OK, { reducedMotion: true });
  await d.startPage();
  assert.strictEqual(d.a.plays, 0);
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Play');
  d = dom(OK, { hash: '#2026-11-10' });
  await d.startPage();
  assert.strictEqual(d.a.plays, 0);
  assert.strictEqual(d.a.src, `${src('2026-11-01')}#t=0.350`, 'starting at the 10th\'s first frame');
  assert.strictEqual(d.a.getAttribute('poster'), `${WORKER}/timelapse/posters/2026-11-10-0123456789ab.jpg`, 'the 10th\'s picture meanwhile');
  d.a.ready();
  assert.strictEqual(d.a.currentTime, 0.35, 'the 10th\'s first frame');
  assert.deepStrictEqual(d.a.seeks, []);
  assert.strictEqual(d.els['tl-when'].textContent, 'Tue, Nov 10, 2026 · 8:00 AM');
  assert.strictEqual(d.els['day-title'].textContent, 'Tuesday, November 10, 2026');
  assert.strictEqual(d.els['day-player'].src, `${WORKER}/timelapse/videos/2026-11-10-0123456789ab.mp4`);
});

test('below: each whole day - the newest ready, any other at a touch, and in the address', async () => {
  const d = dom(OK);
  await d.startPage();
  assert.strictEqual(d.els['day-card'].hidden, false);
  assert.strictEqual(d.els['day-title'].textContent, 'Wednesday, November 11, 2026');
  assert.strictEqual(d.els['day-note'].textContent, '98 photos, 6:35 AM to 4:15 PM - 11 seconds');
  assert.strictEqual(d.els['day-label'].textContent, 'Last 3 days', 'over the days below: how many');
  const buttons = d.dayButtons();
  assert.deepStrictEqual(buttons.map((b) => b.getAttribute('data-date')), ['2026-11-11', '2026-11-10', '2026-11-09']);
  assert.strictEqual(buttons[2].children[0].src, `${WORKER}/timelapse/posters/2026-11-09-0123456789ab.jpg`);
  buttons[2].click();
  assert.strictEqual(d.els['day-player'].src, `${WORKER}/timelapse/videos/2026-11-09-0123456789ab.mp4`);
  assert.strictEqual(d.location.hash, '#2026-11-09');
  assert.deepStrictEqual(d.dayButtons().map((b) => b.getAttribute('aria-current')), ['false', 'false', 'true']);
  d.els['day-player'].fire('error');
  assert.ok(/could not be played/.test(d.els['day-message'].textContent) && !d.els['day-message'].hidden);
});

test('no timelapse yet: said so - the days below if there are any; the Worker down or answering nonsense: said plainly', async () => {
  let d = dom({ status: 404, body: '' });
  await d.startPage();
  assert.strictEqual(d.els['whole-title'].textContent, 'No timelapse yet');
  assert.ok(/The first video appears the evening after/.test(d.els['tl-message'].textContent));
  assert.deepStrictEqual([d.els.stage.hidden, d.els['day-card'].hidden], [true, true]);
  d = dom({ status: 200, body: { days: [day('2026-11-09')] } });
  await d.startPage();
  assert.ok(/starts with the next day that is filmed/.test(d.els['tl-message'].textContent));
  assert.strictEqual(d.els['day-card'].hidden, false);
  for (const r of [new TypeError('Failed to fetch'), { status: 503, body: 'Storage unavailable' }, { status: 200, body: 'not json' }]) {
    d = dom(r);
    await d.startPage();
    assert.strictEqual(d.els['whole-title'].textContent, 'The timelapse could not be loaded');
    assert.strictEqual(d.els['tl-message'].className, 'message problem');
    assert.strictEqual(d.els.stage.hidden, true);
  }
});

test('a part that will not play: said, with what to do', async () => {
  const d = dom(OK);
  await d.startPage();
  d.a.fire('error');
  await d.settle();
  assert.ok(/Part of the timelapse could not be played/.test(d.els['tl-message'].textContent) && !d.els['tl-message'].hidden);
  assert.strictEqual(d.fetched.length, 1, 'the list was read just now: not again');
  // Later, the list again first - the same list: said, and not read again for 30 s.
  await d.advance(31000);
  d.a.fire('error');
  await d.settle();
  assert.strictEqual(d.fetched.length, 2);
  assert.ok(/Part of the timelapse could not be played/.test(d.els['tl-message'].textContent));
  d.a.fire('error');
  await d.settle();
  assert.strictEqual(d.fetched.length, 2);
});

test('the list is asked for afresh each time (the Worker says "not changed" when it is not): a kept copy can name videos already replaced', async () => {
  const d = dom(OK);
  await d.startPage();
  assert.strictEqual(d.fetchOpts[0].cache, 'no-cache');
});

/** Answers that change as the test goes: { list } as the Worker's index now. */
function changing(list) {
  const state = { list };
  return { state, respond: () => ({ status: 200, body: state.list }) };
}

test('a page left open: on the way back to the first day it reads the list again (not more than every 10 minutes) - a new day joins in', async () => {
  const w = changing(INDEX);
  const d = dom(w.respond);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.a.fire('ended'); d.b.fire('ended');
  await d.advance(1600);
  assert.strictEqual(d.fetched.length, 1, 'just read: not again');
  assert.strictEqual(d.visible(), d.a);
  // Ten minutes on, the evening's new day in the list: read on the way round, and played.
  w.state.list = THREE;
  await d.advance(10 * 60 * 1000);
  d.visible().fire('ended');
  d.visible().ready();
  d.visible().fire('ended');
  await d.advance(1600);
  assert.strictEqual(d.fetched.length, 2);
  assert.strictEqual(d.range.max, '10', 'the drag bar now spans the new day too');
  assert.strictEqual(d.els['whole-title'].textContent, 'Nov 9, 2026 to Nov 21, 2026 Timelapse');
  assert.strictEqual(base(d.visible()), src('2026-11-01'), 'from the first day again');
  assert.strictEqual(d.range.value, '0');
  assert.strictEqual(d.visible().paused, false);
});

test('a chunk made again while the page is open (its old video deleted): it reads the list again and carries on from the same frame', async () => {
  const renamed = JSON.parse(JSON.stringify(INDEX));
  renamed.timeline.chunks[1].video = 'whole/2026-11-11-abcdefabcdef.mp4';
  const w = changing(INDEX);
  const d = dom(w.respond);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(6); d.tick(); d.release();
  assert.strictEqual(d.visible(), d.b);
  await d.advance(31000);
  w.state.list = renamed;
  d.b.fire('error');
  await d.settle();
  assert.strictEqual(d.fetched.length, 2);
  const v = d.visible();
  assert.strictEqual(base(v), `${WORKER}/timelapse/whole/2026-11-11-abcdefabcdef.mp4`, 'the new video');
  v.ready();
  assert.strictEqual(v.currentTime, 0.15, 'the same frame: the 11th at 7:15');
  assert.strictEqual(d.els['tl-when'].textContent, 'Wed, Nov 11, 2026 · 7:15 AM');
  assert.strictEqual(d.els['tl-message'].hidden, true, 'nothing to say');
  assert.strictEqual(v.paused, false, 'and playing, as it was');
  // The first chunk was not made again: its video is not loaded anew.
  assert.strictEqual(d.a.loads.filter((x) => x.startsWith(src('2026-11-01'))).length, 1);
});

test('the next chunk, made again while it waited behind (its old video deleted): only it is loaded anew - the one on screen plays on', async () => {
  const renamed = JSON.parse(JSON.stringify(THREE));
  renamed.timeline.chunks[2].video = 'whole/2026-11-21-abcdefabcdef.mp4';
  const w = changing(THREE);
  const d = dom(w.respond);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(6); d.tick(); d.release();
  assert.deepStrictEqual([d.visible(), base(d.a)], [d.b, src('2026-11-21')], 'the 11th on screen, the 21st behind it');
  const shownLoads = d.b.loads.length;
  await d.advance(31000);
  w.state.list = renamed;
  d.a.fire('error');
  await d.settle();
  assert.strictEqual(base(d.a), `${WORKER}/timelapse/whole/2026-11-21-abcdefabcdef.mp4`, 'the new one behind');
  assert.strictEqual(d.b.loads.length, shownLoads, 'the one on screen not loaded again');
  assert.strictEqual(d.visible(), d.b);
  assert.strictEqual(d.els['tl-message'].hidden, true);
});

test('a day\'s video made again (a late frame) while the page is open: it reads the list again and plays the new one', async () => {
  const later = JSON.parse(JSON.stringify(INDEX));
  later.days[1].video = 'videos/2026-11-11-abcdefabcdef.mp4';
  const w = changing(INDEX);
  const d = dom(w.respond);
  await d.startPage();
  assert.strictEqual(d.els['day-title'].textContent, 'Wednesday, November 11, 2026');
  await d.advance(31000);
  w.state.list = later;
  d.els['day-player'].fire('error');
  await d.settle();
  assert.strictEqual(d.els['day-player'].src, `${WORKER}/timelapse/videos/2026-11-11-abcdefabcdef.mp4`);
  assert.strictEqual(d.els['day-message'].hidden, true);
  // Nothing new: said plainly.
  await d.advance(31000);
  d.els['day-player'].fire('error');
  await d.settle();
  assert.ok(/could not be played/.test(d.els['day-message'].textContent) && !d.els['day-message'].hidden);
});

test('the speed chosen stays when the next chunk loads - even in a browser that puts it back to the default on loading', async () => {
  const d = dom({ status: 200, body: THREE });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.speeds[3].click();
  d.drag(10); d.tick();
  const v = d.visible();
  assert.strictEqual(base(v), src('2026-11-21'));
  v.ready();
  assert.deepStrictEqual([v.playbackRate, v.defaultPlaybackRate], [4, 4]);
});

test('a speed the browser will not play: the one it had stays, and stays marked - nothing breaks', async () => {
  const d = dom(OK, { maxRate: 4 });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.speeds[2].click();
  d.speeds[4].click();
  assert.deepStrictEqual([d.a.playbackRate, d.b.playbackRate], [2, 2]);
  assert.deepStrictEqual(d.speeds.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true', 'false', 'false']);
  d.speeds[3].click();
  assert.deepStrictEqual([d.a.playbackRate, d.b.playbackRate], [4, 4], 'the others still work');
});

test('light and dark: the switch changes the page and remembers it for roworno.com too', async () => {
  const d = dom({ status: 404, body: '' });
  await d.startPage();
  assert.strictEqual(d.els['theme-toggle'].getAttribute('aria-label'), 'Switch to light mode');
  d.els['theme-toggle'].click();
  assert.strictEqual(d.docEl.getAttribute('data-theme'), 'light');
  assert.strictEqual(d.storage['nhrc-theme'], 'light', 'the same key as the main page');
  assert.strictEqual(d.meta.getAttribute('content'), '#f2f5f9');
});

test('the phone\'s own bar in the page\'s colour as drawn - the season\'s, in season - or the theme\'s own when the browser cannot say', async () => {
  const d = dom({ status: 404, body: '' }, { navy: ' #170e24' });
  await d.startPage();
  assert.strictEqual(d.meta.getAttribute('content'), '#170e24', 'Halloween\'s dark page');
  for (const navy of ['', 'red', '#12345', 'url(x)', undefined]) {
    const e = dom({ status: 404, body: '' }, { navy });
    await e.startPage();
    assert.strictEqual(e.meta.getAttribute('content'), '#0d1f3c', String(navy));
    e.els['theme-toggle'].click();
    assert.strictEqual(e.meta.getAttribute('content'), '#f2f5f9', `${navy}, light`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. Guard rails');
// ═══════════════════════════════════════════════════════════════════════════

test('the Content-Security-Policy comes first, allows only this page\'s own two scripts (by hash), the season\'s art and the club\'s Worker', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"\/>/.exec(head);
  assert.ok(csp, 'a CSP');
  assert.ok(head.indexOf(csp[0]) < head.indexOf('<script'), 'before any script');
  const rules = Object.fromEntries(csp[1].split(';').map((r) => r.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepStrictEqual(rules['default-src'], ["'none'"]);
  const hashes = scriptsOf(html).map((s) => hashOf(s.text));
  assert.strictEqual(hashes.length, 2);
  assert.deepStrictEqual(rules['script-src'], hashes.concat([ART]),
    'the scripts changed: their hashes in the CSP must too - run: node scripts/test_newboathouse.js --fix-csp');
  for (const k of ['media-src', 'connect-src']) assert.deepStrictEqual(rules[k], [WORKER], k);
  // data: for the season's pictures, which 8bit/seasons.js makes in the page - it fetches nothing.
  assert.deepStrictEqual(rules['img-src'], ["'self'", WORKER, 'data:']);
  assert.deepStrictEqual([rules['base-uri'], rules['form-action']], [["'none'"], ["'none'"]]);
  assert.ok(!/unsafe-inline|unsafe-eval|\*|'self'|data:|https:\/\/roworno\.com\/?(\s|$)|https:\/\/roworno\.com\/[^ ]*\/(\s|$)/.test(rules['script-src'].join(' ')),
    'no inline scripts but the two, nothing from a string, no whole site or folder: one file');
  // The one file: where the page asks for it (from roworno.com/newboathouse/), in the repository, on the site's own address.
  const asked = /season\(root, q, '([^']+)'\);/.exec(scriptsOf(html)[0].text);
  assert.ok(asked, 'the <head> script names the art');
  assert.strictEqual(new URL(asked[1], 'https://roworno.com/newboathouse/').href, ART);
  assert.strictEqual(new URL(asked[1], 'https://roworno.com/newboathouse').href, ART, 'without the last slash too');
  assert.ok(fs.existsSync(path.join(__dirname, '..', '8bit', 'seasons.js')));
  assert.strictEqual(fs.readFileSync(path.join(__dirname, '..', 'CNAME'), 'utf8').trim(), new URL(ART).host);
});

test('the video behind is see-through and under the one in front - never display:none, in the markup or the script', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(/#stage video\{z-index:1;\}/.test(css), 'the one in front on top');
  assert.ok(/#stage video\[aria-hidden="true"\]\{z-index:0;opacity:0;pointer-events:none;\}/.test(css), 'the one behind see-through, under it');
  assert.ok(/<video id="tl-b" playsinline muted preload="auto" aria-hidden="true"><\/video>/.test(html), 'behind from the start, not hidden');
  assert.ok(/<video id="tl-a" playsinline muted preload="auto" aria-label="[^"]+"><\/video>/.test(html), 'in front from the start');
  assert.ok(!/\.hidden\s*=/.test(pageScript.slice(pageScript.indexOf('// ── The continuous timelapse'), pageScript.indexOf('// ── Each whole day'))),
    'the continuous player never hides a video');
});

test('on a phone the five speeds share one row (checked in a real browser at 320 and 375 wide)', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(/@media \(max-width:420px\)\{\s*\.speeds\{gap:6px;flex-wrap:nowrap;\}\s*\.speeds button\{flex:1 1 0;min-width:0;padding:6px 4px;\}\s*\}/.test(css));
});

test('no script from elsewhere, no inline event handlers, and no HTML made from data', () => {
  assert.ok(!/<script[^>]+src=/i.test(html), 'no outside scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no outside styles');
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no onclick= and the like');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(pageScript), 'text only');
  // The one script added: the season's art, by the <head> script, only in a season (scripts/test_site_theme.js runs it).
  const all = scriptsOf(html).map((s) => s.text).join('\n');
  assert.strictEqual((all.match(/createElement\('script'\)/g) || []).length, 1);
  assert.ok(scriptsOf(html)[0].text.includes("createElement('script')") && !pageScript.includes('createElement(\'script\')'));
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>);]+/g)].map((m) => m[0]).filter((u) => !u.startsWith('http://www.w3.org/'));
  assert.ok(urls.every((u) => u.startsWith(WORKER) || u === ART), urls.join(', '));
  assert.strictEqual(urls.filter((u) => u === ART).length, 1, 'the art\'s address in the CSP, nowhere else');
});

test('the page sits beside the main page: its links and pictures are the site\'s own', () => {
  for (const f of ['../favicon-32.png', '../favicon-16.png', '../apple-touch-icon.png', '../nhrc-logo-header.png']) {
    assert.ok(html.includes(`"${f}"`), f);
    assert.ok(fs.existsSync(path.join(__dirname, '..', f.slice(3))), `${f} is in the repository`);
  }
  assert.ok(/<a class="back" href="\.\.\/">/.test(html));
  assert.ok(/<html lang="en">/.test(html) && /<meta name="viewport" content="width=device-width, initial-scale=1\.0"\/>/.test(html));
});

test('the main page links here once, from its header - nothing under the camera\'s photo since November 2026', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const card = main.slice(main.indexOf('id="camera-card"'), main.indexOf('<!-- WEATHER CARD -->'));
  assert.ok(card.includes('id="camera-img"'), 'the camera card');
  assert.ok(!/<a\b|newboathouse/.test(card), 'no link under the photo');
  assert.strictEqual((main.match(/href="newboathouse\/"/g) || []).length, 1, 'one link: the header button');
  assert.ok(!/camera-timelapse/.test(main), 'no styles left for the old link');
});

test('the header\'s "New Boathouse Timelapse" button, under the motto on the right - the same tab, the same site', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const header = main.slice(main.indexOf('<div class="header">'), main.indexOf('<button type="button" id="theme-toggle"'));
  const links = [...header.matchAll(/<a class="timelapse-btn"([^>]*)>([\s\S]*?)<\/a>/g)];
  assert.strictEqual(links.length, 1);
  assert.strictEqual(links[0][1], ' href="newboathouse/"', 'nothing else on it: no new tab');
  assert.strictEqual(links[0][2].replace(/<svg[\s\S]*?<\/svg>/, ''), 'New Boathouse Timelapse', 'its name, and an icon screen readers skip');
  assert.ok(/<svg [^>]*aria-hidden="true"/.test(links[0][2]));
  assert.ok(header.indexOf('The Stroke of the Oar Strengthens the Spirit') < header.indexOf('class="timelapse-btn"'), 'under the motto');
  assert.strictEqual(new URL('newboathouse/', 'https://roworno.com/').href, 'https://roworno.com/newboathouse/', 'this page');
  assert.strictEqual(new URL('newboathouse/', 'https://roworno.com/?8bit&season=halloween').href, 'https://roworno.com/newboathouse/', 'from the 8-bit page too');
});

test('the dock photo carries the club\'s logo, top right, as the timelapse does - in the photo\'s own box, so it goes when the photo does', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // The box around the photo: hidden whole when there is no photo (showCameraFrame hides img.parentElement).
  const box = /<div style="position:relative;[^"]*">\s*<img id="camera-img"[\s\S]*?<\/div>\s*<div class="note-text" id="camera-note">/.exec(main);
  assert.ok(box, 'the photo\'s box');
  assert.ok(/<img class="camera-logo" src="map\/nhrc-map\.png" width="160" height="136" alt=""\/>/.test(box[0]), 'the map\'s logo, in that box, decorative');
  assert.ok(/img\.parentElement\.style\.display = 'none'/.test(main), 'the box is what is hidden when there is no photo');
  const css = /\.camera-logo\{([^}]*)\}/.exec(main)[1];
  assert.ok(/position:absolute;top:8px;right:8px;/.test(css) && /width:clamp\(36px, 9%, 113px\)/.test(css) && /pointer-events:none/.test(css), css);
  // The backup camera's label (top left) stops short of it.
  assert.ok(/\.camera-badge\{[^}]*max-width:calc\(100% - 24px - clamp\(36px, 9%, 113px\)\)/.test(main));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'map', 'nhrc-map.png')));
});

run();
