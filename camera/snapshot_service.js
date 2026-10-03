#!/usr/bin/env node
/**
 * NHRC Boathouse Camera — Ring snapshot service
 * =============================================
 * Runs continuously on a Raspberry Pi (Pi Zero W / ARMv6 supported). Captures a
 * snapshot on a timetable and uploads it to the Cloudflare Worker the website
 * reads from.
 *
 * TWO CAMERAS
 * -----------
 * The PRIMARY camera (RING_CAMERA_NAME, the hardwired "Dock Wired") is captured
 * every 5 minutes, around the clock. The BACKUP (RING_BACKUP_CAMERA_NAME, the
 * battery-powered "Downstream Lot") is never used routinely, to spare its
 * battery: only once the primary has missed BACKUP_AFTER_MISSES captures in a
 * row (six, ~30 minutes), and then only on its own battery-friendly daylight
 * timetable (5am-4pm, every 30 minutes until 10am, then hourly). As soon as
 * the primary answers again the backup goes back to sleep. Each upload says
 * which camera and role it came from, so the website can label a backup view
 * as one.
 *
 * WHY A LONG-RUNNING SERVICE AND NOT A CRON JOB
 * ---------------------------------------------
 * Ring refresh tokens rotate roughly hourly and expire shortly after use. The
 * ring-client-api docs are explicit that consumers MUST subscribe to
 * `onRefreshTokenUpdated` and persist every new token. Getting this wrong does
 * not merely break this script: reusing a stale token permanently breaks push
 * notifications for the Ring account, and the only fix is deleting the client
 * from Ring Control Center and re-authenticating.
 *
 * A cron job authenticates cold every run and would have to write the rotated
 * token back to storage each time, with no safe way to recover from a partial
 * failure. A single long-lived process holds the session in memory, writes each
 * rotation to disk atomically, and only re-authenticates on restart.
 *
 * PRIVACY
 * -------
 * The camera must be framed on the WATER, not the dock. The published image is
 * public. Nothing is archived: exactly one file is overwritten each cycle, both
 * here and at the destination.
 *
 * Usage:
 *   node camera/snapshot_service.js                run the service
 *   node camera/snapshot_service.js --once         capture and upload one frame from the primary
 *   node camera/snapshot_service.js --once-backup  the same from the backup (it then shows on the
 *                                                  website until the next primary capture)
 *   node camera/snapshot_service.js --check        validate config, no Ring calls
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (environment variables — see camera/README.md)
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  // Where the rotated Ring refresh token lives. MUST be writable and persistent
  // across reboots, and should be readable only by the service user: the token
  // is as sensitive as the Ring account password.
  tokenFile: process.env.RING_TOKEN_FILE || path.join(os.homedir(), '.nhrc-ring-token'),

  // Ring camera names. The full name is matched first (case-insensitive), then
  // a unique part of a name; a part that matches several cameras is refused
  // rather than guessed, since a wrong guess could run the battery camera
  // every 5 minutes.
  cameraName: process.env.RING_CAMERA_NAME || '',
  backupCameraName: process.env.RING_BACKUP_CAMERA_NAME || '',

  // Upload destination and shared secret.
  uploadUrl: process.env.CAMERA_UPLOAD_URL || '',
  uploadSecret: process.env.CAMERA_UPLOAD_SECRET || '',

  // The PRIMARY camera's timetable. The defaults suit a hardwired camera:
  // every 5 minutes, around the clock (both window hours 0 = always). Five is
  // also the minimum the validator accepts.
  intervalMinutes: Number(process.env.CAMERA_INTERVAL_MINUTES || 5),

  // Optional two-speed schedule: every CAMERA_INTERVAL_MINUTES until this
  // hour, then every CAMERA_SLOW_INTERVAL_MINUTES. Off when it is not after
  // the window start (the default, 0).
  slowAfterHour: parseHourSetting(process.env.CAMERA_SLOW_AFTER_HOUR, 0),
  slowIntervalMinutes: Number(process.env.CAMERA_SLOW_INTERVAL_MINUTES || 60),

  // Optional window in the boathouse timezone. Accepts "4" or "4:30". Both 0
  // (the default) means always. Defined below CONFIG but hoisted, so usable here.
  activeStartHour: parseHourSetting(process.env.CAMERA_ACTIVE_START_HOUR, 0),
  activeEndHour: parseHourSetting(process.env.CAMERA_ACTIVE_END_HOUR, 0),

  // The BACKUP camera: battery-powered, so used only after the primary has
  // missed this many captures in a row - six at the 5-minute rate, about half
  // an hour, so a short Wi-Fi or Ring hiccup never wakes it - and only on its
  // own timetable, the battery-friendly one: daylight, every 30 minutes until
  // 10am, then hourly. A night-time frame from an unlit river is dark anyway.
  // If CAMERA_INTERVAL_MINUTES changes, change this with it.
  backup: {
    afterMisses: Number(process.env.BACKUP_AFTER_MISSES || 6),
    intervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES || 30),
    slowAfterHour: parseHourSetting(process.env.BACKUP_SLOW_AFTER_HOUR, 10),
    slowIntervalMinutes: Number(process.env.BACKUP_SLOW_INTERVAL_MINUTES || 60),
    activeStartHour: parseHourSetting(process.env.BACKUP_ACTIVE_START_HOUR, 5),
    activeEndHour: parseHourSetting(process.env.BACKUP_ACTIVE_END_HOUR, 16),
  },

  timeZone: process.env.CAMERA_TIMEZONE || 'America/New_York',

  // Ring battery cameras cannot take a snapshot while recording, so a capture
  // that coincides with a motion event fails. Retry a couple of times rather
  // than skipping the whole cycle.
  retries: Number(process.env.CAMERA_RETRIES || 3),
  retryDelaySeconds: Number(process.env.CAMERA_RETRY_DELAY_SECONDS || 45),
};

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}
function logError(...args) {
  console.error(new Date().toISOString(), '- ERROR:', ...args);
}

/** Hostname only, for error messages — never log the URL with its secret nearby. */
function hostOf(url) {
  try { return new URL(url).host; } catch (e) { return String(url); }
}

