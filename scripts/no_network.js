// Preload for the tests (see without_network.sh): nothing may reach past this
// machine. Every attempt - fetch, a socket, a name lookup - is written to
// NO_NETWORK_LOG and fails at once, as it would on a machine with no network.
// A test that reached the network would pass or fail with the state of a
// server somewhere else, and the email job runs its tests at 1 AM with the
// email waiting on them. This machine (localhost) stays open: the tests start
// servers of their own.
'use strict';
const fs = require('fs');
const LOG = process.env.NO_NETWORK_LOG || '';
const local = (h) => /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\]|::ffff:127(\.\d{1,3}){3}|0\.0\.0\.0|::|)$/i
  .test(String(h == null ? '' : h).trim());

function refused(kind, target) {
  const at = (new Error().stack || '').split('\n').slice(3, 8).map(s => s.trim()).join(' <- ');
  if (LOG) {
    try { fs.appendFileSync(LOG, `${kind} ${target}  (${process.argv[1] || process.argv0})  ${at}\n`); } catch (e) { /* the run goes on */ }
  }
  const err = new Error(`no network in the tests: ${kind} ${target}`);
  err.code = 'ENETUNREACH';
  return err;
}

const net = require('net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];   // node's own, normalized form
  let host = '', port, pipe = null;
  if (o && typeof o === 'object') { host = o.host; port = o.port; pipe = o.path || null; }
  else if (typeof o === 'number' || /^\d+$/.test(String(o))) { port = o; if (typeof args[1] === 'string') host = args[1]; }
  else if (typeof o === 'string') pipe = o;
  if (pipe === null && !local(host)) {
    const err = refused('connect', `${host}:${port}`);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};

const dns = require('dns');
const lookup = dns.lookup;
dns.lookup = function (host, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (!local(host)) {
    const err = refused('dns', host);
    process.nextTick(() => cb(err));
    return {};
  }
  return lookup.call(this, host, options, cb);
};
if (dns.promises && typeof dns.promises.lookup === 'function') {
  const lookupP = dns.promises.lookup;
  dns.promises.lookup = function (host, ...rest) {
    return local(host) ? lookupP.call(this, host, ...rest) : Promise.reject(refused('dns', host));
  };
}

if (typeof globalThis.fetch === 'function') {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && (input.href || input.url)) || String(input);
    let h = '';
    try { h = new URL(url).hostname; } catch (e) { /* not a URL: fetch itself will say so */ }
    if (!/^(data|blob|file):/i.test(url) && !local(h)) {
      return Promise.reject(new TypeError('fetch failed', { cause: refused('fetch', url) }));
    }
    return realFetch.call(this, input, init);
  };
}
