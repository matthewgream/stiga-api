// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIUtilities, StigaAPIElements: elements } = require('../../../api/StigaAPI');
const { protobufDecode, stringToBytes, formatMinutesNicely, formatNetworkId } = StigaAPIUtilities;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class MonitorProcessor {
    constructor(connectionManager, displayManager, options = {}) {
        this.connection = connectionManager;
        this.display = displayManager;
        this.location = options.location;
        if (!this.location) throw new Error('MonitorProcessor: options.location is required (RTK reference origin)');
        // status/version/schedule requests are driven by the shared RequestPoller
        this.poller = options.poller;
    }

    //

    async start() {
        this.connection.on('message', (topic, message) => this._handleMessage(topic, message));
        this.poller?.acquire();
        this.display.log('Monitor started');
    }

    async stop() {
        this.poller?.release();
        this.display.log('Monitor stopped');
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
        } else if (topic.includes('/LOG/STATUS')) {
            this.display.log('Robot status response received');
            this._updateRobotStatus(decoded);
        } else if (topic.includes('/LOG/SCHEDULING_SETTINGS')) {
            this.display.log('Robot scheduling settings received');
            this._updateRobotSchedule(decoded);
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
        } else if (topic.includes('/LOG/STATUS')) {
            this.display.log('Base status response received');
            this._updateBaseStatus(decoded);
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
        const rawType = elements.formatRobotStatusType(elements.decodeRobotStatusType(decoded[3]));
        const errorObj = elements.decodeRobotStatusError(decoded[4]);
        // When an ERROR carries a known (code1,code2) it's actually a transient state in
        // disguise (e.g. "GPS searching") — surface that as the operation label instead.
        const message = rawType === 'ERROR' && errorObj?.message ? errorObj.message : undefined;
        const updates = {
            statusType: message || rawType,
            statusText: '',
        };
        const statusInfo = elements.formatRobotStatusInfo(elements.decodeRobotStatusInfo(decoded[10])).replaceAll('-', '');
        const statusError = message ? '' : elements.formatRobotStatusError(errorObj).replaceAll('-', '');
        // eslint-disable-next-line sonarjs/no-nested-conditional
        updates.statusText = statusInfo || statusError ? `${statusInfo}${statusInfo && statusError ? ', ' : ''}${statusError}` : '-';
        updates.statusFlag = `(valid ${elements.formatRobotStatusValid(elements.decodeRobotStatusValid(decoded[1]))}, flag ${elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[2]))})`;
        updates.statusDocked = elements.formatRobotStatusDocking(elements.decodeRobotStatusDocking(decoded[13])).startsWith('yes') ? 'Docked' : 'Not docked';
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
        const location = elements.decodeLocationStatus(decoded);
        if (location) {
            // decoded[19]/[8] is GNSS/RTK quality, not a position — show satellites/coverage,
            // not a lat/lon. The robot's actual location is the separate 'Position:' line.
            data.locationPosition = `${location.satellites} satellites`;
            if (location.coverage) data.locationPosition += ` [${['GOOD', 'POOR', 'BAD', 'WORSE'][location.coverage]}]`;
            data.locationOffset = `RTK offset ${location.offsetDistance.toFixed(1)} cm`;
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
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = MonitorProcessor;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
