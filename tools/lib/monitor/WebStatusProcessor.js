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
//   mapPosition             <lat>,<lon>,<zoom>           Lock the map view. Disables auto-fit-to-bounds.
//                                                        Example: mapPosition=59.6624,12.9952,19
//   mapControls             on | off                     'off' = disableDefaultUI (no zoom/fullscreen/etc.).
//
// Tracks (breadcrumb trail)
//   tracks                  on | off                     Force initial tracks state (default off).
//   tracksClr               0 | 1 | 2 | 3 | off          Decay limit: keep at most max(N,1) most-recent
//                                                        distinct mowing zones. 0 = kill prior on zone change,
//                                                        'off' = keep all (no decay). Default 0.
//                                                        Cycle button in the status box steps through
//                                                        0 → 1 → 2 → 3 → ∞ → 0.
//
// Status-box content
//   statusBatterySparkline  on | off                     Hide the inline battery SVG (default on).
//   statusTracksControls    on | off                     Hide the entire Tracks line (default on).
//
// Example kiosk URL:
//   /?boxNotify=no&mapPosition=59.6624,12.9952,19&mapControls=off&tracks=on&tracksClr=2&statusBatterySparkline=off
//
// More knobs will be added here over time; structure new ones the same way (URL_CONFIG entry +
// a single usage site) so each option stays small and removable.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const express = require('express');

const { StigaAPIUtilities, StigaAPIElements: elements, StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIGarage, StigaAPIPerimeters, StigaAPINotifications } = require('../../../api/StigaAPI');
const { protobufDecode, formatNetworkId } = StigaAPIUtilities;

