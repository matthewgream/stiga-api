#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIFramework, StigaAPIConnectionDevice, StigaAPIDeviceConnector, StigaAPIBaseConnector } = require('../api/StigaAPI');
const { username, password } = require('../stiga_user_and_pass.js');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

let globalOptions = {
    debug: false,
    verbose: false,
};

const display = {
    log: (...args) => console.log(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => {
        if (globalOptions.debug) console.log('[DEBUG]', ...args);
    },
    verbose: (...args) => {
        if (globalOptions.verbose || globalOptions.debug) console.log('[VERBOSE]', ...args);
    },
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const commands = {};

function registerCommand(name, config) {
    commands[name] = config;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        target: undefined,
        command: undefined,
        params: [],
        debug: false,
        verbose: false,
        watch: undefined,
    };
    let i = 0;
    while (i < args.length) {
        // eslint-disable-next-line unicorn/prefer-switch
        if (args[i] === '--base') {
            options.target = ['robot', 'both'].includes(options.target) ? 'both' : 'base';
            i++;
        } else if (args[i] === '--robot') {
            options.target = ['base', 'both'].includes(options.target) ? 'both' : 'robot';
            i++;
        } else if (args[i] === '--both') {
            options.target = 'both';
            i++;
        } else if (args[i] === '--debug') {
            options.debug = true;
            i++;
        } else if (args[i] === '--verbose') {
            options.verbose = true;
            i++;
        } else if (args[i] === '--watch') {
            options.watch = 5;
            if (i + 1 < args.length && /^\d+$/.test(args[i + 1]) && Number.parseInt(args[i + 1]) > 0) options.watch = Number.parseInt(args[++i]);
            i++;
            // eslint-disable-next-line unicorn/no-negated-condition
        } else if (!options.command) {
            options.command = args[i];
            i++;
        } else {
            options.params.push(args[i]);
            i++;
        }
    }
    if (!options.target) options.target = 'both';
    globalOptions = { debug: options.debug, verbose: options.verbose };
    return options;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function parseDays(dayStr) {
    const dayMap = {
        mon: 0,
        monday: 0,
        tue: 1,
        tuesday: 1,
        wed: 2,
        wednesday: 2,
        thu: 3,
        thursday: 3,
        fri: 4,
        friday: 4,
        sat: 5,
        saturday: 5,
        sun: 6,
        sunday: 6,
    };
    return dayStr
        .toLowerCase()
        .split(',')
        .map((d) => d.trim())
        .map((day) => {
            if (dayMap[day] === undefined) throw new Error(`Invalid day: ${day}`);
            return dayMap[day];
        });
}

function parseTime(timeStr) {
    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) throw new Error(`Invalid time format: ${timeStr}. Use HH:MM format.`);
    const hour = Number.parseInt(match[1]),
        minute = Number.parseInt(match[2]);
    if (hour < 0 || hour >= 24) throw new Error(`Invalid hour: ${hour}. Must be 0-23.`);
    if (minute !== 0 && minute !== 30) throw new Error(`Invalid minute: ${minute}. Must be 0 or 30.`);
    return { hour, minute };
}

function parseTimeBlock(blockStr) {
    const match = blockStr.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!match) throw new Error(`Invalid time block format: ${blockStr}. Use HH:MM-HH:MM format.`);
    const startTime = parseTime(match[1]),
        endTime = parseTime(match[2]);
    return { startTime, endTime };
}

function parseScheduleSpecs(specs) {
    return specs.flatMap((spec) => {
        const colonIndex = spec.indexOf(':');
        if (colonIndex === -1) throw new Error(`Invalid schedule spec: ${spec}. Use format: days:HH:MM-HH:MM`);
        const timeBlock = parseTimeBlock(spec.slice(colonIndex + 1));
        return parseDays(spec.slice(0, colonIndex)).map((dayIndex) => ({ dayIndex, ...timeBlock }));
    });
}

