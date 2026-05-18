// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIUtilities, StigaAPIElements: elements } = require('../../../api/StigaAPI');
const { protobufDecode, stringToBytes, formatMinutesNicely, formatNetworkId } = StigaAPIUtilities;

const DEFAULT_TIMING_DOCKED = {
    version: 60 * 60 * 1000, // 60 minutes
    settings: 30 * 60 * 1000, // 30 minutes
    status: 5 * 60 * 1000, // 5 minutes
};

const DEFAULT_TIMING_UNDOCKED = {
    version: 30 * 60 * 1000, // 30 minutes
    settings: 5 * 60 * 1000, // 5 minutes
    status: 30 * 1000, // 30 seconds
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class MonitorProcessor {
    constructor(connectionManager, displayManager, options = {}) {
        this.connection = connectionManager;
        this.display = displayManager;
        this.location = options.location;
        if (!this.location) throw new Error('MonitorProcessor: options.location is required (RTK reference origin)');

        this.timers = [];
        this.ackFlags = {};

        this.timingDocked = { ...DEFAULT_TIMING_DOCKED, ...options.timingDocked };
        this.timingUndocked = { ...DEFAULT_TIMING_UNDOCKED, ...options.timingUndocked };
        this.isDocked = true;
        this.currentTiming = this.timingDocked;
    }

    //

    async start() {
        this.connection.on('message', (topic, message) => this._handleMessage(topic, message));
        this._startTimers();
        this.display.log('Monitor started');
    }

    async stop() {
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        this.display.log('Monitor stopped');
    }

    //

    _startTimers() {
        this._sendStatusRequests();
        this._sendVersionRequests();
        this._sendSettingsRequests();
        this._updateTimers();
    }

    _updateTimers() {
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        this.timers.push(setInterval(() => this._sendStatusRequests(), this.currentTiming.status));
        this.timers.push(setInterval(() => this._sendVersionRequests(), this.currentTiming.version));
        this.timers.push(setInterval(() => this._sendSettingsRequests(), this.currentTiming.settings));
        this.display.log(`timers configured: status=${this.currentTiming.status / 1000}s, version=${this.currentTiming.version / 60000}m, settings=${this.currentTiming.settings / 60000}m`);
    }

    //

    _handleMessage(topic, message) {
        try {
            const decoded = protobufDecode(message);
            if (topic.includes(this.connection.getRobotMac())) this._handleRobotMessage(topic, decoded);
            else if (topic.includes(this.connection.getBaseMac())) this._handleBaseMessage(topic, decoded);
        } catch {
            // Some messages may not be protobuf
        }
    }

    _handleRobotMessage(topic, decoded) {
        if (topic.endsWith('ACK')) {
            // ignore
        } else if (topic.includes('/LOG/VERSION')) {
            this.display.log('Robot version response received');
            this._updateRobotVersion(decoded);
            if (this.ackFlags.robot_version) {
                this.ackFlags.robot_version = false;
                this._sendAck(`${topic}/ACK`);
            }
        } else if (topic.includes('/LOG/STATUS')) {
            this.display.log('Robot status response received');
            this._updateRobotStatus(decoded);
            if (this.ackFlags.robot_status) {
                this.ackFlags.robot_status = false;
                this._sendAck(`${topic}/ACK`);
            }
        } else if (topic.includes('/LOG/SCHEDULING_SETTINGS')) {
            this.display.log('Robot scheduling settings received');
            this._updateRobotSchedule(decoded);
            if (this.ackFlags.robot_schedule) {
                this.ackFlags.robot_schedule = false;
                this._sendAck(`${topic}/ACK`);
            }
        } else if (topic.includes('/LOG/ROBOT_POSITION')) {
            this.display.log('Robot position received');
            this._updateRobotPosition(decoded);
        }
    }

    _handleBaseMessage(topic, decoded) {
        if (topic.endsWith('ACK')) {
            // ignore
        } else if (topic.includes('/LOG/VERSION')) {
            this.display.log('Base version response received');
            this._updateBaseVersion(decoded);
            if (this.ackFlags.base_version) {
                this.ackFlags.base_version = false;
                this._sendAck(`${topic}/ACK`);
            }
        } else if (topic.includes('/LOG/STATUS')) {
            this.display.log('Base status response received');
            this._updateBaseStatus(decoded);
            if (this.ackFlags.base_status) {
                this.ackFlags.base_status = false;
                this._sendAck(`${topic}/ACK`);
            }
        }
    }

    //

    _updateRobotVersion(decoded) {
        const version = elements.decodeVersion(decoded);
        this.display.updateRobotData({
            version: elements.formatVersion(version, { compressed: true, ignore: 'modem' }),
            version2: version.modem || '-',
        });
    }

    _updateRobotStatus(decoded) {
        const updates = {
            statusType: elements.formatRobotStatusType(elements.decodeRobotStatusType(decoded[3])),
            statusText: '',
        };
        const statusInfo = elements.formatRobotStatusInfo(elements.decodeRobotStatusInfo(decoded[10])).replaceAll('-', '');
        const statusError = elements.formatRobotStatusError(elements.decodeRobotStatusError(decoded[4])).replaceAll('-', '');
        // eslint-disable-next-line sonarjs/no-nested-conditional
        updates.statusText = statusInfo || statusError ? `${statusInfo}${statusInfo && statusError ? ', ' : ''}${statusError}` : '-';
        updates.statusFlag = `(valid ${elements.formatRobotStatusValid(elements.decodeRobotStatusValid(decoded[1]))}, flag ${elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[2]))})`;
        updates.statusDocked = elements.formatRobotStatusDocking(elements.decodeRobotStatusDocking(decoded[13])).startsWith('yes') ? 'Docked' : 'Not docked';
        const isDocked = updates.statusDocked === 'Docked';
        if (isDocked !== this.isDocked) {
            this.isDocked = isDocked;
            this.currentTiming = isDocked ? this.timingDocked : this.timingUndocked;
            this.display.log(`Robot ${isDocked ? 'docked' : 'undocked'} - switching to ${isDocked ? 'docked' : 'undocked'} timing`);
            this._updateTimers();
        }
        if (decoded[17]) {
            const battery = elements.decodeRobotBatteryStatus(decoded[17]);
            updates.battery = `${battery.charge}% (${battery.capacity} mAh)`;
        }
        if (decoded[18]) {
            const mowing = elements.decodeRobotMowingStatus(decoded[18]);
            updates.mowing = mowing ? `Zone ${mowing.zone} at ${mowing.zoneCompleted || 0}%; Garden at ${mowing.gardenCompleted || 0}%` : '-';
        }
        if (decoded[19]) this._updateLocationInfo(updates, decoded[19], 'robot');
        if (decoded[20]) this._updateNetworkInfo(updates, decoded[20]);
        this.display.updateRobotData(updates);
    }

    _findNextScheduledSession(settings) {
        const now = new Date(),
            currentDay = (now.getDay() + 6) % 7,
            currentMin = now.getHours() * 60 + now.getMinutes();
        for (let daysAway = 0; daysAway < 7; daysAway++) {
            const daySchedule = settings.days[(currentDay + daysAway) % 7];
            if (daySchedule?.timeBlocks) {
                for (const block of daySchedule.timeBlocks) {
                    const blockStartMinutes = block.startTime.hour * 60 + block.startTime.minute;
                    if (daysAway === 0 && blockStartMinutes <= currentMin) continue;
                    const minutesAway = daysAway === 0 ? blockStartMinutes - currentMin : 24 * 60 - currentMin + (daysAway - 1) * 24 * 60 + blockStartMinutes;
                    return {
                        dayName: daySchedule.dayName,
                        startTime: block.displayTime.split('-')[0],
                        duration: block.durationMinutes,
                        daysAway,
                        minutesAway,
                    };
                }
            }
        }
        return undefined;
    }

    _updateRobotSchedule(decoded) {
        const settings = elements.decodeRobotScheduleSettings({ ...decoded, 2: stringToBytes(decoded[2] || '') });
        let scheduleText = `Schedule ${settings.enabled ? 'active' : 'inactive'}`;
        if (settings.enabled && settings.days) {
            const nextSession = this._findNextScheduledSession(settings);
            if (nextSession) {
                // eslint-disable-next-line unicorn/no-nested-ternary, sonarjs/no-nested-conditional
                const when = nextSession.daysAway === 0 ? 'Today' : nextSession.daysAway === 1 ? 'Tomorrow' : nextSession.dayName;
                scheduleText += `: ${when} at ${nextSession.startTime} for ${formatMinutesNicely(nextSession.duration)}`;
            }
        }
        this.display.updateRobotData({ schedule: scheduleText });
    }

    _updateRobotPosition(decoded) {
        const position = elements.decodeRobotPosition(decoded, this.location);
        if (position) {
            let positionText = `${position.offsetDistanceMetres.toFixed(2)} m at ${position.offsetCompass.toFixed(0)}°`;
            if (position.orientationCompass) positionText += ` [oriented ${position.orientationCompass.toFixed(0)}°]`;
            if (position.latitude !== undefined && position.longitude !== undefined) positionText += ` (${position.latitude.toFixed(8)}, ${position.longitude.toFixed(8)})`;
            this.display.updateRobotData({ position: positionText });
        }
    }

    //

    _updateBaseVersion(decoded) {
        const version = elements.decodeVersion(decoded);
        this.display.updateBaseData({
            version: elements.formatVersion(version, { compressed: true, ignore: 'modem' }),
            version2: version.modem || '-',
        });
    }

    _updateBaseStatus(decoded) {
        const updates = {
            statusType: elements.formatBaseStatusType(elements.decodeBaseStatusType(decoded[1])),
            statusText: `${elements.formatBaseStatusValue(elements.decodeBaseStatusValue(decoded[2]))} / ${elements.formatBaseStatusDetail(elements.decodeBaseStatusDetail(decoded[3]))}`,
            statusFlag: elements.formatBaseStatusFlag(elements.decodeBaseStatusFlag(decoded[4])),
            statusLED: `LED is ${elements.formatBaseSettingLED(elements.decodeBaseSettingLED(decoded[10]))}`,
        };
        if (decoded[8]) this._updateLocationInfo(updates, decoded[8], 'base');
        if (decoded[9]) this._updateNetworkInfo(updates, decoded[9]);
        this.display.updateBaseData(updates);
    }

    //

    _updateLocationInfo(data, decoded, _type) {
        const location = elements.decodeLocationStatus(decoded, this.location);
        if (location) {
            data.locationPosition = `${location.latitude?.toFixed(8) || '-'}, ${location.longitude?.toFixed(8) || '-'} (${location.satellites} satellites)`;
            if (location.coverage) data.locationPosition += ` [${['GOOD', 'POOR', 'BAD', 'WORSE'][location.coverage]}]`;
            data.locationOffset = `${location.offsetDistance.toFixed(2)} cm at ${location.offsetCompass.toFixed(0)}°`;
            if (location.rtkQuality !== undefined) data.locationOffset += ` (quality ${(location.rtkQuality * 100).toFixed(2)}%)`;
        }
    }

    _updateNetworkInfo(data, decoded) {
        const network = elements.decodeNetworkStatus(decoded);
        if (network) {
            data.networkDetail = `${formatNetworkId(network.network)} (${network.type})`;
            data.networkSignal = `${network.rssi} dBm (rsrp ${network.rsrp} dBm, rsrq ${network.rsrq} dB)`;
        }
    }

    //

    _sendStatusRequests() {
        if (!this.connection.isConnected()) {
            this.display.log('Skipping status requests (not connected)');
            return;
        }

        this.display.log('Sending status requests...');
        this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.POSITION_REQUEST), { qos: 2 });
        this.ackFlags.robot_status = true;
        this.connection.publish(
            `${this.connection.getRobotMac()}/CMD_ROBOT`,
            elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.STATUS_REQUEST, elements.encodeRobotStatusRequestTypes({ battery: true, mowing: true, location: true, network: true })),
            {
                qos: 2,
            }
        );
        this.ackFlags.base_status = true;
        this.connection.publish(`${this.connection.getBaseMac()}/CMD_REFERENCE`, elements.encodeBaseCommand(elements.BASE_COMMAND_IDS.STATUS_REQUEST, elements.encodeBaseStatusRequestTypes({ location: true, network: true })), { qos: 2 });
    }

    _sendVersionRequests() {
        if (!this.connection.isConnected()) {
            this.display.log('Skipping version requests (not connected)');
            return;
        }

        this.display.log('Sending version requests...');
        this.ackFlags.robot_version = true;
        this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.VERSION_REQUEST), { qos: 2 });
        this.ackFlags.base_version = true;
        this.connection.publish(`${this.connection.getBaseMac()}/CMD_REFERENCE`, elements.encodeBaseCommand(elements.BASE_COMMAND_IDS.VERSION_REQUEST), { qos: 2 });
    }

    _sendSettingsRequests() {
        if (!this.connection.isConnected()) {
            this.display.log('Skipping settings requests (not connected)');
            return;
        }

        this.display.log('Sending settings requests...');
        this.ackFlags.robot_schedule = true;
        this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.SCHEDULING_SETTINGS_REQUEST), { qos: 2 });
    }

    _sendAck(topic) {
        this.connection.publish(topic, elements.encodeMessageAck(), { qos: 2 });
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = MonitorProcessor;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
