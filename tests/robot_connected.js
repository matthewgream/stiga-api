#!/usr/bin/env node

// Test different connectivity scenarios for StigaAPIDevice
// - Device with only MAC address
// - Device with Garage connection only
// - Device with DeviceConnection only
// - Device with both Garage and DeviceConnection
// - Adding/removing connectors dynamically

const { StigaAPIConnectionServer, StigaAPIGarage, StigaAPIDevice, StigaAPIConnectionDevice, StigaAPIDeviceConnector, StigaAPIFramework, StigaAPIConfig } = require('../api/StigaAPI');
const { username, password } = StigaAPIConfig.load();

async function testScenario1(macAddress) {
    console.log('\n=== SCENARIO 1: Device with only MAC address ===');

    const device = new StigaAPIDevice({ macAddress });
    console.log(`Created device: ${device.toString()}`);
    console.log(`UUID: ${(await device.getUuid())?.value || 'none'}`);
    console.log(`Serial: ${(await device.getSerialNumber())?.value || 'none'}`);

    // Try to get data - should return undefined/cached
    try {
        const version = await device.getVersion();
        console.log(`Version: ${version?.value?.toString() || 'no data'}`);
    } catch (e) {
        console.log(`Version: error - ${e.message}`);
    }

    // Try to get status - should fail
    try {
        const status = await device.getStatusOperation();
        console.log(`Status: ${status?.value?.type || 'no data'}`);
    } catch (e) {
        console.log(`Status: error - ${e.message}`);
    }

    // Try to send command - should fail
    try {
        await device.sendStop();
        console.log('Command: succeeded (unexpected!)');
    } catch (e) {
        console.log(`Command: failed as expected - ${e.message}`);
    }

    return device;
}

async function testScenario2(auth, macAddress) {
    console.log('\n=== SCENARIO 2: Device with Garage connection only ===');

    const server = new StigaAPIConnectionServer(auth);
    const garage = new StigaAPIGarage(server);
    await garage.load();

    // Find device in garage
    const device = garage.getDevices().find((d) => d.getMacAddress() === macAddress);
    if (!device) {
        console.log(`Device ${macAddress} not found in garage`);
        return undefined;
    }

    console.log(`Found device in garage: ${device.toString()}`);
    console.log(`UUID: ${(await device.getUuid())?.value}`);
    console.log(`Name: ${(await device.getName())?.value}`);
    console.log(`Serial: ${(await device.getSerialNumber())?.value}`);
    console.log(`Product: ${(await device.getProductCode())?.value}`);
    console.log(`Device Type: ${(await device.getDeviceType())?.value}`);
    console.log(`Firmware (cloud): ${(await device.getFirmwareVersion())?.value}`);
    console.log(`Total Work Time: ${(await device.getTotalWorkTime())?.value} hours`);

    // Device has garage data but no MQTT connection
    try {
        const version = await device.getVersion();
        console.log(`Version from cache: ${version?.value?.toString() || 'no data'}`);
    } catch (e) {
        console.log(`Version: error - ${e.message}`);
    }

    // Try to get status - should fail (no MQTT)
    try {
        const status = await device.getStatusOperation();
        console.log(`Status: ${status?.value?.type || 'no data'}`);
    } catch (e) {
        console.log(`Status: error - ${e.message}`);
    }

    // Try to send command - should fail (no MQTT)
    try {
        await device.sendStop();
        console.log('Command: succeeded (unexpected!)');
    } catch (e) {
        console.log(`Command: failed as expected - ${e.message}`);
    }

    return device;
}

