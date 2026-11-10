/**
 * Boathouse snapshot receiver and server
 * ======================================
 * A Cloudflare Worker backed by an R2 bucket. The Pi PUTs the latest JPEG here;
 * everyone else GETs it.
 *
 * WHY THIS RATHER THAN SERVING FROM THE PI
 * ----------------------------------------
 * The Pi is a Pi-hole running your home DNS, behind a residential connection.
 * Exposing it to inbound internet traffic would mean port-forwarding to a DNS
 * server, publishing your home IP, and serving image bandwidth from a Zero W.
 * With this, the Pi is outbound-only: it pushes and never listens.
 *
 * WHY NOT THE GITHUB REPO
 * -----------------------
 * NHRC_temp_monitoring is public and git history is permanent. Committing a
 * frame every 15 minutes would build an irreversible public archive of the
 * river — roughly 35,000 images a year that could never truly be deleted. R2
 * stores exactly one object, overwritten each time.
 *
 * ─── Deploy ──────────────────────────────────────────────────────────────────
 *   1. Cloudflare dashboard -> R2 -> create bucket "nhrc-camera"
 *   2. Workers & Pages -> create Worker -> paste this file
 *   3. Settings -> Variables:
 *        UPLOAD_SECRET  (secret)  same value as CAMERA_UPLOAD_SECRET on the Pi
 *      Settings -> Bindings:
 *        R2 bucket, variable name BUCKET, bucket "nhrc-camera"
 *   4. Use the workers.dev URL Cloudflare assigns automatically:
 *        https://nhrc-camera.<your-account>.workers.dev/latest.jpg
 *
 * NOTE: a cam.roworno.com custom domain is NOT available. roworno.com is on
 * GoDaddy nameservers, and Worker custom domains require the zone to be hosted
 * on Cloudflare. The workers.dev hostname has valid TLS and needs no DNS change,
 * so the live site is never put at risk. See README.md "Which URL".
 *
 * ─── Two Pis: a main one and a standby ──────────────────────────────────────
 * Each Pi POSTs a small check-in to /heartbeat every 5 minutes (same secret as
 * uploads). The Worker keeps one record per Pi, timed by its OWN clock - a Pi
 * that has just rebooted without a real-time clock can be hours out until NTP
 * catches up - and answers with what it knows about both Pis. The standby uses
 * that answer to decide whether the main Pi has gone quiet and it should take
 * over the cameras. Uploads say which Pi sent them (X-Camera-Pi), and /status
 * shows both Pis, so a dead standby is noticed before it is needed.
 *
 * ─── The water sensor ───────────────────────────────────────────────────────
 * Every 15 minutes a Cron Trigger has the Worker read the club's Govee water
 * sensor and keep the reading: GET /water/latest.json (the shape of the site's
 * data.json) and /water/recent.json (the last 16 days, as history.json has
 * them: the rowing rules look back 14 mornings, so the website needs nothing
 * older to apply them). The website and the morning email read these first. GitHub's
 * scheduler used to take the readings, and skipped or delayed so many runs that
 * in late October 2026 the reading on the website was more than 45 minutes old
 * 41% of the time between 5 and 11 AM; GitHub now only archives the readings
 * into history.json, and polls the sensor itself only if this Worker cannot be
 * reached. /status says when the last reading came, and why one did not.
 *
 *   Settings -> Variables:      GOVEE_API_KEY (secret) - the club's Govee key
 *                               GOVEE_DEVICE, GOVEE_SKU (optional; default: the current sensor)
 *   Settings -> Triggers:       Cron Trigger  0,15,30,45 * * * *  (every 15 minutes)
 *
 * ─── The new boathouse timelapse ────────────────────────────────────────────
 * Each evening the Pi that filmed the day sends its timelapse frames here
 * (TIMELAPSE_PUBLISH=1 on the Pi); GitHub's builder (scripts/build_timelapse.js)
 * turns them into the day's video, the date and time on every frame, and sends
 * the video back. roworno.com/newboathouse and the morning email read
 * /timelapse/index.json. The frames themselves are never public. The builder
 * has a secret of its own, so a secret leaked from GitHub could never put a
 * photo on the website as the dock camera's.
 *
 *   Settings -> Variables:      TIMELAPSE_SECRET (secret) - the same value as the
 *                               repository's TIMELAPSE_SECRET (GitHub Actions secret)
 */

const OBJECT_KEY = 'latest.jpg';

// The two Pis and the states they report. Anything else is stored as unknown,
// so a check-in can never put arbitrary text into /status.
const PIS = ['main', 'standby'];
const PI_STATES = ['starting', 'capturing', 'standing-by', 'blocked', 'ring-failed'];
const RING_STATES = ['ok', 'failed', 'not-connected'];
const piKey = (pi) => `pi/${pi}.json`;
// Two different Pis checking in under the same name within this window means
// both are configured as that Pi - both would capture, and the battery camera
// would be woken twice as often. Reported for an hour after it last happened.
const CONFLICT_WINDOW_MS = 15 * 60 * 1000;
const CONFLICT_SHOW_MS = 60 * 60 * 1000;

