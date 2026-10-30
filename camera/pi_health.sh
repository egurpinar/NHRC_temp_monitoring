#!/bin/bash
# NHRC - a Pi's health report, for the Mac's hourly check (camera/pi_check.sh).
#
# Installed on each Pi as /usr/local/bin/nhrc-pi-health, and named as the only
# command the Mac's check key may run (in ~/.ssh/authorized_keys):
#
#   restrict,command="/usr/local/bin/nhrc-pi-health" ssh-ed25519 AAAA... nhrc-pi-health
#
# So that key can do one thing: print this report. The report changes nothing
# on the Pi, and never prints a secret: not the camera's env file, not the Ring
# token. Each step has a time limit, so a Pi that is struggling is not held up
# further by being checked.
#
# The first line is a summary, which the Mac keeps, one line per check:
#
#   SUMMARY up 8 hours, 12 minutes; load 0.31; memory available 241 MB; ...
#
# See camera/README.md, "Checking the Pis from the Mac".

set -u
export LC_ALL=C

# Over ssh, always the system's own tools and files. The tests stand in for
# them, from outside ssh only.
if [ -n "${SSH_CONNECTION:-}" ] || [ -z "${NHRC_HEALTH_PATH:-}" ]; then
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  ROOT=''
  STEP=60
else
  PATH=$NHRC_HEALTH_PATH
  ROOT=${NHRC_HEALTH_ROOT:-}
  STEP=${NHRC_HEALTH_STEP_SECONDS:-60}
fi
export PATH

case "${SSH_ORIGINAL_COMMAND:-report}" in
  report) ;;
  *)
    echo "not allowed: this key can only get the health report" >&2
    exit 1
    ;;
esac

DB="$ROOT/etc/pihole/pihole-FTL.db"
FTL_LOG="$ROOT/var/log/pihole/FTL.log"
FRAMES="$ROOT/opt/nhrc-camera/timelapse"
STARTED=$(date +%s)

# A step, never longer than STEP seconds; what it says goes into the report.
step() {
  timeout "$STEP" "$@" 2>&1
  [ $? -eq 124 ] && echo "(stopped after $STEP s)"
  return 0
}
# A step that needs root: read-only, and never waiting for a password. The
# logs too: the user may not be allowed to read a journal just made persistent.
as_root() { step sudo -n "$@"; }
logs() { as_root journalctl -q --no-pager "$@"; }
section() { printf '\n== %s ==\n' "$1"; }
# The first line of what a step said, if it looks as expected; else "?".
value() { local v; v=$(sed -n '1p'); if printf '%s' "$v" | grep -qxE "$1"; then printf '%s' "$v"; else printf '?'; fi; }
# Kernel lines worth seeing - not the ones every boot prints.
KERNEL_WARN='oom-kill|out of memory|brcmf.*(error|fail|timeout|halt|trap|died)|mmc.*(timeout|error|never left|failed)|under-?voltage|hung task|blocked for more|i/o error|ext4-fs (error|.*recovery|.*orphan)|segfault|call trace|internal error|oops|(^|[^a-z])bug:'

# How the last restart came about: "clean" when the Pi was shut down first,
# "not clean" after a freeze or a power cut (a boot with no shutdown before it).
restart_kind() {
  case "$(step last -x reboot shutdown | sed -n '2p' | awk '{print $1}')" in
    shutdown) echo clean ;;
    reboot) echo 'not clean' ;;
    *) echo unknown ;;
  esac
}

watchdog() {
  local w
  w=$(step systemctl show -p RuntimeWatchdogUSec --value | value '[0-9a-z.]+')
  case "$w" in
    '?') echo '?' ;;
    0|infinity) echo off ;;
    *) echo "$w" ;;
  esac
}

summary() {
  local up load mem swap thr ftl cam since boot
  up=$(step uptime -p | sed 's/^up //' | value '[0-9a-z, ]+')
  load=$(cut -d' ' -f1 "$ROOT/proc/loadavg" 2>/dev/null | value '[0-9.]+')
  mem=$(step free -m | awk '/^Mem:/ {print $7}' | value '[0-9]+')
  swap=$(step free -m | awk '/^Swap:/ {print $3 " of " $2}' | value '[0-9]+ of [0-9]+')
  thr=$(step vcgencmd get_throttled | sed 's/^throttled=//' | value '0x[0-9a-fA-F]+')
  ftl=$(step systemctl is-active pihole-FTL | value '[a-z-]+')
  cam=$(step systemctl is-active nhrc-camera | value '[a-z-]+')
  since=$(step uptime -s | value '[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:]{8}')
  # Which boot this is: the Mac tells a restart by it (the time of the last
  # restart, worked out from the clock, can move by a second or two).
  boot=$(cut -c1-8 "$ROOT/proc/sys/kernel/random/boot_id" 2>/dev/null | value '[0-9a-f]{8}')
  printf 'SUMMARY up %s; load %s; memory available %s MB; swap %s MB used; throttled %s; pihole-FTL %s; nhrc-camera %s; last restart %s (%s); watchdog %s; boot %s\n' \
    "$up" "$load" "$mem" "$swap" "$thr" "$ftl" "$cam" "$since" "$(restart_kind)" "$(watchdog)" "$boot"
}