function displaySchedule(schedule) {
    display.log(`Schedule ${schedule.enabled ? 'enabled' : 'disabled'}, ${schedule.totalBlocks} blocks for ${Math.floor(schedule.totalMinutes / 60)}h${schedule.totalMinutes % 60}m`);
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    if (schedule.totalBlocks === 0) display.log('  (No scheduled times)');
    else for (let i = 0; i < 7; i++) if (schedule.days[i].timeBlocks.length > 0) display.log(`  ${days[i]}: ${schedule.days[i].timeBlocks.map((b) => b.displayTime).join(', ')}`);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function connectToRobot(device, connectors) {
    if (!device.hasConnector('mqtt')) {
        display.verbose('Connecting to robot ...');
        connectors.deviceConnection = new StigaAPIConnectionDevice(connectors.auth, (await device.getBrokerId()).value, { debug: globalOptions.debug });
        connectors.connectedDevice = new StigaAPIDeviceConnector(device, connectors.deviceConnection);
        if (!(await connectors.connectedDevice.listen())) throw new Error('Failed to connect to robot');
        display.debug('Robot connected successfully');
    }
}

async function connectToBase(base, connectors) {
    if (!base.hasConnector('mqtt')) {
        display.verbose('Connecting to base ...');
        if (!connectors.deviceConnection) connectors.deviceConnection = new StigaAPIConnectionDevice(connectors.auth, (await connectors.device.getBrokerId()).value, { debug: globalOptions.debug });
        connectors.connectedBase = new StigaAPIBaseConnector(base, connectors.deviceConnection);
        if (!(await connectors.connectedBase.listen())) throw new Error('Failed to connect to base');
        display.debug('Base connected successfully');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function formatWatchValue(value) {
    if (value === undefined || value === null) return String(value);
    if (typeof value !== 'object') return String(value);
    if (typeof value.toString === 'function' && value.toString !== Object.prototype.toString) return value.toString();
    return Object.entries(value)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
}

function formatWatchTimestamp() {
    return new Date().toISOString().slice(11, 19);
}

async function runWatch(options, context) {
    const { target, device, base, connectors } = context;
    const intervalSeconds = options.watch;
    const intervalMs = intervalSeconds * 1000;

    const watchRobot = target === 'both' || target === 'robot';
    const watchBase = target === 'both' || target === 'base';

    if (watchRobot) await connectToRobot(device, connectors);
    if (watchBase) await connectToBase(base, connectors);

    let pollTimer;
    let stopping = false;

    const log = (source, kind, value) => display.log(`[${formatWatchTimestamp()}] ${source} ${kind}: ${formatWatchValue(value)}`);

    const schedulePoll = () => {
        if (stopping) return;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(async () => {
            if (stopping) return;
            display.verbose(`[${formatWatchTimestamp()}] watch poll (idle ${intervalSeconds}s)`);
            try {
                if (watchRobot) await device.getStatusAll({ refresh: 'force' });
                if (watchBase) await base.getStatusAll({ refresh: 'force' });
            } catch (e) {
                display.error(`[${formatWatchTimestamp()}] watch poll failed: ${e.message}`);
            }
            schedulePoll();
        }, intervalMs);
    };

    const onEvent = (source, kind) => (value) => {
        log(source, kind, value);
        schedulePoll();
    };

    if (watchRobot && connectors.connectedDevice) {
        const cd = connectors.connectedDevice;
        cd.on('statusOperation', onEvent('robot', 'operation'));
        cd.on('statusBattery', onEvent('robot', 'battery'));
        cd.on('statusMowing', onEvent('robot', 'mowing'));
        cd.on('statusLocation', onEvent('robot', 'location'));
        cd.on('statusNetwork', onEvent('robot', 'network'));
        cd.on('position', onEvent('robot', 'position'));
        cd.on('notification', onEvent('robot', 'notification'));
    }
    if (watchBase && connectors.connectedBase) {
        const cb = connectors.connectedBase;
        cb.on('statusOperation', onEvent('base', 'operation'));
        cb.on('statusLocation', onEvent('base', 'location'));
        cb.on('statusNetwork', onEvent('base', 'network'));
        cb.on('notification', onEvent('base', 'notification'));
    }

    display.log(`[${formatWatchTimestamp()}] watch starting (poll every ${intervalSeconds}s when idle, Ctrl-C to stop)`);
    schedulePoll();

    await new Promise((resolve) =>
        process.once('SIGINT', () => {
            stopping = true;
            if (pollTimer) clearTimeout(pollTimer);
            display.log(`\n[${formatWatchTimestamp()}] watch stopping`);
            resolve();
        })
    );
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

registerCommand('version', {
    description: 'Get version information',
    targets: ['robot', 'base'],
    help: () => {
        display.log('Usage: stiga-command [--robot|--base] version [help]');
        display.log('\nGet version information for the selected target.');
        display.log('\nExamples:');
        display.log('  stiga-command --robot version');
        display.log('  stiga-command --base version');
    },
    execute: async (options, context) => {
        const { target, device, base, connectors } = context;
        if (target === 'both' || target === 'robot') {
            await connectToRobot(device, connectors);
            const version = await device.getVersion({ refresh: 'force' });
            display.log('Robot Version:');
            display.log(version.value.toString({ compressed: false }));
        }
        if (target === 'both' || target === 'base') {
            await connectToBase(base, connectors);
            const version = await base.getVersion({ refresh: 'force' });
            display.log('Base Version:');
            display.log(version.value.toString({ compressed: false }));
        }
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

registerCommand('status', {
    description: 'Get status information',
    targets: ['robot', 'base'],
    help: () => {
        display.log('Usage: stiga-command [--robot|--base] status [types] [help]');
        display.log('\nGet status information for the selected target.');
        display.log('\nRobot status types:');
        display.log('  operation - Operational status (type, valid, docking)');
        display.log('  battery   - Battery status (charge level, capacity)');
        display.log('  mowing    - Mowing status (zone, completion)');
        display.log('  location  - GPS/location status');
        display.log('  network   - Network connectivity status');
        display.log('\nBase status types:');
        display.log('  operation - Operational status (type, flag)');
        display.log('  location  - GPS/RTK location status');
        display.log('  network   - Network connectivity status');
        display.log('\nExamples:');
        display.log('  stiga-command --robot status');
        display.log('  stiga-command --robot status battery,operation');
        display.log('  stiga-command --base status detailed');
    },
    execute: async (options, context) => {
        const { target, params, device, base, connectors } = context;
        if (target === 'both' || target === 'robot') {
            await connectToRobot(device, connectors);
            if (params.length === 0) {
                const status = await device.getStatusAll({ refresh: 'force' });
                display.log('Robot Status:');
                if (status.operation) display.log(`  Operation: ${status.operation.type}, valid=${status.operation.valid}, docking=${status.operation.docking}`);
                if (status.battery) display.log(`  Battery: ${status.battery.toString()}`);
                if (status.mowing) display.log(`  Mowing: ${status.mowing.toString()}`);
                if (status.location) display.log(`  Location: ${status.location.toString()}`);
                if (status.network) display.log(`  Network: ${status.network.toString()}`);
            } else {
                const types = params[0].split(',');
                for (const type of types) {
                    const typeClean = type.trim().toLowerCase();
                    switch (typeClean) {
                        case 'operation':
                            const opStatus = await device.getStatusOperation({ refresh: 'force' });
                            display.log(`Operation: ${opStatus.value?.type || 'unknown'}, valid=${opStatus.value?.valid}, docking=${opStatus.value?.docking}`);
                            break;
                        case 'battery':
                            const batStatus = await device.getStatusBattery({ refresh: 'force' });
                            display.log(`Battery: ${batStatus.value?.toString() || 'unknown'}`);
                            break;
                        case 'mowing':
                            const mowStatus = await device.getStatusMowing({ refresh: 'force' });
                            display.log(`Mowing: ${mowStatus.value?.toString() || 'unknown'}`);
                            break;
                        case 'location':
                            const locStatus = await device.getStatusLocation({ refresh: 'force' });
                            display.log(`Location: ${locStatus.value?.toString() || 'unknown'}`);
                            break;
                        case 'network':
                            const netStatus = await device.getStatusNetwork({ refresh: 'force' });
                            display.log(`Network: ${netStatus.value?.toString() || 'unknown'}`);
                            break;
                        default:
                            display.log(`Unknown status type: ${type}`);
                    }
                }
            }
        }
        if (target === 'both' || target === 'base') {
            await connectToBase(base, connectors);
            if (params.length === 0) {
                const status = await base.getStatusAll({ refresh: 'force' });
                display.log('Base Status:');
                if (status.operation) display.log(`  Operation: type=${status.operation.type}, flag=${status.operation.flag}`);
                if (status.location) display.log(`  Location: ${status.location.toString()}`);
                if (status.network) display.log(`  Network: ${status.network.toString()}`);
            } else {
                const types = params[0].split(',');
                for (const type of types) {
                    const typeClean = type.trim().toLowerCase();
                    switch (typeClean) {
                        case 'operation':
                            const opStatus = await base.getStatusOperation({ refresh: 'force' });
                            display.log(`Operation: type=${opStatus.value?.type}, flag=${opStatus.value?.flag}`);
                            break;
                        case 'location':
                            const locStatus = await base.getStatusLocation({ refresh: 'force' });
                            display.log(`Location: ${locStatus.value?.toString() || 'unknown'}`);
                            break;
                        case 'network':
                            const netStatus = await base.getStatusNetwork({ refresh: 'force' });
                            display.log(`Network: ${netStatus.value?.toString() || 'unknown'}`);
                            break;
                        default:
                            display.log(`Unknown status type for base: ${type}`);
                    }
                }
            }
        }
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function scheduleUpdateAndDisplay(device, subCommand, value) {
    await device.setScheduleSettings(value);
    display.log(`Schedule ${subCommand}d`);
    const updated = await device.getScheduleSettings({ refresh: 'force' });
    displaySchedule(updated.value);
}

registerCommand('schedule', {
    description: 'Manage robot schedule',
    targets: ['robot'],
    help: () => {
        display.log('Usage: stiga-command --robot schedule [subcommand] [params...] [help]');
        display.log("\nManage the robot's mowing schedule.");
        display.log('\nSubcommands:');
        display.log('  (none)           - Display current schedule');
        display.log('  enable           - Enable the schedule');
        display.log('  disable          - Disable the schedule');
        display.log('  insert <specs>   - Insert time blocks');
        display.log('  add <specs>      - Alias for insert');
        display.log('  remove <specs>   - Remove time blocks');
        display.log('\nSchedule specification format:');
        display.log('  days:HH:MM-HH:MM');
        display.log('\nDays can be:');
        display.log('  Mon, Tue, Wed, Thu, Fri, Sat, Sun (or full names)');
        display.log('  Multiple days separated by commas: Mon,Wed,Fri');
        display.log('\nTimes must be on half-hour boundaries (00 or 30 minutes)');
        display.log('\nExamples:');
        display.log('  stiga-command --robot schedule');
        display.log('  stiga-command --robot schedule enable');
        display.log('  stiga-command --robot schedule insert Mon,Wed,Fri:09:00-11:30');
        display.log('  stiga-command --robot schedule insert Sat,Sun:08:00-10:00 Sat,Sun:14:00-16:00');
        display.log('  stiga-command --robot schedule remove Tue:14:00-16:00');
    },
    execute: async (options, context) => {
        const { params, device, connectors } = context;
        await connectToRobot(device, connectors);
        if (params.length === 0) {
            const schedule = await device.getScheduleSettings({ refresh: 'force' });
            displaySchedule(schedule.value);
            return;
        }
        const subCommand = params[0].toLowerCase();
        switch (subCommand) {
            case 'enable':
            case 'disable': {
                const schedule = await device.getScheduleSettings({ refresh: 'force' });
                schedule.value.enabled = subCommand === 'enable';
                await scheduleUpdateAndDisplay(device, subCommand, schedule.value);
                break;
            }

            case 'remove': {
                if (params.length < 2) throw new Error('Remove requires schedule specifications');
                const schedule = await device.getScheduleSettings({ refresh: 'force' });
                for (const spec of parseScheduleSpecs(params.slice(1))) {
                    try {
                        schedule.value.removeTimeBlock(spec.dayIndex, spec.startTime);
                        display.log(`Removed ${spec.startTime.hour}:${spec.startTime.minute.toString().padStart(2, '0')} from day ${spec.dayIndex}`);
                    } catch (e) {
                        display.error(`Failed to remove time block, aborting without saving: ${e.message}`);
                        return;
                    }
                }
                await scheduleUpdateAndDisplay(device, 'updated', schedule.value);
                break;
            }

            case 'insert': {
                if (params.length < 2) throw new Error('Insert requires schedule specifications');
                const schedule = await device.getScheduleSettings({ refresh: 'force' });
                for (const spec of parseScheduleSpecs(params.slice(1))) {
                    try {
                        schedule.value.insertTimeBlock(spec.dayIndex, spec.startTime, spec.endTime);
                        display.log(`Inserted ${spec.startTime.hour}:${spec.startTime.minute.toString().padStart(2, '0')}-${spec.endTime.hour}:${spec.endTime.minute.toString().padStart(2, '0')} to day ${spec.dayIndex}`);
                    } catch (e) {
                        display.error(`Failed to insert time block, aborting without saving: ${e.message}`);
                        return;
                    }
                }
                await scheduleUpdateAndDisplay(device, 'updated', schedule.value);
                break;
            }

            default:
                throw new Error(`Unknown schedule subcommand: ${subCommand}`);
        }
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

registerCommand('start', {
    description: 'Start mowing',
    targets: ['robot'],
    help: () => {
        display.log('Usage: stiga-command --robot start [help]');
        display.log('\nStart the robot mowing.');
        display.log('\nExamples:');
        display.log('  stiga-command --robot start');
    },
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendStart();
        display.log('Start command sent');
    },
});

registerCommand('stop', {
    description: 'Stop the robot',
    targets: ['robot'],
    help: () => {
        display.log('Usage: stiga-command --robot stop [help]');
        display.log('\nStop the robot.');
        display.log('\nExamples:');
        display.log('  stiga-command --robot stop');
    },
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendStop();
        display.log('Stop command sent');
    },
});

registerCommand('go-home', {
    description: 'Send the robot home to dock',
    targets: ['robot'],
    help: () => {
        display.log('Usage: stiga-command --robot go-home [help]');
        display.log('\nSend the robot back to its docking station.');
        display.log('\nExamples:');
        display.log('  stiga-command --robot go-home');
    },
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendGoHome();
        display.log('Go-home command sent');
    },
});

registerCommand('calibrate-blades', {
    description: 'Calibrate the cutting blades',
    targets: ['robot'],
    help: () => {
        display.log('Usage: stiga-command --robot calibrate-blades [help]');
        display.log('\nTrigger blade calibration on the robot.');
        display.log('\nExamples:');
        display.log('  stiga-command --robot calibrate-blades');
    },
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendCalibrateBlades();
        display.log('Calibrate-blades command sent');
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function showGeneralHelp() {
    display.log('Usage: stiga-command [options] <command> [params...]');
    display.log('\nOptions:');
    display.log('  --robot          Select/Add robot as target');
    display.log('  --base           Select/Add base station as target');
    display.log('  --both           Select both robot and base station as targets (default)');
    display.log('  --debug          Enable debug output');
    display.log('  --verbose        Enable verbose output');
    display.log('  --watch [secs]   Watch and show events: request status every "secs" (default 5) if idle');
    display.log('\nCommands:');

    for (const [name, cmd] of Object.entries(commands)) display.log(`  ${name.padEnd(15)} ${cmd.description} (${cmd.targets.join(', ')})`);

    display.log('\nFor command-specific help:');
    display.log('  stiga-command <command> help');
    display.log('\nExamples:');
    display.log('  stiga-command version help');
    display.log('  stiga-command --robot status');
    display.log('  stiga-command --robot schedule help');
}

async function main() {
    const options = parseArgs();

    if (!options.command && !options.watch) {
        await showGeneralHelp();
        process.exit(1);
    }

    let cmd;
    if (options.command) {
        if (options.params.length > 0 && options.params[options.params.length - 1] === 'help') {
            const c = commands[options.command.toLowerCase()];
            if (c?.help) {
                c.help();
                process.exit(0);
            }
        }
        cmd = commands[options.command.toLowerCase()];
        if (!cmd) {
            display.error(`Unknown command: ${options.command}`);
            await showGeneralHelp();
            process.exit(1);
        }
        if (options.target !== 'both' && !cmd.targets.includes(options.target)) {
            display.error(`Command '${options.command}' does not support target '${options.target}' (only ${cmd.targets.join(', ')})`);
            process.exit(1);
        }
    }

    try {
        display.debug('Initializing framework...');
        const framework = new StigaAPIFramework({ debug: options.debug });
        if (!(await framework.load(username, password))) throw new Error('Failed to load framework');
        const { device, base } = framework.getDeviceAndBasePair();
        if (!device) throw new Error('No robot found');
        if (options.target !== 'robot' && !base) throw new Error('No base found for robot');
        const robotStr = `robot/${device.getMacAddress()} '${(await device.getName()).value}'`;
        const baseStr = base ? `base/${base.getMacAddress()}` : '';
        display.log(`Connected to ${robotStr + (options.target === 'robot' ? '' : ' and ' + baseStr)}`);

        const connectors = {
            auth: framework.auth,
            device,
            base,
            deviceConnection: undefined,
            connectedDevice: undefined,
            connectedBase: undefined,
        };
        const context = {
            target: options.target,
            params: options.params.filter((p) => p !== 'help'),
            device,
            base,
            connectors,
            options,
        };

        if (cmd) {
            display.debug(`Executing command: ${options.command}`);
            await cmd.execute(options, context);
        }

        if (options.watch) await runWatch(options, context);

        display.debug('Cleaning up connections...');
        if (connectors.connectedDevice) connectors.connectedDevice.destroy();
        if (connectors.connectedBase) connectors.connectedBase.destroy();
        if (connectors.deviceConnection) connectors.deviceConnection.disconnect();

        process.exit(0);
    } catch (e) {
        display.error('Error:', e.message);
        if (options.debug) display.error(e.stack);
        process.exit(1);
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

main();

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
