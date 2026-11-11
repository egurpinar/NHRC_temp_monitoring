#!/usr/bin/env node
/**
 * Tests for the website's light and dark themes (index.html).
 *
 *  1. Contrast: every text and status colour against the backgrounds it sits
 *     on, in both themes - WCAG AA: 4.5:1 for text, 3:1 for lines, dots, icons
 *     and the edges of controls.
 *  2. Dark is the original design: its colours are the old ones, apart from
 *     the few that fell short of AA (listed, with the old values).
 *  3. No colour is written into the page outside the palette, where only one
 *     theme would get it.
 *  4. The choice before the page is drawn (the small script in <head>): the
 *     visitor's own choice, otherwise the device's setting.
 *  5. The switch, run in the page's real script with a stand-in browser: its
 *     name, what a click does, remembering, following the device, the charts,
 *     and that a problem with it can never stop the readings loading.
 *
 *  7. roworno.com/8bit, the page's third look (the club's navy and gold,
 *     a pixel font): its contrast where its styles put each colour, only
 *     from the address and never remembered, statuses told apart by more
 *     than colour, its charts, the font (the site's own, renamed as its
 *     licence asks) and the small page at /8bit.
 *  8. The seasons, on the main page (dark and light) and the 8-bit one: each
 *     season's colours (contrast, the statuses' meaning, red never a frame or
 *     a heading), its dates on New York's calendar (every day of six years,
 *     the midnights, Easter by two methods and a third source), the season
 *     named in the address, the pixel art (8bit/seasons.js) fetched only
 *     then, and drawn: where, more on a wide screen, hidden from screen
 *     readers, never in the way of a tap, still when motion is turned down,
 *     snow only in winter.
 *
 * Before release (October 2026) the page was also checked in a real browser
 * engine, both themes, at widths from 320 to 900px: every element's real
 * text-on-background contrast, every status colour, the switch's place, size
 * and focus ring, and dark mode element by element against the old page.
 * The 8-bit look likewise in November 2026, on the live data: all 218 pieces of
 * text at least 5.6:1, nothing wider than a 320px screen. Its seasons too, each
 * on the live page: 199 pieces of text, at least 4.56:1 (Christmas's "No"),
 * nothing wider than 320px, nothing on the header's line over its words.
 *
 * Run: node scripts/test_site_theme.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const INDEX = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');

let passed = 0, failed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function section(t) { queue.push([null, t]); }

// ── Colour arithmetic (WCAG 2.x), with see-through colours laid over what is under them ──
function parse(c) {
  c = String(c).trim();
  let m;
  if ((m = /^#([0-9a-f]{6})$/i.exec(c))) return { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16), a: 1 };
  if ((m = /^#([0-9a-f]{3})$/i.exec(c))) return { r: parseInt(m[1][0] + m[1][0], 16), g: parseInt(m[1][1] + m[1][1], 16), b: parseInt(m[1][2] + m[1][2], 16), a: 1 };
  if ((m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c))) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  throw new Error('not a colour: ' + c);
}
const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
function ratio(fg, layers) {
  let bg = parse(layers[0]);
  for (const l of layers.slice(1)) bg = over(parse(l), bg);
  const [a, b] = [lum(over(parse(fg), bg)), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// ── The two palettes, as the CSS defines them ──
function block(selector) {
  const i = html.indexOf(selector + '{');
  assert.ok(i > -1, `${selector} not found`);
  const body = html.slice(i + selector.length + 1, html.indexOf('}', i));
  const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const DARK = block(':root');
const LIGHT = Object.assign({}, DARK, block(':root[data-theme="light"]'));
const THEMES = { dark: DARK, light: LIGHT };
// roworno.com/8bit: a third look, set from the address only (section 7).
const EIGHT = Object.assign({}, DARK, block(':root[data-theme="8bit"]'));
const ALL = { dark: DARK, light: LIGHT, '8bit': EIGHT };

const TINT = { green: 'rgba(46,125,79,.18)', green15: 'rgba(46,125,79,.15)', green20: 'rgba(46,125,79,.2)', yellow: 'rgba(255,209,102,.15)',
  gold: 'rgba(240,180,41,.15)', red: 'rgba(224,62,62,.15)', red12: 'rgba(224,62,62,.12)', red10: 'rgba(224,62,62,.1)',
  orange: 'rgba(224,123,32,.18)', orange12: 'rgba(224,123,32,.12)', orange10: 'rgba(224,123,32,.1)' };
// A layer: a palette name ('navy2'), a status tint ('tint:green') or a film of ink ('ink:.04').
const layer = (v, b) => b.startsWith('tint:') ? TINT[b.slice(5)] : b.startsWith('ink:') ? `rgba(${v.ink},${b.slice(4)})` : v[b];

// [what, foreground, [backgrounds, bottom first], the minimum]
const PAIRS = [
  ['text on the page', 'white', ['navy'], 4.5], ['text on a card', 'white', ['navy2'], 4.5], ['text on a tile', 'white', ['navy3'], 4.5],
  ['grey text on the page', 'muted', ['navy'], 4.5], ['grey text on a card', 'muted', ['navy2'], 4.5], ['grey text on a tile', 'muted', ['navy3'], 4.5],
  ['grey text on the info bar', 'muted', ['navy2', 'ink:.04'], 4.5], ['grey text on a fog pill', 'muted', ['navy2', 'ink:.05'], 4.5],
  ['gold label on a card', 'gold', ['navy2'], 4.5], ['gold label on a tile', 'gold', ['navy3'], 4.5], ['the active range button', 'gold', ['navy2', 'tint:gold'], 4.5],
  ['green on a green pill', 'ok', ['navy2', 'tint:green'], 4.5], ['green on a tile pill', 'ok', ['navy3', 'tint:green20'], 4.5],
  ['green Live pill on the page', 'ok', ['navy', 'tint:green'], 4.5], ['the Download CSV button', 'ok', ['navy2', 'tint:green15'], 4.5],
  ['caution on a yellow rule', 'caution', ['navy2', 'tint:yellow'], 4.5], ['caution on a gold pill', 'caution', ['navy2', 'tint:gold'], 4.5],
  ['caution on a tile pill', 'caution', ['navy3', 'tint:gold'], 4.5], ['caution text on a card', 'caution', ['navy2'], 4.5],
  ['red on a red pill', 'bad', ['navy2', 'tint:red'], 4.5], ['red on a tile pill', 'bad', ['navy3', 'tint:red'], 4.5],
  ['red on the danger banner', 'bad', ['navy', 'tint:red10'], 4.5], ['red text on a card', 'bad', ['navy2'], 4.5], ['red on a red rule', 'bad', ['navy2', 'tint:red12'], 4.5],
  ['orange on the warning banner', 'warn-text', ['navy', 'tint:orange12'], 4.5], ['orange on a weather alert', 'warn-text', ['navy2', 'tint:orange10'], 4.5],
  ['orange on a fog pill', 'warn-text', ['navy2', 'tint:orange'], 4.5], ['orange Reconnecting pill', 'warn-text', ['navy', 'tint:orange'], 4.5],
  ['chart axis labels', 'chart-tick', ['navy2'], 4.5], ['chart tooltip title', 'chart-tip-title', ['chart-tip-bg'], 4.5], ['chart tooltip text', 'chart-tip-body', ['chart-tip-bg'], 4.5],
  ['error page heading (large)', 'danger', ['navy', 'tint:red10'], 3.0],
  ['temperature line', 'chart-line', ['navy2'], 3.0], ['forecast line', 'chart-forecast', ['navy2'], 3.0],
  ['8 ft line', 'flood-8', ['navy2'], 3.0], ['9 ft line', 'flood-9', ['navy2'], 3.0], ['10 ft line', 'flood-10', ['navy2'], 3.0],
  ['11 ft line', 'flood-11', ['navy2'], 3.0], ['12 ft line', 'flood-12', ['navy2'], 3.0],
  ['green dot', 'ok-dot', ['navy3'], 3.0], ['caution dot', 'caution-dot', ['navy3'], 3.0], ['red dot', 'bad-dot', ['navy3'], 3.0],
  ['the switch\'s icon', 'gold', ['navy2'], 3.0], ['the focus ring', 'focus', ['navy'], 3.0], ['the email box\'s edge', 'input-border', ['navy2'], 3.0],
];

section('1. Contrast, both themes (WCAG AA)');

for (const [theme, v] of Object.entries(THEMES)) {
  test(`${theme}: every text and status colour is readable where it is used`, () => {
    const short = [];
    for (const [what, fg, bgs, min] of PAIRS) {
      assert.ok(v[fg] !== undefined, `${theme}: --${fg} is not defined`);
      const r = ratio(v[fg], bgs.map(b => layer(v, b)));
      if (r < min) short.push(`${what}: ${v[fg]} = ${r.toFixed(2)}:1, needs ${min}:1`);
    }
    assert.deepStrictEqual(short, []);
  });
}

test('the light theme defines a value for every colour the dark one has', () => {
  const lightOnly = block(':root[data-theme="light"]');
  const themed = Object.keys(DARK).filter(k => !/^f(serif|sans)$/.test(k) && !['green', 'blue', 'chart-fill'].includes(k));
  const missing = themed.filter(k => !(k in lightOnly));
  assert.deepStrictEqual(missing, [], 'colours that would stay dark in the light theme');
});

section('2. Dark mode is the original design');

test('dark keeps the original colours, apart from the ones that fell short of AA', () => {
  // The original design's values (index.html before October 2026).
  const ORIGINAL = { navy: '#0d1f3c', navy2: '#162d52', navy3: '#1e3d6e', gold: '#f0b429', white: '#f4f7fb',
    border: 'rgba(240,180,41,0.2)', danger: '#e03e3e', ok: '#5cc98a', caution: '#ffd166', 'warn-text': '#f0a450',
    'chart-line': '#f0b429', 'chart-tick': '#b0c4de', 'chart-grid': 'rgba(255,255,255,0.04)', 'chart-forecast': '#5ba4e0',
    'chart-tip-bg': '#162d52', 'chart-tip-title': '#5ba4e0', 'chart-tip-body': '#f4f7fb', 'flood-8': 'rgba(240,180,41,0.6)', 'flood-9': 'rgba(240,140,20,0.7)' };
  for (const [k, val] of Object.entries(ORIGINAL)) assert.strictEqual(DARK[k], val, `--${k}`);
  // The changes, each because the original fell short (see the comments in the CSS).
  const CHANGED = { muted: ['#7a93b4', '#9baec7'], bad: ['#f07070', '#f49494'], 'input-border': ['rgba(255,255,255,.15)', 'rgba(255,255,255,.4)'],
    'flood-10': ['rgba(224,100,20,0.7)', '#f0782a'], 'flood-11': ['rgba(224,62,62,0.7)', '#ff8080'], 'flood-12': ['rgba(180,20,20,0.85)', '#ff4d4d'] };
  for (const [k, [was, now]] of Object.entries(CHANGED)) {
    assert.strictEqual(DARK[k], now, `--${k}`);
    const v = Object.assign({}, DARK, { [k]: was });
    const pairs = PAIRS.filter(p => p[1] === k);
    assert.ok(pairs.some(([, fg, bgs, min]) => ratio(v[fg], bgs.map(b => layer(v, b))) < min), `--${k}: the old ${was} did pass - no reason to change it`);
  }
});

section('3. No colour outside the palette');

test('no dark-only colour is written into the page outside the palette', () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  // The palettes: dark, light, 8-bit and the 8-bit page's seasons (section 8), together at the top.
  const palettes = [style.indexOf(':root{'), style.indexOf('*{box-sizing:border-box;')];
  assert.ok(style.indexOf(':root[data-theme="light"]{') < style.indexOf(':root[data-theme="8bit"]{'), 'the palettes together, at the top');
  assert.ok(style.indexOf(':root[data-theme="8bit"]{') < style.indexOf(':root[data-theme="8bit"][data-season="halloween"]{')
    && style.indexOf(':root[data-theme="light"][data-season="july4"]{') < style.indexOf('*{box-sizing:border-box;'), 'the seasons straight after the 8-bit one');
  assert.ok(!/:root[^{]*\{[^}]*--[a-z0-9-]+:/.test(style.slice(palettes[1])), 'no colours set after them');
  const css = style.slice(0, palettes[0]) + style.slice(palettes[1]);
  const body = html.slice(html.indexOf('<body>'));
  // Allowed on purpose: the logo (on its own white disc), the Subscribe button
  // (the club's gold and navy in both themes), the backup badge (over the
  // photo), the map's wind badge and markers (over the aerial photos, the same
  // in both themes), and the charts' fallbacks if the CSS cannot be read (the
  // dark values).
  const fallbacks = body.slice(body.indexOf('function chartColors()'), body.indexOf('function restyleCharts()'));
  const scan = (css + body.replace(fallbacks, ''))
    .split('\n').filter(l => !/header-logo-wrap|camera-badge|^\.wind-badge\{|^\.map-dot\{|^\.leaflet-marker-icon\.(dock|yale)-icon\{|background:#f0b429;color:#0d1f3c|rgba\(255,209,102,\.6\)|rgba\(255,209,102,0\.15\)/.test(l)).join('\n');
  const DARK_ONLY = ['#f07070', '#ffd166', '#5cc98a', '#f0a450', '#7a93b4', '#b0c4de', '#5ba4e0', '#162d52', '#1e3d6e', '#f4f7fb',
    'rgba(255,255,255', 'rgba(0,0,0', 'background:#f0b429', 'color:#f0b429'];
  const found = DARK_ONLY.filter(c => scan.includes(c)).map(c => {
    const line = scan.split('\n').find(l => l.includes(c));
    return `${c} in: ${line.trim().slice(0, 100)}`;
  });
  assert.deepStrictEqual(found, []);
});

test('the charts read every colour from the palette, with the dark values as fallbacks', () => {
  const fn = html.slice(html.indexOf('function chartColors()'), html.indexOf('function restyleCharts()'));
  const reads = [...fn.matchAll(/cssVar\('--([a-z0-9-]+)', '([^']+)'\)/g)];
  assert.ok(reads.length >= 15, `${reads.length} colours`);
  for (const [, name, fallback] of reads) {
    assert.ok(name in DARK, `--${name} is not in the palette`);
    assert.strictEqual(fallback, DARK[name], `--${name}: the fallback must be the dark value`);
  }
});

section('4. Light or dark, before the page is drawn');

const initMatch = html.match(/<script id="theme-init">([\s\S]*?)<\/script>/);
const initSrc = initMatch ? initMatch[1] : '';
function pick({ stored, light, storageThrows = false, noMatchMedia = false }) {
  const attrs = {};
  const sandbox = {
    localStorage: { getItem: (k) => { if (storageThrows) throw new Error('SecurityError'); return k === 'nhrc-theme' ? stored : null; } },
    window: noMatchMedia ? {} : { matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: light)' && !!light }) },
    document: { documentElement: { setAttribute: (n, val) => { attrs[n] = val; } } },
  };
  vm.runInNewContext(initSrc, sandbox);
  return attrs['data-theme'];
}

test('the visitor\'s own choice wins over the device', () => {
  assert.ok(initMatch, 'the <script id="theme-init"> in <head>');
  assert.strictEqual(pick({ stored: 'light', light: false }), 'light');
  assert.strictEqual(pick({ stored: 'dark', light: true }), 'dark');
});

test('with no choice made, the device decides', () => {
  assert.strictEqual(pick({ stored: null, light: true }), 'light');
  assert.strictEqual(pick({ stored: null, light: false }), 'dark');
});

test('a stored value that is not a theme is ignored; blocked storage or no matchMedia never breaks it', () => {
  assert.strictEqual(pick({ stored: 'purple', light: true }), 'light');
  assert.strictEqual(pick({ storageThrows: true, light: true }), 'light');
  assert.strictEqual(pick({ stored: null, noMatchMedia: true }), 'dark');
});

test('it runs before anything is drawn, and is not part of the script the daily email reuses', () => {
  assert.ok(initMatch, 'the <script id="theme-init"> in <head> - with its id: a bare <script> there would become the start of the email\'s');
  assert.ok(html.indexOf('<script id="theme-init">') < html.indexOf('<style>'), 'before the styles');
  assert.ok(html.indexOf('<script id="theme-init">') < html.indexOf('<body>'));
  // The email takes the first bare <script> through to the end of <body>.
  const main = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
  assert.ok(!main.includes("<script id=\"theme-init\">") && !main.includes('</style>'), 'the email\'s script is the main one only');
  assert.ok(main.startsWith('\n// ───') || /ZONE_OVERRIDE/.test(main.slice(0, 600)), 'it starts where the main script starts');
});

section('5. The switch, in the page\'s real script');

const mainSrc = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];

/**
 * The page's script with a stand-in browser: a <html> whose data-theme the CSS
 * values follow, the switch button, the phone bar's meta, localStorage,
 * matchMedia, and a Chart that keeps what it is given.
 */
