#!/bin/sh
# NHRC timelapse - the Pi's side of copying the frames to a Mac.
#
# Installed on the Pi as /usr/local/bin/nhrc-timelapse-export, and named as the
# only command the Mac's key may run (in ~/.ssh/authorized_keys):
#
#   restrict,command="/usr/local/bin/nhrc-timelapse-export" ssh-ed25519 AAAA... nhrc-timelapse
#
# So that key can do two things, and nothing else - no shell, no other files,
# nothing written:
#
#   list             each day's folder and how many frames it holds: "2026-10-14 134"
#   get YYYY-MM-DD   that day's folder, as a tar stream
#
# See camera/README.md, "Copying the frames to iCloud".

DIR="${NHRC_TIMELAPSE_DIR:-/opt/nhrc-camera/timelapse}"
request="${SSH_ORIGINAL_COMMAND:-}"

case "$request" in
  list)
    # No folder yet - a standby Pi that has never filmed: no days.
    [ -e "$DIR" ] || exit 0
    cd "$DIR" || exit 1
    for day in 2[0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]; do
      [ -d "$day" ] || continue
      echo "$day $(ls "$day" | grep -c '\.jpg$')"
    done
    ;;
  "get "2[0-9][0-9][0-9]-[01][0-9]-[0-3][0-9])
    day="${request#get }"
    if [ ! -d "$DIR/$day" ]; then
      echo "no such day: $day" >&2
      exit 1
    fi
    # The frames only: not the hidden half-written ones.
    exec tar -C "$DIR" -cf - --exclude='.*' "$day"
    ;;
  *)
    echo "not allowed: this key can only list and fetch timelapse days" >&2
    exit 1
    ;;
esac
