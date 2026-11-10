'use strict';
/**
 * The real Cloudflare Worker (camera/cloudflare_worker.js), run in Node for the
 * tests: an in-memory stand-in for its R2 bucket - put, get (ranges too), head,
 * list (prefixes, delimiters, pages) and delete, as R2 has them - and, for code
 * that talks to the Worker over HTTP (the Pi's service, the timelapse builder),
 * the Worker served on 127.0.0.1. Nothing leaves the machine.
 *
 *   const { loadWorker, memoryR2, serveWorker } = require('./worker_harness');
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const WORKER_FILE = path.join(__dirname, '..', 'camera', 'cloudflare_worker.js');

/** The Worker's fetch/scheduled handlers, from its source (the file in the repository by default). */
async function loadWorker(src = fs.readFileSync(WORKER_FILE, 'utf8')) {
  const tmp = path.join(os.tmpdir(), `nhrc-worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    return (await import(require('url').pathToFileURL(tmp).href)).default;
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** The bytes of whatever R2's put() accepts: text, buffers, a stream (a request's body). */
async function bytesOf(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (value && typeof value[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const c of value) chunks.push(Buffer.from(c));
    return new Uint8Array(Buffer.concat(chunks));
  }
  throw new Error('R2 stand-in: a value R2 would not take');
}

/**
 * An R2 bucket stand-in. failNext(n) makes the next n calls fail, as R2 now
 * and then does; keys(), bytes(key) and stored(key) are for the tests' eyes.
 */
function memoryR2() {
  const objects = new Map();
  let failures = 0;
  const failing = () => { if (failures > 0) { failures--; throw new Error('R2: internal error'); } };
  const meta = (o) => ({ key: o.key, size: o.size, etag: o.etag, httpEtag: `"${o.etag}"`, uploaded: o.uploaded,
    httpMetadata: o.httpMetadata, customMetadata: o.customMetadata });
  const withBody = (o, bytes, range) => Object.assign(meta(o), {
    range,
    body: bytes,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => new TextDecoder().decode(bytes),
    json: async () => JSON.parse(new TextDecoder().decode(bytes)),
  });
  const bucket = {
    async put(key, value, opts = {}) {
      failing();
      const bytes = await bytesOf(value);
      objects.set(key, { key, bytes, size: bytes.byteLength, etag: crypto.createHash('md5').update(bytes).digest('hex'),
        uploaded: new Date(), httpMetadata: Object.assign({}, opts.httpMetadata), customMetadata: Object.assign({}, opts.customMetadata) });
      return meta(objects.get(key));
    },
    async get(key, opts = {}) {
      failing();
      const o = objects.get(key);
      if (!o) return null;
      if (!opts.range) return withBody(o, o.bytes, { offset: 0, length: o.size });
      const r = opts.range;
      const offset = r.suffix !== undefined ? Math.max(0, o.size - r.suffix) : (r.offset || 0);
      const length = r.suffix !== undefined ? o.size - offset : (r.length !== undefined ? r.length : o.size - offset);
      if (offset > o.size || length < 0) throw new Error('R2: InvalidRange');
      const bytes = o.bytes.subarray(offset, Math.min(o.size, offset + length));
      return withBody(o, bytes, { offset, length: bytes.byteLength });
    },
    async head(key) {
      failing();
      const o = objects.get(key);
      return o ? meta(o) : null;
    },
    async list(opts = {}) {
      failing();
      const prefix = opts.prefix || '';
      const limit = Math.min(opts.limit || 1000, 1000);
      const entries = [];
      const seen = new Set();
      for (const k of [...objects.keys()].filter((x) => x.startsWith(prefix)).sort()) {
        if (opts.delimiter) {
          const i = k.indexOf(opts.delimiter, prefix.length);
          if (i >= 0) {
            const p = k.slice(0, i + opts.delimiter.length);
            if (!seen.has(p)) { seen.add(p); entries.push({ prefix: p }); }
            continue;
          }
        }
        entries.push({ key: k });
      }
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = entries.slice(start, start + limit);
      const truncated = start + limit < entries.length;
      return { objects: page.filter((e) => e.key).map((e) => meta(objects.get(e.key))),
        delimitedPrefixes: page.filter((e) => e.prefix).map((e) => e.prefix), truncated,
        cursor: truncated ? String(start + limit) : undefined };
    },
    async delete(keys) {
      failing();
      for (const k of [].concat(keys)) objects.delete(k);
    },
    failNext: (n = 1) => { failures = n; },
    keys: () => [...objects.keys()].sort(),
    stored: (key) => objects.get(key) || null,
    bytes: (key) => (objects.has(key) ? Buffer.from(objects.get(key).bytes) : null),
  };
  return bucket;
}

/**
 * The Worker over HTTP on 127.0.0.1: { url, port, requests, close }. Every
 * request is noted in `requests` ({ method, path, headers, bytes });
 * intercept(entry) may answer one itself ({ status, body, headers }) - a Worker
 * that is down, or older.
 */
async function serveWorker({ env, worker = null, host = 'nhrc-camera.example.workers.dev', intercept = null } = {}) {
  const w = worker || await loadWorker();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const entry = { method: req.method, path: req.url, headers: req.headers, bytes: body.length };
    requests.push(entry);
    try {
      const canned = intercept && await intercept(entry, body);
      if (canned) {
        res.writeHead(canned.status, canned.headers || { 'Content-Type': 'text/plain' });
        res.end(canned.body || '');
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (!['host', 'connection', 'transfer-encoding', 'keep-alive'].includes(k)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const r = await w.fetch(new Request(`https://${host}${req.url}`, { method: req.method, headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body }), env);
      const out = Buffer.from(await r.arrayBuffer());
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(req.method === 'HEAD' ? undefined : out);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(String((e && e.stack) || e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`, port, requests, env,
    close: () => new Promise((r) => { if (server.closeAllConnections) server.closeAllConnections(); server.close(() => r()); }),
  };
}

module.exports = { WORKER_FILE, loadWorker, memoryR2, serveWorker, bytesOf };