function page({ theme = 'dark', stored = null, deviceLight = false, storageThrows = false, brokenSwitch = false } = {}) {
  const root = { attrs: { 'data-theme': theme }, getAttribute(n) { return this.attrs[n] ?? null; }, setAttribute(n, v) { this.attrs[n] = v; } };
  const store = new Map(stored ? [['nhrc-theme', stored]] : []);
  const localStorage = {
    getItem: (k) => { if (storageThrows) throw new Error('SecurityError'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('SecurityError'); store.set(k, String(v)); },
  };
  const mq = { matches: deviceLight, handlers: [], addEventListener(type, fn) { if (type === 'change') this.handlers.push(fn); } };
  const button = { attrs: {}, handlers: {}, setAttribute(n, v) { this.attrs[n] = v; }, getAttribute(n) { return this.attrs[n]; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    click() { (this.handlers.click || []).forEach(fn => fn({})); } };
  const meta = { attrs: { content: '#0d1f3c' }, setAttribute(n, v) { this.attrs[n] = v; } };
  const els = {};
  const gradient = () => ({ stops: [], addColorStop(o, c) { this.stops.push([o, c]); } });
  const el = (id) => els[id] || (els[id] = {
    id, innerHTML: '', textContent: '', style: {}, value: '', className: '', dataset: {},
    getContext: () => ({ createLinearGradient: gradient, createPattern: (tile, rep) => ({ pattern: true, tile, rep }), fillRect() {}, fillStyle: '' }),
    width: 0, height: 0, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, appendChild() {}, get parentElement() { return el(id + '__parent'); },
  });
  const charts = [];
  function Chart(ctx, cfg) { this.data = cfg.data; this.options = cfg.options; this.updates = 0; this.destroyed = false; charts.push(this); }
  Chart.prototype.update = function () { this.updates++; };
  Chart.prototype.destroy = function () { this.destroyed = true; };
  const listeners = { window: {}, document: {} };
  const fetched = [];
  const sandbox = {
    document: {
      documentElement: root,
      getElementById: (id) => { if (id === 'theme-toggle') { if (brokenSwitch) throw new Error('broken'); return button; } return el(id); },
      querySelector: (sel) => (sel === 'meta[name="theme-color"]' ? meta : null),
      querySelectorAll: () => [],
      addEventListener: (t, fn) => { (listeners.document[t] = listeners.document[t] || []).push(fn); },
      createElement: () => el('__created'),
      visibilityState: 'visible',
    },
    window: { addEventListener: (t, fn) => { (listeners.window[t] = listeners.window[t] || []).push(fn); }, matchMedia: () => mq },
    getComputedStyle: () => ({ getPropertyValue: (name) => {
      const v = (ALL[root.attrs['data-theme']] || DARK)[name.replace(/^--/, '')];
      return v === undefined ? '' : ' ' + v;   // as browsers do: with the space after the colon
    } }),
    localStorage,
    fetch: (url) => { fetched.push(String(url)); return new Promise(() => {}); },
    Chart, moment: {},
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {},
    console: { log() {}, warn() {}, error() {} },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Blob: function () {}, Image: function () {},
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    Intl, Date, Math, JSON, isNaN, parseInt, parseFloat, Number, Array, Object, String, Map, Set, Promise,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(mainSrc + '\n;this.__p = { state, currentTheme, applyTheme, chartColors, initChart, initRiverChart, ' +
    'getChart: () => chart, getRiverChart: () => riverChart, THEME_KEY };', ctx, { timeout: 10000 });
  const fire = (bucket, type) => (listeners[bucket][type] || []).forEach(fn => fn({}));
  return { p: ctx.__p, root, button, meta, store, mq, charts, fire, fetched };
}

test('on load the switch is named for what it does: "Switch to light mode" in dark, and the other way round', () => {
  let x = page({ theme: 'dark' });
  x.fire('window', 'DOMContentLoaded');
  assert.strictEqual(x.button.attrs['aria-label'], 'Switch to light mode');
  assert.strictEqual(x.button.attrs.title, 'Switch to light mode');
  x = page({ theme: 'light' });
  x.fire('window', 'DOMContentLoaded');
  assert.strictEqual(x.button.attrs['aria-label'], 'Switch to dark mode');
  assert.strictEqual(x.meta.attrs.content, LIGHT.navy, 'the phone\'s bar in the light page colour');
});

test('a click switches the theme, remembers it, renames the switch, and recolours the phone\'s bar - and back', () => {
  const x = page({ theme: 'dark' });
  x.fire('window', 'DOMContentLoaded');
  x.button.click();
  assert.strictEqual(x.root.attrs['data-theme'], 'light');
  assert.strictEqual(x.store.get('nhrc-theme'), 'light');
  assert.strictEqual(x.button.attrs['aria-label'], 'Switch to dark mode');
  assert.strictEqual(x.meta.attrs.content, LIGHT.navy);
  x.button.click();
  assert.strictEqual(x.root.attrs['data-theme'], 'dark');
  assert.strictEqual(x.store.get('nhrc-theme'), 'dark');
  assert.strictEqual(x.button.attrs['aria-label'], 'Switch to light mode');
  assert.strictEqual(x.meta.attrs.content, DARK.navy);
});

test('with no choice made, the page follows the device when it changes; once chosen, it does not', () => {
  const x = page({ theme: 'dark' });
  x.fire('window', 'DOMContentLoaded');
  assert.strictEqual(x.mq.handlers.length, 1, 'listening for the device');
  x.mq.handlers[0]({ matches: true });
  assert.strictEqual(x.root.attrs['data-theme'], 'light', 'device went light: so does the page');
  assert.ok(!x.store.has('nhrc-theme'), 'following the device is not a choice: nothing remembered');
  x.mq.handlers[0]({ matches: false });
  assert.strictEqual(x.root.attrs['data-theme'], 'dark');
  x.button.click();                         // now the visitor chooses light
  x.mq.handlers[0]({ matches: false });     // and the device says dark
  assert.strictEqual(x.root.attrs['data-theme'], 'light', 'the visitor\'s choice stands');
});

test('with storage blocked the switch still works for this visit, without an error', () => {
  const x = page({ theme: 'dark', storageThrows: true });
  x.fire('window', 'DOMContentLoaded');
  x.button.click();
  assert.strictEqual(x.root.attrs['data-theme'], 'light');
  x.mq.handlers[0]({ matches: false });     // nothing could be remembered: the device decides again
  assert.strictEqual(x.root.attrs['data-theme'], 'dark');
});

test('a broken switch can never keep the readings from loading', () => {
  const x = page({ theme: 'dark', brokenSwitch: true });
  x.fire('window', 'DOMContentLoaded');
  assert.ok(x.fetched.some(u => /^data\.json/.test(u)), 'the water temperature was still fetched: ' + x.fetched.join(', '));
});

test('the charts are built in the current theme\'s colours', () => {
  for (const theme of ['dark', 'light']) {
    const x = page({ theme });
    const v = THEMES[theme];
    x.p.initChart();
    const temp = x.p.getChart();
    assert.strictEqual(temp.data.datasets[0].borderColor, v['chart-line'], `${theme}: line`);
    assert.strictEqual(temp.options.scales.x.ticks.color, v['chart-tick'], `${theme}: axis labels`);
    assert.strictEqual(temp.options.scales.y.grid.color, v['chart-grid'], `${theme}: grid`);
    assert.deepStrictEqual(temp.data.datasets[0].backgroundColor.stops, [[0, `rgba(${v['chart-fill']},0.2)`], [1, `rgba(${v['chart-fill']},0.0)`]]);
    const t0 = Date.now();
    x.p.initRiverChart([{ ts: t0 - 3600e3, ft: 3 }, { ts: t0, ft: 3.1 }], [{ ts: t0 + 3600e3, ft: 3.2 }], 3.1);
    const river = x.p.getRiverChart();
    assert.strictEqual(river.data.datasets[0].borderColor, v['chart-line'], `${theme}: observed`);
    assert.strictEqual(river.data.datasets[1].borderColor, v['chart-forecast'], `${theme}: forecast`);
    assert.strictEqual(river.data.datasets[1].pointBorderColor, v['chart-point-border']);
    // (spread: the page's arrays come from its own realm)
    assert.deepStrictEqual([...river.data.datasets.slice(2)].map(d => d.borderColor), ['8', '9', '10', '11', '12'].map(n => v['flood-' + n]), `${theme}: flood lines`);
    assert.strictEqual(river.options.plugins.tooltip.backgroundColor, v['chart-tip-bg']);
    assert.strictEqual(river.options.plugins.tooltip.titleColor, v['chart-tip-title']);
    assert.strictEqual(river.options.plugins.legend.labels.color, v['chart-tick']);
  }
});

test('switching recolours the temperature chart in place and redraws the river chart', () => {
  const x = page({ theme: 'dark' });
  x.fire('window', 'DOMContentLoaded');
  x.p.initChart();
  const t0 = Date.now();
  x.p.state.riverObserved = [{ ts: t0 - 3600e3, ft: 3 }, { ts: t0, ft: 3.1 }];
  x.p.state.riverForecast = [{ ts: t0 + 3600e3, ft: 3.2 }];
  x.p.state.riverLevel = 3.1;
  x.p.initRiverChart(x.p.state.riverObserved, x.p.state.riverForecast, x.p.state.riverLevel);
  const temp = x.p.getChart(), riverBefore = x.p.getRiverChart();
  x.button.click();
  assert.strictEqual(x.p.getChart(), temp, 'the same temperature chart, not a new one');
  assert.strictEqual(temp.data.datasets[0].borderColor, LIGHT['chart-line']);
  assert.strictEqual(temp.data.datasets[0].pointBackgroundColor, LIGHT['chart-line']);
  assert.strictEqual(temp.options.scales.x.ticks.color, LIGHT['chart-tick']);
  assert.strictEqual(temp.options.scales.y.grid.color, LIGHT['chart-grid']);
  assert.ok(temp.updates >= 1, 'and drawn again');
  const riverAfter = x.p.getRiverChart();
  assert.ok(riverBefore.destroyed && riverAfter !== riverBefore, 'the river chart was redrawn');
  assert.strictEqual(riverAfter.data.datasets[1].borderColor, LIGHT['chart-forecast']);
  assert.strictEqual(riverAfter.data.datasets.length, riverBefore.data.datasets.length, 'with the same lines');
});

test('switching before any chart exists is harmless', () => {
  const x = page({ theme: 'dark' });
  x.fire('window', 'DOMContentLoaded');
  x.button.click();
  assert.strictEqual(x.root.attrs['data-theme'], 'light');
  assert.strictEqual(x.charts.length, 0);
});

section('6. The switch\'s markup and style');

test('a real button, both icons hidden from screen readers, named in the markup from the start', () => {
  const m = html.match(/<button type="button" id="theme-toggle" class="theme-toggle" aria-label="([^"]+)" title="([^"]+)">([\s\S]*?)<\/button>/);
  assert.ok(m, 'the button');
  assert.strictEqual(m[1], 'Switch to light mode');
  const svgs = [...m[3].matchAll(/<svg class="(icon-sun|icon-moon)"[^>]*>/g)];
  assert.deepStrictEqual(svgs.map(s => s[1]), ['icon-sun', 'icon-moon']);
  for (const s of svgs) assert.ok(/aria-hidden="true"/.test(s[0]) && /focusable="false"/.test(s[0]), s[0]);
});

test('44 x 44, a focus ring, the sun in dark and the moon in light, still for people who turn motion off', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const rule = (sel) => { const i = css.indexOf(sel + '{'); assert.ok(i > -1, sel); return css.slice(i, css.indexOf('}', i)); };
  assert.ok(/width:44px;height:44px/.test(rule('.theme-toggle')));
  assert.ok(/outline:3px solid var\(--focus\)/.test(rule('.theme-toggle:focus-visible')));
  assert.ok(/display:none/.test(rule('.theme-toggle .icon-moon')));
  assert.ok(/display:none/.test(rule(':root[data-theme="light"] .theme-toggle .icon-sun')));
  assert.ok(/display:block/.test(rule(':root[data-theme="light"] .theme-toggle .icon-moon')));
  assert.ok(/@media \(prefers-reduced-motion: reduce\)\{\.theme-toggle\{transition:none;\}\}/.test(css));
  assert.ok(/<meta name="color-scheme" content="dark light"\/>/.test(html) && /color-scheme:dark;/.test(css) && /color-scheme:light;/.test(css),
    'the browser draws its own controls (scrollbars, the email box) to match');
});

section('7. The 8-bit page (roworno.com/8bit)');

// Its own colours, laid as its styles lay them (the 8-BIT styles at the end of the CSS).
const PX = (v, b) => b.startsWith('ink:') ? `rgba(${v.ink},${b.slice(4)})` : v[b];
const PAIRS_8BIT = [
  ['text on the page', 'white', ['px-screen'], 4.5], ['grey text', 'muted', ['px-screen'], 4.5], ['grey text on the info bar', 'muted', ['px-screen', 'ink:.04'], 4.5],
  ['gold headings and links', 'gold', ['px-screen'], 4.5], ['no restriction (plain)', 'ok', ['px-screen'], 4.5],
  ['caution (shaded)', 'caution', ['px-shade'], 4.5], ['a warning (shaded)', 'warn-text', ['px-shade'], 4.5], ['caution text in a card', 'caution', ['px-screen'], 4.5],
  ['restricted / danger (solid)', 'px-bad-ink', ['px-bad-bg'], 4.5], ['red text in a card', 'bad', ['px-screen'], 4.5],
  ['an active button', 'px-screen', ['px-line'], 4.5], ['chart axis labels', 'chart-tick', ['px-screen'], 4.5],
  ['chart tooltip title', 'chart-tip-title', ['chart-tip-bg'], 4.5], ['chart tooltip text', 'chart-tip-body', ['chart-tip-bg'], 4.5],
  ['the boxes\' lines', 'px-line', ['px-screen'], 3.0], ['the tiles\' lines', 'px-tile-line', ['px-screen'], 3.0], ['the focus ring', 'focus', ['px-screen'], 3.0],
  ['temperature line', 'chart-line', ['px-screen'], 3.0], ['forecast line', 'chart-forecast', ['px-screen'], 3.0],
  ['8 ft line', 'flood-8', ['px-screen'], 3.0], ['10 ft line', 'flood-10', ['px-screen'], 3.0], ['12 ft line', 'flood-12', ['px-screen'], 3.0],
  ['allowed square', 'ok-dot', ['px-screen'], 3.0], ['caution square', 'caution-dot', ['px-screen'], 3.0], ['no square', 'bad-dot', ['px-screen'], 3.0],
];

test('8-bit: every text and status colour is readable where it is used', () => {
  const short = [];
  for (const [what, fg, bgs, min] of PAIRS_8BIT) {
    assert.ok(EIGHT[fg] !== undefined, `--${fg} is not defined`);
    const r = ratio(EIGHT[fg], bgs.map(b => PX(EIGHT, b)));
    if (r < min) short.push(`${what}: ${EIGHT[fg]} = ${r.toFixed(2)}:1, needs ${min}:1`);
  }
  assert.deepStrictEqual(short, []);
});

test('8-bit: a value for every colour the dark theme has, in the club\'s navy and gold', () => {
  const own = block(':root[data-theme="8bit"]');
  const themed = Object.keys(DARK).filter(k => !/^f(serif|sans)$/.test(k) && !['green', 'blue', 'chart-fill'].includes(k));
  assert.deepStrictEqual(themed.filter(k => !(k in own)), []);
  assert.deepStrictEqual([own.navy, own.gold, own['px-line']], ['#0d1f3c', '#f0b429', '#f0b429'], 'the club\'s colours');
});

test('8-bit: only with ?8bit in the address - whatever was chosen before - and never remembered', () => {
  const withAddress = (search, opts) => {
    const attrs = {}, writes = [];
    const sandbox = {
      location: { search },
      localStorage: { getItem: (k) => (k === 'nhrc-theme' ? opts.stored : null), setItem: (k, v) => writes.push([k, v]) },
      window: { matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: light)' && !!opts.light }) },
      document: { documentElement: { setAttribute: (n, val) => { attrs[n] = val; } } },
    };
    vm.runInNewContext(initSrc, sandbox);
    return [attrs['data-theme'], writes.length];
  };
  for (const s of ['?8bit', '?8bit=1', '?x=1&8bit', '?8bit&x=1']) {
    assert.deepStrictEqual(withAddress(s, { stored: 'light', light: true }), ['8bit', 0], s);
  }
  for (const s of ['', '?', '?8bits', '?no8bit', '?x=8bit']) {
    assert.deepStrictEqual(withAddress(s, { stored: 'light', light: false }), ['light', 0], s || '(none)');
  }
});

test('8-bit: the light/dark switch is hidden, the device cannot switch the page away, and "Normal view" goes to the usual page', () => {
  const x = page({ theme: '8bit' });
  x.fire('window', 'DOMContentLoaded');
  assert.strictEqual(x.p.currentTheme(), '8bit');
  x.mq.handlers[0]({ matches: true });
  x.mq.handlers[0]({ matches: false });
  assert.strictEqual(x.root.attrs['data-theme'], '8bit', 'still 8-bit');
  assert.ok(!x.store.has('nhrc-theme'), 'nothing remembered');
  assert.strictEqual(x.meta.attrs.content, EIGHT.navy, 'the phone\'s bar in the page colour');
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(/:root\[data-theme="8bit"\] \.theme-toggle\{display:none;\}/.test(css));
  assert.ok(/\.exit-8bit\{display:none;\}/.test(css) && /:root\[data-theme="8bit"\] \.exit-8bit\{display:inline-flex;/.test(css));
  assert.ok(/<a class="exit-8bit" href="\.\/">Normal view<\/a>/.test(html));
});

test('8-bit charts: straight lines, square points, a chequered fill, typewriter letters, flood lines told apart by their dashes - the usual page unchanged', () => {
  const t0 = Date.now();
  const obs = [{ ts: t0 - 3600e3, ft: 3 }, { ts: t0, ft: 3.1 }], fc = [{ ts: t0 + 3600e3, ft: 3.2 }];
  const x = page({ theme: '8bit' });
  x.p.initChart();
  const temp = x.p.getChart().data.datasets[0];
  assert.deepStrictEqual([temp.tension, temp.pointStyle, !!temp.backgroundColor.pattern], [0, 'rect', true]);
  assert.strictEqual(x.p.getChart().options.scales.x.ticks.font.family, EIGHT.fsans);
  x.p.initRiverChart(obs, fc, 3.1);
  const river = x.p.getRiverChart();
  assert.deepStrictEqual([river.data.datasets[0].tension, river.data.datasets[1].tension, river.data.datasets[1].pointStyle], [0, 0, 'rect']);
  assert.deepStrictEqual([...river.data.datasets.slice(2)].map(d => JSON.stringify([...d.borderDash]) + '/' + d.borderWidth),
    ['[2,4]/1.5', '[2,4]/1.5', '[6,4]/1.5', '[6,4]/1.5', '[]/2']);
  // The usual page: as it was.
  const y = page({ theme: 'dark' });
  y.p.initChart();
  const dt = y.p.getChart().data.datasets[0];
  assert.deepStrictEqual([dt.tension, dt.pointStyle, Array.isArray(dt.backgroundColor.stops)], [0.3, 'circle', true]);
  assert.strictEqual(y.p.getChart().options.scales.x.ticks.font.family, "'Helvetica Neue',Helvetica,Arial,sans-serif");
  y.p.initRiverChart(obs, fc, 3.1);
  assert.deepStrictEqual([...y.p.getRiverChart().data.datasets.slice(2)].map(d => JSON.stringify([...d.borderDash])), Array(5).fill('[4,3]'));
});

test('8-bit statuses differ in more than colour: plain, shaded with a dashed edge, solid; the flood squares empty, chequered, full', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const X = ':root[data-theme="8bit"] ';
  const ruleFor = (sel) => { const i = css.indexOf(X + sel); assert.ok(i > -1, sel); return css.slice(css.indexOf('{', i), css.indexOf('}', i)); };
  assert.ok(/border:2px solid var\(--ok\)/.test(ruleFor('.pill-ok')) && /border:2px solid var\(--ok\)/.test(ruleFor('.bs-go')), 'plain');
  assert.ok(/background:var\(--px-shade\);color:var\(--caution\);border:2px dashed/.test(ruleFor('.bs-caution')), 'caution: shaded, dashed');
  assert.ok(/background:var\(--px-shade\);color:var\(--warn-text\);border:2px dashed/.test(ruleFor('.pill-warn')), 'a warning: shaded, dashed');
  assert.ok(/background:var\(--px-bad-bg\);color:var\(--px-bad-ink\)/.test(ruleFor('.bs-no')), 'restricted: solid');
  for (const sel of ['.rp-normal', '.rule-banner.green', '.rp-caution', '.rule-banner.yellow', '.rp-danger', '.rule-banner.red', '.warn-banner.level-danger', '.weather-alert.danger'])
    assert.ok(css.includes(X + sel), sel);
  assert.ok(!new RegExp(':root\\[data-theme="8bit"\\] \\.fog-pill\\.likely[^{]*\\{[^}]*px-bad-bg').test(css), 'fog never looks like a restriction');
  assert.ok(/background:transparent;border:2px solid var\(--ok-dot\)/.test(ruleFor('.fc-go')));
  assert.ok(/repeating-conic-gradient/.test(ruleFor('.fc-caution')));
  assert.ok(/background:var\(--bad-dot\)/.test(ruleFor('.fc-no')));
});

/** A WOFF font's name records (platform 3): { nameID: text }. */
function woffNames(file) {
  const zlib = require('zlib');
  const b = fs.readFileSync(file);
  assert.strictEqual(b.toString('latin1', 0, 4), 'wOFF');
  const n = b.readUInt16BE(12);
  for (let i = 0; i < n; i++) {
    const e = 44 + i * 20;
    if (b.toString('latin1', e, e + 4) !== 'name') continue;
    const off = b.readUInt32BE(e + 4), comp = b.readUInt32BE(e + 8), orig = b.readUInt32BE(e + 12);
    const t = comp < orig ? zlib.inflateSync(b.subarray(off, off + comp)) : b.subarray(off, off + orig);
    const count = t.readUInt16BE(2), strings = t.readUInt16BE(4), out = {};
    for (let r = 0; r < count; r++) {
      const p = 6 + r * 12;
      if (t.readUInt16BE(p) !== 3) continue;
      const len = t.readUInt16BE(p + 8), so = t.readUInt16BE(p + 10), raw = t.subarray(strings + so, strings + so + len);
      let s = ''; for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
      out[t.readUInt16BE(p + 6)] = s;
    }
    return out;
  }
  throw new Error('no name table');
}

test('the pixel font: from the site itself, only for the 8-bit page, renamed as its licence asks, the licence beside it', () => {
  const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.ok(/@font-face\{font-family:'Roworno Pixel';src:url\('fonts\/roworno-pixel\.woff'\) format\('woff'\);font-display:swap;\}/.test(css));
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(html), 'never from Google: no visitor\'s address goes there');
  // Used only through the 8-bit palette's --fpixel (and --fserif there): a browser fetches a font only for text that uses it.
  const outside = css.replace(/:root\[data-theme="8bit"\]\{[^}]*\}/, '').replace(/@font-face\{[^}]*\}/, '');
  assert.ok(!/Roworno Pixel/.test(outside), 'named nowhere else');
  assert.ok(!/--fpixel:/.test(outside), '--fpixel only in the 8-bit palette');
  const file = path.join(__dirname, '..', 'fonts', 'roworno-pixel.woff');
  assert.ok(fs.statSync(file).size < 20000, 'small');
  const names = woffNames(file);
  assert.strictEqual(names[1], 'Roworno Pixel');
  for (const id of [1, 3, 4, 6, 16]) assert.ok(!/Press Start 2P/i.test(names[id] || ''), `name ${id} is not the reserved name: ${names[id]}`);
  assert.ok(/^Copyright 2012 The Press Start 2P Project Authors/.test(names[0]), 'the copyright kept');
  const ofl = fs.readFileSync(path.join(__dirname, '..', 'fonts', 'OFL.txt'), 'utf8');
  assert.ok(/SIL OPEN FONT LICENSE Version 1\.1/.test(ofl) && /Copyright 2012 The Press Start 2P Project Authors/.test(ofl));
});

