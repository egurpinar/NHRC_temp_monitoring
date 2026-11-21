# roworno.com - notes for Claude Code

roworno.com is the New Haven Rowing Club's conditions and safety page for Lake
Housatonic: the water temperature and the boat restrictions it sets, river
level, weather, a dawn fog outlook, NWS alerts, the boathouse camera, a hazard
map, a daily email, and a timelapse of the new boathouse. Members decide
whether to row from it, so a wrong rule or a wrong word is a safety problem.

Emre, on the club's Safety Committee, runs it. Private details - the Pis'
home-network addresses, where the repository is on his Mac - are in
`CLAUDE.local.md`, which is never committed.

## Hard rules

- **The repository is public and its history permanent.** Never commit
  secrets, tokens, `env` files, Ring token files, camera images, home-network
  addresses or anyone's email address. `.gitignore` is a safety net only;
  `camera/test_pi_check.js` checks every tracked file for addresses.
- **Never show a secret's value** - in chat, a log, a test or a file. Secrets
  are kept in GitHub (repository secrets: `BUTTONDOWN_API_KEY`,
  `GOVEE_API_KEY`, `TIMELAPSE_SECRET`), in the Cloudflare Worker's Variables
  and Secrets, and on each Pi in `/opt/nhrc-camera/env`. Tell Emre which one
  to set and where; he enters the value himself.
- **Emre pushes.** Commit locally once a change is finished and tested, then
  give him the push steps. GitHub's bot commits water readings every 30
  minutes, so they start with a pull: `git pull --no-edit`, then `git push`.
- **The Pis also run Pi-hole, the house's DNS, which matters more than the
  camera.** Camera code must never crash, hang or starve a Pi of memory.
- **Each Pi has its own Ring login.** Never copy a token file between them.
- **Ask first** before downloading anything, replacing something that works,
  or changing what runs on a Pi, in the Worker or in a workflow. Never type a
  password or a code for him.
- **Review every change for security**: nothing may expose the Pi-holes, the
  Ring cameras, the Worker or the website.
- **Facts versus guesses**: say what was checked and what is inferred.

## How Emre likes to work

- Plain, concise English - in replies, comments and commit messages.
- Very thorough testing: the site and the email matter to the club, and
  changes must be robust. Run the suites before every commit (see Testing).
- Commands for him to run must paste safely into Terminal: not indented, one
  per line, no heredocs.
- After a change, say what changed, how it was tested, the push steps, and
  anything he must do on a Pi, in Cloudflare or on GitHub.

## Wording, on the site and in the email (Safety Committee decisions)

- Never say or suggest it is clear, safe or OK to row. The data is water and
  air temperature, river level and forecasts - not conditions on the water.
- Boats the rules permit are **Allowed** - never "Go", "Row" or "Clear" - and
  the "Allowed is not a go-ahead" note goes with every list of boats.
- Fog is awareness only: it never changes a boat's status. The handbook rule
  is quoted with it: if you cannot see the house with the picket fence, do
  not launch.
- The email takes its rules and words from `index.html` itself:
  `loadSiteLogic()` in `scripts/daily_email.js` runs the page's inline script
  (add a function to its `EXPORTS` to use it). Never write a second copy.

## The water-temperature rule

Zones: Winter Rowing (below 40°F), the Four Oar Rule (40-50), Cold Water
(50-60), no temperature restrictions (60 or more). A zone changes, warmer or
colder, only after **three mornings in a row** on the other side of its line.

- Each day is one data point: its morning's highest reading, 5 to 11 AM
  boathouse time, rounded to 0.5°F (49.9 counts as 50). A morning that flips
  across a line counts by that highest reading; afternoons count for nothing.
- A morning counts once it is over (11 AM), so the zone never changes while
  people are on the water. A morning with no readings is skipped.
- Too few mornings with readings, or mornings back and forth across a line
  for 15 days: the stricter zone, and the page says why.
- `ZONE_OVERRIDE` in `index.html` is the committee's manual setting. River
  level restrictions are separate (`getFloodStatus`), and the stricter wins.
- Code: "ROWING STATUS" in `index.html`. Tests: section 13d2 of
  `scripts/test_daily_email.js`, with real mornings from 2026.

## Layout

- `index.html` - the whole site: one page, no build step, its script inline.
  Scripts from other servers carry SRI hashes (tests check). `sw.js` is
  network first, so a page change reaches phones at once.
- `newboathouse/index.html` - the timelapse page. Its CSP holds hashes of its
  inline scripts: after changing them, run
  `node scripts/test_newboathouse.js --fix-csp`.
- `8bit/` - a redirect to `/?8bit`; `8bit/seasons.js` - the seasonal looks.
  `season()` in the head of both pages must stay word for word the same.
- `map/`, `trial/` - the hazard map and its trial page.
- `scripts/` - the daily email (`daily_email.js`, sent with Buttondown), the
  water archiver (`fetch_temp.sh`), the timelapse builder
  (`build_timelapse.js`), the Govee export importer
  (`import_govee_export.js`), and the tests.
- `camera/` - `snapshot_service.js`, the Pis' service (systemd unit
  `nhrc-camera.service`, installed in `/opt/nhrc-camera`, a main Pi and a
  standby that takes over); `cloudflare_worker.js` (the dock photo, water
  readings every 15 minutes, the Pis' check-ins, the timelapse); the Mac's
  hourly Pi check (`pi_check.sh`, writing `.pi-health/`, never committed).
- `data.json`, `history.json` - the water readings, committed by the bot.
  Never reformat `history.json` (jq's layout, over 1 MB).
- `.github/workflows/` - `tests.yml` (every push and every evening),
  `daily_email.yml` (1 AM, March 15 to November 15), `fetch_temp.yml` (every
  30 minutes), `timelapse.yml` (evenings and 6:30 AM).

## How changes go live

- The website and the email: when Emre pushes to `main` (GitHub Pages).
- The Worker: Emre pastes `camera/cloudflare_worker.js` into Cloudflare (Edit
  code, Deploy).
- The Pis: the steps in `camera/README.md` ("After a change to
  `snapshot_service.js` is merged"), on the main Pi and on the standby.

## Testing

Every suite must pass before a commit; GitHub runs them all (`tests.yml`).

- `node scripts/test_daily_email.js` - the email and the page's logic, seconds.
- `node scripts/test_<name>.js` and `bash scripts/test_<name>.sh` - the rest.
- `node camera/test_snapshot_service.js` - the Pis' service and the Worker,
  about 6 minutes (`TEST_SHARD=1/3` for a third, `TEST_ONLY=<regex>` for some).
  Also `camera/test_timelapse_web.js`, `camera/test_pi_check.js` and
  `camera/test_at_slot_marks.js`.
- `node scripts/test_time_travel.js` - every suite at risky dates and times
  (daylight saving, 1-2 AM, the season's edges), about 30 minutes;
  `bash scripts/without_network.sh <command>` - no test may reach the network.

Standards:

- Tests use fixed clocks and fake networks - never the live services, and
  never today's `data.json` or `history.json`.
- New logic gets mutation checks: break it on purpose, and a test must fail.
- Page changes get a look in a real browser: dark, light and 8-bit, at 375
  and 320 px wide.
- A failing test says why under its name; keep it so - GitHub's logs need
  signing in, its annotations do not.

## Code style

Match the code around you: plain JavaScript, small functions, comments that
say why - with the date and what happened, when a rule came from an
incident. Times are boathouse time (America/New_York) unless said otherwise.
More in `scripts/README.md` and `camera/README.md`.