const DEFAULT_PORT = 3001;
const POLL_MS = 2500; // browser -> server poll interval (local, cheap)
const NOTIF_POLL_MS_UNDOCKED = 60_000; // notifications poll interval when robot is active
const NOTIF_POLL_MS_DOCKED = 300_000; // notifications poll interval when robot is parked

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
        this.perimeters = undefined;
        this.notifications = [];
        this.cloudServer = undefined;
        this.notifTimer = undefined;
        this.poller = options.poller;

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
                updatedVersion: undefined,
            },
            robot: {
                mac: options.robotMac,
                latitude: undefined,
                longitude: undefined,
                offsetDistanceMetres: undefined,
                offsetCompass: undefined,
                orientationCompass: undefined,
                docked: undefined,
                statusType: undefined,
                statusText: undefined,
                statusValid: undefined,
                statusFlag: undefined,
                battery: undefined,
                mowing: undefined,
                schedule: undefined,
                location: undefined,
                network: undefined,
                version: undefined,
                updatedStatus: undefined,
                updatedPosition: undefined,
                updatedSchedule: undefined,
                updatedVersion: undefined,
            },
        };
    }

    //

    async start() {
        this.connection.on('message', (topic, message) => this._handleMessage(topic, message));

        const app = express();
        app.disable('x-powered-by');
        if (this.basicAuth) app.use((req, res, next) => this._basicAuthMiddleware(req, res, next));
        app.get('/', (req, res) => res.type('html').send(this._renderPage()));
        app.get('/api/state', (req, res) => res.json({ generated: new Date().toISOString(), ...this.state }));
        app.get('/api/perimeters', (req, res) => res.json(this.perimeters ?? { zones: [], obstacles: [] }));
        app.get('/api/notifications', (req, res) => res.json(this.notifications));
        await new Promise((resolve, reject) => {
            this.server = app.listen(this.port, '0.0.0.0', () => resolve());
            this.server.on('error', reject);
        });

        this.poller?.acquire();

        this._loadPerimeters()
            .then(() => this._startNotificationPoll())
            .catch((e) => this.logger(`WebStatus: cloud features unavailable (${e.message})`));

        this.logger(`WebStatus started on port ${this.port}`);
    }

    async stop() {
        this.poller?.release();
        if (this.notifTimer) {
            clearTimeout(this.notifTimer);
            this.notifTimer = undefined;
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
            const userOk = this.basicAuth.user === undefined || user === this.basicAuth.user;
            if (userOk && pass === this.basicAuth.pass) {
                next();
                return;
            }
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="Stiga Webstatus", charset="UTF-8"');
        res.status(401).type('text/plain').send('Authentication required');
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
        if (topic.includes('/LOG/STATUS')) {
            this._handleRobotStatus(decoded);
        } else if (topic.includes('/LOG/VERSION')) {
            this.state.robot.version = this._version(decoded);
            this.state.robot.updatedVersion = new Date().toISOString();
        } else if (topic.includes('/LOG/ROBOT_POSITION')) {
            this._handleRobotPosition(decoded);
        } else if (topic.includes('/LOG/SCHEDULING_SETTINGS')) {
            this._handleRobotSchedule(decoded);
        }
    }

    _handleBaseMessage(topic, decoded) {
        if (topic.endsWith('ACK')) return;
        if (topic.includes('/LOG/STATUS')) {
            this._handleBaseStatus(decoded);
        } else if (topic.includes('/LOG/VERSION')) {
            this.state.base.version = this._version(decoded);
            this.state.base.updatedVersion = new Date().toISOString();
        }
    }

    //

    _handleRobotStatus(decoded) {
        const r = this.state.robot;
        r.statusType = elements.formatRobotStatusType(elements.decodeRobotStatusType(decoded[3]));
        const info = elements.formatRobotStatusInfo(elements.decodeRobotStatusInfo(decoded[10])).replaceAll('-', '');
        const error = elements.formatRobotStatusError(elements.decodeRobotStatusError(decoded[4])).replaceAll('-', '');
        r.statusText = [info, error].filter(Boolean).join(', ');
        r.statusValid = elements.formatRobotStatusValid(elements.decodeRobotStatusValid(decoded[1]));
        r.statusFlag = elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[2]));
        r.docked = elements.formatRobotStatusDocking(elements.decodeRobotStatusDocking(decoded[13])).startsWith('yes');
        if (decoded[17]) {
            const battery = elements.decodeRobotBatteryStatus(decoded[17]);
            r.battery = battery ? { charge: battery.charge, capacity: battery.capacity } : undefined;
        }
        if (decoded[18]) {
            const mowing = elements.decodeRobotMowingStatus(decoded[18]);
            r.mowing = mowing ? { zone: mowing.zone, zoneCompleted: mowing.zoneCompleted, gardenCompleted: mowing.gardenCompleted } : undefined;
        }
        if (decoded[19]) r.location = this._rtk(decoded[19]);
        if (decoded[20]) r.network = this._network(decoded[20]);
        r.updatedStatus = new Date().toISOString();
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
    }

    // Compact the schedule down to just what the client needs to compute "next mow": a flag
    // for whether scheduling is on, and the list of weekly time blocks with their start time.
    _handleRobotSchedule(decoded) {
        const schedule = elements.decodeRobotScheduleSettings(decoded);
        if (!schedule) return;
        const blocks = [];
        for (const day of schedule.days || []) {
            for (const block of day.timeBlocks || []) {
                blocks.push({
                    dayIndex: day.dayIndex,
                    dayName: day.dayName,
                    startHour: block.startTime?.hour ?? Math.floor(block.startSlot / 2),
                    startMinute: block.startTime?.minute ?? (block.startSlot % 2) * 30,
                    displayTime: block.displayTime,
                });
            }
        }
        this.state.robot.schedule = { enabled: schedule.enabled, blocks };
        this.state.robot.updatedSchedule = new Date().toISOString();
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
        const perimeters = new StigaAPIPerimeters(server, device);
        if (!(await perimeters.load())) throw new Error('perimeter load failed');

        const ref = perimeters.getReferencePosition();
        this.perimeters = {
            referencePosition: ref,
            zones: perimeters.getZones().map((zone) => ({ id: zone.getId(), name: zone.getName(), area: zone.getArea(), path: zone.getPath() })),
            obstacles: perimeters.getObstacles().map((obstacle) => ({ id: obstacle.getId(), area: obstacle.getArea(), path: obstacle.getPath() })),
        };
        if (ref?.latitude && ref?.longitude) {
            this.location = ref;
            this.state.base.latitude = ref.latitude;
            this.state.base.longitude = ref.longitude;
        }
        this.logger(`WebStatus: loaded ${this.perimeters.zones.length} zones, ${this.perimeters.obstacles.length} obstacles`);
    }

    // poll the cloud for notifications. Frequency is adaptive: a fast cadence while the
    // robot is undocked (where messages tend to arrive), and a slow cadence while it is
    // parked. Self-rescheduling so the interval is recomputed each tick from current state.
    _startNotificationPoll() {
        if (!this.cloudServer) return;
        const tick = async () => {
            try {
                const notifications = new StigaAPINotifications(this.cloudServer);
                if (await notifications.load()) {
                    this.notifications = notifications.getAll().map((n) => ({
                        uuid: n.getUuid(),
                        title: n.getTitle(),
                        body: n.getBody(),
                        type: n.getType(),
                        category: n.getCategory(),
                        read: n.isRead(),
                        createdAt: n.getCreatedAt()?.toISOString(),
                    }));
                }
            } catch (e) {
                this.logger(`WebStatus: notifications poll failed (${e.message})`);
            }
            const delay = this.state.robot.docked ? NOTIF_POLL_MS_DOCKED : NOTIF_POLL_MS_UNDOCKED;
            this.notifTimer = setTimeout(tick, delay);
        };
        tick();
    }

    //

    _renderPage() {
        const config = JSON.stringify({
            baseLat: this.location.latitude,
            baseLng: this.location.longitude,
            pollMs: POLL_MS,
            notifPollMs: NOTIF_POLL_MS_UNDOCKED,
        });
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stiga Robot — Live Status</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<div id="map"></div>
<div id="statusbox" class="pos-lt"><div class="muted">connecting…</div></div>
<div id="notifbox" class="pos-st empty"></div>
<script>var CONFIG = ${config};</script>
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
.pos-st{right:auto;bottom:auto} /* stacked under status box; top/left/width set by JS */
#statusbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:9px 13px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif;min-width:200px;color:#202124}
#statusbox h1{font-size:13px;margin:0 0 6px;display:flex;align-items:center}
#statusbox .row{display:flex;justify-content:space-between;gap:18px}
#statusbox .k{color:#80868b}
#statusbox .v{font-weight:600;text-align:right}
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
#statusbox .nextmow{margin-top:4px;color:#80868b;font-size:11px}
`;

// Client-side script. Uses only quoted strings and concatenation (no template literals,
// no backticks, no ${...}) so it can be embedded verbatim into the page template above.
const CLIENT_JS = `
var map, infoWindow, baseMarker, robotMarker, robotPin;
var state = null, hovered = null, closeTimer = null, userMoved = false, didFit = false;
var perimetersDrawn = false, perimetersLoading = false;
var zonePolys = {}, zoneNames = {};
var tracksOn = false, crumbs = [], crumbSegments = [], lastCrumbTime = null;
var notifications = [], dismissed = {};
var batteryHistory = [], lastBatteryStatusTime = null;

// kiosk-mode URL config — query params let us position/disable boxes, lock the map,
// preset the tracks toggle and decay limit, and trim status-box contents. All optional.
//   boxStatus, boxNotify   lt|rt|lb|rb|no   (default: lt for status, lb for notify)
//   mapPosition            lat,lon,zoom     (locks map view)
//   mapControls            on|off           (off = disableDefaultUI)
//   tracks                 on|off           (force tracks state; default off)
//   tracksClr              0|1|2|3|off      (decay limit; 0=kill prior on transition, off=keep all)
//   statusBatterySparkline on|off           (default on)
//   statusTracksControls   on|off           (default on)
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
    statusTracksControls: p.get('statusTracksControls')
  };
})();

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

