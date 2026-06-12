// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { formatStruct } = require('./StigaAPIUtilitiesFormat');
const { protobufDecode, protobufScan, protobufField, protobufSetFields } = require('./StigaAPIUtilitiesProtobuf');
const { decodePerimeterZoneSettings, encodePerimeterZoneSettings } = require('./StigaAPIElements');
const StigaAPIComponent = require('./StigaAPIComponent');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Perimeter point geometry lives in attributes.data_points.data — a protobuf blob, separate
// from the attributes.preview metadata. Layout (reverse engineered):
//   field 1 = zones, field 2 = paths, field 3 = obstacles.
//   each entry: [1]=id, [2]=points[], [15]=name; anchor doubles at [16] (zone) / [8] (path) / [6] (obstacle).
//   anchor = { 1: eastMetres, 2: northMetres } ENU offset from referencePosition.
//   point  = { 1: x, 2: y } zigzag-encoded signed centimetres, absolute offset from the anchor
//            (zero fields omitted; first point {} = the anchor itself).
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function _zigzag(n) {
    return (n >>> 1) ^ -(n & 1);
}
function _decodePerimeterName(value) {
    // protobufDecode returns plain text for ASCII names, but a hex string for names with
    // non-ASCII (e.g. Swedish) characters — decode those back to UTF-8.
    if (typeof value !== 'string') return value;
    if (/^(?:[\da-f]{2})+$/i.test(value)) return Buffer.from(value, 'hex').toString('utf8');
    return value;
}
function _decodePerimeterGeometry(perimeterData) {
    const bytes = perimeterData?.attributes?.data_points?.data;
    const ref = perimeterData?.attributes?.preview?.referencePosition;
    if (!Array.isArray(bytes) || bytes.length === 0 || !ref?.lat || !ref?.lng) return {};
    let decoded;
    try {
        decoded = protobufDecode(Buffer.from(bytes));
    } catch {
        return {};
    }
    const mPerDegLat = 111320,
        mPerDegLon = 111320 * Math.cos((ref.lat * Math.PI) / 180);
    const toPath = (entry) => {
        const anchor = entry[16] || entry[8] || entry[6];
        if (!anchor?.[1] || !anchor?.[2]) return [];
        const anchorE = Buffer.from(anchor[1], 'hex').readDoubleLE(0),
            anchorN = Buffer.from(anchor[2], 'hex').readDoubleLE(0);
        let points = [];
        if (Array.isArray(entry[2])) points = entry[2];
        else if (entry[2] !== undefined) points = [entry[2]];
        return points.map((point) => {
            const p = point && typeof point === 'object' ? point : {};
            const eastM = anchorE + _zigzag(p[1] || 0) / 100,
                northM = anchorN + _zigzag(p[2] || 0) / 100;
            return { latitude: ref.lat + northM / mPerDegLat, longitude: ref.lng + eastM / mPerDegLon };
        });
    };
    const byId = (entries) => {
        const map = {};
        (Array.isArray(entries) ? entries : []).forEach((entry) => {
            map[entry[1]] = { name: _decodePerimeterName(entry[15]), path: toPath(entry) };
        });
        return map;
    };
    // Paths (decoded[2]) are inter-zone connector routes — open polylines (not polygons), with
    // [6]/[7] holding source/target zone ids. We surface them as a separate collection so the
    // UI can render them differently (e.g. muted grey lines, not filled shapes).
    const paths = (Array.isArray(decoded[2]) ? decoded[2] : []).map((entry) => ({
        id: entry[1],
        fromZone: entry[6],
        toZone: entry[7],
        path: toPath(entry),
    }));
    return { zones: byId(decoded[1]), obstacles: byId(decoded[3]), paths };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Per-zone settings share the data_points blob with the geometry (field 1 = zones, one sub-message
// per zone). Decode just the settings, keyed by zone id.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function _decodeZoneSettingsMap(perimeterData) {
    const bytes = perimeterData?.attributes?.data_points?.data;
    if (!Array.isArray(bytes) || bytes.length === 0) return {};
    let decoded;
    try {
        decoded = protobufDecode(Buffer.from(bytes));
    } catch {
        return {};
    }
    let zones = [];
    if (Array.isArray(decoded[1])) zones = decoded[1];
    else if (decoded[1] !== undefined) zones = [decoded[1]];
    const map = {};
    for (const entry of zones) {
        const settings = decodePerimeterZoneSettings(entry);
        if (settings?.id !== undefined) map[settings.id] = settings;
    }
    return map;
}

// Wire-level patch of one zone's settings inside a data_points buffer. Every other byte (all the
// geometry) is copied through verbatim — see protobufSetFields. Returns a new Buffer; throws if the
// zone id is not present.
function _patchZoneSettingsBytes(dataPointsBuf, zoneId, patches) {
    const parts = [];
    let found = false;
    for (const f of protobufScan(dataPointsBuf)) {
        if (f.field === 1 && !found) {
            const sub = Buffer.from(dataPointsBuf.subarray(f.valStart, f.valEnd));
            let id;
            try {
                id = protobufDecode(sub)[1];
            } catch {
                id = undefined;
            }
            if (id === zoneId) {
                parts.push(protobufField(1, 2, protobufSetFields(sub, patches)));
                found = true;
                continue;
            }
        }
        parts.push(dataPointsBuf.subarray(f.tagStart, f.valEnd));
    }
    if (!found) throw new Error(`zone ${zoneId} not found in perimeter`);
    return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIPerimeter {
    constructor(zoneData, index) {
        this.data = zoneData;
        this.index = index;
        this.name = undefined;
        this.path = undefined;
        this.settings = undefined; // per-zone settings (zones only), decoded from data_points
    }

    // Per-zone settings { id, name, cuttingHeight(mm), cuttingMode, priority, customAngleActive,
    // customAngle(deg), borderCut }. Only populated for zones (not obstacles/paths).
    getSettings() {
        return this.settings;
    }

    getId() {
        return this.data?.id || this.index + 1;
    }

    getArea() {
        return this.data?.m2Area || 0;
    }

    getNumPoints() {
        return this.data?.numPoints || 0;
    }

    getName() {
        return this.name;
    }

    // polygon outline as [{ latitude, longitude }] — empty until geometry is parsed
    getPath() {
        return this.path ?? [];
    }

    toString() {
        return formatStruct({ id: this.getId(), name: this.getName(), area: this.getArea().toFixed(1), points: this.getNumPoints() }, 'perimeter', { area: { units: 'm2' } });
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// Open polyline connector between two zones. Not driven by cloud preview metadata — paths only
// exist in the data_points geometry blob, so we build them straight from the decoded entries.
class StigaAPIPath {
    constructor(data, index) {
        this.data = data;
        this.index = index;
    }
    getId() {
        return this.data?.id ?? this.index + 1;
    }
    getFromZone() {
        return this.data?.fromZone;
    }
    getToZone() {
        return this.data?.toZone;
    }
    getPath() {
        return this.data?.path ?? [];
    }
    toString() {
        return formatStruct({ id: this.getId(), from: this.getFromZone(), to: this.getToZone(), points: this.getPath().length }, 'path');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIPerimeters extends StigaAPIComponent {
    constructor(serverConnection, device, options = {}) {
        super(options);
        this.server = serverConnection;
        this.device = device;
        this.perimeterData = undefined;
        this.zones = [];
        this.closedZones = []; // zones that were defined but are currently closed in the app
        this.obstacles = []; // permanent obstacles
        this.tempObstacles = []; // temporary obstacles (auto-expiring)
        this.connectPaths = []; // inter-zone connector polylines
        this.dockingPaths = []; // approach polylines into the docking station
        this.pickupPoints = []; // singular pickup point locations (geometry layout TBD when sample data appears)
        this.zoneSettings = {}; // per-zone settings keyed by zone id (decoded from data_points)
    }

    async load() {
        if (!this.device) {
            this.display.error('perimeters: failed to load: no device provided');
            return false;
        }

        const device_uuid = (await this.device.getUuid()).value,
            base_uuid = (await this.device.getBaseUuid()).value;
        if (!device_uuid || !base_uuid) {
            this.display.error('perimeters: failed to load: missing device or base UUID');
            return false;
        }

        try {
            const response = await this.server.get('/api/perimeters', { base_uuid, device_uuid });
            if (response.ok) {
                this.perimeterData = (await response.json()).data;
                this._parseData();
                return true;
            }
        } catch (e) {
            this.display.error('perimeters: failed to load:', e);
        }
        return false;
    }

    // Raw cloud resource accessors for lossless backup/restore (stiga-command --format native --save/--load).
    // getRawData() is the exact { id, type, attributes } object load() received; setRawData() installs one to
    // be PATCHed back by write() (which re-stamps timestamp/checksum). No parsing/curation, so nothing is lost.
    getRawData() {
        return this.perimeterData;
    }
    setRawData(data) {
        this.perimeterData = data;
    }

    // Write the currently-loaded perimeter back to the cloud. Mutate the geometry first (via
    // this.perimeterData) then call write(). NOTE: this updates the CLOUD copy only — the robot owns
    // the authoritative map and will re-publish its own copy unless it is told to pull this one with a
    // CLOUDSYNC_DOWNLOAD command over MQTT. Write protocol reverse engineered 2026-06-04, see
    // scripts/stiga-probe-perimeter-write.js. Returns true on success (HTTP 204).
    async write() {
        if (!this.perimeterData?.attributes) {
            this.display.error('perimeters: failed to write: nothing loaded');
            return false;
        }
        const { uuid } = this.perimeterData.attributes;
        if (!uuid) {
            this.display.error('perimeters: failed to write: missing uuid');
            return false;
        }

        // Normalise the record so a write looks like the robot's own. Refresh timestamp to now (so the write
        // supersedes the current record), but set checksum to the data_points geometry blob's BYTE LENGTH, not
        // the timestamp — reverse-engineered 2026-06-12 from a robot-written record whose preview AND
        // data_points both carried checksum "7134" == data_points.data.length (an epoch-ms cannot equal that).
        // Both preview and data_points share that one checksum. Drop null-valued top-level fields the write
        // schema rejects (e.g. base_position). Body envelope is { data: <attributes> }.
        // eslint-disable-next-line unicorn/prefer-structured-clone
        const attributes = JSON.parse(JSON.stringify(this.perimeterData.attributes));
        const now = Date.now();
        const checksum = String(attributes.data_points?.data?.length ?? 0);
        const stamp = (obj) => {
            if (obj) {
                obj.timestamp = now;
                obj.checksum = checksum;
            }
        };
        stamp(attributes.preview);
        stamp(attributes.data_points);
        for (const key of Object.keys(attributes)) if (attributes[key] === null) delete attributes[key];

        try {
            // Spoof the robot's user-agent: the cloud stamps data_points.user_agent from this header, so without
            // it our write is fingerprinted "node" instead of "Stig-A.<mac>".
            const response = await this.server.patch(`/api/perimeters/${uuid}`, { data: attributes }, { 'User-Agent': `Stig-A.${this.device.getMacAddress()}` });
            if (response.ok) {
                this.perimeterData.attributes = attributes;
                this._parseData();
                return true;
            }
        } catch (e) {
            this.display.error('perimeters: failed to write:', e);
        }
        return false;
    }

    _parseData() {
        const preview = this.perimeterData?.attributes?.preview;
        const geometry = _decodePerimeterGeometry(this.perimeterData);
        this.zoneSettings = _decodeZoneSettingsMap(this.perimeterData); // keyed by zone id
        const build = (elements, kind) =>
            (elements ?? []).map((element, index) => {
                const perimeter = new StigaAPIPerimeter(element, index);
                const geo = geometry[kind]?.[perimeter.getId()];
                if (geo) {
                    perimeter.name = geo.name;
                    perimeter.path = geo.path;
                }
                if (kind === 'zones') perimeter.settings = this.zoneSettings[perimeter.getId()];
                return perimeter;
            });
        // The geometry blob's field 1 (zones) and field 3 (obstacles) hold BOTH the regular and
        // the "special" variants — closedZones live alongside zones, tempObstacles alongside
        // obstacles, distinguished only by their ID in the preview metadata. We just look each
        // ID up in the shared geometry map regardless of category.
        this.zones = build(preview?.zones?.elements, 'zones');
        this.closedZones = build(preview?.closedZones?.elements, 'zones');
        this.obstacles = build(preview?.obstacles?.elements, 'obstacles');
        this.tempObstacles = build(preview?.tempObstacles?.elements, 'obstacles');

        // Paths: geometry field 2 carries both connect and docking polylines mixed together.
        // Split by preview membership so the UI can render them differently.
        const connectIds = new Set((preview?.connectPaths?.elements ?? []).map((e) => e.id));
        const dockingIds = new Set((preview?.dockingPaths?.elements ?? []).map((e) => e.id));
        const allPaths = (geometry.paths ?? []).map((entry, i) => new StigaAPIPath(entry, i));
        this.connectPaths = allPaths.filter((p) => connectIds.has(p.getId()));
        this.dockingPaths = allPaths.filter((p) => dockingIds.has(p.getId()));

        // Pickup points: preview metadata available, but geometry-blob layout not yet reverse
        // engineered (no sample data with non-empty pickupPoints). Leave the collection empty
        // for now so consumers can see them when they appear — the preview shape per element
        // is unknown beyond {id, …}; revisit once we encounter a garden that has them.
        this.pickupPoints = [];
    }

    getZones() {
        return this.zones;
    }

    // ----- Per-zone settings (cloud) ---------------------------------------------------------------
    // These are read from / written to the cloud perimeter (data_points), NOT MQTT. load() must have
    // been called first. Settings shape: { id, name, cuttingHeight(mm), cuttingMode, priority,
    // customAngleActive, customAngle(deg), borderCut }.

    // All zones' settings as an array (bulk read).
    getAllZoneSettings() {
        return Object.values(this.zoneSettings);
    }

    // One zone's settings by zone id, or undefined if absent.
    getZoneSettings(zoneId) {
        return this.zoneSettings[zoneId];
    }

    // Change one zone's settings. `settings` is a partial object — only the keys present are changed
    // (e.g. { cuttingHeight: 60, borderCut: true }). See setZoneSettingsBulk for the two-target write
    // semantics and options. Returns { ok, cloud, robot }.
    async setZoneSettings(zoneId, settings, options = {}) {
        return this.setZoneSettingsBulk([{ zone: zoneId, ...settings }], options);
    }

    // Change several zones at once: changes = [{ zone, ...settings }, ...]. A zone settings change has
    // TWO destinations and we write BOTH, in sequence, mirroring the app:
    //   1. cloud  — patch the data_points blob (wire level, geometry untouched) and PATCH it back to
    //               /api/perimeters. This is the persistent/bulk store and the canonical read source.
    //   2. robot  — push each changed zone to the robot over MQTT (CMD_ROBOT cmd 7) for immediate
    //               application. Requires a connected robot connector on this.device.
    // options: { cloud = true, robot = true } to do one side only. Returns { ok, cloud, robot } where
    // cloud/robot are true|false|undefined (undefined = not attempted). ok = every attempted target succeeded.
    async setZoneSettingsBulk(changes, options = {}) {
        const { cloud = true, robot = true } = options;
        const result = { ok: false, cloud: undefined, robot: undefined };
        if (!Array.isArray(changes) || changes.length === 0) {
            this.display.error('perimeters: setZoneSettings: no changes provided');
            return result;
        }
        const data = this.perimeterData?.attributes?.data_points?.data;
        if (!Array.isArray(data) || data.length === 0) {
            this.display.error('perimeters: setZoneSettings: nothing loaded (call load() first)');
            return result;
        }
        // Validate up front, and compute the FULL merged settings per zone (needed for the robot push,
        // which sends the whole record, not just the delta).
        let buffer;
        const merged = [];
        try {
            buffer = Buffer.from(data);
            for (const change of changes) {
                const { zone, ...settings } = change;
                if (zone === undefined) throw new Error('each change must include a zone id');
                const current = this.zoneSettings[zone];
                if (current === undefined) throw new Error(`zone ${zone} not found in perimeter`);
                const patches = encodePerimeterZoneSettings(settings); // validates values
                if (patches.length > 0) buffer = _patchZoneSettingsBytes(buffer, zone, patches);
                merged.push({ ...current, ...settings, zone });
            }
        } catch (e) {
            this.display.error('perimeters: setZoneSettings: failed to encode:', e.message);
            return result;
        }

        // 1. cloud
        if (cloud) {
            this.perimeterData.attributes.data_points.data = [...buffer];
            result.cloud = await this.write(); // re-parses on success, refreshing this.zoneSettings
        }

        // 2. robot (immediate). Best-effort per zone; needs device + connected robot connector.
        if (robot) {
            if (!this.device || typeof this.device.setZoneSettings !== 'function') {
                this.display.error('perimeters: setZoneSettings: no device for robot push');
                result.robot = false;
            } else {
                result.robot = true;
                for (const full of merged) {
                    try {
                        const ack = await this.device.setZoneSettings(full);
                        if (ack === false) result.robot = false;
                    } catch (e) {
                        this.display.error(`perimeters: setZoneSettings: robot push failed for zone ${full.zone}:`, e.message);
                        result.robot = false;
                    }
                }
            }
        }

        result.ok = (result.cloud ?? true) && (result.robot ?? true);
        return result;
    }

    getClosedZones() {
        return this.closedZones;
    }

    getObstacles() {
        return this.obstacles;
    }

    getTempObstacles() {
        return this.tempObstacles;
    }

    getConnectPaths() {
        return this.connectPaths;
    }

    getDockingPaths() {
        return this.dockingPaths;
    }

    getPickupPoints() {
        return this.pickupPoints;
    }

    getTotalArea() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.m2Area || 0;
    }

    getZonesArea() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.zones?.m2Area || 0;
    }

    getObstaclesArea() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.obstacles?.m2Area || 0;
    }

    getZoneCount() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.zones?.num || 0;
    }

    getObstacleCount() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.obstacles?.num || 0;
    }

    getTotalPoints() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.numPoints || 0;
    }

    getChecksum() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.checksum || undefined;
    }

    getTimestamp() {
        const preview = this.perimeterData?.attributes?.preview;
        return preview?.timestamp ? new Date(preview.timestamp) : undefined;
    }

    // The cloud resource URL for this perimeter — the value that goes in a CLOUDSYNC_DOWNLOAD command
    // so the robot can fetch it. Undefined until loaded.
    getResourceUrl() {
        const uuid = this.perimeterData?.attributes?.uuid;
        return uuid ? `${this.server.getBaseUrl()}/api/perimeters/${uuid}` : undefined;
    }

    getReferencePosition() {
        const preview = this.perimeterData?.attributes?.preview;
        const pos = preview?.referencePosition;
        return pos?.lat && pos?.lng ? { latitude: pos.lat, longitude: pos.lng } : undefined;
    }

    toString() {
        return formatStruct({ area: this.getTotalArea().toFixed(1), zones: this.getZoneCount(), obstacles: this.getObstacleCount() }, 'perimeter', { area: { units: 'm2' } });
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIPerimeters;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
