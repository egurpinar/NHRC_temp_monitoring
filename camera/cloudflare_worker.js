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
 * frame every 5 minutes would build an irreversible public archive of the
 * river — roughly 100,000 images a year that could never truly be deleted. R2
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
 */

const OBJECT_KEY = 'latest.jpg';

// A frame older than this is treated as stale, by the camera that took it. A
// stale image is more dangerous than no image, because people trust a
// photograph more than a number.
//
// primary - the hardwired dock camera, every 5 minutes around the clock. In
//           daylight the Pi switches to the backup after six misses (about
//           half an hour), well inside this hour; at night, when the backup
//           sleeps, a dock photo up to an hour old is still shown - with the
//           time it was taken - before the page says the camera is down.
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

/** Camera role and name from an upload, reduced to what is safe to store and echo. */
function cameraMeta(request) {
  const role = (request.headers.get('X-Camera-Role') || '').trim().toLowerCase();
  return {
    role: role === 'primary' || role === 'backup' ? role : '',
    camera: (request.headers.get('X-Camera-Name') || '').replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 60),
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'PUT') return handleUpload(request, env);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (url.pathname === '/status') return handleStatus(env);
      return handleGet(request, env);
    }
    return new Response('Method not allowed', { status: 405 });
  },
};

async function handleUpload(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const expected = `Bearer ${env.UPLOAD_SECRET}`;

  // Constant-time-ish comparison: avoid leaking secret length/prefix via timing.
  if (!env.UPLOAD_SECRET || !timingSafeEqual(auth, expected)) {
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

/** Small JSON endpoint so a dead camera is diagnosable without guesswork. */
async function handleStatus(env) {
  const object = await env.BUCKET.head(OBJECT_KEY);
  if (!object) {
    return json({ ok: false, reason: 'no snapshot has ever been uploaded' }, 404);
  }
  const meta = object.customMetadata || {};
  const capturedAt = meta.capturedAt || object.uploaded;
  const ageSeconds = Math.round((Date.now() - new Date(capturedAt).getTime()) / 1000);
  return json({
    ok: ageSeconds * 1000 <= maxAgeFor(meta.role),
    camera: meta.camera || null,
    role: meta.role || null,
    capturedAt: new Date(capturedAt).toISOString(),
    ageSeconds,
    staleAfterSeconds: maxAgeFor(meta.role) / 1000,
    sizeBytes: object.size,
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