async function testScenario3(auth, deviceData, macAddress) {
    console.log('\n=== SCENARIO 3: Device with DeviceConnection only ===');

    // Create device without garage data
    const device = new StigaAPIDevice({ macAddress });

    // Need broker ID - in real scenario this would come from somewhere else
    const brokerId = (await deviceData.getBrokerId()).value;

    // Create and install MQTT connector
    const deviceConnection = new StigaAPIConnectionDevice(auth, brokerId);
    const connectedDevice = new StigaAPIDeviceConnector(device, deviceConnection);

    console.log(`Created device: ${device.toString()}`);
    console.log(`Initial UUID: ${(await device.getUuid())?.value || 'none'}`);
    console.log(`Initial Serial: ${(await device.getSerialNumber())?.value || 'none'}`);

    // Start MQTT connection
    if (await connectedDevice.listen()) {
        console.log('MQTT connection established');
        console.log(`Connectors: ${device.getConnectorNames().join(', ')}`);

        // Get data via MQTT
        try {
            const version = await device.getVersion({ refresh: 'force' });
            console.log(`Version via MQTT: ${version.value?.toString() || 'no data'}`);

            const statusOp = await device.getStatusOperation({ refresh: 'force' });
            console.log(`Status via MQTT: ${statusOp.value?.type || 'no data'}`);

            // Try batch status
            const statusAll = await device.getStatusAll({ refresh: 'force' });
            console.log(`Battery via MQTT: ${statusAll.battery?.charge || 'no data'}%`);
        } catch (e) {
            console.log(`Data retrieval error: ${e.message}`);
        }

        // Try to send command - should work
        try {
            await device.sendStop();
            console.log('Command: succeeded');
        } catch (e) {
            console.log(`Command: failed - ${e.message}`);
        }
    } else {
        console.log('Failed to establish MQTT connection');
    }

    return { device, connectedDevice, deviceConnection };
}

async function testScenario4(auth, garageDevice) {
    console.log('\n=== SCENARIO 4: Device with both Garage and DeviceConnection ===');

    if (!garageDevice) {
        console.log('No garage device available for this test');
        return undefined;
    }

    // Add MQTT connector to garage device
    const brokerId = (await garageDevice.getBrokerId()).value;
    const deviceConnection = new StigaAPIConnectionDevice(auth, brokerId);
    const connectedDevice = new StigaAPIDeviceConnector(garageDevice, deviceConnection);

    console.log(`Device before MQTT: ${garageDevice.toString()}`);

    if (await connectedDevice.listen()) {
        console.log('MQTT connection added to garage device');
        console.log(`Connectors: ${garageDevice.getConnectorNames().join(', ')}`);

        // Now we have both cloud and device data
        console.log('\nData from both sources:');
        console.log(`UUID (cloud): ${(await garageDevice.getUuid())?.value || 'none'}`);
        console.log(`Serial (cloud): ${(await garageDevice.getSerialNumber())?.value || 'none'}`);
        console.log(`Name (cloud): ${(await garageDevice.getName())?.value || 'none'}`);

        const version = await garageDevice.getVersion({ refresh: 'force' });
        console.log(`Firmware (device): ${version.value?.firmware || 'none'}`);
        console.log(`Firmware (cloud): ${(await garageDevice.getFirmwareVersion())?.value || 'none'}`);

        // Test batch status update
        console.log('\nGetting all status (should be one MQTT request)...');
        const statusAll = await garageDevice.getStatusAll({ refresh: 'force' });
        console.log(`Operation: ${statusAll.operation?.type || 'none'}`);
        console.log(`Battery: ${statusAll.battery?.charge || 'none'}%`);
        console.log(`Mowing: ${statusAll.mowing?.zone || 'none'}`);
        console.log(`Location: ${statusAll.location?.satellites || 'none'} satellites`);
        console.log(`Network: ${statusAll.network?.type || 'none'}`);

        // Update all data (should use batching)
        console.log('\nUpdating all data (should batch status requests)...');
        await garageDevice.update();
        console.log('Update complete');
    }

    return { garageDevice, connectedDevice, deviceConnection };
}