summary
printf 'Report from %s at %s\n' "$(step hostname)" "$(date '+%Y-%m-%d %H:%M:%S %Z')"

section 'Restarts (a boot with no shutdown before it: a freeze or a power cut)'
step last -x reboot shutdown | head -8
logs --list-boots | tail -5

section 'Protections'
echo "hardware watchdog: $(watchdog)"
echo "reboot after a kernel crash: $(cat "$ROOT/proc/sys/kernel/panic" 2>/dev/null) s (0 = never)"
if [ -d "$ROOT/var/log/journal" ]; then
  echo 'logs kept across restarts: yes'
else
  echo 'logs kept across restarts: no (they are lost at every restart)'
fi

section 'Power'
step vcgencmd get_throttled

section 'Memory'
step free -m
step ps -eo rss=,comm= --sort=-rss | head -6 | awk '{printf "%6d MB  %s\n", $1 / 1024, $2}'

section 'SD card'
step df -h /
rootdev=$(step findmnt -no SOURCE /)
case "$rootdev" in
  /dev/*) as_root tune2fs -l "$rootdev" | grep -iE '^(filesystem state|errors behavior|fs error count|first error (time|function)|last error (time|function))' ;;
  *) echo "root device not found ($rootdev)" ;;
esac

section 'Wi-Fi'
step iw dev wlan0 get power_save
awk 'NR > 2 { gsub(/\./, "", $3); gsub(/\./, "", $4); print $1 " link quality " $3 ", signal " $4 " dBm" }' "$ROOT/proc/net/wireless" 2>/dev/null

section 'Pi-hole'
echo "pihole-FTL: $(step systemctl is-active pihole-FTL)"
echo 'Gaps of over an hour in the DNS queries it answered, last 14 days:'
as_root nice -n 10 pihole-FTL sqlite3 "$DB" "SELECT datetime(prev,'unixepoch','localtime') AS last_query, datetime(timestamp,'unixepoch','localtime') AS next_query, CAST((timestamp-prev)/60 AS INT) AS minutes FROM (SELECT timestamp, LAG(timestamp) OVER (ORDER BY timestamp) AS prev FROM query_storage WHERE timestamp > CAST(strftime('%s','now','-14 days') AS INT)) WHERE timestamp-prev > 3600; SELECT 'last query: ' || datetime(MAX(timestamp),'unixepoch','localtime') FROM query_storage;"
echo 'Its log:'
as_root tail -n 6 "$FTL_LOG"

section 'Camera service'
step systemctl show nhrc-camera -p ActiveState -p SubState -p NRestarts -p ExecMainStartTimestamp
echo 'Restarts, takeovers, memory guards and the days, last 3 days:'
logs -u nhrc-camera --since '3 days ago' \
  | grep -E 'frames saved|restarting the service|not started: only|memory available fell|taking over|back to standing by|nhrc-camera.service:' \
  | tail -15
echo 'Memory during captures today (about hourly):'
logs -u nhrc-camera --since today \
  | grep 'available throughout' \
  | sed -E 's/^(.{15}).*this program ([0-9]+) MB.*at least ([0-9]+) MB.*/\1  this program \2 MB, the Pi at least \3 MB available/' \
  | awk 'NR % 12 == 1'
echo 'Its last lines:'
logs -u nhrc-camera -n 8
echo 'Timelapse days (frames):'
if [ -d "$FRAMES" ]; then
  for d in $(ls "$FRAMES" | grep -E '^20[0-9]{2}-[01][0-9]-[0-3][0-9]$' | tail -3); do
    echo "$d $(ls "$FRAMES/$d" | grep -c '\.jpg$') frames, the last $(ls "$FRAMES/$d" | grep '\.jpg$' | tail -1)"
  done
else
  echo 'none on this Pi'
fi

section 'Kernel warnings since the last restart'
logs -k -b | grep -iE "$KERNEL_WARN" | tail -15

section 'Before the last restart'
if [ "$(logs --list-boots | grep -cE '^ *-?[0-9]+ ')" -gt 1 ]; then
  echo 'Kernel warnings:'
  logs -k -b -1 | grep -iE "$KERNEL_WARN" | tail -15
  echo 'Its last lines:'
  logs -b -1 -n 40
else
  echo '(no logs from before the last restart: they were not kept then)'
fi

printf '\nReport took %s s.\n' "$(( $(date +%s) - STARTED ))"
