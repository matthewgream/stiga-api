#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// stiga-verify-position.js
//
// Ground-truth verification of robot positioning. Decodes recent LOG/ROBOT_POSITION and
// LOG/STATUS messages from the capture DB and:
//   - converts each ROBOT_POSITION fix to an absolute lat/lon and (optionally) reports the
//     deviation from a known ground-truth pin;
//   - shows the STATUS location field as the RTK quality figure it actually is — it is NOT
//     the robot's position (see decodeLocationStatus in StigaAPIElements.js).
//
// Usage:
//   scripts/stiga-verify-position.js [--truth <lat>,<lon>] [--db <path>] [--n <count>]
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const path = require('path');
const Database = require('better-sqlite3');
const { StigaAPIUtilities, StigaAPIConfig, StigaAPIElements } = require('../api/StigaAPI');

const { protobufDecode } = StigaAPIUtilities;
const { decodeRobotPosition, decodeLocationStatus } = StigaAPIElements;

const ROBOT_MAC = 'D0:EF:76:64:32:BA';

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function parseArgs() {
    const argv = process.argv.slice(2);
    const valueOf = (flag) => {
        const idx = argv.indexOf(flag);
        return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
    };
    const opts = { db: path.join(__dirname, '..', 'data', 'capture.db'), n: 10, truth: undefined };
    const truthArg = valueOf('--truth');
    if (truthArg) opts.truth = truthArg.split(',').map((s) => Number.parseFloat(s.trim()));
    const dbArg = valueOf('--db');
    if (dbArg) opts.db = dbArg;
    const nArg = valueOf('--n');
    if (nArg) opts.n = Number.parseInt(nArg);
    return opts;
}

// flat-earth distance/bearing between two lat/lon points (fine for garden-scale)
function vectorBetween(from, to) {
    const dNorth = (to.latitude - from.latitude) * 111320;
    const dEast = (to.longitude - from.longitude) * 111320 * Math.cos((from.latitude * Math.PI) / 180);
    const compass = (Math.atan2(dEast, dNorth) * 180) / Math.PI;
    return { dNorth, dEast, distance: Math.hypot(dNorth, dEast), compass: (compass + 360) % 360 };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const opts = parseArgs();
const ref = StigaAPIConfig.load().referencePosition;
if (!ref?.latitude || !ref?.longitude) throw new Error('referencePosition not set in stiga-config.js');
const reference = { latitude: ref.latitude, longitude: ref.longitude };
const truth = opts.truth?.length === 2 ? { latitude: opts.truth[0], longitude: opts.truth[1] } : undefined;

console.log('='.repeat(100));
console.log(`DB:        ${opts.db}`);
console.log(`Reference: ${reference.latitude}, ${reference.longitude}  (base station, from stiga-config.js)`);
if (truth) console.log(`Truth pin: ${truth.latitude}, ${truth.longitude}  (supplied via --truth)`);
console.log('='.repeat(100));

const db = new Database(opts.db, { readonly: true, fileMustExist: true });
db.pragma('journal_mode = WAL');

const latest = (topicLike, n) => db.prepare(`SELECT timestamp, data FROM messages WHERE topic LIKE ? ORDER BY timestamp DESC LIMIT ?`).all(topicLike, n).reverse();

// ---- LOG/ROBOT_POSITION — the robot's actual RTK fix (offsets in metres) -------------------------------------------------------------------------------------
console.log(`\n### LOG/ROBOT_POSITION  (latest ${opts.n}) — the robot's actual location\n`);
for (const row of latest(`${ROBOT_MAC}/LOG/ROBOT_POSITION`, opts.n)) {
    const p = decodeRobotPosition(protobufDecode(row.data), reference);
    const deviation = truth ? `  ->  ${vectorBetween({ latitude: p.latitude, longitude: p.longitude }, truth).distance.toFixed(2)} m from truth` : '';
    console.log(
        `${row.timestamp}  dist=${p.offsetDistanceMetres.toFixed(2)}m  bearing=${p.offsetCompass.toFixed(0)}°  ` +
            `heading=${p.orientationCompass === undefined ? '-' : p.orientationCompass.toFixed(0) + '°'}  ` +
            `lat/lon=${p.latitude?.toFixed(7)},${p.longitude?.toFixed(7)}${deviation}`
    );
}

// ---- LOG/STATUS location field — RTK quality, NOT a position -------------------------------------------------------------------------------------------------
console.log(`\n### LOG/STATUS location field  (latest ${opts.n}) — RTK quality, not the robot's position\n`);
let shown = 0;
for (const row of latest(`${ROBOT_MAC}/LOG/STATUS`, opts.n * 4)) {
    if (shown >= opts.n) break;
    const decoded = protobufDecode(row.data);
    const loc = decoded[19] ? decodeLocationStatus(decoded[19]) : undefined;
    if (!loc) continue;
    shown++;
    const coverage = ['GOOD', 'POOR', 'BAD', 'WORSE'][loc.coverage] ?? loc.coverage;
    console.log(`${row.timestamp}  satellites=${loc.satellites}  coverage=${coverage}  rtkOffset=${loc.offsetDistance.toFixed(1)}cm  rtkQuality=${loc.rtkQuality ?? '-'}`);
}
console.log(`(rtkOffset stays ~constant regardless of where the robot is — confirming it is a quality figure, not a location.)`);

// ---- geometry check ------------------------------------------------------------------------------------------------------------------------------------------
if (truth) {
    const v = vectorBetween(reference, truth);
    console.log(`\n### Geometry check`);
    console.log(`Truth pin vs base reference:  ${v.distance.toFixed(2)} m @ ${v.compass.toFixed(0)}°  (${v.dNorth.toFixed(1)} m N, ${v.dEast.toFixed(1)} m E)`);
    console.log(`The latest ROBOT_POSITION dist/bearing above should match this.`);
}

db.close();
console.log('\n' + '='.repeat(100));
