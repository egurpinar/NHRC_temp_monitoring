#!/bin/bash
# NHRC - your Mac checks the Pis every hour and keeps what they say where
# Claude (and you) can read it: .pi-health/ in this repository's folder, which
# is never committed (.gitignore).
#
#   bash camera/pi_check.sh install emre@pihole2 [emre@standby]   set it up (once)
#   bash camera/pi_check.sh run                                   check now (what the schedule runs)
#   bash camera/pi_check.sh update                                put the latest report on the Pis
#   bash camera/pi_check.sh uninstall                             stop the hourly check
#
# install puts the report (camera/pi_health.sh) on each Pi as
# /usr/local/bin/nhrc-pi-health, and gives this Mac a key of its own that can
# run that report and nothing else - no shell, no other command, nothing
# written. It asks once for each Pi's password, or your key's passphrase.
#
# Each check writes, in .pi-health/:
#
#   emre@pihole2.txt   the latest report from that Pi, whole
#   history.log        one line per Pi per check: its summary, or why it did not answer
#
# A notification says when one Pi answers but another has not, two checks in
# a row (it may have frozen); when it answers again; and when a Pi has
# restarted without a clean shutdown since the last check. No Pi answering
# means this Mac is away from home (or the home network is down): nothing is
# said then.
#
# Written for the bash every Mac has (3.2).

set -u
set -o pipefail

NAME="NHRC Pi Check"
LABEL="com.nhrc.pi-check"
SUPPORT="${NHRC_PICHECK_SUPPORT:-$HOME/Library/Application Support/$NAME}"
APP="$SUPPORT/$NAME.app"
SCRIPT="$SUPPORT/pi_check.sh"
SETTINGS="$SUPPORT/settings"
STATE="$SUPPORT/state"
LOCK="$SUPPORT/.running"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
KEY="${NHRC_PICHECK_KEY:-$HOME/.ssh/nhrc_pi_health}"
SSH="${NHRC_PICHECK_SSH:-ssh}"                        # the tests stand in for ssh
HELPER="${NHRC_PICHECK_HELPER:-/usr/local/bin/nhrc-pi-health}"
RETRY_SECONDS="${NHRC_PICHECK_RETRY_SECONDS:-30}"     # a Pi that does not answer is asked again once
HERE="$(cd "$(dirname "$0")" && pwd)"
EVERY_SECONDS=3600
HISTORY_KEEP=5000                                     # about three months of hourly lines for two Pis

# A Pi as user@address: letters, digits, dots, dashes and underscores (and the
# colons of an IPv6 address) - nothing ssh could take for an option, nothing a
# file name or a notification could break on.
valid_pi() {
  local re='^[A-Za-z0-9_][A-Za-z0-9._-]*@[A-Za-z0-9_][A-Za-z0-9._:-]*$'
  [[ $1 =~ $re ]]
}

# A value as the history shows it: on one line, plain characters only.
shown() { printf '%s' "$1" | tr -c 'A-Za-z0-9@._:,;()/ -' '?'; }
last_line() { tail -n 1 "$1" 2>/dev/null | tr -d '\r'; }

# What install wrote: "dest <folder>" and "pi <user@address>" lines.
setting() { [ -f "$SETTINGS" ] && sed -n "s/^$1 //p" "$SETTINGS"; return 0; }

# The report from a Pi, through the check key: never waits for a password, never
# reads this script's input, gives up on a Pi that stops answering.
ask() {
  "$SSH" -n -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=4 "$1" report > "$2" 2> "$3"
}

# Remembered between checks, in $STATE: "missed <pi> <n>", "boot <pi> <id>".
state_get() {
  [ -f "$STATE" ] || return 0
  awk -v k="$1" -v p="$2" '$1 == k && $2 == p { $1 = ""; $2 = ""; sub(/^ +/, ""); print; exit }' "$STATE"
}
state_set() {
  { [ -f "$STATE" ] && awk -v k="$1" -v p="$2" '!($1 == k && $2 == p)' "$STATE"
    [ -n "$3" ] && printf '%s %s %s\n' "$1" "$2" "$3"
    true; } > "$STATE.new" && mv -f "$STATE.new" "$STATE"
}

history() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$DEST/history.log"; }

notify() {
  history "notice: $1"
  if [ -n "${NHRC_PICHECK_NOTIFY:-}" ]; then "$NHRC_PICHECK_NOTIFY" "$1"; return 0; fi
  # The text is made of a Pi's address (checked by valid_pi), times and fixed
  # words: no quote to break out of.
  /usr/bin/osascript -e "display notification \"$1\" with title \"$NAME\"" >/dev/null 2>&1 || true
}

