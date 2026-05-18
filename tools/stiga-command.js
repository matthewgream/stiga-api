#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIFramework, StigaAPIConnectionDevice, StigaAPIDeviceConnector, StigaAPIBaseConnector } = require('../api/StigaAPI');
const { username, password } = require('../stiga_user_and_pass.js');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const LEVELS = { quiet: 0, normal: 1, verbose: 2 };

let globalOptions = {
    debug: false,
    level: LEVELS.normal,
    format: 'text',
};

const display = {
    log: (...args) => globalOptions.level >= LEVELS.normal && console.log(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => globalOptions.debug && console.error('[DEBUG]', ...args),
    verbose: (...args) => (globalOptions.level >= LEVELS.verbose || globalOptions.debug) && console.error('[VERBOSE]', ...args),
    out: (...args) => console.log(...args),
    text: (...args) => globalOptions.format === 'text' && globalOptions.level >= LEVELS.normal && console.log(...args),
    json: (obj) => globalOptions.format === 'json' && console.log(JSON.stringify(obj)),
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const commands = {};
const aliases = {};

function registerCommand(names, config) {
    const [primary, ...rest] = Array.isArray(names) ? names : [names];
    commands[primary] = { ...config, name: primary, aliases: rest };
    for (const alias of rest) aliases[alias] = primary;
}

function resolveCommand(name) {
    const key = name.toLowerCase();
    if (commands[key]) return commands[key];
    if (aliases[key]) return commands[aliases[key]];
    const matches = new Set();
    for (const n of Object.keys(commands)) if (n.startsWith(key)) matches.add(n);
    for (const [a, p] of Object.entries(aliases)) if (a.startsWith(key)) matches.add(p);
    if (matches.size === 0) return undefined;
    if (matches.size === 1) return commands[[...matches][0]];
    throw new Error(`Ambiguous command '${name}': matches ${[...matches].join(', ')}`);
}

function showCommandHelp(cmd) {
    display.log(`Usage: ${cmd.usage}`);
    if (cmd.summary) display.log(`\n${cmd.summary}`);
    if (cmd.details) for (const line of cmd.details) display.log(line);
    if (cmd.examples?.length > 0) {
        display.log('\nExamples:');
        for (const ex of cmd.examples) display.log(`  ${ex}`);
    }
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
        level: 'normal',
        watch: undefined,
        format: 'text',
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
        } else if (args[i] === '--level') {
            if (i + 1 >= args.length) throw new Error('--level requires a value (quiet|normal|verbose)');
            const v = args[++i].toLowerCase();
            if (LEVELS[v] === undefined) throw new Error(`Invalid --level value '${v}': must be quiet|normal|verbose`);
            options.level = v;
            i++;
        } else if (args[i] === '--watch') {
            options.watch = 5;
            if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) options.watch = Number.parseInt(args[++i]);
            i++;
        } else if (args[i] === '--format') {
            if (i + 1 >= args.length) throw new Error('--format requires a value (text|json|none)');
            const v = args[++i].toLowerCase();
            if (!['text', 'json', 'none'].includes(v)) throw new Error(`Invalid --format value '${v}': must be text|json|none`);
            options.format = v;
            i++;
        } else if (!options.command) {
            options.command = args[i];
            i++;
        } else {
            options.params.push(args[i]);
            i++;
        }
    }
    if (!options.target) options.target = 'both';
    globalOptions = { debug: options.debug, level: LEVELS[options.level], format: options.format };
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
    const hour = Number.parseInt(match[1]);
    const minute = Number.parseInt(match[2]);
    if (hour < 0 || hour >= 24) throw new Error(`Invalid hour: ${hour}. Must be 0-23.`);
    if (minute !== 0 && minute !== 30) throw new Error(`Invalid minute: ${minute}. Must be 0 or 30.`);
    return { hour, minute };
}

