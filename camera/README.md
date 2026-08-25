# Boathouse Camera

Captures a snapshot from the Ring camera every 15 minutes and publishes it via
a Cloudflare Worker, so the website can show current river conditions.

```
Ring cloud  <--  Pi Zero W (snapshot_service.js)  -->  Cloudflare Worker + R2
                 outbound only, no open ports          *.workers.dev
                                                              |
                                                       roworno.com <img>
```

Tested on Raspbian GNU/Linux 12 (bookworm), 32-bit, Pi Zero W (ARMv6).

## Two things to get right

**Frame the camera on the water, not the dock.** The image is public. Keeping
people out of shot is what makes access control unnecessary — a password on a
static site cannot actually be enforced, so the framing *is* the privacy
control.

**Never commit snapshots to this repository.** It is public and git history is
permanent: a frame every 15 minutes would build an irreversible public archive
of ~35,000 images a year. R2 holds exactly one object, overwritten each cycle.

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

```bash
cat > /opt/nhrc-camera/env <<'EOF'
RING_CAMERA_NAME=boathouse
CAMERA_UPLOAD_URL=https://nhrc-camera.YOUR-ACCOUNT.workers.dev/latest.jpg
CAMERA_UPLOAD_SECRET=the-same-secret-as-the-worker
CAMERA_INTERVAL_MINUTES=15
CAMERA_ACTIVE_START_HOUR=4
CAMERA_ACTIVE_END_HOUR=19
EOF
chmod 600 /opt/nhrc-camera/env

set -a; . /opt/nhrc-camera/env; set +a
node snapshot_service.js --check     # config only, no Ring calls
node snapshot_service.js --once      # one real capture and upload
```

`RING_CAMERA_NAME` is a case-insensitive substring; if it matches nothing the
error lists every camera on the account.

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
# back. Harmless once; wasteful every 15 minutes for months.
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

The card stays hidden until an image loads, and hides again on any failure — so
a dead camera removes the panel rather than freezing a stale frame on a page
people use for safety decisions.

---

## Settings worth knowing

| Variable | Default | Notes |
|---|---|---|
| `CAMERA_INTERVAL_MINUTES` | 15 | Minimum 5. Ring throttles battery cameras to roughly one snapshot per 10 min |
| `CAMERA_ACTIVE_START_HOUR` / `_END_HOUR` | 4 / 19 | Boathouse local time. Both `0` disables. Night frames are black and still cost battery |
| `CAMERA_RETRIES` | 3 | Battery cameras cannot snapshot *while recording*, so motion events cause failures worth retrying |
| `RING_TOKEN_FILE` | `~/.nhrc-ring-token` | Must persist across reboots |

## Battery

The camera is battery plus solar. Every capture wakes it, so the interval is a
direct battery trade-off. If charge trends down over a few weeks, raise
`CAMERA_INTERVAL_MINUTES` to 30 or narrow the active hours before assuming a
hardware fault.

## When something is wrong

```bash
curl https://nhrc-camera.YOUR-ACCOUNT.workers.dev/status       # age of the current frame
journalctl -u nhrc-camera -n 50           # what the Pi has been doing
```

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

**In this deployment that is already narrow.** The account used here is not the
camera owner's; the boathouse camera was shared with it, and it is not used for
anything else. So a stolen token exposes one camera pointed at a river — which
is exactly the isolation a purpose-made Shared User would have provided. Nothing
further is needed.

Two consequences worth noting:

- Mishandling a token would break push notifications on **this** account only.
  FCM registration is per-account, so the camera owner's notifications are not
  at risk.
- If this account is ever given access to more Ring devices, the blast radius
  grows silently. Keep it single-purpose.

**Permission, separately from security.** The camera belongs to someone else.
Being able to view a shared camera is not the same as permission to republish
its images publicly every 15 minutes. Get the owner's explicit agreement before
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
  limiting factor is what that account can reach — currently one shared camera,
  which is why keeping the account single-purpose matters.
- **Anyone who can see the published image.** It is public by design. The
  privacy control is the camera's framing, not access control.
- **Someone re-aiming the camera.** If it is ever moved to cover the dock,
  people become publicly visible with no code change and no warning. Worth a
  note in the committee's records that the framing is deliberate.
- **Ring changing or blocking the unofficial API.** This can break without
  notice. The failure mode is benign — the card disappears from the site — but
  it will need attention when it happens.

### Data retention

Exactly one object exists at any time, overwritten every cycle. Nothing is
archived, nothing enters git, and Cloudflare access logs are not enabled by
default. If the committee wants a formal retention answer: *the current frame
only, replaced every 15 minutes, never stored historically.*

---

## Tests

```bash
node camera/test_snapshot_service.js
```

21 tests covering config validation, the timezone-aware active window, atomic
token persistence and file permissions, upload auth, and retry behaviour. The
Ring API itself is stubbed, so no credentials are needed.
