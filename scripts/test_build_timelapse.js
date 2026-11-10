#!/usr/bin/env node
/**
 * Tests for scripts/build_timelapse.js - each day's frames into the video on
 * roworno.com/newboathouse - with real ffmpeg and the real Worker code
 * (in-memory R2, served on 127.0.0.1: scripts/worker_harness.js). No network.
 *
 * Run: node scripts/test_build_timelapse.js        (TEST_ONLY=<regex> runs some)
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const B = require('./build_timelapse.js');
const { memoryR2, serveWorker } = require('./worker_harness.js');

const ONLY = process.env.TEST_ONLY ? new RegExp(process.env.TEST_ONLY) : null;
let passed = 0, failed = 0, skipped = 0;
const queue = [];
function test(name, fn, ms = 60000) { if (!ONLY || ONLY.test(name)) queue.push([name, fn, ms]); }
function section(title) { queue.push([title, null]); }
async function run() {
  for (const [name, fn, ms] of queue) {
    if (!fn) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); continue; }
    try {
      const r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms / 1000} s`)), ms).unref())]);
      if (r === 'skip') { skipped++; console.log(`  SKIP  ${name}`); continue; }
      passed++; console.log(`  PASS  ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${String((e && e.message) || e).split('\n').slice(0, 12).join('\n        ')}`);
    }
  }
  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}${ONLY ? ` (only ${ONLY})` : ''}`);
  console.log('='.repeat(60));
  process.exitCode = failed ? 1 : 0;
}

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const HAVE_FONT = fs.existsSync(B.FONT);
// Without them (a laptop without ffmpeg), the video tests are skipped - and
// said so; on GitHub, where the workflow installs both, they always run.
const needVideo = () => (HAVE_FFMPEG && HAVE_FONT ? null : 'skip');
if (process.env.GITHUB_ACTIONS === 'true' && !(HAVE_FFMPEG && HAVE_FONT)) {
  test('ffmpeg and the font are installed on GitHub\'s runner', () => { assert.fail(`ffmpeg ${HAVE_FFMPEG}, font ${HAVE_FONT}`); });
}

const ET = (iso) => new Date(iso);   // instants are written with their offset
const today = () => B.localParts(new Date()).day;
const etDay = (n = 0) => B.dayBefore(today(), -n);
const PI_SECRET = 'a'.repeat(64), BUILDER_SECRET = 'b'.repeat(64);

// ═══════════════════════════════════════════════════════════════════════════
section('1. The words in the corner, and when a day is ready');
// ═══════════════════════════════════════════════════════════════════════════

test('the stamp: weekday, date and the boathouse\'s own time, 12-hour', () => {
  assert.strictEqual(B.stampText('2026-11-09', '0705'), 'Mon, Nov 9, 2026 · 7:05 AM');
  assert.strictEqual(B.stampText('2026-11-09', '1200'), 'Mon, Nov 9, 2026 · 12:00 PM');
  assert.strictEqual(B.stampText('2026-11-09', '0000'), 'Mon, Nov 9, 2026 · 12:00 AM');
  assert.strictEqual(B.stampText('2026-11-09', '1615'), 'Mon, Nov 9, 2026 · 4:15 PM');
  assert.strictEqual(B.stampText('2026-11-09', '2359'), 'Mon, Nov 9, 2026 · 11:59 PM');
  assert.strictEqual(B.stampText('2027-01-01', '0720'), 'Fri, Jan 1, 2027 · 7:20 AM');
  assert.strictEqual(B.stampText('2028-02-29', '1300'), 'Tue, Feb 29, 2028 · 1:00 PM');
  // The day daylight saving starts: the Pi names frames by the clock on the wall.
  assert.strictEqual(B.stampText('2027-03-14', '0715'), 'Sun, Mar 14, 2027 · 7:15 AM');
});

test('days and the boathouse\'s clock - across month ends, years and daylight saving', () => {
  assert.strictEqual(B.dayBefore('2026-03-01'), '2026-02-28');
  assert.strictEqual(B.dayBefore('2027-01-01', 3), '2026-12-29');
  assert.strictEqual(B.dayBefore('2026-11-10', -1), '2026-11-11');
  assert.deepStrictEqual(B.localParts(ET('2026-11-01T05:30:00Z')), { day: '2026-11-01', minutes: 90 });   // 1:30 AM EDT
  assert.deepStrictEqual(B.localParts(ET('2026-11-01T06:30:00Z')), { day: '2026-11-01', minutes: 90 });   // 1:30 AM EST, again
  assert.deepStrictEqual(B.localParts(ET('2026-11-10T04:59:00Z')), { day: '2026-11-09', minutes: 23 * 60 + 59 });
  assert.deepStrictEqual(B.localParts(ET('2027-03-14T07:00:00Z')), { day: '2027-03-14', minutes: 180 });   // 3:00 AM EDT
});

test('a day is ready when a Pi says it has sent all its frames; else from 6 AM the next day; never while still filmed', () => {
  const at = (iso) => ET(iso);
  const day = '2026-11-09';
  assert.deepStrictEqual(B.dayReady(day, { main: { frames: 112 } }, at('2026-11-09T22:00:00Z')).ready, true, 'the evening it was filmed');
  assert.ok(/the main Pi/.test(B.dayReady(day, { main: { frames: 1 } }, at('2026-11-09T22:00:00Z')).why));
  assert.ok(/the standby Pi/.test(B.dayReady(day, { main: null, standby: { frames: 1 } }, at('2026-11-09T22:00:00Z')).why));
  assert.strictEqual(B.dayReady(day, { main: null, standby: null }, at('2026-11-09T22:00:00Z')).ready, false);
  assert.ok(/still being filmed/.test(B.dayReady(day, null, at('2026-11-09T22:00:00Z')).why));
  assert.strictEqual(B.dayReady(day, null, at('2026-11-10T10:59:00Z')).ready, false, '5:59 AM the next day');
  assert.ok(/waiting until 6 AM/.test(B.dayReady(day, null, at('2026-11-10T10:59:00Z')).why));
  assert.strictEqual(B.dayReady(day, null, at('2026-11-10T11:00:00Z')).ready, true, '6:00 AM the next day');
  assert.strictEqual(B.dayReady('2026-11-07', null, at('2026-11-10T03:00:00Z')).ready, true, 'older days');
  assert.strictEqual(B.dayReady('2026-11-11', { main: { frames: 1 } }, at('2026-11-10T03:00:00Z')).ready, false, 'a day to come');
  // 6 AM by the wall clock, the morning after daylight saving ends (EST) and starts (EDT).
  assert.strictEqual(B.dayReady('2026-10-31', null, at('2026-11-01T10:59:00Z')).ready, false);
  assert.strictEqual(B.dayReady('2026-10-31', null, at('2026-11-01T11:00:00Z')).ready, true);
  assert.strictEqual(B.dayReady('2027-03-13', null, at('2027-03-14T09:59:00Z')).ready, false);
  assert.strictEqual(B.dayReady('2027-03-13', null, at('2027-03-14T10:00:00Z')).ready, true);
});

test('what a video is made from: names and sizes, in any order; any change is a new set', () => {
  const a = [{ name: '0700.jpg', size: 10 }, { name: '0705.jpg', size: 20 }];
  assert.strictEqual(B.frameSet(a), B.frameSet([a[1], a[0]]));
  assert.ok(/^[0-9a-f]{12}$/.test(B.frameSet(a)));
  assert.notStrictEqual(B.frameSet(a), B.frameSet([a[0], { name: '0705.jpg', size: 21 }]));
  assert.notStrictEqual(B.frameSet(a), B.frameSet([...a, { name: '0710.jpg', size: 5 }]));
});

test('the index: the day\'s entry replaces any before it; newest first', () => {
  const idx = { days: [{ date: '2026-11-07', video: 'a' }, { date: '2026-11-08', video: 'b' }, null] };
  const out = B.mergeIndex(idx, { date: '2026-11-08', video: 'c' });
  assert.deepStrictEqual(out.days.map((d) => [d.date, d.video]), [['2026-11-08', 'c'], ['2026-11-07', 'a']]);
  assert.deepStrictEqual(B.mergeIndex(null, { date: '2026-11-09' }).days.map((d) => d.date), ['2026-11-09']);
  assert.deepStrictEqual(B.mergeIndex({ days: 'junk' }, { date: '2026-11-09' }).days.map((d) => d.date), ['2026-11-09']);
});

test('the poster is the frame nearest noon; a value in an ffmpeg filter is escaped', () => {
  assert.strictEqual(B.posterIndex(['0700', '1150', '1215', '1600']), 1);
  assert.strictEqual(B.posterIndex(['0700', '1155', '1205']), 1, 'a tie: the earlier');
  assert.strictEqual(B.posterIndex(['1300']), 0);
  assert.strictEqual(B.filterValue("/a:b\\c'd"), "/a\\:b\\\\c\\'d");
});

test('soft frames (under 720 lines) are left out of a day\'s video - unless the day has fewer than 2 sharp ones', () => {
  const f = (n, w, h) => ({ name: `${n}.jpg`, width: w, height: h });
  let r = B.sharpFrames([f('0700', 1280, 720), f('0705', 848, 480), f('0710', 1920, 1080), f('0715', 0, 0)]);
  assert.deepStrictEqual([r.keep.map((x) => x.name), r.soft.map((x) => x.name)], [['0700.jpg', '0710.jpg'], ['0705.jpg', '0715.jpg']]);
  r = B.sharpFrames([f('0700', 1280, 720), f('0705', 848, 480), f('0710', 848, 480)]);
  assert.deepStrictEqual([r.keep.length, r.soft], [3, []], 'one sharp frame: all kept rather than a one-frame video');
});

test('the continuous timelapse: each quarter hour\'s sharpest frame; of equals, the one nearest the quarter; empty quarters skipped', () => {
  const f = (n, w, h) => ({ name: `${n}.jpg`, width: w, height: h });
  const picks = B.slotPicks([
    f('0700', 1280, 720), f('0705', 1920, 1080), f('0710', 1280, 720),      // 7:00-7:14: the 1080
    f('0715', 848, 480), f('0720', 1280, 720), f('0725', 1280, 720),       // 7:15-7:29: 7:20, nearest 7:15 of the sharp
    f('0730', 1280, 720), f('0735', 1280, 720),                            // 7:30-7:44: 7:30
    f('0800', 640, 360),                                                   // 8:00-8:14: soft, but all there is
    f('1214', 1280, 720), f('1215', 1280, 720),                            // either side of 12:15
  ]);
  assert.deepStrictEqual(picks.map((x) => x.name), ['0705.jpg', '0720.jpg', '0730.jpg', '0800.jpg', '1214.jpg', '1215.jpg']);
  // A whole day at 5 minutes: one in three.
  const day = Array.from({ length: 108 }, (_, i) => { const m = 7 * 60 + i * 5; return f(`${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`, 1280, 720); });
  assert.strictEqual(B.slotPicks(day).length, 36);
  assert.deepStrictEqual(B.slotPicks([]), []);
});

test('the continuous timelapse is kept in chunks from the 1st, 11th and 21st - month ends and leap days included', () => {
  const cases = { '2026-11-01': '2026-11-01', '2026-11-10': '2026-11-01', '2026-11-11': '2026-11-11', '2026-11-20': '2026-11-11',
    '2026-11-21': '2026-11-21', '2026-11-30': '2026-11-21', '2026-12-31': '2026-12-21', '2028-02-29': '2028-02-21', '2027-01-01': '2027-01-01' };
  for (const [d, start] of Object.entries(cases)) assert.strictEqual(B.chunkStart(d), start, d);
  const idx = { days: [{ date: '2026-11-11', set: 'a1', timeline: '0700' }, { date: '2026-11-09', set: 'b2', timeline: '0700,0715' },
    { date: '2026-11-10', set: 'c3' }, { date: '2026-11-02', set: 'd4', timeline: '1200' }, null, { date: 'junk', timeline: '0700' }] };
  const by = B.chunkDays(idx);
  assert.deepStrictEqual([...by.keys()], ['2026-11-01', '2026-11-11']);
  assert.deepStrictEqual(by.get('2026-11-01').map((d) => d.date), ['2026-11-02', '2026-11-09'], 'in order; a day with no timeline left out');
});

test('a JPEG\'s size is read from its header, whatever kind of JPEG; anything else is no size', () => {
  if (needVideo()) return 'skip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-size-'));
  for (const [size, extra] of [['1920x1080', []], ['848x480', []], ['1280x720', ['-q:v', '2']]]) {
    const f = path.join(dir, `${size}.jpg`);
    const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${size}`, '-frames:v', '1', ...extra, '-y', f]);
    assert.strictEqual(r.status, 0);
    const [w, h] = size.split('x').map(Number);
    assert.deepStrictEqual(B.jpegSize(fs.readFileSync(f)), { width: w, height: h });
  }
  assert.strictEqual(B.jpegSize(Buffer.from('not a picture at all, just words')), null);
  assert.strictEqual(B.jpegSize(Buffer.alloc(0)), null);
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. The video, made with real ffmpeg');
// ═══════════════════════════════════════════════════════════════════════════

/** A frame like Ring's: a flat grey picture of the given size, as JPEG. */
function frame(file, size = '1280x720', grey = 128) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${grey.toString(16).padStart(2, '0').repeat(3)}:s=${size}`,
    '-frames:v', '1', '-q:v', '3', '-y', file]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  return file;
}
/** Grey pixel values of a region of an image: { mean, spread } (spread = max - min). */
function region(file, w, h, x, y) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},format=gray`, '-f', 'rawvideo', '-']);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const px = r.stdout;
  let sum = 0, min = 255, max = 0;
  for (const v of px) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  return { mean: sum / px.length, spread: max - min, bytes: px };
}
/**
 * What is drawn on a grey picture in a region of its first frame: where (the
 * box around every pixel off the grey, in the whole picture's coordinates), and
 * how many of its pixels are yellow, near black and near white.
 */
