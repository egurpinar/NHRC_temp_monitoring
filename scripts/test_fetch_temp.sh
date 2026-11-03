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

# Temperatures are checked as numbers ("jq '... + 0'"), not as written: jq 1.7
# and later print a number as it stands in the file (99.00), jq 1.6 as a
# number (99). GitHub's runners have the newer jq; the first run there failed
# on exactly that, though the files are the same JSON either way.

# Sections 1-5 test polling the sensor directly - what the job does without the
# Worker. Section 6 turns the Worker back on, with stand-in files.
export WORKER_ARCHIVE=0

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
chk "tempF recorded" "$(jq -r '.[-1].tempF + 0' history.json)" "73.36"
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
reading(){ export GOVEE_FAKE_RESPONSE="{\"payload\":{\"capabilities\":[{\"instance\":\"sensorTemperature\",\"state\":{\"value\":$1}}]}}"
           LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1; }
reading 31
chk "integer value accepted" "$(jq -r '.[-1].tempF + 0' history.json)" "31"
chk "below 0°C converts to C" "$(jq -r '.[-1].tempC + 0' history.json)" "-0.55"
# Between -1 and 1 °C bc writes ".55" / "-.55" - not valid JSON. Every file must
# stay strictly valid, checked here with Python's parser, which (unlike jq)
# rejects a missing leading zero.
for f in 33 32.5 31 33.79; do
  reading "$f"
  chk "${f}F: history.json strictly valid JSON" "$(python3 -c 'import json,sys; json.load(open("history.json")); print("ok")' 2>&1)" "ok"
  chk "${f}F: data.json strictly valid JSON" "$(python3 -c 'import json; json.load(open("data.json")); print("ok")' 2>&1)" "ok"
done
chk "33F stored as 0.55C" "$(python3 -c 'import json; print(json.load(open("history.json"))[-4]["tempC"])')" "0.55"
chk "tem keeps its sign below freezing" "$(reading 31; jq -r '.data.devices[0].deviceExt.lastDeviceData' data.json | jq -r .tem)" "-55"
# jq re-serialises numbers on the way into history.json, which would hide the
# bug in that file - so check the raw entry the script builds, as it logs it.
GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":33}}]}}' \
  LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" > lead.log 2>&1
chk "the raw entry has a leading zero (0.55)" "$(grep -o '"tempC":[^,]*' lead.log | head -1)" '"tempC":0.55'
GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":31.5}}]}}' \
  LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" > lead.log 2>&1
chk "and below zero (-0.27)" "$(grep -o '"tempC":[^,]*' lead.log | head -1)" '"tempC":-0.27'

# Impossible water temperatures are faults, not readings.
cp data.json data.before; n=$(jq length history.json)
for f in -4.5 0 0.5 27.9 100.1 150 999; do
  reading "$f"; chk "implausible ${f}F rejected" "$?" "1"
done
chk "data.json untouched by implausible readings" "$(cmp -s data.json data.before && echo same)" "same"
chk "history untouched by implausible readings" "$(jq length history.json)" "$n"
reading 28; chk "28F (the floor) accepted" "$?" "0"
reading 100; chk "100F (the ceiling) accepted" "$?" "0"
MIN_PLAUSIBLE_F=-40 LOOP_MINUTES=0 GIT_COMMIT=0 GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":-4.5}}]}}' bash "$SCRIPT" >/dev/null 2>&1
chk "the bounds can be overridden" "$(jq -r '.[-1].tempC + 0' history.json)" "-20.27"
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
chk "reading reached origin" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF + 0')" "73.4"

# Someone else pushes between our checkout and our push.
git clone -q "$ORIGIN" ../other
( cd ../other && echo unrelated > NOTES.md && git add -A && git commit -qm other && git push -q )
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":74.1}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" > b.log 2>&1
chk "survives a push race" "$?" "0"
chk "noticed the rejection" "$(grep -c 'push rejected' b.log)" "1"
chk "their commit survived" "$(git --git-dir="$ORIGIN" cat-file -p main:NOTES.md)" "unrelated"
chk "our reading survived" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF + 0')" "74.1"
chk "no readings lost" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq length)" "3"

