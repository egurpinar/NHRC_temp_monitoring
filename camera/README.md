# Boathouse Camera

Publishes one photo of the river on the website, via a Cloudflare Worker, with
the time it was taken and which camera took it. Two Ring cameras:

| Camera | Power | Role | When it is captured |
|---|---|---|---|
| **Dock Wired** | Hardwired | Primary | Every 15 minutes, around the clock |
| **Downstream Lot** | Battery + solar | Backup | Only after the dock camera has missed **two captures in a row**; then 5am-4pm, every 30 minutes until 10am and hourly after. Back to sleep as soon as the dock camera answers |

The backup is never woken while the dock camera is answering, to spare its
battery. When the website shows a backup photo it says so, on the photo and in
the caption, because it looks at a different stretch of river.

```
Ring cloud  <--  Pi Zero W (snapshot_service.js)  -->  Cloudflare Worker + R2
                 outbound only, no open ports          *.workers.dev
                                                              |
                                                       roworno.com <img>
```

Tested on Raspbian GNU/Linux 12 (bookworm), 32-bit, Pi Zero W (ARMv6).

## Two things to get right

**Keep identifiable people out of every view.** The image is public. Keeping
people out of shot is what makes access control unnecessary — a password on a
static site cannot actually be enforced, so the framing *is* the privacy
control. Both current views were confirmed for public use by the Safety
Committee in October 2026, with the Downstream Lot owner's permission. Re-check
whenever a camera is moved or replaced.

**Never commit snapshots to this repository.** It is public and git history is
permanent: a frame every 15 minutes would build an irreversible public archive
of tens of thousands of images a year. R2 holds exactly one object, overwritten
each capture.

## Why a service and not a cron job

Ring refresh tokens rotate about hourly and expire shortly after use. The
`ring-client-api` docs are blunt about the consequence of mishandling them:

> "push notifications will not work for any future connections... the only fix
> is to delete the client from Ring Control Center and repeat the authentication
> process"

