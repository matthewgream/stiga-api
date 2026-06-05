#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// stiga-probe-perimeter-write.js
//
// Writes a perimeter back to the Stiga Cloud. Reconstructs a perimeter from a saved dump (default
// data/perimeters-before.json), bumps timestamp+checksum to "now" so the write supersedes whatever
// the cloud currently holds, and PATCHes it. DRY-RUNS by default; nothing is transmitted unless
// --send is passed.
//
// CAVEAT (observed 2026-06-04): the PATCH returns 204 and the cloud briefly serves our blob, but it
// does NOT durably stick — the ROBOT owns the authoritative map and re-publishes its own copy to the
// cloud minutes later (identifiable by data_points.user_agent = "Stig-A.<ROBOT_MAC>" and a small
// integer checksum), overwriting our write. Changing a perimeter for real needs the robot's copy to
// change (likely via MQTT), not just this cloud REST write.
//
// Write protocol (reverse engineered by iterating on the server's JSON-schema validation errors):
//   PATCH https://connectivity-production.stiga.com/api/perimeters/{attributes.uuid}
//   body:   { data: <attributes> }              (NOT the JSON:API {type,attributes} wrapper)
//   where <attributes> is the GET-read attributes object with all null-valued top-level fields
//   removed (base_position, drawn_data_points, user_uuid, store_uuid), and preview + data_points
//   each carrying a refreshed checksum = String(epoch-ms). Success = 204 No Content. The server
//   honours the checksum we send but assigns its own preview.timestamp on receipt.
//   (GET /api/perimeters?base_uuid&device_uuid is the read path; PUT/PATCH there is a 404.)
//
// Usage:
//   node scripts/stiga-probe-perimeter-write.js [options]
//     --source <file>      dump to write back (default: data/perimeters-before.json)
//     --method <VERB>      PUT | POST | PATCH (default: PUT)
//     --envelope <kind>    data | attributes | bare (default: data)
//                            data       -> { data: { type:'perimeters', attributes } }
//                            attributes -> { attributes }
//                            bare       -> attributes
//     --endpoint <path>    override request path (default: /api/perimeters?base_uuid&device_uuid)
//     --send               actually transmit (omit = dry run, prints request only)
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { StigaAPIAuthentication, StigaAPIConfig } = require('../api/StigaAPI');

const BASE_URL = 'https://connectivity-production.stiga.com';

function parseArgs(argv) {
    // defaults = the write protocol discovered by reverse engineering (see header):
    //   PATCH /api/perimeters/{uuid}  with body { data: <attributes> }
    const opts = { source: 'data/perimeters-before.json', method: 'PATCH', envelope: 'data-flat', endpoint: undefined, send: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--send') opts.send = true;
        else if (a === '--source') opts.source = argv[++i];
        else if (a === '--method') opts.method = argv[++i].toUpperCase();
        else if (a === '--envelope') opts.envelope = argv[++i];
        else if (a === '--endpoint') opts.endpoint = argv[++i];
        else throw new Error(`unknown arg: ${a}`);
    }
    return opts;
}

function buildAttributes(dump) {
    // start from the full read-back attributes, refresh timestamps/checksum so the write wins
    const attributes = JSON.parse(JSON.stringify(dump.attributes));
    const now = Date.now();
    const stamp = (obj) => {
        if (!obj) return;
        obj.timestamp = now;
        obj.checksum = String(now); // checksum is the string form of the epoch-ms timestamp
    };
    stamp(attributes.preview);
    stamp(attributes.data_points);
    // the write schema rejects null-valued fields that it expects to be objects (e.g. base_position);
    // drop any top-level attribute that read back as null
    for (const key of Object.keys(attributes)) if (attributes[key] === null) delete attributes[key];
    return { attributes, now };
}

function buildBody(attributes, envelope) {
    if (envelope === 'data') return { data: { type: 'perimeters', attributes } };
    if (envelope === 'attributes') return { attributes };
    if (envelope === 'bare') return attributes;
    // 'split': the server wants top-level `data` AND `data_points` as siblings
    if (envelope === 'split') return { data: { type: 'perimeters', attributes }, data_points: attributes.data_points };
    // 'data-flat': attributes placed directly under `data` (so data.data_points exists, no type/attributes wrapper)
    if (envelope === 'data-flat') return { data: attributes };
    throw new Error(`unknown envelope: ${envelope}`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { username, password } = StigaAPIConfig.load();

    const sourcePath = path.isAbsolute(opts.source) ? opts.source : path.join(__dirname, '..', opts.source);
    const dump = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));

    const endpoint = opts.endpoint || `/api/perimeters/${dump.attributes.uuid}`;
    const url = BASE_URL + endpoint;

    const { attributes, now } = buildAttributes(dump);
    const body = buildBody(attributes, opts.envelope);
    const bodyStr = JSON.stringify(body);

    console.log('=== PERIMETER WRITE (experimental) ===');
    console.log(`source:    ${opts.source}`);
    console.log(`method:    ${opts.method}`);
    console.log(`url:       ${url}`);
    console.log(`envelope:  ${opts.envelope}  (top-level keys: ${Object.keys(body).join(', ')})`);
    console.log(`timestamp: ${now}  (${new Date(now).toISOString()})  checksum="${String(now)}"`);
    console.log(`blob bytes:${dump.attributes.data_points.data.length}  body bytes:${bodyStr.length}`);

    const auth = new StigaAPIAuthentication(username, password);
    if (!(await auth.isValid())) throw new Error('authentication failed');

    if (!opts.send) {
        console.log('\n[DRY RUN] not transmitting. Re-run with --send to actually write.');
        return;
    }

    const requestOptions = { method: opts.method, headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: bodyStr };
    await auth.addAuthentication(requestOptions);
    console.log('\n>>> SENDING ...');
    const response = await fetch(url, requestOptions);
    console.log(`<<< status: ${response.status} ${response.statusText}`);
    const text = await response.text();
    console.log(`<<< body (first 1000 chars):\n${text.slice(0, 1000)}`);
}

main().catch((e) => {
    console.error('WRITE PROBE FAILED:', e.message);
    process.exit(1);
});
