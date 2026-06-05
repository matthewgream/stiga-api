// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const protobuf = require('../api/StigaAPIUtilitiesProtobuf');
const elements = require('../api/StigaAPIElements');
//const { formatStruct } = require('../api/StigaAPIUtilitiesFormat');

let BASE_LOCATION;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function message_robot_CMD_ROBOT(decoded, { interpretation, fieldTracker }) {
    interpretation.push('ROBOT::CMD_ROBOT');
    const command = elements.decodeRobotCommandType(decoded[1]);
    fieldTracker.add(addField(interpretation, 1, 'Command Type', `${command} (${decoded[1]})`));
    if (decoded[2] !== undefined)
        switch (command) {
            case 'VERSION_REQUEST':
                break;
            case 'STATUS_REQUEST':
                fieldTracker.add(addField(interpretation, 2, 'Status Request Types', elements.formatRobotStatusRequestTypes(elements.decodeRobotStatusRequestTypes(decoded[2]))));
                break;
            case 'SETTINGS_UPDATE':
                fieldTracker.add(addField(interpretation, 2, 'Settings', elements.formatRobotSettings(elements.decodeRobotSettings(decoded[2]))));
                break;
            case 'SCHEDULING_SETTINGS_UPDATE':
                fieldTracker.add(addField(interpretation, 2, 'Schedule Settings', elements.formatRobotScheduleSettings(elements.decodeRobotScheduleSettings({ ...decoded[2], 2: protobuf.stringToBytes(decoded[2]?.[2] || '') }))));
                break;
            case 'ZONE_SETTINGS_UPDATE':
                fieldTracker.add(addField(interpretation, 2, 'Zone Settings', elements.formatRobotZoneSettings(elements.decodeRobotZoneSettings(decoded[2]))));
                break;
            case 'ZONE_ORDER_UPDATE':
                fieldTracker.add(addField(interpretation, 2, 'Zone Order', elements.formatRobotZoneOrder(elements.decodeRobotZoneOrder(decoded[2]))));
                break;
            case 'CLOUDSYNC_DOWNLOAD':
            case 'CLOUDSYNC_REQUEST':
                fieldTracker.add(addField(interpretation, 2, 'CloudSync Parameters', elements.formatRobotCloudSync(elements.decodeRobotCloudSync(decoded[2]))));
                break;
            case 'FORCE_CUT':
            case 'FORCE_BORDER_CUT':
                fieldTracker.add(addField(interpretation, 2, 'Zone', elements.decodeRobotForceCut(decoded[2])));
                break;
            case 'GO_AWAY':
                fieldTracker.add(addField(interpretation, 2, 'Go-Away Obstacle', elements.formatRobotGoAway(elements.decodeRobotGoAway(decoded[2]))));
                break;
        }
    if (decoded[3] !== undefined) {
        fieldTracker.add('3');
        if (decoded[3] !== decoded[1]) interpretation.push(`Command Echo (${decoded[3]}) !== Command Type (${decoded[1]})`);
    }
}

function message_robot_CMD_ROBOT_ACK(decoded, { interpretation, fieldTracker }) {
    interpretation.push('ROBOT::CMD_ROBOT_ACK');
    fieldTracker.add(addField(interpretation, 1, 'Command Type', `${elements.decodeRobotCommandType(decoded[1] || 0)} (${decoded[1] || 0})`));
    if (decoded[2] !== undefined) fieldTracker.add(addField(interpretation, 2, 'Result', elements.decodeRobotCommandAckResult(decoded[2])));
}