run() {
  local pis=() ok=() missing=() PI n=0 reached=0 tmp err first boot when kind before c
  if [ "$#" -gt 0 ]; then
    pis=("$@")
  else
    while read -r PI; do [ -n "$PI" ] && pis+=("$PI"); done <<< "$(setting pi)"
  fi
  if [ "${#pis[@]}" -eq 0 ]; then
    echo "No Pi to check: set it up first - bash camera/pi_check.sh install emre@pihole2 [emre@standby]" >&2
    return 1
  fi
  DEST="${NHRC_PICHECK_DEST:-$(setting dest | head -n 1)}"
  [ -n "$DEST" ] || DEST="$HERE/../.pi-health"
  mkdir -p "$SUPPORT" "$DEST" || return 1
  # One check at a time (the schedule and one started by hand); a lock left by
  # a check that died is taken over after half an hour.
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      rm -rf "$LOCK" && mkdir "$LOCK" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  trap 'rm -rf "$LOCK"' EXIT
  err="$SUPPORT/.last-error"

  for PI in "${pis[@]}"; do
    n=$((n + 1))
    if ! valid_pi "$PI"; then
      history "not a Pi: \"$(shown "$PI")\" - give each as user@address"
      continue
    fi
    tmp="$DEST/.$PI.tmp"
    if ask "$PI" "$tmp" "$err" || { sleep "$RETRY_SECONDS"; ask "$PI" "$tmp" "$err"; }; then
      first=$(head -n 1 "$tmp")
      case "$first" in
        'SUMMARY '*) ;;
        *)
          history "$PI answered, but not with its report: $(shown "$first$(last_line "$err")")"
          rm -f "$tmp"
          missing+=("$PI")
          continue
          ;;
      esac
      mv -f "$tmp" "$DEST/$PI.txt"
      history "$PI $(shown "${first#SUMMARY }")"
      reached=$((reached + 1))
      ok+=("$PI")
      # Restarted since the last check (another boot)? Said only when it was
      # not clean: a freeze, or a power cut.
      boot=$(printf '%s' "$first" | sed -n 's/.*; boot \([0-9a-f]\{8\}\)$/\1/p')
      when=$(printf '%s' "$first" | sed -n 's/.*; last restart \([0-9: -]*\) (\([a-z ]*\));.*/\1/p')
      kind=$(printf '%s' "$first" | sed -n 's/.*; last restart \([0-9: -]*\) (\([a-z ]*\));.*/\2/p')
      before=$(state_get boot "$PI")
      if [ -n "$boot" ]; then
        if [ -n "$before" ] && [ "$before" != "$boot" ] && [ "$kind" = 'not clean' ]; then
          notify "$PI restarted at ${when:-a time it does not know} without a clean shutdown: a freeze or a power cut."
        fi
        state_set boot "$PI" "$boot"
      fi
    else
      history "$PI did not answer ($(shown "$(last_line "$err")"))"
      rm -f "$tmp"
      missing+=("$PI")
    fi
  done

  if [ "$reached" -eq 0 ]; then
    history "no Pi answered: this Mac is probably away from home, or the home network is down"
  else
    for PI in ${missing[@]+"${missing[@]}"}; do
      c=$(state_get missed "$PI")
      c=$(( ${c:-0} + 1 ))
      state_set missed "$PI" "$c"
      [ "$c" -eq 2 ] && notify "$PI has not answered for two checks in a row, while the other Pi does: it may have frozen."
    done
    for PI in ${ok[@]+"${ok[@]}"}; do
      c=$(state_get missed "$PI")
      [ "${c:-0}" -ge 2 ] && notify "$PI answers again."
      state_set missed "$PI" ''
    done
  fi

  if [ "$(wc -l < "$DEST/history.log")" -gt "$HISTORY_KEEP" ]; then
    tail -n "$HISTORY_KEEP" "$DEST/history.log" > "$DEST/.history.new" && mv -f "$DEST/.history.new" "$DEST/history.log"
  fi
  return 0
}

# The report and the check key, onto one Pi - through your own ssh login, so it
# may ask for that Pi's password, or your key's passphrase.
setup_pi() {
  local PI=$1 report="$HERE/pi_health.sh" b64 line installer first tmp err
  if [ ! -f "$report" ] || ! head -n 1 "$report" | grep -qx '#!/bin/bash'; then
    echo "camera/pi_health.sh must be next to this script: run it from the repository's folder." >&2
    return 1
  fi
  [ -f "$KEY.pub" ] || { echo "No key at $KEY.pub - run install first." >&2; return 1; }
  b64=$(base64 < "$report" | tr -d '\n')
  line="restrict,command=\"$HELPER\" $(cat "$KEY.pub")"
  # Run on the Pi as one word of base64, so nothing in it needs quoting.
  installer="set -e
tmp=\$(mktemp)
trap 'rm -f \"\$tmp\"' EXIT
printf '%s' '$b64' | base64 -d > \"\$tmp\"
head -n 1 \"\$tmp\" | grep -qx '#!/bin/bash' || { echo 'the report did not arrive whole' >&2; exit 3; }
if ! sudo -n install -m 755 \"\$tmp\" '$HELPER' 2>/dev/null; then
  echo 'sudo asks for a password on this Pi - see camera/README.md, Checking the Pis from the Mac' >&2
  exit 4
fi
if [ -d /var/log/journal ]; then sudo -n systemd-tmpfiles --create --prefix /var/log/journal 2>/dev/null || true; fi
umask 077
mkdir -p ~/.ssh
line='$line'
if ! grep -qxF \"\$line\" ~/.ssh/authorized_keys 2>/dev/null; then
  if [ -s ~/.ssh/authorized_keys ] && [ -n \"\$(tail -c 1 ~/.ssh/authorized_keys)\" ]; then echo >> ~/.ssh/authorized_keys; fi
  printf '%s\\n' \"\$line\" >> ~/.ssh/authorized_keys
fi
echo installed"
  echo "Putting the report on $PI, with this Mac's read-only key (it may ask for that Pi's password)..."
  "$SSH" "$PI" "echo $(printf '%s' "$installer" | base64 | tr -d '\n') | base64 -d | bash" || return 1
  mkdir -p "$SUPPORT"
  tmp="$SUPPORT/.first-report" err="$SUPPORT/.last-error"
  if ! ask "$PI" "$tmp" "$err"; then
    echo "The key does not work on $PI yet: $(last_line "$err")" >&2
    return 1
  fi
  first=$(head -n 1 "$tmp")
  rm -f "$tmp"
  case "$first" in
    'SUMMARY '*) echo "$PI answers: ${first#SUMMARY }" ;;
    *) echo "$PI did not answer with its report: $first" >&2; return 1 ;;
  esac
}

