#!/usr/bin/env node
/**
 * Tests for the Mac's hourly Pi check: the Pi's report (pi_health.sh) and the
 * Mac's side (pi_check.sh), run for real with stand-ins for the Pi's tools and
 * for ssh. Two pretend Pis, at documentation addresses (192.0.2.x).
 *
 * Run: node camera/test_pi_check.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const HEALTH = path.join(__dirname, 'pi_health.sh');
const CHECK = path.join(__dirname, 'pi_check.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-picheck-'));

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; failures.push([name, e]); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function section(t) { console.log(`\n${t}\n${'-'.repeat(t.length)}`); }

let serial = 0;
const fresh = (name) => fs.mkdtempSync(path.join(TMP, `${name}-${serial++}-`));
const write = (file, text, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, mode ? { mode } : undefined);
};
const sh = (body) => `#!/bin/bash\n${body}\n`;

// ── A pretend Pi: its tools (bin/), its files (root/), its home (home/) ──────

const LAST_NOT_CLEAN = [
  'reboot   system boot  6.12.93+rpt-rpi- Thu Oct 22 15:16   still running',
  'reboot   system boot  6.12.93+rpt-rpi- Wed Aug  5 13:16   still running',
  'shutdown system down  6.12.93+rpt-rpi- Wed Jun 17 20:23 - 20:23  (-00:00)',
  'reboot   system boot  6.12.93+rpt-rpi- Wed Jun 17 20:21 - 20:23  (00:02)',
  '',
  'wtmp begins Wed Jun 17 20:21:25 2026',
].join('\n') + '\n';
const LAST_CLEAN = [
  'reboot   system boot  6.12.93+rpt-rpi- Fri Oct 30 09:02   still running',
  'shutdown system down  6.12.93+rpt-rpi- Fri Oct 30 09:01 - 09:02  (00:01)',
  'reboot   system boot  6.12.93+rpt-rpi- Thu Oct 22 15:16 - 09:01 (7+17:45)',
  '',
  'wtmp begins Wed Jun 17 20:21:25 2026',
].join('\n') + '\n';
const BOOTS_TWO = 'IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n'
  + ' -1 1f2e3d4c5b6a79881f2e3d4c5b6a7988 Sun 2026-11-01 09:00:00 EST Sun 2026-11-01 15:22:45 EST\n'
  + '  0 d9b28f0da2dd4b6d83a5a4068f6b3aed Sun 2026-11-01 15:30:02 EST Sun 2026-11-01 18:13:48 EST\n';
const BOOTS_ONE = 'IDX BOOT ID                          FIRST ENTRY                 LAST ENTRY\n'
  + '  0 d9b28f0da2dd4b6d83a5a4068f6b3aed Thu 2026-10-22 15:17:02 EDT Fri 2026-10-30 08:13:48 EDT\n';
const KERNEL = [
  'Oct 30 00:50:12 pihole2 kernel: brcmfmac: F1 signature read @0x18000000=0x1541a9a6',
  'Oct 30 00:50:12 pihole2 kernel: mmc1: new high speed SDIO card at address 0001',
  'Oct 30 00:50:14 pihole2 kernel: EXT4-fs (mmcblk0p2): orphan cleanup on readonly fs',
  'Oct 30 03:10:01 pihole2 kernel: hwmon hwmon1: Undervoltage detected!',
  'Oct 30 03:12:44 pihole2 kernel: brcmfmac: brcmf_sdio_hostmail: mailbox indicates firmware halted',
  'Oct 30 04:00:00 pihole2 kernel: INFO: task kworker/0:1:45 blocked for more than 120 seconds.',
  'Oct 30 04:00:00 pihole2 kernel: Out of memory: Killed process 479 (node) total-vm:300000kB',
  'Oct 30 04:00:01 pihole2 kernel: usb 1-1: new high-speed USB device number 2 using dwc_otg',
].join('\n') + '\n';
const frameLine = (h, m, node, avail) => `Oct 30 ${h}:${m}:41 pihole2 node[479]: 2026-10-30T12:00:41.000Z - Timelapse 2026-10-30 ${h}:${m}: `
  + `saved 2026-10-30_${h}${m}.jpg - 1280x720, 151 KB, from live video (20 s; 0 of 900 packets missing); took 31 s. Battery 87%. `
  + `Memory: this program ${node} MB; the Pi had at least ${avail} MB available throughout.`;
const CAMERA_TODAY = (() => {
  const lines = [];
  for (let i = 0; i < 24; i++) {
    const t = 7 * 60 + 25 + i * 5;
    lines.push(frameLine(String(Math.floor(t / 60)).padStart(2, '0'), String(t % 60).padStart(2, '0'), 60 + i, 250 - i));
  }
  lines.push('Oct 30 09:31:02 pihole2 node[479]: 2026-10-30T13:31:02.000Z - Snapshot uploaded (20152 bytes).');
  return lines.join('\n') + '\n';
})();
const CAMERA_3DAYS = [
  'Oct 28 17:55:32 pihole2 node[479]: 2026-10-28T21:55:32.224Z - Timelapse 2026-10-28: 81 frames saved (4 at 1920x1080); 40 failed; memory: this program 67 MB; 21 files open.',
  'Oct 29 09:00:01 pihole2 node[479]: 2026-10-29T13:00:01.000Z - Snapshot uploaded (20000 bytes).',
  'Oct 30 00:51:02 pihole2 systemd[1]: nhrc-camera.service: Main process exited, code=exited, status=75/n/a',
  'Oct 30 01:00:30 pihole2 node[479]: 2026-10-30T05:00:30.914Z - The main Pi is checking in again (27 s ago) - this Pi is back to standing by.',
].join('\n') + '\n';

/**
 * A pretend Pi under `dir`. `o` may set: last, boots, watchdog, active
 * ({ unit: state }), bootId, noVcgencmd, sudoNeedsPassword, hangIw, report
 * (what the installed report is replaced with - for a Pi answering oddly).
 */
