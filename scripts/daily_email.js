#!/usr/bin/env node
/**
 * NHRC Daily Conditions Email
 * ---------------------------
 * Builds and (optionally) sends the daily conditions digest.
 *
 * DESIGN NOTE — WHY THIS EXTRACTS LOGIC FROM index.html
 * ------------------------------------------------------
 * The rowing-status rules (temperature zones, 3-morning streak confirmation,
 * flood restrictions, tier tables) are SAFETY-CRITICAL. If this script
 * reimplemented them, the email and the website could silently drift apart
 * after any future edit to index.html — and members could be told they may row
 * when the site says they may not.
 *
 * To make that class of bug structurally impossible, this script parses the
 * real functions out of index.html and evaluates them. There is exactly ONE
 * source of truth for the rules: index.html. Change the rules there, and this
 * email follows automatically.
 *
 * Usage:
 *   node scripts/daily_email.js            # print HTML to stdout (dry run)
 *   node scripts/daily_email.js --send     # send via Buttondown API
 *   node scripts/daily_email.js --json     # print computed data as JSON
 */

'use strict';

// Node 18+ is required for the built-in global fetch() this script relies on.
// Fail with a plain-English message rather than a confusing "fetch is not
// defined" several seconds into the run.
const NODE_MAJOR = parseInt(process.versions.node.split('.')[0], 10);
if (NODE_MAJOR < 18) {
  console.error(
    `This script needs Node 18 or newer (you have ${process.versions.node}).\n` +
    `Install the LTS release from https://nodejs.org, then open a NEW terminal window and try again.`);
  process.exit(1);
}

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');

// ═════════════════════════════════════════════════════════════════════════════
// ROWING SEASON — Safety Committee setting
// ═════════════════════════════════════════════════════════════════════════════
// The daily email is sent every day DURING the season and paused outside it.
//
// Both endpoints are INCLUSIVE: with the values below, March 15 and November 15
// both receive an email; March 14 and November 16 do not. Months are 1-based
// (1 = January ... 12 = December).
//
// The date is evaluated in America/New_York, NOT UTC. This matters: the job
// fires at 08:00/09:00 UTC, which is still the previous calendar day in the
// evening — a UTC comparison would start and end the season a day early.
//
// To change the season, edit these four numbers. A range that wraps the new
// year (e.g. Nov 1 -> Mar 31) is supported.
const SEASON = {
  startMonth: 3,  startDay: 15,   // March 15
  endMonth:  11,  endDay:   15,   // November 15
};

/**
 * True if the given instant falls inside the configured rowing season,
 * evaluated in the boathouse's local timezone. Handles ranges that wrap the
 * year end. Both endpoints are inclusive.
 */
function isInSeason(now = new Date(), season = SEASON) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'numeric', day: 'numeric',
  }).formatToParts(now);
  const month = parseInt(parts.find(p => p.type === 'month').value, 10);
  const day   = parseInt(parts.find(p => p.type === 'day').value, 10);

  // Encode month/day as a single comparable integer (e.g. Mar 15 -> 315,
  // Nov 15 -> 1115) so the range check is a plain numeric comparison.
  const key   = month * 100 + day;
  const start = season.startMonth * 100 + season.startDay;
  const end   = season.endMonth   * 100 + season.endDay;

  return start <= end
    ? (key >= start && key <= end)    // normal range, e.g. Mar 15 - Nov 15
    : (key >= start || key <= end);   // wraps the year, e.g. Nov 1 - Mar 31
}

// Buttondown's free tier caps at 100 subscribers. Warn before that becomes a
// silent delivery failure for members who signed up but sit past the cap.
const SUBSCRIBER_WARN_THRESHOLD = 90;
const SUBSCRIBER_FREE_LIMIT = 100;

// ─────────────────────────────────────────────────────────────────────────────
// Club logo
// ─────────────────────────────────────────────────────────────────────────────
// Email clients do NOT render SVG (Gmail, Outlook and Apple Mail all block or
// fail on it), so the email uses a PNG rendered from NHRC_logo.svg, on the same
// white circle with a gold ring that the website header uses. The surround is
// baked to WHITE to match the email card — the email is a light design, because
// clients that force dark mode frequently invert backgrounds without inverting
// inline-coloured text, which left the old dark version unreadable.
//
// The image must be referenced by absolute URL — mail clients cannot read files
// from the repo. It is served by GitHub Pages from the site root once merged.
//
// To preview before the file is live on the site (e.g. testing from a branch),
// point EMAIL_LOGO_URL at the raw GitHub copy:
//   EMAIL_LOGO_URL=https://raw.githubusercontent.com/egurpinar/NHRC_temp_monitoring/daily-conditions-email/nhrc_email_logo.png \
//     node scripts/daily_email.js > preview.html
//
// To regenerate the PNG after changing the SVG, see scripts/README.md.
const LOGO_URL = process.env.EMAIL_LOGO_URL || 'https://roworno.com/nhrc_email_logo.png';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Load the site's own logic out of index.html
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the site's inline <script> and evaluates the pure-logic functions in
 * a sandbox with a minimal DOM stub. We only ever call pure functions
 * (getEffectiveLevel, floodStatusForBoat, etc.) — never the render functions —
 * so the DOM stub just needs to keep top-level code from throwing.
 */
