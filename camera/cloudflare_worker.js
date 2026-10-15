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

    if (request.method === 'PUT') return handleUpload(request, env);
    if (request.method === 'POST' && url.pathname === '/heartbeat') return handleHeartbeat(request, env);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (url.pathname === '/status') return handleStatus(env);
      return handleGet(request, env);
    }
    return new Response('Method not allowed', { status: 405 });
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
  if (!object) {
    return json({ ok: false, reason: 'no snapshot has ever been uploaded', pis }, 404);
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
  });
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
