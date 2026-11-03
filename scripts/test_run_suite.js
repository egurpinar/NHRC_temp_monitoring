#!/usr/bin/env node
/**
 * Tests for scripts/run_suite.js, which tests.yml runs every suite through:
 * output and exit code passed through unchanged, and on GitHub each failing
 * test as an annotation (readable on the run page without signing in).
 *
 * Run: node scripts/test_run_suite.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const R = require('./run_suite.js');

const RUN = path.join(__dirname, 'run_suite.js');
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${String(e.message).split('\n').join('\n        ')}`); }
}
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nhrc-run-suite-'));
process.on('exit', () => fs.rmSync(DIR, { recursive: true, force: true }));
/** run_suite.js around a stand-in suite (standin_suite.js): printing `out`, exiting with `code`. */
function around(out, code, github = true) {
  const file = path.join(DIR, 'standin_suite.js');
  fs.writeFileSync(file, `process.stdout.write(${JSON.stringify(out)}); process.exitCode = ${code};`);
  const env = Object.assign({}, process.env, { GITHUB_ACTIONS: github ? 'true' : '' });
  return spawnSync(process.execPath, [RUN, process.execPath, file], { encoding: 'utf8', env });
}
const annotationsIn = (stdout) => stdout.split('\n').filter(l => l.startsWith('::error '));

console.log('\nrun_suite.js\n------------');

test('a passing suite: its output and exit 0, untouched - no annotation', () => {
  const r = around('  PASS  one\n1 passed, 0 failed\n', 0);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '  PASS  one\n1 passed, 0 failed\n');
});

test('a failing suite on GitHub: its exit code, its output, then one annotation per failing test, with what it said', () => {
  const out = '  PASS  one\n  FAIL  two\n        Expected values to be strictly equal:\n        \n        \'99.00\' !== \'99\'\n  PASS  three\n  FAIL junk never archived -- expected \'[71.6,99]\' got \'[71.6,99.00]\'\n1 passed, 2 failed\n';
  const r = around(out, 1);
  assert.strictEqual(r.status, 1);
  assert.ok(r.stdout.startsWith(out), 'the output first, unchanged');
  const a = annotationsIn(r.stdout);
  assert.strictEqual(a.length, 2, r.stdout);
  assert.ok(a[0].startsWith('::error title=standin_suite.js failed::FAIL  two%0AExpected values to be strictly equal:%0A'), a[0]);
  assert.ok(a[0].includes("'99.00' !== '99'"), a[0]);
  assert.ok(a[1].startsWith('::error title=standin_suite.js failed::FAIL junk never archived'), a[1]);
  assert.ok(a[1].includes("expected '[71.6,99]' got '[71.6,99.00]'"), a[1]);
});

test('not on GitHub: no annotation, the same exit code and output', () => {
  const r = around('  FAIL  two\n', 1, false);
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(annotationsIn(r.stdout), []);
});

test('a crash with no FAIL line: one annotation with its last lines', () => {
  const r = around('starting\nTypeError: x is not a function\n    at y (z.js:1:2)\n', 1);
  assert.strictEqual(r.status, 1);
  const a = annotationsIn(r.stdout);
  assert.strictEqual(a.length, 1);
  assert.ok(/exit 1 with no FAIL line - its last lines:%0Astarting%0ATypeError: x is not a function/.test(a[0]), a[0]);
});

test('a suite killed by a signal: a failure (exit 1), said', () => {
  const env = Object.assign({}, process.env, { GITHUB_ACTIONS: 'true' });
  const r = spawnSync(process.execPath, [RUN, process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 1);
  assert.ok(/\(SIGKILL\)/.test(annotationsIn(r.stdout)[0]), r.stdout);
});

test('many failures: nine annotations and a count of the rest (GitHub shows ten a step)', () => {
  const out = Array.from({ length: 14 }, (_, i) => `  FAIL t${i}`).join('\n') + '\n';
  const a = annotationsIn(around(out, 1).stdout);
  assert.strictEqual(a.length, 10);
  assert.ok(a[9].endsWith('... and 5 more FAIL lines'), a[9]);
});

test('GitHub\'s escaping: % CR LF in messages; and : , in the title too', () => {
  assert.strictEqual(R.esc('50% a\r\nb'), '50%25 a%0D%0Ab');
  assert.strictEqual(R.escProp('a: b, c'), 'a%3A b%2C c');
  const a = R.annotations('  FAIL  100%: done\n', 1, null, 'x: y.js');
  assert.deepStrictEqual(a, ['::error title=x%3A y.js failed::FAIL  100%25: done']);
});

test('the suite\'s name in the title: its file, past any wrapper', () => {
  const env = Object.assign({}, process.env, { GITHUB_ACTIONS: 'true' });
  const r = spawnSync(process.execPath, [RUN, 'bash', '-c', 'echo "  FAIL x"; exit 3', 'scripts/test_fetch_temp.sh'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 3, 'any exit code passes through');
  assert.ok(annotationsIn(r.stdout)[0].startsWith('::error title=test_fetch_temp.sh failed::FAIL x'), r.stdout);
});

console.log('\n' + '='.repeat(60));
console.log(`${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exitCode = failed ? 1 : 0;
