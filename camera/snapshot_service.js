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
  activeStartHour: Number(process.env.CAMERA_ACTIVE_START_HOUR ?? 5),
  activeEndHour: Number(process.env.CAMERA_ACTIVE_END_HOUR ?? 21),

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

/** Validates configuration up front so failures are obvious, not mysterious. */
function validateConfig(cfg = CONFIG) {
  const problems = [];
  if (!cfg.uploadUrl) problems.push('CAMERA_UPLOAD_URL is not set');
  else if (!/^https:\/\//.test(cfg.uploadUrl)) {
    problems.push('CAMERA_UPLOAD_URL must be https (the secret is sent as a header)');
  }
  if (!cfg.uploadSecret) problems.push('CAMERA_UPLOAD_SECRET is not set');
  else if (cfg.uploadSecret.length < 16) {
    problems.push('CAMERA_UPLOAD_SECRET is too short — use at least 16 random characters');
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
      if (!Number.isInteger(v) || v < 0 || v > 23) problems.push(`${k} must be an integer 0-23`);
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
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.timeZone, hour: 'numeric', hour12: false,
  }).format(now), 10);
  const { activeStartHour: s, activeEndHour: e } = cfg;
  return s <= e ? (hour >= s && hour < e) : (hour >= s || hour < e);
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
  const res = await fetchImpl(cfg.uploadUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${cfg.uploadSecret}`,
      'Content-Type': 'image/jpeg',
      'Content-Length': String(buffer.length),
    },
    body: buffer,
  });
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

  const { RingApi } = require('ring-client-api');
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
      logError(`snapshot attempt ${attempt}/${cfg.retries} failed: ${e.message}`);
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
  const buf = await captureWithRetry(camera, cfg);
  await uploadSnapshot(buf, cfg);
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
      ? 'always' : CONFIG.activeStartHour + ':00-' + CONFIG.activeEndHour + ':00 ' + CONFIG.timeZone}`);
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
};

if (require.main === module) {
  main().catch(err => {
    logError(err.message);
    process.exit(1);
  });
}