/**
 * Node's fetch throws a bare "fetch failed" and buries the real transport error
 * on `.cause` (often nested one more level for aggregate connect errors). Walk
 * it so the log names the actual problem: ENOTFOUND, ENETUNREACH, cert failure.
 */
function describeCause(err) {
  const parts = [];
  let e = err;
  for (let depth = 0; e && depth < 4; depth++) {
    const code = e.code ? `${e.code} ` : '';
    const msg = e.message || String(e);
    const line = (code + msg).trim();
    if (line && !parts.includes(line)) parts.push(line);
    // AggregateError from a multi-address connect attempt keeps the per-address
    // failures in .errors — that is where an IPv6-only route failure shows up.
    if (Array.isArray(e.errors) && e.errors.length) {
      for (const sub of e.errors.slice(0, 3)) {
        const s = ((sub.code ? sub.code + ' ' : '') + (sub.message || '')).trim();
        if (s && !parts.includes(s)) parts.push(s);
      }
    }
    e = e.cause;
  }
  return parts.join(' <- ') || 'unknown error';
}

/** Validates configuration up front so failures are obvious, not mysterious. */
function validateConfig(cfg = CONFIG) {
  const problems = [];
  if (!cfg.uploadUrl) problems.push('CAMERA_UPLOAD_URL is not set');
  else if (!/^https:\/\//.test(cfg.uploadUrl)) {
    problems.push('CAMERA_UPLOAD_URL must be https (the secret is sent as a header)');
  } else if (/YOUR-SUBDOMAIN|YOUR_SUBDOMAIN|example\.com|CHANGEME/i.test(cfg.uploadUrl)) {
    // An unedited placeholder from the setup guide. Without this check --check
    // cheerfully reports "Configuration looks valid" and the failure only
    // surfaces later as a DNS error during an upload, which is far less obvious.
    problems.push('CAMERA_UPLOAD_URL still contains a placeholder — edit it to the real URL');
  }
  if (!cfg.uploadSecret) problems.push('CAMERA_UPLOAD_SECRET is not set');
  else if (cfg.uploadSecret.length < 16) {
    problems.push('CAMERA_UPLOAD_SECRET is too short — use at least 16 random characters');
  } else if (/\s/.test(cfg.uploadSecret)) {
    problems.push('CAMERA_UPLOAD_SECRET contains whitespace — it was probably pasted with a stray space or newline');
  } else if (/^[a-z]+(-[a-z]+){2,}$/.test(cfg.uploadSecret)) {
    // Three or more lowercase words joined by hyphens is descriptive prose, not
    // a random secret — e.g. "the-same-secret-as-the-worker" from the README.
    // This exact mistake reached the Pi and cost a debugging round trip: the
    // only symptom was an opaque HTTP 401 from the Worker, which is also what a
    // missing binding looks like. A real secret from `openssl rand -hex 32` is
    // 64 hex characters and cannot match this pattern.
    problems.push('CAMERA_UPLOAD_SECRET looks like placeholder text, not a secret — ' +
      'paste the real value (openssl rand -hex 32 gives 64 hex characters)');
  }
  if (!(cfg.retries >= 1)) problems.push('CAMERA_RETRIES must be at least 1');
  problems.push(...scheduleProblems(cfg, 'CAMERA_'));
  if (cfg.backupCameraName) {
    const b = cfg.backup || {};
    problems.push(...scheduleProblems(b, 'BACKUP_'));
    if (!(Number.isInteger(b.afterMisses) && b.afterMisses >= 1)) {
      problems.push('BACKUP_AFTER_MISSES must be a whole number, at least 1');
    }
    if (cfg.cameraName && cfg.cameraName.trim().toLowerCase() === cfg.backupCameraName.trim().toLowerCase()) {
      problems.push('RING_CAMERA_NAME and RING_BACKUP_CAMERA_NAME name the same camera');
    }
  }
  return problems;
}

