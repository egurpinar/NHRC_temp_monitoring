#!/usr/bin/env node
/**
 * The new boathouse timelapse: each day's frames into a video, with the date
 * and time in the corner of every frame, for roworno.com/newboathouse and the
 * morning email.
 *
 * Each evening the Pi that filmed the day (camera/snapshot_service.js, with
 * TIMELAPSE_PUBLISH=1) sends that day's frames - one every 5 minutes, sunrise
 * to sunset, from the Downstream Lot camera - to the Worker, and says when it
 * has sent them all. GitHub runs this a few times each evening
 * (.github/workflows/timelapse.yml): every day whose frames are all there and
 * which has no video yet - or whose frames have changed since (a late frame) -
 * is made into one and sent back to the Worker, and listed in
 * /timelapse/index.json, which the page and the email read. Frames are deleted
 * from the Worker three days after their video is made (the Pi and the Mac keep
 * theirs); the videos are kept.
 *
 *   node scripts/build_timelapse.js                       every finished day not made yet
 *   node scripts/build_timelapse.js --day 2026-11-09      that day, now - even if no Pi has said it is complete
 *   node scripts/build_timelapse.js --frames DIR --out timelapse.mp4
 *                                                         from frames on this computer (e.g. a day's folder in
 *                                                         iCloud Drive > NHRC Timelapse); nothing is sent
 *
 * Environment: TIMELAPSE_SECRET (the builder's secret on the Worker: a GitHub
 * Actions secret, never in this repository), TIMELAPSE_WORKER (the Worker; the
 * club's by default), FFMPEG and FFPROBE (on the PATH by default),
 * TIMELAPSE_FONT (DejaVu Sans Bold - apt install fonts-dejavu-core - or, on a Mac, Arial Bold).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const WORKER = process.env.TIMELAPSE_WORKER || 'https://nhrc-camera.gurpinar-emre.workers.dev';
const TIME_ZONE = 'America/New_York';
const WIDTH = 1280, HEIGHT = 720;     // what Ring sends by day; 1080 frames are scaled down, 480 up
const FPS = 10;                       // a 5-minute frame for a tenth of a second: a December day in 11 s, June in 18
const GOP = FPS;                      // a keyframe each second, so dragging the slider is quick
const CRF = 23;
const MIN_FRAMES = 2;                 // one frame is not a timelapse
const READY_HOUR = 6;                 // a day no Pi has called complete is made from 6 AM the day after
const KEEP_FRAMES_DAYS = 3;           // frames stay on the Worker this long after their video, for late ones
const DROP_FRAMES_DAYS = 30;          // and never longer than this, video or not
const DOWNLOADS_AT_ONCE = 4;
const TRIES = 3;
// The font for the date and time: DejaVu Sans Bold on GitHub's runner (apt
// install fonts-dejavu-core), Arial Bold on a Mac; TIMELAPSE_FONT overrides.
const FONTS = ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf'];
const FONT = process.env.TIMELAPSE_FONT || FONTS.find((f) => fs.existsSync(f)) || FONTS[0];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The words in the corner of a frame, from its day and its local time (as the
 * Pi named it - the boathouse's time, daylight saving included):
 * "Mon, Nov 9, 2026 · 7:05 AM".
 */
