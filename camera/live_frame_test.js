#!/usr/bin/env node
/**
 * One-off test: can this Pi take a FULL-RESOLUTION picture from a Ring camera
 * by grabbing one frame of its live video? Ring snapshots are only 640x360.
 *
 * It takes one ordinary snapshot, then records about 10 seconds of the
 * camera's live video (default camera: RING_BACKUP_CAMERA_NAME, the Downstream
 * Lot) and saves its latest keyframe that decodes cleanly. Everything goes in
 * /tmp. It reports the resolution, lost packets, the time taken and the peak
 * memory.
 *
 * STOP THE CAMERA SERVICE FIRST: two programs must never use the Ring login at
 * the same time. Needs ffmpeg:  sudo apt install -y --no-install-recommends ffmpeg
 *
 *   sudo systemctl stop nhrc-camera
 *   sudo -u nhrccam bash -c 'cd /opt/nhrc-camera && set -a && . ./env && set +a && node live_frame_test.js'
 *   sudo systemctl start nhrc-camera
 *
 * The live view runs for about 10-15 seconds and is the only part that uses
 * more battery than a snapshot. Nothing is uploaded; the website is untouched.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const S = require('./snapshot_service.js');

const CAMERA = process.argv[2] || S.CONFIG.backupCameraName || 'Downstream Lot';
const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || path.join(path.dirname(FFMPEG), 'ffprobe');
const OUT_DIR = process.env.LIVE_FRAME_OUT_DIR || '/tmp';
const RECORD_SECONDS = Number(process.env.LIVE_FRAME_RECORD_SECONDS || 10);   // several keyframes to choose from
const DEADLINE_SECONDS = Number(process.env.LIVE_FRAME_DEADLINE_SECONDS || 60);
const SERVICE_MEMORY_MB = 200;  // MemoryMax in nhrc-camera.service

const say = (...a) => console.log(...a);
const ffmpegLog = [];           // what ffmpeg said while recording, for lost-packet counts

/** Width and height from a JPEG's start-of-frame marker, or null. */
function jpegSize(buf) {
  let i = 2;
  while (buf && i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC5 && marker <= 0xC7) || (marker >= 0xC9 && marker <= 0xCB)
        || (marker >= 0xCD && marker <= 0xCF)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** The camera service must not be running: it holds the same Ring login. */
function serviceRunning() {
  const r = spawnSync('systemctl', ['is-active', 'nhrc-camera'], { encoding: 'utf8' });
  return !r.error && String(r.stdout).trim() === 'active';
}

/** Peak memory (KB) of any ffmpeg this process has started, read from /proc. */
function ffmpegPeakKb() {
  let peak = 0;
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)); } catch (e) { return 0; }
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (name !== 'ffmpeg' || ppid !== process.pid) continue;
      const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      if (m) peak = Math.max(peak, Number(m[1]));
    } catch (e) { /* gone */ }
  }
  return peak;
}

function report(label, buf, ms, file) {
  const d = jpegSize(buf);
  say(`  ${label.padEnd(11)}: ${d ? `${d.width} x ${d.height}` : 'size unreadable'}, ${(buf.length / 1024).toFixed(0)} KB, `
    + `${(ms / 1000).toFixed(1)} s  ->  ${file}`);
  return d;
}

