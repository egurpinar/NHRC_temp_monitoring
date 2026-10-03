#!/usr/bin/env bash
# Tests for scripts/refresh_checkout.sh, against a real local git remote and a
# shallow clone made the way actions/checkout makes one.
#
# Run: bash scripts/test_refresh_checkout.sh

SCRIPT="$(cd "$(dirname "$0")" && pwd)/refresh_checkout.sh"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
unset GITHUB_REF_NAME BRANCH

pass=0; fail=0
chk(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1";
       else fail=$((fail+1)); echo "  FAIL $1 -- expected '$3' got '$2'"; fi; }
has(){ if grep -q -- "$3" <<<"$2"; then pass=$((pass+1)); echo "  ok   $1";
       else fail=$((fail+1)); echo "  FAIL $1 -- '$3' not in: $2"; fi; }
section(){ echo; echo "$1"; echo "${1//?/-}"; }
reading(){ jq -r .fetchedAt data.json; }

section "0. Syntax"
bash -n "$SCRIPT"; chk "refresh_checkout.sh parses" "$?" "0"

# A remote whose data moves on while the job sleeps: 9 PM at checkout, 12:45 AM
# by the time the email is built.
G=$(mktemp -d); ORIGIN="$G/origin.git"
git init -q --bare -b main "$ORIGIN"
mkdir "$G/seed" && cd "$G/seed" && git init -qb main && git remote add origin "$ORIGIN"
echo '{"fetchedAt":"2026-10-01T01:00:00Z"}' > data.json
git add -A && git commit -qm "9 PM reading" && git push -q -u origin main
advance(){ ( cd "$G/seed" && echo "{\"fetchedAt\":\"$1\"}" > data.json && git commit -qam "reading $1" && git push -q ); }
clone(){ rm -rf "$G/$1"; git clone -q --depth 1 "file://$ORIGIN" "$G/$1"; cd "$G/$1" || exit 1; }

section "1. The job's checkout catches up with readings made while it slept"
clone job
chk "sanity: checkout starts at the 9 PM reading" "$(reading)" "2026-10-01T01:00:00Z"
advance "2026-10-01T04:45:00Z"
out=$(GITHUB_REF_NAME=main bash "$SCRIPT"); code=$?
chk "exits 0" "$code" "0"
chk "data.json now has the 12:45 AM reading" "$(reading)" "2026-10-01T04:45:00Z"
chk "HEAD matches the remote" "$(git rev-parse HEAD)" "$(git --git-dir="$ORIGIN" rev-parse main)"
has "says what it did" "$out" "Synced to origin/main"
has "logs the reading it will use" "$out" "2026-10-01T04:45:00Z"

section "2. Works from a detached HEAD, as actions/checkout sometimes leaves it"
clone detached; git checkout -q --detach
advance "2026-10-01T04:50:00Z"
GITHUB_REF_NAME=main bash "$SCRIPT" >/dev/null; chk "exits 0" "$?" "0"
chk "synced" "$(reading)" "2026-10-01T04:50:00Z"

section "3. Without GITHUB_REF_NAME it follows the current branch"
clone local
advance "2026-10-01T04:55:00Z"
bash "$SCRIPT" >/dev/null; chk "exits 0" "$?" "0"
chk "synced" "$(reading)" "2026-10-01T04:55:00Z"

section "4. A remote outage never blocks the email"
clone offline
git remote set-url origin "$G/does-not-exist.git"
out=$(GITHUB_REF_NAME=main bash "$SCRIPT"); code=$?
chk "still exits 0" "$code" "0"
has "warns on the run page" "$out" "::warning::Could not refresh"
chk "the existing checkout is untouched" "$(reading)" "2026-10-01T04:55:00Z"

section "5. Detached with no branch to follow: warns, changes nothing"
clone nobranch; git checkout -q --detach
before=$(git rev-parse HEAD)
out=$(bash "$SCRIPT"); code=$?
chk "exits 0" "$code" "0"
has "warns" "$out" "::warning::"
chk "HEAD unchanged" "$(git rev-parse HEAD)" "$before"

section "6. Untracked files from earlier steps survive"
clone untracked; echo preview > preview.html
advance "2026-10-01T05:00:00Z"
GITHUB_REF_NAME=main bash "$SCRIPT" >/dev/null
chk "synced" "$(reading)" "2026-10-01T05:00:00Z"
chk "untracked file kept" "$(cat preview.html)" "preview"

cd / && rm -rf "$G"
echo
echo "============================================================"
echo "$pass passed, $fail failed"
echo "============================================================"
[ "$fail" -eq 0 ]