// A frame older than this is treated as stale, by the camera that took it. A
// stale image is more dangerous than no image, because people trust a
// photograph more than a number.
//
// primary - the hardwired dock camera, every 15 minutes around the clock: an
//           hour is three missed captures plus slack. (After two misses the Pi
//           switches to the backup in daylight, well inside this.)
// backup  - the battery camera, every 30 minutes before 10am and hourly after:
//           one missed afternoon capture already reaches 120 minutes, so 130
//           tolerates exactly one miss with a little slack.
// Frames from a Pi that does not say which camera (older versions) get the
// longer limit.
//
// If a capture interval changes, these must change with it.
const MAX_AGE_MS = { primary: 60 * 60 * 1000, backup: 130 * 60 * 1000 };
const MAX_AGE_DEFAULT_MS = 130 * 60 * 1000;
const maxAgeFor = (role) => (Object.prototype.hasOwnProperty.call(MAX_AGE_MS, role) ? MAX_AGE_MS[role] : MAX_AGE_DEFAULT_MS);

// The website reads which camera took the photo, and when, from these headers.
// Custom headers are only visible to another origin when listed here.
const EXPOSED = 'X-Camera-Role, X-Camera-Name, X-Snapshot-Age-Seconds';

/** Camera role and name, and which Pi sent it, reduced to what is safe to store and echo. */
function cameraMeta(request) {
  const role = (request.headers.get('X-Camera-Role') || '').trim().toLowerCase();
  const pi = (request.headers.get('X-Camera-Pi') || '').trim().toLowerCase();
  return {
    role: role === 'primary' || role === 'backup' ? role : '',
    camera: (request.headers.get('X-Camera-Name') || '').replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 60),
    pi: PIS.includes(pi) ? pi : '',
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Before the photo's PUT below, which answers a PUT to any other address:
    // a timelapse frame must never become the website's photo.
    if (url.pathname.startsWith('/timelapse/')) return handleTimelapse(request, env, url);
    if (request.method === 'PUT') return handleUpload(request, env);
    if (request.method === 'POST' && url.pathname === '/heartbeat') return handleHeartbeat(request, env);
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/water/')) return waterPreflight();
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (url.pathname === '/status') return handleStatus(env);
      if (url.pathname === '/water/latest.json') return handleWater(request, env, WATER_LATEST);
      if (url.pathname === '/water/recent.json') return handleWater(request, env, WATER_RECENT);
      return handleGet(request, env);
    }
    return new Response('Method not allowed', { status: 405 });
  },

  /** The Cron Trigger: a reading from the water sensor. */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(pollSensor(env, controller && controller.scheduledTime ? controller.scheduledTime : Date.now()));
  },
};

/** The shared secret, as a bearer token - required for uploads and check-ins. */
function authorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  // Constant-time-ish comparison: avoid leaking secret length/prefix via timing.
  return !!env.UPLOAD_SECRET && timingSafeEqual(auth, `Bearer ${env.UPLOAD_SECRET}`);
}

