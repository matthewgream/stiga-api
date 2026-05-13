// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { protobufEncode } = require('./StigaAPIUtilitiesProtobuf');
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

// XXX not sure ...
function _decodeLocationStatus(latitudeOffset, longitudeOffset, latitude, longitude) {
    const latitudeOffsetCm = hexToDouble(latitudeOffset),
        longitudeOffsetCm = hexToDouble(longitudeOffset);
    const latitudeCmPerDeg = 111320 * 100,
        longitudeCmPerDeg = 111320 * 100 * (latitude === undefined ? 1 : Math.cos((latitude * Math.PI) / 180));
    const offsetDegrees = (Math.atan2(longitudeOffsetCm, latitudeOffsetCm) * 180) / Math.PI,
        offsetCompass = (90 - offsetDegrees + 360) % 360;
    return {
        latitude: latitude === undefined ? undefined : latitude + latitudeOffsetCm / latitudeCmPerDeg,
        longitude: longitude === undefined ? undefined : longitude + longitudeOffsetCm / longitudeCmPerDeg,
        latitudeOffsetCm,
        longitudeOffsetCm,
        offsetDistance: Math.hypot(latitudeOffsetCm, longitudeOffsetCm),
        offsetDegrees,
        offsetCompass,
    };
}
function decodeLocationStatus(decoded, location) {
    return decoded?.[3] || decoded?.[4]
        ? upgradeLocationStatus({
              // correlates with now low satellite count
              // 1 is kind of < 20 satellites, 2 is < 15
              // lowest satellite count I have seen is 8 (still marked as 2)
              coverage: decoded[1] || 0, // DOP? https://www.tersus-gnss.com/tech_blog/what-is-dop-in-gnss
              satellites: decoded[2],
              ..._decodeLocationStatus(decoded[3], decoded[4], location?.latitude, location?.longitude),
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
    2: 'UNKNOWN_CMD_2',
    4: 'GO_HOME',
    7: 'ZONE_SETTINGS_UPDATE',
    17: 'SETTINGS_REQUEST',
    18: 'SETTINGS_UPDATE',
    19: 'SCHEDULING_SETTINGS_REQUEST',
    20: 'SCHEDULING_SETTINGS_UPDATE',
    21: 'VERSION_REQUEST',
    22: 'POSITION_REQUEST',
    26: 'CALIBRATE_BLADES',
    28: 'STATUS_REQUEST',
    32: 'CLOUDSYNC_REQUEST',
    37: 'UNKNOWN_CMD_37',
    47: 'ZONE_ORDER_UPDATE',
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
    3: 'CHARGING',
    4: 'DOCKED',
    5: 'UPDATING',
    6: 'BLOCKED',
    8: 'LID_OPEN',
    13: 'GOING_HOME',
    18: 'CALIBRATION',
    20: 'BLADES_CALIBRATING',
    24: 'UNKNOWN_24',
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

// 2, 18 and then 2, 20 when leaving dock
// 2, 22 when blocked/lidsensor
// 2, 20 when out of perimeter
// 2, 22 when stuck/trapped
// 2, 18 -> reference station initiating

function decodeRobotStatusError(decoded) {
    return decoded
        ? upgradeRobotStatusError({
              code1: decoded[1],
              code2: decoded[2],
          })
        : undefined;
}
function formatRobotStatusError(statusError) {
    return formatStruct(statusError, 'statusError');
}
function upgradeRobotStatusError(statusError) {
    statusError.toString = () => formatRobotStatusError(statusError);
    return statusError;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const ROBOT_STATUS_INFO_CODES = {
    0x0064: 'LOW_BATTERY', // 3/1/1 (100)
    0x0191: 'BLOCKED', // 3/1/1 (401)
    0x0195: 'UNKNOWN_0195', // 3/1/1 (405) [when BLOCKED]
    0x019e: 'UNKNOWN_019E', // 3/1/1 (414)
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

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function decodeRobotMowingStatus(decoded) {
    return decoded
        ? upgradeRobotMowingStatus({
              zone: decoded[1],
              zoneCompleted: decoded[2],
              gardenCompleted: decoded[3],
          })
        : undefined;
}
function formatRobotMowingStatus(mowing) {
    return formatStruct(mowing, 'mowing', { zoneCompleted: { units: '%' }, gardenCompleted: { units: '%' } });
}
function upgradeRobotMowingStatus(mowing) {
    mowing.toString = () => formatRobotMowingStatus(mowing);
    return mowing;
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

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// relative to Base location
function decodeRobotPosition(decoded, location) {
    const offsetLongitudeMetres = hexToDouble(decoded[1] === undefined ? 0 : decoded[1]),
        offsetLatitutdeMetres = hexToDouble(decoded[2] === undefined ? 0 : decoded[2]);
    const orientRad = decoded[3] === undefined ? 0 : hexToDouble(decoded[3]);

    const offsetDegrees = (Math.atan2(offsetLongitudeMetres, offsetLatitutdeMetres) * 180) / Math.PI,
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
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function encodeRobotZoneSettings(zoneSettings) {
    if (!zoneSettings || typeof zoneSettings !== 'object') throw new Error('Zone settings must be an object');
    if (zoneSettings.zone === undefined || zoneSettings.zone === null) throw new Error('Zone number is required');
    if (typeof zoneSettings.zone !== 'number' || !Number.isInteger(zoneSettings.zone) || zoneSettings.zone < 0) throw new Error('Zone must be a non-negative integer');
    const type = zoneSettings.type || 1;
    if (![1, 2, 3, 4].includes(type)) throw new Error('Zone settings type must be 1, 2, 3, or 4');
    const settings = {};
    settings[1] = zoneSettings.zone;
    if (zoneSettings.unknown_5 !== undefined) settings[5] = zoneSettings.unknown_5;
    if (zoneSettings.unknown_6 !== undefined) settings[6] = zoneSettings.unknown_6;
    if (zoneSettings.unknown_7 !== undefined) settings[7] = zoneSettings.unknown_7;
    if (zoneSettings.cuttingMode !== undefined) {
        if (typeof zoneSettings.cuttingMode === 'string') {
            if (getCuttingModesMap()[zoneSettings.cuttingMode] === undefined) throw new Error(`Cutting mode name must be one of: ${Object.keys(getCuttingModesMap()).join(',')}`);
            settings[8] = getCuttingModesMap()[zoneSettings.cuttingMode];
        } else if (typeof zoneSettings.cuttingMode === 'number') {
            if (!Object.values(getCuttingModesMap()).includes(zoneSettings.cuttingMode)) throw new Error(`Cutting mode number must be one of: ${Object.values(getCuttingModesMap()).join(',')}`);
            settings[8] = zoneSettings.cuttingMode;
        } else throw new Error('Cutting mode must be a string or number');
    }
    if (zoneSettings.cuttingHeight !== undefined) {
        if (getCuttingHeightsMap()[zoneSettings.cuttingHeight] === undefined) throw new Error(`Cutting height must be one of: ${Object.keys(getCuttingHeightsMap()).join(', ')} mm`);
        settings[9] = getCuttingHeightsMap()[zoneSettings.cuttingHeight];
    }
    if (zoneSettings.unknown_11 !== undefined) settings[11] = zoneSettings.unknown_11;
    if (zoneSettings.deactivated !== undefined) {
        if (typeof zoneSettings.deactivated !== 'boolean') throw new Error('Deactivated must be a boolean');
        settings[12] = zoneSettings.deactivated ? 1 : 0;
    }
    if (zoneSettings.unknown_13 !== undefined) settings[13] = zoneSettings.unknown_13;
    if (zoneSettings.name !== undefined) {
        if (typeof zoneSettings.name !== 'string') throw new Error('Zone name must be a string');
        if (zoneSettings.name.length > 255) throw new Error('Zone name is too long (max 255 characters)');
        settings[15] = zoneSettings.name;
    }
    if (zoneSettings.cuttingAngleCustom !== undefined) {
        if (typeof zoneSettings.cuttingAngleCustom !== 'boolean') throw new Error('Cutting angle custom must be a boolean');
        settings[17] = zoneSettings.cuttingAngleCustom ? 1 : 0;
    }
    if (zoneSettings.cuttingAngle !== undefined) {
        if (typeof zoneSettings.cuttingAngle !== 'number') throw new Error('Cutting angle must be a number');
        if (zoneSettings.cuttingAngle < 0 || zoneSettings.cuttingAngle > 360) throw new Error('Cutting angle must be between 0 and 360 degrees');
        settings[19] = zoneSettings.cuttingAngle;
    }
    const encoded = { 1: type, [type]: settings };
    return encoded;
}
function decodeRobotZoneSettings(decoded) {
    const settings = decoded?.[decoded?.[1]];
    return settings
        ? upgradeRobotZoneSettings({
              type: decoded[1],
              zone: settings[1],
              unknown_5: settings[5],
              unknown_6: settings[6],
              unknown_7: settings[7],
              cuttingMode: getCuttingModesMap()[settings[8] || 0],
              cuttingHeight: getCuttingHeightsMap()[settings[9] || 5],
              unknown_11: settings[11],
              deactivated: Boolean(settings[12]),
              unknown_13: settings[13],
              name: settings[15] || '',
              cuttingAngleCustom: Boolean(settings[17]),
              cuttingAngle: settings[19] || 0,
          })
        : undefined;
}
function formatRobotZoneSettings(zoneSettings) {
    return formatStruct(zoneSettings, 'zoneSettings', { cuttingHeight: { units: 'mm' }, cuttingAngle: { units: 'deg' } });
}
function upgradeRobotZoneSettings(zoneSettings) {
    zoneSettings.getCuttingModes = () => Object.keys(getCuttingModesMap());
    zoneSettings.getCuttingHeights = () => Object.keys(getCuttingHeightsMap());
    zoneSettings.toString = () => formatRobotZoneSettings(zoneSettings);
    return zoneSettings;
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
    3: 'UNKNOWN_3',
    4: 'UNKNOWN_4',
    5: 'UNKNOWN_5',
    6: 'PUBLISH_START',
    7: 'PUBLISH_STOP',
    8: 'STATUS_REQUEST',
    // 13 is sent with 2.1=1 (at start) and 2.1=5 (at end)
    13: 'UNKNOWN_13',
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

function decodeBaseUnknown13(decoded) {
    // 13 is sent with 2.1=1 (at start) and 2.1=5 (at end)
    return decoded?.[1];
}
function formatBaseUnknown13(x) {
    return x;
}

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
        location: decodeLocationStatus(decoded[8], this.position),
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
    decodeRobotMowingStatus,
    formatRobotMowingStatus,
    decodeRobotBatteryStatus,
    formatRobotBatteryStatus,
    decodeRobotPosition,
    formatRobotPosition,
    encodeRobotSettings,
    decodeRobotSettings,
    formatRobotSettings,
    decodeRobotCloudSync,
    formatRobotCloudSync,
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
    decodeBaseUnknown13,
    formatBaseUnknown13,
    decodeBaseaMessageVersion,
    decodeBaseMessageStatus,
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
