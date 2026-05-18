#!/usr/bin/env node

// Test different connectivity scenarios for StigaAPIBase
// - Base with only MAC address
// - Base with Garage connection only
// - Base with DeviceConnection only
// - Base with both Garage and DeviceConnection
// - Adding/removing connectors dynamically

const { StigaAPIConnectionServer, StigaAPIGarage, StigaAPIBase, StigaAPIConnectionDevice, StigaAPIBaseConnector, StigaAPIFramework, StigaAPIConfig } = require('../api/StigaAPI');
const { username, password } = StigaAPIConfig.load();

async function testScenario1(macAddress) {
    console.log('\n=== SCENARIO 1: Base with only MAC address ===');

    const base = new StigaAPIBase({ macAddress });
    console.log(`Created base: ${base.toString()}`);
    console.log(`UUID: ${(await base.getUuid())?.value || 'none'}`);
    console.log(`Serial: ${(await base.getSerialNumber())?.value || 'none'}`);

    // Try to get data - should return undefined/cached
    try {
        const version = await base.getVersion();
        console.log(`Version: ${version?.value?.toString() || 'no data'}`);
    } catch (e) {
        console.log(`Version: error - ${e.message}`);
    }

    // Try to set LED - should fail
    try {
        await base.setSetting('led', 'off');
        console.log('LED setting: succeeded (unexpected!)');
    } catch (e) {
        console.log(`LED setting: failed as expected - ${e.message}`);
    }

    return base;
}

async function testScenario2(auth, macAddress) {
    console.log('\n=== SCENARIO 2: Base with Garage connection only ===');

    const server = new StigaAPIConnectionServer(auth);
    const garage = new StigaAPIGarage(server);
    await garage.load();

    // Find base in garage
    const base = garage.getBases().find((b) => b.getMacAddress() === macAddress);
    if (!base) {
        console.log(`Base ${macAddress} not found in garage`);
        return undefined;
    }

    console.log(`Found base in garage: ${base.toString()}`);
    console.log(`UUID: ${(await base.getUuid())?.value}`);
    console.log(`Serial: ${(await base.getSerialNumber())?.value}`);
    console.log(`Product: ${(await base.getProductCode())?.value}`);
    console.log(`Firmware (cloud): ${(await base.getFirmwareVersion())?.value}`);

    // Base has garage data but no MQTT connection
    try {
        const version = await base.getVersion();
        console.log(`Version from cache: ${version?.value?.toString() || 'no data'}`);
    } catch (e) {
        console.log(`Version: error - ${e.message}`);
    }

    // Try to set LED - should fail (no MQTT)
    try {
        await base.setSetting('led', 'off');
        console.log('LED setting: succeeded (unexpected!)');
    } catch (e) {
        console.log(`LED setting: failed as expected - ${e.message}`);
    }

    return base;
}

async function testScenario3(auth, device, macAddress) {
    console.log('\n=== SCENARIO 3: Base with DeviceConnection only ===');

    // Create base without garage data
    const base = new StigaAPIBase({ macAddress });

    // Create and install MQTT connector
    const deviceConnection = new StigaAPIConnectionDevice(auth, (await device.getBrokerId()).value);
    const connectedBase = new StigaAPIBaseConnector(base, deviceConnection);

    console.log(`Created base: ${base.toString()}`);
    console.log(`Initial UUID: ${(await base.getUuid())?.value || 'none'}`);
    console.log(`Initial Serial: ${(await base.getSerialNumber())?.value || 'none'}`);

    // Start MQTT connection
    if (await connectedBase.listen()) {
        console.log('MQTT connection established');
        console.log(`Connectors: ${base.getConnectorNames().join(', ')}`);

        // Get data via MQTT
        try {
            const version = await base.getVersion({ refresh: 'force' });
            console.log(`Version via MQTT: ${version.value.toString()}`);
            const statusOp = await base.getStatusOperation({ refresh: 'force' });
            console.log(`Status Operation via MQTT: type=${statusOp.value?.type}, flag=${statusOp.value?.flag}`);
            const statusAll = await base.getStatusAll({ refresh: 'force' });
            console.log(`Status All via MQTT:`);
            console.log(`  Operation: type=${statusAll.operation?.type}, flag=${statusAll.operation?.flag}`);
            console.log(`  Location: ${statusAll.location?.toString() || 'no data'}`);
            console.log(`  Network: ${statusAll.network?.toString() || 'no data'}`);
        } catch (e) {
            console.log(`Data retrieval error: ${e.message}`);
        }

        // Try to set LED - should work
        try {
            await base.setSetting('led', 'off');
            console.log('LED setting: succeeded');
        } catch (e) {
            console.log(`LED setting: failed - ${e.message}`);
        }
    } else {
        console.log('Failed to establish MQTT connection');
    }

    return { base, connectedBase, deviceConnection };
}