// When the notifbox is in stacked mode it has no top/left/width of its own — it tracks the
// status box's bounding rect so it sits flush underneath and matches its width. Re-run on:
// status-box resize (content changes), window resize, and after the notif box itself rerenders.
function applyStackedNotifyPosition(){
  var nb = document.getElementById('notifbox');
  if(!nb || !nb.classList.contains('pos-st')) return;
  var sb = document.getElementById('statusbox');
  if(!sb) return;
  var rect = sb.getBoundingClientRect();
  nb.style.top = (rect.bottom + 8) + 'px';
  nb.style.left = rect.left + 'px';
  nb.style.width = rect.width + 'px';
  nb.style.maxWidth = 'none';
}
if(window.ResizeObserver){
  var sb = document.getElementById('statusbox');
  if(sb) new window.ResizeObserver(applyStackedNotifyPosition).observe(sb);
}
window.addEventListener('resize', applyStackedNotifyPosition);
var COVERAGE = ['GOOD','POOR','BAD','WORSE'];
var ZONE_COLORS = ['#fbbc04','#34a853','#4285f4','#a142f4','#ff6d01'];

function esc(s){ var d = document.createElement('div'); d.textContent = (s === null || s === undefined) ? '' : String(s); return d.innerHTML; }
function fmt(v,dash){ return (v === null || v === undefined || v === '') ? (dash === undefined ? '-' : dash) : v; }
function ago(iso){
  if(!iso) return 'never';
  var s = Math.round((Date.now() - new Date(iso).getTime())/1000);
  if(s < 60) return s + 's ago';
  if(s < 3600) return Math.round(s/60) + 'm ago';
  return Math.round(s/3600) + 'h ago';
}

