/**
 * The club's hazard map with the wind on it, on roworno.com.
 *
 * The lanes, hazards and swim areas come from the Safety Committee's Google
 * map ("Lake Housatonic Navigation"), copied into map/hazard-map.json by
 * scripts/hazard_map.js - a Google My Map cannot show live data, so the site
 * draws the same map itself. Now is the wind measured at Waterbury-Oxford
 * Airport, which the page's weather card loads and hands over (the
 * 'nhrc-station' event); the 48 hours ahead are Open-Meteo's forecast for the
 * boathouse dock, one forecast for the whole lake, and say so. No model
 * output is ever shown as now. No thresholds, no verdicts: the wind, and how
 * it lies on the course.
 *
 * In a browser this file starts itself. In Node it only exports its pieces,
 * for scripts/test_map.js.
 */
(function (root) {
  'use strict';

  // ── Settings ───────────────────────────────────────────────────────────────
  const DOCK = { lat: 41.3685422, lon: -73.1478128 };   // the NHRC dock, as the club gave it
  /** The club's logo (the site's own file), for the dock. */
  const LOGO_URL = 'NHRC_logo.svg';
  // The rowable lake, from the shallows above the boathouse to the power lines
  // above the Derby dam: the first view, until the map's own outline arrives.
  const LAKE_BOUNDS = [[41.3262, -73.1565], [41.3770, -73.1035]];
  const TZ = 'America/New_York';
  const HOURS_AHEAD = 48;
  const REFRESH_MS = 15 * 60 * 1000;
  const MAP_DATA_URL = 'map/hazard-map.json';
  const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${DOCK.lat}&longitude=${DOCK.lon}`
    + '&hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m'
    + '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=America%2FNew_York&timeformat=unixtime&forecast_days=3';
  // The map opens on the State of Connecticut's aerial photos from spring 2023:
  // 3-inch pixels, tested to about 4 inches against 179 surveyed points, and
  // taken before the leaves came out, so the banks show. No key, no limits on
  // use. If the state's server cannot be reached, the USGS photos (1 m pixels,
  // summer, 2017-2021) stand in, under the same "Satellite" button.
  const TILES = {
    aerial: { name: 'Satellite', url: 'https://cteco.uconn.edu/ctraster/rest/services/images/Ortho_2023_tiled/ImageServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 20, maxNativeZoom: 20, attribution: 'Photos: <a href="https://maps.cteco.uconn.edu/data/flight2023/">CT State GIS Office</a> 2023' } },
    aerialBackup: { name: 'Satellite', url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
      options: { maxZoom: 20, maxNativeZoom: 16, attribution: 'Photos: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>' } },
    map: { name: 'Map', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      options: { maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' } },
  };
  /** State photos that fail before any has loaded: the server is down, use the USGS photos. */
  const PHOTO_FAILS = 3;
  /** A measured reading older than this is not "now". */
  const STATION_MAX_AGE_MS = 2 * 3600 * 1000;
  /** Popups narrow enough to fit a phone's map with room to spare. */
  const POPUP = { maxWidth: 240, autoPanPadding: [12, 12] };
  /** The still arrows (less motion asked for): one every this many pixels, all over the map. */
  const ARROW_STEP = 80;

  // ── Numbers and words ──────────────────────────────────────────────────────
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (deg) => DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
  const WIND_WORD = { head: 'headwind', cross: 'crosswind', tail: 'tailwind' };
  const CONDITIONS = {
    0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Freezing fog',
    51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
    71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Heavy showers',
    85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
  };
  const condition = (code) => (num(code) && CONDITIONS[code]) || '';

  /** Compass bearing (degrees from north) from a to b, each [lat, lon]. */
  function bearing(a, b) {
    const r = Math.PI / 180, p1 = a[0] * r, p2 = b[0] * r, dl = (b[1] - a[1]) * r;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / r + 360) % 360;
  }
  /** Metres between a and b, each [lat, lon]. */
  function distance(a, b) {
    const r = Math.PI / 180, dla = (b[0] - a[0]) * r, dlo = (b[1] - a[1]) * r;
    const h = Math.sin(dla / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dlo / 2) ** 2;
    return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /** The angle between two directions, 0-180. */
  const angleBetween = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);
  /** Rowing towards `heading`, with the wind coming from `from`: 'head', 'cross' or 'tail'. */
  function windOnBoat(from, heading) {
    const d = angleBetween(from, heading);
    return d <= 45 ? 'head' : d >= 135 ? 'tail' : 'cross';
  }

  /**
   * One edge of a lane (a long, thin polygon), from its northern end to its
   * southern end - the way the river runs here, so the way you row downstream.
   */
  function laneEdge(ring) {
    let pts = ring.slice();
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts = pts.slice(0, -1);
    if (pts.length < 2) return [];
    let n = 0, s = 0;
    pts.forEach((p, i) => { if (p[0] > pts[n][0]) n = i; if (p[0] < pts[s][0]) s = i; });
    if (n === s) return [];
    const out = [];
    for (let i = n; ; i = (i + 1) % pts.length) { out.push(pts[i]); if (i === s) break; }
    return out;
  }

  /**
   * How much of these lanes has the wind ahead, across or behind you, by
   * distance, rowing downstream (north to south) or upstream.
   */
  function windShares(edges, from, upstream) {
    const tot = { head: 0, cross: 0, tail: 0 };
    for (const e of edges) {
      for (let i = 1; i < e.length; i++) {
        const heading = (bearing(e[i - 1], e[i]) + (upstream ? 180 : 0)) % 360;
        tot[windOnBoat(from, heading)] += distance(e[i - 1], e[i]);
      }
    }
    const all = tot.head + tot.cross + tot.tail;
    if (!all) return null;
    return { head: tot.head / all, cross: tot.cross / all, tail: tot.tail / all };
  }
  const mostly = (sh) => Object.keys(sh).reduce((a, b) => (sh[b] > sh[a] ? b : a), 'head');

  /** "mostly headwind (64%)" */
  function mostlyText(sh) {
    if (!sh) return '';
    const k = mostly(sh);
    return `mostly ${WIND_WORD[k]} (${Math.round(sh[k] * 100)}%)`;
  }

  // ── The forecast ───────────────────────────────────────────────────────────

  /** "Now", or "Sun 7 AM" in the boathouse's time. */
  function slotLabel(ms, isNow) {
    if (isNow) return 'Now';
    return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric' }).format(new Date(ms));
  }

  /**
   * Open-Meteo's answer -> [this hour, then each of the next 48 hours]: { t,
   * label, speed, gust, from, temp, rain, code, forecast: true }. Missing
   * values stay null - never 0. All forecasts: the model's own "current"
   * values are never asked for, and the airport's measured reading takes this
   * hour's place when there is one (withStation).
   */
  function forecastSlots(fc, nowMs) {
    const h = fc && fc.hourly;
    if (!h || !Array.isArray(h.time)) return [];
    const at = (key, i) => (Array.isArray(h[key]) && num(h[key][i]) ? h[key][i] : null);
    let i0 = -1;
    h.time.forEach((t, i) => { if (num(t) && t * 1000 <= nowMs) i0 = i; });
    if (i0 < 0) return [];
    const out = [];
    for (let k = 0; k <= HOURS_AHEAD && i0 + k < h.time.length; k++) {
      const i = i0 + k;
      if (!num(h.time[i])) continue;
      out.push({ t: h.time[i] * 1000, speed: at('wind_speed_10m', i), gust: at('wind_gusts_10m', i),
        from: at('wind_direction_10m', i), temp: at('temperature_2m', i), rain: at('precipitation_probability', i),
        code: at('weather_code', i), forecast: true, isNow: k === 0 });
    }
    out.forEach((s) => { s.label = slotLabel(s.t, s.isNow); });
    return out;
  }

  /**
   * The airport's measured reading - from the page's weather card - as now, in
   * front of the forecast hours, when it is under 2 hours old. Otherwise the
   * forecast's own hour stays, labelled a forecast. `station`: { atMs, tempF,
   * windMph, deg, gustMph, code, cond, name, where }.
   */
  function withStation(slots, station, nowMs) {
    const st = station;
    if (!st || !num(st.atMs) || !num(st.tempF) || !num(st.windMph) || nowMs - st.atMs > STATION_MAX_AGE_MS) return slots;
    const now = {
      t: st.atMs, label: 'Now', isNow: true, measured: true,
      speed: st.windMph, gust: num(st.gustMph) ? st.gustMph : null, from: num(st.deg) && st.windMph > 0 ? st.deg : null,
      temp: st.tempF, rain: null, code: num(st.code) ? st.code : null,
      cond: typeof st.cond === 'string' && st.cond.trim() ? st.cond.trim() : null,
      station: typeof st.name === 'string' && st.name ? st.name : 'the airport',
      where: typeof st.where === 'string' ? st.where : '',
    };
    return [now].concat(slots.slice(slots.length && slots[0].isNow ? 1 : 0));
  }

  /** "6:05 AM", in the boathouse's time. */
  const clock = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

  /** What an hour is called where there is room: "Now, measured at the airport", "Sun 7 AM (forecast)". */
  function slotName(s) {
    if (!s) return '';
    if (s.measured) return 'Now, measured at the airport';
    return s.isNow ? 'Now (forecast)' : `${s.label} (forecast)`;
  }

  /** Where an hour's numbers come from. */
  function sourceText(s) {
    if (!s) return '';
    if (s.measured) return `Measured at ${s.station}${s.where ? `, ${s.where}` : ''}, at ${clock(s.t)}.`;
    return 'Forecast for the dock, from weather models.';
  }

  /** "12 mph from the NW, gusts 20" - or "Calm", or "Wind not available". */
  function windText(s) {
    if (!s || !num(s.speed)) return 'Wind not available';
    const mph = Math.round(s.speed);
    if (mph === 0) return 'Calm';
    const gust = num(s.gust) && Math.round(s.gust) > mph ? `, gusts ${Math.round(s.gust)}` : '';
    return num(s.from) ? `${mph} mph from the ${compass(s.from)}${gust}` : `${mph} mph${gust}`;
  }
  /** "54°F · Partly cloudy · 10% chance of rain" - for a measured hour, the station's own words for the sky. */
  function conditionsText(s) {
    if (!s) return '';
    const parts = [];
    if (num(s.temp)) parts.push(`${Math.round(s.temp)}°F`);
    const sky = s.cond || condition(s.code);
    if (sky) parts.push(sky);
    if (num(s.rain)) parts.push(`${Math.round(s.rain)}% chance of rain`);
    return parts.join(' · ');
  }
  /** Where the arrow points: downwind, the way the air is going. */
  const arrowRotation = (from) => (((from + 180) % 360) + 360) % 360;
  const isCalm = (s) => !s || !num(s.speed) || Math.round(s.speed) === 0 || !num(s.from);

  /** The course in words, both ways, for the lanes found on the map. */
  function courseText(s, lanes) {
    if (!s || !num(s.speed) || !num(s.from)) return '';
    if (Math.round(s.speed) === 0) return 'Calm on the course.';
    const down = lanes.filter((l) => l.direction === 'downstream').map((l) => l.edge);
    const up = lanes.filter((l) => l.direction === 'upstream').map((l) => l.edge);
    const goingDown = windShares(down.length ? down : up, s.from, false);
    const comingUp = windShares(up.length ? up : down, s.from, true);
    if (!goingDown || !comingUp) return '';
    return `Going downstream: ${mostlyText(goingDown)}. Coming back upstream: ${mostlyText(comingUp)}.`;
  }

  /** One lane's wind, for its popup: "Rowing upstream here: mostly headwind (80%)". */
  function laneText(s, lane) {
    if (!lane || !s || !num(s.speed) || !num(s.from)) return '';
    if (Math.round(s.speed) === 0) return 'Calm.';
    const sh = windShares([lane.edge], s.from, lane.direction === 'upstream');
    return sh ? `Rowing ${lane.direction} here: ${mostlyText(sh)}.` : '';
  }

  // ── The map's contents ─────────────────────────────────────────────────────

  /** Which way a folder's lanes are rowed, from its name ("Upstream", "Downstream 1"), or null. */
  function laneDirection(folderName) {
    const n = String(folderName || '').toLowerCase();
    if (/\bupstream\b/.test(n)) return 'upstream';
    if (/\bdownstream\b/.test(n)) return 'downstream';
    return null;
  }

  // ── Hazard pictures ────────────────────────────────────────────────────────
  // What a hazard is comes from the committee's own name for it, so a hazard
  // added on the Google map gets its picture without anyone doing anything.
  // First match wins: "Sandbar and Exposed Pipe" is a pipe, "Tree in the
  // Water and Potential Shallow Shoreline" a tree. Anything else gets "!".
  const KINDS = [
    ['stop', /\bdo not (row|pass|go)\b|\bno (rowing|entry)\b|\bstop\b|\bpower ?lines?\b|\bdam\b|\bkeep out\b/i],
    ['pipe', /\bpipes?\b/i],
    ['tree', /\btrees?\b|\blogs?\b|\bbranch(es)?\b|\bstumps?\b|\bsnags?\b|\bdebris\b/i],
    ['boulder', /\bboulders?\b|\brocks?\b|\bstones?\b/i],
    ['sandbar', /\bsand ?bars?\b/i],
    ['shallow', /\bshallows?\b|\bshoals?\b|\blow water\b/i],
    ['swim', /\bswim(ming)?\b|\bbeach\b/i],
    ['ski', /\bski(ing)?\b/i],
  ];
  const KIND_WORDS = { stop: 'Do not row beyond', pipe: 'Pipe', shallow: 'Shallow water', sandbar: 'Sandbar', boulder: 'Boulder',
    tree: 'Tree in the water', swim: 'Swim area', ski: 'Water ski course', other: 'Other hazard' };
  const KIND_ORDER = ['stop', 'pipe', 'shallow', 'sandbar', 'boulder', 'tree', 'swim', 'ski', 'other'];
  function hazardKind(name) {
    const n = String(name || '');
    for (const [kind, re] of KINDS) if (re.test(n)) return kind;
    return 'other';
  }

  // The pictures: drawn for this map, 24 x 24, in the colour that reads best
  // on the hazard's own colour (white on orange, dark on yellow).
  const WAVE = (y) => `<path d="M3.5 ${y}c1.4-1.3 2.8-1.3 4.2 0s2.8 1.3 4.2 0 2.8-1.3 4.2 0 2.8 1.3 4.2 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`;
  const GLYPHS = {
    tree: '<circle cx="12" cy="7.6" r="4.4"/><circle cx="8.2" cy="10.4" r="3.5"/><circle cx="15.8" cy="10.4" r="3.5"/><rect x="10.9" y="10.5" width="2.2" height="6.8" rx=".6"/>' + WAVE(20),
    boulder: '<path d="M4.6 17.6l1.9-6.1 3.8-3.4 4.5.3 3.6 3.5 1.2 5.7z"/>' + WAVE(20.4),
    sandbar: '<path d="M2.8 16.4c3-4.4 6.1-6.2 9.2-6.2s6.2 1.8 9.2 6.2z"/>' + WAVE(19.6),
    shallow: WAVE(7.6) + WAVE(11.6) + '<path d="M3 21v-2.2c2.4-2.2 4.9-2.6 7.4-1.3s5 1.6 7.4.3c1.2-.6 2.2-.9 3.2-.9V21z"/>',
    pipe: '<rect x="3" y="9.6" width="18" height="5" rx="1"/><rect x="6.6" y="7.9" width="2.4" height="8.4" rx=".6"/><rect x="15" y="7.9" width="2.4" height="8.4" rx=".6"/>' + WAVE(20.2),
    stop: '<rect x="4.8" y="9.8" width="14.4" height="4.4" rx="1.2"/>',
    swim: '<circle cx="16.8" cy="7.4" r="2.3"/><path d="M4.6 13.2l4.8-3.6 3.6 2.2 3.6-1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' + WAVE(16.8) + WAVE(20.4),
    ski: '<path d="M3 12.4h16.6l-2.7 4.5H6.3z"/><path d="M8.6 12.4l2.2-3.5h3.9l1.4 3.5z"/>' + WAVE(20.2),
    other: '<rect x="10.75" y="4.6" width="2.5" height="9.8" rx="1.25"/><circle cx="12" cy="18.4" r="1.75"/>',
  };
  const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
  /** White on dark colours, dark on light ones. */
  function glyphColor(hex) {
    const v = parseInt(hex.slice(1), 16);
    return 0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255) > 150 ? '#3a2c00' : '#ffffff';
  }
  /**
   * A hazard's picture as SVG text: its colour in a white ring, the picture
   * inside. Only this file's own shapes and a checked "#RRGGBB" colour go in,
   * never a name or a description; it is shown as an image, which cannot run
   * anything.
   */
  function iconSvg(kind, color) {
    const fill = SAFE_COLOR.test(String(color)) ? color : '#E65100';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 30" width="30" height="30">'
      + '<circle cx="15" cy="15" r="14" fill="#000000" fill-opacity="0.4"/>'
      + `<circle cx="15" cy="15" r="12.6" fill="${fill}" stroke="#ffffff" stroke-width="2"/>`
      + `<g transform="translate(4.2 4.2) scale(.9)" color="${glyphColor(fill)}" fill="currentColor">${GLYPHS[kind] || GLYPHS.other}</g></svg>`;
  }
  const iconUrl = (kind, color) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(iconSvg(kind, color));

  /** The middle of an area (its centroid), [lat, lon]: where its picture goes. */
  function areaMiddle(ring) {
    const p = (ring || []).slice();
    if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop();
    if (!p.length) return null;
    const [la0, lo0] = p[0];                      // relative to the first corner: no rounding loss
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < p.length; i++) {
      const y0 = p[i][0] - la0, x0 = p[i][1] - lo0, j = (i + 1) % p.length, y1 = p[j][0] - la0, x1 = p[j][1] - lo0;
      const c = x0 * y1 - x1 * y0;
      a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    if (Math.abs(a) < 1e-14) return [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];
    return [la0 + cy / (3 * a), lo0 + cx / (3 * a)];
  }

  /** A hazard's marker: its picture, centred exactly on the spot, above the wind; a button for the keyboard. */
  function hazardMarker(L, map, f, at) {
    const kind = hazardKind(f.name);
    const icon = L.icon({ iconUrl: iconUrl(kind, f.color), iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -13], className: 'hz-icon' });
    return L.marker(at, { icon, title: String(f.name || KIND_WORDS[kind]), alt: String(f.name || KIND_WORDS[kind]), keyboard: true, riseOnHover: true,
      pane: map.getPane && map.getPane('hazards') ? 'hazards' : undefined });
  }

  /**
   * Draws the club's map with Leaflet `L` on `map`: lanes and areas, then
   * hazards on top, each with its picture. Returns { lanes, bounds, count,
   * kinds }: `kinds` is one { kind, color } for each sort of hazard on the
   * map, for the key. Names and descriptions are only ever set as text,
   * never as markup. Every corner is drawn where the committee put it
   * (no smoothing).
   */
  function drawHazards(L, map, data, popupFor) {
    const lanes = [];
    const pts = [];
    const seenKinds = new Map();
    const group = L.layerGroup();
    const ordered = (data.folders || []).slice().sort((a, b) => {
      const pa = (a.features || []).some((f) => f.type === 'point') ? 1 : 0;
      const pb = (b.features || []).some((f) => f.type === 'point') ? 1 : 0;
      return pa - pb;
    });
    let count = 0;
    for (const folder of ordered) {
      const direction = laneDirection(folder.name);
      const polys = (folder.features || []).filter((f) => f.type !== 'point');
      const points = (folder.features || []).filter((f) => f.type === 'point');
      for (const f of polys.concat(points)) {
        let layer = null;
        let picture = null;                             // where this hazard's picture goes, if it has one
        if (f.type === 'polygon' && Array.isArray(f.coords) && f.coords.length >= 4) {
          layer = L.polygon(f.coords, { color: f.color, weight: Math.max(1.5, f.weight || 1), fillColor: f.fillColor,
            fillOpacity: num(f.fillOpacity) ? f.fillOpacity : 0.3, stroke: f.outline !== false, smoothFactor: 0 });
          const lane = direction ? { name: f.name, direction, edge: laneEdge(f.coords) } : null;
          if (lane && lane.edge.length > 1) lanes.push(lane);
          layer.bindPopup(() => popupFor(f, lane), POPUP);
          f.coords.forEach((c) => pts.push(c));
          if (!direction) picture = areaMiddle(f.coords);   // a swim area, the ski course: its picture in the middle
        } else if (f.type === 'line' && Array.isArray(f.coords) && f.coords.length >= 2) {
          layer = L.polyline(f.coords, { color: f.color, weight: Math.max(2, f.weight || 2), smoothFactor: 0 });
          layer.bindPopup(() => popupFor(f, null), POPUP);
          f.coords.forEach((c) => pts.push(c));
        } else if (f.type === 'point' && Array.isArray(f.coords) && num(f.coords[0]) && num(f.coords[1])) {
          picture = f.coords;
          pts.push(f.coords);
        }
        if (layer) { layer.addTo(group); count++; }
        if (picture) {
          // In their own pane, above the moving wind, so they stay clear to see and tap.
          const marker = hazardMarker(L, map, f, picture);
          marker.bindPopup(() => popupFor(f, null), POPUP);
          marker.addTo(group);
          if (!layer) count++;
          const kind = hazardKind(f.name);
          if (!seenKinds.has(kind)) seenKinds.set(kind, SAFE_COLOR.test(String(f.color)) ? f.color : '#E65100');
        }
      }
    }
    group.addTo(map);
    const kinds = KIND_ORDER.filter((k) => seenKinds.has(k)).map((k) => ({ kind: k, color: seenKinds.get(k) }));
    return { lanes, bounds: pts.length ? L.latLngBounds(pts) : null, count, kinds };
  }

  // ── The moving wind ────────────────────────────────────────────────────────

  /**
   * Streaks drifting downwind across the whole map - or, for anyone who has
   * asked their device for less motion, still arrows all over it. The wind is
   * one forecast for the whole lake, so every streak moves the same way. Gusts
   * show as some streaks running faster and longer.
   *
   * `container` gives the size (the map's box); the canvas itself goes into
   * `parent` - on the page a map pane between the lanes and the hazards, so
   * the hazards and popups stay above the streaks.
   */
  function createWindLayer(container, env, parent) {
    const doc = env.document, win = env.window;
    const canvas = doc.createElement('canvas');
    canvas.className = 'wind-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    (parent || container).appendChild(canvas);
    const reduce = !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const st = { ctx: null, W: 0, H: 0, parts: [], speed: 0, gust: 0, to: 0, color: 'rgba(11,58,74,.6)', halo: false,
      raf: null, last: 0, on: false, visible: true };

    /** How many streaks: one for every 1800 square pixels of map, 40 to 350. */
    function count() {
      return Math.max(40, Math.min(350, Math.round(st.W * st.H / 1800)));
    }
    function resize() {
      const r = container.getBoundingClientRect(), d = win.devicePixelRatio || 1;
      st.W = r.width; st.H = r.height;
      canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d);
      canvas.style.width = `${r.width}px`; canvas.style.height = `${r.height}px`;
      st.ctx = canvas.getContext('2d');
      if (st.ctx) st.ctx.setTransform(d, 0, 0, d, 0, 0);
      reseed();
    }
    function reseed() {
      st.parts = Array.from({ length: count() }, () => newParticle(true));
      draw(0);
    }
    /** Gusty when the gusts are well above the wind: up to two streaks in five ride a gust. */
    function gustShare() {
      if (!(st.gust > st.speed * 1.15) || !st.speed) return 0;
      return Math.min(0.4, (st.gust - st.speed) / st.gust);
    }
    function newParticle(anyAge) {
      const max = 1.5 + Math.random() * 2;
      const x = Math.random() * st.W, y = Math.random() * st.H;
      const gusty = Math.random() < gustShare();
      return { x, y, age: anyAge ? Math.random() * max : 0, max,
        k: gusty ? Math.min(3, st.gust / st.speed) * (0.95 + Math.random() * 0.1) : 0.85 + Math.random() * 0.3, gusty };
    }
    function stroke(c, path) {
      // A dark edge under each streak keeps white streaks clear on bright patches of the photos.
      if (st.halo) { c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 4; path(); c.stroke(); }
      c.strokeStyle = st.color; c.lineWidth = 2; path(); c.stroke();
    }
    function arrows() {
      const c = st.ctx; if (!c) return;
      c.clearRect(0, 0, st.W, st.H);
      if (!st.speed) return;
      const vx = Math.sin(st.to), vy = -Math.cos(st.to), L = Math.min(34, 10 + st.speed);
      c.lineCap = 'round';
      const step = ARROW_STEP;
      for (let y = step / 2; y < st.H; y += step) {
        for (let x = step / 2; x < st.W; x += step) {
          const ex = x + vx * L / 2, ey = y + vy * L / 2;
          stroke(c, () => {
            c.beginPath();
            c.moveTo(x - vx * L / 2, y - vy * L / 2); c.lineTo(ex, ey);
            c.moveTo(ex, ey); c.lineTo(ex - vx * 7 + vy * 5, ey - vy * 7 - vx * 5);
            c.moveTo(ex, ey); c.lineTo(ex - vx * 7 - vy * 5, ey - vy * 7 + vx * 5);
          });
        }
      }
    }
    function draw(dt) {
      const c = st.ctx; if (!c) return;
      if (reduce) { arrows(); return; }
      c.clearRect(0, 0, st.W, st.H);
      if (!st.speed) return;
      const vx = Math.sin(st.to), vy = -Math.cos(st.to);
      const pxs = 3.5 * Math.min(st.speed, 45), tail = Math.max(8, Math.min(44, 6 + 1.2 * st.speed));
      c.lineCap = 'round';
      for (const p of st.parts) {
        const step = pxs * p.k * dt;
        p.x += vx * step; p.y += vy * step; p.age += dt;
        const life = p.age / p.max;
        if (life >= 1 || p.x < -50 || p.y < -50 || p.x > st.W + 50 || p.y > st.H + 50) {
          Object.assign(p, newParticle(false)); continue;
        }
        const t = p.gusty ? tail * 1.5 : tail;
        c.globalAlpha = Math.sin(Math.PI * life);
        stroke(c, () => { c.beginPath(); c.moveTo(p.x - vx * t, p.y - vy * t); c.lineTo(p.x, p.y); });
      }
      c.globalAlpha = 1;
    }
    function frame(t) {
      st.raf = null;
      if (!st.on || !st.visible) return;
      const dt = st.last ? Math.min(0.1, (t - st.last) / 1000) : 0;
      st.last = t;
      draw(dt);
      st.raf = win.requestAnimationFrame(frame);
    }
    function run() {
      if (reduce || !st.on || !st.visible || st.raf || !st.speed) return;
      st.last = 0;
      st.raf = win.requestAnimationFrame(frame);
    }
    return {
      canvas, reduce, state: st, resize,
      /** The wind to show: mph, the direction it comes from (null for none), and the gusts. */
      set(speed, from, gust) {
        const before = gustShare();
        st.speed = num(speed) && num(from) && Math.round(speed) > 0 ? speed : 0;
        st.gust = num(gust) ? gust : 0;
        st.to = num(from) ? arrowRotation(from) * Math.PI / 180 : 0;
        if (gustShare() !== before) st.parts = Array.from({ length: count() }, () => newParticle(true));
        draw(0);
        run();
      },
      /** Streak colour; `halo` puts a dark edge under them (on the photos). */
      setColor(color, halo) { st.color = color; st.halo = !!halo; draw(0); },
      start() { st.on = true; run(); },
      stop() { st.on = false; if (st.raf) { win.cancelAnimationFrame(st.raf); st.raf = null; } },
      /** Off screen or a hidden tab: no drawing, no battery. */
      setVisible(v) { st.visible = !!v; if (v) run(); else if (st.raf) { win.cancelAnimationFrame(st.raf); st.raf = null; } },
    };
  }

  // ── The page ───────────────────────────────────────────────────────────────

  function el(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /** The arrow for the wind badge: SVG, pointing downwind. */
  function arrowSvg(doc, from) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('aria-hidden', 'true');
    const ring = doc.createElementNS(ns, 'circle');
    ring.setAttribute('cx', '20'); ring.setAttribute('cy', '20'); ring.setAttribute('r', '18');
    ring.setAttribute('class', 'arrow-ring');
    svg.appendChild(ring);
    if (num(from)) {
      const g = doc.createElementNS(ns, 'g');
      g.setAttribute('transform', `rotate(${arrowRotation(from)} 20 20)`);
      const head = doc.createElementNS(ns, 'path');
      head.setAttribute('d', 'M20 5 L27 18 L20 15 L13 18 Z');
      head.setAttribute('class', 'arrow-head');
      const shaft = doc.createElementNS(ns, 'path');
      shaft.setAttribute('d', 'M20 15 L20 34');
      shaft.setAttribute('class', 'arrow-shaft');
      g.appendChild(head); g.appendChild(shaft);
      svg.appendChild(g);
    }
    return svg;
  }

  function init(env) {
    const doc = env.document, win = env.window, L = env.L;
    const $ = (id) => doc.getElementById(id);
    const state = { slots: [], fcSlots: [], station: win.NHRC_STATION || null, index: 0, lanes: [], fetchedAt: 0, tried: false,
      map: null, wind: null, badge: null, base: 'aerial', photos: 'state', tabVisible: doc.visibilityState !== 'hidden', onScreen: true };
    // The streaks move only while someone can see them: the tab open and the map on screen.
    const seen = () => { if (state.wind) state.wind.setVisible(state.tabVisible && state.onScreen); };

    const slider = $('wind-time'), timeLabel = $('wind-time-label'), windLine = $('wind-line'),
      condLine = $('wind-conditions'), sourceLine = $('wind-source'), courseLine = $('wind-course'),
      status = $('wind-status'), mapStatus = $('map-status');

    function popupFor(f, lane) {
      const box = el(doc, 'div', 'map-popup');
      box.appendChild(el(doc, 'strong', '', f.name || ''));
      if (f.description) box.appendChild(el(doc, 'p', '', f.description));
      if (lane) {
        const s = state.slots[state.index];
        const words = laneText(s, lane);
        if (words) box.appendChild(el(doc, 'p', 'popup-wind', `${slotName(s)}: ${windText(s)}. ${words}`));
      }
      return box;
    }

    function showSlot() {
      if (!state.tried) return;                         // still loading: the page says so
      const s = state.slots[state.index];
      if (timeLabel) timeLabel.textContent = s ? s.label : '';
      if (windLine) windLine.textContent = windText(s);
      if (condLine) condLine.textContent = conditionsText(s);
      if (sourceLine) sourceLine.textContent = sourceText(s);
      if (courseLine) courseLine.textContent = courseText(s, state.lanes);
      if (slider && s) slider.setAttribute('aria-valuetext', `${slotName(s)}: ${windText(s)}`);
      if (state.badge) {
        state.badge.textContent = '';
        state.badge.appendChild(arrowSvg(doc, isCalm(s) ? null : s.from));
        const words = el(doc, 'div', 'badge-words');
        words.appendChild(el(doc, 'b', '', windText(s)));
        words.appendChild(el(doc, 'span', '', slotName(s)));
        state.badge.appendChild(words);
      }
      if (state.wind) state.wind.set(s ? s.speed : null, s ? s.from : null, s ? s.gust : null);
    }

    function setSlots(slots) {
      const keep = state.slots[state.index];
      state.slots = slots;
      // After a refresh, stay on the same hour if it is still there.
      const same = keep && !keep.isNow ? slots.findIndex((x) => !x.isNow && x.t === keep.t) : 0;
      state.index = same > 0 ? same : 0;
      if (slider) {
        slider.max = String(Math.max(0, slots.length - 1));
        slider.value = String(state.index);
        slider.disabled = slots.length < 2;
      }
      showSlot();
    }

    // The hours to show: the forecast, with the airport's reading as now when there is one.
    const refreshSlots = () => setSlots(withStation(state.fcSlots, state.station, Date.now()));

    async function loadForecast() {
      try {
        const r = await env.fetch(FORECAST_URL);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const slots = forecastSlots(await r.json(), Date.now());
        if (!slots.length) throw new Error('no forecast in the answer');
        state.fetchedAt = Date.now();
        state.tried = true;
        state.fcSlots = slots;
        if (status) status.textContent = '';
        refreshSlots();
      } catch (e) {
        state.tried = true;
        if (!state.fcSlots.length) {
          refreshSlots();
          if (status) status.textContent = 'The wind forecast could not be loaded. It is tried again every 15 minutes.';
        }
      }
    }
    // The weather card hands over each new airport reading.
    if (win.addEventListener) {
      win.addEventListener('nhrc-station', (e) => {
        state.station = (e && e.detail) || null;
        if (state.tried) refreshSlots();
      });
    }

    async function loadMapData() {
      try {
        const r = await env.fetch(MAP_DATA_URL, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) {
        if (mapStatus) mapStatus.textContent = 'The hazard map could not be loaded. Reload the page to try again.';
        return null;
      }
    }

    if (slider) {
      slider.addEventListener('input', () => {
        state.index = Math.max(0, Math.min(state.slots.length - 1, Number(slider.value) || 0));
        showSlot();
      });
    }
    const nowBtn = $('wind-now');
    if (nowBtn) nowBtn.addEventListener('click', () => { state.index = 0; if (slider) slider.value = '0'; showSlot(); });

    const forecast = loadForecast();
    const timer = win.setInterval(loadForecast, REFRESH_MS);
    doc.addEventListener('visibilitychange', () => {
      state.tabVisible = doc.visibilityState !== 'hidden';
      seen();
      if (state.tabVisible && Date.now() - state.fetchedAt > REFRESH_MS) loadForecast();
    });

    // The map itself. Without Leaflet (a blocked or failed download), the
    // wind still shows in words below.
    const mapBox = $('hazard-map');
    if (!L || !mapBox) {
      if (mapStatus) mapStatus.textContent = 'The map could not be loaded. The wind is still given below.';
      return { state, forecast, timer };
    }
    // The page scrolls past the map: the wheel does not zoom it (the buttons do).
    // The lake runs from top left to bottom right, so the map's own controls
    // sit top right, over land; the other buttons are below the map.
    const map = L.map(mapBox, { zoomSnap: 0.5, scrollWheelZoom: false, zoomControl: false });
    state.map = map;
    const FIT = { paddingTopLeft: [20, 20], paddingBottomRight: [20, 34] };   // clear of the credits line
    // The whole lake in view. A map with no size yet (a tab opened in the background,
    // a page still laying out) would zoom all the way in on the middle of the lake -
    // the woods by the river - so it waits until the map has a size.
    const fitLake = () => {
      const size = map.getSize ? map.getSize() : null;
      if (size && !(size.x > 0 && size.y > 0)) { state.fitPending = true; return; }
      state.fitPending = false;
      map.fitBounds(state.bounds || LAKE_BOUNDS, FIT);
    };
    fitLake();
    map.createPane('hazards');
    map.getPane('hazards').style.zIndex = '620';
    // The photos first; the street map one tap away. The photos sit in a group,
    // so the USGS ones can take their place if the state's server is down.
    const photos = L.tileLayer(TILES.aerial.url, TILES.aerial.options);
    const base = { aerial: L.layerGroup([photos]), map: L.tileLayer(TILES.map.url, TILES.map.options) };
    let photosLoaded = 0, photosFailed = 0;
    photos.on('tileload', () => { photosLoaded++; });
    photos.on('tileerror', () => {
      photosFailed++;
      if (photosLoaded || photosFailed !== PHOTO_FAILS) return;
      base.aerial.removeLayer(photos);
      base.aerial.addLayer(L.tileLayer(TILES.aerialBackup.url, TILES.aerialBackup.options));
      state.photos = 'usgs';
    });
    base.aerial.addTo(map);

    // The pictures shrink when the whole lake is in view, so they do not pile up.
    const iconScale = () => {
      const z = map.getZoom(), cl = mapBox.classList;
      if (!cl) return;
      cl.toggle('hz-far', z < 14);
      cl.toggle('hz-mid', z >= 14 && z < 15.5);
    };
    map.on('zoomend', iconScale);

    // The moving wind lives in its own map pane, above the lanes (400) and
    // below the hazards (620) and popups (700). The pane moves when the map
    // is dragged, so the canvas is put back over the visible map each time.
    const windPane = map.createPane('wind');
    windPane.style.zIndex = '450';
    windPane.style.pointerEvents = 'none';
    state.wind = createWindLayer(mapBox, { document: doc, window: win }, windPane);
    const place = () => { if (L.DomUtil.setPosition) L.DomUtil.setPosition(state.wind.canvas, map.containerPointToLayerPoint([0, 0])); };
    map.on('move zoomend viewreset resize', place);
    const streakColor = () => (state.base === 'aerial' ? 'rgba(255,255,255,.85)' : 'rgba(11,58,74,.6)');
    state.wind.setColor(streakColor(), state.base === 'aerial');

    const badge = L.control({ position: 'topright' });
    badge.onAdd = () => { const d = L.DomUtil.create('div', 'wind-badge'); d.setAttribute('aria-hidden', 'true'); return d; };
    badge.addTo(map);
    state.badge = badge.getContainer ? badge.getContainer() : null;
    L.control.zoom({ position: 'topright' }).addTo(map);

    // The boathouse: the club's logo on white in the header's navy and gold rings, centred on the
    // dock, above every hazard's picture.
    const dock = L.marker([DOCK.lat, DOCK.lon], {
      icon: L.icon({ iconUrl: LOGO_URL, iconSize: [58, 58], iconAnchor: [29, 29], popupAnchor: [0, -29], className: 'dock-icon' }),
      title: 'NHRC boathouse dock', alt: 'NHRC boathouse dock', keyboard: true, zIndexOffset: 1000, pane: 'hazards' });
    dock.bindPopup(() => el(doc, 'strong', '', 'NHRC boathouse dock'), POPUP).addTo(map);

    // Below the map: the two views, and photos or street map.
    const tools = $('map-tools');
    if (tools) {
      const button = (text, onClick) => { const b = el(doc, 'button', 'rb', text); b.type = 'button'; b.addEventListener('click', onClick); tools.appendChild(b); return b; };
      button('Boathouse', () => map.setView([DOCK.lat, DOCK.lon], 16));
      button('Whole lake', fitLake);
      const swap = button('Street map', () => {
        const toMap = state.base === 'aerial';
        map.removeLayer(toMap ? base.aerial : base.map);
        (toMap ? base.map : base.aerial).addTo(map);
        state.base = toMap ? 'map' : 'aerial';
        swap.textContent = toMap ? 'Satellite' : 'Street map';
        state.wind.setColor(streakColor(), state.base === 'aerial');
      });
    }

    const sized = () => { map.invalidateSize(); if (state.fitPending) fitLake(); state.wind.resize(); place(); };
    if (win.ResizeObserver) new win.ResizeObserver(sized).observe(mapBox);
    else win.addEventListener('resize', sized);
    if (win.IntersectionObserver) {
      new win.IntersectionObserver((es) => es.forEach((e) => { state.onScreen = e.isIntersecting; seen(); })).observe(mapBox);
    }
    state.wind.resize();
    place();
    seen();
    iconScale();
    state.wind.start();

    const drawn = loadMapData().then((data) => {
      if (!data) return;
      const out = drawHazards(L, map, data, popupFor);
      state.lanes = out.lanes;
      state.bounds = out.bounds;
      if (out.bounds) fitLake();
      const copied = $('map-copied');
      if (copied && data.copied) copied.textContent = data.copied;
      // The key: one picture for each sort of hazard on the map, as it looks there.
      const key = $('hazard-key');
      if (key) {
        key.textContent = '';
        for (const k of out.kinds) {
          const item = el(doc, 'span', 'hz-key');
          const img = el(doc, 'img');
          img.src = iconUrl(k.kind, k.color);
          img.alt = '';
          img.width = 18; img.height = 18;
          item.appendChild(img);
          item.appendChild(el(doc, 'span', '', KIND_WORDS[k.kind]));
          key.appendChild(item);
        }
      }
      showSlot();
    });
    return { state, forecast, drawn, timer, map };
  }

  const api = {
    DOCK, LOGO_URL, LAKE_BOUNDS, TZ, HOURS_AHEAD, FORECAST_URL, MAP_DATA_URL, TILES, PHOTO_FAILS, POPUP, REFRESH_MS,
    hazardKind, KIND_WORDS, KIND_ORDER, GLYPHS, glyphColor, iconSvg, iconUrl, areaMiddle, ARROW_STEP,
    compass, bearing, distance, angleBetween, windOnBoat, laneEdge, windShares, mostlyText, slotLabel,
    forecastSlots, withStation, slotName, sourceText, STATION_MAX_AGE_MS, windText, conditionsText, arrowRotation, isCalm, courseText, laneText, laneDirection,
    drawHazards, createWindLayer, arrowSvg, init,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.NHRCWindMap = api;
    const go = () => {
      try {
        init({ document: root.document, window: root, L: root.L, fetch: root.fetch.bind(root) });
      } catch (e) {
        const s = root.document.getElementById('map-status');
        if (s) s.textContent = 'The map could not be started. Reload the page to try again.';
      }
    };
    const start = () => {
      if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', go);
      else go();
    };
    start.once = (() => { let done = false; return () => { if (!done) { done = true; start(); } }; })();
    // Leaflet loads on its own (async), so it may still be on its way: wait for
    // it - or for its failure, after which the wind is still given in words.
    const tag = root.document.getElementById('leaflet-js');
    if (root.L || !tag || (tag.dataset && tag.dataset.failed)) start.once();
    else {
      tag.addEventListener('load', start.once);
      tag.addEventListener('error', start.once);
      root.setTimeout(start.once, 20000);
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