function stampText(day, hhmm) {
  const [y, m, d] = day.split('-').map(Number);
  const h = Number(hhmm.slice(0, 2)), min = hhmm.slice(2, 4);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${weekday}, ${MONTHS[m - 1]} ${d}, ${y} · ${h12}:${min} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "07:05" from "0705". */
const clock = (hhmm) => `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;

/** The calendar day n days before a YYYY-MM-DD day. */
function dayBefore(day, n = 1) {
  return new Date(Date.parse(`${day}T12:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

/** The boathouse's day and minute of the day at an instant. */
function localParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * Whether a day's frames are all in: a Pi has said so (it sends them after
 * the day's last frame, then says it is done) - or the day is over and it is
 * 6 AM the day after, by when any Pi that could send them has.
 */
function dayReady(day, done, now = new Date()) {
  const { day: today, minutes } = localParts(now);
  if (day > today) return { ready: false, why: 'a day still to come' };
  const by = done && done.main ? 'the main Pi' : done && done.standby ? 'the standby Pi' : null;
  if (by) return { ready: true, why: `${by} has sent all of its frames` };
  if (day === today) return { ready: false, why: 'still being filmed - no Pi has said it has sent all of its frames' };
  if (day === dayBefore(today) && minutes < READY_HOUR * 60) return { ready: false, why: `waiting until ${READY_HOUR} AM for the Pi to send the rest` };
  return { ready: true, why: 'over, and no Pi has more to send' };
}

const DAY_RE = /^\d{4}-\d\d-\d\d$/;

/** A video or poster of that day's, by the name the Worker gives such files. */
const ownFile = (p, kind, day, ext) => typeof p === 'string' && new RegExp(`^${kind}/${day}-[0-9a-f]{8,16}\\.${ext}$`).test(p);

/** What a video was made from: the frames' names and sizes, as a short hash. */
function frameSet(frames) {
  const list = frames.map((f) => `${f.name}:${f.size}`).sort().join('\n');
  return crypto.createHash('sha256').update(list).digest('hex').slice(0, 12);
}

/** The index's days with this day's entry in (replacing any before), newest first. */
function mergeIndex(index, entry) {
  const days = (index && Array.isArray(index.days) ? index.days : []).filter((d) => d && d.date !== entry.date);
  days.push(entry);
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { days };
}

/** The frame nearest midday, for the poster (the light is best then). */
function posterIndex(names) {
  let best = 0, bestGap = Infinity;
  names.forEach((n, i) => {
    const m = Number(n.slice(0, 2)) * 60 + Number(n.slice(2, 4));
    if (Math.abs(m - 720) < bestGap) { bestGap = Math.abs(m - 720); best = i; }
  });
  return best;
}

/**
 * The environment ffmpeg and ffprobe run with: the PATH, nothing else. They
 * read pictures that came from outside; the Worker's secret is in this
 * process's environment, and they have no need of it.
 */
const toolEnv = () => ({ PATH: process.env.PATH || '/usr/bin:/bin' });

/** Runs a tool: { code, stderr }; a deadline kills it. */
function runTool(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env: toolEnv() });
    } catch (e) {
      resolve({ code: -1, stderr: e.message });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeoutMs);
    child.stderr.on('data', (d) => { if (stderr.length < 20000) stderr += d; });
    child.on('error', (e) => { stderr += e.message; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code === null ? -1 : code, stderr }); });
  });
}

