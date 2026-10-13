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
 * every 15 minutes, around the clock. The BACKUP (RING_BACKUP_CAMERA_NAME, the
 * battery-powered "Downstream Lot") is never used routinely, to spare its
 * battery: only once the primary has missed BACKUP_AFTER_MISSES captures in a
 * row (two, ~30 minutes), and then only on its own battery-friendly daylight
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
const { spawn } = require('child_process');

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
  // every 15 minutes.
  cameraName: process.env.RING_CAMERA_NAME || '',
  backupCameraName: process.env.RING_BACKUP_CAMERA_NAME || '',

  // Upload destination and shared secret.
  uploadUrl: process.env.CAMERA_UPLOAD_URL || '',
  uploadSecret: process.env.CAMERA_UPLOAD_SECRET || '',

  // The PRIMARY camera's timetable. The defaults suit a hardwired camera:
  // every 15 minutes, around the clock (both window hours 0 = always).
  //
  // Not more often. Ring only provides a new photo of the dock camera every
  // 15 minutes, on the quarter hour - its Snapshot Capture frequency, set in
  // the Ring app. Tried at 5 minutes (October 2026): the :05 and :10 captures
  // waited for a new photo, failed three times each, and the website still
  // showed one from the quarter hour. To go faster, raise that frequency in
  // the Ring app first, then this and BACKUP_AFTER_MISSES (two misses is the
  // half hour before the backup is used).
  intervalMinutes: Number(process.env.CAMERA_INTERVAL_MINUTES || 15),

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
  // missed this many captures in a row, and only on its own timetable - the
  // battery-friendly one: daylight, every 30 minutes until 10am, then hourly.
  // A night-time frame from an unlit river is dark anyway.
  backup: {
    afterMisses: Number(process.env.BACKUP_AFTER_MISSES || 2),
    intervalMinutes: Number(process.env.BACKUP_INTERVAL_MINUTES || 30),
    slowAfterHour: parseHourSetting(process.env.BACKUP_SLOW_AFTER_HOUR, 10),
    slowIntervalMinutes: Number(process.env.BACKUP_SLOW_INTERVAL_MINUTES || 60),
    activeStartHour: parseHourSetting(process.env.BACKUP_ACTIVE_START_HOUR, 5),
    activeEndHour: parseHourSetting(process.env.BACKUP_ACTIVE_END_HOUR, 16),
  },

  timeZone: process.env.CAMERA_TIMEZONE || 'America/New_York',

  // TIMELAPSE - off unless TIMELAPSE_EVERY_MINUTES or TIMELAPSE_TIMES is set.
  // Frames from the camera's live video - sharper than its 640x360 snapshots
  // - saved ON THIS PI, never uploaded. See "Timelapse" below and
  // camera/README.md.
  timelapse: {
    // At these local times (e.g. "8:00,12:00,15:00"), right after that slot's
    // dock photo.
    times: parseTimeList(process.env.TIMELAPSE_TIMES),
    // Or a frame every this many minutes (5 at the least) from TIMELAPSE_FROM
    // to TIMELAPSE_UNTIL - 'sunrise', 'sunset' or a local time like 7:30 - on
    // its own timetable, beside the dock photos'. 0 (the default) = off.
    everyMinutes: Number(process.env.TIMELAPSE_EVERY_MINUTES || 0),
    from: String(process.env.TIMELAPSE_FROM || 'sunrise').trim().toLowerCase(),
    until: String(process.env.TIMELAPSE_UNTIL || 'sunset').trim().toLowerCase(),
    // Where sunrise and sunset are reckoned for: the boathouse (the point the
    // website's weather uses).
    latitude: Number(process.env.TIMELAPSE_LATITUDE || 41.437),
    longitude: Number(process.env.TIMELAPSE_LONGITUDE || -73.119),
    cameraName: process.env.TIMELAPSE_CAMERA_NAME || process.env.RING_BACKUP_CAMERA_NAME || '',
    dir: process.env.TIMELAPSE_DIR || '/opt/nhrc-camera/timelapse',
    ffmpegPath: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
    // Ring's live view starts at a low resolution and steps up as it runs - and
    // sometimes back down. In daylight on the Pi (October 2026): 848x480 after
    // 5 s, 1280x720 by 18 s; at night 1920x1080 within 8 s. So: up to this many
    // seconds of live video, stopping as soon as a keyframe TIMELAPSE_TARGET_HEIGHT
    // tall has arrived; the sharpest clean keyframe is kept.
    recordSeconds: Number(process.env.TIMELAPSE_RECORD_SECONDS || 45),
    targetHeight: Number(process.env.TIMELAPSE_TARGET_HEIGHT || 1080),
    // A battery camera gets no live view under this charge, and again only
    // from 15 points above it: the timelapse must never flatten it.
    minBattery: Number(process.env.TIMELAPSE_MIN_BATTERY || 40),
    // Where each recording is made, then deleted. Best in memory (/run - see
    // camera/README.md), not on the SD card. Unset: the system's temp folder.
    workDir: process.env.TIMELAPSE_WORK_DIR || '',
    // Every-few-minutes timetable: if this program ever grows past this (MB)
    // at two checks in a row, it restarts itself (systemd starts it again a
    // minute later), so a slow leak in the live-video libraries can never take
    // memory from Pi-hole. It used about 77 MB after captures (October 2026).
    maxRssMb: Number(process.env.TIMELAPSE_MAX_RSS_MB || 160),
    // The SD card always keeps this much free: nothing is saved below it.
    minDiskMb: Number(process.env.TIMELAPSE_MIN_DISK_MB || 500),
    // This Pi also serves the house's DNS, so it always keeps this much
    // memory available for Pi-hole (MemAvailable in /proc/meminfo). The live
    // video starts only with 40 MB more than this available, and is stopped
    // at once if the Pi falls below it.
    minMemoryMb: Number(process.env.TIMELAPSE_MIN_MEMORY_MB || 40),
    // When the live video fails, the 640x360 snapshot is saved instead -
    // after this pause: a battery camera cannot take one while it streams,
    // nor straight after (the snapshot is tried twice, 30 s apart).
    snapshotPauseSeconds: Number(process.env.TIMELAPSE_SNAPSHOT_PAUSE_SECONDS || 20),
  },

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
  return [...serviceProblems(cfg), ...timelapseProblems(cfg)];
}

/** Problems that stop the service: the dock photos cannot run with them. */
function serviceProblems(cfg = CONFIG) {
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
 * Problems with the timelapse settings. The service itself runs without the
 * timelapse when there are any (the website's photos matter more); --check
 * reports them and fails.
 */
function timelapseProblems(cfg = CONFIG) {
  const problems = [];
  const tl = cfg.timelapse;
  // Unset is 0 (off); anything that is not a number is a mistake, not "off".
  const every = !tl || tl.everyMinutes === undefined || tl.everyMinutes === null ? 0 : Number(tl.everyMinutes);
  if (tl && ((tl.times && tl.times.length) || every !== 0)) {
    for (const t of tl.times || []) {
      if (!Number.isFinite(t.minutes)) problems.push(`TIMELAPSE_TIMES: "${t.label}" is not a time like 8:00 or 15:30`);
    }
    if (tl.times && tl.times.length && every !== 0) {
      problems.push('TIMELAPSE_TIMES and TIMELAPSE_EVERY_MINUTES are both set: use one or the other');
    }
    if (every !== 0 && !(Number.isInteger(every) && every >= 5 && 60 % every === 0)) {
      problems.push('TIMELAPSE_EVERY_MINUTES must be 5, 6, 10, 12, 15, 20, 30 or 60');
    }
    if (every !== 0) {
      for (const [name, v] of [['TIMELAPSE_FROM', tl.from], ['TIMELAPSE_UNTIL', tl.until]]) {
        if (!parseWindowEdge(v)) problems.push(`${name}: "${v}" is not sunrise, sunset or a time like 7:30`);
      }
      const from = parseWindowEdge(tl.from), until = parseWindowEdge(tl.until);
      if (from && until && ((from.sun && until.sun && !(from.sun === 'sunrise' && until.sun === 'sunset'))
          || (from.minutes !== undefined && until.minutes !== undefined && from.minutes >= until.minutes))) {
        problems.push('TIMELAPSE_FROM must come before TIMELAPSE_UNTIL (the window cannot run through midnight)');
      }
      // Beyond the polar circles the sun need not rise or set at all.
      if (!(tl.latitude >= -65 && tl.latitude <= 65)) problems.push('TIMELAPSE_LATITUDE must be between -65 and 65');
      if (!(tl.longitude >= -180 && tl.longitude <= 180)) problems.push('TIMELAPSE_LONGITUDE must be between -180 and 180');
    }
    if (!String(tl.cameraName || '').trim()) {
      problems.push('The timelapse is on but there is no camera for it: set TIMELAPSE_CAMERA_NAME (or RING_BACKUP_CAMERA_NAME)');
    }
    if (!(Number.isInteger(tl.recordSeconds) && tl.recordSeconds >= 4 && tl.recordSeconds <= 60)) {
      problems.push('TIMELAPSE_RECORD_SECONDS must be a whole number from 4 to 60');
    }
    // 0: never stop early - always the whole TIMELAPSE_RECORD_SECONDS.
    if (!(Number.isInteger(tl.targetHeight) && (tl.targetHeight === 0 || (tl.targetHeight >= 240 && tl.targetHeight <= 2160)))) {
      problems.push('TIMELAPSE_TARGET_HEIGHT must be 0 (never stop early) or a whole number from 240 to 2160');
    }
    if (!(Number.isInteger(tl.minBattery) && tl.minBattery >= 0 && tl.minBattery <= 85)) {
      problems.push('TIMELAPSE_MIN_BATTERY must be a whole number from 0 to 85');
    }
    if (tl.workDir && !path.isAbsolute(String(tl.workDir))) problems.push('TIMELAPSE_WORK_DIR must be an absolute path');
    if (!(tl.maxRssMb >= 120)) problems.push('TIMELAPSE_MAX_RSS_MB must be at least 120');
    if (!path.isAbsolute(String(tl.dir || ''))) problems.push('TIMELAPSE_DIR must be an absolute path');
    if (!path.isAbsolute(String(tl.ffmpegPath || ''))) problems.push('FFMPEG_PATH must be an absolute path');
    if (!(tl.minDiskMb >= 100)) problems.push('TIMELAPSE_MIN_DISK_MB must be at least 100');
    if (!(tl.minMemoryMb >= 20)) problems.push('TIMELAPSE_MIN_MEMORY_MB must be at least 20 (memory kept for Pi-hole)');
    if (!(Number.isInteger(tl.snapshotPauseSeconds) && tl.snapshotPauseSeconds >= 0 && tl.snapshotPauseSeconds <= 120)) {
      problems.push('TIMELAPSE_SNAPSHOT_PAUSE_SECONDS must be a whole number from 0 to 120');
    }
  }
  return problems;
}

/**
 * "8:00,12:00,15:00" -> [{ minutes: 480, label: '08:00' }, ...], sorted, each
 * time once. An entry that is not a time keeps minutes NaN, for validation to
 * name. Unset or empty means no timelapse.
 */
function parseTimeList(raw) {
  if (raw === undefined || raw === null || !String(raw).trim()) return [];
  const out = [];
  for (const part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})(?::([0-5]\d))?$/.exec(part);
    const minutes = m && Number(m[1]) < 24 ? Number(m[1]) * 60 + Number(m[2] || 0) : NaN;
    const label = Number.isFinite(minutes)
      ? `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` : part;
    if (!out.some(o => o.minutes === minutes && Number.isFinite(minutes))) out.push({ minutes, label });
  }
  return out.sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
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
  // A slot's photos are being taken: the every-few-minutes timelapse waits.
  let busy = false;

  const tick = async () => {
    const slot = captureSlot(deps.now(), cfg);
    if (slot && slot.key !== lastSlotKey) {
      // Before the capture: a failed cycle is not retried until the next
      // slot. captureWithRetry already retries within the cycle, and a slot
      // that keeps failing must not turn into a capture every wake-up.
      lastSlotKey = slot.key;
      busy = true;
      try {
        await photos();
      } finally {
        busy = false;
      }
    }
    // Anything that should follow the photos (the timelapse), after them so
    // it can never delay one. Its failure is contained here: the timetable
    // goes on regardless.
    if (deps.afterSlot) {
      try {
        await deps.afterSlot();
      } catch (e) {
        logError('after-slot task failed:', e.message);
      }
    }
    // Half a second past the boundary, so the clock reads the new slot.
    deps.setTimer(tick, secondsUntilNextSlot(deps.now(), cfg) * 1000 + 500);
  };

  // One slot's photos: the primary, and the backup if the primary keeps missing.
  const photos = async () => {
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
  };
  // For the every-few-minutes timelapse: whether a slot's photos are being
  // taken, and whether the website is using the backup camera.
  tick.busy = () => busy;
  tick.onBackup = () => onBackup;
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
    // The timelapse's live video goes through ffmpeg; without a timelapse
    // the library never starts it.
    ...(timelapseOn(cfg) ? { ffmpegPath: cfg.timelapse.ffmpegPath } : {}),
  });
  if (timelapseOn(cfg)) {
    // So a failed live view can say what Ring did (see ringNotes).
    try {
      const util = await import('ring-client-api/util');
      util.useLogger({ logInfo: (...m) => ringNotes.note('info', m), logError: (m) => ringNotes.note('error', [m]) });
    } catch (e) { /* a version without the hook: failures say less */ }
  }

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
 * "Lot" could otherwise pick the battery camera and run it every 15 minutes.
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