function marks(file, w, h, x0, y0, grey = 128) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `crop=${w}:${h}:${x0}:${y0},format=rgb24`, '-f', 'rawvideo', '-']);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const px = r.stdout;
  const m = { x: Infinity, y: Infinity, x2: -1, y2: -1, yellow: 0, black: 0, white: 0, bytes: px };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3, red = px[i], green = px[i + 1], blue = px[i + 2];
      if (Math.max(Math.abs(red - grey), Math.abs(green - grey), Math.abs(blue - grey)) > 40) {
        m.x = Math.min(m.x, x0 + x); m.x2 = Math.max(m.x2, x0 + x); m.y = Math.min(m.y, y0 + y); m.y2 = Math.max(m.y2, y0 + y);
      }
      if (red > 170 && green > 140 && blue < 90) m.yellow++;
      if (red + green + blue < 120) m.black++;
      if (red > 225 && green > 225 && blue > 225) m.white++;
    }
  }
  return m;
}
function dayOfFrames(sizes, { damaged = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-frames-'));
  const frames = sizes.map(([hhmm, size]) => {
    const file = path.join(dir, `${hhmm}.jpg`);
    if (damaged.includes(hhmm)) fs.writeFileSync(file, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]));
    else frame(file, size);
    return { name: `${hhmm}.jpg`, file };
  });
  return { dir, frames };
}

