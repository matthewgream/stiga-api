# Stiga monitor — integration guide

This directory packages the project as a **background server** you can run in Docker and integrate
with other systems (Home Assistant, scripts, dashboards) over a small HTTP/JSON API.

- [`Dockerfile`](./Dockerfile) — builds the server image.
- [`docker-compose.yml`](./docker-compose.yml) — one-command run, with the volumes wired up.
- [`config/stiga-config-example.js`](./config/stiga-config-example.js) — template for your credentials.
- [`home-assistant.yaml`](./home-assistant.yaml) — drop-in Home Assistant sensors + commands.

---

## Why run the monitor (architecture)

The container runs `stiga-monitor` headless. It holds a **persistent MQTT session** to the robot and
base, marries each position report to the live status, and computes derived state (geofence
violations, coverage, link health). It then exposes that **already-decoded model** over HTTP.

So integrations don't re-implement the protocol or re-authenticate to Stiga's cloud on every read —
**one container owns the hard part, everyone else just reads JSON.** This is the key reason to run
the monitor rather than have (say) Home Assistant poll Stiga's cloud directly.

---

## Running the container

```sh
cd integration
cp config/stiga-config-example.js config/stiga-config.js   # then edit it
mkdir -p data
docker compose up -d --build
```

- Web page: `http://<host>:3001/`
- JSON API: `http://<host>:3001/api/summary`

The three things worth understanding — **these are orthogonal to any Home Assistant use**:

### (A) `stiga-config.js` — credentials in, never baked in

The container reads its account credentials, RTK reference position and Maps key from a JS config
file. You **mount it in**; it is never copied into the image (see [`.dockerignore`](../.dockerignore)).

- compose mounts `./config` → `/config` (read-only), and the image sets `STIGA_CONFIG=/config/stiga-config.js`.
- Start from [`config/stiga-config-example.js`](./config/stiga-config-example.js); copy it to
  `config/stiga-config.js` and fill in `username`, `password`, `referencePosition`, `mapsApiKey`.
- The Maps key is required only because the same process also serves the human map page; the
  `/api/*` JSON endpoints don't use it. A key restricted to the Maps JavaScript API is fine.

### (B) `capture.db` — full history retained on the host

The default command runs with `--directory=/data --capture`, so the monitor records **every MQTT
frame** to `/data/capture.db`. Because compose mounts `./data` → `/data`, that database (and the
persisted breadcrumb trail under `/data/persist`) **lives on the host and survives** container
restarts, rebuilds and upgrades.

```sh
ls -lh data/capture.db                 # grows as frames arrive
# Run the analysis tools against it, inside the container:
docker compose exec stiga-monitor node tools/stiga-exporter.js --help
```

`capture.db` is real telemetry (and may contain session tokens) — keep it out of anything you share
or commit. It is already in [`.dockerignore`](../.dockerignore).

### (C) `--connect` / `--background` — attach a live console

The container runs `--background`: headless, no terminal UI, but it still publishes its live console
over a Unix socket (`/tmp/stiga-monitor.sock` inside the container). You can attach a **read-only live
view** — the same scrolling status + log display you'd get running the monitor interactively — from
your local command line, without disturbing the running server:

```sh
docker compose exec stiga-monitor node tools/stiga-monitor.js --connect
```

This runs the lightweight client *inside* the container (same filesystem as the socket, so it Just
Works), mirrors the live display, and detaches on `q` / `Ctrl-C` — the background server keeps
running. Run it whenever you want to watch what the robot is doing in real time.

> Advanced — host-native `--connect`: add `-e TMPDIR=/run/stiga` and a bind mount `./run:/run/stiga`
> to the container, then from a repo checkout on the host run
> `TMPDIR="$(pwd)/run" node tools/stiga-monitor.js --connect`. The socket is then on a shared
> directory. The `docker compose exec` form above is simpler and avoids socket-permission fuss.

---

## HTTP API reference

| Method | Endpoint | Purpose | Auth (with `…/commands` scope) |
|--------|----------|---------|--------------------------------|
| GET  | `/api/summary` | **Flat, versioned** snapshot for integrations (see below) | open |
| GET  | `/api/state` | Full internal UI model (rich, but shape may change) | open |
| GET  | `/api/perimeters` | Garden zones / obstacles / paths | open |
| GET  | `/api/notifications` | Cloud events / notifications | open |
| POST | `/api/refresh` | Force a cloud + MQTT refresh | open |
| POST | `/api/command/:name` | Drive the robot (publishes MQTT) | **password** |
| POST | `/api/diagnostic/:name` | Run a diagnostic (shells out) | **password** |