/** "every 15 min, around the clock" / "every 30 min until 10:00, then every 60 min, 5:00-16:00 ...". */
function describeTimetable(cfg = CONFIG) {
  const rate = describeSchedule(cfg).replace(/^Capturing /, '').replace(/\.$/, '');
  return `${rate}, ${describeWindow(cfg)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Timelapse
// ─────────────────────────────────────────────────────────────────────────────
//
// For a construction timelapse: the sharpest clean keyframe of up to
// TIMELAPSE_RECORD_SECONDS of the camera's live video (it stops early once a
// keyframe TIMELAPSE_TARGET_HEIGHT tall has arrived) - 848x480 to 1280x720 in
// daylight so far, up to 1920x1080 at night; Ring snapshots are only 640x360.
// Saved on this Pi, never uploaded, never on the website. Two timetables:
//  - TIMELAPSE_TIMES: a few set times a day, right after that slot's dock
//    photo (TIMELAPSE_DIR/YYYY-MM-DD_HHMM.jpg; the snapshot if the video fails);
//  - TIMELAPSE_EVERY_MINUTES: every few minutes from sunrise to sunset, on its
//    own clock beside the dock photos' (TIMELAPSE_DIR/YYYY-MM-DD/..._HHMM.jpg;
//    a frame that fails is simply missed - the next is minutes away).
//
// THIS PI ALSO SERVES THE HOUSE'S DNS, so the capture is gentle and fails safe:
// - It never holds up a dock photo: set times run after the slot's photo, the
//   every-few-minutes timetable runs on its own.
// - A battery camera gets no live view under TIMELAPSE_MIN_BATTERY; the
//   timelapse pauses while the website needs that camera as its backup; after
//   six failed live views in a row it waits an hour; after two captures in a
//   day that never finished (the service stopped during them) it stops for the
//   day; and if this program ever grows past TIMELAPSE_MAX_RSS_MB it restarts.
// - The video is RECORDED without decoding (light work), then decoded
//   afterwards, one keyframe at a time, single-threaded. In the first test on
//   the Pi Zero, decoding as the video arrived, the picture came out smeared
//   (October 2026).
// - Every step has a deadline. ffmpeg is killed at its deadline, the live view
//   is always ended, and the temporary files always removed.
// - Memory is kept for Pi-hole: the live video starts only with room to spare
//   (TIMELAPSE_MIN_MEMORY_MB + 40 MB available), and the memory is checked
//   twice a second throughout - below TIMELAPSE_MIN_MEMORY_MB the live view
//   and ffmpeg are stopped at once.
// - A damaged keyframe is never saved. If no clean one arrives, the 640x360
//   snapshot is saved instead (..._snapshot.jpg), so the day is not missed.
// - Nothing is written unless the disk has TIMELAPSE_MIN_DISK_MB free.
// - Each time is tried once a day, and that is noted on disk before it starts:
//   a capture that brought the service down is not tried again on restart, so
//   it can never become a restart loop.
// - systemd lowers the service's priority below Pi-hole's and makes the kernel
//   stop it first if memory ever runs out; the network buffers are raised -
//   see camera/README.md, "Timelapse".

const TIMELAPSE_WINDOW_MINUTES = 15;          // a time is due from T until T+15 min: one dock slot
const LIVE_START_TIMEOUT_MS = 30 * 1000;      // to get the live view going
const LIVE_EXTRA_MS = 45 * 1000;              // connection set-up, on top of the recording itself
const FFMPEG_STEP_TIMEOUT_MS = 45 * 1000;     // each ffprobe or decode run
const MAX_KEYFRAMES_TRIED = 4;
const CAPTURE_TIMEOUT_MS = 6 * 60 * 1000;     // the whole capture, fallback included, whatever happens
const SOCKET_BUFFER_BYTES = 8 * 1024 * 1024;  // ffmpeg's receive buffer (the system caps it at net.core.rmem_max)
const LIVE_MEMORY_NEED_MB = 40;               // headroom, on top of TIMELAPSE_MIN_MEMORY_MB, to start the live video
const MEMORY_CHECK_MS = 500;                  // how often the memory is checked during a capture
// The fallback snapshot. A battery camera cannot take one while it streams,
// nor straight after: on the Pi the first try, made at once, failed with
// "unable to capture snapshots while streaming" (7 October 2026). So: a pause
// first (TIMELAPSE_SNAPSHOT_PAUSE_SECONDS), and a second try.
const SNAPSHOT_TRIES = 2;
const SNAPSHOT_RETRY_MS = 30 * 1000;
const KEYFRAME_ASK_MS = 2000;                 // until the recording starts, a keyframe is asked for this often
// Stopping early: once a keyframe TIMELAPSE_TARGET_HEIGHT tall has been
// announced (its SPS), with no packet missing for this long after it - time
// for the whole keyframe to reach ffmpeg - the live view is ended.
const TARGET_SETTLE_MS = 3000;
// After the live view, the time ffmpeg has to finish its file before it is
// killed: once the video stops, it waits up to 10 s for more (its SDP input's
// listen_timeout) before it acts on its stop signal (see finishFfmpeg).
const FFMPEG_FINISH_MS = 15 * 1000;
// Stopped by us (early, or at the deadline), ffmpeg ends the live view as it
// exits; if it has not exited by then, the live view is ended here.
const RECORDER_EXIT_MS = 12 * 1000;
const CLIP_MAX_MB = 32;                       // a recording is never larger (ffmpeg -fs); 45 s is about 2-12 MB
const CLIP_MIN_MB = 8;                        // ... and is not started without room for this much
const WORK_KEEP_FREE_MB = 16;                 // what a recording always leaves free where it is made (/run is shared)
// The every-few-minutes timetable.
const INTERVAL_WAKE_MS = 2000;                // it wakes 2 s past each slot - after the dock clock (0.5 s)
const DOCK_WAIT_MS = 4 * 60 * 1000;           // a frame due with a dock photo waits for it, at most this long
const DOCK_POLL_MS = 1000;
const FAILURES_BEFORE_REST = 6;               // live views failing in a row ...
const REST_MS = 60 * 60 * 1000;               // ... then a rest of an hour
const UNFINISHED_BEFORE_STOP = 2;             // captures a day that never finished, before it stops for the day
const BATTERY_RESUME_POINTS = 15;             // stopped under TIMELAPSE_MIN_BATTERY, it resumes this far above it
const BATTERY_READ_TIMEOUT_MS = 15 * 1000;
const MAX_OPEN_FILES = 400;                   // files and sockets: more means a leak (the limit is 1024)

function timelapseOn(cfg = CONFIG) {
  const tl = cfg.timelapse;
  return !!(tl && ((tl.times && tl.times.length) || Number(tl.everyMinutes) > 0));
}

/** The every-few-minutes timetable is on. */
function intervalOn(cfg = CONFIG) {
  return !!(cfg.timelapse && Number(cfg.timelapse.everyMinutes) > 0);
}

/** 'sunrise' / 'sunset' -> { sun }, '7:30' -> { minutes: 450 }, anything else -> null. */
function parseWindowEdge(raw) {
  const s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase();
  if (s === 'sunrise' || s === 'sunset') return { sun: s };
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  if (m && Number(m[1]) < 24) return { minutes: Number(m[1]) * 60 + Number(m[2]) };
  return null;
}

/**
 * Sunrise and sunset on a calendar date at a place, as instants (ms): the
 * sun's upper edge at the horizon, refraction included (its centre 0.833
 * degrees below). NOAA's solar calculator (after Meeus), each event worked out
 * at its own time - at the boathouse, the US Naval Observatory's almanac to
 * the minute (tested). null when the sun does not rise or set that day.
 */
function sunTimes(ymd, latitude, longitude) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const day0 = Date.UTC(y, m - 1, d);
  const rad = Math.PI / 180;
  const event = (rising) => {
    let t = day0 + (12 - longitude / 15) * 3600000;   // first guess: local solar noon
    for (let pass = 0; pass < 3; pass++) {
      const T = (t / 86400000 + 2440587.5 - 2451545) / 36525;   // Julian centuries since J2000
      const L0 = ((280.46646 + T * (36000.76983 + T * 0.0003032)) % 360 + 360) % 360;
      const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
      const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
      const C = Math.sin(M * rad) * (1.914602 - T * (0.004817 + 0.000014 * T))
        + Math.sin(2 * M * rad) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * rad) * 0.000289;
      const omega = 125.04 - 1934.136 * T;
      const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * rad);
      const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60
        + 0.00256 * Math.cos(omega * rad);
      const decl = Math.asin(Math.sin(eps * rad) * Math.sin(lambda * rad));
      const v = Math.tan(eps * rad / 2) ** 2;
      const eqTime = 4 / rad * (v * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M * rad)
        + 4 * e * v * Math.sin(M * rad) * Math.cos(2 * L0 * rad) - 0.5 * v * v * Math.sin(4 * L0 * rad)
        - 1.25 * e * e * Math.sin(2 * M * rad));   // minutes
      const cosH = Math.cos(90.833 * rad) / (Math.cos(latitude * rad) * Math.cos(decl))
        - Math.tan(latitude * rad) * Math.tan(decl);
      if (!(cosH >= -1 && cosH <= 1)) return null;
      const ha = Math.acos(cosH) / rad;
      t = day0 + (720 - 4 * longitude - eqTime + (rising ? -4 : 4) * ha) * 60000;
    }
    return t;
  };
  const sunrise = event(true), sunset = event(false);
  return sunrise === null || sunset === null ? null : { sunrise, sunset };
}

/**
 * The every-few-minutes window on a local date, in local minutes of the day
 * (sunrise and sunset to the second: 07:02:40 is 422.67): { from, until }, or
 * null when there is none (the sun does not rise or set).
 */
function daylightMinutes(ymd, cfg = CONFIG) {
  const tl = cfg.timelapse;
  const sun = sunTimes(ymd, tl.latitude, tl.longitude);
  const edge = (spec) => {
    const e = parseWindowEdge(spec);
    if (!e) return null;
    if (e.minutes !== undefined) return e.minutes;
    if (!sun) return null;
    const p = localDateParts(new Date(sun[e.sun]), cfg);
    return p.minutes + Number(p.hhmmss.slice(4)) / 60;
  };
  const from = edge(tl.from), until = edge(tl.until);
  return from === null || until === null ? null : { from, until };
}

/** Minutes of the day as "07:05" (seconds dropped). */
const hhmm = (minutes) => {
  const m = Math.floor(minutes);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

/**
 * The every-few-minutes slot that `now` falls in: slots start on the clock's
 * multiples of TIMELAPSE_EVERY_MINUTES (7:00, 7:05 ...), and a slot counts
 * when it starts inside the day's window (from the first slot at or after
 * sunrise to the last at or before sunset).
 */
function intervalSlot(now, cfg = CONFIG) {
  const step = cfg.timelapse.everyMinutes * 60000;
  const start = Math.floor(now.getTime() / step) * step;
  const p = localDateParts(new Date(start), cfg);
  const win = daylightMinutes(p.date, cfg);
  return { start, end: start + step, date: p.date, minutes: p.minutes, label: hhmm(p.minutes), window: win,
           inWindow: !!win && p.minutes >= win.from && p.minutes <= win.until };
}

/**
 * The H.264 sequence parameter sets in one RTP packet's payload: a single NAL
 * unit of type 7, or inside a STAP-A (type 24, several small NAL units - how
 * a camera usually sends its SPS and PPS together).
 */
function spsNals(payload) {
  if (!payload || payload.length < 2) return [];
  const type = payload[0] & 0x1f;
  if (type === 7) return [payload];
  if (type !== 24) return [];
  const out = [];
  for (let i = 1; i + 2 <= payload.length;) {
    const size = payload.readUInt16BE(i);
    if (!size || i + 2 + size > payload.length) break;
    const nal = payload.subarray(i + 2, i + 2 + size);
    if ((nal[0] & 0x1f) === 7) out.push(nal);
    i += 2 + size;
  }
  return out;
}

/**
 * Width and height from an H.264 sequence parameter set (SPS) NAL unit, or
 * null if it cannot be read. ITU-T H.264 7.3.2.1.1, cropping included.
 */
function spsResolution(nal) {
  try {
    // Without its emulation-prevention bytes (00 00 03 -> 00 00).
    const bytes = [];
    for (let i = 1, zeros = 0; i < nal.length; i++) {
      const b = nal[i];
      if (zeros >= 2 && b === 3) { zeros = 0; continue; }
      bytes.push(b);
      zeros = b === 0 ? zeros + 1 : 0;
    }
    let bit = 0;
    const u = (n) => { let v = 0; for (let k = 0; k < n; k++, bit++) { if (bit >> 3 >= bytes.length) throw new Error('short');
      v = v * 2 + ((bytes[bit >> 3] >> (7 - (bit & 7))) & 1); } return v; };
    const ue = () => { let z = 0; while (u(1) === 0) { if (++z > 31) throw new Error('bad'); } return (2 ** z) - 1 + u(z); };
    const se = () => { const k = ue(); return k % 2 ? (k + 1) / 2 : -k / 2; };
    const profile = u(8); u(16); ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue();
      if (chroma === 3) u(1);
      ue(); ue(); u(1);
      if (u(1)) {
        for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) {
          if (u(1)) { let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; } }
        }
      }
    }
    ue();
    const poc = ue();
    if (poc === 0) ue();
    else if (poc === 1) { u(1); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); u(1);
    const wMbs = ue() + 1, hUnits = ue() + 1, frameMbsOnly = u(1);
    if (!frameMbsOnly) u(1);
    u(1);
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (u(1)) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
    const cropX = chroma === 0 || chroma === 3 ? 1 : 2;
    const cropY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = wMbs * 16 - (cl + cr) * cropX, height = (2 - frameMbsOnly) * hUnits * 16 - (ct + cb) * cropY;
    return width > 0 && height > 0 ? { width, height } : null;
  } catch (e) { return null; }
}

const dateFormats = new Map();   // one per timezone: building one costs more than using it

/** Local date, minutes of the day and hhmmss in the boathouse timezone. */
function localDateParts(now = new Date(), cfg = CONFIG) {
  let f = dateFormats.get(cfg.timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timeZone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    dateFormats.set(cfg.timeZone, f);
  }
  const p = f.formatToParts(now);
  const g = (t) => p.find(x => x.type === t).value;
  return { date: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')),
           hhmmss: `${g('hour')}${g('minute')}${g('second')}` };
}

/** Where the frame for `date` at time `t` is saved; kind 'live' or 'snapshot'. */
function timelapseFile(cfg, date, t, kind = 'live') {
  return path.join(cfg.timelapse.dir, `${date}_${t.label.replace(':', '')}${kind === 'snapshot' ? '_snapshot' : ''}.jpg`);
}

/**
 * The times due now: inside their 15-minute window, not saved yet, not tried
 * yet today (a failed time is not retried at every wake). After a restart
 * within the window the saved file is what says it is done.
 */
function timelapseDue(now, cfg, exists, tried) {
  if (!timelapseOn(cfg)) return [];
  const { date, minutes } = localDateParts(now, cfg);
  return cfg.timelapse.times
    .filter(t => Number.isFinite(t.minutes) && minutes >= t.minutes && minutes < t.minutes + TIMELAPSE_WINDOW_MINUTES
      && !tried.has(`${date} ${t.label}`)
      && !exists(timelapseFile(cfg, date, t, 'live')) && !exists(timelapseFile(cfg, date, t, 'snapshot')))
    .map(t => ({ date, time: t }));
}

/** Rejects after `ms` (the work itself is stopped by its own deadlines). */
function withTimeout(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The memory the Pi has available (MemAvailable, in MB), or null where it cannot be read. */
function availableMb() {
  try {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) / 1024 : null;
  } catch (e) { return null; }
}

/**
 * Stops everything one capture runs - the live view, every ffmpeg - at once.
 * The memory watch pulls it when the Pi runs short.
 */
class CaptureStop {
  constructor() { this.reason = null; this.kills = new Set(); }
  stop(reason) {
    if (this.reason) return;
    this.reason = reason;
    for (const kill of [...this.kills]) { try { kill(); } catch (e) { /* already gone */ } }
  }
  check() { if (this.reason) throw new Error(this.reason); }
}

/**
 * Checks the Pi's available memory now and every `everyMs` until stopped,
 * keeping the lowest seen. Below `floorMb` it calls onLow, once.
 */
function watchMemory(floorMb, onLow, read = availableMb, everyMs = MEMORY_CHECK_MS) {
  let timer = null;
  const w = { lowest: null, low: null, stop() { clearInterval(timer); } };
  const check = () => {
    const mb = read();
    if (typeof mb !== 'number' || !Number.isFinite(mb)) return;
    if (w.lowest === null || mb < w.lowest) w.lowest = mb;
    if (w.low === null && mb < floorMb) {
      w.low = mb;
      try { onLow(mb); } catch (e) { /* stopping is best effort */ }
    }
  };
  timer = setInterval(check, everyMs);
  check();
  return w;
}

/**
 * Runs ffmpeg or ffprobe, killing it at its deadline - or at once when the
 * capture is stopped. Never rejects.
 */
function runTool(cmd, args, timeoutMs = FFMPEG_STEP_TIMEOUT_MS, halt = null) {
  return new Promise((resolve) => {
    if (halt && halt.reason) { resolve({ code: null, stdout: '', stderr: halt.reason }); return; }
    let out = '', err = '', done = false;
    let p;
    try {
      p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e.message });
      return;
    }
    const kill = () => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } };
    const timer = setTimeout(kill, timeoutMs);
    if (halt) halt.kills.add(kill);
    p.stdout.on('data', (d) => { if (out.length < 1e6) out += d; });
    p.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (halt) halt.kills.delete(kill);
      resolve({ code, stdout: out, stderr: err });
    };
    p.on('error', (e) => { err += e.message; finish(null); });
    p.on('close', (code) => finish(code));
  });
}

/** The keyframes of a recorded clip, in time order: [{ t (seconds), width, height }]. */
async function keyframeInfo(ffprobe, clip, halt = null) {
  const r = await runTool(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=best_effort_timestamp_time,width,height', '-of', 'json', clip], FFMPEG_STEP_TIMEOUT_MS, halt);
  if (r.code !== 0) return [];
  let frames;
  try { frames = JSON.parse(r.stdout).frames || []; } catch (e) { return []; }
  return frames.map(f => ({ t: Number(f.best_effort_timestamp_time), width: Number(f.width) || 0, height: Number(f.height) || 0 }))
    .filter(f => Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
}

/**
 * The keyframes to try, best first: the sharpest (most pixels), then the
 * latest. Ring changes a live view's resolution as it goes - on the Pi one
 * 20 s recording ended at 1280x720, the next at 848x480 (October 2026) - so
 * the last keyframe is not always the sharpest.
 */
function keyframeOrder(frames, max = MAX_KEYFRAMES_TRIED) {
  return frames.slice().sort((a, b) => (b.width * b.height - a.width * a.height) || (b.t - a.t)).slice(0, max);
}

/** How the resolution went: "640x360 from 0.0 s, 848x480 from 4.2 s". */
function resolutionTimeline(frames) {
  const parts = [];
  let last = null;
  for (const f of frames) {
    const res = `${f.width}x${f.height}`;
    if (res !== last) { parts.push(`${res} from ${f.t.toFixed(1)} s`); last = res; }
  }
  return parts.join(', ');
}

/**
 * Decodes the clip's keyframes, best first (keyframeOrder), until one is
 * clean. { frame, checked, resolutions }, frame null when none is.
 */
async function pickKeyframe(ffmpeg, ffprobe, clip, frame, halt = null) {
  const keys = await keyframeInfo(ffprobe, clip, halt);
  const checked = [];
  if (halt) halt.check();
  for (const k of keyframeOrder(keys)) {
    const ok = await decodeKeyframe(ffmpeg, clip, k.t, frame, halt);
    if (halt) halt.check();
    checked.push(`${k.t.toFixed(1)} s ${k.width}x${k.height} ${ok ? 'clean' : 'damaged'}`);
    if (ok) return { frame, checked, resolutions: resolutionTimeline(keys), keys: keys.length };
  }
  return { frame: null, checked, resolutions: resolutionTimeline(keys), keys: keys.length };
}

/**
 * Decodes the keyframe at `t` to a JPEG, single-threaded, refusing a damaged
 * one: lost packets make the decoder report errors - and otherwise smear the
 * last good row down the picture.
 */
async function decodeKeyframe(ffmpeg, clip, t, out, halt = null) {
  try { fs.unlinkSync(out); } catch (e) { /* none */ }
  const r = await runTool(ffmpeg, ['-v', 'error', '-threads', '1', '-xerror', '-err_detect', 'explode',
    '-skip_frame', 'nokey', '-ss', String(t), '-i', clip, '-frames:v', '1', '-q:v', '2', '-y', out], FFMPEG_STEP_TIMEOUT_MS, halt);
  return r.code === 0 && !r.stderr.trim() && fs.existsSync(out) && fs.statSync(out).size > 0;
}

/**
 * The gist of what the recording ffmpeg said (FFREPORT, written next to the
 * clip): its first three errors - the cause comes first - and how many packets
 * it reported missing. '' when it said nothing of note.
 */
function ffmpegSummary(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return ''; }
  let lines = text.split(/[\r\n]+/).map(s => s.replace(/ @ 0x[0-9a-f]+/g, '').trim()).filter(Boolean);
  const cmd = lines.findIndex(l => l === 'Command line:');
  if (cmd >= 0) lines = lines.slice(cmd + 2);   // past the header and the command itself
  let missed = 0;
  for (const l of lines) for (const m of l.matchAll(/missed (\d+) packets/g)) missed += Number(m[1]);
  const errors = [...new Set(lines.filter(l => !/missed \d+ packets/.test(l)
    && /error|could not|not set|invalid|failed|unable|unspecified/i.test(l)))].slice(0, 3).map(l => l.slice(0, 160));
  const signal = lines.map(l => /received signal (\d+)/.exec(l)).find(Boolean);
  const parts = [];
  if (errors.length) parts.push(`ffmpeg: ${errors.join(' / ')}`);
  if (missed) parts.push(`ffmpeg missed ${missed} packets`);
  // Stopped from outside: the live view ended before ffmpeg was done.
  if (signal) parts.push(`ffmpeg was stopped (signal ${signal[1]})`);
  return parts.join('; ');
}

/** Hides anything that looks like a token or ticket, before text reaches the journal. */
function redact(text) {
  return String(text)
    .replace(/((?:token|ticket|auth[a-z_]*)=)[^&\s"']+/gi, '$1(hidden)')
    .replace(/("(?:[a-z_]*token|ticket|authorization)"\s*:\s*")[^"]*"/gi, '$1(hidden)"');
}

/** An object as one short line of text, for a log. */
function briefly(x, max = 160) {
  let s;
  if (typeof x === 'string') s = x;
  else if (x instanceof Error) s = x.message;
  else { try { s = JSON.stringify(x); } catch (e) { s = String(x); } }
  return redact(String(s).replace(/\s+/g, ' ').trim()).slice(0, max);
}

/**
 * ring-client-api logs nothing by default (it writes to the "debug" package).
 * During a timelapse capture its messages are kept, so a capture that fails
 * can say what Ring did; outside captures they are dropped, as before.
 */
const ringNotes = {
  on: false,
  lines: [],
  start() { this.on = true; this.lines = []; },
  stop() { this.on = false; const l = this.lines; this.lines = []; return l; },
  note(kind, args) {
    if (!this.on || this.lines.length >= 50) return;
    this.lines.push(`${kind === 'error' ? 'error: ' : ''}${args.map(a => briefly(a)).join(' ')}`);
  },
};

/** Counts RTP packets by sequence number (16-bit, wrapping), and how many are missing. */
class SequenceCounter {
  constructor() { this.seqs = new Set(); this.last = null; this.cycles = 0; this.lo = Infinity; this.hi = -Infinity; }
  add(seq) {
    if (typeof seq !== 'number') return;
    if (this.last !== null && seq < this.last && this.last - seq > 30000) this.cycles++;
    this.last = seq;
    const s = this.cycles * 65536 + seq;
    this.seqs.add(s);
    // Kept as it goes: `missing` is read four times a second while recording.
    if (s < this.lo) this.lo = s;
    if (s > this.hi) this.hi = s;
  }
  get received() { return this.seqs.size; }
  get missing() { return this.seqs.size ? this.hi - this.lo + 1 - this.seqs.size : 0; }
}

/** Width and height from a JPEG's start-of-frame marker, or null. */
function jpegSize(buf) {
  let i = 2;
  while (buf && i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB)
        || (marker >= 0xCD && marker <= 0xCF)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Records up to recordSeconds of the camera's live video WITHOUT decoding it
 * - stopping early once a keyframe TIMELAPSE_TARGET_HEIGHT tall has arrived
 * whole - then decodes the sharpest keyframes one at a time and returns the
 * first clean one. Throws when there is none.
 *
 * Memory comes first: the camera is not even woken without room for the
 * video and ffmpeg on top of what is kept for Pi-hole, and from then on the
 * memory is watched - below TIMELAPSE_MIN_MEMORY_MB everything is stopped.
 * The recording itself is capped (CLIP_MAX_MB) and always leaves
 * WORK_KEEP_FREE_MB free where it is made: in memory (/run), it shares that
 * space with the rest of the system.
 */
async function captureLiveFrame(camera, cfg, workDir) {
  const tl = cfg.timelapse;
  const ffprobe = path.join(path.dirname(tl.ffmpegPath), 'ffprobe');
  if (!fs.existsSync(tl.ffmpegPath) || !fs.existsSync(ffprobe)) {
    throw new Error(`ffmpeg is not installed at ${tl.ffmpegPath} (sudo apt install -y --no-install-recommends ffmpeg)`);
  }
  const readMemory = tl.readMemory || availableMb;   // the tests stand in for /proc/meminfo
  const floor = tl.minMemoryMb;
  const before = readMemory();
  if (typeof before === 'number' && before < floor + LIVE_MEMORY_NEED_MB) {
    throw new Error(`not started: only ${Math.round(before)} MB of memory available; the live video starts with `
      + `${floor + LIVE_MEMORY_NEED_MB} MB or more (${floor} MB is kept for Pi-hole)`);
  }
  const room = (tl.freeMbAt || freeMb)(workDir);     // the tests stand in for a nearly full folder
  const clipMb = room === null ? CLIP_MAX_MB : Math.min(CLIP_MAX_MB, Math.floor(room - WORK_KEEP_FREE_MB));
  if (clipMb < CLIP_MIN_MB) {
    throw new Error(`not started: only ${Math.round(room)} MB free in ${path.dirname(workDir)} for the recording; `
      + `it starts with ${CLIP_MIN_MB + WORK_KEEP_FREE_MB} MB or more`);
  }
  const halt = new CaptureStop();
  const watch = watchMemory(floor, (mb) => {
    halt.stop(`stopped: the memory available fell to ${Math.round(mb)} MB, below the ${floor} MB kept for Pi-hole`);
  }, readMemory, tl.memoryCheckMs || MEMORY_CHECK_MS);
  try {
    const r = await recordAndPick(camera, tl, workDir, ffprobe, halt, clipMb * 1048576);
    return Object.assign(r, { lowestMemory: watch.lowest });
  } catch (e) {
    // For the log, and for the fallback: the camera was asked for live video,
    // so it needs a moment before it can take a snapshot.
    e.lowestMemory = watch.lowest;
    e.cameraStreamed = true;
    throw e;
  } finally {
    watch.stop();
  }
}

async function recordAndPick(camera, tl, workDir, ffprobe, halt, clipBytes = CLIP_MAX_MB * 1048576) {
  ringNotes.start();
  try {
    return await recordAndPickInner(camera, tl, workDir, ffprobe, halt, clipBytes);
  } finally {
    ringNotes.stop();
  }
}

/** ffmpeg's last words, in its report: its totals ("muxing overhead"), or that a signal stopped it. */
function ffmpegDone(report) {
  try { return /muxing overhead|received signal \d+|Conversion failed/.test(fs.readFileSync(report, 'utf8')); } catch (e) { return false; }
}

/**
 * Waits for the recording ffmpeg to finish its file once the live view is
 * over - then kills it if it has not, so it can never stay behind holding
 * memory. ring-client-api stops it with a SIGTERM, but an ffmpeg that has
 * started recording acts on that only when its next packet arrives, or after
 * 10 s without one (its input's listen_timeout): then it writes the end of its
 * file - with the last keyframe in it - and exits. (A second signal would make
 * it exit at once, but then it cannot write the end of its file.) pids()
 * lists the recording ffmpeg. True if it finished its file.
 */
async function finishFfmpeg(report, pids, waits = {}) {
  if (!fs.existsSync(report)) return false;   // no ffmpeg was started
  const maxMs = waits.maxMs !== undefined ? waits.maxMs : FFMPEG_FINISH_MS;
  for (const until = Date.now() + maxMs; Date.now() < until; await sleep(100)) {
    if (ffmpegDone(report)) return true;
    if (!pids().length) return ffmpegDone(report);   // gone without its last words: killed
  }
  if (ffmpegDone(report)) return true;
  for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
  return false;
}

async function recordAndPickInner(camera, tl, workDir, ffprobe, halt, clipBytes) {
  const clip = path.join(workDir, 'clip.mkv');
  // What the recording ffmpeg says goes to a file (FFREPORT), so a failure can
  // say why: ring-client-api keeps ffmpeg's messages to itself.
  const ffLog = path.join(workDir, 'ffmpeg.log');
  const seen = new SequenceCounter();
  const t0 = Date.now();
  // How the live view went, for the log when it fails.
  const at = { answered: null, first: null, last: null, ended: null };
  const ringSaid = [];
  let canSeeAnswer = false, asks = 0;
  // Stopping early: the camera announces each keyframe's size in its SPS.
  // `at`: when one TIMELAPSE_TARGET_HEIGHT tall was announced (null while
  // waiting for one), `missing`: packets missing by then; `early`: when the
  // live view was ended for it; `best`: the largest announced.
  const target = Number(tl.targetHeight) > 0 ? Number(tl.targetHeight) : 0;
  const goal = { at: null, size: null, missing: 0, early: null, best: null };
  const story = () => {
    const s = (t) => ((t - t0) / 1000).toFixed(1);
    const parts = [
      canSeeAnswer ? (at.answered !== null ? `answered after ${s(at.answered)} s` : 'not answered') : '',
      at.first !== null ? `video ${s(at.first)}-${s(at.last)} s` : 'no video',
      at.ended !== null ? `ended at ${s(at.ended)} s` : '',
      asks ? `${asks} keyframe request${asks === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    if (ringSaid.length) parts.push(`Ring: ${ringSaid.join(', ')}`);
    const errors = ringNotes.lines.filter(l => l.startsWith('error: ')).slice(0, 3);
    if (errors.length) parts.push(`Ring ${errors.join(' / ')}`);
    const ff = ffmpegSummary(ffLog);
    if (ff) parts.push(ff);
    return parts.join('; ');
  };
  const recording = () => { try { return fs.statSync(clip).size > 0; } catch (e) { return false; } };

  const starting = Promise.resolve().then(() => camera.startLiveCall());
  let call;
  try {
    call = await withTimeout(starting, tl.startTimeoutMs || LIVE_START_TIMEOUT_MS, 'starting the live view');
  } catch (e) {
    // ring-client-api retries an unreachable server for ever. If the live view
    // does start after we gave up, end it at once: nobody is recording it, and
    // it would keep the battery camera streaming.
    starting.then((late) => { try { late.stop(); } catch (err) { /* gone */ } }, () => {});
    throw e;
  }
  // Ending the live view ends its ffmpeg too (ring-client-api stops it).
  const endCall = () => { try { call.stop(); } catch (e) { /* already ended */ } };
  halt.kills.add(endCall);
  // The recording ffmpeg is this program's only ffmpeg while it records
  // (ring-client-api starts it; the decoding comes after). Short of memory,
  // it is stopped at once - not left waiting for packets that never come.
  const ffmpegPids = tl.ffmpegPids || (() => strayFfmpeg(process.pid, ffmpegName(tl)));
  const killRecorder = () => ffmpegPids().forEach((pid) => { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } });
  halt.kills.add(killRecorder);
  const subs = [];
  const unsubscribeAll = () => subs.forEach(x => { try { x.unsubscribe(); } catch (e) { /* gone */ } });
  // Ring's side of the call (its signalling messages, when it answered), from
  // ring-client-api's connection object - not a public API, so only if there.
  try {
    const conn = call.connection;
    if (conn && conn.onMessage && typeof conn.onMessage.subscribe === 'function') {
      subs.push(conn.onMessage.subscribe((m) => {
        const method = m && m.method;
        if (!method || method === 'ice' || method === 'pong') return;
        const text = method === 'close' ? `close ${briefly(m.body, 120)}`
          : method === 'notification' ? `notification ${briefly(m.body && m.body.text, 60)}` : method;
        if (ringSaid[ringSaid.length - 1] !== text && ringSaid.length < 12) ringSaid.push(text);
      }));
    }
    if (conn && conn.onCallAnswered && typeof conn.onCallAnswered.subscribe === 'function') {
      canSeeAnswer = true;
      subs.push(conn.onCallAnswered.subscribe(() => { if (at.answered === null) at.answered = Date.now(); }));
    }
  } catch (e) { /* only for the log */ }
  let asker = null, watcher = null, recorderExit = null;
  // Stopping the recording ourselves (early, or at the deadline): ffmpeg is
  // stopped while the video still flows, so it finishes its file at once,
  // and ring-client-api ends the live view when it exits. Ending the live
  // view first would leave ffmpeg waiting 10 s for a packet - see finishFfmpeg.
  const stopRecording = () => {
    if (recorderExit) return;
    const pids = ffmpegPids();
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (e) { /* gone */ } }
    if (pids.length) recorderExit = setTimeout(endCall, tl.recorderExitMs || RECORDER_EXIT_MS);
    else endCall();
  };
  try {
    halt.check();
    const ended = new Promise((r) => call.onCallEnded.subscribe(() => { at.ended = Date.now(); r(); }));
    try {
      subs.push(call.onVideoRtp.subscribe((rtp) => {
        // Never throws: an error here would surface far from any try/catch.
        try {
          const now = Date.now();
          if (at.first === null) at.first = now;
          at.last = now;
          seen.add(rtp && rtp.header && rtp.header.sequenceNumber);
          if (target && rtp && Buffer.isBuffer(rtp.payload)) {
            for (const nal of spsNals(rtp.payload)) {
              const size = spsResolution(nal);
              if (!size) continue;
              if (!goal.best || size.width * size.height > goal.best.width * goal.best.height) goal.best = size;
              if (size.height >= target && goal.at === null) Object.assign(goal, { at: now, size, missing: seen.missing });
            }
          }
        } catch (e) { /* counting and watching are niceties */ }
      }));
    } catch (e) { /* counting is a nicety */ }
    // Ends the recording - and with it the live view - whatever happens.
    const stopper = setTimeout(stopRecording,
      tl.recordSeconds * 1000 + (tl.liveExtraMs || LIVE_EXTRA_MS));
    const report = process.env.FFREPORT;
    process.env.FFREPORT = `file=${ffLog}:level=32`;
    try {
      await call.startTranscoding({
        input: ['-buffer_size', String(SOCKET_BUFFER_BYTES)],
        audio: ['-an'],
        video: ['-vcodec', 'copy'],
        output: ['-t', String(tl.recordSeconds), '-fs', String(clipBytes), '-f', 'matroska', '-y', clip],
      });
      // ffmpeg starts recording only once a keyframe has brought it the
      // stream's description (SPS/PPS). ring-client-api asks the camera for
      // one once; until the recording has started, ask again every 2 s.
      asker = setInterval(() => {
        if (recording()) { clearInterval(asker); return; }
        if (typeof call.requestKeyFrame === 'function') {
          try { call.requestKeyFrame(); asks++; } catch (e) { /* only a request */ }
        }
      }, tl.keyframeAskMs || KEYFRAME_ASK_MS);
      // The early stop: a keyframe of the target height was announced, the
      // recording is running, and no packet has gone missing since - give it
      // TARGET_SETTLE_MS to arrive whole, then stop. A packet lost meanwhile
      // may be part of it: wait for the next one instead.
      if (target) {
        watcher = setInterval(() => {
          if (goal.at === null || goal.early) return;
          if (seen.missing > goal.missing) { goal.at = null; return; }
          if (!recording()) return;
          if (Date.now() - goal.at >= (tl.targetSettleMs || TARGET_SETTLE_MS)) {
            goal.early = { at: (Date.now() - t0) / 1000, size: goal.size };
            clearInterval(watcher);
            stopRecording();
          }
        }, 250);
      }
      await ended;
    } finally {
      clearInterval(asker);
      clearInterval(watcher);
      clearTimeout(recorderExit);
      clearTimeout(stopper);
      if (report === undefined) delete process.env.FFREPORT; else process.env.FFREPORT = report;
    }
  } finally {
    halt.kills.delete(endCall);
    endCall();
    unsubscribeAll();
  }
  const liveSeconds = (Date.now() - t0) / 1000;
  try {
    halt.check();
    // The live view is over: ffmpeg must finish its file (and its report).
    await finishFfmpeg(ffLog, ffmpegPids, tl.ffmpegWaits || {});
    halt.check();
  } finally {
    halt.kills.delete(killRecorder);
  }
  const packets = `${seen.received} video packets arrived, ${seen.missing} missing`;
  if (!recording()) {
    // ffmpeg never started the file: the stream's description (SPS/PPS) did
    // not arrive whole, or the live view ended first - the story says which.
    throw new Error(seen.received
      ? `nothing was recorded (${packets}; ${story()})`
      : `the live view gave no video (${story()})`);
  }
  const pick = await pickKeyframe(tl.ffmpegPath, ffprobe, clip, path.join(workDir, 'frame.jpg'), halt);
  halt.check();
  if (!pick.keys) throw new Error(`the recording has no keyframe (${packets}; ${story()})`);
  if (pick.frame) {
    return { frame: pick.frame, liveSeconds, missing: seen.missing, received: seen.received,
      checked: pick.checked, resolutions: pick.resolutions, target, stoppedEarly: goal.early, largest: goal.best };
  }
  throw new Error(`no clean keyframe (${pick.checked.join(', ')}; ${seen.missing} of ${seen.received + seen.missing} packets missing; `
    + `resolution ${pick.resolutions}; ${story()})`);
}

