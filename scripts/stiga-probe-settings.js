#!/usr/bin/env node

// Read-only probe: dump the cloud garage device 'settings' object, to see whether per-zone
// settings and zone order are carried in the cloud (the MQTT read path is unimplemented).

const { StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIConfig } = require('../api/StigaAPI');

const { username, password } = StigaAPIConfig.load();

(async () => {
    const auth = new StigaAPIAuthentication(username, password);
    if (!(await auth.isValid())) throw new Error('auth failed');
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw new Error('server failed');

    const response = await server.get('/api/garage', { relationships: 'base,connpack' });
    const body = await response.json();
    const device = body?.data?.find((d) => d.type === 'Device') ?? body?.data?.[0];
    const settings = device?.attributes?.settings;

    console.log('device keys:', Object.keys(device ?? {}).join(', '));
    console.log('device attribute keys:', Object.keys(device?.attributes ?? {}).join(', '));
    console.log('\nsettings is:', Array.isArray(settings) ? `array[${settings.length}]` : typeof settings);
    const s = Array.isArray(settings) ? settings[0] : settings;
    if (s && typeof s === 'object') {
        console.log('settings[0] keys:', Object.keys(s).join(', '));
        for (const [k, v] of Object.entries(s)) {
            let desc = JSON.stringify(v);
            if (Array.isArray(v)) desc = `array[${v.length}]`;
            else if (v && typeof v === 'object') desc = `{${Object.keys(v).join(',')}}`;
            console.log(`  ${k}: ${desc}`);
        }
        console.log('\n--- full settings[0] JSON ---');
        console.log(JSON.stringify(s, undefined, 1));
    }
})().catch((e) => {
    console.error('PROBE FAILED:', e.message);
    process.exit(1);
});
