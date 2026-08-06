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

const WMO_CODES = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Moderate drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Moderate rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Light showers', 81: 'Moderate showers', 82: 'Violent showers',
  85: 'Light snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ heavy hail',
};

function windDirLabel(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
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
      tempF: Math.round(c.temperature_2m),
      feelsF: Math.round(c.apparent_temperature),
      cond: WMO_CODES[c.weather_code] || 'Unknown',
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
    weather,
    sensorStale,
    sensorAgeMs,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Render the email (matches the approved mockup template)
// ─────────────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function statusPill(status, label) {
  const styles = {
    no:      'background:rgba(224,62,62,0.18);color:#f07070;',
    caution: 'background:rgba(240,180,41,0.18);color:#ffd166;',
    go:      'background:rgba(46,125,79,0.2);color:#5cc98a;',
  };
  return `<span style="display:inline-block;${styles[status] || styles.go}font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;">${esc(label)}</span>`;
}

function renderEmailHtml(d) {
  const boatCols = ['1x / 2-', '2x', '4+ / 4-', '4x / 8+'];

  const warnings = [];
  if (d.sensorStale) {
    const hrs = Math.floor(d.sensorAgeMs / 3600000);
    warnings.push(`<strong>Water sensor may be offline.</strong> No new reading in ${hrs}+ hours — the temperature below is the last known value. Verify against the thermometer at the dock.`);
  }
  if (d.river.failed) {
    warnings.push(`<strong>River level unavailable.</strong> NOAA data could not be retrieved, so flood restrictions are not reflected below. Check water.noaa.gov/gauges/stvc3 before launching.`);
  } else if (d.river.stale) {
    const days = d.river.ageMs !== null ? Math.floor(d.river.ageMs / 86400000) : null;
    warnings.push(`<strong>River gauge data is stale.</strong> NOAA's observed reading hasn't updated in ${days !== null ? days + ' day' + (days === 1 ? '' : 's') : 'an extended period'}. The level below is estimated from NOAA's forecast model, not a live sensor.`);
  }

  const warningHtml = warnings.map(w => `
            <tr><td style="padding:16px 28px 0;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:rgba(224,62,62,0.1);border:1px solid rgba(224,62,62,0.35);border-radius:10px;">
                <tr><td style="padding:12px 14px;font-size:12px;color:#f07070;line-height:1.5;">${w}</td></tr>
              </table>
            </td></tr>`).join('');

  const tierRows = d.rows.map((tier, i) => {
    const last = i === d.rows.length - 1;
    const border = last ? '' : 'border-bottom:1px solid rgba(255,255,255,0.05);';
    const cells = boatCols.map(col => {
      const boat = tier.boats.find(b => b.name === col);
      return `<td style="padding:10px 12px;${border}" align="center">${boat ? statusPill(boat.status, boat.label) : '<span style="color:#7a93b4;font-size:11px;">—</span>'}</td>`;
    }).join('');
    return `<tr><td style="padding:10px 12px;font-size:13px;color:#ffffff;${border}">${esc(tier.name)}</td>${cells}</tr>`;
  }).join('');

  const headerCells = boatCols.map(c =>
    `<td style="padding:10px 12px;font-size:11px;color:#7a93b4;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid rgba(255,255,255,0.08);" align="center">${esc(c)}</td>`
  ).join('');

  const riverStr = d.river.level !== null ? d.river.level.toFixed(1) : '--';
  const riverNote = d.floodSummary
    ? `River at ${riverStr} ft — ${esc(d.floodSummary.text)}.`
    : (d.river.level === null ? 'River level unavailable — flood restrictions not applied.' : '');

  const weatherRow = d.weather.available
    ? `${esc(d.weather.cond)}, ${d.weather.tempF}°F (feels like ${d.weather.feelsF}°F) &nbsp;·&nbsp; Wind ${d.weather.windMph} mph ${esc(d.weather.dir)}, gusts ${d.weather.gustMph} mph &nbsp;·&nbsp; Precip ${esc(d.weather.precip)} in`
    : 'Weather data unavailable this morning.';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>NHRC Daily Conditions</title></head>
<body style="margin:0;padding:0;background:#eef1f6;font-family:-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0d1f3c;border-radius:14px;overflow:hidden;">

        <tr><td style="padding:26px 28px 20px;border-bottom:1px solid rgba(240,180,41,0.2);">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:56px;height:56px;border-radius:50%;background:#ffffff;border:3px solid #0d1f3c;outline:2px solid #f0b429;outline-offset:1px;text-align:center;vertical-align:middle;font-family:Georgia,serif;font-weight:700;color:#0d1f3c;font-size:20px;">NHRC</td>
            <td style="padding-left:14px;">
              <div style="font-family:Georgia,serif;font-size:18px;font-weight:700;color:#f0b429;">New Haven Rowing Club</div>
              <div style="font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:#7a93b4;margin-top:3px;">Daily Conditions Report</div>
              <div style="font-size:11px;color:#7a93b4;margin-top:2px;">${esc(d.dateLabel)} · ${esc(d.timeLabel)} ${esc(d.tz)}</div>
            </td>
          </tr></table>
        </td></tr>
${warningHtml}
        <tr><td style="padding:20px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${d.zoneColor.bg};border:1px solid ${d.zoneColor.border};border-radius:10px;">
            <tr><td style="padding:14px 16px;font-size:14px;font-weight:700;color:${d.zoneColor.text};">${esc(d.zoneLabel)}</td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:16px 28px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td width="33%" style="background:#162d52;border-radius:10px;padding:12px;" align="center">
              <div style="font-size:10px;letter-spacing:0.07em;text-transform:uppercase;color:#7a93b4;">Water Temp</div>
              <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;margin-top:4px;">${d.tempF.toFixed(1)}°F</div>
            </td>
            <td width="4"></td>
            <td width="33%" style="background:#162d52;border-radius:10px;padding:12px;" align="center">
              <div style="font-size:10px;letter-spacing:0.07em;text-transform:uppercase;color:#7a93b4;">River Level</div>
              <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;margin-top:4px;">${riverStr} <span style="font-size:12px;color:#7a93b4;">ft</span></div>
            </td>
            <td width="4"></td>
            <td width="33%" style="background:#162d52;border-radius:10px;padding:12px;" align="center">
              <div style="font-size:10px;letter-spacing:0.07em;text-transform:uppercase;color:#7a93b4;">Air Temp</div>
              <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#ffffff;margin-top:4px;">${d.weather.available ? d.weather.tempF + '°F' : '--'}</div>
            </td>
          </tr></table>
        </td></tr>

        <tr><td style="padding:22px 28px 0;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#f0b429;margin-bottom:10px;">Rowing Status — Boat Restrictions</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#162d52;border-radius:10px;border-collapse:separate;">
            <tr><td style="padding:10px 12px;font-size:11px;color:#7a93b4;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid rgba(255,255,255,0.08);">Tier</td>${headerCells}</tr>
            ${tierRows}
          </table>
          ${riverNote ? `<div style="font-size:11px;color:#7a93b4;margin-top:8px;line-height:1.5;">${riverNote}</div>` : ''}
        </td></tr>

        <tr><td style="padding:22px 28px 0;">
          <div style="font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#f0b429;margin-bottom:10px;">Weather — Oxford, CT</div>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#162d52;border-radius:10px;">
            <tr><td style="padding:14px 16px;font-size:13px;color:#ffffff;">${weatherRow}</td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:22px 28px 0;" align="center">
          <a href="https://roworno.com" style="display:inline-block;background:#f0b429;color:#0d1f3c;font-weight:700;font-size:13px;text-decoration:none;padding:11px 22px;border-radius:8px;">View full conditions &amp; navigation map →</a>
        </td></tr>

        <tr><td style="padding:26px 28px 24px;">
          <div style="border-top:1px solid rgba(255,255,255,0.08);margin-top:6px;padding-top:16px;font-size:11px;color:#7a93b4;line-height:1.6;text-align:center;">
            Conditions are provided for guidance only — always verify at the boathouse before launching.<br/>
            New Haven Rowing Club · 407 Roosevelt Drive, Oxford, CT 06478<br/>
            <a href="{{ unsubscribe_url }}" style="color:#7a93b4;text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; <a href="https://roworno.com" style="color:#7a93b4;text-decoration:underline;">roworno.com</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderSubject(d) {
  const short = {
    winter: 'Winter Rowing', fourOar: 'Four Oar Rule',
    coldWater: 'Cold Water', normal: 'Normal conditions',
  }[d.zone] || d.zone;
  const dateShort = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric',
  });
  return `NHRC ${dateShort} — ${short} · ${d.tempF.toFixed(1)}°F water`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Send via Buttondown
