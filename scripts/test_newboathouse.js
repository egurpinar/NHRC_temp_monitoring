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
section('1. What the page makes of the list of days');
// ═══════════════════════════════════════════════════════════════════════════

test('only the Worker\'s own, well formed days are used - newest first, each once', () => {
  const days = P.daysFrom({ days: [
    day('2026-11-07'), day('2026-11-09'), day('2026-11-08'),
    day('2026-11-06', { video: '//evil.example/x.mp4' }),
    day('2026-11-05', { video: 'videos/../latest.jpg' }),
    day('2026-11-04', { video: 'javascript:alert(1)' }),
    day('2026-11-03', { video: 'videos/2026-11-02-0123456789ab.mp4' }),     // another day's video
    day('2026-02-30'), null, 'x', { date: '2026-11-01' },
    day('2026-11-09', { frames: 1 }),                                        // a second 9th
  ] });
  assert.deepStrictEqual(days.map((d) => d.date), ['2026-11-09', '2026-11-08', '2026-11-07']);
  assert.strictEqual(days[0].video, 'videos/2026-11-09-0123456789ab.mp4');
  for (const bad of [undefined, null, {}, { days: 'x' }, []]) assert.deepStrictEqual(P.daysFrom(bad), []);
});

test('a poster or a detail that is not well formed is dropped, the day kept', () => {
  const [d] = P.daysFrom({ days: [day('2026-11-09', { poster: 'https://evil.example/p.jpg', frames: -3, first: '25:00', last: '<b>', seconds: 'x' })] });
  assert.deepStrictEqual([d.poster, d.frames, d.first, d.last, d.seconds], [null, null, null, null, null]);
  assert.strictEqual(P.dayNote(d), '', 'nothing to say rather than nonsense');
});

test('the words: the day, the hours, the length', () => {
  assert.strictEqual(P.dayTitle('2026-11-09'), 'Monday, November 9, 2026');
  assert.strictEqual(P.dayTitle('2027-01-01'), 'Friday, January 1, 2027');
  assert.strictEqual(P.shortDay('2026-11-09'), 'Mon, Nov 9');
  assert.deepStrictEqual(['00:05', '06:35', '12:00', '16:15'].map(P.clock12), ['12:05 AM', '6:35 AM', '12:00 PM', '4:15 PM']);
  const [d] = P.daysFrom({ days: [day('2026-11-09')] });
  assert.strictEqual(P.dayNote(d), '112 photos, 6:35 AM to 4:15 PM - 11 seconds');
  assert.strictEqual(P.dayNote(Object.assign({}, d, { frames: 1, seconds: 0.2 })), '1 photo, 6:35 AM to 4:15 PM - 1 second');
});

test('a link to a day (#2026-11-08) opens that day; anything else, the newest', () => {
  const days = P.daysFrom({ days: [day('2026-11-08'), day('2026-11-09')] });
  assert.strictEqual(P.pickDay(days, '#2026-11-08').date, '2026-11-08');
  for (const h of ['', '#', '#2026-11-01', '#<img src=x>', null]) assert.strictEqual(P.pickDay(days, h).date, '2026-11-09');
  assert.strictEqual(P.pickDay([], '#2026-11-08'), null);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. The page, on a stand-in DOM');
// ═══════════════════════════════════════════════════════════════════════════

/** Just enough DOM for the page: elements by id, the buttons it makes, events. */
function dom(responses) {
  const listeners = {};
  const make = (tag, id) => {
    const el = {
      tagName: tag.toUpperCase(), id, hidden: false, className: '', children: [], attrs: {}, _text: '', handlers: {}, style: {},
      get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { this._text = String(v); this.children = []; },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
      click() { for (const fn of this.handlers.click || []) fn({}); },
      scrollIntoView() {},
    };
    return el;
  };
  const els = {};
  for (const id of ['day-title', 'day-note', 'message', 'video-wrap', 'speeds', 'days-card', 'days', 'player-card', 'theme-toggle']) els[id] = make('div', id);
  els['video-wrap'].hidden = true; els.speeds.hidden = true; els['days-card'].hidden = true; els.message.hidden = true;
  const player = make('video', 'player');
  player.playbackRate = 1;
  els.player = player;
  const speeds = ['0.5', '1', '2'].map((r) => { const b = make('button'); b.attrs['data-rate'] = r; b.attrs['aria-pressed'] = r === '1' ? 'true' : 'false'; return b; });
  const all = (node) => [node, ...node.children.flatMap(all)];
  const meta = make('meta');
  const docEl = make('html');
  docEl.attrs['data-theme'] = 'dark';
  const document = {
    documentElement: docEl,
    getElementById: (id) => els[id] || null,
    createElement: (tag) => make(tag),
    querySelector: (sel) => {
      if (sel === '#speeds button[aria-pressed="true"]') return speeds.find((b) => b.attrs['aria-pressed'] === 'true') || null;
      if (sel === 'meta[name="theme-color"]') return meta;
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel === '#speeds button') return speeds;
      if (sel === '#days button') return all(els.days).filter((e) => e.tagName === 'BUTTON');
      return [];
    },
  };
  const fetched = [];
  const location = { hash: '' };
  const storage = {};
  const ctx = {
    document, location, console, Date, Math, JSON, Number, String, Array, Object, RegExp, Promise, Error,
    AbortController, setTimeout, clearTimeout,
    history: { replaceState: (a, b, h) => { location.hash = h; } },
    localStorage: { getItem: (k) => storage[k] || null, setItem: (k, v) => { storage[k] = v; } },
    window: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    fetch: async (url) => {
      fetched.push(url);
      const r = typeof responses === 'function' ? responses(url) : responses;
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body) };
    },
    module: undefined,
  };
  ctx.window.document = document;
  vm.runInNewContext(pageScript, ctx);
  const startPage = async () => { listeners.DOMContentLoaded(); for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  return { els, player, speeds, fetched, location, storage, docEl, meta, startPage, listeners, dayButtons: () => document.querySelectorAll('#days button') };
}