function parseTimeBlock(blockStr) {
    const match = blockStr.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!match) throw new Error(`Invalid time block format: ${blockStr}. Use HH:MM-HH:MM format.`);
    const startTime = parseTime(match[1]);
    const endTime = parseTime(match[2]);
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
    display.text(`Schedule ${schedule.enabled ? 'enabled' : 'disabled'}, ${schedule.totalBlocks} blocks for ${Math.floor(schedule.totalMinutes / 60)}h${schedule.totalMinutes % 60}m`);
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    if (schedule.totalBlocks === 0) display.text('  (No scheduled times)');
    else for (let i = 0; i < 7; i++) if (schedule.days[i].timeBlocks.length > 0) display.text(`  ${days[i]}: ${schedule.days[i].timeBlocks.map((b) => b.displayTime).join(', ')}`);
    display.json({ source: 'robot', kind: 'schedule', value: schedule });
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
    const { watch: intervalSeconds } = options;
    const intervalMs = intervalSeconds * 1000;
    const pollEnabled = intervalSeconds > 0;

    const watchRobot = target === 'both' || target === 'robot';
    const watchBase = target === 'both' || target === 'base';

    if (watchRobot) await connectToRobot(device, connectors);
    if (watchBase) await connectToBase(base, connectors);

    let pollTimer;
    let stopping = false;

    const log = (source, kind, value) => {
        display.text(`[${formatWatchTimestamp()}] ${source} ${kind}: ${formatWatchValue(value)}`);
        display.json({ ts: new Date().toISOString(), source, kind, value });
    };

    const schedulePoll = () => {
        if (!pollEnabled || stopping) return;
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

    const pollDesc = pollEnabled ? `poll every ${intervalSeconds}s when idle` : 'passive (no polling)';
    display.log(`[${formatWatchTimestamp()}] watch starting (${pollDesc}, Ctrl-C to stop)`);
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
    description: 'Get firmware/hardware version',
    targets: ['robot', 'base'],
    usage: 'stiga-command [--robot|--base] version [help]',
    summary: 'Get version information for the selected target.',
    examples: ['stiga-command --robot version', 'stiga-command --base version'],
    execute: async (options, context) => {
        const { target, device, base, connectors } = context;
        if (target === 'both' || target === 'robot') {
            await connectToRobot(device, connectors);
            const version = await device.getVersion({ refresh: 'force' });
            display.text('Robot Version:');
            display.text(version.value.toString({ compressed: false }));
            display.json({ source: 'robot', kind: 'version', value: version.value });
        }
        if (target === 'both' || target === 'base') {
            await connectToBase(base, connectors);
            const version = await base.getVersion({ refresh: 'force' });
            display.text('Base Version:');
            display.text(version.value.toString({ compressed: false }));
            display.json({ source: 'base', kind: 'version', value: version.value });
        }
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

registerCommand('status', {
    description: 'Get operation/battery/mowing/location/network status',
    targets: ['robot', 'base'],
    usage: 'stiga-command [--robot|--base] status [types] [help]',
    summary: 'Get status information for the selected target.',
    details: [
        '',
        'Robot status types:',
        '  operation - Operational status (type, valid, docking)',
        '  battery   - Battery status (charge level, capacity)',
        '  mowing    - Mowing status (zone, completion)',
        '  location  - GPS/location status',
        '  network   - Network connectivity status',
        '',
        'Base status types:',
        '  operation - Operational status (type, flag)',
        '  location  - GPS/RTK location status',
        '  network   - Network connectivity status',
    ],
    examples: ['stiga-command --robot status', 'stiga-command --robot status battery,operation', 'stiga-command --base status'],
    execute: async (options, context) => {
        const { target, params, device, base, connectors } = context;
        if (target === 'both' || target === 'robot') {
            await connectToRobot(device, connectors);
            if (params.length === 0) {
                const status = await device.getStatusAll({ refresh: 'force' });
                display.text('Robot Status:');
                if (status.operation) display.text(`  Operation: ${status.operation.type}, valid=${status.operation.valid}, docking=${status.operation.docking}`);
                if (status.battery) display.text(`  Battery: ${status.battery.toString()}`);
                if (status.mowing) display.text(`  Mowing: ${status.mowing.toString()}`);
                if (status.location) display.text(`  Location: ${status.location.toString()}`);
                if (status.network) display.text(`  Network: ${status.network.toString()}`);
                display.json({
                    source: 'robot',
                    kind: 'status',
                    value: { operation: status.operation, battery: status.battery, mowing: status.mowing, location: status.location, network: status.network },
                });
            } else
                for (const type of params[0].split(','))
                    switch (type.trim().toLowerCase()) {
                        case 'operation':
                            const opStatus = await device.getStatusOperation({ refresh: 'force' });
                            display.text(`Operation: ${opStatus.value?.type || 'unknown'}, valid=${opStatus.value?.valid}, docking=${opStatus.value?.docking}`);
                            display.json({ source: 'robot', kind: 'operation', value: opStatus.value ?? null });
                            break;
                        case 'battery':
                            const batStatus = await device.getStatusBattery({ refresh: 'force' });
                            display.text(`Battery: ${batStatus.value?.toString() || 'unknown'}`);
                            display.json({ source: 'robot', kind: 'battery', value: batStatus.value ?? null });
                            break;
                        case 'mowing':
                            const mowStatus = await device.getStatusMowing({ refresh: 'force' });
                            display.text(`Mowing: ${mowStatus.value?.toString() || 'unknown'}`);
                            display.json({ source: 'robot', kind: 'mowing', value: mowStatus.value ?? null });
                            break;
                        case 'location':
                            const locStatus = await device.getStatusLocation({ refresh: 'force' });
                            display.text(`Location: ${locStatus.value?.toString() || 'unknown'}`);
                            display.json({ source: 'robot', kind: 'location', value: locStatus.value ?? null });
                            break;
                        case 'network':
                            const netStatus = await device.getStatusNetwork({ refresh: 'force' });
                            display.text(`Network: ${netStatus.value?.toString() || 'unknown'}`);
                            display.json({ source: 'robot', kind: 'network', value: netStatus.value ?? null });
                            break;
                        default:
                            display.text(`Unknown status type: ${type}`);
                    }
        }
        if (target === 'both' || target === 'base') {
            await connectToBase(base, connectors);
            if (params.length === 0) {
                const status = await base.getStatusAll({ refresh: 'force' });
                display.text('Base Status:');
                if (status.operation) display.text(`  Operation: type=${status.operation.type}, flag=${status.operation.flag}`);
                if (status.location) display.text(`  Location: ${status.location.toString()}`);
                if (status.network) display.text(`  Network: ${status.network.toString()}`);
                display.json({
                    source: 'base',
                    kind: 'status',
                    value: { operation: status.operation, location: status.location, network: status.network },
                });
            } else
                for (const type of params[0].split(','))
                    switch (type.trim().toLowerCase()) {
                        case 'operation':
                            const opStatus = await base.getStatusOperation({ refresh: 'force' });
                            display.text(`Operation: type=${opStatus.value?.type}, flag=${opStatus.value?.flag}`);
                            display.json({ source: 'base', kind: 'operation', value: opStatus.value ?? null });
                            break;
                        case 'location':
                            const locStatus = await base.getStatusLocation({ refresh: 'force' });
                            display.text(`Location: ${locStatus.value?.toString() || 'unknown'}`);
                            display.json({ source: 'base', kind: 'location', value: locStatus.value ?? null });
                            break;
                        case 'network':
                            const netStatus = await base.getStatusNetwork({ refresh: 'force' });
                            display.text(`Network: ${netStatus.value?.toString() || 'unknown'}`);
                            display.json({ source: 'base', kind: 'network', value: netStatus.value ?? null });
                            break;
                        default:
                            display.text(`Unknown status type for base: ${type}`);
                    }
        }
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function scheduleUpdateAndDisplay(device, subCommand, value) {
    await device.setScheduleSettings(value);
    display.text(`Schedule ${subCommand}d`);
    const updated = await device.getScheduleSettings({ refresh: 'force' });
    displaySchedule(updated.value);
}

registerCommand('schedule', {
    description: 'Display/enable/disable/insert/remove mowing schedule',
    targets: ['robot'],
    usage: 'stiga-command --robot schedule [subcommand] [params...] [help]',
    summary: "Manage the robot's mowing schedule.",
    details: [
        '',
        'Subcommands:',
        '  (none)               - Display current schedule',
        '  enable               - Enable the schedule',
        '  disable              - Disable the schedule',
        '  insert|add <specs>   - Insert time blocks',
        '  remove <specs>       - Remove time blocks',
        '',
        'Schedule specification format:',
        '  days:HH:MM-HH:MM',
        '',
        'Days can be:',
        '  Mon, Tue, Wed, Thu, Fri, Sat, Sun (or full names)',
        '  Multiple days separated by commas: Mon,Wed,Fri',
        '',
        'Times must be on half-hour boundaries (00 or 30 minutes)',
    ],
    examples: [
        'stiga-command --robot schedule',
        'stiga-command --robot schedule enable',
        'stiga-command --robot schedule add Mon,Wed,Fri:09:00-11:30',
        'stiga-command --robot schedule insert Sat,Sun:08:00-10:00 Sat,Sun:14:00-16:00',
        'stiga-command --robot schedule remove Tue:14:00-16:00',
    ],
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
                        display.text(`Removed ${spec.startTime.hour}:${spec.startTime.minute.toString().padStart(2, '0')} from day ${spec.dayIndex}`);
                    } catch (e) {
                        display.error(`Failed to remove time block, aborting without saving: ${e.message}`);
                        return;
                    }
                }
                await scheduleUpdateAndDisplay(device, 'updated', schedule.value);
                break;
            }

            case 'add':
            case 'insert': {
                if (params.length < 2) throw new Error('Insert requires schedule specifications');
                const schedule = await device.getScheduleSettings({ refresh: 'force' });
                for (const spec of parseScheduleSpecs(params.slice(1))) {
                    try {
                        schedule.value.insertTimeBlock(spec.dayIndex, spec.startTime, spec.endTime);
                        display.text(`Inserted ${spec.startTime.hour}:${spec.startTime.minute.toString().padStart(2, '0')}-${spec.endTime.hour}:${spec.endTime.minute.toString().padStart(2, '0')} to day ${spec.dayIndex}`);
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

registerCommand('start', {
    description: 'Start mowing',
    targets: ['robot'],
    usage: 'stiga-command --robot start [help]',
    summary: 'Start the robot mowing.',
    examples: ['stiga-command --robot start'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendStart();
        display.text('Start command sent');
        display.json({ source: 'robot', kind: 'command', command: 'start', ok: true });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

registerCommand('stop', {
    description: 'Stop the robot',
    targets: ['robot'],
    usage: 'stiga-command --robot stop [help]',
    summary: 'Stop the robot.',
    examples: ['stiga-command --robot stop'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendStop();
        display.text('Stop command sent');
        display.json({ source: 'robot', kind: 'command', command: 'stop', ok: true });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

registerCommand(['go-home', 'home'], {
    description: 'Send the robot home to dock',
    targets: ['robot'],
    usage: 'stiga-command --robot go-home [help]',
    summary: 'Send the robot back to its docking station.',
    examples: ['stiga-command --robot go-home'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendGoHome();
        display.text('Go-home command sent');
        display.json({ source: 'robot', kind: 'command', command: 'go-home', ok: true });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

registerCommand(['calibrate-blades', 'blades'], {
    description: 'Calibrate the cutting blades',
    targets: ['robot'],
    usage: 'stiga-command --robot calibrate-blades [help]',
    summary: 'Trigger blade calibration on the robot.',
    examples: ['stiga-command --robot calibrate-blades'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        await device.sendCalibrateBlades();
        display.text('Calibrate-blades command sent');
        display.json({ source: 'robot', kind: 'command', command: 'calibrate-blades', ok: true });
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
    display.log('  --debug          Enable debug output (on stderr)');
    display.log('  --level <lvl>    Output level: quiet (errors only), normal (default), verbose (extra diagnostics on stderr)');
    display.log('  --format <fmt>   Output format: none (suppress), text (default), json (one JSON object per line)');
    display.log('  --watch [secs]   Watch and show events: request status every "secs" (default 5) if idle; 0 = passive (no polling)');
    display.log('\nCommands (| separates aliases, any unique prefix also matches):');
    for (const [name, cmd] of Object.entries(commands)) {
        const label = cmd.aliases?.length > 0 ? [name, ...cmd.aliases].join('|') : name;
        display.log(`  ${label.padEnd(25)} ${cmd.description} (${cmd.targets.join(', ')})`);
    }
    display.log('\nFor command-specific help:');
    display.log('  stiga-command <command> help');
    display.log('\nExamples:');
    for (const cmd of Object.values(commands).filter((cmd) => cmd.examples?.[0])) display.log(`  ${cmd.examples[0]}`);
    display.log('  stiga-command --robot --watch');
    display.log('  stiga-command --robot --watch 0 --debug');
    display.log('  stiga-command --robot --watch 0 --format json --level quiet | jq .');
    display.log('  stiga-command --robot status --format json --level quiet | jq .');
}

async function main() {
    let options;
    try {
        options = parseArgs();
    } catch (e) {
        display.error(e.message);
        process.exit(1);
    }

    if (!options.command && options.watch === undefined) {
        await showGeneralHelp();
        process.exit(1);
    }

    let cmd;
    if (options.command) {
        try {
            if (options.params.length > 0 && options.params[options.params.length - 1] === 'help') {
                const c = resolveCommand(options.command);
                if (c) {
                    showCommandHelp(c);
                    process.exit(0);
                }
            }
            cmd = resolveCommand(options.command);
        } catch (e) {
            display.error(e.message);
            process.exit(1);
        }
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

        if (options.watch !== undefined) await runWatch(options, context);

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
