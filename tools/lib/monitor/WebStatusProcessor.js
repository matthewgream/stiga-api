// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// WebStatusProcessor — a monitor plugin that serves a lightweight real-time status web page.
//
// Runs an Express server with a full-screen Google Maps canvas showing a pin for the base
// station and a pin for the robot (the robot pin moves as position updates arrive). A fixed
// status box (top-left, unaffected by map pan/zoom) shows the headline robot state; hovering
// either pin reveals a detail popup. The browser polls /api/state; this processor keeps that
// state fresh by decoding the live MQTT stream; the shared RequestPoller drives the requests.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const express = require('express');

const { StigaAPIUtilities, StigaAPIElements: elements, StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIGarage, StigaAPIPerimeters } = require('../../../api/StigaAPI');
const { protobufDecode, formatNetworkId } = StigaAPIUtilities;

const DEFAULT_PORT = 3001;
const POLL_MS = 3000; // browser -> server poll interval (local, cheap)

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
        this.perimeters = undefined;
        // status/version requests are driven by the shared RequestPoller
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
                location: undefined,
                network: undefined,
                version: undefined,
                updatedStatus: undefined,
                updatedPosition: undefined,
                updatedVersion: undefined,
            },
        };
    }

    //

    async start() {
        this.connection.on('message', (topic, message) => this._handleMessage(topic, message));

        const app = express();
        app.disable('x-powered-by');
        app.get('/', (req, res) => res.type('html').send(this._renderPage()));
        app.get('/api/state', (req, res) => res.json({ generated: new Date().toISOString(), ...this.state }));
        app.get('/api/perimeters', (req, res) => res.json(this.perimeters ?? { zones: [], obstacles: [] }));
        await new Promise((resolve, reject) => {
            this.server = app.listen(this.port, '0.0.0.0', () => resolve());
            this.server.on('error', reject);
        });

        this.poller?.acquire();

        this._loadPerimeters().catch((e) => this.logger(`WebStatus: perimeters unavailable (${e.message})`));

        this.logger(`WebStatus started on port ${this.port}`);
    }

    async stop() {
        this.poller?.release();
        if (this.server) await new Promise((resolve) => this.server.close(resolve));
        this.logger('WebStatus stopped');
    }

    //

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
            r.battery = { charge: battery.charge, capacity: battery.capacity };
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
    // referencePosition as the RTK origin so zones and the robot share one frame.
    async _loadPerimeters() {
        if (!this.username || !this.password) {
            this.logger('WebStatus: no credentials supplied — zones disabled');
            return;
        }
        const auth = new StigaAPIAuthentication(this.username, this.password);
        if (!(await auth.isValid())) throw new Error('authentication failed');
        const server = new StigaAPIConnectionServer(auth);
        if (!(await server.isConnected())) throw new Error('server connection failed');
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

    //

    _renderPage() {
        const config = JSON.stringify({ baseLat: this.location.latitude, baseLng: this.location.longitude, pollMs: POLL_MS });
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
<div id="statusbox"><div class="muted">connecting…</div></div>
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
#statusbox{position:absolute;top:12px;left:12px;z-index:5;background:rgba(255,255,255,.96);
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
`;

// Client-side script. Uses only quoted strings and concatenation (no template literals,
// no backticks, no ${...}) so it can be embedded verbatim into the page template above.
const CLIENT_JS = `
var map, infoWindow, baseMarker, robotMarker, robotPin;
var state = null, hovered = null, closeTimer = null, userMoved = false, didFit = false;
var perimetersDrawn = false, perimetersLoading = false;
var zonePolys = {}, zoneNames = {};
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
  map = new google.maps.Map(document.getElementById('map'), {
    center: base, zoom: 18, mapTypeId: 'satellite', tilt: 0,
    mapId: 'robot_position_map', gestureHandling: 'greedy', streetViewControl: false
  });
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
}
window.initMap = initMap;

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
  var name = zoneNames[zoneId];
  return name ? (name + ' (' + zoneId + ')') : ('Zone ' + zoneId);
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

function row(k,v){ return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }

function renderStatusBox(){
  var box = document.getElementById('statusbox');
  if(!state){ box.innerHTML = '<div class="muted">connecting…</div>'; return; }
  var r = state.robot;
  var place = r.docked === true ? 'Docked' : (r.docked === false ? 'Out' : '-');
  var op = fmt(r.statusType);
  if(r.statusText) op += ' · ' + r.statusText;
  var batt = r.battery ? (r.battery.charge + '%') : '-';
  var mow = '-';
  if(r.mowing) mow = zoneLabel(r.mowing.zone) + ' · ' + fmt(r.mowing.zoneCompleted,0) + '% · garden ' + fmt(r.mowing.gardenCompleted,0) + '%';
  box.innerHTML =
    '<h1><span class="dot" style="background:' + robotColor(r) + '"></span>Stiga Robot</h1>' +
    row('State', place) + row('Status', op) + row('Battery', batt) + row('Mowing', mow) +
    '<div class="muted">status ' + ago(r.updatedStatus) + ' · position ' + ago(r.updatedPosition) + '</div>';
}

function table(rows){
  var h = '<table>';
  for(var i = 0; i < rows.length; i++){
    if(!rows[i]) continue;
    h += '<tr><td class="k">' + esc(rows[i][0]) + '</td><td>' + esc(rows[i][1]) + '</td></tr>';
  }
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
function verLine(v){ return v ? (fmt(v.firmware) + (v.build ? ' (build ' + v.build + ')' : '')) : '-'; }

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
  return '<div class="infobox"><h2>Robot</h2>' + table(rows) +
    '<div class="muted">status ' + ago(r.updatedStatus) + ' · position ' + ago(r.updatedPosition) + '</div></div>';
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
  return '<div class="infobox"><h2>Base station</h2>' + table(rows) +
    '<div class="muted">status ' + ago(b.updatedStatus) + '</div></div>';
}
`;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = WebStatusProcessor;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
