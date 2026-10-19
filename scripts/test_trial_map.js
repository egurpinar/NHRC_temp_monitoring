#!/usr/bin/env node
/**
 * Tests for the trial hazard map with the wind (trial/index.html,
 * trial/wind-map.js).
 *
 *  1. The wind in words: compass points, calm, gusts only when stronger,
 *     missing values shown as missing - never as 0.
 *  2. Headwind, crosswind, tailwind on the lanes: the geometry, both ways.
 *  3. The forecast: now, then 48 hours, in the boathouse's time.
 *  4. The page itself, run with stand-ins for the browser and Leaflet: what
 *     is drawn, in which colours, what the popups say (as text, never as
 *     markup), the slider, the badge, and what happens when the map library,
 *     the map data or the forecast cannot be loaded.
 *  5. The page's markup: kept out of search engines, the credits the data's
 *     licences ask for, the libraries pinned by hash, no keys.
 *
 * Run: node scripts/test_trial_map.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = require('../trial/wind-map.js');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'trial', 'index.html'), 'utf8');
const MAP_DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'trial', 'hazard-map.json'), 'utf8'));

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
  for (const id of ['hazard-map', 'map-status', 'wind-time', 'wind-time-label', 'wind-line', 'wind-conditions', 'wind-course', 'wind-status', 'wind-now', 'map-copied', 'hazard-key', 'map-tools']) {
    if (opts.withoutMapBox && id === 'hazard-map') continue;
    doc.byId[id] = fakeElement(id === 'wind-time' ? 'input' : 'div', doc);
  }
  const frames = [];
  const win = {
    devicePixelRatio: 2, timers: [],
    matchMedia: (q) => ({ matches: !!(opts.reduceMotion && /reduce/.test(q)) }),
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    cancelAnimationFrame: () => {},
    setInterval(f, ms) { this.timers.push([f, ms]); return this.timers.length; },
    addEventListener() {},
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
section('3. The forecast: now, then 48 hours');

test('now from Open-Meteo\'s current conditions, then the next 48 whole hours, in Eastern time', () => {
  const s = W.forecastSlots(sampleForecast(), NOW);
  assert.strictEqual(s.length, 49);
  assert.deepStrictEqual([s[0].label, s[0].isNow, s[0].speed, s[0].from, s[0].temp], ['Now', true, 11.6, 315, 54.4]);
  assert.strictEqual(s[0].rain, 5, 'the chance of rain for the current hour (14:00)');
  assert.strictEqual(s[1].label, 'Sun 3 PM');
  assert.strictEqual(s[48].label, 'Tue 2 PM');
  assert.ok(s.slice(1).every((x, i) => x.t === NOW - 20 * 60000 + (i + 1) * 3600000), 'whole hours, in order');
});

test('without current conditions, now is the current hour; missing numbers stay missing', () => {
  const fc = sampleForecast();
  delete fc.current;
  fc.hourly.wind_gusts_10m[1] = null;
  fc.hourly.temperature_2m[2] = 'warm';
  const s = W.forecastSlots(fc, NOW);
  assert.deepStrictEqual([s[0].label, s[0].speed, s[0].gust, s[0].from], ['Now', 6, null, 15]);
  assert.strictEqual(s[1].temp, null, 'not a number: not shown');
});

test('a forecast that is empty, broken or all in the past gives nothing to show - not a crash', () => {
  assert.deepStrictEqual(W.forecastSlots(null, NOW), []);
  assert.deepStrictEqual(W.forecastSlots({ hourly: {} }, NOW), []);
  const old = sampleForecast();
  delete old.current;
  old.hourly.time = old.hourly.time.map((t) => t - 10 * 86400);
  const s = W.forecastSlots(old, NOW);
  assert.ok(s.length === 1 && s[0].isNow, 'only its last hour, as now');
});

test('the forecast is for the boathouse dock, in mph and °F, with times the page can trust', () => {
  const u = new URL(W.FORECAST_URL);
  assert.strictEqual(u.hostname, 'api.open-meteo.com');
  assert.deepStrictEqual([u.searchParams.get('latitude'), u.searchParams.get('longitude')], ['41.3685422', '-73.1478128'], 'the dock the club gave');
  assert.strictEqual(u.searchParams.get('wind_speed_unit'), 'mph');
  assert.strictEqual(u.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.strictEqual(u.searchParams.get('timeformat'), 'unixtime', 'instants, not local clock strings read as UTC');
  for (const v of ['wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'precipitation_probability']) assert.ok(u.searchParams.get('hourly').includes(v), v);
  assert.ok(Number(u.searchParams.get('forecast_days')) >= 3, 'enough for 48 hours from late in the day');
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

test('the wind: badge, words, conditions and the course - for now', async () => {
  const p = await started();
  assert.strictEqual(p.$('wind-line').textContent, '12 mph from the NW, gusts 19');
  assert.strictEqual(p.$('wind-time-label').textContent, 'Now');
  assert.strictEqual(p.$('wind-conditions').textContent, '54°F · Overcast · 5% chance of rain');
  assert.ok(/^Going downstream: mostly tailwind/.test(p.$('wind-course').textContent), p.$('wind-course').textContent);
  const badge = p.run.state.badge;
  assert.ok(/12 mph from the NW, gusts 19/.test(badge.textContent) && /Now/.test(badge.textContent));
  const g = badge.children[0].children.find((c) => c.tagName === 'G');
  assert.strictEqual(g.attrs.transform, 'rotate(135 20 20)', 'the arrow points downwind');
  assert.strictEqual(p.$('wind-time').max, '48');
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
  assert.strictEqual(sl.attrs['aria-valuetext'], `${s17.label}: ${W.windText(s17)}`);
  assert.strictEqual(p.run.state.wind.state.speed, s17.speed);
  sl.value = '999';
  sl.dispatch('input');
  assert.strictEqual(p.run.state.index, 48, 'held to the last hour');
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
  assert.ok(/^Upstream Section 2Now: 12 mph from the NW, gusts 19\. Rowing upstream here: mostly headwind/.test(words), words);
  assert.deepStrictEqual(p.document.innerHTMLWrites, [], 'nothing from the map data is ever written as markup');
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
  assert.strictEqual(withPopups.length, 9 + 12 + 1, 'the lanes and areas, the pictures, the dock');
  for (const x of withPopups) assert.deepStrictEqual(x.popupOptions, { maxWidth: 240, autoPanPadding: [12, 12] }, x.kind);
});

test('the boathouse is the NHRC logo, centred on the dock the club gave, above every hazard picture', async () => {
  const p = await started();
  const dock = dockMarker(p.leaflet.made);
  const io = dock.o.icon.iconOptions;
  assert.strictEqual(io.iconUrl, '../NHRC_logo.svg', 'the site\'s own logo file');
  assert.deepStrictEqual([io.iconSize, io.iconAnchor], [[58, 58], [29, 29]], 'its middle is the dock');
  assert.deepStrictEqual([dock.o.title, dock.o.alt, dock.o.keyboard, dock.o.zIndexOffset, dock.o.pane],
    ['NHRC boathouse dock', 'NHRC boathouse dock', true, 1000, 'hazards']);
  assert.strictEqual(dock.popup().textContent, 'NHRC boathouse dock');
  assert.deepStrictEqual([W.DOCK.lat, W.DOCK.lon], [41.3685422, -73.1478128]);
  assert.ok(fs.existsSync(path.join(ROOT, 'NHRC_logo.svg')), 'the file is there, one level up from trial/');
  // Shrunk with the lake in view, still centred and still bigger than the hazards.
  for (const [cls, px] of [['hz-mid', 48], ['hz-far', 38]]) {
    const rule = HTML.match(new RegExp(`\\.${cls} \\.leaflet-marker-icon\\.dock-icon\\{([^}]*)\\}`))[1];
    assert.ok(rule.includes(`width:${px}px!important`) && rule.includes(`margin-left:-${px / 2}px!important`) && rule.includes(`margin-top:-${px / 2}px!important`), cls);
  }
  assert.ok(/<img class="key-logo" src="\.\.\/NHRC_logo\.svg" alt=""\/>NHRC boathouse dock/.test(HTML), 'the key shows the logo too');
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

test('a map with no size yet waits to show the whole lake - it used to open zoomed right in on the woods', async () => {
  const env = fakeEnv();
  let resized = null;
  env.window.ResizeObserver = function (cb) { resized = cb; this.observe = () => {}; };
  const realMap = env.leaflet.map;
  let size = { x: 0, y: 0 };
  env.leaflet.map = (...a) => { const m = realMap(...a); m.getSize = () => size; return m; };
  const realNow = Date.now;
  Date.now = () => NOW;
  let run;
  try { run = W.init(env); await run.forecast; await run.drawn; } finally { Date.now = realNow; }
  assert.deepStrictEqual(run.map.views, [], 'no fit while the map has no size');
  assert.strictEqual(run.state.fitPending, true);
  size = { x: 400, y: 300 };
  resized([]);
  assert.deepStrictEqual(run.map.views.map((v) => v[0]), ['fit'], 'the whole lake, once it has a size');
  assert.notStrictEqual(run.map.views[0][1], W.LAKE_BOUNDS, 'the map\'s own outline, which has arrived');
  resized([]);
  assert.strictEqual(run.map.views.length, 1, 'and only once: a later resize keeps where you are');
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
  assert.deepStrictEqual(p.run.map.fitOptions, { paddingTopLeft: [20, 20], paddingBottomRight: [20, 34] }, 'the lake\'s far end clear of the credits line');
  buttons[0].click();
  assert.deepStrictEqual(p.run.map.views.slice(-1)[0], ['view', [W.DOCK.lat, W.DOCK.lon], 16]);
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
    assert.strictEqual(env.document.byId['wind-line'].textContent, '12 mph from the NW, gusts 19');
  } finally {
    Date.now = realNow;
  }
});

test('the forecast cannot be loaded: the map still shows, and the page says so', async () => {
  for (const forecast of [{ throws: true }, { ok: false }, { ok: true, badJson: true }, { ok: true, body: { hourly: {} } }]) {
    const p = await started({ answers: { forecast } });
    assert.strictEqual(p.$('wind-line').textContent, 'Wind not available', JSON.stringify(forecast));
    assert.ok(/could not be loaded/.test(p.$('wind-status').textContent));
    assert.strictEqual(p.$('wind-time').disabled, true);
    assert.strictEqual(p.leaflet.made.layers.filter((x) => x.kind === 'polygon').length, 9, 'the hazards are still there');
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

test('a trial: kept out of search engines, says it is a trial, and links back', () => {
  assert.ok(/<meta name="robots" content="noindex, nofollow"\/>/.test(HTML));
  assert.ok(/<strong>Trial<\/strong>/.test(HTML) && /href="\.\.\/">Back to roworno\.com</.test(HTML));
});

test('the credits the data asks for: Open-Meteo by name with a link; map tiles credited on the map', () => {
  assert.ok(HTML.includes('<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>'));
  assert.ok(/OpenStreetMap<\/a> contributors/.test(W.TILES.map.options.attribution));
  assert.ok(/CT State GIS Office/.test(W.TILES.aerial.options.attribution) && /maps\.cteco\.uconn\.edu\/data\/flight2023\//.test(W.TILES.aerial.options.attribution),
    'the state asks to be acknowledged: by name, with the link it gives');
  assert.ok(/USGS The National Map/.test(W.TILES.aerialBackup.options.attribution));
  assert.ok(/Safety Committee's Google map/.test(HTML));
  assert.ok(/State of\s+Connecticut's, taken in spring 2023/.test(HTML), 'the page says whose photos, and when');
});

test('Leaflet is pinned to the exact files, by hash; no keys anywhere', () => {
  assert.ok(HTML.includes('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="')
    || /leaflet@1\.9\.4\/dist\/leaflet\.js"\s+integrity="sha256-20nQCchB9co0qIjJZRGuk2\/Z9VM\+kNiyxNV1lvTlZBo="/.test(HTML));
  assert.ok(/leaflet@1\.9\.4\/dist\/leaflet\.css"\s+integrity="sha256-p4NxAoJBhIIN\+hmNHrzRCf9tD\/miZyoHS5obTRR9BMY="/.test(HTML));
  const js = fs.readFileSync(path.join(ROOT, 'trial', 'wind-map.js'), 'utf8');
  assert.ok(!/api[_-]?key|apikey|access_token|token=/i.test(HTML + js));
});

test('every element the script looks for is on the page', () => {
  for (const id of ['hazard-map', 'map-status', 'wind-time', 'wind-time-label', 'wind-line', 'wind-conditions', 'wind-course', 'wind-status', 'wind-now', 'map-copied', 'hazard-key']) {
    assert.ok(HTML.includes(`id="${id}"`), id);
  }
  assert.ok(HTML.indexOf('leaflet.js') < HTML.indexOf('wind-map.js'), 'Leaflet first');
});

test('the theme follows the choice made on roworno.com', () => {
  assert.ok(HTML.includes("localStorage.getItem('nhrc-theme')"));
  assert.ok(/:root\[data-theme="light"\]\{/.test(HTML));
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