test('roworno.com/8bit: a small page that sends the visitor to /?8bit - replace(), so Back does not bounce - and nothing else', () => {
  const stub = fs.readFileSync(path.join(__dirname, '..', '8bit', 'index.html'), 'utf8');
  assert.ok(/<script>location\.replace\('\.\.\/\?8bit' \+ location\.hash\);<\/script>/.test(stub));
  assert.ok(/<meta http-equiv="refresh" content="0; url=\.\.\/\?8bit"\/>/.test(stub), 'without scripts too');
  assert.ok(/<link rel="canonical" href="https:\/\/roworno\.com\/\?8bit"\/>/.test(stub));
  assert.strictEqual((stub.match(/<script/g) || []).length, 1);
  assert.ok(!/<link rel="stylesheet"|<img|<iframe|src=/.test(stub), 'nothing loaded from anywhere');
});

section('8. The seasons, on the main page and the 8-bit one (8bit/seasons.js)');

const SEASON_NAMES = ['halloween', 'christmas', 'newyear', 'easter', 'july4'];
const CSS_ALL = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
/** A season's own colours in a theme (8bit, dark or light), as its rule sets them (the New Year shares Christmas's). */
function seasonBlock(name, theme) {
  const m = new RegExp(`(?:^|\\n|,)(:root\\[data-theme="${theme}"\\]\\[data-season="${name}"\\][^{]*)\\{([^}]*)\\}`).exec(CSS_ALL);
  assert.ok(m, `no colours for ${name} (${theme})`);
  const out = {};
  for (const v of m[2].matchAll(/--([a-z0-9-]+):([^;]+);/g)) out[v[1]] = v[2].trim();
  return { selector: m[1], vars: out, body: m[2] };
}
const BASE_OF = { '8bit': EIGHT, dark: DARK, light: LIGHT };
const PALETTE = (name, theme) => Object.assign({}, BASE_OF[theme], seasonBlock(name, theme).vars);
const ART = require(path.join(__dirname, '..', '8bit', 'seasons.js'));
const ART_SRC = fs.readFileSync(path.join(__dirname, '..', '8bit', 'seasons.js'), 'utf8');

