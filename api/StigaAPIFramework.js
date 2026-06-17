// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const StigaAPIAuthentication = require('./StigaAPIAuthentication');
const StigaAPIConnectionServer = require('./StigaAPIConnectionServer');
const StigaAPIConnectionDevice = require('./StigaAPIConnectionDevice');
const StigaAPIComponent = require('./StigaAPIComponent');
const StigaAPIElements = require('./StigaAPIElements');
const StigaAPIGarage = require('./StigaAPIGarage');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIFramework extends StigaAPIComponent {
    destroy() {
        this.deviceConnection?.disconnect();
    }

    async load(username, password) {
        this.display.verbose('Collecting authentication token...');
        this.auth = new StigaAPIAuthentication(username, password, undefined, undefined, { debug: this.debug, verbose: this.verbose });
        if (!(await this.auth.isValid())) {
            this.display.error('Authentication failed');
            return false;
        }

        this.display.verbose('Connecting to server...');
        const server = new StigaAPIConnectionServer(this.auth);
        if (!(await server.isConnected())) {
            this.display.error('Failed to connect to server');
            return false;
        }

        this.display.verbose('Loading garage data...');
        const garage = new StigaAPIGarage(server);
        if (!(await garage.load())) {
            this.display.error('Failed to load garage');
            return false;
        }

        this.devices = garage.getDevices();
        if (!this.devices || this.devices.length === 0) {
            this.display.error('No devices found');
            return false;
        }
        const [device] = this.devices;

        this.bases = garage.getBasesForDevice(device);
        if (!this.bases || this.bases.length === 0) {
            this.display.error('No bases found');
            return false;
        }
        const [base] = this.bases;

        this.display.verbose(`Garage has ${this.devices.length} devices and (${this.bases.length}) bases`);
        this.display.verbose(`Garage found device '${(await device.getName()).value}' (${device.getMacAddress()}) with base (${base.getMacAddress()})`);

        return true;
    }

    async connect() {
        const { device } = this.getDeviceAndBasePair();
        this.deviceConnection = new StigaAPIConnectionDevice(this.auth, (await device.getBrokerId()).value, { debug: false });
        return (await this.deviceConnection.connect((await device.getUuid()).value)) ? this.deviceConnection : undefined;
    }

    async listen(handler) {
        for (const topic of this.getListenTopics()) this.deviceConnection.subscribe(topic, handler);
    }

    getListenTopics() {
        const { device, base } = this.getDeviceAndBasePair();
        return [...StigaAPIElements.buildRobotMessageTopics(device?.getMacAddress()), ...StigaAPIElements.buildBaseMessageTopics(base?.getMacAddress())];
    }

    getDeviceAndBasePair() {
        const [device] = this.devices,
            [base] = this.bases;
        return { device, base };
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIFramework;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
