#!/usr/bin/env bash
# Decides what a daily-email run should do, given the time it actually started.
#
# THE PROBLEM THIS SOLVES
# -----------------------
# GitHub Actions cron is best effort and the delays here are large: a 05:00 UTC
# trigger (1:00 AM Eastern) has been observed starting at 5:00 AM Eastern, four
# hours late. The old gate then correctly refused to send, because a digest
# arriving after 5 AM is no use to someone already at the boathouse -- so
# members simply got no email, and the run was green.
#
# Widening the window again would just trade usefulness for reliability. Instead
# the workflow is now scheduled hours EARLY and this script decides:
#
#   before the window   -> WAIT <seconds>   (sleep, then send at 1 AM)
#   inside the window   -> SEND             (on time, or late but still useful)
#   after the window    -> SKIP <reason>    (too late to help anyone)
#
# A punctual start waits; a four-hour delay lands on time. Both send at 1 AM.
#
# Environment:
#   TARGET_HOUR      hour to send, boathouse local time (default 1 = 1 AM)
#   LATEST_HOUR      last hour a late send is still worth making (default 5)
#   MAX_WAIT_SECONDS refuse to sleep longer than this (default 18000 = 5h),
#                    so the job cannot exceed the GitHub 6-hour limit
#   NOW_OVERRIDE     epoch seconds; tests only
#
# Prints exactly one line: "SEND", "WAIT <seconds>", or "SKIP <reason>".

set -uo pipefail

ZONE="${BOATHOUSE_TZ:-America/New_York}"
TARGET_HOUR="${TARGET_HOUR:-1}"
LATEST_HOUR="${LATEST_HOUR:-5}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-18000}"

now_epoch="${NOW_OVERRIDE:-$(date +%s)}"

# Local hour, base-10 forced: bash reads a leading zero as octal, so "08" and
# "09" would otherwise be errors rather than 8 and 9.
et_hour=$((10#$(TZ="$ZONE" date -d "@$now_epoch" +%H)))

# Send window: TARGET_HOUR up to but not including LATEST_HOUR.
if [ "$et_hour" -ge "$TARGET_HOUR" ] && [ "$et_hour" -lt "$LATEST_HOUR" ]; then
  echo "SEND"
  exit 0
fi

# Past the window: today's digest is no longer worth sending. Waiting for
# tomorrow would mean a ~20 hour job, far past what a runner allows.
if [ "$et_hour" -ge "$LATEST_HOUR" ] && [ "$et_hour" -lt 12 ]; then
  echo "SKIP started at ${et_hour}:00 ${ZONE}, past the ${LATEST_HOUR}:00 cutoff"
  exit 0
fi

# Before the window. From midday onward the next send is tomorrow's; between
# midnight and TARGET_HOUR it is later today. Computing the target as a date
# string in the boathouse zone keeps this correct across daylight saving,
# rather than assuming a fixed offset.
if [ "$et_hour" -lt "$TARGET_HOUR" ]; then
  day="today"
else
  day="tomorrow"
fi

target_epoch=$(TZ="$ZONE" date -d "$(TZ="$ZONE" date -d "@$now_epoch" +%Y-%m-%d) $day $(printf '%02d' "$TARGET_HOUR"):00:00" +%s 2>/dev/null)
if [ -z "${target_epoch:-}" ]; then
  # Fall back to plain relative parsing if the composed form is not supported.
  target_epoch=$(TZ="$ZONE" date -d "$day $(printf '%02d' "$TARGET_HOUR"):00" +%s 2>/dev/null)
fi

if [ -z "${target_epoch:-}" ]; then
  echo "SKIP could not compute the next ${TARGET_HOUR}:00 in $ZONE"
  exit 0
fi

wait_seconds=$(( target_epoch - now_epoch ))

if [ "$wait_seconds" -le 0 ]; then
  # The target is behind us despite the hour check -- treat as sendable rather
  # than sleeping a negative amount.
  echo "SEND"
  exit 0
fi

if [ "$wait_seconds" -gt "$MAX_WAIT_SECONDS" ]; then
  echo "SKIP would need to wait ${wait_seconds}s, over the ${MAX_WAIT_SECONDS}s limit"
  exit 0
fi

echo "WAIT $wait_seconds"
