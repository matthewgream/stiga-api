#!/usr/bin/env node

/* eslint-disable unicorn/no-null */

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const {
    StigaAPIFramework,
    StigaAPIAuthentication,
    StigaAPIConnectionServer,
    StigaAPIGarage,
    StigaAPIPerimeters,
    StigaAPIOptimisePerimeters,
    StigaAPIUser,
    StigaAPINotifications,
    StigaAPIConnectionDevice,
    StigaAPIConnectionMQTT,
    StigaAPIDeviceConnector,
    StigaAPIBaseConnector,
    StigaAPIConfig,
    StigaAPIElements,
} = require('../api/StigaAPI');

const fs = require('node:fs');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const LEVELS = { quiet: 1, normal: 2, verbose: 3 };
// none/text/json are display formats; 'native' is an export/import encoding — it means "the command's own raw
// blob, verbatim" (e.g. the full cloud perimeter resource, or a raw protobuf), used only with --save/--load.
// The point of native over json is losslessness: it never strips fields we don't happen to parse.
const FORMATS = { none: 1, text: 2, json: 3, native: 4 };

let globalOptions = {
    debug: false,
    level: LEVELS.normal,
    format: 'text',
};

const display = {
    // progress/help text. In json mode it routes to stderr so stdout stays pure JSON for piping (| jq);
    // in text/none mode it stays on stdout. Suppressed below 'normal' level (e.g. --level quiet) either way.
    log: (...args) => globalOptions.level >= LEVELS.normal && (globalOptions.format === 'json' || globalOptions.format === 'native' ? console.error(...args) : console.log(...args)),
    error: (...args) => console.error(...args),
    debug: (...args) => globalOptions.debug && console.error('[DEBUG]', ...args),
    verbose: (...args) => (globalOptions.level >= LEVELS.verbose || globalOptions.debug) && console.error('[VERBOSE]', ...args),
    out: (...args) => console.log(...args),
    text: (...args) => globalOptions.format === 'text' && globalOptions.level >= LEVELS.normal && console.log(...args),
    json: (obj) => globalOptions.format === 'json' && console.log(JSON.stringify(obj)),
};

// ---- export/import I/O for --save/--load ----------------------------------------------------------------------
// A command in export mode writes its blob via ioExport (a file path, or '-' = stdout); in import mode it reads
// via ioImport (a file path, or '-' = stdin). data may be a string or a Buffer. stdout stays clean because
// progress/log text is routed to stderr under the json/native formats these are used with.
function ioExport(target, data) {
    if (target === '-') process.stdout.write(data);
    else {
        fs.writeFileSync(target, data);
        display.log(`wrote ${Buffer.byteLength(data)} bytes to ${target}`);
    }
}
function ioImport(source) {
    const buf = source === '-' ? fs.readFileSync(0) : fs.readFileSync(source);
    if (source !== '-') display.log(`read ${buf.length} bytes from ${source}`);
    return buf; // always a Buffer; the command decodes per its format
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const commands = {};
const aliases = {};

function commandRegister(names, config) {
    const [primary, ...rest] = Array.isArray(names) ? names : [names];
    commands[primary] = { ...config, name: primary, aliases: rest };
    for (const alias of rest) aliases[alias.toLowerCase()] = primary;
}

function commandResolve(name) {
    const key = name.toLowerCase();
    if (commands[key]) return commands[key];
    if (aliases[key]) return commands[aliases[key]];
    const matches = new Set();
    for (const n of Object.keys(commands)) if (n.toLowerCase().startsWith(key)) matches.add(n);
    for (const [a, p] of Object.entries(aliases)) if (a.toLowerCase().startsWith(key)) matches.add(p);
    if (matches.size === 0) return undefined;
    if (matches.size === 1) return commands[[...matches][0]];
    throw new Error(`Ambiguous command '${name}': matches ${[...matches].join(', ')}`);
}

function commandShowHelp(cmd) {
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

// validate a flag value against a keyed table (LEVELS/FORMATS), returning it or throwing with the valid set.
function validateChoice(value, table, flag) {
    if (!table[value]) throw new Error(`Invalid ${flag} value '${value}': must be ${Object.keys(table).join('|')}`);
    return value;
}

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
        save: undefined, // --save/--export/--output <file|-> : commands that support it export their blob here
        load: undefined, // --load/--import/--input  <file|-> : ...and import it from here
        commit: false, // --commit : commands that mutate (e.g. optimise) only write when this is set; else dry-run
        sync: false, // --commit-and-sync : as --commit, then have the robot pull the written copy (implies commit)
        payload: undefined, // --payload <hex> : raw command — send these exact CMD_ROBOT bytes (no envelope)
        data: undefined, // --data/--field2 <hex> : raw command — bytes for field 2 of the {1,2,3} envelope
        noAck: false, // --no-ack : raw command — fire and forget, do not wait for the robot ACK
        username: undefined,
        password: undefined,
        mqttBroker: undefined,
    };
    // value-consuming flags (alias -> option key). Kept as a table so adding aliases doesn't grow the branching
    // below: --save/--export/--output set 'save'; --load/--import/--input set 'load'.
    const VALUE_FLAGS = new Map([
        ['--username', 'username'],
        ['--password', 'password'],
        ['--save', 'save'],
        ['--export', 'save'],
        ['--output', 'save'],
        ['--load', 'load'],
        ['--import', 'load'],
        ['--input', 'load'],
        ['--payload', 'payload'],
        ['--data', 'data'],
        ['--field2', 'data'],
    ]);
    // consume args left-to-right; flags that take a value shift the next token (so '-' and filenames pass through
    // untouched). A while/shift loop avoids mutating a for-counter and keeps each flag a single flat branch.
    const next = (label) => {
        if (args.length === 0) throw new Error(`${label} requires a value`);
        return args.shift();
    };
    /* eslint-disable unicorn/prefer-switch -- compound + table-driven guards don't map cleanly to a switch */
    while (args.length > 0) {
        const a = args.shift();
        if (VALUE_FLAGS.has(a)) options[VALUE_FLAGS.get(a)] = next(a);
        else if (a === '--mqtt-broker' || a === '--broker') options.mqttBroker = next('--mqtt-broker/--broker (e.g. broker, broker1, broker2)');
        else if (a === '--base') options.target = ['robot', 'both'].includes(options.target) ? 'both' : 'base';
        else if (a === '--robot') options.target = ['base', 'both'].includes(options.target) ? 'both' : 'robot';
        else if (a === '--both') options.target = 'both';
        else if (a === '--watch') options.watch = args.length > 0 && /^\d+$/.test(args[0]) ? Number.parseInt(args.shift()) : 5;
        else if (a === '--passive') options.watch = 0;
        else if (a === '--level') options.level = validateChoice(next('--level').toLowerCase(), LEVELS, '--level');
        else if (a === '--format') options.format = validateChoice(next('--format').toLowerCase(), FORMATS, '--format');
        else if (a === '--commit') options.commit = true;
        else if (a === '--commit-and-sync') {
            options.commit = true;
            options.sync = true;
        } else if (a === '--no-ack' || a === '--noack') options.noAck = true;
        else if (a === '--debug') options.debug = true;
        else if (options.command === undefined) options.command = a;
        else options.params.push(a);
    }
    /* eslint-enable unicorn/prefer-switch */
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
        display.log(`Connected to robot/${device.getMacAddress()} '${(await device.getName()).value}'`);
    }
}