/** A colour's hue, 0-360. */
function hue(c) {
  const { r, g, b } = parse(c), R = r / 255, G = g / 255, B = b / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn;
  if (!d) return null;
  let h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
const red = (c) => { const h = hue(c); return h !== null && (h >= 345 || h <= 12); };

test('seasons on the 8-bit page: every text and status colour readable where its styles put it', () => {
  const short = [];
  for (const name of SEASON_NAMES) {
    const v = PALETTE(name, '8bit');
    for (const [what, fg, bgs, min] of PAIRS_8BIT) {
      const r = ratio(v[fg], bgs.map(b => PX(v, b)));
      if (r < min) short.push(`${name}, ${what}: ${v[fg]} = ${r.toFixed(2)}:1, needs ${min}:1`);
    }
  }
  assert.deepStrictEqual(short, []);
  assert.ok(CSS_ALL.includes(':root[data-theme="8bit"][data-season="christmas"],:root[data-theme="8bit"][data-season="newyear"]{'), 'the New Year in Christmas\'s colours');
  assert.ok(/color-scheme:light;/.test(seasonBlock('easter', '8bit').body), 'Easter a light page, its controls light too');
});

test('seasons on the main page, dark and light: every text and status colour readable where it is used', () => {
  const short = [];
  for (const name of SEASON_NAMES) {
    for (const theme of ['dark', 'light']) {
      const v = PALETTE(name, theme);
      for (const [what, fg, bgs, min] of PAIRS) {
        const r = ratio(v[fg], bgs.map(b => layer(v, b)));
        if (r < min) short.push(`${name} (${theme}), ${what}: ${v[fg]} = ${r.toFixed(2)}:1, needs ${min}:1`);
      }
    }
    assert.ok(/color-scheme:light;/.test(seasonBlock(name, 'light').body), `${name}: a light page`);
    assert.ok(!/color-scheme/.test(seasonBlock(name, 'dark').body), `${name}: dark stays dark`);
  }
  assert.deepStrictEqual(short, []);
  for (const theme of ['dark', 'light']) {
    assert.ok(CSS_ALL.includes(`:root[data-theme="${theme}"][data-season="christmas"],:root[data-theme="${theme}"][data-season="newyear"]{`), theme);
  }
});

test('seasons on both pages: statuses keep their colours\' meaning (green, yellow, orange, red), and red is never a frame or a heading', () => {
  for (const name of SEASON_NAMES) {
    for (const theme of ['8bit', 'dark', 'light']) {
      const v = PALETTE(name, theme), own = seasonBlock(name, theme).vars, at = `${name} (${theme})`;
      assert.deepStrictEqual(Object.keys(own).filter(k => !(k in BASE_OF[theme])), [], `${at}: only the theme's own colour names`);
      const h = (k) => hue(v[k]);
      assert.ok(h('ok') >= 90 && h('ok') <= 170, `${at}: no restriction is green (${v.ok})`);
      assert.ok(h('caution') >= 38 && h('caution') <= 62, `${at}: caution is yellow (${v.caution})`);
      assert.ok(h('warn-text') >= 15 && h('warn-text') <= 40, `${at}: a warning is orange (${v['warn-text']})`);
      assert.ok(red(v.bad) && red(v['bad-dot']), `${at}: restricted is red`);
      for (const k of ['border', 'gold', 'white', 'muted', 'chart-line'].concat(theme === '8bit' ? ['px-line', 'px-tile-line'] : [])) {
        assert.ok(!red(v[k]), `${at}: --${k} is not red (${v[k]})`);
      }
    }
  }
});

// The <head> script, run on a given moment: what it sets on <html>, and what it fetches.
const INIT = new vm.Script(initSrc);
function headAt(iso, search = '?8bit', opts = {}) {
  const t = Date.parse(iso);
  class At extends Date { constructor(...a) { if (a.length) super(...a); else super(t); } static now() { return t; } }
  const attrs = {}, fetched = [], writes = [];
  // A visitor far from New York (Tokyo): the page must use New York's date, not the device's.
  const IntlAway = Object.assign(Object.create(Intl), {
    DateTimeFormat: function (locale, o) { return new Intl.DateTimeFormat(locale, Object.assign({ timeZone: 'Asia/Tokyo' }, o)); },
  });
  INIT.runInNewContext({
    Date: At, Intl: IntlAway, location: { search },
    localStorage: { getItem: (k) => (k === 'nhrc-theme' ? opts.stored || null : null), setItem: (k, v) => writes.push([k, v]) },
    window: { matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: light)' && !!opts.light }) },
    document: {
      documentElement: { setAttribute: (n, val) => { attrs[n] = val; }, removeAttribute: (n) => { delete attrs[n]; } },
      createElement: (tag) => ({ tag }),
      head: { appendChild: (el) => { if (opts.appendThrows) throw new Error('blocked'); fetched.push(el); } },
    },
  });
  return { theme: attrs['data-theme'], get season() { return attrs['data-season']; }, fetched, writes };
}
/** Easter Sunday by Gauss's method (with its two exceptions) - not the page's own formula. */
function gaussEaster(y) {
  const a = y % 19, b = y % 4, c = y % 7, k = Math.floor(y / 100), p = Math.floor((13 + 8 * k) / 25), q = Math.floor(k / 4);
  const M = (15 - p + k - q) % 30, N = (4 + k - q) % 7, d = (19 * a + M) % 30, e = (2 * b + 4 * c + 6 * d + N) % 7;
  if (d === 29 && e === 6) return [4, 19];
  if (d === 28 && e === 6 && (11 * M + 11) % 30 < 19) return [4, 18];
  return 22 + d + e <= 31 ? [3, 22 + d + e] : [4, d + e - 9];
}
// Easter Sunday 2025-2060 from python-dateutil (a third, independent source), as MMDD.
const EASTER_REF = '0420,0405,0328,0416,0401,0421,0413,0328,0417,0409,0325,0413,0405,0425,0410,0401,0421,0406,0329,0417,0409,0325,0414,0405,0418,0410,0402,0421,0406,0329,0418,0402,0422,0414,0330,0418'.split(',');

test('Easter Sunday: the page\'s formula against dateutil\'s dates (2025-2060) and Gauss\'s method (1900-2299)', () => {
  const src = initSrc.slice(initSrc.indexOf('function easter('), initSrc.indexOf('/**', initSrc.indexOf('function easter(')));
  const easter = vm.runInNewContext(`(${src.trim()})`);
  EASTER_REF.forEach((md, i) => assert.deepStrictEqual([...easter(2025 + i)], [+md.slice(0, 2), +md.slice(2)], `${2025 + i}`));
  for (let y = 1900; y < 2300; y++) assert.deepStrictEqual([...easter(y)], gaussEaster(y), `${y}`);
});

test('seasons on the club\'s calendar: every day of 2026-2031 at noon in New York, as the dates say - on both pages', () => {
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  const wrong = [];
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2032, 0, 1); ms += 864e5) {
    const [y, m, d] = ymd(ms).split('-').map(Number), md = m * 100 + d;
    const e = EASTER_REF[y - 2025], sunday = Date.UTC(y, +e.slice(0, 2) - 1, +e.slice(2));
    const want = md >= 1015 && md <= 1031 ? 'halloween' : md >= 1201 && md <= 1225 ? 'christmas' : md >= 1226 || md === 101 ? 'newyear'
      : md >= 628 && md <= 705 ? 'july4' : ms >= sunday - 8 * 864e5 && ms <= sunday + 864e5 ? 'easter' : undefined;
    const noon = new Date(ms + 17 * 3600e3).toISOString();   // noon in New York is 16:00 or 17:00 UTC
    const got = [headAt(noon).season, headAt(noon, '').season];
    if (got[0] !== want || got[1] !== want) wrong.push(`${ymd(ms)}: ${got} (should be ${want})`);
  }
  assert.deepStrictEqual(wrong, []);
  // The ten days up to Easter Monday, 2027 (Easter Sunday March 28): March 20 to 29.
  assert.deepStrictEqual(['2027-03-19', '2027-03-20', '2027-03-28', '2027-03-29', '2027-03-30'].map(d => headAt(`${d}T16:00:00Z`).season),
    [undefined, 'easter', 'easter', 'easter', undefined]);
});

