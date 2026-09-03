#!/usr/bin/env bash
# Tests for scripts/send_window.sh.
#
# Every case is expressed as a wall-clock time at the boathouse, converted to an
# epoch and fed in through NOW_OVERRIDE, so the decisions are checked against
# real timezone arithmetic rather than an assumed UTC offset. Both EDT and EST
# are covered, including the daylight-saving changeover days.
#
# Run: bash scripts/test_send_window.sh

SCRIPT="$(cd "$(dirname "$0")" && pwd)/send_window.sh"
ZONE=America/New_York
pass=0; fail=0

# Epoch for a given wall-clock moment at the boathouse.
at() { TZ=$ZONE date -d "$1" +%s; }

expect() { # expect <label> <when> <expected first word> [expected wait seconds]
  local label="$1" when="$2" want="$3" wantwait="${4:-}"
  local out kind
  out=$(NOW_OVERRIDE="$(at "$when")" bash "$SCRIPT")
  kind=$(echo "$out" | awk '{print $1}')
  if [ "$kind" != "$want" ]; then
    fail=$((fail+1)); echo "  FAIL $label"
    echo "        at $when expected $want, got: $out"
    return
  fi
  if [ -n "$wantwait" ]; then
    local got; got=$(echo "$out" | awk '{print $2}')
    if [ "$got" != "$wantwait" ]; then
      fail=$((fail+1)); echo "  FAIL $label -- expected wait ${wantwait}s, got ${got}s"
      return
    fi
  fi
  pass=$((pass+1)); echo "  ok   $label  ($out)"
}

section(){ echo; echo "$1"; echo "${1//?/-}"; }

section "0. Syntax"
bash -n "$SCRIPT" && { pass=$((pass+1)); echo "  ok   send_window.sh parses"; } || { fail=$((fail+1)); echo "  FAIL syntax"; }

section "1. Inside the send window (summer, EDT)"
expect "1:00 AM sends"            "2026-07-15 01:00:00" SEND
expect "1:30 AM sends"            "2026-07-15 01:30:00" SEND
expect "3:00 AM sends (late but useful)" "2026-07-15 03:00:00" SEND
expect "4:59 AM sends"            "2026-07-15 04:59:00" SEND

section "2. Past the cutoff -- the case that lost real emails"
# The observed failure: a 1 AM trigger that actually started at 5 AM Eastern.
expect "5:00 AM skips"            "2026-07-15 05:00:00" SKIP
expect "5:01 AM skips"            "2026-07-15 05:01:00" SKIP
expect "9:00 AM skips"            "2026-07-15 09:00:00" SKIP
expect "11:59 AM skips"           "2026-07-15 11:59:00" SKIP

section "3. Before the window -- wait rather than skip"
expect "9:00 PM waits 4h"         "2026-07-15 21:00:00" WAIT 14400
expect "10:00 PM waits 3h"        "2026-07-15 22:00:00" WAIT 10800
expect "11:30 PM waits 1.5h"      "2026-07-15 23:30:00" WAIT 5400
expect "midnight waits 1h"        "2026-07-16 00:00:00" WAIT 3600
expect "12:59 AM waits 1 min"     "2026-07-16 00:59:00" WAIT 60

section "4. Too early to wait for"
# Midday is 13 hours out; sleeping that long would blow the 6-hour job limit.
expect "noon skips"               "2026-07-15 12:00:00" SKIP
expect "4:00 PM skips"            "2026-07-15 16:00:00" SKIP
expect "8:00 PM is within 5h"     "2026-07-15 20:00:00" WAIT 18000

section "5. Winter (EST) -- same wall-clock behaviour"
expect "1:00 AM EST sends"        "2026-01-15 01:00:00" SEND
expect "5:00 AM EST skips"        "2026-01-15 05:00:00" SKIP
expect "9:00 PM EST waits 4h"     "2026-01-15 21:00:00" WAIT 14400
expect "midnight EST waits 1h"    "2026-01-16 00:00:00" WAIT 3600

section "6. Daylight saving changeover days"
# Spring forward 2026-03-08: 2 AM never happens, so 9 PM the previous evening is
# only THREE hours before 1 AM, not four. A fixed-offset calculation would
# oversleep by an hour and miss the window.
expect "night before spring forward" "2026-03-07 21:00:00" WAIT 14400
expect "1 AM on spring-forward day"  "2026-03-08 01:00:00" SEND
expect "9 PM on spring-forward day"  "2026-03-08 21:00:00" WAIT 14400
# Fall back 2026-11-01: 1 AM happens twice.
expect "night before fall back"      "2026-10-31 21:00:00" WAIT 14400
expect "1 AM on fall-back day"       "2026-11-01 01:00:00" SEND
expect "9 PM on fall-back day"       "2026-11-01 21:00:00" WAIT 14400

section "7. The wait never exceeds the job limit"
for when in "2026-07-15 20:00:00" "2026-07-15 21:00:00" "2026-07-15 23:00:00" "2026-01-15 20:00:00" "2026-11-01 20:00:00"; do
  out=$(NOW_OVERRIDE="$(at "$when")" bash "$SCRIPT")
  secs=$(echo "$out" | awk '/^WAIT/{print $2}')
  if [ -n "$secs" ] && [ "$secs" -gt 18000 ]; then
    fail=$((fail+1)); echo "  FAIL $when would sleep ${secs}s"
  else
    pass=$((pass+1)); echo "  ok   $when within the limit ($out)"
  fi
done

section "8. A waited run lands inside the window"
# The point of waiting is that the send happens at 1 AM. Verify by advancing the
# clock by the returned wait and re-asking: the answer must be SEND.
for when in "2026-07-15 21:00:00" "2026-07-15 23:30:00" "2026-01-15 22:00:00" "2026-03-07 21:00:00" "2026-10-31 21:00:00"; do
  start=$(at "$when")
  out=$(NOW_OVERRIDE="$start" bash "$SCRIPT")
  secs=$(echo "$out" | awk '/^WAIT/{print $2}')
  if [ -z "$secs" ]; then fail=$((fail+1)); echo "  FAIL $when did not WAIT ($out)"; continue; fi
  after=$(( start + secs ))
  out2=$(NOW_OVERRIDE="$after" bash "$SCRIPT")
  local_hour=$(TZ=$ZONE date -d "@$after" "+%H:%M %Z")
  if [ "$(echo "$out2" | awk '{print $1}')" = "SEND" ]; then
    pass=$((pass+1)); echo "  ok   $when -> wakes at $local_hour -> SEND"
  else
    fail=$((fail+1)); echo "  FAIL $when -> wakes at $local_hour -> $out2"
  fi
done

echo
echo "============================================================"
echo "$pass passed, $fail failed"
echo "============================================================"
[ "$fail" -eq 0 ]
