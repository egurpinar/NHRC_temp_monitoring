#!/bin/bash
# NHRC timelapse - copies the finished days from the Pi into iCloud Drive.
#
# Runs on your Mac, every evening at 21:30: after sunset, when the Pi has
# stopped filming (the latest sunset, in June, is 20:30). Each finished day the
# Mac does not have yet is fetched once, whole, into
#
#   iCloud Drive / NHRC Timelapse / 2026-10-14 / 2026-10-14_0705.jpg ...
#
# and macOS uploads it. If the Mac is asleep at 21:30, it runs when it wakes,
# and catches up on any days it missed. Nothing changes on the Pi, and no
# Apple password goes anywhere.
#
# It reaches the Pi with its own key, which can only list and fetch the
# frames (the Pi's nhrc-timelapse-export) - see camera/README.md,
# "Copying the frames to iCloud".
#
#   bash timelapse_to_icloud.sh install emre@pihole2   set it up (once)
#   bash timelapse_to_icloud.sh run emre@pihole2       copy now (what the schedule runs)
#   bash timelapse_to_icloud.sh uninstall                   stop it (the frames stay)
#
# What it did: ~/Library/Logs/nhrc-timelapse.log
#
# Written for the bash every Mac has (3.2).

set -u
set -o pipefail

NAME="NHRC Timelapse"
LABEL="com.nhrc.timelapse-to-icloud"
SUPPORT="$HOME/Library/Application Support/$NAME"
APP="$SUPPORT/$NAME.app"
SCRIPT="$SUPPORT/timelapse_to_icloud.sh"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="${NHRC_TIMELAPSE_LOG:-$HOME/Library/Logs/nhrc-timelapse.log}"
KEY="$HOME/.ssh/nhrc_timelapse"
DEST="${NHRC_TIMELAPSE_DEST:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/$NAME}"
STATE="${NHRC_TIMELAPSE_STATE:-$SUPPORT/days-copied}"
LOCK="$SUPPORT/.running"
SSH="${NHRC_TIMELAPSE_SSH:-ssh}"   # the tests stand in for ssh
HELPER="/usr/local/bin/nhrc-timelapse-export"
DAY_DONE_HOUR=21                   # by 21:00 a day's last frame is in
RUN_HOUR=21
RUN_MINUTE=30

log() {
  mkdir -p "$(dirname "$LOG")"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
}

# The Pi, through the read-only key. Never waits for a password, and never
# reads this script's input (-n): in the loop over the days, ssh would
# otherwise swallow the rest of the list after the first day.
pi() {
  "$SSH" -n -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$PI" "$1"
}

# The last line of a file, on one line, for the log.
last_line() { tail -n 1 "$1" 2>/dev/null | tr -d '\r'; }