/** Runs a tool and returns what it printed. */
function toolOutput(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let out = '', err = '';
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: toolEnv() });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += e.message; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** A value inside an ffmpeg filter: \ : and ' escaped. */
const filterValue = (s) => String(s).replace(/[\\:']/g, '\\$&');

/**
 * Makes the video. frames: [{ name: 'HHMM.jpg', file }], in time order.
 * Each frame is scaled to 1280x720 and stamped on its own (so a damaged one is
 * simply left out), then they are encoded together. Checked before it is
 * returned: H.264, 1280x720, one video frame per photo, ready to play while it
 * loads (the index at the front). Returns { video, poster, frames, first,
 * last, seconds, width, height, bytes, skipped }.
 */
async function buildVideo({ day, frames, workDir, ffmpeg = process.env.FFMPEG || 'ffmpeg', ffprobe = process.env.FFPROBE || 'ffprobe', font = FONT }) {
  if (!fs.existsSync(font)) throw new Error(`the font ${font} is not there (apt install fonts-dejavu-core, or set TIMELAPSE_FONT)`);
  const stamped = path.join(workDir, 'stamped');
  fs.mkdirSync(stamped, { recursive: true });
  const textFile = path.join(workDir, 'stamp.txt');
  const size = Math.round(HEIGHT * 0.042), border = Math.round(HEIGHT * 0.014), margin = Math.round(HEIGHT * 0.033);
  const used = [], skipped = [];
  for (const f of frames) {
    const hhmm = f.name.slice(0, 4);
    fs.writeFileSync(textFile, stampText(day, hhmm));
    const out = path.join(stamped, `${String(used.length + 1).padStart(5, '0')}.jpg`);
    const vf = `scale=${WIDTH}:${HEIGHT}:flags=lanczos,setsar=1,drawtext=fontfile=${filterValue(font)}:textfile=${filterValue(textFile)}`
      + `:expansion=none:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=${border}:x=w-tw-${margin}:y=h-th-${margin}`;
    const r = await runTool(ffmpeg, ['-v', 'error', '-xerror', '-i', f.file, '-frames:v', '1', '-vf', vf, '-q:v', '2', '-y', out], 60000);
    if (r.code !== 0 || !fs.existsSync(out) || fs.statSync(out).size === 0) {
      try { fs.unlinkSync(out); } catch (e) { /* not made */ }
      skipped.push(f.name);
      continue;
    }
    used.push(hhmm);
  }
  if (used.length < MIN_FRAMES) {
    throw new Error(`only ${used.length} of the ${frames.length} frames could be read${skipped.length ? ` (${skipped.slice(0, 5).join(', ')} could not)` : ''}`);
  }
  const video = path.join(workDir, 'timelapse.mp4');
  const enc = await runTool(ffmpeg, ['-v', 'error', '-framerate', String(FPS), '-i', path.join(stamped, '%05d.jpg'),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF), '-g', String(GOP), '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-an', '-y', video], 600000);
  if (enc.code !== 0) throw new Error(`ffmpeg could not make the video: ${enc.stderr.trim().split('\n').slice(-3).join(' / ')}`);
  const poster = path.join(workDir, 'poster.jpg');
  const p = await runTool(ffmpeg, ['-v', 'error', '-i', path.join(stamped, `${String(posterIndex(used) + 1).padStart(5, '0')}.jpg`),
    '-vf', 'scale=640:360', '-q:v', '4', '-y', poster], 60000);
  if (p.code !== 0) throw new Error(`ffmpeg could not make the poster: ${p.stderr.trim().split('\n').slice(-2).join(' / ')}`);
  const info = await checkVideo(video, used.length, ffprobe);
  return { video, poster, frames: used.length, first: clock(used[0]), last: clock(used[used.length - 1]),
    seconds: info.seconds, width: info.width, height: info.height, bytes: fs.statSync(video).size, skipped };
}

/** The video as the page needs it - or an error saying how it is not. */
async function checkVideo(file, frames, ffprobe = process.env.FFPROBE || 'ffprobe') {
  const r = await toolOutput(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries',
    'stream=codec_name,width,height,nb_read_frames:format=duration', '-of', 'json', file]);
  if (r.code !== 0) throw new Error(`ffprobe could not read the video: ${r.err.trim().slice(0, 200)}`);
  const j = JSON.parse(r.out);
  const s = (j.streams || [])[0] || {};
  const seconds = Number(j.format && j.format.duration);
  const problems = [];
  if (s.codec_name !== 'h264') problems.push(`codec ${s.codec_name}`);
  if (s.width !== WIDTH || s.height !== HEIGHT) problems.push(`${s.width}x${s.height}`);
  if (Number(s.nb_read_frames) !== frames) problems.push(`${s.nb_read_frames} frames for ${frames} photos`);
  if (!(Math.abs(seconds - frames / FPS) < 0.2)) problems.push(`${seconds} s for ${frames} photos`);
  // Plays while it loads: the index (moov) before the pictures (mdat).
  const head = Buffer.alloc(65536);
  const fd = fs.openSync(file, 'r');
  const n = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const moov = head.subarray(0, n).indexOf('moov'), mdat = head.subarray(0, n).indexOf('mdat');
  if (moov < 0 || (mdat >= 0 && mdat < moov)) problems.push('the index is not at the front (it would not play until loaded)');
  if (problems.length) throw new Error(`the video is not right: ${problems.join('; ')}`);
  return { seconds: Math.round(seconds * 100) / 100, width: s.width, height: s.height };
}