update() {
  local pis=() PI
  if [ "$#" -gt 0 ]; then pis=("$@"); else while read -r PI; do [ -n "$PI" ] && pis+=("$PI"); done <<< "$(setting pi)"; fi
  [ "${#pis[@]}" -gt 0 ] || { echo "No Pi given, and none set up: bash camera/pi_check.sh install emre@pihole2 [emre@standby]" >&2; return 1; }
  for PI in "${pis[@]}"; do
    valid_pi "$PI" || { echo "Give each Pi as user@address - not \"$PI\"" >&2; return 1; }
  done
  for PI in "${pis[@]}"; do setup_pi "$PI" || return 1; done
}

install() {
  local PI repo dest
  [ "$#" -ge 1 ] || { echo "Give the Pis as user@address, e.g.: bash $0 install emre@pihole2 emre@standby" >&2; return 1; }
  for PI in "$@"; do
    valid_pi "$PI" || { echo "Give each Pi as user@address, e.g.: bash $0 install emre@pihole2 - not \"$PI\"" >&2; return 1; }
  done
  if [ "$(uname)" != Darwin ]; then
    echo "This part runs on your Mac." >&2
    return 1
  fi
  repo=$(cd "$HERE/.." && pwd)
  dest="$repo/.pi-health"
  if ! grep -qx '.pi-health/' "$repo/.gitignore" 2>/dev/null; then
    echo "$repo/.gitignore must keep .pi-health/ out of git first." >&2
    return 1
  fi
  mkdir -p "$SUPPORT" "$HOME/.ssh" "$HOME/Library/LaunchAgents" "$dest" || return 1
  chmod 700 "$HOME/.ssh"

  # 1. Its own key, which each Pi lets run the report and nothing else.
  if [ ! -f "$KEY" ]; then
    ssh-keygen -q -t ed25519 -N '' -C 'nhrc-pi-health (read-only health report)' -f "$KEY" || return 1
  fi
  # 2. The report and the key on each Pi.
  for PI in "$@"; do setup_pi "$PI" || return 1; done

  # 3. Where the results go, and which Pis; this script, where the schedule can
  #    always read it.
  { echo "dest $dest"; for PI in "$@"; do echo "pi $PI"; done; } > "$SETTINGS" || return 1
  cp "$0" "$SCRIPT" && chmod 755 "$SCRIPT" || return 1

  # 4. A small app that runs it: macOS asks per app whether it may reach the
  #    local network and use the Documents folder - this one is "NHRC Pi Check".
  rm -rf "$APP"
  osacompile -o "$APP" \
    -e 'try' \
    -e "do shell script \"/bin/bash \" & quoted form of \"$SCRIPT\" & \" run\"" \
    -e 'end try' || return 1

  # 5. Every hour, while the Mac is awake.
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
  <key>StartInterval</key>
  <integer>$EVERY_SECONDS</integer>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" || return 1

  # 6. A first check now, through the app - so macOS asks its questions now.
  echo "Checking now. If macOS asks whether \"$NAME\" may find devices on your local network, or use files in your Documents folder, click Allow."
  open -W "$APP"
  echo
  tail -n "$#" "$dest/history.log" 2>/dev/null
  echo
  echo "Done. Every hour your Mac checks the Pis; what they say is in $dest."
}

uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
  rm -f "$PLIST"
  rm -rf "$SUPPORT"
  echo "Stopped. What the checks wrote stays in .pi-health/; so does the key, ~/.ssh/nhrc_pi_health."
  echo "To take the key off a Pi too, delete its line (ending 'nhrc-pi-health (read-only health report)')"
  echo "from ~/.ssh/authorized_keys there; the report itself is $HELPER."
}

case "${1:-}" in
  run) shift; run "$@" ;;
  install) shift; install "$@" ;;
  update) shift; update "$@" ;;
  uninstall) uninstall ;;
  *)
    echo "Usage: bash $0 install user@pi [user@pi], or: bash $0 run|update|uninstall" >&2
    exit 1
    ;;
esac