async function main() {
  if (serviceRunning()) {
    throw new Error('The camera service is running and holds the Ring login. Stop it first: sudo systemctl stop nhrc-camera');
  }
  if (!fs.existsSync(FFMPEG)) {
    throw new Error(`ffmpeg is not installed (${FFMPEG}). Install it with: sudo apt install -y --no-install-recommends ffmpeg`);
  }
  const token = S.readToken();
  if (!token) throw new Error(`No Ring token at ${S.CONFIG.tokenFile} - run this with the service's settings (see the top of this file).`);

  if (!fs.existsSync(FFPROBE)) throw new Error(`ffprobe is not installed (${FFPROBE}); it comes with ffmpeg.`);

  // ring-client-api logs through its own logger, silent by default: show its
  // errors, so a failed live view says why, and keep what ffmpeg says while
  // recording (its debug output) to count lost packets.
  try {
    const util = await import('ring-client-api/util');
    util.useLogger({
      logInfo: (m) => { const s = String(m); if (s.startsWith('From Ring (')) ffmpegLog.push(s); },
      logError: (m) => console.error('  ring-client-api:', m && m.message ? m.message : m),
    });
  } catch (e) { /* older versions: no logger hook */ }

  const { RingApi } = await import('ring-client-api');
  const api = new RingApi({
    refreshToken: token,
    cameraStatusPollingSeconds: 0,
    locationModePollingSeconds: 0,
    controlCenterDisplayName: 'NHRC Boathouse Camera',
    ffmpegPath: FFMPEG,
    debug: true,          // routes ffmpeg's own messages to the logger above
  });
  // Same rule as the service: every rotated token is saved, or the service
  // cannot sign in when it starts again.
  api.onRefreshTokenUpdated.subscribe(({ newRefreshToken }) => {
    try { S.writeToken(newRefreshToken); } catch (e) { console.error('COULD NOT SAVE THE ROTATED RING TOKEN:', e.message); }
  });

  const cams = await api.getCameras();
  // findCamera exists from the two-camera release on; before that, match the full name.
  const cam = typeof S.findCamera === 'function' ? S.findCamera(cams, CAMERA)
    : cams.find(c => String(c.name).trim().toLowerCase() === CAMERA.trim().toLowerCase()) || null;
  if (!cam) throw new Error(`No camera "${CAMERA}". On this account: ${cams.map(c => `"${c.name}"`).join(', ')}`);
  say(`Camera "${cam.name}"${cam.model ? ` (${cam.model})` : ''}${cam.batteryLevel != null ? `, battery ${cam.batteryLevel}%` : ''}`);

  // 1. An ordinary snapshot, for comparison. Not fatal: the live view is the
  // point of the test.
  let t = Date.now();
  try {
    const snap = await cam.getSnapshot();
    const snapFile = path.join(OUT_DIR, 'test-snapshot.jpg');
    fs.writeFileSync(snapFile, snap);
    report('Snapshot', snap, Date.now() - t, snapFile);
  } catch (e) {
    say(`  Snapshot   : failed - ${e.message}`);
  }

  // 2. Live video. The first version decoded the picture WHILE the video
  // arrived; on a Pi Zero that was too slow, packets were dropped, and the
  // frame came out smeared. Now: record about RECORD_SECONDS of the video as
  // it comes, without decoding it (light work), then afterwards decode its
  // keyframes one by one and keep the latest one that decodes cleanly.
  const clipFile = path.join(OUT_DIR, 'test-live-clip.mkv');
  const frameFile = path.join(OUT_DIR, 'test-live-frame.jpg');
  for (const f of [clipFile, frameFile]) { try { fs.unlinkSync(f); } catch (e) { /* none yet */ } }
  t = Date.now();
  let peakFfmpegKb = 0;
  const sampler = setInterval(() => { peakFfmpegKb = Math.max(peakFfmpegKb, ffmpegPeakKb()); }, 200);
  // Where do packets go missing? Before they reach this program (the network,
  // or the Pi too busy to read them), or between this program and ffmpeg?
  const cpu0 = cpuTimes(), udp0 = udpErrors(), me0 = process.cpuUsage();
  const seen = new SequenceCounter();
  const call = await cam.startLiveCall();
  const ended = new Promise(r => call.onCallEnded.subscribe(() => r()));
  let rtpSub = null;
  try { rtpSub = call.onVideoRtp.subscribe((rtp) => seen.add(rtp && rtp.header && rtp.header.sequenceNumber)); }
  catch (e) { /* not available in this version */ }
  const deadline = setTimeout(() => {
    say(`  No video after ${DEADLINE_SECONDS} s - stopping the live view.`);
    call.stop();
  }, DEADLINE_SECONDS * 1000);
  await call.startTranscoding({
    // A big receive buffer for ffmpeg, as far as the system allows (net.core.rmem_max).
    input: ['-buffer_size', String(8 * 1024 * 1024)],
    audio: ['-an'],
    video: ['-vcodec', 'copy'],
    output: ['-t', String(RECORD_SECONDS), '-f', 'matroska', '-y', clipFile],
  });
  await ended;
  clearTimeout(deadline);
  clearInterval(sampler);
  if (rtpSub) { try { rtpSub.unsubscribe(); } catch (e) { /* gone */ } }
  const elapsed = Date.now() - t;
  const cpu1 = cpuTimes(), udp1 = udpErrors(), me = process.cpuUsage(me0);
  const lost = ffmpegLog.reduce((n, line) => n + [...line.matchAll(/missed (\d+) packets/g)].reduce((a, m) => a + Number(m[1]), 0), 0);
  if (!fs.existsSync(clipFile) || !fs.statSync(clipFile).size) {
    throw new Error('The live view gave no video (see any ring-client-api lines above).');
  }
  const keys = keyframeTimes(clipFile);
  say(`  Live video : ${(fs.statSync(clipFile).size / 1024).toFixed(0)} KB in ${(elapsed / 1000).toFixed(1)} s, `
    + `${keys.length} keyframe${keys.length === 1 ? '' : 's'}, ${lost} packet${lost === 1 ? '' : 's'} lost on the way  ->  ${clipFile}`);

  // The diagnosis.
  const busy = cpu0 && cpu1 ? 100 * (1 - (cpu1.idle - cpu0.idle) / Math.max(1, cpu1.total - cpu0.total)) : null;
  const mine = 100 * (me.user + me.system) / 1000 / Math.max(1, elapsed);
  const dropped = udp0 !== null && udp1 !== null ? udp1 - udp0 : null;
  say(`  Pi         : processor ${busy === null ? 'unknown' : busy.toFixed(0) + '%'} busy during the video `
    + `(this program ${mine.toFixed(0)}%); ${dropped === null ? 'buffer drops unknown' : `${dropped} packets dropped because a buffer was full`}; `
    + `buffers allowed up to ${rmemMaxKb() === null ? 'unknown' : rmemMaxKb() + ' KB'}`);
  say(`  Packets    : ${seen.received} reached this program, ${seen.missing} were already missing when they did`
    + `${seen.received ? ` (${(100 * seen.missing / (seen.received + seen.missing)).toFixed(0)}%)` : ''}`);
  if (seen.received && seen.missing === 0 && lost > 0) {
    say('  -> Everything reached this program; packets were lost between it and ffmpeg, inside the Pi.');
  } else if (seen.missing > 0 && dropped > 0) {
    say('  -> Packets were dropped by the Pi itself, its buffers full: it could not read them fast enough.');
  } else if (seen.missing > 0) {
    say('  -> Packets were missing before they reached the Pi: the network (Wi-Fi at either end, or the internet).');
  }

  // Latest first: the camera's exposure has settled by then.
  let chosen = null, clean = 0;
  const results = [];
  for (const k of keys.slice().reverse()) {
    const ok = await decodeKeyframe(clipFile, k, frameFile);
    results.push(`${k.toFixed(1)} s ${ok ? 'clean' : 'damaged'}`);
    if (ok) { clean++; if (chosen === null) { chosen = k; break; } }
  }
  if (chosen === null) {
    throw new Error(`None of the ${keys.length} keyframes decoded cleanly (${results.join(', ')}). `
      + (lost ? `${lost} packets were lost between the camera and ffmpeg.` : 'No lost packets were reported.'));
  }
  const live = report('Live frame', fs.readFileSync(frameFile), elapsed, frameFile);
  say(`               from the keyframe at ${chosen.toFixed(1)} s (checked, latest first: ${results.join(', ')})`);

  const nodeMb = process.resourceUsage().maxRSS / 1024;
  const recMb = peakFfmpegKb / 1024, decMb = decodePeakKb / 1024;
  const mb = (v) => (v ? `${v.toFixed(0)} MB` : 'unknown');
  say(`  Memory     : this program peaked at ${mb(nodeMb)}, ffmpeg at ${mb(recMb)} recording and ${mb(decMb)} decoding`
    + ` (at most ${(nodeMb + Math.max(recMb, decMb)).toFixed(0)} MB together; the service may use up to ${SERVICE_MEMORY_MB} MB)`);
  if (live && (live.width <= 640)) say('  The live frame is no sharper than a snapshot on this camera.');
  try { api.disconnect(); } catch (e) { /* exiting anyway */ }
}