/** Writes a file into place in one step, readable by the Pi's user for copying off. */
function saveAtomically(source, dest) {
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp`);
  if (Buffer.isBuffer(source)) fs.writeFileSync(tmp, source);
  else fs.copyFileSync(source, tmp);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, dest);
}

/** Free space (MB) on the disk holding `dir`, or null when it cannot be read. */
function freeMb(dir) {
  try {
    const s = fs.statfsSync(dir);
    return (Number(s.bavail) * Number(s.bsize)) / 1048576;
  } catch (e) { return null; }
}

/** "this program 95 MB; the service 160 MB now, 186 MB at most so far, of 200 MB allowed" */
function memoryReport() {
  let text = `this program ${Math.round(process.memoryUsage().rss / 1048576)} MB`;
  try {
    const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(l => l.startsWith('0::'));
    const dir = path.join('/sys/fs/cgroup', line.slice(3).trim());
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch (e) { return null; } };
    const mb = (v) => (v && /^\d+$/.test(v) ? Math.round(Number(v) / 1048576) : null);
    const cur = mb(read('memory.current')), peak = mb(read('memory.peak')), max = mb(read('memory.max'));
    if (cur !== null) {
      text += `; the service ${cur} MB now${peak !== null ? `, ${peak} MB at most so far` : ''}${max !== null ? `, of ${max} MB allowed` : ''}`;
    }
  } catch (e) { /* not on systemd's cgroup v2 */ }
  return text;
}

/**
 * mkdir -p - without fs.mkdirSync's { recursive: true }, which on Node 22
 * never returns for a folder the kernel refuses with ENOENT (anything under
 * /proc, say): a mistyped TIMELAPSE_DIR or TIMELAPSE_WORK_DIR would hang the
 * whole service, dock photos and all.
 */
function makeDir(dir, mode = 0o755) {
  const missing = [];
  for (let d = path.resolve(String(dir)); !fs.existsSync(d); d = path.dirname(d)) {
    missing.unshift(d);
    if (path.dirname(d) === d) break;
  }
  for (const d of missing) {
    try { fs.mkdirSync(d, { mode }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

/** Whether `dir` is in memory (tmpfs or ramfs); null when that cannot be told. */
function inMemory(dir) {
  try {
    const type = Number(fs.statfsSync(dir).type);
    return type === 0x01021994 || type === 0x858458f6;
  } catch (e) { return null; }
}

/**
 * Where recordings are made: TIMELAPSE_WORK_DIR when it can be used - best in
 * memory, /run/nhrc-camera (systemd's RuntimeDirectory=), so the SD card is
 * not written with every capture - else the system's temp folder.
 * { dir, inMemory, note }: note says why the setting could not be used.
 */
function resolveWorkRoot(tl) {
  const fallback = os.tmpdir();
  if (tl.workDir) {
    try {
      makeDir(tl.workDir, 0o700);
      fs.accessSync(tl.workDir, fs.constants.W_OK);
      return { dir: tl.workDir, inMemory: inMemory(tl.workDir), note: '' };
    } catch (e) {
      return { dir: fallback, inMemory: inMemory(fallback),
        note: `TIMELAPSE_WORK_DIR ${tl.workDir} cannot be used (${e.code || e.message})` };
    }
  }
  return { dir: fallback, inMemory: inMemory(fallback), note: '' };
}

/** "/run/nhrc-camera - in memory", for --check, which creates nothing. */
function describeWorkRoot(tl) {
  const dir = tl.workDir || os.tmpdir();
  if (!fs.existsSync(dir)) {
    return `${dir} - not there yet${dir.startsWith('/run/') ? ' (systemd makes it when the service starts: RuntimeDirectory=)' : ''}`;
  }
  const mem = inMemory(dir);
  return `${dir} - ${mem === true ? 'in memory' : mem === false ? 'on the SD card' : 'kind of storage unknown'}`;
}

/**
 * Removes recordings left behind by a capture the service did not live to
 * clean up. Only at start, when no capture can be running. Returns how many.
 */
function sweepWorkRoot(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith('nhrc-timelapse-')) continue;
    try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); removed++; } catch (e) { /* not ours */ }
  }
  return removed;
}

/**
 * The ffmpeg processes this program started that are still running (pids), by
 * the name they run under (FFMPEG_PATH's, as the kernel keeps it: 15
 * characters at most). Linux; [] elsewhere.
 */
function strayFfmpeg(parent = process.pid, name = 'ffmpeg') {
  let names;
  try { names = fs.readdirSync('/proc'); } catch (e) { return []; }
  const pids = [];
  for (const d of names) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
      if (st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')) === name && rest[0] !== 'Z' && Number(rest[1]) === parent) {
        pids.push(Number(d));
      }
    } catch (e) { /* gone */ }
  }
  return pids;
}

/** The name ffmpeg runs under: FFMPEG_PATH's last part. */
const ffmpegName = (tl) => path.basename(String((tl && tl.ffmpegPath) || 'ffmpeg')).slice(0, 15);

/** Files and sockets this program has open, or null where that cannot be read. */
function openFileCount() {
  try { return fs.readdirSync('/proc/self/fd').length - 1; } catch (e) { return null; }   // less the one reading
}

/**
 * The battery level a camera last reported to Ring: from its health report,
 * fetched fresh - or, when that has no number (Ring's own types allow a word
 * there), from the camera list, fetched fresh (`listDevices`: the list loaded
 * at start is never refreshed, as status polling is off). { level: 0-100 or
 * null, signal: Wi-Fi dBm or null, why: why there is no level }.
 */
async function readBattery(camera, timeoutMs = BATTERY_READ_TIMEOUT_MS, listDevices = null) {
  // Ring sends numbers, or numbers as text ("85"), or words ("NA").
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
  const percent = (v) => { const n = num(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : null; };
  let signal = null, why;
  if (camera && typeof camera.getHealth === 'function') {
    try {
      const h = await withTimeout(Promise.resolve().then(() => camera.getHealth()), timeoutMs, 'reading the battery');
      const sig = num(h && h.latest_signal_strength);
      if (Number.isFinite(sig)) signal = sig;
      const level = percent(h && h.battery_percentage);
      if (level !== null) return { level, signal, why: '' };
      why = h && h.battery_percentage !== undefined ? `Ring gave "${briefly(h.battery_percentage, 30)}"` : 'Ring gave no battery level';
    } catch (e) {
      why = briefly(e, 120);
    }
  } else {
    why = 'this camera gives no health report';
  }
  if (camera && camera.id !== undefined && typeof listDevices === 'function') {
    try {
      const list = await withTimeout(Promise.resolve().then(listDevices), timeoutMs, 'listing the cameras');
      const d = ((list && list.allCameras) || []).find((c) => c && c.id === camera.id);
      if (d) {
        // Its health first; else the lower of its batteries (some cameras take two).
        const fromHealth = percent(d.health && d.health.battery_percentage);
        const lives = [d.battery_life, d.battery_life_2].map(percent).filter((x) => x !== null);
        const level = fromHealth !== null ? fromHealth : lives.length ? Math.min(...lives) : null;
        if (level !== null) return { level, signal, why: '' };
        why += '; nor did the camera list';
      } else {
        why += '; the camera is not in the camera list';
      }
    } catch (e) {
      why += `; the camera list: ${briefly(e, 80)}`;
    }
  }
  return { level: null, signal, why };
}

/**
 * The timelapse. Set times (TIMELAPSE_TIMES): maybeCapture() after every dock
 * slot. Every few minutes (TIMELAPSE_EVERY_MINUTES): intervalTick(), on its
 * own clock. captureNow() for a test (SIGUSR2). One capture at a time; every
 * outcome is logged, nothing thrown.
 * deps: camera() -> the camera or null, now(); for the every-few-minutes
 * timetable also setTimer(fn, ms), dockBusy(), backupInUse() and exit(code);
 * workRoot (resolveWorkRoot); for the tests exists(file), liveFrame(camera,
 * workDir), rssBytes(), openFiles(), strays() and shorter waits.
 */
function createTimelapse(cfg, deps) {
  const tl = cfg.timelapse;
  const exists = deps.exists || fs.existsSync;
  const liveFrame = deps.liveFrame || ((camera, workDir) => captureLiveFrame(camera, cfg, workDir));
  const work = deps.workRoot || { dir: os.tmpdir() };
  const strays = deps.strays || (() => strayFfmpeg(process.pid, ffmpegName(tl)));
  const tried = new Set();
  let today = null, busy = false;

  // The times tried today are also noted on disk, BEFORE each capture starts:
  // if a capture ever brought the service down (killed for memory, say), the
  // restarted service does not try it again - so it cannot loop, waking the
  // battery camera and loading the Pi every minute or so.
  const record = path.join(tl.dir, '.tried');
  const triedOnDisk = (date) => {
    try {
      return fs.readFileSync(record, 'utf8').split('\n').map(s => s.trim()).filter(s => s.startsWith(`${date} `));
    } catch (e) { return []; }
  };
  const noteTried = () => {
    try {
      makeDir(tl.dir);
      saveAtomically(Buffer.from([...tried].join('\n') + '\n'), record);
    } catch (e) {
      logError(`Timelapse: could not note the attempt in ${record} (${e.message}).`);
    }
  };

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  const afterLiveMs = deps.afterLiveMs !== undefined ? deps.afterLiveMs
    : (Number.isFinite(tl.snapshotPauseSeconds) ? tl.snapshotPauseSeconds : 20) * 1000;
  const retryMs = deps.snapshotRetryMs !== undefined ? deps.snapshotRetryMs : SNAPSHOT_RETRY_MS;

  async function attempt(camera, workDir, dir, base, fallback) {
    let live;
    try {
      const r = await liveFrame(camera, workDir);
      const dest = path.join(dir, `${base}.jpg`);
      saveAtomically(r.frame, dest);
      return Object.assign({ kind: 'live', dest }, r);
    } catch (e) {
      live = e;
    }
    if (!fallback) {
      // Every few minutes, a failed frame is simply missed: the next is minutes
      // away, and a snapshot would keep the battery camera busy for longer.
      const err = new Error(`live video failed (${live.message}); no frame this time`);
      err.lowestMemory = live.lowestMemory;
      throw err;
    }
    // The 640x360 snapshot instead. A battery camera cannot take one while it
    // is still streaming: if it was asked for live video, give it a moment,
    // and a second chance.
    if (live.cameraStreamed) await pause(afterLiveMs);
    let snap = null, snapError = null;
    for (let i = 0; i < SNAPSHOT_TRIES && !snap; i++) {
      if (i) await pause(retryMs);
      try {
        snap = await withTimeout(Promise.resolve().then(() => camera.getSnapshot()), 30 * 1000, 'the snapshot');
        if (!snap || !snap.length) { snap = null; snapError = new Error('the snapshot was empty'); }
      } catch (e) {
        snapError = e;
      }
    }
    if (!snap) {
      const err = new Error(`live video failed (${live.message}); the snapshot failed too, `
        + `${SNAPSHOT_TRIES} tries (${snapError.message})`);
      err.lowestMemory = live.lowestMemory;
      throw err;
    }
    const dest = path.join(dir, `${base}_snapshot.jpg`);
    saveAtomically(snap, dest);
    return { kind: 'snapshot', dest, liveError: live.message, lowestMemory: live.lowestMemory };
  }

  /** "; the Pi had at least 120 MB available throughout", when the memory was watched. */
  const lowestNote = (x) => (x && typeof x.lowestMemory === 'number'
    ? `; the Pi had at least ${Math.round(x.lowestMemory)} MB available throughout` : '');

  /**
   * One capture, saved as dir/base.jpg. opts.fallback (default true): the
   * snapshot if the live video fails; opts.battery: the level, for the log.
   * The result, { kind: 'failed' } when it failed, null when it was skipped.
   */
  async function captureOne(label, dir, base, opts = {}) {
    if (busy) { log(`${label}: a timelapse capture is already running; skipped.`); return null; }
    const camera = deps.camera();
    if (!camera) {
      logError(`${label}: no camera "${tl.cameraName}" on the account; skipped.`);
      return null;
    }
    busy = true;
    let workDir = null;
    let inner = null;
    try {
      makeDir(dir);
      const free = freeMb(dir);
      if (free !== null && free < tl.minDiskMb) {
        logError(`${label}: only ${Math.round(free)} MB free on the SD card (it keeps ${tl.minDiskMb} MB free); nothing saved.`);
        return null;
      }
      makeDir(work.dir, 0o700);
      workDir = fs.mkdtempSync(path.join(work.dir, 'nhrc-timelapse-'));
      const t0 = Date.now();
      inner = attempt(camera, workDir, dir, base, opts.fallback !== false);
      const r = await withTimeout(inner, deps.captureTimeoutMs || CAPTURE_TIMEOUT_MS, 'the capture');
      const buf = fs.readFileSync(r.dest);
      const size = jpegSize(buf);
      const what = `${size ? `${size.width}x${size.height}` : 'size unknown'}, ${Math.round(buf.length / 1024)} KB`;
      if (r.kind === 'live') {
        const early = r.stoppedEarly
          ? `stopped once ${r.stoppedEarly.size.width}x${r.stoppedEarly.size.height} had arrived; `
          : r.target ? `${r.target} lines not reached${r.largest ? ` (${r.largest.width}x${r.largest.height} at most)` : ''}; ` : '';
        const battery = typeof opts.battery === 'number' ? ` Battery ${opts.battery}%.` : '';
        log(`${label}: saved ${path.basename(r.dest)} - ${what}, from live video (${r.liveSeconds.toFixed(0)} s; ${early}`
          + `${r.missing} of ${r.received + r.missing} packets missing; `
          + `${r.resolutions ? `resolution ${r.resolutions}; ` : ''}keyframes checked: ${r.checked.join(', ')}); `
          + `took ${((Date.now() - t0) / 1000).toFixed(0)} s.${battery} Memory: ${memoryReport()}${lowestNote(r)}.`);
      } else {
        logError(`${label}: live video failed (${r.liveError}); saved the snapshot instead: ${path.basename(r.dest)} - ${what}. `
          + `Memory: ${memoryReport()}${lowestNote(r)}.`);
      }
      return r;
    } catch (e) {
      logError(`${label}: ${e.message}. Memory: ${memoryReport()}${lowestNote(e)}.`);
      return { kind: 'failed', error: e.message };
    } finally {
      const cleanUp = () => {
        if (workDir) {
          try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* gone */ }
          // An ffmpeg still running now is one the end of the live view did
          // not stop: it must never be left holding memory Pi-hole needs.
          const left = strays();
          if (left.length) {
            for (const pid of left) { try { process.kill(pid, 'SIGKILL'); } catch (e) { /* gone */ } }
            logError(`${label}: ${left.length} ffmpeg still running after the capture; stopped.`);
          }
        }
        busy = false;
      };
      // If the overall deadline fired, the work is still winding down: free
      // the slot only when it has, so two captures can never overlap.
      if (inner) inner.then(cleanUp, cleanUp); else cleanUp();
    }
  }

  async function maybeCapture() {
    const now = deps.now();
    const { date } = localDateParts(now, cfg);
    if (date !== today) {
      tried.clear();
      today = date;
      for (const k of triedOnDisk(date)) tried.add(k);
      for (const job of timelapseDue(now, cfg, exists, new Set())) {
        if (tried.has(`${job.date} ${job.time.label}`)) {
          log(`Timelapse ${job.date} ${job.time.label}: already tried before the service restarted; `
            + 'not tried again today.');
        }
      }
    }
    for (const job of timelapseDue(now, cfg, exists, tried)) {
      tried.add(`${job.date} ${job.time.label}`);
      noteTried();
      await captureOne(`Timelapse ${job.date} ${job.time.label}`, tl.dir,
        `${job.date}_${job.time.label.replace(':', '')}`);
    }
  }

  async function captureNow() {
    const p = localDateParts(deps.now(), cfg);
    return captureOne('Timelapse test', path.join(tl.dir, 'tests'), `${p.date}_${p.hhmmss}`);
  }

  // ── Every few minutes, from sunrise to sunset ──
  //
  // What happens is noted on disk as it happens (TIMELAPSE_DIR/.interval-log):
  // "<date> <time> start" before each capture, "done" after it, "stopped" if
  // the service is stopped during one, "restart" when the service restarts
  // itself to start afresh. A "start" with no "done" is a capture that
  // brought the service down: after two of those (restarts included) in a
  // day, the timelapse stops until the next day - never a restart loop.
  const ivRecord = path.join(tl.dir, '.interval-log');
  const iv = {
    day: null, started: new Set(), unfinished: 0, restarts: 0, handled: null, pause: null,
    failures: 0, restUntil: 0, counts: null, summarized: null, current: null, over: 0,
    battery: { level: null, signal: null, paused: false, unknownNoted: false },
    recordError: false, noMoreRestarts: false,
  };
  const newCounts = () => ({ failed: 0, paused: 0, missed: 0 });
  const hhmmAt = (ms) => hhmm(localDateParts(new Date(ms), cfg).minutes);

  const note = (line) => {
    try {
      makeDir(tl.dir);
      fs.appendFileSync(ivRecord, `${line}\n`, { mode: 0o644 });
    } catch (e) {
      if (!iv.recordError) {
        logError(`Timelapse: could not note "${line}" in ${ivRecord} (${e.message}); `
          + 'a capture that brought the service down cannot be told from one that finished.');
      }
      iv.recordError = true;
    }
  };

  /** A new day: today's notes from disk (the note keeps today only), and yesterday's summary. */
  function enterDay(date) {
    if (iv.day === date) return;
    if (iv.day !== null && iv.summarized !== iv.day) summarize(iv.day);
    Object.assign(iv, { day: date, started: new Set(), counts: newCounts(), failures: 0, restUntil: 0, noMoreRestarts: false });
    let lines = [];
    try {
      lines = fs.readFileSync(ivRecord, 'utf8').split('\n').map((s) => s.trim()).filter((s) => s.startsWith(`${date} `));
    } catch (e) { /* nothing noted yet */ }
    try {
      if (fs.existsSync(ivRecord)) saveAtomically(Buffer.from(lines.map((l) => `${l}\n`).join('')), ivRecord);
    } catch (e) { /* said when it is next written */ }
    const last = new Map();
    let restarts = 0;
    for (const l of lines) {
      const [, time, what] = l.split(' ');
      if (what === 'restart') { restarts++; continue; }
      if (what === 'start') iv.started.add(time);
      if (what) last.set(time, what);
    }
    const unfinished = [...last].filter(([, what]) => what === 'start').map(([time]) => time);
    iv.restarts = restarts;
    iv.unfinished = unfinished.length + restarts;
    if (unfinished.length) {
      logError(`Timelapse ${date}: the capture${unfinished.length === 1 ? '' : 's'} at ${unfinished.join(', ')} never finished `
        + `(the service stopped during ${unfinished.length === 1 ? 'it' : 'them'}).`);
    }
  }

  /** The day in one line: frames saved (from disk, by size), failed, paused, the battery, memory. */
  function summarize(date) {
    iv.summarized = date;
    const dayDir = path.join(tl.dir, date);
    let files = [];
    try { files = fs.readdirSync(dayDir).filter((f) => /^\d{4}-\d\d-\d\d_\d{4}\.jpg$/.test(f)); } catch (e) { /* none */ }
    const bySize = new Map();
    for (const f of files) {
      let size = null;
      try {
        const fd = fs.openSync(path.join(dayDir, f), 'r');
        try {
          const buf = Buffer.alloc(16384);   // the size is near the start of the file
          size = jpegSize(buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0)));
        } finally { fs.closeSync(fd); }
      } catch (e) { /* unreadable */ }
      const key = size ? `${size.width}x${size.height}` : 'size unknown';
      bySize.set(key, (bySize.get(key) || 0) + 1);
    }
    const px = (k) => { const m = /^(\d+)x(\d+)$/.exec(k); return m ? m[1] * m[2] : 0; };
    const sizes = [...bySize].sort((a, b) => px(b[0]) - px(a[0])).map(([k, n]) => `${n} at ${k}`).join(', ');
    const c = iv.day === date && iv.counts ? iv.counts : newCounts();
    const parts = [`${files.length} frame${files.length === 1 ? '' : 's'} saved${sizes ? ` (${sizes})` : ''}`];
    if (c.failed) parts.push(`${c.failed} failed`);
    if (c.paused) parts.push(`${c.paused} paused`);
    if (c.missed) parts.push(`${c.missed} missed`);
    const b = iv.battery;
    if (b.level !== null) {
      parts.push(`battery ${b.level}%${b.signal !== null ? `, Wi-Fi signal ${b.signal} dBm` : ''} at the last reading`);
    }
    const open = deps.openFiles ? deps.openFiles() : openFileCount();
    parts.push(`memory: ${memoryReport()}${open !== null ? `; ${open} files open` : ''}`);
    log(`Timelapse ${date}: ${parts.join('; ')}.`);
  }

  /** Battery: paused under TIMELAPSE_MIN_BATTERY, until BATTERY_RESUME_POINTS above it. */
  async function batteryReason(camera) {
    const min = Number(tl.minBattery) || 0;
    if (min <= 0) return null;
    const b = iv.battery;
    const r = await readBattery(camera, deps.batteryTimeoutMs || BATTERY_READ_TIMEOUT_MS, deps.listDevices);
    if (r.level === null) {
      // Kept as it was: paused stays paused, running keeps running.
      if (!b.unknownNoted) {
        log(`Timelapse: the battery level of "${camera.name}" could not be read (${r.why}); `
          + `${b.paused ? 'still paused' : 'carrying on'} until it can be.`);
        b.unknownNoted = true;
      }
    } else {
      b.unknownNoted = false;
      b.level = r.level;
      b.signal = r.signal;
      if (b.paused && r.level >= min + BATTERY_RESUME_POINTS) b.paused = false;
      else if (!b.paused && r.level < min) b.paused = true;
    }
    return b.paused ? { key: 'battery', text: `"${camera.name}" battery at ${b.level}%: paused under ${min}%, until it is back to `
      + `${min + BATTERY_RESUME_POINTS}%, so the camera keeps its charge for the website's backup` } : null;
  }

  /** Why no frame should be taken now, cheapest checks first: { key, text, problem } or null. */
  async function pauseReason() {
    if (iv.unfinished >= UNFINISHED_BEFORE_STOP) {
      return { key: 'stopped', problem: true, text: `stopped for today: ${iv.unfinished} captures today never finished or `
        + 'ended in a restart (see above); it starts again tomorrow' };
    }
    if (deps.now().getTime() < iv.restUntil) {
      return { key: 'rest', text: `resting until ${hhmmAt(iv.restUntil)} after ${FAILURES_BEFORE_REST} failed live views in a row` };
    }
    const camera = deps.camera();
    if (!camera) return { key: 'camera', problem: true, text: `no camera "${tl.cameraName}" on the account` };
    if (!exists(tl.ffmpegPath) || !exists(path.join(path.dirname(tl.ffmpegPath), 'ffprobe'))) {
      return { key: 'ffmpeg', problem: true,
        text: `ffmpeg is not installed at ${tl.ffmpegPath} (sudo apt install -y --no-install-recommends ffmpeg)` };
    }
    if (deps.backupInUse && deps.backupInUse()) {
      return { key: 'backup', text: `the website is using "${camera.name}" as its backup camera, until the dock camera answers again` };
    }
    const free = freeMb(fs.existsSync(tl.dir) ? tl.dir : path.dirname(tl.dir));
    if (free !== null && free < tl.minDiskMb) {
      return { key: 'disk', problem: true,
        text: `only ${Math.round(free)} MB free on the SD card (it keeps ${tl.minDiskMb} MB free): copy the frames off and delete them` };
    }
    return batteryReason(camera);
  }

  async function intervalCapture(slot) {
    const label = `Timelapse ${slot.date} ${slot.label}`;
    // A frame due with a dock photo waits for it: the website's photo first.
    const waitUntil = Date.now() + (deps.dockWaitMs !== undefined ? deps.dockWaitMs : DOCK_WAIT_MS);
    while (deps.dockBusy && deps.dockBusy() && Date.now() < waitUntil) await pause(deps.dockPollMs || DOCK_POLL_MS);
    if (busy) { log(`${label}: skipped - another capture is still running.`); iv.counts.missed++; return; }
    const reason = await pauseReason();
    if ((reason && reason.key) !== (iv.pause && iv.pause.key)) {
      if (reason) (reason.problem ? logError : log)(`Timelapse paused: ${reason.text}.`);
      else log(`Timelapse resumed at ${slot.label}.`);
    }
    iv.pause = reason;
    if (reason) { iv.counts.paused++; return; }
    iv.started.add(slot.label);
    note(`${slot.date} ${slot.label} start`);
    iv.current = slot;
    let r = null;
    try {
      r = await captureOne(label, path.join(tl.dir, slot.date), `${slot.date}_${slot.label.replace(':', '')}`,
        { fallback: false, battery: iv.battery.level });
    } finally {
      iv.current = null;
      note(`${slot.date} ${slot.label} done`);
    }
    if (r && r.kind === 'live') { iv.failures = 0; return; }
    if (!r) { iv.counts.missed++; return; }
    iv.counts.failed++;
    if (++iv.failures >= FAILURES_BEFORE_REST) {
      iv.failures = 0;
      iv.restUntil = deps.now().getTime() + REST_MS;
      logError(`Timelapse: ${FAILURES_BEFORE_REST} live views in a row failed; resting until ${hhmmAt(iv.restUntil)}.`);
    }
  }

  /**
   * After every slot: if this program has grown past TIMELAPSE_MAX_RSS_MB, or
   * holds more than MAX_OPEN_FILES files and sockets, at two checks in a row,
   * it restarts (deps.exit) - never during a capture or a dock photo, and at
   * most twice a day.
   */
  function healthCheck() {
    if (!deps.exit || busy) return;
    const rssMb = (deps.rssBytes ? deps.rssBytes() : process.memoryUsage().rss) / 1048576;
    const files = deps.openFiles ? deps.openFiles() : openFileCount();
    const over = [];
    if (rssMb > tl.maxRssMb) over.push(`this program uses ${Math.round(rssMb)} MB of memory (TIMELAPSE_MAX_RSS_MB is ${tl.maxRssMb})`);
    if (files !== null && files > MAX_OPEN_FILES) over.push(`it has ${files} files and connections open (at most ${MAX_OPEN_FILES} are expected)`);
    if (!over.length) { iv.over = 0; return; }
    if (++iv.over < 2) return;
    if (deps.dockBusy && deps.dockBusy()) return;
    if (iv.restarts >= UNFINISHED_BEFORE_STOP) {
      if (!iv.noMoreRestarts) {
        logError(`Timelapse: ${over.join('; ')} - but the service has restarted itself ${iv.restarts} times today already: `
          + 'the timelapse stays stopped until tomorrow, and the service carries on.');
      }
      iv.noMoreRestarts = true;
      return;
    }
    const p = localDateParts(deps.now(), cfg);
    note(`${p.date} ${hhmm(p.minutes)} restart`);
    logError(`Timelapse: ${over.join('; ')} - restarting the service to start afresh (systemd starts it again a minute later).`);
    deps.exit(75);
  }

  /** Once a slot: a frame if one is due, the day's summary after its last slot; then sleep until the next. */
  async function intervalTick() {
    try {
      const slot = intervalSlot(deps.now(), cfg);
      enterDay(slot.date);
      if (slot.start !== iv.handled) {
        iv.handled = slot.start;
        if (slot.inWindow && !iv.started.has(slot.label)) await intervalCapture(slot);
        else if (!slot.inWindow && slot.window && slot.minutes > slot.window.until && iv.summarized !== slot.date) summarize(slot.date);
      }
    } catch (e) {
      logError(`Timelapse: ${e.message}`);
    }
    try { healthCheck(); } catch (e) { logError(`Timelapse: ${e.message}`); }
    let ms = 60 * 1000;
    try {
      const now = deps.now();
      const cur = intervalSlot(now, cfg);
      // A capture that ran into the next slot: that one is taken at once -
      // late rather than not at all.
      ms = cur.start !== iv.handled && cur.inWindow && !iv.started.has(cur.label) ? 0
        : cur.end - now.getTime() + (deps.wakeDelayMs !== undefined ? deps.wakeDelayMs : INTERVAL_WAKE_MS);
    } catch (e) {
      logError(`Timelapse: ${e.message}`);
    }
    deps.setTimer(intervalTick, Math.max(0, ms));
  }

  /** The service is being stopped (SIGTERM): a capture under way did not bring it down. */
  function noteStopping() {
    if (iv.current) note(`${iv.current.date} ${iv.current.label} stopped`);
  }

  return { maybeCapture, captureNow, busy: () => busy, intervalTick, noteStopping, state: () => iv };
}