// ─── The Worker ──────────────────────────────────────────────────────────────

/**
 * The Worker's timelapse, for the builder: every call bounded, and tried again
 * (up to 3 times) when the Worker or the network fails - never when it refuses.
 */
function workerClient({ base = WORKER, secret, fetchImpl = globalThis.fetch, backoffMs = 2000, timeoutMs = 60000 } = {}) {
  async function call(method, p, { body = undefined, type = undefined, auth = true, as = 'json', okStatuses = [] } = {}) {
    let last = null;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      if (attempt > 1 && backoffMs) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 2)));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), body && body.length > 1e6 ? 10 * 60000 : timeoutMs);
      try {
        const headers = {};
        if (auth) headers.Authorization = `Bearer ${secret}`;
        if (type) headers['Content-Type'] = type;
        const res = await fetchImpl(`${base}${p}`, { method, headers, body, signal: ctrl.signal });
        if (res.ok || okStatuses.includes(res.status)) {
          if (!res.ok) return { status: res.status, data: null };
          const data = as === 'json' ? await res.json() : as === 'bytes' ? Buffer.from(await res.arrayBuffer()) : await res.text();
          return { status: res.status, data };
        }
        // Plain printable text only: what a server says must never reach the
        // log as a line of its own - on GitHub, "::" at a line's start is a command.
        const text = (await res.text().catch(() => '')).replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 200);
        last = new Error(`${method} ${p}: the Worker answered HTTP ${res.status}${text ? ` (${text})` : ''}`);
        if (res.status < 500) throw Object.assign(last, { final: true });   // refused: trying again changes nothing
      } catch (e) {
        if (e.final) throw e;
        last = e.name === 'AbortError' ? new Error(`${method} ${p}: no answer from the Worker in time`)
          : e.message && e.message.startsWith(method) ? e : new Error(`${method} ${p}: the Worker could not be reached (${(e.cause && e.cause.code) || e.message})`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  }
  return {
    days: async () => (await call('GET', '/timelapse/frames/')).data.days || [],
    day: async (day) => (await call('GET', `/timelapse/frames/${day}/`)).data,
    frame: async (day, name) => (await call('GET', `/timelapse/frames/${day}/${name}`, { as: 'bytes' })).data,
    index: async () => {
      const r = await call('GET', `/timelapse/index.json?fresh=${Date.now()}`, { auth: false, okStatuses: [404] });
      return r.status === 404 ? { days: [] } : r.data;
    },
    putIndex: async (index) => call('PUT', '/timelapse/index.json', { body: JSON.stringify(index), type: 'application/json' }),
    putVideo: async (name, bytes) => call('PUT', `/timelapse/videos/${name}`, { body: bytes, type: 'video/mp4' }),
    putPoster: async (name, bytes) => call('PUT', `/timelapse/posters/${name}`, { body: bytes, type: 'image/jpeg' }),
    remove: async (p) => call('DELETE', `/timelapse/${p}`, { okStatuses: [404] }),
    dropFrames: async (day) => call('DELETE', `/timelapse/frames/${day}/`),
  };
}

/** Downloads a day's frames into dir, a few at a time: [{ name, file }] in time order. */
async function downloadFrames(client, day, names, dir) {
  const out = new Array(names.length);
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      const file = path.join(dir, names[i]);
      fs.writeFileSync(file, await client.frame(day, names[i]));
      out[i] = { name: names[i], file };
    }
  };
  await Promise.all(Array.from({ length: Math.min(DOWNLOADS_AT_ONCE, names.length) }, worker));
  return out;
}

