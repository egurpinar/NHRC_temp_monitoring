#!/usr/bin/env node
/**
 * Runs one test suite, passing its output and exit code through. On GitHub
 * (GITHUB_ACTIONS=true) each failing test also becomes an annotation, so the
 * run page - and GitHub's failure email - say which test failed and why,
 * readable without signing in (GitHub shows the logs only to those who are).
 *
 *   node scripts/run_suite.js bash scripts/test_fetch_temp.sh
 *   node scripts/run_suite.js node camera/test_snapshot_service.js
 */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

// GitHub's workflow commands: a message escapes %, CR and LF; a property also : and ,.
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** The annotations for a failed run's output: each FAIL line with the lines that explain it. */
function annotations(output, code, signal, suite) {
  const title = escProp(`${suite} failed`);
  const lines = output.split('\n');
  const found = [];
  lines.forEach((l, i) => {
    if (!/^\s*FAIL\b/.test(l)) return;
    // The FAIL line, then its indented explanation (node suites), up to 8 lines.
    const block = [l.trim()];
    for (let j = i + 1; j < lines.length && block.length < 8 && /^\s{6,}/.test(lines[j]); j++) {
      if (lines[j].trim()) block.push(lines[j].trim());
    }
    found.push(block.join('\n'));
  });
  const out = found.slice(0, 9).map(f => `::error title=${title}::${esc(f.slice(0, 1500))}`);
  if (found.length > 9) out.push(`::error title=${title}::${esc(`... and ${found.length - 9} more FAIL lines`)}`);
  if (!found.length) {
    out.push(`::error title=${title}::${esc(`exit ${code}${signal ? ` (${signal})` : ''} with no FAIL line - its last lines:\n` +
      lines.filter(Boolean).slice(-15).join('\n'))}`);
  }
  return out;
}

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) { console.error('usage: run_suite.js <command> [args...]'); process.exit(2); }
  const suite = path.basename(args.filter(a => !a.startsWith('-')).pop() || cmd);
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { process.stdout.write(d); output += d; });
  child.stderr.on('data', (d) => { process.stderr.write(d); output += d; });
  child.on('error', (e) => { output += `\n${e.message}\n`; });
  child.on('close', (code, signal) => {
    const failed = code !== 0;
    if (failed && process.env.GITHUB_ACTIONS === 'true') for (const a of annotations(output, code, signal, suite)) console.log(a);
    process.exitCode = code === null ? 1 : code;
  });
}

module.exports = { annotations, esc, escProp };
