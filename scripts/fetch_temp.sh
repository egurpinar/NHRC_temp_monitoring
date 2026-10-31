#!/usr/bin/env bash
# Archive the water readings into data.json and history.json.
#
# SINCE NOVEMBER 2026: THE CLOUDFLARE WORKER TAKES THE READINGS
# ---------------------------------------------------------------
# The camera's Cloudflare Worker reads the sensor every 15 minutes on its own
# Cron Trigger, which runs on time, and keeps the last 16 days. The website and
# the morning email read it first. This job now copies the Worker's readings
# into history.json - filling any gap GitHub's scheduler left - and stops: one
# short run per trigger, instead of a three-hour loop. Only when the Worker
# cannot be reached, or its newest reading is over 45 minutes old, does this job
# poll the sensor itself, as it always did (below). WORKER_ARCHIVE=0 skips the
# Worker altogether.
#
# WHY THIS IS A LOOP AND NOT JUST A CRON JOB
# ------------------------------------------
# GitHub Actions schedules are best effort. Measured on this repository, a
# '*/15' cron produced 12-44 runs a day against 96 scheduled -- and once went
# 49 hours without firing at all. The website warns when a reading is over 45
# minutes old, so those skipped triggers are exactly what members were seeing.
#
# Running a loop inside one job decouples the sampling rate from the trigger
# rate: however sparsely GitHub decides to start us, once started we keep
# sampling on our own clock. The workflow still schedules frequently, and
# concurrency cancel-in-progress means a new run simply replaces the old one.
#
# Environment:
#   GOVEE_API_KEY          required (unless GOVEE_FAKE_RESPONSE is set)
#   GOVEE_DEVICE           device id; defaults to the current sensor
#   GOVEE_SKU              defaults to H5109
#   LOOP_MINUTES           total run time; 0 means take a single reading
#   SAMPLE_INTERVAL_SECONDS  gap between readings, default 900 (15 min)
#   GIT_COMMIT             "1" to commit and push each reading, "0" to skip
#   GOVEE_FAKE_RESPONSE    test hook: use this instead of calling the API
#   WORKER_ARCHIVE         "1" (default) to copy the Worker's readings first; "0" to skip it
#   WORKER_WATER_URL       where the Worker serves latest.json and recent.json
#   WORKER_FRESH_SECONDS   the Worker counts as taking readings if its newest is this recent (2700)
#   WORKER_FAKE_DIR        test hook: latest.json / recent.json from this folder instead of the Worker
#
# Exit codes: 0 if at least one reading was recorded, 1 if none were.

set -uo pipefail

GOVEE_DEVICE="${GOVEE_DEVICE:-03:48:01:69:00:00:00:0F:FF:FF:00:45:FF:FF:00:45}"
GOVEE_SKU="${GOVEE_SKU:-H5109}"
LOOP_MINUTES="${LOOP_MINUTES:-0}"
SAMPLE_INTERVAL_SECONDS="${SAMPLE_INTERVAL_SECONDS:-900}"
GIT_COMMIT="${GIT_COMMIT:-0}"
GOVEE_FAKE_RESPONSE="${GOVEE_FAKE_RESPONSE:-}"

WORKER_ARCHIVE="${WORKER_ARCHIVE:-1}"
WORKER_WATER_URL="${WORKER_WATER_URL:-https://nhrc-camera.gurpinar-emre.workers.dev/water}"
WORKER_FRESH_SECONDS="${WORKER_FRESH_SECONDS:-2700}"
WORKER_FAKE_DIR="${WORKER_FAKE_DIR:-}"

recorded=0

# A water temperature outside this range (°F) is a sensor or API fault, not a
# reading: liquid water in the lake cannot be below freezing, and nothing near
# 100°F. Recording one would act on the website's rules - a single 0°F glitch
# forces Winter Rowing; a 150°F one could make a cold morning count as warm.
MIN_PLAUSIBLE_F="${MIN_PLAUSIBLE_F:-28}"
MAX_PLAUSIBLE_F="${MAX_PLAUSIBLE_F:-100}"

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

# bc prints values between -1 and 1 without a leading zero (".55", "-.27"),
# which is not valid JSON. jq happens to accept it today; nothing else that
# reads these files is obliged to. Every bc result goes through this.
lead0() { sed -E 's/^(-?)\./\10./'; }

call_api() {
  if [ -n "$GOVEE_FAKE_RESPONSE" ]; then
    printf '%s' "$GOVEE_FAKE_RESPONSE"
    return 0
  fi
  curl -s --max-time 30 -X POST "https://openapi.api.govee.com/router/api/v1/device/state" \
    -H "Govee-API-Key: $GOVEE_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"requestId\":\"fetch\",\"payload\":{\"sku\":\"$GOVEE_SKU\",\"device\":\"$GOVEE_DEVICE\"}}"
}