/**
 * Problems with one camera's timetable. `prefix` names its settings in the
 * messages: CAMERA_ for the primary, BACKUP_ for the backup.
 */
function scheduleProblems(s, prefix) {
  const problems = [];
  const always = s.activeStartHour === 0 && s.activeEndHour === 0;
  if (!(s.intervalMinutes >= 5)) {
    // Ring throttles battery cameras to roughly one snapshot per 10 minutes and
    // every capture costs battery, so anything below 5 minutes is pointless.
    problems.push(`${prefix}INTERVAL_MINUTES must be at least 5`);
  }
  if (!(s.slowIntervalMinutes >= 5)) {
    problems.push(`${prefix}SLOW_INTERVAL_MINUTES must be at least 5`);
  }
  if (!Number.isFinite(s.slowAfterHour) || s.slowAfterHour < 0 || s.slowAfterHour >= 24) {
    problems.push(`${prefix}SLOW_AFTER_HOUR must be an hour from 0 to 23, optionally with minutes (e.g. 10 or 10:30)`);
  } else if (!always && s.slowAfterHour > s.activeStartHour && s.slowAfterHour >= s.activeEndHour) {
    // Switching to the slow rate at or after the window closes means the slow
    // rate never applies — almost certainly a typo, and silently ignoring it
    // would leave the camera on the fast rate all day, draining the battery
    // this setting exists to protect. (An always-on window has no close.)
    problems.push(`${prefix}SLOW_AFTER_HOUR is at or after ${prefix}ACTIVE_END_HOUR, so the slower rate would never take effect`);
  }
  if (!always) {
    for (const [k, v] of [[`${prefix}ACTIVE_START_HOUR`, s.activeStartHour],
                          [`${prefix}ACTIVE_END_HOUR`, s.activeEndHour]]) {
      // Fractional values are legitimate (4.5 === "4:30"), so this checks the
      // range rather than integer-ness. 24 is excluded: "24:00" would never
      // match, since the clock reads 0 at midnight.
      if (!Number.isFinite(v) || v < 0 || v >= 24) {
        problems.push(`${k} must be an hour from 0 to 23, optionally with minutes (e.g. 4 or 4:30)`);
      }
    }
  }
  return problems;
}

/** The backup camera's timetable as a full config, for the shared window functions. */
function backupConfig(cfg = CONFIG) {
  return Object.assign({}, cfg, cfg.backup || {});
}

// ─────────────────────────────────────────────────────────────────────────────
// Time window
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True if `now` falls inside the configured active hours, evaluated in the
 * boathouse timezone rather than the Pi's locale — a Pi with an unset timezone
 * would otherwise capture on a UTC schedule and miss the actual daylight hours.
 */
function isWithinActiveHours(now = new Date(), cfg = CONFIG) {
  if (cfg.activeStartHour === 0 && cfg.activeEndHour === 0) return true;
  // Minutes matter: the window may start on a half hour (4:30). Reading only the
  // hour would round 4:30 down to 4:00 and capture half an hour early.
  //
  // hourCycle 'h23' rather than hour12:false — the latter renders midnight as
  // "24" in some locales, which would place it after every window boundary
  // instead of before.
  const hour = localHour(now, cfg);
  const { activeStartHour: s, activeEndHour: e } = cfg;
  return s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e);
}

/**
 * Fractional local hour (13:30 -> 13.5) in the boathouse timezone. Shared by the
 * window check and the interval schedule so they can never read the clock
 * differently.
 */
function localHour(now = new Date(), cfg = CONFIG) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour').value);
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h + m / 60;
}

/**
 * Minutes to wait before the next capture. Fast through the early morning when
 * crews are deciding whether to go out, slower afterwards to save battery.
 *
 * Deliberately evaluated fresh before every wait rather than fixed at startup:
 * the process runs for months, so a rate chosen once at 4am would still be in
 * force at 6pm, and would survive a DST change with the wrong offset baked in.
 */