So a botched token doesn't just break this script — it silently disables push
notifications for the Ring account being used (this account only, not the camera
owner's, since FCM registration is per-account). A cron job authenticates cold every
run and has no safe way to persist the rotation. A long-lived process holds the
session in memory, subscribes to `onRefreshTokenUpdated`, and writes each new
token to disk atomically.

---

## 1. Cloudflare Worker (the receiving end)

1. **R2 → Create bucket** → `nhrc-camera`
2. **Workers & Pages → Create Worker** → paste `cloudflare_worker.js`
3. **Settings → Variables and Secrets**
   - `UPLOAD_SECRET` (type: Secret) — generate with `openssl rand -hex 32`
4. **Settings → Bindings → R2 bucket**
   - Variable name `BUCKET`, bucket `nhrc-camera`

### Which URL

`roworno.com` currently uses **GoDaddy** nameservers
(`ns11/ns12.domaincontrol.com`), pointing at GitHub Pages, with no MX records.
Cloudflare Workers custom domains require the zone to be hosted on Cloudflare,
so `cam.roworno.com` is not available without moving the nameservers.

**Use the workers.dev URL** that Cloudflare assigns automatically:

```
https://nhrc-camera.<your-account>.workers.dev/latest.jpg
```

It has valid TLS, costs nothing, and needs no DNS change — so the live site is
never at risk. The URL appears only in `index.html`; members never see it.

If you later move DNS to Cloudflare (relatively low risk here: four A records
and no email to break), add the custom domain under **Settings → Domains &
Routes** and change the one constant in `index.html`.

Check it: `curl https://nhrc-camera.<account>.workers.dev/status` → JSON saying
no snapshot has been uploaded yet.

## 2. Node on the Pi Zero W

Pi Zero W is **ARMv6**, which official Node builds dropped years ago. Use the
unofficial builds — v20 is the newest with ARMv6 available (nothing from v22
onward is compiled for it).

```bash
uname -m          # armv6l confirms this applies to you
cd /tmp
wget https://unofficial-builds.nodejs.org/download/release/v20.18.1/node-v20.18.1-linux-armv6l.tar.gz
ls -la node-v20.18.1-linux-armv6l.tar.gz   # a few KB means the download failed
tar -xzf node-v20.18.1-linux-armv6l.tar.gz

# cp -a, NOT cp -r. In the tarball bin/npm and bin/npx are symlinks into
# lib/node_modules/npm/. Plain `cp -r` dereferences symlinks, which leaves npm
# either missing or broken while `node` (a real file) copies fine — producing a
# confusing "npm: command not found" after an apparently successful install.
sudo cp -a node-v20.18.1-linux-armv6l/bin/* /usr/local/bin/
sudo cp -a node-v20.18.1-linux-armv6l/lib/* /usr/local/lib/
sudo cp -a node-v20.18.1-linux-armv6l/include/* /usr/local/include/ 2>/dev/null
sudo cp -a node-v20.18.1-linux-armv6l/share/* /usr/local/share/ 2>/dev/null

hash -r           # clear bash's cached command lookups
node --version    # v20.18.1
npm --version     # ~10.8.x — if this fails, the symlinks did not survive
```

Verify both `node` and `npm` before continuing; `npm` is the one that breaks
quietly.

## 3. Install the service

```bash
sudo mkdir -p /opt/nhrc-camera && sudo chown $USER /opt/nhrc-camera
cd /opt/nhrc-camera
curl -fsSL -o snapshot_service.js \
  https://raw.githubusercontent.com/egurpinar/NHRC_temp_monitoring/main/camera/snapshot_service.js

npm init -y
# --ignore-scripts skips the ffmpeg binary download, which has no ARMv6 build,
# and — more importantly — stops package install scripts running arbitrary code
# on a machine serving DNS. Only video streaming needs ffmpeg; snapshots do not.
npm install ring-client-api --ignore-scripts --no-audit --no-fund
```

### Memory during install

Installing is the memory-hungry step, not running. npm resolving a large
dependency tree can transiently need several hundred MB — more than the service
ever uses. On a 512 MB Pi Zero W (~427 MB usable) that can thrash swap or get
OOM-killed, which on a Pi-hole box means DNS hiccups.

Check headroom first:

```bash
free -m          # look at the "available" column, not "free"
```

If `available` is under ~250 MB, or swap is already heavily used, give the
install more room temporarily:

```bash
sudo dphys-swapfile swapoff
sudo sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=1024/' /etc/dphys-swapfile
sudo dphys-swapfile setup && sudo dphys-swapfile swapon
free -m          # confirm ~1 GB swap
```

Revert to the original value afterwards if you prefer — the running service does
not need it. Heavy swapping wears the SD card, so this is for the install only.

**If npm still fails or the Pi becomes unresponsive**, install on another machine
and copy the result across. `--ignore-scripts` means nothing is compiled, so the
tree is portable:

```bash
# on your Mac, in an empty directory
npm init -y && npm install ring-client-api --ignore-scripts --no-audit --no-fund
rsync -az node_modules package.json emre@pihole2:/opt/nhrc-camera/
```

## 4. Authenticate to Ring (once)

```bash
npx -p ring-client-api ring-auth-cli
```

Enter the Ring email, password and 2FA code. Copy the `refreshToken`, then:

```bash
umask 077
echo 'PASTE_TOKEN_HERE' > ~/.nhrc-ring-token
chmod 600 ~/.nhrc-ring-token
```

Treat this file like the account password. From here the service maintains it
itself — do not hand-edit it afterwards.

## 5. Configure and test

Both cameras must be shared with the Ring account the Pi signs in with. At
startup the journal lists every camera that account can see.

```bash
cat > /opt/nhrc-camera/env <<'EOF'
RING_CAMERA_NAME="Dock Wired"
RING_BACKUP_CAMERA_NAME="Downstream Lot"
CAMERA_UPLOAD_URL=https://nhrc-camera.YOUR-ACCOUNT.workers.dev/latest.jpg
CAMERA_UPLOAD_SECRET=the-same-secret-as-the-worker
CAMERA_INTERVAL_MINUTES=15
CAMERA_ACTIVE_START_HOUR=0
CAMERA_ACTIVE_END_HOUR=0
CAMERA_SLOW_AFTER_HOUR=0
BACKUP_AFTER_MISSES=2
BACKUP_INTERVAL_MINUTES=30
BACKUP_SLOW_AFTER_HOUR=10
BACKUP_SLOW_INTERVAL_MINUTES=60
BACKUP_ACTIVE_START_HOUR=5
BACKUP_ACTIVE_END_HOUR=16
EOF
chmod 600 /opt/nhrc-camera/env

set -a; . /opt/nhrc-camera/env; set +a
node snapshot_service.js --check         # config only, no Ring calls
node snapshot_service.js --once          # one real capture and upload from the dock camera
node snapshot_service.js --once-backup   # the same from the backup (shows until the next dock capture)
```

The quotes around the camera names matter: without them the shell reads
`Dock Wired` as a setting followed by a command called `Wired`. (systemd
strips the quotes, so the same file works for the service.) The values shown
are also the defaults, written out so the file says what the Pi does.

A camera name is matched in full first (case-insensitive), then as a part of a
name that only one camera has. A part shared by several cameras is refused
rather than guessed, and a name that matches nothing makes the journal list
every camera on the account.

Then open the same URL in a browser — you should see the river.

## 6. Run it permanently

```ini
# /etc/systemd/system/nhrc-camera.service
[Unit]
Description=NHRC boathouse camera snapshots
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nhrccam
Group=nhrccam
WorkingDirectory=/opt/nhrc-camera
EnvironmentFile=/opt/nhrc-camera/env
ExecStart=/usr/local/bin/node /opt/nhrc-camera/snapshot_service.js
Restart=always
RestartSec=60

# IPv6 is disabled at the router (so all DNS goes through Pi-hole), but DNS
# still returns AAAA records for Cloudflare. Without this, every upload first
# attempts an unroutable IPv6 address and waits for it to fail before falling
# back. Harmless once; wasteful on every upload for months.
Environment=NODE_OPTIONS=--dns-result-order=ipv4first

# This box also serves DNS. Cap memory so a leak here can never take Pi-hole
# down with it — systemd kills this service instead of the OOM killer choosing.
# 200M sits comfortably above the ~80-120M the service actually uses (including
# startup spikes) while leaving headroom on a 427M Pi Zero W. Set it too low and
# systemd kills the service on every start, producing a restart loop.
MemoryMax=200M

# --- Containment -----------------------------------------------------------
# This process runs a large third-party dependency tree on a machine that
# serves DNS for the whole network. Limit what a compromise could reach.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6
RestrictNamespaces=true
LockPersonality=true
# The only writable path it needs is its own state directory.
ReadWritePaths=/opt/nhrc-camera

[Install]
WantedBy=multi-user.target
```

Create the unprivileged account and move the token into the service directory
(`ProtectHome=true` means it can no longer read `/home`):

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin nhrccam
sudo mv ~/.nhrc-ring-token /opt/nhrc-camera/ring-token
sudo chown -R nhrccam:nhrccam /opt/nhrc-camera
sudo chmod 600 /opt/nhrc-camera/ring-token /opt/nhrc-camera/env
```

Add to `/opt/nhrc-camera/env`:

```
RING_TOKEN_FILE=/opt/nhrc-camera/ring-token
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nhrc-camera
journalctl -u nhrc-camera -f
```

## 7. Show it on the website

Once the snapshot URL is live, set this near the bottom of
`index.html`:

```js
const CAMERA_SNAPSHOT_URL = 'https://nhrc-camera.YOUR-ACCOUNT.workers.dev/latest.jpg';
```

The card never shows a broken or badly stale image. The Worker refuses a dock
frame over an hour old (four missed captures) and a backup frame over 130
minutes old (one missed hourly capture). The caption gives the time the photo
was taken and which camera took it, read from the Worker's `Last-Modified`,
`X-Camera-Role` and `X-Camera-Name` headers; a backup photo is also badged on
the image. With no photo the card says why: at night that the dock camera is not
responding and the backup only runs 5am-4pm, by day that the cameras could not
be reached.

The page describes the Pi's settings in a few constants next to
`CAMERA_SNAPSHOT_URL` (`CAMERA_CADENCE_LABEL`, `CAMERA_BACKUP_START_HOUR` /
`_END_HOUR`). They do not control the cameras; change them when the Pi's
settings change.

---

## Settings worth knowing

| Variable | Default | Notes |
|---|---|---|
| `RING_CAMERA_NAME` | — | The primary (dock) camera. May be omitted only if the account has a single camera |
| `RING_BACKUP_CAMERA_NAME` | — | The backup camera. Omit to run without one |
| `CAMERA_INTERVAL_MINUTES` | 15 | Primary. Minimum 5 |
| `CAMERA_ACTIVE_START_HOUR` / `_END_HOUR` | 0 / 0 | Primary window, boathouse local time. Both `0` means around the clock |
| `CAMERA_SLOW_AFTER_HOUR` / `CAMERA_SLOW_INTERVAL_MINUTES` | 0 / 60 | Optional slower primary rate after that hour; off when not after the window start |
| `BACKUP_AFTER_MISSES` | 2 | Primary captures missed in a row before the backup is used |
| `BACKUP_INTERVAL_MINUTES` | 30 | Backup rate until `BACKUP_SLOW_AFTER_HOUR` |
| `BACKUP_SLOW_AFTER_HOUR` / `BACKUP_SLOW_INTERVAL_MINUTES` | 10 / 60 | Backup rate after that hour. Must stay under the Worker's backup limit (130 min) |
| `BACKUP_ACTIVE_START_HOUR` / `_END_HOUR` | 5 / 16 | Backup window. Night frames are dark and still cost battery |
| `CAMERA_RETRIES` | 3 | Battery cameras cannot snapshot *while recording*, so motion events cause failures worth retrying |
| `RING_TOKEN_FILE` | `~/.nhrc-ring-token` | Must persist across reboots |

## The timetable

Captures happen on fixed slots counted from the window start. The dock camera:
every 15 minutes from midnight, 96 a day. The backup, when it is in use: its own
slots, 5:00, 5:30, ... 9:30, then 10:00, 11:00, ... 15:00 - at most 16 a day,
and none at all on a day the dock camera keeps answering.

How the switch works, slot by slot:

- every 15 minutes the dock camera is tried first;
- a failed **capture** counts as a miss; a failed **upload** does not (the
  camera answered, and the backup's frame would fail to upload the same way);
- from the second miss in a row, the backup is captured once per backup slot,
  only inside its window;
- the first dock capture that works resets the count, and the backup goes back
  to sleep. The journal logs both switches.

It used to sleep a fixed interval *after* each capture instead. Every capture
takes time, so the schedule drifted later each cycle and the first frame of the
day landed anywhere from 5:00 to 5:29 - while the website, with no frame newer
than the Worker's limit, told members at the dock the camera could not be
reached. Now:

- one capture per slot, however long a capture or its retries take;
- a failed slot is not retried until the next slot (the retries happen inside
  the cycle), so a busy camera cannot turn into a capture every wake-up;
- the loop never sleeps more than 30 minutes and re-reads the clock each time,
  so a daylight-saving change or clock correction cannot cost a morning;
- after a restart it captures straight away, then rejoins the timetable.

## Updating the service on the Pi

**Two-camera release (October 2026) — do these in order:**

1. **Worker first.** Cloudflare dashboard → Workers & Pages → `nhrc-camera` →
   Edit code → replace everything with the new `cloudflare_worker.js` → Deploy.
   It stores which camera took each frame; an old Worker would show a backup
   photo without saying it is the backup.
2. **Share both cameras** with the Ring account the Pi uses, if not already.
3. **Update `/opt/nhrc-camera/env`** with the camera names and settings in
   section 5 (keep your `CAMERA_UPLOAD_URL`, `CAMERA_UPLOAD_SECRET` and
   `RING_TOKEN_FILE` lines). The old 30/60-minute daylight lines must go: left
   in, they would run the dock camera on the battery schedule.
4. **Update the service file** as below, and restart.
5. Check: `journalctl -u nhrc-camera -n 20 --no-pager` lists the cameras and
   both timetables, and `/status` shows `"role": "primary"` within 15 minutes.

After a change to `snapshot_service.js` is merged to `main`:

```bash
cd /opt/nhrc-camera
sudo curl -fsSL -o snapshot_service.new.js \
  https://raw.githubusercontent.com/egurpinar/NHRC_temp_monitoring/main/camera/snapshot_service.js
node --check snapshot_service.new.js && \
  sudo mv snapshot_service.new.js snapshot_service.js && \
  sudo chown nhrccam:nhrccam snapshot_service.js
sudo systemctl restart nhrc-camera
journalctl -u nhrc-camera -n 20 --no-pager
```

`node --check` only checks the syntax, so a truncated download can never replace
a working service. The startup line in the journal states the timetable.

## Battery

Only the backup camera runs on battery (with solar), and only while the dock
camera is down. Each capture wakes it, so if its charge trends down during a
long dock outage, raise `BACKUP_INTERVAL_MINUTES` or narrow the backup window
before assuming a hardware fault.

## When something is wrong

```bash
curl https://nhrc-camera.YOUR-ACCOUNT.workers.dev/status       # which camera, and how old
journalctl -u nhrc-camera -n 50           # what the Pi has been doing
```

- **`"role": "backup"`** — the dock camera has stopped answering (power, Wi-Fi,
  or Ring). The journal shows its capture errors.
- **`ok: false` with a large `ageSeconds`** — the Pi has stopped uploading.
  Check the service is running and the Pi is online.
- **401 on upload** — the secret on the Pi and in the Worker disagree.
- **Snapshots repeatedly fail** — often the camera recording during motion.
  Persistent failure usually means a dead battery or lost Wi-Fi.
- **Authentication fails after working** — the token was not persisted. Check
  permissions on the token file, re-run `ring-auth-cli`, and if push
  notifications are also broken, delete the client in Ring Control Center first.

---

## Security analysis

Read this before deploying. The design keeps blast radius small, but two risks
are inherent and one of them is worth a deliberate decision.

### The Ring token — keep its reach small

A Ring refresh token is equivalent to the account password: whoever holds it can
reach everything that account can reach.

**In this deployment that is already narrow.** The account used here is not a
camera owner's; the two cameras were shared with it, and it is not used for
anything else. So a stolen token exposes two cameras whose views are already
public — which is exactly the isolation a purpose-made Shared User would have
provided. Nothing further is needed.

Two consequences worth noting:

- Mishandling a token would break push notifications on **this** account only.
  FCM registration is per-account, so the camera owner's notifications are not
  at risk.
- If this account is ever given access to more Ring devices, the blast radius
  grows silently. Keep it single-purpose.

**Permission, separately from security.** The camera belongs to someone else.
Being able to view a shared camera is not the same as permission to republish
its images publicly through the day. Get the owner's explicit agreement before
going live, and tell them the framing is water-only — it is their device, their
Ring account terms, and unwinding it later is harder than asking first.

| Protection in place | What it does |
|---|---|
| `chmod 600`, owned by a dedicated `nhrccam` user | Other local users cannot read the token |
| Atomic writes (temp file + rename) | A crash mid-write cannot corrupt it into requiring re-authentication |
| Never logged | The token never reaches `journalctl`, which is world-readable by default |
| `ProtectHome`, `ProtectSystem=strict` | A compromised process cannot read `/home` or write outside its own directory |

### The Pi is outbound-only

No ports are opened, no port forwarding, no home IP published. The Pi pushes to
Cloudflare and never listens. This is why the design does not serve the image
from the Pi directly — that would mean exposing a DNS server to the internet.

### The upload secret

Worst case if it leaks: someone replaces the published picture. Annoying, but
it grants no access to the Pi, the Ring
account, or the website repo.

Hardening applied:

- **HTTPS enforced** — config validation rejects an `http://` upload URL, since
  the secret travels in a header.
- **JPEG magic bytes verified** — `Content-Type` is attacker-controlled, so the
  Worker checks the bytes actually start `FF D8 FF` and end `FF D9`. Without
  this, the secret could be used to host arbitrary content on the domain.
- **`nosniff` + forced `image/jpeg`** — closes the "upload a file that is also
  valid HTML/SVG and get it executed from our origin" path.
- **8 MB cap** and single fixed object key, so storage cannot be inflated.
- **Constant-time comparison** of the bearer token.

Rotating it is cheap: change the Worker secret and the Pi's `env`, restart.

### Supply chain

`ring-client-api` brings a large dependency tree onto a machine serving your
DNS. Mitigations:

- **`npm install --ignore-scripts`** — this is in the install steps for the
  ARMv6 ffmpeg problem, but it matters more as a security control: it prevents
  package install scripts executing arbitrary code on the Pi.
- **Dedicated unprivileged user, no shell, no home directory.**
- **systemd containment** — `NoNewPrivileges`, restricted address families,
  read-only filesystem apart from one directory.
- **`MemoryMax=200M`** — a runaway process gets killed rather than triggering
  the OOM killer, which might otherwise choose Pi-hole.

Pin versions and update deliberately rather than automatically.

### What this does NOT protect against

Being explicit, since these are real:

- **A compromised Pi.** If the box is owned, the Ring token goes with it. The
  limiting factor is what that account can reach — currently two shared cameras,
  which is why keeping the account single-purpose matters.
- **Anyone who can see the published image.** It is public by design. The
  privacy control is the camera's framing, not access control.
- **Someone re-aiming a camera.** If one is moved, people may become publicly
  visible with no code change and no warning. Worth a note in the committee's
  records that the framing is deliberate.
- **A view that shows when the boathouse is empty.** The dock camera now
  publishes around the clock, night vision included. The committee accepted
  this in October 2026; revisit it if security at the boathouse becomes a
  concern.
- **Ring changing or blocking the unofficial API.** This can break without
  notice. The failure mode is benign — the site's camera card says the camera
  could not be reached — but it will need attention when it happens.

### Data retention

Exactly one object exists at any time, overwritten every cycle. Nothing is
archived, nothing enters git, and Cloudflare access logs are not enabled by
default. If the committee wants a formal retention answer: *the current frame
only, replaced at each capture (every 15 minutes), never stored historically.*

---

## Tests

```bash
node camera/test_snapshot_service.js
```

93 tests covering config validation, the timezone-aware windows, the capture
timetable and the switch to the backup (whole days on a fake clock, including
both daylight-saving days and day-long outages), camera selection, atomic token
persistence and file permissions, upload auth and retry behaviour, the Worker
itself (run in Node against an in-memory R2), and the real service process end
to end, with a stand-in Ring library. Every test is hermetic: a
fixed clock and a fake network, never the real endpoint. The Ring API itself is
stubbed, so no credentials are needed.