async function handleUpload(request, env) {
  if (!authorized(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const type = request.headers.get('Content-Type') || '';
  if (!type.startsWith('image/')) {
    return new Response('Expected an image', { status: 415 });
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return new Response('Empty body', { status: 400 });
  if (body.byteLength > 8 * 1024 * 1024) {
    return new Response('Too large', { status: 413 });
  }

  // Verify the bytes really are a JPEG, not merely labelled as one. The
  // Content-Type header is supplied by the client, so on its own it proves
  // nothing: anyone holding the secret could otherwise store arbitrary content
  // that we would then serve from the club's domain.
  if (!looksLikeJpeg(body)) {
    return new Response('Body is not a JPEG', { status: 415 });
  }

  await env.BUCKET.put(OBJECT_KEY, body, {
    httpMetadata: { contentType: 'image/jpeg' },
    customMetadata: Object.assign({ capturedAt: new Date().toISOString() }, cameraMeta(request)),
  });

  return new Response('OK', { status: 200 });
}

async function handleGet(request, env) {
  const object = await env.BUCKET.get(OBJECT_KEY);
  if (!object) return new Response('No snapshot yet', { status: 404 });

  const meta = object.customMetadata || {};
  const capturedAt = meta.capturedAt ? new Date(meta.capturedAt) : object.uploaded;
  const ageMs = Date.now() - new Date(capturedAt).getTime();

  // Refuse to serve a badly stale frame. The website says the camera could not
  // be reached rather than showing hours-old conditions as if they were current.
  // CORS headers here too, so the page sees a 404 rather than a network error.
  if (ageMs > maxAgeFor(meta.role)) {
    return new Response('Snapshot is stale', {
      status: 404,
      headers: { 'Cache-Control': 'no-store', 'X-Snapshot-Age-Seconds': String(Math.round(ageMs / 1000)),
                 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': EXPOSED },
    });
  }

  const headers = new Headers();
  headers.set('Content-Type', 'image/jpeg');
  // Cache briefly: long enough to absorb traffic, short enough that a new frame
  // appears promptly. The site also cache-busts with a query parameter.
  headers.set('Cache-Control', 'public, max-age=60');
  headers.set('X-Snapshot-Age-Seconds', String(Math.round(ageMs / 1000)));
  headers.set('Last-Modified', new Date(capturedAt).toUTCString());
  // Stop browsers second-guessing the declared type. Combined with the JPEG
  // magic-byte check on upload, this closes the "upload something that is also
  // valid HTML/SVG and get it executed from our domain" path.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Disposition', 'inline; filename="latest.jpg"');
  // The website fetches the frame and reads which camera took it and when.
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Expose-Headers', EXPOSED);
  headers.set('X-Camera-Role', meta.role || '');
  headers.set('X-Camera-Name', meta.camera || '');

  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(object.body, { headers });
}

/**
 * A Pi checking in. Body: {"pi": "main"|"standby", "state", "ring", "ringId",
 * "instance"}; "probe": true asks without being recorded (the Pi's --status).
 * The answer describes both Pis, including which Ring device each signs in
 * as, so the standby can refuse to share the main Pi's Ring login - that is
 * only ever told to a caller holding the secret.
 */
async function handleHeartbeat(request, env) {
  if (!authorized(request, env)) {
    return new Response('Unauthorized', { status: 401 });
  }
  let body;
  try {
    const text = await request.text();
    if (text.length > 2048) return new Response('Too large', { status: 413 });
    body = JSON.parse(text);
  } catch (e) {
    return new Response('Expected JSON', { status: 400 });
  }
  const pi = body && typeof body === 'object' ? String(body.pi || '').trim().toLowerCase() : '';
  if (!PIS.includes(pi)) return new Response('"pi" must be "main" or "standby"', { status: 400 });

  const now = Date.now();
  try {
    if (body.probe !== true) {
      const prev = await readPi(env, pi);
      const instance = hexId(body.instance);
      let conflictAt = prev && Number.isFinite(prev.conflictAt) ? prev.conflictAt : null;
      if (prev && prev.instance && instance && prev.instance !== instance && now - prev.at < CONFLICT_WINDOW_MS) {
        conflictAt = now;
      }
      const record = {
        at: now,
        state: oneOf(body.state, PI_STATES),
        ring: oneOf(body.ring, RING_STATES),
        instance,
        ringId: hexId(body.ringId),
        conflictAt,
      };
      await env.BUCKET.put(piKey(pi), JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } });
    }

    const [mainRec, standbyRec, photo] = await Promise.all([
      readPi(env, 'main'), readPi(env, 'standby'), env.BUCKET.head(OBJECT_KEY),
    ]);
    return json({
      ok: true,
      conflict: conflictActive(pi === 'main' ? mainRec : standbyRec, now),
      main: piSummary('main', mainRec, photo, now, true),
      standby: piSummary('standby', standbyRec, photo, now, true),
      photo: photoSummary(photo, now),
    });
  } catch (e) {
    // Storage trouble. Never answer "the main Pi has not been heard from" when
    // the truth is "could not look": the standby treats an error as no news
    // and carries on doing what it was doing.
    return new Response('Storage unavailable', { status: 503 });
  }
}

/**
 * A Pi's stored check-in, or null if there is none. A storage error is
 * thrown, not turned into null - see handleHeartbeat. A damaged record (which
 * the Pi's next check-in overwrites) reads as none.
 */
async function readPi(env, pi) {
  const object = await env.BUCKET.get(piKey(pi));
  if (!object) return null;
  try {
    const record = await object.json();
    return record && typeof record === 'object' && Number.isFinite(record.at) ? record : null;
  } catch (e) {
    return null;
  }
}

/**
 * What is known about one Pi, or null if it has never been heard from. A photo
 * it uploaded counts as hearing from it. A photo that does not say which Pi
 * sent it came from software older than the standby, when there was only the
 * main Pi - so it counts for the main Pi.
 */
function piSummary(pi, record, photo, now, withIds) {
  let last = record ? record.at : null;
  if (photo) {
    const meta = photo.customMetadata || {};
    if ((meta.pi || 'main') === pi) {
      const t = meta.capturedAt ? Date.parse(meta.capturedAt) : new Date(photo.uploaded).getTime();
      if (Number.isFinite(t) && (last === null || t > last)) last = t;
    }
  }
  if (last === null) return null;
  const summary = {
    lastSeenSecondsAgo: Math.max(0, Math.round((now - last) / 1000)),
    state: record && record.state ? record.state : null,
    ring: record && record.ring ? record.ring : null,
    conflict: conflictActive(record, now),
  };
  if (withIds) summary.ringId = record && record.ringId ? record.ringId : null;
  return summary;
}

function photoSummary(photo, now) {
  if (!photo) return null;
  const meta = photo.customMetadata || {};
  const capturedAt = meta.capturedAt || photo.uploaded;
  return {
    ageSeconds: Math.round((now - new Date(capturedAt).getTime()) / 1000),
    pi: meta.pi || null,
    role: meta.role || null,
    camera: meta.camera || null,
  };
}

const conflictActive = (record, now) => !!(record && Number.isFinite(record.conflictAt)
  && now - record.conflictAt < CONFLICT_SHOW_MS);
const oneOf = (v, allowed) => (allowed.includes(v) ? v : 'unknown');
const hexId = (v) => (typeof v === 'string' && /^[0-9a-f]{8,32}$/.test(v) ? v : '');

// ─── The water sensor ────────────────────────────────────────────────────────

const WATER_LATEST = 'water/latest.json';
const WATER_RECENT = 'water/recent.json';
const WATER_POLL = 'water/poll.json';
/**
 * What the Worker keeps; the archive on GitHub has the rest. 16 days: the rowing
 * rules look at today's morning and the 14 before it, from 5 AM - up to 15 and
 * a half days back - so the website can apply them from these alone.
 */
const WATER_KEEP_MS = 16 * 24 * 3600 * 1000;
const GOVEE_URL = 'https://openapi.api.govee.com/router/api/v1/device/state';
// The sensor in the water since 29 August 2026. Each unit has its own id; the
// repository's "List Govee Devices" workflow finds a new one, which then goes
// in this Worker's GOVEE_DEVICE variable.
const GOVEE_DEVICE = '03:48:01:69:00:00:00:0F:FF:FF:00:45:FF:FF:00:45';
const GOVEE_SKU = 'H5109';
const GOVEE_TIMEOUT_MS = 20000;
// A water temperature outside this range (°F) is a sensor or API fault, not a
// reading - as in scripts/fetch_temp.sh: one 0°F glitch would put the website
// into its coldest rules, one 150°F would count a cold morning as warm.
const PLAUSIBLE_F = [28, 100];

/**
 * Two decimals, cut rather than rounded, as history.json's readings always
 * were (bc in scripts/fetch_temp.sh). The nudge undoes floating point: 56.94
 * times 100 is 5693.9999...
 */
const cut2 = (v) => Math.trunc(v * 100 + (v >= 0 ? 1e-6 : -1e-6)) / 100;

/**
 * The reading in a Govee answer: { tempF } or { error }. An empty value is
 * what Govee gives for a sensor it cannot reach; a sensor Govee calls offline
 * gives no reading either - its value would be an old one, shown as new.
 */
function goveeReading(body) {
  // Govee's own errors come back as HTTP 200, with a code and words of their own.
  if (body && body.code !== undefined && body.code !== null && Number(body.code) !== 200) {
    const said = [body.msg, body.message].find((m) => typeof m === 'string' && m.trim());
    return { error: `Govee answered code ${String(body.code).slice(0, 8)}${said ? `: ${said.trim().slice(0, 80)}` : ''}` };
  }
  const caps = body && body.payload && Array.isArray(body.payload.capabilities) ? body.payload.capabilities : [];
  const cap = (name) => caps.find((c) => c && c.instance === name);
  const online = cap('online');
  const offline = !!(online && online.state && online.state.value === false);
  const t = cap('sensorTemperature');
  const raw = t && t.state ? t.state.value : undefined;
  if (raw === undefined || raw === null || raw === '') {
    return { error: offline ? 'Govee says the sensor is offline: no temperature from it'
      : t ? 'no temperature in Govee\'s answer: the sensor may be out of reach'
      : 'Govee\'s answer has no temperature field' };
  }
  const tempF = typeof raw === 'number' ? raw : /^-?\d+(\.\d+)?$/.test(String(raw)) ? Number(raw) : NaN;
  if (!Number.isFinite(tempF)) return { error: 'the temperature in Govee\'s answer is not a number' };
  if (tempF < PLAUSIBLE_F[0] || tempF > PLAUSIBLE_F[1]) return { error: `implausible water temperature: ${tempF}°F` };
  const o = cap('online');
  if (o && o.state && o.state.value === false) return { error: 'Govee says the sensor is offline' };
  return { tempF };
}

/**
 * One reading from the sensor, kept for the website (the Cron Trigger's job).
 * Whatever happens is noted in water/poll.json, for /status. Never throws.
 */
async function pollSensor(env, when = Date.now()) {
  const at = new Date(when);
  const poll = { at: at.toISOString(), ok: false, error: null };
  try {
    if (!env.GOVEE_API_KEY) throw new Error('GOVEE_API_KEY is not set on this Worker');
    let res;
    try {
      res = await fetch(GOVEE_URL, {
        method: 'POST',
        headers: { 'Govee-API-Key': env.GOVEE_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: 'nhrc-worker', payload: { sku: env.GOVEE_SKU || GOVEE_SKU, device: env.GOVEE_DEVICE || GOVEE_DEVICE } }),
        signal: AbortSignal.timeout(GOVEE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(e && e.name === 'TimeoutError' ? 'Govee did not answer within 20 s' : 'Govee could not be reached');
    }
    if (!res.ok) throw new Error(`Govee answered HTTP ${res.status}`);
    let body;
    try { body = await res.json(); } catch (e) { throw new Error('Govee\'s answer is not JSON'); }
    const r = goveeReading(body);
    if (r.error) throw new Error(r.error);
    await storeReading(env, r.tempF, at);
    poll.ok = true;
  } catch (e) {
    poll.error = String((e && e.message) || e).slice(0, 160);
  }
  try {
    await env.BUCKET.put(WATER_POLL, JSON.stringify(poll), { httpMetadata: { contentType: 'application/json' } });
  } catch (e) { /* only the diagnostics */ }
  return poll;
}

/**
 * The reading, into the last 16 days and as the latest. The days first: a
 * reader who sees the latest finds it among the days. A storage error reading
 * the days is thrown - they are never replaced by one reading.
 */
async function storeReading(env, rawF, at) {
  const tempF = cut2(rawF);
  const tempC = cut2((rawF - 32) * 5 / 9);
  const ts = at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  let days = [];
  const stored = await env.BUCKET.get(WATER_RECENT);
  if (stored) {
    try { const a = await stored.json(); if (Array.isArray(a)) days = a; } catch (e) { days = []; }
  }
  const from = at.getTime() - WATER_KEEP_MS;
  days = days.filter((x) => x && typeof x.ts === 'string' && Date.parse(x.ts) >= from && x.ts !== ts
    && Number.isFinite(x.tempF) && Number.isFinite(x.tempC));
  days.push({ ts, tempC, tempF });
  days.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  await env.BUCKET.put(WATER_RECENT, JSON.stringify(days), { httpMetadata: { contentType: 'application/json' } });
  const tem = Math.round(tempC * 100);
  const latest = {
    status: 200,
    message: 'Success',
    data: { devices: [{
      sku: env.GOVEE_SKU || GOVEE_SKU,
      deviceName: 'NHRC Water Sensor',
      deviceExt: { lastDeviceData: JSON.stringify({ online: true, tem, hum: 0, lastTime: at.getTime(), avgDayTem: tem, avgDayHum: 0 }) },
    }] },
    fetchedAt: ts,
    source: 'worker',
  };
  await env.BUCKET.put(WATER_LATEST, JSON.stringify(latest), { httpMetadata: { contentType: 'application/json' } });
}

/** The latest reading, or the last 16 days, for anyone - the website reads them from another origin. */
async function handleWater(request, env, key) {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
  let object;
  try {
    object = await env.BUCKET.get(key);
  } catch (e) {
    return new Response('Storage unavailable', { status: 503, headers: Object.assign({ 'Cache-Control': 'no-store' }, headers) });
  }
  if (!object) return new Response('No reading yet', { status: 404, headers: Object.assign({ 'Cache-Control': 'no-store' }, headers) });
  // A minute: long enough to absorb a busy morning, short enough for a 15-minute reading.
  headers['Cache-Control'] = 'public, max-age=60';
  if (request.method === 'HEAD') return new Response(null, { headers });
  return new Response(object.body, { headers });
}

function waterPreflight() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' } });
}

/** For /status: when the last reading came, and how the last try went. */
async function waterStatus(env, now) {
  try {
    const [latest, poll] = await Promise.all([env.BUCKET.get(WATER_LATEST), env.BUCKET.get(WATER_POLL)]);
    const l = latest ? await latest.json().catch(() => null) : null;
    const p = poll ? await poll.json().catch(() => null) : null;
    const t = l ? Date.parse(l.fetchedAt) : NaN;
    return {
      lastReadingAt: Number.isFinite(t) ? new Date(t).toISOString() : null,
      ageSeconds: Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : null,
      lastTryAt: p && typeof p.at === 'string' ? p.at : null,
      lastTryOk: p ? p.ok === true : null,
      lastError: p && typeof p.error === 'string' ? p.error.slice(0, 160) : null,
    };
  } catch (e) {
    return 'unavailable';
  }
}

/** Small JSON endpoint so a dead camera - or a dead Pi - is diagnosable without guesswork. */
async function handleStatus(env) {
  const now = Date.now();
  const failed = Symbol('failed');
  const [object, mainRec, standbyRec] = await Promise.all([
    env.BUCKET.head(OBJECT_KEY),
    readPi(env, 'main').catch(() => failed), readPi(env, 'standby').catch(() => failed),
  ]);
  // Public, so without the Ring device ids: when each Pi last checked in, and
  // what it was doing.
  const pis = mainRec === failed || standbyRec === failed ? 'unavailable' : {
    main: piSummary('main', mainRec, object, now, false),
    standby: piSummary('standby', standbyRec, object, now, false),
  };
  const water = await waterStatus(env, now);
  const timelapse = await timelapseStatus(env);
  if (!object) {
    return json({ ok: false, reason: 'no snapshot has ever been uploaded', pis, water, timelapse }, 404);
  }
  const meta = object.customMetadata || {};
  const capturedAt = meta.capturedAt || object.uploaded;
  const ageSeconds = Math.round((now - new Date(capturedAt).getTime()) / 1000);
  return json({
    ok: ageSeconds * 1000 <= maxAgeFor(meta.role),
    camera: meta.camera || null,
    role: meta.role || null,
    pi: meta.pi || null,
    capturedAt: new Date(capturedAt).toISOString(),
    ageSeconds,
    staleAfterSeconds: maxAgeFor(meta.role) / 1000,
    sizeBytes: object.size,
    pis,
    water,
    timelapse,
  });
}

// ─── The new boathouse timelapse ─────────────────────────────────────────────
//
//   the Pi (UPLOAD_SECRET)          PUT    /timelapse/frames/YYYY-MM-DD/HHMM.jpg
//                                   PUT    /timelapse/frames/YYYY-MM-DD/done-main.json (or done-standby):
//                                          {"frames": n} - all of that Pi's frames of the day are here
//                                   GET    /timelapse/frames/YYYY-MM-DD/        what is here already
//   the builder (TIMELAPSE_SECRET)  GET    /timelapse/frames/                   the days that have frames
//                                   GET    /timelapse/frames/YYYY-MM-DD/  and  .../HHMM.jpg
//                                   DELETE /timelapse/frames/YYYY-MM-DD/
//                                   PUT, DELETE /timelapse/videos/YYYY-MM-DD-<id>.mp4
//                                   PUT, DELETE /timelapse/posters/YYYY-MM-DD-<id>.jpg
//                                   PUT    /timelapse/index.json
//   everyone                        GET    /timelapse/index.json, /timelapse/videos/..., /timelapse/posters/...
//
// A video's name changes whenever it is made again (<id> comes from its
// bytes), so videos and posters can be kept by browsers for good.

const TL_FRAMES = 'timelapse/frames/';
const TL_INDEX = 'timelapse/index.json';
const TL_FRAME_MAX = 8 * 1024 * 1024;     // as the photo's
const TL_POSTER_MAX = 2 * 1024 * 1024;
const TL_VIDEO_MAX = 95 * 1024 * 1024;    // a Worker accepts 100 MB at most; a day is about 5-15 MB
const TL_INDEX_MAX = 512 * 1024;
const TL_DAYS_MAX = 2000;
const TL_RECENT_DAYS = 40;                // a Pi may send the frames of a day this far back, or tomorrow's (clocks)
const TL_CORS = { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };

const tlText = (status, text, extra = {}) => new Response(text, {
  status, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, TL_CORS, extra),
});

/** A real calendar day, YYYY-MM-DD. */
function validDay(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(typeof s === 'string' ? s : '');
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 2020 && y <= 2100 && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** A day a Pi may send frames for: from TL_RECENT_DAYS ago to tomorrow. */
function recentDay(s, now = Date.now()) {
  if (!validDay(s)) return false;
  const t = Date.parse(`${s}T12:00:00Z`);
  return t >= now - TL_RECENT_DAYS * 86400000 && t <= now + 2 * 86400000;
}

/**
 * What is wrong with the builder's secret on this Worker, or null. Short, or
 * the same as the Pis' (which would let either do both jobs), is as good as none.
 */
function builderSecretProblem(env) {
  if (!env.TIMELAPSE_SECRET) return 'TIMELAPSE_SECRET is not set';
  if (String(env.TIMELAPSE_SECRET).length < 32) return 'TIMELAPSE_SECRET is too short (openssl rand -hex 32 gives 64 characters)';
  if (env.TIMELAPSE_SECRET === env.UPLOAD_SECRET) return 'TIMELAPSE_SECRET must not be the same as UPLOAD_SECRET';
  return null;
}

/** The builder's own secret. Without a usable one on the Worker, nothing of the builder's is allowed. */
function builderAuthorized(request, env) {
  const auth = request.headers.get('Authorization') || '';
  return !builderSecretProblem(env) && timingSafeEqual(auth, `Bearer ${env.TIMELAPSE_SECRET}`);
}

/** Every key under a prefix, page by page. */
async function listAll(env, prefix) {
  const out = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const r = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    out.push(...(r.objects || []));
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return out;
}

/** One day's frames (name, size) and which Pis have said they sent all of theirs. */
async function timelapseDay(env, day) {
  const prefix = `${TL_FRAMES}${day}/`;
  const frames = [];
  const done = { main: null, standby: null };
  for (const o of await listAll(env, prefix)) {
    const name = o.key.slice(prefix.length);
    if (/^\d{4}\.jpg$/.test(name)) { frames.push({ name, size: o.size }); continue; }
    const d = /^done-(main|standby)\.json$/.exec(name);
    if (!d) continue;
    try {
      const rec = await (await env.BUCKET.get(o.key)).json();
      done[d[1]] = { frames: Number.isInteger(rec.frames) ? rec.frames : null, at: typeof rec.at === 'string' ? rec.at : null };
    } catch (e) {
      done[d[1]] = { frames: null, at: null };
    }
  }
  frames.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { day, frames, done };
}

/** The days that have frames here. */
async function timelapseDays(env) {
  const days = [];
  let cursor;
  for (let page = 0; page < 50; page++) {
    const r = await env.BUCKET.list({ prefix: TL_FRAMES, delimiter: '/', cursor, limit: 1000 });
    for (const p of r.delimitedPrefixes || []) {
      const day = p.slice(TL_FRAMES.length).replace(/\/$/, '');
      if (validDay(day)) days.push(day);
    }
    if (!r.truncated) break;
    cursor = r.cursor;
  }
  return days.sort();
}

/**
 * A single "bytes=a-b", "bytes=a-" or "bytes=-n" range of a file of `size`
 * bytes: { start, end }, 'unsatisfiable', or null for none - or for one this
 * does not do (several ranges, nonsense), which the whole file then answers.
 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!(n > 0)) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null;    // "bytes=5-2": nonsense
  if (start >= size) return 'unsatisfiable';
  return { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

/**
 * A public file: the index, a video or a poster. Videos are fetched in pieces
 * (Range) - Safari plays nothing from a server that cannot send them.
 */
async function serveTimelapseFile(request, env, key, type, cacheControl) {
  const head = await env.BUCKET.head(key);
  if (!head) return tlText(404, 'Not found');
  const headers = new Headers(TL_CORS);
  headers.set('Content-Type', type);
  headers.set('Cache-Control', cacheControl);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag');
  if (head.httpEtag) headers.set('ETag', head.httpEtag);
  if (head.uploaded) headers.set('Last-Modified', new Date(head.uploaded).toUTCString());
  const inm = request.headers.get('If-None-Match');
  if (inm && head.httpEtag && inm === head.httpEtag) return new Response(null, { status: 304, headers });
  const range = request.method === 'GET' ? parseRange(request.headers.get('Range'), head.size) : null;
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(head.size));
    return new Response(null, { status: 200, headers });
  }
  if (range) {
    const part = await env.BUCKET.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
    if (!part) return tlText(404, 'Not found');
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${head.size}`);
    return new Response(part.body, { status: 206, headers });
  }
  const whole = await env.BUCKET.get(key);
  if (!whole) return tlText(404, 'Not found');
  return new Response(whole.body, { status: 200, headers });
}

/**
 * The index the builder sends, kept only if every day in it is well formed -
 * the website and the email read it - and stored as rebuilt from those days.
 */
function sanitizeTimelapseIndex(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.days) || obj.days.length > TL_DAYS_MAX) return null;
  const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  const hhmm = (x) => typeof x === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
  const seen = new Set();
  const days = [];
  for (const d of obj.days) {
    if (!d || typeof d !== 'object' || !validDay(d.date) || seen.has(d.date)) return null;
    const v = /^videos\/(\d{4}-\d\d-\d\d)-[0-9a-f]{8,16}\.mp4$/.exec(typeof d.video === 'string' ? d.video : '');
    if (!v || v[1] !== d.date) return null;
    let poster = null;
    if (d.poster !== null && d.poster !== undefined) {
      const p = /^posters\/(\d{4}-\d\d-\d\d)-[0-9a-f]{8,16}\.jpg$/.exec(typeof d.poster === 'string' ? d.poster : '');
      if (!p || p[1] !== d.date) return null;
      poster = d.poster;
    }
    if (!int(d.frames, 1, 2000) || !int(d.bytes, 1, TL_VIDEO_MAX) || !int(d.width, 16, 4096) || !int(d.height, 16, 4096)) return null;
    if (!(typeof d.seconds === 'number' && Number.isFinite(d.seconds) && d.seconds > 0 && d.seconds <= 3600)) return null;
    if (!hhmm(d.first) || !hhmm(d.last) || d.first > d.last) return null;
    if (typeof d.set !== 'string' || !/^[0-9a-f]{8,64}$/.test(d.set)) return null;
    seen.add(d.date);
    days.push({ date: d.date, video: d.video, poster, frames: d.frames, first: d.first, last: d.last,
      seconds: Math.round(d.seconds * 100) / 100, bytes: d.bytes, width: d.width, height: d.height, set: d.set });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { updated: new Date().toISOString(), days };
}

async function handleTimelapse(request, env, url) {
  const p = url.pathname.slice('/timelapse/'.length);
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  // The builder's routes, when the Worker has no usable secret for it: said
  // plainly, so the GitHub job's log says what to set.
  const problem = builderSecretProblem(env);
  const builder = () => (problem ? null : builderAuthorized(request, env));
  const notSetUp = () => tlText(503, `The timelapse is not set up on this Worker: ${problem} (camera/README.md)`);
  try {
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: Object.assign({ 'Access-Control-Allow-Methods': 'GET, HEAD',
        'Access-Control-Allow-Headers': 'Range', 'Access-Control-Max-Age': '86400' }, TL_CORS) });
    }

    if (p === 'index.json') {
      if (read) return await serveTimelapseFile(request, env, TL_INDEX, 'application/json', 'public, max-age=300');
      if (method !== 'PUT') return tlText(405, 'Method not allowed');
      const ok = builder();
      if (ok === null) return notSetUp();
      if (!ok) return tlText(401, 'Unauthorized');
      const text = await request.text();
      if (text.length > TL_INDEX_MAX) return tlText(413, 'Too large');
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { return tlText(400, 'Expected JSON'); }
      const index = sanitizeTimelapseIndex(parsed);
      if (!index) return tlText(400, 'Not a timelapse index');
      await env.BUCKET.put(TL_INDEX, JSON.stringify(index), { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true, days: index.days.length });
    }

    let m = /^(videos|posters)\/(\d{4}-\d\d-\d\d)-[0-9a-f]{8,16}\.(mp4|jpg)$/.exec(p);
    if (m && validDay(m[2]) && (m[1] === 'videos') === (m[3] === 'mp4')) {
      const key = `timelapse/${p}`;
      const video = m[1] === 'videos';
      if (read) {
        return await serveTimelapseFile(request, env, key, video ? 'video/mp4' : 'image/jpeg', 'public, max-age=31536000, immutable');
      }
      if (method !== 'PUT' && method !== 'DELETE') return tlText(405, 'Method not allowed');
      const ok = builder();
      if (ok === null) return notSetUp();
      if (!ok) return tlText(401, 'Unauthorized');
      if (method === 'DELETE') {
        await env.BUCKET.delete(key);
        return json({ ok: true });
      }
      if (!video) {
        const body = await request.arrayBuffer();
        if (!body.byteLength) return tlText(400, 'Empty body');
        if (body.byteLength > TL_POSTER_MAX) return tlText(413, 'Too large');
        if (!looksLikeJpeg(body)) return tlText(415, 'Body is not a JPEG');
        await env.BUCKET.put(key, body, { httpMetadata: { contentType: 'image/jpeg' } });
        return json({ ok: true });
      }
      // The video goes straight through to storage - a day's video need never
      // be held in this Worker's memory - and is checked for an MP4's start
      // ('ftyp') once stored, before anything lists it.
      const length = Number(request.headers.get('Content-Length'));
      if (!(length > 0)) return tlText(411, 'Content-Length required');
      if (length > TL_VIDEO_MAX) return tlText(413, 'Too large');
      if (!/^video\/mp4\b/.test(request.headers.get('Content-Type') || '')) return tlText(415, 'Expected video/mp4');
      await env.BUCKET.put(key, request.body, { httpMetadata: { contentType: 'video/mp4' } });
      const start = await env.BUCKET.get(key, { range: { offset: 0, length: 12 } });
      const b = start ? new Uint8Array(await start.arrayBuffer()) : new Uint8Array(0);
      if (!(b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)) {
        await env.BUCKET.delete(key);
        return tlText(415, 'Body is not an MP4 video');
      }
      return json({ ok: true });
    }

    if (p === 'frames/') {
      if (method !== 'GET') return tlText(405, 'Method not allowed');
      const ok = builder();
      if (ok === null) return notSetUp();
      if (!ok) return tlText(401, 'Unauthorized');
      return json({ ok: true, days: await timelapseDays(env) });
    }

    m = /^frames\/(\d{4}-\d\d-\d\d)\/(?:(\d{4})\.jpg|done-(main|standby)\.json)?$/.exec(p);
    if (m && validDay(m[1])) {
      const [, day, hhmm, pi] = m;
      const fromPi = authorized(request, env);
      if (!hhmm && !pi) {
        // The day: what is here (the Pi, before sending; the builder), or delete it (the builder).
        if (method === 'GET') {
          if (!fromPi && !builderAuthorized(request, env)) return tlText(401, 'Unauthorized');
          return json(Object.assign({ ok: true }, await timelapseDay(env, day)));
        }
        if (method !== 'DELETE') return tlText(405, 'Method not allowed');
        const ok = builder();
        if (ok === null) return notSetUp();
        if (!ok) return tlText(401, 'Unauthorized');
        const keys = (await listAll(env, `${TL_FRAMES}${day}/`)).map((o) => o.key);
        for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
        return json({ ok: true, deleted: keys.length });
      }
      if (hhmm) {
        if (!/^([01]\d|2[0-3])[0-5]\d$/.test(hhmm)) return tlText(404, 'Not found');
        const key = `${TL_FRAMES}${day}/${hhmm}.jpg`;
        if (method === 'GET') {
          if (!builderAuthorized(request, env)) return tlText(401, 'Unauthorized');
          const o = await env.BUCKET.get(key);
          if (!o) return tlText(404, 'Not found');
          return new Response(o.body, { headers: Object.assign({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }, TL_CORS) });
        }
        if (method !== 'PUT') return tlText(405, 'Method not allowed');
        if (!fromPi) return tlText(401, 'Unauthorized');
        if (!recentDay(day)) return tlText(400, 'Not a day the Pi can be sending frames for');
        if (!(request.headers.get('Content-Type') || '').startsWith('image/')) return tlText(415, 'Expected an image');
        const body = await request.arrayBuffer();
        if (!body.byteLength) return tlText(400, 'Empty body');
        if (body.byteLength > TL_FRAME_MAX) return tlText(413, 'Too large');
        if (!looksLikeJpeg(body)) return tlText(415, 'Body is not a JPEG');
        // A frame already here is never replaced: the main Pi and the standby
        // each send what they filmed, and neither overwrites the other's.
        if (await env.BUCKET.head(key)) return json({ ok: true, kept: true });
        await env.BUCKET.put(key, body, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { pi: cameraMeta(request).pi } });
        return json({ ok: true });
      }
      // done-<pi>.json: that Pi has sent every frame it has of the day.
      if (method !== 'PUT') return tlText(405, 'Method not allowed');
      if (!fromPi) return tlText(401, 'Unauthorized');
      if (!recentDay(day)) return tlText(400, 'Not a day the Pi can be sending frames for');
      let body;
      try {
        const text = await request.text();
        if (text.length > 1024) return tlText(413, 'Too large');
        body = JSON.parse(text);
      } catch (e) {
        return tlText(400, 'Expected JSON');
      }
      const frames = body && typeof body === 'object' ? body.frames : undefined;
      if (!(Number.isInteger(frames) && frames >= 0 && frames <= 2000)) return tlText(400, '"frames" must be a whole number');
      await env.BUCKET.put(`${TL_FRAMES}${day}/done-${pi}.json`, JSON.stringify({ pi, frames, at: new Date().toISOString() }),
        { httpMetadata: { contentType: 'application/json' } });
      return json({ ok: true });
    }

    return tlText(404, 'Not found');
  } catch (e) {
    return tlText(503, 'Storage unavailable');
  }
}

/** For /status: the newest day with a video, and how many days have one. */
async function timelapseStatus(env) {
  try {
    const o = await env.BUCKET.get(TL_INDEX);
    if (!o) return { latest: null, days: 0 };
    const index = await o.json();
    const days = index && Array.isArray(index.days) ? index.days : [];
    return { latest: days.length && typeof days[0].date === 'string' ? days[0].date : null, days: days.length };
  } catch (e) {
    return 'unavailable';
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  });
}

/**
 * JPEG magic bytes: starts FF D8 FF, ends FF D9. Cheap structural check that
 * stops a stolen secret being used to host arbitrary content on our domain.
 */
function looksLikeJpeg(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 4) return false;
  const startsOk = b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
  const endsOk = b[b.length - 2] === 0xFF && b[b.length - 1] === 0xD9;
  return startsOk && endsOk;
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
