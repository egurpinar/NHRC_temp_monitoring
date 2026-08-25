#!/usr/bin/env node
/**
 * NHRC Boathouse Camera — Ring snapshot service
 * =============================================
 * Runs continuously on a Raspberry Pi (Pi Zero W / ARMv6 supported). Captures a
 * snapshot from the Ring camera on a schedule and uploads it to the endpoint
 * that serves cam.roworno.com.
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
 *   node camera/snapshot_service.js            run the service
 *   node camera/snapshot_service.js --once     capture and upload a single frame
 *   node camera/snapshot_service.js --check    validate config, no Ring calls
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

  // Substring match against the Ring camera name, so the right camera is picked
  // when the account has several. Case-insensitive.
  cameraName: process.env.RING_CAMERA_NAME || '',

  // Upload destination and shared secret.
  uploadUrl: process.env.CAMERA_UPLOAD_URL || '',
  uploadSecret: process.env.CAMERA_UPLOAD_SECRET || '',

  intervalMinutes: Number(process.env.CAMERA_INTERVAL_MINUTES || 15),

  // Optional daylight window in the boathouse timezone. A night-time frame from
  // an unlit river is a black rectangle, which is worse than showing nothing —
  // and each capture costs battery. Set both to 0 to disable the window.
  // Accepts "4" or "4:30". Defined below CONFIG but hoisted, so usable here.
  activeStartHour: parseHourSetting(process.env.CAMERA_ACTIVE_START_HOUR, 4.5),
  activeEndHour: parseHourSetting(process.env.CAMERA_ACTIVE_END_HOUR, 19),

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
  if (!(cfg.intervalMinutes >= 5)) {
    // Ring throttles battery cameras to roughly one snapshot per 10 minutes and
    // every capture costs battery, so anything below 5 minutes is pointless.
    problems.push('CAMERA_INTERVAL_MINUTES must be at least 5');
  }
  if (!(cfg.retries >= 1)) problems.push('CAMERA_RETRIES must be at least 1');
  const hoursDisabled = cfg.activeStartHour === 0 && cfg.activeEndHour === 0;
  if (!hoursDisabled) {
    for (const [k, v] of [['CAMERA_ACTIVE_START_HOUR', cfg.activeStartHour],
                          ['CAMERA_ACTIVE_END_HOUR', cfg.activeEndHour]]) {
      // Fractional values are legitimate now (4.5 === "4:30"), so this checks
      // the range rather than integer-ness. 24 is excluded: "24:00" would never
      // match, since the clock reads 0 at midnight.
      if (!Number.isFinite(v) || v < 0 || v >= 24) {
        problems.push(`${k} must be an hour from 0 to 23, optionally with minutes (e.g. 4 or 4:30)`);
      }
    }
  }
  return problems;
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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour').value);
  const m = Number(parts.find(p => p.type === 'minute').value);
  const hour = h + m / 60;
  const { activeStartHour: s, activeEndHour: e } = cfg;
  return s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e);
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
async function uploadSnapshot(buffer, cfg = CONFIG, fetchImpl = globalThis.fetch) {
  let res;
  try {
    res = await fetchImpl(cfg.uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${cfg.uploadSecret}`,
        'Content-Type': 'image/jpeg',
        // Do NOT set Content-Length. undici derives it from the body and
        // rejects a caller-supplied value with UND_ERR_INVALID_ARG, so setting
        // it here made every upload fail before a byte left the Pi.
      },
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
    // No camera status polling: we only need snapshots, and polling wakes a
    // battery camera unnecessarily.
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

async function pickCamera(api, cfg = CONFIG) {
  const cameras = await api.getCameras();
  if (!cameras.length) throw new Error('No cameras found on this Ring account.');
  if (!cfg.cameraName) {
    if (cameras.length > 1) {
      log(`Note: ${cameras.length} cameras found and RING_CAMERA_NAME is unset; using "${cameras[0].name}".`);
      log('Available:', cameras.map(c => c.name).join(', '));
    }
    return cameras[0];
  }
  const needle = cfg.cameraName.toLowerCase();
  const match = cameras.find(c => String(c.name).toLowerCase().includes(needle));
  if (!match) {
    throw new Error(
      `No camera matching "${cfg.cameraName}". Available: ${cameras.map(c => c.name).join(', ')}`);
  }
  return match;
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

async function runCycle(camera, cfg = CONFIG) {
  if (!isWithinActiveHours(new Date(), cfg)) {
    log('Outside active hours — skipping capture.');
    return false;
  }
  // Label the stage: "fetch failed" alone cannot be told apart from a Ring
  // download failure, and the two have completely different fixes.
  let buf;
  try {
    buf = await captureWithRetry(camera, cfg);
  } catch (e) {
    throw new Error(`CAPTURE stage — ${describeCause(e)}`);
  }
  log(`Captured ${buf.length} bytes; uploading to ${hostOf(cfg.uploadUrl)}`);
  try {
    await uploadSnapshot(buf, cfg);
  } catch (e) {
    throw new Error(`UPLOAD stage — ${describeCause(e)}`);
  }
  log(`Snapshot uploaded (${(buf.length / 1024).toFixed(0)} KB).`);
  return true;
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
  if (args.includes('--check')) {
    log('Configuration looks valid.');
    log(`  interval     : every ${CONFIG.intervalMinutes} min`);
    log(`  active hours : ${CONFIG.activeStartHour === 0 && CONFIG.activeEndHour === 0
      ? 'always'
      : formatHourSetting(CONFIG.activeStartHour) + '-' + formatHourSetting(CONFIG.activeEndHour)
        + ' ' + CONFIG.timeZone}`);
    log(`  token file   : ${CONFIG.tokenFile} (${readToken() ? 'present' : 'MISSING'})`);
    log(`  upload to    : ${CONFIG.uploadUrl}`);
    return;
  }

  const api = await connectRing();
  const camera = await pickCamera(api);
  log(`Using camera: ${camera.name}`);

  if (args.includes('--once')) {
    await runCycle(camera);
    process.exit(0);
  }

  log(`Starting. Capturing every ${CONFIG.intervalMinutes} minutes.`);
  const tick = async () => {
    try {
      await runCycle(camera);
    } catch (e) {
      // Never exit on a failed cycle: a transient Ring or network error should
      // not take the service down until someone notices days later. The image
      // simply ages, and the website hides a snapshot it cannot load.
      logError('cycle failed:', e.message);
    }
  };

  await tick();
  setInterval(tick, CONFIG.intervalMinutes * 60 * 1000);
}

module.exports = {
  CONFIG, validateConfig, isWithinActiveHours,
  readToken, writeToken, uploadSnapshot, captureWithRetry, runCycle,
  describeCause, hostOf, parseHourSetting, formatHourSetting,
};

if (require.main === module) {
  main().catch(err => {
    logError(err.message);
    process.exit(1);
  });
}