/** Counts RTP packets by sequence number (16-bit, wrapping) and how many are missing. */
class SequenceCounter {
  constructor() { this.seqs = new Set(); this.last = null; this.cycles = 0; }
  add(seq) {
    if (typeof seq !== 'number') return;
    if (this.last !== null && seq < this.last && this.last - seq > 30000) this.cycles++;   // wrapped
    this.last = seq;
    this.seqs.add(this.cycles * 65536 + seq);
  }
  get received() { return this.seqs.size; }
  get missing() {
    if (!this.seqs.size) return 0;
    let lo = Infinity, hi = -Infinity;
    for (const s of this.seqs) { if (s < lo) lo = s; if (s > hi) hi = s; }
    return hi - lo + 1 - this.seqs.size;
  }
}

/** The whole processor's time so far, from /proc/stat: { idle, total } in ticks, or null. */
function cpuTimes() {
  try {
    const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    return { idle: f[3] + (f[4] || 0), total: f.reduce((a, b) => a + b, 0) };
  } catch (e) { return null; }
}

/** UDP packets the system dropped because a receive buffer was full (RcvbufErrors), or null. */
function udpErrors() {
  try {
    const lines = fs.readFileSync('/proc/net/snmp', 'utf8').split('\n').filter(l => l.startsWith('Udp:'));
    const names = lines[0].trim().split(/\s+/), values = lines[1].trim().split(/\s+/);
    const i = names.indexOf('RcvbufErrors');
    return i > 0 ? Number(values[i]) : null;
  } catch (e) { return null; }
}

