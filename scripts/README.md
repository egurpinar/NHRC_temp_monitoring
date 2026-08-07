# Daily Conditions Email

Sends a daily digest of rowing status, boat restrictions, river level, and
weather to subscribers at **1:00 AM Eastern**, so it is in inboxes well before
anyone leaves for a dawn practice.

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
| `test_daily_email.js` | Test suite (74 tests) |
| `../.github/workflows/daily_email.yml` | 1 AM ET schedule |

## Rowing season

The email sends **every day from March 15 through November 15** and pauses
outside that window (246 days on, 119 days off). The season is set in one
place — the `SEASON` constant at the top of `daily_email.js`:

```js
const SEASON = {
  startMonth: 3,  startDay: 15,   // March 15
  endMonth:  11,  endDay:   15,   // November 15
};
```

Both endpoints are **inclusive**: March 15 and November 15 each get an email;
March 14 and November 16 do not.

Dates are evaluated in `America/New_York`, not UTC. This matters because the job
fires at 05:00/06:00 UTC — on November 15 that is still the 15th locally, but a
UTC comparison would read the 16th and end the season a day early. A range that
wraps the new year (e.g. Nov 1 → Mar 31) is also supported.

Change those four numbers to whatever the committee decides; nothing else needs
editing. Previews still work off-season, so you can check the email year-round.

## Email rendering rules (read before editing the template)

Buttondown's free plan **wraps our content inside its own email template** —
"naked mode", which gives full document control, is Professional-only. That
constraint drives the whole design:

| Rule | Why |
|---|---|
| Emit a **fragment**, never `<!DOCTYPE>`/`<html>`/`<head>` | Nesting a document inside their `<body>` makes clients discard our `<head>`, taking every `<style>` rule with it |
| **No `<style>` blocks, no media queries, no classes** | They live in `<head>`, so they cannot survive |
| **100% inline styles** | The only thing that reliably survives |
| **Light palette, dark text** | Clients that force dark mode often invert backgrounds without inverting inline-coloured text, which leaves white text on white |
| **Every text container sets both `color` and `background-color`** | Inheriting is how our text ended up black on their background |
| **No `rgba()`** | Several clients drop alpha colours entirely |
| **Max three columns per row** | A five-column grid is unreadable at 320px |
| Send as **`plaintext`** editor mode, not `fancy` | Fancy re-parses HTML through a WYSIWYG schema that normalises away inline styles and nested tables |

All of these are enforced by tests (section 8a2). If you break one, the suite
fails rather than the email quietly rendering wrong on somebody's phone.

To inspect the result visually at several widths, under a simulated Buttondown
wrapper and forced dark mode, regenerate the harness — see the git history for
`nhrc_email_compat_harness.html`.

## Club logo in the email

Email clients do **not** render SVG — Gmail, Outlook and Apple Mail all block or
fail on it. So the email uses `nhrc_email_logo.png`, generated from
`NHRC_logo.svg` with the same white circle and gold ring the website header uses, on a WHITE
surround matching the email card (the email is a light design for dark-mode
safety).

The image is referenced by absolute URL — mail clients can't read repo files —
and is served by GitHub Pages from `https://roworno.com/nhrc_email_logo.png`
once merged to `main`.

**Previewing before it's live on the site:** point at the raw GitHub copy —

```bash
EMAIL_LOGO_URL=https://raw.githubusercontent.com/egurpinar/NHRC_temp_monitoring/daily-conditions-email/nhrc_email_logo.png \
  node scripts/daily_email.js > preview.html
```

**Note on `NHRC_logo.svg`:** despite the extension it is not vector art — it is
a PNG embedded inside an SVG wrapper. It was originally a 3000x2500 bitmap
weighing 1.9 MB, displayed at 96px. It is now stored at 384x320 (4x the display
size, so still crisp on any screen) at 107 KB, which is visually identical and
94% smaller. Re-exporting from Inkscape will likely reinflate it — resize before
committing.

**Regenerating the email logo after changing the SVG** (needs ImageMagick — `brew install imagemagick`):