// ─────────────────────────────────────────────────────────────────────────────

async function sendViaButtondown(subject, bodyHtml) {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) throw new Error('BUTTONDOWN_API_KEY is not set');

  // "fancy" mode tells Buttondown to treat the body as rich HTML rather than
  // Markdown, which is required for this table-based email template.
  const body = '<!-- buttondown-editor-mode: fancy -->' + bodyHtml;

  const res = await fetch('https://api.buttondown.com/v1/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Token ${key}`,
      'Content-Type': 'application/json',
      'X-API-Version': '2026-04-01',
      // Required once per API key to confirm real sends are intended.
      'X-Buttondown-Live-Dangerously': 'true',
    },
    body: JSON.stringify({ subject, body, status: 'about_to_send' }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Buttondown API ${res.status}: ${text}`);
  return JSON.parse(text);
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
    console.log(`Sent: ${subject}`);
    console.log(`Buttondown email id: ${result.id}`);
    return;
  }
  console.error(`Subject: ${subject}`); // stderr so stdout stays pure HTML
  console.log(html);
}

module.exports = {
  loadSiteLogic, loadLocalData, loadRiver, loadWeather,
  computeDigest, renderEmailHtml, renderSubject, sendViaButtondown, build,
  parseGaugeSeries, checkSubscriberHeadroom, isInSeason,
  STALE_MS, SEASON, SUBSCRIBER_FREE_LIMIT,
};

if (require.main === module) {
  main().catch(err => {
    console.error('daily_email failed:', err.message);
    process.exit(1);
  });
}
