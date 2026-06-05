// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { formatStruct } = require('./StigaAPIUtilitiesFormat');
const StigaAPIComponent = require('./StigaAPIComponent');

const STALE_THRESHOLD_DEFAULT = 30 * 60 * 1000;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIDevice extends StigaAPIComponent {
    constructor(options = {}) {
        super(options);

        if (!options.macAddress) throw new Error('StigaAPIDevice: macAddress is required');
        this.macAddress = options.macAddress;
        this.connectors = new Map(); // name -> connector instance
        this._boundListeners = {};
        this.storage = {
            // Cloud/Garage data
            uuid: { value: undefined, _updated: undefined },
            name: { value: undefined, _updated: undefined },
            brokerId: { value: undefined, _updated: undefined },
            productCode: { value: undefined, _updated: undefined },
            serialNumber: { value: undefined, _updated: undefined },
            firmwareVersion: { value: undefined, _updated: undefined },
            deviceType: { value: undefined, _updated: undefined },
            baseUuid: { value: undefined, _updated: undefined },
            isEnabled: { value: undefined, _updated: undefined },
            totalWorkTime: { value: undefined, _updated: undefined },
            lastPosition: { value: undefined, _updated: undefined },
            // MQTT/Device data
            version: { value: undefined, _updated: undefined, _stale: 24 * 60 * 60 * 1000 },
            statusOperation: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 1 * 60 * 1000 },
            statusBattery: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 5 * 60 * 1000 },
            statusMowing: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 1 * 60 * 1000 },
            statusLocation: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 1 * 60 * 1000 },
            statusNetwork: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 5 * 60 * 1000 },
            statusAll: { value: undefined, _updated: undefined, _isBatch: true },
            position: { value: undefined, _updated: undefined, _stale: 1 * 60 * 1000 },
            settings: { value: undefined, _updated: undefined, _stale: 30 * 60 * 1000 },
            scheduleSettings: { value: undefined, _updated: undefined, _stale: 30 * 60 * 1000 },
            zoneSettings: { value: undefined, _updated: undefined, _stale: 30 * 60 * 1000 },
            zoneOrder: { value: undefined, _updated: undefined, _stale: 30 * 60 * 1000 },
        };
        this.staleThresholdDefault = options.staleThresholdDefault || STALE_THRESHOLD_DEFAULT;
        // Paired RTK reference station (set by Garage once relationships are known).
        this.pairedBase = undefined;
    }

    setPairedBase(base) {
        this.pairedBase = base;
    }
    getPairedBase() {
        return this.pairedBase;
    }
    // RTK reference origin. Sourced from paired base if known, otherwise the
    // device's own cloud lastPosition.
    getReferencePosition() {
        return this.pairedBase?.getReferencePosition() ?? this.storage.lastPosition.value;
    }

    //

    getMacAddress() {
        return this.macAddress;
    }

    //

    async getUuid(options = {}) {
        return this._dataGet('uuid', options);
    }
    async getName(options = {}) {
        return this._dataGet('name', options);
    }
    async getBrokerId(options = {}) {
        return this._dataGet('brokerId', options);
    }
    async getProductCode(options = {}) {
        return this._dataGet('productCode', options);
    }
    async getSerialNumber(options = {}) {
        return this._dataGet('serialNumber', options);
    }
    async getFirmwareVersion(options = {}) {
        return this._dataGet('firmwareVersion', options);
    }
    async getDeviceType(options = {}) {
        return this._dataGet('deviceType', options);
    }
    async getBaseUuid(options = {}) {
        return this._dataGet('baseUuid', options);
    }
    async getIsEnabled(options = {}) {
        return this._dataGet('isEnabled', options);
    }
    async getTotalWorkTime(options = {}) {
        return this._dataGet('totalWorkTime', options);
    }
    async getLastPosition(options = {}) {
        return this._dataGet('lastPosition', options);
    }
    async getVersion(options = {}) {
        return this._dataGet('version', options);
    }
    async getPosition(options = {}) {
        return this._dataGet('position', options);
    }

    //

    async getSettings(options = {}) {
        return this._dataGet('settings', options);
    }
    async setSettings(settings) {
        return this._setViaConnector('setSettings', settings);
    }
    async getScheduleSettings(options = {}) {
        return this._dataGet('scheduleSettings', options);
    }
    async setScheduleSettings(scheduleSettings) {
        return this._setViaConnector('setScheduleSettings', scheduleSettings);
    }
    // DEPRECATED: there is no MQTT read path for per-zone settings (no ZONE_SETTINGS log topic).
    // Per-zone settings are read from the cloud perimeter — use StigaAPIPerimeters.getZoneSettings()
    // / getAllZoneSettings(). Kept only to fail loudly rather than silently return undefined.
    async getZoneSettings() {
        throw new Error('getZoneSettings (MQTT) is not available — read per-zone settings from StigaAPIPerimeters.getZoneSettings()');
    }
    // Immediate per-zone push to the robot over MQTT (CMD_ROBOT cmd 7). `zoneSettings` is the FULL
    // zone record { zone, cuttingMode, cuttingHeight, priority, name, customAngleActive, customAngle,
    // borderCut, ... }. NOTE: this only updates the robot's live copy; it does NOT persist to the cloud
    // perimeter. To do both (persist + immediate, like the app), use StigaAPIPerimeters.setZoneSettings().
    async setZoneSettings(zoneSettings) {
        return this._setViaConnector('setZoneSettings', zoneSettings);
    }
    async getZoneOrder(options = {}) {
        return this._dataGet('zoneOrder', options);
    }
    async setZoneOrder(zoneOrder) {
        return this._setViaConnector('setZoneOrder', zoneOrder);
    }

    //

    async getStatusOperation(options = {}) {
        return this._dataGet('statusOperation', options);
    }
    async getStatusBattery(options = {}) {
        return this._dataGet('statusBattery', options);
    }
    async getStatusMowing(options = {}) {
        return this._dataGet('statusMowing', options);
    }
    async getStatusLocation(options = {}) {
        return this._dataGet('statusLocation', options);
    }
    async getStatusNetwork(options = {}) {
        return this._dataGet('statusNetwork', options);
    }
    async getStatusAll(options = {}) {
        if (options.refresh === 'force' || options.refresh === 'ifstale') await this.update('statusAll');
        return {
            operation: this.storage.statusOperation.value,
            battery: this.storage.statusBattery.value,
            mowing: this.storage.statusMowing.value,
            location: this.storage.statusLocation.value,
            network: this.storage.statusNetwork.value,
            _updated: Math.min(
                this.storage.statusOperation._updated || Infinity,
                this.storage.statusBattery._updated || Infinity,
                this.storage.statusMowing._updated || Infinity,
                this.storage.statusLocation._updated || Infinity,
                this.storage.statusNetwork._updated || Infinity
            ),
        };
    }

    //

    async sendStart() {
        return this._cmdViaConnector('sendStart');
    }
    async sendStop() {
        return this._cmdViaConnector('sendStop');
    }
    async sendGoHome() {
        return this._cmdViaConnector('sendGoHome');
    }
    async sendCalibrateBlades() {
        return this._cmdViaConnector('sendCalibrateBlades');
    }
    async sendCloudSync(auth, url) {
        return this._cmdViaConnector('sendCloudSync', auth, url);
    }
    async sendForceCut(zone) {
        return this._cmdViaConnector('sendForceCut', zone);
    }
    async sendForceBorderCut(zone) {
        return this._cmdViaConnector('sendForceBorderCut', zone);
    }
    async sendGoAway(auth, url, placement) {
        return this._cmdViaConnector('sendGoAway', auth, url, placement);
    }
    async sendResetError() {
        return this._cmdViaConnector('sendResetError');
    }
    async sendBoot() {
        return this._cmdViaConnector('sendBoot');
    }
    async sendCalibrateDocking() {
        return this._cmdViaConnector('sendCalibrateDocking');
    }

    //

    _dataUpdateAll(data, name) {
        let value;
        if ((value = data.getUuid()) !== undefined) this._dataUpdate('uuid', value, name);
        if ((value = data.getName()) !== undefined) this._dataUpdate('name', value, name);
        if ((value = data.getBrokerId()) !== undefined) this._dataUpdate('brokerId', value, name);
        if ((value = data.getProductCode()) !== undefined) this._dataUpdate('productCode', value, name);
        if ((value = data.getSerialNumber()) !== undefined) this._dataUpdate('serialNumber', value, name);
        if ((value = data.getFirmwareVersion()) !== undefined) this._dataUpdate('firmwareVersion', value, name);
        if ((value = data.getDeviceType()) !== undefined) this._dataUpdate('deviceType', value, name);
        if ((value = data.getBaseUuid()) !== undefined) this._dataUpdate('baseUuid', value, name);
        if ((value = data.getIsEnabled()) !== undefined) this._dataUpdate('isEnabled', value, name);
        if ((value = data.getTotalWorkTime()) !== undefined) this._dataUpdate('totalWorkTime', value, name);
        if ((value = data.getLastPosition()) !== undefined) this._dataUpdate('lastPosition', value, name);
    }
    _dataUpdate(key, value, source) {
        const oldValue = this.storage[key]?.value;
        this.storage[key] = { ...this.storage[key], value, _updated: Date.now() };
        if (oldValue !== value) {
            this.emit('dataUpdated', { key, value, oldValue, source });
            this.emit(key, value);
        }
        this.display.debug(`device ${this.macAddress}: updated ${key} from ${source} [${oldValue === value ? 'unchanged' : 'changed'}]`);
    }
    async _dataGet(key, options = {}) {
        let shouldRefresh = false;
        if (options.refresh === 'force') shouldRefresh = true;
        else if (options.refresh === 'ifstale') shouldRefresh = !this.storage[key]._updated || Date.now() - this.storage[key]._updated > (options.staleThreshold || this.storage[key]._stale || this.staleThresholdDefault);
        if (shouldRefresh) await this.update(key);
        return {
            value: this.storage[key].value,
            _updated: this.storage[key]._updated,
        };
    }

    async update(key = undefined) {
        await this._connectorsLoad(key);
        const keys = key === undefined ? this._getOptimizedKeysForUpdate() : [key];
        for (const k of keys) await this._connectorsUpdate(k);
    }

    _getOptimizedKeysForUpdate() {
        const allKeys = Object.keys(this.storage);
        const handledByBatch = new Set();
        const keysAreBatched = allKeys
            .filter((key) => this.storage[key]._isBatch)
            .map((key) => {
                allKeys.filter((k) => this.storage[k]._batchedBy === key).forEach((k) => handledByBatch.add(k));
                return key;
            });
        const keysNotBatched = allKeys.filter((key) => !this.storage[key]._isBatch && !handledByBatch.has(key));
        return [...keysAreBatched, ...keysNotBatched];
    }

    async _setViaConnector(method, value) {
        for (const [name, connector] of this.connectors)
            if (connector[method] && typeof connector[method] === 'function')
                try {
                    const result = await connector[method](value);
                    this.display.debug(`device ${this.macAddress}: ${method} success via ${name}`);
                    return result;
                } catch (e) {
                    this.display.error(`device ${this.macAddress}: ${method} failure via ${name}:`, e);
                }
        throw new Error(`No connector available for ${method}`);
    }

    async _cmdViaConnector(method, ...args) {
        for (const [name, connector] of this.connectors)
            if (connector[method] && typeof connector[method] === 'function')
                try {
                    const result = await connector[method](...args);
                    this.display.debug(`device ${this.macAddress}: ${method} success via ${name}`);
                    return result;
                } catch (e) {
                    this.display.error(`device ${this.macAddress}: ${method} failure via ${name}:`, e);
                }
        throw new Error(`No connector available for ${method}`);
    }

    //

    installConnector(name, connector, data = undefined) {
        if (this.connectors.has(name)) this.display.error(`device: connector '${name}' already installed, replacing`);
        this.connectors.set(name, connector);
        if (connector.on && typeof connector.on === 'function') {
            this._boundListeners.version = (data) => this._dataUpdate('version', data, name);
            this._boundListeners.statusOperation = (data) => this._dataUpdate('statusOperation', data, name);
            this._boundListeners.statusBattery = (data) => this._dataUpdate('statusBattery', data, name);
            this._boundListeners.statusMowing = (data) => this._dataUpdate('statusMowing', data, name);
            this._boundListeners.statusLocation = (data) => this._dataUpdate('statusLocation', data, name);
            this._boundListeners.statusNetwork = (data) => this._dataUpdate('statusNetwork', data, name);
            this._boundListeners.position = (data) => this._dataUpdate('position', data, name);
            this._boundListeners.settings = (data) => this._dataUpdate('settings', data, name);
            this._boundListeners.scheduleSettings = (data) => this._dataUpdate('scheduleSettings', data, name);
            this._boundListeners.zoneSettings = (data) => this._dataUpdate('zoneSettings', data, name);
            this._boundListeners.zoneOrder = (data) => this._dataUpdate('zoneOrder', data, name);
            this._boundListeners.dataUpdated = (data) => this._dataUpdateAll(data, name);
            connector.on('version', this._boundListeners.version);
            connector.on('statusOperation', this._boundListeners.statusOperation);
            connector.on('statusBattery', this._boundListeners.statusBattery);
            connector.on('statusMowing', this._boundListeners.statusMowing);
            connector.on('statusLocation', this._boundListeners.statusLocation);
            connector.on('statusNetwork', this._boundListeners.statusNetwork);
            connector.on('position', this._boundListeners.position);
            connector.on('settings', this._boundListeners.settings);
            connector.on('scheduleSettings', this._boundListeners.scheduleSettings);
            connector.on('zoneSettings', this._boundListeners.zoneSettings);
            connector.on('zoneOrder', this._boundListeners.zoneOrder);
            connector.on(`dataUpdated/${this.macAddress}`, this._boundListeners.dataUpdated);
        }
        if (data) this._dataUpdateAll(data, name);
        this.display.debug(`device ${this.macAddress}: installed connector '${name}'`);
        this.emit('connectorInstalled', { name, connector });
    }
    uninstallConnector(name) {
        const connector = this.connectors.get(name);
        if (!connector) {
            this.display.error(`device: connector '${name}' not found`);
            return;
        }
        if (connector.removeListener && typeof connector.removeListener === 'function') {
            connector.removeListener('version', this._boundListeners?.version);
            connector.removeListener('statusOperation', this._boundListeners?.statusOperation);
            connector.removeListener('statusBattery', this._boundListeners?.statusBattery);
            connector.removeListener('statusMowing', this._boundListeners?.statusMowing);
            connector.removeListener('statusLocation', this._boundListeners?.statusLocation);
            connector.removeListener('statusNetwork', this._boundListeners?.statusNetwork);
            connector.removeListener('position', this._boundListeners?.position);
            connector.removeListener('settings', this._boundListeners?.settings);
            connector.removeListener('scheduleSettings', this._boundListeners?.scheduleSettings);
            connector.removeListener('zoneSettings', this._boundListeners?.zoneSettings);
            connector.removeListener('zoneOrder', this._boundListeners?.zoneOrder);
            connector.removeListener(`dataUpdated/${this.macAddress}`, this._boundListeners?.dataUpdated);
        }
        this.connectors.delete(name);
        this.display.debug(`device ${this.macAddress}: uninstalled connector '${name}'`);
        this.emit('connectorUninstalled', { name });
    }
    async _connectorsLoad(key) {
        for (const [, connector] of this.connectors) if ((key === undefined || connector.provides(key)) && typeof connector?.load === 'function') await connector.load(this.macAddress);
    }
    async _connectorsUpdate(key) {
        for (const [name, connector] of this.connectors)
            if (connector.provides(key))
                try {
                    await this._connectorUpdate(connector, key);
                } catch (e) {
                    this.display.error(`device ${this.macAddress}: failed to refresh ${key} from ${name}:`, e);
                }
    }
    async _connectorUpdate(connector, key) {
        switch (key) {
            case 'version':
                await connector.getVersion();
                break;
            case 'statusOperation':
                await connector.getStatusOperation();
                break;
            case 'statusBattery':
                await connector.getStatusBattery();
                break;
            case 'statusMowing':
                await connector.getStatusMowing();
                break;
            case 'statusLocation':
                await connector.getStatusLocation();
                break;
            case 'statusNetwork':
                await connector.getStatusNetwork();
                break;
            case 'statusAll':
                await connector.getStatusAll();
                break;
            case 'position':
                await connector.getPosition();
                break;
            case 'settings':
                await connector.getSettings();
                break;
            case 'scheduleSettings':
                await connector.getScheduleSettings();
                break;
            case 'zoneSettings':
                await connector.getZoneSettings();
                break;
            case 'zoneOrder':
                await connector.getZoneOrder();
                break;
            case 'uuid':
            case 'name':
            case 'brokerId':
            case 'productCode':
            case 'serialNumber':
            case 'firmwareVersion':
            case 'deviceType':
            case 'baseUuid':
            case 'isEnabled':
            case 'totalWorkTime':
            case 'lastPosition':
                // These come from garage/cloud
                break;
            default:
                throw new Error(`Don't know how to request ${key} from connector`);
        }
    }
    hasConnector(name) {
        return this.connectors.has(name);
    }
    getConnectorNames() {
        return [...this.connectors.keys()];
    }
    isConnected() {
        return this.connectors.size > 0;
    }

    //

    toString() {
        return formatStruct({ mac: this.getMacAddress(), connectors: this.getConnectorNames().join(',') || 'none' }, 'device');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIDevice;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