```bash
SIZE=168                     # 3x the 56px display size, for high-DPI screens
INNER=$(python3 -c "print(int($SIZE*0.78))")
convert -density 600 -background none NHRC_logo.svg -trim +repage \
        -resize ${INNER}x${INNER} /tmp/logo_inner.png
convert -size ${SIZE}x${SIZE} xc:none -fill white -stroke '#f0b429' -strokewidth 6 \
        -draw "circle $((SIZE/2)),$((SIZE/2)) $((SIZE/2)),4" /tmp/circle.png
convert /tmp/circle.png /tmp/logo_inner.png -gravity center -composite \
        -background '#ffffff' -alpha remove -alpha off nhrc_email_logo.png
```

## Subscriber limit

Buttondown's free tier caps at **100 subscribers**. Before each send the script
logs the current count and warns as it approaches the cap, so this doesn't turn
into silent non-delivery for members who signed up past it. Club membership is
around 110, so keep an eye on this in the Actions logs.

## Prerequisites

Running these scripts on your own machine requires **Node 18 or newer**
(GitHub Actions already has it, so the scheduled automation needs nothing).

If `node --version` says "command not found", install the LTS release from
<https://nodejs.org> and then open a **new** terminal window — an existing one
won't pick up the change.

## Running locally

```bash
node scripts/daily_email.js           # print the email HTML (no send)
node scripts/daily_email.js --json    # print computed values
node scripts/daily_email.js --send    # send (respects the season gate)
node scripts/daily_email.js --send --force   # send even if off-season
node scripts/test_daily_email.js      # run the tests
```

## Setup steps (must be done by a human)

1. **Create the Buttondown account** at https://buttondown.com/register.
   Pick the username you want in the public subscribe URL.
2. **Get the API key** from https://buttondown.com/settings/programming.
3. **Add it as a GitHub secret** named `BUTTONDOWN_API_KEY` under
   Settings → Secrets and variables → Actions → New repository secret.
4. **Subscribe form** — already wired to the `gurpinar` account in
   `index.html`, using Buttondown's public embed endpoint (no API key in
   frontend code).
5. **Test before going live**: Actions tab → Daily Conditions Email →
   Run workflow, leaving "dry run" checked. This builds the email and runs the
   tests without sending anything.
6. When satisfied, uncheck dry run for a real test send, then let the schedule
   take over.

## Scheduling note

GitHub Actions cron is UTC-only, so the workflow triggers at both 05:00 and
06:00 UTC (1 AM Eastern in summer and winter respectively) and the job proceeds
when the Eastern hour is between 1 and 4.

The window is wide because GitHub's scheduled runs are routinely delayed by tens
of minutes on shared runners. It previously required exactly 4 AM, so a late
start skipped the day's email silently while still reporting success — that is
why no email arrived on 6 August.

Because the window is wide, BOTH scheduled crons are eligible in summer
(05:00 UTC = 1 AM ET, 06:00 UTC = 2 AM ET), so a duplicate guard is essential.
Before sending, the script asks Buttondown whether an email carrying today's
slug (`nhrc-YYYY-MM-DD`, keyed to the Eastern date) already exists, and skips if
so. The two runs are an hour apart rather than concurrent, so check-then-send is
sufficient.

An earlier version relied on Buttondown rejecting a duplicate slug with a 409.
It does not — the API documents `slug` only as an archive-URL identifier, with
no uniqueness guarantee — and members received the digest twice. If the API
cannot be reached the script sends only on the primary 1 AM run, so an outage
cannot produce a second copy.

The window deliberately ends before 5 AM — a digest arriving later is no use to
someone already at the boathouse.

## Safety behaviour

- If the tests fail, the workflow stops and nothing is sent.
- If the water sensor is stale (>3h), the email says so.
- If NOAA's river gauge is stale (>6h), the email falls back to the forecast
  value and labels it clearly as an estimate.
- If NOAA is unreachable, the email says the river level is unavailable rather
  than showing a stale or invented number.
- Every email carries the "verify at the boathouse" disclaimer.
- The subject line is derived from the actual combined boat statuses, so it can
  never read "all clear" while the river restricts boats.