test('the newest day plays first, with its poster, its date and its hours; every day is listed to pick from', async () => {
  const d = dom({ status: 200, body: { days: [day('2026-11-08', { frames: 98 }), day('2026-11-09')] } });
  await d.startPage();
  assert.deepStrictEqual(d.fetched, [`${WORKER}/timelapse/index.json`]);
  assert.strictEqual(d.els['day-title'].textContent, 'Monday, November 9, 2026');
  assert.strictEqual(d.els['day-note'].textContent, '112 photos, 6:35 AM to 4:15 PM - 11 seconds');
  assert.strictEqual(d.player.src, `${WORKER}/timelapse/videos/2026-11-09-0123456789ab.mp4`);
  assert.strictEqual(d.player.getAttribute('poster'), `${WORKER}/timelapse/posters/2026-11-09-0123456789ab.jpg`);
  assert.deepStrictEqual([d.els['video-wrap'].hidden, d.els.speeds.hidden, d.els['days-card'].hidden, d.els.message.hidden], [false, false, false, true]);
  const buttons = d.dayButtons();
  assert.deepStrictEqual(buttons.map((b) => b.getAttribute('data-date')), ['2026-11-09', '2026-11-08']);
  assert.deepStrictEqual(buttons.map((b) => b.getAttribute('aria-current')), ['true', 'false']);
  assert.strictEqual(buttons[1].children[0].src, `${WORKER}/timelapse/posters/2026-11-08-0123456789ab.jpg`);
  assert.strictEqual(buttons[1].children[0].loading, 'lazy');
  assert.strictEqual(buttons[1].textContent, 'Sun, Nov 898 photos');
});

test('picking another day plays it, marks it, and puts it in the address - at the chosen speed', async () => {
  const d = dom({ status: 200, body: { days: [day('2026-11-08'), day('2026-11-09')] } });
  await d.startPage();
  d.speeds[2].click();
  assert.strictEqual(d.player.playbackRate, 2);
  assert.deepStrictEqual(d.speeds.map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  d.dayButtons()[1].click();
  assert.strictEqual(d.player.src, `${WORKER}/timelapse/videos/2026-11-08-0123456789ab.mp4`);
  assert.strictEqual(d.player.playbackRate, 2);
  assert.strictEqual(d.location.hash, '#2026-11-08');
  assert.deepStrictEqual(d.dayButtons().map((b) => b.getAttribute('aria-current')), ['false', 'true']);
  // A new video keeps the speed when it loads.
  d.player.playbackRate = 1;
  for (const fn of d.player.handlers.loadedmetadata) fn();
  assert.strictEqual(d.player.playbackRate, 2);
});

test('a link to a day opens that day; one day alone shows no list', async () => {
  const d = dom({ status: 200, body: { days: [day('2026-11-08'), day('2026-11-09')] } });
  d.location.hash = '#2026-11-08';
  await d.startPage();
  assert.strictEqual(d.els['day-title'].textContent, 'Sunday, November 8, 2026');
  const one = dom({ status: 200, body: { days: [day('2026-11-09')] } });
  await one.startPage();
  assert.strictEqual(one.els['days-card'].hidden, true);
  assert.strictEqual(one.els['video-wrap'].hidden, false);
});

test('no timelapse yet (404, or an empty or useless list): said so, no player', async () => {
  for (const r of [{ status: 404, body: 'Not found' }, { status: 200, body: { days: [] } }, { status: 200, body: { days: [day('2026-11-09', { video: '//evil.example/x.mp4' })] } }]) {
    const d = dom(r);
    await d.startPage();
    assert.strictEqual(d.els['day-title'].textContent, 'No timelapse yet');
    assert.ok(/The first video appears the evening after the camera's first full day of photos\./.test(d.els.message.textContent));
    assert.strictEqual(d.els['video-wrap'].hidden, true);
    assert.strictEqual(d.player.src, undefined);
  }
});

test('the Worker unreachable, or answering nonsense: said plainly, nothing half-shown', async () => {
  for (const r of [new TypeError('Failed to fetch'), { status: 503, body: 'Storage unavailable' }, { status: 200, body: 'not json' }]) {
    const d = dom(r);
    await d.startPage();
    assert.strictEqual(d.els['day-title'].textContent, 'The timelapse could not be loaded');
    assert.ok(/try again in a few minutes/.test(d.els.message.textContent));
    assert.strictEqual(d.els.message.className, 'message problem');
    assert.strictEqual(d.els['video-wrap'].hidden, true);
  }
});

test('a video that will not play: said, with what to do', async () => {
  const d = dom({ status: 200, body: { days: [day('2026-11-09')] } });
  await d.startPage();
  for (const fn of d.player.handlers.error) fn();
  assert.ok(/could not be played/.test(d.els.message.textContent) && d.els.message.hidden === false);
});

test('light and dark: the switch changes the page and remembers it for roworno.com too', async () => {
  const d = dom({ status: 404, body: '' });
  await d.startPage();
  assert.strictEqual(d.els['theme-toggle'].getAttribute('aria-label'), 'Switch to light mode');
  d.els['theme-toggle'].click();
  assert.strictEqual(d.docEl.getAttribute('data-theme'), 'light');
  assert.strictEqual(d.storage['nhrc-theme'], 'light', 'the same key as the main page');
  assert.strictEqual(d.els['theme-toggle'].getAttribute('aria-label'), 'Switch to dark mode');
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
