#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const ANALYSERS = [
    require('./lib/analyse/BatteryCharging'), // battery charging
    require('./lib/analyse/BatteryConsumption'), // battery consumption
    require('./lib/analyse/GardenCompletion'), // garden completion
    require('./lib/analyse/PositionHeatmap'), // position heatmap
];
const analyserMap = new Map(ANALYSERS.map((Analyser) => [Analyser.getMetadata().command, Analyser]));

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function displayHelp() {
    console.log(`
Stiga Analyser

Usage:
  stiga-analyser.js [--database=<path>] <command> [options]
  
Commands:`);
    const maxCommandLength = Math.max(...ANALYSERS.map((a) => a.getMetadata().command.length));
    ANALYSERS.map((Analyser) => Analyser.getMetadata()).forEach((meta) => {
        console.log(`  ${meta.command.padEnd(maxCommandLength + 4)}${meta.description}`);
        if (meta.options) Object.entries(meta.options).forEach(([flag, desc]) => console.log(`    ${flag.padEnd(maxCommandLength + 2)}${desc}`));
    });
    console.log(`  
Global Options:
  --database=<path>    Path to SQLite database file (default: /opt/stiga-api/data/capture.db)
  --mac_device=MAC     Device MAC address (default: D0:EF:76:64:32:BA)
  --help               Show this help
  
Description:`);
    ANALYSERS.map((Analyser) => Analyser.getMetadata()).forEach((meta, index) => console.log(`  ${index + 1}. ${meta.command}: ${meta.detailedDescription}`));
    console.log(`  
Examples:`);
    ANALYSERS.map((Analyser) => Analyser.getMetadata()).forEach((meta) => meta.examples.forEach((example) => console.log(`  ${example}`)));
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

let robotMac = 'D0:EF:76:64:32:BA';
let dbPath = '/opt/stiga-api/data/capture.db';

async function main() {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
        displayHelp();
        process.exit(0);
    }
    const dbArgIndex = args.findIndex((arg) => arg.startsWith('--database='));
    if (dbArgIndex !== -1) {
        dbPath = args[dbArgIndex].split('=')[1];
        args.splice(dbArgIndex, 1);
    }
    if (args.length === 0) {
        console.error('Error: No command specified');
        displayHelp();
        process.exit(1);
    }
    const command = args[0];
    const AnalyserClass = analyserMap.get(command);
    if (!AnalyserClass) {
        console.error(`Unknown command: ${command}`);
        console.error(`Valid commands: ${[...analyserMap.keys()].join(', ')}`);
        process.exit(1);
    }
    const macArg = args.find((arg) => arg.startsWith('--mac_device='));
    if (macArg) robotMac = macArg.split('=')[1];
    const options = { robotMac };
    const meta = AnalyserClass.getMetadata();
    if (meta.options)
        Object.keys(meta.options).forEach((flag) => {
            const flagIndex = args.indexOf(flag);
            if (flagIndex !== -1) options[flag] = flagIndex + 1 < args.length && !args[flagIndex + 1].startsWith('--') ? args[flagIndex + 1] : true;
        });
    let analyser;
    try {
        analyser = new AnalyserClass(dbPath);
        analyser.open();
        await analyser.analyze(options);
    } catch (e) {
        console.error('Error:', e.message);
        process.exit(1);
    } finally {
        analyser?.close();
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

main();

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