take_reading() {
  local FETCHED_AT TIMESTAMP RESPONSE TEMP_F ONLINE TEMP_C TEM TEMP_F_CLEAN NEW_ENTRY
  FETCHED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  TIMESTAMP=$(date +%s%3N)

  RESPONSE=$(call_api)
  log "Raw response: $RESPONSE"

  TEMP_F=$(echo "$RESPONSE" | jq -r '.payload.capabilities[]? | select(.instance=="sensorTemperature") | .state.value // empty' 2>/dev/null | head -1)
  ONLINE=$(echo "$RESPONSE" | jq -r '.payload.capabilities[]? | select(.instance=="online") | .state.value // empty' 2>/dev/null | head -1)

  # An empty string is what the API returns for a sensor it cannot currently
  # reach, so it must be rejected as firmly as a missing field. Anything
  # non-numeric is treated the same way.
  if [ -z "$TEMP_F" ] || [ "$TEMP_F" = "null" ] || ! echo "$TEMP_F" | grep -Eq '^-?[0-9]+(\.[0-9]+)?$'; then
    # IMPORTANT: on any API failure, do NOT overwrite data.json. The site keeps
    # showing the last known reading, with its own staleness warning, rather
    # than breaking or displaying something wrong.
    log "No usable temperature in response - leaving data.json untouched"
    return 1
  fi

  if ! awk -v f="$TEMP_F" -v lo="$MIN_PLAUSIBLE_F" -v hi="$MAX_PLAUSIBLE_F" 'BEGIN { exit !(f >= lo && f <= hi) }'; then
    log "Implausible water temperature ${TEMP_F}F (outside ${MIN_PLAUSIBLE_F}-${MAX_PLAUSIBLE_F}F) - leaving data.json untouched"
    return 1
  fi

  TEMP_C=$(echo "scale=2; ($TEMP_F - 32) * 5 / 9" | bc | lead0)
  TEM=$(echo "scale=0; ($TEMP_C * 100)/1" | bc)
  [ -z "$ONLINE" ] && ONLINE=true

  # data.json keeps the shape index.html already parses; lastDeviceData is a
  # JSON string holding tem (Celsius x100).
  jq -n \
    --arg ts "$FETCHED_AT" \
    --arg sku "$GOVEE_SKU" \
    --argjson tem "$TEM" \
    --argjson online "$ONLINE" \
    --argjson lasttime "$TIMESTAMP" \
    '{
      status: 200,
      message: "Success",
      data: { devices: [{
        sku: $sku,
        deviceName: "NHRC Water Sensor",
        deviceExt: { lastDeviceData: ({online: $online, tem: $tem, hum: 0, lastTime: $lasttime, avgDayTem: $tem, avgDayHum: 0} | tostring) }
      }] },
      fetchedAt: $ts
    }' > data.json || { log "failed writing data.json"; return 1; }

  TEMP_F_CLEAN=$(echo "scale=2; $TEMP_F / 1" | bc | lead0)
  NEW_ENTRY="{\"ts\":\"$FETCHED_AT\",\"tempC\":$TEMP_C,\"tempF\":$TEMP_F_CLEAN}"
  log "New entry: $NEW_ENTRY"

  if [ -f history.json ]; then
    jq --argjson entry "$NEW_ENTRY" '. + [$entry] | .[-525600:]' history.json > history_tmp.json \
      && mv history_tmp.json history.json
  else
    echo "[$NEW_ENTRY]" > history.json
  fi

  log "history.json entries: $(jq length history.json 2>/dev/null || echo 0)"
  recorded=$((recorded + 1))
  return 0
}

commit_reading() {
  [ "$GIT_COMMIT" = "1" ] || return 0
  git config user.name  "github-actions[bot]"
  git config user.email "github-actions[bot]@users.noreply.github.com"
  git add data.json history.json
  git diff --cached --quiet && { log "nothing to commit"; return 0; }
  git commit -q -m "chore: update temperature data"

  # Retry around a push race. Another run (or a person) may have pushed since
  # checkout; rebasing our single data commit on top is always the right
  # resolution, since each reading is an append.
  local attempt
  for attempt in 1 2 3; do
    if git push -q 2>/dev/null; then
      log "pushed"
      return 0
    fi
    log "push rejected (attempt $attempt) - rebasing on origin"
    git pull --rebase -q origin "$(git rev-parse --abbrev-ref HEAD)" || {
      log "rebase failed; abandoning this push"
      git rebase --abort 2>/dev/null
      return 1
    }
    sleep 3
  done
  log "could not push after 3 attempts"
  return 1
}

# One of the Worker's files (latest or recent), or nothing.
fetch_worker() {
  if [ -n "$WORKER_FAKE_DIR" ]; then
    cat "$WORKER_FAKE_DIR/$1.json" 2>/dev/null
    return
  fi
  curl -sf --max-time 20 "$WORKER_WATER_URL/$1.json"
}