test('seasons begin and end at midnight in New York, not in the visitor\'s or the server\'s time zone', () => {
  const at = (iso) => headAt(iso, '').season;
  // October: EDT, UTC-4.
  assert.deepStrictEqual([at('2026-10-15T03:59:00Z'), at('2026-10-15T04:00:00Z')], [undefined, 'halloween']);
  assert.deepStrictEqual([at('2026-11-01T03:59:00Z'), at('2026-11-01T04:00:00Z')], ['halloween', undefined]);
  // December and January: EST, UTC-5.
  assert.deepStrictEqual([at('2026-12-01T04:59:00Z'), at('2026-12-01T05:00:00Z')], [undefined, 'christmas']);
  assert.deepStrictEqual([at('2026-12-26T04:59:00Z'), at('2026-12-26T05:00:00Z')], ['christmas', 'newyear']);
  assert.deepStrictEqual([at('2027-01-02T04:59:00Z'), at('2027-01-02T05:00:00Z')], ['newyear', undefined]);
  // July: EDT.
  assert.deepStrictEqual([at('2027-06-28T03:59:00Z'), at('2027-06-28T04:00:00Z')], [undefined, 'july4']);
  assert.deepStrictEqual([at('2027-07-06T03:59:00Z'), at('2027-07-06T04:00:00Z')], ['july4', undefined]);
});

