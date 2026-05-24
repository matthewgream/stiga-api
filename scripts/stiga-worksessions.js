#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// stiga-worksessions.js
//
// Read-only: fetch the cloud-side worksessions log for the first device. The endpoint stores
// {start_date, end_date, type} per cutting session — a long-term ledger of activity. We
// fetch the most-recent page (always) to show "what just happened", and optionally page
// through the entire history (--all) to compute lifetime totals and a duration distribution.
//
// Usage:
//   scripts/stiga-worksessions.js          # recent 30 + total counts only
//   scripts/stiga-worksessions.js --all    # full crawl + lifetime totals + buckets
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIConfig } = require('../api/StigaAPI');

const RECENT_PAGES = 3; // first 30 sessions when not --all
const PAGE_SIZE = 10;

async function fetchFirstDevice(server) {
    const r = await server.get('/api/garage', { relationships: 'base,connpack' });
    if (!r.ok) throw new Error(`/api/garage -> ${r.status}`);
    const body = await r.json();
    const dev = (body.data || []).find((d) => d.type === 'devices');
    if (!dev) throw new Error('no device in garage');
    return { uuid: dev.attributes?.uuid, name: dev.attributes?.name, mac: dev.attributes?.mac_address };
}

function formatDuration(secs) {
    if (secs < 60) return `${secs}s`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m${(secs % 60).toString().padStart(2, '0')}s`;
    return `${Math.floor(secs / 3600)}h${Math.floor((secs % 3600) / 60).toString().padStart(2, '0')}m`;
}

function formatAgo(date) {
    const s = Math.round((Date.now() - date.getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86_400)}d ago`;
}

function bucketize(durSec) {
    const m = durSec / 60;
    if (m < 1) return '<1min';
    if (m < 5) return '1-5min';
    if (m < 15) return '5-15min';
    if (m < 60) return '15-60min';
    if (m < 120) return '1-2h';
    return '>2h';
}

async function fetchPage(server, deviceUuid, page) {
    const r = await server.get('/api/worksessions', { device_uuid: deviceUuid, page, size: PAGE_SIZE });
    if (!r.ok) throw new Error(`/api/worksessions page ${page} -> ${r.status} ${r.statusText}`);
    return r.json();
}

(async () => {
    const all = process.argv.includes('--all');
    const { username, password } = StigaAPIConfig.load();
    const auth = new StigaAPIAuthentication(username, password);
    if (!(await auth.isValid())) throw new Error('auth failed');
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw new Error('server connection failed');
    const device = await fetchFirstDevice(server);
    const deviceUuid = device.uuid;

    // page 1 always — gets the recent items + the total count via data_info
    const first = await fetchPage(server, deviceUuid, 1);
    const totalPages = first.data_info?.total_pages ?? 1;
    const totalCount = first.data_info?.count ?? first.data.length;

    const sessions = [...first.data];
    const pagesToFetch = all ? totalPages : Math.min(RECENT_PAGES, totalPages);
    for (let p = 2; p <= pagesToFetch; p++) sessions.push(...(await fetchPage(server, deviceUuid, p)).data);

    const parsed = sessions.map((s) => {
        const a = s.attributes;
        const start = new Date(a.start_date),
            end = new Date(a.end_date);
        return { uuid: a.uuid, start, end, durSec: Math.round((end - start) / 1000), type: a.worksession_type };
    });

    console.log('');
    console.log(`Device: ${device.name || '-'} (${device.mac || '-'})`);
    console.log(`Cloud total: ${totalCount} sessions across ${totalPages} pages`);
    console.log('');
    console.log(`Recent (${Math.min(parsed.length, 30)} of ${totalCount}):`);
    parsed.slice(0, 30).forEach((s) => {
        const date = s.start.toISOString().slice(0, 16).replace('T', ' ');
        console.log(`  ${date} UTC   ${formatDuration(s.durSec).padStart(8)}   ${s.type.padEnd(8)}   (${formatAgo(s.start)})`);
    });

    if (all) {
        console.log('');
        console.log(`Lifetime summary (${parsed.length} sessions):`);
        const totalSec = parsed.reduce((a, s) => a + s.durSec, 0);
        const span = (parsed[0].end - parsed[parsed.length - 1].start) / 86_400_000;
        console.log(`  Span:           ${span.toFixed(0)} days (${parsed[parsed.length - 1].start.toISOString().slice(0, 10)} → ${parsed[0].end.toISOString().slice(0, 10)})`);
        console.log(`  Total cutting:  ${(totalSec / 3600).toFixed(1)} h (${(totalSec / 86_400).toFixed(2)} days)`);
        console.log(`  Avg / session:  ${formatDuration(Math.round(totalSec / parsed.length))}`);
        console.log(`  Avg / day:      ${(totalSec / 60 / span).toFixed(0)} min/day across span`);

        const buckets = { '<1min': 0, '1-5min': 0, '5-15min': 0, '15-60min': 0, '1-2h': 0, '>2h': 0 };
        parsed.forEach((s) => buckets[bucketize(s.durSec)]++);
        console.log('');
        console.log('  Duration distribution:');
        for (const [k, v] of Object.entries(buckets)) {
            const pct = ((100 * v) / parsed.length).toFixed(0);
            const bar = '█'.repeat(Math.round((40 * v) / parsed.length));
            console.log(`    ${k.padEnd(10)} ${String(v).padStart(4)}  ${pct.padStart(3)}%   ${bar}`);
        }

        // per-day for the last 14 days
        const byDay = new Map();
        const now = Date.now(),
            cutoff = now - 14 * 86_400_000;
        parsed.forEach((s) => {
            if (s.start.getTime() < cutoff) return;
            const d = s.start.toISOString().slice(0, 10);
            byDay.set(d, (byDay.get(d) || 0) + s.durSec);
        });
        if (byDay.size > 0) {
            console.log('');
            console.log('  Last 14 days (cutting minutes per day):');
            for (const [d, sec] of [...byDay.entries()].sort()) {
                const min = Math.round(sec / 60);
                const bar = '█'.repeat(Math.min(40, Math.round(min / 10)));
                console.log(`    ${d}  ${String(min).padStart(4)}m  ${bar}`);
            }
        }
    } else {
        console.log('');
        console.log('(use --all to fetch every page and show lifetime totals + distribution)');
    }
    console.log('');
})().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
});
