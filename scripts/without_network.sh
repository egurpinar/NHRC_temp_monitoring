#!/usr/bin/env bash
# Runs a command - a test suite, or test_time_travel.js - with the network cut
# off for every process it starts: node through no_network.js (NODE_OPTIONS),
# curl, wget and nc through stand-ins that refuse. Afterwards anything that
# tried is listed, and the run fails even if every test passed: no test may
# depend on a server somewhere else.
#
#   bash scripts/without_network.sh node scripts/test_daily_email.js
#   bash scripts/without_network.sh node scripts/test_time_travel.js
set -u
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
log="$tmp/attempts.log"
: > "$log"
mkdir "$tmp/bin"
for t in curl wget nc ncat telnet; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\necho "%s: no network in the tests" >&2\nexit 7\n' "$t" "$log" "$t" > "$tmp/bin/$t"
  chmod +x "$tmp/bin/$t"
done
export PATH="$tmp/bin:$PATH" NO_NETWORK_LOG="$log"
export NODE_OPTIONS="${NODE_OPTIONS:-} --require \"$here/no_network.js\""

"$@"
code=$?
if [ -s "$log" ]; then
  echo
  echo "== Tried to reach the network (no test may):"
  sort "$log" | uniq -c | sort -rn | head -50
  [ "$code" = 0 ] && code=1
fi
exit "$code"