test('frames of every size Ring sends, into one 1280x720 H.264 video: a tenth of a second each, ready to play as it loads - the soft ones left out', async () => {
  if (needVideo()) return 'skip';
  const { frames } = dayOfFrames([['0705', '1920x1080'], ['0710', '1280x720'], ['0715', '848x480'], ['1200', '640x360'], ['1610', '1280x720']]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-'));
  const v = await B.buildVideo({ day: '2026-11-09', frames, workDir: work });
  assert.deepStrictEqual([v.frames, v.first, v.last, v.width, v.height, v.skipped], [3, '07:05', '16:10', 1280, 720, []]);
  assert.deepStrictEqual(v.soft, ['0715.jpg', '1200.jpg'], 'under 720 lines: out of the day\'s video');
  assert.ok(Math.abs(v.seconds - 0.3) < 0.05, String(v.seconds));
  // The continuous timelapse: each quarter hour's sharpest - a soft one only where nothing better was filmed.
  assert.deepStrictEqual(v.timeline, ['0705', '0715', '1200', '1610']);
  assert.strictEqual((await B.checkVideo(v.segment, 4)).width, 1280);
  assert.strictEqual(v.bytes, fs.statSync(v.video).size);
  // By name: ffprobe lists the fields in its own order, which can change between versions.
  const probe = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,profile,pix_fmt,color_range,width,height',
    '-of', 'json', v.video], { encoding: 'utf8' }).stdout).streams[0];
  assert.deepStrictEqual([probe.codec_name, probe.profile, probe.pix_fmt, probe.width, probe.height], ['h264', 'High', 'yuv420p', 1280, 720]);
  assert.notStrictEqual(probe.color_range, 'pc', 'limited range, as video for the web is');
  const posterSize = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', v.poster], { encoding: 'utf8' });
  assert.strictEqual(posterSize.stdout.trim(), '640,360');
  const head = fs.readFileSync(v.video).subarray(0, 4096).toString('latin1');
  assert.ok(head.indexOf('moov') > 0 && (head.indexOf('mdat') < 0 || head.indexOf('moov') < head.indexOf('mdat')), 'the index first');
});

/** A frame of four grey bands - 0, 64, 200 and 255 - as Ring's JPEGs are: full range. */
const BANDS = [0, 64, 200, 255];
function bandFrame(file) {
  const inputs = BANDS.flatMap((g) => ['-f', 'lavfi', '-i', `color=c=0x${g.toString(16).padStart(2, '0').repeat(3)}:s=320x720`]);
  const r = spawnSync('ffmpeg', ['-v', 'error', ...inputs, '-filter_complex', 'hstack=inputs=4', '-frames:v', '1', '-q:v', '2', '-y', file]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  return file;
}
/** Each band's level in a picture's first frame, decoded to RGB as a player shows it (the middle of each band, clear of the stamp and logo). */
function bandLevels(file, width = 1280) {
  const k = width / 1280;
  return BANDS.map((_, i) => {
    const crop = `crop=${Math.round(200 * k)}:${Math.round(120 * k)}:${Math.round((320 * i + 60) * k)}:${Math.round(300 * k)}`;
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `${crop},format=rgb24`, '-f', 'rawvideo', '-']);
    assert.strictEqual(r.status, 0, String(r.stderr));
    let sum = 0;
    for (const v of r.stdout) sum += v;
    return Math.round(sum / r.stdout.length);
  });
}