function intervalForTime(now = new Date(), cfg = CONFIG) {
  const slowAfter = cfg.slowAfterHour;
  const slow = cfg.slowIntervalMinutes;
  if (!Number.isFinite(slowAfter) || !Number.isFinite(slow)) return cfg.intervalMinutes;
  // Equal to (or before) the window start means the two-speed schedule is off.
  if (slowAfter <= cfg.activeStartHour) return cfg.intervalMinutes;
  return localHour(now, cfg) >= slowAfter ? slow : cfg.intervalMinutes;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture timetable
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY A TIMETABLE AND NOT "WAIT AN INTERVAL AFTER EACH CAPTURE"
// The loop used to sleep a fixed interval after each cycle. Each cycle takes
// time (a capture, an upload, sometimes 45-second retries), so the schedule
// drifted later every capture and the phase was effectively random: the first
// frame of the day landed anywhere from 5:00 to 5:29. Until it did, the
// website had no frame younger than the Worker's 130-minute limit and told
// members at the dock "the boathouse camera could not be reached" - at the
// exact time the camera matters most, to check for fog before launching.
//
// Now captures happen at fixed slots - 5:00, 5:30, ... 9:30, then 10:00,
// 11:00, ... 15:00 with the default settings - one per slot, however long a
// capture takes. The loop never sleeps more than MAX_SLEEP_SECONDS, re-reading
// the clock each time it wakes, so a daylight-saving change or a clock
// correction can never cost a morning.

const MAX_SLEEP_SECONDS = 30 * 60;
const DAY_SECONDS = 86400;

/** Seconds since local midnight in the boathouse timezone. */
function localSeconds(now = new Date(), cfg = CONFIG) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const g = t => Number(parts.find(p => p.type === t).value);
  return g('hour') * 3600 + g('minute') * 60 + g('second');
}

/**
 * The window and its two rates, as seconds from the window's opening. Mirrors
 * isWithinActiveHours (0/0 means always; start == end means never; a window
 * may wrap midnight) and intervalForTime (two speeds only when the slow hour
 * is after the start).
 */
function windowGeometry(cfg = CONFIG) {
  const always = cfg.activeStartHour === 0 && cfg.activeEndHour === 0;
  const startSecs = always ? 0 : Math.round(cfg.activeStartHour * 3600);
  const lenSecs = always ? DAY_SECONDS
    : Math.round((((cfg.activeEndHour - cfg.activeStartHour) % 24 + 24) % 24) * 3600);
  const twoSpeed = Number.isFinite(cfg.slowAfterHour) && Number.isFinite(cfg.slowIntervalMinutes)
    && cfg.slowAfterHour > cfg.activeStartHour;
  const slowOffset = twoSpeed
    ? Math.min(Math.round((cfg.slowAfterHour - cfg.activeStartHour) * 3600), lenSecs)
    : lenSecs;
  return {
    startSecs, lenSecs, slowOffset,
    fast: Math.round(cfg.intervalMinutes * 60),
    slow: Math.round((twoSpeed ? cfg.slowIntervalMinutes : cfg.intervalMinutes) * 60),
  };
}

/**
 * The capture slot `now` falls in, or null when the window is closed. `key`
 * is the slot's start in epoch seconds: unique per slot, so the loop captures
 * once per slot however often it wakes.
 */
function captureSlot(now = new Date(), cfg = CONFIG) {
  const g = windowGeometry(cfg);
  const offset = ((localSeconds(now, cfg) - g.startSecs) % DAY_SECONDS + DAY_SECONDS) % DAY_SECONDS;
  if (offset >= g.lenSecs) return null;
  const slotOffset = offset < g.slowOffset
    ? Math.floor(offset / g.fast) * g.fast
    : g.slowOffset + Math.floor((offset - g.slowOffset) / g.slow) * g.slow;
  return { key: Math.floor(now.getTime() / 1000) - (offset - slotOffset), offsetSecs: slotOffset };
}

/** Seconds until the next slot (or the window's next opening), capped at MAX_SLEEP_SECONDS. */
function secondsUntilNextSlot(now = new Date(), cfg = CONFIG) {
  const g = windowGeometry(cfg);
  const offset = ((localSeconds(now, cfg) - g.startSecs) % DAY_SECONDS + DAY_SECONDS) % DAY_SECONDS;
  let next;
  if (offset >= g.lenSecs) next = DAY_SECONDS;
  else if (offset < g.slowOffset) next = Math.min((Math.floor(offset / g.fast) + 1) * g.fast, g.slowOffset);
  else next = g.slowOffset + (Math.floor((offset - g.slowOffset) / g.slow) + 1) * g.slow;
  // A slot that would start at or after the window closes is tomorrow's opening.
  if (next >= g.lenSecs && g.lenSecs < DAY_SECONDS) next = DAY_SECONDS;
  return Math.max(1, Math.min(next - offset, MAX_SLEEP_SECONDS));
}

