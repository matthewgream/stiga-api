// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// RequestPoller — one shared poller that periodically requests status/position/version/schedule
// from the robot and base, and acknowledges the LOG responses it solicited.
//
// Processors that need fresh device data (MonitorProcessor, WebStatusProcessor, …) share a
// single instance: each calls acquire() in start() and release() in stop(). The poller is
// reference counted — it begins polling on the first acquire and stops on the last release —
// so the requests go out exactly once regardless of how many processors are running.
//
// Processors still consume the data themselves by listening to connection 'message' events;
// the poller only owns the outbound request cadence (and the matching ACKs).
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIUtilities, StigaAPIElements: elements } = require('../../../api/StigaAPI');
const { protobufDecode } = StigaAPIUtilities;

const DEFAULT_TIMING_DOCKED = {
    version: 60 * 60 * 1000, // 60 minutes
    settings: 30 * 60 * 1000, // 30 minutes
    status: 5 * 60 * 1000, // 5 minutes
};

const DEFAULT_TIMING_UNDOCKED = {
    version: 30 * 60 * 1000, // 30 minutes
    settings: 5 * 60 * 1000, // 5 minutes
    status: 15 * 1000, // 15 seconds
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class RequestPoller {
    constructor(connection, options = {}) {
        this.connection = connection;
        this.logger = options.logger || console.log;
        this.timingDocked = { ...DEFAULT_TIMING_DOCKED, ...options.timingDocked };
        this.timingUndocked = { ...DEFAULT_TIMING_UNDOCKED, ...options.timingUndocked };
        this.currentTiming = this.timingDocked;
        this.isDocked = true;

        this.refCount = 0;
        this.timers = [];
        this.ackFlags = {};
        this._messageHandler = (topic, message) => this._handleMessage(topic, message);
    }

    // a processor declares it needs polled data; the first acquire starts the poller
    acquire() {
        this.refCount++;
        if (this.refCount === 1) this._start();
        return this;
    }

    // a processor no longer needs polled data; the last release stops the poller
    release() {
        if (this.refCount === 0) return;
        this.refCount--;
        if (this.refCount === 0) this._stop();
    }

    //

    _start() {
        this.connection.on('message', this._messageHandler);
        this._sendStatusRequests();
        this._sendVersionRequests();
        this._sendSettingsRequests();
        this._scheduleTimers();
        this.logger('RequestPoller started');
    }

    _stop() {
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        this.connection.off('message', this._messageHandler);
        this.logger('RequestPoller stopped');
    }

    _scheduleTimers() {
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [
            setInterval(() => this._sendStatusRequests(), this.currentTiming.status),
            setInterval(() => this._sendVersionRequests(), this.currentTiming.version),
            setInterval(() => this._sendSettingsRequests(), this.currentTiming.settings),
        ];
        this.logger(`RequestPoller timing: status=${this.currentTiming.status / 1000}s, version=${this.currentTiming.version / 60000}m, settings=${this.currentTiming.settings / 60000}m`);
    }

    //

    _handleMessage(topic, message) {
        if (topic.endsWith('ACK')) return;
        const isRobot = topic.includes(this.connection.getRobotMac());
        const isBase = topic.includes(this.connection.getBaseMac());

        // adaptive cadence: watch robot status for the docked flag and switch timing
        if (isRobot && topic.includes('/LOG/STATUS')) {
            try {
                const decoded = protobufDecode(message);
                const docked = elements.formatRobotStatusDocking(elements.decodeRobotStatusDocking(decoded[13])).startsWith('yes');
                if (docked !== this.isDocked) {
                    this.isDocked = docked;
                    this.currentTiming = docked ? this.timingDocked : this.timingUndocked;
                    this.logger(`RequestPoller: robot ${docked ? 'docked' : 'undocked'} - switching to ${docked ? 'docked' : 'undocked'} timing`);
                    if (this.timers.length > 0) this._scheduleTimers();
                }
            } catch {
                // not protobuf
            }
        }

        // acknowledge the LOG responses to the requests we solicited
        let flag;
        if (isRobot && topic.includes('/LOG/STATUS')) flag = 'robot_status';
        else if (isRobot && topic.includes('/LOG/VERSION')) flag = 'robot_version';
        else if (isRobot && topic.includes('/LOG/SCHEDULING_SETTINGS')) flag = 'robot_schedule';
        else if (isRobot && topic.includes('/LOG/SETTINGS')) flag = 'robot_settings';
        else if (isBase && topic.includes('/LOG/STATUS')) flag = 'base_status';
        else if (isBase && topic.includes('/LOG/VERSION')) flag = 'base_version';
        if (flag && this.ackFlags[flag]) {
            this.ackFlags[flag] = false;
            this.connection.publish(`${topic}/ACK`, elements.encodeMessageAck(), { qos: 2 });
        }
    }

    //

    _sendStatusRequests() {
        if (!this.connection.isConnected()) return;
        this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.POSITION_REQUEST), { qos: 2 });
        this.ackFlags.robot_status = true;
        this.connection.publish(
            `${this.connection.getRobotMac()}/CMD_ROBOT`,
            elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.STATUS_REQUEST, elements.encodeRobotStatusRequestTypes({ battery: true, mowing: true, location: true, network: true })),
            { qos: 2 }
        );
        this.ackFlags.base_status = true;
        this.connection.publish(`${this.connection.getBaseMac()}/CMD_REFERENCE`, elements.encodeBaseCommand(elements.BASE_COMMAND_IDS.STATUS_REQUEST, elements.encodeBaseStatusRequestTypes({ location: true, network: true })), { qos: 2 });
    }

    _sendVersionRequests() {
        if (!this.connection.isConnected()) return;
        this.ackFlags.robot_version = true;
        this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.VERSION_REQUEST), { qos: 2 });
        this.ackFlags.base_version = true;
        this.connection.publish(`${this.connection.getBaseMac()}/CMD_REFERENCE`, elements.encodeBaseCommand(elements.BASE_COMMAND_IDS.VERSION_REQUEST), { qos: 2 });
    }

    _sendSettingsRequests() {
        if (!this.connection.isConnected()) return;
        // Global settings (LOG/SETTINGS) — needed for the webstatus settings panel; the robot only
        // publishes these when solicited, so without this request the panel never populates.
        this.ackFlags.robot_settings = true;
        this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.SETTINGS_REQUEST), { qos: 2 });
        this.ackFlags.robot_schedule = true;
        this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.SCHEDULING_SETTINGS_REQUEST), { qos: 2 });
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = RequestPoller;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
