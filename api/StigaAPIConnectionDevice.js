// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const mqtt = require('mqtt');

const { formatHexDump } = require('./StigaAPIUtilitiesFormat');
const { getCertificates } = require('./StigaAPICertificates');
const StigaAPIConnectionMQTT = require('./StigaAPIConnectionMQTT');
const StigaAPIComponent = require('./StigaAPIComponent');

// XXX needs to be refactored to use StigaAPIConnectionMQTT

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const PUBLISH_OPTIONS_DEFAULT = { qos: 2, retain: false };
const SUBSCRIBE_OPTIONS_DEFAULT = { qos: 0 };

const CONNECTION_TIMEOUT_PERIOD_DEFAULT = 10 * 1000;
const CONNECTION_RECONNECT_PERIOD_DEFAULT = 5 * 1000;

const COMMAND_PUBLISH_OPTIONS_DEFAULT = { qos: 2 };

const COMMAND_TIMEOUT_PERIOD = 15 * 1000;
const COMMAND_TIMEOUT_CHECK = 5 * 1000;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIConnectionDevice extends StigaAPIComponent {
    constructor(auth, brokerId, options = {}) {
        super(options);

        this.auth = auth;
        this.client = undefined;
        this.connected = false;

        this.pendingCommands = new Map(); // messageId -> { topic, expectAck, expectResponse, timestamp }
        this.nextMessageId = 1;

        this.broker = StigaAPIConnectionMQTT.getBrokerURL(brokerId);
        const certs = getCertificates(brokerId);
        this.options = {
            cert: Buffer.from(certs.cert),
            key: Buffer.from(certs.key),
            rejectUnauthorized: false,
            username: StigaAPIConnectionMQTT.getBrokerUsername(),
            password: '', // Will be set from auth token
            clientId: '', // Will be set per device
            clean: true,
            reconnectPeriod: CONNECTION_RECONNECT_PERIOD_DEFAULT,
            ...options,
        };
        this.startCleanupTimer();
    }

    async authenticate() {
        if (await this.auth.isValid()) {
            this.options.password = StigaAPIConnectionMQTT.getBrokerPassword(this.auth);
            return true;
        }
        this.display.error('connection: authentication failed');
        return false;
    }

    async connect(clientId) {
        if (this.connected || this.client) {
            this.display.error('connection: mqtt broker already connected');
            return true;
        }
        try {
            this.options.clientId = clientId;
            if (!(await this.authenticate())) return false;
            this.display.debug(`connection: mqtt broker connection request (client=${clientId}, broker=${this.broker})`);
            return new Promise((resolve, reject) => {
                let connected = false;
                this.client = mqtt.connect(this.broker, this.options);
                this.client.on('connect', () => {
                    this.display.debug(`connection: mqtt broker connection success`);
                    this.connected = true;
                    if (!connected) {
                        connected = true;
                        resolve(true);
                    }
                });
                this.client.on('reconnect', async () => {
                    this.display.debug('connection: mqtt broker connection retry');
                    if ((await this.authenticate()) && this.client.options) this.client.options.password = this.options.password;
                });
                this.client.on('error', (err) => {
                    this.display.error('connection: mqtt broker connection error:', err);
                    this.connected = false;
                    if (!connected) reject(err);
                    this.authenticate().then(() => {
                        this.display.error('connection: mqtt broker authentication updated');
                    });
                });
                this.client.on('close', () => {
                    this.display.debug('connection: mqtt broker connection closed');
                    this.connected = false;
                });
                this.client.on('message', (topic, message) => {
                    this._handleMessage(topic, message);
                });
                setTimeout(() => {
                    if (!connected) {
                        this.client.end();
                        reject(new Error('Connection timeout'));
                    }
                }, CONNECTION_TIMEOUT_PERIOD_DEFAULT);
            });
        } catch (e) {
            this.display.error(`connection: mqtt broker connection failure:`, e);
            return false;
        }
    }

    _checkConnected() {
        if (!this.connected || !this.client) {
            this.display.error('connection: mqtt broker not connected');
            return false;
        }
        return true;
    }

    subscribe(topic, callback, options = {}) {
        if (!this._checkConnected()) return false;

        const subOptions = { ...SUBSCRIBE_OPTIONS_DEFAULT, ...options };

        this.display.debug(`connection: mqtt broker subscribe (topic='${topic}') request`);
        this.client.subscribe(topic, subOptions, (err) => {
            if (err) this.display.error(`connection: mqtt broker subscribe (topic='${topic}') failure:`, err);
            else this.display.debug(`connection: mqtt broker subscribe (topic='${topic}') success`);
        });
        if (callback) this.on(`mqtt:${topic}`, callback);
        return true;
    }

    unsubscribe(topic) {
        if (!this._checkConnected()) return false;

        this.display.debug(`connection: mqtt broker unsubscribe (topic='${topic}') request`);

        this.client.unsubscribe(topic, (err) => {
            if (err) this.display.error(`connection: mqtt broker unsubscribe (topic='${topic}') failure:`, err);
            else this.display.debug(`connection: mqtt broker unsubscribe (topic='${topic}') success`);
        });

        // Remove associated event listeners
        this.removeAllListeners(`mqtt:${topic}`);

        return true;
    }

    publish(topic, message, options = {}) {
        if (!this._checkConnected()) return false;

        const pubOptions = { ...PUBLISH_OPTIONS_DEFAULT, ...options };

        this.display.debug(`connection: mqtt broker publish (topic='${topic}') request`);
        this.display.debug(message);
        this.client.publish(topic, message, pubOptions, (err) => {
            if (err) this.display.error(`connection: mqtt broker publish (topic='${topic}') failure:`, err);
            else this.display.debug(`connection: mqtt broker publish (topic='${topic}') success`);
        });
        return true;
    }

    sendCommand(topic, payload, expectAck = true, expectResponse = undefined) {
        if (!this._checkConnected()) return undefined;

        const messageId = this.nextMessageId++;

        let commandType;
        if (payload.length >= 2) commandType = payload[1]; // The second byte is usually the command sub-type

        this.pendingCommands.set(messageId, {
            topic,
            expectAck,
            expectResponse,
            timestamp: Date.now(),
            messageId,
            commandType,
        });

        this.publish(topic, payload, COMMAND_PUBLISH_OPTIONS_DEFAULT);

        return messageId;
    }

    _handleMessage(topic, message) {
        this.display.debug(`connection: received (${topic}):`);
        this.display.debug(formatHexDump(message, '  ').join('\n'));
        if (topic.includes('_ACK/')) this._handleAck(topic, message);
        else if (topic.includes('/LOG/')) this._handleResponse(topic, message);
        this._emitMessage(topic, message);
    }

    // XXX not just CMD_REFERENCE
    _handleAckUnknown(topic, _message) {
        this.display.debug(`connection: external ACK unmatched (${topic})`);
    }

    // XXX not just CMD_REFERENCE ... should propagate unhandled acks if they are being listened to
    _handleAck(topic, message) {
        let ackFound = false;

        let ackedCommand;
        if (message.length >= 3) if (message[0] === 0x20 && message[1] === 0x08) ackedCommand = message[2];
        for (const [messageId, pending] of this.pendingCommands.entries()) {
            if (pending.expectAck && this._isAckFor(topic, pending.topic)) {
                if (ackedCommand !== undefined && pending.commandType !== undefined) if (ackedCommand !== pending.commandType) continue; // This ACK is not for this command
                this.display.debug(`connection: command ACK (messageId='${messageId}')`);
                if (pending.expectResponse) pending.ackReceived = true;
                else this.pendingCommands.delete(messageId);
                ackFound = true;
                break;
            }
        }

        if (!ackFound) {
            if (message.length >= 3 && message[0] === 0x20 && message[1] === 0x08) {
                const ackedCmd = message[2];
                if (ackedCmd === 0x06)
                    this.display.error(`connection: external ACK (START PUBLISHING GPS CORRECTIONS)`); // XXX
                else if (ackedCmd === 0x07)
                    this.display.error(`connection: external ACK (STOP PUBLISHING GPS CORRECTIONS)`); // XXX
                else this._handleAckUnknown(topic, message);
            } else this._handleAckUnknown(topic, message);
        }
    }

    _handleResponse(topic, _message) {
        for (const [messageId, pending] of this.pendingCommands.entries())
            if (pending.expectResponse && topic.includes(pending.expectResponse)) {
                this.display.debug(`connection: command response received (messageId='${messageId}', topic='${topic}')`);
                const ackTopic = `${topic}/ACK`,
                    ackPayload = Buffer.from([0x00]); // Empty ACK
                this.publish(ackTopic, ackPayload, COMMAND_PUBLISH_OPTIONS_DEFAULT);
                this.pendingCommands.delete(messageId);
                break;
            }
    }

    _isAckFor(ackTopic, commandTopic) {
        // XXX fix
        const parts = commandTopic.split('/');
        const mac = parts[0] === 'FC:E8:C0:72:EC:62' ? parts[0] : parts[parts.length - 1];
        return ackTopic.includes(mac);
    }

    _emitMessage(topic, message) {
        // XXX incorrect?
        let emitted = false;
        for (const eventName of this.eventNames())
            if (eventName.startsWith('mqtt:') && this._topicMatches(eventName.slice(5), topic)) {
                this.emit(eventName, topic, message);
                emitted = true;
            }
        if (!emitted) this.emit(`mqtt:${topic}`, topic, message);
    }

    startCleanupTimer() {
        setInterval(() => {
            const expiryTime = Date.now() - COMMAND_TIMEOUT_PERIOD;
            for (const [messageId, pending] of this.pendingCommands.entries())
                if (pending.timestamp < expiryTime) {
                    this.display.error(`connection: command response timeout (messageId='${messageId}')`);
                    this.pendingCommands.delete(messageId);
                }
        }, COMMAND_TIMEOUT_CHECK);
    }

    disconnect() {
        if (this.client) {
            this.client.end();
            this.connected = false;
        }
    }

    isConnected() {
        return this.connected;
    }

    _topicMatches(pattern, topic) {
        const regex = pattern
            .split('/')
            .map((part) => {
                if (part === '+') return '[^/]+';
                else if (part === '#') return '.*';
                else return part.replaceAll(/[$()*+.?[\\\]^{|}]/g, '\\$&');
            })
            .join('/');
        return new RegExp(`^${regex}$`).test(topic);
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIConnectionDevice;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