/**
 * Every finished day not made yet - or only `onlyDay`, made whatever any Pi
 * has said. Returns { built: [...], waiting: [...], failed: [...], pruned: [...] }.
 */
async function buildFromWorker({ client, now = new Date(), onlyDay = null, say = console.log, tools = {} }) {
  const result = { built: [], waiting: [], failed: [], pruned: [], skipped: [] };
  // Every day, file name and address from the Worker is checked before it is
  // used in a path or a request: an answer can never reach outside its day.
  const days = (onlyDay ? [onlyDay] : await client.days()).filter((d) => typeof d === 'string' && DAY_RE.test(d));
  let index = await client.index();
  const known = new Map((index.days || []).map((d) => [d.date, d]));
  const sets = new Map();
  const { day: today } = localParts(now);
  for (const day of days) {
    try {
      const listing = await client.day(day);
      const frames = (listing.frames || []).filter((f) => f && /^\d{4}\.jpg$/.test(f.name));
      if (!frames.length) { if (onlyDay) say(`${day}: no frames on the Worker.`); continue; }
      const set = frameSet(frames);
      sets.set(day, set);
      const before = known.get(day);
      if (before && before.set === set && !onlyDay) continue;            // made from these very frames
      if (!onlyDay) {
        const ready = dayReady(day, listing.done, now);
        if (!ready.ready) { result.waiting.push(day); say(`${day}: not yet - ${ready.why} (${frames.length} frames so far).`); continue; }
      }
      if (frames.length < MIN_FRAMES) { result.skipped.push(day); say(`${day}: only ${frames.length} frame - no video.`); continue; }
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `nhrc-timelapse-${day}-`));
      try {
        const t0 = Date.now();
        const got = await downloadFrames(client, day, frames.map((f) => f.name), work);
        const v = await buildVideo(Object.assign({ day, frames: got, workDir: work }, tools));
        const bytes = fs.readFileSync(v.video);
        const id = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
        const entry = { date: day, video: `videos/${day}-${id}.mp4`, poster: `posters/${day}-${id}.jpg`, frames: v.frames,
          first: v.first, last: v.last, seconds: v.seconds, bytes: v.bytes, width: v.width, height: v.height, set };
        await client.putVideo(`${day}-${id}.mp4`, bytes);
        await client.putPoster(`${day}-${id}.jpg`, fs.readFileSync(v.poster));
        index = mergeIndex(index, entry);
        await client.putIndex(index);
        known.set(day, entry);
        // The video it replaces, once the index no longer lists it - only ever that day's own.
        if (before && before.video !== entry.video) {
          if (ownFile(before.video, 'videos', day, 'mp4')) await client.remove(before.video).catch(() => {});
          if (ownFile(before.poster, 'posters', day, 'jpg')) await client.remove(before.poster).catch(() => {});
        }
        result.built.push(Object.assign({ skipped: v.skipped }, entry));
        say(`${day}: made - ${v.frames} frames, ${v.first} to ${v.last}, ${v.seconds} s, ${(v.bytes / 1048576).toFixed(1)} MB`
          + `${before ? ' (made again: its frames had changed)' : ''}${v.skipped.length ? `; left out, unreadable: ${v.skipped.join(', ')}` : ''}`
          + `; took ${Math.round((Date.now() - t0) / 1000)} s.`);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    } catch (e) {
      // One line of plain text: ffmpeg's and the Worker's words never reach the log as lines of their own.
      const error = String((e && e.message) || e).replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 500);
      result.failed.push({ day, error });
      say(`${day}: FAILED - ${error}`);
    }
  }
  // Frames whose video is made, once they are KEEP_FRAMES_DAYS old; any, at DROP_FRAMES_DAYS.
  if (!onlyDay) {
    for (const day of days) {
      const made = known.get(day);
      const done = made && sets.has(day) && made.set === sets.get(day);
      if ((done && day <= dayBefore(today, KEEP_FRAMES_DAYS)) || day < dayBefore(today, DROP_FRAMES_DAYS)) {
        try {
          await client.dropFrames(day);
          result.pruned.push(day);
        } catch (e) {
          say(`${day}: its frames could not be deleted from the Worker (${e.message}) - tried again next time.`);
        }
      }
    }
  }
  return result;
}

