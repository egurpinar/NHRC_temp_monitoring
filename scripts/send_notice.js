#!/usr/bin/env node
/**
 * The "no report today" notice. The daily email job sends it instead of the
 * conditions report when the job's tests or the report's build failed - so
 * members hear that there is no report, rather than nothing. Fixed, short
 * words and a link to the site.
 *
 * On its own on purpose: it loads neither daily_email.js nor index.html, the
 * code whose failure it reports. From daily_email.js it reads only the rowing
 * season, as text (test_send_notice.js keeps the two in step).
 *
 * At most one email a day:
 *   - none outside the rowing season (no report was due);
 *   - none if today's report or notice already went out - both slugs start
 *     with the day's, nhrc-YYYY-MM-DD;
 *   - none if that cannot be checked (a second email is worse than none).
 * And once the notice has gone, a later run that could send the report does
 * not: the report's own check (alreadySentToday) finds the notice's slug.
 *
 *   node scripts/send_notice.js            # print the notice, send nothing
 *   node scripts/send_notice.js --send     # send it (BUTTONDOWN_API_KEY)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SITE = 'https://roworno.com';
const API = 'https://api.buttondown.com/v1/emails';
const ZONE = 'America/New_York';

/** The rowing season as daily_email.js sets it, read from its text; null if it cannot be read. */
function readSeason(src) {
  if (src === undefined) {
    try { src = fs.readFileSync(path.join(__dirname, 'daily_email.js'), 'utf8'); } catch (e) { return null; }
  }
  const block = /const SEASON = \{([^}]*)\}/.exec(src);
  if (!block) return null;
  const num = (k) => { const m = new RegExp(`\\b${k}:\\s*(\\d+)\\b`).exec(block[1]); return m ? Number(m[1]) : NaN; };
  const [startMonth, startDay, endMonth, endDay] = ['startMonth', 'startDay', 'endMonth', 'endDay'].map(num);
  const ok = (mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  return ok(startMonth, startDay) && ok(endMonth, endDay) ? { startMonth, startDay, endMonth, endDay } : null;
}

/** The boathouse's calendar date for an instant. */
function boathouseDate(now) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(now)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p;
}

/** As daily_email.js's isInSeason: the boathouse's date, both ends included, a range may wrap the new year. */
function inSeason(now, season) {
  const { month, day } = boathouseDate(now);
  const key = month * 100 + day;
  const start = season.startMonth * 100 + season.startDay;
  const end = season.endMonth * 100 + season.endDay;
  return start <= end ? (key >= start && key <= end) : (key >= start || key <= end);
}

const ymd = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
/** The day's slug, as daily_email.js's dailySlug: nhrc-YYYY-MM-DD. */
const daySlug = (now) => `nhrc-${ymd(now)}`;
const noticeSlug = (now) => `${daySlug(now)}-no-report`;

/** The notice: subject, body (HTML) and slug. */
function notice(now) {
  const short = now.toLocaleDateString('en-US', { timeZone: ZONE, month: 'short', day: 'numeric' });
  const long = now.toLocaleDateString('en-US', { timeZone: ZONE, weekday: 'long', month: 'long', day: 'numeric' });
  const subject = `NHRC ${short} - No conditions report today - check roworno.com`;
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1d2b36;max-width:560px;">',
    `<p style="font-size:18px;margin:0 0 12px;"><strong>No conditions report today (${long}).</strong></p>`,
    '<p style="margin:0 0 12px;">Today&rsquo;s report could not be put together, so it has not been sent.</p>',
    '<p style="margin:0 0 12px;">Before you row, check the water temperature, the river level, the weather and any alerts on ' +
      `<a href="${SITE}" style="color:#1d4ed8;">roworno.com</a>, and follow the Safety Committee&rsquo;s rules as usual.</p>`,
    '<p style="margin:0;font-size:13px;color:#5b6b78;">Conditions are guidance only &mdash; always verify at the boathouse before launching. ' +
      'This is an automatic message.</p>',
    '</div>',
  ].join('\n');
  return { subject, html, slug: noticeSlug(now) };
}

const headers = (key) => ({ 'Authorization': `Token ${key}`, 'X-API-Version': '2026-04-01' });

/** Has an email for today - the report or this notice - already gone out? { known, found }. */
async function todaysEmail(now, key) {
  try {
    const res = await fetch(`${API}?creation_date__start=${ymd(now)}&excluded_fields=body`, { headers: headers(key) });
    if (!res.ok) return { known: false, found: false };
    const data = await res.json();
    const results = data && Array.isArray(data.results) ? data.results : [];
    return { known: true, found: results.some(e => e && typeof e.slug === 'string' && e.slug.startsWith(daySlug(now))) };
  } catch (e) {
    return { known: false, found: false };
  }
}

async function sendNotice(now, key) {
  const n = notice(now);
  const res = await fetch(API, {
    method: 'POST',
    headers: Object.assign(headers(key), { 'Content-Type': 'application/json', 'X-Buttondown-Live-Dangerously': 'true' }),
    // As the report: Buttondown's plaintext (Markdown) mode, which passes block HTML through.
    body: JSON.stringify({ subject: n.subject, body: '<!-- buttondown-editor-mode: plaintext -->\n\n' + n.html, slug: n.slug, status: 'about_to_send' }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Buttondown API ${res.status}: ${text.slice(0, 300)}`);
  let id = null;
  try { id = JSON.parse(text).id || null; } catch (e) { /* sent; the id is only for the log */ }
  return { subject: n.subject, slug: n.slug, id };
}

/** Returns the exit code: 0 sent or rightly not sent, 1 could not do what it should. */
async function main(argv = process.argv.slice(2), now = new Date()) {
  const n = notice(now);
  if (!argv.includes('--send')) {
    console.log(`Subject: ${n.subject}\nSlug: ${n.slug}\n\n${n.html}`);
    return 0;
  }
  const season = readSeason();
  if (!season) {
    console.log('Could not read the rowing season from daily_email.js - no notice sent.');
    return 1;
  }
  if (!inSeason(now, season)) {
    console.log(`Outside the rowing season (${season.startMonth}/${season.startDay} - ${season.endMonth}/${season.endDay}): no report was due, so no notice.`);
    return 0;
  }
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) {
    console.log('BUTTONDOWN_API_KEY is not set - no notice sent.');
    return 1;
  }
  const check = await todaysEmail(now, key);
  if (!check.known) {
    console.log('Could not check whether today\'s email already went out - no notice, rather than risk a second email.');
    return 0;
  }
  if (check.found) {
    console.log(`Today's email (${daySlug(now)}) already went out - no notice.`);
    return 0;
  }
  const r = await sendNotice(now, key);
  console.log(`Sent the notice: ${r.subject} (slug ${r.slug}${r.id ? `, Buttondown id ${r.id}` : ''})`);
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`send_notice failed: ${e.message}`); process.exitCode = 1; });
}

module.exports = { SITE, readSeason, boathouseDate, inSeason, daySlug, noticeSlug, notice, todaysEmail, sendNotice, main };
