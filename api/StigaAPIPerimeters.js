// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { formatStruct } = require('./StigaAPIUtilitiesFormat');
const { protobufDecode } = require('./StigaAPIUtilitiesProtobuf');
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
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIPerimeter {
    constructor(zoneData, index) {
        this.data = zoneData;
        this.index = index;
        this.name = undefined;
        this.path = undefined;
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

    _parseData() {
        const preview = this.perimeterData?.attributes?.preview;
        const geometry = _decodePerimeterGeometry(this.perimeterData);
        const build = (elements, kind) =>
            (elements ?? []).map((element, index) => {
                const perimeter = new StigaAPIPerimeter(element, index);
                const geo = geometry[kind]?.[perimeter.getId()];
                if (geo) {
                    perimeter.name = geo.name;
                    perimeter.path = geo.path;
                }
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
