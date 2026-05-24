#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// stiga-maintenance.js
//
// Read-only: fetch the maintenance event log for the first device and pretty-print it with
// action names resolved from the global catalogue. Joins:
//   /api/commons/maintenanceactions   — catalogue (uuid -> action name)
//   /api/maintenances?device_uuid=…   — per-device events referencing those uuids
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIConfig } = require('../api/StigaAPI');

async function fetchFirstDevice(server) {
    const r = await server.get('/api/garage', { relationships: 'base,connpack' });
    if (!r.ok) throw new Error(`/api/garage -> ${r.status}`);
    const body = await r.json();
    const dev = (body.data || []).find((d) => d.type === 'devices');
    if (!dev) throw new Error('no device in garage');
    return { uuid: dev.attributes?.uuid, name: dev.attributes?.name, mac: dev.attributes?.mac_address };
}

function formatAgo(date) {
    const s = Math.round((Date.now() - date.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86_400)}d ago`;
}

(async () => {
    const { username, password } = StigaAPIConfig.load();
    const auth = new StigaAPIAuthentication(username, password);
    if (!(await auth.isValid())) throw new Error('auth failed');
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw new Error('server connection failed');
    const device = await fetchFirstDevice(server);
    const deviceUuid = device.uuid;

    // 1. Action catalogue (small, global)
    const catResp = await server.get('/api/commons/maintenanceactions');
    if (!catResp.ok) throw new Error(`/api/commons/maintenanceactions -> ${catResp.status}`);
    const cat = (await catResp.json()).data || [];
    const actionByUuid = new Map(cat.map((a) => [a.attributes.uuid, a.attributes.action]));

    // 2. Per-device events
    const evtResp = await server.get('/api/maintenances', { device_uuid: deviceUuid });
    if (!evtResp.ok) throw new Error(`/api/maintenances -> ${evtResp.status}`);
    const events = ((await evtResp.json()).data || []).map((e) => {
        const a = e.attributes;
        return {
            uuid: a.uuid,
            actionUuid: a.maintenanceaction_uuid,
            action: actionByUuid.get(a.maintenanceaction_uuid) || `unknown(${a.maintenanceaction_uuid?.slice(0, 8)}…)`,
            done: a.done,
            workhours: a.workhours,
            note: a.note,
            battery: a.battery_level,
            createdAt: new Date(a.created_at),
        };
    });

    console.log('');
    console.log(`Device: ${device.name || '-'} (${device.mac || '-'})`);
    console.log('');
    console.log(`Catalogue (${cat.length} action types):`);
    for (const a of cat) console.log(`  ${a.attributes.action.padEnd(20)} ${a.attributes.uuid}`);

    console.log('');
    console.log(`Events (${events.length} for this device, newest first):`);
    if (events.length === 0) {
        console.log('  (none)');
    } else {
        // Sort newest first
        events.sort((a, b) => b.createdAt - a.createdAt);
        for (const e of events) {
            const when = `${e.createdAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
            const ago = formatAgo(e.createdAt);
            const batt = e.battery === null || e.battery === undefined ? '-' : `${e.battery}%`;
            const wh = e.workhours ? `${e.workhours}h` : '-';
            const done = e.done ? '✓' : ' ';
            const note = e.note && e.note !== e.action ? `   "${e.note}"` : '';
            console.log(`  ${done} ${when}   ${e.action.padEnd(20)}   batt=${batt.padStart(4)}   wh=${wh.padStart(3)}   (${ago})${note}`);
        }

        // Quick rollup by action
        const byAction = new Map();
        for (const e of events) byAction.set(e.action, (byAction.get(e.action) || 0) + 1);
        console.log('');
        console.log('  Count by action:');
        for (const [k, v] of [...byAction.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`    ${k.padEnd(20)} ${v}`);
        }
    }
    console.log('');
})().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
