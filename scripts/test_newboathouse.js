#!/usr/bin/env node
/**
 * Tests for roworno.com/newboathouse (newboathouse/index.html): what it makes
 * of the Worker's list of days - only well formed days, only the Worker's own
 * videos - and how the page shows them, run against a small stand-in DOM; and
 * the page's guard rails: its Content-Security-Policy (with the hashes of its
 * own scripts), no outside scripts, no HTML built from data. No network.
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

/** The page's inline scripts, in order: [{ id, text }]. */
const scriptsOf = (html) => [...html.matchAll(/<script(?: id="([^"]*)")?>([\s\S]*?)<\/script>/g)].map((m) => ({ id: m[1], text: m[2] }));
const hashOf = (text) => `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;

if (process.argv.includes('--fix-csp')) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const fixed = html.replace(/script-src [^;]*;/, `script-src ${scriptsOf(html).map((s) => hashOf(s.text)).join(' ')};`);
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
  assert.strictEqual(P.wholeNote(raw.timelineFrom(INDEX)), '3 days so far, a frame for each quarter hour of daylight - 1 second in all');
  const quarters = Array.from({ length: 96 }, (_, i) => `${String(Math.floor(i / 4)).padStart(2, '0')}${String((i % 4) * 15).padStart(2, '0')}`).join(',');
  const long = raw.timelineFrom({ timeline: { fps: 10, chunks: [chunk('2026-11-01', [['2026-11-09', quarters]])] } });
  assert.strictEqual(P.wholeNote(long), '1 day so far, a frame for each quarter hour of daylight - 10 seconds in all');
  const month = raw.timelineFrom({ timeline: { fps: 10, chunks: ['01', '11', '21'].map((s) => chunk(`2026-11-${s}`,
    Array.from({ length: 10 }, (_, i) => [`2026-11-${String(Number(s) + i).padStart(2, '0')}`, quarters]))) } });
  assert.strictEqual(P.wholeNote(month), '30 days so far, a frame for each quarter hour of daylight - 5 minutes in all');
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
      fire(type) { for (const fn of (this.handlers[type] || []).slice()) fn({ target: this }); },
      click() { this.fire('click'); },
      scrollIntoView() {},
    };
    return el;
  };
  const video = (id) => {
    const v = make('video', id);
    let src = '';
    Object.assign(v, { readyState: 0, currentTime: 0, playbackRate: 1, defaultPlaybackRate: 1, paused: true, plays: 0, loads: [] });
    // A new video stops the one before: paused, as browsers do on loading.
    Object.defineProperty(v, 'src', { get: () => src, set: (x) => { src = x; v.readyState = 0; v.currentTime = 0; v.paused = true; v.loads.push(x); } });
    v.play = () => { v.plays++; v.paused = false; return opts.refusePlay ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(); };
    v.pause = () => { v.paused = true; };
    // As a browser may: the speed back to the default once the new video has loaded.
    v.ready = () => { v.readyState = 4; v.playbackRate = v.defaultPlaybackRate; v.fire('loadedmetadata'); };
    return v;
  };
  const els = {};
  for (const id of ['whole-title', 'stage', 'tl-controls', 'tl-play', 'tl-range', 'tl-full', 'tl-when', 'tl-ends', 'tl-note', 'tl-message',
    'day-card', 'day-title', 'day-note', 'day-message', 'days', 'theme-toggle']) els[id] = make('div', id);
  for (const id of ['stage', 'tl-controls', 'day-card', 'tl-message', 'day-message']) els[id].hidden = true;
  els['tl-a'] = video('tl-a');
  els['tl-b'] = video('tl-b');
  els['tl-b'].hidden = true;
  els['tl-b'].attrs['aria-hidden'] = 'true';
  els['day-player'] = video('day-player');
  const speeds = ['0.5', '1', '2', '4'].map((r) => { const b = make('button'); b.attrs['data-rate'] = r; b.attrs['aria-pressed'] = r === '1' ? 'true' : 'false'; return b; });
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
    window: { addEventListener: (type, fn) => { listeners[type] = fn; }, matchMedia: (q) => ({ matches: !!(opts.reducedMotion && /reduce/.test(q)) }) },
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
    visible: () => (els['tl-a'].hidden ? els['tl-b'] : els['tl-a']),
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

test('it plays from the first day at once: the first chunk on screen, the next made ready behind it; the drag bar spans every frame', async () => {
  const d = dom(OK);
  await d.startPage();
  assert.deepStrictEqual(d.fetched, [`${WORKER}/timelapse/index.json`]);
  assert.strictEqual(d.els['whole-title'].textContent, 'Monday, November 9, 2026 to Wednesday, November 11, 2026');
  assert.strictEqual(d.els['tl-ends'].textContent, 'Nov 9, 2026 → Nov 11, 2026');
  assert.deepStrictEqual([d.els.stage.hidden, d.els['tl-controls'].hidden], [false, false]);
  assert.strictEqual(d.a.src, src('2026-11-01'));
  assert.strictEqual(d.b.src, src('2026-11-11'), 'the next chunk loading behind');
  assert.ok(d.b.hidden && d.b.getAttribute('aria-hidden') === 'true');
  assert.strictEqual(d.a.getAttribute('poster'), `${WORKER}/timelapse/posters/2026-11-09-0123456789ab.jpg`);
  assert.strictEqual(d.range.max, '8');
  assert.strictEqual(d.a.plays, 1);
  assert.strictEqual(d.els['tl-play'].getAttribute('aria-label'), 'Pause');
  assert.strictEqual(d.els['tl-when'].textContent, 'Mon, Nov 9, 2026 · 7:00 AM');
  assert.strictEqual(d.range.getAttribute('aria-valuetext'), 'Mon, Nov 9, 2026 · 7:00 AM');
  assert.strictEqual(d.els['tl-note'].textContent, '3 days so far, a frame for each quarter hour of daylight - 1 second in all');
  // The bar follows the video, frame by frame.
  d.a.ready();
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
  assert.ok(d.a.hidden && !d.b.hidden && d.b.getAttribute('aria-hidden') === null);
  assert.strictEqual(d.b.plays, 1);
  assert.strictEqual(d.a.src, src('2026-11-21'), 'the third loading behind');
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

test('dragging to a chunk not loaded yet: it loads, and shows that frame once it can', async () => {
  const d = dom({ status: 200, body: THREE });
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(10);
  d.tick();
  assert.strictEqual(d.visible().src, src('2026-11-21'));
  assert.strictEqual(d.visible().currentTime, 0, 'not before it has loaded');
  d.visible().ready();
  assert.strictEqual(d.visible().currentTime, 0.15);
  d.release();
  assert.strictEqual(d.visible().paused, false);
});

test('speed for both videos; the button pauses and plays; at the end it starts again from the first day', async () => {
  const d = dom(OK);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.speeds[3].click();
  assert.deepStrictEqual([d.a.playbackRate, d.b.playbackRate], [4, 4]);
  assert.deepStrictEqual(d.speeds.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'false', 'true']);
  d.els['tl-play'].click();
  assert.strictEqual(d.a.paused, true);
  d.drag(8); d.tick(); d.release();
  d.els['tl-play'].click();
  assert.strictEqual(d.visible(), d.a, 'from the first chunk');
  assert.strictEqual(d.a.currentTime, 0.05);
  assert.strictEqual(d.a.paused, false);
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
  d.a.ready();
  assert.strictEqual(d.a.currentTime, 0.35, 'the 10th\'s first frame');
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
  assert.strictEqual(d.els['whole-title'].textContent, 'Monday, November 9, 2026 to Saturday, November 21, 2026');
  assert.strictEqual(d.visible().src, src('2026-11-01'), 'from the first day again');
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
  assert.strictEqual(v.src, `${WORKER}/timelapse/whole/2026-11-11-abcdefabcdef.mp4`, 'the new video');
  v.ready();
  assert.strictEqual(v.currentTime, 0.15, 'the same frame: the 11th at 7:15');
  assert.strictEqual(d.els['tl-when'].textContent, 'Wed, Nov 11, 2026 · 7:15 AM');
  assert.strictEqual(d.els['tl-message'].hidden, true, 'nothing to say');
  assert.strictEqual(v.paused, false, 'and playing, as it was');
  // The first chunk was not made again: its video is not loaded anew.
  assert.strictEqual(d.a.loads.filter((x) => x === src('2026-11-01')).length, 1);
});

test('the next chunk, made again while it waited behind (its old video deleted): only it is loaded anew - the one on screen plays on', async () => {
  const renamed = JSON.parse(JSON.stringify(THREE));
  renamed.timeline.chunks[2].video = 'whole/2026-11-21-abcdefabcdef.mp4';
  const w = changing(THREE);
  const d = dom(w.respond);
  await d.startPage();
  d.a.ready(); d.b.ready();
  d.drag(6); d.tick(); d.release();
  assert.deepStrictEqual([d.visible(), d.a.src], [d.b, src('2026-11-21')], 'the 11th on screen, the 21st behind it');
  const shownLoads = d.b.loads.length;
  await d.advance(31000);
  w.state.list = renamed;
  d.a.fire('error');
  await d.settle();
  assert.strictEqual(d.a.src, `${WORKER}/timelapse/whole/2026-11-21-abcdefabcdef.mp4`, 'the new one behind');
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
  d.speeds[2].click();
  d.drag(10); d.tick();
  const v = d.visible();
  assert.strictEqual(v.src, src('2026-11-21'));
  v.ready();
  assert.deepStrictEqual([v.playbackRate, v.defaultPlaybackRate], [2, 2]);
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

// ═══════════════════════════════════════════════════════════════════════════
section('3. Guard rails');
// ═══════════════════════════════════════════════════════════════════════════

test('the Content-Security-Policy comes first, allows only this page\'s own two scripts (by hash) and the club\'s Worker', () => {
  const head = html.slice(0, html.indexOf('</head>'));
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"\/>/.exec(head);
  assert.ok(csp, 'a CSP');
  assert.ok(head.indexOf(csp[0]) < head.indexOf('<script'), 'before any script');
  const rules = Object.fromEntries(csp[1].split(';').map((r) => r.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepStrictEqual(rules['default-src'], ["'none'"]);
  const hashes = scriptsOf(html).map((s) => hashOf(s.text));
  assert.strictEqual(hashes.length, 2);
  assert.deepStrictEqual(rules['script-src'], hashes,
    'the scripts changed: their hashes in the CSP must too - run: node scripts/test_newboathouse.js --fix-csp');
  for (const k of ['media-src', 'connect-src']) assert.deepStrictEqual(rules[k], [WORKER], k);
  assert.deepStrictEqual(rules['img-src'], ["'self'", WORKER]);
  assert.deepStrictEqual([rules['base-uri'], rules['form-action']], [["'none'"], ["'none'"]]);
  assert.ok(!/unsafe-inline|unsafe-eval|\*/.test(rules['script-src'].join(' ')));
});

test('no script from elsewhere, no inline event handlers, and no HTML made from data', () => {
  assert.ok(!/<script[^>]+src=/i.test(html), 'no outside scripts');
  assert.ok(!/<link[^>]+stylesheet/i.test(html), 'no outside styles');
  assert.ok(!/\son[a-z]+\s*=/i.test(html.replace(/<script[\s\S]*?<\/script>/g, '')), 'no onclick= and the like');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(pageScript), 'text only');
  const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]).filter((u) => !u.startsWith('http://www.w3.org/'));
  assert.ok(urls.every((u) => u.startsWith(WORKER)), urls.join(', '));
});

test('the page sits beside the main page: its links and pictures are the site\'s own', () => {
  for (const f of ['../favicon-32.png', '../favicon-16.png', '../apple-touch-icon.png', '../nhrc-logo-header.png']) {
    assert.ok(html.includes(`"${f}"`), f);
    assert.ok(fs.existsSync(path.join(__dirname, '..', f.slice(3))), `${f} is in the repository`);
  }
  assert.ok(/<a class="back" href="\.\.\/">/.test(html));
  assert.ok(/<html lang="en">/.test(html) && /<meta name="viewport" content="width=device-width, initial-scale=1\.0"\/>/.test(html));
});

test('the main page links here, under the camera\'s photo', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const card = main.slice(main.indexOf('id="camera-card"'), main.indexOf('<!-- WEATHER CARD -->'));
  assert.ok(/<a href="newboathouse\/">New boathouse: watch each day's timelapse/.test(card), card.slice(-600));
  assert.ok(card.indexOf('newboathouse/') > card.indexOf('id="camera-img"'), 'under the photo');
});

run();