test('every visitor gets the season, in their own light or dark - or on the 8-bit page; one named in the address shows on any day; nothing remembered', () => {
  const summer = '2027-08-10T16:00:00Z', halloween = '2026-10-20T16:00:00Z';
  // The main page: the season with the visitor's own choice, or their device's.
  assert.deepStrictEqual(['theme', 'season'].map(k => headAt(halloween, '')[k]), ['dark', 'halloween']);
  assert.deepStrictEqual(['theme', 'season'].map(k => headAt(halloween, '', { light: true })[k]), ['light', 'halloween']);
  assert.deepStrictEqual(['theme', 'season'].map(k => headAt(halloween, '', { stored: 'light' })[k]), ['light', 'halloween']);
  assert.deepStrictEqual(['theme', 'season'].map(k => headAt(halloween, '?8bit')[k]), ['8bit', 'halloween']);
  assert.deepStrictEqual(['theme', 'season'].map(k => headAt(summer, '')[k]), ['dark', undefined], 'none out of season');
  // Named in the address, on either page.
  for (const s of SEASON_NAMES) {
    assert.strictEqual(headAt(summer, `?season=${s}`).season, s, s);
    assert.strictEqual(headAt(summer, `?8bit&season=${s}`).season, s, `${s} (8-bit)`);
  }
  assert.strictEqual(headAt(summer, '?season=easter&8bit').season, 'easter', 'in either order');
  assert.strictEqual(headAt(halloween, '?season=none').season, undefined, 'none, in a season');
  assert.strictEqual(headAt(halloween, '?8bit&season=none').season, undefined);
  for (const s of ['xmas', 'halloween2', '']) assert.strictEqual(headAt(halloween, `?season=${s}`).season, undefined, `not a season's name: ${s}`);
  for (const s of ['<script>', 'HALLOWEEN', '%3Cscript%3E']) assert.strictEqual(headAt(halloween, `?season=${s}`).season, 'halloween', `not even a name: the day's own season (${s})`);
  // Never remembered; the 8-bit page only from its address.
  assert.deepStrictEqual(headAt(halloween, '?8bit&season=easter').writes, []);
  assert.notStrictEqual(headAt(halloween, '?x=8bit&season=easter').theme, '8bit');
});

test('the pixel art is fetched only in a season, on either page, from the site itself - and a page that cannot fetch it keeps the year-round look', () => {
  for (const search of ['', '?8bit']) {
    const r = headAt('2026-10-20T16:00:00Z', search);
    assert.strictEqual(r.season, 'halloween');
    assert.deepStrictEqual(r.fetched.map(e => [e.tag, e.src, e.async]), [['script', '8bit/seasons.js', true]], search || '(main page)');
    assert.deepStrictEqual(headAt('2026-08-10T16:00:00Z', search).fetched, [], 'not out of season');
    // Fetched, but not there (no signal): the year-round look again, no empty room above the header.
    assert.strictEqual(typeof r.fetched[0].onerror, 'function');
    r.fetched[0].onerror();
    assert.strictEqual(r.season, undefined);
    assert.ok(['dark', '8bit'].includes(r.theme));
    const failed = headAt('2026-10-20T16:00:00Z', search, { appendThrows: true });
    assert.deepStrictEqual([failed.theme, failed.season], [search ? '8bit' : 'dark', undefined], 'no season colours, and no empty room');
  }
  assert.ok(!/<script[^>]*seasons\.js/.test(html), 'never from the page itself: everyone would fetch it all year');
});

