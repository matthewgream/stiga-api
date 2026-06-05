// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// WebStatusProcessor — a monitor plugin that serves a lightweight real-time status web page.
//
// Runs an Express server with a full-screen Google Maps canvas showing a pin for the base
// station and a pin for the robot (the robot pin moves as position updates arrive). A fixed
// status box (top-left, unaffected by map pan/zoom) shows the headline robot state; hovering
// either pin reveals a detail popup. The browser polls /api/state; this processor keeps that
// state fresh by decoding the live MQTT stream; the shared RequestPoller drives the requests.
//
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Client-side URL query parameters (kiosk-mode knobs — all optional, sensible defaults)
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
//
// Layout
//   boxStatus               lt | rt | lb | rb | no            Status-box position (default lt). 'no' hides it.
//   boxNotify               st | lt | rt | lb | rb | no       Notifications-box position (default st).
//                                                             'st' = stacked under status box, same width as it (also
//                                                             reads as "status" — pun intended). 'no' hides it.
//
// Map
//   mapPosition             <lat>,<lon>[,<zoom>]         Absolute view. Disables auto-fit.
//                                                        Example: mapPosition=59.6624,12.9952,19
//                           <dLat>,<dLon>[,<zoom>]       Offset from the zones bounding-box centre (which the
//                                                        client also console.logs at startup so you can copy it).
//                                                        Units required on at least one part: 'm' or 'cm'.
//                                                        Examples: mapPosition=+5m,-5m  mapPosition=+23cm,0m,19
//                           (omitted)                    Default: fit to zones bounding box once perimeters arrive.
//   mapControls             on | off                     'off' = disableDefaultUI (no zoom/fullscreen/etc.).
//
// Tracks (breadcrumb trail)
//   tracks                  on | off                     Force initial tracks state (default on).
//   tracksClr               0 | 1 | 2 | 3 | off          Decay limit: keep at most max(N,1) most-recent
//                                                        distinct mowing zones. 0 = kill prior on zone change,
//                                                        'off' = keep all (no decay). Default 0.
//                                                        Cycle button in the status box steps through
//                                                        0 → 1 → 2 → 3 → ∞ → 0.
//                                                        Also drives the one-shot history baked into the
//                                                        page at connect time: by default the server sends
//                                                        crumbs from the CURRENT zone only (matching the
//                                                        official app's behaviour); ?tracksClr=N extends to
//                                                        N zones; ?tracksClr=off sends the entire cache.
//                                                        Server-side caching is always on; --persist on
//                                                        stiga-monitor opts into cross-restart persistence
//                                                        (default off, 14 days).
//
// Status-box content
//   statusBatterySparkline  on | off                     Show inline battery SVG (default off).
//   statusTracksControls    on | off                     Show the Tracks line (default on).
//
// Commands (active control panel, stacked between status & notify boxes)
//   commands                on | off                     Show command box with [Start|Stop] [Home] (default off).
//                                                        Start/Stop is context-aware (the relevant verb is shown).
//
// Example kiosk URL:
//   /?boxNotify=no&mapPosition=59.6624,12.9952,19&mapControls=off&tracks=on&tracksClr=2&statusBatterySparkline=off
//
// More knobs will be added here over time; structure new ones the same way (URL_CONFIG entry +
// a single usage site) so each option stays small and removable.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');

const { StigaAPIUtilities, StigaAPIElements: elements, StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIGarage, StigaAPIPerimeters, StigaAPINotifications } = require('../../../api/StigaAPI');
const { protobufDecode, stringToBytes, formatNetworkId } = StigaAPIUtilities;

const DEFAULT_PORT = 3001;
const POLL_MS = 2500; // browser -> server poll interval (local, cheap)
const NOTIF_POLL_MS_UNDOCKED = 60 * 1000; // notifications poll interval when robot is active
const NOTIF_POLL_MS_DOCKED = 5 * 60 * 1000; // notifications poll interval when robot is parked
const SCHEDULE_TIMEZONE_DEFAULT = 'Europe/Stockholm'; // garden tz fallback if not configured
const PERSIST_DEFAULT_DIR = '/dev/shm';
const PERSIST_INTERVAL_MS = 60 * 1000; // flush cached crumbs to disk every minute when persistence is enabled
const PERSIST_DEFAULT_DAYS = 14;
const CRUMB_DEFAULT_INITIAL_ZONES = 1; // semantic default — cover the current (most-recent) mowing zone only