# Copies the Worker's readings into history.json, and its latest reading into
# data.json when it is newer. Returns 0 when the Worker is taking readings (its
# newest is under WORKER_FRESH_SECONDS old), 1 when it cannot be reached or
# gives nothing usable, 2 when its newest reading is too old. Only well-formed
# readings in the plausible range are taken; a reading already in history.json
# (the same moment) is kept as it is.
archive_from_worker() {
  local recent good newest newest_s now_s latest cur new tem
  recent=$(fetch_worker recent) || { log "the Worker could not be reached"; return 1; }
  good=$(printf '%s' "$recent" | jq -c --argjson lo "$MIN_PLAUSIBLE_F" --argjson hi "$MAX_PLAUSIBLE_F" '
    if type == "array" then [ .[] | select(type == "object"
      and (.ts | type) == "string" and (.ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"))
      and (.tempF | type) == "number" and (.tempC | type) == "number"
      and .tempF >= $lo and .tempF <= $hi) | {ts, tempC, tempF} ] else empty end' 2>/dev/null)
  if [ -z "$good" ] || [ "$good" = "[]" ]; then
    log "the Worker gave no usable readings"
    return 1
  fi
  [ -f history.json ] || echo '[]' > history.json
  jq --argjson add "$good" '(. + $add) | unique_by(.ts) | .[-525600:]' history.json > history_tmp.json \
    && mv history_tmp.json history.json || { log "failed merging into history.json"; return 1; }
  log "history.json entries: $(jq length history.json 2>/dev/null || echo 0) (with the Worker's $(printf '%s' "$good" | jq length))"

  # data.json: the Worker's latest, if it holds a plausible temperature and is newer.
  latest=$(fetch_worker latest) || latest=""
  if [ -n "$latest" ]; then
    tem=$(printf '%s' "$latest" | jq -r '.data.devices[0].deviceExt.lastDeviceData | fromjson | .tem' 2>/dev/null)
    new=$(printf '%s' "$latest" | jq -r '.fetchedAt // empty' 2>/dev/null)
    cur=$(jq -r '.fetchedAt // empty' data.json 2>/dev/null)
    if echo "$tem" | grep -Eq '^-?[0-9]+$' \
      && awk -v t="$tem" -v lo="$MIN_PLAUSIBLE_F" -v hi="$MAX_PLAUSIBLE_F" 'BEGIN { f = t / 100 * 9 / 5 + 32; exit !(f >= lo && f <= hi) }' \
      && echo "$new" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' \
      && [[ "$new" > "$cur" ]]; then
      printf '%s' "$latest" | jq '.' > data.json || log "failed writing data.json"
    fi
  fi

  newest=$(printf '%s' "$good" | jq -r 'map(.ts) | max')
  newest_s=$(date -u -d "$newest" +%s 2>/dev/null || echo 0)
  now_s=$(date -u +%s)
  if [ $(( now_s - newest_s )) -gt "$WORKER_FRESH_SECONDS" ]; then
    log "the Worker's newest reading ($newest) is over $((WORKER_FRESH_SECONDS / 60)) minutes old"
    return 2
  fi
  log "the Worker is taking readings (newest $newest)"
  return 0
}

if [ "$WORKER_ARCHIVE" = "1" ]; then
  archive_from_worker
  worker_rc=$?
  if [ "$worker_rc" -ne 1 ]; then
    commit_reading || { log "ERROR: the Worker's readings could not be pushed"; exit 1; }
  fi
  if [ "$worker_rc" -eq 0 ]; then
    log "done - the Worker's readings archived; the sensor is not polled from here"
    exit 0
  fi
  log "polling the sensor directly, as before the Worker"
fi

END_TS=$(( $(date +%s) + LOOP_MINUTES * 60 ))

while : ; do
  if take_reading; then
    commit_reading
  fi

  NOW=$(date +%s)
  # Stop if the next sample would land past the end of the window. With
  # LOOP_MINUTES=0 this exits after the first reading.
  if [ "$(( NOW + SAMPLE_INTERVAL_SECONDS ))" -gt "$END_TS" ]; then
    break
  fi
  log "sleeping ${SAMPLE_INTERVAL_SECONDS}s until the next reading"
  sleep "$SAMPLE_INTERVAL_SECONDS"
done

log "done - $recorded reading(s) recorded"

# A reading that was written but never pushed is a reading nobody will ever see.
# Recording locally and exiting 0 would leave the job green while the website
# went stale -- the same silent failure that once hid a missing daily email for
# days. Check for commits that never reached the remote and fail loudly.
if [ "$GIT_COMMIT" = "1" ]; then
  unpushed=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  if [ "${unpushed:-0}" -gt 0 ]; then
    log "ERROR: $unpushed commit(s) were never pushed - the site will not see these readings"
    exit 1
  fi
fi

[ "$recorded" -gt 0 ]
