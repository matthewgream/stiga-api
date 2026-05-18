#!/usr/bin/env node

/* eslint-disable max-depth, sonarjs/cognitive-complexity */

const {
    StigaAPIAuthentication,
    StigaAPIConnectionServer,
    StigaAPIUser,
    StigaAPINotifications,
    StigaAPIGarage,
    StigaAPIPerimeters,
    StigaAPIConnectionDevice,
    StigaAPIDeviceConnector,
    StigaAPIBaseConnector,
    StigaAPIConfig,
} = require('../api/StigaAPI');
const { username, password } = StigaAPIConfig.load();

async function main() {
    try {
        const auth = new StigaAPIAuthentication(username, password);
        if (!(await auth.isValid())) {
            console.error('Failed to authenticate');
            return;
        }
        console.log('✓ Authentication successful');

        const server = new StigaAPIConnectionServer(auth);
        if (!(await server.isConnected())) {
            console.error('Failed to connect to server');
            return;
        }
        console.log('✓ Connected to server');

        console.log('===== USER =====');
        const user = new StigaAPIUser(server);
        if (await user.load()) {
            console.log(`User: ${user.toString()}`);
            console.log(`UUID: ${user.getUuid()}`);
            console.log(`Language: ${user.getLanguage()}`);
            console.log(`Last login: ${user.getLastLogin()}`);
            console.log(`Terms accepted: ${user.hasAcceptedTerms()}`);
            console.log(`Marketing consent: ${user.hasMarketingConsent()}`);
        }

        console.log('===== NOTIFICATIONS =====');
        const notifications = new StigaAPINotifications(server);
        if (await notifications.load()) {
            console.log(`Total: ${notifications.toString()}`);
            const unread = notifications.getUnread();
            console.log(`Unread notifications (${unread.length}):`);
            unread.slice(0, 5).forEach((notif) => {
                console.log(`  - ${notif.toString()}`);
                console.log(`    ${notif.getBody()}`);
            });
            const recent = notifications.getRecent(24);
            console.log(`Recent notifications (last 24h): ${recent.length}`);
            const types = {};
            notifications.getAll().forEach((notif) => {
                const type = notif.getType() || 'unknown';
                types[type] = (types[type] || 0) + 1;
            });
            console.log('Notifications by type:');
            Object.entries(types).forEach(([type, count]) => console.log(`  ${type}: ${count}`));
        }

        console.log('===== GARAGE =====');
        const garage = new StigaAPIGarage(server);
        if (await garage.load()) {
            console.log(garage.toString());

            const devices = garage.getDevices();
            if (devices && devices.length > 0) {
                for (const [index, device] of devices.entries()) {
                    console.log(`  Device [${index + 1}]: ${device.toString()}`);
                    console.log(`  UUID: ${(await device.getUuid()).value}`);
                    console.log(`  Product: ${(await device.getProductCode()).value}`);
                    console.log(`  Serial: ${(await device.getSerialNumber()).value}`);
                    console.log(`  Firmware: ${(await device.getFirmwareVersion()).value}`);
                    console.log(`  Enabled: ${(await device.getIsEnabled()).value}`);

                    const position = (await device.getLastPosition()).value;
                    if (position) console.log(`  Position: ${position.latitude}, ${position.longitude}`);
                    const scheduling = (await device.getScheduleSettings()).value;
                    if (scheduling) console.log(`  Scheduling: ${scheduling.toString()}`);

                    const bases = garage.getBasesForDevice(device);
                    if (bases && bases.length > 0)
                        for (const [idx, base] of bases.entries()) {
                            console.log(`  Base (${idx + 1}): ${base.toString()}`);
                            console.log(`    UUID: ${(await base.getUuid()).value}`);
                            console.log(`    Serial: ${(await base.getSerialNumber()).value}`);
                            console.log(`    Firmware (cloud): ${(await base.getFirmwareVersion()).value}`);
                        }
                    else console.log('Bases not found');
                    const [base] = bases || [];

                    const packs = garage.getPacksForDevice(device);
                    if (packs && packs.length > 0) for (const [idx, pack] of packs.entries()) console.log(`  Pack (${idx + 1}): ${pack.toString()}`);
                    else console.log('  Packs not found');

                    const perimeters = new StigaAPIPerimeters(server, device);
                    if (await perimeters.load()) {
                        console.log(`  Perimeters: ${perimeters.toString()}`);

                        const zones = perimeters.getZones();
                        console.log(`  Zones (${zones.length}):`);
                        zones.forEach((zone, idx) => console.log(`    Zone (${idx + 1}): ${zone.toString()}`));

                        const obstacles = perimeters.getObstacles();
                        console.log(`  Obstacles: ${obstacles.length} total, ${perimeters.getObstaclesArea().toFixed(1)}m²`);

                        const refPos = perimeters.getReferencePosition();
                        if (refPos) console.log(`  Reference position: ${refPos.latitude}, ${refPos.longitude}`);

                        const timestamp = perimeters.getTimestamp();
                        if (timestamp) console.log(`  Last updated: ${timestamp.toLocaleString()}`);
                    } else console.log('  Failed to load perimeters');

                    if (base) {
                        console.log('  Setting up MQTT device connection...');

                        const connection = new StigaAPIConnectionDevice(auth, (await device.getBrokerId()).value);
                        const connectedDevice = new StigaAPIDeviceConnector(device, connection);
                        const connectedBase = new StigaAPIBaseConnector(base, connection);

                        base.on('version', (version) => console.log(`  BASE VERSION UPDATE: ${version.toString()}`));
                        base.on('statusOperation', (status) => console.log(`  BASE STATUS UPDATE: type=${status.type}, flag=${status.flag}`));
                        base.on('statusLocation', (status) => console.log(`  BASE LOCATION UPDATE: ${status.toString()}`));
                        base.on('statusNetwork', (status) => console.log(`  BASE NETWORK UPDATE: ${status.toString()}`));

                        if (await connectedBase.listen()) {
                            console.log('  ✓ Base listeners active');
                            console.log(`    Connectors: ${base.getConnectorNames().join(', ')}`);
                            console.log(`    Subscriptions: ${connectedBase.getSubscriptions().join(', ')}`);
                            try {
                                console.log(`    Version: ${(await base.getVersion({ refresh: 'force' })).value.toString()}`);
                            } catch (e) {
                                console.error(`    Failed to get base version: ${e.message}`);
                            }
                        }
                        if (await connectedDevice.listen()) {
                            console.log('  ✓ Robot listeners active');
                            console.log(`    Connectors: ${device.getConnectorNames().join(', ')}`);
                            console.log(`    Subscriptions: ${connectedDevice.getSubscriptions().join(', ')}`);
                            try {
                                console.log(`    Version: ${(await device.getVersion({ refresh: 'force' })).value.toString()}`);
                            } catch (e) {
                                console.error(`    Failed to get robot version: ${e.message}`);
                            }
                        }

                        console.log('  Listening for MQTT messages for 30 seconds...');
                        console.log('  (Hex dumps of received messages will appear below)');

                        await new Promise((resolve) => setTimeout(resolve, 30000));

                        // Clean up
                        connectedDevice.destroy();
                        connectedBase.destroy();
                        connection.disconnect();

                        console.log('  MQTT connection closed');
                        console.log(`  Base connectors after cleanup: ${base.getConnectorNames().join(', ') || 'none'}`);
                    }
                }
            } else {
                console.log('No devices found');
            }
        }

        process.exit(0);
    } catch (e) {
        console.error('Error in main execution:', e);
        process.exit(1);
    }
}

main();