// zone-completion trail: a sparse record of "robot finished N% of zone X at time T". Recorded
// only on transition out of a zone, and only when the percent meets a threshold to filter
// aborted starts. Persisted separately from crumbs (much smaller, much longer retention).
const ZONE_COMPLETION_THRESHOLD_PERCENT = 5; // ignore <5% departures (likely aborted attempts)
const ZONE_COMPLETIONS_PER_ZONE_KEEP = 10; // server retains up to N per zone (on disk + memory)
const ZONE_COMPLETIONS_PER_ZONE_SERVE = 5; // up to N per zone served to the client
const ZONE_COMPLETIONS_PERSIST_DEFAULT_DAYS = 90; // longer retention than crumbs — they're tiny
const ZONE_COMPLETION_DEDUPE_WINDOW_MS = 60 * 60 * 1000; // merge same-zone records within 1h: treat as one session

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class WebStatusProcessor {
    constructor(connection, options = {}) {
        this.connection = connection;
        this.logger = options.logger || console.log;
        this.location = options.location;
        if (!this.location) throw new Error('WebStatusProcessor: options.location is required (RTK reference origin)');
        this.apiKey = options.apiKey;
        if (!this.apiKey) throw new Error('WebStatusProcessor: options.apiKey is required (Google Maps API key)');
        this.port = options.port || DEFAULT_PORT;
        this.username = options.username;
        this.password = options.password;
        this.basicAuth = this._parseBasicAuth(options.auth);
        this.scheduleTimezone = options.scheduleTimezone || SCHEDULE_TIMEZONE_DEFAULT;
        this.perimeters = undefined;
        this.notifications = [];
        this.cloudServer = undefined;
        this.notificationsTimer = undefined;
        this.poller = options.poller;

        // crumb cache: always on (in-memory). Persistence to disk is opt-in via --persist; when
        // enabled the cache survives restarts and is pruned to persistDays of history.
        this.persistEnabled = Boolean(options.persist);
        this.persistDir = typeof options.persist === 'string' && options.persist ? options.persist : PERSIST_DEFAULT_DIR;
        this.persistDays = options.persistDays || PERSIST_DEFAULT_DAYS;
        this.persistanceTimer = undefined;
        this.crumbs = []; // [{ lat, lng, t (epoch ms), zone, color }]
        this.crumbsDirty = false;

        // zone-completion tracking — see ZONE_COMPLETION_* constants for retention/threshold.
        // Hardcoded 90-day default (vs the configurable crumb retention) because the records
        // are tiny and the value of a long trail (seasonal mowing history) outweighs the cost.
        this.zoneCompletions = []; // chronological [{ zone: "5", percent: 87, t: 1716480000000 }]
        this.zoneCompletionsDirty = false;
        this.zoneCompletionDays = options.zoneCompletionDays || ZONE_COMPLETIONS_PERSIST_DEFAULT_DAYS;
        this._activeMowingZone = undefined; // last seen non-null zone (used for transition detection)
        this._activeMowingPercent = 0;

        this.state = {
            base: {
                mac: options.baseMac,
                latitude: this.location.latitude,
                longitude: this.location.longitude,
                status: undefined,
                location: undefined,
                network: undefined,
                version: undefined,
                updatedStatus: undefined,
            },
            robot: {
                mac: options.robotMac,
                name: undefined,
                latitude: undefined,
                longitude: undefined,
                offsetDistanceMetres: undefined,
                offsetCompass: undefined,
                orientationCompass: undefined,
                docked: undefined,
                statusType: undefined,
                statusMessage: undefined,
                statusText: undefined,
                statusValid: undefined,
                statusFlag: undefined,
                interventionRequired: undefined,
                battery: undefined,
                mowing: undefined,
                schedule: undefined,
                location: undefined,
                network: undefined,
                version: undefined,
                updatedStatus: undefined,
                updatedPosition: undefined,
                updatedSchedule: undefined,
            },
        };
    }

    //

    async start() {
        this.connection.on('message', (topic, message) => this._handleMessage(topic, message));

        const app = express();
        app.disable('x-powered-by');
        if (this.basicAuth) app.use((req, res, next) => this._basicAuthMiddleware(req, res, next));
        app.get('/', (req, res) => res.type('html').send(this._renderPage(req)));
        app.get('/api/state', (req, res) => res.json({ generated: new Date().toISOString(), ...this.state, zoneCompletions: this._serializeZoneCompletions() }));
        app.get('/api/perimeters', (req, res) => res.json(this.perimeters ?? { zones: [], obstacles: [] }));
        app.get('/api/notifications', (req, res) => res.json(this.notifications));
        app.post('/api/command/:name', (req, res) => this._handleCommandPost(req, res));
        app.post('/api/refresh', (req, res) => this._handleRefreshPost(req, res));
        await new Promise((resolve, reject) => {
            this.server = app.listen(this.port, '0.0.0.0', () => resolve());
            this.server.on('error', reject);
        });

        this.poller?.acquire();

        if (this.persistEnabled) {
            this._loadCrumbs();
            this._loadZoneCompletions();
            this.persistanceTimer = setInterval(() => {
                this._saveCrumbs();
                this._saveZoneCompletions();
            }, PERSIST_INTERVAL_MS);
            this.logger(`WebStatus: persistence ON (dir=${this.persistDir}, crumbs=${this.persistDays}d, zones=${this.zoneCompletionDays}d)`);
        }

        this._loadPerimeters()
            .then(() => this._startNotificationPoll())
            .catch((e) => this.logger(`WebStatus: cloud features unavailable (${e.message})`));

        this.logger(`WebStatus started on port ${this.port}`);
    }

    async stop() {
        this.poller?.release();
        if (this.notificationsTimer) {
            clearTimeout(this.notificationsTimer);
            this.notificationsTimer = undefined;
        }
        if (this.persistanceTimer) {
            clearInterval(this.persistanceTimer);
            this.persistanceTimer = undefined;
        }
        if (this.persistEnabled) {
            this._saveCrumbs();
            this._saveZoneCompletions();
        }
        if (this.server) await new Promise((resolve) => this.server.close(resolve));
        this.logger('WebStatus stopped');
    }

    //

    // Accepts "user:pass" (full credentials) or "pass" (password only — any username accepted).
    // Returns undefined when no protection is requested, so the middleware is never installed.
    _parseBasicAuth(spec) {
        if (!spec) return undefined;
        const colon = spec.indexOf(':');
        if (colon === -1) return { user: undefined, pass: spec };
        return { user: spec.slice(0, colon), pass: spec.slice(colon + 1) };
    }

    _basicAuthMiddleware(req, res, next) {
        const header = req.headers.authorization || '';
        if (header.startsWith('Basic ')) {
            const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
            const split = decoded.indexOf(':');
            const user = split === -1 ? decoded : decoded.slice(0, split);
            const pass = split === -1 ? '' : decoded.slice(split + 1);
            if ((this.basicAuth.user === undefined || user === this.basicAuth.user) && pass === this.basicAuth.pass) {
                next();
                return;
            }
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="Stiga Webstatus", charset="UTF-8"');
        res.status(401).type('text/plain').send('Authentication required');
    }

    // Active robot commands the kiosk can trigger. Each maps to a ROBOT_COMMAND_IDS entry and
    // is published directly on the shared MQTT connection (same path RequestPoller uses for
    // its own commands). Fire-and-forget — the robot's next STATUS will reflect the new state.
    _handleCommandPost(req, res) {
        const map = { start: 'START', stop: 'STOP', home: 'GO_HOME' };
        const id = map[(req.params.name || '').toLowerCase()];
        if (!id) {
            res.status(400).json({ ok: false, error: `unknown command '${req.params.name}'` });
            return;
        }
        if (!this.connection.isConnected()) {
            res.status(503).json({ ok: false, error: 'MQTT not connected' });
            return;
        }
        try {
            this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS[id]), { qos: 2 });
            this.logger(`WebStatus: command ${id} dispatched`);
            res.json({ ok: true, command: id });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    }

    // Re-fetch cloud-side data on demand (perimeters from the cloud, then notification poll
    // immediately). The MQTT state is already live, so nothing to do for it.
    async _handleRefreshPost(req, res) {
        try {
            this.perimeters = undefined;
            await this._loadPerimeters();
            if (this.notificationsTimer) clearTimeout(this.notificationsTimer);
            this._startNotificationPoll();
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    }

    _handleMessage(topic, message) {
        try {
            const decoded = protobufDecode(message);
            if (topic.includes(this.connection.getRobotMac())) this._handleRobotMessage(topic, decoded);
            else if (topic.includes(this.connection.getBaseMac())) this._handleBaseMessage(topic, decoded);
        } catch {
            // not all messages are protobuf
        }
    }

    _handleRobotMessage(topic, decoded) {
        if (topic.endsWith('ACK')) return;
        if (topic.includes('/LOG/STATUS')) this._handleRobotStatus(decoded);
        else if (topic.includes('/LOG/VERSION')) this.state.robot.version = this._version(decoded);
        else if (topic.includes('/LOG/ROBOT_POSITION')) this._handleRobotPosition(decoded);
        else if (topic.includes('/LOG/SCHEDULING_SETTINGS')) this._handleRobotSchedule(decoded);
    }

    _handleBaseMessage(topic, decoded) {
        if (topic.endsWith('ACK')) return;
        if (topic.includes('/LOG/STATUS')) this._handleBaseStatus(decoded);
        else if (topic.includes('/LOG/VERSION')) this.state.base.version = this._version(decoded);
    }

    //

    _handleRobotStatus(decoded) {
        const r = this.state.robot;
        r.statusType = elements.formatRobotStatusType(elements.decodeRobotStatusType(decoded[3]));
        const errorObj = elements.decodeRobotStatusError(decoded[4]);
        // When the parent type is ERROR and we have a known (code1,code2) → "GPS searching" /
        // "Navigation initialising" / etc., the app shows the message *in place of* the ERROR
        // label. We surface it as statusMessage so the UI can prefer it without losing the raw
        // statusType (which color logic, isRobotActive, etc. still key off). When the message
        // takes over we suppress the error from statusText so it isn't shown twice.
        r.statusMessage = r.statusType === 'ERROR' && errorObj?.message ? errorObj.message : undefined;
        const info = elements.formatRobotStatusInfo(elements.decodeRobotStatusInfo(decoded[10])).replaceAll('-', '');
        const error = r.statusMessage ? '' : elements.formatRobotStatusError(errorObj).replaceAll('-', '');
        r.statusText = [info, error].filter(Boolean).join(', ');
        r.statusValid = elements.formatRobotStatusValid(elements.decodeRobotStatusValid(decoded[1]));
        r.statusFlag = elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[2]));
        r.docked = elements.formatRobotStatusDocking(elements.decodeRobotStatusDocking(decoded[13])).startsWith('yes');
        r.interventionRequired = elements.decodeRobotStatusFlag(decoded[12]);
        if (decoded[17]) {
            const battery = elements.decodeRobotBatteryStatus(decoded[17]);
            r.battery = battery ? { charge: battery.charge, capacity: battery.capacity } : undefined;
        }
        if (decoded[18]) {
            const mowing = elements.decodeRobotMowingStatus(decoded[18], this.location);
            r.mowing = mowing ? { zone: mowing.zone, zoneCompleted: mowing.zoneCompleted, gardenCompleted: mowing.gardenCompleted, target: mowing.target } : undefined;
        }
        if (decoded[19]) r.location = this._rtk(decoded[19]);
        if (decoded[20]) r.network = this._network(decoded[20]);
        r.updatedStatus = new Date().toISOString();
        this._trackZoneCompletions();
    }

    // Detect "robot left zone X" transitions and record the % complete at departure. We track
    // the active (zone, percent) on every status decode, and when the zone changes we attribute
    // the previous percent to the previous zone — provided it meets the threshold (filters out
    // aborted starts where the robot drove out and immediately came back).
    _trackZoneCompletions() {
        const r = this.state.robot;
        const m = r.mowing;
        const currentZone = m && !r.docked && m.zone !== undefined && m.zone !== null ? String(m.zone) : undefined;
        const currentPercent = m && typeof m.zoneCompleted === 'number' ? m.zoneCompleted : 0;
        const previousZone = this._activeMowingZone;
        const previousPercent = this._activeMowingPercent;
        if (currentZone !== previousZone && previousZone !== undefined && previousPercent >= ZONE_COMPLETION_THRESHOLD_PERCENT) this._appendZoneCompletions(previousZone, previousPercent);
        this._activeMowingZone = currentZone;
        this._activeMowingPercent = currentZone ? currentPercent : 0;
    }

    _appendZoneCompletions(zone, percent) {
        const rounded = Math.round(percent);
        // De-dupe transient oscillations: if the most recent record for this zone is within the
        // dedupe window, treat the new event as a continuation of the same session and update
        // it in-place (bumping percent to whichever is higher, refreshing the timestamp). This
        // stops a stuck/retried robot from filling the log with identical entries.
        let recent;
        for (let i = this.zoneCompletions.length - 1; i >= 0; i--) {
            if (this.zoneCompletions[i].zone === zone) {
                recent = this.zoneCompletions[i];
                break;
            }
        }
        if (recent && Date.now() - recent.t < ZONE_COMPLETION_DEDUPE_WINDOW_MS) {
            const merged = Math.max(recent.percent, rounded);
            if (merged !== recent.percent || Date.now() - recent.t > 30_000) {
                recent.percent = merged;
                recent.t = Date.now();
                this.zoneCompletionsDirty = true;
            }
            return;
        }
        this.zoneCompletions.push({ zone, percent: rounded, t: Date.now() });
        this._pruneZoneCompletions();
        this.zoneCompletionsDirty = true;
        this.logger(`WebStatus: zone ${zone} completion ${rounded}% recorded`);
    }

    // Two-axis prune: by absolute age (zoneCompletionDays) and per-zone count cap. The latter
    // keeps any one zone's history from monopolising the cache if the robot oscillates there.
    _pruneZoneCompletions() {
        const cutoff = Date.now() - this.zoneCompletionDays * 24 * 60 * 60 * 1000;
        this.zoneCompletions = this.zoneCompletions.filter((c) => c.t >= cutoff);
        const perZone = new Map();
        let pruned = false;
        for (let i = this.zoneCompletions.length - 1; i >= 0; i--) {
            const entry = this.zoneCompletions[i];
            const count = (perZone.get(entry.zone) || 0) + 1;
            perZone.set(entry.zone, count);
            if (count > ZONE_COMPLETIONS_PER_ZONE_KEEP) {
                entry._drop = true;
                pruned = true;
            }
        }
        this.zoneCompletions = this.zoneCompletions.filter((c) => !c._drop);
        return pruned;
    }

    // Serialise for the wire: per-zone cap of ZONE_COMPLETIONS_PER_ZONE_SERVE, sorted newest-first
    // across all zones (so the client can render "most recent overall" as entry [0]).
    _serializeZoneCompletions() {
        const out = [];
        const perZone = new Map();
        for (const entry of [...this.zoneCompletions].sort((a, b) => b.t - a.t)) {
            const count = (perZone.get(entry.zone) || 0) + 1;
            perZone.set(entry.zone, count);
            if (count <= ZONE_COMPLETIONS_PER_ZONE_SERVE) out.push(entry);
        }
        return out;
    }

    _filenameZoneCompletions() {
        const mac = String(this.state.robot.mac || 'unknown').replaceAll(':', '');
        return path.join(this.persistDir, `stiga-zonecompletions-${mac}.json.gz`);
    }

    _saveZoneCompletions() {
        if (this.zoneCompletionsDirty)
            try {
                const json = JSON.stringify({ version: 1, robotMac: this.state.robot.mac, savedAt: new Date().toISOString(), retentionDays: this.zoneCompletionDays, completions: this.zoneCompletions });
                fs.writeFileSync(this._filenameZoneCompletions(), zlib.gzipSync(json));
                this.zoneCompletionsDirty = false;
            } catch (e) {
                this.logger(`WebStatus: zone-completions save failed: ${e.message}`);
            }
    }

    _loadZoneCompletions() {
        const file = this._filenameZoneCompletions();
        if (fs.existsSync(file))
            try {
                const json = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
                const data = JSON.parse(json);
                if (Array.isArray(data?.completions)) {
                    this.zoneCompletions = data.completions;
                    this.zoneCompletionsDirty = this._pruneZoneCompletions();
                    this.logger(`WebStatus: zone-completions load ${this.zoneCompletions.length} from ${file}`);
                }
            } catch (e) {
                this.logger(`WebStatus: zone-completions load failed: ${e.message}`);
            }
    }

    _handleRobotPosition(decoded) {
        if (!decoded[1] || !decoded[2]) return;
        const position = elements.decodeRobotPosition(decoded, this.location);
        if (!position) return;
        const r = this.state.robot;
        r.latitude = position.latitude;
        r.longitude = position.longitude;
        r.offsetDistanceMetres = position.offsetDistanceMetres;
        r.offsetCompass = position.offsetCompass;
        r.orientationCompass = position.orientationCompass;
        r.updatedPosition = new Date().toISOString();
        this._trackCrumbs(position.latitude, position.longitude);
    }

    // Compact the schedule down to just what the client needs to compute "next mow": a flag
    // for whether scheduling is on, and the list of weekly time blocks with their start time.
    _handleRobotSchedule(decoded) {
        // Field 2 carries the packed per-day timeblocks as a bytes blob — protobufDecode
        // surfaces it as a string by default, so we must re-byte it before decode walks it.
        // Same shim MonitorProcessor uses; without it the decoder returns an empty schedule.
        const schedule = elements.decodeRobotScheduleSettings({ ...decoded, 2: stringToBytes(decoded[2] || '') });
        if (schedule) {
            const blocks = [];
            for (const day of schedule.days || [])
                for (const block of day.timeBlocks || [])
                    blocks.push({
                        dayIndex: day.dayIndex,
                        dayName: day.dayName,
                        startHour: block.startTime?.hour ?? Math.floor(block.startSlot / 2),
                        startMinute: block.startTime?.minute ?? (block.startSlot % 2) * 30,
                        durationMinutes: block.durationMinutes,
                        displayTime: block.displayTime,
                    });
            this.state.robot.schedule = { enabled: schedule.enabled, blocks };
            this.state.robot.updatedSchedule = new Date().toISOString();
        }
    }

    // mirror of the client crumbColor mapping — kept in sync so cached crumbs render the same
    // colours as live ones recorded by the browser. Pure function of the current robot state.
    _serverCrumbColor() {
        const r = this.state.robot;
        if (!r) return '#ffffff';
        if (/error|fault|stuck|blocked|fail|trapped/i.test(r.statusText || '')) return '#ea4335';
        const t = (r.statusType || '').toUpperCase();
        if (t === 'ERROR' || t === 'BLOCKED' || t === 'LID_OPEN') return '#ea4335';
        if (t === 'MOWING' || t === 'CUTTING_BORDER') return '#34a853';
        if (t === 'GOING_HOME' || t === 'NAVIGATING_TO_AREA' || t === 'REACHING_FIRST_POINT' || t === 'PLANNING_ONGOING') return '#ffffff';
        return '#fbbc04';
    }

    _trackCrumbs(lat, lng) {
        const r = this.state.robot;
        const zone = r.mowing && !r.docked && r.mowing.zone !== undefined && r.mowing.zone !== null ? String(r.mowing.zone) : undefined;
        const color = this._serverCrumbColor();
        // For red ("alarm") crumbs we also capture a short text describing what was wrong, so
        // the client can dedupe and surface a fault trail on demand. Older persisted crumbs
        // (pre this change) simply have no `err` field — backwards compatible: the client
        // treats undefined as "no detail" and skips those entries in the alarm panel.
        const err = color === '#ea4335' ? [r.statusMessage || r.statusType, r.statusText].filter(Boolean).join(' · ') || undefined : undefined;
        // 7 decimal places ≈ 1 cm precision — vastly more than the mower's repeatability —
        // and saves ~20 bytes per crumb in serialised form vs. the ~17 digits JS produces.
        this.crumbs.push({ lat: Math.round(lat * 1e7) / 1e7, lng: Math.round(lng * 1e7) / 1e7, t: Date.now(), zone, color, err });
        this._pruneCrumbs();
        this.crumbsDirty = true;
    }

    _pruneCrumbs() {
        const cutoff = Date.now() - this.persistDays * 24 * 60 * 60 * 1000;
        let pruned = false;
        while (this.crumbs.length > 0 && this.crumbs[0].t < cutoff) {
            this.crumbs.shift();
            pruned = true;
        }
        return pruned;
    }

    _filenameCrumbs() {
        const mac = String(this.state.robot.mac || 'unknown').replaceAll(':', '');
        return path.join(this.persistDir, `stiga-crumbs-${mac}.json.gz`);
    }

    // Persist as gzipped JSON: keeps the format human-inspectable (gunzip + jq) while
    // shrinking the file ~5–10×. The full file is rewritten each tick — fine at /dev/shm
    // speeds and crumb cadence; revisit if the cache ever grows to many MB.
    _saveCrumbs() {
        if (this.crumbsDirty)
            try {
                const json = JSON.stringify({ version: 2, robotMac: this.state.robot.mac, savedAt: new Date().toISOString(), retentionDays: this.persistDays, crumbs: this.crumbs });
                fs.writeFileSync(this._filenameCrumbs(), zlib.gzipSync(json));
                this.crumbsDirty = false;
            } catch (e) {
                this.logger(`WebStatus: crumbs save failed: ${e.message}`);
            }
    }

    _loadCrumbs() {
        const file = this._filenameCrumbs();
        if (fs.existsSync(file))
            try {
                const json = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
                const data = JSON.parse(json);
                if (Array.isArray(data?.crumbs)) {
                    this.crumbs = data.crumbs;
                    this.crumbsDirty = this._pruneCrumbs();
                    this.logger(`WebStatus: crumbs load ${this.crumbs.length} from ${file}`);
                }
            } catch (e) {
                this.logger(`WebStatus: crumbs load failed: ${e.message}`);
            }
    }

    _handleBaseStatus(decoded) {
        const b = this.state.base;
        b.status = {
            type: elements.formatBaseStatusType(elements.decodeBaseStatusType(decoded[1])),
            value: elements.formatBaseStatusValue(elements.decodeBaseStatusValue(decoded[2])),
            detail: elements.formatBaseStatusDetail(elements.decodeBaseStatusDetail(decoded[3])),
            flag: elements.formatBaseStatusFlag(elements.decodeBaseStatusFlag(decoded[4])),
            led: elements.formatBaseSettingLED(elements.decodeBaseSettingLED(decoded[10])),
        };
        if (decoded[8]) b.location = this._rtk(decoded[8]);
        if (decoded[9]) b.network = this._network(decoded[9]);
        b.updatedStatus = new Date().toISOString();
    }

    _version(decoded) {
        const version = elements.decodeVersion(decoded);
        return version ? { hardware: version.hardware, firmware: version.firmware, build: version.build, modem: version.modem } : undefined;
    }

    _rtk(decoded) {
        const location = elements.decodeLocationStatus(decoded);
        return location ? { satellites: location.satellites, coverage: location.coverage, offsetDistance: location.offsetDistance, rtkQuality: location.rtkQuality } : undefined;
    }

    _network(decoded) {
        const network = elements.decodeNetworkStatus(decoded);
        if (!network) return undefined;
        return {
            name: formatNetworkId(String(network.network)).replaceAll("'", ''),
            type: network.type,
            band: network.band,
            rssi: network.rssi,
            rsrp: network.rsrp,
            rsrq: network.rsrq,
            sq: network.sq,
        };
    }

    // fetch the garden perimeters from the Cloud (once, at startup). Uses the perimeter
    // referencePosition as the RTK origin so zones and the robot share one frame. The
    // authenticated cloud connection is cached on `this.cloudServer` for reuse by the
    // notifications poll.
    async _loadPerimeters() {
        if (!this.username || !this.password) {
            this.logger('WebStatus: no credentials supplied — zones disabled');
            return;
        }
        const auth = new StigaAPIAuthentication(this.username, this.password);
        if (!(await auth.isValid())) throw new Error('authentication failed');
        const server = new StigaAPIConnectionServer(auth);
        if (!(await server.isConnected())) throw new Error('server connection failed');
        this.cloudServer = server;
        const garage = new StigaAPIGarage(server);
        if (!(await garage.load())) throw new Error('garage load failed');
        const device = garage.getDevice(this.connection.getRobotMac()) || (garage.getDevices() || [])[0];
        if (!device) throw new Error('no device in garage');
        // User-assigned device name from the cloud (e.g. "Stiga Stuga"). Surfaced in the
        // webstatus title so the kiosk shows the user's pet name instead of a generic label.
        // Falls back to undefined; client renders "Stiga Robot" when absent.
        const deviceName = (await device.getName())?.value;
        if (deviceName) this.state.robot.name = deviceName;
        const perimeters = new StigaAPIPerimeters(server, device);
        if (!(await perimeters.load())) throw new Error('perimeter load failed');

        const ref = perimeters.getReferencePosition();
        this.perimeters = {
            referencePosition: ref,
            zones: perimeters.getZones().map((zone) => ({ id: zone.getId(), name: zone.getName(), area: zone.getArea(), path: zone.getPath() })),
            closedZones: perimeters.getClosedZones().map((zone) => ({ id: zone.getId(), name: zone.getName(), area: zone.getArea(), path: zone.getPath() })),
            obstacles: perimeters.getObstacles().map((obstacle) => ({ id: obstacle.getId(), area: obstacle.getArea(), path: obstacle.getPath() })),
            tempObstacles: perimeters.getTempObstacles().map((obstacle) => ({ id: obstacle.getId(), area: obstacle.getArea(), path: obstacle.getPath() })),
            connectPaths: perimeters.getConnectPaths().map((p) => ({ id: p.getId(), fromZone: p.getFromZone(), toZone: p.getToZone(), path: p.getPath() })),
            dockingPaths: perimeters.getDockingPaths().map((p) => ({ id: p.getId(), fromZone: p.getFromZone(), toZone: p.getToZone(), path: p.getPath() })),
            pickupPoints: perimeters.getPickupPoints(),
        };
        if (ref?.latitude && ref?.longitude) {
            this.location = ref;
            this.state.base.latitude = ref.latitude;
            this.state.base.longitude = ref.longitude;
        }
        this.logger(
            `WebStatus: loaded ${this.perimeters.zones.length} zones (+${this.perimeters.closedZones.length} closed), ` +
                `${this.perimeters.obstacles.length} obstacles (+${this.perimeters.tempObstacles.length} temp), ` +
                `${this.perimeters.connectPaths.length} connect-paths, ${this.perimeters.dockingPaths.length} docking-paths, ` +
                `${this.perimeters.pickupPoints.length} pickup-points`
        );
    }

    // poll the cloud for notifications. Frequency is adaptive: a fast cadence while the
    // robot is undocked (where messages tend to arrive), and a slow cadence while it is
    // parked. Self-rescheduling so the interval is recomputed each tick from current state.
    _startNotificationPoll() {
        if (this.cloudServer) {
            const tick = async () => {
                try {
                    const notifications = new StigaAPINotifications(this.cloudServer);
                    if (await notifications.load())
                        this.notifications = notifications.getAll().map((n) => ({
                            uuid: n.getUuid(),
                            title: n.getTitle(),
                            body: n.getBody(),
                            type: n.getType(),
                            category: n.getCategory(),
                            read: n.isRead(),
                            createdAt: n.getCreatedAt()?.toISOString(),
                        }));
                } catch (e) {
                    this.logger(`WebStatus: notifications poll failed (${e.message})`);
                }
                this.notificationsTimer = setTimeout(tick, this.state.robot.docked ? NOTIF_POLL_MS_DOCKED : NOTIF_POLL_MS_UNDOCKED);
            };
            tick();
        }
    }

    //

    // One-shot crumb delivery: at request time we slice the cached crumbs to the zone window
    // implied by ?tracksClr=N (default 1 — the CURRENT zone only). Time-based windowing was
    // intentionally dropped: the robot sleeps/charges between mowing sessions, so wall-clock
    // history is mostly empty space, while "current zone" tracks the activity we actually care
    // about. ?tracksClr=off delivers the entire cache (useful with --persist for diagnostics).
    // One-shot only: a page reload is required to change the window; live updates extend from
    // the last cached point.
    _renderPage(req) {
        const q = req?.query || {};
        const tcRaw = q.tracksClr;
        const tcOff = tcRaw === 'off' || tcRaw === 'inf' || tcRaw === '∞';
        let maxZones = CRUMB_DEFAULT_INITIAL_ZONES;
        if (tcRaw !== undefined && tcRaw !== null && tcRaw !== '' && !tcOff) {
            const tc = Number.parseInt(tcRaw, 10);
            if (Number.isFinite(tc) && tc >= 0) maxZones = Math.max(tc, 1);
        }
        // walk newest-first counting distinct zones; stop at the boundary into the (maxZones+1)th
        // zone. Unzoned crumbs (going-home, transitions) within that window are included.
        let zoneCutoff = Number.NEGATIVE_INFINITY;
        if (!tcOff) {
            const seenZones = new Set();
            for (let i = this.crumbs.length - 1; i >= 0; i--) {
                const z = this.crumbs[i].zone;
                if (z === undefined || z === null) continue;
                if (!seenZones.has(z)) {
                    if (seenZones.size >= maxZones) {
                        zoneCutoff = this.crumbs[i].t;
                        break;
                    }
                    seenZones.add(z);
                }
            }
        }
        const config = JSON.stringify({
            baseLat: this.location.latitude,
            baseLng: this.location.longitude,
            pollMs: POLL_MS,
            notifPollMs: NOTIF_POLL_MS_UNDOCKED,
            scheduleTimezone: this.scheduleTimezone,
        });
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stiga Robot — Live Status</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect y='21' width='32' height='11' fill='%23137333'/><path fill='%2334a853' d='M2 21 L3 11 L4 21 Z M6 21 L7 13 L8 21 Z M10 21 L11 10 L12 21 Z M13 21 L14 14 L15 21 Z M17 21 L18 9 L19 21 Z M21 21 L22 12 L23 21 Z M25 21 L26 11 L27 21 Z M29 21 L30 13 L31 21 Z'/></svg>">
<style>${PAGE_CSS}</style>
</head>
<body>
<div id="map"></div>
<div id="statusbox" class="pos-lt"><div class="muted">connecting…</div></div>
<div id="cmdbox" class="pos-st pos-no"></div>
<div id="notifbox" class="pos-st empty"></div>
<div id="zonepanel"></div>
<div id="schedpanel"></div>
<script>
var CONFIG = ${config};
var INITIAL_CRUMBS = ${JSON.stringify(this.crumbs.filter((c) => c.t > zoneCutoff))};
var INITIAL_STATE = ${JSON.stringify({ generated: new Date().toISOString(), ...this.state, zoneCompletions: this._serializeZoneCompletions() })};
var INITIAL_NOTIFICATIONS = ${JSON.stringify(this.notifications)};
</script>
<script>${CLIENT_JS}</script>
<script async src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(this.apiKey)}&loading=async&callback=initMap&libraries=marker"></script>
</body>
</html>`;
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const PAGE_CSS = `
html,body{margin:0;height:100%}
#map{height:100%;width:100%;background:#222}
.pos-lt{top:12px;left:12px;right:auto;bottom:auto}
.pos-rt{top:12px;right:12px;left:auto;bottom:auto}
.pos-lb{bottom:12px;left:12px;right:auto;top:auto}
.pos-rb{bottom:12px;right:12px;left:auto;top:auto}
.pos-no{display:none !important}
.pos-st{right:auto;bottom:auto;box-sizing:border-box} /* stacked under status box; top/left/width set by JS — border-box so the width set in JS includes the notif-box padding */
#statusbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:9px 13px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif;min-width:200px;color:#202124}
#statusbox h1{font-size:13px;margin:0 0 6px;display:flex;align-items:center}
#statusbox .row{display:flex;justify-content:space-between;gap:18px}
#statusbox .k{color:#80868b}
#statusbox .v{font-weight:600;text-align:right}
#statusbox .v.alert{animation:statusAlertFlash 1.1s ease-in-out infinite;padding:1px 7px;border-radius:5px}
@keyframes statusAlertFlash{0%,100%{background:#ffffff;color:#202124}50%{background:#ea4335;color:#ffffff}}
#statusbox .muted{color:#9aa0a6;font-size:11px;margin-top:5px}
.dot{width:9px;height:9px;border-radius:50%;margin-right:6px;display:inline-block}
.infobox{font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;max-width:280px;color:#202124}
.infobox h2{font-size:13px;margin:0 0 5px}
.infobox table{border-collapse:collapse;width:100%}
.infobox td{padding:1px 0;vertical-align:top}
.infobox td.k{color:#80868b;padding-right:12px;white-space:nowrap}
.infobox .muted{color:#9aa0a6;margin-top:4px}
#statusbox .tracks{margin-top:6px;font-size:11px;color:#80868b}
#statusbox .btn{cursor:pointer;border:1px solid #c4c7c5;border-radius:3px;padding:0 6px;margin-left:4px;color:#202124;user-select:none}
#statusbox .btn.on{background:#34a853;border-color:#34a853;color:#fff}
#notifbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;max-width:560px;color:#202124}
#notifbox.empty{display:none}
#notifbox h2{font-size:10px;margin:0 0 6px;color:#80868b;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
#notifbox .nrow{display:flex;gap:10px;align-items:flex-start;padding:4px 0}
#notifbox .nrow + .nrow{border-top:1px solid #eee}
#notifbox .nago{color:#80868b;flex:0 0 auto;font-size:11px;white-space:nowrap;padding-top:1px}
#notifbox .ncol{flex:1 1 auto;min-width:0}
#notifbox .nline{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#notifbox .nline strong{font-weight:600}
#notifbox .nline .nsep{color:#9aa0a6;margin:0 4px}
#notifbox .nbody{color:#5f6368}
#notifbox .nrow:hover .nline{white-space:normal;overflow:visible;text-overflow:clip}
#notifbox .nmeta{display:none;font-size:11px;color:#80868b;padding-top:3px;opacity:.85}
#notifbox .nrow:hover .nmeta{display:block}
#notifbox .ndismiss{cursor:pointer;color:#5f6368;padding:0 4px;user-select:none;font-size:14px;line-height:1}
#notifbox .ndismiss:hover{color:#ea4335}
#statusbox h1 .linktag{margin-left:auto;font-size:9px;padding:2px 8px;border-radius:10px;
  font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:#fff;background:#9aa0a6}
#statusbox h1 .linktag.online{background:#34a853}
#statusbox h1 .linktag.stale{background:#fbbc04;color:#202124}
#statusbox h1 .linktag.offline{background:#ea4335}
#statusbox .spark{margin-top:4px;display:block}
#statusbox .zonelast{font-size:11px;color:#5f6368;text-align:right;cursor:default;padding:1px 0;font-weight:500}
#statusbox .zonelast:hover{color:#202124}
#zonepanel,#schedpanel{position:absolute;z-index:6;background:rgba(255,255,255,.98);border-radius:8px;
  padding:9px 13px;box-shadow:0 2px 12px rgba(0,0,0,.35);box-sizing:border-box;
  font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#202124;display:none}
#zonepanel.show,#schedpanel.show{display:block}
.alarmtip{font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;max-width:280px;color:#202124}
.alarmtip .aerr{font-weight:600;color:#c5221f;margin-bottom:3px}
.alarmtip .atime{color:#80868b;font-size:11px}
#schedpanel h2{font-size:11px;margin:0 0 7px;color:#80868b;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
#schedpanel table{border-collapse:collapse;width:100%}
#schedpanel td{padding:2px 0;vertical-align:top;font-size:12px}
#schedpanel td.swhen{padding-right:12px;white-space:nowrap;font-weight:600}
#schedpanel td.stime{padding-right:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
#schedpanel td.sdur{color:#80868b;white-space:nowrap;text-align:right;font-size:11px}
#schedpanel .now{color:#137333}
#statusbox .sched-trigger{cursor:default}
#zonepanel h2{font-size:11px;margin:0 0 7px;color:#80868b;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
#zonepanel table{border-collapse:collapse;width:100%}
#zonepanel td{padding:2px 0;vertical-align:top;font-size:12px}
#zonepanel td.zn{padding-right:12px;white-space:nowrap;font-weight:600}
#zonepanel td.zp{padding-right:12px;white-space:nowrap;text-align:right;color:#137333;font-variant-numeric:tabular-nums}
#zonepanel td.zt{color:#80868b;white-space:nowrap;text-align:right;font-size:11px}
#zonepanel .zsep td{border-top:1px solid #eee;padding-top:5px}
#cmdbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#202124;
  display:flex;gap:8px;align-items:center}
#cmdbox .cbtn{cursor:pointer;border:1px solid #c4c7c5;border-radius:4px;padding:5px 14px;
  font-size:12px;font-weight:600;color:#202124;background:#fff;user-select:none;letter-spacing:.3px}
#cmdbox .cbtn:hover{background:#f1f3f4}
#cmdbox .cbtn:active{background:#e8eaed}
#cmdbox .cbtn.start{color:#137333;border-color:#137333}
#cmdbox .cbtn.stop{color:#c5221f;border-color:#c5221f}
#cmdbox .cbtn.home{color:#1967d2;border-color:#1967d2}
#cmdbox .cbtn.busy{opacity:.55;pointer-events:none}
#cmdbox .cmsg{font-size:11px;color:#80868b;margin-left:auto;min-width:0}
`;

// Client-side script. Uses only quoted strings and concatenation (no template literals,
// no backticks, no ${...}) so it can be embedded verbatim into the page template above.
const CLIENT_JS = `
var map, infoWindow, baseMarker, robotMarker, robotPin, robotArrow, targetMarker, targetLine;
var state = null, hovered = null, closeTimer = null, userMoved = false, didFit = false;
var perimetersDrawn = false, perimetersLoading = false;
var zonePolys = {}, zoneNames = {};
var tracksOn = true, tracksVisible = true, alarmsHighlighted = false, crumbs = [], crumbSegments = [], lastCrumbTime = null;
var notifications = [], dismissed = {};
var batteryHistory = [], lastBatteryStatusTime = null;

// Hydrate from the snapshot baked into the page so the boxes show real data from first paint
// instead of "connecting…". The first /api/state poll will replace this with fresher values,
// but even a stale snapshot is a consistent and dated view (the "Xs ago" age tells the user).
if(typeof INITIAL_STATE !== 'undefined' && INITIAL_STATE) state = INITIAL_STATE;
if(typeof INITIAL_NOTIFICATIONS !== 'undefined' && Array.isArray(INITIAL_NOTIFICATIONS)) notifications = INITIAL_NOTIFICATIONS;

// kiosk-mode URL config — query params let us position/disable boxes, lock the map,
// preset the tracks toggle and decay limit, and trim status-box contents. All optional.
//   boxStatus, boxNotify   lt|rt|lb|rb|no   (default: lt for status, lb for notify)
//   mapPosition            lat,lon,zoom     (locks map view)
//   mapControls            on|off           (off = disableDefaultUI)
//   tracks                 on|off           (force tracks state; default on)
//   tracksClr              0|1|2|3|off      (decay limit; 0=kill prior on transition, off=keep all; also drives one-shot history window — default = current zone only)
//   statusBatterySparkline on|off           (default off)
//   statusTracksControls   on|off           (default on)
//   commands               on|off           (active control panel: Start/Stop/Home; default off)
var URL_CONFIG = (function(){
  var p = new URLSearchParams(window.location.search);
  return {
    boxStatus: p.get('boxStatus'),
    boxNotify: p.get('boxNotify'),
    mapPosition: p.get('mapPosition'),
    mapControls: p.get('mapControls'),
    tracks: p.get('tracks'),
    tracksClr: p.get('tracksClr'),
    statusBatterySparkline: p.get('statusBatterySparkline'),
    statusTracksControls: p.get('statusTracksControls'),
    commands: p.get('commands'),
    experimental: p.get('experimental')
  };
})();

// mapPosition supports two forms:
//   absolute: "lat,lon[,zoom]" e.g. "59.6624,12.9952,19"
//   offset:   "<dLatM>,<dLonM>[,zoom]" with m/cm unit on at least one of the first two parts,
//             e.g. "+5m,-5m" or "+23cm,0m". Offsets are applied relative to the bounding-box
//             centre of all zones, computed once the perimeters arrive.
function parseUnitToMeters(s){
  var m = (typeof s === 'string') ? s.match(/^([+-]?\\d+(?:\\.\\d+)?)(m|cm)$/i) : null;
  if(!m) return null;
  var v = Number.parseFloat(m[1]);
  return m[2].toLowerCase() === 'cm' ? v / 100 : v;
}
function parseMapPositionSpec(spec){
  if(!spec) return null;
  var parts = spec.split(',').map(function(s){ return s.trim(); });
  if(parts.length < 2) return null;
  var hasUnit = /(m|cm)$/i.test(parts[0]) || /(m|cm)$/i.test(parts[1]);
  var zoom;
  if(parts.length >= 3){ var z = Number.parseFloat(parts[2]); if(!Number.isNaN(z)) zoom = z; }
  if(hasUnit){
    var latM = parseUnitToMeters(parts[0]);
    var lonM = parseUnitToMeters(parts[1]);
    if(latM === null || lonM === null) return null;
    return { offset: { latM: latM, lonM: lonM }, zoom: zoom, raw: spec };
  }
  var lat = Number.parseFloat(parts[0]);
  var lon = Number.parseFloat(parts[1]);
  if(Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { abs: { lat: lat, lng: lon }, zoom: zoom, raw: spec };
}
function applyOffsetFromCenter(center, latM, lonM){
  var dLat = latM / 111_320;
  var dLon = lonM / (111_320 * Math.cos(center.lat * Math.PI / 180));
  return { lat: center.lat + dLat, lng: center.lng + dLon };
}
function computeZonesBoundsCenter(zones){
  if(!zones || zones.length === 0) return null;
  var minLat = Number.POSITIVE_INFINITY, maxLat = Number.NEGATIVE_INFINITY;
  var minLon = Number.POSITIVE_INFINITY, maxLon = Number.NEGATIVE_INFINITY;
  for(var i = 0; i < zones.length; i++){
    var path = zones[i].path || [];
    for(var j = 0; j < path.length; j++){
      var pt = path[j];
      if(pt.latitude < minLat) minLat = pt.latitude;
      if(pt.latitude > maxLat) maxLat = pt.latitude;
      if(pt.longitude < minLon) minLon = pt.longitude;
      if(pt.longitude > maxLon) maxLon = pt.longitude;
    }
  }
  return Number.isFinite(minLat) ? { lat: (minLat + maxLat) / 2, lng: (minLon + maxLon) / 2 } : null;
}
var MAP_POSITION = parseMapPositionSpec(URL_CONFIG.mapPosition);
var ZONES_CENTRE = null; // populated when perimeters arrive; used as the offset reference

// tracksClr cycle: 0 -> 1 -> 2 -> 3 -> off (Infinity) -> 0. The value is "at most N most-recent
// distinct zones kept"; N=0 means kill prior tracks on zone change (1 zone visible).
var TRACKS_CLR_CYCLE = [0, 1, 2, 3, Number.POSITIVE_INFINITY];
var tracksClr = 0;
(function(){
  var v = URL_CONFIG.tracksClr;
  if(v === null || v === undefined) return;
  if(v === 'off' || v === 'inf' || v === '∞') { tracksClr = Number.POSITIVE_INFINITY; return; }
  var n = Number.parseInt(v, 10);
  if(!Number.isNaN(n) && n >= 0) tracksClr = n;
})();
if(URL_CONFIG.tracks === 'on') tracksOn = true;
else if(URL_CONFIG.tracks === 'off') tracksOn = false;

function applyBoxPosition(id, defaultClass, override){
  var el = document.getElementById(id);
  if(!el) return;
  ['pos-lt','pos-rt','pos-lb','pos-rb','pos-no','pos-st'].forEach(function(c){ el.classList.remove(c); });
  // clear inline styles that 'st' mode writes, so a switch back to a corner mode is clean
  el.style.top = el.style.left = el.style.right = el.style.bottom = el.style.width = el.style.maxWidth = '';
  var cls = defaultClass;
  if(override === 'lt' || override === 'rt' || override === 'lb' || override === 'rb') cls = 'pos-' + override;
  else if(override === 'no') cls = 'pos-no';
  else if(override === 'st') cls = 'pos-st';
  el.classList.add(cls);
}
applyBoxPosition('statusbox', 'pos-lt', URL_CONFIG.boxStatus);
applyBoxPosition('notifbox', 'pos-st', URL_CONFIG.boxNotify);
// commands box: default hidden ('no'); 'on' enables stacked layout under the status box
applyBoxPosition('cmdbox', 'pos-no', URL_CONFIG.commands === 'on' ? 'st' : URL_CONFIG.commands);

// Stacked-mode layout: each .pos-st box chains under the previous one — statusbox → cmdbox →
// notifbox. Boxes that are hidden or not in stacked mode are skipped, so the chain collapses
// naturally when, say, the cmdbox is off. Re-runs on any box resize and on window resize.
function applyStackedNotifyPosition(){
  var sb = document.getElementById('statusbox');
  if(!sb) return;
  var sbRect = sb.getBoundingClientRect();
  var topRef = sb;
  var leftPx = sbRect.left;
  var widthPx = sbRect.width;
  ['cmdbox', 'notifbox'].forEach(function(id){
    var el = document.getElementById(id);
    if(!el || !el.classList.contains('pos-st')) return;
    // hidden boxes (display:none) report 0-size rect and don't push the chain forward
    var visible = !el.classList.contains('pos-no') && !el.classList.contains('empty');
    var refRect = topRef.getBoundingClientRect();
    el.style.top = (refRect.bottom + 8) + 'px';
    el.style.left = leftPx + 'px';
    el.style.width = widthPx + 'px';
    el.style.maxWidth = 'none';
    if(visible) topRef = el;
  });
}
if(window.ResizeObserver){
  ['statusbox', 'cmdbox', 'notifbox'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) new window.ResizeObserver(applyStackedNotifyPosition).observe(el);
  });
}
window.addEventListener('resize', applyStackedNotifyPosition);

// Initial render from the baked-in snapshot. Function declarations are hoisted so we can call
// them here even though they're defined further down. Runs synchronously at script parse time,
// before the Google Maps script loads — so the user never sees "connecting…" if the server
// already had state to share.
if(state) { renderStatusBox(); renderCommandBox(); }
if(notifications.length > 0) renderNotifBox();

var COVERAGE = ['GOOD','POOR','BAD','WORSE'];
var ZONE_COLORS = ['#fbbc04','#34a853','#4285f4','#a142f4','#ff6d01'];

function esc(s){ var d = document.createElement('div'); d.textContent = (s === null || s === undefined) ? '' : String(s); return d.innerHTML; }
function fmt(v,dash){ return (v === null || v === undefined || v === '') ? (dash === undefined ? '-' : dash) : v; }
// Soften DISPLAY-only enum strings: NAVIGATING_TO_AREA -> "Navigating to area",
// GPS_SEARCHING -> "GPS searching". The raw enums stay in r.statusType / r.statusMessage etc.
// on the wire so automation/scripts can parse them. Two preserve-lists (inlined so the
// function is safe to call from the early initial-render path before module-level vars are
// assigned — function declarations are hoisted but var assignments aren't):
//   KEEP_UPPER  — whole-token critical labels that stay all caps (ERROR).
//   ACRONYMS    — sub-tokens (between underscores) that keep their capitalisation when
//                 softened, so "GPS_SEARCHING" -> "GPS searching" not "Gps searching".
// Applied narrowly at known enum-rendering sites only (status box header).
function soften(s){
  if(s === null || s === undefined) return s;
  var KEEP_UPPER = { ERROR: 1 };
  var ACRONYMS = { GPS: 1, RTK: 1, GNSS: 1, MQTT: 1, RSSI: 1, LED: 1, MAC: 1, API: 1 };
  return String(s).replace(/[A-Z][A-Z0-9_]*/g, function(m){
    if(KEEP_UPPER[m]) return m;
    var parts = m.split('_').map(function(part, i){
      if(ACRONYMS[part]) return part;
      var lower = part.toLowerCase();
      return i === 0 ? (lower.charAt(0).toUpperCase() + lower.slice(1)) : lower;
    });
    return parts.join(' ');
  });
}
function ago(iso){
  if(!iso) return 'never';
  var s = Math.round((Date.now() - new Date(iso).getTime())/1000);
  if(s < 60) return s + 's ago';
  if(s < 3600) return Math.round(s/60) + 'm ago';
  if(s < 86_400){
    var hr = Math.round(s/3600);
    if(hr < 24) return hr + 'h ago';
    // round-up lands on a full day boundary — drop through to the day formatter
  }
  // 24h+: split into days + hours so "166h ago" reads as "6d22h ago".
  var d = Math.floor(s / 86_400);
  var h = Math.round((s % 86_400) / 3600);
  if(h === 24){ d++; h = 0; }
  return h === 0 ? (d + 'd ago') : (d + 'd' + h + 'h ago');
}

function initMap(){
  var base = { lat: CONFIG.baseLat, lng: CONFIG.baseLng };
  var center = base, zoom = 18, locked = false;
  if(MAP_POSITION && MAP_POSITION.abs){
    center = { lat: MAP_POSITION.abs.lat, lng: MAP_POSITION.abs.lng };
    if(MAP_POSITION.zoom !== undefined) zoom = MAP_POSITION.zoom;
    locked = true;
  } else if(MAP_POSITION && MAP_POSITION.offset){
    // offset mode — wait for perimeters to resolve the reference centre; lock the view now
    locked = true;
  }
  var mapOpts = {
    center: center, zoom: zoom, mapTypeId: 'satellite', tilt: 0,
    mapId: 'robot_position_map', gestureHandling: 'greedy', streetViewControl: false
  };
  if(URL_CONFIG.mapControls === 'off') mapOpts.disableDefaultUI = true;
  map = new google.maps.Map(document.getElementById('map'), mapOpts);
  if(locked){ userMoved = true; didFit = true; } // suppress auto-fit when caller fixed the view
  infoWindow = new google.maps.InfoWindow();
  map.addListener('dragstart', function(){ userMoved = true; });
  map.addListener('idle', logMapPositionFromCurrentView);

  var basePin = new google.maps.marker.PinElement({ background:'#1a73e8', borderColor:'#ffffff', glyphColor:'#ffffff', glyphText:'B' });
  baseMarker = new google.maps.marker.AdvancedMarkerElement({ map: map, position: base, title: 'Base station', content: basePin });
  attachHover(baseMarker, 'base');

  robotPin = new google.maps.marker.PinElement({ background:'#34a853', borderColor:'#ffffff', glyphColor:'#ffffff', glyphText:'R' });
  // Wrap the pin so we can overlay a heading arrow that pivots to the robot's reported orientation.
  // The wrapper's bottom-centre (the pin tip = the robot's location) stays the marker anchor; the
  // arrow box is centred on that point via negative margins and rotated by orientationCompass (0=N, CW).
  var robotEl = document.createElement('div');
  robotEl.style.position = 'relative';
  robotEl.appendChild(robotPin.element);
  robotArrow = document.createElement('div');
  robotArrow.style.cssText = 'position:absolute; left:50%; bottom:0; width:40px; height:40px; margin-left:-20px; margin-bottom:-20px; transform-origin:50% 50%; transition:transform .25s ease; pointer-events:none; display:none;';
  robotArrow.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40" style="overflow:visible; filter:drop-shadow(0 1px 1px rgba(0,0,0,.45))"><path d="M20 6 L26 16 L20 13 L14 16 Z" fill="currentColor" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  robotEl.appendChild(robotArrow);
  robotMarker = new google.maps.marker.AdvancedMarkerElement({ position: base, title: 'Robot', content: robotEl });
  attachHover(robotMarker, 'robot');

  // experimental (?experimental=on): a reticle at the current mowing target + a line from the robot to it
  targetLine = new google.maps.Polyline({ path: [], strokeColor:'#fbbc04', strokeOpacity:0.85, strokeWeight:2, clickable:false, zIndex:1 });
  var targetEl = document.createElement('div');
  targetEl.style.cssText = 'position:relative;width:0;height:0;';
  targetEl.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" style="position:absolute;left:-12px;top:-12px;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))"><circle cx="12" cy="12" r="8" fill="none" stroke="#fbbc04" stroke-width="2.5"/><circle cx="12" cy="12" r="2.5" fill="#fbbc04"/></svg>';
  targetMarker = new google.maps.marker.AdvancedMarkerElement({ position: base, title: 'Mowing target', content: targetEl });

  hydrateInitialCrumbs();

  refresh();
  setInterval(refresh, CONFIG.pollMs);
  refreshNotifications();
  setInterval(refreshNotifications, CONFIG.notifPollMs);
}

// One-shot crumb hydration. The server bakes a window of cached crumbs into the page as
// INITIAL_CRUMBS; here we replay them into the crumbs[] array and rebuild the matching
// polyline segments so the live recordCrumb() path naturally extends from the last point.
function hydrateInitialCrumbs(){
  if(typeof INITIAL_CRUMBS === 'undefined' || !Array.isArray(INITIAL_CRUMBS) || INITIAL_CRUMBS.length === 0) return;
  for(var i = 0; i < INITIAL_CRUMBS.length; i++){
    var c = INITIAL_CRUMBS[i];
    // err and t may be absent on legacy crumbs (pre-alarm-trail data) — that's fine, they
    // just won't appear in the dedup'd alarm panel. Fields are additive, schema unchanged.
    crumbs.push({ lat: c.lat, lng: c.lng, color: c.color, zone: c.zone, err: c.err, t: c.t });
    if(i > 0){
      var prev = INITIAL_CRUMBS[i-1];
      var seg = new google.maps.Polyline({
        path: [{ lat: prev.lat, lng: prev.lng }, { lat: c.lat, lng: c.lng }],
        strokeColor: c.color, strokeOpacity: 0.55, strokeWeight: 3, clickable: false, zIndex: 1,
        map: (tracksOn && tracksVisible) ? map : null
      });
      seg.crumbColor = c.color;
      seg.crumbZone = c.zone;
      seg.crumbErr = c.err;
      seg.crumbT = c.t;
      crumbSegments.push(seg);
    }
  }
  applyTracksClr();
  applyAlarmsHighlight();
  console.log('WebStatus: hydrated ' + crumbs.length + ' cached crumbs');
}
window.initMap = initMap;
window.toggleTracks = toggleTracks;
window.clearTracks = clearTracks;
window.toggleTracksVisible = toggleTracksVisible;

function attachHover(marker, kind){
  var node = marker.content;
  node.style.cursor = 'pointer';
  node.addEventListener('mouseenter', function(){
    if(closeTimer){ clearTimeout(closeTimer); closeTimer = null; }
    hovered = kind;
    infoWindow.setContent(kind === 'base' ? baseInfo() : robotInfo());
    infoWindow.open({ map: map, anchor: marker });
  });
  node.addEventListener('mouseleave', function(){
    closeTimer = setTimeout(function(){ infoWindow.close(); hovered = null; closeTimer = null; }, 300);
  });
}

function loadPerimeters(){
  if(perimetersDrawn || perimetersLoading) return;
  perimetersLoading = true;
  fetch('api/perimeters', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(p){
      perimetersLoading = false;
      if(!p.zones || p.zones.length === 0) return; // server still fetching from cloud — retried on next poll
      perimetersDrawn = true;
      var bounds = new google.maps.LatLngBounds();
      var any = false;
      // Layer order (bottom → top): satellite base → crumb tracks (z=1, semi-transparent so
       // vegetation still shows) → connector + docking paths (z=2) → zone boundaries (z=3) →
       // obstacles + temp obstacles (z=4) → pickup points (z=5). Perimeter data always sits
       // above the tracks so zone/obstacle borders are never obscured by a dense crumb trail.
      (p.zones || []).forEach(function(z, i){
        var color = ZONE_COLORS[i % ZONE_COLORS.length];
        var poly = makePolygon(z.path, color, 0.12, 4, 3);
        if(poly){
          poly.getPath().forEach(function(ll){ bounds.extend(ll); });
          any = true;
          zonePolys[z.id] = poly;
          zoneNames[z.id] = z.name;
        }
      });
      // Closed zones — same colour rotation as live zones but much lighter fill, signalling
      // "defined but currently disabled in the app". Cycle continues from where live zones end.
      (p.closedZones || []).forEach(function(z, i){
        var color = ZONE_COLORS[(p.zones.length + i) % ZONE_COLORS.length];
        makePolygon(z.path, color, 0.05, 2, 3);
      });
      (p.obstacles || []).forEach(function(o){
        makePolygon(o.path, '#ea4335', 0.20, 3, 4);
      });
      // Temporary obstacles — same shape treatment as permanent obstacles but a brighter red
      // with stronger fill, since they're transient and the user should notice them.
      (p.tempObstacles || []).forEach(function(o){
        makePolygon(o.path, '#ff3b30', 0.32, 3, 4);
      });
      // Inter-zone connector paths — drawn ABOVE tracks now, as a thinner grey line. With
      // tracks made semi-transparent below, the bright crumb colours still show through the
      // path's reduced opacity, so you can see both "where the route goes" and "where the
      // robot has been" simultaneously.
      (p.connectPaths || []).forEach(function(pp){
        if(!pp.path || pp.path.length < 2) return;
        new google.maps.Polyline({
          path: pp.path.map(function(pt){ return { lat: pt.latitude, lng: pt.longitude }; }),
          strokeColor: '#9aa0a6', strokeOpacity: 0.40, strokeWeight: 7,
          clickable: false, zIndex: 2, map: map
        });
      });
      // Docking paths — same treatment in base-pin blue. Slightly higher opacity since blue is
      // less dominant visually than the grey at the same opacity.
      (p.dockingPaths || []).forEach(function(pp){
        if(!pp.path || pp.path.length < 2) return;
        new google.maps.Polyline({
          path: pp.path.map(function(pt){ return { lat: pt.latitude, lng: pt.longitude }; }),
          strokeColor: '#1a73e8', strokeOpacity: 0.50, strokeWeight: 7,
          clickable: false, zIndex: 2, map: map
        });
      });
      // Pickup points — small red circles, top of the stack so they're never hidden.
      (p.pickupPoints || []).forEach(function(pt){
        var lat = pt.latitude ?? pt.lat ?? pt.y;
        var lng = pt.longitude ?? pt.lng ?? pt.x;
        if(typeof lat !== 'number' || typeof lng !== 'number') return;
        new google.maps.Circle({
          center: { lat: lat, lng: lng }, radius: 0.4,
          fillColor: '#ea4335', fillOpacity: 0.85,
          strokeColor: '#ea4335', strokeOpacity: 1, strokeWeight: 2,
          clickable: false, zIndex: 5, map: map
        });
      });
      highlightActiveZone();
      ZONES_CENTRE = computeZonesBoundsCenter(p.zones || []);
      if(ZONES_CENTRE) console.log('WebStatus: zones centre = ' + ZONES_CENTRE.lat.toFixed(7) + ', ' + ZONES_CENTRE.lng.toFixed(7) + ' (use as mapPosition reference)');
      if(MAP_POSITION && MAP_POSITION.offset && ZONES_CENTRE){
        var target = applyOffsetFromCenter(ZONES_CENTRE, MAP_POSITION.offset.latM, MAP_POSITION.offset.lonM);
        map.setCenter(target);
        if(MAP_POSITION.zoom !== undefined) map.setZoom(MAP_POSITION.zoom);
        console.log('WebStatus: mapPosition offset ' + MAP_POSITION.raw + ' -> ' + target.lat.toFixed(7) + ', ' + target.lng.toFixed(7));
      } else if(any && !userMoved){
        didFit = true;
        map.fitBounds(bounds, 60);
      }
    })
    .catch(function(){ perimetersLoading = false; });
}

// Print the current map view as a ready-to-paste mapPosition= spec whenever the user finishes
// dragging or zooming. Workflow: drag the map to the desired view, then copy the last line
// printed (e.g. mapPosition=+5.20m,-1.80m,19) into the URL or stiga-monitor invocation.
var lastLoggedMapSpec = null;
function logMapPositionFromCurrentView(){
  if(!ZONES_CENTRE || !map) return;
  var c = map.getCenter();
  if(!c) return;
  var dLatM = (c.lat() - ZONES_CENTRE.lat) * 111_320;
  var dLonM = (c.lng() - ZONES_CENTRE.lng) * 111_320 * Math.cos(ZONES_CENTRE.lat * Math.PI / 180);
  function fmt(v){
    var sign = v >= 0 ? '+' : '-';
    var abs = Math.abs(v);
    return abs < 1 ? sign + Math.round(abs * 100) + 'cm' : sign + abs.toFixed(2) + 'm';
  }
  var spec = 'mapPosition=' + fmt(dLatM) + ',' + fmt(dLonM) + ',' + map.getZoom();
  if(spec === lastLoggedMapSpec) return;
  lastLoggedMapSpec = spec;
  console.log('WebStatus: current view = ' + spec);
}

function makePolygon(path, color, fillOpacity, weight, zIndex){
  if(!path || path.length < 3) return null;
  return new google.maps.Polygon({
    paths: path.map(function(pt){ return { lat: pt.latitude, lng: pt.longitude }; }),
    strokeColor: color, strokeWeight: weight, strokeOpacity: 0.9,
    fillColor: color, fillOpacity: fillOpacity, clickable: false, zIndex: zIndex, map: map
  });
}

// accentuate the zone the robot is currently mowing (brighter fill + heavier stroke)
function highlightActiveZone(){
  var active = (state && state.robot && state.robot.mowing && !state.robot.docked) ? state.robot.mowing.zone : null;
  for(var id in zonePolys){
    var on = String(id) === String(active);
    zonePolys[id].setOptions({
      fillOpacity: on ? 0.45 : 0.12,
      strokeWeight: on ? 6 : 4,
      strokeOpacity: on ? 1 : 0.85
    });
  }
}

function zoneLabel(zoneId){
  if(zoneId === null || zoneId === undefined) return '-';
  return zoneNames[zoneId] ? (zoneNames[zoneId] + ' (' + zoneId + ')') : ('Zone ' + zoneId);
}

function refresh(){
  loadPerimeters();
  fetch('api/state', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(s){
      state = s;
      var r = s.robot;
      if(typeof r.latitude === 'number' && typeof r.longitude === 'number'){
        var pos = { lat: r.latitude, lng: r.longitude };
        robotMarker.position = pos;
        if(!robotMarker.map) robotMarker.map = map;
        robotPin.background = robotColor(r);
        if(typeof r.orientationCompass === 'number'){
          robotArrow.style.display = 'block';
          robotArrow.style.color = robotColor(r);
          robotArrow.style.transform = 'rotate(' + r.orientationCompass + 'deg)';
        } else {
          robotArrow.style.display = 'none';
        }
        // experimental: show the mowing target reticle + robot->target line (?experimental=on)
        var tgt = (URL_CONFIG.experimental === 'on' && r.mowing && r.mowing.target && typeof r.mowing.target.latitude === 'number') ? r.mowing.target : null;
        if(tgt){
          var tp = { lat: tgt.latitude, lng: tgt.longitude };
          targetMarker.position = tp; if(!targetMarker.map) targetMarker.map = map;
          targetMarker.title = 'Mowing target ' + tp.lat.toFixed(6) + ',' + tp.lng.toFixed(6) + ' · heading ' + Math.round(tgt.headingCompass) + '°' + (tgt.raw ? ' · [4] 1=' + tgt.raw[1] + ' 2=' + tgt.raw[2] + ' 3=' + tgt.raw[3] + ' 4=' + tgt.raw[4] + ' 7=' + tgt.raw[7] : '');
          targetLine.setPath([pos, tp]); if(!targetLine.getMap()) targetLine.setMap(map);
        } else {
          if(targetMarker.map) targetMarker.map = null;
          if(targetLine.getMap()) targetLine.setMap(null);
        }
        if(!didFit && !userMoved){
          didFit = true;
          var b = new google.maps.LatLngBounds();
          b.extend({ lat: CONFIG.baseLat, lng: CONFIG.baseLng });
          b.extend(pos);
          map.fitBounds(b, 90);
        }
      }
      recordCrumb();
      recordBattery();
      renderStatusBox();
      renderCommandBox();
      highlightActiveZone();
      if(hovered) infoWindow.setContent(hovered === 'base' ? baseInfo() : robotInfo());
    })
    .catch(function(){ /* keep last good state */ });
}

function robotColor(r){
  if(!r) return '#9aa0a6';
  if(r.statusText && /error|fault|stuck|blocked|fail/i.test(r.statusText)) return '#ea4335';
  if(r.docked) return '#1a73e8';
  var t = (r.statusType || '').toUpperCase();
  if(t.indexOf('MOW') >= 0 || t.indexOf('PLAN') >= 0 || t.indexOf('WORK') >= 0) return '#34a853';
  if(t.indexOf('CHARG') >= 0) return '#1a73e8';
  return '#fbbc04';
}

// client-side breadcrumb trail — a point is appended on each fresh position report while
// tracks are ON. Each segment is colored by the robot's status at the time the crumb was
// laid down, so the trail visually shows what the robot was doing where. Session-only:
// not persisted, lost on page refresh.
function crumbColor(r){
  if(!r) return '#ffffff';
  if(r.statusText && /error|fault|stuck|blocked|fail|trapped/i.test(r.statusText)) return '#ea4335';
  var t = (r.statusType || '').toUpperCase();
  if(t === 'ERROR' || t === 'BLOCKED' || t === 'LID_OPEN') return '#ea4335';
  if(t === 'MOWING' || t === 'CUTTING_BORDER') return '#34a853';
  if(t === 'GOING_HOME' || t === 'NAVIGATING_TO_AREA' || t === 'REACHING_FIRST_POINT' || t === 'PLANNING_ONGOING') return '#ffffff';
  return '#fbbc04'; // waiting, updating, calibrating, blades-calibrating, storing, startup, docked, charging, etc.
}

function recordCrumb(){
  if(!tracksOn || !state || !state.robot) return;
  var r = state.robot;
  if(typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return;
  if(r.updatedPosition === lastCrumbTime) return;
  lastCrumbTime = r.updatedPosition;
  var color = crumbColor(r);
  var zone = (r.mowing && !r.docked && r.mowing.zone !== null && r.mowing.zone !== undefined) ? String(r.mowing.zone) : null;
  // Capture an alarm string for red crumbs so the alarm panel can dedupe by it.
  var err = color === '#ea4335' ? ([r.statusMessage || r.statusType, r.statusText].filter(Boolean).join(' · ') || null) : null;
  var prev = crumbs[crumbs.length - 1];
  var pt = { lat: r.latitude, lng: r.longitude, color: color, zone: zone, err: err, t: Date.now() };
  crumbs.push(pt);
  if(prev){
    var seg = new google.maps.Polyline({
      path: [{ lat: prev.lat, lng: prev.lng }, { lat: pt.lat, lng: pt.lng }],
      strokeColor: color, strokeOpacity: 0.55, strokeWeight: 3, clickable: false, zIndex: 1,
      map: tracksVisible ? map : null
    });
    seg.crumbColor = color;
    seg.crumbZone = zone;
    seg.crumbErr = err;
    seg.crumbT = pt.t;
    crumbSegments.push(seg);
    if(color === '#ea4335' && alarmsHighlighted){
      styleAlarmSegment(seg, true);
      // Rebuild clusters so a freshly-recorded alarm shows up as a circle straight away.
      buildAlarmClusters();
    }
  }
  applyTracksClr();
}

// Enforce the decay limit: keep at most max(tracksClr,1) most-recent distinct zones.
// Segments tagged with a zone outside the keep-set are removed from the map and dropped.
// Unzoned segments (recorded while the robot wasn't mowing) are always kept.
function applyTracksClr(){
  if(tracksClr === Number.POSITIVE_INFINITY) return;
  var maxZones = Math.max(tracksClr, 1);
  var seen = {}, zoneOrder = [];
  for(var i = crumbs.length - 1; i >= 0; i--){
    var z = crumbs[i].zone;
    if(!z) continue;
    if(seen[z]) continue;
    seen[z] = true;
    zoneOrder.push(z);
    if(zoneOrder.length >= maxZones) break;
  }
  var keepSet = {};
  zoneOrder.forEach(function(z){ keepSet[z] = true; });
  crumbSegments = crumbSegments.filter(function(s){
    if(!s.crumbZone) return true;
    if(keepSet[s.crumbZone]) return true;
    s.setMap(null);
    return false;
  });
}

// cycle the decay limit through the canonical values; called from the [#N] button in the
// status box. Re-applies immediately so segments drop or remain as appropriate.
// Alarm highlighting. When alarmsHighlighted is on, red crumb segments get fatter & brighter
// (so the path through an error region is obvious) AND each error LOCATION gets a red Circle
// drawn on top with its own hover tooltip. Clusters of nearby same-error crumbs (within ~2m
// AND ±5min) collapse into a single circle so a robot stuck in one spot doesn't paint dozens
// of overlapping dots.
var ALARM_CLUSTER_TIME_WINDOW_MS = 5 * 60 * 1000;
var ALARM_CLUSTER_DISTANCE_M = 2;
var alarmClusters = []; // [{lat, lng, err, firstT, lastT, count, circle}]
var alarmInfoWindow = null;
var alarmTipCloseTimer = null;

function styleAlarmSegment(seg, highlight){
  if(highlight) seg.setOptions({ strokeWeight: 6, strokeOpacity: 0.95, zIndex: 6 });
  else seg.setOptions({ strokeWeight: 3, strokeOpacity: 0.45, zIndex: 1 });
}
function applyAlarmSegmentHighlight(){
  crumbSegments.forEach(function(s){
    if(s.crumbColor === '#ea4335') styleAlarmSegment(s, alarmsHighlighted);
  });
}

function distanceMetres(lat1, lng1, lat2, lng2){
  var dLat = (lat2 - lat1) * 111_320;
  var dLng = (lng2 - lng1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function buildAlarmClusters(){
  clearAlarmClusters();
  if(!map) return;
  var red = crumbs.filter(function(c){ return c.color === '#ea4335' && c.err && c.t; }).slice().sort(function(a, b){ return a.t - b.t; });
  red.forEach(function(c){
    // try to attach to any recent same-error cluster within range, scanning newest-first
    var match;
    for(var i = alarmClusters.length - 1; i >= 0; i--){
      var cl = alarmClusters[i];
      if(cl.err !== c.err) continue;
      if(c.t - cl.lastT > ALARM_CLUSTER_TIME_WINDOW_MS) continue;
      if(distanceMetres(c.lat, c.lng, cl.lat, cl.lng) > ALARM_CLUSTER_DISTANCE_M) continue;
      match = cl; break;
    }
    if(match){
      match.count++;
      match.lat = match.lat + (c.lat - match.lat) / match.count;
      match.lng = match.lng + (c.lng - match.lng) / match.count;
      match.lastT = c.t;
    } else {
      alarmClusters.push({ lat: c.lat, lng: c.lng, err: c.err, firstT: c.t, lastT: c.t, count: 1 });
    }
  });
  // draw circles
  alarmClusters.forEach(function(cl){
    cl.circle = new google.maps.Circle({
      center: { lat: cl.lat, lng: cl.lng }, radius: 1.5,
      fillColor: '#ea4335', fillOpacity: 0.25,
      strokeColor: '#ea4335', strokeOpacity: 0.95, strokeWeight: 2,
      clickable: true, zIndex: 7, map: map
    });
    cl.circle.addListener('mouseover', function(){ showAlarmTooltip(cl); });
    cl.circle.addListener('mouseout',  function(){ scheduleAlarmTooltipClose(); });
  });
}
function clearAlarmClusters(){
  alarmClusters.forEach(function(cl){ if(cl.circle){ cl.circle.setMap(null); cl.circle = null; } });
  alarmClusters = [];
  if(alarmInfoWindow) alarmInfoWindow.close();
}

function showAlarmTooltip(cluster){
  if(alarmTipCloseTimer){ clearTimeout(alarmTipCloseTimer); alarmTipCloseTimer = null; }
  if(!alarmInfoWindow) alarmInfoWindow = new google.maps.InfoWindow({ disableAutoPan: true });
  var when = ago(new Date(cluster.lastT).toISOString());
  var spanMin = Math.round((cluster.lastT - cluster.firstT) / 60_000);
  var detail = [when];
  if(spanMin >= 1) detail.push('over ' + spanMin + 'm');
  if(cluster.count > 1) detail.push(cluster.count + ' samples');
  var html = '<div class="alarmtip">' +
    '<div class="aerr">' + esc(cluster.err) + '</div>' +
    '<div class="atime">' + esc(detail.join(' · ')) + '</div>' +
  '</div>';
  alarmInfoWindow.setContent(html);
  alarmInfoWindow.setPosition({ lat: cluster.lat, lng: cluster.lng });
  alarmInfoWindow.open(map);
}
function scheduleAlarmTooltipClose(){
  if(alarmTipCloseTimer) clearTimeout(alarmTipCloseTimer);
  alarmTipCloseTimer = setTimeout(function(){ if(alarmInfoWindow) alarmInfoWindow.close(); alarmTipCloseTimer = null; }, 250);
}

function applyAlarmsHighlight(){
  applyAlarmSegmentHighlight();
  if(alarmsHighlighted) buildAlarmClusters();
  else clearAlarmClusters();
}
function setAlarmsHighlight(on){
  if(alarmsHighlighted === on) return;
  alarmsHighlighted = on;
  applyAlarmsHighlight();
  renderStatusBox();
}
function toggleAlarmsHighlight(){ setAlarmsHighlight(!alarmsHighlighted); }
window.toggleAlarmsHighlight = toggleAlarmsHighlight;

function cycleTracksClr(){
  var idx = TRACKS_CLR_CYCLE.indexOf(tracksClr);
  tracksClr = TRACKS_CLR_CYCLE[(idx + 1) % TRACKS_CLR_CYCLE.length];
  applyTracksClr();
  renderStatusBox();
}
window.cycleTracksClr = cycleTracksClr;
// Segments are on the map only when BOTH recording is on AND visibility is on. Visibility is a
// purely UI concern (lets the user peek under tracks at zones/paths/obstacles without losing the
// crumb data); recording continues regardless.
function applyTracksMap(){
  var show = tracksOn && tracksVisible;
  crumbSegments.forEach(function(s){ s.setMap(show ? map : null); });
}
function setTracks(on){
  if(tracksOn === on) return;
  tracksOn = on;
  applyTracksMap();
  if(tracksOn){ lastCrumbTime = null; recordCrumb(); }
}
function toggleTracks(){ setTracks(!tracksOn); renderStatusBox(); }
function setTracksVisible(on){
  if(tracksVisible === on) return;
  tracksVisible = on;
  applyTracksMap();
  renderStatusBox();
}
function toggleTracksVisible(){ setTracksVisible(!tracksVisible); }
function clearTracks(){
  crumbs = [];
  lastCrumbTime = null;
  crumbSegments.forEach(function(s){ s.setMap(null); });
  crumbSegments = [];
  renderStatusBox();
}

// session-only battery history: one sample per fresh STATUS report. Capped at 240 samples
// so the SVG stays small even after a long session.
function recordBattery(){
  if(!state || !state.robot || !state.robot.battery || !state.robot.updatedStatus) return;
  if(state.robot.updatedStatus === lastBatteryStatusTime) return;
  lastBatteryStatusTime = state.robot.updatedStatus;
  batteryHistory.push({ t: new Date(state.robot.updatedStatus).getTime(), v: state.robot.battery.charge });
  if(batteryHistory.length > 240) batteryHistory.shift();
}

function batterySparkSVG(){
  if(batteryHistory.length < 2) return '';
  var w = 110, h = 22, pad = 2;
  var t0 = batteryHistory[0].t, tN = batteryHistory[batteryHistory.length - 1].t;
  var span = Math.max(1, tN - t0);
  var pts = batteryHistory.map(function(p){
    return (pad + ((p.t - t0) / span) * (w - 2 * pad)).toFixed(1) + ',' + (pad + (1 - p.v / 100) * (h - 2 * pad)).toFixed(1);
  }).join(' ');
  var last = batteryHistory[batteryHistory.length - 1];
  var first = batteryHistory[0];
  var trend = last.v - first.v;
  var color = trend > 0 ? '#34a853' : (trend < 0 ? '#fbbc04' : '#80868b');
  var lastX = pad + (w - 2 * pad);
  var lastY = pad + (1 - last.v / 100) * (h - 2 * pad);
  return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round"/>' +
    '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="1.8" fill="' + color + '"/>' +
    '</svg>';
}

// Extract "now" in the schedule's home timezone — Stockholm by default. The robot's schedule
// blocks are defined in that local time, so the client must not use its own browser timezone
// for the comparison. Intl.DateTimeFormat is the standard way to get day-of-week / hour /
// minute for an arbitrary IANA zone without a third-party library.
var SCHEDULE_TZ_FMT = null;
function nowInScheduleTz(){
  var tz = (CONFIG && CONFIG.scheduleTimezone) || 'Europe/Stockholm';
  if(!SCHEDULE_TZ_FMT) SCHEDULE_TZ_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  var parts = SCHEDULE_TZ_FMT.formatToParts(new Date());
  var weekday = parts.find(function(p){ return p.type === 'weekday'; }).value;
  var hour = Number.parseInt(parts.find(function(p){ return p.type === 'hour'; }).value, 10);
  var minute = Number.parseInt(parts.find(function(p){ return p.type === 'minute'; }).value, 10);
  // schedule day index: Mon=0..Sun=6 (matches what the protobuf decoder produces)
  var dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { dayIndex: dayMap[weekday], hour: hour, minute: minute, nowMin: hour * 60 + minute };
}

// Walk the schedule forward from "now" (in the garden's timezone) and return up to maxEntries
// upcoming sessions, oldest first. Each entry: { dayName, displayTime, startTime,
// durationMinutes, daysAway }. Empty array if scheduling is disabled or has no blocks.
function upcomingScheduledSessions(maxEntries){
  var max = maxEntries || 5;
  if(!state || !state.robot || !state.robot.schedule) return [];
  var s = state.robot.schedule;
  if(!s.enabled || !s.blocks || s.blocks.length === 0) return [];
  var now = nowInScheduleTz();
  var out = [];
  for(var offset = 0; offset < 8 && out.length < max; offset++){
    var scheduleDay = (now.dayIndex + offset) % 7;
    var bucket = s.blocks
      .filter(function(b){ return b.dayIndex === scheduleDay; })
      .sort(function(a, b){ return a.startHour * 60 + a.startMinute - (b.startHour * 60 + b.startMinute); });
    for(var i = 0; i < bucket.length; i++){
      var b = bucket[i];
      var blockMin = b.startHour * 60 + b.startMinute;
      if(offset === 0 && blockMin <= now.nowMin) continue;
      // Minutes from now until this block starts. Today is a simple subtract; future days
      // assume 24h per day — fine for a "(in XhYm)" hint, DST jitter is acceptable.
      var minutesUntil = offset === 0 ? (blockMin - now.nowMin) : ((24 * 60 - now.nowMin) + (offset - 1) * 24 * 60 + blockMin);
      out.push({
        dayName: b.dayName,
        displayTime: b.displayTime,
        startTime: (b.displayTime || '').split('-')[0],
        durationMinutes: b.durationMinutes,
        daysAway: offset,
        minutesUntil: minutesUntil
      });
      if(out.length >= max) break;
    }
  }
  return out;
}

function fmtScheduleDuration(mins){
  if(mins === null || mins === undefined) return '';
  if(mins < 60) return mins + 'm';
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return m === 0 ? (h + 'h') : (h + 'h' + m + 'm');
}

function scheduleWhenLabel(daysAway, dayName){
  if(daysAway === 0) return 'Today';
  if(daysAway === 1) return 'Tomorrow';
  return dayName;
}

// If "now" falls inside one of today's scheduled blocks, return its end time + remaining
// minutes; otherwise null. Used by formatScheduleSummary to show "Now to HH:MM · …" while
// a session is in progress instead of jumping ahead to the next-after-this one.
function currentScheduledSession(){
  if(!state || !state.robot || !state.robot.schedule) return null;
  var s = state.robot.schedule;
  if(!s.enabled || !s.blocks || s.blocks.length === 0) return null;
  var now = nowInScheduleTz();
  for(var i = 0; i < s.blocks.length; i++){
    var b = s.blocks[i];
    if(b.dayIndex !== now.dayIndex) continue;
    var startMin = b.startHour * 60 + b.startMinute;
    var endMin = startMin + (b.durationMinutes || 0);
    if(now.nowMin >= startMin && now.nowMin < endMin){
      var endHour = Math.floor(endMin / 60);
      var endMinute = endMin % 60;
      // Everything's now in Stockholm minutes-of-day, so the remaining delta is a simple subtract.
      return {
        endTime: endHour + ':' + String(endMinute).padStart(2, '0'),
        remainingMin: Math.max(0, endMin - now.nowMin)
      };
    }
  }
  return null;
}

// One-line status row text. States:
//   "Inactive"                                       — schedule disabled
//   "Active (no sessions)"                           — enabled but no blocks defined
//   "Until 11:00 (1h5m)"                             — currently inside a scheduled block
//   "Today at 09:00 for 2h (in 1h3m)"                — today, future block; (in …) is countdown
//   "Tomorrow at 09:00 for 2h" / "Wednesday at …"    — non-today, just the day label is enough
function formatScheduleSummary(){
  if(!state || !state.robot || !state.robot.schedule) return '-';
  var s = state.robot.schedule;
  if(!s.enabled) return 'Inactive';
  var current = currentScheduledSession();
  if(current) return 'Until ' + current.endTime + ' (' + fmtScheduleDuration(current.remainingMin) + ')';
  var sessions = upcomingScheduledSessions(1);
  if(sessions.length === 0) return 'Active (no sessions)';
  var n = sessions[0];
  var line = scheduleWhenLabel(n.daysAway, n.dayName) + ' at ' + n.startTime + ' for ' + fmtScheduleDuration(n.durationMinutes);
  // For today's upcoming block, append a "(in …)" countdown so the user can see how soon.
  if(n.daysAway === 0 && typeof n.minutesUntil === 'number' && n.minutesUntil > 0) line += ' (in ' + fmtScheduleDuration(n.minutesUntil) + ')';
  return line;
}

// MQTT link health, derived from the freshest update timestamp across both endpoints.
// Returned as a {cls,label} pair so it can render inline in the status-box title row.
function linkState(){
  var ages = [];
  if(state && state.robot){
    if(state.robot.updatedStatus) ages.push(Date.now() - new Date(state.robot.updatedStatus).getTime());
    if(state.robot.updatedPosition) ages.push(Date.now() - new Date(state.robot.updatedPosition).getTime());
  }
  if(state && state.base && state.base.updatedStatus) ages.push(Date.now() - new Date(state.base.updatedStatus).getTime());
  if(ages.length === 0) return { cls: 'offline', label: 'connecting' };
  var freshest = Math.min.apply(null, ages);
  if(freshest < 60_000) return { cls: 'online', label: 'online' };
  if(freshest < 180_000) return { cls: 'stale', label: 'stale ' + Math.round(freshest / 1000) + 's' };
  return { cls: 'offline', label: 'offline ' + Math.round(freshest / 60_000) + 'm' };
}

function row(k,v,vcls){
  return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v' + (vcls ? ' ' + vcls : '') + '">' + esc(v) + '</span></div>';
}

// Floating panel showing the per-zone completion trail, opened on hover of the latest-zone
// line in the status box. Positioned beside the status box; closes when the pointer leaves
// either the trigger line or the panel itself.
// Shared positioner for hover panels (zone, schedule, …): match the status-box width and place
// the panel to its right if there's room, otherwise stacked directly underneath. Width is set
// in border-box mode so the panel's padding sits inside that width (matches statusbox visually).
function positionHoverPanel(panel, box){
  var br = box.getBoundingClientRect();
  panel.style.width = br.width + 'px';
  var pr = panel.getBoundingClientRect();
  var gap = 8;
  if(br.right + gap + pr.width <= window.innerWidth){
    panel.style.left = (br.right + gap) + 'px';
    panel.style.top = br.top + 'px';
  } else {
    panel.style.left = br.left + 'px';
    panel.style.top = (br.bottom + gap) + 'px';
  }
}

var zonePanelCloseTimer = null;
function attachZonePanelHover(){
  var box = document.getElementById('statusbox');
  var trigger = box && box.querySelector('.zonelast');
  if(!trigger) return;
  trigger.addEventListener('mouseenter', showZonePanel);
  trigger.addEventListener('mouseleave', scheduleZonePanelClose);
  var panel = document.getElementById('zonepanel');
  if(panel && !panel.dataset.bound){
    panel.dataset.bound = '1';
    panel.addEventListener('mouseenter', function(){ if(zonePanelCloseTimer){ clearTimeout(zonePanelCloseTimer); zonePanelCloseTimer = null; } });
    panel.addEventListener('mouseleave', scheduleZonePanelClose);
  }
}
function showZonePanel(){
  var panel = document.getElementById('zonepanel');
  var box = document.getElementById('statusbox');
  if(!panel || !box || !state || !Array.isArray(state.zoneCompletions) || state.zoneCompletions.length === 0) return;
  if(zonePanelCloseTimer){ clearTimeout(zonePanelCloseTimer); zonePanelCloseTimer = null; }
  // Group by zone, newest-first within each group; zones themselves ordered by most-recent entry.
  var byZone = {}, zoneOrder = [];
  state.zoneCompletions.forEach(function(c){
    if(!byZone[c.zone]){ byZone[c.zone] = []; zoneOrder.push(c.zone); }
    byZone[c.zone].push(c);
  });
  var html = '<h2>Zone completions</h2><table>';
  for(var i = 0; i < zoneOrder.length; i++){
    var z = zoneOrder[i];
    var entries = byZone[z];
    for(var j = 0; j < entries.length; j++){
      var e = entries[j];
      html += '<tr' + (j === 0 && i > 0 ? ' class="zsep"' : (j > 0 ? '' : (i === 0 ? '' : ''))) + '>' +
        '<td class="zn">' + (j === 0 ? esc(zoneLabel(z)) : '') + '</td>' +
        '<td class="zp">' + esc(e.percent) + '%</td>' +
        '<td class="zt">' + esc(ago(new Date(e.t).toISOString())) + '</td>' +
      '</tr>';
    }
  }
  html += '</table>';
  panel.innerHTML = html;
  panel.classList.add('show');
  positionHoverPanel(panel, box);
}
function scheduleZonePanelClose(){
  if(zonePanelCloseTimer) clearTimeout(zonePanelCloseTimer);
  zonePanelCloseTimer = setTimeout(function(){
    var panel = document.getElementById('zonepanel');
    if(panel) panel.classList.remove('show');
    zonePanelCloseTimer = null;
  }, 250);
}

// Schedule panel — same hover pattern as the zone panel. Lists the upcoming 5 sessions next
// to / under the status box. Only attaches when scheduling is enabled (no point hovering an
// "Inactive" line — nothing to show).
var schedPanelCloseTimer = null;
function attachSchedPanelHover(){
  var box = document.getElementById('statusbox');
  var trigger = box && box.querySelector('.sched-trigger');
  if(!trigger) return;
  if(!state || !state.robot || !state.robot.schedule || !state.robot.schedule.enabled) return;
  trigger.addEventListener('mouseenter', showSchedPanel);
  trigger.addEventListener('mouseleave', scheduleSchedPanelClose);
  var panel = document.getElementById('schedpanel');
  if(panel && !panel.dataset.bound){
    panel.dataset.bound = '1';
    panel.addEventListener('mouseenter', function(){ if(schedPanelCloseTimer){ clearTimeout(schedPanelCloseTimer); schedPanelCloseTimer = null; } });
    panel.addEventListener('mouseleave', scheduleSchedPanelClose);
  }
}
function showSchedPanel(){
  var panel = document.getElementById('schedpanel');
  var box = document.getElementById('statusbox');
  if(!panel || !box) return;
  var sessions = upcomingScheduledSessions(5);
  if(sessions.length === 0) return;
  if(schedPanelCloseTimer){ clearTimeout(schedPanelCloseTimer); schedPanelCloseTimer = null; }
  var html = '<h2>Upcoming schedule</h2><table>';
  for(var i = 0; i < sessions.length; i++){
    var s = sessions[i];
    var when = scheduleWhenLabel(s.daysAway, s.dayName);
    html += '<tr' + (i === 0 ? ' class="now"' : '') + '>' +
      '<td class="swhen">' + esc(when) + '</td>' +
      '<td class="stime">' + esc(s.displayTime) + '</td>' +
      '<td class="sdur">' + esc(fmtScheduleDuration(s.durationMinutes)) + '</td>' +
    '</tr>';
  }
  html += '</table>';
  panel.innerHTML = html;
  panel.classList.add('show');
  positionHoverPanel(panel, box);
}
function scheduleSchedPanelClose(){
  if(schedPanelCloseTimer) clearTimeout(schedPanelCloseTimer);
  schedPanelCloseTimer = setTimeout(function(){
    var panel = document.getElementById('schedpanel');
    if(panel) panel.classList.remove('show');
    schedPanelCloseTimer = null;
  }, 250);
}

// Active-control panel. Hidden unless URL_CONFIG.commands === 'on'. Start/Stop is shown as
// the contextually-appropriate verb based on the live robot status; Home is always present.
// Commands POST to /api/command/:name and the local server publishes via MQTT.
var commandBusy = false;
function isRobotActive(r){
  if(!r) return false;
  var t = (r.statusType || '').toUpperCase();
  return t === 'MOWING' || t === 'CUTTING_BORDER' || t === 'REACHING_FIRST_POINT' || t === 'NAVIGATING_TO_AREA' || t === 'PLANNING_ONGOING' || t === 'GOING_HOME';
}
function renderCommandBox(){
  var box = document.getElementById('cmdbox');
  if(!box) return;
  if(URL_CONFIG.commands !== 'on'){ box.classList.add('pos-no'); return; }
  box.classList.remove('pos-no');
  var r = state && state.robot;
  var active = isRobotActive(r);
  var busy = commandBusy ? ' busy' : '';
  var primary = active
    ? '<span class="cbtn stop' + busy + '" data-cmd="stop">Stop</span>'
    : '<span class="cbtn start' + busy + '" data-cmd="start">Start</span>';
  var home = '<span class="cbtn home' + busy + '" data-cmd="home">Home</span>';
  var msg = box.querySelector('.cmsg');
  var msgHtml = msg ? msg.outerHTML : '<span class="cmsg"></span>';
  box.innerHTML = primary + home + msgHtml;
  var btns = box.querySelectorAll('.cbtn');
  for(var i = 0; i < btns.length; i++){
    (function(el){ el.addEventListener('click', function(){ sendCommand(el.getAttribute('data-cmd')); }); })(btns[i]);
  }
}
function setCommandMessage(text, isError){
  var box = document.getElementById('cmdbox');
  if(!box) return;
  var span = box.querySelector('.cmsg');
  if(!span) return;
  span.textContent = text || '';
  span.style.color = isError ? '#c5221f' : '#80868b';
}
function sendCommand(name){
  if(commandBusy) return;
  commandBusy = true;
  renderCommandBox();
  setCommandMessage('sending ' + name + '…', false);
  fetch('api/command/' + encodeURIComponent(name), { method: 'POST', cache: 'no-store' })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
    .then(function(rsp){
      commandBusy = false;
      if(rsp.ok) setCommandMessage(name + ' dispatched', false);
      else setCommandMessage(name + ' failed: ' + ((rsp.body && rsp.body.error) || 'unknown'), true);
      renderCommandBox();
      setTimeout(function(){ setCommandMessage('', false); }, 4000);
    })
    .catch(function(e){
      commandBusy = false;
      setCommandMessage(name + ' error: ' + e.message, true);
      renderCommandBox();
    });
}

// Refresh button (passive read; lives in the status box). Triggers a server-side re-fetch
// of perimeters and notifications, then redraws the relevant client state.
var refreshBusy = false;
function triggerRefresh(){
  if(refreshBusy) return;
  refreshBusy = true;
  renderStatusBox();
  fetch('api/refresh', { method: 'POST', cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(){
      perimetersDrawn = false;
      Object.keys(zonePolys).forEach(function(id){ zonePolys[id].setMap(null); });
      zonePolys = {}; zoneNames = {};
      loadPerimeters();
      refreshNotifications();
    })
    .catch(function(){})
    .finally(function(){ refreshBusy = false; renderStatusBox(); });
}
window.triggerRefresh = triggerRefresh;
window.sendCommand = sendCommand;

function renderStatusBox(){
  var box = document.getElementById('statusbox');
  if(!state){ box.innerHTML = '<div class="muted">connecting…</div>'; return; }
  var r = state.robot;
  var place = r.docked === true ? 'Docked' : (r.docked === false ? 'Out' : '-');
  // Prefer the human override (e.g. "GPS_SEARCHING", "STUCK") when present, else fall back
  // to the raw statusType — both are enum-style so soften() handles them uniformly (and the
  // SOFTEN_ACRONYMS list ensures GPS/RTK/etc keep their caps). Raw type stays in r.statusType
  // for color and active-state logic to key off unchanged.
  var op = fmt(soften(r.statusMessage || r.statusType));
  if(r.statusText) op += ' · ' + soften(r.statusText);
  var batt = r.battery ? (r.battery.charge + '%') : '-';
  var spark = URL_CONFIG.statusBatterySparkline === 'on' ? batterySparkSVG() : '';
  var sched = formatScheduleSummary();
  var schedRow = '<div class="row"><span class="k">Schedule</span><span class="v sched-trigger" data-schedpanel="1">' + esc(sched) + '</span></div>';
  var mow = '-';
  if(r.mowing) mow = zoneLabel(r.mowing.zone) + ' · ' + fmt(r.mowing.zoneCompleted,0) + '% · garden ' + fmt(r.mowing.gardenCompleted,0) + '%';
  // experimental: current mowing target waypoint (from LOG/STATUS [18][4]); gated on ?experimental=on
  var tgtRow = '';
  if(URL_CONFIG.experimental === 'on' && r.mowing && r.mowing.target){
    var tg = r.mowing.target;
    var tw = (typeof tg.latitude === 'number') ? (tg.latitude.toFixed(6) + ',' + tg.longitude.toFixed(6)) : (fmt(tg.east,1) + ',' + fmt(tg.north,1) + 'm');
    var dist = '';
    if(typeof tg.latitude === 'number' && typeof r.latitude === 'number'){
      var mLat = 111320, mLng = 111320 * Math.cos(r.latitude * Math.PI / 180);
      dist = ' · ' + Math.hypot((tg.latitude - r.latitude) * mLat, (tg.longitude - r.longitude) * mLng).toFixed(1) + 'm';
    }
    tgtRow = row('Target', tw + ' · ' + Math.round(tg.headingCompass) + '°' + dist);
    if(tg.raw) tgtRow += row('Mow[4]', 'en=(' + fmt(tg.east,1) + ',' + fmt(tg.north,1) + ') · 1=' + tg.raw[1] + ' 2=' + tg.raw[2] + ' 3=' + tg.raw[3] + ' 4=' + tg.raw[4] + ' 7=' + tg.raw[7]);
  }
  var zoneLastRow = '';
  var zc = state.zoneCompletions;
  if(Array.isArray(zc) && zc.length > 0){
    var latest = zc[0];
    zoneLastRow = '<div class="zonelast" data-zonepanel="1">' + esc(zoneLabel(latest.zone)) + ' - ' + esc(latest.percent) + '% · ' + esc(ago(new Date(latest.t).toISOString())) + '</div>';
  }
  var link = linkState();
  var linkTag = '<span class="linktag ' + link.cls + '">' + esc(link.label) + '</span>';
  var trk = '';
  if(URL_CONFIG.statusTracksControls !== 'off'){
    var clrLabel = tracksClr === Number.POSITIVE_INFINITY ? '∞' : String(tracksClr);
    var refreshBtn = '<span class="btn" onclick="triggerRefresh()" title="re-fetch perimeters and notifications">' + (refreshBusy ? '↻…' : '↻') + '</span>';
    var visBtn = '<span class="btn" onclick="toggleTracksVisible()" title="temporarily hide/show tracks (recording continues)">' + (tracksVisible ? 'HIDE' : 'SHOW') + '</span>';
    var alarmBtn = '<span class="btn' + (alarmsHighlighted ? ' on' : '') + '" onclick="toggleAlarmsHighlight()" title="highlight error tracks and reveal deduped alarm log on hover">!</span>';
    trk = '<div class="tracks">' + refreshBtn + ' Tracks:' +
      '<span class="btn' + (tracksOn ? ' on' : '') + '" onclick="toggleTracks()">' + (tracksOn ? 'ON' : 'OFF') + '</span>' +
      visBtn +
      '<span class="btn" onclick="clearTracks()">CLR</span>' +
      '<span class="btn" onclick="cycleTracksClr()" title="decay limit (distinct zones to keep)">#' + clrLabel + '</span>' +
      alarmBtn +
    '</div>';
  }
  box.innerHTML =
    '<h1><span class="dot" style="background:' + robotColor(r) + '"></span>' + (r.name ? "'" + esc(r.name) + "'" : 'Stiga Robot') + linkTag + '</h1>' +
    row('State', place) + row('Status', op, r.interventionRequired ? 'alert' : '') + row('Battery', batt) + spark + schedRow + row('Mowing', mow) + tgtRow + zoneLastRow +
    '<div class="muted">status ' + ago(r.updatedStatus) + ' · position ' + ago(r.updatedPosition) + '</div>' + trk;
  attachZonePanelHover();
  attachSchedPanelHover();
}

function table(rows){
  var h = '<table>';
  for(var i = 0; i < rows.length; i++)
    if(rows[i])
      h += '<tr><td class="k">' + esc(rows[i][0]) + '</td><td>' + esc(rows[i][1]) + '</td></tr>';
  return h + '</table>';
}
function netLine(n){
  if(!n) return '-';
  var s = fmt(n.name);
  if(n.type) s += ' (' + n.type + ')';
  if(typeof n.rssi === 'number') s += ' · ' + n.rssi + ' dBm';
  return s;
}
function rtkLine(l){
  if(!l) return '-';
  var s = fmt(l.satellites) + ' sats';
  if(typeof l.coverage === 'number') s += ' · ' + (COVERAGE[l.coverage] || l.coverage);
  if(typeof l.offsetDistance === 'number') s += ' · RTK ' + l.offsetDistance.toFixed(1) + ' cm';
  return s;
}
function verLine(v){
  return v ? (fmt(v.firmware) + (v.build ? ' (build ' + v.build + ')' : '')) : '-';
}

function robotInfo(){
  if(!state) return '<div class="infobox">connecting…</div>';
  var r = state.robot;
  // Combined Location: offset-from-base + orientation, e.g. "1.7m at 242°, oriented 338°".
  // Each half degrades independently when its source is missing.
  var fromBase = (typeof r.offsetDistanceMetres === 'number') ? (r.offsetDistanceMetres.toFixed(1) + 'm at ' + Math.round(r.offsetCompass) + '°') : null;
  var heading = (typeof r.orientationCompass === 'number') ? ('oriented ' + Math.round(r.orientationCompass) + '°') : null;
  var location = [fromBase, heading].filter(Boolean).join(', ') || '-';
  var rows = [
    ['Status', fmt(r.statusMessage || r.statusType) + (r.statusText ? ' · ' + r.statusText : '')],
    ['Validity', fmt(r.statusValid) + ' · ' + fmt(r.statusFlag)],
    ['Docked', r.docked === undefined ? '-' : (r.docked ? 'yes' : 'no')],
    ['Battery', r.battery ? (r.battery.charge + '% · ' + r.battery.capacity + ' mAh') : '-'],
    ['Position', (typeof r.latitude === 'number') ? (r.latitude.toFixed(7) + ', ' + r.longitude.toFixed(7)) : 'no fix yet'],
    ['Location', location],
    ['GNSS/RTK', rtkLine(r.location)],
    ['Network', netLine(r.network)],
    ['Firmware', verLine(r.version)]
  ];
  return '<div class="infobox"><h2>Robot</h2>' + table(rows) + '<div class="muted">status ' + ago(r.updatedStatus) + ' · position ' + ago(r.updatedPosition) + '</div></div>';
}

// notifications — polled on a slow cadence (60s by default) and rendered in a bottom-left
// box. The server already has them in cached form; dismissal is client-only, so dismissed
// items reappear on page refresh (acceptable — we have no cloud "mark read" path yet).
function refreshNotifications(){
  fetch('api/notifications', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(list){ notifications = list || []; renderNotifBox(); })
    .catch(function(){ /* keep last list */ });
}

function renderNotifBox(){
  var box = document.getElementById('notifbox');
  if(!box) return;
  // Sort all notifications newest-first and assign 1-based ranks against the full list, so the
  // header can express "showing items 2-3 of 5" — useful when dismissals shift the visible window.
  var sorted = notifications.slice().sort(function(a, b){
    return (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0);
  });
  var total = sorted.length;
  var rankByUuid = {};
  sorted.forEach(function(n, i){ rankByUuid[n.uuid] = i + 1; });
  var visible = sorted.filter(function(n){ return !dismissed[n.uuid]; }).slice(0, 3);
  if(visible.length === 0){ box.classList.add('empty'); box.innerHTML = ''; return; }
  box.classList.remove('empty');
  var ranks = visible.map(function(n){ return rankByUuid[n.uuid]; });
  var firstRank = Math.min.apply(null, ranks);
  var lastRank = Math.max.apply(null, ranks);
  var rangeLabel = firstRank === lastRank ? String(firstRank) : firstRank + '-' + lastRank;
  var html = '<h2>Notifications (' + rangeLabel + ' of ' + total + ')</h2>';
  for(var i = 0; i < visible.length; i++){
    var n = visible[i];
    var meta = [n.type, n.category].filter(Boolean).join(' · ');
    var body = n.body && n.body !== 'No body' ? n.body : '';
    var bodyChunk = body ? '<span class="nsep">—</span><span class="nbody">' + esc(body) + '</span>' : '';
    html += '<div class="nrow">' +
      '<span class="ndismiss" data-uuid="' + esc(n.uuid) + '" title="dismiss">×</span>' +
      '<span class="nago">' + esc(ago(n.createdAt)) + '</span>' +
      '<div class="ncol">' + '<div class="nline"><strong>' + esc(n.title) + '</strong>' + bodyChunk + '</div>' + (meta ? '<div class="nmeta">' + esc(meta) + '</div>' : '') + '</div>' +
    '</div>';
  }
  box.innerHTML = html;
  var buttons = box.querySelectorAll('.ndismiss');
  for(var j = 0; j < buttons.length; j++){
    (function(el){
      el.addEventListener('click', function(){ dismissed[el.getAttribute('data-uuid')] = true; renderNotifBox(); });
    })(buttons[j]);
  }
  applyStackedNotifyPosition();
}

function baseInfo(){
  if(!state) return '<div class="infobox">connecting…</div>';
  var b = state.base;
  var st = b.status || {};
  var rows = [
    ['Status', fmt(st.type)],
    ['Detail', fmt(st.value) + ' / ' + fmt(st.detail)],
    ['Flag', fmt(st.flag)],
    ['Position', b.latitude.toFixed(7) + ', ' + b.longitude.toFixed(7)],
    ['GNSS/RTK', rtkLine(b.location)],
    ['Network', netLine(b.network)],
    ['Firmware', verLine(b.version)]
  ];
  return '<div class="infobox"><h2>Base station</h2>' + table(rows) + '<div class="muted">status ' + ago(b.updatedStatus) + '</div></div>';
}
`;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = WebStatusProcessor;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
