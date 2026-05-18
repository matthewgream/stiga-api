#!/usr/bin/env node

const { StigaAPIConnectionDevice, StigaAPIBaseConnector, StigaAPIFramework, StigaAPIConfig } = require('../api/StigaAPI');
const { username, password } = StigaAPIConfig.load();

async function main() {
    try {
        const framework = new StigaAPIFramework();
        if (!(await framework.load(username, password))) throw new Error('Framework failed to intiaialise');
        const { device, base } = framework.getDeviceAndBasePair();

        //

        // The base now has garage data
        console.log('\n=== Base with Garage Data Only ===');

        console.log(`UUID: ${(await base.getUuid())?.value}`);
        console.log(`Product Code: ${(await base.getProductCode())?.value}`);
        console.log(`Serial Number: ${(await base.getSerialNumber())?.value}`);
        console.log(`Firmware (cloud): ${(await base.getFirmwareVersion())?.value}`);
        console.log(`Connectors: ${base.getConnectorNames().join(', ') || 'none'}`);

        base.on('version', (version) => console.log(`BASE EVENT - VERSION: ${version.toString()}`));
        base.on('statusOperation', (status) => console.log(`BASE EVENT - STATUS (OPERATION): type=${status.type}, flag=${status.flag}`));
        base.on('statusLocation', (status) => console.log(`BASE EVENT - STATUS (LOCATION): ${status.toString()}`));
        base.on('statusNetwork', (status) => console.log(`BASE EVENT - STATUS (NETWORK): ${status.toString()}`));
        base.on('ledSetting', (led) => {
            console.log(`BASE EVENT - LED SETTING: ${led}`);
            if (led !== 'off') {
                console.log(`  LED is not off! setting=${led}; changing to off...`);
                // base.setSetting('led', 'off').catch((e) => console.error('Failed to set LED:', e));
            }
        });
        base.on('dataUpdated', ({ key, _value, source }) => console.log(`BASE DATA UPDATED: ${key} from ${source}`));

        // Create device connection and connected base
        console.log('\n=== Setting up MQTT Connection ===');
        const deviceConnection = new StigaAPIConnectionDevice(framework.auth, (await device.getBrokerId()).value, { debug: false });
        const connectedBase = new StigaAPIBaseConnector(base, deviceConnection);

        console.log('Starting base station listeners...');
        if (!(await connectedBase.listen())) {
            console.error('Failed to start base listeners');
            return;
        }
        console.log(`Connectors after MQTT setup: ${base.getConnectorNames().join(', ')}`);

        //

        // Now request data through the base
        console.log('\n=== Requesting Initial Data via Base ===');

        const version = await base.getVersion({ refresh: 'force' });
        console.log(`Version: ${version.value.toString()}`);
        console.log(`  Last updated: ${new Date(version._updated).toLocaleTimeString()}`);
        const statusOp = await base.getStatusOperation({ refresh: 'force' });
        console.log(`Status Operation: type=${statusOp.value?.type}, flag=${statusOp.value?.flag}`);
        console.log(`  Last updated: ${new Date(statusOp._updated).toLocaleTimeString()}`);
        const statusLoc = await base.getStatusLocation({ refresh: 'force' });
        console.log(`Status Location: ${statusLoc.value?.toString() || 'no data'}`);
        console.log(`  Last updated: ${new Date(statusLoc._updated || 0).toLocaleTimeString()}`);
        const statusNet = await base.getStatusNetwork({ refresh: 'force' });
        console.log(`Status Network: ${statusNet.value?.toString() || 'no data'}`);
        console.log(`  Last updated: ${new Date(statusNet._updated || 0).toLocaleTimeString()}`);
        const statusAll = await base.getStatusAll({ refresh: 'force' });
        console.log(`Status All:`);
        console.log(`  Operation: type=${statusAll.operation?.type}, flag=${statusAll.operation?.flag}`);
        console.log(`  Location: ${statusAll.location?.toString() || 'no data'}`);
        console.log(`  Network: ${statusAll.network?.toString() || 'no data'}`);
        console.log(`  Last updated: ${new Date(statusAll._updated).toLocaleTimeString()}`);
        const ledSetting = await base.getSetting('led');
        console.log(`LED Setting: ${ledSetting.value}`);

        //

        // Test update all
        console.log('\n=== Testing Update All ===');
        await base.update();
        console.log('Update complete');

        // Main loop - periodic status checks
        console.log('\n=== Starting Main Loop (15 second intervals) ===');
        console.log('Press Ctrl+C to exit\n');

        const mainLoop = setInterval(async () => {
            console.log(`\n[${new Date().toLocaleTimeString()}] Status Check`);
            try {
                // Get status without refresh (use cached data)
                const cachedStatus = await base.getStatusOperation();
                console.log(`Cached status: type=${cachedStatus.value?.type}, flag=${cachedStatus.value?.flag}`);
                console.log(`  Age: ${Math.round((Date.now() - cachedStatus._updated) / 1000)}s`);

                // Get status with refresh if stale (older than 5 minutes)
                const freshStatus = await base.getStatusOperation({ refresh: 'ifstale' });
                if (freshStatus._updated > cachedStatus._updated) console.log(`Fresh status: type=${freshStatus.value?.type}, flag=${freshStatus.value?.flag}`);
            } catch (e) {
                console.error(`Error getting status:`, e.message);
            }
        }, 15000);

        // Test connector removal/addition after 45 seconds
        setTimeout(async () => {
            console.log('\n=== Testing Connector Removal ===');
            connectedBase.destroy();
            console.log(`Connectors after removal: ${base.getConnectorNames().join(', ') || 'none'}`);

            // Try to get status - should use cached data
            try {
                const status = await base.getStatusOperation();
                console.log(`Status (from cache): type=${status.value?.type}, flag=${status.value?.flag}`);
                console.log(`  Age: ${Math.round((Date.now() - status._updated) / 1000)}s`);
            } catch (e) {
                console.error('Failed to get status:', e.message);
            }

            // Try to set LED - should fail
            try {
                await base.setSetting('led', 'always');
                console.log('LED setting succeeded (unexpected!)');
            } catch (e) {
                console.log('LED setting failed as expected:', e.message);
            }

            // Reconnect after 10 seconds
            setTimeout(async () => {
                console.log('\n=== Testing Connector Reconnection ===');
                const connectedBaseNew = new StigaAPIBaseConnector(base, deviceConnection);
                await connectedBaseNew.listen();
                console.log(`Connectors after reconnection: ${base.getConnectorNames().join(', ')}`);

                // Try to set LED again - should work now
                try {
                    await base.setSetting('led', 'always');
                    console.log('LED setting succeeded');
                } catch (e) {
                    console.error('LED setting failed:', e.message);
                }
            }, 10000);
        }, 45000);

        process.on('SIGINT', () => {
            console.log('\n\nShutting down...');
            clearInterval(mainLoop);
            if (connectedBase) connectedBase.destroy();
            deviceConnection.disconnect();
            process.exit(0);
        });
    } catch (e) {
        console.error('Error in main execution:', e);
        process.exit(1);
    }
}

main();