run() {
  PI="$1"
  mkdir -p "$SUPPORT" || return 0
  touch "$STATE"
  local err="$SUPPORT/.last-error"
  # One copy at a time (the schedule and a copy started by hand); a lock left
  # by a copy that died is taken over after two hours.
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
      rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null || return 0
    else
      log "another copy is running; this one stops"
      return 0
    fi
  fi
  trap 'rm -rf "$LOCK"' EXIT
  # Without iCloud Drive on, the folder would be an ordinary one, never uploaded.
  if [ -z "${NHRC_TIMELAPSE_DEST:-}" ] && [ ! -d "$HOME/Library/Mobile Documents/com~apple~CloudDocs" ]; then
    log "iCloud Drive cannot be found: is it on (System Settings > Apple Account > iCloud), and may \"$NAME\" use it (Privacy & Security > Files & Folders)?"
    return 0
  fi
  # The boathouse's date and hour, whatever the Mac's own timezone.
  local today hour
  today="${NHRC_TIMELAPSE_TODAY:-$(TZ=America/New_York date +%F)}"
  hour="${NHRC_TIMELAPSE_HOUR:-$(TZ=America/New_York date +%H)}"
  hour=$((10#$hour))

  local list
  if ! list=$(pi list 2>"$err"); then
    log "could not reach the Pi ($(last_line "$err")); trying again tomorrow at 21:30, or when this Mac wakes"
    return 0
  fi
  if ! mkdir -p "$DEST" 2>"$err" || ! touch "$DEST/.nhrc-write-test" 2>"$err"; then
    log "could not write to iCloud Drive ($(last_line "$err")) - allow \"$NAME\" in System Settings > Privacy & Security > Files & Folders"
    return 0
  fi
  rm -f "$DEST/.nhrc-write-test"

  local copied=0 frames=0 failed=0 day count got incoming f
  while read -r day count; do
    case "$day" in
      2[0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]) ;;
      *) continue ;;
    esac
    case "$count" in ''|*[!0-9]*) continue ;; esac
    # Finished days only: before today - or today, once its last frame is in.
    if [[ "$day" > "$today" ]]; then continue; fi
    if [ "$day" = "$today" ] && [ "$hour" -lt "$DAY_DONE_HOUR" ]; then continue; fi
    if grep -qx "$day" "$STATE"; then continue; fi
    if [ "$count" -eq 0 ]; then
      echo "$day" >> "$STATE"
      continue
    fi
    # Fetched into a folder of this Mac's own first (not uploaded): a day
    # arrives in iCloud Drive whole, or not at all.
    incoming="$SUPPORT/incoming-$day"
    rm -rf "$incoming"
    mkdir -p "$incoming"
    if pi "get $day" 2>"$err" | tar -xf - -C "$incoming" 2>>"$err"; then
      got=$(find "$incoming/$day" -maxdepth 1 -name '*.jpg' 2>/dev/null | wc -l | tr -d ' ')
    else
      got=0
    fi
    if [ "$got" -ge "$count" ]; then
      mkdir -p "$DEST/$day"
      for f in "$incoming/$day"/*.jpg; do mv -n "$f" "$DEST/$day/"; done
      rm -rf "$incoming"
      echo "$day" >> "$STATE"
      copied=$((copied + 1))
      frames=$((frames + got))
    else
      log "could not copy $day: $got of its $count frames arrived ($(last_line "$err")); trying again next time"
      rm -rf "$incoming"
      failed=$((failed + 1))
    fi
  done <<< "$list"

  if [ "$copied" -gt 0 ]; then
    log "copied $copied day$([ "$copied" -eq 1 ] || echo s), $frames frames, to iCloud Drive/$NAME"
  elif [ "$failed" -eq 0 ]; then
    log "nothing new to copy"
  fi
  return 0
}

install() {
  PI="$1"
  case "$PI" in
    *@*) ;;
    *) echo "Give the Pi as user@address, e.g.: bash $0 install emre@pihole2" >&2; return 1 ;;
  esac
  if [ "$(uname)" != Darwin ]; then
    echo "This part runs on your Mac." >&2
    return 1
  fi
  mkdir -p "$SUPPORT" "$HOME/.ssh" "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"
  chmod 700 "$HOME/.ssh"

  # 1. Its own key, which the Pi will let list and fetch frames, nothing else.
  if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -C 'nhrc-timelapse (read-only frames)' -f "$KEY" || return 1
  fi
  if ! pi list >/dev/null 2>&1; then
    echo "Adding this Mac's key to the Pi, read-only (it may ask for your Pi password)..."
    printf 'restrict,command="%s" %s\n' "$HELPER" "$(cat "$KEY.pub")" | "$SSH" "$PI" \
      "test -x $HELPER || { echo 'First install $HELPER on the Pi - see camera/README.md' >&2; exit 3; }; umask 077; mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" \
      || return 1
    if ! pi list >/dev/null 2>/tmp/nhrc-timelapse-key.err; then
      echo "The key does not work yet: $(last_line /tmp/nhrc-timelapse-key.err)" >&2
      return 1
    fi
  fi
  echo "The Pi answers: $(pi list | wc -l | tr -d ' ') days of frames there."

  # 2. This script, where the schedule can always read it.
  cp "$0" "$SCRIPT" && chmod 755 "$SCRIPT" || return 1

  # 3. A small app that runs it. macOS asks permission for iCloud Drive (and
  #    the local network) per app: this one is "NHRC Timelapse".
  rm -rf "$APP"
  osacompile -o "$APP" \
    -e 'try' \
    -e "do shell script \"/bin/bash \" & quoted form of \"$SCRIPT\" & \" run \" & quoted form of \"$PI\"" \
    -e 'end try' || return 1

  # 4. The schedule: every day at 21:30, or as soon as the Mac wakes after it.
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-W</string>
    <string>-g</string>
    <string>$APP</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$RUN_HOUR</integer>
    <key>Minute</key>
    <integer>$RUN_MINUTE</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || return 1

  # 5. A first copy now, through the app - so if macOS asks whether "NHRC
  #    Timelapse" may use iCloud Drive or the local network, it asks now.
  echo "Copying now. If macOS asks whether \"$NAME\" may access iCloud Drive or find devices on your local network, click Allow."
  open -W "$APP"
  echo
  tail -n 3 "$LOG"
  echo
  echo "Done. Every evening at 21:30 the finished days go to iCloud Drive > $NAME."
  echo "What it did: tail ~/Library/Logs/nhrc-timelapse.log"
}

uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  rm -rf "$SUPPORT"
  echo "Stopped. The frames in iCloud Drive stay; so does the key, ~/.ssh/nhrc_timelapse."
  echo "To take the key off the Pi too, delete its line (ending 'nhrc-timelapse (read-only frames)') from ~/.ssh/authorized_keys there."
}

case "${1:-}" in
  run) run "${2:?the Pi, as user@address}" ;;
  install) install "${2:?the Pi, as user@address}" ;;
  uninstall) uninstall ;;
  *)
    echo "Usage: bash $0 install|run user@pi-address, or: bash $0 uninstall" >&2
    exit 1
    ;;
esac