async function testScenario5(device, connectedDevice) {
    console.log('\n=== SCENARIO 5: Dynamic connector management ===');

    if (!device || !connectedDevice) {
        console.log('No device/connector available for this test');
        return undefined;
    }

    console.log(`Initial state: ${device.toString()}`);

    // Remove MQTT connector
    console.log('\nRemoving MQTT connector...');
    connectedDevice.destroy();
    console.log(`After removal: ${device.toString()}`);

    // Try to get cached data
    try {
        const status = await device.getStatusOperation();
        console.log(`Cached status: ${status.value?.type || 'no data'}`);
        console.log(`  Age: ${Math.round((Date.now() - status._updated) / 1000)}s`);

        const battery = await device.getStatusBattery();
        console.log(`Cached battery: ${battery.value?.charge || 'no data'}%`);
        console.log(`  Age: ${Math.round((Date.now() - battery._updated) / 1000)}s`);
    } catch (e) {
        console.log(`Status error: ${e.message}`);
    }

    // Try to send command - should fail
    try {
        await device.sendStop();
        console.log('Command: succeeded (unexpected!)');
    } catch (e) {
        console.log(`Command: failed as expected - ${e.message}`);
    }

    // Re-add connector
    console.log('\nRe-adding MQTT connector...');
    const deviceConnection = connectedDevice.connection;
    const connectedDeviceNew = new StigaAPIDeviceConnector(device, deviceConnection);

    if (await connectedDeviceNew.listen()) {
        console.log(`After re-adding: ${device.toString()}`);

        // Try to send command again
        try {
            await device.sendStop();
            console.log('Command: succeeded');
        } catch (e) {
            console.log(`Command: failed - ${e.message}`);
        }

        // Get fresh status
        const status = await device.getStatusOperation({ refresh: 'force' });
        console.log(`Fresh status: ${status.value?.type || 'no data'}`);
    }

    return connectedDeviceNew;
}

async function testScenario6(framework) {
    console.log('\n=== SCENARIO 6: Testing status batching efficiency ===');

    const { device } = framework.getDeviceAndBasePair();

    // Clear any cached status first
    console.log('Clearing cached status by waiting...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\nTest 1: Individual status requests (5 separate MQTT requests expected)');
    console.time('Individual requests');
    await device.getStatusOperation({ refresh: 'force' });
    await device.getStatusBattery({ refresh: 'force' });
    await device.getStatusMowing({ refresh: 'force' });
    await device.getStatusLocation({ refresh: 'force' });
    await device.getStatusNetwork({ refresh: 'force' });
    console.timeEnd('Individual requests');

    // Clear cache again
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\nTest 2: Batch status request (1 MQTT request expected)');
    console.time('Batch request');
    await device.getStatusAll({ refresh: 'force' });
    console.timeEnd('Batch request');

    // Clear cache again
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\nTest 3: Full update (should use batching)');
    console.time('Full update');
    await device.update();
    console.timeEnd('Full update');
}

async function main() {
    try {
        console.log('=== SETUP ===');

        const framework = new StigaAPIFramework();
        if (!(await framework.load(username, password))) throw new Error('Framework failed to initialise');
        const { device } = framework.getDeviceAndBasePair();

        // Scenario 1: MAC only
        await testScenario1(device.getMacAddress());

        // Scenario 2: Garage only
        const device2 = await testScenario2(framework.auth, device.getMacAddress());

        // Scenario 3: DeviceConnection only
        const { device: device3, connectedDevice: conn3, deviceConnection: dev3 } = await testScenario3(framework.auth, device, device.getMacAddress());

        // Scenario 4: Both connections
        const result4 = await testScenario4(framework.auth, device2);

        // Scenario 5: Dynamic management
        if (device3 && conn3) await testScenario5(device3, conn3);

        // Scenario 6: Batching efficiency
        await testScenario6(framework);

        console.log('\n=== CLEANUP ===');

        if (conn3) conn3.destroy();
        if (dev3) dev3.disconnect();
        if (result4?.connectedDevice) result4.connectedDevice.destroy();
        if (result4?.deviceConnection) result4.deviceConnection.disconnect();

        console.log('All tests complete');
        process.exit(0);
    } catch (e) {
        console.error('Error in main execution:', e);
        process.exit(1);
    }
}

main();