# A conflicting append to the same file, which cannot be rebased automatically.
( cd ../other && git pull -q --rebase && jq '. + [{"ts":"2026-08-29T23:00:00Z","tempC":1,"tempF":33.8}]' history.json > h && mv h history.json && git add -A && git commit -qm conflict && git push -q )
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":75.2}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" > c.log 2>&1
chk "fails loudly rather than losing a reading" "$?" "1"
chk "repo not stranded mid-rebase" "$(test -d .git/rebase-merge -o -d .git/rebase-apply && echo BROKEN || echo clean)" "clean"
chk "origin JSON still valid" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -e . >/dev/null 2>&1 && echo valid)" "valid"
chk "the other run's data intact" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF + 0')" "33.8"

# The next scheduled run gets a fresh checkout and must simply work.
cd "$G" && git clone -q "$ORIGIN" work2 && cd work2
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":76.3}}]}}'
LOOP_MINUTES=0 GIT_COMMIT=1 bash "$SCRIPT" > d.log 2>&1
chk "next run recovers" "$?" "0"
chk "its reading landed" "$(git --git-dir="$ORIGIN" cat-file -p main:history.json | jq -r '.[-1].tempF + 0')" "76.3"

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

# ══════════════════════════════════════════════════════════════════════════
section "6. The Worker's readings, archived (the sensor polled only without them)"
# ══════════════════════════════════════════════════════════════════════════
export WORKER_ARCHIVE=1
V=$(mktemp -d); cd "$V" || exit 1
F="$V/fake"; mkdir -p "$F"; export WORKER_FAKE_DIR="$F"
ago(){ date -u -d "-$1 minutes" +%Y-%m-%dT%H:%M:%SZ; }
OLD="2026-08-29T12:00:00Z"; B=$(ago 10); C=$(ago 5)
latest_json(){ # fetchedAt tem
  printf '{"status":200,"message":"Success","data":{"devices":[{"sku":"H5109","deviceName":"NHRC Water Sensor","deviceExt":{"lastDeviceData":"{\\"online\\":true,\\"tem\\":%s,\\"hum\\":0}"}}]},"fetchedAt":"%s","source":"worker"}' "$2" "$1"; }
reset(){ echo "[{\"ts\":\"$OLD\",\"tempC\":22.0,\"tempF\":71.6}]" > history.json; echo '{"fetchedAt":"2026-08-29T12:00:00Z"}' > data.json; }
# If the sensor were polled from here, its 99F would show up in history.json.
export GOVEE_FAKE_RESPONSE='{"payload":{"capabilities":[{"instance":"sensorTemperature","state":{"value":99}}]}}'

reset
echo "[{\"ts\":\"$OLD\",\"tempC\":0,\"tempF\":32},{\"ts\":\"$C\",\"tempC\":14,\"tempF\":57.2},{\"ts\":\"$B\",\"tempC\":13.9,\"tempF\":57.02}]" > "$F/recent.json"
latest_json "$C" 1400 > "$F/latest.json"
LOOP_MINUTES=180 GIT_COMMIT=0 bash "$SCRIPT" > w1.log 2>&1
chk "a healthy Worker: exit 0" "$?" "0"
chk "its readings archived, in time order" "$(jq -c '[.[].ts]' history.json)" "[\"$OLD\",\"$B\",\"$C\"]"
chk "a moment already archived keeps its value" "$(jq -r '.[0].tempF + 0' history.json)" "71.6"
chk "data.json is the Worker's latest" "$(jq -r .fetchedAt data.json)" "$C"
chk "the sensor is not polled from here" "$(jq '[.[] | select(.tempF == 99)] | length' history.json)" "0"
chk "and no three-hour loop" "$(grep -c sleeping w1.log)" "0"
chk "history.json strictly valid JSON" "$(python3 -c 'import json; json.load(open("history.json")); print("ok")' 2>&1)" "ok"

reset
echo "[{\"ts\":\"$(ago 120)\",\"tempC\":14,\"tempF\":57.2}]" > "$F/recent.json"
latest_json "$(ago 120)" 1400 > "$F/latest.json"
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" > w2.log 2>&1
chk "a Worker two hours behind: its readings kept" "$(jq '[.[] | select(.tempF == 57.2)] | length' history.json)" "1"
chk "and the sensor polled directly" "$(jq -r '.[-1].tempF + 0' history.json)" "99"
chk "the log says why" "$(grep -c 'over 45 minutes old' w2.log)" "1"

