// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { protobufEncode, protobufField } = require('./StigaAPIUtilitiesProtobuf');
const { formatStruct, formatNetworkId } = require('./StigaAPIUtilitiesFormat');

function toInt32(value) {
    if (value > 0x7fffffff) return value - 0x100000000;
    return value;
}
function hexToDouble(hexStr) {
    return Buffer.from(hexStr, 'hex').readDoubleLE(0);
}

function calculateLocationFromOffset(position, [xOffsetM, yOffsetM]) {
    const latitudeMPerDegree = 111320,
        longitudeMPerDegree = 111320 * (position?.latitude ? Math.cos((position.latitude * Math.PI) / 180) : 1);
    const latitude = position?.latitude === undefined ? undefined : position.latitude + yOffsetM / latitudeMPerDegree;
    const longitude = position?.longitude === undefined ? undefined : position.longitude + xOffsetM / longitudeMPerDegree;
    return { latitude, longitude };
}

function decodeIndex(offset, table, allowUndefined = false) {
    // eslint-disable-next-line sonarjs/no-nested-conditional
    return offset === undefined ? undefined : (table[offset] ?? (allowUndefined ? undefined : `UNKNOWN(0x${offset.toString(16).padStart(2, '0').toUpperCase()})`));
}

function formatBoolean(value) {
    return value ? 'yes' : 'no';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function encodeMessageAck(responseCode = 0) {
    return Buffer.from([responseCode]);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function _decodeVersionInfo(hex) {
    if (!hex) return undefined;
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16));
    return bytes.join('.');
}

