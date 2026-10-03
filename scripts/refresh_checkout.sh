#!/usr/bin/env bash
# Brings the job's checkout up to date with the remote branch, right before the
# daily email is tested and built.
#
# WHY THIS EXISTS
# ---------------
# The email job is triggered hours early and sleeps until 1 AM (see
# send_window.sh). actions/checkout runs when the job STARTS, so the email was
# being built from the repository as it stood at 9 or 10 PM: a water reading up
# to four hours old, which the email then reported as "Water sensor may be
# offline. No new reading in 3+ hours". The 1 Oct 2026 digest said exactly that,
# when the sensor had reported 90 minutes before the email went out.
#
# NEVER FATAL. If the remote cannot be reached the email is still built, from
# the checkout made at job start; its sensor-age warning can then be
# over-cautious, which is far better than no email at all.
#
# Environment:
#   BRANCH  branch to sync to; defaults to $GITHUB_REF_NAME (set by Actions),
#           then to the current branch
#
# Run: bash scripts/refresh_checkout.sh   (from the repository root)

set -uo pipefail

BRANCH="${BRANCH:-${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}}"
before=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

if [ -n "$BRANCH" ] && [ "$BRANCH" != "HEAD" ] \
   && git fetch -q --depth=1 origin "$BRANCH" 2>/dev/null \
   && git reset -q --hard FETCH_HEAD 2>/dev/null; then
  echo "Synced to origin/$BRANCH: $before -> $(git rev-parse --short HEAD)"
else
  # The ::warning:: prefix makes GitHub show this on the run's summary page.
  echo "::warning::Could not refresh from origin/${BRANCH:-?}; building from the checkout made at job start ($before)."
fi

if command -v jq >/dev/null 2>&1 && [ -f data.json ]; then
  echo "Latest water reading in this checkout: $(jq -r '.fetchedAt // "unknown"' data.json 2>/dev/null || echo unreadable)"
fi
exit 0