/** The timelapse in one line, for --check and the startup log. */
function describeTimelapse(cfg = CONFIG, now = new Date()) {
  const tl = cfg.timelapse;
  const video = Number(tl.targetHeight) > 0
    ? `the sharpest frame of up to ${tl.recordSeconds} s of live video, stopping once a ${tl.targetHeight}-line keyframe has arrived`
    : `the sharpest frame of ${tl.recordSeconds} s of live video`;
  const keeps = `keeps ${tl.minMemoryMb} MB of memory for Pi-hole and ${tl.minDiskMb} MB of disk free`;
  if (intervalOn(cfg)) {
    const every = Number(tl.everyMinutes);
    const w = daylightMinutes(localDateParts(now, cfg).date, cfg);
    const edge = (v) => { const e = parseWindowEdge(v); return e ? (e.sun || hhmm(e.minutes)) : String(v); };
    const count = w ? Math.max(0, Math.floor(w.until / every) - Math.ceil(w.from / every) + 1) : 0;
    const battery = Number(tl.minBattery) > 0 ? `paused under ${tl.minBattery}% battery` : 'no battery check';
    return `"${tl.cameraName}" every ${every} min from ${edge(tl.from)} to ${edge(tl.until)} `
      + `(${w ? `today ${hhmm(w.from)}-${hhmm(w.until)}, ${count} frames` : 'none today'}) -> ${path.join(tl.dir, 'YYYY-MM-DD')}/ `
      + `(${video}; a frame that fails is skipped; ${battery}; ${keeps})`;
  }
  return `"${tl.cameraName}" at ${tl.times.map(t => t.label).join(', ')} -> ${tl.dir} `
    + `(${video}; the snapshot if that fails; ${keeps})`;
}

