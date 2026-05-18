// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { formatStruct } = require('./StigaAPIUtilitiesFormat');
const StigaAPIComponent = require('./StigaAPIComponent');

const STALE_THRESHOLD_DEFAULT = 30 * 60 * 1000;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIBase extends StigaAPIComponent {
    constructor(options = {}) {
        super(options);

        if (!options.macAddress) throw new Error('StigaAPIBase: macAddress is required');
        this.macAddress = options.macAddress;
        this.connectors = new Map(); // name -> connector instance
        this._boundListeners = {};
        this.storage = {
            // Cloud/Garage data
            uuid: { value: undefined, _updated: undefined },
            productCode: { value: undefined, _updated: undefined },
            serialNumber: { value: undefined, _updated: undefined },
            firmwareVersion: { value: undefined, _updated: undefined },
            createdAt: { value: undefined, _updated: undefined },
            // RTK reference origin (zero point for offset reporting). Sourced from
            // the paired device's lastPosition by Garage, or set explicitly.
            referencePosition: { value: undefined, _updated: undefined },
            // MQTT/Device data
            version: { value: undefined, _updated: undefined, _stale: 24 * 60 * 60 * 1000 },
            statusOperation: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 1 * 60 * 1000 },
            statusLocation: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 1 * 60 * 1000 },
            statusNetwork: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 5 * 60 * 1000 },
            statusAll: { value: undefined, _updated: undefined, _isBatch: true },
            ledSetting: { value: undefined, _updated: undefined, _batchedBy: 'statusAll', _stale: 1 * 60 * 1000 },
        };
        this.staleThresholdDefault = options.staleThresholdDefault || STALE_THRESHOLD_DEFAULT;
    }

    //

    getMacAddress() {
        return this.macAddress;
    }

    //

    async getUuid(options = {}) {
        return this._dataGet('uuid', options);
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
    async getCreatedAt(options = {}) {
        return this._dataGet('createdAt', options);
    }

    getReferencePosition() {
        return this.storage.referencePosition.value;
    }
    setReferencePosition(position) {
        this._dataUpdate('referencePosition', position, 'explicit');
    }

    //

    async getVersion(options = {}) {
        return this._dataGet('version', options);
    }
    async getStatusOperation(options = {}) {
        return this._dataGet('statusOperation', options);
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
            location: this.storage.statusLocation.value,
            network: this.storage.statusNetwork.value,
            led: this.storage.ledSetting.value,
            _updated: Math.min(this.storage.statusOperation._updated || Infinity, this.storage.statusLocation._updated || Infinity, this.storage.statusNetwork._updated || Infinity, this.storage.ledSetting._updated || Infinity),
        };
    }
    async getLedSetting(options = {}) {
        return this._dataGet('ledSetting', options);
    }
    async setLedSetting(ledSetting) {
        return this._setViaConnector('ledSetting', ledSetting);
    }

    //

    async getSetting(settingName, options = {}) {
        if (settingName !== 'led') throw new Error(`Unknown setting: ${settingName}`);
        return this._dataGet('ledSetting', options);
    }
    async setSetting(settingName, value) {
        if (settingName !== 'led') throw new Error(`Unknown setting: ${settingName}`);
        // XXX not pleasant
        for (const [name, connector] of this.connectors)
            if (connector.setLedSetting && typeof connector.setLedSetting === 'function')
                try {
                    const result = await connector.setLedSetting(value);
                    this.display.debug(`base ${this.macAddress}: set success for '${settingName}=${value}' via ${name}`);
                    return result;
                } catch (e) {
                    this.display.error(`base ${this.macAddress}: set failure for '${settingName}=${value}' via ${name}:`, e);
                }
        throw new Error(`No connector available to set ${settingName}`);
    }

    //

    _dataUpdateAll(data, name) {
        let value;
        if ((value = data.getUuid()) !== undefined) this._dataUpdate('uuid', value, name);
        if ((value = data.getProductCode()) !== undefined) this._dataUpdate('productCode', value, name);
        if ((value = data.getSerialNumber()) !== undefined) this._dataUpdate('serialNumber', value, name);
        if ((value = data.getFirmwareVersion()) !== undefined) this._dataUpdate('firmwareVersion', value, name);
        if ((value = data.getCreatedAt()) !== undefined) this._dataUpdate('createdAt', value, name);
    }
    _dataUpdate(key, value, source) {
        const oldValue = this.storage[key]?.value;
        this.storage[key] = { ...this.storage[key], value, _updated: Date.now() };
        if (oldValue !== value) {
            this.emit('dataUpdated', { key, value, oldValue, source });
            this.emit(key, value);
        }
        this.display.debug(`base ${this.macAddress}: updated ${key} from ${source} [${oldValue === value ? 'changed' : 'unchanged'}]`);
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
                    this.display.debug(`base ${this.macAddress}: ${method} success via ${name}`);
                    return result;
                } catch (e) {
                    this.display.error(`base ${this.macAddress}: ${method} failure via ${name}:`, e);
                }
        throw new Error(`No connector available for ${method}`);
    }

    //

    installConnector(name, connector, data = undefined) {
        if (this.connectors.has(name)) this.display.error(`base: connector '${name}' already installed, replacing`);
        this.connectors.set(name, connector);
        if (connector.on && typeof connector.on === 'function') {
            this._boundListeners.version = (data) => this._dataUpdate('version', data, name);
            this._boundListeners.statusOperation = (data) => this._dataUpdate('statusOperation', data, name);
            this._boundListeners.statusLocation = (data) => this._dataUpdate('statusLocation', data, name);
            this._boundListeners.statusNetwork = (data) => this._dataUpdate('statusNetwork', data, name);
            this._boundListeners.ledSetting = (data) => this._dataUpdate('ledSetting', data, name);
            this._boundListeners.dataUpdated = (data) => this._dataUpdateAll(data, name);
            connector.on('version', this._boundListeners.version);
            connector.on('statusOperation', this._boundListeners.statusOperation);
            connector.on('statusLocation', this._boundListeners.statusLocation);
            connector.on('statusNetwork', this._boundListeners.statusNetwork);
            connector.on('ledSetting', this._boundListeners.ledSetting);
            connector.on(`dataUpdated/${this.macAddress}`, this._boundListeners.dataUpdated);
        }
        if (data) this._dataUpdateAll(data, name);
        this.display.debug(`base ${this.macAddress}: installed connector '${name}'`);
        this.emit('connectorInstalled', { name, connector });
    }
    uninstallConnector(name) {
        const connector = this.connectors.get(name);
        if (!connector) {
            this.display.error(`base: connector '${name}' not found`);
            return;
        }
        if (connector.removeListener && typeof connector.removeListener === 'function') {
            connector.removeListener('version', this._boundListeners?.version);
            connector.removeListener('statusOperation', this._boundListeners?.statusOperation);
            connector.removeListener('statusLocation', this._boundListeners?.statusLocation);
            connector.removeListener('statusNetwork', this._boundListeners?.statusNetwork);
            connector.removeListener('ledSetting', this._boundListeners?.ledSetting);
            connector.removeListener(`dataUpdated/${this.macAddress}`, this._boundListeners?.dataUpdated);
        }
        this.connectors.delete(name);
        this.display.debug(`base ${this.macAddress}: uninstalled connector '${name}'`);
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
                    this.display.error(`base ${this.macAddress}: failed to refresh ${key} from ${name}:`, e);
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
            case 'statusLocation':
                await connector.getStatusLocation();
                break;
            case 'statusNetwork':
                await connector.getStatusNetwork();
                break;
            case 'statusAll':
                await connector.getStatusAll();
                break;
            case 'ledSetting':
                await connector.getLedSetting();
                break;
            case 'uuid':
            case 'productCode':
            case 'serialNumber':
            case 'firmwareVersion':
            case 'createdAt':
            case 'referencePosition':
                // These come from garage/cloud (or are set explicitly)
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
        return formatStruct({ mac: this.getMacAddress(), connectors: this.getConnectorNames().join(',') || 'none' }, 'base');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIBase;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
