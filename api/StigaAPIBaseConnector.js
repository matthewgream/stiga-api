// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { protobufDecode } = require('./StigaAPIUtilitiesProtobuf');
const { formatHexDump } = require('./StigaAPIUtilitiesFormat');
const {
    BASE_MESSAGE_TOPICS,
    BASE_COMMAND_TOPICS,
    BASE_COMMAND_TYPES,
    BASE_COMMAND_IDS,
    encodeBaseCommand,
    decodeBaseCommandType,
    decodeBaseCommandAckResult,
    encodeBaseStatusRequestTypes,
    encodeBaseSettingLED,
    decodeBaseaMessageVersion,
    decodeBaseMessageStatus,
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

class StigaAPIBaseConnector extends StigaAPIComponent {
    constructor(base, deviceConnection, options = {}) {
        super(options);
        this.base = base;
        this.connection = deviceConnection;
        this.macAddress = base.getMacAddress();
        this.subscriptions = [];
        this.ourCommands = new Set();
        this.pendingRequests = new Map();
        this.lastStatusRequest = new Map();
        this.lastResponseTime = new Map();
        this.pendingRateLimits = new Map();
        if (options.referencePosition) this.base.setReferencePosition(options.referencePosition);
        this.base.installConnector('mqtt', this);
    }

    destroy() {
        this._unsubscribeFromTopics();
        this.base.uninstallConnector('mqtt');
        this.removeAllListeners();
    }

    async listen() {
        const baseUuid = await this.base.getUuid();
        if (!this.connection.isConnected()) {
            if (!(await this.connection.connect(baseUuid.value))) {
                this.display.error(`connectedBase ${this.macAddress}: failed to connect to MQTT broker`);
                return false;
            }
        }
        return this._subscribeToTopics();
    }

    provides(key) {
        return ['version', 'statusOperation', 'statusLocation', 'statusNetwork', 'statusAll', 'ledSetting'].includes(key);
    }

    //

    _subscribeToTopics() {
        const subscriptions = [
            {
                topic: BASE_MESSAGE_TOPICS.CMD_REFERENCE(this.macAddress),
                handler: (topic, message) => this._handleMessageCommandReq(topic, message),
            },
            {
                topic: BASE_MESSAGE_TOPICS.CMD_REFERENCE_ACK(this.macAddress),
                handler: (topic, message) => this._handleMessageCommandAck(topic, message),
            },
            {
                topic: BASE_MESSAGE_TOPICS.LOG(this.macAddress),
                handler: (topic, message) => this._handleMessageLog(topic, message),
            },
            {
                topic: BASE_MESSAGE_TOPICS.JSON_NOTIFICATION(this.macAddress),
                handler: (topic, message) => this._handleMessageJsonNotification(topic, message),
            },
        ];
        subscriptions.forEach(({ topic, handler }) => this.connection.subscribe(topic, handler) && this.subscriptions.push(topic));
        this.display.debug(`connectedBase ${this.macAddress}: subscribed to ${this.subscriptions.length} of ${subscriptions.length} topics`);
        return this.subscriptions.length === subscriptions.length;
    }

    _unsubscribeFromTopics() {
        for (const topic of this.subscriptions) this.connection.unsubscribe(topic);
        this.display.debug(`connectedBase ${this.macAddress}: unsubscribed from ${this.subscriptions.length} topics`);
        this.subscriptions = [];
    }

    //

    _handleMessageCommandAck(topic, message) {
        const decoded = protobufDecode(message?.length > 2 && message[0] == 0x20 ? message.slice(1) : message);
        const commandType = decodeBaseCommandType(decoded?.[1]);
        const result = decodeBaseCommandAckResult(decoded?.[2]);
        this.display.debug(`connectedBase ${this.macAddress}: ACK for ${commandType}: ${result}`);
        for (const [requestId, pending] of this.pendingRequests.entries()) {
            if (pending.commandType === commandType) {
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
        const commandType = decodeBaseCommandType(decoded?.[1], true);
        if (commandType === undefined) {
            this.display.error(`connectedBase ${this.macAddress}: unknown command: '${decodeBaseCommandType(decoded?.[1])}':`);
            this.display.error(formatHexDump(message, '  ').join('\n'));
        } else this.display.debug(`connectedBase ${this.macAddress}: external command: '${commandType}'`);
    }
    _handleMessageJsonNotification(topic, message) {
        this.display.debug(`connectedBase ${this.macAddress}: received JSON message on ${topic}`);
        try {
            const notification = JSON.parse(message.toString());
            this.display.debug(notification);
            this.emit('notification', notification);
        } catch (e) {
            this.display.error(`connectedBase ${this.macAddress}: JSON decode error:`, e);
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
            default:
                this.display.error(`connectedBase ${this.macAddress}: LOG message unknown: ${messageType}`);
        }
    }

    _handleVersion(decoded) {
        const version = decodeBaseaMessageVersion(decoded);
        this.emit('version', version);
        this._commandResponseResolve('version', version);
    }
    _handleStatus(decoded) {
        const status = decodeBaseMessageStatus(decoded);
        const operation = {
            type: status.type,
            flag: status.flag,
        };
        this.emit('statusOperation', operation);
        if (status.location) this.emit('statusLocation', status.location);
        if (status.network) this.emit('statusNetwork', status.network);
        if (status.led !== undefined) this.emit('ledSetting', status.led);
        this._commandResponseResolve('statusOperation', operation);
        this._commandResponseResolve('statusLocation', status.location);
        this._commandResponseResolve('statusNetwork', status.network);
        this._commandResponseResolve('statusAll', status);
        this._commandResponseResolve('ledSetting', status.led);
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
        const commandName = BASE_COMMAND_TYPES[commandType];
        const rateLimit = COMMAND_RATE_LIMITS[commandName];
        if (rateLimit) {
            const lastResponseTime = this.lastResponseTime.get(commandName);
            if (lastResponseTime) {
                const timeSinceLastResponse = Date.now() - lastResponseTime;
                if (timeSinceLastResponse < rateLimit) {
                    const waitTime = rateLimit - timeSinceLastResponse;
                    this.display.debug(`connectedBase ${this.macAddress}: rate limiting ${commandName}, waiting ${waitTime}ms since last response`);
                    await new Promise((resolve) => setTimeout(resolve, waitTime));
                }
            }
        }
        const topic = BASE_MESSAGE_TOPICS.CMD_REFERENCE(this.macAddress);
        const payload = encodeBaseCommand(commandType, params);
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
            this.display.debug(`connectedBase ${this.macAddress}: skipping duplicate status request (${requestKey}) within ${STATUS_REQUEST_CACHE_TIME}ms`);
            return false;
        }
        this.lastStatusRequest.set(requestKey, now);
        return true;
    }
    //

    async getVersion() {
        return this._commandRequest(BASE_COMMAND_IDS.VERSION_REQUEST, undefined, BASE_COMMAND_TOPICS.VERSION, 'version');
    }
    async getStatusOperation() {
        return this._shouldMakeStatusRequest({}) ? this._commandRequest(BASE_COMMAND_IDS.STATUS_REQUEST, encodeBaseStatusRequestTypes({}), BASE_COMMAND_TOPICS.STATUS, 'statusOperation') : undefined;
    }
    async getStatusLocation() {
        return this._shouldMakeStatusRequest({ location: true }) ? this._commandRequest(BASE_COMMAND_IDS.STATUS_REQUEST, encodeBaseStatusRequestTypes({ location: true }), BASE_COMMAND_TOPICS.STATUS, 'statusLocation') : undefined;
    }
    async getStatusNetwork() {
        return this._shouldMakeStatusRequest({ network: true }) ? this._commandRequest(BASE_COMMAND_IDS.STATUS_REQUEST, encodeBaseStatusRequestTypes({ network: true }), BASE_COMMAND_TOPICS.STATUS, 'statusNetwork') : undefined;
    }
    async getStatusAll() {
        const types = { location: true, network: true };
        return this._shouldMakeStatusRequest(types) ? this._commandRequest(BASE_COMMAND_IDS.STATUS_REQUEST, encodeBaseStatusRequestTypes({ location: true, network: true }), BASE_COMMAND_TOPICS.STATUS, 'statusAll') : undefined;
    }
    async getLedSetting() {
        return this._commandRequest(BASE_COMMAND_IDS.STATUS_REQUEST, undefined, BASE_COMMAND_TOPICS.STATUS, 'ledSetting');
    }
    async setLedSetting(mode) {
        return this._commandRequest(BASE_COMMAND_IDS.SETTINGS_UPDATE, encodeBaseSettingLED(mode)); //, undefined, 'ledSetting');
    }
    async sendMode(mode) {
        return this._commandRequest(BASE_COMMAND_IDS.SET_MODE, { 1: mode });
    }
    async sendPublishStart() {
        return this._commandRequest(BASE_COMMAND_IDS.PUBLISH_START);
    }
    async sendPublishStop() {
        return this._commandRequest(BASE_COMMAND_IDS.PUBLISH_STOP);
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

module.exports = StigaAPIBaseConnector;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
