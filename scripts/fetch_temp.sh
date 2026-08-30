#!/usr/bin/env bash
# Fetch the water temperature from the Govee OpenAPI and record it.
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
#
# Exit codes: 0 if at least one reading was recorded, 1 if none were.

set -uo pipefail

GOVEE_DEVICE="${GOVEE_DEVICE:-03:48:01:69:00:00:00:0F:FF:FF:00:45:FF:FF:00:45}"
GOVEE_SKU="${GOVEE_SKU:-H5109}"
LOOP_MINUTES="${LOOP_MINUTES:-0}"
SAMPLE_INTERVAL_SECONDS="${SAMPLE_INTERVAL_SECONDS:-900}"
GIT_COMMIT="${GIT_COMMIT:-0}"
GOVEE_FAKE_RESPONSE="${GOVEE_FAKE_RESPONSE:-}"

recorded=0

log() { echo "[$(date -u +%H:%M:%S)] $*"; }

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

  TEMP_C=$(echo "scale=2; ($TEMP_F - 32) * 5 / 9" | bc)
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

  TEMP_F_CLEAN=$(echo "scale=2; $TEMP_F / 1" | bc)
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
