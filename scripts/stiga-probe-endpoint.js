#!/usr/bin/env node

// Generic read-only probe for the Stiga cloud REST surface. Authenticates with the
// configured account, GETs a user-supplied path, and prints status + a structural
// summary + the body. Use it to experiment with unknown endpoints (/api/zones, etc.).
//
// Usage:
//   scripts/stiga-probe-endpoint.js <path> [key=value ...]
//
// Examples:
//   scripts/stiga-probe-endpoint.js /api/zones
//   scripts/stiga-probe-endpoint.js /api/garage relationships=base,connpack
//   scripts/stiga-probe-endpoint.js /api/user/notifications

const { StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIConfig } = require('../api/StigaAPI');

const [path, ...kvArgs] = process.argv.slice(2);
if (!path) {
    console.error('usage: stiga-probe-endpoint.js <path> [key=value ...]');
    process.exit(2);
}

const query = {};
for (const arg of kvArgs) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
        console.error(`bad query arg (expected key=value): ${arg}`);
        process.exit(2);
    }
    query[arg.slice(0, eq)] = arg.slice(eq + 1);
}

function describe(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array[${value.length}]`;
    if (typeof value === 'object') return `{${Object.keys(value).join(',')}}`;
    if (typeof value === 'string') return `"${value.length > 60 ? value.slice(0, 60) + '…' : value}"`;
    return String(value);
}

(async () => {
    const { username, password } = StigaAPIConfig.load();
    const auth = new StigaAPIAuthentication(username, password);
    if (!(await auth.isValid())) throw new Error('auth failed');
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw new Error('server failed');

    console.log(`GET ${path}${Object.keys(query).length > 0 ? ' ?' + new URLSearchParams(query).toString() : ''}`);
    const response = await server.get(path, query);
    console.log(`-> ${response.status} ${response.statusText}  (content-type: ${response.headers.get('content-type') || '-'})`);

    const text = await response.text();
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        console.log(`\n--- non-JSON body (${text.length} bytes) ---`);
        console.log(text.length > 4000 ? text.slice(0, 4000) + '\n…[truncated]' : text);
        return;
    }

    console.log(`\ntop-level keys: ${Object.keys(body).join(', ')}`);
    if (Array.isArray(body?.data)) {
        console.log(`data: array[${body.data.length}]`);
        const first = body.data[0];
        if (first && typeof first === 'object') {
            console.log(`data[0] keys: ${Object.keys(first).join(', ')}`);
            if (first.attributes && typeof first.attributes === 'object') {
                console.log('data[0].attributes:');
                for (const [k, v] of Object.entries(first.attributes)) console.log(`  ${k}: ${describe(v)}`);
            }
        }
    } else if (body?.data && typeof body.data === 'object') {
        console.log(`data keys: ${Object.keys(body.data).join(', ')}`);
    }
    if (Array.isArray(body?.included)) {
        const types = body.included.reduce((acc, item) => ((acc[item.type] = (acc[item.type] || 0) + 1), acc), {});
        const summary = Object.entries(types)
            .map(([t, n]) => `${t}×${n}`)
            .join(', ');
        console.log(`included: array[${body.included.length}] (types: ${summary})`);
    }

    console.log('\n--- full JSON ---');
    console.log(JSON.stringify(body, undefined, 1));
})().catch((e) => {
    console.error('PROBE FAILED:', e.message);
    process.exit(1);
});
