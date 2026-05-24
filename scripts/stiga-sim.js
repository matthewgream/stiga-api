#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// stiga-sim.js
//
// Read-only: fetch the cellular SIM record for the first device's connectivity pack and
// pretty-print it. Shows identity (UUID/IMSI/ICCID/IMEI), service-pack profile, data usage
// counters and a decoded breakdown of the last cell ID the modem attached to. Useful for
// connectivity diagnostics — the SIM's "last seen" view is independent of the MQTT broker.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const mccMncList = require('mcc-mnc-list');
const { StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIConfig } = require('../api/StigaAPI');

// Skip the StigaAPIGarage / StigaAPIDevice abstractions here — they're async-laden and tuned
// for the connector/MQTT path, while these scripts just want a few JSON fields.
// Walks the garage response for every entity that carries a sim_uuid — robot device + base +
// any connectivity packs — so we can show all SIMs the account owns.
async function fetchSimSources(server) {
    const r = await server.get('/api/garage', { relationships: 'base,connpack' });
    if (!r.ok) throw new Error(`/api/garage -> ${r.status}`);
    const body = await r.json();
    // data has the primary 'devices' entries; included has 'OwnBases' and 'ConnPacks'. Both
    // can carry sim_uuid (robot SIM + reference-station SIM), so we walk both arrays.
    const entries = [...(body.data || []), ...(body.included || [])];
    return entries
        .filter((d) => d.attributes?.sim_uuid)
        .map((d) => ({
            type: d.type, // 'devices', 'OwnBases', 'ConnPacks', ...
            simUuid: d.attributes.sim_uuid,
            name: d.attributes.name || d.attributes.serial_number || '',
            mac: d.attributes.mac_address || '',
        }));
}

function formatBytes(n) {
    if (n === null || n === undefined) return '-';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatAgo(iso) {
    if (!iso) return '-';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86_400)}d ago`;
}

function carrierName(mcc, mnc) {
    const m = mccMncList.find({ mccmnc: `${mcc}${mnc}` });
    return m ? `${m.brand || m.operator} / ${m.countryName}` : `MCC ${mcc} MNC ${mnc}`;
}

// LTE cell ID format: MCC-MNC-TAC-ECI-PCI
// ECI = (eNodeB ID << 8) | Cell ID-within-eNB.
// PCI is 0..503, the physical layer identifier used for handover.
function parseCellId(cellId) {
    if (!cellId) return undefined;
    const parts = cellId.split('-');
    if (parts.length < 5) return undefined;
    const [mcc, mnc, tac, eciStr, pciStr] = parts;
    const eci = Number.parseInt(eciStr, 10);
    return {
        mcc,
        mnc,
        tac,
        eci,
        enodebId: eci >>> 8,
        cellInEnb: eci & 0xff,
        pci: Number.parseInt(pciStr, 10),
    };
}

async function showSim(server, src) {
    const response = await server.get(`/api/sim/${src.simUuid}`);
    if (!response.ok) {
        console.log('');
        console.log(`SIM for ${src.type} ${src.name || src.mac} — fetch failed (HTTP ${response.status})`);
        return;
    }
    const { data } = await response.json();
    const a = data.attributes;
    const info = a.last_info || {};
    const cell = parseCellId(info.lastCellId);

    const owner = `${src.type}${src.name ? ' "' + src.name + '"' : ''}${src.mac ? ' (' + src.mac + ')' : ''}`;
    const rows = [];
    rows.push(['Owner', owner]);
    rows.push(['SIM UUID', a.uuid]);
    rows.push(['IMSI', a.sim_id]);
    rows.push(['ICCID', info.iccid]);
    rows.push(['IMEI (modem)', info.imei]);
    rows.push(['Status', `${a.sim_status} · last_info.state="${info.state}"`]);
    rows.push(['Service pack', info.serviceProfile]);
    rows.push(['Created', `${a.created_at} (${formatAgo(a.created_at)})`]);
    rows.push(['Updated', `${a.updated_at} (${formatAgo(a.updated_at)})`]);
    rows.push(['Last used', `${info.lastUsed} (${formatAgo(info.lastUsed)})`]);
    rows.push(['Bytes in', `${formatBytes(info.bytesIn)} (${info.bytesIn?.toLocaleString()} bytes)`]);
    rows.push(['Bytes out', `${formatBytes(info.bytesOut)} (${info.bytesOut?.toLocaleString()} bytes)`]);
    rows.push(['Total data', formatBytes((info.bytesIn || 0) + (info.bytesOut || 0))]);
    if (a.created_at) {
        const days = (Date.now() - new Date(a.created_at).getTime()) / 86_400_000;
        const totalBytes = (info.bytesIn || 0) + (info.bytesOut || 0);
        if (days > 0.5) rows.push(['Avg per day', `${formatBytes(totalBytes / days)} (over ${days.toFixed(1)} days)`]);
    }
    if (info.country) rows.push(['Country (cloud)', info.country]);

    console.log('');
    console.log(`SIM — ${src.type}`);
    console.log('═'.repeat(`SIM — ${src.type}`.length));
    const labelWidth = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) console.log(`  ${k.padEnd(labelWidth)}   ${v ?? '-'}`);

    if (cell) {
        console.log('');
        console.log('  Last cell attachment');
        console.log('  ' + '─'.repeat(20));
        const cellRows = [
            ['Raw', info.lastCellId],
            ['MCC / MNC', `${cell.mcc} / ${cell.mnc}    (${carrierName(cell.mcc, cell.mnc)})`],
            ['TAC (Tracking Area)', cell.tac],
            ['ECI (E-UTRAN Cell ID)', `${cell.eci}    (0x${cell.eci.toString(16).toUpperCase()})`],
            ['  → eNodeB ID', cell.enodebId],
            ['  → Cell-in-eNB', cell.cellInEnb],
            ['PCI (Physical Cell)', `${cell.pci}    (0..503 — used for over-the-air handover)`],
        ];
        const cw = Math.max(...cellRows.map(([k]) => k.length));
        for (const [k, v] of cellRows) console.log(`    ${k.padEnd(cw)}   ${v ?? '-'}`);
    } else if (info.lastCellId) {
        console.log(`  Last cell ID (unparsed): ${info.lastCellId}`);
    }
}

(async () => {
    const { username, password } = StigaAPIConfig.load();
    const auth = new StigaAPIAuthentication(username, password);
    if (!(await auth.isValid())) throw new Error('auth failed');
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw new Error('server connection failed');

    const sims = await fetchSimSources(server);
    if (sims.length === 0) throw new Error('no entities with sim_uuid in garage');

    // De-duplicate (a sim_uuid can appear on multiple entities, e.g. device + its connpack)
    const seen = new Set();
    for (const src of sims) {
        if (seen.has(src.simUuid)) continue;
        seen.add(src.simUuid);
        await showSim(server, src);
    }
    console.log('');
})().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