/**
 * The capture loop: one capture per slot, then sleep until the next slot.
 * deps: now() -> Date, setTimer(fn, ms), cycle() -> Promise. Injected so the
 * tests can run whole days - and daylight-saving days - on a fake clock.
 */
function createScheduler(cfg, deps) {
  // deps.cycle(role) captures and uploads from 'primary' or 'backup'.
  // deps.hasPrimary / deps.hasBackup: whether each camera was found.
  const hasPrimary = deps.hasPrimary !== false;
  const hasBackup = !!deps.hasBackup;
  const backupCfg = backupConfig(cfg);
  const afterMisses = (cfg.backup && cfg.backup.afterMisses) || 2;
  let lastSlotKey = null, lastBackupSlotKey = null;
  // Primary captures missed in a row. Without a primary camera at all, the
  // backup runs on its timetable from the first slot.
  let misses = hasPrimary ? 0 : afterMisses;
  let onBackup = false;

  const tick = async () => {
    const slot = captureSlot(deps.now(), cfg);
    if (slot && slot.key !== lastSlotKey) {
      // Before the capture: a failed cycle is not retried until the next
      // slot. captureWithRetry already retries within the cycle, and a slot
      // that keeps failing must not turn into a capture every wake-up.
      lastSlotKey = slot.key;
      let answered = false;
      if (hasPrimary) {
        try {
          await deps.cycle('primary');
          answered = true;
        } catch (e) {
          // Never exit on a failed cycle: a transient Ring or network error
          // should not take the service down until someone notices days later.
          logError('primary cycle failed:', e.message);
          // A failed UPLOAD means the camera did answer - and the backup's
          // frame would fail to upload the same way.
          if (e.stage === 'upload') answered = true;
        }
      }
      if (answered) {
        if (onBackup) log('Primary camera is answering again; the backup goes back to sleep.');
        misses = 0;
        onBackup = false;
      } else {
        misses += 1;
      }

      if (!answered && hasBackup && misses >= afterMisses) {
        if (!onBackup) {
          log(`Primary camera has missed ${misses} capture${misses === 1 ? '' : 's'} in a row; using the backup on its own timetable.`);
          onBackup = true;
        }
        // The backup's own slots (daylight, every 30-60 minutes): at most one
        // capture per slot, and none outside its window, however long the
        // primary stays down.
        const bslot = captureSlot(deps.now(), backupCfg);
        if (bslot && bslot.key !== lastBackupSlotKey) {
          lastBackupSlotKey = bslot.key;
          try {
            await deps.cycle('backup');
          } catch (e) {
            logError('backup cycle failed:', e.message);
          }
        }
      }
    }
    // Half a second past the boundary, so the clock reads the new slot.
    deps.setTimer(tick, secondsUntilNextSlot(deps.now(), cfg) * 1000 + 500);
  };
  return tick;
}

/**
 * Accepts either a plain hour ("19") or an hour with minutes ("4:30") and
 * returns a fractional hour, so 4:30 becomes 4.5. Returning a number rather
 * than a {h,m} pair keeps every comparison downstream a single `<`.
 */