async function testScenario4(auth, device, garageBase) {
    console.log('\n=== SCENARIO 4: Base with both Garage and DeviceConnection ===');

    if (!garageBase) {
        console.log('No garage base available for this test');
        return undefined;
    }

    // Add MQTT connector to garage base
    const deviceConnection = new StigaAPIConnectionDevice(auth, (await device.getBrokerId()).value);
    const connectedBase = new StigaAPIBaseConnector(garageBase, deviceConnection);

    console.log(`Base before MQTT: ${garageBase.toString()}`);

    if (await connectedBase.listen()) {
        console.log('MQTT connection added to garage base');
        console.log(`Connectors: ${garageBase.getConnectorNames().join(', ')}`);

        // Now we have both cloud and device data
        console.log('\nData from both sources:');
        console.log(`UUID (cloud): ${(await garageBase.getUuid())?.value || 'none'}`);
        console.log(`Serial (cloud): ${(await garageBase.getSerialNumber())?.value || 'none'}`);

        const version = await garageBase.getVersion({ refresh: 'force' });
        console.log(`Firmware (device): ${version.value?.firmware || 'none'}`);
        console.log(`Firmware (cloud): ${(await garageBase.getFirmwareVersion())?.value || 'none'}`);

        // Update all data
        console.log('\nUpdating all data...');
        await garageBase.update();
        console.log('Update complete');
    }

    return { garageBase, connectedBase, deviceConnection };
}

async function testScenario5(base, connectedBase) {
    console.log('\n=== SCENARIO 5: Dynamic connector management ===');

    if (!base || !connectedBase) {
        console.log('No base/connector available for this test');
        return undefined;
    }

    console.log(`Initial state: ${base.toString()}`);

    // Remove MQTT connector
    console.log('\nRemoving MQTT connector...');
    connectedBase.destroy();
    console.log(`After removal: ${base.toString()}`);

    // Try to get cached data
    try {
        const status = await base.getStatusOperation();
        console.log(`Cached status: type=${status.value?.type}, flag=${status.value?.flag}`);
        console.log(`  Age: ${Math.round((Date.now() - status._updated) / 1000)}s`);
    } catch (e) {
        console.log(`Status error: ${e.message}`);
    }

    // Try to set LED - should fail
    try {
        await base.setSetting('led', 'always');
        console.log('LED setting: succeeded (unexpected!)');
    } catch (e) {
        console.log(`LED setting: failed as expected - ${e.message}`);
    }

    // Re-add connector
    console.log('\nRe-adding MQTT connector...');
    const deviceConnection = connectedBase.connection;
    const connectedBaseNew = new StigaAPIBaseConnector(base, deviceConnection);

    if (await connectedBaseNew.listen()) {
        console.log(`After re-adding: ${base.toString()}`);

        // Try to set LED again
        try {
            await base.setSetting('led', 'always');
            console.log('LED setting: succeeded');
        } catch (e) {
            console.log(`LED setting: failed - ${e.message}`);
        }
    }

    return connectedBaseNew;
}

async function testScenario6(framework) {
    console.log('\n=== SCENARIO 6: Testing status batching efficiency ===');

    const { base } = framework.getDeviceAndBasePair();

    // Clear any cached status first
    console.log('Clearing cached status by waiting...');
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\nTest 1: Individual status requests (3 separate MQTT requests expected)');
    console.time('Individual requests');
    await base.getStatusOperation({ refresh: 'force' });
    await base.getStatusLocation({ refresh: 'force' });
    await base.getStatusNetwork({ refresh: 'force' });
    console.timeEnd('Individual requests');

    // Clear cache again
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\nTest 2: Batch status request (1 MQTT request expected)');
    console.time('Batch request');
    await base.getStatusAll({ refresh: 'force' });
    console.timeEnd('Batch request');

    // Clear cache again
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log('\nTest 3: Full update (should use batching)');
    console.time('Full update');
    await base.update();
    console.timeEnd('Full update');
}

async function main() {
    try {
        console.log('=== SETUP ===');

        const framework = new StigaAPIFramework();
        if (!(await framework.load(username, password))) throw new Error('Framework failed to intiaialise');
        const { device, base } = framework.getDeviceAndBasePair();

        // Scenario 1: MAC only
        await testScenario1(base.getMacAddress());

        // Scenario 2: Garage only
        const base2 = await testScenario2(framework.auth, base.getMacAddress());

        // Scenario 3: DeviceConnection only
        const { base: base3, connectedBase: conn3, deviceConnection: dev3 } = await testScenario3(framework.auth, device, base.getMacAddress());

        // Scenario 4: Both connections
        const result4 = await testScenario4(framework.auth, device, base2);

        // Scenario 5: Dynamic management
        if (base3 && conn3) await testScenario5(base3, conn3);

        // Scenario 6: Batching efficiency
        await testScenario6(framework);

        console.log('\n=== CLEANUP ===');

        if (conn3) conn3.destroy();
        if (dev3) dev3.disconnect();
        if (result4?.connectedBase) result4.connectedBase.destroy();
        if (result4?.deviceConnection) result4.deviceConnection.disconnect();

        console.log('All tests complete');
        process.exit(0);
    } catch (e) {
        console.error('Error in main execution:', e);
        process.exit(1);
    }
}

main();
