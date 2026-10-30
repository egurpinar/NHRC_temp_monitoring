#!/usr/bin/env node
/**
 * Tests for the hazard map with the wind on the main page (index.html,
 * map/wind-map.js), and the old trial address that now points to it.
 *
 *  1. The wind in words: compass points, calm, gusts only when stronger,
 *     missing values shown as missing - never as 0.
 *  2. Headwind, crosswind, tailwind on the lanes: the geometry, both ways.
 *  3. Now and the 24 hours: now is the airport's measured reading (from the
 *     weather card), the hours ahead the forecast for the dock - never the
 *     model's own "now".
 *  4. The page itself, run with stand-ins for the browser and Leaflet: what
 *     is drawn, in which colours, what the popups say (as text, never as
 *     markup), the slider, the badge, and what happens when the map library,
 *     the map data or the forecast cannot be loaded.
 *  5. The page's markup: kept out of search engines, the credits the data's
 *     licences ask for, the libraries pinned by hash, no keys.
 *
 * Run: node scripts/test_map.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../map/wind-map.js');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const TRIAL = fs.readFileSync(path.join(ROOT, 'trial', 'index.html'), 'utf8');
const MAP_DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'map', 'hazard-map.json'), 'utf8'));

let passed = 0, failed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push([name, fn]); }
function section(t) { queue.push([null, t]); }

// ── Stand-ins: a little of the browser, and of Leaflet ───────────────────────

function fakeElement(tag, doc) {
  const e = {
    tagName: String(tag).toUpperCase(), children: [], attrs: {}, listeners: {}, style: {}, className: '', _text: '',
    value: '', max: '', disabled: false, type: '',
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); },
    set textContent(v) { this._text = String(v); this.children = []; },
    set innerHTML(v) { doc.innerHTMLWrites.push(String(v)); this._text = String(v); this.children = []; },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    dispatch(t, ev = {}) { (this.listeners[t] || []).forEach((f) => f(ev)); },
    getBoundingClientRect: () => ({ width: 400, height: 300, left: 0, top: 0 }),
    clientWidth: 400, clientHeight: 300,
    classes: new Set(),
    get classList() {
      const s = this.classes;
      return { toggle: (c, on) => { if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); }, contains: (c) => s.has(c) };
    },
    // The wind's canvas records into doc.ctx; no other canvas is drawn on.
    getContext() { return this.className === 'wind-canvas' ? doc.ctx : null; },
    click() { this.dispatch('click'); },
  };
  return e;
}

function fakeEnv(opts = {}) {
  const doc = {
    innerHTMLWrites: [], listeners: {}, visibilityState: 'visible', readyState: 'complete', byId: {},
    ctx: null,
    createElement: (t) => fakeElement(t, doc),
    createElementNS: (ns, t) => fakeElement(t, doc),
    getElementById: (id) => doc.byId[id] || null,
    addEventListener(t, f) { (doc.listeners[t] = doc.listeners[t] || []).push(f); },
  };
  const calls = [];
  doc.ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (...a) => calls.push([k, ...a])), set: (o, k, v) => { o[k] = v; return true; } });
  for (const id of ['hazard-map', 'map-status', 'wind-time', 'wind-time-label', 'wind-line', 'wind-conditions', 'wind-source', 'wind-course', 'wind-status', 'wind-now', 'wind-play', 'map-copied', 'hazard-key', 'map-tools']) {
    if (opts.withoutMapBox && id === 'hazard-map') continue;
    doc.byId[id] = fakeElement(id === 'wind-time' ? 'input' : 'div', doc);
  }
  // The row the wind's words sit in, as on the page: it is the one read out.
  doc.liveRow = fakeElement('div', doc);
  doc.byId['wind-line'].parentNode = doc.liveRow;
  const frames = [];
  const win = {
    devicePixelRatio: 2, timers: [],
    matchMedia: (q) => ({ matches: !!(opts.reduceMotion && /reduce/.test(q)) }),
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    cancelAnimationFrame: () => {},
    setInterval(f, ms) { this.timers.push([f, ms]); return this.timers.length; },
    // One-off timers (the loop through the hours): kept to be run by hand.
    timeouts: [],
    setTimeout(f, ms) { this.timeouts.push({ f, ms, live: true }); return this.timeouts.length; },
    clearTimeout(id) { if (this.timeouts[id - 1]) this.timeouts[id - 1].live = false; },
    pending() { return this.timeouts.filter((t) => t.live); },
    tick() { const t = this.pending().slice(-1)[0]; if (!t) return null; t.live = false; t.f(); return t.ms; },
    // The weather card's airport reading, as the page leaves it, and its event.
    NHRC_STATION: Object.prototype.hasOwnProperty.call(opts, 'station') ? opts.station : STATION,
    listeners: {},
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    station(detail) { (this.listeners['nhrc-station'] || []).forEach((f) => f({ detail })); },
  };
  const leaflet = fakeLeaflet(doc);
  const answers = Object.assign({ forecast: { ok: true, body: sampleForecast() }, map: { ok: true, body: MAP_DATA } }, opts.answers || {});
  const fetched = [];
  const fetch = async (url) => {
    fetched.push(url);
    if (url !== W.MAP_DATA_URL && opts.forecastGate) await opts.forecastGate;   // a slow forecast
    const a = url === W.MAP_DATA_URL ? answers.map : answers.forecast;
    if (a.throws) throw new Error('offline');
    return { ok: a.ok, status: a.ok ? 200 : 503, json: async () => (a.badJson ? Promise.reject(new Error('bad json')) : JSON.parse(JSON.stringify(a.body))) };
  };
  return { document: doc, window: win, L: opts.noLeaflet ? undefined : leaflet, fetch, frames, calls, fetched, leaflet };
}

function fakeLeaflet(doc) {
  const made = { layers: [], controls: [], tiles: [], panes: {}, groups: [], maps: [] };
  const layer = (kind, coords, o) => ({
    kind, coords, o: o || {}, popup: null,
    bindPopup(fn, po) { this.popup = fn; this.popupOptions = po; return this; },
    addTo(t) { (t.items || (t.items = [])).push(this); made.layers.push(this); return this; },
  });
  const L = {
    made,
    map(el, o) {
      const m = {
        el, o, views: [], handlers: {}, items: [], zoom: 13, removed: [],
        fitBounds(b, fo) { this.views.push(['fit', b]); this.fitOptions = fo; return this; },
        setView(c, z) { this.views.push(['view', c, z]); return this; },
        getZoom() { return this.zoom; },
        removeLayer(x) { this.removed.push(x); if (x) x.onMap = false; return this; },
        fire(t) { (this.handlers[t] || []).forEach((f) => f({})); },
        createPane(n) { made.panes[n] = Object.assign(doc.createElement('div'), { style: {} }); return made.panes[n]; },
        containerPointToLayerPoint(p) { return { x: p[0] - 7, y: p[1] - 3 }; },
        latLngToContainerPoint(ll) { return { x: (ll[1] + 73.16) * 6000, y: (41.38 - ll[0]) * 6000 }; },
        getPane(n) { return made.panes[n]; },
        on(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f); return this; },
        invalidateSize() {},
      };
      made.maps.push(m);
      return m;
    },
    tileLayer(url, o) {
      const t = { url, o, handlers: {}, addTo(m) { made.tiles.push(this); return this; },
        on(type, f) { (this.handlers[type] = this.handlers[type] || []).push(f); return this; },
        fire(type) { (this.handlers[type] || []).forEach((f) => f({})); } };
      made.tileLayers = (made.tileLayers || []).concat(t);
      return t;
    },
    control: Object.assign((o) => {
      const c = { o, container: null, addTo(m) { this.container = this.onAdd(m); made.controls.push(this); return this; }, getContainer() { return this.container; } };
      return c;
    }, { layers: (base, over, o) => ({ base, o, addTo() { made.controls.push(this); return this; } }),
      zoom: (o) => ({ zoom: true, o, addTo() { made.controls.push(this); return this; } }) }),
    DomUtil: { create: (t, cls) => { const e = doc.createElement(t); e.className = cls; return e; },
      setPosition: (e, pt) => { e.position = pt; } },
    DomEvent: { disableClickPropagation() {}, disableScrollPropagation() {} },
    layerGroup(list) {
      const g = { items: (list || []).slice(), onMap: false,
        addTo(m) { this.onMap = true; made.groups.push(this); return this; },
        addLayer(x) { this.items.push(x); return this; },
        removeLayer(x) { this.items = this.items.filter((y) => y !== x); return this; },
        hasLayer(x) { return this.items.includes(x); } };
      return g;
    },
    polygon: (c, o) => layer('polygon', c, o),
    polyline: (c, o) => layer('polyline', c, o),
    circleMarker: (c, o) => layer('circle', c, o),
    marker: (c, o) => layer('marker', c, o),
    icon: (o) => ({ iconOptions: o }),
    latLngBounds: (pts) => ({ pts }),
  };
  return L;
}

/** An Open-Meteo answer: now 14:20 Eastern on 18 October 2026, and 60 hours from 13:00. */
const NOW = Date.UTC(2026, 9, 18, 18, 20);                     // 14:20 EDT
/** The airport's reading at 14:15, as the weather card hands it over (readStation, with the station's name). */
const STATION = { atMs: NOW - 5 * 60000, tempF: 54, windMph: 12, dir: 'NW', deg: 315, gustMph: 19, humidity: 70, feelsF: null,
  cond: 'Mostly Cloudy', code: 3, name: 'Waterbury-Oxford Airport', where: 'on a hilltop 7.6 mi north of the dock' };
function sampleForecast() {
  const t0 = Date.UTC(2026, 9, 18, 17) / 1000;                 // 13:00 EDT
  const n = 60, time = [], sp = [], gu = [], dir = [], tmp = [], pp = [], code = [];
  for (let i = 0; i < n; i++) {
    time.push(t0 + i * 3600); sp.push(5 + (i % 10)); gu.push(12 + (i % 10)); dir.push((i * 15) % 360);
    tmp.push(50 + (i % 7)); pp.push((i * 5) % 100); code.push(i % 2 ? 2 : 61);
  }
  return {
    utc_offset_seconds: -14400,
    current: { time: Math.floor(NOW / 1000), wind_speed_10m: 11.6, wind_gusts_10m: 19.4, wind_direction_10m: 315, temperature_2m: 54.4, weather_code: 3 },
    hourly: { time, wind_speed_10m: sp, wind_gusts_10m: gu, wind_direction_10m: dir, temperature_2m: tmp, precipitation_probability: pp, weather_code: code },
  };
}