function decodeVersion(decoded) {
    return decoded
        ? upgradeVersion({
              hardware: _decodeVersionInfo(decoded[1]),
              firmware: _decodeVersionInfo(decoded[2]),
              build: _decodeVersionInfo(decoded[3]),
              modem: decoded[5],
              localization: decoded[6],
          })
        : undefined;
}
function formatVersion(version, options = {}) {
    return formatStruct(version, 'version', options);
}
function upgradeVersion(version) {
    version.toString = (options = {}) => formatVersion(version, options);
    return version;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// **GPS Parameters**:
// **CNR AVG**: Measures the quality of the GPS signal. A higher value indicates good reception.
// **DOP**: Represents the precision of the GPS signal. A lower value means the position is more accurate.
// **Number of Satellites**: The robot needs to connect to an adequate number of satellites to ensure reliable positioning.
// **Svin**: Indicates the positioning accuracy of the single antenna. A lower value corresponds to higher accuracy in positioning. (Worst >2  ; Good 0.5)

// decoded[3]/[4] are an RTK accuracy/correction figure in centimetres (how far the
// RTK-corrected fix sits from the raw GNSS fix) — NOT the robot's position offset from
// the base. Verified 2026-05-22: the value stays ~constant (~44 cm) regardless of where
// the robot actually is, so no absolute lat/lon is derived from it. The robot's actual
// location comes only from LOG/ROBOT_POSITION (decodeRobotPosition).
function _decodeLocationStatus(latitudeOffset, longitudeOffset) {
    const offsetLatitudeCm = hexToDouble(latitudeOffset),
        offsetLongitudeCm = hexToDouble(longitudeOffset);
    // offsetDegrees is a math angle (0°=East, anticlockwise); offsetCompass is a compass bearing (0°=North, clockwise).
    const offsetDegrees = (Math.atan2(offsetLatitudeCm, offsetLongitudeCm) * 180) / Math.PI,
        offsetCompass = (90 - offsetDegrees + 360) % 360;
    return {
        offsetLatitudeCm,
        offsetLongitudeCm,
        offsetDistance: Math.hypot(offsetLatitudeCm, offsetLongitudeCm),
        offsetDegrees,
        offsetCompass,
    };
}
function decodeLocationStatus(decoded) {
    return decoded?.[3] || decoded?.[4]
        ? upgradeLocationStatus({
              // correlates with now low satellite count
              // 1 is kind of < 20 satellites, 2 is < 15
              // lowest satellite count I have seen is 8 (still marked as 2)
              coverage: decoded[1] || 0, // DOP? https://www.tersus-gnss.com/tech_blog/what-is-dop-in-gnss
              satellites: decoded[2],
              ..._decodeLocationStatus(decoded[3], decoded[4]),
              rtkQuality: decoded[5], // probably Svin
          })
        : undefined;
}
function formatLocationStatus(location) {
    return formatStruct(location, 'location', { rtkQuality: { units: '%' }, coverage: (v) => ['GOOD', 'POOR', 'BAD', 'WORSE'][v] });
}
function upgradeLocationStatus(location) {
    location.toString = () => formatLocationStatus(location);
    return location;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// **2G/4G Parameters**:
// **RSSI**: Measures the signal strength of the 2G network. A higher value means better signal quality. (Worst -110 [dBm]; Best -50 [dBm])
// **RSRP**: Measures the signal strength in the LTE (4G) network. A higher value indicates good signal strength.(Worst -110 [dBm]; Best -50 [dBm])
// **RSRQ**: Indicates the quality of the LTE signal. Higher values reflect a better connection.(Worst -20 [dBm]; Best -5 [dBm])

function decodeNetworkStatus(decoded) {
    const status = decoded?.[3];
    return status
        ? upgradeNetworkStatus({
              network: status[4],
              type: status[5],
              band: status[6],
              rssi: toInt32(status[7]),
              rsrp: toInt32(status[10]),
              sq: toInt32(status[11]),
              rsrq: toInt32(status[12]),
          })
        : undefined;
}
function formatNetworkStatus(network) {
    return formatStruct(network, 'network', { network: formatNetworkId, type: { quote: true }, rssi: { units: 'dBm' }, rsrp: { units: 'dBm' }, rsrq: { units: 'dB' }, sq: { units: '%' } });
}
function upgradeNetworkStatus(network) {
    network.toString = () => formatNetworkStatus(network);
    return network;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const ROBOT_MESSAGE_TOPICS = {
    CMD_ROBOT: (mac) => `${mac}/CMD_ROBOT`,
    CMD_ROBOT_ACK: (mac) => `CMD_ROBOT_ACK/${mac}`,
    LOG: (mac) => `${mac}/LOG/+`,
    JSON_NOTIFICATION: (mac) => `${mac}/JSON_NOTIFICATION`,
};

function buildRobotMessageTopics(robotMac, includeAcks) {
    if (!robotMac) return [];
    const topics = Object.values(ROBOT_MESSAGE_TOPICS).map((func) => func(robotMac));
    if (includeAcks) ['STATUS', 'VERSION', 'SETTINGS', 'SCHEDULING_SETTINGS'].forEach((log) => topics.push(`${robotMac}/LOG/${log}/ACK`));
    return topics;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const ROBOT_COMMAND_TOPICS = {
    VERSION: '/LOG/VERSION',
    STATUS: '/LOG/STATUS',
    SETTINGS: '/LOG/SETTINGS',
    SCHEDULING_SETTINGS: '/LOG/SCHEDULING_SETTINGS',
    ROBOT_POSITION: '/LOG/ROBOT_POSITION',
};
const ROBOT_COMMAND_TYPES = {
    0: 'STOP',
    1: 'START',
    //  2:
    4: 'GO_HOME',
    7: 'ZONE_SETTINGS_UPDATE',
    9: 'BOOT',
    17: 'SETTINGS_REQUEST',
    18: 'SETTINGS_UPDATE',
    19: 'SCHEDULING_SETTINGS_REQUEST',
    20: 'SCHEDULING_SETTINGS_UPDATE',
    21: 'VERSION_REQUEST',
    22: 'POSITION_REQUEST',
    25: 'CALIBRATE_DOCKING',
    26: 'CALIBRATE_BLADES',
    28: 'STATUS_REQUEST',
    // 31 and 32 carry an identical payload [2] = { 1: "Bearer <jwt>", 2: cloud resource URL } and both
    // make the robot DOWNLOAD/fetch that resource from the cloud and apply it (NOT an upload — the robot
    // re-publishing its own copy to the cloud afterwards is separate autonomous behaviour). The observed
    // difference is the trigger: 31 fires automatically when a perimeter edit is saved (robot adopts the
    // app's new map; the app's "Download data failed" is this fetch failing); 32 fires on a manual
    // "sync now" from the app. Exact functional difference beyond trigger is still unconfirmed. (2026-06-04)
    31: 'CLOUDSYNC_DOWNLOAD',
    32: 'CLOUDSYNC_REQUEST',
    37: 'RESET_ERROR',
    38: 'FORCE_CUT',
    40: 'GO_AWAY',
    47: 'ZONE_ORDER_UPDATE',
    51: 'FORCE_BORDER_CUT',
};
const ROBOT_COMMAND_IDS = Object.fromEntries(Object.entries(ROBOT_COMMAND_TYPES).map(([key, value]) => [value, Number.parseInt(key)]));

function encodeRobotCommand(type, fields = undefined) {
    return ROBOT_COMMAND_TYPES[type]
        ? protobufEncode({
              1: type,
              2: fields,
              3: type, // echo
          })
        : undefined;
}

function decodeRobotCommandType(decoded, allowUndefined = false) {
    return decodeIndex(decoded || 0, ROBOT_COMMAND_TYPES, allowUndefined);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const ROBOT_COMMAND_RESULT_CODES = {
    1: 'OK',
};
function decodeRobotCommandAckResult(decoded, allowUndefined = false) {
    return decodeIndex(decoded, ROBOT_COMMAND_RESULT_CODES, allowUndefined);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function encodeRobotStatusRequestTypes(encoded) {
    const types = { battery: 1, mowing: 2, location: 3, network: 4 };
    return Object.entries(types).reduce((r, [type, index]) => (encoded[type] ? { ...r, [index]: 1 } : r), {});
}

function decodeRobotStatusRequestTypes(decoded) {
    return decoded
        ? {
              battery: decoded[1],
              mowing: decoded[2],
              location: decoded[3],
              network: decoded[4],
          }
        : undefined;
}
function formatRobotStatusRequestTypes(statusTypes) {
    return formatStruct(statusTypes, 'statusTypes');
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line unicorn/prefer-native-coercion-functions
function decodeRobotStatusValid(decoded) {
    return Boolean(decoded);
}
function formatRobotStatusValid(statusValid) {
    return formatBoolean(statusValid);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line unicorn/prefer-native-coercion-functions
function decodeRobotStatusFlag(decoded) {
    return Boolean(decoded);
}
function formatRobotStatusFlag(statusFlag) {
    return formatBoolean(statusFlag);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const ROBOT_STATUS_TYPES = {
    0: 'WAITING_FOR_COMMAND',
    1: 'MOWING',
    2: 'GOING_HOME',
    3: 'CHARGING',
    4: 'DOCKED',
    5: 'UPDATING',
    6: 'BLOCKED',
    8: 'LID_OPEN',
    13: 'GOING_HOME', // ? duplicate
    18: 'CALIBRATION',
    20: 'BLADES_CALIBRATION',
    // 24: 'UNKNOWN_24',
    25: 'DOCKING_CALIBRATION',
    27: 'STORING_DATA',
    28: 'PLANNING_ONGOING',
    29: 'REACHING_FIRST_POINT',
    30: 'NAVIGATING_TO_AREA',
    32: 'CUTTING_BORDER',
    252: 'STARTUP_REQUIRED',
    255: 'ERROR',
};
function decodeRobotStatusType(decoded, allowUndefined = false) {
    return decodeIndex(decoded || 0, ROBOT_STATUS_TYPES, allowUndefined);
}
function formatRobotStatusType(statusType) {
    return statusType ?? '-';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// Human-readable mapping for the (code1, code2) tuple that the robot emits as field 4 of its
// status protobuf. These are NOT always errors in the user-facing sense — the official app
// surfaces them as transient state ("GPS searching", "Navigation initialising", …) even when
// the parent status type is ERROR (255). When we have a mapping we prefer that string; when we
// don't we fall back to the raw codes so research can continue.
//
// Historical observations (not all confirmed; some may be context-dependent):
//   2,18  leaving dock / reference station initiating
//   2,20  out of perimeter
//   2,22  blocked / lid sensor / stuck / trapped
const ROBOT_STATUS_ERROR_MESSAGES = {
    // Confirmed against the official app. Stored in ENUM_STYLE so the on-the-wire shape
    // matches ROBOT_STATUS_TYPES / ROBOT_STATUS_INFO_CODES — the webstatus UI softens these
    // for display (preserving known acronyms like GPS). The accompanying StatusInfo code
    // (e.g. TRAPPED, LID_SENSOR) gives the specific cause and is shown alongside as the
    // status detail.
    '2,18': 'NAVIGATION_INITIALISING',
    '2,20': 'GPS_SEARCHING',
    '2,22': 'STUCK',
};
// NB: there is no reliable "user can reset this error" predicate yet. RESET_ERROR (CMD_ROBOT 37) clears a
// recoverable fault (confirmed 2026-06-05 on a STUCK/2,22), but the same STUCK code also occurs when the
// robot is stuck in a way the user cannot reset, and state [3]=255 additionally covers transient,
// self-resolving states (NAVIGATION_INITIALISING 2,18 / GPS_SEARCHING 2,20). So neither the state nor the
// [4] code alone gates the app's "reset error" button — the real discriminator is still unknown and needs
// a non-resettable-stuck status capture to diff against the resettable one. See [[reset-error-command]].

function decodeRobotStatusError(decoded) {
    if (!decoded) return undefined;
    const code1 = decoded[1];
    const code2 = decoded[2];
    const message = ROBOT_STATUS_ERROR_MESSAGES[`${code1},${code2}`];
    return upgradeRobotStatusError({ code1, code2, message });
}
function formatRobotStatusError(statusError) {
    if (!statusError) return '-';
    if (statusError.message) return statusError.message;
    return formatStruct({ code1: statusError.code1, code2: statusError.code2 }, 'statusError');
}
function upgradeRobotStatusError(statusError) {
    statusError.toString = () => formatRobotStatusError(statusError);
    return statusError;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const ROBOT_STATUS_INFO_CODES = {
    0x0064: 'LOW_BATTERY', // 3/1/1 (100)
    0x00da: 'BLADE_MOTOR_TROUBLE', // 2/3/1
    0x0191: 'BLOCKED', // 3/1/1 (401)
    // 0x0195: 'UNKNOWN_0195', // 3/1/1 (405) [when BLOCKED]
    // 0x019e: 'UNKNOWN_019E', // 3/1/1 (414)
    0x01a2: 'LID_SENSOR', // 2/1/1 (418)
    0x01a9: 'RAIN_SENSOR', // 3/1/1 (425)
    0x01b0: 'LIFT_SENSOR', // 2/1/1 (432)
    0x01b1: 'BUMP_SENSOR', // 2/1/1 (433)
    0x01b2: 'SLOPE_SENSOR', // 2/1/1 (434)
    0x01b3: 'TRAPPED', // 2/1/1 (435)
    0x01fa: 'DOCKING_ERROR', // 2/1/1 (506) critical battery level?
    0x0389: 'WHEEL_TROUBLE', // 3/1/1 (905) [when BLOCKED]
    0x03ef: 'SURFACE_TOO_SLIPPERY', // 3/1/1 and 2/1/1
    0x03f0: 'OUT_OF_PERIMETER', // 1/1/1 (1008)
};

function decodeRobotStatusInfo(decoded, allowUndefined = false) {
    return decoded
        ? upgradeRobotStatusInfo({
              code: decodeIndex(decoded[1], ROBOT_STATUS_INFO_CODES, allowUndefined),
              code2: decoded[2],
              code3: decoded[3],
              code4: decoded[4],
          })
        : undefined;
}
function formatRobotStatusInfo(statusInfo) {
    // Always return a string — callers do `.replaceAll('-', '')`. Empty -> '-' matches the
    // formatStruct(undefined) behaviour the previous version of this function relied on.
    if (!statusInfo) return '-';
    // When the primary code resolved to a known label (e.g. TRAPPED, LID_SENSOR) we just show
    // that — the trailing code2/code3/code4 fields are diagnostic noise the app doesn't surface.
    // Only fall back to the full struct dump if the code is the UNKNOWN(0xNN) sentinel, so we
    // can still see the raw fields when reverse engineering a new condition.
    if (statusInfo.code && !statusInfo.code.startsWith('UNKNOWN(')) return statusInfo.code;
    return formatStruct(statusInfo, 'statusInfo', { code: { nokey: true } });
}
function upgradeRobotStatusInfo(statusInfo) {
    statusInfo.toString = () => formatRobotStatusInfo(statusInfo);
    return statusInfo;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line unicorn/prefer-native-coercion-functions
function decodeRobotStatusDocking(decoded) {
    return Boolean(decoded);
}
function formatRobotStatusDocking(statusDocking) {
    return formatBoolean(statusDocking);
}

// Status [9] — present while the robot runs CALIBRATE_DOCKING (status type 25 = DOCKING_CALIBRATION).
// The value's meaning is unknown (only sample seen is 1; possibly a phase/step or a simple flag); kept
// as a raw number and surfaced as dockingCalibration so it is captured rather than dropped as unknown.
function decodeRobotDockingCalibration(decoded) {
    return decoded === undefined ? undefined : Number(decoded);
}
function formatRobotDockingCalibration(dockingCalibration) {
    return dockingCalibration === undefined ? '-' : String(dockingCalibration);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function decodeRobotMowingStatus(decoded, location) {
    if (!decoded) return undefined;
    return upgradeRobotMowingStatus({
        zone: decoded[1],
        zoneCompleted: decoded[2],
        gardenCompleted: decoded[3],
        target: decodeRobotMowingTarget(decoded[4], location),
    });
}
// [18][4] — the mowing PLAN + progress (reverse engineered; full field table in api/status.txt).
// Set once at (re)plan time and constant for the whole run: [5] = anchor/reference point ({1:east,
// 2:north} doubles on a 0.5 m grid — NOT a live target and NOT where the robot starts), [6] = cutting
// direction (radians, rotates each run), [2] = 4-state orientation class, [4] = an opaque per-plan
// quantity (NOT the zone work-total). [1] is the only live value: cumulative work/length mowed, whose
// per-zone ceiling approximates the zone's total work. [3]/[7] = constant-when-present markers.
// omitted == 0. Only surfaced when an anchor [5] is present. (Field name `target` kept for now.)
function decodeRobotMowingTarget(decoded, location) {
    if (!decoded || decoded[5] === undefined) return undefined;
    const east = hexToDouble(decoded[5][1] || '0000000000000000'),
        north = hexToDouble(decoded[5][2] || '0000000000000000');
    const headingDegrees = ((decoded[6] || 0) * 180) / Math.PI;
    return upgradeRobotMowingTarget({
        east,
        north,
        ...calculateLocationFromOffset(location, [east, north]),
        headingDegrees,
        headingCompass: (450 - headingDegrees) % 360,
        // raw [18][4] counters/markers, surfaced for correlation eyeballing (meaning TBD; omitted == 0)
        raw: { 1: decoded[1] || 0, 2: decoded[2] || 0, 3: decoded[3] || 0, 4: decoded[4] || 0, 7: decoded[7] || 0 },
    });
}
function formatRobotMowingStatus(mowing) {
    if (!mowing) return undefined;
    return (
        formatStruct({ zone: mowing.zone, zoneCompleted: mowing.zoneCompleted, gardenCompleted: mowing.gardenCompleted }, 'mowing', { zoneCompleted: { units: '%' }, gardenCompleted: { units: '%' } }) +
        (mowing.target ? ', ' + formatRobotMowingTarget(mowing.target) : '')
    );
}
function formatRobotMowingTarget(target) {
    const where = target.latitude !== undefined && target.longitude !== undefined ? `${target.latitude.toFixed(7)},${target.longitude.toFixed(7)}` : `${target.east.toFixed(1)},${target.north.toFixed(1)}m`;
    return `target=${where} heading=${Math.round(target.headingCompass)}°`;
}
function upgradeRobotMowingStatus(mowing) {
    mowing.toString = () => formatRobotMowingStatus(mowing);
    return mowing;
}
function upgradeRobotMowingTarget(target) {
    target.toString = () => formatRobotMowingTarget(target);
    return target;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function decodeRobotBatteryStatus(decoded) {
    return decoded ? upgradeRobotBatteryStatus({ capacity: decoded[1], charge: decoded[2] || 0 }) : undefined;
}
function formatRobotBatteryStatus(battery) {
    return formatStruct(battery, 'battery', { capacity: { units: 'mAh' }, charge: { units: '%' } });
}
function upgradeRobotBatteryStatus(battery) {
    battery.toString = () => formatRobotBatteryStatus(battery);
    return battery;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function encodeRobotCloudSync({ auth, url }) {
    // inverse of decodeRobotCloudSync: field [1] = auth ("Bearer <jwt>"), field [2] = resource url
    return protobufEncode({ 1: auth, 2: url });
}
function decodeRobotCloudSync(decoded) {
    return decoded
        ? upgradeRobotCloudSync({
              url: decoded[2],
              auth: decoded[1],
          })
        : undefined;
}
function formatRobotCloudSync(cloudSync) {
    return formatStruct(cloudSync, 'cloudSync', { auth: { process: (v) => v.slice(16) + '...' } });
}
function upgradeRobotCloudSync(cloudSync) {
    cloudSync.toString = () => formatRobotCloudSync(cloudSync);
    return cloudSync;
}

function encodeRobotForceCut(zone) {
    // Shared by FORCE_CUT (38) and FORCE_BORDER_CUT (51): field [2] = single-byte zone number,
    // length-delimited (e.g. zone 3 -> 12 01 03).
    return Buffer.from([zone]);
}
function decodeRobotForceCut(decoded) {
    if (decoded === undefined) return undefined;
    // protobufDecode renders the 1-byte length-delimited field as a hex string ("02", "03", ...)
    if (typeof decoded === 'string') return Number.parseInt(decoded, 16);
    if (Buffer.isBuffer(decoded)) return decoded[0];
    return Number(decoded);
}

// GO_AWAY (command 40) — a temporary circular avoid-obstacle pushed to the robot in real time.
// The command payload [2] is, reverse engineered byte-exact (2026-06-04):
//   { 1:3, 3:4 (fixed constants), 6: secondsUntilExpiry, 7: { 1:{1:eastM, 2:northM}, 2: radiusM },
//     8: "Bearer <jwt>", 9: perimeter url }
// The centre east/north and the radius are wire FIXED32 floats (not doubles, not varints) — even an
// integer radius like 2 must be written as a fixed32 float, so we build field 7 by hand.
function _encodeFixed32Float(field, value) {
    const buffer = Buffer.alloc(5);
    buffer[0] = (field << 3) | 5; // wire type 5 = 32-bit
    buffer.writeFloatLE(value, 1);
    return buffer;
}
function encodeRobotGoAway({ east, north, radius, expirySeconds, auth, url }) {
    const point = Buffer.concat([_encodeFixed32Float(1, east), _encodeFixed32Float(2, north)]);
    const placement = Buffer.concat([
        Buffer.from([(1 << 3) | 2, point.length]), // [7][1] = point sub-message (length-delimited, <128 bytes)
        point,
        _encodeFixed32Float(2, radius), // [7][2] = radius
    ]);
    return protobufEncode({ 1: 3, 3: 4, 6: expirySeconds, 7: placement, 8: auth, 9: url });
}
function decodeRobotGoAway(decoded) {
    if (!decoded) return undefined;
    const point = decoded[7]?.[1];
    return upgradeRobotGoAway({
        east: point?.[1],
        north: point?.[2],
        radius: decoded[7]?.[2],
        expirySeconds: decoded[6],
        url: decoded[9],
    });
}
function formatRobotGoAway(goAway) {
    if (!goAway) return undefined;
    return formatStruct(
        {
            centre: `${Number(goAway.east).toFixed(2)},${Number(goAway.north).toFixed(2)}`,
            radius: goAway.radius,
            expiresInDays: goAway.expirySeconds === undefined ? undefined : Number(goAway.expirySeconds / 86400).toFixed(1),
            url: goAway.url,
        },
        'goAway',
        { centre: { units: 'm' }, radius: { units: 'm' }, expiresInDays: { units: 'd' } }
    );
}
function upgradeRobotGoAway(goAway) {
    goAway.toString = () => formatRobotGoAway(goAway);
    return goAway;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// relative to Base location
function decodeRobotPosition(decoded, location) {
    const offsetLongitudeMetres = hexToDouble(decoded[1] === undefined ? 0 : decoded[1]),
        offsetLatitutdeMetres = hexToDouble(decoded[2] === undefined ? 0 : decoded[2]);
    const orientRad = decoded[3] === undefined ? 0 : hexToDouble(decoded[3]);

    // offsetDegrees is a math angle (0°=East, anticlockwise); offsetCompass is a true compass
    // bearing of the robot from the base (0°=North, clockwise).
    const offsetDegrees = (Math.atan2(offsetLatitutdeMetres, offsetLongitudeMetres) * 180) / Math.PI,
        offsetCompass = (90 - offsetDegrees + 360) % 360;
    const orientationDegrees = (orientRad * 180) / Math.PI,
        orientationCompass = (450 - orientationDegrees) % 360;
    return upgradeRobotPosition({
        offsetLatitutdeMetres,
        offsetLongitudeMetres,
        offsetDistanceMetres: Math.hypot(offsetLatitutdeMetres, offsetLongitudeMetres),
        offsetDegrees,
        offsetCompass,
        orientationDegrees,
        orientationCompass,
        ...calculateLocationFromOffset(location, [offsetLongitudeMetres, offsetLatitutdeMetres]),
    });
}
function formatRobotPosition(position) {
    return formatStruct(position, 'position');
}
function upgradeRobotPosition(position) {
    position.toString = () => formatRobotPosition(position);
    return position;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function getCuttingHeightsMap() {
    return { 20: 0, 25: 1, 30: 2, 35: 3, 40: 4, 45: 5, 50: 6, 55: 7, 60: 8 };
}
function getRainDelaysMap() {
    return { 4: 0, 8: 1, 12: 2 };
}
function getCuttingModesMap() {
    return { denseGrid: 0, chessBoard: 1, northSouth: 5, eastWest: 6 };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line sonarjs/cognitive-complexity
function encodeRobotSettings(settings) {
    if (!settings || typeof settings !== 'object') throw new Error('Settings must be an object');

    const encoded = {};
    if (settings.rainSensorEnabled !== undefined) {
        if (typeof settings.rainSensorEnabled !== 'boolean') throw new Error('rainSensorEnabled must be a boolean');
        if (!encoded[1]) encoded[1] = {};
        encoded[1][1] = settings.rainSensorEnabled ? 1 : 0;
    }
    if (settings.rainSensorDelay !== undefined) {
        if (getRainDelaysMap()[settings.rainSensorDelay] === undefined) throw new Error(`rainSensorDelay must be ${Object.keys(getRainDelaysMap()).join(', ')} hours`);
        if (!encoded[1]) encoded[1] = {};
        encoded[1][2] = getRainDelaysMap()[settings.rainSensorDelay];
    }
    if (settings.keyboardLock !== undefined) {
        if (typeof settings.keyboardLock !== 'boolean') throw new Error('keyboardLock must be a boolean');
        encoded[2] = settings.keyboardLock ? 1 : 0;
    }
    if (settings.zoneCuttingHeightEnabled !== undefined) {
        if (typeof settings.zoneCuttingHeightEnabled !== 'boolean') throw new Error('zoneCuttingHeightEnabled must be a boolean');
        if (!encoded[4]) encoded[4] = {};
        encoded[4][1] = settings.zoneCuttingHeightEnabled ? 1 : 0;
    }
    if (settings.zoneCuttingHeight !== undefined) {
        if (getCuttingHeightsMap()[settings.zoneCuttingHeight] === undefined) throw new Error(`zoneCuttingHeight must be one of: ${Object.keys(getCuttingHeightsMap()).join(', ')} mm`);
        if (!encoded[4]) encoded[4] = {};
        encoded[4][2] = getCuttingHeightsMap()[settings.zoneCuttingHeight];
    }
    if (settings.antiTheft !== undefined) {
        if (typeof settings.antiTheft !== 'boolean') throw new Error('antiTheft must be a boolean');
        encoded[6] = settings.antiTheft ? 1 : 0;
    }
    if (settings.smartCutHeight !== undefined) {
        if (typeof settings.smartCutHeight !== 'boolean') throw new Error('smartCutHeight must be a boolean');
        encoded[7] = settings.smartCutHeight ? 1 : 0;
    }
    if (settings.longExit !== undefined) {
        if (typeof settings.longExit !== 'boolean') throw new Error('longExit must be a boolean');
        if (!encoded[8]) encoded[8] = {};
        encoded[8][1] = settings.longExit ? 1 : 0;
    }
    if (settings.longExitMode !== undefined) {
        if (typeof settings.longExitMode !== 'number' || settings.longExitMode < 0) throw new Error('longExitMode must be a non-negative number');
        if (!encoded[8]) encoded[8] = {};
        encoded[8][3] = settings.longExitMode;
    }
    if (settings.zoneCuttingHeightUniform !== undefined) {
        if (typeof settings.zoneCuttingHeightUniform !== 'boolean') throw new Error('zoneCuttingHeightUniform must be a boolean');
        encoded[9] = settings.zoneCuttingHeightUniform ? 1 : 0;
    }
    if (settings.unknown !== undefined) encoded[11] = settings.unknown;
    if (settings.pushNotifications !== undefined) {
        if (typeof settings.pushNotifications !== 'boolean') throw new Error('pushNotifications must be a boolean');
        if (!encoded[14]) encoded[14] = {};
        encoded[14][1] = settings.pushNotifications ? 1 : 0;
    }
    if (settings.obstacleNotifications !== undefined) {
        if (typeof settings.obstacleNotifications !== 'boolean') throw new Error('obstacleNotifications must be a boolean');
        if (!encoded[15]) encoded[15] = {};
        encoded[15][1] = settings.obstacleNotifications ? 1 : 0;
    }
    return encoded;
}
function decodeRobotSettings(decoded) {
    return decoded
        ? upgradeRobotSettings({
              rainSensorEnabled: Boolean(decoded?.[1]?.[1] === 1),
              rainSensorDelay: getRainDelaysMap()[decoded?.[1]?.[2] || 0] || 0,
              keyboardLock: Boolean(decoded?.[2] === 1),
              zoneCuttingHeightEnabled: decoded?.[4]?.[1],
              zoneCuttingHeight: getCuttingHeightsMap()[decoded?.[4]?.[2] || 5],
              // 4.3 is set to 1 when the height is being changed
              antiTheft: Boolean(decoded?.[6] === 1),
              smartCutHeight: Boolean(decoded?.[7] === 1),
              longExit: Boolean(decoded?.[8]?.[1] === 1),
              longExitMode: decoded?.[8]?.[3] || 0,
              zoneCuttingHeightUniform: Boolean(decoded?.[9] === 1),
              unknown: decoded?.[11] || 110,
              pushNotifications: Boolean(decoded?.[14]?.[1] === 1),
              obstacleNotifications: Boolean(decoded?.[15]?.[1] === 1),
          })
        : undefined;
}
function formatRobotSettings(settings) {
    return formatStruct(settings, 'settings', {
        rainSensorDelay: { units: 'h' },
        zoneCuttingHeightEnabled: { onoff: true },
        zoneCuttingHeight: { units: 'mm' },
        rainSensorEnabled: { onoff: true },
        keyboardLock: { onoff: true },
        zoneCuttingHeightUniform: { onoff: true },
        antiTheft: { onoff: true },
        smartCutHeight: { onoff: true },
        longExit: { onoff: true },
        pushNotifications: { onoff: true },
        obstacleNotifications: { onoff: true },
    });
}
function upgradeRobotSettings(settings) {
    settings.getRainSensorDelays = () => Object.keys(getRainDelaysMap());
    settings.getCuttingHeights = () => Object.keys(getCuttingHeightsMap());
    settings.toString = () => formatRobotSettings(settings);
    return settings;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function getWeekDays() {
    return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
}
function getWeekDaysMap(days) {
    return getWeekDays()
        .map((n) => (days.includes(n) ? n[0] : '-'))
        .join('');
}

function decodeScheduleBlock(startSlot, endSlot) {
    const startHour = Math.floor(startSlot / 2),
        startMinute = (startSlot % 2) * 30;
    const endHour = Math.floor((endSlot + 1) / 2),
        endMinute = ((endSlot + 1) % 2) * 30;
    return {
        startSlot,
        endSlot,
        startTime: { hour: startHour, minute: startMinute },
        endTime: { hour: endHour, minute: endMinute },
        displayTime: `${startHour}:${startMinute.toString().padStart(2, '0')}-${endHour}:${endMinute.toString().padStart(2, '0')}`,
        durationMinutes: (endSlot - startSlot + 1) * 30,
    };
}
function decodeScheduleDay(bytes) {
    const daySchedule = {
        timeBlocks: [],
        bitmap: [],
        totalMinutes: 0,
    };
    const bits = [];
    for (let byte of bytes) {
        let reversedByte = 0;
        for (let i = 0; i < 8; i++) reversedByte = (reversedByte << 1) | ((byte >> i) & 1);
        for (let i = 7; i >= 0; i--) bits.push((reversedByte >> i) & 1);
    }
    daySchedule.bitmap = bits;
    let blockStart = -1;
    for (let i = 0; i < bits.length; i++)
        if (bits[i] === 1 && blockStart === -1) blockStart = i;
        else if (bits[i] === 0 && blockStart !== -1) {
            daySchedule.timeBlocks.push(decodeScheduleBlock(blockStart, i - 1));
            daySchedule.totalMinutes += (i - blockStart) * 30;
            blockStart = -1;
        }
    if (blockStart !== -1) {
        daySchedule.timeBlocks.push(decodeScheduleBlock(blockStart, bits.length - 1));
        daySchedule.totalMinutes += (bits.length - blockStart) * 30;
    }
    return daySchedule;
}
function decodeScheduleTimes(bytes) {
    const schedule = {
        days: [],
        totalMinutes: 0,
        totalBlocks: 0,
    };
    if (!bytes) return schedule;
    if (bytes.length !== 42) throw new Error(`Unexpected schedule data length: ${bytes.length} bytes`);
    const DAYS_PER_WEEK = 7,
        BYTES_PER_DAY = bytes.length / DAYS_PER_WEEK;
    for (let dayIndex = 0; dayIndex < DAYS_PER_WEEK; dayIndex++) {
        const dayOffset = dayIndex * BYTES_PER_DAY,
            dayBytes = bytes.slice(dayOffset, dayOffset + BYTES_PER_DAY),
            daySchedule = decodeScheduleDay(dayBytes);
        daySchedule.dayIndex = dayIndex;
        daySchedule.dayName = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][dayIndex];
        schedule.days.push(daySchedule);
        schedule.totalMinutes += daySchedule.totalMinutes;
        schedule.totalBlocks += daySchedule.timeBlocks.length;
    }
    return schedule;
}
function encodeScheduleDay(daySchedule) {
    const bytes = Array.from({ length: 6 }).fill(0); // 6 bytes per day = 48 half-hour slots
    if (daySchedule.bitmap) {
        for (let slot = 0; slot < daySchedule.bitmap.length && slot < 48; slot++) if (daySchedule.bitmap[slot]) bytes[Math.floor(slot / 8)] |= 1 << slot % 8;
    } else if (daySchedule.timeBlocks)
        for (const block of daySchedule.timeBlocks) {
            const startSlot = block.startSlot || block.startTime.hour * 2 + (block.startTime.minute >= 30 ? 1 : 0),
                endSlot = block.endSlot || block.endTime.hour * 2 + (block.endTime.minute >= 30 ? 1 : 0) - 1;
            for (let slot = startSlot; slot <= endSlot && slot < 48; slot++) bytes[Math.floor(slot / 8)] |= 1 << slot % 8;
        }
    return Buffer.from(bytes);
}
function encodeScheduleTimes(schedule) {
    const buffer = Buffer.alloc(42); // 7 days * 6 bytes per day
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) encodeScheduleDay(schedule.days[dayIndex] || { timeBlocks: [] }).copy(buffer, dayIndex * 6);
    return buffer;
}
function insertTimeBlock(schedule, dayIndex, startTime, endTime) {
    if (!schedule || !schedule.days) throw new Error('Invalid schedule object');
    if (dayIndex < 0 || dayIndex >= 7) throw new Error('Day index must be between 0 and 6');
    const day = schedule.days[dayIndex];
    let startSlot, endSlot;
    if (typeof startTime === 'number') startSlot = startTime;
    else if (typeof startTime === 'object') startSlot = startTime.hour * 2 + (startTime.minute >= 30 ? 1 : 0);
    else throw new Error('Start time must be a slot number or {hour, minute} object');
    if (typeof endTime === 'number') endSlot = endTime;
    else if (typeof endTime === 'object') endSlot = endTime.hour * 2 + (endTime.minute >= 30 ? 1 : 0) - 1;
    else throw new Error('End time must be a slot number or {hour, minute} object');
    if (startSlot < 0 || startSlot >= 48) throw new Error('Start slot must be between 0 and 47');
    if (endSlot < 0 || endSlot >= 48) throw new Error('End slot must be between 0 and 47');
    if (startSlot > endSlot) throw new Error('Start time must be before end time');
    for (const block of day.timeBlocks)
        if ((startSlot >= block.startSlot && startSlot <= block.endSlot) || (endSlot >= block.startSlot && endSlot <= block.endSlot) || (startSlot <= block.startSlot && endSlot >= block.endSlot))
            throw new Error('Time block overlaps with existing block');
    day.timeBlocks.push(decodeScheduleBlock(startSlot, endSlot));
    day.timeBlocks.sort((a, b) => a.startSlot - b.startSlot);
    for (let slot = startSlot; slot <= endSlot; slot++) day.bitmap[slot] = 1;
    const addedMinutes = (endSlot - startSlot + 1) * 30;
    day.totalMinutes += addedMinutes;
    schedule.totalMinutes += addedMinutes;
    schedule.totalBlocks++;
}
function removeTimeBlock(schedule, dayIndex, startTime) {
    if (!schedule || !schedule.days) throw new Error('Invalid schedule object');
    if (dayIndex < 0 || dayIndex >= 7) throw new Error('Day index must be between 0 and 6');
    const day = schedule.days[dayIndex];
    let startSlot;
    if (typeof startTime === 'number') startSlot = startTime;
    else if (typeof startTime === 'object' && startTime.hour !== undefined) startSlot = startTime.hour * 2 + (startTime.minute >= 30 ? 1 : 0);
    else if (typeof startTime === 'string') {
        const [hour, minute] = startTime.split(':').map(Number);
        if (Number.isNaN(hour) || Number.isNaN(minute)) throw new Error('Invalid time string format. Use "HH:MM" format');
        startSlot = hour * 2 + (minute >= 30 ? 1 : 0);
    } else throw new Error('Start time must be a slot number, {hour, minute} object, or "HH:MM" string');
    const blockIndex = day.timeBlocks.findIndex((block) => block.startSlot === startSlot);
    if (blockIndex === -1) {
        // eslint-disable-next-line unicorn/no-nested-ternary, sonarjs/no-nested-conditional
        const str = typeof startTime === 'string' ? startTime : typeof startTime === 'object' ? `${startTime.hour}:${startTime.minute || 0}` : `slot ${startTime}`;
        throw new Error(`No time block found starting at ${str}`);
    }
    const block = day.timeBlocks[blockIndex];
    for (let slot = block.startSlot; slot <= block.endSlot; slot++) day.bitmap[slot] = 0;
    const removedMinutes = block.durationMinutes;
    day.totalMinutes -= removedMinutes;
    schedule.totalMinutes -= removedMinutes;
    schedule.totalBlocks--;
    day.timeBlocks.splice(blockIndex, 1);
}
function clearDay(schedule, dayIndex) {
    if (!schedule || !schedule.days) throw new Error('Invalid schedule object');
    if (dayIndex < 0 || dayIndex >= 7) throw new Error('Day index must be between 0 and 6');
    const day = schedule.days[dayIndex];
    schedule.totalMinutes -= day.totalMinutes;
    schedule.totalBlocks -= day.timeBlocks.length;
    day.timeBlocks = [];
    day.bitmap = Array.from({ length: 48 }).fill(0);
    day.totalMinutes = 0;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line sonarjs/cognitive-complexity
function encodeRobotScheduleSettings(schedule) {
    if (!schedule || typeof schedule !== 'object') throw new Error('Schedule settings must be an object');
    const encoded = {};
    if (schedule.enabled !== undefined) {
        if (typeof schedule.enabled !== 'boolean') throw new Error('Schedule enabled must be a boolean');
        encoded[1] = schedule.enabled ? 1 : 0;
    }
    if (schedule.days !== undefined) {
        if (!Array.isArray(schedule.days) || schedule.days.length !== 7) throw new Error('Schedule must have exactly 7 days');
        for (let i = 0; i < 7; i++) {
            const day = schedule.days[i];
            if (!day || typeof day !== 'object') throw new Error(`Day ${i} must be an object`);
            if (day.timeBlocks && !Array.isArray(day.timeBlocks)) throw new Error(`Day ${i} timeBlocks must be an array`);
            if (day.timeBlocks) {
                for (const block of day.timeBlocks) {
                    if (!block.startSlot && !block.startTime) throw new Error('Time block must have startSlot or startTime');
                    if (!block.endSlot && !block.endTime) throw new Error('Time block must have endSlot or endTime');
                    if (block.startSlot !== undefined && (block.startSlot < 0 || block.startSlot >= 48)) throw new Error('Start slot must be between 0 and 47');
                    if (block.endSlot !== undefined && (block.endSlot < 0 || block.endSlot >= 48)) throw new Error('End slot must be between 0 and 47');
                    if (block.startTime) {
                        if (block.startTime.hour < 0 || block.startTime.hour >= 24) throw new Error('Start hour must be between 0 and 23');
                        if (block.startTime.minute !== 0 && block.startTime.minute !== 30) throw new Error('Start minute must be 0 or 30');
                    }
                    if (block.endTime) {
                        if (block.endTime.hour < 0 || block.endTime.hour >= 24) throw new Error('End hour must be between 0 and 23');
                        if (block.endTime.minute !== 0 && block.endTime.minute !== 30) throw new Error('End minute must be 0 or 30');
                    }
                }
            }
        }
        encoded[2] = encodeScheduleTimes(schedule);
    }
    if (schedule.type !== undefined) {
        if (typeof schedule.type !== 'number' || schedule.type < 0) throw new Error('Schedule type must be a non-negative number');
        encoded[4] = schedule.type;
    }
    return encoded;
}
function decodeRobotScheduleSettings(decoded) {
    return decoded
        ? upgradeRobotScheduleSettings({
              enabled: Boolean(decoded['1'] === true || decoded['1'] === 1),
              ...decodeScheduleTimes(decoded['2']),
              type: decoded['4'] || 5,
          })
        : undefined;
}
function formatRobotScheduleSettings(schedule, format = undefined) {
    if (format === 'detailed')
        return (
            schedule.days
                .filter((day) => day.timeBlocks?.length > 0)
                .map((day) => `${day.dayName.slice(0, 2)}:${day.timeBlocks.map((block) => block.displayTime).join('/')}`)
                .join(', ') || 'no-times'
        );
    if (format === 'blocks') return schedule.days.filter((day) => day.timeBlocks.length > 0).map((day) => `${day.dayName}: ${day.timeBlocks.map((tb) => tb.displayTime).join(', ')}`);

    return formatStruct(schedule, 'schedule', {
        totalBlocks: { rename: 'blocks' },
        totalMinutes: {
            rename: 'time',
            process: (v) => `${(v / 60).toFixed(0)}h${v % 60}m`,
        },
        days: {
            process: (v) => getWeekDaysMap(v.map((d) => d.dayName)),
        },
    });
}
function createRobotScheduleSettings() {
    return upgradeRobotScheduleSettings({
        enabled: false,
        days: Array.from({ length: 7 }).map((_, dayIndex) => ({
            dayIndex,
            dayName: getWeekDays()[dayIndex],
            timeBlocks: [],
            bitmap: Array.from({ length: 48 }).fill(0),
            totalMinutes: 0,
        })),
        totalMinutes: 0,
        totalBlocks: 0,
        type: 5,
    });
}
function upgradeRobotScheduleSettings(settings) {
    settings.insertTimeBlock = (dayIndex, startTime, endTime) => insertTimeBlock(settings, dayIndex, startTime, endTime);
    settings.removeTimeBlock = (dayIndex, startTime) => removeTimeBlock(settings, dayIndex, startTime);
    settings.clearDay = (dayIndex) => clearDay(settings, dayIndex);
    settings.toString = (format = undefined) => formatRobotScheduleSettings(settings, format);
    return settings;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// DEPRECATED — MQTT zone-settings codec. This was written on the assumption that per-zone settings
// are pushed over MQTT as CMD_ROBOT command 7 (ZONE_SETTINGS_UPDATE), but that turned out to be
// wrong: per-zone settings live in the cloud perimeter blob, not MQTT (cmd 7 in real traffic carries
// a position+timestamp, not this schema, and there is no zone-settings read path over MQTT). The
// `{1:type,[type]:settings}` framing and the field mapping here (notably cuttingAngle on [19]) do not
// match reality. Use decodePerimeterZoneSettings / encodePerimeterZoneSettings (above) and
// StigaAPIPerimeters.getZoneSettings / setZoneSettings instead. Kept only so the legacy CMD_ROBOT
// message interpreter (StigaAPIMessages) still resolves; do not use for new code.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// Encode a per-zone settings update for the robot over MQTT (CMD_ROBOT command 7). The robot's zone
// record uses the SAME field schema as the cloud data_points record (see PERIMETER_ZONE_FIELDS), so
// the app pushes the FULL record. The wrapper is { 1: type, [type]: <zoneRecord> } (the [2] payload of
// the command; the command envelope { 1:7, 2:<this>, 3:7 } is added by encodeRobotCommand). `type` was
// observed = 3 for a zone-settings update; overridable via settings.type. Returns a Buffer, built at
// the wire level so the customAngle [18] is a FIXED32 float even when it is a whole number (which
// protobufEncode would otherwise mis-encode as a varint). Verified byte-exact against a live capture
// (2026-06-05). Field set 1,5,6,7,8,9,11,12,13,15,17,18,19 mirrors what the app transmits.
function encodeRobotZoneSettings(zoneSettings) {
    if (!zoneSettings || typeof zoneSettings !== 'object') throw new Error('Zone settings must be an object');
    const zone = zoneSettings.zone ?? zoneSettings.id;
    if (zone === undefined || zone === null || !Number.isInteger(zone) || zone < 0) throw new Error('Zone must be a non-negative integer');
    const type = zoneSettings.type ?? 3;
    const heights = getCuttingHeightsMap(),
        modes = getCuttingModesMap();
    let heightValue = 5,
        modeValue = 0;
    if (zoneSettings.cuttingHeight !== undefined) {
        if (heights[zoneSettings.cuttingHeight] === undefined) throw new Error(`cuttingHeight must be one of: ${Object.keys(heights).join(', ')} mm`);
        heightValue = heights[zoneSettings.cuttingHeight];
    }
    if (zoneSettings.cuttingMode !== undefined) {
        if (typeof zoneSettings.cuttingMode === 'string') {
            if (modes[zoneSettings.cuttingMode] === undefined) throw new Error(`cuttingMode must be one of: ${Object.keys(modes).join(', ')}`);
            modeValue = modes[zoneSettings.cuttingMode];
        } else if (typeof zoneSettings.cuttingMode === 'number') modeValue = zoneSettings.cuttingMode;
        else throw new Error('cuttingMode must be a string or number');
    }
    const name = zoneSettings.name ?? '';
    if (typeof name !== 'string' || name.length > 255) throw new Error('name must be a string of at most 255 characters');
    const customAngle = zoneSettings.customAngle ?? 0;
    if (typeof customAngle !== 'number') throw new Error('customAngle must be a number');
    // housekeeping fields preserved from the source record (raw) where known, else the observed defaults
    const raw = zoneSettings.raw ?? {};
    const record = Buffer.concat([
        protobufField(1, 0, zone),
        protobufField(5, 0, raw[5] ?? 1),
        protobufField(6, 0, raw[6] ?? 0),
        protobufField(7, 0, raw[7] ?? 0),
        protobufField(8, 0, modeValue),
        protobufField(9, 0, heightValue),
        protobufField(11, 0, raw[11] ?? 0),
        protobufField(12, 0, zoneSettings.deactivated ? 1 : 0),
        protobufField(13, 0, zoneSettings.priority ?? 0),
        protobufField(15, 2, Buffer.from(name, 'utf8')),
        protobufField(17, 0, zoneSettings.customAngleActive ? 1 : 0),
        protobufField(18, 5, customAngle),
        protobufField(19, 0, zoneSettings.borderCut ? 1 : 0),
    ]);
    // [2] payload = { 1: type, [type]: record }
    return Buffer.concat([protobufField(1, 0, type), protobufField(type, 2, record)]);
}
// Decode an MQTT zone-settings payload (the command's [2] = { 1: type, [type]: record }). Shares the
// cloud zone-record decoder so the field mapping (angle [18], borderCut [19], priority [13]) is
// consistent. Used by the CMD_ROBOT message interpreter (StigaAPIMessages).
function decodeRobotZoneSettings(decoded) {
    const type = decoded?.[1];
    const record = type === undefined ? undefined : decoded?.[type];
    if (!record) return undefined;
    const settings = decodePerimeterZoneSettings(record);
    settings.type = type;
    settings.toString = () => formatRobotZoneSettings(settings);
    return settings;
}
function formatRobotZoneSettings(zoneSettings) {
    return formatPerimeterZoneSettings(zoneSettings);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function encodeRobotZoneOrder(zoneOrder) {
    if (!Array.isArray(zoneOrder)) throw new Error('Zone order must be an array');
    if (zoneOrder.length === 0) throw new Error('Zone order cannot be empty');
    for (const zone of zoneOrder) {
        if (typeof zone !== 'number' || !Number.isInteger(zone)) throw new Error('All zone IDs must be integers');
        if (zone < 0 || zone > 255) throw new Error('Zone IDs must be between 0 and 255');
    }
    const unique = new Set(zoneOrder);
    if (unique.size !== zoneOrder.length) throw new Error('Zone order cannot contain duplicate zone IDs');
    return zoneOrder.map((z) => z.toString(16).padStart(2, '0')).join('');
}
function decodeRobotZoneOrder(decoded) {
    if (decoded && typeof decoded === 'string') {
        let zones = [];
        let i = 0;
        while (i < decoded.length) {
            zones.push(Number.parseInt(decoded.slice(i, i + 2), 16));
            i += 2;
        }
        return zones;
    }
    return undefined;
}
function formatRobotZoneOrder(zoneOrder) {
    return zoneOrder?.join(',') ?? '-';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Per-zone settings — the CLOUD representation.
//
// Per-zone settings are NOT carried over MQTT (there is no ZONE_SETTINGS log topic, and CMD_ROBOT
// cmd 7 carries something else). They live in the cloud perimeter resource: GET /api/perimeters ->
// attributes.data_points.data is a protobuf blob whose field 1 is the list of zones, one sub-message
// per zone. Each zone sub-message carries both geometry (points/anchor/name) and these settings:
//   [1]  id                 varint
//   [8]  cuttingMode        varint  (getCuttingModesMap; absent => 0/denseGrid)
//   [9]  cuttingHeight      varint  (getCuttingHeightsMap index; absent => 5/45mm)
//   [13] priority           varint  (cut order; absent => 0, e.g. the main zone)
//   [15] name               string  (UTF-8; protobufDecode yields hex for non-ASCII)
//   [17] customAngleActive  varint  (bool)
//   [18] customAngle        FIXED32 float (degrees, signed)
//   [19] borderCut          varint  (bool; absent/unset => off)
// Verified 2026-06-05 against a live garden and a before/after app-edit diff (height [9], borderCut
// [19]). Writes go back via PATCH /api/perimeters/{uuid} (see StigaAPIPerimeters.setZoneSettings),
// patched at the wire level so the geometry bytes are preserved. Field number / wire-type spec, the
// single source of truth shared by read (decode) and write (patch):
const PERIMETER_ZONE_FIELDS = {
    cuttingMode: { field: 8, wire: 0, kind: 'mode' },
    cuttingHeight: { field: 9, wire: 0, kind: 'height' },
    priority: { field: 13, wire: 0, kind: 'int' },
    name: { field: 15, wire: 2, kind: 'string' },
    customAngleActive: { field: 17, wire: 0, kind: 'bool' },
    customAngle: { field: 18, wire: 5, kind: 'float' },
    borderCut: { field: 19, wire: 0, kind: 'bool' },
};

function _decodePerimeterZoneName(value) {
    if (typeof value !== 'string') return value;
    if (/^(?:[\da-f]{2})+$/i.test(value)) return Buffer.from(value, 'hex').toString('utf8');
    return value;
}

// Decode a single zone sub-message (as produced by protobufDecode of data_points field 1) into a
// friendly settings object. Unknown housekeeping fields ([5],[10],[11]) are preserved under `raw`
// so callers can inspect them without us guessing their meaning.
function decodePerimeterZoneSettings(zoneEntry) {
    if (!zoneEntry || typeof zoneEntry !== 'object') return undefined;
    const cuttingModesByValue = Object.fromEntries(Object.entries(getCuttingModesMap()).map(([k, v]) => [v, k]));
    const cuttingHeightsByValue = Object.fromEntries(Object.entries(getCuttingHeightsMap()).map(([k, v]) => [v, Number(k)]));
    const modeValue = zoneEntry[8] ?? 0;
    const heightValue = zoneEntry[9] ?? 5;
    return {
        id: zoneEntry[1],
        name: _decodePerimeterZoneName(zoneEntry[15]) || '',
        cuttingMode: cuttingModesByValue[modeValue] ?? modeValue,
        cuttingHeight: cuttingHeightsByValue[heightValue] ?? heightValue, // mm
        priority: zoneEntry[13] ?? 0,
        customAngleActive: Boolean(zoneEntry[17]),
        customAngle: zoneEntry[18] ?? 0, // degrees
        borderCut: Boolean(zoneEntry[19]),
        raw: { 5: zoneEntry[5], 10: zoneEntry[10], 11: zoneEntry[11] },
    };
}

function formatPerimeterZoneSettings(settings) {
    if (!settings) return '-';
    return formatStruct(
        {
            id: settings.id,
            name: settings.name,
            cuttingHeight: settings.cuttingHeight,
            cuttingMode: settings.cuttingMode,
            priority: settings.priority,
            customAngle: settings.customAngleActive ? settings.customAngle : 'off',
            borderCut: settings.borderCut,
        },
        'zoneSettings',
        { cuttingHeight: { units: 'mm' }, customAngle: { units: 'deg' }, borderCut: { onoff: true } }
    );
}

// Translate a friendly partial settings object ({ cuttingHeight, cuttingMode, priority, name,
// customAngleActive, customAngle, borderCut }) into a list of wire-level patches
// ({ field, wire, value }) for protobufSetFields. Validates each value and throws on bad input.
// Only keys present in `settings` are emitted, so callers can change one field without touching others.
function encodePerimeterZoneSettings(settings) {
    if (!settings || typeof settings !== 'object') throw new Error('Zone settings must be an object');
    const patches = [];
    const heights = getCuttingHeightsMap(),
        modes = getCuttingModesMap();
    for (const [key, value] of Object.entries(settings)) {
        if (value === undefined || key === 'id' || key === 'zone' || key === 'raw') continue;
        const spec = PERIMETER_ZONE_FIELDS[key];
        if (!spec) throw new Error(`Unknown zone setting: ${key}`);
        let encoded;
        switch (spec.kind) {
            case 'height':
                if (heights[value] === undefined) throw new Error(`cuttingHeight must be one of: ${Object.keys(heights).join(', ')} mm`);
                encoded = heights[value];
                break;
            case 'mode':
                if (typeof value === 'string') {
                    if (modes[value] === undefined) throw new Error(`cuttingMode must be one of: ${Object.keys(modes).join(', ')}`);
                    encoded = modes[value];
                } else if (typeof value === 'number') encoded = value;
                else throw new Error('cuttingMode must be a string or number');
                break;
            case 'int':
                if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
                encoded = value;
                break;
            case 'bool':
                if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
                encoded = value ? 1 : 0;
                break;
            case 'float':
                if (typeof value !== 'number') throw new Error(`${key} must be a number`);
                encoded = value;
                break;
            case 'string':
                if (typeof value !== 'string') throw new Error(`${key} must be a string`);
                if (value.length > 255) throw new Error(`${key} is too long (max 255 characters)`);
                encoded = Buffer.from(value, 'utf8');
                break;
            default:
                throw new Error(`Unhandled zone setting kind: ${spec.kind}`);
        }
        patches.push({ field: spec.field, wire: spec.wire, value: encoded });
    }
    return patches;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const BASE_MESSAGE_TOPICS = {
    CMD_REFERENCE: (mac) => `${mac}/CMD_REFERENCE`,
    CMD_REFERENCE_ACK: (mac) => `CMD_REFERENCE_ACK/${mac}`,
    LOG: (mac) => `${mac}/LOG/+`,
    JSON_NOTIFICATION: (mac) => `${mac}/JSON_NOTIFICATION`,
};

function buildBaseMessageTopics(baseMac, includeAcks) {
    if (!baseMac) return [];
    const topics = Object.values(BASE_MESSAGE_TOPICS).map((func) => func(baseMac));
    if (includeAcks) ['STATUS', 'VERSION', 'SETTINGS'].forEach((log) => topics.push(`${baseMac}/LOG/${log}/ACK`));
    return topics;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const BASE_COMMAND_TOPICS = {
    VERSION: '/LOG/VERSION',
    STATUS: '/LOG/STATUS',
};
const BASE_COMMAND_TYPES = {
    1: 'VERSION_REQUEST',
    // 3: cloud->base, parameterless (0803). Bursts as a re-sync/abort reaction when the base is driven
    //    into an odd state or a second controller appears (observed during SET_MODE experiments). TBD.
    // 4/5: 'UNKNOWN_4' / 'UNKNOWN_5'
    6: 'PUBLISH_START',
    7: 'PUBLISH_STOP',
    8: 'STATUS_REQUEST',
    // 13: cloud->base, drives the base RTK mode; [2][1] is a BASE_STATUS_TYPE. Cloud cycles 1=STANDBY
    //    (re-survey, ~5min) and 5=PUBLISHING_CORRECTIONS (~36min). Experimentally, 2=INITIALIZING and
    //    4=ACQUIRING_GPS both force a re-survey (base drops status [2]/[3] and reports [8][5] survey
    //    accuracy); the base status type never echoes the commanded mode. 3=ERROR untested.
    13: 'SET_MODE',
    15: 'SETTINGS_UPDATE',
};
const BASE_COMMAND_IDS = Object.fromEntries(Object.entries(BASE_COMMAND_TYPES).map(([key, value]) => [value, Number.parseInt(key)]));

function encodeBaseCommand(type, fields = undefined) {
    return BASE_COMMAND_TYPES[type]
        ? protobufEncode({
              1: type,
              2: fields,
          })
        : undefined;
}

function decodeBaseCommandType(decoded, allowUndefined = false) {
    return decodeIndex(decoded, BASE_COMMAND_TYPES, allowUndefined);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// const BASE_COMMAND_RESULT_CODES = {
//     1: 'OK',
// };
function decodeBaseCommandAckResult(_decoded, _allowUndefined = false) {
    return 'OK';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function encodeBaseStatusRequestTypes(encoded) {
    const r = {};
    if (encoded.location) r[1] = 1;
    if (encoded.network) r[2] = 1;
    return r;
}
function decodeBaseStatusRequestTypes(decoded) {
    return decoded
        ? {
              location: decoded[1],
              network: decoded[2],
          }
        : undefined;
}
function formatBaseStatusRequestTypes(statusTypes) {
    return formatStruct(statusTypes, 'statusTypes');
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const BASE_STATUS_TYPES = {
    1: 'STANDBY',
    2: 'INITIALIZING',
    3: 'ERROR',
    4: 'ACQUIRING_GPS',
    5: 'PUBLISHING_CORRECTIONS',
};

function decodeBaseStatusType(decoded, allowUndefined = false) {
    return decodeIndex(decoded, BASE_STATUS_TYPES, allowUndefined);
}
function formatBaseStatusType(statusType) {
    return statusType ?? '-';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function decodeBaseStatusValue(decoded) {
    return decoded ? { robot_not_asking: true } : undefined;
}
function formatBaseStatusValue(statusValue) {
    return statusValue?.robot_not_asking ? 'ROBOT_NOT_ASKING' : 'ROBOT_IS_ASKING';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function decodeBaseStatusDetail(decoded) {
    return decoded?.[2] ? { robot_not_asking: true } : undefined;
}
function formatBaseStatusDetail(statusDetail) {
    return statusDetail?.robot_not_asking ? 'ROBOT_NOT_ASKING' : 'ROBOT_IS_ASKING';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const BASE_STATUS_FLAGS = {
    0: 'INACTIVE',
    1: 'ACTIVE/OK',
    2: 'WARNING',
    3: 'ERROR',
};

function decodeBaseStatusFlag(decoded, allowUndefined = false) {
    return decodeIndex(decoded || 0, BASE_STATUS_FLAGS, allowUndefined);
}
function formatBaseStatusFlag(statusFlag) {
    return statusFlag ?? '-';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function getLedModesMap() {
    return { off: 0, always: 1, scheduled: 2 };
}

function encodeBaseSettingLED(mode) {
    if (getLedModesMap()[mode] === undefined) throw new Error(`LED mode must be one of: ${Object.keys(getLedModesMap()).join(',')}`);
    return Buffer.from([getLedModesMap()[mode]]);
}
function decodeBaseSettingLED(decoded, allowUndefined = false) {
    return decodeIndex(decoded || 0, Object.keys(getLedModesMap()), allowUndefined);
}
function formatBaseSettingLED(settingLED) {
    return settingLED ?? '-';
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function decodeBaseaMessageVersion(decoded) {
    return decodeVersion(decoded);
}

function decodeBaseMessageStatus(decoded) {
    const status = {
        type: decodeBaseStatusType(decoded[1]),
        flag: decodeBaseStatusFlag(decoded[4]),
        led: decodeBaseSettingLED(decoded[10]),
        location: decodeLocationStatus(decoded[8]),
        network: decodeNetworkStatus(decoded[9]),
    };
    status.toString = () => formatStruct(status, 'status', { network: { recurse: true, squarebrackets: true }, location: { recurse: true, squarebrackets: true } });
    return status;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = {
    //
    encodeMessageAck,
    //
    decodeVersion,
    formatVersion,
    decodeLocationStatus,
    formatLocationStatus,
    decodeNetworkStatus,
    formatNetworkStatus,
    //
    ROBOT_MESSAGE_TOPICS,
    ROBOT_COMMAND_TOPICS,
    ROBOT_COMMAND_TYPES,
    ROBOT_COMMAND_IDS,
    buildRobotMessageTopics,
    encodeRobotCommand,
    decodeRobotCommandType,
    decodeRobotCommandAckResult,
    encodeRobotStatusRequestTypes,
    decodeRobotStatusRequestTypes,
    formatRobotStatusRequestTypes,
    decodeRobotStatusValid,
    formatRobotStatusValid,
    decodeRobotStatusFlag,
    formatRobotStatusFlag,
    decodeRobotStatusType,
    formatRobotStatusType,
    decodeRobotStatusError,
    formatRobotStatusError,
    decodeRobotStatusInfo,
    formatRobotStatusInfo,
    decodeRobotStatusDocking,
    formatRobotStatusDocking,
    decodeRobotDockingCalibration,
    formatRobotDockingCalibration,
    decodeRobotMowingStatus,
    formatRobotMowingStatus,
    decodeRobotBatteryStatus,
    formatRobotBatteryStatus,
    decodeRobotPosition,
    formatRobotPosition,
    encodeRobotSettings,
    decodeRobotSettings,
    formatRobotSettings,
    encodeRobotCloudSync,
    decodeRobotCloudSync,
    formatRobotCloudSync,
    encodeRobotForceCut,
    decodeRobotForceCut,
    encodeRobotGoAway,
    decodeRobotGoAway,
    formatRobotGoAway,
    createRobotScheduleSettings,
    encodeRobotScheduleSettings,
    decodeRobotScheduleSettings,
    formatRobotScheduleSettings,
    encodeRobotZoneSettings,
    decodeRobotZoneSettings,
    formatRobotZoneSettings,
    encodeRobotZoneOrder,
    decodeRobotZoneOrder,
    formatRobotZoneOrder,
    PERIMETER_ZONE_FIELDS,
    decodePerimeterZoneSettings,
    encodePerimeterZoneSettings,
    formatPerimeterZoneSettings,
    //
    BASE_MESSAGE_TOPICS,
    BASE_COMMAND_TOPICS,
    BASE_COMMAND_TYPES,
    BASE_COMMAND_IDS,
    buildBaseMessageTopics,
    encodeBaseCommand,
    decodeBaseCommandType,
    decodeBaseCommandAckResult,
    encodeBaseStatusRequestTypes,
    decodeBaseStatusRequestTypes,
    formatBaseStatusRequestTypes,
    decodeBaseStatusType,
    formatBaseStatusType,
    decodeBaseStatusValue,
    formatBaseStatusValue,
    decodeBaseStatusDetail,
    formatBaseStatusDetail,
    decodeBaseStatusFlag,
    formatBaseStatusFlag,
    encodeBaseSettingLED,
    decodeBaseSettingLED,
    formatBaseSettingLED,
    decodeBaseaMessageVersion,
    decodeBaseMessageStatus,
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
