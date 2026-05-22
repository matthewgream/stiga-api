#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// stiga-probe-perimeters.js
//
// Read-only probe: authenticates to the Stiga Cloud, fetches the garden perimeters for the
// first device, and dumps the raw response so we can see where the zone/obstacle polygon
// coordinates live. Writes the full JSON to data/perimeters-dump.json and prints a structural
// summary (large coordinate arrays truncated) to the console.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIGarage, StigaAPIPerimeters, StigaAPIConfig } = require('../api/StigaAPI');

const { username, password } = StigaAPIConfig.load();

// describe the shape of a value, truncating long arrays so the output stays readable
function describe(value, depth = 0, keyHint = '') {
    const pad = '  '.repeat(depth);
    if (Array.isArray(value)) {
        if (value.length === 0) return '[] (empty)';
        const looksNumeric = value.every((v) => typeof v === 'number');
        if (looksNumeric) return `[${value.length} numbers] e.g. ${value.slice(0, 6).join(', ')}${value.length > 6 ? ', …' : ''}`;
        const head = `[${value.length} items]`;
        if (depth > 4) return head;
        const sample = describe(value[0], depth + 1, keyHint);
        return `${head} first =\n${pad}  ${sample}`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        if (depth > 5) return `{${keys.join(', ')}}`;
        return keys.map((k) => `${pad}  ${k}: ${describe(value[k], depth + 1, k)}`).join('\n');
    }
    if (typeof value === 'string' && value.length > 80) return `"${value.slice(0, 77)}…" (string, ${value.length} chars)`;
    return JSON.stringify(value);
}

async function main() {
    const auth = new StigaAPIAuthentication(username, password);
    if (!(await auth.isValid())) throw new Error('authentication failed');
    console.log('✓ authenticated');

    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw new Error('server connection failed');
    console.log('✓ connected to cloud');

    const garage = new StigaAPIGarage(server);
    if (!(await garage.load())) throw new Error('garage load failed');
    const devices = garage.getDevices() || [];
    console.log(`✓ garage loaded: ${devices.length} device(s)`);
    if (devices.length === 0) throw new Error('no devices');

    const device = devices[0];
    console.log(`  device: ${device.toString()}`);

    const perimeters = new StigaAPIPerimeters(server, device);
    if (!(await perimeters.load())) throw new Error('perimeters load failed');

    console.log(`\n=== SUMMARY ===`);
    console.log(`  ${perimeters.toString()}`);
    console.log(`  zones=${perimeters.getZoneCount()} obstacles=${perimeters.getObstacleCount()} totalPoints=${perimeters.getTotalPoints()}`);
    const ref = perimeters.getReferencePosition();
    const refStr = ref ? `${ref.latitude}, ${ref.longitude}` : '(none)';
    console.log(`  referencePosition: ${refStr}`);
    console.log(`  checksum=${perimeters.getChecksum()} timestamp=${perimeters.getTimestamp()}`);
    perimeters.getZones().forEach((z, i) => console.log(`  zone[${i}]: id=${z.getId()} area=${z.getArea()}m² points=${z.getNumPoints()}`));

    const raw = perimeters.perimeterData;
    const outPath = path.join(__dirname, '..', 'data', 'perimeters-dump.json');
    fs.writeFileSync(outPath, JSON.stringify(raw, undefined, 2));
    console.log(`\n=== full raw JSON written to ${outPath} ===`);

    console.log(`\n=== STRUCTURE (arrays truncated) ===`);
    console.log(describe(raw));

    const firstZone = raw?.attributes?.preview?.zones?.elements?.[0];
    if (firstZone) {
        console.log(`\n=== FIRST ZONE ELEMENT (raw keys) ===`);
        console.log(JSON.stringify(firstZone, undefined, 2).split('\n').slice(0, 60).join('\n'));
    }
}

main().catch((e) => {
    console.error('PROBE FAILED:', e.message);
    process.exit(1);
});