async function started(opts = {}) {
  const env = fakeEnv(opts);
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const run = W.init(env);
    await run.forecast;
    if (run.drawn) await run.drawn;
    return Object.assign(env, { run, $: (id) => env.document.byId[id] });
  } finally {
    Date.now = realNow;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
section('1. The wind in words');

test('compass points, all sixteen, and directions past 360 or below 0', () => {
  assert.deepStrictEqual([0, 22.5, 45, 90, 135, 180, 225, 270, 315, 337.5, 359, 360, -45].map(W.compass),
    ['N', 'NNE', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'NNW', 'N', 'N', 'NW']);
});

test('"12 mph from the NW, gusts 20" - gusts only when they are stronger; calm; missing', () => {
  assert.strictEqual(W.windText({ speed: 11.6, gust: 19.6, from: 315 }), '12 mph from the NW, gusts 20');
  assert.strictEqual(W.windText({ speed: 11.6, gust: 12.2, from: 315 }), '12 mph from the NW', 'a gust no stronger is not news');
  assert.strictEqual(W.windText({ speed: 11.6, gust: null, from: 315 }), '12 mph from the NW');
  assert.strictEqual(W.windText({ speed: 0.4, gust: 3, from: 200 }), 'Calm');
  assert.strictEqual(W.windText({ speed: 7, gust: 9, from: null }), '7 mph, gusts 9', 'no direction: none made up');
  assert.strictEqual(W.windText({ speed: null, from: 200 }), 'Wind not available', 'never "0 mph"');
  assert.strictEqual(W.windText(undefined), 'Wind not available');
});

test('the conditions: temperature, sky, chance of rain - each only when known', () => {
  assert.strictEqual(W.conditionsText({ temp: 54.4, code: 2, rain: 10 }), '54°F · Partly cloudy · 10% chance of rain');
  assert.strictEqual(W.conditionsText({ temp: null, code: 95, rain: null }), 'Thunderstorm');
  assert.strictEqual(W.conditionsText({ temp: 0, code: 0, rain: 0 }), '0°F · Clear · 0% chance of rain', 'real zeros are kept');
  assert.strictEqual(W.conditionsText({ temp: null, code: 1234, rain: null }), '');
});

test('the arrow points downwind: a wind from the north-west blows towards the south-east', () => {
  assert.strictEqual(W.arrowRotation(315), 135);
  assert.strictEqual(W.arrowRotation(0), 180);
  assert.strictEqual(W.arrowRotation(180), 0);
  assert.strictEqual(W.arrowRotation(-90), 90);
});

// ═════════════════════════════════════════════════════════════════════════════
section('2. Headwind, crosswind, tailwind on the lanes');

const lanes = [];
for (const f of MAP_DATA.folders) {
  const d = W.laneDirection(f.name);
  for (const x of f.features) if (d && x.type === 'polygon') lanes.push({ name: x.name, direction: d, edge: W.laneEdge(x.coords) });
}

test('bearings and distances: north is 0, east 90; a degree of latitude is 111 km', () => {
  assert.ok(Math.abs(W.bearing([41, -73], [42, -73]) - 0) < 0.01);
  assert.ok(Math.abs(W.bearing([41, -73], [41, -72]) - 90) < 1);
  assert.ok(Math.abs(W.bearing([41, -73], [40, -73]) - 180) < 0.01);
  assert.ok(Math.abs(W.distance([41, -73], [42, -73]) - 111195) < 100);
});

test('rowing into the wind is a headwind, with it a tailwind; 45° and 135° are the edges', () => {
  assert.strictEqual(W.windOnBoat(135, 135), 'head');
  assert.strictEqual(W.windOnBoat(315, 135), 'tail');
  assert.strictEqual(W.windOnBoat(180, 135), 'head', '45° off the bow');
  assert.strictEqual(W.windOnBoat(181, 135), 'cross');
  assert.strictEqual(W.windOnBoat(270, 135), 'tail', '135° off the bow');
  assert.strictEqual(W.windOnBoat(269, 135), 'cross');
  assert.strictEqual(W.windOnBoat(10, 350), 'head', 'across north');
});

test('each lane\'s edge runs from its north end to its south end - the way the river runs', () => {
  assert.strictEqual(lanes.length, 6);
  for (const l of lanes) {
    assert.ok(l.edge.length > 5, l.name);
    assert.ok(l.edge[0][0] > l.edge[l.edge.length - 1][0], `${l.name} runs south`);
    const b = W.bearing(l.edge[0], l.edge[l.edge.length - 1]);
    assert.ok(b > 120 && b < 165, `${l.name}: the lake runs south-east (${b.toFixed(0)}°)`);
  }
  assert.deepStrictEqual(W.laneEdge([[1, 1], [1, 1]]), [], 'a ring with nothing to it');
});

test('a north-west wind: tailwind all the way down, headwind all the way back', () => {
  const t = W.courseText({ speed: 12, from: 315 }, lanes);
  assert.ok(/^Going downstream: mostly tailwind \((9\d|100)%\)\. Coming back upstream: mostly headwind \((9\d|100)%\)\.$/.test(t), t);
});

test('a south-east wind is the reverse; NE and SW winds are crosswinds both ways', () => {
  assert.ok(/downstream: mostly headwind.*upstream: mostly tailwind/.test(W.courseText({ speed: 12, from: 135 }, lanes)));
  for (const from of [45, 225]) assert.ok(/downstream: mostly crosswind.*upstream: mostly crosswind/.test(W.courseText({ speed: 12, from }, lanes)), String(from));
});

test('calm, no wind, or no lanes yet: no course words made up', () => {
  assert.strictEqual(W.courseText({ speed: 0.3, from: 315 }, lanes), 'Calm on the course.');
  assert.strictEqual(W.courseText({ speed: null, from: 315 }, lanes), '');
  assert.strictEqual(W.courseText({ speed: 12, from: 315 }, []), '');
  assert.strictEqual(W.courseText(undefined, lanes), '');
});

test('one lane\'s popup: rowing upstream in an upstream lane, downstream in a downstream one', () => {
  const up = lanes.find((l) => l.name === 'Upstream Section 2'), down = lanes.find((l) => l.name === 'Downstream Section 2');
  assert.ok(/^Rowing upstream here: mostly headwind/.test(W.laneText({ speed: 10, from: 315 }, up)));
  assert.ok(/^Rowing downstream here: mostly tailwind/.test(W.laneText({ speed: 10, from: 315 }, down)));
  assert.strictEqual(W.laneText({ speed: 0, from: 315 }, up), 'Calm.');
});

test('which way a folder\'s lanes are rowed, from its name', () => {
  assert.strictEqual(W.laneDirection('Downstream 1'), 'downstream');
  assert.strictEqual(W.laneDirection('Upstream'), 'upstream');
  assert.strictEqual(W.laneDirection('Hazards'), null);
  assert.strictEqual(W.laneDirection('Upstreamish'), null);
});

// ═════════════════════════════════════════════════════════════════════════════
section('3. The forecast: now, then 24 hours');

test('the forecast: this hour and the next 24, whole hours in Eastern time - and the model\'s own "current" is never used', () => {
  const s = W.forecastSlots(sampleForecast(), NOW);
  assert.strictEqual(s.length, 25);
  assert.deepStrictEqual([s[0].label, s[0].isNow, s[0].forecast, s[0].speed, s[0].from, s[0].temp, s[0].rain], ['Now', true, true, 6, 15, 51, 5],
    'the 14:00 hour - not the answer\'s "current" block (11.6 mph from the NW)');
  assert.strictEqual(s[1].label, 'Sun 3 PM');
  assert.strictEqual(s[24].label, 'Mon 2 PM');
  assert.ok(s.every((x, i) => x.t === NOW - 20 * 60000 + i * 3600000 && x.forecast), 'whole hours, in order, all forecasts');
  // Missing numbers stay missing.
  const fc = sampleForecast();
  fc.hourly.wind_gusts_10m[1] = null;
  fc.hourly.temperature_2m[2] = 'warm';
  const m = W.forecastSlots(fc, NOW);
  assert.deepStrictEqual([m[0].gust, m[1].temp], [null, null]);
});

test('now is the airport\'s measured reading when the weather card has one under 2 hours old - otherwise the forecast\'s hour, said to be one', () => {
  const fc = W.forecastSlots(sampleForecast(), NOW);
  const s = W.withStation(fc, STATION, NOW);
  assert.strictEqual(s.length, 25, 'the measured now takes the forecast hour\'s place');
  assert.deepStrictEqual([s[0].measured, s[0].isNow, s[0].label, s[0].speed, s[0].gust, s[0].from, s[0].temp, s[0].rain, s[0].cond],
    [true, true, 'Now', 12, 19, 315, 54, null, 'Mostly Cloudy']);
  assert.strictEqual(s[1], fc[1], 'the hours ahead are the forecast\'s');
  assert.strictEqual(W.sourceText(s[0]), 'Measured at Waterbury-Oxford Airport, on a hilltop 7.6 mi north of the dock, at 2:15 PM.');
  assert.strictEqual(W.slotName(s[0]), 'Now, measured at the airport');
  assert.strictEqual(W.conditionsText(s[0]), '54°F · Mostly Cloudy', 'the station\'s own words; no chance of rain is measured');
  assert.deepStrictEqual([W.slotName(fc[0]), W.slotName(fc[1]), W.sourceText(fc[1])],
    ['Now (forecast)', 'Sun 3 PM (forecast)', 'Forecast for the dock, from weather models.']);
  // Not current, or not a reading: the forecast's own hour stays.
  assert.strictEqual(W.withStation(fc, Object.assign({}, STATION, { atMs: NOW - 121 * 60000 }), NOW), fc, 'over 2 hours old');
  assert.strictEqual(W.withStation(fc, Object.assign({}, STATION, { atMs: NOW - 120 * 60000 }), NOW)[0].measured, true, '2 hours exactly is still now');
  for (const bad of [null, undefined, {}, Object.assign({}, STATION, { tempF: null }), Object.assign({}, STATION, { windMph: 'x' })]) {
    assert.strictEqual(W.withStation(fc, bad, NOW), fc, JSON.stringify(bad));
  }
  // A calm or a shifting wind has no direction to draw; no forecast still gives the reading.
  assert.strictEqual(W.withStation(fc, Object.assign({}, STATION, { windMph: 0, deg: 0 }), NOW)[0].from, null);
  assert.strictEqual(W.withStation(fc, Object.assign({}, STATION, { deg: null }), NOW)[0].from, null);
  assert.deepStrictEqual(W.withStation([], STATION, NOW).map((x) => x.measured), [true]);
  assert.strictEqual(W.withStation(fc, Object.assign({}, STATION, { name: '' }), NOW)[0].station, 'the airport');
});

test('a forecast that is empty, broken or all in the past gives nothing to show - not a crash', () => {
  assert.deepStrictEqual(W.forecastSlots(null, NOW), []);
  assert.deepStrictEqual(W.forecastSlots({ hourly: {} }, NOW), []);
  const old = sampleForecast();
  old.hourly.time = old.hourly.time.map((t) => t - 10 * 86400);
  const s = W.forecastSlots(old, NOW);
  assert.ok(s.length === 1 && s[0].isNow, 'only its last hour, as now');
  const later = sampleForecast();
  later.hourly.time = later.hourly.time.map((t) => t + 10 * 86400);
  assert.deepStrictEqual(W.forecastSlots(later, NOW), [], 'a forecast that starts after now has no "now"');
});

test('the forecast is for the boathouse dock, in mph and °F, with times the page can trust', () => {
  const u = new URL(W.FORECAST_URL);
  assert.strictEqual(u.hostname, 'api.open-meteo.com');
  assert.deepStrictEqual([u.searchParams.get('latitude'), u.searchParams.get('longitude')], ['41.3685422', '-73.1478128'], 'the dock the club gave');
  assert.strictEqual(u.searchParams.get('wind_speed_unit'), 'mph');
  assert.strictEqual(u.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.strictEqual(u.searchParams.get('timeformat'), 'unixtime', 'instants, not local clock strings read as UTC');
  for (const v of ['wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'precipitation_probability']) assert.ok(u.searchParams.get('hourly').includes(v), v);
  assert.ok(Number(u.searchParams.get('forecast_days')) >= 2, 'enough for 24 hours from late in the day');
  assert.strictEqual(u.searchParams.get('current'), null, 'the model\'s "now" is never asked for');
});

// ═════════════════════════════════════════════════════════════════════════════
section('4. The page, with stand-ins for the browser and Leaflet');

const hazardPictures = (made) => made.layers.filter((x) => x.kind === 'marker' && x.o.icon.iconOptions.className === 'hz-icon');
const dockMarker = (made) => made.layers.find((x) => x.kind === 'marker' && x.o.icon.iconOptions.className === 'dock-icon');

test('the map: the lanes and areas, then the hazards on top with their pictures, in the Google map\'s colours', async () => {
  const p = await started();
  const L = p.leaflet.made;
  const polys = L.layers.filter((x) => x.kind === 'polygon'), pics = hazardPictures(L);
  assert.strictEqual(polys.length, 9);
  assert.strictEqual(pics.length, 12, 'nine hazards, and a picture in each swim area and on the ski course');
  assert.ok(polys.filter((x) => x.o.color === '#E65100').length === 3 && polys.filter((x) => x.o.color === '#0F9D58').length === 3);
  assert.ok(pics.every((d) => d.o.pane === 'hazards'), 'in their own pane, above the lanes and the moving wind');
  assert.strictEqual(L.panes.hazards.style.zIndex, '620');
  const dock = dockMarker(L);
  assert.deepStrictEqual(dock.coords, [41.3685422, -73.1478128]);
  assert.strictEqual(dock.o.pane, 'hazards');
  assert.deepStrictEqual(p.run.map.views.slice(-1)[0][0], 'fit', 'the whole lake, once its outline is in');
  assert.strictEqual(p.$('map-copied').textContent, MAP_DATA.copied);
});

test('the wind now: the airport\'s reading - badge, words, where it was measured, and the course', async () => {
  const p = await started();
  assert.strictEqual(p.$('wind-line').textContent, '12 mph from the NW, gusts 19');
  assert.strictEqual(p.$('wind-time-label').textContent, 'Now');
  assert.strictEqual(p.$('wind-conditions').textContent, '54°F · Mostly Cloudy');
  assert.strictEqual(p.$('wind-source').textContent, 'Measured at Waterbury-Oxford Airport, on a hilltop 7.6 mi north of the dock, at 2:15 PM.');
  assert.ok(/^Going downstream: mostly tailwind/.test(p.$('wind-course').textContent), p.$('wind-course').textContent);
  const badge = p.run.state.badge;
  assert.ok(/12 mph from the NW, gusts 19/.test(badge.textContent) && /Now, measured at the airport/.test(badge.textContent), badge.textContent);
  const g = badge.children[0].children.find((c) => c.tagName === 'G');
  assert.strictEqual(g.attrs.transform, 'rotate(135 20 20)', 'the arrow points downwind');
  assert.strictEqual(p.$('wind-time').max, '24');
  assert.strictEqual(p.$('wind-time').disabled, false);
});

test('the slider moves through the hours; "Now" comes back; the moving wind follows', async () => {
  const p = await started();
  const sl = p.$('wind-time');
  sl.value = '17';
  sl.dispatch('input');
  const s17 = p.run.state.slots[17];
  assert.strictEqual(p.$('wind-time-label').textContent, s17.label);
  assert.strictEqual(p.$('wind-line').textContent, W.windText(s17));
  assert.strictEqual(sl.attrs['aria-valuetext'], `${s17.label} (forecast): ${W.windText(s17)}`);
  assert.strictEqual(p.$('wind-source').textContent, 'Forecast for the dock, from weather models.');
  assert.strictEqual(p.run.state.wind.state.speed, s17.speed);
  sl.value = '999';
  sl.dispatch('input');
  assert.strictEqual(p.run.state.index, 24, 'held to the last hour');
  p.$('wind-now').click();
  assert.deepStrictEqual([p.run.state.index, sl.value, p.$('wind-time-label').textContent], [0, '0', 'Now']);
});

test('popups say the committee\'s words as text - and a lane\'s says the wind it has at that hour', async () => {
  const p = await started();
  const L = p.leaflet.made;
  const boulder = L.layers.find((x) => x.kind === 'marker' && x.coords[0] === 41.3687371);
  const box = boulder.popup();
  assert.strictEqual(box.children[0].textContent, 'Boulder');
  assert.strictEqual(box.children[1].textContent, 'There is a boulder in this area and it is shallow.');
  const lane = L.layers.find((x) => x.kind === 'polygon' && x.popup().children[0].textContent === 'Upstream Section 2');
  const words = lane.popup().textContent;
  assert.ok(/^Upstream Section 2Now, measured at the airport: 12 mph from the NW, gusts 19\. Rowing upstream here: mostly headwind/.test(words), words);
  assert.deepStrictEqual(p.document.innerHTMLWrites, [], 'nothing from the map data is ever written as markup');
});

test('no airport reading: now is the forecast\'s hour, and says so; a reading arriving later takes its place', async () => {
  const p = await started({ station: null });
  assert.strictEqual(p.$('wind-line').textContent, '6 mph from the NNE, gusts 13');
  assert.strictEqual(p.$('wind-conditions').textContent, '51°F · Partly cloudy · 5% chance of rain');
  assert.strictEqual(p.$('wind-source').textContent, 'Forecast for the dock, from weather models.');
  assert.ok(/Now \(forecast\)/.test(p.run.state.badge.textContent));
  // The weather card loads the airport's reading: the map takes it as now.
  const realNow = Date.now;
  Date.now = () => NOW;
  try { p.window.station(STATION); } finally { Date.now = realNow; }
  assert.strictEqual(p.$('wind-line').textContent, '12 mph from the NW, gusts 19');
  assert.strictEqual(p.run.state.slots.length, 25);
  assert.strictEqual(p.run.state.wind.state.speed, 12, 'the streaks follow');
  // And a refresh with no reading puts the forecast back.
  Date.now = () => NOW;
  try { p.window.station(null); } finally { Date.now = realNow; }
  assert.strictEqual(p.$('wind-line').textContent, '6 mph from the NNE, gusts 13');
});

test('a reading that has gone old by the time the forecast refreshes is no longer now', async () => {
  const p = await started();
  assert.strictEqual(p.run.state.slots[0].measured, true);
  const realNow = Date.now;
  Date.now = () => NOW + 3 * 3600000;
  try { await p.window.timers[0][0](); } finally { Date.now = realNow; }
  assert.ok(!p.run.state.slots[0].measured, 'three hours later, without a new reading: the forecast\'s hour');
});

test('markup in the map\'s text stays text', async () => {
  const evil = JSON.parse(JSON.stringify(MAP_DATA));
  evil.folders[2].features[1].name = '<img src=x onerror=alert(1)>';
  evil.folders[2].features[1].description = '<script>alert(1)</script>';
  const p = await started({ answers: { map: { ok: true, body: evil } } });
  const dot = p.leaflet.made.layers.find((x) => x.kind === 'marker' && x.coords[0] === 41.3687371);
  const box = dot.popup();
  assert.strictEqual(box.children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.strictEqual(dot.o.title, '<img src=x onerror=alert(1)>', 'the name as plain text for the tooltip');
  const svg = decodeURIComponent(dot.o.icon.iconOptions.iconUrl.split(',')[1]);
  assert.ok(!svg.includes('<img') && !svg.includes('onerror'), 'and never in the picture');
  assert.deepStrictEqual(p.document.innerHTMLWrites, []);
});

// ── The photos, and the hazards' pictures ────────────────────────────────────

function insidePolygon([lat, lon], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [yi, xi] = ring[i], [yj, xj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const photoGroup = (made) => made.groups.find((g) => g.items.some((t) => t.url === W.TILES.aerial.url || t.url === W.TILES.aerialBackup.url));

test('the map opens on the state\'s 2023 photos, the street map one tap away; the streaks are white on the photos', async () => {
  const p = await started();
  const L = p.leaflet.made;
  const sat = photoGroup(L);
  assert.ok(sat && sat.onMap, 'the photos are on the map from the start');
  assert.strictEqual(sat.items[0].url, 'https://cteco.uconn.edu/ctraster/rest/services/images/Ortho_2023_tiled/ImageServer/tile/{z}/{y}/{x}');
  const street = L.tileLayers.find((t) => t.url === W.TILES.map.url);
  assert.ok(!L.tiles.includes(street), 'the street map waits until it is asked for');
  assert.deepStrictEqual([W.TILES.aerial.options.maxNativeZoom, W.TILES.aerial.options.maxZoom], [20, 20], 'every bit of the 3-inch detail');
  assert.strictEqual(W.TILES.map.options.maxNativeZoom, 19, 'the street map, enlarged past its last level, not blank');
  assert.strictEqual(p.run.state.wind.state.color, 'rgba(255,255,255,.85)', 'white streaks on the photos');
  const swap = p.$('map-tools').children[2];
  swap.click();
  assert.deepStrictEqual([p.run.state.base, swap.textContent, sat.onMap, L.tiles.includes(street)], ['map', 'Satellite', false, true], 'the street map');
  assert.strictEqual(p.run.state.wind.state.color, 'rgba(11,58,74,.6)', 'dark streaks on the street map');
  swap.click();
  assert.deepStrictEqual([p.run.state.base, swap.textContent, sat.onMap], ['aerial', 'Street map', true], 'and back to the photos');
  assert.ok(p.run.map.removed.includes(street));
  assert.strictEqual(p.run.state.wind.state.color, 'rgba(255,255,255,.85)');
});

test('the map\'s own controls sit top right, over land: the lake runs from top left to bottom right', async () => {
  const p = await started();
  assert.strictEqual(p.run.map.o.zoomControl, false, 'not Leaflet\'s top-left default');
  const zoom = p.leaflet.made.controls.find((c) => c.zoom);
  assert.strictEqual(zoom.o.position, 'topright');
  const badge = p.leaflet.made.controls.find((c) => c.container && c.container.className === 'wind-badge');
  assert.strictEqual(badge.o.position, 'topright');
  assert.ok(p.leaflet.made.controls.indexOf(badge) < p.leaflet.made.controls.indexOf(zoom), 'the wind first, the zoom under it');
  assert.ok(!p.leaflet.made.controls.some((c) => c.base), 'no layer menu on the map: the switch is below it');
});

test('the pictures shrink with the whole lake in view, and are full size close in', async () => {
  const p = await started();
  const box = p.$('hazard-map'), m = p.run.map;
  const at = (z) => { m.zoom = z; m.fire('zoomend'); return [box.classList.contains('hz-far'), box.classList.contains('hz-mid')]; };
  assert.deepStrictEqual([box.classList.contains('hz-far'), box.classList.contains('hz-mid')], [true, false], 'the whole lake when it opens');
  assert.deepStrictEqual(at(13.5), [true, false]);
  assert.deepStrictEqual(at(14), [false, true]);
  assert.deepStrictEqual(at(15), [false, true]);
  assert.deepStrictEqual(at(15.5), [false, false], 'full size');
  assert.deepStrictEqual(at(19), [false, false]);
  assert.deepStrictEqual(at(12), [true, false]);
  // Shrunk or not, each picture stays centred on its spot.
  for (const [cls, px] of [['hz-mid', 24], ['hz-far', 20]]) {
    const rule = HTML.match(new RegExp(`\\.${cls} \\.leaflet-marker-icon\\.hz-icon\\{([^}]*)\\}`))[1];
    assert.ok(rule.includes(`width:${px}px!important`) && rule.includes(`height:${px}px!important`), cls);
    assert.ok(rule.includes(`margin-left:-${px / 2}px!important`) && rule.includes(`margin-top:-${px / 2}px!important`), `${cls}: centred`);
  }
});

test('if the state\'s photos cannot be reached, the USGS photos take their place under the same button', async () => {
  const p = await started();
  const sat = photoGroup(p.leaflet.made);
  const photos = sat.items[0];
  photos.fire('tileerror'); photos.fire('tileerror');
  assert.strictEqual(sat.items[0], photos, 'two failures: still the state\'s');
  photos.fire('tileerror');
  assert.deepStrictEqual(sat.items.map((t) => t.url), [W.TILES.aerialBackup.url], 'three, and none loaded: the USGS photos');
  assert.strictEqual(p.run.state.photos, 'usgs');
  photos.fire('tileerror');
  assert.strictEqual(sat.items.length, 1, 'swapped once, not again and again');
  // Photos that have loaded: a few failed tiles later are not a server that is down.
  const q = await started();
  const sat2 = photoGroup(q.leaflet.made);
  const ph2 = sat2.items[0];
  ph2.fire('tileload');
  for (let i = 0; i < 10; i++) ph2.fire('tileerror');
  assert.deepStrictEqual([sat2.items[0], q.run.state.photos], [ph2, 'state']);
});

test('each hazard\'s picture comes from the committee\'s own name for it', () => {
  const cases = {
    'Tree in the Water': 'tree', Boulder: 'boulder', Sandbar: 'sandbar', 'Shallow Area': 'shallow',
    'Sandbar and Exposed Pipe': 'pipe', 'Do not Row Beyond This Point!': 'stop',
    'Tree in the Water and Potential Shallow Shoreline': 'tree', 'State Park Swim Area': 'swim', 'Swim Area': 'swim',
    'Water Ski Course': 'ski',
    // what a new hazard might be called
    'Fallen log': 'tree', 'Rocks below the surface': 'boulder', 'Power lines': 'stop', 'Stay clear of the dam': 'stop',
    Shoal: 'shallow', 'Old pipes': 'pipe', Beach: 'swim', 'No swimming': 'swim', Skiing: 'ski', 'Sand bar': 'sandbar',
    // and what must not fool it
    "Skipper's mooring": 'other', 'Damaged dock': 'other', Treeline: 'other', 'Bar and grill': 'other', '': 'other',
  };
  for (const [name, kind] of Object.entries(cases)) assert.strictEqual(W.hazardKind(name), kind, name);
  assert.strictEqual(W.hazardKind(null), 'other');
  for (const k of W.KIND_ORDER) assert.ok(W.GLYPHS[k] && W.KIND_WORDS[k], k);
});

test('the pictures: the hazard\'s own colour, white on orange and dark on yellow, centred exactly on the spot', async () => {
  const p = await started();
  const pics = p.leaflet.made.layers.filter((x) => x.kind === 'marker');
  const points = MAP_DATA.folders.flatMap((f) => f.features).filter((f) => f.type === 'point');
  assert.strictEqual(points.length, 9);
  for (const f of points) {
    const m = pics.find((x) => x.coords[0] === f.coords[0] && x.coords[1] === f.coords[1]);
    assert.ok(m, f.name);
    const io = m.o.icon.iconOptions;
    assert.deepStrictEqual([io.iconSize, io.iconAnchor], [[30, 30], [15, 15]], `${f.name}: the middle of the picture is the spot`);
    const svg = decodeURIComponent(io.iconUrl.split(',')[1]);
    assert.ok(io.iconUrl.startsWith('data:image/svg+xml;charset=utf-8,'), 'an image: nothing in it can run');
    assert.ok(svg.includes(`fill="${f.color}"`), f.name);
    assert.ok(svg.includes(W.GLYPHS[W.hazardKind(f.name)]), `${f.name}: its picture`);
    assert.ok(svg.includes(`color="${f.color === '#FFD600' ? '#3a2c00' : '#ffffff'}"`), `${f.name}: readable on its colour`);
    assert.deepStrictEqual([m.o.title, m.o.alt, m.o.keyboard], [f.name, f.name, true], `${f.name}: named, and reachable by keyboard`);
  }
  assert.strictEqual(W.glyphColor('#0F9D58'), '#ffffff');
  assert.strictEqual(W.glyphColor('#FFFFFF'), '#3a2c00');
});

test('the swim areas and the ski course have their picture in the middle; the lanes have none', async () => {
  const p = await started();
  const pics = hazardPictures(p.leaflet.made);
  const areas = MAP_DATA.folders.flatMap((f) => f.features).filter((f) => f.type === 'polygon' && /Swim|Ski/.test(f.name));
  assert.strictEqual(areas.length, 3);
  for (const a of areas) {
    const mid = W.areaMiddle(a.coords);
    assert.ok(insidePolygon(mid, a.coords), `${a.name}: its middle is inside it`);
    const m = pics.find((x) => x.coords[0] === mid[0] && x.coords[1] === mid[1]);
    assert.ok(m, a.name);
    assert.strictEqual(m.popup().children[0].textContent, a.name, 'its picture opens the area\'s note');
  }
  assert.strictEqual(pics.length, 9 + areas.length, 'the nine hazards and the three areas: none for the lanes');
  // The middle, worked out: a square, a triangle, a line, nothing.
  assert.deepStrictEqual(W.areaMiddle([[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]), [1, 1]);
  const t = W.areaMiddle([[41.3, -73.1], [41.3, -73.0], [41.4, -73.1]]);
  assert.ok(Math.abs(t[0] - (41.3 + 41.3 + 41.4) / 3) < 1e-12 && Math.abs(t[1] - (-73.1 - 73.0 - 73.1) / 3) < 1e-12, String(t));
  assert.deepStrictEqual(W.areaMiddle([[1, 1], [2, 2], [3, 3], [1, 1]]), [2, 2]);
  assert.strictEqual(W.areaMiddle([]), null);
});

test('the key: one picture for each sort of hazard on the map, as it looks there, in a steady order', async () => {
  const p = await started();
  const key = p.$('hazard-key');
  assert.deepStrictEqual(key.children.map((c) => c.children[1].textContent),
    ['Do not row beyond', 'Pipe', 'Shallow water', 'Sandbar', 'Boulder', 'Tree in the water', 'Swim area', 'Water ski course']);
  const img = key.children[0].children[0];
  assert.deepStrictEqual([img.tagName, img.alt, img.width, img.height], ['IMG', '', 18, 18], 'the words beside it say what it is');
  assert.ok(decodeURIComponent(img.src).includes('fill="#E65100"') && decodeURIComponent(img.src).includes(W.GLYPHS.stop));
  assert.ok(decodeURIComponent(key.children[5].children[0].src).includes('fill="#FFD600"'), 'the trees are yellow, as on the map');
  assert.deepStrictEqual(p.document.innerHTMLWrites, []);
  // A sort of hazard in two colours is in the key once, as it first appears on the map.
  const two = JSON.parse(JSON.stringify(MAP_DATA));
  two.folders[2].features.unshift({ name: 'Fallen tree', description: '', type: 'point', coords: [41.36, -73.14], color: '#E65100' });
  const q = await started({ answers: { map: { ok: true, body: two } } });
  const trees = q.$('hazard-key').children.filter((c) => c.children[1].textContent === 'Tree in the water');
  assert.strictEqual(trees.length, 1);
  assert.ok(decodeURIComponent(trees[0].children[0].src).includes('fill="#E65100"'));
});

test('a name or colour can never get into a picture as markup', () => {
  const svg = W.iconSvg('tree', '#FFD600"/><script>alert(1)</script>');
  assert.ok(!/script/i.test(svg), 'a colour that is not plain #RRGGBB is not used');
  assert.ok(svg.includes('fill="#E65100"'));
  assert.ok(W.iconSvg('no such kind', '#123456').includes(W.GLYPHS.other));
  assert.ok(W.iconSvg('tree', 'red').includes('fill="#E65100"') && W.iconSvg('tree', null).includes('fill="#E65100"'));
});

test('every popup fits a phone\'s map: no wider than 240 px, kept clear of the edges', async () => {
  const p = await started();
  const withPopups = p.leaflet.made.layers.filter((x) => x.popup);
  assert.strictEqual(withPopups.length, 9 + 12 + 2, 'the lanes and areas, the pictures, the two boathouses');
  for (const x of withPopups) assert.deepStrictEqual(x.popupOptions, { maxWidth: 240, autoPanPadding: [12, 12] }, x.kind);
});

test('the boathouse is the NHRC logo itself - no disc, no rings - bigger, centred on the dock the club gave, above every hazard picture', async () => {
  const p = await started();
  const dock = dockMarker(p.leaflet.made);
  const io = dock.o.icon.iconOptions;
  assert.strictEqual(io.iconUrl, 'map/nhrc-map.png');
  assert.deepStrictEqual([io.iconSize, io.iconAnchor, io.popupAnchor], [[64, 54], [32, 27], [0, -27]], 'its middle is the dock');
  assert.deepStrictEqual([dock.o.title, dock.o.alt, dock.o.keyboard, dock.o.zIndexOffset, dock.o.pane],
    ['NHRC boathouse dock', 'NHRC boathouse dock', true, 1000, 'hazards']);
  assert.strictEqual(dock.popup().textContent, 'NHRC boathouse dock');
  assert.deepStrictEqual([W.DOCK.lat, W.DOCK.lon], [41.3685422, -73.1478128]);
  assert.strictEqual(W.LOGO_URL, 'map/nhrc-map.png');
  // The picture: the club's logo, whole (nothing on its edge), its background clear, the shape
  // of the logo (wider than high), small to load.
  const png = fs.readFileSync(path.join(ROOT, W.LOGO_URL));
  assert.ok(png.length < 12000, `${png.length} bytes`);
  const img = readPng(png);
  assert.deepStrictEqual([img.width, img.height], [160, 136]);
  assert.ok(wholeInside(img), 'the logo reaches the edge of its picture: it would look cut off');
  assert.ok(Math.abs(io.iconSize[0] / io.iconSize[1] - img.width / img.height) < 0.03, 'shown in its own proportions');
  // Its black letters keep a white edge: the middle of the "H" is black, with white round it.
  const at = (x, y) => [...img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
  const dark = [], light = [];
  for (let i = 0; i < img.width * img.height; i++) {
    const [r, g, b, a] = at(i % img.width, Math.floor(i / img.width));
    if (a > 250 && r + g + b < 60) dark.push(i);
    if (a > 250 && r > 245 && g > 245 && b > 245) light.push(i);
  }
  assert.ok(dark.length > 200 && light.length > 1500, `${dark.length} black, ${light.length} white pixels`);
  // On the map: no disc, no ring, nothing to cut it; a shadow to lift it off the photos.
  const rule = (sel) => HTML.match(new RegExp(`\\n${sel}\\{([^}]*)\\}`))[1];
  const base = rule('\\.leaflet-marker-icon\\.dock-icon');
  assert.ok(/object-fit:contain/.test(base) && /drop-shadow/.test(base), base);
  assert.ok(!/border|background|box-shadow|padding|clip|overflow/.test(base), base);
  // Shrunk with more of the lake in view, still centred and still bigger than the hazards and Yale's.
  for (const [cls, w, h] of [['hz-mid', 54, 46], ['hz-far', 44, 38]]) {
    const r = rule(`\\.${cls} \\.leaflet-marker-icon\\.dock-icon`);
    assert.ok(r.includes(`width:${w}px!important`) && r.includes(`height:${h}px!important`)
      && r.includes(`margin-left:-${w / 2}px!important`) && r.includes(`margin-top:-${h / 2}px!important`), cls);
    assert.ok(!/border|padding/.test(r), r);
  }
  // The key shows the same picture, also without a disc.
  assert.ok(/<img class="key-logo" src="map\/nhrc-map\.png" alt=""\/>NHRC boathouse dock/.test(HTML), 'the key shows the logo too');
  assert.ok(!/border|background|radius|box-shadow/.test(rule('\\.key-logo')), rule('\\.key-logo'));
  // The header keeps the site's own logo file.
  assert.ok(/NHRC_logo\.svg/.test(HTML));
});

const yaleMarker = (made) => made.layers.find((x) => x.kind === 'marker' && x.o.icon.iconOptions.className === 'yale-icon');

/** A PNG's pixels (8-bit RGBA, as map/yale-y.png is saved): { width, height, rgba }. */
function readPng(buf) {
  const zlib = require('zlib');
  assert.strictEqual(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a', 'a PNG');
  let at = 8, width, height, depth, type, plte = null, trns = Buffer.alloc(0);
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), kind = buf.slice(at + 4, at + 8).toString('ascii'), data = buf.slice(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; assert.strictEqual(data[12], 0, 'not interlaced'); }
    if (kind === 'PLTE') plte = data;
    if (kind === 'tRNS') trns = data;
    if (kind === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  // RGBA, or a palette with its transparency: either way 8 bits, so its background can be clear.
  assert.ok(depth === 8 && (type === 6 || (type === 3 && plte && trns.length)), `depth ${depth}, colour type ${type}`);
  const bpp = type === 6 ? 4 : 1, stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat)), px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y ? px[(y - 1) * stride + x - bpp] : 0;
      const pr = () => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      px[y * stride + x] = (line[x] + [0, a, b, (a + b) >> 1, f === 4 ? pr() : 0][f]) & 255;
    }
  }
  if (type === 6) return { width, height, rgba: px };
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const k = px[i];
    plte.copy(rgba, i * 4, k * 3, k * 3 + 3);
    rgba[i * 4 + 3] = k < trns.length ? trns[k] : 255;
  }
  return { width, height, rgba };
}

/** True when nothing of a picture lies on its edge: what it shows is whole, not cut off. */
function wholeInside(img) {
  const alpha = (x, y) => img.rgba[(y * img.width + x) * 4 + 3];
  for (let x = 0; x < img.width; x++) if (alpha(x, 0) || alpha(x, img.height - 1)) return false;
  for (let y = 0; y < img.height; y++) if (alpha(0, y) || alpha(img.width - 1, y)) return false;
  return true;
}

test('the Yale Gilder Boathouse: Yale\'s Y where the club gave it, whole, smaller than the club\'s own, in the key and the whole-lake view', async () => {
  const p = await started();
  const yale = yaleMarker(p.leaflet.made);
  assert.ok(yale, 'there is a Yale marker');
  // 41°19'39.6"N 73°06'14.2"W, as the club gave it.
  assert.ok(Math.abs(W.YALE.lat - (41 + 19 / 60 + 39.6 / 3600)) < 1e-6, String(W.YALE.lat));
  assert.ok(Math.abs(W.YALE.lon + (73 + 6 / 60 + 14.2 / 3600)) < 1e-6, String(W.YALE.lon));
  assert.deepStrictEqual(yale.coords, [W.YALE.lat, W.YALE.lon]);
  const io = yale.o.icon.iconOptions;
  assert.strictEqual(io.iconUrl, 'map/yale-y.png');
  assert.deepStrictEqual([io.iconSize, io.iconAnchor, io.popupAnchor], [[40, 40], [20, 20], [0, -20]], 'its middle is the boathouse');
  const dock = dockMarker(p.leaflet.made);
  assert.ok(io.iconSize[0] < dock.o.icon.iconOptions.iconSize[0], 'smaller than the club\'s own');
  assert.deepStrictEqual([yale.o.title, yale.o.alt, yale.o.keyboard, yale.o.pane], ['Yale Gilder Boathouse', 'Yale Gilder Boathouse', true, 'hazards']);
  assert.ok(yale.o.zIndexOffset > 0 && yale.o.zIndexOffset < dock.o.zIndexOffset, 'above the hazards\' pictures, below the club\'s dock');
  assert.strictEqual(yale.popup().textContent, 'Yale Gilder Boathouse');
  assert.deepStrictEqual(yale.popupOptions, W.POPUP);
  // The picture: the file the club supplied, square, its background clear - and the Y
  // whole: nothing of it on the picture's edge, as it would be had it been cut.
  const png = fs.readFileSync(path.join(ROOT, W.YALE_LOGO_URL));
  assert.ok(png.length < 8000, `${png.length} bytes`);
  const img = readPng(png);
  assert.deepStrictEqual([img.width, img.height], [128, 128]);
  const alpha = (x, y) => img.rgba[(y * img.width + x) * 4 + 3];
  assert.ok(wholeInside(img), 'the Y reaches the edge of its picture: it would look cut off');
  assert.strictEqual(alpha(0, 0), 0);
  const at = (x, y) => [...img.rgba.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
  assert.deepStrictEqual(at(64, 100), [0, 53, 107, 255], 'Yale blue, solid, in the stem');
  // Shown whole on the map and in the key: no circle, no ring, nothing to cut it.
  const rule = (sel) => HTML.match(new RegExp(`\\n${sel}\\{([^}]*)\\}`))[1];
  const base = rule('\\.leaflet-marker-icon\\.yale-icon');
  assert.ok(/object-fit:contain/.test(base) && /drop-shadow/.test(base), base);
  for (const r of [base, rule('\\.key-logo')]) assert.ok(!/border|radius|clip|overflow|background/.test(r), r);
  // Shrunk with more of the lake in view, still centred.
  for (const [cls, px] of [['hz-mid', 34], ['hz-far', 28]]) {
    const r = rule(`\\.${cls} \\.leaflet-marker-icon\\.yale-icon`);
    assert.ok(r.includes(`width:${px}px!important`) && r.includes(`height:${px}px!important`)
      && r.includes(`margin-left:-${px / 2}px!important`) && r.includes(`margin-top:-${px / 2}px!important`), cls);
  }
  assert.ok(/<img class="key-logo" src="map\/yale-y\.png" alt=""\/>Yale Gilder Boathouse/.test(HTML), 'the key shows it too');
  // "Whole lake" takes in both boathouses; the first view, before the outline arrives, has Yale's too.
  const fit = p.run.map.views.filter((v) => v[0] === 'fit').slice(-1)[0][1];
  assert.ok(fit.pts.some((c) => c[0] === W.YALE.lat && c[1] === W.YALE.lon), 'the whole lake takes in the Yale boathouse');
  assert.ok(fit.pts.some((c) => c[0] === W.DOCK.lat && c[1] === W.DOCK.lon), 'and the club\'s');
  assert.ok(W.LAKE_BOUNDS[0][0] < W.YALE.lat && W.YALE.lon < W.LAKE_BOUNDS[1][1]);
});

test('the boathouses widen the whole-lake view only once there is a map to show: no outline, no bounds', () => {
  const L = fakeEnv().leaflet;
  const m = L.map({});
  assert.strictEqual(W.drawHazards(L, m, { folders: [] }, () => null, [[W.YALE.lat, W.YALE.lon]]).bounds, null);
  const one = W.drawHazards(L, m, { folders: [{ name: 'Hazards', features: [{ name: 'Rock', type: 'point', coords: [41.35, -73.13] }] }] },
    () => null, [[W.YALE.lat, W.YALE.lon]]);
  assert.deepStrictEqual(one.bounds.pts, [[41.35, -73.13], [W.YALE.lat, W.YALE.lon]]);
  const none = W.drawHazards(L, m, { folders: [{ name: 'Hazards', features: [{ name: 'Rock', type: 'point', coords: [41.35, -73.13] }] }] }, () => null);
  assert.deepStrictEqual(none.bounds.pts, [[41.35, -73.13]], 'without landmarks, as before');
});

test('the streaks cover the whole map, not only the course: when it opens, once the lanes arrive, after a drag, and as they drift', async () => {
  // The same "random" every run, so this cannot pass or fail by luck.
  const realRandom = Math.random, realNow = Date.now;
  let seed = 11;
  Math.random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  try {
    const env = fakeEnv();
    const realMap = env.leaflet.map;
    env.leaflet.map = (...a) => { const m = realMap(...a); m.getSize = () => ({ x: 400, y: 300 }); return m; };
    Date.now = () => NOW;
    let run;
    try { run = W.init(env); await run.forecast; await run.drawn; } finally { Date.now = realNow; }
    const w = run.state.wind;
    assert.ok(run.state.lanes.length > 0, 'the lanes have arrived');
    // Streaks in each quarter of the 400 x 300 map, and near each of its edges.
    const spread = () => {
      const q = new Set(w.state.parts.map((p) => (p.x < 200 ? 0 : 1) + (p.y < 150 ? 0 : 2)));
      const xs = w.state.parts.map((p) => p.x), ys = w.state.parts.map((p) => p.y);
      return q.size === 4 && Math.min(...xs) < 100 && Math.max(...xs) > 300 && Math.min(...ys) < 75 && Math.max(...ys) > 225;
    };
    assert.strictEqual(w.state.parts.length, 67, 'one for every 1800 square pixels of map');
    assert.ok(spread(), 'all over the map');
    Object.values(run.map.handlers).flat().forEach((f) => f({}));     // dragged and zoomed
    assert.ok(spread(), 'still all over it after a drag');
    for (let t = 1000; t < 31000; t += 100) env.frames.shift()(t);   // half a minute of drifting
    assert.strictEqual(w.state.parts.length, 67);
    assert.ok(spread(), 'and as they drift and are born again');
    assert.ok(w.state.parts.every((p) => p.x >= -50 && p.x <= 450 && p.y >= -50 && p.y <= 350), 'none lost far off the map');
  } finally {
    Math.random = realRandom;
  }
});

test('less motion asked for: still arrows over the whole map, one every 80 px', async () => {
  const r = await started({ reduceMotion: true });
  const before = r.calls.length;
  r.run.state.wind.setColor('rgba(255,255,255,.85)', false);       // draws them again
  const calls = r.calls.slice(before);
  assert.strictEqual(calls.filter((c) => c[0] === 'stroke').length, 20, '5 across and 4 down a 400 x 300 map');
  // Each arrow's shaft: from its tail (the first of its three moveTo) to its head (the lineTo after it).
  const centres = [];
  calls.forEach((c, i) => {
    if (c[0] !== 'beginPath') return;
    const tail = calls[i + 1], head = calls[i + 2];
    centres.push([Math.round((tail[1] + head[1]) / 2), Math.round((tail[2] + head[2]) / 2)]);
  });
  const want = [];
  for (const y of [40, 120, 200, 280]) for (const x of [40, 120, 200, 280, 360]) want.push([x, y]);
  assert.deepStrictEqual(centres, want, 'a grid over the whole map');
  assert.strictEqual(W.ARROW_STEP, 80);
});

test('gusts show: when they are well above the wind, some streaks ride them - faster and longer', () => {
  const env = fakeEnv();
  const w = W.createWindLayer(env.document.createElement('div'), env, null);
  w.resize();
  w.set(10, 315, 20);
  const gusty = w.state.parts.filter((q) => q.gusty);
  assert.ok(gusty.length > 0 && gusty.length < w.state.parts.length, `${gusty.length} of ${w.state.parts.length}`);
  assert.ok(gusty.every((q) => q.k >= 1.9 && q.k <= 2.1), 'at the gust speed');
  assert.ok(w.state.parts.filter((q) => !q.gusty).every((q) => q.k >= 0.85 && q.k <= 1.15), 'the rest at the wind');
  w.set(10, 315, 11);
  assert.strictEqual(w.state.parts.filter((q) => q.gusty).length, 0, 'gusts barely above the wind: none');
  w.set(10, 315, null);
  assert.strictEqual(w.state.parts.filter((q) => q.gusty).length, 0, 'no gust figure: none');
});

test('on the photos the streaks get a dark edge, so they stay clear on bright patches', async () => {
  const strokes = (halo) => {
    const env = fakeEnv({ reduceMotion: true });         // still arrows: the same drawing every time
    const w = W.createWindLayer(env.document.createElement('div'), env, null);
    w.resize(); w.set(12, 315, 12);
    const before = env.calls.length;
    w.setColor('rgba(255,255,255,.85)', halo);
    return env.calls.slice(before).filter((c) => c[0] === 'stroke').length;
  };
  const plain = strokes(false), edged = strokes(true);
  assert.ok(plain > 0);
  assert.strictEqual(edged, plain * 2, 'a dark stroke under each white one');
  const p = await started();
  assert.strictEqual(p.run.state.wind.state.halo, true, 'on the photos when the map opens');
  p.$('map-tools').children[2].click();
  assert.strictEqual(p.run.state.wind.state.halo, false, 'not on the street map');
});

test('a map with no size yet waits to show the whole lake - and shows it once it has one, however Leaflet measures', async () => {
  // roworno.com shows its cards only once the first reading is in, so the map
  // often starts in a box of 0 x 0. Leaflet as it really is: getSize() keeps
  // what it first measured, and invalidateSize() does nothing before the map
  // has a view - asking it early left the map blank on the live page.
  const env = fakeEnv();
  let resized = null;
  env.window.ResizeObserver = function (cb) { resized = cb; this.observe = () => {}; };
  let size = { x: 0, y: 0 };
  const box = env.document.byId['hazard-map'];
  Object.defineProperty(box, 'clientWidth', { get: () => size.x });
  Object.defineProperty(box, 'clientHeight', { get: () => size.y });
  const realMap = env.leaflet.map;
  env.leaflet.map = (...a) => {
    const m = realMap(...a);
    const o = a[1] || {};
    let measured = null, stale = false;
    const ready = () => !!(o.center && o.zoom !== undefined) || m.views.length > 0;
    m.getSize = () => { if (!measured || stale) { measured = { x: size.x, y: size.y }; stale = false; } return measured; };
    m.invalidateSize = () => { if (ready()) stale = true; return m; };
    const fit = m.fitBounds.bind(m);
    m.fitBounds = (b, fo) => { const z = m.getSize(); m.fittedAt = [z.x, z.y]; return fit(b, fo); };
    return m;
  };
  const realNow = Date.now;
  Date.now = () => NOW;
  let run;
  try { run = W.init(env); await run.forecast; await run.drawn; } finally { Date.now = realNow; }
  assert.ok(run.map.o.center && run.map.o.zoom === 13, 'a view from the start, so Leaflet measures afresh when asked');
  // Anything at all measuring the map while its box is hidden - a tile layer,
  // a control: Leaflet would keep that 0 x 0.
  run.map.getSize();
  assert.deepStrictEqual(run.map.views, [], 'no fit while the map has no size');
  assert.strictEqual(run.state.fitPending, true);
  size = { x: 400, y: 300 };
  resized([]);
  assert.deepStrictEqual(run.map.views.map((v) => v[0]), ['fit'], 'the whole lake, once it has a size');
  assert.deepStrictEqual(run.map.fittedAt, [400, 300], 'fitted to the size it has now, not a remembered 0 x 0');
  assert.notStrictEqual(run.map.views[0][1], W.LAKE_BOUNDS, 'the map\'s own outline, which has arrived');
  resized([]);
  assert.strictEqual(run.map.views.length, 1, 'and only once: a later resize keeps where you are');
});

test('"Whole lake" measures the box as it is now - even before the page has said it changed size', async () => {
  const env = fakeEnv();
  env.window.ResizeObserver = function () { this.observe = () => {}; };      // its call has not come yet
  let size = { x: 0, y: 0 };
  const box = env.document.byId['hazard-map'];
  Object.defineProperty(box, 'clientWidth', { get: () => size.x });
  Object.defineProperty(box, 'clientHeight', { get: () => size.y });
  const realMap = env.leaflet.map;
  env.leaflet.map = (...a) => {
    const m = realMap(...a);
    const o = a[1] || {};
    let measured = null, stale = false;
    m.getSize = () => { if (!measured || stale) { measured = { x: size.x, y: size.y }; stale = false; } return measured; };
    m.invalidateSize = () => { if ((o.center && o.zoom !== undefined) || m.views.length) stale = true; return m; };
    const fit = m.fitBounds.bind(m);
    m.fitBounds = (b, fo) => { const z = m.getSize(); m.fittedAt = [z.x, z.y]; return fit(b, fo); };
    return m;
  };
  const realNow = Date.now;
  Date.now = () => NOW;
  let run;
  try { run = W.init(env); await run.forecast; await run.drawn; } finally { Date.now = realNow; }
  run.map.getSize();                                                   // measured while hidden: 0 x 0
  size = { x: 400, y: 300 };
  env.document.byId['map-tools'].children[1].click();                  // Whole lake
  assert.deepStrictEqual([run.map.views.length, run.map.fittedAt], [1, [400, 300]]);
});

test('every corner is drawn where the committee put it: the lanes are not smoothed', async () => {
  const p = await started();
  const polys = p.leaflet.made.layers.filter((x) => x.kind === 'polygon');
  assert.ok(polys.every((x) => x.o.smoothFactor === 0));
  const up1 = MAP_DATA.folders[1].features[0];
  const drawn = polys.find((x) => x.popup().children[0].textContent === up1.name);
  assert.deepStrictEqual(drawn.coords, up1.coords, 'the very same coordinates, to seven decimals');
});

test('the moving wind: streaks for most, still arrows for anyone who asked for less motion', async () => {
  const p = await started();
  const w = p.run.state.wind;
  assert.strictEqual(w.reduce, false);
  assert.ok(p.frames.length >= 1, 'animating');
  const before = p.calls.length;
  p.frames.shift()(1000); p.frames.shift()(1016);
  assert.ok(p.calls.slice(before).some((c) => c[0] === 'lineTo'), 'streaks drawn');
  w.setVisible(false);
  const n = p.frames.length;
  assert.strictEqual(w.state.visible, false);
  p.frames.forEach((f) => f(2000));
  assert.ok(p.frames.length <= n, 'off screen: no more frames asked for');
  const r = await started({ reduceMotion: true });
  assert.strictEqual(r.run.state.wind.reduce, true);
  assert.strictEqual(r.frames.length, 0, 'no animation at all');
  assert.ok(r.calls.some((c) => c[0] === 'lineTo'), 'arrows drawn once');
});

test('the moving wind sits between the lanes and the hazards, and stays over the map when it is dragged', async () => {
  const p = await started();
  const L = p.leaflet.made;
  assert.deepStrictEqual([L.panes.wind.style.zIndex, L.panes.wind.style.pointerEvents], ['450', 'none']);
  assert.ok(Number(L.panes.wind.style.zIndex) > 400 && Number(L.panes.wind.style.zIndex) < Number(L.panes.hazards.style.zIndex),
    'above the lanes (400), below the hazards - and the popups (700)');
  const canvas = p.run.state.wind.canvas;
  assert.strictEqual(canvas.parent, L.panes.wind, 'in the pane, not over the whole map');
  assert.deepStrictEqual(canvas.position, { x: -7, y: -3 }, 'placed over the visible map');
  canvas.position = null;
  p.run.map.handlers['move zoomend viewreset resize'].forEach((f) => f());
  assert.deepStrictEqual(canvas.position, { x: -7, y: -3 }, 'and put back after a drag');
});

test('the streaks stop when the tab is hidden or the map scrolled away - and start again only when both are back', async () => {
  const env = fakeEnv();
  let observe = null;
  env.window.IntersectionObserver = function (cb) { observe = cb; this.observe = () => {}; };
  const realNow = Date.now;
  Date.now = () => NOW;
  let run;
  try { run = W.init(env); await run.forecast; await run.drawn; } finally { Date.now = realNow; }
  const st = run.state.wind.state;
  assert.strictEqual(st.visible, true);
  observe([{ isIntersecting: false }]);
  assert.strictEqual(st.visible, false, 'scrolled away');
  env.document.visibilityState = 'visible';
  env.document.listeners.visibilitychange.forEach((f) => f());
  assert.strictEqual(st.visible, false, 'the tab is back, but the map is still off screen');
  observe([{ isIntersecting: true }]);
  assert.strictEqual(st.visible, true);
  env.document.visibilityState = 'hidden';
  env.document.listeners.visibilitychange.forEach((f) => f());
  assert.strictEqual(st.visible, false, 'tab hidden');
});

test('"Whole lake" works even before the map\'s outline has arrived; "Boathouse" zooms to the dock', async () => {
  const p = await started({ answers: { map: { ok: false } } });
  const buttons = p.$('map-tools').children;
  assert.deepStrictEqual(buttons.map((b) => [b.tagName, b.type, b.textContent]), [['BUTTON', 'button', 'Boathouse'], ['BUTTON', 'button', 'Whole lake'], ['BUTTON', 'button', 'Street map']]);
  buttons[1].click();
  assert.deepStrictEqual(p.run.map.views.slice(-1)[0], ['fit', W.LAKE_BOUNDS]);
  assert.deepStrictEqual(p.run.map.fitOptions, { paddingTopLeft: [20, 20], paddingBottomRight: [30, 44] }, 'the lake\'s far end - the Yale boathouse - clear of the credits line');
  buttons[0].click();
  assert.deepStrictEqual(p.run.map.views.slice(-1)[0], ['view', [W.DOCK.lat, W.DOCK.lon], 16]);
});

test('the map rolls through the hours on its own, like a radar loop: now held, then an hour a second, and round again', async () => {
  const p = await started();
  const st = p.run.state, w = p.window;
  assert.strictEqual(st.playing, true, 'rolling from the start');
  assert.strictEqual(p.$('wind-play').textContent, '\u275a\u275a Pause');
  assert.strictEqual(p.document.liveRow.attrs['aria-live'], 'off', 'the changing words are not read out every second');
  assert.strictEqual(w.pending().length, 1);
  assert.strictEqual(w.tick(), W.PLAY.holdNowMs, 'now is held a little longer');
  assert.deepStrictEqual([st.index, p.$('wind-time').value, p.$('wind-time-label').textContent], [1, '1', 'Sun 3 PM']);
  assert.strictEqual(st.wind.state.speed, st.slots[1].speed, 'the streaks follow each hour');
  assert.ok(/Sun 3 PM \(forecast\)/.test(st.badge.textContent));
  for (let i = 2; i <= 24; i++) assert.strictEqual(w.tick(), W.PLAY.frameMs, `hour ${i}`);
  assert.strictEqual(st.index, 24);
  w.tick();
  assert.deepStrictEqual([st.index, p.$('wind-time-label').textContent, p.$('wind-line').textContent], [0, 'Now', '12 mph from the NW, gusts 19'], 'and round to now again');
  assert.strictEqual(w.pending()[0].ms, W.PLAY.holdNowMs);
  assert.strictEqual(w.pending().length, 1, 'one step waiting at a time');
});

test('taking the slider or "Now" stops the loop where you put it; Play starts it again', async () => {
  const p = await started();
  const st = p.run.state, w = p.window;
  w.tick(); w.tick();
  p.$('wind-time').value = '9';
  p.$('wind-time').dispatch('input');
  assert.deepStrictEqual([st.playing, st.index, w.pending().length], [false, 9, 0], 'stopped on the hour you chose');
  assert.strictEqual(p.$('wind-play').textContent, '\u25b6\ufe0e Play');
  assert.strictEqual(p.document.liveRow.attrs['aria-live'], 'polite', 'read out again once it holds still');
  p.$('wind-play').click();
  assert.deepStrictEqual([st.playing, w.pending().length, w.pending()[0].ms], [true, 1, W.PLAY.frameMs], 'on from where it was');
  w.tick();
  assert.strictEqual(st.index, 10);
  p.$('wind-play').click();
  assert.deepStrictEqual([st.playing, w.pending().length], [false, 0], 'Pause');
  p.$('wind-play').click();
  p.$('wind-now').click();
  assert.deepStrictEqual([st.playing, st.index, w.pending().length, p.$('wind-time-label').textContent], [false, 0, 0, 'Now']);
});

test('the loop rests while nobody can see it - map scrolled away or tab hidden - and goes on when they can', async () => {
  const env = fakeEnv();
  let observe = null;
  env.window.IntersectionObserver = function (cb) { observe = cb; this.observe = () => {}; };
  const realNow = Date.now;
  Date.now = () => NOW;
  let run;
  try { run = W.init(env); await run.forecast; await run.drawn; } finally { Date.now = realNow; }
  const w = env.window;
  assert.strictEqual(w.pending().length, 1);
  observe([{ isIntersecting: false }]);
  assert.deepStrictEqual([run.state.playing, w.pending().length], [true, 0], 'still on, but no steps while off screen');
  observe([{ isIntersecting: true }]);
  assert.strictEqual(w.pending().length, 1);
  env.document.visibilityState = 'hidden';
  env.document.listeners.visibilitychange.forEach((f) => f());
  assert.strictEqual(w.pending().length, 0, 'tab hidden');
  env.document.visibilityState = 'visible';
  env.document.listeners.visibilitychange.forEach((f) => f());
  assert.strictEqual(w.pending().length, 1);
});

test('no loop on its own for anyone who asked for less motion, without a map, or with only one hour to show', async () => {
  const r = await started({ reduceMotion: true });
  assert.deepStrictEqual([r.run.state.playing, r.window.pending().length], [false, 0]);
  assert.strictEqual(r.document.byId['wind-play'].textContent, '', 'the button as the page wrote it: Play');
  r.$('wind-play').click();
  assert.deepStrictEqual([r.run.state.playing, r.window.pending().length], [true, 1], 'Play still works for them');
  const n = await started({ noLeaflet: true });
  assert.deepStrictEqual([n.run.state.playing, n.window.pending().length], [false, 0], 'no map: nothing to roll over');
  const one = await started({ answers: { forecast: { throws: true } } });
  assert.deepStrictEqual([one.run.state.slots.length, one.run.state.playing, one.window.pending().length], [1, false, 0], 'just now: nothing to roll through');
});

test('a calm hour clears the map of streaks', async () => {
  const p = await started();
  const s = p.run.state.slots[1];
  s.speed = 0.2;
  p.$('wind-time').value = '1';
  p.$('wind-time').dispatch('input');
  assert.strictEqual(p.run.state.wind.state.speed, 0);
  assert.strictEqual(p.$('wind-line').textContent, 'Calm');
  assert.strictEqual(p.$('wind-course').textContent, 'Calm on the course.');
});

test('while the forecast is still on its way, the page says it is loading - not that there is no wind', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const env = fakeEnv({ forecastGate: gate });
  env.document.byId['wind-line'].textContent = 'Loading the wind…';
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const run = W.init(env);
    await run.drawn;                                       // the map arrives first
    assert.strictEqual(env.document.byId['wind-line'].textContent, 'Loading the wind…');
    assert.strictEqual(env.document.byId['wind-course'].textContent, '');
    release();
    await run.forecast;
    assert.strictEqual(env.document.byId['wind-line'].textContent, '12 mph from the NW, gusts 19', 'the reading, once the hours are in');
  } finally {
    Date.now = realNow;
  }
});

test('the forecast cannot be loaded: the map still shows, the airport\'s reading still shows, and the page says so', async () => {
  for (const forecast of [{ throws: true }, { ok: false }, { ok: true, badJson: true }, { ok: true, body: { hourly: {} } }]) {
    const p = await started({ answers: { forecast }, station: null });
    assert.strictEqual(p.$('wind-line').textContent, 'Wind not available', JSON.stringify(forecast));
    assert.ok(/could not be loaded/.test(p.$('wind-status').textContent));
    assert.strictEqual(p.$('wind-time').disabled, true);
    assert.strictEqual(p.leaflet.made.layers.filter((x) => x.kind === 'polygon').length, 9, 'the hazards are still there');
    const q = await started({ answers: { forecast } });
    assert.deepStrictEqual([q.$('wind-line').textContent, q.$('wind-time').disabled, q.run.state.slots.length], ['12 mph from the NW, gusts 19', true, 1]);
    assert.ok(/could not be loaded/.test(q.$('wind-status').textContent));
  }
});

test('the map data cannot be loaded: the wind still shows, and the page says so', async () => {
  const p = await started({ answers: { map: { ok: false } } });
  assert.ok(/hazard map could not be loaded/.test(p.$('map-status').textContent));
  assert.strictEqual(p.$('wind-line').textContent, '12 mph from the NW, gusts 19');
  assert.strictEqual(p.$('wind-course').textContent, '', 'no lanes, no course words');
});

test('Leaflet cannot be loaded (blocked or offline): the wind in words, and a plain message', async () => {
  const p = await started({ noLeaflet: true });
  assert.ok(/map could not be loaded/.test(p.$('map-status').textContent));
  assert.strictEqual(p.$('wind-line').textContent, '12 mph from the NW, gusts 19');
});

test('the forecast refreshes every 15 minutes, and when a tab comes back after longer', async () => {
  const p = await started();
  assert.deepStrictEqual(p.window.timers.map((t) => t[1]), [15 * 60 * 1000]);
  const n = p.fetched.filter((u) => u === W.FORECAST_URL).length;
  const realNow = Date.now;
  Date.now = () => NOW + 20 * 60000;
  try { p.document.listeners.visibilitychange.forEach((f) => f()); } finally { Date.now = realNow; }
  assert.strictEqual(p.fetched.filter((u) => u === W.FORECAST_URL).length, n + 1);
});

test('a refresh keeps the hour you were looking at', async () => {
  const p = await started();
  p.$('wind-time').value = '5';
  p.$('wind-time').dispatch('input');
  const t = p.run.state.slots[5].t;
  // The refresh runs at the forecast's own time, not whenever the tests happen to run.
  const realNow = Date.now;
  Date.now = () => NOW + 15 * 60000;
  try { await p.window.timers[0][0](); } finally { Date.now = realNow; }
  assert.strictEqual(p.run.state.slots[p.run.state.index].t, t);
});

// ═════════════════════════════════════════════════════════════════════════════
section('5. The page\'s markup');

test('the map is on the main page, where the Google embed was; the old trial address sends people to it', () => {
  assert.ok(!/<iframe[^>]*google\.com\/maps/.test(HTML), 'the Google embed is gone');
  assert.ok(/id="river-map"/.test(HTML) && HTML.indexOf('id="river-map"') > HTML.indexOf('id="river-content"')
    && HTML.indexOf('id="river-map"') < HTML.indexOf('Daily Conditions Email'), 'between the river level and the email sign-up, as before');
  assert.ok(/href="https:\/\/www\.google\.com\/maps\/d\/u\/0\/viewer\?mid=1dNR4qbbp2I8oIZK2ZMMKCNkksLDCXIk"/.test(HTML), 'the committee\'s own map, one tap away');
  assert.ok(/<meta http-equiv="refresh" content="0; url=\.\.\/#river-map"\/>/.test(TRIAL) && /href="\.\.\/#river-map"/.test(TRIAL));
  assert.ok(/<meta name="robots" content="noindex, nofollow"\/>/.test(TRIAL));
  assert.ok(!fs.existsSync(path.join(ROOT, 'trial', 'wind-map.js')) && !fs.existsSync(path.join(ROOT, 'trial', 'hazard-map.json')), 'one copy of each');
  assert.strictEqual(W.MAP_DATA_URL, 'map/hazard-map.json');
  assert.ok(fs.existsSync(path.join(ROOT, W.MAP_DATA_URL)));
});

test('the weather card hands its airport reading to the map', () => {
  const main = HTML.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
  assert.ok(/window\.NHRC_STATION = live \? Object\.assign\(\{ name: WEATHER_STATION\.name, where: WEATHER_STATION\.where \}, live\) : null;/.test(main));
  assert.ok(/new CustomEvent\('nhrc-station', \{ detail: window\.NHRC_STATION \}\)/.test(main));
});

test('the credits the data asks for: Open-Meteo by name with a link; map tiles credited on the map', () => {
  assert.ok(/<a href="https:\/\/open-meteo\.com\/"[^>]*>Forecast data by Open-Meteo\.com<\/a>/.test(HTML));
  assert.ok(/OpenStreetMap<\/a> contributors/.test(W.TILES.map.options.attribution));
  assert.ok(/CT State GIS Office/.test(W.TILES.aerial.options.attribution) && /maps\.cteco\.uconn\.edu\/data\/flight2023\//.test(W.TILES.aerial.options.attribution),
    'the state asks to be acknowledged: by name, with the link it gives');
  assert.ok(/USGS The National Map/.test(W.TILES.aerialBackup.options.attribution));
  assert.ok(/Safety Committee's map, copied/.test(HTML));
  assert.ok(/Now is the wind measured at Waterbury-Oxford Airport, on a hilltop 7\.6 mi north\s+of the dock/.test(HTML), 'where now comes from');
  assert.ok(/State of\s+Connecticut's, taken in spring 2023/.test(HTML), 'the page says whose photos, and when');
});

test('Leaflet is pinned to the exact files, by hash; no keys anywhere', () => {
  assert.ok(HTML.includes('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="')
    || /leaflet@1\.9\.4\/dist\/leaflet\.js"\s+integrity="sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo="/.test(HTML));
  assert.ok(/leaflet@1\.9\.4\/dist\/leaflet\.css"\s+integrity="sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY="/.test(HTML));
  const js = fs.readFileSync(path.join(ROOT, 'map', 'wind-map.js'), 'utf8');
  assert.ok(/<script id="leaflet-js" src="https:\/\/unpkg\.com\/leaflet@1\.9\.4\/dist\/leaflet\.js"[^>]*\basync\b/.test(HTML)
    && /<script src="map\/wind-map\.js\?v=[0-9a-f]{10}" async><\/script>/.test(HTML), 'both async: a slow map library cannot hold up the page');
  assert.ok(!/api[_-]?key|apikey|access_token|token=/i.test(HTML + js));
});

test('the page asks for this very version of the map script, so no browser keeps running an old one', () => {
  const hash = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'map', 'wind-map.js'))).digest('hex').slice(0, 10);
  assert.ok(HTML.includes(`<script src="map/wind-map.js?v=${hash}" async></script>`),
    `map/wind-map.js has changed: in index.html, load it as map/wind-map.js?v=${hash}`);
});

test('every element the script looks for is on the page', () => {
  for (const id of ['hazard-map', 'map-status', 'wind-time', 'wind-time-label', 'wind-line', 'wind-conditions', 'wind-source', 'wind-course', 'wind-status', 'wind-now', 'map-copied', 'hazard-key', 'map-tools']) {
    assert.strictEqual(HTML.split(`id="${id}"`).length, 2, `${id}: once`);
  }
  assert.ok(HTML.indexOf('<script id="leaflet-js"') < HTML.indexOf('<script src="map/wind-map.js?v='), 'Leaflet first');
  // The site's main script stays the last one on the page: the email and the tests read it from there.
  const main = HTML.match(/<script>([\s\S]*)<\/script>\s*<\/body>/)[1];
  assert.ok(!/<script/.test(main) && /function loadWeatherNow/.test(main));
});

test('the map\'s styles use the site\'s theme, light and dark', () => {
  assert.ok(HTML.includes("localStorage.getItem('nhrc-theme')"));
  assert.ok(/:root\[data-theme="light"\]\{/.test(HTML));
  assert.ok(/#wind-line\{[^}]*color:var\(--white\)/.test(HTML) && /#wind-time-label\{[^}]*color:var\(--gold\)/.test(HTML));
  assert.ok(/\.map-status\{[^}]*color:var\(--bad\)/.test(HTML));
});

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  for (const [name, fn] of queue) {
    if (name === null) { console.log(`\n${fn}\n${'-'.repeat(fn.length)}`); continue; }
    try { await fn(); passed++; console.log(`  PASS  ${name}`); }
    catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${String(e.stack || e.message).split('\n').slice(0, 6).join('\n        ')}`); }
  }
  console.log(`\n${'='.repeat(60)}\n${passed} passed, ${failed} failed\n${'='.repeat(60)}`);
  if (failed) { for (const [n, e] of failures) console.log(`  - ${n}: ${e.message.split('\n')[0]}`); process.exitCode = 1; }
})();