function message_robot_LOG_STATUS(decoded, { interpretation, fieldTracker }) {
    interpretation.push('ROBOT::LOG_STATUS');
    fieldTracker.add(addField(interpretation, 1, 'Status Valid', elements.formatRobotStatusValid(elements.decodeRobotStatusValid(decoded[1]))));
    // seems to correlate with on/off the ground or operable??
    // fieldTracker.add(addField(interpretation, 2, 'Status Flag[2]', elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[2]))));
    fieldTracker.add(addField(interpretation, 3, 'Status Type', elements.formatRobotStatusType(elements.decodeRobotStatusType(decoded[3]))));
    fieldTracker.add(addField(interpretation, 4, 'Status Error', elements.formatRobotStatusError(elements.decodeRobotStatusError(decoded[4]))));
    fieldTracker.add(addField(interpretation, 5, 'Status Flag[5]', elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[5])))); // omnipresent
    if (decoded[9] !== undefined) fieldTracker.add(addField(interpretation, 9, 'Docking Calibration', elements.formatRobotDockingCalibration(elements.decodeRobotDockingCalibration(decoded[9]))));
    fieldTracker.add(addField(interpretation, 10, 'Status Info', elements.formatRobotStatusInfo(elements.decodeRobotStatusInfo(decoded[10]))));
    fieldTracker.add(addField(interpretation, 12, 'Intervention Required', elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[12]))));
    fieldTracker.add(addField(interpretation, 13, 'Docked', elements.formatRobotStatusDocking(elements.decodeRobotStatusDocking(decoded[13]))));
    if (decoded[17] !== undefined) fieldTracker.add(addField(interpretation, 17, 'Battery Status', elements.formatRobotBatteryStatus(elements.decodeRobotBatteryStatus(decoded[17]))));
    if (decoded[18] !== undefined) fieldTracker.add(addField(interpretation, 18, 'Mowing Status', elements.formatRobotMowingStatus(elements.decodeRobotMowingStatus(decoded[18], BASE_LOCATION))));
    if (decoded[19] !== undefined) fieldTracker.add(addField(interpretation, 19, 'Location Status', elements.formatLocationStatus(elements.decodeLocationStatus(decoded[19], BASE_LOCATION))));
    if (decoded[20] !== undefined) fieldTracker.add(addField(interpretation, 20, 'Network Status', elements.formatNetworkStatus(elements.decodeNetworkStatus(decoded[20]))));
}

function message_robot_LOG_SETTINGS(decoded, { interpretation, fieldTracker }) {
    interpretation.push('ROBOT::LOG_SETTINGS');
    // 3, 5, 10, 12, 13
    ['1', '2', '4', '6', '7', '8', '9', '11', '14', '15'].forEach((field) => fieldTracker.add(field));
    interpretation.push(`Settings: ${elements.formatRobotSettings(elements.decodeRobotSettings(decoded))}`);
}

function message_robot_LOG_SCHEDULING_SETTINGS(decoded, { interpretation, fieldTracker }) {
    interpretation.push('ROBOT::LOG_SCHEDULING_SETTINGS');
    ['1', '2', '4'].forEach((field) => fieldTracker.add(field));
    const schedule = elements.decodeRobotScheduleSettings({ ...decoded, 2: protobuf.stringToBytes(decoded[2] || '') });
    interpretation.push(`Schedule Settings: ${elements.formatRobotScheduleSettings(schedule)}`);
    if (schedule.totalBlocks > 0) elements.formatRobotScheduleSettings(schedule, 'blocks').forEach((block) => interpretation.push(`    ${block}`));
}

function message_robot_POSITION(decoded, { interpretation, fieldTracker }) {
    interpretation.push('ROBOT::POSITION');
    ['1', '2', '3'].forEach((field) => fieldTracker.add(field));
    interpretation.push(`Position: ${elements.formatRobotPosition(elements.decodeRobotPosition(decoded))}`);
}

