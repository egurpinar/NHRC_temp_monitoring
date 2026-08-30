#!/usr/bin/env bash
# Tests for scripts/fetch_temp.sh.
#
# Runs against a real local git remote, because the risky part of that script is
# not the arithmetic -- it is what happens when a push is rejected, when two
# runs race, and when a rebase conflicts. Those paths cannot be reasoned about
# safely; they have to be executed.
#
# No network and no Govee key required: GOVEE_FAKE_RESPONSE injects the API
# response.
#
# Run: bash scripts/test_fetch_temp.sh

SCRIPT="$(cd "$(dirname "$0")" && pwd)/fetch_temp.sh"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1";
       else fail=$((fail+1)); echo "  FAIL $1 -- expected '$3' got '$2'"; fi; }
ok(){ if [ "$2" = "0" ] || [ "$2" = "true" ]; then pass=$((pass+1)); echo "  ok   $1";
      else fail=$((fail+1)); echo "  FAIL $1"; fi; }
section(){ echo; echo "$1"; echo "${1//?/-}"; }

TEMP_OK='{"payload":{"capabilities":[{"instance":"online","state":{"value":true}},{"instance":"sensorTemperature","state":{"value":73.36}}]}}'

# ══════════════════════════════════════════════════════════════════════════
section "0. Syntax"
# ══════════════════════════════════════════════════════════════════════════
bash -n "$SCRIPT"; ok "fetch_temp.sh parses" "$?"

# ══════════════════════════════════════════════════════════════════════════
section "1. Reading and recording"
# ══════════════════════════════════════════════════════════════════════════
W=$(mktemp -d); cd "$W" || exit 1
echo '[{"ts":"2026-08-29T12:00:00Z","tempC":22.0,"tempF":71.6}]' > history.json
echo '{}' > data.json

export GOVEE_FAKE_RESPONSE="$TEMP_OK"
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "exit 0 on a good reading" "$?" "0"
chk "history appended" "$(jq length history.json)" "2"
chk "tempF recorded" "$(jq -r '.[-1].tempF' history.json)" "73.36"
chk "tem is Celsius x100" "$(jq -r '.data.devices[0].deviceExt.lastDeviceData' data.json | jq -r .tem)" "2297"
chk "online recorded" "$(jq -r '.data.devices[0].deviceExt.lastDeviceData' data.json | jq -r .online)" "true"

# ══════════════════════════════════════════════════════════════════════════
section "2. Bad input never overwrites good data"
# ══════════════════════════════════════════════════════════════════════════
# The empty-string case is not hypothetical: it is exactly what the API returned
# for several hours after the replacement sensor was paired but before the
# gateway picked it up. Writing that through would have blanked the website.
cp data.json data.before
for body in \
  '{"code":200,"payload":{"capabilities":[{"instance":"online","state":{"value":false}},{"instance":"sensorTemperature","state":{"value":""}}]}}' \
  '{"code":401,"message":"unauthorized"}' \
  '' \
  'not json at all' \
  '{"payload":{"capabilities":[]}}' \
  '{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":"N/A"}}]}}' \
  '{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":null}}]}}' ; do
  export GOVEE_FAKE_RESPONSE="$body"
  LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
  chk "rejected: ${body:0:38}" "$?" "1"
done
chk "data.json untouched by bad input" "$(cmp -s data.json data.before && echo same)" "same"
chk "history untouched by bad input" "$(jq length history.json)" "2"

# ══════════════════════════════════════════════════════════════════════════
section "3. Value ranges"
# ══════════════════════════════════════════════════════════════════════════
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":31}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "integer value accepted" "$(jq -r '.[-1].tempF' history.json)" "31"
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":-4.5}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "sub-zero value accepted" "$(jq -r '.[-1].tempF' history.json)" "-4.5"
chk "sub-zero converts to C" "$(jq -r '.[-1].tempC' history.json)" "-20.27"
# The replacement sensor advertises no "online" capability at all.
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":70.0}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "missing online defaults true" "$(jq -r '.data.devices[0].deviceExt.lastDeviceData' data.json | jq -r .online)" "true"