function makePi(dir, o = {}) {
  const bin = path.join(dir, 'bin'), root = path.join(dir, 'root'), home = path.join(dir, 'home');
  const f = (n) => path.join(root, 'fake', n);
  fs.mkdirSync(home, { recursive: true });
  write(f('last.txt'), o.last || LAST_NOT_CLEAN);
  write(f('boots.txt'), o.boots || BOOTS_ONE);
  write(f('kernel.txt'), KERNEL);
  write(f('kernel-prev.txt'), 'Nov 01 15:22:40 pihole2 kernel: mmc0: timeout waiting for hardware interrupt.\n');
  write(f('prev-tail.txt'), 'Nov 01 15:22:45 pihole2 pihole-FTL[2663]: last line before the freeze\n');
  write(f('camera-today.txt'), CAMERA_TODAY);
  write(f('camera-3days.txt'), CAMERA_3DAYS);
  write(f('gaps.txt'), '│ 2026-10-22 15:22:36 │ 2026-10-30 00:53:05 │   10650 │\nlast query: 2026-10-30 08:13:01\n');
  write(f('watchdog'), `${o.watchdog === undefined ? '14s' : o.watchdog}\n`);
  for (const [unit, state] of Object.entries(o.active || {})) write(f(`active-${unit}`), `${state}\n`);
  if (o.sudoNeedsPassword) write(f('sudo-needs-password'), '');
  write(path.join(root, 'proc', 'loadavg'), '0.54 0.27 0.27 1/150 12345\n');
  write(path.join(root, 'proc', 'sys', 'kernel', 'panic'), '10\n');
  write(path.join(root, 'proc', 'sys', 'kernel', 'random', 'boot_id'), `${o.bootId || 'd9b28f0d-a2dd-4b6d-83a5-a4068f6b3aed'}\n`);
  write(path.join(root, 'proc', 'net', 'wireless'), 'Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE\n'
    + ' face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22\n'
    + ' wlan0: 0000   58.  -52.  -256        0      0      0      0      0        0\n');
  fs.mkdirSync(path.join(root, 'var', 'log', 'journal'), { recursive: true });
  write(path.join(root, 'etc', 'pihole', 'pihole-FTL.db'), 'not really a database');
  write(path.join(root, 'var', 'log', 'pihole', 'FTL.log'),
    '2026-10-22 15:22:45.380 EDT [2663/T2706] INFO: Received 7/8 valid NTP replies from pool.ntp.org\n');
  for (const [day, frames] of [['2026-10-21', ['2026-10-21_0720.jpg', '2026-10-21_0725.jpg']],
    ['2026-10-22', ['2026-10-22_1510.jpg', '2026-10-22_1515.jpg', '2026-10-22_1520.jpg']]]) {
    for (const fr of frames) write(path.join(root, 'opt', 'nhrc-camera', 'timelapse', day, fr), 'jpeg');
  }
  write(path.join(root, 'opt', 'nhrc-camera', 'timelapse', 'tests', 'x.jpg'), 'jpeg');
  write(path.join(root, 'opt', 'nhrc-camera', 'timelapse', '.interval-log'), '2026-10-22 15:25 start\n');
  // What must never come out: the camera's secrets.
  write(path.join(root, 'opt', 'nhrc-camera', 'env'), 'CAMERA_UPLOAD_SECRET=s3cr3t-upload-value-0123456789\n');
  write(path.join(root, 'opt', 'nhrc-camera', '.nhrc-ring-token'), 'ring-refresh-token-abcdefghijklmnop\n');

  const R = '"$NHRC_HEALTH_ROOT/fake';
  const tools = {
    uptime: 'case "$1" in -p) echo "up 7 hours, 23 minutes" ;; -s) echo "2026-10-30 00:50:51" ;; *) echo " 08:13:50 up  7:23,  3 users" ;; esac',
    free: 'printf "               total        used        free      shared  buff/cache   available\\nMem:             427         186          36          10         263         241\\nSwap:             99          70          29\\n"',
    vcgencmd: o.noVcgencmd ? 'echo "vcgencmd: command not found" >&2; exit 127' : 'echo "throttled=0x0"',
    systemctl: `case "$1" in
  is-active) cat ${R}/active-$2" 2>/dev/null || echo active ;;
  show) if [ "$2" = -p ] && [ "$3" = RuntimeWatchdogUSec ]; then cat ${R}/watchdog"; else printf 'ActiveState=active\\nSubState=running\\nNRestarts=0\\nExecMainStartTimestamp=Fri 2026-10-30 00:51:02 EDT\\n'; fi ;;
esac`,
    last: `cat ${R}/last.txt"`,
    journalctl: `echo "$*" >> ${R}/journalctl.calls"
case "$*" in
  *--list-boots*) cat ${R}/boots.txt" ;;
  *"-u nhrc-camera --since 3 days ago"*) cat ${R}/camera-3days.txt" ;;
  *"-u nhrc-camera --since today"*) cat ${R}/camera-today.txt" ;;
  *"-u nhrc-camera -n 8"*) tail -n 8 ${R}/camera-today.txt" ;;
  *"-k -b -1"*) cat ${R}/kernel-prev.txt" ;;
  *"-k -b"*) cat ${R}/kernel.txt" ;;
  *"-b -1 -n 40"*) cat ${R}/prev-tail.txt" ;;
esac`,
    ps: 'printf " 94280 node\\n 41000 pihole-FTL\\n 12000 systemd-journal\\n  8000 sshd\\n  6000 systemd\\n  5000 bash\\n  4000 cron\\n"',
    df: 'printf "Filesystem      Size  Used Avail Use%% Mounted on\\n/dev/root        29G  6.1G   22G  23%% /\\n"',
    findmnt: 'echo /dev/mmcblk0p2',
    tune2fs: 'printf "tune2fs 1.47.0 (5-Feb-2023)\\nFilesystem volume name:   rootfs\\nFilesystem state:         clean\\nErrors behavior:          Continue\\nFS Error count:           2\\nFirst error time:         Thu Oct 22 15:23:10 2026\\nFirst error function:     ext4_journal_check_start\\nLast error time:          Thu Oct 22 15:23:10 2026\\nLast error function:      ext4_journal_check_start\\nLifetime writes:          100 GB\\n"',
    iw: o.hangIw ? 'sleep 20; echo "Power save: on"' : 'echo "Power save: on"',
    hostname: 'echo pihole2',
    'pihole-FTL': `[ "$1" = sqlite3 ] || exit 2
printf '%s\\n' "$3" > ${R}/sql.txt"
cat ${R}/gaps.txt"`,
    sudo: `echo "sudo $*" >> ${R}/sudo.calls"
if [ -f ${R}/sudo-needs-password" ]; then echo "sudo: a password is required" >&2; exit 1; fi
[ "$1" = -n ] || { echo "sudo would have asked for a password" >&2; exit 1; }
shift
exec "$@"`,
    'systemd-tmpfiles': `echo "$*" >> ${R}/tmpfiles.calls"`,
  };
  for (const [name, body] of Object.entries(tools)) write(path.join(bin, name), sh(body), 0o755);
  return { dir, bin, root, home, fake: f };
}

