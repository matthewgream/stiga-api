#!/usr/bin/env node

const { StigaAPIConnectionDevice, StigaAPIDeviceConnector, StigaAPIFramework, StigaAPIConfig } = require('../api/StigaAPI');
const { username, password } = StigaAPIConfig.load();

async function main() {
    try {
        const framework = new StigaAPIFramework();
        if (!(await framework.load(username, password))) throw new Error('Framework failed to initialise');
        const { device } = framework.getDeviceAndBasePair();

        console.log('\n=== Device with Garage Data Only ===');
        console.log(`UUID: ${(await device.getUuid())?.value}`);
        console.log(`Name: ${(await device.getName())?.value}`);
        console.log(`Product Code: ${(await device.getProductCode())?.value}`);
        console.log(`Serial Number: ${(await device.getSerialNumber())?.value}`);
        console.log(`Device Type: ${(await device.getDeviceType())?.value}`);
        console.log(`Firmware (cloud): ${(await device.getFirmwareVersion())?.value}`);
        console.log(`Base UUID: ${(await device.getBaseUuid())?.value}`);
        console.log(`Broker ID: ${(await device.getBrokerId())?.value}`);
        console.log(`Enabled: ${(await device.getIsEnabled())?.value}`);
        console.log(`Total Work Time: ${(await device.getTotalWorkTime())?.value} hours`);
        console.log(`Last Position: ${JSON.stringify((await device.getLastPosition())?.value)}`);
        console.log(`Connectors: ${device.getConnectorNames().join(', ') || 'none'}`);

        device.on('version', (version) => console.log(`DEVICE EVENT - VERSION: ${version.toString()}`));
        device.on('statusOperation', (status) =>
            console.log(
                `DEVICE EVENT - STATUS (OPERATION): type=${status.type}, valid=${status.valid}, docking=${status.docking}${status.error ? ', error=' + status.error.toString() : ''}${status.info ? ', info=' + status.info.toString() : ''}`
            )
        );
        device.on('statusBattery', (status) => console.log(`DEVICE EVENT - STATUS (BATTERY): ${status.toString()}`));
        device.on('statusMowing', (status) => console.log(`DEVICE EVENT - STATUS (MOWING): ${status.toString()}`));
        device.on('statusLocation', (status) => console.log(`DEVICE EVENT - STATUS (LOCATION): ${status.toString()}`));
        device.on('statusNetwork', (status) => console.log(`DEVICE EVENT - STATUS (NETWORK): ${status.toString()}`));
        device.on('position', (position) => console.log(`DEVICE EVENT - POSITION: ${position.toString()}`));
        device.on('settings', (settings) => console.log(`DEVICE EVENT - SETTINGS: ${settings.toString()}`));
        device.on('scheduleSettings', (schedule) => console.log(`DEVICE EVENT - SCHEDULE: ${schedule.toString()}`));
        device.on('dataUpdated', ({ key, source }) => console.log(`DEVICE DATA UPDATED: ${key} from ${source}`));

        console.log('\n=== Setting up MQTT Connection ===');
        const connection = new StigaAPIConnectionDevice(framework.auth, (await device.getBrokerId()).value, { debug: false });
        const connectedDevice = new StigaAPIDeviceConnector(device, connection);

        console.log(`Connectors after MQTT setup: ${device.getConnectorNames().join(', ')}`);

        console.log('Starting device listeners...');
        if (!(await connectedDevice.listen())) {
            console.error('Failed to start device listeners');
            return;
        }

        //

        console.log('\n=== Requesting Initial Data via Device ===');
        const version = await device.getVersion({ refresh: 'force' });
        console.log(`Version: ${version.value?.toString() || 'no data'}`);
        console.log(`  Last updated: ${new Date(version._updated).toLocaleTimeString()}`);

        //

        console.log('\n=== Testing Individual Status Requests ===');
        const statusOp = await device.getStatusOperation({ refresh: 'force' });
        console.log(`Status Operation: type=${statusOp.value?.type}, valid=${statusOp.value?.valid}, docking=${statusOp.value?.docking}`);
        const statusBat = await device.getStatusBattery({ refresh: 'force' });
        console.log(`Status Battery: ${statusBat.value?.toString() || 'no data'}`);
        const statusMow = await device.getStatusMowing({ refresh: 'force' });
        console.log(`Status Mowing: ${statusMow.value?.toString() || 'no data'}`);
        const statusLoc = await device.getStatusLocation({ refresh: 'force' });
        console.log(`Status Location: ${statusLoc.value?.toString() || 'no data'}`);
        const statusNet = await device.getStatusNetwork({ refresh: 'force' });
        console.log(`Status Network: ${statusNet.value?.toString() || 'no data'}`);

        //

        console.log('\n=== Testing Batch Status Request (getStatusAll) ===');
        const statusAll = await device.getStatusAll({ refresh: 'force' });
        console.log('All Status:');
        console.log(`  Operation: ${statusAll.operation?.type || 'no data'}`);
        console.log(`  Battery: ${statusAll.battery?.charge || 'no data'}%`);
        console.log(`  Mowing: zone=${statusAll.mowing?.zone || 'no data'}, completed=${statusAll.mowing?.zoneCompleted || 'no data'}%`);
        console.log(`  Location: satellites=${statusAll.location?.satellites || 'no data'}`);
        console.log(`  Network: ${statusAll.network?.type || 'no data'}`);
        console.log(`  Last updated: ${new Date(statusAll._updated).toLocaleTimeString()}`);

        //

        console.log('\n=== Testing Other Data Requests ===');
        const position = await device.getPosition({ refresh: 'force' });
        console.log(`Position: ${position.value?.toString() || 'no data'}`);
        const settings = await device.getSettings({ refresh: 'force' });
        console.log(`Settings: ${settings.value?.toString() || 'no data'}`);
        const schedule = await device.getScheduleSettings({ refresh: 'force' });
        console.log(`Schedule: ${schedule.value?.toString() || 'no data'}`);
        if (schedule.value?.totalBlocks > 0) {
            console.log('Schedule details:');
            schedule.value.toString('blocks').forEach((block) => console.log(`  ${block}`));
        }

        //

        console.log('\n=== Testing Update All (with optimized batching) ===');
        console.log('This should use getStatusAll instead of individual status requests...');
        await device.update();
        console.log('Update complete');

        //

        console.log('\n=== Testing Device Command ===');
        try {
            console.log('Sending STOP command...');
            await device.sendStop();
            console.log('Stop command sent successfully');
        } catch (e) {
            console.error('Stop command failed:', e.message);
        }

        //

        console.log('\n=== Starting Main Loop (20 second intervals) ===');
        console.log('Press Ctrl+C to exit\n');

        let loopCount = 0;
        const mainLoop = setInterval(async () => {
            loopCount++;
            console.log(`\n[${new Date().toLocaleTimeString()}] Status Check #${loopCount}`);
            try {
                if (loopCount % 3 === 0) {
                    console.log('Getting all status (batched)...');
                    const allStatus = await device.getStatusAll({ refresh: 'ifstale' });
                    console.log(`  Operation: ${allStatus.operation?.type || '-'}`);
                    console.log(`  Battery: ${allStatus.battery?.charge || '-'}%`);
                    console.log(`  Location: ${allStatus.location?.satellites || '-'} satellites`);
                    console.log(`  Age: ${Math.round((Date.now() - allStatus._updated) / 1000)}s`);
                } else if (loopCount % 3 === 1) {
                    console.log('Getting operation status only...');
                    const opStatus = await device.getStatusOperation({ refresh: 'ifstale' });
                    console.log(`  Type: ${opStatus.value?.type || '-'}`);
                    console.log(`  Valid: ${opStatus.value?.valid || '-'}`);
                    console.log(`  Docking: ${opStatus.value?.docking || '-'}`);
                    console.log(`  Age: ${Math.round((Date.now() - opStatus._updated) / 1000)}s`);
                } else {
                    console.log('Getting cached status...');
                    const cachedOp = await device.getStatusOperation();
                    const cachedBat = await device.getStatusBattery();
                    console.log(`  Operation: ${cachedOp.value?.type || '-'} (age: ${Math.round((Date.now() - cachedOp._updated) / 1000)}s)`);
                    console.log(`  Battery: ${cachedBat.value?.charge || '-'}% (age: ${Math.round((Date.now() - cachedBat._updated) / 1000)}s)`);
                }
            } catch (e) {
                console.error(`Error getting status:`, e.message);
            }
        }, 20000);

        //

        setTimeout(async () => {
            console.log('\n=== Testing Device Commands ===');

            const status = await device.getStatusOperation();
            console.log(`Current status: ${status.value?.type}`);

            if (status.value?.type === 'WAITING_FOR_COMMAND' || status.value?.type === 'DOCKED' || status.value?.type === 'CHARGING') {
                console.log('Mower appears ready for commands');
                try {
                    console.log('Sending STOP command...');
                    await device.sendStop();
                    console.log('Stop command sent successfully');
                } catch (e) {
                    console.error('Stop command failed:', e.message);
                }
            } else {
                console.log(`Mower is not in a state to receive commands (${status.value?.type})`);
            }

            console.log('\nTesting settings get/update...');
            const currentSettings = await device.getSettings();
            console.log(`Current rain sensor: ${currentSettings.value?.rainSensorEnabled ? 'enabled' : 'disabled'}`);

            console.log('(Not actually changing settings in test)');
        }, 30000);

        //

        setTimeout(async () => {
            console.log('\n=== Testing Connector Removal ===');
            connectedDevice.destroy();
            console.log(`Connectors after removal: ${device.getConnectorNames().join(', ') || 'none'}`);

            try {
                const status = await device.getStatusOperation();
                console.log(`Status (from cache): ${status.value?.type || 'no data'}`);
                console.log(`  Age: ${Math.round((Date.now() - status._updated) / 1000)}s`);
            } catch (e) {
                console.error('Failed to get status:', e.message);
            }

            try {
                await device.sendStop();
                console.log('Command succeeded (unexpected!)');
            } catch (e) {
                console.log('Command failed as expected:', e.message);
            }

            setTimeout(async () => {
                console.log('\n=== Testing Connector Reconnection ===');
                const connectedDeviceNew = new StigaAPIDeviceConnector(device, connection);
                await connectedDeviceNew.listen();
                console.log(`Connectors after reconnection: ${device.getConnectorNames().join(', ')}`);
                const status = await device.getStatusAll({ refresh: 'force' });
                console.log('Fresh status after reconnection:');
                console.log(`  Operation: ${status.operation?.type || 'no data'}`);
                console.log(`  Battery: ${status.battery?.charge || 'no data'}%`);
            }, 10000);
        }, 60000);

        //

        process.on('SIGINT', () => {
            console.log('\n\nShutting down...');
            clearInterval(mainLoop);
            if (connectedDevice) connectedDevice.destroy();
            connection.disconnect();
            process.exit(0);
        });
    } catch (e) {
        console.error('Error in main execution:', e);
        process.exit(1);
    }
}

main();
