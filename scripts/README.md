# Daily Conditions Email

Sends a daily digest of rowing status, boat restrictions, river level, and
weather to subscribers at **4:00 AM Eastern**, every day.

## Why this can't disagree with the website

The rowing rules are safety-critical. Rather than reimplementing them, this
script **extracts the real functions out of `index.html`** at runtime and calls
them. There is one source of truth. If you change the rules in `index.html`,
the email follows automatically — no code change here.

This is verified by a 182-scenario parity test that recomputes every boat
status using the site's own functions and compares against the email output.

## Files

| File | Purpose |
|---|---|
| `daily_email.js` | Builds and sends the digest |
| `test_daily_email.js` | Test suite (29 tests) |
| `../.github/workflows/daily_email.yml` | 4 AM ET schedule |

## Running locally

```bash
node scripts/daily_email.js           # print the email HTML (no send)
node scripts/daily_email.js --json    # print computed values
node scripts/test_daily_email.js      # run the tests
```

## Setup steps (must be done by a human)

1. **Create the Buttondown account** at https://buttondown.com/register.
   Pick the username you want in the public subscribe URL.
2. **Get the API key** from https://buttondown.com/settings/programming.
3. **Add it as a GitHub secret** named `BUTTONDOWN_API_KEY` under
   Settings → Secrets and variables → Actions → New repository secret.
4. **Update the subscribe link** in `index.html` — search for
   `REPLACE_WITH_YOUR_USERNAME` and swap in the real Buttondown URL.
5. **Test before going live**: Actions tab → Daily Conditions Email →
   Run workflow, leaving "dry run" checked. This builds the email and runs the
   tests without sending anything.
6. When satisfied, uncheck dry run for a real test send, then let the schedule
   take over.

## Scheduling note

GitHub Actions cron is UTC-only, so the workflow triggers at both 08:00 and
09:00 UTC and the job checks whether it is currently the 4 AM hour in
`America/New_York`. Exactly one of the two fires on any given day, including
across daylight-saving transitions.

## Safety behaviour

- If the tests fail, the workflow stops and nothing is sent.
- If the water sensor is stale (>3h), the email says so.
- If NOAA's river gauge is stale (>6h), the email falls back to the forecast
  value and labels it clearly as an estimate.
- If NOAA is unreachable, the email says the river level is unavailable rather
  than showing a stale or invented number.
- Every email carries the "verify at the boathouse" disclaimer.
