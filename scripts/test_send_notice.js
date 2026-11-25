#!/usr/bin/env node
/**
 * Tests for scripts/send_notice.js - the "no report today" notice the daily
 * email job sends when its tests, the build or the send fail - and for how the
 * job runs it. A stand-in for Buttondown; fixed instants; no network.
 *
 * Not among the email job's own tests on purpose: those decide whether the
 * report goes out, and the notice is what goes out when they fail. The job
 * runs these just before sending a notice (a broken notice stays unsent), and
 * GitHub runs them at each push and every evening (tests.yml).
 *
 * Run: node scripts/test_send_notice.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const N = require('./send_notice.js');

// daily_email.js, to check the notice against it - when it loads. The email
// job runs these when something failed, perhaps daily_email.js itself: then
// the checks against it are skipped (GitHub ran them at the last push) and the
// notice's own still run, so a broken daily_email.js cannot also stop the
// notice. Outside the email job (NOTICE_PREFLIGHT unset) a daily_email.js that
// does not load is a failure.
let M = null, mError = null;
try { M = require('./daily_email.js'); } catch (e) { mError = e; }
const PREFLIGHT = process.env.NOTICE_PREFLIGHT === '1';

let passed = 0, failed = 0, skipped = 0;
const failures = [];
const queue = [];
/** A test; needsM: it checks the notice against daily_email.js. */
function test(name, fn, { needsM = false } = {}) { queue.push([name, fn, needsM]); }
function section(title) { queue.push([title, null]); }
async function run() {
  if (!M) {
    console.log(`daily_email.js does not load (${mError && mError.message.split('\n')[0]}): the checks against it are skipped.`);
    if (!PREFLIGHT) { failed++; failures.push(['daily_email.js loads', mError]); console.log('  FAIL  daily_email.js loads'); }
  }
  for (const [name, fn, needsM] of queue) {
    if (!fn) { console.log(`\n${name}\n${'-'.repeat(name.length)}`); continue; }
    if (needsM && !M) { skipped++; console.log(`  SKIP  ${name}  (daily_email.js does not load)`); continue; }
    try {
      await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 20 s')), 20000).unref())]);
      passed++; console.log(`  PASS  ${name}`);
    } catch (e) {
      failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${String(e && e.message).split('\n').join('\n        ')}`);
    }
  }
  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
  console.log('='.repeat(60));
  process.exitCode = failed ? 1 : 0;
}

const at = (iso) => new Date(iso);
// 1:05 AM EST on 3 Nov 2026 - when the job would send.
const NIGHT = at('2026-11-03T06:05:00Z');
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, '’').replace(/&mdash;/g, '—').replace(/\s+/g, ' ').trim();

/** A stand-in Buttondown: today's emails as given (or a failure), and every request noted. */
function buttondown({ today = [], list = 'ok', post = 'ok' } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    if ((opts.method || 'GET') === 'GET') {
      if (list === 'throw') throw new TypeError('fetch failed');
      if (list === '500') return reply(500, 'busy');
      if (list === 'junk') return { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); }, text: async () => '<html>' };
      return reply(200, { results: today.map(slug => ({ slug })), count: today.length });
    }
    if (post === '500') return reply(500, '{"detail":"server error"}');
    return reply(201, { id: 'em_123', slug: JSON.parse(opts.body).slug });
  };
  return { fetch, calls };
}
async function withButtondown(bd, key, fn) {
  const realFetch = global.fetch, realKey = process.env.BUTTONDOWN_API_KEY, realLog = console.log;
  const lines = [];
  global.fetch = bd.fetch;
  if (key === null) delete process.env.BUTTONDOWN_API_KEY; else process.env.BUTTONDOWN_API_KEY = key;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { code: await fn(), lines }; } finally {
    console.log = realLog; global.fetch = realFetch;
    if (realKey === undefined) delete process.env.BUTTONDOWN_API_KEY; else process.env.BUTTONDOWN_API_KEY = realKey;
  }
}

section('1. The notice itself');

test('the words: no report today, the date, roworno.com, verify at the boathouse - and never a go-ahead', () => {
  const n = N.notice(NIGHT);
  assert.strictEqual(n.subject, 'NHRC Nov 3 - No conditions report today - check roworno.com');
  const text = plain(n.html);
  assert.ok(/^No conditions report today \(Tuesday, November 3\)\./.test(text), text);
  assert.ok(text.includes('could not be put together, so it has not been sent'), text);
  assert.ok(/check the water temperature, the river level, the weather and any alerts on roworno\.com/.test(text), text);
  assert.ok(text.includes('follow the Safety Committee’s rules as usual'), text);
  assert.ok(text.includes('always verify at the boathouse before launching'), 'the line every report carries');
  assert.ok(n.html.includes(`<a href="${N.SITE}"`) && N.SITE === 'https://roworno.com');
  assert.ok(!/\b(clear|safe|go|good to)\b/i.test(text + ' ' + n.subject), 'nothing that reads as a go-ahead');
  assert.ok(!/report.*(tomorrow|soon)/i.test(text), 'no promise it cannot keep');
});

test('the date is the boathouse\'s: 11:30 PM on the 2nd is still the 2nd, 12:30 AM the 3rd - in EDT and EST', () => {
  assert.ok(N.notice(at('2026-11-03T04:30:00Z')).subject.startsWith('NHRC Nov 2 - '));   // 11:30 PM EST, Nov 2
  assert.ok(N.notice(at('2026-11-03T05:30:00Z')).subject.startsWith('NHRC Nov 3 - '));   // 12:30 AM EST, Nov 3
  assert.ok(N.notice(at('2026-07-15T03:30:00Z')).subject.startsWith('NHRC Jul 14 - '));  // 11:30 PM EDT
  assert.ok(N.notice(at('2026-07-15T04:30:00Z')).subject.startsWith('NHRC Jul 15 - '));  // 12:30 AM EDT
});

test('its slug is the day\'s - the report\'s, as daily_email.js makes it - and "-no-report"', () => {
  for (const iso of ['2026-11-03T06:05:00Z', '2026-11-03T04:59:59Z', '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z', '2027-03-14T07:30:00Z', '2026-12-31T23:59:00Z']) {
    const now = at(iso);
    assert.strictEqual(N.daySlug(now), M.dailySlug(now), iso);
    assert.strictEqual(N.noticeSlug(now), `${M.dailySlug(now)}-no-report`, iso);
  }
}, { needsM: true });

section('2. Sending: at most one email a day');

test('in season, nothing out yet today: the notice is sent, once, as the report is', async () => {
  const bd = buttondown();
  const r = await withButtondown(bd, 'test-key', () => N.main(['--send'], NIGHT));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(bd.calls.map(c => c.method), ['GET', 'POST']);
  const [list, post] = bd.calls;
  assert.strictEqual(list.url, 'https://api.buttondown.com/v1/emails?creation_date__start=2026-11-03&excluded_fields=body');
  assert.strictEqual(list.headers.Authorization, 'Token test-key');
  assert.strictEqual(post.url, 'https://api.buttondown.com/v1/emails');
  assert.strictEqual(post.headers.Authorization, 'Token test-key');
  assert.strictEqual(post.headers['X-Buttondown-Live-Dangerously'], 'true');
  assert.strictEqual(post.headers['X-API-Version'], '2026-04-01');
  assert.deepStrictEqual(Object.keys(post.body).sort(), ['body', 'slug', 'status', 'subject']);
  assert.strictEqual(post.body.status, 'about_to_send');
  assert.strictEqual(post.body.slug, 'nhrc-2026-11-03-no-report');
  assert.strictEqual(post.body.subject, N.notice(NIGHT).subject);
  assert.ok(post.body.body.startsWith('<!-- buttondown-editor-mode: plaintext -->\n\n<div'), 'the report\'s mode: its HTML passes through');
  assert.ok(r.lines.some(l => /^Sent the notice: NHRC Nov 3 - No conditions report today/.test(l)), r.lines.join('\n'));
});

test('today\'s report already went out: no notice', async () => {
  for (const slug of ['nhrc-2026-11-03', 'nhrc-2026-11-03-2']) {
    const bd = buttondown({ today: ['something-else', slug] });
    const r = await withButtondown(bd, 'test-key', () => N.main(['--send'], NIGHT));
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual(bd.calls.map(c => c.method), ['GET'], slug);
    assert.ok(r.lines.some(l => /already went out - no notice/.test(l)));
  }
});

test('today\'s notice already went out (an earlier run): no second one', async () => {
  const bd = buttondown({ today: ['nhrc-2026-11-03-no-report'] });
  const r = await withButtondown(bd, 'test-key', () => N.main(['--send'], NIGHT));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(bd.calls.map(c => c.method), ['GET']);
});

test('yesterday\'s emails do not count: only slugs of today\'s date', async () => {
  const bd = buttondown({ today: ['nhrc-2026-11-02', 'nhrc-2026-11-02-no-report'] });
  const r = await withButtondown(bd, 'test-key', () => N.main(['--send'], NIGHT));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(bd.calls.map(c => c.method), ['GET', 'POST']);
});

test('Buttondown cannot say what went out today (down, an error, nonsense): no notice - rather than risk a second email', async () => {
  for (const list of ['throw', '500', 'junk']) {
    const bd = buttondown({ list });
    const r = await withButtondown(bd, 'test-key', () => N.main(['--send'], NIGHT));
    assert.strictEqual(r.code, 0, list);
    assert.deepStrictEqual(bd.calls.map(c => c.method), ['GET'], list);
    assert.ok(r.lines.some(l => /Could not check whether today's email already went out/.test(l)), list);
  }
});

test('the send itself fails: said, and the step fails (exit 1) - not taken for sent', async () => {
  const bd = buttondown({ post: '500' });
  await assert.rejects(withButtondown(bd, 'test-key', () => N.main(['--send'], NIGHT)), /Buttondown API 500/);
  const script = spawnSync(process.execPath, ['-e', `
    const N = require(${JSON.stringify(path.join(__dirname, 'send_notice.js'))});
    global.fetch = async (u, o) => (o && o.method === 'POST')
      ? { ok: false, status: 500, text: async () => 'down' }
      : { ok: true, status: 200, json: async () => ({ results: [] }) };
    process.env.BUTTONDOWN_API_KEY = 'k';
    N.main(['--send'], new Date('2026-11-03T06:05:00Z')).then(c => { process.exitCode = c; }, e => { console.error('send_notice failed: ' + e.message); process.exitCode = 1; });
  `], { encoding: 'utf8' });
  assert.strictEqual(script.status, 1, script.stdout + script.stderr);
});

test('any day of the year: there are no dates - the job runs it only when a report was due (not while Winter Rowing pauses the email)', async () => {
  // The days the March 15 - November 15 season used to leave out, and its edges.
  for (const iso of ['2026-11-16T06:05:00Z', '2027-01-15T06:05:00Z', '2027-03-14T06:05:00Z', '2026-11-15T06:05:00Z', '2027-03-15T06:05:00Z', '2026-07-15T05:05:00Z']) {
    const bd = buttondown();
    const r = await withButtondown(bd, 'test-key', () => N.main(['--send'], at(iso)));
    assert.strictEqual(r.code, 0, iso);
    assert.deepStrictEqual(bd.calls.map(c => c.method), ['GET', 'POST'], iso);
  }
});

test('no API key: says so, exit 1, nothing asked', async () => {
  const bd = buttondown();
  const r = await withButtondown(bd, null, () => N.main(['--send'], NIGHT));
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(bd.calls, []);
});

test('without --send it only prints the notice - nothing is asked or sent', async () => {
  const bd = buttondown();
  const r = await withButtondown(bd, 'test-key', () => N.main([], NIGHT));
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(bd.calls, []);
  assert.ok(r.lines.join('\n').includes('Subject: NHRC Nov 3 - No conditions report today - check roworno.com'));
});

test('once the notice is out, the report\'s own check counts it: a later run sends no report after it', async () => {
  const bd = buttondown({ today: [N.noticeSlug(NIGHT)] });
  const r = await withButtondown(bd, 'test-key', () => M.alreadySentToday(NIGHT));
  assert.deepStrictEqual(r.code, { known: true, found: true });
}, { needsM: true });

section('3. On its own: none of the code whose failure it reports');

test('it loads neither daily_email.js nor index.html - nor reads any file', () => {
  const src = fs.readFileSync(path.join(__dirname, 'send_notice.js'), 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  assert.deepStrictEqual(requires, [], 'no module at all, so no file can be read');
  // Until 25 Nov 2026 it read the season's dates from daily_email.js's text.
  assert.ok(!/readFileSync|readFile\(/.test(src), 'no file read');
});

test('with daily_email.js broken (it does not even parse), or gone, the notice still goes out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-notice-'));
  try {
    fs.copyFileSync(path.join(__dirname, 'send_notice.js'), path.join(dir, 'send_notice.js'));
    const real = fs.readFileSync(path.join(__dirname, 'daily_email.js'), 'utf8');
    fs.writeFileSync(path.join(dir, 'daily_email.js'), real + '\n}}} this is not javascript (\n');
    assert.notStrictEqual(spawnSync(process.execPath, ['--check', path.join(dir, 'daily_email.js')]).status, 0, 'it really is broken');
    // A stand-in Buttondown, in the process: nothing out today, the send accepted.
    const preload = path.join(dir, 'buttondown.js');
    fs.writeFileSync(preload, `globalThis.fetch = async (u, o) => (o && o.method === 'POST')
      ? { ok: true, status: 201, text: async () => '{"id":"em_1"}' }
      : { ok: true, status: 200, json: async () => ({ results: [] }) };`);
    const env = Object.assign({}, process.env, { BUTTONDOWN_API_KEY: 'k' });
    for (const gone of [false, true]) {
      if (gone) fs.unlinkSync(path.join(dir, 'daily_email.js'));
      let r = spawnSync(process.execPath, [path.join(dir, 'send_notice.js')], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(/Subject: NHRC \w{3} \d{1,2} - No conditions report today/.test(r.stdout), r.stdout);
      r = spawnSync(process.execPath, ['-r', preload, path.join(dir, 'send_notice.js'), '--send'], { encoding: 'utf8', env });
      assert.strictEqual(r.status, 0, `${gone ? 'gone' : 'broken'}: ${r.stdout}${r.stderr}`);
      assert.ok(/^Sent the notice: NHRC \w{3} \d{1,2} - No conditions report today/m.test(r.stdout), r.stdout);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

section('4. How the jobs run it');

const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'daily_email.yml'), 'utf8');
/** The workflow's steps as [name, text] - the text from its "- name:" line to the next. */
const steps = wf.split(/\n(?=      - name: )/).slice(1).map(s => [/^ {6}- name: (.*)/.exec(s)[1].trim(), s]);
const step = (name) => (steps.find(([n]) => n === name) || [])[1] || '';

test('the email job: when the tests, the build or the send failed - not on a dry run, not before the send window, not while Winter Rowing pauses the email - its tests, then the notice', () => {
  const names = steps.map(([n]) => n);
  const notice = 'No report today - tell the subscribers instead';
  assert.strictEqual(names[names.length - 1], notice, 'the last step');
  assert.ok(/\n {8}id: tests\n/.test(step('Run test suite')));
  assert.ok(/\n {8}id: build\n/.test(step('Build email (dry run preview)')));
  assert.ok(/\n {8}id: send\n/.test(step('Send via Buttondown')));
  // The pause is decided by the job's "Is a report due" step (daily_email.js --due), before the tests.
  assert.ok(/\n {8}id: due\n/.test(step('Is a report due tonight? (none during Winter Rowing)')));
  const s = step(notice);
  const cond = /\n {8}if: >-\n((?: {10}.*\n)+)/.exec(s);
  assert.ok(cond, s);
  assert.strictEqual(cond[1].replace(/\s+/g, ' ').trim(),
    "failure() && steps.gate.outputs.proceed == 'true' && github.event.inputs.dry_run != 'true' && " +
    "steps.due.outputs.paused != 'true' && " +
    "(steps.tests.outcome == 'failure' || steps.build.outcome == 'failure' || steps.send.outcome == 'failure')");
  assert.ok(/\n {10}BUTTONDOWN_API_KEY: \$\{\{ secrets\.BUTTONDOWN_API_KEY \}\}\n/.test(s));
  assert.ok(/\n {8}run: \|\n {10}NOTICE_PREFLIGHT=1 node scripts\/test_send_notice\.js\n {10}node scripts\/send_notice\.js --send\n?$/.test(s), s);
  // The email job's own tests stay what they were: not these.
  assert.ok(!/test_send_notice/.test(step('Run test suite')));
});

test('in the email job, with daily_email.js broken, these still pass - the checks against it skipped - so the notice goes out', () => {
  if (process.env.NOTICE_META === '1') return;   // this file, run below on a copy
  const repo = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-notice-job-'));
  try {
    for (const f of ['scripts/send_notice.js', 'scripts/test_send_notice.js', 'scripts/test_time_travel.js',
      '.github/workflows/daily_email.yml', '.github/workflows/tests.yml']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.copyFileSync(path.join(repo, f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, 'scripts', 'daily_email.js'),
      fs.readFileSync(path.join(__dirname, 'daily_email.js'), 'utf8') + '\n}}} this is not javascript (\n');
    const env = Object.assign({}, process.env, { NOTICE_META: '1' });
    delete env.NOTICE_PREFLIGHT;
    let r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'test_send_notice.js')],
      { encoding: 'utf8', env: Object.assign({}, env, { NOTICE_PREFLIGHT: '1' }) });
    assert.strictEqual(r.status, 0, r.stdout.slice(-1500) + r.stderr);
    assert.ok(/daily_email\.js does not load/.test(r.stdout), r.stdout);
    const skippedNow = /, (\d+) skipped/.exec(r.stdout);
    assert.ok(skippedNow && Number(skippedNow[1]) === queue.filter(q => q[2]).length, r.stdout.slice(-300));
    // Anywhere else - at a push, in the evening run - the same is a failure.
    r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'test_send_notice.js')], { encoding: 'utf8', env });
    assert.strictEqual(r.status, 1, r.stdout.slice(-500));
    assert.ok(/ {2}FAIL {2}daily_email\.js loads/.test(r.stdout));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GitHub runs these at each push and every evening, with the clock moved and the network cut off', () => {
  const tests = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'tests.yml'), 'utf8');
  assert.ok(/\n {10}node scripts\/run_suite\.js node scripts\/test_send_notice\.js \|\| fail=1\n/.test(tests));
  const tt = fs.readFileSync(path.join(__dirname, 'test_time_travel.js'), 'utf8');
  assert.ok(/name: 'send_notice',\s+cmd: \['node', 'scripts\/test_send_notice\.js'\]/.test(tt));
});

run();