/** The report, from a pretend Pi, as the forced command would run it (outside ssh). */
function report(pi, env = {}) {
  const r = spawnSync('bash', [HEALTH], {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({ NHRC_HEALTH_PATH: `${pi.bin}:/usr/bin:/bin`, NHRC_HEALTH_ROOT: pi.root, HOME: pi.home }, env),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ═══════════════════════════════════════════════════════════════════════════
section('1. The Pi\'s report (pi_health.sh)');
// ═══════════════════════════════════════════════════════════════════════════

const piA = makePi(fresh('pi'));
const A = report(piA);

test('it finishes, and the summary comes first, in the agreed form', () => {
  assert.strictEqual(A.code, 0, A.err);
  assert.strictEqual(A.out.split('\n')[0],
    'SUMMARY up 7 hours, 23 minutes; load 0.54; memory available 241 MB; swap 70 of 99 MB used; throttled 0x0; '
    + 'pihole-FTL active; nhrc-camera active; last restart 2026-10-30 00:50:51 (not clean); watchdog 14s; boot d9b28f0d');
});

test('every section is there, in order', () => {
  const heads = ['Restarts', 'Protections', 'Power', 'Memory', 'SD card', 'Wi-Fi', 'Pi-hole', 'Camera service',
    'Kernel warnings since the last restart', 'Before the last restart'];
  let at = 0;
  for (const h of heads) {
    const i = A.out.indexOf(`\n== ${h}`, at);
    assert.ok(i > at, `section "${h}" missing or out of order`);
    at = i;
  }
  assert.ok(/\nReport took \d+ s\.\n$/.test(A.out));
});

test('a restart after a shutdown is "clean"; one with none before it is "not clean"', () => {
  assert.ok(A.out.includes('(not clean)'));
  const pi = makePi(fresh('pi'), { last: LAST_CLEAN });
  assert.ok(report(pi).out.split('\n')[0].includes('last restart 2026-10-30 00:50:51 (clean)'));
  const odd = makePi(fresh('pi'), { last: 'wtmp begins Wed Jun 17 20:21:25 2026\n' });
  assert.ok(report(odd).out.split('\n')[0].includes('(unknown)'));
});

test('the protections: watchdog, reboot after a kernel crash, logs kept', () => {
  assert.ok(A.out.includes('hardware watchdog: 14s'));
  assert.ok(A.out.includes('reboot after a kernel crash: 10 s (0 = never)'));
  assert.ok(A.out.includes('logs kept across restarts: yes'));
  const off = makePi(fresh('pi'), { watchdog: '0' });
  fs.rmSync(path.join(off.root, 'var', 'log', 'journal'), { recursive: true });
  const r = report(off).out;
  assert.ok(r.split('\n')[0].endsWith('; watchdog off; boot d9b28f0d'), r.split('\n')[0]);
  assert.ok(r.includes('logs kept across restarts: no'));
});

test('a value that does not look right is "?" in the summary, never an error message', () => {
  const pi = makePi(fresh('pi'), { noVcgencmd: true, active: { 'pihole-FTL': 'Failed to connect to bus: No such file or directory' } });
  const first = report(pi).out.split('\n')[0];
  assert.ok(first.includes('throttled ?;') && first.includes('pihole-FTL ?;'), first);
  assert.ok(!/command not found|Failed to connect/.test(first), first);
  const stopped = makePi(fresh('pi'), { active: { 'nhrc-camera': 'inactive' } });
  assert.ok(report(stopped).out.split('\n')[0].includes('nhrc-camera inactive;'));
});

test('memory: the table, and the biggest programs in MB', () => {
  assert.ok(A.out.includes('Swap:             99          70          29'));
  assert.ok(/\n +92 MB  node\n +40 MB  pihole-FTL\n/.test(A.out), A.out);
});

test('the SD card: free space, and only the error lines of the file system', () => {
  assert.ok(A.out.includes('/dev/root        29G  6.1G   22G  23% /'));
  for (const l of ['Filesystem state:         clean', 'Errors behavior:          Continue', 'FS Error count:           2',
    'First error time:', 'First error function:', 'Last error time:', 'Last error function:']) {
    assert.ok(A.out.includes(l), l);
  }
  assert.ok(!A.out.includes('Lifetime writes') && !A.out.includes('volume name'));
});

test('Wi-Fi: power saving, and the link quality and signal', () => {
  assert.ok(A.out.includes('Power save: on'));
  assert.ok(A.out.includes('wlan0: link quality 58, signal -52 dBm'));
});

test('Pi-hole: the gaps come from query_storage (fast) - not the queries view, which stalled on the busy Pi', () => {
  const sql = fs.readFileSync(piA.fake('sql.txt'), 'utf8');
  assert.ok(/FROM query_storage WHERE timestamp > CAST\(strftime\('%s','now','-14 days'\) AS INT\)\) WHERE timestamp-prev > 3600;/.test(sql), sql);
  assert.ok(!/FROM queries\b/.test(sql), sql);
  assert.ok(A.out.includes('10650') && A.out.includes('last query: 2026-10-30 08:13:01'));
  assert.ok(A.out.includes('Received 7/8 valid NTP replies'));
});

test('everything that needs root goes through sudo -n: never a password prompt', () => {
  const calls = fs.readFileSync(piA.fake('sudo.calls'), 'utf8').trim().split('\n');
  assert.ok(calls.length >= 8, calls.join('\n'));
  for (const c of calls) assert.ok(c.startsWith('sudo -n '), c);
  assert.ok(calls.some(c => /^sudo -n nice -n 10 pihole-FTL sqlite3 /.test(c)));
  assert.ok(calls.some(c => /^sudo -n tune2fs -l \/dev\/mmcblk0p2$/.test(c)));
  assert.ok(calls.some(c => c.endsWith('/var/log/pihole/FTL.log')));
  assert.ok(calls.every(c => !c.includes('journalctl') || c.includes('journalctl -q --no-pager')));
});

test('where sudo would ask for a password, the report says so and carries on', () => {
  const pi = makePi(fresh('pi'), { sudoNeedsPassword: true });
  const r = report(pi);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.includes('sudo: a password is required'));
  assert.ok(/\nReport took \d+ s\.\n$/.test(r.out));
});

test('the camera service: restarts, takeovers and day lines; memory about hourly; the last lines; the days', () => {
  assert.ok(A.out.includes('NRestarts=0'));
  assert.ok(A.out.includes('81 frames saved') && A.out.includes('back to standing by') && A.out.includes('status=75/n/a'));
  assert.ok(!A.out.includes('Oct 29 09:00:01'), 'only the lines that matter from the last 3 days');
  const hourly = A.out.split('\n').filter(l => l.includes('this program') && l.includes('the Pi at least'));
  assert.deepStrictEqual(hourly, [
    'Oct 30 07:25:41  this program 60 MB, the Pi at least 250 MB available',
    'Oct 30 08:25:41  this program 72 MB, the Pi at least 238 MB available',
  ]);
  assert.ok(A.out.includes('Snapshot uploaded (20152 bytes).'), 'the last lines');
  assert.ok(A.out.includes('2026-10-21 2 frames, the last 2026-10-21_0725.jpg'));
  assert.ok(A.out.includes('2026-10-22 3 frames, the last 2026-10-22_1520.jpg'));
  assert.ok(!/\ntests /.test(A.out));
});

test('kernel lines: the warnings, not what every boot prints', () => {
  const sec = A.out.slice(A.out.indexOf('== Kernel warnings'), A.out.indexOf('== Before the last restart'));
  for (const l of ['orphan cleanup', 'Undervoltage detected!', 'firmware halted', 'blocked for more than 120 seconds',
    'Out of memory: Killed process']) {
    assert.ok(sec.includes(l), l);
  }
  for (const l of ['F1 signature', 'new high speed SDIO card', 'new high-speed USB device']) assert.ok(!sec.includes(l), l);
});

test('before the last restart: its logs when they were kept, else says they were not', () => {
  assert.ok(A.out.includes('(no logs from before the last restart: they were not kept then)'));
  const pi = makePi(fresh('pi'), { boots: BOOTS_TWO });
  const r = report(pi).out;
  const sec = r.slice(r.indexOf('== Before the last restart'));
  assert.ok(sec.includes('mmc0: timeout waiting for hardware interrupt') && sec.includes('last line before the freeze'), sec);
});

test('it never prints a secret: not the camera\'s env file, not the Ring token', () => {
  for (const s of ['s3cr3t-upload-value', 'ring-refresh-token', 'CAMERA_UPLOAD_SECRET']) {
    assert.ok(!A.out.includes(s) && !A.err.includes(s), s);
  }
  const src = fs.readFileSync(HEALTH, 'utf8');
  assert.ok(!/nhrc-camera\/env|ring-token|\.nhrc-ring|authorized_keys/.test(src.replace(/^#.*$/gm, '')), 'the report never reads them');
});

test('the key can ask for the report and nothing else', () => {
  for (const cmd of ['cat /etc/passwd', 'report; id', 'bash', 'report ']) {
    const r = report(piA, { SSH_ORIGINAL_COMMAND: cmd });
    assert.strictEqual(r.code, 1, cmd);
    assert.strictEqual(r.out, '', cmd);
    assert.ok(r.err.includes('not allowed'), cmd);
  }
  assert.ok(report(piA, { SSH_ORIGINAL_COMMAND: 'report' }).out.startsWith('SUMMARY '));
});

test('over ssh, the stand-ins are ignored: always the system\'s own tools and files', () => {
  const r = report(piA, { SSH_CONNECTION: '192.0.2.10 50000 192.0.2.48 22' });
  assert.strictEqual(r.code, 0, r.err);
  assert.ok(!r.out.includes('pihole2'), 'the pretend hostname was used over ssh');
  assert.ok(!r.out.includes('up 7 hours, 23 minutes'), 'the pretend uptime was used over ssh');
});

test('a step that hangs is cut off, and the report goes on', () => {
  const pi = makePi(fresh('pi'), { hangIw: true });
  const t0 = Date.now();
  const r = report(pi, { NHRC_HEALTH_STEP_SECONDS: '1' });
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms`);
  assert.ok(r.out.includes('(stopped after 1 s)'));
  assert.ok(r.out.includes('== Pi-hole =='));
});

test('on a machine without the Pi\'s tools it still finishes: every section, a "?" where a value is missing', () => {
  const r = spawnSync('bash', [HEALTH], { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', HOME: TMP } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.startsWith('SUMMARY up '));
  assert.ok(r.stdout.includes('== Before the last restart =='));
});

// ═══════════════════════════════════════════════════════════════════════════
section('2. The Mac\'s side (pi_check.sh)');
// ═══════════════════════════════════════════════════════════════════════════

const PI1 = 'emre@192.0.2.48', PI2 = 'emre@192.0.2.47';

/** A Mac with its own key, two pretend Pis, a stand-in ssh and notifications. */
function makeMac() {
  const base = fresh('mac');
  const mac = {
    base,
    support: path.join(base, 'support'),
    dest: path.join(base, 'repo', '.pi-health'),
    key: path.join(base, 'ssh', 'nhrc_pi_health'),
    pis: path.join(base, 'pis'),
    helper: path.join(base, 'usr-local-bin', 'nhrc-pi-health'),
    notes: path.join(base, 'notifications'),
    ssh: path.join(base, 'fake-ssh'),
    notify: path.join(base, 'fake-notify'),
  };
  fs.mkdirSync(path.dirname(mac.key), { recursive: true });
  fs.mkdirSync(path.dirname(mac.helper), { recursive: true });
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'nhrc-pi-health (read-only health report)', '-f', mac.key]);
  mac.pi = {};
  for (const p of [PI1, PI2]) mac.pi[p] = makePi(path.join(mac.pis, p));
  // ssh: with -i, the key's line on that Pi decides (its forced command runs,
  // as sshd would run it); without, your own login runs the command there.
  write(mac.ssh, sh(`key=''
while [ $# -gt 0 ]; do case "$1" in -n) shift ;; -i) key=$2; shift 2 ;; -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
host=$1; shift; cmd="$*"
pi="$FAKE_PIS/$host"
if [ ! -d "$pi" ] || [ -f "$pi/down" ]; then echo "ssh: connect to host \${host#*@} port 22: Operation timed out" >&2; exit 255; fi
if [ -n "$key" ]; then
  pub=$(cut -d' ' -f1,2 "$key.pub")
  line=$(grep -F "$pub" "$pi/home/.ssh/authorized_keys" 2>/dev/null | head -n 1)
  [ -n "$line" ] || { echo "$host: Permission denied (publickey)." >&2; exit 255; }
  forced=$(printf '%s' "$line" | sed -n 's/^restrict,command="\\([^"]*\\)" .*/\\1/p')
  [ -n "$forced" ] || { echo "fake ssh: that key's line has no forced command: $line" >&2; exit 254; }
  [ -x "$forced" ] || { echo "bash: $forced: No such file or directory" >&2; exit 127; }
  exec env -u SSH_CONNECTION HOME="$pi/home" NHRC_HEALTH_PATH="$pi/bin:/usr/bin:/bin" NHRC_HEALTH_ROOT="$pi/root" SSH_ORIGINAL_COMMAND="$cmd" \\
    bash -c "if [ -f '$pi/report-override' ]; then exec bash '$pi/report-override'; else exec '$forced'; fi"
fi
exec env -u SSH_CONNECTION HOME="$pi/home" PATH="$pi/bin:/usr/bin:/bin" NHRC_HEALTH_ROOT="$pi/root" bash -c "$cmd"`), 0o755);
  write(mac.notify, sh(`printf '%s\\n' "$1" >> "${mac.notes}"`), 0o755);
  mac.env = (extra = {}) => Object.assign({
    PATH: process.env.PATH, HOME: base,
    NHRC_PICHECK_SUPPORT: mac.support, NHRC_PICHECK_DEST: mac.dest, NHRC_PICHECK_KEY: mac.key,
    NHRC_PICHECK_SSH: mac.ssh, NHRC_PICHECK_HELPER: mac.helper, NHRC_PICHECK_RETRY_SECONDS: '0',
    NHRC_PICHECK_NOTIFY: mac.notify, FAKE_PIS: mac.pis,
  }, extra);
  mac.exec = (args, extra) => spawnSync('bash', [CHECK, ...args], { encoding: 'utf8', timeout: 120000, env: mac.env(extra) });
  mac.history = () => (fs.existsSync(path.join(mac.dest, 'history.log')) ? fs.readFileSync(path.join(mac.dest, 'history.log'), 'utf8') : '');
  mac.notes_ = () => (fs.existsSync(mac.notes) ? fs.readFileSync(mac.notes, 'utf8').trim().split('\n').filter(Boolean) : []);
  mac.keys = (p) => fs.readFileSync(path.join(mac.pi[p].home, '.ssh', 'authorized_keys'), 'utf8');
  mac.down = (p, on = true) => { const f = path.join(mac.pi[p].dir, 'down'); if (on) write(f, ''); else fs.rmSync(f, { force: true }); };
  mac.bootId = (p, id) => write(path.join(mac.pi[p].root, 'proc', 'sys', 'kernel', 'random', 'boot_id'), `${id}\n`);
  return mac;
}

const pub = (mac) => fs.readFileSync(`${mac.key}.pub`, 'utf8').trim();
const keyLine = (mac) => `restrict,command="${mac.helper}" ${pub(mac)}`;

test('update: puts the report on each Pi, byte for byte, and the key - read-only - in its authorized_keys', () => {
  const mac = makeMac();
  const r = mac.exec(['update', PI1, PI2]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  assert.ok(fs.readFileSync(mac.helper).equals(fs.readFileSync(HEALTH)), 'the report arrived whole');
  assert.strictEqual(fs.statSync(mac.helper).mode & 0o777, 0o755);
  for (const p of [PI1, PI2]) {
    assert.strictEqual(mac.keys(p), `${keyLine(mac)}\n`, p);
    assert.ok(r.stdout.includes(`${p} answers: up 7 hours, 23 minutes;`), r.stdout);
    assert.ok(fs.readFileSync(mac.pi[p].fake('sudo.calls'), 'utf8').includes(`sudo -n install -m 755 `), p);
  }
});

test('update again: the key line is never added twice; the report is replaced with the new one', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1]).status, 0);
  fs.writeFileSync(mac.helper, '#!/bin/bash\necho old\n');
  const r = mac.exec(['update', PI1]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(mac.keys(PI1), `${keyLine(mac)}\n`);
  assert.ok(fs.readFileSync(mac.helper).equals(fs.readFileSync(HEALTH)));
});

test('a Pi\'s existing keys stay whole - even a last line with no newline after it', () => {
  const mac = makeMac();
  write(path.join(mac.pi[PI1].home, '.ssh', 'authorized_keys'), 'ssh-ed25519 AAAAexisting emre@MacBook-Air');
  assert.strictEqual(mac.exec(['update', PI1]).status, 0);
  assert.strictEqual(mac.keys(PI1), `ssh-ed25519 AAAAexisting emre@MacBook-Air\n${keyLine(mac)}\n`);
});

test('where sudo would ask for a password, nothing is put on that Pi, and it says what to do', () => {
  const mac = makeMac();
  write(mac.pi[PI1].fake('sudo-needs-password'), '');
  const r = mac.exec(['update', PI1]);
  assert.notStrictEqual(r.status, 0);
  assert.ok(r.stderr.includes('sudo asks for a password on this Pi'), r.stderr);
  assert.ok(!fs.existsSync(path.join(mac.pi[PI1].home, '.ssh', 'authorized_keys')), 'no key without the report');
  assert.ok(!fs.existsSync(mac.helper));
});

test('the journal made persistent is opened to the Pi\'s user again (systemd-tmpfiles), when there is one', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1]).status, 0);
  const calls = fs.existsSync(mac.pi[PI1].fake('tmpfiles.calls')) ? fs.readFileSync(mac.pi[PI1].fake('tmpfiles.calls'), 'utf8') : '';
  if (fs.existsSync('/var/log/journal')) assert.strictEqual(calls.trim(), '--create --prefix /var/log/journal');
  else assert.strictEqual(calls, '');
});

test('run: each Pi\'s latest report, whole, and one history line per Pi', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1, PI2]).status, 0);
  const r = mac.exec(['run', PI1, PI2]);
  assert.strictEqual(r.status, 0, r.stderr);
  for (const p of [PI1, PI2]) {
    const rep = fs.readFileSync(path.join(mac.dest, `${p}.txt`), 'utf8');
    assert.ok(rep.startsWith('SUMMARY up 7 hours') && rep.includes('== Before the last restart =='), p);
  }
  const lines = mac.history().trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.ok(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d emre@192\.0\.2\.48 up 7 hours, 23 minutes; load 0\.54; .*; boot d9b28f0d$/.test(lines[0]), lines[0]);
  assert.ok(lines[1].includes(`${PI2} up 7 hours`));
  assert.deepStrictEqual(mac.notes_(), []);
  assert.deepStrictEqual(fs.readdirSync(mac.dest).filter(f => f.startsWith('.')), [], 'no temporary file left');
});

test('without Pis on the command line, run checks the ones install noted, into the folder it noted', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1, PI2]).status, 0);
  const other = path.join(mac.base, 'noted-folder');
  write(path.join(mac.support, 'settings'), `dest ${other}\npi ${PI1}\npi ${PI2}\n`);
  const r = mac.exec(['run'], { NHRC_PICHECK_DEST: '' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(other, `${PI1}.txt`)) && fs.existsSync(path.join(other, `${PI2}.txt`)));
});

test('nothing to check: run says how to set it up', () => {
  const mac = makeMac();
  const r = mac.exec(['run']);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stderr.includes('install'));
});

test('a Pi that stops answering: noted each time; after two checks in a row a notification; another when it is back', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1, PI2]).status, 0);
  assert.strictEqual(mac.exec(['run', PI1, PI2]).status, 0);
  const good = fs.readFileSync(path.join(mac.dest, `${PI1}.txt`), 'utf8');
  mac.down(PI1);
  mac.exec(['run', PI1, PI2]);
  assert.deepStrictEqual(mac.notes_(), [], 'one missed check could be the Mac waking up');
  assert.ok(mac.history().includes(`${PI1} did not answer (ssh: connect to host 192.0.2.48 port 22: Operation timed out)`));
  assert.strictEqual(fs.readFileSync(path.join(mac.dest, `${PI1}.txt`), 'utf8'), good, 'its last report is kept');
  mac.exec(['run', PI1, PI2]);
  assert.deepStrictEqual(mac.notes_(), [`${PI1} has not answered for two checks in a row, while the other Pi does: it may have frozen.`]);
  mac.exec(['run', PI1, PI2]);
  assert.strictEqual(mac.notes_().length, 1, 'said once, not every hour');
  mac.down(PI1, false);
  mac.exec(['run', PI1, PI2]);
  assert.deepStrictEqual(mac.notes_().slice(1), [`${PI1} answers again.`]);
  mac.exec(['run', PI1, PI2]);
  assert.strictEqual(mac.notes_().length, 2);
});

test('no Pi answering is this Mac away from home: noted, never a notification, and it counts for no Pi', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1, PI2]).status, 0);
  mac.down(PI1);
  mac.exec(['run', PI1, PI2]);             // PI1 missed once, PI2 answered
  mac.down(PI2);
  for (let i = 0; i < 3; i++) mac.exec(['run', PI1, PI2]);
  assert.deepStrictEqual(mac.notes_(), []);
  assert.ok(mac.history().includes('no Pi answered: this Mac is probably away from home, or the home network is down'));
  mac.down(PI2, false);
  mac.exec(['run', PI1, PI2]);             // home again: PI1's second miss
  assert.deepStrictEqual(mac.notes_(), [`${PI1} has not answered for two checks in a row, while the other Pi does: it may have frozen.`]);
});

test('a Pi that restarted without a clean shutdown since the last check: a notification; a clean restart: none', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1, PI2]).status, 0);
  mac.exec(['run', PI1, PI2]);
  mac.exec(['run', PI1, PI2]);
  assert.deepStrictEqual(mac.notes_(), [], 'the same boot');
  mac.bootId(PI1, '0a1b2c3d-0000-4000-8000-000000000000');
  mac.exec(['run', PI1, PI2]);
  assert.deepStrictEqual(mac.notes_(), [`${PI1} restarted at 2026-10-30 00:50:51 without a clean shutdown: a freeze or a power cut.`]);
  write(mac.pi[PI2].fake('last.txt'), LAST_CLEAN);
  mac.bootId(PI2, '0a1b2c3d-0000-4000-8000-000000000001');
  mac.exec(['run', PI1, PI2]);
  assert.strictEqual(mac.notes_().length, 1, 'a clean restart is not news');
});

test('the first check of a Pi is never taken for a restart', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1]).status, 0);
  mac.exec(['run', PI1]);
  assert.deepStrictEqual(mac.notes_(), []);
});

test('a Pi that answers with something other than its report is noted, and counts as not answering', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1, PI2]).status, 0);
  write(path.join(mac.pi[PI1].dir, 'report-override'), 'echo "Welcome to Raspberry Pi"\n');
  mac.exec(['run', PI1, PI2]);
  mac.exec(['run', PI1, PI2]);
  assert.ok(mac.history().includes(`${PI1} answered, but not with its report: Welcome to Raspberry Pi`), mac.history());
  assert.ok(!fs.existsSync(path.join(mac.dest, `${PI1}.txt`)));
  assert.strictEqual(mac.notes_().length, 1);
});

test('a Pi without the report installed: the history says so', () => {
  const mac = makeMac();
  write(path.join(mac.pi[PI1].home, '.ssh', 'authorized_keys'), `${keyLine(mac)}\n`);
  mac.exec(['run', PI1]);
  assert.ok(mac.history().includes(`${PI1} did not answer (bash: ${mac.helper}: No such file or directory)`), mac.history());
});

test('only user@address Pis are asked; anything else is noted and skipped', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1]).status, 0);
  mac.exec(['run', '-oProxyCommand=touch /tmp/x', PI1]);
  // Noted with anything unusual in it made harmless ("=" shown as "?").
  assert.ok(mac.history().includes('not a Pi: "-oProxyCommand?touch /tmp/x" - give each as user@address'), mac.history());
  assert.ok(!fs.existsSync('/tmp/x') || fs.statSync('/tmp/x').mtimeMs < Date.now() - 60000, 'it was never handed to ssh');
  assert.ok(mac.history().includes(`${PI1} up 7 hours`));
  const u = mac.exec(['update', 'pihole2']);
  assert.notStrictEqual(u.status, 0);
  assert.ok(u.stderr.includes('user@address'));
});

test('one check at a time; a lock left by a check that died is taken over after half an hour', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1]).status, 0);
  const lock = path.join(mac.support, '.running');
  fs.mkdirSync(lock, { recursive: true });
  mac.exec(['run', PI1]);
  assert.strictEqual(mac.history(), '', 'another check is running');
  execFileSync('touch', ['-d', '-2 hours', lock]);
  mac.exec(['run', PI1]);
  assert.ok(mac.history().includes(`${PI1} up 7 hours`));
  assert.ok(!fs.existsSync(lock), 'the lock goes with the check');
});

test('the history keeps its last 5000 lines', () => {
  const mac = makeMac();
  assert.strictEqual(mac.exec(['update', PI1]).status, 0);
  write(path.join(mac.dest, 'history.log'), Array.from({ length: 5000 }, (_, i) => `old line ${i}`).join('\n') + '\n');
  mac.exec(['run', PI1]);
  const lines = mac.history().trim().split('\n');
  assert.strictEqual(lines.length, 5000);
  assert.strictEqual(lines[0], 'old line 1');
  assert.ok(lines[4999].includes(`${PI1} up 7 hours`));
});

test('install is for the Mac, and checks the Pis\' names before it does anything', () => {
  const mac = makeMac();
  const bad = mac.exec(['install', 'pihole2']);
  assert.notStrictEqual(bad.status, 0);
  assert.ok(bad.stderr.includes('user@address'));
  const r = mac.exec(['install', PI1]);
  if (process.platform !== 'darwin') {
    assert.notStrictEqual(r.status, 0);
    assert.ok(r.stderr.includes('This part runs on your Mac.'));
  }
  assert.ok(!fs.existsSync(mac.helper));
});

// ═══════════════════════════════════════════════════════════════════════════
section('3. With a real ssh server: the key gets the report, and nothing else');
// ═══════════════════════════════════════════════════════════════════════════

if (fs.existsSync('/usr/sbin/sshd') && fs.existsSync('/usr/bin/ssh-keygen') && fs.existsSync('/usr/bin/ssh')) {
  const t = fresh('sshd');
  const user = os.userInfo().username;
  const key = path.join(t, 'nhrc_pi_health');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(t, 'hostkey')]);
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'nhrc-pi-health (read-only health report)', '-f', key]);
  // The line install puts on the Pi - with the report from this repository.
  fs.writeFileSync(path.join(t, 'authorized_keys'), `restrict,command="${HEALTH}" ${fs.readFileSync(`${key}.pub`, 'utf8')}`, { mode: 0o600 });
  const port = 30000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(path.join(t, 'sshd_config'), [`Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${t}/hostkey`, `PidFile ${t}/sshd.pid`,
    `AuthorizedKeysFile ${t}/authorized_keys`, 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'PubkeyAuthentication yes', 'AcceptEnv LANG LC_*'].join('\n') + '\n');
  fs.writeFileSync(path.join(t, 'ssh_config'), `Host pi\n  HostName 127.0.0.1\n  Port ${port}\n  User ${user}\n`
    + `  UserKnownHostsFile ${t}/known_hosts\n  StrictHostKeyChecking no\n  LogLevel ERROR\n`);
  const wrapper = path.join(t, 'ssh');
  fs.writeFileSync(wrapper, `#!/bin/bash\nexec ssh -F ${t}/ssh_config "$@"\n`, { mode: 0o755 });
  const sshd = require('child_process').spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(t, 'sshd_config')], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(path.join(t, 'sshd.pid')); i++) execFileSync('sleep', ['0.1']);
    execFileSync('sleep', ['0.3']);
    const as = (args, opts = {}) => spawnSync(args[0], args.slice(1), Object.assign({ encoding: 'utf8', timeout: 20000 }, opts));
    const base = ['-F', `${t}/ssh_config`, '-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes'];

    test('the Mac\'s check, end to end: the report arrives over ssh, and the history has its line', () => {
      const dest = path.join(t, 'dest');
      const r = spawnSync('bash', [CHECK, 'run', `${user}@pi`], { encoding: 'utf8', timeout: 120000, env: {
        PATH: process.env.PATH, HOME: t, NHRC_PICHECK_SUPPORT: path.join(t, 'support'), NHRC_PICHECK_DEST: dest,
        NHRC_PICHECK_KEY: key, NHRC_PICHECK_SSH: wrapper, NHRC_PICHECK_RETRY_SECONDS: '0', NHRC_PICHECK_NOTIFY: '/bin/true' } });
      assert.strictEqual(r.status, 0, r.stderr);
      const rep = fs.readFileSync(path.join(dest, `${user}@pi.txt`), 'utf8');
      assert.ok(rep.startsWith('SUMMARY up ') && rep.includes('== Before the last restart =='), rep.slice(0, 300));
      assert.ok(new RegExp(` ${user}@pi up `).test(fs.readFileSync(path.join(dest, 'history.log'), 'utf8')));
    });

    test('over real ssh the report uses the system\'s own tools: the test stand-ins cannot be slipped in', () => {
      const pi = makePi(fresh('pi'));
      const x = as(['ssh', ...base, '-o', `SetEnv=NHRC_HEALTH_PATH=${pi.bin}:/usr/bin:/bin NHRC_HEALTH_ROOT=${pi.root}`, 'pi', 'report']);
      assert.strictEqual(x.status, 0, x.stderr);
      assert.ok(x.stdout.startsWith('SUMMARY ') && !x.stdout.includes('pihole2') && !x.stdout.includes('up 7 hours, 23 minutes'), x.stdout.slice(0, 300));
    });

    test('the key can run no other command, and gets no shell, no scp, no sftp, no forwarding', () => {
      let x = as(['ssh', ...base, 'pi', 'id']);
      assert.ok(x.status === 1 && /not allowed/.test(x.stderr) && !/uid=/.test(x.stdout), 'no other command');
      x = as(['ssh', ...base, 'pi', 'report; id']);
      assert.ok(x.status === 1 && !/uid=/.test(x.stdout), 'nothing tacked on');
      x = as(['ssh', ...base, '-tt', 'pi']);
      assert.ok(!/uid=|\$ $/m.test(x.stdout) && (x.stdout.startsWith('SUMMARY') || x.status !== 0), 'no shell: at most the report');
      x = as(['scp', ...base, 'pi:/etc/passwd', path.join(t, 'stolen')]);
      assert.ok(x.status !== 0 && !fs.existsSync(path.join(t, 'stolen')), 'no scp');
      x = as(['sftp', ...base, 'pi'], { input: 'ls /\n' });
      assert.ok(x.status !== 0 && !/etc|usr/.test(x.stdout), 'no sftp');
      // A forward through the key to the ssh server itself: a connection made
      // through it must get nothing - not the server's greeting.
      const local = port + 1;
      const fwd = require('child_process').spawn('ssh', [...base, '-N', '-L', `${local}:127.0.0.1:${port}`, 'pi'], { stdio: 'ignore' });
      try {
        execFileSync('sleep', ['1.5']);
        x = as(['bash', '-c', `exec 3<>/dev/tcp/127.0.0.1/${local} || exit 9; timeout 3 head -c 7 <&3`]);
        assert.ok(!/SSH-2\.0/.test(x.stdout), `port forwarding worked: ${x.stdout}`);
      } finally {
        fwd.kill('SIGTERM');
      }
    });
  } finally {
    sshd.kill('SIGTERM');
  }
} else {
  console.log('  (skipped: no ssh server here)');
}

// ═══════════════════════════════════════════════════════════════════════════
section('4. Safety of what is published and what is kept');
// ═══════════════════════════════════════════════════════════════════════════

test('what the checks write is never committed: .pi-health/ is in .gitignore, and git agrees', () => {
  const repo = path.join(__dirname, '..');
  const gi = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
  assert.ok(gi.split('\n').includes('.pi-health/'));
  const r = spawnSync('git', ['check-ignore', '-q', '.pi-health/emre@192.0.2.48.txt'], { cwd: repo });
  if (r.error || r.status === 128) return;    // not a git checkout here
  assert.strictEqual(r.status, 0, 'git would commit .pi-health/');
  const src = fs.readFileSync(CHECK, 'utf8');
  assert.ok(src.includes("grep -qx '.pi-health/' \"$repo/.gitignore\""), 'install refuses without it');
});

test('no address of the home network in these files', () => {
  const lan = /\b(192\.168|10\.\d{1,3}|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/;
  for (const f of [HEALTH, CHECK, __filename]) {
    const m = lan.exec(fs.readFileSync(f, 'utf8'));
    assert.ok(!m, `${path.basename(f)}: ${m && m[0]}`);
  }
});

test('the Mac script is written for the bash every Mac has (3.2)', () => {
  const src = fs.readFileSync(CHECK, 'utf8').replace(/^\s*#.*$/gm, '');
  for (const [re, what] of [[/declare -A|local -A/, 'associative arrays'], [/\bmapfile\b|\breadarray\b/, 'mapfile'],
    [/\$\{\w+(,,|\^\^)\}/, 'case changes'], [/\|&/, '|&'], [/&>>/, '&>>'], [/\bcoproc\b/, 'coproc'],
    [/\$\{\w+\[-1\]\}/, 'negative indexes'], [/\bwait -n\b/, 'wait -n']]) {
    assert.ok(!re.test(src), what);
  }
  // Under set -u, bash 3.2 calls an empty array unbound: every expansion of
  // one that can be empty is guarded.
  for (const m of src.matchAll(/(.)"\$\{(\w+)\[@\]\}"/g)) {
    assert.ok(m[1] === '+' || m[2] === 'pis', `unguarded "\${${m[2]}[@]}"`);
  }
  assert.ok(/^set -u$/m.test(src) && /^set -o pipefail$/m.test(src));
});

test('both scripts parse', () => {
  for (const f of [HEALTH, CHECK]) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${path.basename(f)}: ${r.stderr}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${'='.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best effort */ }
if (failed) {
  failures.forEach(([n, e]) => console.log(`  - ${n}: ${e.message}`));
  process.exit(1);
}