test('the room kept above the header is the scene\'s size in 8bit/seasons.js, on every page; each season\'s colours name their theme', () => {
  const wide = /\n:root\[data-season\] #app\{padding-top:(\d+)px;\}/.exec(CSS_ALL);
  const narrow = /@media\(max-width:599px\)\{:root\[data-season\] #app\{padding-top:(\d+)px;\}\}/.exec(CSS_ALL);
  assert.ok(wide && narrow);
  // 12px above the scene, its height, 16px below it.
  assert.strictEqual(+wide[1], 12 + ART.SCENE_SIZE.wide.height + 16);
  assert.strictEqual(+narrow[1], 12 + ART.SCENE_SIZE.narrow.height + 16);
  assert.ok(ART_SRC.includes('const wide = width >= 600;') && ART_SRC.includes("'(min-width: 600px)'"), 'the same 600px as the CSS');
  // Every rule naming a season names its theme too - but the room above the header, kept on every page.
  const uses = [...CSS_ALL.matchAll(/([^{}]*?)\[data-season/g)].map(m => m[1].split(/[,{}]/).pop().trim());
  assert.strictEqual(uses.length, (CSS_ALL.match(/\[data-season/g) || []).length);
  assert.ok(uses.length >= 20);
  for (const u of uses) assert.ok(/:root\[data-theme="(8bit|dark|light)"\]$/.test(u) || /(^|\n):root$/.test(u), `a season rule without its theme: ${u}`);
  assert.strictEqual(uses.filter(u => /(^|\n):root$/.test(u)).length, 2, 'only the room, wide and narrow');
  // The main script - the one the daily email reuses - knows nothing of seasons.
  assert.ok(!/data-season|seasons\.js/.test(mainSrc));
});

test('the 8-bit page\'s map photos in the season\'s colours at Halloween and Easter: the same four brightness steps as the navy ones', () => {
  const tables = (id) => {
    const f = html.match(new RegExp(`<filter id="${id}"[\\s\\S]*?</filter>`))[0];
    return ['R', 'G', 'B'].map(ch => f.match(new RegExp(`<feFunc${ch} type="discrete" tableValues="([^"]+)"`))[1].split(' ').map(Number));
  };
  const steps = (id) => { const [R, G, B] = tables(id); return R.map((r, i) => lum({ r: r * 255, g: G[i] * 255, b: B[i] * 255 })); };
  const navy = steps('px-tones');
  for (const s of ['halloween', 'easter']) {
    const own = steps(`px-tones-${s}`);
    own.forEach((l, i) => assert.ok(Math.abs(l - navy[i]) / navy[i] < 0.05, `${s}, step ${i + 1}: ${l.toFixed(4)} vs ${navy[i].toFixed(4)}`));
    assert.ok(CSS_ALL.includes(`:root[data-theme="8bit"][data-season="${s}"] .leaflet-tile{filter:url(#px-tones-${s});}`));
  }
  assert.ok(!/:root\[data-theme="(dark|light)"\][^{]*\.leaflet-tile/.test(CSS_ALL), 'the main page\'s map keeps its photos as they are');
});

test('8bit/seasons.js: every picture well formed, every season\'s things there, and each fits where it goes', () => {
  for (const [name, sp] of Object.entries(ART.SPRITES)) {
    const { w, h } = ART.size(name);
    for (const f of sp.f) {
      assert.strictEqual(f.length, h, `${name}: rows`);
      for (const row of f) {
        assert.strictEqual(row.length, w, `${name}: ${row}`);
        for (const ch of row) assert.ok(ch === '.' || /^#[0-9a-f]{6}$/.test(sp.c[ch]), `${name}: ${ch}`);
      }
    }
  }
  for (const t of Object.values(ART.TINTS).concat(Object.values(ART.BURSTS))) for (const c of Object.values(t)) assert.ok(/^#[0-9a-f]{6}$/.test(c), c);
  assert.deepStrictEqual(Object.keys(ART.SCENES), SEASON_NAMES);
  for (const sk of Object.values(ART.SCENE_SIZE)) assert.ok((sk.height - 8) / sk.k >= 20, 'the frame holds 20 rows');
  const thingOk = (season, where, it) => {
    assert.ok(ART.SPRITES[it.s], `${season} ${where}: ${it.s}`);
    if (it.tint) assert.ok(ART.TINTS[it.tint], `${season} ${where}: ${it.tint}`);
    if (it.color) assert.ok(ART.BURSTS[it.color], `${season} ${where}: ${it.color}`);
    if (it.frames) assert.ok(ART.size(it.s).n > 1, `${season} ${where}: ${it.s} has frames to run`);
  };
  for (const [season, plan] of Object.entries(ART.SCENES)) {
    for (const where of ['top', 'bottom']) {
      const part = plan[where];
      for (const k of ['floor', 'sky', 'lights']) if (part[k]) assert.ok(ART.SPRITES[part[k]], `${season}: ${part[k]}`);
      assert.ok(part.things.length >= 8, `${season} ${where}: plenty`);
      for (const it of part.things) {
        thingOk(season, where, it);
        const { h } = ART.size(it.s);
        // The scenes are 20 picture pixels high inside their frames.
        if (it.t !== undefined) assert.ok(it.t + h <= 20, `${season} ${where}: ${it.s} from the top`);
        if (it.b !== undefined) assert.ok(it.b + h <= 20, `${season} ${where}: ${it.s} from the bottom`);
        if (it.x !== undefined) assert.ok(it.x >= 0 && it.x < 100, `${season} ${where}: ${it.s} across`);
      }
    }
    // The header's line: 10 rows at 2 = 20px, in its 22px of padding, clear of its words.
    for (const it of plan.line) { thingOk(season, 'line', it); assert.ok(ART.size(it.s).h * ART.GROUND.k <= ART.GROUND.height && ART.GROUND.height < 22, `${season}: ${it.s} on the line`); }
    for (const side of ['left', 'right']) {
      assert.strictEqual(plan.margins[side].length, 3, `${season}: three in the ${side} margin`);
      for (const it of plan.margins[side]) {
        thingOk(season, side, it);
        assert.ok(['top', 'middle', 'bottom'].includes(it.v) && it.k >= 4 && ART.size(it.s).w * it.k <= 96, `${season} ${side}: ${it.s} fits a 100px margin`);
      }
    }
    for (const it of plan.flyers || []) { thingOk(season, 'flyers', it); assert.ok(it.t >= 0 && it.t <= 90 && ['fly', 'flutter'].includes(it.move), `${season}: ${it.s} crosses the page`); }
  }
  // The pictures as images: SVG, crisp, the colours as given.
  const uri = ART.svgUri('pumpkin');
  assert.ok(/^url\("data:image\/svg\+xml,%3Csvg/.test(uri));
  const svg = decodeURIComponent(uri.slice(29, -2));
  assert.ok(/shape-rendering="crispEdges"/.test(svg) && /fill="#ff8a1f"/.test(svg) && /width="24" height="10"/.test(svg));
  assert.ok(/fill="#ff4d4d"/.test(decodeURIComponent(ART.svgUri('burst', ART.BURSTS.red))), 'a firework in another colour');
  assert.ok(/fill="#f2efe6"/.test(decodeURIComponent(ART.svgUri('pumpkin', ART.TINTS.whitePumpkin))), 'a white pumpkin');
});

/** Just enough of a page for 8bit/seasons.js: <html>, <head>, <body>, #app with its header, summary and disclaimer, and what follows. */
function artPage(opts = {}) {
  const make = (tag) => {
    const el = {
      tagName: tag.toUpperCase(), children: [], parentNode: null, attrs: {}, className: '', id: '', textContent: '', listeners: {},
      style: { setProperty(k, v) { this[k] = v; } },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      insertBefore(c, ref) { c.parentNode = this; const i = this.children.indexOf(ref); if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
      removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; return c; },
      addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      get firstChild() { return this.children[0] || null; },
      get nextSibling() { const p = this.parentNode; return p ? p.children[p.children.indexOf(this) + 1] || null : null; },
    };
    return el;
  };
  const root = make('html'), head = make('head'), body = make('body'), app = make('div'), header = make('div'), summary = make('div');
  const disclaimer = make('div'), footer = make('div');
  app.id = 'app'; header.className = 'header'; summary.className = 'dash-top'; disclaimer.id = 'site-disclaimer'; footer.className = 'license';
  root.appendChild(head); root.appendChild(body); body.appendChild(app);
  for (const el of [header, summary, disclaimer, footer]) app.appendChild(el);
  const all = (n) => [n, ...n.children.flatMap(all)];
  const is = (el, sel) => sel.split(',').some(s => (s = s.trim(), s[0] === '#' ? el.id === s.slice(1) : s[0] === '.' && el.className.split(' ').includes(s.slice(1))));
  const doc = {
    documentElement: root, head, body, readyState: opts.readyState || 'complete', listeners: {},
    createElement: make, getElementById: (id) => all(root).find(e => e.id === id) || null,
    querySelector: (sel) => all(root).find(e => is(e, sel)) || null,
    querySelectorAll: (sel) => all(root).filter(e => is(e, sel)),
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
  };
  return { doc, root, head, body, app, header, all: () => all(root) };
}
const flat = (el) => [el, ...el.children.flatMap(flat)];

test('on a page: a scene above the header and one after the disclaimer, things on the header\'s line, the margins, things crossing behind the page - hidden from screen readers, never in the way of a tap', () => {
  for (const season of SEASON_NAMES) {
    const p = artPage();
    const added = ART.build(p.doc, season, { width: 1024, random: () => 0.5 });
    const names = p.app.children.map(e => e.id || e.className);
    assert.deepStrictEqual(names, [`px-scene px-${season}`, 'header', 'dash-top', 'site-disclaimer', `px-scene px-bottom px-${season}`, 'license'], `${season}: where the scenes go`);
    const ground = p.header.children.find(e => e.className === 'px-ground');
    const margins = p.body.children.find(e => e.className === 'px-margins');
    assert.ok(ground && margins, season);
    assert.strictEqual(margins.children.length, 6, `${season}: three a side`);
    assert.strictEqual(!!p.body.children.find(e => e.className === 'px-flyers'), !!ART.SCENES[season].flyers, `${season}: flyers`);
    for (const el of added.filter(e => e.tagName !== 'STYLE')) assert.strictEqual(el.getAttribute('aria-hidden'), 'true', `${season}: ${el.className}`);
    const css = p.head.children.find(e => e.id === 'px-season-css').textContent;
    for (const c of ['px-scene', 'px-ground', 'px-margins', 'px-flyers', 'px-snow']) assert.ok(new RegExp(`\\.${c}\\{[^}]*pointer-events:none`).test(css), `${c} takes no taps`);
    assert.ok(/\.px-scene i,\.px-scene b,\.px-ground i,\.px-ground b,\.px-margins i,\.px-margins b,\.px-flyers i,\.px-flyers b,\.px-snow i\{[^}]*pointer-events:none/.test(css));
    // Crossing behind the page's boxes and words (the column is z-index 1); only the snow falls in front.
    assert.ok(/\.px-flyers\{[^}]*z-index:0;/.test(css) && /\.px-margins\{[^}]*z-index:0;/.test(css) && /\.px-snow\{[^}]*z-index:5;/.test(css));
    // Framed as each page frames its boxes.
    assert.ok(css.includes(':root:not([data-theme="8bit"]) .px-scene{border:1px solid var(--border);border-radius:14px;box-shadow:none;}'));
    assert.ok(/\.px-scene\{[^}]*border:4px solid var\(--px-line\);box-shadow:4px 4px 0 var\(--px-shadow\)/.test(css));
    // Nothing but the site's own pictures: data: addresses made here, no text, no links, nothing to focus.
    for (const el of added.flatMap(flat)) {
      const bg = el.style.backgroundImage;
      if (bg) assert.ok(/^url\("data:image\/svg\+xml,/.test(bg), bg.slice(0, 40));
      assert.ok(['DIV', 'I', 'B', 'STYLE'].includes(el.tagName), el.tagName);
      if (el.tagName !== 'STYLE') assert.strictEqual(el.textContent, '');
    }
    // The frames for every sprite that moves frame by frame.
    for (const id of new Set(added.flatMap(flat).flatMap(e => [...String(e.style.animation || '').matchAll(/px-(?:f|flick|burst|tw|patrol)-([a-z0-9]+-\d)/g)].map(m => m[1])))) {
      assert.ok(css.includes(`-${id}{`), `${season}: the frames for ${id}`);
    }
  }
  // A page without the disclaimer: the bottom scene last in #app.
  const q = artPage();
  q.app.children = q.app.children.filter(e => e.id !== 'site-disclaimer');
  ART.build(q.doc, 'easter', { width: 1024 });
  assert.strictEqual(q.app.children[q.app.children.length - 1].className, 'px-scene px-bottom px-easter');
  // No way for anything from outside into the page: no HTML from strings, no network, no eval.
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|import\(/.test(ART_SRC));
  assert.deepStrictEqual([...ART_SRC.matchAll(/https?:\/\/[^\s"'`]+/g)].map(m => m[0]), ['http://www.w3.org/2000/svg'], 'no address but the SVG namespace');
});

test('more on a wide screen: every thing on a page 600px wide or more, a phone the ones marked for it - and the scenes in proportion', () => {
  const count = (plan, wide) => plan.things.filter(it => wide || !it.wide).length;
  for (const season of SEASON_NAMES) {
    const plan = ART.SCENES[season];
    for (const [width, wide] of [[1024, true], [375, false]]) {
      const p = artPage();
      ART.build(p.doc, season, { width });
      const [top] = p.app.children, bottom = p.app.children.find(e => /px-bottom/.test(e.className));
      const own = (el) => el.children.filter(e => !/px-(sky|tile)/.test(e.className)).length;
      assert.strictEqual(own(top), count(plan.top, wide), `${season} at ${width}: the top scene`);
      assert.strictEqual(own(bottom), count(plan.bottom, wide), `${season} at ${width}: the bottom scene`);
      const flyers = p.body.children.find(e => e.className === 'px-flyers');
      if (plan.flyers) assert.strictEqual(flyers.children.length, plan.flyers.filter(it => wide || !it.wide).length, `${season} at ${width}: flyers`);
    }
    assert.ok(count(plan.top, true) > count(plan.top, false), `${season}: more above the header on a wide screen`);
    assert.ok(count(plan.top, false) >= 6, `${season}: a phone still gets a scene`);
  }
});

test('motion turned down: nothing moves, nothing crosses, no snow, the fireworks shown at their widest - and the styles stop motion too', () => {
  for (const season of SEASON_NAMES) {
    const p = artPage();
    const added = ART.build(p.doc, season, { width: 1024, still: true });
    assert.ok(!added.some(e => e.className === 'px-snow' || e.className === 'px-flyers'), `${season}: no snow, nothing crossing`);
    for (const el of added.flatMap(flat)) assert.ok(!el.style.animation, `${season}: ${el.className || el.tagName} moves`);
  }
  const p = artPage();
  ART.build(p.doc, 'july4', { width: 1024, still: true });
  const bursts = p.all().filter(e => /%23ff4d4d|%236cb6ff/.test(e.style.backgroundImage || ''));
  assert.ok(bursts.length >= 4 && bursts.every(b => b.style.backgroundPosition === '-90px 0'), 'the third picture of five, at 3 pixels a pixel');
  const css = p.head.children[0].textContent;
  assert.ok(/@media \(prefers-reduced-motion: reduce\)\{\.px-scene \*,\.px-ground \*,\.px-margins \*\{animation:none !important;\}\.px-snow,\.px-flyers\{display:none;\}\}/.test(css));
  assert.ok(/@media print\{\.px-scene,\.px-ground,\.px-margins,\.px-flyers,\.px-snow\{display:none;\}\}/.test(css), 'and none on paper');
});

test('snow at Christmas and the New Year only: 18 flakes on a phone, 36 wider, spread across the page; the scenes at 2 pixels a pixel on a phone, 3 wider', () => {
  const flakes = (season, width) => {
    const p = artPage();
    let i = 0;
    const added = ART.build(p.doc, season, { width, random: () => ((i++ * 0.37) % 1) });
    const snow = added.find(e => e.className === 'px-snow');
    return snow ? snow.children : [];
  };
  assert.strictEqual(flakes('christmas', 375).length, 18);
  assert.strictEqual(flakes('newyear', 1280).length, 36);
  for (const s of ['halloween', 'easter', 'july4']) assert.strictEqual(flakes(s, 1280).length, 0, s);
  const lefts = flakes('christmas', 1280).map(f => parseFloat(f.style.left));
  assert.ok(lefts.every(l => l >= 0 && l <= 100) && Math.max(...lefts) - Math.min(...lefts) > 60, 'across the page');
  assert.ok(flakes('christmas', 1280).every(f => /^px-fall [\d.]+s linear -[\d.]+s infinite$/.test(f.style.animation)), 'already falling when the page opens');
  const moonAt = (width) => { const p = artPage(); ART.build(p.doc, 'halloween', { width }); return p.app.children[0].children.find(e => /%23fff1b8/.test(e.style.backgroundImage || '')).style.width; };
  assert.deepStrictEqual([moonAt(375), moonAt(599), moonAt(600), moonAt(1280)], ['24px', '24px', '36px', '36px']);
});

test('an unknown season draws nothing; clear() takes a season out again, all of it', () => {
  const p = artPage();
  const page = () => p.all().map(e => e.tagName + (e.id ? '#' + e.id : '') + (e.className ? '.' + e.className : ''));
  const before = page();
  assert.deepStrictEqual(before, ['HTML', 'HEAD', 'BODY', 'DIV#app', 'DIV.header', 'DIV.dash-top', 'DIV#site-disclaimer', 'DIV.license']);
  assert.deepStrictEqual(ART.build(p.doc, 'xmas', {}), []);
  assert.deepStrictEqual(page(), before, 'the page as it was');
  ART.build(p.doc, 'christmas', { width: 1024 });
  assert.ok(page().length > before.length + 40);
  ART.clear(p.doc);
  assert.deepStrictEqual(page(), before, 'nothing left of it');
});

test('in the page: drawn once the page is there, for the season <html> names - again when the window crosses 600px or motion is turned down - and never an error', () => {
  const run = (season, opts = {}) => {
    const p = artPage({ readyState: 'loading' });
    if (season) p.root.setAttribute('data-season', season);
    const mqs = {};
    const window = { innerWidth: opts.width || 1280, matchMedia: (q) => (mqs[q] = { matches: q.includes('reduce') ? !!opts.still : (opts.width || 1280) >= 600, handlers: [], addEventListener(t, f) { this.handlers.push(f); } }) };
    vm.runInNewContext(ART_SRC, { window, document: p.doc, Math, Object, Array, Set, String, Number, encodeURIComponent, Error });
    return { p, mqs, window };
  };
  const { p, mqs, window } = run('easter');
  assert.strictEqual(p.app.children[0], p.header, 'nothing before the page is there');
  p.doc.listeners.DOMContentLoaded.forEach(f => f());
  assert.strictEqual(p.app.children[0].className, 'px-scene px-easter');
  // Narrower than 600px now: drawn again at 2 pixels a pixel - one of each, not two.
  const cloudWidth = () => p.app.children[0].children.find(e => /%23d6ecfb/.test(e.style.backgroundImage || '')).style.width;
  assert.strictEqual(cloudWidth(), '45px', 'a cloud, 15 pixels at 3');
  window.innerWidth = 375;
  assert.ok(mqs['(min-width: 600px)'].handlers.length, 'it listens for the width');
  mqs['(min-width: 600px)'].handlers.forEach(f => f());
  assert.strictEqual(cloudWidth(), '30px', 'and at 2');
  for (const cls of ['px-scene px-easter', 'px-scene px-bottom px-easter', 'px-ground', 'px-margins', 'px-flyers']) {
    assert.strictEqual(p.all().filter(e => e.className === cls).length, 1, cls);
  }
  assert.strictEqual(p.all().filter(e => e.id === 'px-season-css').length, 1);
  // Motion turned down while the page is open: drawn again, still.
  mqs['(prefers-reduced-motion: reduce)'].matches = true;
  mqs['(prefers-reduced-motion: reduce)'].handlers.forEach(f => f());
  assert.ok(p.all().every(e => !(e.style && e.style.animation)));
  assert.strictEqual(p.all().filter(e => e.className === 'px-flyers').length, 0);
  // No season, or one it does not know: nothing at all.
  for (const s of [null, 'xmas']) {
    const r = run(s);
    assert.deepStrictEqual(Object.keys(r.p.doc.listeners), [], String(s));
  }
  // A page without its #app or header (an error page): no error.
  const q = run('halloween');
  q.p.app.children = [];
  assert.doesNotThrow(() => q.p.doc.listeners.DOMContentLoaded.forEach(f => f()));
});

// ── run ──
(async () => {
  for (const [name, fn] of queue) {
    if (name === null) { console.log(`\n${fn}\n${'-'.repeat(fn.length)}`); continue; }
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`); }
  }
  console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failed} failed\n${'='.repeat(60)}`);
  if (failed) process.exit(1);
})();
