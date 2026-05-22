#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// stiga-probe-perimeter-points.js
//
// Reads data/perimeters-dump.json (from stiga-probe-perimeters.js), protobuf-decodes the
// attributes.data_points.data byte blob, reconstructs the zone/obstacle/path polygons, and
// verifies the decode by comparing each decoded polygon area to the Cloud-reported m2Area.
// Writes data/perimeters.geojson so the result can be eyeballed on any map.
//
// Encoding (reverse-engineered):
//   blob field 1 = zones, field 2 = paths, field 3 = obstacles, field 5 = ECEF of reference.
//   each entry: [1]=id, [2]=points[], [15]=name, anchor doubles at [16] (zone) / [8] (path) / [6] (obstacle).
//   anchor = { [1]: eastMetres, [2]: northMetres } offset from referencePosition.
//   point  = { [1]: x, [2]: y } zigzag-encoded signed centimetres, ABSOLUTE offset from the anchor
//            (zero fields omitted; first point {} = the anchor itself).
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { StigaAPIUtilities } = require('../api/StigaAPI');
const { protobufDecode } = StigaAPIUtilities;

const dump = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'perimeters-dump.json'), 'utf8'));
const decoded = protobufDecode(Buffer.from(dump.attributes.data_points.data));
const ref = dump.attributes.preview.referencePosition;
const previewZones = dump.attributes.preview.zones?.elements ?? [];
const previewObstacles = dump.attributes.preview.obstacles?.elements ?? [];

const dbl = (hex) => Buffer.from(hex, 'hex').readDoubleLE(0);
const zz = (n) => (n >>> 1) ^ -(n & 1); // zigzag decode
const mPerDegLat = 111320;
const mPerDegLon = 111320 * Math.cos((ref.lat * Math.PI) / 180);

// decode one entry (zone / obstacle / path) into a polygon of absolute lat/lng
function polygon(entry) {
    const anchorField = entry[16] || entry[8] || entry[6];
    const anchorE = dbl(anchorField[1]);
    const anchorN = dbl(anchorField[2]);
    const pts = Array.isArray(entry[2]) ? entry[2] : [entry[2]];
    return pts.map((p) => {
        const o = p && typeof p === 'object' ? p : {};
        const eastM = anchorE + zz(o[1] || 0) / 100;
        const northM = anchorN + zz(o[2] || 0) / 100;
        return {
            eastM,
            northM,
            latitude: ref.lat + northM / mPerDegLat,
            longitude: ref.lng + eastM / mPerDegLon,
        };
    });
}

// shoelace area (m²) on local east/north metres
function area(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
        const j = (i + 1) % poly.length;
        a += poly[i].eastM * poly[j].northM - poly[j].eastM * poly[i].northM;
    }
    return Math.abs(a) / 2;
}

console.log(`referencePosition: ${ref.lat}, ${ref.lng}`);
const ecef = Object.values(decoded[5]).map((h) => dbl(h).toFixed(1)).join(', ');
console.log(`ECEF reference (field 5): ${ecef}\n`);

const features = [];

console.log('=== ZONES (decoded area vs Cloud m2Area) ===');
decoded[1].forEach((zone, i) => {
    const poly = polygon(zone);
    const decodedArea = area(poly);
    const cloud = previewZones[i]?.m2Area ?? 0;
    const err = cloud ? (((decodedArea - cloud) / cloud) * 100).toFixed(1) : '?';
    console.log(`  zone id=${zone[1]} "${zone[15]}"  points=${poly.length}  decoded=${decodedArea.toFixed(1)}m²  cloud=${cloud}m²  err=${err}%`);
    features.push({
        type: 'Feature',
        properties: { kind: 'zone', id: zone[1], name: zone[15], area: cloud },
        geometry: { type: 'Polygon', coordinates: [[...poly, poly[0]].map((p) => [p.longitude, p.latitude])] },
    });
});

console.log('\n=== OBSTACLES (decoded area vs Cloud m2Area) ===');
let obstacleErrSum = 0;
decoded[3].forEach((obstacle, i) => {
    const poly = polygon(obstacle);
    const decodedArea = area(poly);
    const cloud = previewObstacles[i]?.m2Area ?? 0;
    if (cloud) obstacleErrSum += Math.abs((decodedArea - cloud) / cloud);
    if (i < 5) console.log(`  obstacle id=${obstacle[1]}  points=${poly.length}  decoded=${decodedArea.toFixed(2)}m²  cloud=${cloud}m²`);
    features.push({
        type: 'Feature',
        properties: { kind: 'obstacle', id: obstacle[1], area: cloud },
        geometry: { type: 'Polygon', coordinates: [[...poly, poly[0]].map((p) => [p.longitude, p.latitude])] },
    });
});
console.log(`  ... ${decoded[3].length} obstacles total, mean area error ${((obstacleErrSum / decoded[3].length) * 100).toFixed(1)}%`);

console.log('\n=== PATHS ===');
decoded[2].forEach((p) => {
    const poly = polygon(p);
    console.log(`  path id=${p[1]}  zone${p[6]}->zone${p[7]}  points=${poly.length}`);
    features.push({
        type: 'Feature',
        properties: { kind: 'path', id: p[1], fromZone: p[6], toZone: p[7] },
        geometry: { type: 'LineString', coordinates: poly.map((pt) => [pt.longitude, pt.latitude]) },
    });
});

const geojsonPath = path.join(__dirname, '..', 'data', 'perimeters.geojson');
fs.writeFileSync(geojsonPath, JSON.stringify({ type: 'FeatureCollection', features }, undefined, 1));
console.log(`\nGeoJSON written to ${geojsonPath} — open in geojson.io / Google My Maps to eyeball the garden shape.`);
const sample = polygon(decoded[1][0])
    .slice(0, 3)
    .map((p) => p.latitude.toFixed(7) + ',' + p.longitude.toFixed(7))
    .join('  ');
console.log(`zone[0] first 3 points (lat,lng): ${sample}`);