async function connectToBase(base, connectors) {
    if (!base.hasConnector('mqtt')) {
        display.verbose('Connecting to base ...');
        if (!connectors.deviceConnection) connectors.deviceConnection = new StigaAPIConnectionDevice(connectors.auth, (await connectors.device.getBrokerId()).value, { debug: globalOptions.debug });
        connectors.connectedBase = new StigaAPIBaseConnector(base, connectors.deviceConnection);
        if (!(await connectors.connectedBase.listen())) throw new Error('Failed to connect to base');
        display.log(`Connected to base/${base.getMacAddress()}`);
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
        cd.on('firmwareUpdate', onEvent('robot', 'firmware'));
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

function throwExit(message, exitCode) {
    const err = new Error(message);
    err.exitCode = exitCode;
    return err;
}

function resolveCredentials(options) {
    if (options.username && options.password) return { username: options.username, password: options.password };
    if (options.username || options.password) throw new Error('--username and --password must be provided together');
    const config = StigaAPIConfig.load();
    if (!config.username || !config.password) throw new Error('config missing username/password');
    return { username: config.username, password: config.password };
}

async function executeRobotCommand(name, fn, context) {
    const { device, connectors } = context;
    await connectToRobot(device, connectors);
    if ((await fn(device)) === true) {
        display.text(`${name} command acknowledged`);
        display.json({ source: 'robot', kind: 'command', command: name, ok: true });
        return;
    }
    display.text(`${name} command rejected by robot`);
    display.json({ source: 'robot', kind: 'command', command: name, ok: false });
    throw throwExit(`Robot did not acknowledge '${name}' command`, 2);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function runChecks(credentials, target) {
    const counts = { ok: 0, fail: 0, skip: 0 };
    const unmet = new Set();
    const failures = new Map(); // step name -> failure detail (for diagnostic hints at the end)
    const state = {};

    const record = (name, status, detail) => {
        const label = { ok: '[OK]  ', fail: '[FAIL]', skip: '[SKIP]' }[status];
        display.text(`  ${label} ${name}${detail ? ': ' + detail : ''}`);
        display.json({ source: 'check', kind: 'step', name, status, detail: detail ?? null });
        counts[status]++;
        if (status !== 'ok') unmet.add(name);
        if (status === 'fail') failures.set(name, detail);
    };

    const step = async (name, requires, fn) => {
        for (const req of requires)
            if (unmet.has(req)) {
                record(name, 'skip', `requires '${req}'`);
                return;
            }
        try {
            record(name, 'ok', await fn());
        } catch (e) {
            record(name, 'fail', e.message);
        }
    };

    display.text('Installation check:');

    await step('credentials', [], async () => {
        if (!credentials.username) throw new Error('no username');
        if (!credentials.password) throw new Error('no password');
        return `username=${credentials.username}`;
    });

    await step('authentication', ['credentials'], async () => {
        state.auth = new StigaAPIAuthentication(credentials.username, credentials.password, undefined, undefined, { debug: globalOptions.debug, verbose: globalOptions.level >= LEVELS.verbose });
        if (!(await state.auth.isValid())) throw new Error('firebase rejected credentials');
        return 'token obtained';
    });

    await step('server reachable', ['authentication'], async () => {
        state.server = new StigaAPIConnectionServer(state.auth);
        if (!(await state.server.isConnected())) throw new Error('server /api/user returned non-OK');
        return state.server.getBaseUrl();
    });

    await step('garage load', ['server reachable'], async () => {
        state.garage = new StigaAPIGarage(state.server);
        if (!(await state.garage.load())) throw new Error('garage load failed');
        return state.garage.toString();
    });

    await step('device found', ['garage load'], async () => {
        state.device = state.garage.getDevices()[0];
        if (!state.device) throw new Error('no device in garage');
        return `mac=${state.device.getMacAddress()}`;
    });

    await step('device metadata', ['device found'], async () => {
        const [name, fw, brokerId] = await Promise.all([state.device.getName(), state.device.getFirmwareVersion(), state.device.getBrokerId()]);
        if (!name?.value) throw new Error('no name in garage data');
        if (!brokerId?.value) throw new Error('no broker ID in garage data');
        return `name='${name.value}' fw=${fw.value ?? '-'} broker=${brokerId.value}`;
    });

    const wantBase = target === 'both' || target === 'base';
    if (wantBase) {
        await step('base found', ['device found'], async () => {
            const bases = state.garage.getBasesForDevice(state.device);
            state.base = bases?.[0];
            if (!state.base) throw new Error('no base linked to this device');
            return `mac=${state.base.getMacAddress()}`;
        });
    } else record('base found', 'skip', '--robot only');

    await step('mqtt connect', ['device metadata'], async () => {
        const brokerId = (await state.device.getBrokerId()).value;
        state.deviceConnection = new StigaAPIConnectionDevice(state.auth, brokerId);
        const uuid = (await state.device.getUuid()).value;
        if (!(await state.deviceConnection.connect(uuid))) throw new Error('mqtt broker connect failed');
        return 'TLS+auth OK';
    });

    const wantRobot = target === 'both' || target === 'robot';
    if (wantRobot) {
        await step('robot subscribe', ['mqtt connect'], async () => {
            state.deviceConnector = new StigaAPIDeviceConnector(state.device, state.deviceConnection);
            if (!(await state.deviceConnector.listen())) throw new Error('subscribe failed');
            return `${state.deviceConnector.getSubscriptions().length} topics`;
        });

        await step('robot version', ['robot subscribe'], async () => {
            const v = await state.device.getVersion({ refresh: 'force' });
            if (!v?.value) throw new Error('no version response within timeout');
            return v.value.toString({ compressed: true });
        });

        await step('robot status', ['robot subscribe'], async () => {
            const s = await state.device.getStatusAll({ refresh: 'force' });
            if (!s.operation) throw new Error('no status response within timeout');
            return `op=${s.operation.type}`;
        });
    } else record('robot subscribe', 'skip', '--base only');

    if (wantBase) {
        await step('base subscribe', ['mqtt connect', 'base found'], async () => {
            state.baseConnector = new StigaAPIBaseConnector(state.base, state.deviceConnection);
            if (!(await state.baseConnector.listen())) throw new Error('subscribe failed');
            return `${state.baseConnector.getSubscriptions().length} topics`;
        });

        await step('base status', ['base subscribe'], async () => {
            const s = await state.base.getStatusAll({ refresh: 'force' });
            if (!s.operation) throw new Error('no status response within timeout');
            return `op=${s.operation.type}`;
        });
    }

    state.deviceConnector?.destroy();
    state.baseConnector?.destroy();
    state.deviceConnection?.disconnect();

    display.text('');
    const skipTail = counts.skip ? `, ${counts.skip} skipped` : '';
    display.text(`Result: ${counts.ok} ok, ${counts.fail} fail${skipTail}`);
    display.json({ source: 'check', kind: 'summary', ok: counts.ok, fail: counts.fail, skip: counts.skip });

    // Common-failure hint: if MQTT couldn't connect at all (timeout / no response from the
    // broker the cloud told us to use), that hostname may not be reachable for this account.
    // Some robots report a brokerId — e.g. 'broker1' — whose hostname doesn't actually accept
    // connections, even though the unsuffixed 'broker' (or 'broker2') endpoint works. Rather
    // than silently remap (which could break other accounts), point the user at the override.
    if (failures.has('mqtt connect')) {
        const reportedBroker = (await state.device?.getBrokerId?.())?.value;
        const reported = reportedBroker || '(empty — fallback)';
        const currentOverride = StigaAPIConnectionMQTT.brokerOverride;
        display.text('');
        display.text(`Hint: 'mqtt connect' failed (${failures.get('mqtt connect')}).`);
        display.text(`  Cloud reports broker='${reported}', resolved hostname robot-mqtt-${currentOverride || reportedBroker || 'broker'}.stiga.com:8883.`);
        display.text(`  Some robots need an override. Try probing the other endpoints without editing config:`);
        display.text(`    tools/stiga-command.js check --mqtt-broker=broker     (unsuffixed / fallback)`);
        display.text(`    tools/stiga-command.js check --mqtt-broker=broker2`);
        display.text(`  Once you find the one that works, pin it in stiga-config.js with brokerOverride: 'broker'. See issue #7.`);
        display.json({ source: 'check', kind: 'hint', topic: 'mqtt-broker-override', cloudBrokerId: reportedBroker || null, currentOverride: currentOverride || null });
    }

    if (counts.fail > 0) throw throwExit(`check failed (${counts.fail} failure${counts.fail === 1 ? '' : 's'})`, 3);
}

commandRegister('check', {
    description: 'Step-by-step installation/connectivity health check',
    targets: ['robot', 'base'],
    usage: 'stiga-command [--robot|--base] check [help]',
    summary: 'Step through credentials, auth, server, garage, broker, MQTT, and first responses, reporting each.',
    examples: ['stiga-command check', 'stiga-command --robot check', 'stiga-command check --format json | jq .'],
    skipDefaultSetup: true,
    execute: async (options, context) => runChecks(context.credentials, context.target),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function safeAwait(label, fn) {
    try {
        return await fn();
    } catch (e) {
        display.verbose(`info: ${label} failed: ${e.message}`);
        return undefined;
    }
}

async function gatherRobotInfo(device) {
    const cloudKeys = ['name', 'productCode', 'serialNumber', 'firmwareVersion', 'deviceType', 'brokerId', 'totalWorkTime', 'isEnabled', 'lastPosition'];
    const getterMap = {
        name: () => device.getName(),
        productCode: () => device.getProductCode(),
        serialNumber: () => device.getSerialNumber(),
        firmwareVersion: () => device.getFirmwareVersion(),
        deviceType: () => device.getDeviceType(),
        brokerId: () => device.getBrokerId(),
        totalWorkTime: () => device.getTotalWorkTime(),
        isEnabled: () => device.getIsEnabled(),
        lastPosition: () => device.getLastPosition(),
    };
    const info = { macAddress: device.getMacAddress() };
    for (const key of cloudKeys) {
        const v = await safeAwait(key, getterMap[key]);
        info[key] = v?.value;
    }
    const version = await safeAwait('version', () => device.getVersion({ refresh: 'force' }));
    info.version = version?.value;
    const status = await safeAwait('statusAll', () => device.getStatusAll({ refresh: 'force' }));
    if (status) info.status = { operation: status.operation, battery: status.battery, mowing: status.mowing, location: status.location, network: status.network };
    const settings = await safeAwait('settings', () => device.getSettings({ refresh: 'force' }));
    info.settings = settings?.value;
    const schedule = await safeAwait('schedule', () => device.getScheduleSettings({ refresh: 'force' }));
    info.schedule = schedule?.value;
    return info;
}

async function gatherBaseInfo(base) {
    const cloudKeys = ['productCode', 'serialNumber', 'firmwareVersion', 'createdAt'];
    const getterMap = {
        productCode: () => base.getProductCode(),
        serialNumber: () => base.getSerialNumber(),
        firmwareVersion: () => base.getFirmwareVersion(),
        createdAt: () => base.getCreatedAt(),
    };
    const info = { macAddress: base.getMacAddress() };
    for (const key of cloudKeys) {
        const v = await safeAwait(key, getterMap[key]);
        info[key] = v?.value;
    }
    const version = await safeAwait('version', () => base.getVersion({ refresh: 'force' }));
    info.version = version?.value;
    const status = await safeAwait('statusAll', () => base.getStatusAll({ refresh: 'force' }));
    if (status) info.status = { operation: status.operation, location: status.location, network: status.network, led: status.led };
    return info;
}

function displayRobotInfoText(info) {
    display.text('Robot Info:');
    display.text('  Identity:');
    display.text(`    mac=${info.macAddress}`);
    display.text(`    name='${info.name ?? '-'}'`);
    display.text(`    serial=${info.serialNumber ?? '-'}`);
    display.text(`    product=${info.productCode ?? '-'}`);
    display.text(`    type=${info.deviceType ?? '-'}`);
    display.text(`    firmware=${info.firmwareVersion ?? '-'}`);
    display.text(`    enabled=${info.isEnabled}`);
    display.text(`    totalWorkTime=${info.totalWorkTime ?? 0}h`);
    display.text(`    brokerId=${info.brokerId ?? '-'}`);
    const lastPos = info.lastPosition ? `${info.lastPosition.latitude},${info.lastPosition.longitude}` : '-';
    display.text(`    lastPosition=${lastPos}`);
    if (info.version) display.text(`  Version: ${info.version.toString({ compressed: true })}`);
    if (info.status) {
        display.text('  Status:');
        if (info.status.operation) display.text(`    operation: ${info.status.operation.type}, valid=${info.status.operation.valid}, docking=${info.status.operation.docking}`);
        if (info.status.battery) display.text(`    battery: ${info.status.battery.toString()}`);
        if (info.status.mowing) display.text(`    mowing: ${info.status.mowing.toString()}`);
        if (info.status.location) display.text(`    location: ${info.status.location.toString()}`);
        if (info.status.network) display.text(`    network: ${info.status.network.toString()}`);
    }
    if (info.settings) display.text(`  Settings: ${info.settings.toString()}`);
    if (info.schedule) display.text(`  Schedule: ${info.schedule.enabled ? 'enabled' : 'disabled'}, ${info.schedule.totalBlocks} blocks (${Math.floor(info.schedule.totalMinutes / 60)}h${info.schedule.totalMinutes % 60}m)`);
}

function displayBaseInfoText(info) {
    display.text('Base Info:');
    display.text('  Identity:');
    display.text(`    mac=${info.macAddress}`);
    display.text(`    serial=${info.serialNumber ?? '-'}`);
    display.text(`    product=${info.productCode ?? '-'}`);
    display.text(`    firmware=${info.firmwareVersion ?? '-'}`);
    display.text(`    createdAt=${info.createdAt ? (info.createdAt.toISOString?.() ?? info.createdAt) : '-'}`);
    if (info.version) display.text(`  Version: ${info.version.toString({ compressed: true })}`);
    if (info.status) {
        display.text('  Status:');
        if (info.status.operation) display.text(`    operation: type=${info.status.operation.type}, flag=${info.status.operation.flag}`);
        if (info.status.location) display.text(`    location: ${info.status.location.toString()}`);
        if (info.status.network) display.text(`    network: ${info.status.network.toString()}`);
        if (info.status.led !== undefined) display.text(`    led: ${info.status.led}`);
    }
}

// Account- and cloud-level info (complements the per-device robot/base sections): the Stiga account
// profile, cloud-only device settings (auto-update etc.), and garden/notification summaries.
async function gatherCloudInfo(context) {
    const { connectors, device } = context;
    const server = new StigaAPIConnectionServer(connectors.auth);
    const info = {};
    try {
        const user = new StigaAPIUser(server);
        if (await user.load()) info.account = { name: user.getFullName(), email: user.getEmail(), country: user.getCountry(), language: user.getLanguage(), verified: user.isVerified(), lastLogin: user.getLastLogin(), uuid: user.getUuid() };
    } catch {
        /* cloud account unavailable */
    }
    info.autoUpdate = (await safeAwait('autoUpdate', () => device.getAutoUpdate()))?.value;
    const cloudRaw = (await safeAwait('cloudSettingsRaw', () => device.getCloudSettingsRaw()))?.value;
    if (cloudRaw)
        info.cloudSettings = {
            ecomode: cloudRaw.ecomode,
            hasGarden: cloudRaw.has_garden,
            hibernated: cloudRaw.hibernated,
            footballFieldMode: cloudRaw.parsedSettings?.football_field_mode,
            dockingType: cloudRaw.docking_type,
            dockingVersion: cloudRaw.docking_version,
        };
    try {
        const perimeters = new StigaAPIPerimeters(server, device);
        if (await perimeters.load()) info.garden = { zones: perimeters.getZoneCount(), obstacles: perimeters.getObstacleCount(), area: perimeters.getTotalArea() };
    } catch {
        /* perimeters unavailable */
    }
    try {
        const notifications = new StigaAPINotifications(server);
        if (await notifications.load()) info.notifications = { total: notifications.getCount(), unread: notifications.getUnreadCount() };
    } catch {
        /* notifications unavailable */
    }
    return info;
}

function displayCloudInfoText(info) {
    display.text('Cloud Info:');
    if (info.account) {
        display.text('  Account:');
        display.text(`    name='${info.account.name ?? '-'}'  email=${info.account.email ?? '-'}`);
        display.text(`    language=${info.account.language ?? '-'}  verified=${info.account.verified}`);
        const ll = info.account.lastLogin ? (info.account.lastLogin.toISOString?.() ?? info.account.lastLogin) : '-';
        display.text(`    lastLogin=${ll}  uuid=${info.account.uuid ?? '-'}`);
    }
    // eslint-disable-next-line unicorn/no-nested-ternary,sonarjs/no-nested-conditional
    display.text(`  Firmware auto-update: ${info.autoUpdate === undefined ? '-' : info.autoUpdate ? 'on' : 'off'}`);
    if (info.cloudSettings) {
        const cs = info.cloudSettings;
        display.text(`  Cloud-only settings: ecomode=${cs.ecomode}, hasGarden=${cs.hasGarden}, hibernated=${cs.hibernated}, footballFieldMode=${cs.footballFieldMode}, docking=${cs.dockingType ?? '-'}/${cs.dockingVersion ?? '-'}`);
    }
    if (info.garden) display.text(`  Garden: ${info.garden.zones} zones, ${info.garden.obstacles} obstacles, ${Number(info.garden.area).toFixed(1)} m²`);
    if (info.notifications) display.text(`  Notifications: ${info.notifications.total} total, ${info.notifications.unread} unread`);
}

commandRegister(['info', 'describe'], {
    description: 'Dump all known information for the selected target(s)',
    targets: ['robot', 'base'],
    usage: 'stiga-command [--robot|--base] info [help]',
    summary: 'Gather robot, base and cloud versions, status, settings, and data into a single report.',
    examples: ['stiga-command --robot info', 'stiga-command --robot info --format json | jq .', 'stiga-command --base info'],
    execute: async (options, context) => {
        const { target, device, base, connectors } = context;
        if (target === 'both' || target === 'robot') {
            await connectToRobot(device, connectors);
            const info = await gatherRobotInfo(device);
            displayRobotInfoText(info);
            display.json({ source: 'robot', kind: 'info', value: info });
        }
        if (target === 'both' || target === 'base') {
            await connectToBase(base, connectors);
            const info = await gatherBaseInfo(base);
            displayBaseInfoText(info);
            display.json({ source: 'base', kind: 'info', value: info });
        }
        // Cloud summary — account + cloud-only settings + garden/notification counts (shown once, any target).
        const cloud = await gatherCloudInfo(context);
        displayCloudInfoText(cloud);
        display.json({ source: 'cloud', kind: 'info', value: cloud });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister('version', {
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
            display.json({ source: 'robot', kind: 'version', value: version.value ?? null });
        }
        if (target === 'both' || target === 'base') {
            await connectToBase(base, connectors);
            const version = await base.getVersion({ refresh: 'force' });
            display.text('Base Version:');
            display.text(version.value.toString({ compressed: false }));
            display.json({ source: 'base', kind: 'version', value: version.value ?? null });
        }
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// Operation line with the error detail + note and the StatusInfo cause appended when present, so a
// CLI `status` surfaces e.g. "ERROR (error=HIGH_GRASS (going home))" or "...(error=BLADES_NOT_CALIBRATED)"
// instead of a bare "ERROR". error/info are decoded objects (toString-aware); absent in normal states.
function formatOperationStatus(op) {
    if (!op) return 'unknown';
    let s = `${op.type}, valid=${op.valid}, docking=${op.docking}`;
    if (op.error) s += `, error=${op.error.toString()}`;
    if (op.info) s += `, info=${op.info.toString()}`;
    return s;
}

commandRegister('status', {
    description: 'Get operation/battery/mowing/location/network status',
    targets: ['robot', 'base'],
    args: '[types...]',
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
                if (status.operation) display.text(`  Operation: ${formatOperationStatus(status.operation)}`);
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
                            display.text(`Operation: ${formatOperationStatus(opStatus.value)}`);
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

commandRegister('position', {
    description: "Get the robot's actual position (live offset from base, with lat/lon when the reference is known)",
    targets: ['robot'],
    usage: 'stiga-command [--robot] position [help]',
    summary: "Get the robot's live position from LOG/ROBOT_POSITION.",
    details: [
        '',
        "This is the robot's ACTUAL position: its offset from the base (distance, bearing,",
        'orientation) plus an absolute latitude/longitude when the RTK reference position is',
        'known. The GNSS/RTK fix quality (satellites, DOP, coverage) lives separately under',
        '`status location`.',
    ],
    examples: ['stiga-command --robot position'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        const position = await device.getPosition({ refresh: 'force' });
        display.text('Robot Position:');
        display.text(`  ${position.value?.toString() || 'unknown'}`);
        display.json({ source: 'robot', kind: 'position', value: position.value ?? null });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['reference-position', 'referencePosition', 'reference'], {
    description: 'Get the RTK reference station position (the fixed point the robot measures itself against)',
    targets: ['robot'],
    usage: 'stiga-command [--robot] reference-position [help]',
    summary: 'Request the surveyed RTK reference position (REFERENCE_POSITION_REQUEST, command 23 -> LOG/REFERENCE_POSITION).',
    details: ['', 'This is the FIXED reference the robot measures its own position against, published as', 'ECEF X/Y/Z metres and converted here to WGS84 lat/lon/alt. Distinct from `position`,', "which is the robot's own live location."],
    examples: ['stiga-command --robot reference-position'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        const reference = await connectors.connectedDevice.getReferencePosition();
        display.text('RTK Reference Position:');
        display.text(`  ${reference?.toString() || 'unknown'}`);
        display.json({ source: 'robot', kind: 'reference-position', value: reference ?? null });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['battery-status', 'batteryStatus', 'battery'], {
    description: "Get the robot's battery status (capacity and charge %)",
    targets: ['robot'],
    usage: 'stiga-command [--robot] battery-status [help]',
    summary: 'Request battery status directly (BATTERY_REQUEST, command 29 -> LOG/BATTERY): a granular alternative to `status battery`, which goes via the bundled STATUS request.',
    examples: ['stiga-command --robot battery-status'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        const battery = await connectors.connectedDevice.getBattery();
        display.text('Battery:');
        display.text(`  ${battery?.toString() || 'unknown'}`);
        display.json({ source: 'robot', kind: 'battery', value: battery ?? null });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['lte-status', 'lteStatus', 'lte'], {
    description: 'Get the LTE modem firmware-update status',
    targets: ['robot'],
    usage: 'stiga-command [--robot] lte-status [help]',
    summary: 'Request the Quectel LTE modem status (LTE_UPDATE_STATUS_REQUEST, command 35 -> LOG/LTE_UPDATE_STATUS). Field meanings are provisional.',
    examples: ['stiga-command --robot lte-status'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        const lte = await connectors.connectedDevice.getLteStatus();
        display.text('LTE Modem Status:');
        display.text(`  ${lte?.toString() || 'unknown'}`);
        display.json({ source: 'robot', kind: 'lte-status', value: lte ?? null });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['ubx-status', 'ubxStatus', 'ubx', 'gnss'], {
    description: 'Get the u-blox (UBX) GNSS firmware-update status',
    targets: ['robot'],
    usage: 'stiga-command [--robot] ubx-status [help]',
    summary: 'Request the u-blox GNSS module status (UBX_UPDATE_STATUS_REQUEST, command 36 -> LOG/UBX_UPDATE_STATUS). Field meanings are provisional.',
    examples: ['stiga-command --robot ubx-status'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        await connectToRobot(device, connectors);
        const ubx = await connectors.connectedDevice.getUbxStatus();
        display.text('UBX / GNSS Status:');
        display.text(`  ${ubx?.toString() || 'unknown'}`);
        display.json({ source: 'robot', kind: 'ubx-status', value: ubx ?? null });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function formatSettingValue(value) {
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (value === undefined || value === null) return '-';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function sortedSettingEntries(value) {
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value)
        .filter(([k, v]) => !k.startsWith('_') && typeof v !== 'function')
        .sort(([a], [b]) => a.localeCompare(b));
}

function displaySettings(header, value) {
    display.text(header);
    if (value == undefined) display.text('  (none)');
    else for (const [k, v] of sortedSettingEntries(value)) display.text(`  ${k}: ${formatSettingValue(v)}`);
}

function plainSettings(value) {
    if (!value || typeof value !== 'object') return value ?? null;
    return Object.fromEntries(sortedSettingEntries(value));
}

commandRegister('settings', {
    description: 'Display device settings',
    targets: ['robot', 'base'],
    usage: 'stiga-command [--robot|--base] settings [help]',
    summary: 'Display the current settings for the selected target(s).',
    details: [
        '',
        'Robot settings include:',
        '  rainSensorEnabled, rainSensorDelay, keyboardLock,',
        '  zoneCuttingHeightEnabled, zoneCuttingHeight, zoneCuttingHeightUniform,',
        '  antiTheft, smartCutHeight, longExitEnabled, longExitDistance,',
        '  pushNotifications, obstacleNotifications',
        '',
        'Cloud settings (from the garage, not MQTT):',
        '  autoUpdate   (--debug also dumps the raw cloud blob incl. unverified fields)',
        '',
        'Base settings:',
        '  led',
    ],
    examples: ['stiga-command --robot settings', 'stiga-command --base settings', 'stiga-command settings --format json | jq .'],
    execute: async (options, context) => {
        const { target, device, base, connectors } = context;
        if (target === 'both' || target === 'robot') {
            await connectToRobot(device, connectors);
            const settings = await device.getSettings({ refresh: 'force' });
            displaySettings('Robot Settings:', settings.value);
            display.json({ source: 'robot', kind: 'settings', value: plainSettings(settings.value) });

            // Cloud-only device settings (from the garage, not MQTT). Only the supported ones are shown;
            // the rest of the raw cloud blob (unverified / possibly model-specific) is dumped under --debug.
            const autoUpdate = await device.getAutoUpdate();
            displaySettings('Cloud Settings:', { autoUpdate: autoUpdate.value });
            display.json({ source: 'cloud', kind: 'settings', value: { autoUpdate: autoUpdate.value ?? null } });
            const cloudRaw = (await device.getCloudSettingsRaw()).value;
            if (cloudRaw) display.debug('Cloud settings (raw, incl. unverified fields): ' + JSON.stringify(cloudRaw));
        }
        if (target === 'both' || target === 'base') {
            await connectToBase(base, connectors);
            const led = await base.getLedSetting({ refresh: 'force' });
            displaySettings('Base Settings:', { led: led.value });
            display.json({ source: 'base', kind: 'settings', value: { led: led.value ?? null } });
        }
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['zone-settings', 'zoneSettings', 'zones'], {
    description: 'Display per-zone settings (cutting height, mode, priority, angle, border cut)',
    targets: ['robot'],
    usage: 'stiga-command --robot zone-settings [zone] [help]',
    summary: 'Read the per-zone settings from the cloud perimeter (the canonical store). Optionally pass a zone id to show just one zone.',
    details: [
        '',
        'Per-zone settings are stored in the cloud perimeter, not over MQTT.',
        'Each zone reports: name, cuttingHeight (mm), cuttingMode, priority,',
        'customAngle (deg, when customAngleActive), borderCut.',
        '',
        'Read-only for now.',
    ],
    examples: ['stiga-command --robot zone-settings', 'stiga-command --robot zone-settings 2', 'stiga-command --robot zone-settings --format json | jq .'],
    execute: async (options, context) => {
        const { device, connectors, params } = context;
        const { auth } = connectors;
        if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
        const server = new StigaAPIConnectionServer(auth);
        const perimeters = new StigaAPIPerimeters(server, device);
        if (!(await perimeters.load())) throw throwExit('failed to load perimeters', 2);

        const wanted = params[0] === undefined ? undefined : Number.parseInt(params[0], 10);
        let all = perimeters.getAllZoneSettings();
        if (wanted !== undefined) {
            if (!Number.isInteger(wanted)) throw throwExit(`invalid zone id: ${params[0]}`, 2);
            all = all.filter((z) => z.id === wanted);
            if (all.length === 0)
                throw throwExit(
                    `zone ${wanted} not found (zones: ${
                        perimeters
                            .getAllZoneSettings()
                            .map((z) => z.id)
                            .join(', ') || 'none'
                    })`,
                    2
                );
        }

        display.text('Zone Settings:');
        if (all.length === 0) display.text('  (no zones)');
        for (const z of all) {
            const angle = z.customAngleActive ? `${z.customAngle}°` : 'off';
            const mode = StigaAPIElements.getCuttingModeLabels()[z.cuttingMode] || z.cuttingMode;
            display.text(`  zone ${z.id} "${z.name}": enabled=${z.enabled === false ? 'no' : 'yes'} height=${z.cuttingHeight}mm mode=${mode} priority=${z.priority} angle=${angle} borderCut=${z.borderCut ? 'on' : 'off'}`);
        }
        display.json({
            source: 'cloud',
            kind: 'zoneSettings',
            value: all.map((z) => ({
                id: z.id,
                name: z.name,
                enabled: z.enabled !== false,
                cuttingHeight: z.cuttingHeight,
                cuttingMode: z.cuttingMode,
                priority: z.priority,
                customAngleActive: z.customAngleActive,
                customAngle: z.customAngle,
                borderCut: z.borderCut,
            })),
        });
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function scheduleUpdateAndDisplay(device, subCommand, value) {
    await device.setScheduleSettings(value);
    display.text(`Schedule ${subCommand}d`);
    const updated = await device.getScheduleSettings({ refresh: 'force' });
    displaySchedule(updated.value);
}

commandRegister('schedule', {
    description: 'Display/enable/disable/insert/remove mowing schedule',
    targets: ['robot'],
    args: '[subcommand]',
    usage: 'stiga-command --robot schedule [subcommand] [params...] [--save <file|->] [--load <file|->] [help]',
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
        'Backup / restore (- means stdout/stdin):',
        '  --save <file>        - back up the active schedule as JSON',
        '  --load <file>        - restore a saved schedule to the robot',
        '  (this is the MQTT schedule the robot runs; the cloud names/multi-session are separate)',
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
        'stiga-command --robot schedule --save data/schedule.backup',
        'stiga-command --robot schedule --load data/schedule.backup',
    ],
    // backup-capable via the `backup`/`restore` meta-commands. transport:'mqtt' tells the meta to open a device
    // connection (perimeters is cloud-only); format json since the schedule isn't a lossless native blob.
    backup: { format: 'json', transport: 'mqtt' },
    execute: async (options, context) => {
        const { params, device, connectors } = context;
        await connectToRobot(device, connectors);
        // Phase-one backup/restore of the ACTIVE schedule (the one insert/remove act on). Stored as JSON for
        // inspectability/hand-editing. This is the MQTT schedule only — the cloud's named multi-session
        // (working_daytimes) is a separate, later piece. - means stdout/stdin.
        if (options.load) {
            const data = JSON.parse(ioImport(options.load).toString('utf8'));
            display.log('restoring schedule to the robot...');
            await device.setScheduleSettings(data);
            const updated = await device.getScheduleSettings({ refresh: 'force' });
            displaySchedule(updated.value);
            return;
        }
        if (options.save) {
            const schedule = await device.getScheduleSettings({ refresh: 'force' });
            ioExport(options.save, JSON.stringify(schedule.value, undefined, 2));
            return;
        }
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

// bounding box (width/height in metres) and centroid of a lat/lng polygon
// One text line for a connector/docking path: id, from-zone -> to-zone (or "dock" when there's no toZone).
function perimeterPathLine(p) {
    return `    [${p.getId()}] zone ${p.getFromZone()} -> ${p.getToZone() == null ? 'dock' : 'zone ' + p.getToZone()}`.padEnd(28) + `${p.getPath().length} pts`.padStart(8);
}
function perimeterGeometry(path) {
    if (!path || path.length === 0) return undefined;
    let minLat = Infinity,
        maxLat = -Infinity,
        minLng = Infinity,
        maxLng = -Infinity,
        sumLat = 0,
        sumLng = 0;
    for (const point of path) {
        minLat = Math.min(minLat, point.latitude);
        maxLat = Math.max(maxLat, point.latitude);
        minLng = Math.min(minLng, point.longitude);
        maxLng = Math.max(maxLng, point.longitude);
        sumLat += point.latitude;
        sumLng += point.longitude;
    }
    const centreLat = sumLat / path.length,
        centreLng = sumLng / path.length;
    return {
        centreLat,
        centreLng,
        widthM: (maxLng - minLng) * 111320 * Math.cos((centreLat * Math.PI) / 180),
        heightM: (maxLat - minLat) * 111320,
    };
}

async function runPerimeters(credentials, options = {}) {
    const { save, load, format } = options;
    if (save && load) throw throwExit('use --save or --load, not both', 1);
    if ((save || load) && format !== 'native' && format !== 'json') throw throwExit('--save/--load require --format native (lossless, restorable) or json', 1);

    const auth = new StigaAPIAuthentication(credentials.username, credentials.password);
    if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw throwExit('server connection failed', 2);
    const garage = new StigaAPIGarage(server);
    if (!(await garage.load())) throw throwExit('garage load failed', 2);
    const device = garage.getDevices()?.[0];
    if (!device) throw throwExit('no device found in garage', 2);
    const perimeters = new StigaAPIPerimeters(server, device);

    // IMPORT: restore a previously-saved native blob straight back to the cloud. We replace, not merge, and
    // don't load() first — the file is the source of truth (its uuid targets the PATCH). write() re-stamps the
    // timestamp/checksum so it supersedes the current record.
    if (load) {
        if (format === 'json') throw throwExit('--format json import is not supported yet — use --format native', 1);
        let data;
        try {
            data = JSON.parse(ioImport(load).toString('utf8'));
        } catch (e) {
            throw throwExit(`invalid native perimeter file: ${e.message}`, 1);
        }
        perimeters.setRawData(data);
        display.log('restoring perimeter to the cloud...');
        if (!(await perimeters.write())) throw throwExit('failed to write perimeter to cloud', 2);
        display.log('perimeter restored — cloud copy updated (the robot owns the master; issue a cloudsync to make it pull this)');
        return;
    }

    if (!(await perimeters.load())) throw throwExit('failed to load perimeters', 2);

    const ref = perimeters.getReferencePosition();
    const timestamp = perimeters.getTimestamp();
    const zones = perimeters.getZones();
    const obstacles = perimeters.getObstacles();
    const tempObstacles = perimeters.getTempObstacles();
    const closedZones = perimeters.getClosedZones();
    const connectPaths = perimeters.getConnectPaths();
    const dockingPaths = perimeters.getDockingPaths();
    const pickupPoints = perimeters.getPickupPoints();

    display.text('Garden Perimeters:');
    display.text(`  Total: ${perimeters.getTotalArea().toFixed(1)} m² across ${perimeters.getZoneCount()} zones, ${perimeters.getObstacleCount()} obstacles (${perimeters.getTotalPoints()} points)`);
    if (ref) display.text(`  Reference: ${ref.latitude.toFixed(7)}, ${ref.longitude.toFixed(7)}`);
    if (timestamp) display.text(`  Updated: ${timestamp.toISOString()}`);
    display.text('  Zones:');
    for (const zone of zones) {
        const geo = perimeterGeometry(zone.getPath());
        const name = (zone.getName() || '-').padEnd(16);
        const area = `${zone.getArea().toFixed(1)} m²`.padStart(11);
        const points = `${zone.getNumPoints()} pts`.padStart(8);
        const span = geo ? `  ${geo.widthM.toFixed(0)}x${geo.heightM.toFixed(0)} m` : '';
        const centre = geo ? `  centre ${geo.centreLat.toFixed(6)},${geo.centreLng.toFixed(6)}` : '';
        display.text(`    [${zone.getId()}] ${name} ${area} ${points}${span}${centre}`);
    }
    display.text(`  Obstacles (${obstacles.length}):`);
    for (const obstacle of obstacles) {
        const area = `${obstacle.getArea().toFixed(2)} m²`.padStart(11);
        const points = `${obstacle.getNumPoints()} pts`.padStart(8);
        display.text(`    [${obstacle.getId()}] ${area} ${points}`);
    }
    // Temporary obstacles — auto-expiring no-go zones (app circles, or robot sensor-detected polygons). Same
    // geometry shape as permanent obstacles; listed separately so they're not mistaken for the fixed map.
    if (tempObstacles.length > 0) {
        display.text(`  Temp obstacles (${tempObstacles.length}):`);
        for (const obstacle of tempObstacles) {
            const area = `${obstacle.getArea().toFixed(2)} m²`.padStart(11);
            const points = `${obstacle.getNumPoints()} pts`.padStart(8);
            display.text(`    [${obstacle.getId()}] ${area} ${points}`);
        }
    }
    // Closed zones — defined but currently disabled in the app (same shape as live zones).
    if (closedZones.length > 0) {
        display.text(`  Closed zones (${closedZones.length}):`);
        for (const zone of closedZones) {
            const name = (zone.getName() || '-').padEnd(16);
            const area = `${zone.getArea().toFixed(1)} m²`.padStart(11);
            const points = `${zone.getNumPoints()} pts`.padStart(8);
            display.text(`    [${zone.getId()}] ${name} ${area} ${points}`);
        }
    }
    // Connector + docking paths — polylines the robot follows between zones / into the dock (see perimeterPathLine).
    if (connectPaths.length > 0) {
        display.text(`  Connect paths (${connectPaths.length}):`);
        for (const p of connectPaths) display.text(perimeterPathLine(p));
    }
    if (dockingPaths.length > 0) {
        display.text(`  Docking paths (${dockingPaths.length}):`);
        for (const p of dockingPaths) display.text(perimeterPathLine(p));
    }
    // Pickup points — geometry layout still TBD (no sample data yet); dump raw so they're visible if they appear.
    if (pickupPoints.length > 0) {
        display.text(`  Pickup points (${pickupPoints.length}):`);
        for (const pt of pickupPoints) display.text(`    ${JSON.stringify(pt)}`);
    }

    const jsonValue = {
        source: 'robot',
        kind: 'perimeters',
        value: {
            referencePosition: ref ?? null,
            totalArea: perimeters.getTotalArea(),
            zoneCount: perimeters.getZoneCount(),
            obstacleCount: perimeters.getObstacleCount(),
            totalPoints: perimeters.getTotalPoints(),
            timestamp: timestamp ? timestamp.toISOString() : null,
            zones: zones.map((zone) => ({ id: zone.getId(), name: zone.getName() ?? null, area: zone.getArea(), numPoints: zone.getNumPoints(), path: zone.getPath() })),
            obstacles: obstacles.map((obstacle) => ({ id: obstacle.getId(), area: obstacle.getArea(), numPoints: obstacle.getNumPoints(), path: obstacle.getPath() })),
            tempObstacles: tempObstacles.map((obstacle) => ({ id: obstacle.getId(), area: obstacle.getArea(), numPoints: obstacle.getNumPoints(), path: obstacle.getPath() })),
            closedZones: closedZones.map((zone) => ({ id: zone.getId(), name: zone.getName() ?? null, area: zone.getArea(), numPoints: zone.getNumPoints(), path: zone.getPath() })),
            connectPaths: connectPaths.map((p) => ({ id: p.getId(), fromZone: p.getFromZone(), toZone: p.getToZone() ?? null, numPoints: p.getPath().length, path: p.getPath() })),
            dockingPaths: dockingPaths.map((p) => ({ id: p.getId(), fromZone: p.getFromZone(), toZone: p.getToZone() ?? null, numPoints: p.getPath().length, path: p.getPath() })),
            pickupPoints,
        },
    };
    // EXPORT: native = the full raw cloud resource (lossless + restorable via --load); json = the curated view.
    if (save) {
        ioExport(save, format === 'native' ? JSON.stringify(perimeters.getRawData()) : JSON.stringify(jsonValue));
        return;
    }
    display.json(jsonValue);
}

commandRegister('perimeters', {
    description: 'Display, back up, or restore garden zones and obstacles from the cloud',
    targets: ['robot'],
    usage: 'stiga-command perimeters [--format native|json] [--save <file|->] [--load <file|->] [help]',
    summary: 'Fetch the garden perimeter map (zones and obstacles, with geometry) from the Stiga Cloud, or back it up / restore it.',
    details: [
        '',
        'Each zone is listed with its id, name, area, point count, bounding-box size and centre',
        'coordinate; permanent and temporary obstacles are listed with id, area and point count.',
        'JSON output additionally includes the full polygon path (lat/lng) of every zone and obstacle.',
        '',
        'Backup / restore (- means stdout/stdin):',
        '  --format native --save <file>   back up the FULL raw cloud perimeter (lossless, restorable)',
        '  --format native --load <file>   restore that backup to the cloud (PATCH; re-stamped so it sticks)',
        '  --format json   --save <file>   save the curated view (geometry only — NOT restorable)',
        '',
        'native is the raw cloud resource verbatim, so no fields are stripped. Restore updates the CLOUD',
        'copy only — the robot owns the master and will re-publish its own unless told to pull via cloudsync.',
    ],
    examples: ['stiga-command perimeters', 'stiga-command perimeters --format json | jq .', 'stiga-command perimeters --format native --save perimeters.backup', 'stiga-command perimeters --format native --load perimeters.backup'],
    // marks this command as backup-capable: the `backup`/`restore` meta-commands drive its export/import with
    // this format and the standard data/<name>.backup file. native = lossless + restorable.
    backup: { format: 'native' },
    skipDefaultSetup: true,
    execute: async (options, context) => runPerimeters(context.credentials, options),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// optimise — run a geometry optimisation over the cloud perimeter. The geometry work lives in
// StigaAPIOptimisePerimeters (so the API, CLI and a future front-end share it); loading + committing live here.
// Dry-run by default — mutates only the in-memory model and reports; --commit writes to the cloud.

const OPTIMISE_SHAPE_OPS = new Set(['make-circular', 'make-rectangular', 'tune-circular', 'tune-rectangular']);
const OPTIMISE_OPS = new Set(['reduce', 'smooth', ...OPTIMISE_SHAPE_OPS, 'move']);
const OPTIMISE_USAGE =
    'usage: optimise perimeter <reduce|smooth|make-circular|make-rectangular|tune-circular|tune-rectangular|move> [zone|obstacle|path|docking] [id[,id...]] [±A[,±B]] [eps=<cm> | iters=<n> strength=<0..1> | points=<n> | subdivide=<n>] [--commit | --commit-and-sync]';

// A ±A or ±A,±B positional argument (cm). The sign is mandatory — it is what marks the token as a delta rather
// than an id, and it keeps '+10' visibly distinct from a bare size.
function parseOptimiseDelta(spec) {
    const parts = String(spec).split(',');
    if (parts.length > 2 || !parts.every((p) => /^[+-]\d+(?:\.\d+)?$/.test(p))) throw throwExit(`invalid delta '${spec}' — expected ±A or ±A,±B in cm (e.g. +10 or +10,-5)`, 1);
    return { a: Number(parts[0]), b: parts.length > 1 ? Number(parts[1]) : 0 };
}
// A traced shape that the fit cannot honestly represent: a vertex well inside the fitted circle means the drive
// wandered in toward the object, and no circle can be right for it. Surface it rather than quietly averaging.
function optimiseFitWarning(change) {
    if (change.shape === 'circle') {
        const { radiusCm, rMinCm, rmsCm } = change.before;
        if (rMinCm < 0.5 * radiusCm) return `poor circle fit — a vertex sits ${rMinCm.toFixed(1)}cm from the centre against a fitted radius of ${radiusCm.toFixed(1)}cm; the trace wanders inward, so re-drive it or set the size by hand`;
        if (rmsCm > 0.25 * radiusCm) return `loose circle fit — radial spread ${rmsCm.toFixed(1)}cm against a fitted radius of ${radiusCm.toFixed(1)}cm`;
    } else if (change.before.fill < 0.85 || change.before.fill > 1.15) return `poor rectangle fit — the trace fills ${(change.before.fill * 100).toFixed(0)}% of the fitted rectangle, so it may not be rectangular`;
    return undefined;
}
function formatOptimiseShape(shape, s) {
    if (shape === 'circle') return `circle centre (${s.centre.x.toFixed(0)},${s.centre.y.toFixed(0)}) diameter ${s.diameterCm.toFixed(1)}cm (radius ${s.radiusCm.toFixed(1)}cm)`;
    return `rect centre (${s.centre.x.toFixed(0)},${s.centre.y.toFixed(0)}) A=${(s.aCm / 100).toFixed(2)}m B=${(s.bCm / 100).toFixed(2)}m bearing ${s.bearingDeg.toFixed(1)}°`;
}
function formatOptimiseFitQuality(shape, before) {
    if (shape === 'circle') return `radial spread ${before.rmsCm.toFixed(1)}cm, vertices ${before.rMinCm.toFixed(1)}..${before.rMaxCm.toFixed(1)}cm from centre`;
    return `trace fills ${(before.fill * 100).toFixed(0)}% of the fitted rectangle`;
}
const signedCm = (n) => `${n >= 0 ? '+' : ''}${n}`;
const signedM2 = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;

// Before/after for one reshaped element — the whole point of the dry-run, so it shows the fitted shape, how
// good that fit was, and how far the boundary actually travels.
function displayOptimiseShapeChange(shape, c) {
    display.text(`  ${c.type} ${c.id}:`);
    display.text(`    before: ${c.before.points} pts, area ${c.before.areaM2.toFixed(2)}m² — fitted ${formatOptimiseShape(shape, c.before)}`);
    display.text(`            fit quality: ${formatOptimiseFitQuality(shape, c.before)}`);
    display.text(`    after : ${c.after.points} pts, area ${c.after.areaM2.toFixed(2)}m² — ${formatOptimiseShape(shape, c.after)}`);
    display.text(`    boundary moves up to ${c.maxMoveCm.toFixed(1)}cm, area Δ ${signedM2(c.after.areaM2 - c.before.areaM2)}m²`);
    const warning = optimiseFitWarning(c);
    if (warning) display.log(`warning: ${c.type} ${c.id}: ${warning}`);
}
function displayOptimiseMoveChange(c) {
    display.text(`  ${c.type} ${c.id}:`);
    display.text(`    before: anchor E=${c.before.anchorEastM.toFixed(3)}m N=${c.before.anchorNorthM.toFixed(3)}m`);
    display.text(`    after : anchor E=${c.after.anchorEastM.toFixed(3)}m N=${c.after.anchorNorthM.toFixed(3)}m`);
    display.text(`    moved ${c.movedCm.toFixed(1)}cm (shape unchanged)`);
}

// Hand the freshly-written cloud copy to the robot (CLOUDSYNC_DOWNLOAD — the same command the app's "sync now"
// issues): the robot fetches the perimeter over HTTPS and adopts it. This exists as one step with the write
// because the robot owns the master and re-publishes its own map, so a cloud edit that is not pulled promptly
// gets clobbered — committing and syncing together closes that window. Builds its own MQTT connection (optimise
// is otherwise cloud-only, and a dry-run should not open one) and tears it down again.
async function syncPerimeterToRobot(auth, device, perimeters) {
    const url = perimeters.getResourceUrl();
    if (!url) throw throwExit('no perimeter resource url available to sync', 2);
    const connectors = { auth, device, deviceConnection: undefined, connectedDevice: undefined, connectedBase: undefined };
    try {
        await connectToRobot(device, connectors);
        if ((await device.sendCloudSync(`Bearer ${auth.token}`, url)) !== true) throw throwExit('robot did not acknowledge the cloud-sync command — the cloud copy is written but the robot has NOT adopted it', 2);
        display.log('robot acknowledged cloud-sync — it is downloading and applying the committed perimeter');
        return true;
    } finally {
        if (connectors.connectedDevice) connectors.connectedDevice.destroy();
        if (connectors.deviceConnection) connectors.deviceConnection.disconnect();
    }
}

async function runOptimise(credentials, options, rawParams) {
    // pull the k=v arguments out, leaving the positional grammar: perimeter <op> [type] [id] [±A[,±B]]
    let epsilon = StigaAPIOptimisePerimeters.REDUCE_DEFAULT_EPSILON_CM;
    let iterations = StigaAPIOptimisePerimeters.SMOOTH_DEFAULT_ITERATIONS;
    let strength = StigaAPIOptimisePerimeters.SMOOTH_DEFAULT_STRENGTH;
    let count = StigaAPIOptimisePerimeters.CIRCLE_DEFAULT_POINTS;
    let subdivide = 1;
    let delta;
    const params = [];
    for (const p of rawParams) {
        const eM = /^eps=(\d+(?:\.\d+)?)$/i.exec(p),
            iM = /^iters=(\d+)$/i.exec(p),
            sM = /^strength=(\d+(?:\.\d+)?)$/i.exec(p),
            pM = /^points=(\d+)$/i.exec(p),
            dM = /^subdivide=(\d+)$/i.exec(p);
        if (eM) epsilon = Number(eM[1]);
        else if (iM) iterations = Number(iM[1]);
        else if (sM) strength = Number(sM[1]);
        else if (pM) count = Number(pM[1]);
        else if (dM) subdivide = Number(dM[1]);
        else if (/^[+-]/.test(p)) delta = parseOptimiseDelta(p);
        else params.push(p);
    }
    const subject = (params[0] || '').toLowerCase();
    const operation = (params[1] || '').toLowerCase();
    if (subject !== 'perimeter' || !OPTIMISE_OPS.has(operation)) throw throwExit(OPTIMISE_USAGE, 1);
    const isShape = OPTIMISE_SHAPE_OPS.has(operation);
    // Reshaping/moving every element at once is never what anyone means, so those ops target obstacles and
    // demand an explicit id (or id list); reduce/smooth keep their broader sweep-everything defaults.
    const type = params[2] ?? (isShape || operation === 'move' ? 'obstacle' : undefined);
    const idSpec = params[3];
    if ((isShape || operation === 'move') && !idSpec) throw throwExit(`${operation} needs an explicit element id (or a comma-separated list) — it will not reshape every element at once`, 1);
    const id = idSpec?.split(',').map((s) => {
        if (!/^\d+$/.test(s)) throw throwExit(`invalid element id '${s}'`, 1);
        return Number(s);
    });
    if (operation.startsWith('tune-') && !delta) throw throwExit(`${operation} needs a ±delta in cm (e.g. ${operation === 'tune-circular' ? '+10' : '+10,-5'})`, 1);
    if (operation === 'move' && !delta) throw throwExit('move needs a ±north,±east delta in cm (e.g. +30,-20)', 1);

    const auth = new StigaAPIAuthentication(credentials.username, credentials.password);
    if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw throwExit('server connection failed', 2);
    const garage = new StigaAPIGarage(server);
    if (!(await garage.load())) throw throwExit('garage load failed', 2);
    const device = garage.getDevices()?.[0];
    if (!device) throw throwExit('no device found in garage', 2);
    const perimeters = new StigaAPIPerimeters(server, device);
    if (!(await perimeters.load())) throw throwExit('failed to load perimeters', 2);

    // every op reports, then commits only on --commit; `changed` gates the write and the wording
    const finish = async (pkg, changed, nothingToCommit) => {
        let synced = false;
        if (options.commit && changed) {
            display.log('EXPERIMENTAL — committing edited perimeter (changed outside the app guard rails) to the cloud...');
            if (!(await perimeters.write())) throw throwExit('failed to write perimeter to cloud', 2);
            if (options.sync) synced = await syncPerimeterToRobot(auth, device, perimeters);
            else display.log('warning: model committed to the cloud but must be force-synced to the robot to take effect — use --commit-and-sync, or the cloud-sync command');
        } else if (options.commit) display.log(`nothing to commit (${nothingToCommit})`);
        else display.text('  (dry-run — nothing written; re-run with --commit to write to the cloud, or --commit-and-sync to also make the robot adopt it)');
        display.json({ source: 'robot', kind: 'optimise', committed: Boolean(options.commit && changed), synced, value: pkg });
    };

    const dry = options.commit ? '' : '  [dry-run]';
    if (operation === 'move') {
        const pkg = StigaAPIOptimisePerimeters.movePerimeter(perimeters, { type, id, dNorth: delta.a, dEast: delta.b });
        display.text(`Optimise perimeter — move (north ${signedCm(delta.a)}cm, east ${signedCm(delta.b)}cm)${dry}:`);
        for (const c of pkg.changes) displayOptimiseMoveChange(c);
        await finish(
            pkg,
            pkg.changes.some((c) => c.movedCm > 0),
            'zero movement'
        );
        return;
    }

    if (isShape) {
        const shape = operation.endsWith('-circular') ? 'circle' : 'rectangle';
        const pkg = StigaAPIOptimisePerimeters.shapePerimeter(perimeters, { shape, type, id, deltaA: delta?.a ?? 0, deltaB: delta?.b ?? 0, count, subdivide });
        const spec = shape === 'rectangle' ? `${signedCm(delta?.a)},${signedCm(delta?.b)}` : signedCm(delta?.a);
        const suffix = delta ? ` (${spec}cm)` : '';
        display.text(`Optimise perimeter — ${operation}${suffix}${dry}:`);
        for (const c of pkg.changes) displayOptimiseShapeChange(shape, c);
        const t = pkg.totals;
        display.text(`  total: ${t.elements} element${t.elements === 1 ? '' : 's'}, ${t.numPointsBefore} -> ${t.numPointsAfter} points, ${t.bytesBefore} -> ${t.bytesAfter} bytes, area Δ ${signedM2(t.areaDeltaM2)} m²`);
        await finish(pkg, t.elements > 0, 'nothing reshaped');
        return;
    }

    if (operation === 'smooth') {
        // No boundary/guard awareness — it can move points across borders (the future front-end shows the
        // result before commit). Dry-run by default; --commit writes the moved geometry to the cloud.
        const pkg = StigaAPIOptimisePerimeters.smoothPerimeter(perimeters, { type, id, iterations, strength });
        display.text(`Optimise perimeter — smooth (iters=${iterations}, strength=${strength})${options.commit ? '' : '  [dry-run]'}:`);
        for (const c of pkg.changes) display.text(`  ${c.type} ${c.id} (${c.points}pts): avg move ${c.avgMoveCm.toFixed(1)}cm, max ${c.maxMoveCm.toFixed(1)}cm`);
        await finish(pkg, pkg.totals.moved > 0, 'no points moved');
        return;
    }

    const pkg = StigaAPIOptimisePerimeters.reducePerimeter(perimeters, { type, id, epsilon });
    display.text(`Optimise perimeter — reduce (eps=${epsilon}cm)${options.commit ? '' : '  [dry-run]'}:`);
    for (const c of pkg.changes.filter((c) => c.removed > 0)) display.text(`  ${c.type} ${c.id}: ${c.before} -> ${c.after} pts (-${c.removed})`);
    const t = pkg.totals;
    display.text(`  total: removed ${t.removed} of ${t.numPointsBefore} points, ${t.bytesBefore} -> ${t.bytesAfter} bytes, area Δ ${t.areaDeltaM2.toFixed(4)} m²`);
    await finish(pkg, t.removed > 0, 'no points removed');
}

commandRegister('optimise', {
    description: '[EXPERIMENTAL] Optimise the cloud perimeter geometry (reduce, smooth, regularise to a circle/rectangle, move)',
    targets: ['robot'],
    usage: OPTIMISE_USAGE.replace('usage: ', 'stiga-command '),
    summary: 'Run a geometry optimisation over the cloud perimeter. Dry-run by default; --commit writes to the cloud.',
    details: [
        '',
        '  *** EXPERIMENTAL *** — this edits perimeter geometry OUTSIDE the robot/app guard rails. Those',
        '  boundaries are physically grounded (RTK-surveyed lines that may keep the robot from water, roads,',
        '  drops); committed changes are not validated by the app. Dry-run and review first; keep a backup',
        '  (stiga-command perimeters --format native --save), and remember the robot owns the master.',
        '',
        '  reduce  [type] [id]    drop redundant collinear vertices (zones, obstacles, connect-paths; docking',
        '                         excluded by default). eps=<cm> = tolerance (default 1cm; 0 = exactly lossless).',
        '  smooth  [type] [id]    Laplacian corner-rounding — iters=<n> (default 2), strength=<0..1> (default 0.5).',
        '                         No boundary guards (can move points across borders); --commit writes it.',
        '',
        '  Regularising a hand-driven trace — you cannot drive a clean circle round a tree, so these replace the',
        '  wobbly trace with the ideal shape fitted to it. They default to obstacles and REQUIRE an id (or a',
        '  comma-separated list), because reshaping the whole garden at once is never the intent.',
        '',
        '  make-circular    <id>       replace the trace with the best-fit circle. points=<n> sets the vertex',
        "                             count (default 16, matching the app's own circular obstacles).",
        '  make-rectangular <id>       replace the trace with the best-fit rectangle (4 corners; subdivide=<n>',
        '                             adds n-1 intermediate vertices per side).',
        '  tune-circular    <id> ±A    refit, then change the DIAMETER by A cm (+10 = 5cm more clearance all',
        '                             round). Repeatable — refitting an ideal circle recovers it exactly.',
        '  tune-rectangular <id> ±A,±B refit, then change side A (the longer) by A cm and side B by B cm.',
        '  move             <id> ±A,±B shift the element A cm north and B cm east, shape untouched.',
        '',
        '  --commit               write the result to the cloud (otherwise dry-run + report).',
        '  --commit-and-sync      write it, then tell the robot to pull and adopt it (CLOUDSYNC_DOWNLOAD).',
        '                         PREFER THIS over --commit: the robot owns the master and re-publishes its own',
        '                         map, so a cloud copy that is not pulled promptly is simply clobbered.',
        '',
        'The fit solves for centre and size together by least squares on the vertices — the drive wobble averages',
        'out, and the vertices are where the robot actually was. It does NOT size by area: a traced polygon is',
        'inscribed in the curve it was sampled from, so its area falls short (a 4-gon holds 64% of its circle),',
        'which would shrink the obstacle. Each run reports the fit quality (radial spread for a circle, fill',
        'fraction for a rectangle) and warns when a trace is too ragged to represent honestly.',
        '',
        'A --commit alone updates the CLOUD copy only, which the robot will overwrite with its own next publish;',
        '--commit-and-sync makes the robot adopt it. Reduce is shape-preserving (area Δ is sub-cm² at eps=1cm).',
    ],
    examples: [
        'stiga-command optimise perimeter reduce',
        'stiga-command optimise perimeter reduce zone 1',
        'stiga-command optimise perimeter reduce obstacle 7 --commit-and-sync',
        'stiga-command optimise perimeter smooth path 10 iters=3 strength=0.5',
        'stiga-command optimise perimeter make-circular obstacle 3',
        'stiga-command optimise perimeter make-circular obstacle 2,3,4,5,8,9,10 --commit-and-sync',
        'stiga-command optimise perimeter make-rectangular obstacle 6 --commit-and-sync',
        'stiga-command optimise perimeter tune-circular obstacle 3 +10 --commit-and-sync',
        'stiga-command optimise perimeter tune-rectangular obstacle 6 +20,-5',
        'stiga-command optimise perimeter move obstacle 6 +30,-20',
    ],
    skipDefaultSetup: true,
    execute: async (options, context) => runOptimise(context.credentials, options, context.params),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Bulk backup/restore: iterate every command that declares `backup` support and drive its existing export/import
// (--save/--load) against the standard data/<name>.backup file. New backup-capable commands are picked up for
// free — they only need a `backup: { format }` tag and working save/load.

const BACKUP_DIR = 'data';

async function runBackupRestore(mode, options, context) {
    const targets = Object.values(commands).filter((c) => c.backup);
    if (targets.length === 0) throw throwExit('no backup-capable commands are registered', 1);
    if (mode === 'backup') fs.mkdirSync(BACKUP_DIR, { recursive: true });

    // The meta-commands run cloud-only (skipDefaultSetup → just credentials). Cloud-backed commands (perimeters)
    // use context.credentials; MQTT-backed ones (schedule, tagged transport:'mqtt') need a device + connectors.
    // Set those up once, lazily, only when a tagged command needs them, and expose both on the sub-context.
    let connectors;
    if (targets.some((c) => c.backup.transport === 'mqtt')) {
        const framework = new StigaAPIFramework({ debug: options.debug });
        if (!(await framework.load(context.credentials.username, context.credentials.password))) throw throwExit('framework load failed', 2);
        const { device } = framework.getDeviceAndBasePair();
        if (!device) throw throwExit('no robot found', 2);
        connectors = { auth: framework.auth, device, base: undefined, deviceConnection: undefined, connectedDevice: undefined, connectedBase: undefined };
    }
    const subContext = { ...context, device: connectors?.device, connectors };

    let failures = 0;
    for (const cmd of targets) {
        const file = `${BACKUP_DIR}/${cmd.name}.backup`;
        if (mode === 'restore' && !fs.existsSync(file)) {
            display.log(`restore ${cmd.name}: skipped (no ${file})`);
            continue;
        }
        const sub = { ...options, format: cmd.backup.format, save: mode === 'backup' ? file : undefined, load: mode === 'restore' ? file : undefined };
        display.log(`${mode} ${cmd.name} ${mode === 'backup' ? '→' : '←'} ${file}`);
        // suppress the sub-command's own text/json dump (display keys off globalOptions.format) — we only want
        // the blob written. 'none' covers both native and json sub-formats (json would otherwise print).
        const prevFormat = globalOptions.format;
        globalOptions.format = 'none';
        try {
            await cmd.execute(sub, subContext);
        } catch (e) {
            failures++;
            display.error(`${mode} ${cmd.name} failed: ${e.message}`);
        } finally {
            globalOptions.format = prevFormat;
        }
    }
    // tidy the MQTT connection if we opened one (process.exit on the skipDefaultSetup path also covers this)
    if (connectors) {
        if (connectors.connectedDevice) connectors.connectedDevice.destroy();
        if (connectors.deviceConnection) connectors.deviceConnection.disconnect();
    }
    display.log(`${mode} complete: ${targets.length - failures}/${targets.length} ok`);
    if (failures > 0) throw throwExit(`${failures} ${mode}(s) failed`, 2);
}

commandRegister('backup', {
    description: 'Back up every backup-capable command to data/<command>.backup',
    targets: ['robot', 'base'],
    usage: 'stiga-command backup [help]',
    summary: 'Export each backup-capable command (its lossless native blob) to the standard data/ directory.',
    details: ['', 'Iterates the command set and exports every command that supports it (perimeters, schedule)', 'to data/<command>.backup. Restore the set with `restore`. Schedule needs a robot/MQTT connection.'],
    examples: ['stiga-command backup'],
    skipDefaultSetup: true,
    execute: async (options, context) => runBackupRestore('backup', options, context),
});

commandRegister('restore', {
    description: 'Restore every backup-capable command from data/<command>.backup',
    targets: ['robot', 'base'],
    usage: 'stiga-command restore [help]',
    summary: 'Import each backup-capable command from its data/<command>.backup file (skips any that are missing).',
    details: ['', 'Iterates the command set and imports every command that supports it (perimeters, schedule)', 'from data/<command>.backup. Perimeters PATCHes the cloud; schedule pushes to the robot over MQTT.'],
    examples: ['stiga-command restore'],
    skipDefaultSetup: true,
    execute: async (options, context) => runBackupRestore('restore', options, context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister('start', {
    description: 'Start mowing',
    targets: ['robot'],
    usage: 'stiga-command --robot start [help]',
    summary: 'Start the robot mowing.',
    examples: ['stiga-command --robot start'],
    execute: async (options, context) => executeRobotCommand('start', (d) => d.sendStart(), context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister('stop', {
    description: 'Stop the robot',
    targets: ['robot'],
    usage: 'stiga-command --robot stop [help]',
    summary: 'Stop the robot.',
    examples: ['stiga-command --robot stop'],
    execute: async (options, context) => executeRobotCommand('stop', (d) => d.sendStop(), context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['go-home', 'goHome', 'home'], {
    description: 'Send the robot home to dock',
    targets: ['robot'],
    usage: 'stiga-command --robot go-home [help]',
    summary: 'Send the robot back to its docking station.',
    examples: ['stiga-command --robot go-home'],
    execute: async (options, context) => executeRobotCommand('go-home', (d) => d.sendGoHome(), context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['force-cut', 'forceCut', 'cut'], {
    description: 'Force the robot to mow a specific zone now',
    targets: ['robot'],
    usage: 'stiga-command --robot force-cut <zone> [help]',
    summary: 'Send the robot to mow the given zone number immediately (FORCE_CUT).',
    examples: ['stiga-command --robot force-cut 2'],
    execute: async (options, context) => {
        const zone = Number.parseInt(context.params[0], 10);
        if (!Number.isInteger(zone) || zone < 1) throw throwExit('force-cut requires a zone number, e.g. force-cut 2', 2);
        return executeRobotCommand('force-cut', (d) => d.sendForceCut(zone), context);
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['force-border-cut', 'forceBorderCut', 'border-cut'], {
    description: "Force the robot to cut a specific zone's border now",
    targets: ['robot'],
    usage: 'stiga-command --robot force-border-cut <zone> [help]',
    summary: "Send the robot to cut the given zone's border immediately (FORCE_BORDER_CUT).",
    examples: ['stiga-command --robot force-border-cut 2'],
    execute: async (options, context) => {
        const zone = Number.parseInt(context.params[0], 10);
        if (!Number.isInteger(zone) || zone < 1) throw throwExit('force-border-cut requires a zone number, e.g. force-border-cut 2', 2);
        return executeRobotCommand('force-border-cut', (d) => d.sendForceBorderCut(zone), context);
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['reset-error', 'resetError', 'reset'], {
    description: 'Clear a recoverable latched error (the app\'s "reset error" button)',
    targets: ['robot'],
    usage: 'stiga-command --robot reset-error [help]',
    summary: 'Send RESET_ERROR (CMD_ROBOT 37) to clear a recoverable error. Note: not every error is resettable — some stuck conditions need physical intervention.',
    examples: ['stiga-command --robot reset-error'],
    execute: async (options, context) => executeRobotCommand('reset-error', (d) => d.sendResetError(), context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['boot', 'startup'], {
    description: 'Boot the robot out of a "startup required" state (the app\'s "boot" button)',
    targets: ['robot'],
    usage: 'stiga-command --robot boot [help]',
    summary: 'Send BOOT (CMD_ROBOT 9) to clear STARTUP_REQUIRED; the robot then proceeds into calibration.',
    examples: ['stiga-command --robot boot'],
    execute: async (options, context) => executeRobotCommand('boot', (d) => d.sendBoot(), context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['calibrate-blades', 'calibrateBlades', 'blades'], {
    description: 'Calibrate the cutting blades',
    targets: ['robot'],
    usage: 'stiga-command --robot calibrate-blades [help]',
    summary: 'Trigger blade calibration on the robot.',
    examples: ['stiga-command --robot calibrate-blades'],
    execute: async (options, context) => executeRobotCommand('calibrate-blades', (d) => d.sendCalibrateBlades(), context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['calibrate-docking', 'calibrateDocking', 'docking'], {
    description: 'Calibrate the docking/charging alignment',
    targets: ['robot'],
    usage: 'stiga-command --robot calibrate-docking [help]',
    summary: 'Trigger docking calibration on the robot (the app\'s "docking calibration"). Robot reports status type 25 while running.',
    examples: ['stiga-command --robot calibrate-docking'],
    execute: async (options, context) => executeRobotCommand('calibrate-docking', (d) => d.sendCalibrateDocking(), context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['cloud-sync', 'cloudSync', 'sync'], {
    description: 'Tell the robot to re-sync its perimeter from the cloud',
    targets: ['robot'],
    usage: 'stiga-command --robot cloud-sync [help]',
    summary: 'Trigger the robot to download and apply the current cloud perimeter (CLOUDSYNC_DOWNLOAD).',
    examples: ['stiga-command --robot cloud-sync'],
    execute: async (options, context) => {
        const { device, connectors } = context;
        const { auth } = connectors;
        if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
        const server = new StigaAPIConnectionServer(auth);
        const perimeters = new StigaAPIPerimeters(server, device);
        if (!(await perimeters.load())) throw throwExit('failed to load perimeters', 2);
        const url = perimeters.getResourceUrl();
        if (!url) throw throwExit('no perimeter resource url available', 2);
        return executeRobotCommand('cloud-sync', (d) => d.sendCloudSync(`Bearer ${auth.token}`, url), context);
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

commandRegister(['go-away', 'goAway', 'avoid'], {
    description: 'Push a temporary circular GO_AWAY obstacle to the robot (real-time avoid)',
    targets: ['robot'],
    usage: 'stiga-command --robot go-away <lat> <lng> <radius_m> [expiry_days]',
    summary: 'Tell the robot to avoid a circle at lat/lng now (MQTT push only).',
    details: [
        '',
        'NOTE: this only pushes the real-time GO_AWAY command over MQTT. It does NOT add the obstacle',
        'to the cloud perimeter (tempObstacles), so it will not persist across a full re-sync. To make',
        'it permanent the caller must also update the cloud perimeter — left to the API client.',
    ],
    examples: ['stiga-command --robot go-away 59.6620665 12.9959925 2 30'],
    execute: async (options, context) => {
        const { device, connectors, params } = context;
        const { auth } = connectors;
        const lat = Number.parseFloat(params[0]),
            lng = Number.parseFloat(params[1]),
            radius = Number.parseFloat(params[2]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) throw throwExit('go-away requires <lat> <lng> <radius_m>, e.g. go-away 59.662 12.996 2', 2);
        const days = Number.isFinite(Number.parseFloat(params[3])) ? Number.parseFloat(params[3]) : 30;
        if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
        const server = new StigaAPIConnectionServer(auth);
        const perimeters = new StigaAPIPerimeters(server, device);
        if (!(await perimeters.load())) throw throwExit('failed to load perimeters', 2);
        const url = perimeters.getResourceUrl();
        const ref = perimeters.getReferencePosition();
        if (!url || !ref) throw throwExit('no perimeter / reference position available', 2);
        // lat/lng -> ENU east/north metres, relative to the perimeter reference position
        const placement = {
            east: (lng - ref.longitude) * (111320 * Math.cos((ref.latitude * Math.PI) / 180)),
            north: (lat - ref.latitude) * 111320,
            radius,
            expirySeconds: Math.round(days * 86400),
        };
        return executeRobotCommand('go-away', (d) => d.sendGoAway(`Bearer ${auth.token}`, url, placement), context);
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// Parse a command id given as decimal (9) or hex (0x31 / 0x09). Returns undefined if it is neither.
function parseCommandId(str) {
    if (str === undefined) return undefined;
    const s = String(str).trim();
    let n = Number.NaN;
    if (/^0x[\da-f]+$/i.test(s)) n = Number.parseInt(s, 16);
    else if (/^\d+$/.test(s)) n = Number.parseInt(s, 10);
    return Number.isInteger(n) && n >= 0 && n <= 0x7fffffff ? n : undefined;
}

// Normalise a hex byte string (accepts 0x prefix, spaces, colons). Throws on odd length / non-hex.
function normaliseHex(str, label) {
    if (str === undefined) return undefined;
    const s = String(str).replace(/^0x/i, '').replaceAll(/[\s:]/g, '');
    if (s.length === 0) return undefined;
    if (s.length % 2 !== 0 || !/^[\da-f]+$/i.test(s)) throw throwExit(`${label} must be an even-length hex string, got '${str}'`, 2);
    return s.toLowerCase();
}

function displayRawCommandMap() {
    const { ROBOT_COMMAND_TYPES } = StigaAPIElements;
    const known = Object.keys(ROBOT_COMMAND_TYPES)
        .map(Number)
        .sort((a, b) => a - b);
    const max = known.length > 0 ? known[known.length - 1] : 0;
    const gaps = [];
    for (let i = 0; i <= max; i++) if (!ROBOT_COMMAND_TYPES[i]) gaps.push(i);
    display.text('Known CMD_ROBOT command ids:');
    for (const id of known) display.text(`  ${String(id).padStart(3)} (0x${id.toString(16).padStart(2, '0')})  ${ROBOT_COMMAND_TYPES[id]}`);
    display.text('');
    display.text(`Unmapped gaps 0..${max}: ${gaps.join(', ')}`);
    display.text(`(ids above ${max} are also possible, just never observed)`);
    display.json({ source: 'robot', kind: 'raw-command-map', known: Object.fromEntries(known.map((id) => [id, ROBOT_COMMAND_TYPES[id]])), gaps });
}

async function runRaw(options, context) {
    const { params, device, connectors } = context;
    const { ROBOT_COMMAND_TYPES, encodeRobotRawCommand } = StigaAPIElements;

    // No command id and no --payload -> just print the command map (offline, no connection needed).
    if (params[0] === undefined && options.payload === undefined) {
        displayRawCommandMap();
        return;
    }

    const payloadHex = normaliseHex(options.payload, '--payload');
    let commandType, fieldsHex;
    if (payloadHex === undefined) {
        commandType = parseCommandId(params[0]);
        if (commandType === undefined) throw throwExit('raw needs a command id (decimal like 9 or hex like 0x31), or --payload <hex>', 2);
        fieldsHex = normaliseHex(params[1] ?? options.data, 'field-2 data');
    } else if (params[0] !== undefined || options.data !== undefined) throw throwExit('raw --payload is verbatim: do not also pass a command id or --data', 2);

    const spec = payloadHex === undefined ? { commandType, fields: fieldsHex } : { payload: payloadHex };
    const bytes = encodeRobotRawCommand(spec);
    const hex = bytes.toString('hex');
    const name = commandType === undefined ? '(verbatim payload)' : (ROBOT_COMMAND_TYPES[commandType] ?? 'UNKNOWN / undocumented');

    display.text('Raw CMD_ROBOT plan:');
    if (commandType !== undefined) display.text(`  command : ${commandType} (0x${commandType.toString(16).padStart(2, '0')})  ${name}`);
    if (fieldsHex) display.text(`  field 2 : ${fieldsHex} (${fieldsHex.length / 2} bytes)`);
    display.text(`  payload : ${hex} (${bytes.length} bytes)`);
    display.text(`  ack     : ${options.noAck ? 'not awaited (--no-ack)' : 'awaited'}`);

    if (!options.commit) {
        display.text('');
        display.text('DRY RUN — nothing sent. Add --commit to transmit.');
        display.json({ source: 'robot', kind: 'raw', committed: false, payloadHex: hex, commandType, name });
        return;
    }

    await connectToRobot(device, connectors);
    const result = await device.sendRaw({ ...spec, waitAck: !options.noAck });
    if (options.noAck) display.text(`sent (ack not awaited): ${result.payload}`);
    else if (result.acked) display.text(`ACK: ${result.ok ? 'OK' : 'REJECTED'} (command ${result.commandType})`);
    else display.text('no ACK within timeout — the robot may not implement this command (or is unresponsive)');
    display.json({ source: 'robot', kind: 'raw', committed: true, payloadHex: result.payload, commandType: result.commandType, name, acked: result.acked, ok: result.ok });
}

commandRegister('raw', {
    description: 'Send a raw / undocumented CMD_ROBOT command (protocol probing)',
    targets: ['robot'],
    usage: 'stiga-command --robot raw [<cmd> [dataHex] | --payload <hex>] [--data <hex>] [--no-ack] [--commit]',
    summary: 'Transmit an arbitrary CMD_ROBOT payload to the robot. DRY-RUN by default (shows the exact bytes); add --commit to actually send. With no arguments it prints the known command map and the unmapped id gaps.',
    details: [
        '',
        'DANGER: this bypasses the command whitelist and can send ids the robot may act on in unknown,',
        'possibly unsafe ways. Prefer parameterless probes; keep the robot docked; be ready to power-cycle.',
        '',
        '  raw                    list the known command ids and the unmapped gaps (no send)',
        '  raw <cmd>              envelope { 1: cmd, 3: cmd } — the safe parameterless form',
        '  raw <cmd> <dataHex>    envelope { 1: cmd, 2: <bytes>, 3: cmd } — bytes become field 2',
        '  raw --payload <hex>    send these exact bytes as the whole CMD_ROBOT payload (no envelope)',
        '',
        '<cmd> is decimal (9) or hex (0x09 / 0x31). --no-ack fires without waiting for the ACK (a missing',
        'ACK is itself a signal — the robot silently ignores commands it does not implement).',
    ],
    examples: ['stiga-command --robot raw', 'stiga-command --robot raw 3', 'stiga-command --robot raw 0x09 --commit', 'stiga-command --robot raw 23 --commit', 'stiga-command --robot raw --payload 08091803 --commit'],
    execute: async (options, context) => runRaw(options, context),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function notificationPredicate(selector) {
    const sel = selector.toLowerCase();
    if (sel === 'unread') return (n) => !n.isRead();
    if (sel === 'read') return (n) => n.isRead();
    if (sel === 'recent' || sel.startsWith('recent:')) {
        const hours = sel.includes(':') ? Number.parseInt(sel.slice(sel.indexOf(':') + 1)) || 24 : 24;
        const cutoff = Date.now() - hours * 60 * 60 * 1000;
        return (n) => {
            const createdAt = n.getCreatedAt();
            return createdAt !== undefined && createdAt.getTime() > cutoff;
        };
    }
    if (sel.startsWith('type:')) return (n) => (n.getType() || '').toLowerCase() === sel.slice(5);
    if (sel.startsWith('category:')) return (n) => (n.getCategory() || '').toLowerCase() === sel.slice(9);
    return (n) => (n.getType() || '').toLowerCase() === sel || (n.getCategory() || '').toLowerCase() === sel;
}

async function runNotifications(credentials, selectors) {
    const auth = new StigaAPIAuthentication(credentials.username, credentials.password);
    if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw throwExit('server connection failed', 2);
    const notifications = new StigaAPINotifications(server);
    if (!(await notifications.load())) throw throwExit('failed to load notifications', 2);

    let list = notifications.getAll();
    for (const selector of selectors) list = list.filter(notificationPredicate(selector));
    list = [...list].sort((a, b) => (b.getCreatedAt()?.getTime() ?? 0) - (a.getCreatedAt()?.getTime() ?? 0));

    // resolve the base reference position (only if some notification carries geometry or a point) so
    // obstacle metadata AND error/info positions can be shown as lat/lng + a copy-paste Google Maps link
    let referencePosition;
    if (list.some((n) => n.getMetadata()?.obstacles?.length || n.getPosition())) {
        try {
            const garage = new StigaAPIGarage(server);
            const device = (await garage.load()) ? garage.getDevices()?.[0] : undefined;
            if (device) {
                const perimeters = new StigaAPIPerimeters(server, device);
                if (await perimeters.load()) referencePosition = perimeters.getReferencePosition();
            }
        } catch {
            // no reference -> fall back to ENU metres without a link
        }
    }

    const filterNote = selectors.length > 0 ? ` [qualifiers: ${selectors.join(', ')}]` : '';
    display.text(`Notifications: ${list.length} shown of ${notifications.getCount()} total, ${notifications.getUnreadCount()} unread${filterNote}`);
    for (const n of list) {
        const when = n.getCreatedAt()?.toISOString() ?? 'unknown';
        const status = n.isRead() ? 'read  ' : 'UNREAD';
        const kind = [n.getType(), n.getCategory()].filter(Boolean).join('/') || '-';
        display.text(`  ${when}  ${status}  ${kind}  ${n.getTitle()}`);
        const meta = n.getMetadata(referencePosition);
        if (meta?.obstacles?.length)
            for (const o of meta.obstacles) {
                const link = typeof o.latitude === 'number' ? `  (https://www.google.com/maps?q=${o.latitude.toFixed(7)},${o.longitude.toFixed(7)})` : '';
                display.text(`      obstacle: ${o.east.toFixed(1)},${o.north.toFixed(1)} m  radius ${o.radius?.toFixed(2)} m${link}`);
            }
        const pos = n.getPosition(referencePosition);
        if (pos) {
            const link = typeof pos.latitude === 'number' ? `  (https://www.google.com/maps?q=${pos.latitude.toFixed(7)},${pos.longitude.toFixed(7)})` : '';
            display.text(`      position: ${pos.x.toFixed(1)},${pos.y.toFixed(1)} m${link}`);
        }
    }
    display.json({
        source: 'cloud',
        kind: 'notifications',
        value: {
            total: notifications.getCount(),
            unread: notifications.getUnreadCount(),
            shown: list.length,
            qualifiers: selectors,
            notifications: list.map((n) => ({
                uuid: n.getUuid() ?? null,
                createdAt: n.getCreatedAt()?.toISOString() ?? null,
                readAt: n.getReadAt()?.toISOString() ?? null,
                read: n.isRead(),
                type: n.getType() ?? null,
                category: n.getCategory() ?? null,
                title: n.getTitle(),
                body: n.getBody(),
                deviceUuid: n.getDeviceUuid() ?? null,
                position: n.getPosition(referencePosition) ?? null,
                metadata: n.getMetadata(referencePosition) ?? null,
            })),
        },
    });
}

// Resolve which notifications a `delete[:selector]` targets. `all` is sorted newest-first.
//   (none)        -> all          read|unread -> by state
//   <N>s|m|h|d    -> created within the last N (e.g. 5h, 20m)
//   YYYY-MM[-DD]  -> created on that date prefix
//   <N>           -> the last N (most recent)        <uuid> -> that exact notification
function notificationDeleteTargets(all, selector) {
    if (!selector) return [...all];
    const sel = selector.toLowerCase();
    if (sel === 'read') return all.filter((n) => n.isRead());
    if (sel === 'unread') return all.filter((n) => !n.isRead());
    const dur = sel.match(/^(\d+)([dhms])$/);
    if (dur) {
        const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[dur[2]];
        const cutoff = Date.now() - Number(dur[1]) * mult;
        return all.filter((n) => (n.getCreatedAt()?.getTime() ?? 0) > cutoff);
    }
    // eslint-disable-next-line regexp/no-unused-capturing-group
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(sel)) return all.filter((n) => (n.getCreatedAt()?.toISOString() ?? '').startsWith(sel));
    if (/^\d+$/.test(sel)) return all.slice(0, Number(sel)); // last N (newest-first)
    return all.filter((n) => n.getUuid() === selector); // uuid (case-sensitive)
}

async function runNotificationsDelete(credentials, selector) {
    const auth = new StigaAPIAuthentication(credentials.username, credentials.password);
    if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw throwExit('server connection failed', 2);
    const notifications = new StigaAPINotifications(server);
    if (!(await notifications.load())) throw throwExit('failed to load notifications', 2);

    const all = [...notifications.getAll()].sort((a, b) => (b.getCreatedAt()?.getTime() ?? 0) - (a.getCreatedAt()?.getTime() ?? 0));
    const targets = notificationDeleteTargets(all, selector);
    const label = `delete${selector ? ':' + selector : ''}`;
    if (targets.length === 0) {
        display.text(`No notifications match '${label}' (of ${all.length} total)`);
        display.json({ source: 'cloud', kind: 'notificationsDelete', value: { selector: selector ?? null, matched: 0, deleted: 0, total: all.length, results: [] } });
        return;
    }
    display.text(`Deleting ${targets.length} of ${all.length} notification(s) [${label}]:`);
    let deleted = 0;
    const results = [];
    for (const n of targets) {
        const uuid = n.getUuid();
        const ok = await notifications.delete(uuid);
        if (ok) deleted++;
        display.text(`  ${ok ? 'deleted' : 'FAILED '}  ${n.getCreatedAt()?.toISOString() ?? '?'}  ${n.isRead() ? 'read  ' : 'unread'}  ${n.getTitle()}`);
        results.push({ uuid, ok, createdAt: n.getCreatedAt()?.toISOString() ?? null, title: n.getTitle() });
    }
    display.text(`Done: ${deleted}/${targets.length} deleted.`);
    display.json({ source: 'cloud', kind: 'notificationsDelete', value: { selector: selector ?? null, matched: targets.length, deleted, total: all.length, results } });
}

commandRegister('notifications', {
    description: 'Display device notifications/events from the cloud',
    targets: ['robot', 'base'],
    args: '[qualifier...]',
    usage: 'stiga-command notifications [qualifier...] [help]',
    summary: 'Fetch the notification/event feed (events, errors) from the Stiga Cloud.',
    details: [
        '',
        'Optionally pass one or more qualifier arguments to filter; multiple qualifiers',
        'combine with AND. Recognised qualifiers:',
        '  unread | read            by read state',
        '  recent | recent:<hours>  created within the last <hours> (default 24)',
        '  type:<value>             match notification type',
        '  category:<value>         match notification category',
        '  <value>                  bare value matches either type or category',
        '',
        'Delete (mark-as-read endpoint not found yet — only delete is wired):',
        '  delete                   delete ALL notifications',
        '  delete:read | :unread    by read state',
        '  delete:5h | :20m         created within the last 5 hours / 20 minutes (s|m|h|d)',
        '  delete:2025-06[-05]      created on that year-month[-day]',
        '  delete:5                 the last 5 (most recent)',
        '  delete:<uuid>            one specific notification',
    ],
    examples: ['stiga-command notifications', 'stiga-command notifications unread', 'stiga-command notifications delete:read', 'stiga-command notifications delete:5h', 'stiga-command notifications delete:2026-06-05'],
    skipDefaultSetup: true,
    execute: async (options, context) => {
        const first = (context.params[0] || '').toLowerCase();
        if (first === 'delete' || first.startsWith('delete:')) {
            const raw = context.params[0];
            return runNotificationsDelete(context.credentials, raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : undefined);
        }
        return runNotifications(context.credentials, context.params);
    },
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function runUser(credentials) {
    const auth = new StigaAPIAuthentication(credentials.username, credentials.password);
    if (!(await auth.isValid())) throw throwExit('authentication failed', 2);
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw throwExit('server connection failed', 2);
    const user = new StigaAPIUser(server);
    if (!(await user.load())) throw throwExit('failed to load user account', 2);

    const lastLogin = user.getLastLogin();
    display.text('User Account:');
    display.text(`  Name:       ${user.getFullName() || '-'}`);
    display.text(`  Email:      ${user.getEmail() || '-'}`);
    display.text(`  Mobile:     ${user.getMobile() || '-'}`);
    display.text(`  Country:    ${user.getCountry() || '-'}`);
    display.text(`  Language:   ${user.getLanguage() || '-'}`);
    display.text(`  Verified:   ${user.isVerified() ? 'yes' : 'no'}`);
    display.text(`  Last login: ${lastLogin ? lastLogin.toISOString() : '-'}`);
    display.text(`  Consent:    terms=${user.hasAcceptedTerms() ? 'yes' : 'no'}, marketing=${user.hasMarketingConsent() ? 'yes' : 'no'}, dataAnalysis=${user.hasDataAnalysisConsent() ? 'yes' : 'no'}`);
    display.json({
        source: 'cloud',
        kind: 'user',
        value: {
            uuid: user.getUuid() ?? null,
            name: user.getFullName() ?? null,
            email: user.getEmail() ?? null,
            mobile: user.getMobile() ?? null,
            country: user.getCountry() ?? null,
            language: user.getLanguage() ?? null,
            verified: user.isVerified(),
            lastLogin: lastLogin ? lastLogin.toISOString() : null,
            termsAccepted: user.hasAcceptedTerms(),
            marketingConsent: user.hasMarketingConsent(),
            dataAnalysisConsent: user.hasDataAnalysisConsent(),
        },
    });
}

commandRegister('user', {
    description: 'Display the cloud account profile',
    targets: ['robot', 'base'],
    usage: 'stiga-command user [help]',
    summary: 'Fetch the Stiga Cloud account profile (name, email, verification, consents).',
    examples: ['stiga-command user', 'stiga-command user --format json | jq .'],
    skipDefaultSetup: true,
    execute: async (options, context) => runUser(context.credentials),
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function showHelp() {
    display.log('Usage: stiga-command [options] <command> [params...]');
    display.log('\nOptions:');
    display.log('  --robot              Select/Add robot as target');
    display.log('  --base               Select/Add base station as target');
    display.log('  --both               Select both robot and base station as targets (default)');
    display.log('  --debug              Enable debug output (on stderr)');
    display.log('  --level <lvl>        Output level: quiet (errors only), normal (default), verbose (extra diagnostics on stderr)');
    display.log('  --format <fmt>       Output format: none (suppress), text (default), json (one JSON object per line)');
    display.log('  --watch [secs]       Watch and show events: request status every "secs" (default 5) if idle; 0 = passive (no polling)');
    display.log('  --passive            Alias for --watch 0 (passive listen, no polling)');
    display.log('  --username <u>       Override username credential from stiga-config.js');
    display.log('  --password <p>       Override password credentials from stiga-config.js');
    display.log('  --mqtt-broker <id>   Override MQTT broker suffix (e.g. broker, broker1, broker2)');
    display.log('\nConfiguration (resolved in order, first match wins):');
    display.log('  1. --username/--password command-line flags (credentials only)');
    display.log('  2. $STIGA_CONFIG environment variable (path to a config file)');
    display.log(`  3. stiga-config.<hostname>.js  (this host: stiga-config.${require('node:os').hostname()}.js)`);
    display.log('  4. stiga-config.js');
    display.log('\nCommands (| separates aliases, any unique prefix also matches):');
    const labels = Object.entries(commands).map(([name, cmd]) => ({
        cmd,
        label: (cmd.aliases?.length > 0 ? [name, ...cmd.aliases].join('|') : name) + (cmd.args ? ' ' + cmd.args : ''),
    }));
    const labelWidth = Math.max(...labels.map((l) => l.label.length)) + 2;
    for (const { label, cmd } of labels) display.log(`  ${label.padEnd(labelWidth)} ${cmd.description} (${cmd.targets.join(', ')})`);
    display.log('\nFor command-specific help:');
    display.log('  stiga-command <command> help');
    display.log('\nFor all or command-specific examples:');
    display.log('  stiga-command examples');
    display.log('  stiga-command <command> help');
}

function showExamples() {
    display.log('Examples:');
    for (const [name, cmd] of Object.entries(commands).filter(([, cmd]) => cmd.examples?.length)) {
        display.log(`\n  ${name}:`);
        for (const ex of cmd.examples) display.log(`    ${ex}`);
    }
    display.log('\n  global / watch:');
    display.log('    stiga-command --robot --watch');
    display.log('    stiga-command --robot --watch 0 --debug');
    display.log('    stiga-command --robot --watch 0 --format json --level quiet | jq .');
    display.log('    stiga-command --robot status --format json --level quiet | jq .');
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function main() {
    let options;
    try {
        options = parseArgs();
    } catch (e) {
        display.error(e.message);
        process.exit(1);
    }

    if (!options.command && options.watch === undefined) {
        showHelp();
        process.exit(1);
    }

    if (['examples', 'example'].includes(options.command)) {
        showExamples();
        process.exit(0);
    }

    let cmd;
    if (options.command) {
        try {
            if (options.params.length > 0 && options.params[options.params.length - 1] === 'help') {
                const c = commandResolve(options.command);
                if (c) {
                    commandShowHelp(c);
                    process.exit(0);
                }
            }
            cmd = commandResolve(options.command);
        } catch (e) {
            display.error(e.message);
            process.exit(1);
        }
        if (!cmd) {
            display.error(`Unknown command: ${options.command}`);
            showHelp();
            process.exit(1);
        }
        if (options.target !== 'both' && !cmd.targets.includes(options.target)) {
            display.error(`Command '${options.command}' does not support target '${options.target}' (only ${cmd.targets.join(', ')})`);
            process.exit(1);
        }
    }

    let credentials;
    try {
        credentials = resolveCredentials(options);
    } catch (e) {
        display.error(e.message);
        process.exit(1);
    }

    if (options.mqttBroker) StigaAPIConnectionMQTT.brokerOverride = options.mqttBroker;

    if (cmd?.skipDefaultSetup)
        try {
            await cmd.execute(options, {
                target: options.target,
                params: options.params.filter((p) => p !== 'help'),
                options,
                credentials,
            });
            process.exit(0);
        } catch (e) {
            display.error('Error:', e.message);
            if (options.debug) display.error(e.stack);
            process.exit(e.exitCode ?? 1);
        }

    try {
        display.debug('Initializing framework...');
        const framework = new StigaAPIFramework({ debug: options.debug });
        if (!(await framework.load(credentials.username, credentials.password))) throw new Error('Failed to load framework');
        const { device, base } = framework.getDeviceAndBasePair();
        if (!device) throw new Error('No robot found');
        if (options.target !== 'robot' && !base) throw new Error('No base found for robot');
        display.verbose(`Cloud: robot/${device.getMacAddress()} '${(await device.getName()).value}'${base ? ', base/' + base.getMacAddress() : ''}`);

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
        process.exit(e.exitCode ?? 1);
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

main();

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