/** Two camera objects for the same Ring camera (the service lists the cameras twice). */
function sameCamera(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
  return !!a.name && a.name === b.name;
}

async function main() {
  const args = process.argv.slice(2);

  // The timelapse test (SIGUSR2) is listened for from the very first moment,
  // because a signal nobody listens for ends the program. On the Pi in
  // October 2026 one sent 12 s after a restart - while the Pi Zero was still
  // signing in to Ring, before the timelapse existed - stopped the service.
  let timelapse = null, timelapseOff = '';
  process.on('SIGUSR2', () => {
    if (timelapse) {
      // A test capture inside the running service - so under the same systemd
      // limits as the scheduled ones. Saved under tests/.
      log('Timelapse test requested.');
      timelapse.captureNow().catch((e) => logError('Timelapse test failed:', e.message));
    } else if (timelapseOff) {
      log(`Timelapse test requested, but the timelapse is off (${timelapseOff}).`);
    } else if (!timelapseOn(CONFIG)) {
      log('Timelapse test requested, but the timelapse is off (neither TIMELAPSE_EVERY_MINUTES nor TIMELAPSE_TIMES is set).');
    } else {
      log('Timelapse test requested while the service is still starting; '
        + 'send it again once the journal says "Test it now".');
    }
  });

  const problems = serviceProblems();
  if (problems.length) {
    logError('Configuration problems:');
    problems.forEach(p => console.error('  - ' + p));
    console.error('\nSee camera/README.md for setup.');
    process.exit(1);
  }
  // A mistake in the timelapse settings never stops the dock photos - the
  // website matters more: the service runs without the timelapse, and says so.
  const tlProblems = timelapseProblems();
  if (tlProblems.length) {
    logError('Timelapse settings problems - the timelapse is OFF until they are fixed (the dock photos are not affected):');
    tlProblems.forEach(p => console.error('  - ' + p));
  }
  const backupCfg = backupConfig(CONFIG);
  if (args.includes('--check')) {
    log(tlProblems.length ? 'The dock photos\' configuration is valid; the timelapse\'s is not (see above).'
      : 'Configuration looks valid.');
    log(`  primary      : ${CONFIG.cameraName ? `"${CONFIG.cameraName}"` : '(the only camera on the account)'} — `
      + describeTimetable(CONFIG));
    log(`  backup       : ${CONFIG.backupCameraName
      ? `"${CONFIG.backupCameraName}" — only after ${CONFIG.backup.afterMisses} missed primary captures in a row; `
        + `then ${describeTimetable(backupCfg)}`
      : 'none'}`);
    log(`  token file   : ${CONFIG.tokenFile} (${readToken() ? 'present' : 'MISSING'})`);
    log(`  upload to    : ${CONFIG.uploadUrl}`);
    log(`  timelapse    : ${tlProblems.length ? 'OFF - its settings have problems (above)' : timelapseOn(CONFIG)
      ? `${describeTimelapse(CONFIG)}; ffmpeg ${fs.existsSync(CONFIG.timelapse.ffmpegPath) ? 'found' : 'MISSING'}`
      : 'off'}`);
    if (!tlProblems.length && timelapseOn(CONFIG)) log(`  recordings   : ${describeWorkRoot(CONFIG.timelapse)}`);
    if (tlProblems.length) process.exitCode = 1;
    return;
  }
  if (tlProblems.length) {
    timelapseOff = 'its settings have problems: see the journal from the service\'s start';
    CONFIG.timelapse.times = [];
    CONFIG.timelapse.everyMinutes = 0;
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

  // The timelapse, if configured. A problem with it is logged and never stops
  // the dock photos.
  let tick = null;
  if (timelapseOn(CONFIG)) {
    let camera = null;
    try {
      camera = findCamera(await api.getCameras(), CONFIG.timelapse.cameraName);
    } catch (e) {
      logError(`Timelapse: ${e.message}`);
    }
    if (!camera) {
      logError(`Timelapse: no camera matching "${CONFIG.timelapse.cameraName}" - no timelapse frames until this is fixed.`);
    }
    if (!fs.existsSync(CONFIG.timelapse.ffmpegPath)) {
      logError(`Timelapse: ffmpeg is not installed at ${CONFIG.timelapse.ffmpegPath} - `
        + `${intervalOn(CONFIG) ? 'no frames' : 'frames will be 640x360 snapshots'} until it is `
        + '(sudo apt install -y --no-install-recommends ffmpeg).');
    }
    const work = resolveWorkRoot(CONFIG.timelapse);
    if (work.note) logError(`Timelapse: ${work.note}; recording in ${work.dir} instead.`);
    const swept = sweepWorkRoot(work.dir);
    if (swept) log(`Timelapse: removed ${swept} recording${swept === 1 ? '' : 's'} left behind by an earlier run.`);
    const filmsBackup = sameCamera(camera, backup);
    timelapse = createTimelapse(CONFIG, {
      camera: () => camera,
      now: () => new Date(),
      workRoot: work,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      // The every-few-minutes timetable waits for the dock photos, and pauses
      // while the website needs this camera as its backup.
      dockBusy: () => !!(tick && tick.busy()),
      backupInUse: () => !!(filmsBackup && tick && tick.onBackup()),
      exit: (code) => process.exit(code),
      // For the battery level, when the camera's health report has none.
      listDevices: () => api.fetchRingDevices(),
    });
    log(`Timelapse: ${describeTimelapse(CONFIG)}; recorded in ${work.dir}`
      + `${work.inMemory === true ? ' (in memory)' : work.inMemory === false ? ' (on the SD card)' : ''}. `
      + `Test it now with: sudo kill -USR2 ${process.pid}`);
    if (intervalOn(CONFIG)) {
      // Stopped (systemctl stop/restart) during a capture: noted, so the
      // capture is not taken for one that brought the service down. Then the
      // signal does what it always did.
      for (const sig of ['SIGTERM', 'SIGINT']) {
        const onStop = () => {
          process.removeListener(sig, onStop);
          try { timelapse.noteStopping(); } catch (e) { /* best effort */ }
          process.kill(process.pid, sig);
        };
        process.on(sig, onStop);
      }
    }
  }

  // setTimeout that reschedules itself, not setInterval: the next wake-up is
  // the next slot boundary, recomputed from the clock every time. A slow cycle
  // can never make captures pile up, and can never shift the timetable.
  tick = createScheduler(CONFIG, {
    now: () => new Date(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    hasPrimary: !!primary,
    hasBackup: !!backup,
    cycle: (role) => role === 'backup'
      ? runCycle(backup, backupCfg, new Date(), globalThis.fetch, 'backup')
      : runCycle(primary, CONFIG, new Date(), globalThis.fetch, 'primary'),
    afterSlot: timelapse && !intervalOn(CONFIG) ? () => timelapse.maybeCapture() : undefined,
  });
  await tick();
  // The every-few-minutes timelapse runs on its own clock from here, after
  // the first dock photo.
  if (timelapse && intervalOn(CONFIG)) {
    timelapse.intervalTick().catch((e) => logError(`Timelapse: ${e.message}`));
  }
}

module.exports = {
  CONFIG, validateConfig, serviceProblems, timelapseProblems, isWithinActiveHours,
  readToken, writeToken, uploadSnapshot, captureWithRetry, runCycle,
  describeCause, hostOf, parseHourSetting, formatHourSetting,
  intervalForTime, localHour, describeSchedule,
  localSeconds, windowGeometry, captureSlot, secondsUntilNextSlot, createScheduler,
  MAX_SLEEP_SECONDS,
  findCamera, pickCameras, pickCamera, backupConfig, scheduleProblems, headerSafe, describeWindow,
  describeTimetable,
  // Timelapse
  parseTimeList, timelapseOn, intervalOn, localDateParts, timelapseFile, timelapseDue, withTimeout, runTool, keyframeInfo,
  keyframeOrder, resolutionTimeline, pickKeyframe,
  decodeKeyframe, SequenceCounter, jpegSize, captureLiveFrame, saveAtomically, freeMb, memoryReport,
  createTimelapse, describeTimelapse, availableMb, watchMemory, CaptureStop, ffmpegSummary, redact, briefly, ringNotes,
  parseWindowEdge, sunTimes, daylightMinutes, intervalSlot, spsNals, spsResolution, finishFfmpeg, ffmpegDone,
  inMemory, resolveWorkRoot, describeWorkRoot, sweepWorkRoot, strayFfmpeg, openFileCount, readBattery, sameCamera, makeDir,
  TIMELAPSE_WINDOW_MINUTES, CAPTURE_TIMEOUT_MS, MAX_KEYFRAMES_TRIED, LIVE_MEMORY_NEED_MB,
  TARGET_SETTLE_MS, CLIP_MAX_MB, CLIP_MIN_MB, WORK_KEEP_FREE_MB, FAILURES_BEFORE_REST, REST_MS, UNFINISHED_BEFORE_STOP,
  BATTERY_RESUME_POINTS, MAX_OPEN_FILES, INTERVAL_WAKE_MS, DOCK_WAIT_MS, FFMPEG_FINISH_MS, RECORDER_EXIT_MS,
};

if (require.main === module) {
  main().catch(err => {
    logError(err.message);
    process.exit(1);
  });
}