function parseHourSetting(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim();
  const hhmm = s.match(/^(\d{1,2}):([0-5]\d)$/);
  if (hhmm) return Number(hhmm[1]) + Number(hhmm[2]) / 60;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** One-line summary of the capture schedule, for --check and the startup log. */
function describeSchedule(cfg = CONFIG) {
  const twoSpeed = Number.isFinite(cfg.slowAfterHour) && cfg.slowAfterHour > cfg.activeStartHour;
  if (!twoSpeed) return `Capturing every ${cfg.intervalMinutes} min.`;
  return `Capturing every ${cfg.intervalMinutes} min until `
    + `${formatHourSetting(cfg.slowAfterHour)}, then every ${cfg.slowIntervalMinutes} min.`;
}

/** Renders a fractional hour back as "4:30" / "19:00" for the --check output. */
function formatHourSetting(v) {
  const h = Math.floor(v);
  const m = Math.round((v - h) * 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// Token storage
// ─────────────────────────────────────────────────────────────────────────────

function readToken(cfg = CONFIG) {
  try {
    const t = fs.readFileSync(cfg.tokenFile, 'utf8').trim();
    return t || null;
  } catch (e) {
    return null;
  }
}

/**
 * Writes the token atomically: write to a temp file in the same directory, then
 * rename. A partial write here would leave an unusable token and require manual
 * re-authentication at the boathouse, so it is worth the extra call.
 */
function writeToken(token, cfg = CONFIG) {
  const dir = path.dirname(cfg.tokenFile);
  const tmp = path.join(dir, '.' + path.basename(cfg.tokenFile) + '.tmp');
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, cfg.tokenFile);
  try { fs.chmodSync(cfg.tokenFile, 0o600); } catch (e) { /* best effort */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * PUTs the JPEG to the receiving endpoint. Deliberately a plain authenticated
 * PUT rather than an S3 SDK: signing libraries are heavy for a Pi Zero W, and
 * this keeps the Pi outbound-only — nothing inbound is ever exposed.
 */
/** A header value: printable ASCII only, bounded - a camera name is user-set text. */
function headerSafe(s, max = 60) {
  return String(s == null ? '' : s).replace(/[^\x20-\x7e]/g, '').trim().slice(0, max);
}

async function uploadSnapshot(buffer, cfg = CONFIG, fetchImpl = globalThis.fetch, meta = {}) {
  const headers = {
    'Authorization': `Bearer ${cfg.uploadSecret}`,
    'Content-Type': 'image/jpeg',
    // Do NOT set Content-Length. undici derives it from the body and
    // rejects a caller-supplied value with UND_ERR_INVALID_ARG, so setting
    // it here made every upload fail before a byte left the Pi.
  };
  // Which camera took the frame. The Worker stores these with it and the
  // website labels a backup view as one - the backup looks at a different
  // stretch of river, and members must know which view they are looking at.
  if (meta.role === 'primary' || meta.role === 'backup') headers['X-Camera-Role'] = meta.role;
  const name = headerSafe(meta.name);
  if (name) headers['X-Camera-Name'] = name;
  let res;
  try {
    res = await fetchImpl(cfg.uploadUrl, {
      method: 'PUT',
      headers,
      body: buffer,
    });
  } catch (e) {
    // Node's fetch reports every transport failure as the useless string
    // "fetch failed" and hides the real reason on err.cause. On this host the
    // likely causes are DNS (the Pi resolves through its own Pi-hole, and some
    // blocklists cover *.workers.dev) or TLS. Surface it, or debugging is guesswork.
    throw new Error(`upload to ${hostOf(cfg.uploadUrl)} failed: ${describeCause(e)}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ring
// ─────────────────────────────────────────────────────────────────────────────

async function connectRing(cfg = CONFIG) {
  const token = readToken(cfg);
  if (!token) {
    throw new Error(
      `No Ring refresh token at ${cfg.tokenFile}.\n` +
      `Generate one with:  npx -p ring-client-api ring-auth-cli\n` +
      `then write it to that file (chmod 600).`);
  }

  // ring-client-api v14+ is an ES module, so it cannot be require()d from this
  // CommonJS file — Node throws ERR_REQUIRE_ESM. A dynamic import() works from
  // CommonJS and is available in every supported Node version. This function is
  // already async, so awaiting it costs nothing.
  const { RingApi } = await import('ring-client-api');
  const api = new RingApi({
    refreshToken: token,
    // Explicitly OFF. ring-client-api only sets up status polling when this is
    // truthy (api.js: `if (!cameraStatusPollingSeconds) return`), so leaving it
    // unset happens to work — but it makes us dependent on a library default we
    // do not control, and the battery here has no margin for a version that
    // changes it. We need snapshots and nothing else; polling would add regular
    // traffic for status we never read.
    cameraStatusPollingSeconds: 0,
    // Likewise: no alarm/location mode polling. This account exists only to
    // pull frames from one shared camera.
    locationModePollingSeconds: 0,
    controlCenterDisplayName: 'NHRC Boathouse Camera',
  });

  // THE CRITICAL SUBSCRIPTION. Ring issues a new refresh token roughly hourly.
  // If these are not persisted, the next cold start fails AND the account's push
  // notifications break permanently until the client is deleted in Ring Control
  // Center. This is the single most important line in the file.
  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    try {
      writeToken(newRefreshToken, cfg);
      log('Refresh token rotated and saved.');
    } catch (e) {
      logError('COULD NOT SAVE ROTATED TOKEN —', e.message);
      logError('Fix the permissions on', cfg.tokenFile,
        'promptly: if the process restarts before this succeeds, re-authentication will be required.');
    }
  });

  return api;
}

const cameraList = (cameras) => cameras.map(c => `"${c.name}"`).join(', ');

/**
 * The camera a configured name refers to, or null when none does. The full
 * name wins (case-insensitive); otherwise a part of a name that matches exactly
 * one camera. A part matching several is an error, not a guess: "Dock" or
 * "Lot" could otherwise pick the battery camera and run it every 5 minutes.
 */
function findCamera(cameras, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  const nameOf = c => String(c.name || '').trim().toLowerCase();
  const exact = cameras.filter(c => nameOf(c) === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`Several cameras are named "${name}": ${cameraList(exact)}`);
  const partial = cameras.filter(c => nameOf(c).includes(want));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${name}" matches several cameras (${cameraList(partial)}) — use the full name`);
  }
  return null;
}

/**
 * The primary and backup cameras on the account. A missing backup only
 * disables the fallback. A missing primary is logged loudly and the backup
 * runs on its own (battery-friendly) timetable, so the website keeps a view;
 * only when neither can be found does the service stop.
 */
async function pickCameras(api, cfg = CONFIG) {
  const cameras = await api.getCameras();
  if (!cameras.length) throw new Error('No cameras found on this Ring account.');
  log(`Cameras on this account: ${cameraList(cameras)}`);
  let primary;
  if (cfg.cameraName) {
    primary = findCamera(cameras, cfg.cameraName);
  } else if (cameras.length === 1) {
    primary = cameras[0];
  } else {
    // Refuse to guess: the first camera on the list may be the battery one.
    throw new Error(`${cameras.length} cameras on this Ring account and RING_CAMERA_NAME is unset. `
      + `Set it to one of: ${cameraList(cameras)}`);
  }
  const backup = cfg.backupCameraName ? findCamera(cameras, cfg.backupCameraName) : null;
  if (primary && backup && primary === backup) {
    throw new Error('RING_CAMERA_NAME and RING_BACKUP_CAMERA_NAME pick the same camera');
  }
  if (!primary && !backup) {
    throw new Error(`No camera matching "${cfg.cameraName}"`
      + (cfg.backupCameraName ? ` or "${cfg.backupCameraName}"` : '') + `. Available: ${cameraList(cameras)}`);
  }
  if (!primary) {
    logError(`No camera matching RING_CAMERA_NAME "${cfg.cameraName}" (available: ${cameraList(cameras)}). `
      + 'The backup camera will run on its own timetable until this is fixed.');
  }
  if (cfg.backupCameraName && !backup) {
    logError(`No camera matching RING_BACKUP_CAMERA_NAME "${cfg.backupCameraName}" `
      + `(available: ${cameraList(cameras)}). Running without a backup.`);
  }
  return { primary, backup };
}

/** The single camera to use - kept for compatibility; the service uses pickCameras(). */
async function pickCamera(api, cfg = CONFIG) {
  const { primary, backup } = await pickCameras(api, cfg);
  return primary || backup;
}

/**
 * Captures one snapshot, retrying on failure.
 *
 * Battery cameras cannot produce a snapshot while recording, so a capture that
 * lands during a motion event fails outright. Retrying after a short delay
 * recovers the cycle instead of leaving the site with a stale frame.
 */
async function captureWithRetry(camera, cfg = CONFIG) {
  let lastErr;
  for (let attempt = 1; attempt <= cfg.retries; attempt++) {
    try {
      const buf = await camera.getSnapshot();
      if (!buf || !buf.length) throw new Error('empty snapshot buffer');
      return buf;
    } catch (e) {
      lastErr = e;
      logError(`snapshot attempt ${attempt}/${cfg.retries} failed: ${describeCause(e)}`);
      if (attempt < cfg.retries) await sleep(cfg.retryDelaySeconds * 1000);
    }
  }
  throw lastErr || new Error('snapshot failed');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────────────────────

async function runCycle(camera, cfg = CONFIG, now = new Date(), fetchImpl = globalThis.fetch, role = 'primary') {
  if (!isWithinActiveHours(now, cfg)) {
    log('Outside active hours — skipping capture.');
    return false;
  }
  // Label the stage: "fetch failed" alone cannot be told apart from a Ring
  // download failure, and the two have completely different fixes. The
  // scheduler also needs it: only a CAPTURE failure means the camera is down.
  const fail = (stage, e) => Object.assign(
    new Error(`${stage.toUpperCase()} stage (${role} "${camera.name}") — ${describeCause(e)}`), { stage });
  let buf;
  try {
    buf = await captureWithRetry(camera, cfg);
  } catch (e) {
    throw fail('capture', e);
  }
  log(`Captured ${buf.length} bytes from ${role} "${camera.name}"; uploading to ${hostOf(cfg.uploadUrl)}`);
  try {
    await uploadSnapshot(buf, cfg, fetchImpl, { role, name: camera.name });
  } catch (e) {
    throw fail('upload', e);
  }
  log(`Snapshot uploaded (${(buf.length / 1024).toFixed(0)} KB).`);
  return true;
}

/** "around the clock" or "5:00-16:00 America/New_York", for --check and the startup log. */
function describeWindow(cfg = CONFIG) {
  return cfg.activeStartHour === 0 && cfg.activeEndHour === 0
    ? 'around the clock'
    : formatHourSetting(cfg.activeStartHour) + '-' + formatHourSetting(cfg.activeEndHour) + ' ' + cfg.timeZone;
}

/** "every 5 min, around the clock" / "every 30 min until 10:00, then every 60 min, 5:00-16:00 ...". */
function describeTimetable(cfg = CONFIG) {
  const rate = describeSchedule(cfg).replace(/^Capturing /, '').replace(/\.$/, '');
  return `${rate}, ${describeWindow(cfg)}`;
}

async function main() {
  const args = process.argv.slice(2);

  const problems = validateConfig();
  if (problems.length) {
    logError('Configuration problems:');
    problems.forEach(p => console.error('  - ' + p));
    console.error('\nSee camera/README.md for setup.');
    process.exit(1);
  }
  const backupCfg = backupConfig(CONFIG);
  if (args.includes('--check')) {
    log('Configuration looks valid.');
    log(`  primary      : ${CONFIG.cameraName ? `"${CONFIG.cameraName}"` : '(the only camera on the account)'} — `
      + describeTimetable(CONFIG));
    log(`  backup       : ${CONFIG.backupCameraName
      ? `"${CONFIG.backupCameraName}" — only after ${CONFIG.backup.afterMisses} missed primary captures in a row; `
        + `then ${describeTimetable(backupCfg)}`
      : 'none'}`);
    log(`  token file   : ${CONFIG.tokenFile} (${readToken() ? 'present' : 'MISSING'})`);
    log(`  upload to    : ${CONFIG.uploadUrl}`);
    return;
  }

  const api = await connectRing();
  const { primary, backup } = await pickCameras(api);
  if (primary) log(`Primary camera: "${primary.name}" — ${describeTimetable(CONFIG)}`);
  if (backup) {
    log(`Backup camera: "${backup.name}" — only after ${CONFIG.backup.afterMisses} missed primary captures in a row; `
      + `then ${describeTimetable(backupCfg)}`);
  }

  if (args.includes('--once-backup')) {
    if (!backup) throw new Error('No backup camera configured or found.');
    // A deliberate test: no window. The frame shows on the website, labelled
    // as the backup, until the next primary capture replaces it.
    await runCycle(backup, Object.assign({}, backupCfg, { activeStartHour: 0, activeEndHour: 0 }),
      new Date(), globalThis.fetch, 'backup');
    process.exit(0);
  }
  if (args.includes('--once')) {
    if (!primary) throw new Error('No primary camera found.');
    await runCycle(primary, CONFIG, new Date(), globalThis.fetch, 'primary');
    process.exit(0);
  }

  log('Starting. Captures on the slot boundaries, from the window start.');

  // setTimeout that reschedules itself, not setInterval: the next wake-up is
  // the next slot boundary, recomputed from the clock every time. A slow cycle
  // can never make captures pile up, and can never shift the timetable.
  const tick = createScheduler(CONFIG, {
    now: () => new Date(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    hasPrimary: !!primary,
    hasBackup: !!backup,
    cycle: (role) => role === 'backup'
      ? runCycle(backup, backupCfg, new Date(), globalThis.fetch, 'backup')
      : runCycle(primary, CONFIG, new Date(), globalThis.fetch, 'primary'),
  });
  await tick();
}

module.exports = {
  CONFIG, validateConfig, isWithinActiveHours,
  readToken, writeToken, uploadSnapshot, captureWithRetry, runCycle,
  describeCause, hostOf, parseHourSetting, formatHourSetting,
  intervalForTime, localHour, describeSchedule,
  localSeconds, windowGeometry, captureSlot, secondsUntilNextSlot, createScheduler,
  MAX_SLEEP_SECONDS,
  findCamera, pickCameras, pickCamera, backupConfig, scheduleProblems, headerSafe, describeWindow,
  describeTimetable,
};

if (require.main === module) {
  main().catch(err => {
    logError(err.message);
    process.exit(1);
  });
}