function initMap(){
  var base = { lat: CONFIG.baseLat, lng: CONFIG.baseLng };
  var center = base, zoom = 18, locked = false;
  if(URL_CONFIG.mapPosition){
    var parts = URL_CONFIG.mapPosition.split(',').map(function(s){ return Number.parseFloat(s); });
    if(parts.length >= 2 && !Number.isNaN(parts[0]) && !Number.isNaN(parts[1])){
      center = { lat: parts[0], lng: parts[1] };
      if(parts.length >= 3 && !Number.isNaN(parts[2])) zoom = parts[2];
      locked = true;
    }
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

  var basePin = new google.maps.marker.PinElement({ background:'#1a73e8', borderColor:'#ffffff', glyphColor:'#ffffff', glyph:'B' });
  baseMarker = new google.maps.marker.AdvancedMarkerElement({ map: map, position: base, title: 'Base station', content: basePin.element });
  attachHover(baseMarker, 'base');

  robotPin = new google.maps.marker.PinElement({ background:'#34a853', borderColor:'#ffffff', glyphColor:'#ffffff', glyph:'R' });
  robotMarker = new google.maps.marker.AdvancedMarkerElement({ position: base, title: 'Robot', content: robotPin.element });
  attachHover(robotMarker, 'robot');

  refresh();
  setInterval(refresh, CONFIG.pollMs);
  refreshNotifications();
  setInterval(refreshNotifications, CONFIG.notifPollMs);
}
window.initMap = initMap;
window.toggleTracks = toggleTracks;
window.clearTracks = clearTracks;

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
      (p.zones || []).forEach(function(z, i){
        var color = ZONE_COLORS[i % ZONE_COLORS.length];
        var poly = makePolygon(z.path, color, 0.12, 4, 1);
        if(poly){
          poly.getPath().forEach(function(ll){ bounds.extend(ll); });
          any = true;
          zonePolys[z.id] = poly;
          zoneNames[z.id] = z.name;
        }
      });
      (p.obstacles || []).forEach(function(o){
        makePolygon(o.path, '#ea4335', 0.20, 3, 2);
      });
      highlightActiveZone();
      if(any && !userMoved){ didFit = true; map.fitBounds(bounds, 60); }
    })
    .catch(function(){ perimetersLoading = false; });
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
  var prev = crumbs[crumbs.length - 1];
  var pt = { lat: r.latitude, lng: r.longitude, color: color, zone: zone };
  crumbs.push(pt);
  if(prev){
    var seg = new google.maps.Polyline({
      path: [{ lat: prev.lat, lng: prev.lng }, { lat: pt.lat, lng: pt.lng }],
      strokeColor: color, strokeOpacity: 0.95, strokeWeight: 3, clickable: false, zIndex: 3, map: map
    });
    seg.crumbZone = zone;
    crumbSegments.push(seg);
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
function cycleTracksClr(){
  var idx = TRACKS_CLR_CYCLE.indexOf(tracksClr);
  tracksClr = TRACKS_CLR_CYCLE[(idx + 1) % TRACKS_CLR_CYCLE.length];
  applyTracksClr();
  renderStatusBox();
}
window.cycleTracksClr = cycleTracksClr;
function setTracks(on){
  if(tracksOn === on) return;
  tracksOn = on;
  crumbSegments.forEach(function(s){ s.setMap(tracksOn ? map : null); });
  if(tracksOn){ lastCrumbTime = null; recordCrumb(); }
}
function toggleTracks(){ setTracks(!tracksOn); renderStatusBox(); }
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

// compute the next scheduled start time, scanning forward up to 7 days from now.
function nextScheduledMow(){
  if(!state || !state.robot || !state.robot.schedule) return null;
  var s = state.robot.schedule;
  if(!s.enabled || !s.blocks || s.blocks.length === 0) return null;
  var now = new Date();
  var jsDay = now.getDay(); // 0=Sun..6=Sat
  // convert JS day (Sun=0) to schedule day (Mon=0..Sun=6)
  var todayScheduleIdx = (jsDay + 6) % 7;
  var nowMin = now.getHours() * 60 + now.getMinutes();
  for(var offset = 0; offset < 8; offset++){
    var scheduleDay = (todayScheduleIdx + offset) % 7;
    var bucket = s.blocks.filter(function(b){ return b.dayIndex === scheduleDay; }).sort(function(a, b){ return a.startHour * 60 + a.startMinute - (b.startHour * 60 + b.startMinute); });
    for(var i = 0; i < bucket.length; i++){
      var b = bucket[i];
      var blockMin = b.startHour * 60 + b.startMinute;
      if(offset === 0 && blockMin <= nowMin) continue;
      var dt = new Date(now);
      dt.setDate(dt.getDate() + offset);
      dt.setHours(b.startHour, b.startMinute, 0, 0);
      return { date: dt, day: b.dayName, displayTime: b.displayTime };
    }
  }
  return null;
}

function formatNextMow(nm){
  if(!nm) return null;
  var deltaMin = Math.round((nm.date.getTime() - Date.now()) / 60_000);
  var when;
  if(deltaMin < 60) when = 'in ' + deltaMin + 'm';
  else if(deltaMin < 24 * 60) when = 'in ' + Math.round(deltaMin / 60) + 'h';
  else if(deltaMin < 7 * 24 * 60) when = nm.day.slice(0, 3) + ' ' + nm.displayTime.split('-')[0];
  else when = 'next ' + nm.day;
  return 'Next mow ' + when;
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

function row(k,v){
  return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>';
}

function renderStatusBox(){
  var box = document.getElementById('statusbox');
  if(!state){ box.innerHTML = '<div class="muted">connecting…</div>'; return; }
  var r = state.robot;
  var place = r.docked === true ? 'Docked' : (r.docked === false ? 'Out' : '-');
  var op = fmt(r.statusType);
  if(r.statusText) op += ' · ' + r.statusText;
  var batt = r.battery ? (r.battery.charge + '%') : '-';
  var spark = URL_CONFIG.statusBatterySparkline === 'off' ? '' : batterySparkSVG();
  var mow = '-';
  if(r.mowing) mow = zoneLabel(r.mowing.zone) + ' · ' + fmt(r.mowing.zoneCompleted,0) + '% · garden ' + fmt(r.mowing.gardenCompleted,0) + '%';
  var nextMowStr = formatNextMow(nextScheduledMow());
  var nextMowRow = nextMowStr ? '<div class="nextmow">' + esc(nextMowStr) + '</div>' : '';
  var link = linkState();
  var linkTag = '<span class="linktag ' + link.cls + '">' + esc(link.label) + '</span>';
  var trk = '';
  if(URL_CONFIG.statusTracksControls !== 'off'){
    var clrLabel = tracksClr === Number.POSITIVE_INFINITY ? '∞' : String(tracksClr);
    trk = '<div class="tracks">Tracks:' +
      '<span class="btn' + (tracksOn ? ' on' : '') + '" onclick="toggleTracks()">' + (tracksOn ? 'ON' : 'OFF') + '</span>' +
      '<span class="btn" onclick="clearTracks()">CLR</span>' +
      '<span class="btn" onclick="cycleTracksClr()" title="decay limit (distinct zones to keep)">#' + clrLabel + '</span>' +
    '</div>';
  }
  box.innerHTML =
    '<h1><span class="dot" style="background:' + robotColor(r) + '"></span>Stiga Robot' + linkTag + '</h1>' +
    row('State', place) + row('Status', op) + row('Battery', batt) + spark + row('Mowing', mow) + nextMowRow +
    '<div class="muted">status ' + ago(r.updatedStatus) + ' · position ' + ago(r.updatedPosition) + '</div>' + trk;
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
  var rows = [
    ['Operation', fmt(r.statusType) + (r.statusText ? ' · ' + r.statusText : '')],
    ['Validity', fmt(r.statusValid) + ' · ' + fmt(r.statusFlag)],
    ['Docked', r.docked === undefined ? '-' : (r.docked ? 'yes' : 'no')],
    ['Battery', r.battery ? (r.battery.charge + '% · ' + r.battery.capacity + ' mAh') : '-'],
    r.mowing ? ['Mowing', zoneLabel(r.mowing.zone) + ' at ' + fmt(r.mowing.zoneCompleted,0) + '%, garden ' + fmt(r.mowing.gardenCompleted,0) + '%'] : null,
    ['Location', (typeof r.latitude === 'number') ? (r.latitude.toFixed(7) + ', ' + r.longitude.toFixed(7)) : 'no fix yet'],
    ['From base', (typeof r.offsetDistanceMetres === 'number') ? (r.offsetDistanceMetres.toFixed(1) + ' m at ' + Math.round(r.offsetCompass) + '°') : '-'],
    ['Heading', (typeof r.orientationCompass === 'number') ? (Math.round(r.orientationCompass) + '°') : '-'],
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
  var visible = notifications
    .filter(function(n){ return !dismissed[n.uuid]; })
    .slice()
    .sort((a, b) => (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0))
    .slice(0, 3);
  if(visible.length === 0){ box.className = 'empty'; box.innerHTML = ''; return; }
  box.className = '';
  var html = '<h2>Notifications (' + visible.length + ')</h2>';
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
}

function baseInfo(){
  if(!state) return '<div class="infobox">connecting…</div>';
  var b = state.base;
  var st = b.status || {};
  var rows = [
    ['Position', b.latitude.toFixed(7) + ', ' + b.longitude.toFixed(7)],
    ['Status', fmt(st.type)],
    ['Detail', fmt(st.value) + ' / ' + fmt(st.detail)],
    ['Flag', fmt(st.flag)],
    ['LED', fmt(st.led)],
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