function message_robot_LOG_VERSION(decoded, { interpretation, fieldTracker }) {
    interpretation.push('ROBOT::LOG_VERSION');
    ['1', '2', '3', '5', '6'].forEach((field) => fieldTracker.add(field));
    interpretation.push(`Version: ${elements.formatVersion(elements.decodeVersion(decoded))}`);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function message_base_CMD_REFERENCE(decoded, { interpretation, fieldTracker }) {
    interpretation.push('REFER::CMD_REFERENCE');
    const command = elements.decodeBaseCommandType(decoded[1]);
    fieldTracker.add(addField(interpretation, 1, 'Command Type', `${command} (${decoded[1]})`));
    if (decoded[2] !== undefined)
        switch (command) {
            case 'VERSION_REQUEST':
                break;
            case 'STATUS_REQUEST':
                fieldTracker.add(addField(interpretation, 2, 'Status Request Types', elements.formatBaseStatusRequestTypes(elements.decodeBaseStatusRequestTypes(decoded[2]))));
                break;
            case 'SETTINGS_UPDATE':
                fieldTracker.add(addField(interpretation, 2, 'LED Mode', elements.formatBaseSettingLED(elements.decodeBaseSettingLED(decoded[2]))));
                break;
            case 'SET_MODE':
                fieldTracker.add(addField(interpretation, 2, 'Status Mode', elements.formatBaseStatusType(elements.decodeBaseStatusType(decoded[2]?.[1]))));
                break;
        }
}
function message_base_CMD_REFERENCE_ACK(decoded, { interpretation, fieldTracker }) {
    interpretation.push('REFER::CMD_REFERENCE_ACK');
    fieldTracker.add(addField(interpretation, 1, 'Command Type', `${elements.decodeBaseCommandType(decoded[1])} (${decoded[1]})`));
}

function message_base_LOG_STATUS(decoded, { interpretation, fieldTracker }) {
    interpretation.push('REFER::LOG_STATUS');
    fieldTracker.add(addField(interpretation, 1, 'Status Type', elements.formatBaseStatusType(elements.decodeBaseStatusType(decoded[1]))));
    fieldTracker.add(addField(interpretation, 2, 'Status Value', elements.formatBaseStatusValue(elements.decodeBaseStatusValue(decoded[2]))));
    fieldTracker.add(addField(interpretation, 3, 'Status Detail', elements.formatBaseStatusDetail(elements.decodeBaseStatusDetail(decoded[3]))));
    fieldTracker.add(addField(interpretation, 4, 'Status Flag', elements.formatBaseStatusFlag(elements.decodeBaseStatusFlag(decoded[4]))));
    // 5, 6, 7
    // [8] is the base's own GNSS/RTK status (reusing the location decoder). [8][5] -> rtkQuality is the
    // survey/Svin accuracy and only appears while the base is acquiring (SET_MODE 2/4); during normal
    // PUBLISHING/STANDBY it is absent. [2]/[3] (Status Value/Detail) drop out while acquiring.
    if (decoded[8] !== undefined) fieldTracker.add(addField(interpretation, 8, 'Location Status', elements.formatLocationStatus(elements.decodeLocationStatus(decoded[8], BASE_LOCATION))));
    if (decoded[9] !== undefined) fieldTracker.add(addField(interpretation, 9, 'Network Status', elements.formatNetworkStatus(elements.decodeNetworkStatus(decoded[9]))));
    if (decoded[10] !== undefined) fieldTracker.add(addField(interpretation, 10, 'LED Mode', elements.formatBaseSettingLED(elements.decodeBaseSettingLED(decoded[10]))));
}

function message_base_LOG_VERSION(decoded, { interpretation, fieldTracker }) {
    interpretation.push('REFER::LOG_VERSION');
    ['1', '2', '3', '5', '6'].forEach((field) => fieldTracker.add(field));
    interpretation.push(`Version: ${elements.formatVersion(elements.decodeVersion(decoded))}`);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function message_unknown_REQUEST(topic, _decoded, { interpretation }) {
    interpretation.push(`UNKNOWN::${topic}`);
}

function message_ACK(_decoded, { interpretation }) {
    interpretation.push('ACK (Empty acknowledgment)');
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function getHandlers({ MAC_ROBOT, MAC_BASE }) {
    return {
        //
        [`${MAC_ROBOT}/CMD_ROBOT`]: { handler: message_robot_CMD_ROBOT, type: 'protobuf' },
        [`CMD_ROBOT_ACK/${MAC_ROBOT}`]: { handler: message_robot_CMD_ROBOT_ACK, type: 'protobuf' },
        [`${MAC_ROBOT}/LOG/STATUS`]: { handler: message_robot_LOG_STATUS, type: 'protobuf' },
        [`${MAC_ROBOT}/LOG/STATUS/ACK`]: { handler: message_ACK, type: 'custom' },
        [`${MAC_ROBOT}/LOG/VERSION`]: { handler: message_robot_LOG_VERSION, type: 'protobuf' },
        [`${MAC_ROBOT}/LOG/VERSION/ACK`]: { handler: message_ACK, type: 'custom' },
        [`${MAC_ROBOT}/LOG/SETTINGS`]: { handler: message_robot_LOG_SETTINGS, type: 'protobuf' },
        [`${MAC_ROBOT}/LOG/SETTINGS/ACK`]: { handler: message_ACK, type: 'custom' },
        [`${MAC_ROBOT}/LOG/SCHEDULING_SETTINGS`]: { handler: message_robot_LOG_SCHEDULING_SETTINGS, type: 'protobuf' },
        [`${MAC_ROBOT}/LOG/SCHEDULING_SETTINGS/ACK`]: { handler: message_ACK, type: 'custom' },
        [`${MAC_ROBOT}/LOG/ROBOT_POSITION`]: { handler: message_robot_POSITION, type: 'protobuf' },
        [`${MAC_ROBOT}/LOG/ROBOT_POSITION/ACK`]: { handler: message_ACK, type: 'custom' },
        //
        [`${MAC_BASE}/CMD_REFERENCE`]: { handler: message_base_CMD_REFERENCE, type: 'protobuf' },
        [`CMD_REFERENCE_ACK/${MAC_BASE}`]: {
            handler: message_base_CMD_REFERENCE_ACK,
            type: 'protobuf',
            preprocess: (message) => (message.length > 2 && message[0] == 0x20 ? message.slice(1) : message),
        },
        [`${MAC_BASE}/LOG/STATUS`]: { handler: message_base_LOG_STATUS, type: 'protobuf' },
        [`${MAC_BASE}/LOG/STATUS/ACK`]: { handler: message_ACK, type: 'protobuf' },
        [`${MAC_BASE}/LOG/VERSION`]: { handler: message_base_LOG_VERSION, type: 'protobuf' },
        [`${MAC_BASE}/LOG/VERSION/ACK`]: { handler: message_ACK, type: 'protobuf' },
    };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function interpret(topic, message, options) {
    const result = {
        interpretation: [],
        fieldTracker: new Set(),
    };

    const handler = getHandlers(options)[topic];
    if (!handler) {
        message_unknown_REQUEST(topic, message, result);
        return result.interpretation;
    }

    let decoded = message;
    let decodedType = 'unknown';
    if (handler.preprocess && typeof handler.preprocess === 'function') message = handler.preprocess(message);
    if (handler.type === 'protobuf' && message.length > 0 && message[0] !== 0x00)
        try {
            decoded = protobuf.decode(message);
            decodedType = 'protobuf';
        } catch (e) {
            return [`Failed to decode message: ${e.message}`];
        }
    handler.handler(decoded, result);

    let output = result.interpretation;
    if (decodedType === 'protobuf' && typeof decoded === 'object' && !Buffer.isBuffer(decoded)) {
        const unknownSummary = Object.keys(decoded)
            .filter((field) => !result.fieldTracker.has(field))
            .map((field) => `[${field}]`)
            .join(', ');
        if (unknownSummary) output = [...output, `Unknown: ${unknownSummary}`, ...JSON.stringify(decoded, undefined, 2).split('\n')];
    }

    return output;
}

function addField(interpretation, field, name, value) {
    interpretation.push(`[${field}] ${name}: ${value}`);
    return field.toString();
}

function configure(options) {
    if (options.location) BASE_LOCATION = options.location;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = {
    configure,
    interpret,
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