function rmemMaxKb() {
  try { return Math.round(Number(fs.readFileSync('/proc/sys/net/core/rmem_max', 'utf8')) / 1024); } catch (e) { return null; }
}

/** Keyframe timestamps (seconds) in a recorded clip. */
function keyframeTimes(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return String(r.stdout || '').split('\n').map(s => s.trim()).filter(s => s && s !== 'N/A')
    .map(Number).filter(Number.isFinite);
}

/**
 * Decodes the keyframe at `t` to a JPEG, refusing a damaged one: with lost
 * packets the decoder reports errors (and would otherwise smear the last good
 * row down the picture, as in the first test). Measures its peak memory too:
 * decoding a 1080p picture is the heaviest step.
 */
let decodePeakKb = 0;
function decodeKeyframe(file, t, out) {
  try { fs.unlinkSync(out); } catch (e) { /* none */ }
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, ['-v', 'error', '-xerror', '-err_detect', 'explode', '-skip_frame', 'nokey',
      '-ss', String(t), '-i', file, '-frames:v', '1', '-q:v', '2', '-y', out]);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    const sample = setInterval(() => {
      try {
        const m = /VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${p.pid}/status`, 'utf8'));
        if (m) decodePeakKb = Math.max(decodePeakKb, Number(m[1]));
      } catch (e) { /* finished */ }
    }, 25);
    p.on('close', (code) => {
      clearInterval(sample);
      resolve(code === 0 && !stderr.trim() && fs.existsSync(out) && fs.statSync(out).size > 0);
    });
  });
}

main().then(() => process.exit(0), (e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
