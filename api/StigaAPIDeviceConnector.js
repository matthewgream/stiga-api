// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { protobufDecode, stringToBytes } = require('./StigaAPIUtilitiesProtobuf');
const { formatHexDump } = require('./StigaAPIUtilitiesFormat');
const {
    ROBOT_MESSAGE_TOPICS,
    ROBOT_COMMAND_TOPICS,
    ROBOT_COMMAND_TYPES,
    ROBOT_COMMAND_IDS,
    decodeRobotCommandType,
    decodeRobotCommandAckResult,
    encodeRobotCommand,
    encodeRobotCloudSync,
    encodeRobotForceCut,
    encodeRobotGoAway,
    encodeRobotStatusRequestTypes,
    encodeRobotSettings,
    encodeRobotScheduleSettings,
    encodeRobotZoneSettings,
    encodeRobotZoneOrder,
    decodeVersion,
    decodeRobotStatusType,
    decodeRobotStatusError,
    decodeRobotStatusInfo,
    decodeRobotStatusDocking,
    decodeRobotBatteryStatus,
    decodeRobotMowingStatus,
    decodeLocationStatus,
    decodeNetworkStatus,
    decodeRobotPosition,
    decodeRobotSettings,
    decodeRobotScheduleSettings,
    // decodeRobotZoneSettings,
    // decodeRobotZoneOrder,
} = require('./StigaAPIElements');
const StigaAPIComponent = require('./StigaAPIComponent');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 5000;
const STATUS_REQUEST_CACHE_TIME = 1000; // 1 second cache for status requests
const COMMAND_RATE_LIMITS = {
    STATUS_REQUEST: 1000, // 1 second between status requests
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIDeviceConnector extends StigaAPIComponent {
    constructor(device, deviceConnection, options = {}) {
        super(options);
        this.device = device;
        this.connection = deviceConnection;
        this.macAddress = device.getMacAddress();
        this.subscriptions = [];
        this.ourCommands = new Set();
        this.pendingRequests = new Map();
        this.lastStatusRequest = new Map();
        this.lastResponseTime = new Map();
        this.pendingRateLimits = new Map();
        // Explicit override for the RTK reference position; if unset, falls back
        // to the device's lastPosition (from cloud) at decode time.
        this.referencePosition = options.referencePosition;
        this.device.installConnector('mqtt', this);
        this.debug = Boolean(options.debug);
    }

    setReferencePosition(position) {
        this.referencePosition = position;
    }
    _getReferencePosition() {
        return this.referencePosition ?? this.device.getReferencePosition();
    }

    destroy() {
        this._unsubscribeFromTopics();
        this.device.uninstallConnector('mqtt');
        this.removeAllListeners();
    }

    async listen() {
        const deviceUuid = await this.device.getUuid();
        if (!this.connection.isConnected())
            if (!(await this.connection.connect(deviceUuid.value))) {
                this.display.error(`connectedDevice ${this.macAddress}: failed to connect to MQTT broker`);
                return false;
            }
        return this._subscribeToTopics();
    }

    provides(key) {
        return ['version', 'statusOperation', 'statusBattery', 'statusMowing', 'statusLocation', 'statusNetwork', 'statusAll', 'position', 'settings', 'scheduleSettings', 'zoneSettings', 'zoneOrder'].includes(key);
    }

    //

    _subscribeToTopics() {
        const subscriptions = [
            {
                topic: ROBOT_MESSAGE_TOPICS.CMD_ROBOT(this.macAddress),
                handler: (topic, message) => this._handleMessageCommandReq(topic, message),
            },
            {
                topic: ROBOT_MESSAGE_TOPICS.CMD_ROBOT_ACK(this.macAddress),
                handler: (topic, message) => this._handleMessageCommandAck(topic, message),
            },
            {
                topic: ROBOT_MESSAGE_TOPICS.LOG(this.macAddress),
                handler: (topic, message) => this._handleMessageLog(topic, message),
            },
            {
                topic: ROBOT_MESSAGE_TOPICS.JSON_NOTIFICATION(this.macAddress),
                handler: (topic, message) => this._handleMessageJsonNotification(topic, message),
            },
        ];
        subscriptions.forEach(({ topic, handler }) => this.connection.subscribe(topic, handler) && this.subscriptions.push(topic));
        this.display.debug(`connectedDevice ${this.macAddress}: subscribed to ${this.subscriptions.length} of ${subscriptions.length} topics`);
        return this.subscriptions.length === subscriptions.length;
    }
    _unsubscribeFromTopics() {
        for (const topic of this.subscriptions) this.connection.unsubscribe(topic);
        this.display.debug(`connectedDevice ${this.macAddress}: unsubscribed from ${this.subscriptions.length} topics`);
        this.subscriptions = [];
    }

    //

    _handleMessageCommandAck(topic, message) {
        const decoded = protobufDecode(message);
        const commandTypeId = decoded?.[1] ?? 0;
        const commandType = decodeRobotCommandType(commandTypeId);
        const result = decodeRobotCommandAckResult(decoded?.[2]);
        this.display.debug(`connectedDevice ${this.macAddress}: ACK for ${commandType}: ${result}`);
        for (const [requestId, pending] of this.pendingRequests.entries()) {
            if (requestId === 'command' && pending.commandType === commandTypeId) {
                const { resolve } = this.pendingRequests.get(requestId);
                this.pendingRequests.delete(requestId);
                resolve(result === 'OK');
                break;
            }
        }
    }
    _handleMessageCommandReq(topic, message) {
        const messageHash = message.toString('hex');
        if (this.ourCommands.has(messageHash)) {
            this.ourCommands.delete(messageHash);
            return;
        }
        const decoded = protobufDecode(message);
        const commandType = decodeRobotCommandType(decoded?.[1], true);
        if (commandType === undefined) {
            this.display.error(`connectedDevice ${this.macAddress}: unknown command: '${decodeRobotCommandType(decoded?.[1])}':`);
            this.display.error(formatHexDump(message, '  ').join('\n'));
        } else this.display.debug(`connectedDevice ${this.macAddress}: external command: '${commandType}'`);
    }
    _handleMessageJsonNotification(topic, message) {
        this.display.debug(`connectedDevice ${this.macAddress}: received JSON message on ${topic}`);
        try {
            const notification = JSON.parse(message.toString());
            this.display.debug(notification);
            this.emit('notification', notification);
        } catch (e) {
            this.display.error(`connectedDevice ${this.macAddress}: JSON decode error:`, e);
        }
    }
    _handleMessageLog(topic, message) {
        const decoded = protobufDecode(message);
        const messageType = topic.split('/').pop();
        switch (messageType) {
            case 'VERSION':
                this._handleVersion(decoded);
                break;
            case 'STATUS':
                this._handleStatus(decoded);
                break;
            case 'SETTINGS':
                this._handleSettings(decoded);
                break;
            case 'SCHEDULING_SETTINGS':
                this._handleScheduleSettings(decoded);
                break;
            case 'ROBOT_POSITION':
                this._handlePosition(decoded);
                break;
            default:
                this.display.error(`connectedDevice ${this.macAddress}: LOG message unknown: ${messageType}`);
        }
    }

    //

    _handleVersion(decoded) {
        const version = decodeVersion(decoded);
        this.emit('version', version);
        this._commandResponseResolve('version', version);
    }
    _handleStatus(decoded) {
        this.lastResponseTime.set('STATUS_REQUEST', Date.now());
        const statusData = {
            valid: decoded[1] === 1,
            type: decodeRobotStatusType(decoded[3]),
            error: decodeRobotStatusError(decoded[4]),
            flag: decoded[5],
            info: decodeRobotStatusInfo(decoded[10]),
            docking: decodeRobotStatusDocking(decoded[13]),
            battery: decodeRobotBatteryStatus(decoded[17]),
            mowing: decodeRobotMowingStatus(decoded[18]),
            location: decodeLocationStatus(decoded[19]),
            network: decodeNetworkStatus(decoded[20]),
        };
        const operation = {
            valid: statusData.valid,
            type: statusData.type,
            error: statusData.error,
            flag: statusData.flag,
            info: statusData.info,
            docking: statusData.docking,
        };
        this.emit('statusOperation', operation);
        if (statusData.battery) this.emit('statusBattery', statusData.battery);
        if (statusData.mowing) this.emit('statusMowing', statusData.mowing);
        if (statusData.location) this.emit('statusLocation', statusData.location);
        if (statusData.network) this.emit('statusNetwork', statusData.network);
        this._commandResponseResolve('statusOperation', operation);
        this._commandResponseResolve('statusBattery', statusData.battery);
        this._commandResponseResolve('statusMowing', statusData.mowing);
        this._commandResponseResolve('statusLocation', statusData.location);
        this._commandResponseResolve('statusNetwork', statusData.network);
        this._commandResponseResolve('statusAll', statusData);
    }
    _handleSettings(decoded) {
        const settings = decodeRobotSettings(decoded);
        this.emit('settings', settings);
        this._commandResponseResolve('settings', settings);
    }
    _handleScheduleSettings(decoded) {
        const scheduleSettings = decodeRobotScheduleSettings({ ...decoded, 2: stringToBytes(decoded[2] || '') });
        this.emit('scheduleSettings', scheduleSettings);
        this._commandResponseResolve('scheduleSettings', scheduleSettings);
    }
    _handlePosition(decoded) {
        const position = decodeRobotPosition(decoded, this._getReferencePosition());
        this.emit('position', position);
        this._commandResponseResolve('position', position);
    }

    //

    async _commandResponsePromise(name, timeout = DEFAULT_TIMEOUT, commandType = undefined) {
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                if (this.pendingRequests.has(name)) {
                    this.pendingRequests.delete(name);
                    reject(new Error(`Timeout waiting for '${name}' response`));
                }
            }, timeout);
            this.pendingRequests.set(name, { resolve, reject, commandType, timeoutId });
        });
    }
    _commandResponseResolve(name, data) {
        if (this.pendingRequests.has(name)) {
            const { resolve, timeoutId } = this.pendingRequests.get(name);
            if (timeoutId) clearTimeout(timeoutId);
            this.pendingRequests.delete(name);
            resolve(data);
        }
    }
    async _commandRequest(commandType, params = undefined, expectResponse = undefined, resultName = undefined) {
        const commandName = ROBOT_COMMAND_TYPES[commandType];
        const rateLimit = COMMAND_RATE_LIMITS[commandName];
        if (rateLimit) {
            const lastResponseTime = this.lastResponseTime.get(commandName);
            if (lastResponseTime) {
                const timeSinceLastResponse = Date.now() - lastResponseTime;
                if (timeSinceLastResponse < rateLimit) {
                    const waitTime = rateLimit - timeSinceLastResponse;
                    this.display.debug(`connectedDevice ${this.macAddress}: rate limiting ${commandName}, waiting ${waitTime}ms since last response`);
                    await new Promise((resolve) => setTimeout(resolve, waitTime));
                }
            }
        }
        const topic = ROBOT_MESSAGE_TOPICS.CMD_ROBOT(this.macAddress);
        const payload = encodeRobotCommand(commandType, params);
        if (!payload) throw new Error(`Failed to encode command ${commandType}`);
        this.ourCommands.add(payload.toString('hex'));
        this.connection.sendCommand(topic, payload, true, expectResponse);
        return resultName ? this._commandResponsePromise(resultName, DEFAULT_TIMEOUT, commandType) : undefined;
    }
    _shouldMakeStatusRequest(types) {
        const now = Date.now();
        const requestKey = Object.keys(types).sort().join(',');
        const lastRequest = this.lastStatusRequest.get(requestKey);
        if (lastRequest && now - lastRequest < STATUS_REQUEST_CACHE_TIME) {
            this.display.debug(`connectedDevice ${this.macAddress}: skipping duplicate status request (${requestKey}) within ${STATUS_REQUEST_CACHE_TIME}ms`);
            return false;
        }
        this.lastStatusRequest.set(requestKey, now);
        return true;
    }

    //

    async getVersion() {
        return this._commandRequest(ROBOT_COMMAND_IDS.VERSION_REQUEST, undefined, ROBOT_COMMAND_TOPICS.VERSION, 'version');
    }
    async getStatusOperation() {
        return this._shouldMakeStatusRequest({}) ? this._commandRequest(ROBOT_COMMAND_IDS.STATUS_REQUEST, encodeRobotStatusRequestTypes({}), ROBOT_COMMAND_TOPICS.STATUS, 'statusOperation') : undefined;
    }
    async getStatusBattery() {
        return this._shouldMakeStatusRequest({ battery: true }) ? this._commandRequest(ROBOT_COMMAND_IDS.STATUS_REQUEST, encodeRobotStatusRequestTypes({ battery: true }), ROBOT_COMMAND_TOPICS.STATUS, 'statusBattery') : undefined;
    }
    async getStatusMowing() {
        return this._shouldMakeStatusRequest({ mowing: true }) ? this._commandRequest(ROBOT_COMMAND_IDS.STATUS_REQUEST, encodeRobotStatusRequestTypes({ mowing: true }), ROBOT_COMMAND_TOPICS.STATUS, 'statusMowing') : undefined;
    }
    async getStatusLocation() {
        return this._shouldMakeStatusRequest({ location: true }) ? this._commandRequest(ROBOT_COMMAND_IDS.STATUS_REQUEST, encodeRobotStatusRequestTypes({ location: true }), ROBOT_COMMAND_TOPICS.STATUS, 'statusLocation') : undefined;
    }
    async getStatusNetwork() {
        return this._shouldMakeStatusRequest({ network: true }) ? this._commandRequest(ROBOT_COMMAND_IDS.STATUS_REQUEST, encodeRobotStatusRequestTypes({ network: true }), ROBOT_COMMAND_TOPICS.STATUS, 'statusNetwork') : undefined;
    }
    async getStatusAll() {
        const types = { battery: true, mowing: true, location: true, network: true };
        return this._shouldMakeStatusRequest(types) ? this._commandRequest(ROBOT_COMMAND_IDS.STATUS_REQUEST, encodeRobotStatusRequestTypes(types), ROBOT_COMMAND_TOPICS.STATUS, 'statusAll') : undefined;
    }
    async getPosition() {
        return this._commandRequest(ROBOT_COMMAND_IDS.POSITION_REQUEST, undefined, ROBOT_COMMAND_TOPICS.ROBOT_POSITION, 'position');
    }
    async getSettings() {
        return this._commandRequest(ROBOT_COMMAND_IDS.SETTINGS_REQUEST, undefined, ROBOT_COMMAND_TOPICS.SETTINGS, 'settings');
    }
    async getScheduleSettings() {
        return this._commandRequest(ROBOT_COMMAND_IDS.SCHEDULING_SETTINGS_REQUEST, undefined, ROBOT_COMMAND_TOPICS.SCHEDULING_SETTINGS, 'scheduleSettings');
    }
    async getZoneSettings() {
        // No MQTT read path exists for per-zone settings (no ZONE_SETTINGS log topic, and there is no
        // zone-settings REQUEST command). Per-zone settings are read from the cloud perimeter instead
        // — see StigaAPIPerimeters.getZoneSettings().
        this.display.error(`connectedDevice ${this.macAddress}: getZoneSettings unavailable over MQTT — read from StigaAPIPerimeters`);
        return undefined;
    }
    async getZoneOrder() {
        // Zone order might come from cloud sync or another source
        this.display.error(`connectedDevice ${this.macAddress}: getZoneOrder not fully implemented`);
        return undefined;
    }
    async setSettings(settings) {
        return this._commandRequest(ROBOT_COMMAND_IDS.SETTINGS_UPDATE, encodeRobotSettings(settings), undefined, 'settings');
    }
    async setScheduleSettings(scheduleSettings) {
        return this._commandRequest(ROBOT_COMMAND_IDS.SCHEDULING_SETTINGS_UPDATE, encodeRobotScheduleSettings(scheduleSettings), undefined, 'scheduleSettings');
    }
    // Push a full per-zone settings record to the robot for immediate application (CMD_ROBOT cmd 7,
    // type 3). encodeRobotZoneSettings returns the [2] payload bytes (angle as FIXED32); the robot
    // ACKs with result OK. Does not persist to the cloud — StigaAPIPerimeters.setZoneSettings pairs
    // this with the cloud write. Verified byte-exact against a live capture (2026-06-05).
    async setZoneSettings(zoneSettings) {
        return this._commandRequest(ROBOT_COMMAND_IDS.ZONE_SETTINGS_UPDATE, encodeRobotZoneSettings(zoneSettings), undefined, 'zoneSettings');
    }
    async setZoneOrder(zoneOrder) {
        return this._commandRequest(ROBOT_COMMAND_IDS.ZONE_ORDER_UPDATE, encodeRobotZoneOrder(zoneOrder), undefined, 'zoneOrder');
    }

    //

    async sendStart() {
        return this._commandRequest(ROBOT_COMMAND_IDS.START, undefined, undefined, 'command');
    }
    async sendStop() {
        return this._commandRequest(ROBOT_COMMAND_IDS.STOP, undefined, undefined, 'command');
    }
    async sendGoHome() {
        return this._commandRequest(ROBOT_COMMAND_IDS.GO_HOME, undefined, undefined, 'command');
    }
    async sendCalibrateDocking() {
        return this._commandRequest(ROBOT_COMMAND_IDS.CALIBRATE_DOCKING, undefined, undefined, 'command');
    }
    async sendCalibrateBlades() {
        return this._commandRequest(ROBOT_COMMAND_IDS.CALIBRATE_BLADES, undefined, undefined, 'command');
    }
    async sendCloudSync(auth, url) {
        return this._commandRequest(ROBOT_COMMAND_IDS.CLOUDSYNC_DOWNLOAD, encodeRobotCloudSync({ auth, url }), undefined, 'command');
    }
    async sendForceCut(zone) {
        return this._commandRequest(ROBOT_COMMAND_IDS.FORCE_CUT, encodeRobotForceCut(zone), undefined, 'command');
    }
    async sendForceBorderCut(zone) {
        return this._commandRequest(ROBOT_COMMAND_IDS.FORCE_BORDER_CUT, encodeRobotForceCut(zone), undefined, 'command');
    }
    async sendGoAway(auth, url, { east, north, radius, expirySeconds }) {
        return this._commandRequest(ROBOT_COMMAND_IDS.GO_AWAY, encodeRobotGoAway({ east, north, radius, expirySeconds, auth, url }), undefined, 'command');
    }
    async sendResetError() {
        return this._commandRequest(ROBOT_COMMAND_IDS.RESET_ERROR, undefined, undefined, 'command');
    }

    //

    getMacAddress() {
        return this.macAddress;
    }
    getSubscriptions() {
        return this.subscriptions;
    }
    isConnected() {
        return this.connection && this.connection.isConnected();
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIDeviceConnector;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