reset; rm -f "$F/recent.json" "$F/latest.json"
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" > w3.log 2>&1
chk "no Worker: the sensor polled, as before" "$(jq -r '.[-1].tempF + 0' history.json)" "99"
chk "the log says the Worker could not be reached" "$(grep -c 'could not be reached' w3.log)" "1"

for junk in '{"not":"an array"}' 'not json' '[]' '[1,"x",null]' \
  "[{\"ts\":\"yesterday\",\"tempC\":14,\"tempF\":57.2}]" \
  "[{\"ts\":\"$C\",\"tempC\":14,\"tempF\":\"57.2\"}]" \
  "[{\"ts\":\"$C\",\"tempF\":57.2}]" \
  "[{\"ts\":\"$C\",\"tempC\":65.5,\"tempF\":150}]" \
  "[{\"ts\":\"$C\",\"tempC\":-17.7,\"tempF\":0}]"; do
  reset; printf '%s' "$junk" > "$F/recent.json"; latest_json "$C" 1400 > "$F/latest.json"
  LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
  chk "junk never archived: ${junk:0:40}" "$(jq -c '[.[].tempF + 0]' history.json)" "[71.6,99]"
done

reset; echo "{\"fetchedAt\":\"$(ago 1)\",\"marker\":1}" > data.json
echo "[{\"ts\":\"$C\",\"tempC\":14,\"tempF\":57.2}]" > "$F/recent.json"; latest_json "$C" 1400 > "$F/latest.json"
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "an older latest never replaces data.json" "$(jq -r .marker data.json)" "1"
reset; latest_json "$C" 99999 > "$F/latest.json"
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "nor an implausible one" "$(jq -r .fetchedAt data.json)" "2026-08-29T12:00:00Z"
reset; printf '{"fetchedAt":"%s"}' "$C" > "$F/latest.json"
LOOP_MINUTES=0 GIT_COMMIT=0 bash "$SCRIPT" >/dev/null 2>&1
chk "nor one without a temperature" "$(jq -r .fetchedAt data.json)" "2026-08-29T12:00:00Z"

# Git: one commit for the Worker's readings; none when there is nothing new.
G2=$(mktemp -d); ORIGIN2="$G2/origin.git"
git init -q --bare -b main "$ORIGIN2"
mkdir "$G2/seed" && cd "$G2/seed" && git init -qb main
echo "[{\"ts\":\"$OLD\",\"tempC\":22.0,\"tempF\":71.6}]" > history.json; echo '{}' > data.json
git add -A && git commit -qm init && git remote add origin "$ORIGIN2" && git push -q -u origin main
cd "$G2" && git clone -q "$ORIGIN2" work && cd work
echo "[{\"ts\":\"$B\",\"tempC\":13.9,\"tempF\":57.02},{\"ts\":\"$C\",\"tempC\":14,\"tempF\":57.2}]" > "$F/recent.json"; latest_json "$C" 1400 > "$F/latest.json"
n0=$(git --git-dir="$ORIGIN2" rev-list --count main)
LOOP_MINUTES=180 GIT_COMMIT=1 bash "$SCRIPT" > g1.log 2>&1
chk "pushed: exit 0" "$?" "0"
chk "one commit" "$(( $(git --git-dir="$ORIGIN2" rev-list --count main) - n0 ))" "1"
chk "the Worker's readings reached origin" "$(git --git-dir="$ORIGIN2" cat-file -p main:history.json | jq length)" "3"
LOOP_MINUTES=180 GIT_COMMIT=1 bash "$SCRIPT" > g2.log 2>&1
chk "nothing new: exit 0" "$?" "0"
chk "nothing new: no commit" "$(( $(git --git-dir="$ORIGIN2" rev-list --count main) - n0 ))" "1"
chk "no unpushed commits" "$(git rev-list --count '@{u}..HEAD')" "0"
cd "$V"
chk "the workflow leaves the Worker on" "$(grep -c 'WORKER_ARCHIVE' "$(dirname "$SCRIPT")/../.github/workflows/fetch_temp.yml")" "0"
unset WORKER_FAKE_DIR GOVEE_FAKE_RESPONSE
rm -rf "$V" "$G2"

rm -rf "$W" "$G"
echo
echo "============================================================"
echo "$pass passed, $fail failed"
echo "============================================================"
[ "$fail" -eq 0 ]