function loadSiteLogic(indexHtmlPath = INDEX_HTML) {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  if (!match) throw new Error('Could not find the main inline <script> in index.html');
  const src = match[1];

  const noop = () => {};
  const fakeEl = () => ({
    innerHTML: '', textContent: '', className: '', style: {},
    getContext: () => ({ createLinearGradient: () => ({ addColorStop: noop }) }),
    addEventListener: noop, querySelector: () => null,
  });

  const sandbox = {
    document: {
      getElementById: fakeEl,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: noop,
      createElement: fakeEl,
    },
    window: { addEventListener: noop },
    fetch: () => Promise.reject(new Error('network disabled in logic sandbox')),
    Chart: function () { return { destroy: noop, update: noop }; },
    moment: {},
    setInterval: noop,
    setTimeout: noop,
    console: { log: noop, warn: noop, error: noop },
    URL: { createObjectURL: noop, revokeObjectURL: noop },
    Blob: function () {},
    Intl,
    Date,
    Math,
    JSON,
    isNaN,
    parseInt,
    parseFloat,
    Number,
    Array,
    Object,
    String,
  };

  // Expose the pure functions + shared state object we need.
  const EXPORTS = [
    'state', 'ZONE_TIERS', 'ZONE_OVERRIDE',
    'getEffectiveLevel', 'checkMorningStreak', 'nyWindowBound', 'nyTzAbbr',
    'getFloodStatus', 'combineStatus', 'boatKeys', 'floodStatusForBoat',
    'floodSummaryLabel', 'extractTemp', 'parseLastDeviceData',
    'WMO_CODES', 'WMO_ICONS',
  ];
  const exportSrc = EXPORTS
    .map(n => `try { __out.${n} = ${n}; } catch (e) {}`)
    .join('\n');

  const vm = require('vm');
  const context = vm.createContext({ ...sandbox, __out: {} });
  vm.runInContext(src + '\n' + exportSrc, context, { timeout: 10000 });
  return context.__out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Data loading
// ─────────────────────────────────────────────────────────────────────────────

function loadLocalData() {
  const dataPath = path.join(REPO_ROOT, 'data.json');
  const histPath = path.join(REPO_ROOT, 'history.json');

  let raw = null, history = [];
  try { raw = JSON.parse(fs.readFileSync(dataPath, 'utf8')); }
  catch (e) { throw new Error(`Could not read data.json: ${e.message}`); }

  try {
    const h = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    if (Array.isArray(h)) {
      history = h.map(x => ({
        ts: new Date(x.ts).getTime(),
        tempF: x.tempF != null ? x.tempF : Math.round((x.tempC * 9 / 5 + 32) * 10) / 10,
      })).filter(x => !isNaN(x.ts) && !isNaN(x.tempF)).sort((a, b) => a.ts - b.ts);
    }
  } catch (e) {
    // history.json is optional — the streak logic degrades gracefully without it
  }

  return { raw, history };
}

const NOAA_BASE = 'https://api.water.noaa.gov/nwps/v1/gauges/STVC3/stageflow/';
const STALE_MS = 6 * 3600000; // must match index.html's river staleness threshold

async function fetchJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseGaugeSeries(payload) {
  const arr = payload?.data || [];
  return arr
    .filter(d => d.primary !== null && d.primary !== undefined && d.primary > 0)
    .map(d => ({ ts: new Date(d.validTime).getTime(), ft: parseFloat(d.primary) }))
    .filter(d => !isNaN(d.ts) && !isNaN(d.ft))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Mirrors index.html's river logic, including the stale-observed fallback:
 * NOAA's observed feed for this gauge has been seen frozen for weeks while the
 * forecast kept updating. Never silently present a stale reading as current.
 */
async function loadRiver() {
  let observed = [], forecast = [], failed = false;
  try {
    const [obs, fc] = await Promise.all([
      fetchJson(NOAA_BASE + 'observed').catch(() => null),
      fetchJson(NOAA_BASE + 'forecast').catch(() => null),
    ]);
    if (obs) observed = parseGaugeSeries(obs);
    if (fc) forecast = parseGaugeSeries(fc);
    if (!obs && !fc) failed = true;
  } catch (e) {
    failed = true;
  }

  const lastObsTs = observed.length ? observed[observed.length - 1].ts : null;
  const isStale = lastObsTs === null || (Date.now() - lastObsTs) > STALE_MS;

  let level = null, isEstimate = false;
  if (!isStale) {
    level = observed[observed.length - 1].ft;
  } else if (forecast.length) {
    const nearest = forecast.reduce((a, b) =>
      Math.abs(b.ts - Date.now()) < Math.abs(a.ts - Date.now()) ? b : a);
    level = nearest.ft;
    isEstimate = true;
  } else if (lastObsTs !== null) {
    level = observed[observed.length - 1].ft;
  }

  return {
    level, isEstimate, failed,
    stale: isStale,
    ageMs: lastObsTs !== null ? Date.now() - lastObsTs : null,
    lastObsTs,
  };
}

// Weather condition names and icons are extracted from index.html (see
// loadSiteLogic) so the email matches the website. These fallbacks are used
// only if extraction ever fails, so a cosmetic lookup can never break a send.
const WMO_CODES_FALLBACK = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Moderate showers', 82: 'Violent showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ heavy hail',
};
// HTML entities rather than literal emoji: they survive any encoding mishap
// between here, Buttondown, and the recipient's mail client.
const WMO_ICONS_FALLBACK = {
  0: '&#9728;', 1: '&#127780;', 2: '&#9925;', 3: '&#9729;', 45: '&#127787;', 48: '&#127787;',
  51: '&#127782;', 53: '&#127782;', 55: '&#127783;',
  61: '&#127783;', 63: '&#127783;', 65: '&#127783;',
  71: '&#127784;', 73: '&#127784;', 75: '&#10052;', 77: '&#127784;',
  80: '&#127782;', 81: '&#127783;', 82: '&#9928;',
  85: '&#127784;', 86: '&#10052;', 95: '&#9928;', 96: '&#9928;', 99: '&#9928;',
};
const DEFAULT_WEATHER_ICON = '&#127777;'; // thermometer, for unmapped codes

function windDirLabel(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

/**
 * Resolves a WMO weather code to its label and icon, preferring the site's own
 * mapping so the email and website agree, with a local fallback.
 */
function describeWeatherCode(code, logic) {
  const codes = (logic && logic.WMO_CODES) || WMO_CODES_FALLBACK;
  const icons = (logic && logic.WMO_ICONS) || WMO_ICONS_FALLBACK;
  return {
    cond: codes[code] || 'Unknown',
    icon: icons[code] || DEFAULT_WEATHER_ICON,
  };
}

/**
 * Adds `cond` and `icon` to a weather object. Only overrides an existing
 * `cond` when there is actually a code to resolve — otherwise a caller that
 * supplied its own label (or an API response missing weather_code) would have
 * it silently replaced with "Unknown".
 */
function withWeatherDescription(weather, logic) {
  if (!weather || !weather.available) return weather;
  const hasCode = weather.code !== undefined && weather.code !== null;
  const resolved = hasCode ? describeWeatherCode(weather.code, logic) : {};
  return Object.assign({}, weather, {
    cond: resolved.cond || weather.cond || 'Unknown',
    icon: resolved.icon || weather.icon || DEFAULT_WEATHER_ICON,
  });
}

async function loadWeather() {
  const lat = 41.4370, lon = -73.1190; // NHRC boathouse, Oxford CT
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=America%2FNew_York`;
  try {
    const data = await fetchJson(url);
    const c = data.current;
    return {
      available: true,
      code: c.weather_code,
      tempF: Math.round(c.temperature_2m),
      feelsF: Math.round(c.apparent_temperature),
      windMph: Math.round(c.wind_speed_10m),
      gustMph: Math.round(c.wind_gusts_10m),
      dir: windDirLabel(c.wind_direction_10m),
      precip: Number(c.precipitation).toFixed(2),
    };
  } catch (e) {
    return { available: false };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Compute the digest using the SITE'S OWN rules
// ─────────────────────────────────────────────────────────────────────────────

const ZONE_LABEL = {
  winter:    'Winter Rowing in effect',
  fourOar:   'Four Oar Rule in effect',
  coldWater: 'Cold Water restrictions apply',
  normal:    'Normal rowing conditions',
};
const ZONE_COLOR = {
  winter:    { bg: 'rgba(224,62,62,0.12)',  border: 'rgba(224,62,62,0.4)',  text: '#f07070' },
  fourOar:   { bg: 'rgba(255,209,102,0.15)', border: 'rgba(255,209,102,0.5)', text: '#ffd166' },
  coldWater: { bg: 'rgba(255,209,102,0.15)', border: 'rgba(255,209,102,0.5)', text: '#ffd166' },
  normal:    { bg: 'rgba(46,125,79,0.15)',  border: 'rgba(46,125,79,0.4)',  text: '#5cc98a' },
};

function computeDigest(logic, { raw, history }, river, weather, now = new Date()) {
  const tempC = logic.extractTemp(raw);
  if (tempC === null || tempC === undefined) {
    throw new Error('Could not extract water temperature from data.json');
  }
  const tempF = Math.round((tempC * 9 / 5 + 32) * 10) / 10;
  const fetchedAt = raw.fetchedAt ? new Date(raw.fetchedAt) : null;

  // Populate the site's state object exactly as the browser would.
  logic.state.allHistory   = history;
  logic.state.lastTempF    = tempF;
  logic.state.lastFetchedAt = fetchedAt;
  logic.state.riverLevel   = river.level;

  const eff   = logic.getEffectiveLevel(tempF);
  const tiers = logic.ZONE_TIERS[eff.zone];

  // Combine temperature status with flood status per boat — same as the site.
  const rows = tiers.map(tier => ({
    name: tier.name,
    boats: tier.boats.map(b => {
      const floodS   = logic.floodStatusForBoat(b.name, river.level);
      const combined = logic.combineStatus(b.s, floodS);
      let label;
      if (combined === 'no')            label = 'No';
      else if (combined === 'caution')  label = 'Caution';
      else if (b.note)                  label = 'Cond.';
      else                              label = 'Go';
      return { name: b.name, status: combined, label, note: b.note || null };
    }),
  }));

  const floodSummary = river.level !== null ? logic.floodSummaryLabel(river.level) : null;

  // Sensor freshness — mirrors the site's 3-hour offline threshold.
  const sensorAgeMs = fetchedAt ? (now.getTime() - fetchedAt.getTime()) : null;
  const sensorStale = sensorAgeMs !== null && sensorAgeMs > 3 * 3600000;

  return {
    dateLabel: now.toLocaleDateString('en-US', {
      timeZone: 'America/New_York', weekday: 'long', year: 'numeric',
      month: 'long', day: 'numeric',
    }),
    timeLabel: now.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
    }),
    tz: logic.nyTzAbbr(now.getTime()),
    tempF,
    zone: eff.zone,
    zoneLabel: ZONE_LABEL[eff.zone] || eff.zone,
    zoneColor: ZONE_COLOR[eff.zone] || ZONE_COLOR.normal,
    immediate: !!eff.immediate,
    rows,
    river,
    floodSummary,
    // Resolve the condition label and icon here, where the site's own mapping
    // is available, so the email uses the same icons the website shows.
    weather: withWeatherDescription(weather, logic),
    sensorStale,
    sensorAgeMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Render the email
// ─────────────────────────────────────────────────────────────────────────────
//
// HARD CONSTRAINTS — read before changing anything here.
//
// 1. THIS MUST BE A FRAGMENT, NOT A DOCUMENT.
//    Buttondown's free plan wraps our content inside its own email template
//    ("naked mode", which gives full document control, is Professional-only).
//    Emitting <!DOCTYPE>/<html>/<head> nests a document inside their <body>;
//    clients then discard our <head>, taking every <style> rule with it, and
//    Buttondown's template CSS colours our text instead. That is exactly what
//    produced black tier labels and white-on-grey weather text.
//
// 2. NO <style> BLOCKS AND NO MEDIA QUERIES.
//    They live in <head>, so per (1) they cannot be relied on. Every rule here
//    is an inline style attribute, and the layout must work at any width
//    without a breakpoint.
//
// 3. LIGHT PALETTE, DARK TEXT.
//    A dark design is fragile: clients that force dark mode often invert
//    backgrounds but not inline-coloured text, leaving white text on white.
//    A light design degrades safely — inverted it becomes light text on dark,
//    which is still legible. Brand colour comes from the logo and gold accents
//    rather than large dark fills.
//
// 4. EVERY TEXT CONTAINER SETS BOTH color AND background-color.
//    Never inherit either. Inheriting is how our text ended up on Buttondown's
//    background.
//
// 5. NO rgba() — several clients drop alpha colours entirely.
//
// These rules are enforced by tests in test_daily_email.js.

const C = {
  page:      '#eef1f6',
  card:      '#ffffff',
  border:    '#d8dfe9',
  ink:       '#16233b',  // primary text
  inkSoft:   '#5a6b85',  // secondary text
  rule:      '#f0b429',  // gold accent (borders/fills only — too light for text)
  label:     '#8a6400',  // dark gold, readable as text on white
  goBg:      '#e4f4ea', goText:      '#14622f', goBorder:      '#a9d8bd',
  cautionBg: '#fdf2d8', cautionText: '#7a5600', cautionBorder: '#e6c66a',
  noBg:      '#fdeaea', noText:      '#96201f', noBorder:      '#e8a3a3',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STATUS_STYLE = {
  go:      { bg: C.goBg,      text: C.goText,      border: C.goBorder },
  caution: { bg: C.cautionBg, text: C.cautionText, border: C.cautionBorder },
  no:      { bg: C.noBg,      text: C.noText,      border: C.noBorder },
};

function statusPill(status, label) {
  const s = STATUS_STYLE[status] || STATUS_STYLE.go;
  return `<span style="display:inline-block;background-color:${s.bg};color:${s.text};` +
    `border:1px solid ${s.border};font-size:12px;font-weight:bold;padding:3px 10px;` +
    `border-radius:12px;white-space:nowrap;">${esc(label)}</span>`;
}

/** A section heading: small dark-gold label above a block. */
function sectionLabel(text) {
  return `<div style="font-size:11px;font-weight:bold;letter-spacing:0.08em;` +
    `text-transform:uppercase;color:${C.label};background-color:${C.card};` +
    `padding:0 0 8px 0;">${esc(text)}</div>`;
}

function renderEmailHtml(d) {
  const PAD = 20; // modest padding so 320px screens still have room

  // ── Warnings ───────────────────────────────────────────────────────────────
  const warnings = [];
  if (d.sensorStale) {
    const hrs = Math.floor(d.sensorAgeMs / 3600000);
    warnings.push(`<strong>Water sensor may be offline.</strong> No new reading in ${hrs}+ hours — the temperature below is the last known value. Verify against the thermometer at the dock.`);
  }
  if (d.river.failed) {
    warnings.push(`<strong>River level unavailable.</strong> NOAA data could not be retrieved, so flood restrictions are not reflected below. Check the gauge before launching.`);
  } else if (d.river.stale) {
    const days = d.river.ageMs !== null ? Math.floor(d.river.ageMs / 86400000) : null;
    warnings.push(`<strong>River gauge data is stale.</strong> NOAA's observed reading hasn't updated in ${days !== null ? days + ' day' + (days === 1 ? '' : 's') : 'an extended period'}. The level below is estimated from NOAA's forecast, not a live sensor.`);
  }

  const warningHtml = warnings.map(w =>
    `<tr><td style="padding:0 ${PAD}px 12px ${PAD}px;background-color:${C.card};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr><td style="background-color:${C.noBg};border:1px solid ${C.noBorder};border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.5;color:${C.noText};font-family:Arial,Helvetica,sans-serif;">${w}</td></tr>
      </table>
    </td></tr>`).join('');

  // ── Zone banner ────────────────────────────────────────────────────────────
  const zoneStyle = d.zone === 'normal' ? STATUS_STYLE.go
    : (d.zone === 'winter' ? STATUS_STYLE.no : STATUS_STYLE.caution);

  // ── Key numbers ────────────────────────────────────────────────────────────
  const riverStr = d.river.level !== null ? d.river.level.toFixed(1) + ' ft' : '--';
  const airStr = d.weather.available ? d.weather.tempF + '°F' : '--';
  const stat = (label, value) =>
    `<td width="33%" align="center" style="background-color:${C.page};border:1px solid ${C.border};` +
    `border-radius:8px;padding:10px 4px;font-family:Arial,Helvetica,sans-serif;">
       <div style="font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${C.inkSoft};background-color:${C.page};white-space:nowrap;">${esc(label)}</div>
       <div style="font-size:17px;font-weight:bold;color:${C.ink};background-color:${C.page};white-space:nowrap;padding-top:3px;">${esc(value)}</div>
     </td>`;

  // ── Boat restrictions ──────────────────────────────────────────────────────
  // One block per tier, each a two-column list. The previous five-column grid
  // could not fit a phone: labels wrapped mid-token and the table became
  // unreadable. Two columns cannot collapse no matter how narrow the screen.
  const tierBlocks = d.rows.map(tier => {
    const rows = tier.boats.map((b, i) => {
      const line = i === tier.boats.length - 1 ? '' : `border-bottom:1px solid ${C.border};`;
      const note = b.note ? `<div style="font-size:11px;color:${C.inkSoft};background-color:${C.card};padding-top:2px;">${esc(b.note)}</div>` : '';
      return `<tr>
        <td style="padding:8px 0;${line}font-size:14px;color:${C.ink};background-color:${C.card};font-family:Arial,Helvetica,sans-serif;">${esc(b.name)}${note}</td>
        <td align="right" style="padding:8px 0;${line}background-color:${C.card};font-family:Arial,Helvetica,sans-serif;">${statusPill(b.status, b.label)}</td>
      </tr>`;
    }).join('');
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin-bottom:14px;">
      <tr><td colspan="2" style="padding:0 0 4px 0;font-size:13px;font-weight:bold;color:${C.ink};background-color:${C.card};font-family:Arial,Helvetica,sans-serif;">${esc(tier.name)}</td></tr>
      ${rows}
    </table>`;
  }).join('');

  const riverNote = d.floodSummary
    ? `River at ${riverStr} — ${esc(d.floodSummary.text)}.`
    : (d.river.level === null ? 'River level unavailable — flood restrictions not applied.' : '');

  // ── Weather ────────────────────────────────────────────────────────────────
  // The icon is a controlled entity from our own map, so it is not escaped.
  // It renders as dark text on a light card, which needs no colour trickery:
  // the earlier white-on-navy version was invisible whenever the background
  // failed to apply.
  const weatherBlock = d.weather.available
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
         <tr>
           <td style="font-size:26px;line-height:1;padding-right:12px;vertical-align:top;color:${C.ink};background-color:${C.card};">${d.weather.icon || ''}</td>
           <td style="vertical-align:top;font-family:Arial,Helvetica,sans-serif;background-color:${C.card};">
             <div style="font-size:14px;font-weight:bold;color:${C.ink};background-color:${C.card};">${esc(d.weather.cond)}, ${d.weather.tempF}°F</div>
             <div style="font-size:13px;color:${C.inkSoft};background-color:${C.card};padding-top:3px;">Feels like ${d.weather.feelsF}°F &nbsp;&middot;&nbsp; Wind ${d.weather.windMph} mph ${esc(d.weather.dir)}, gusts ${d.weather.gustMph} mph</div>
             <div style="font-size:13px;color:${C.inkSoft};background-color:${C.card};padding-top:2px;">Precipitation ${esc(d.weather.precip)} in</div>
           </td>
         </tr>
       </table>`
    : `<div style="font-size:13px;color:${C.inkSoft};background-color:${C.card};font-family:Arial,Helvetica,sans-serif;">Weather data unavailable this morning.</div>`;

  // ── Assemble ───────────────────────────────────────────────────────────────
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background-color:${C.page};">
  <tr><td align="center" style="padding:16px 8px;background-color:${C.page};">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;width:100%;max-width:600px;background-color:${C.card};border:1px solid ${C.border};border-radius:10px;">

      <tr><td style="padding:${PAD}px ${PAD}px 14px ${PAD}px;background-color:${C.card};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr>
            <td width="52" style="vertical-align:middle;background-color:${C.card};"><img src="${LOGO_URL}" width="52" height="52" alt="NHRC" style="display:block;width:52px;height:52px;border:0;"/></td>
            <td style="padding-left:12px;vertical-align:middle;background-color:${C.card};font-family:Arial,Helvetica,sans-serif;">
              <div style="font-size:17px;font-weight:bold;color:${C.ink};background-color:${C.card};">New Haven Rowing Club</div>
              <div style="font-size:11px;letter-spacing:0.06em;text-transform:uppercase;color:${C.inkSoft};background-color:${C.card};padding-top:2px;">Daily Conditions</div>
              <div style="font-size:12px;color:${C.inkSoft};background-color:${C.card};padding-top:2px;">${esc(d.dateLabel)}</div>
            </td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 ${PAD}px;background-color:${C.card};"><div style="height:3px;line-height:3px;font-size:0;background-color:${C.rule};">&nbsp;</div></td></tr>

      <tr><td style="padding:16px ${PAD}px 12px ${PAD}px;background-color:${C.card};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr><td style="background-color:${zoneStyle.bg};border:1px solid ${zoneStyle.border};border-radius:8px;padding:12px 14px;font-size:15px;font-weight:bold;color:${zoneStyle.text};font-family:Arial,Helvetica,sans-serif;">${esc(d.zoneLabel)}</td></tr>
        </table>
      </td></tr>

${warningHtml}

      <tr><td style="padding:0 ${PAD}px 16px ${PAD}px;background-color:${C.card};">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:4px 0;">
          <tr>
            ${stat('Water', d.tempF.toFixed(1) + '°F')}
            ${stat('River', riverStr)}
            ${stat('Air', airStr)}
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:0 ${PAD}px 8px ${PAD}px;background-color:${C.card};">
        ${sectionLabel('Boat restrictions')}
        ${tierBlocks}
        ${riverNote ? `<div style="font-size:12px;color:${C.inkSoft};background-color:${C.card};line-height:1.5;font-family:Arial,Helvetica,sans-serif;">${riverNote}</div>` : ''}
      </td></tr>

      <tr><td style="padding:8px ${PAD}px 16px ${PAD}px;background-color:${C.card};">
        ${sectionLabel('Weather — Oxford, CT')}
        ${weatherBlock}
      </td></tr>

      <tr><td align="center" style="padding:0 ${PAD}px 20px ${PAD}px;background-color:${C.card};">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
          <tr><td style="background-color:${C.rule};border-radius:6px;padding:11px 20px;font-family:Arial,Helvetica,sans-serif;">
            <a href="https://roworno.com" style="font-size:14px;font-weight:bold;color:${C.ink};text-decoration:none;">View full conditions &amp; river map</a>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:14px ${PAD}px 18px ${PAD}px;background-color:${C.page};border-top:1px solid ${C.border};">
        <div style="font-size:11px;line-height:1.6;color:${C.inkSoft};background-color:${C.page};text-align:center;font-family:Arial,Helvetica,sans-serif;">
          Conditions are guidance only — always verify at the boathouse before launching.<br/>
          New Haven Rowing Club &middot; 407 Roosevelt Drive, Oxford, CT 06478<br/>
          <a href="{{ unsubscribe_url }}" style="color:${C.inkSoft};text-decoration:underline;">Unsubscribe</a>
          &nbsp;&middot;&nbsp;
          <a href="https://roworno.com" style="color:${C.inkSoft};text-decoration:underline;">roworno.com</a>
        </div>
      </td></tr>

    </table>
  </td></tr>
</table>`;
}
/**
 * Builds the subject line.
 *
 * SAFETY: the headline is derived from the ACTUAL combined boat statuses
 * (temperature AND flood restrictions), never from the temperature zone alone.
 * The zone only describes water temperature, so a subject built from it would
 * read "Normal conditions" while the river was at 13 ft and nobody could row —
 * exactly the kind of thing someone skims at 4am before driving to the
 * boathouse. The subject must never be less restrictive than the email body.
 */
function renderSubject(d, now = new Date()) {
  const ZONE_SHORT = {
    winter: 'Winter Rowing', fourOar: 'Four Oar Rule', coldWater: 'Cold Water',
  };

  const boats = d.rows.flatMap(r => r.boats);
  const allNo      = boats.length > 0 && boats.every(b => b.status === 'no');
  const anyNo      = boats.some(b => b.status === 'no');
  const anyCaution = boats.some(b => b.status === 'caution');

  // Does the river level alone restrict anything? (getFloodStatus starts
  // cautioning 1x/2- above 8 ft.)
  const floodRestricts = d.river.level !== null && d.river.level > 8;

  const causes = [];
  if (ZONE_SHORT[d.zone]) causes.push(ZONE_SHORT[d.zone]);
  if (floodRestricts) causes.push('high river');

  // With no river reading, flood rules cannot be applied — so every boat shows
  // clear purely because the data is missing. Saying "All boats clear" there
  // would assert a safety conclusion we have not actually verified.
  const riverUnknown = d.river.failed || d.river.level === null;

  let headline;
  if (allNo) {
    headline = 'ALL BOATS RESTRICTED';
  } else if (causes.length) {
    headline = causes.join(' + ');
  } else if (anyNo || anyCaution) {
    headline = 'Some boats restricted';
  } else if (riverUnknown) {
    headline = 'Check river level';
  } else {
    headline = 'All boats clear';
  }

  const dateShort = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  });

  const riverPart = d.river.failed || d.river.level === null
    ? 'river n/a'
    : `river ${d.river.level.toFixed(1)} ft${d.river.isEstimate ? ' est.' : ''}`;

  return `NHRC ${dateShort} — ${headline} · ${d.tempF.toFixed(1)}°F · ${riverPart}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Send via Buttondown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic per-day identifier, e.g. "nhrc-2026-08-06", based on the date
 * in the boathouse's timezone.
 *
 * This is the idempotency key. Buttondown rejects a duplicate slug, so if the
 * job runs more than once in a day — a delayed run, the DST twin cron, a manual
 * retry — only the first actually sends. That lets the schedule tolerate delay
 * without any risk of members getting the same email twice.
 */
function dailySlug(now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  return `nhrc-${ymd}`;
}

/**
 * Sends the email. Returns {sent: false, reason: 'already-sent'} rather than
 * throwing if today's email already went out, so a duplicate run is a clean
 * no-op instead of a failed workflow.
 */
async function sendViaButtondown(subject, bodyHtml, now = new Date()) {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) throw new Error('BUTTONDOWN_API_KEY is not set');

  // NOT "fancy" mode. Fancy is Buttondown's WYSIWYG: it re-parses submitted
  // HTML into its own editor schema, which normalises away inline styles and
  // nested table markup it does not model — that is what stripped our colours
  // and backgrounds. "plaintext" is the Markdown pipeline, and raw block HTML
  // passes through Markdown untouched, which is what this template needs.
  const body = '<!-- buttondown-editor-mode: plaintext -->\n\n' + bodyHtml;
  const slug = dailySlug(now);

  const res = await fetch('https://api.buttondown.com/v1/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${key}`,
      'Content-Type': 'application/json',
      'X-API-Version': '2026-04-01',
      // Required once per API key to confirm real sends are intended.
      'X-Buttondown-Live-Dangerously': 'true',
    },
    body: JSON.stringify({ subject, body, slug, status: 'about_to_send' }),
  });

  const text = await res.text();

  // 409 Conflict = an email with this slug already exists, i.e. today's digest
  // has already been sent. Treat as success so a retry does not fail the run.
  if (res.status === 409) {
    return { sent: false, reason: 'already-sent', slug };
  }
  if (!res.ok) throw new Error(`Buttondown API ${res.status}: ${text}`);
  return Object.assign({ sent: true, slug }, JSON.parse(text));
}

/**
 * Checks how close the list is to Buttondown's free-tier ceiling. Purely
 * advisory — never blocks a send, and never throws, because failing to read a
 * count is not a reason to withhold safety information.
 */
async function checkSubscriberHeadroom() {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.buttondown.com/v1/subscribers?type=regular', {
      headers: { 'Authorization': `Token ${key}`, 'X-API-Version': '2026-04-01' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const count = typeof data.count === 'number' ? data.count : null;
    if (count === null) return null;
    if (count >= SUBSCRIBER_FREE_LIMIT) {
      console.error(`WARNING: ${count} subscribers — at or past Buttondown's free-tier limit of ${SUBSCRIBER_FREE_LIMIT}. Members beyond the cap may not receive this email.`);
    } else if (count >= SUBSCRIBER_WARN_THRESHOLD) {
      console.error(`NOTE: ${count} subscribers — approaching the free-tier limit of ${SUBSCRIBER_FREE_LIMIT}.`);
    } else {
      console.error(`Subscribers: ${count} (free-tier limit ${SUBSCRIBER_FREE_LIMIT}).`);
    }
    return count;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Main
// ─────────────────────────────────────────────────────────────────────────────

async function build() {
  const logic = loadSiteLogic();
  const local = loadLocalData();
  const [river, weather] = await Promise.all([loadRiver(), loadWeather()]);
  const digest = computeDigest(logic, local, river, weather);
  return { digest, html: renderEmailHtml(digest), subject: renderSubject(digest) };
}

async function main() {
  const args = process.argv.slice(2);

  // Season gate — applies only to real sends. Previews (--json, default HTML
  // output) always work so the committee can check the email off-season.
  // --force overrides the gate for a deliberate out-of-season send.
  if (args.includes('--send') && !args.includes('--force') && !isInSeason()) {
    const today = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', month: 'long', day: 'numeric',
    }).format(new Date());
    const fmt = (m, d) => new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric' })
      .format(new Date(Date.UTC(2000, m - 1, d, 12)));
    console.log(`Off-season: today is ${today}; season runs ${fmt(SEASON.startMonth, SEASON.startDay)} through ${fmt(SEASON.endMonth, SEASON.endDay)}. Nothing sent.`);
    return;
  }

  const { digest, html, subject } = await build();

  if (args.includes('--json')) {
    console.log(JSON.stringify(digest, null, 2));
    return;
  }
  if (args.includes('--send')) {
    await checkSubscriberHeadroom();
    const result = await sendViaButtondown(subject, html);
    if (!result.sent) {
      console.log(`Today's email (${result.slug}) was already sent — nothing to do.`);
      return;
    }
    console.log(`Sent: ${subject}`);
    console.log(`Buttondown email id: ${result.id} (slug ${result.slug})`);
    return;
  }
  console.error(`Subject: ${subject}`); // stderr so stdout stays pure HTML
  console.log(html);
}

module.exports = {
  loadSiteLogic, loadLocalData, loadRiver, loadWeather,
  computeDigest, renderEmailHtml, renderSubject, sendViaButtondown, build,
  parseGaugeSeries, checkSubscriberHeadroom, isInSeason, dailySlug,
  describeWeatherCode, withWeatherDescription,
  STALE_MS, SEASON, SUBSCRIBER_FREE_LIMIT, LOGO_URL,
  WMO_CODES_FALLBACK, WMO_ICONS_FALLBACK, DEFAULT_WEATHER_ICON,
};

if (require.main === module) {
  main().catch(err => {
    console.error('daily_email failed:', err.message);
    process.exit(1);
  });
}