/** A day's frames from a folder on this computer: files named YYYY-MM-DD_HHMM.jpg. */
function framesFromFolder(dir) {
  const found = fs.readdirSync(dir).map((n) => /^(\d{4}-\d\d-\d\d)_(\d{4})\.jpg$/.exec(n)).filter(Boolean)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!found.length) throw new Error(`no frames named YYYY-MM-DD_HHMM.jpg in ${dir}`);
  const days = [...new Set(found.map((m) => m[1]))];
  if (days.length > 1) throw new Error(`frames of ${days.length} days in ${dir} (${days.join(', ')}): one day's folder at a time`);
  return { day: days[0], frames: found.map((m) => ({ name: `${m[2]}.jpg`, file: path.join(dir, m[0]) })) };
}

function annotate(level, msg) {
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::${level}::${String(msg).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
}

async function main(argv = process.argv.slice(2)) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  if (arg('--frames')) {
    const { day, frames } = framesFromFolder(arg('--frames'));
    const out = path.resolve(arg('--out') || `${day}.mp4`);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-timelapse-local-'));
    try {
      const v = await buildVideo({ day, frames, workDir: work });
      fs.copyFileSync(v.video, out);
      console.log(`${day}: ${out} - ${v.frames} frames, ${v.first} to ${v.last}, ${v.seconds} s, ${(v.bytes / 1048576).toFixed(1)} MB`
        + `${v.skipped.length ? `; left out, unreadable: ${v.skipped.join(', ')}` : ''}.`);
      return 0;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  const onlyDay = arg('--day');
  if (onlyDay !== null && !/^\d{4}-\d\d-\d\d$/.test(onlyDay)) {
    console.error(`--day needs a day like 2026-11-09 (it was "${onlyDay}")`);
    return 2;
  }
  const secret = process.env.TIMELAPSE_SECRET || '';
  if (!secret) {
    const msg = 'TIMELAPSE_SECRET is not set: no timelapse made. To set it up, see camera/README.md, "The timelapse on the website".';
    console.log(msg);
    annotate('notice', msg);
    return 0;
  }
  const r = await buildFromWorker({ client: workerClient({ secret }), onlyDay });
  const lines = [
    ...r.built.map((d) => `- ${d.date}: made - ${d.frames} frames, ${d.first} to ${d.last}, ${d.seconds} s`),
    ...r.waiting.map((d) => `- ${d}: waiting for its frames`),
    ...r.failed.map((f) => `- ${f.date || f.day}: FAILED - ${f.error}`),
  ];
  console.log(`Made ${r.built.length}, waiting ${r.waiting.length}, failed ${r.failed.length}; frames deleted from the Worker for ${r.pruned.length} day(s).`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### New boathouse timelapse\n\n${lines.join('\n') || 'Nothing to make.'}\n`); } catch (e) { /* only the summary */ }
  }
  for (const f of r.failed) annotate('error', `${f.day}: ${f.error}`);
  return r.failed.length ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`FAILED - ${e.message}`);
    annotate('error', e.message);
    process.exitCode = 1;
  });
}

module.exports = {
  WORKER, WIDTH, HEIGHT, FPS, GOP, MIN_FRAMES, READY_HOUR, KEEP_FRAMES_DAYS, DROP_FRAMES_DAYS, FONT, FONTS,
  stampText, clock, dayBefore, localParts, dayReady, frameSet, mergeIndex, posterIndex, filterValue, toolEnv, ownFile,
  buildVideo, checkVideo, workerClient, downloadFrames, buildFromWorker, framesFromFolder, main,
};