**`/api/summary` is the stable contract.** Field names and structure are deliberate: additive
changes only; a breaking change bumps the `schema` string (`stiga-summary/1`). Build automations on
this. `/api/state` mirrors the web UI's internal model and can change shape — use it for exploration,
not contracts.

```sh
curl -s http://localhost:3001/api/summary | jq
```

```jsonc
{
  "schema": "stiga-summary/1",
  "online": true,            // false once the freshest update is > 2 min old
  "age_seconds": 3,
  "robot": {
    "name": "Stiga Stuga",
    "status": "MOWING",      // raw status type
    "status_detail": "…",    // human message / extra text, when present
    "docked": false,
    "active": true,          // mowing / homing / navigating / planning
    "error": false,          // error OR intervention-required OR stuck/blocked/…
    "intervention_required": false,
    "battery_percent": 73,
    "latitude": 59.6628, "longitude": 12.9947,
    "heading_compass": 302,          // robot's facing (deg, 0=N)
    "distance_from_base_m": 37.1,
    "zone": 3,
    "zone_completed_percent": 42,
    "garden_completed_percent": 10,
    "satellites": 24,
    "rtk_quality_percent": 98,
    "gps_coverage": "GOOD",
    "signal_rssi_dbm": -71,
    "firmware": "0.0.3.154",
    "schedule_enabled": true,
    "updated_status": "…", "updated_position": "…"
  },
  "base": { "mac": "…", "latitude": …, "longitude": …, "satellites": 30,
            "rtk_quality_percent": 99, "gps_coverage": "GOOD", "firmware": "…", "updated_status": "…" }
}
```

### Commands

`POST /api/command/:name` — fire-and-forget; the robot's next status reflects the change.

| `:name` | Action | Query |
|---------|--------|-------|
| `start` | Start mowing | |
| `stop` | Stop | |
| `home` | Return to dock | |
| `reset-error` | Clear a recoverable error | |
| `boot` | Leave "startup required" | |
| `force-cut` | Mow a zone now | `?zone=N` |
| `force-border-cut` | Cut a zone's border now | `?zone=N` |
| `schedule-on` / `schedule-off` | Enable / disable the schedule | |

```sh
# Open endpoints (read + refresh) need no auth:
curl -s -X POST http://localhost:3001/api/refresh

# Command endpoints are password-gated when started with --webstatus=3001/<pass>/commands.
# Password-only realm → any username works:
curl -s -u x:SECRET -X POST http://localhost:3001/api/command/start
curl -s -u x:SECRET -X POST 'http://localhost:3001/api/command/force-cut?zone=3'
```

### Auth model

Auth is configured on the `--webstatus` flag: `--webstatus=PORT[/CREDS[/SCOPE]]`, where `CREDS` is
`user:pass` or just `pass`, and `SCOPE` is:

- **`commands`** (recommended) — only `/api/command/*` and `/api/diagnostic/*` require the password.
  Read GETs (`/api/summary`, …) and `/api/refresh` stay open. Ideal for Home Assistant: sensors poll
  freely, only actions need the credential.
- omitted / anything else — **everything** requires auth.

To enable it, override `command:` in [`docker-compose.yml`](./docker-compose.yml) with
`--webstatus=3001/<pass>/commands`.

---

## Home Assistant

See [`home-assistant.yaml`](./home-assistant.yaml) for a ready-to-edit configuration. It adds:

- **Sensors** from `/api/summary` — status, battery, zone, garden %, satellites, RTK quality.
- **Binary sensors** — `online` (connectivity), `docked`, `problem`.
- **`rest_command`s** — start / stop / home / force-cut, posting to `/api/command/*`.

Quick start:

1. Run the container with command auth scoped to commands only:
   `--webstatus=3001/<pass>/commands` (so HA sensors need no credential, only actions do).
2. Edit `home-assistant.yaml`: replace `STIGA_HOST` with the container host, and add
   `stiga_user` / `stiga_pass` to your `secrets.yaml`.
3. Merge it into your HA `configuration.yaml` (or `!include` it) and restart Home Assistant.

The sensors poll `/api/summary` every 30 s — well inside the robot's own update cadence — and read
the **stable** contract, so a future change to the web UI won't break your dashboards.
