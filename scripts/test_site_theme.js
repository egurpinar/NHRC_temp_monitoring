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
 *
 * Before release (October 2026) the page was also checked in a real browser
 * engine, both themes, at widths from 320 to 900px: every element's real
 * text-on-background contrast, every status colour, the switch's place, size
 * and focus ring, and dark mode element by element against the old page.
 * The 8-bit look likewise in November 2026, on the live data: all 218 pieces of
 * text at least 5.6:1, nothing wider than a 320px screen.
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
  const palettes = [style.indexOf(':root{'), style.indexOf('}', style.indexOf(':root[data-theme="8bit"]{'))];
  assert.ok(style.indexOf(':root[data-theme="light"]{') < style.indexOf(':root[data-theme="8bit"]{'), 'the three palettes together, at the top');
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