# ══════════════════════════════════════════════════════════════════════════
section "4. The loop"
# ══════════════════════════════════════════════════════════════════════════
export GOVEE_FAKE_RESPONSE="$TEMP_OK"
before=$(jq length history.json); start=$(date +%s)
LOOP_MINUTES=1 SAMPLE_INTERVAL_SECONDS=5 GIT_COMMIT=0 bash "$SCRIPT" > loop.log 2>&1
elapsed=$(( $(date +%s) - start )); added=$(( $(jq length history.json) - before ))
echo "  ($added readings in ${elapsed}s at a 5s interval over a 60s window)"
if [ "$added" -ge 8 ]; then pass=$((pass+1)); echo "  ok   sampled repeatedly"; else fail=$((fail+1)); echo "  FAIL only $added readings"; fi
if [ "$elapsed" -le 75 ]; then pass=$((pass+1)); echo "  ok   respected its window"; else fail=$((fail+1)); echo "  FAIL overran at ${elapsed}s"; fi
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" > single.log 2>&1
chk "LOOP_MINUTES=0 takes exactly one reading" "$(grep -c 'New entry' single.log)" "1"
chk "and does not sleep" "$(grep -c sleeping single.log)" "0"

# ══════════════════════════════════════════════════════════════════════════
section "5. Git: push, races, and conflicts"
# ══════════════════════════════════════════════════════════════════════════
G=$(mktemp -d); ORIGIN="$G/origin.git"
git init -q --bare -b main "$ORIGIN"
mkdir "$G/seed" && cd "$G/seed" && git init -qb main
echo '[{"ts":"2026-08-29T12:00:00Z","tempC":22.0,"tempF":71.6}]' > history.json
echo '{}' > data.json
git add -A && git commit -qm init && git remote add origin "$ORIGIN" && git push -q -u origin main
cd "$G" && git clone -q "$ORIGIN" work && cd work

export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":73.4}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" > a.log 2>&1
chk "clean push exits 0" "$?" "0"
chk "reading reached origin" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF')" "73.4"

# Someone else pushes between our checkout and our push.
git clone -q "$ORIGIN" ../other
( cd ../other && echo unrelated > NOTES.md && git add -A && git commit -qm other && git push -q )
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":74.1}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" > b.log 2>&1
chk "survives a push race" "$?" "0"
chk "noticed the rejection" "$(grep -c 'push rejected' b.log)" "1"
chk "their commit survived" "$(git --git-dir="$ORIGIN" cat-file -p main:NOTES.md)" "unrelated"
chk "our reading survived" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF')" "74.1"
chk "no readings lost" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq length)" "3"

# A conflicting append to the same file, which cannot be rebased automatically.
( cd ../other && git pull -q --rebase && jq '. + [{"ts":"2026-08-29T23:00:00Z","tempC":1,"tempF":33.8}]' history.json > h && mv h history.json && git add -A && git commit -qm conflict && git push -q )
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":75.2}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" > c.log 2>&1
chk "fails loudly rather than losing a reading" "$?" "1"
chk "repo not stranded mid-rebase" "$(test -d .git/rebase-merge -o -d .git/rebase-apply && echo BROKEN || echo clean)" "clean"
chk "origin JSON still valid" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -e . >/dev/null 2>&1 && echo valid)" "valid"
chk "the other run's data intact" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF')" "33.8"

# The next scheduled run gets a fresh checkout and must simply work.
cd "$G" && git clone -q "$ORIGIN" work2 && cd work2
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":76.3}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" > d.log 2>&1
chk "next run recovers" "$?" "0"
chk "its reading landed" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF')" "76.3"

before=$(git rev-parse HEAD)
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":77.0}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "GIT_COMMIT=0 commits nothing" "$(git rev-parse HEAD)" "$before"

git checkout -q -- .; before=$(git rev-parse HEAD)
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":""}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" >/dev/null 2>&1
chk "a failed reading commits nothing" "$(git rev-parse HEAD)" "$before"

# Each reading should reach the site as it happens, not in a batch at the end.
cd "$G" && git clone -q "$ORIGIN" work3 && cd work3
n0=$(git --git-dir="$ORIGIN" rev-list --count main)
export GOVEE_FAKE_RESPONSE="$TEMP_OK"
LOOP_MINUTES=1 SAMPLE_INTERVAL_SECONDS=20 GIT_COMMIT=1 bash "$SCRIPT" > g.log 2>&1
n1=$(git --git-dir="$ORIGIN" rev-list --count main)
if [ $((n1-n0)) -ge 3 ]; then pass=$((pass+1)); echo "  ok   loop pushes incrementally ($((n1-n0)) commits)";
else fail=$((fail+1)); echo "  FAIL loop produced only $((n1-n0)) commits"; fi
chk "no unpushed commits at exit" "$(git rev-list --count '@{u}..HEAD')" "0"
chk "origin JSON valid after the loop" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -e . >/dev/null 2>&1 && echo valid)" "valid"

rm -rf "$W" "$G"
echo
echo "============================================================"
echo "$pass passed, $fail failed"
echo "============================================================"
[ "$fail" -eq 0 ]