test('the levels members see: black stays black, white white, greys where they were - in every picture made, whatever ffmpeg made it', async () => {
  if (needVideo()) return 'skip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-levels-'));
  const frames = ['0700', '0715'].map((t) => ({ name: `${t}.jpg`, file: bandFrame(path.join(dir, `${t}.jpg`)) }));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-'));
  const v = await B.buildVideo({ day: '2026-11-09', frames, workDir: work });
  // A chunk joined as is, and one re-encoded (a piece made otherwise forces it).
  const odd = path.join(dir, 'odd.mp4');
  assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=10', '-frames:v', '4', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', odd]).status, 0);
  const copied = await B.joinSegments({ files: [v.segment, v.segment], frames: 4, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-join-')) });
  const again = await B.joinSegments({ files: [v.segment, odd], frames: 6, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-join-')) });
  assert.deepStrictEqual([copied.joined, again.joined], ['copied', 're-encoded']);
  // Wrong range handling moves black to 16, white to 235, 64 to 71 or 56, 200 to 188 or 214: never within these.
  const near = (got) => got[0] <= 6 && Math.abs(got[1] - 64) <= 6 && Math.abs(got[2] - 200) <= 6 && got[3] >= 249;
  for (const [name, file, width] of [['stamped frame', path.join(work, 'stamped', '0700.jpg'), 1280], ['poster', v.poster, 640],
    ['day video', v.video, 1280], ['piece', v.segment, 1280], ['chunk, joined', copied.file, 1280], ['chunk, re-encoded', again.file, 1280]]) {
    const got = bandLevels(file, width);
    assert.ok(near(got), `${name}: ${got.join(', ')} for ${BANDS.join(', ')}`);
  }
});

test('the date and time are on every frame, bottom right - each frame its own; the rest of the picture untouched', async () => {
  if (needVideo()) return 'skip';
  const { frames } = dayOfFrames([['0705', '1280x720'], ['0710', '1280x720']]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-'));
  await B.buildVideo({ day: '2026-11-09', frames, workDir: work });
  const [a, b] = ['0705.jpg', '0710.jpg'].map((f) => path.join(work, 'stamped', f));
  // Bottom right: the dark box and white letters. Top left: the plain grey picture.
  const corner = region(a, 420, 70, 1280 - 440, 720 - 80);
  assert.ok(corner.spread > 150, `letters on a dark box: spread ${corner.spread}`);
  assert.ok(corner.mean < 110, `a dark box: mean ${corner.mean.toFixed(0)} (the picture is 128)`);
  const plain = region(a, 400, 300, 0, 0);
  assert.ok(plain.spread < 12 && Math.abs(plain.mean - 128) < 6, `untouched: mean ${plain.mean.toFixed(0)}, spread ${plain.spread}`);
  assert.ok(!region(b, 420, 70, 1280 - 440, 720 - 80).bytes.equals(corner.bytes), 'the 7:10 frame says something else than the 7:05');
});

test('the club\'s logo, top right on every frame: 96 lines high, 24 from the edges, in its colours - the same on frames of every size', async () => {
  if (needVideo()) return 'skip';
  const { frames } = dayOfFrames([['0705', '1280x720'], ['0710', '1920x1080'], ['0715', '848x480']]);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-'));
  const v = await B.buildVideo({ day: '2026-11-09', frames, workDir: work });
  const [a, b, c] = ['0705', '0710', '0715'].map((t) => marks(path.join(work, 'stamped', `${t}.jpg`), 400, 200, 880, 0));
  // Its box: 113 x 96 at (1143, 24). The drawing inside, the logo's clear edge aside, about 104 x 88.
  assert.ok(a.x >= 1143 && a.x2 <= 1280 - 24 && a.y >= 24 && a.y2 <= 24 + 96, `in its box: x ${a.x}-${a.x2}, y ${a.y}-${a.y2}`);
  assert.ok(a.x2 - a.x > 95 && a.y2 - a.y > 80, `all of it, not a corner: ${a.x2 - a.x + 1} x ${a.y2 - a.y + 1}`);
  assert.ok(a.yellow > 150 && a.black > 100 && a.white > 1000, `its yellow banner, black letters, white edge: ${a.yellow}, ${a.black}, ${a.white}`);
  assert.ok(b.bytes.equals(a.bytes) && c.bytes.equals(a.bytes), 'the same logo on the 1080, the 720 and the 480 frame');
  // Nowhere else: the top left and the middle are the plain grey picture.
  for (const [w, h, x, y] of [[600, 300, 0, 0], [400, 200, 440, 260]]) {
    const plain = region(path.join(work, 'stamped', '0705.jpg'), w, h, x, y);
    assert.ok(plain.spread < 12 && Math.abs(plain.mean - 128) < 6, `untouched at ${x},${y}: mean ${plain.mean.toFixed(0)}, spread ${plain.spread}`);
  }
  // In what members see: the day's video, its piece of the continuous timelapse, the poster.
  for (const file of [v.video, v.segment]) {
    const m = marks(file, 400, 200, 880, 0);
    assert.ok(m.x >= 1141 && m.x2 <= 1258 && m.y >= 22 && m.y2 <= 122 && m.yellow > 100, `${path.basename(file)}: x ${m.x}-${m.x2}, y ${m.y}-${m.y2}, yellow ${m.yellow}`);
  }
  const p = marks(v.poster, 200, 100, 440, 0);
  assert.ok(p.x >= 570 && p.x2 <= 628 && p.yellow > 30, `poster: x ${p.x}-${p.x2}, yellow ${p.yellow}`);
});

test('no logo, no video - said plainly; a logo ffmpeg cannot read fails every frame, and ffmpeg\'s words say why', async () => {
  await assert.rejects(B.buildVideo({ day: '2026-11-09', frames: [], workDir: os.tmpdir(), font: __filename, logo: '/nowhere/logo.png' }),
    /the logo \/nowhere\/logo\.png is not there/);
  assert.throws(() => B.look('/nowhere/logo.png'), /the logo \/nowhere\/logo\.png is not there/);
  if (needVideo()) return 'skip';
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-logo-')), 'logo.png');
  fs.writeFileSync(bad, 'not a picture');
  const { frames } = dayOfFrames([['0705', '1280x720'], ['0710', '1280x720']]);
  await assert.rejects(B.buildVideo({ day: '2026-11-09', frames, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')), logo: bad }),
    /only 0 of the 2 frames could be read \(0705\.jpg, 0710\.jpg could not\); ffmpeg: \S/);
});

test('what is drawn on the frames is part of each day\'s set: another logo or stamp, and the days still on the Worker are made again', () => {
  const frames = [{ name: '0705.jpg', size: 20 }, { name: '0710.jpg', size: 30 }];
  assert.ok(B.LOGO.endsWith(path.join('map', 'nhrc-map.png')) && fs.existsSync(B.LOGO), 'the map\'s logo');
  const look = B.look();
  assert.ok(/^[0-9a-f]{12}$/.test(look) && B.look() === look, 'the same look on every run');
  // The filter (the stamp, the logo's size and place) and the logo's own bytes.
  const crypto = require('crypto');
  assert.strictEqual(look, crypto.createHash('sha256').update(B.stampFilter('font', 'text')).update(fs.readFileSync(B.LOGO)).digest('hex').slice(0, 12));
  assert.ok(/scale=-1:96:/.test(B.stampFilter('f', 't')) && /overlay=x=W-w-24:y=24:/.test(B.stampFilter('f', 't')));
  const other = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-look-')), 'logo.png');
  fs.writeFileSync(other, Buffer.concat([fs.readFileSync(B.LOGO), Buffer.from([0])]));
  assert.notStrictEqual(B.look(other), look, 'another logo, another look');
  assert.notStrictEqual(B.frameSet(frames, B.look(other)), B.frameSet(frames, look));
  // A day made before the logo (its set then: the frames alone) is made again too.
  const before = crypto.createHash('sha256').update('0705.jpg:20\n0710.jpg:30').digest('hex').slice(0, 12);
  assert.notStrictEqual(B.frameSet(frames, look), before);
});

test('a damaged frame is left out and named; too few readable frames is an error, not a video', async () => {
  if (needVideo()) return 'skip';
  let { frames } = dayOfFrames([['0705', '1280x720'], ['0710', '1280x720'], ['0715', '1280x720']], { damaged: ['0710'] });
  const v = await B.buildVideo({ day: '2026-11-09', frames, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')) });
  assert.deepStrictEqual([v.frames, v.skipped, v.first, v.last], [2, ['0710.jpg'], '07:05', '07:15']);
  ({ frames } = dayOfFrames([['0705', '1280x720'], ['0710', '1280x720']], { damaged: ['0710'] }));
  await assert.rejects(B.buildVideo({ day: '2026-11-09', frames, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')) }),
    /only 1 of the 2 frames could be read \(0710\.jpg could not\)/);
});

test('ffmpeg and ffprobe run with the PATH only: the Worker\'s secret never reaches the programs that read the pictures', async () => {
  if (needVideo()) return 'skip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-env-'));
  const seen = path.join(dir, 'env.txt');
  const real = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = path.join(dir, 'ffmpeg');
  fs.writeFileSync(wrapper, `#!/bin/sh\nenv >> '${seen}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const { frames } = dayOfFrames([['0705', '1280x720'], ['0710', '1280x720']]);
  const before = process.env.TIMELAPSE_SECRET;
  process.env.TIMELAPSE_SECRET = 'the-builder-secret-must-not-leak-0123456789';
  try {
    await B.buildVideo({ day: '2026-11-09', frames, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')), ffmpeg: wrapper });
  } finally {
    if (before === undefined) delete process.env.TIMELAPSE_SECRET; else process.env.TIMELAPSE_SECRET = before;
  }
  const env = fs.readFileSync(seen, 'utf8');
  assert.ok(env.length > 0 && /^PATH=/m.test(env), 'the wrapper ran');
  assert.ok(!/TIMELAPSE_SECRET|must-not-leak|GITHUB_TOKEN/.test(env), env);
  assert.deepStrictEqual(Object.keys(B.toolEnv()), ['PATH']);
});

test('no font, no video - said plainly', async () => {
  await assert.rejects(B.buildVideo({ day: '2026-11-09', frames: [], workDir: os.tmpdir(), font: '/nowhere/font.ttf' }),
    /the font \/nowhere\/font\.ttf is not there \(apt install fonts-dejavu-core/);
});

test('the check refuses a video that would not play while it loads, or has the wrong size or count', async () => {
  if (needVideo()) return 'skip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-check-'));
  const make = (name, args) => { const f = path.join(dir, name); const r = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=1280x720:r=10', '-frames:v', '20', ...args, '-y', f]); assert.strictEqual(r.status, 0, String(r.stderr)); return f; };
  const good = make('good.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']);
  assert.strictEqual((await B.checkVideo(good, 20)).width, 1280);
  await assert.rejects(B.checkVideo(good, 21), /20 frames for 21 photos/);
  const slow = make('slow.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  await assert.rejects(B.checkVideo(slow, 20), /the index is not at the front/);
  const small = path.join(dir, 'small.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=10', '-frames:v', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', small]);
  await assert.rejects(B.checkVideo(small, 20), /640x360/);
  // Full range (what a newer ffmpeg makes from JPEGs, left to itself), however ffprobe says it: refused.
  for (const [pix, range] of [['yuvj420p', 'pc'], ['yuv420p', 'pc'], ['yuvj420p', 'unknown']]) {
    const probe = path.join(dir, `ffprobe-${pix}-${range}`);
    fs.writeFileSync(probe, `#!/bin/sh\necho '${JSON.stringify({ streams: [{ codec_name: 'h264', width: 1280, height: 720, pix_fmt: pix,
      color_range: range, nb_read_frames: '20' }], format: { duration: '2.000000' } })}'\n`, { mode: 0o755 });
    await assert.rejects(B.checkVideo(good, 20, probe), new RegExp(`${pix} \\(${range}\\), not yuv420p limited range`));
  }
});

test('days\' pieces join into one video without re-encoding: every frame there, in order, playing as it loads; a piece made otherwise is refused', async () => {
  if (needVideo()) return 'skip';
  const one = await B.buildVideo({ day: '2026-11-09', frames: dayOfFrames([['0700', '1280x720'], ['0715', '1920x1080'], ['0730', '1280x720']]).frames,
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')) });
  const two = await B.buildVideo({ day: '2026-11-10', frames: dayOfFrames([['0800', '1280x720'], ['0815', '1280x720']]).frames,
    workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')) });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-join-'));
  const j = await B.joinSegments({ files: [one.segment, two.segment], frames: 5, workDir: work });
  assert.strictEqual(j.joined, 'copied');
  const out = j.file;
  assert.ok(Math.abs((await B.checkVideo(out, 5)).seconds - 0.5) < 0.05);
  const ts = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', out], { encoding: 'utf8' })
    .stdout.trim().split('\n').map((l) => l.split(','));
  assert.deepStrictEqual(ts.map((x) => Number(x[0]).toFixed(1)), ['0.0', '0.1', '0.2', '0.3', '0.4'], 'evenly, across the join');
  assert.ok(ts[3][1].startsWith('K'), 'the second day starts on a keyframe');
  // A piece encoded otherwise (another ffmpeg on GitHub one day; here, another size and B-frames) is never
  // copied in - it would break the video where it joins: the chunk is re-encoded, every frame kept.
  const odd = path.join(work, 'odd.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=10', '-frames:v', '4', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', odd]);
  assert.notStrictEqual(await B.encoding(odd), await B.encoding(one.segment));
  const k = await B.joinSegments({ files: [one.segment, odd], frames: 7, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-join-')) });
  assert.strictEqual(k.joined, 're-encoded');
  const info = await B.checkVideo(k.file, 7);
  assert.deepStrictEqual([info.width, info.height], [1280, 720]);
  const clean = spawnSync('ffmpeg', ['-v', 'error', '-i', k.file, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.strictEqual(clean.stderr.trim(), '', 'decodes cleanly from end to end');
  // And the copied one too.
  assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.trim(), '');
}, 90000);

// ═══════════════════════════════════════════════════════════════════════════
section('3. With the real Worker: made, sent, listed - once');
// ═══════════════════════════════════════════════════════════════════════════

/** The real Worker on 127.0.0.1, its R2 in memory; the builder's client for it. */
async function setUp(extra = {}) {
  const env = Object.assign({ UPLOAD_SECRET: PI_SECRET, TIMELAPSE_SECRET: BUILDER_SECRET, BUCKET: memoryR2() }, extra.env || {});
  const host = await serveWorker({ env, intercept: extra.intercept });
  const client = B.workerClient({ base: host.url, secret: extra.secret || BUILDER_SECRET, backoffMs: 0, timeoutMs: 20000 });
  const lines = [];
  const build = (opts = {}) => B.buildFromWorker(Object.assign({ client, say: (l) => lines.push(l) }, opts));
  /** Frames sent as a Pi sends them (its secret), and its "done". */
  const send = async (day, times, { done = 'main', size = '1280x720' } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-send-'));
    for (const t of times) {
      const body = fs.readFileSync(frame(path.join(dir, `${t}.jpg`), size));
      const r = await fetch(`${host.url}/timelapse/frames/${day}/${t}.jpg`, { method: 'PUT', body,
        headers: { Authorization: `Bearer ${PI_SECRET}`, 'Content-Type': 'image/jpeg', 'X-Camera-Pi': done || 'main' } });
      assert.strictEqual(r.status, 200, await r.text());
    }
    if (done) {
      const r = await fetch(`${host.url}/timelapse/frames/${day}/done-${done}.json`, { method: 'PUT', body: JSON.stringify({ frames: times.length }),
        headers: { Authorization: `Bearer ${PI_SECRET}`, 'Content-Type': 'application/json' } });
      assert.strictEqual(r.status, 200);
    }
  };
  const index = () => { const b = env.BUCKET.bytes('timelapse/index.json'); return b ? JSON.parse(b.toString()) : null; };
  return { env, host, client, lines, build, send, index, close: () => host.close() };
}
const at6pm = (day) => new Date(`${day}T23:00:00Z`);   // 6 or 7 PM at the boathouse

test('a day a Pi has finished: made, sent, listed - the public video plays in pieces, and the poster is there', async () => {
  if (needVideo()) return 'skip';
  const w = await setUp();
  try {
    const day = etDay(0);
    await w.send(day, ['0705', '0710', '1200', '1610']);
    const r = await w.build({ now: at6pm(day) });
    assert.deepStrictEqual([r.built.length, r.failed, r.waiting], [1, [], []], w.lines.join('\n'));
    const idx = w.index();
    const e = idx.days[0];
    assert.strictEqual(e.date, day);
    assert.deepStrictEqual([e.frames, e.first, e.last, e.width, e.height], [4, '07:05', '16:10', 1280, 720]);
    assert.ok(new RegExp(`^videos/${day}-[0-9a-f]{12}\\.mp4$`).test(e.video) && e.poster === e.video.replace('videos/', 'posters/').replace('.mp4', '.jpg'));
    assert.ok(w.lines.some((l) => new RegExp(`^${day}: made - 4 frames, 07:05 to 16:10, 0\\.4 s, [\\d.]+ MB; 3 frames for the continuous timelapse; took \\d+ s\\.$`).test(l)), w.lines.join('\n'));
    // As the page asks for it.
    const res = await fetch(`${w.host.url}/timelapse/${e.video}`, { headers: { Range: 'bytes=0-1' } });
    assert.strictEqual(res.status, 206);
    const whole = await fetch(`${w.host.url}/timelapse/${e.video}`);
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-dl-')), 'v.mp4');
    fs.writeFileSync(file, Buffer.from(await whole.arrayBuffer()));
    assert.strictEqual((await B.checkVideo(file, 4)).height, 720, 'what is served is the video');
    assert.strictEqual((await fetch(`${w.host.url}/timelapse/${e.poster}`)).status, 200);
    // And its piece of the continuous timelapse, in its chunk: public, every quarter hour's frame.
    const c = idx.timeline.chunks[0];
    assert.deepStrictEqual([idx.timeline.fps, idx.timeline.slotMinutes, c.start, c.frames, c.days], [10, 15, B.chunkStart(day), 3,
      [{ date: day, set: e.set, times: '0705,1200,1610' }]]);
    assert.strictEqual(e.timeline, '0705,1200,1610');
    const chunk = await fetch(`${w.host.url}/timelapse/${c.video}`);
    assert.strictEqual(chunk.status, 200);
    const cf = path.join(path.dirname(file), 'c.mp4');
    fs.writeFileSync(cf, Buffer.from(await chunk.arrayBuffer()));
    assert.strictEqual((await B.checkVideo(cf, 3)).width, 1280);
    assert.ok(w.env.BUCKET.keys().includes(`timelapse/segments/${day}.mp4`), 'its piece kept, for the chunk');
    assert.strictEqual((await fetch(`${w.host.url}/timelapse/segments/${day}.mp4`)).status, 401, 'not public');
    // Made once: the next run makes nothing.
    w.lines.length = 0;
    const again = await w.build({ now: at6pm(day) });
    assert.deepStrictEqual([again.built.length, again.failed.length, again.chunks], [0, 0, undefined], w.lines.join('\n'));
  } finally { await w.close(); }
}, 120000);

test('a late frame: the day is made again, and the video it replaces is deleted', async () => {
  if (needVideo()) return 'skip';
  const w = await setUp();
  try {
    const day = etDay(-1);
    await w.send(day, ['0705', '0710']);
    await w.build({ now: at6pm(etDay(0)) });
    const first = w.index().days[0];
    await w.send(day, ['1200'], { done: 'standby' });
    const r = await w.build({ now: at6pm(etDay(0)) });
    assert.strictEqual(r.built.length, 1, w.lines.join('\n'));
    const second = w.index().days[0];
    assert.strictEqual(second.frames, 3);
    assert.notStrictEqual(second.video, first.video);
    const keys = w.env.BUCKET.keys();
    assert.ok(!keys.includes(`timelapse/${first.video}`) && !keys.includes(`timelapse/${first.poster}`), 'the old one is gone');
    assert.ok(keys.includes(`timelapse/${second.video}`) && keys.includes(`timelapse/${second.poster}`));
    assert.ok(w.lines.some((l) => /\(made again: its frames, or what is drawn on them, had changed\)/.test(l)), w.lines.join('\n'));
  } finally { await w.close(); }
}, 120000);

test('a day made with another logo is made again while its frames are on the Worker - its chunk too, once - and members see the club\'s', async () => {
  if (needVideo()) return 'skip';
  const w = await setUp();
  try {
    const day = etDay(-1);
    await w.send(day, ['0705', '0710']);
    const old = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-oldlogo-')), 'old.png');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=40x40', '-frames:v', '1', '-y', old]);
    assert.strictEqual(made.status, 0, String(made.stderr));
    let r = await w.build({ now: at6pm(etDay(0)), tools: { logo: old } });
    assert.strictEqual(r.built.length, 1, w.lines.join('\n'));
    const first = w.index().days[0];
    const firstChunk = w.index().timeline.chunks[0].video;
    w.lines.length = 0;
    r = await w.build({ now: at6pm(etDay(0)) });
    assert.deepStrictEqual([r.built.map((x) => x.date), r.chunks, r.failed], [[day], [B.chunkStart(day)], []], w.lines.join('\n'));
    assert.ok(w.lines.some((l) => /\(made again: its frames, or what is drawn on them, had changed\)/.test(l)), w.lines.join('\n'));
    const idx = w.index();
    assert.ok(idx.days[0].set !== first.set && idx.days[0].video !== first.video && idx.timeline.chunks[0].video !== firstChunk);
    const keys = w.env.BUCKET.keys();
    assert.ok(!keys.includes(`timelapse/${first.video}`) && !keys.includes(`timelapse/${firstChunk}`), 'the old videos are gone');
    // What members are served now carries the club's logo - its yellow banner, where the old one had none.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-dl-'));
    for (const p of [idx.days[0].video, idx.timeline.chunks[0].video]) {
      const res = await fetch(`${w.host.url}/timelapse/${p}`);
      assert.strictEqual(res.status, 200);
      const file = path.join(dir, path.basename(p));
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      const m = marks(file, 400, 200, 880, 0);
      assert.ok(m.yellow > 100 && m.x >= 1141, `${p}: yellow ${m.yellow}, x ${m.x}`);
    }
    // Once.
    r = await w.build({ now: at6pm(etDay(0)) });
    assert.deepStrictEqual([r.built.length, r.chunks, r.failed], [0, undefined, []], w.lines.join('\n'));
  } finally { await w.close(); }
}, 150000);

test('not yet: today\'s frames with no Pi done; yesterday\'s before 6 AM - and one frame alone makes no video', async () => {
  if (needVideo()) return 'skip';
  const w = await setUp();
  try {
    const [d0, d1, d2] = [etDay(0), etDay(-1), etDay(-2)];
    await w.send(d0, ['0705', '0710'], { done: null });
    await w.send(d1, ['0705', '0710'], { done: null });
    await w.send(d2, ['0705'], { done: 'main' });
    // A time at the boathouse today, whatever its offset from UTC (EST or EDT).
    const offsetH = (12 * 60 - B.localParts(new Date(`${d0}T12:00:00Z`)).minutes) / 60;
    const local = (hm) => new Date(Date.parse(`${d0}T${hm}:00Z`) + offsetH * 3600000);
    let r = await w.build({ now: local('05:00') });
    assert.deepStrictEqual(r.waiting.sort(), [d0, d1].sort(), w.lines.join('\n'));
    assert.deepStrictEqual(r.skipped, [d2]);
    assert.ok(w.lines.some((l) => l === `${d0}: not yet - still being filmed - no Pi has said it has sent all of its frames (2 frames so far).`), w.lines.join('\n'));
    assert.ok(w.lines.some((l) => new RegExp(`^${d1}: not yet - waiting until 6 AM`).test(l)));
    assert.strictEqual(w.index(), null, 'nothing made');
    r = await w.build({ now: local('06:00') });
    assert.deepStrictEqual(r.built.map((b) => b.date), [d1]);
  } finally { await w.close(); }
}, 120000);

/** A day of the index as the builder writes it (its video need not exist for these tests). */
const dayEntry = (date, set, timeline) => ({ date, video: `videos/${date}-0123456789ab.mp4`, poster: `posters/${date}-0123456789ab.jpg`,
  frames: 2, first: '07:00', last: '13:00', seconds: 0.2, bytes: 1000, width: 1280, height: 720, set, timeline });

test('the continuous timelapse: each chunk made from its days\' pieces - and made again only when one of its days changes', async () => {
  if (needVideo()) return 'skip';
  const w = await setUp();
  try {
    const entries = [];
    for (const [day, times] of [['2026-11-09', ['0700', '0715']], ['2026-11-10', ['0800']], ['2026-11-11', ['0900', '0915', '0930']]]) {
      const v = await B.buildVideo({ day, frames: dayOfFrames(times.map((t) => [t, '1280x720']).concat(times.length === 1 ? [['1300', '1280x720']] : [])).frames,
        workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')) });
      await w.client.putSegment(day, fs.readFileSync(v.segment));
      entries.push(dayEntry(day, `${day.replace(/-/g, '')}aa`, v.timeline.join(',')));
    }
    let index = { days: entries.slice().reverse() };
    const result = { failed: [] };
    index = await B.rebuildChunks({ client: w.client, index, result, say: (l) => w.lines.push(l) });
    assert.deepStrictEqual(result, { failed: [], chunks: ['2026-11-01', '2026-11-11'] }, w.lines.join('\n'));
    const t = w.index().timeline;
    assert.deepStrictEqual(t.chunks.map((c) => [c.start, c.frames, c.days.map((d) => d.date)]),
      [['2026-11-01', 4, ['2026-11-09', '2026-11-10']], ['2026-11-11', 3, ['2026-11-11']]]);
    const first = t.chunks[0].video, second = t.chunks[1].video;
    // Nothing changed: nothing made.
    let r2 = { failed: [] };
    index = await B.rebuildChunks({ client: w.client, index, result: r2, say: () => {} });
    assert.deepStrictEqual(r2, { failed: [] });
    // The 10th made again (a late frame): its chunk only - the old video deleted, the other chunk untouched.
    const v = await B.buildVideo({ day: '2026-11-10', frames: dayOfFrames([['0800', '1280x720'], ['0815', '1280x720'], ['1300', '1280x720']]).frames,
      workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-work-')) });
    await w.client.putSegment('2026-11-10', fs.readFileSync(v.segment));
    index = B.mergeIndex(index, dayEntry('2026-11-10', '20261110bb', v.timeline.join(',')));
    r2 = { failed: [] };
    index = await B.rebuildChunks({ client: w.client, index, result: r2, say: () => {} });
    assert.deepStrictEqual(r2.chunks, ['2026-11-01']);
    const after = w.index().timeline;
    assert.strictEqual(after.chunks[0].frames, 5);
    assert.notStrictEqual(after.chunks[0].video, first);
    assert.strictEqual(after.chunks[1].video, second);
    assert.ok(!w.env.BUCKET.keys().includes(`timelapse/${first}`) && w.env.BUCKET.keys().includes(`timelapse/${second}`));
    // A missing piece fails that chunk alone, said; the index keeps the chunk it had.
    await w.env.BUCKET.delete('timelapse/segments/2026-11-11.mp4');
    index = B.mergeIndex(index, dayEntry('2026-11-11', '20261111cc', '0900,0915,0930'));
    r2 = { failed: [] };
    await B.rebuildChunks({ client: w.client, index, result: r2, say: () => {} });
    assert.deepStrictEqual(r2.failed.map((f) => f.day), ['timelapse from 2026-11-11']);
    assert.ok(/segments\/2026-11-11\.mp4: the Worker answered HTTP 404/.test(r2.failed[0].error), r2.failed[0].error);
    assert.strictEqual(w.index().timeline.chunks[1].video, second);
  } finally { await w.close(); }
}, 150000);

test('frames are deleted from the Worker 3 days after their video - kept until then, and never kept past 30 days', async () => {
  if (needVideo()) return 'skip';
  const w = await setUp();
  try {
    const [d1, d3, d31] = [etDay(-1), etDay(-3), etDay(-31)];
    await w.send(d1, ['0705', '0710']);
    await w.send(d3, ['0705', '0710']);
    await w.env.BUCKET.put(`timelapse/frames/${d31}/0705.jpg`, 'old');     // older than a Pi may send: straight into storage
    const r = await w.build({ now: at6pm(etDay(0)) });
    assert.deepStrictEqual(r.built.map((b) => b.date).sort(), [d3, d1].sort(), w.lines.join('\n'));
    assert.deepStrictEqual(r.pruned.sort(), [d31, d3].sort());
    const keys = w.env.BUCKET.keys();
    assert.ok(keys.some((k) => k.startsWith(`timelapse/frames/${d1}/`)), 'yesterday\'s kept, for a late frame');
    assert.ok(!keys.some((k) => k.startsWith(`timelapse/frames/${d3}/`) || k.startsWith(`timelapse/frames/${d31}/`)));
    assert.deepStrictEqual(w.index().days.map((d) => d.date), [d1, d3], 'the videos stay');
  } finally { await w.close(); }
}, 120000);

test('nothing from the Worker reaches outside its day: odd days, file names and old addresses are left alone', async () => {
  if (needVideo()) return 'skip';
  const day = etDay(-1);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-odd-'));
  const good = fs.readFileSync(frame(path.join(dir, 'good.jpg')));
  const asked = [], removed = [];
  const segments = new Map();
  const client = {
    days: async () => ['../../etc', `${day}/../..`, 'not-a-day', day, 42],
    day: async (d) => { asked.push(`day ${d}`); return { frames: [{ name: '../../escape.jpg', size: 9 }, { name: '0705.jpg', size: good.length },
      { name: '0710.jpg', size: good.length }, { name: '0715.jpg/../../x', size: 1 }, null], done: { main: { frames: 2 } } }; },
    frame: async (d, n) => { asked.push(`frame ${d} ${n}`); return good; },
    index: async () => ({ days: [{ date: day, video: '../latest.jpg', poster: `posters/${etDay(-2)}-0123456789ab.jpg`, set: 'old' }] }),
    putVideo: async () => {}, putPoster: async () => {}, putIndex: async () => {}, putChunk: async () => {},
    putSegment: async (d, bytes) => { segments.set(d, bytes); }, segment: async (d) => segments.get(d),
    remove: async (p) => { removed.push(p); },
    dropFrames: async () => {},
  };
  const r = await B.buildFromWorker({ client, now: at6pm(etDay(0)), say: () => {} });
  assert.deepStrictEqual(r.built.map((b) => b.date), [day], JSON.stringify(r));
  assert.deepStrictEqual(asked, [`day ${day}`, `frame ${day} 0705.jpg`, `frame ${day} 0710.jpg`], 'only the real day, only its real frames');
  assert.deepStrictEqual(removed, [], 'an old entry that is not that day\'s own video is never deleted');
}, 60000);

test('--day makes that day now, whatever the Pis have said, even if made before', async () => {
  if (needVideo()) return 'skip';
  const w = await setUp();
  try {
    const day = etDay(0);
    await w.send(day, ['0705', '0710'], { done: null });
    let r = await w.build({ now: at6pm(day), onlyDay: day });
    assert.strictEqual(r.built.length, 1, w.lines.join('\n'));
    r = await w.build({ now: at6pm(day), onlyDay: day });
    assert.strictEqual(r.built.length, 1, 'again');
    assert.strictEqual(w.index().days.length, 1);
    assert.ok(w.lines.some((l) => new RegExp(`^${day}: made - .* \\(made again, as asked\\);`).test(l)), w.lines.join('\n'));
  } finally { await w.close(); }
}, 120000);

test('the Worker refusing the secret, or without TIMELAPSE_SECRET, or down: said, nothing half-done, a failure', async () => {
  let w = await setUp({ secret: 'c'.repeat(64) });
  try {
    await assert.rejects(w.build({ now: new Date() }), /GET \/timelapse\/frames\/: the Worker answered HTTP 401 \(Unauthorized\)/);
  } finally { await w.close(); }
  w = await setUp({ env: { TIMELAPSE_SECRET: undefined } });
  try {
    await assert.rejects(w.build({ now: new Date() }), /HTTP 503 \(The timelapse is not set up on this Worker: TIMELAPSE_SECRET is not set/);
  } finally { await w.close(); }
  w = await setUp();
  const url = w.host.url;
  await w.close();
  const client = B.workerClient({ base: url, secret: BUILDER_SECRET, backoffMs: 0, timeoutMs: 5000 });
  await assert.rejects(B.buildFromWorker({ client, say: () => {} }), /the Worker could not be reached \(ECONNREFUSED\)/);
}, 60000);

test('the index cannot be updated: that day fails (and is tried again next time) - the others go on', async () => {
  if (needVideo()) return 'skip';
  let failIndex = true;
  const w = await setUp({ intercept: (e) => (failIndex && e.method === 'PUT' && e.path === '/timelapse/index.json'
    ? { status: 500, body: 'R2 busy' } : null) });
  try {
    const day = etDay(-1);
    await w.send(day, ['0705', '0710']);
    let r = await w.build({ now: at6pm(etDay(0)) });
    // The day - and its chunk of the continuous timelapse, which also needs the index.
    assert.deepStrictEqual(r.failed.map((f) => f.day), [day, `timelapse from ${B.chunkStart(day)}`]);
    assert.ok(/PUT \/timelapse\/index\.json: the Worker answered HTTP 500 \(R2 busy\)/.test(r.failed[0].error), r.failed[0].error);
    assert.strictEqual(w.index(), null);
    assert.ok(!r.pruned.includes(day), 'its frames are kept for the next try');
    failIndex = false;
    r = await w.build({ now: at6pm(etDay(0)) });
    assert.deepStrictEqual(r.built.map((b) => b.date), [day]);
  } finally { await w.close(); }
}, 120000);

test('what a server says reaches GitHub\'s log as one line of plain text - never a "::" command of its own', async () => {
  const w = await setUp({ intercept: (e) => (e.method === 'GET' && /\/timelapse\/frames\/\S+\/$/.test(e.path)
    ? { status: 400, body: 'bad\n::error title=Injected::not from us\r\n::add-mask::x' } : null) });
  try {
    await w.env.BUCKET.put(`timelapse/frames/${etDay(-1)}/0705.jpg`, 'x');
    const r = await w.build({ now: at6pm(etDay(0)) });
    const err = r.failed[0].error;
    assert.ok(/HTTP 400 \(bad ::error title=Injected::not from us ::add-mask::x\)/.test(err), err);
    assert.ok(!/[\n\r]/.test(err) && w.lines.every((l) => !/\n::/.test(l)), JSON.stringify(err));
  } finally { await w.close(); }
}, 60000);

test('a frame the Worker cannot give is tried 3 times, then that day fails - said with the reason', async () => {
  if (needVideo()) return 'skip';
  let asked = 0;
  const w = await setUp({ intercept: (e) => (/\/0710\.jpg$/.test(e.path) && e.method === 'GET' ? (asked++, { status: 503, body: 'Storage unavailable' }) : null) });
  try {
    const day = etDay(-1);
    await w.send(day, ['0705', '0710']);
    const r = await w.build({ now: at6pm(etDay(0)) });
    assert.strictEqual(asked, 3);
    assert.ok(/GET \/timelapse\/frames\/\S+\/0710\.jpg: the Worker answered HTTP 503 \(Storage unavailable\)/.test(r.failed[0].error), r.failed[0].error);
  } finally { await w.close(); }
}, 60000);

// ═══════════════════════════════════════════════════════════════════════════
section('4. Run as GitHub runs it, and by hand');
// ═══════════════════════════════════════════════════════════════════════════

const SCRIPT = path.join(__dirname, 'build_timelapse.js');
const runScript = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8',
  env: Object.assign({}, process.env, { GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' }, env) });
/** The same, without blocking this process - which may be serving the Worker it talks to. */
const runScriptAsync = (args, env = {}) => new Promise((resolve) => {
  const child = require('child_process').spawn(process.execPath, [SCRIPT, ...args],
    { env: Object.assign({}, process.env, { GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' }, env) });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (status) => resolve({ status, stdout, stderr }));
});

test('without TIMELAPSE_SECRET: nothing made, said - and not a failure (before it is set up)', () => {
  const r = runScript([], { TIMELAPSE_SECRET: '', GITHUB_ACTIONS: 'true' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/TIMELAPSE_SECRET is not set: no timelapse made/.test(r.stdout));
  assert.ok(/^::notice::TIMELAPSE_SECRET is not set/m.test(r.stdout), 'a note on GitHub\'s run page');
});

test('--day must be a day', () => {
  const r = runScript(['--day', 'yesterday'], { TIMELAPSE_SECRET: BUILDER_SECRET });
  assert.strictEqual(r.status, 2);
  assert.ok(/--day needs a day like 2026-11-09/.test(r.stderr));
});

test('by hand, from a day\'s folder of frames (as the Mac keeps them): a video file, nothing sent', () => {
  if (needVideo()) return 'skip';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-local-'));
  for (const t of ['0705', '0710', '0715']) frame(path.join(dir, `2026-11-09_${t}.jpg`));
  fs.writeFileSync(path.join(dir, '2026-11-09_0720_snapshot.jpg'), 'x');
  const out = path.join(dir, 'day.mp4');
  const r = runScript(['--frames', dir, '--out', out], { TIMELAPSE_SECRET: '', TIMELAPSE_WORKER: 'http://127.0.0.1:9' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(/2026-11-09: \S+day\.mp4 - 3 frames, 07:05 to 07:15, 0\.3 s/.test(r.stdout), r.stdout);
  assert.ok(fs.statSync(out).size > 0);
  fs.writeFileSync(path.join(dir, '2026-11-10_0705.jpg'), fs.readFileSync(path.join(dir, '2026-11-09_0705.jpg')));
  const two = runScript(['--frames', dir], {});
  assert.strictEqual(two.status, 1);
  assert.ok(/frames of 2 days in .* one day's folder at a time/.test(two.stderr), two.stderr);
  const none = runScript(['--frames', fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-bt-empty-'))], {});
  assert.ok(/no frames named YYYY-MM-DD_HHMM\.jpg/.test(none.stderr));
});

test('the workflow: evenings and a morning, never for pull requests, read-only, the secret only where the videos are made', () => {
  const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'timelapse.yml'), 'utf8');
  const on = /\non:\n([\s\S]*?)\n\S/.exec(wf)[1];
  assert.deepStrictEqual([...on.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ['schedule', 'workflow_dispatch'], 'no pull_request, no push');
  assert.deepStrictEqual([...wf.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]), ['45 22 * * *', '15 1 * * *', '45 3 * * *', '30 11 * * *']);
  assert.ok(/\npermissions:\n {2}contents: read\n/.test(wf), 'reads the repository, writes nothing');
  assert.ok(/persist-credentials: false/.test(wf), 'no GitHub token left on the runner\'s disk');
  assert.strictEqual((wf.match(/secrets\.TIMELAPSE_SECRET/g) || []).length, 1, 'the secret goes to one step');
  const steps = wf.split(/\n {6}- name: /).slice(1);
  const build = steps.find((s) => /build_timelapse\.js/.test(s) && !/test_build/.test(s));
  assert.ok(/TIMELAPSE_SECRET: \$\{\{ secrets\.TIMELAPSE_SECRET \}\}/.test(build), 'and it is the build step');
  assert.ok(/\n {8}run: node scripts\/build_timelapse\.js \$\{DAY:\+--day "\$DAY"\}\n?$/.test(build), build);
  for (const s of steps) {
    const run = /\n {8}run: ([\s\S]*)$/.exec(s);
    assert.ok(!run || !/\$\{\{/.test(run[1]), `nothing typed into "Run workflow" is pasted into a command: ${s.split('\n')[0]}`);
  }
  const iTests = steps.findIndex((s) => /test_build_timelapse\.js/.test(s));
  assert.ok(iTests >= 0 && iTests < steps.indexOf(build), 'its tests first, on that runner');
  assert.ok(/fonts-dejavu-core/.test(wf) && /ffmpeg/.test(wf));
});

test('GitHub runs both timelapse suites at each push and every evening, with the clock moved and the network cut off', () => {
  const tests = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'tests.yml'), 'utf8');
  assert.ok(/\n {10}node scripts\/run_suite\.js node camera\/test_timelapse_web\.js \|\| fail=1\n/.test(tests));
  assert.ok(/\n {10}node scripts\/run_suite\.js node scripts\/test_build_timelapse\.js \|\| fail=1\n/.test(tests));
  assert.ok(/\n {10}node scripts\/run_suite\.js node scripts\/test_newboathouse\.js \|\| fail=1\n/.test(tests));
  assert.ok(/install -y -qq --no-install-recommends [^\n]*ffmpeg[^\n]*fonts-dejavu-core/.test(tests));
  const tt = fs.readFileSync(path.join(__dirname, 'test_time_travel.js'), 'utf8');
  assert.ok(/name: 'timelapse_web',\s+cmd: \['node', 'camera\/test_timelapse_web\.js'\]/.test(tt));
  assert.ok(/name: 'build_timelapse',\s+cmd: \['node', 'scripts\/test_build_timelapse\.js'\]/.test(tt));
  assert.ok(/name: 'newboathouse',\s+cmd: \['node', 'scripts\/test_newboathouse\.js'\]/.test(tt));
});

test('an index nearing the Worker\'s 1 MB is warned about well before it is refused - in the log and on GitHub\'s run page', async () => {
  const sent = [];
  const client = B.workerClient({ base: 'http://127.0.0.1:9', secret: BUILDER_SECRET, backoffMs: 0,
    fetchImpl: async (url, opts) => { sent.push(opts.body.length); return { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  const said = [];
  const log = console.log;
  const was = process.env.GITHUB_ACTIONS;
  console.log = (m) => said.push(String(m));
  process.env.GITHUB_ACTIONS = 'true';
  try {
    await client.putIndex({ days: [{ pad: 'x'.repeat(700 * 1024) }] });
    assert.deepStrictEqual(said, []);
    await client.putIndex({ days: [{ pad: 'x'.repeat(850 * 1024) }] });
  } finally {
    console.log = log;
    if (was === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = was;
  }
  assert.strictEqual(sent.length, 2, 'still sent');
  assert.ok(/^The timelapse's index is 850 KB, near the Worker's 1 MB limit/.test(said[0]), said.join('\n'));
  assert.ok(/^::warning::The timelapse's index is 850 KB/.test(said[1]), said.join('\n'));
});

test('on GitHub: a server\'s words never become a workflow command, even when the whole run fails', async () => {
  const w = await setUp({ intercept: (e) => (e.path === '/timelapse/frames/'
    ? { status: 401, body: 'Unauthorized\n::error title=Injected::from the server\n::add-mask::abc' } : null) });
  try {
    const r = await runScriptAsync([], { TIMELAPSE_SECRET: BUILDER_SECRET, TIMELAPSE_WORKER: w.host.url, GITHUB_ACTIONS: 'true' });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    const lines = (r.stdout + r.stderr).split('\n');
    assert.ok(!lines.some((l) => /^::(error title=Injected|add-mask)/.test(l)), lines.join('\n'));
    assert.ok(lines.some((l) => /^::error::GET \/timelapse\/frames\/: the Worker answered HTTP 401 \(Unauthorized ::error title=Injected::from the server ::add-mask::abc\)$/.test(l)), lines.join('\n'));
  } finally { await w.close(); }
}, 60000);

test('on GitHub: a failure is an annotation on the run page, and the job fails', async () => {
  const w = await setUp({ secret: 'c'.repeat(64) });
  try {
    const r = await runScriptAsync([], { TIMELAPSE_SECRET: 'c'.repeat(64), TIMELAPSE_WORKER: w.host.url, GITHUB_ACTIONS: 'true' });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.ok(/^::error::.*HTTP 401/m.test(r.stdout), r.stdout + r.stderr);
  } finally { await w.close(); }
}, 60000);

run();
