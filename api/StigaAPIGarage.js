// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { formatStruct } = require('./StigaAPIUtilitiesFormat');
const { decodeRobotScheduleSettings } = require('./StigaAPIElements');
const StigaAPIBase = require('./StigaAPIBase');
const StigaAPIDevice = require('./StigaAPIDevice');
const StigaAPIComponent = require('./StigaAPIComponent');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class DeviceData {
    constructor(deviceData) {
        this.data = deviceData;
    }

    getUuid() {
        return this.data?.attributes?.uuid || undefined;
    }
    getName() {
        return this.data?.attributes?.name || 'Unnamed Device';
    }
    getProductCode() {
        return this.data?.attributes?.product_code || undefined;
    }
    getSerialNumber() {
        return this.data?.attributes?.serial_number || undefined;
    }
    getMacAddress() {
        return this.data?.attributes?.mac_address || undefined;
    }
    getDeviceType() {
        return this.data?.attributes?.device_type || undefined;
    }
    getFirmwareVersion() {
        return this.data?.attributes?.firmware_version || undefined;
    }
    getBaseUuid() {
        return this.data?.attributes?.base_uuid || undefined;
    }
    getBrokerId() {
        return this.data?.attributes?.broker_id || undefined;
    }
    getLastPosition() {
        const pos = this.data?.attributes?.last_position;
        return pos?.coordinates && Array.isArray(pos.coordinates) && pos.coordinates.length >= 2 ? { latitude: pos.coordinates[0], longitude: pos.coordinates[1] } : undefined;
    }
    getTotalWorkTime() {
        return this.data?.attributes?.total_work_time || 0;
    }
    getIsEnabled() {
        return this.data?.attributes?.enabled || false;
    }
    getSettings() {
        const settings = this.data?.attributes?.settings;
        return settings?.length > 0 ? settings[0] : undefined;
    }
    // Automatic firmware update — a CLOUD-ONLY device setting (not in the robot's MQTT LOG/SETTINGS).
    getAutoUpdate() {
        return this.getSettings()?.auto_update;
    }
    getScheduling() {
        return decodeRobotScheduleSettings(this.getSettings()?.scheduling);
    }
    toString() {
        return formatStruct({ name: this.getName(), mac: this.getMacAddress(), type: this.getDeviceType() }, 'device');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class BaseData {
    constructor(baseData) {
        this.data = baseData;
    }

    getUuid() {
        return this.data?.id || this.data?.attributes?.uuid || undefined;
    }
    getProductCode() {
        return this.data?.attributes?.product_code || undefined;
    }
    getSerialNumber() {
        return this.data?.attributes?.serial_number || undefined;
    }
    getMacAddress() {
        return this.data?.attributes?.mac_address || undefined;
    }
    getFirmwareVersion() {
        return this.data?.attributes?.firmware_version || undefined;
    }
    getCreatedAt() {
        const created = this.data?.attributes?.created_at;
        return created ? new Date(created) : undefined;
    }
    getData() {
        return this.data;
    }
    toString() {
        return formatStruct({ serial: this.getSerialNumber(), mac: this.getMacAddress() }, 'base');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class PackData {
    constructor(packData) {
        this.data = packData;
    }

    getUuid() {
        return this.data?.id || this.data?.attributes?.uuid || undefined;
    }
    getDeviceUuid() {
        return this.data?.attributes?.device_uuid || undefined;
    }
    getStatus() {
        return this.data?.attributes?.status || 'unknown';
    }
    getWorkHoursUsed() {
        return this.data?.attributes?.work_hours_used || 0;
    }
    getWorkHoursTotal() {
        return this.data?.attributes?.work_hours_total || 0;
    }
    getValidFrom() {
        const validFrom = this.data?.attributes?.validity_from;
        return validFrom ? new Date(validFrom) : undefined;
    }
    getValidTo() {
        const validTo = this.data?.attributes?.validity_to;
        return validTo ? new Date(validTo) : undefined;
    }
    isActive() {
        return this.getStatus() === 'active';
    }
    toString() {
        return formatStruct({ hours: this.getWorkHoursUsed(), total: this.getWorkHoursTotal(), status: this.getStatus() }, 'pack', { hours: { units: 'h' }, total: { units: 'h' } });
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIGarage extends StigaAPIComponent {
    constructor(serverConnection, options = {}) {
        super(options);
        this.server = serverConnection;
        this.garageData = undefined;
        this.devicesData = [];
        this.devices = new Map(); // MAC -> StigaAPIDevice instance
        this.basesData = new Map(); // UUID -> BaseData instance
        this.bases = new Map(); // MAC -> StigaAPIBase instance
        this.packsData = new Map();
    }
    destroy() {
        [...this.bases.values()].forEach((base) => base.uninstallConnector('garage'));
        [...this.devices.values()].forEach((device) => device.uninstallConnector('garage'));
        this.removeAllListeners();
        this.bases.clear();
        this.basesData.clear();
        this.devices.clear();
        this.devicesData = [];
        this.packsData.clear();
        this.garageData = undefined;
    }

    async load() {
        try {
            const response = await this.server.get('/api/garage', { relationships: 'base,connpack' });
            if (response.ok) {
                this.garageData = await response.json();
                this._parseData();
                this._updateBases();
                this._updateDevices();
                this._propagateReferencePosition();
                return true;
            }
        } catch (e) {
            this.display.error('garage: failed to load:', e);
        }
        return false;
    }

    // Link each device to its paired base and seed the base's RTK reference
    // origin from the device's cloud-reported lastPosition. The cloud has no
    // base coordinates of its own, so the device's last fix (taken near the
    // base) is the best proxy.
    _propagateReferencePosition() {
        for (const deviceData of this.devicesData) {
            const baseUuid = deviceData.getBaseUuid();
            if (!baseUuid) continue;
            const baseData = this.basesData.get(baseUuid);
            if (!baseData) continue;
            const base = this.bases.get(baseData.getMacAddress());
            const device = this.devices.get(deviceData.getMacAddress());
            if (!base || !device) continue;
            device.setPairedBase(base);
            const lastPosition = deviceData.getLastPosition();
            if (lastPosition && base.getReferencePosition() === undefined) base.setReferencePosition(lastPosition);
        }
    }

    provides(key) {
        return ['uuid', 'productCode', 'serialNumber', 'firmwareVersion', 'createdAt'].includes(key);
    }

    _parseData() {
        this.devicesData = this.garageData?.data?.filter((item) => item.type === 'devices').map((item) => new DeviceData(item)) ?? [];
        this.basesData.clear();
        this.garageData?.included?.forEach((item) => {
            if (item.type === 'OwnBases') this.basesData.set(item.id, new BaseData(item));
            else if (item.type === 'ConnPacks') this.packsData.set(item.id, new PackData(item));
        });
    }

    _updateBases() {
        for (const [, baseData] of this.basesData) {
            const macAddress = baseData.getMacAddress();
            if (!macAddress) continue;
            let base = this.bases.get(macAddress);
            if (base) this.emit(`dataUpdated/${macAddress}`, baseData);
            else {
                base = new StigaAPIBase({ macAddress });
                this.bases.set(macAddress, base);
                base.installConnector('garage', this, baseData);
                this.display.debug(`garage: created new base ${macAddress}`);
            }
        }
    }

    _updateDevices() {
        for (const deviceData of this.devicesData) {
            const macAddress = deviceData.getMacAddress();
            if (!macAddress) continue;
            let device = this.devices.get(macAddress);
            if (device) this.emit(`dataUpdated/${macAddress}`, deviceData);
            else {
                device = new StigaAPIDevice({ macAddress });
                this.devices.set(macAddress, device);
                device.installConnector('garage', this, deviceData);
                this.display.debug(`garage: created new device ${macAddress}`);
            }
        }
    }

    //

    getDevice(macAddress) {
        return this.devices.get(macAddress) || undefined;
    }
    getDevices() {
        return [...this.devices.values()];
    }

    //

    getBase(macAddress) {
        return [...this.bases.values()].find((b) => b.getMacAddress() === macAddress) || undefined;
    }
    getBases() {
        return [...this.bases.values()];
    }
    getBasesForDevice(device) {
        // to avoid async
        const deviceData = this.devicesData.find((deviceData) => deviceData.getMacAddress() === device.getMacAddress());
        if (!deviceData) return undefined;
        const baseUuid = deviceData.getBaseUuid();
        if (!baseUuid) return undefined;
        const baseData = this.basesData.get(baseUuid);
        if (!baseData) return undefined;
        const macAddress = baseData.getMacAddress();
        if (!macAddress) return undefined;
        return [this.getBase(macAddress)];
    }

    //

    getPacks() {
        return [...this.packsData.values()];
    }
    getPacksForDevice(device) {
        // to avoid async
        const deviceData = this.devicesData.find((deviceData) => deviceData.getMacAddress() === device.getMacAddress());
        if (!deviceData) return undefined;
        return [...this.packsData.values()].filter((pack) => pack.getDeviceUuid() === deviceData.getUuid());
    }

    //

    toString() {
        return formatStruct({ devices: this.devices.size, bases: this.basesData.size, packs: this.packsData.size }, 'garage');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIGarage;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
