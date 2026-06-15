// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// StigaAPIOptimisePerimeters — geometry optimisations for the cloud perimeter model.
//
// Home for any/all perimeter optimisations. Two layers:
//   - pure geometry helpers that take a plain point list (a closed polygon, or an open line) — reduceCollinear
//   - perimeter-level helpers that apply an optimisation across a loaded StigaAPIPerimeters model via
//     wire-surgery on the data_points protobuf blob, MUTATING the model in place and returning a report.
//
// Optimisations never write. The caller (stiga-command) owns loading and committing: it inspects the report,
// and only on an explicit commit calls perimeters.write() (and, separately, a cloudsync to reach the robot).
//
// data_points layout (see StigaAPIPerimeters): field 1 = zones, 2 = paths, 3 = obstacles; each entry has
// [1]=id and repeated [2] point sub-messages { 1:x, 2:y } as zigzag-cm offsets from the entry anchor.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { protobufDecode, protobufScan, protobufField, protobufEncode } = require('./StigaAPIUtilitiesProtobuf');

const REDUCE_DEFAULT_EPSILON_CM = 1; // a vertex within this of the line through its neighbours is redundant

function _zigzagDecode(n) {
    return (n >>> 1) ^ -(n & 1);
}
function _distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax,
        dy = by - ay,
        l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---- pure geometry -----------------------------------------------------------------------------------------
// Greedily remove vertices that sit within `epsilon` of the segment between their two neighbours (i.e. add no
// shape). `closed` = polygon (wrap-around); otherwise an open line (endpoints fixed). points: [{x,y}] in any
// consistent unit (epsilon in the same unit). Returns { removed: Set<originalIndex>, kept }. Index 0 is never
// removed — for perimeter geometry it is the anchor-coincident vertex. Because a collinear vertex contributes
// nothing to the shoelace area, removing these is lossless: the boundary and the enclosed area are unchanged.
function reduceCollinear(points, { closed = true, epsilon = REDUCE_DEFAULT_EPSILON_CM } = {}) {
    const removed = new Set();
    if (!Array.isArray(points) || points.length < (closed ? 4 : 3)) return { removed, kept: points?.length ?? 0 };
    const work = points.map((p, i) => ({ x: p.x, y: p.y, i }));
    let changed = true;
    while (changed && work.length > (closed ? 4 : 3)) {
        changed = false;
        const n = work.length;
        const hi = closed ? n : n - 1;
        for (let k = 1; k < hi; k++) {
            const b = work[k];
            if (b.i === 0) continue; // keep the anchor vertex
            const a = work[(k - 1 + n) % n],
                c = work[(k + 1) % n];
            if (_distToSegment(b.x, b.y, a.x, a.y, c.x, c.y) <= epsilon) {
                removed.add(b.i);
                work.splice(k, 1);
                changed = true;
                break;
            }
        }
    }
    return { removed, kept: points.length - removed.size };
}

// ---- wire-surgery on the data_points blob ------------------------------------------------------------------
// Ordered cm points of one entry sub-message (each [2] field is a point { 1:x, 2:y } zigzag-cm).
function _entryPoints(entryBuf) {
    const pts = [];
    for (const f of protobufScan(entryBuf)) {
        if (f.field !== 2) continue;
        let d;
        try {
            d = protobufDecode(Buffer.from(entryBuf.subarray(f.valStart, f.valEnd)));
        } catch {
            d = {};
        }
        pts.push({ x: _zigzagDecode(d[1] || 0), y: _zigzagDecode(d[2] || 0) });
    }
    return pts;
}
// New entry buffer with the [2] point fields at `removeSet` indices spliced out — every other byte verbatim.
function _deletePointsFromEntry(entryBuf, removeSet) {
    const parts = [];
    let pointIndex = 0;
    for (const f of protobufScan(entryBuf)) {
        if (f.field === 2) {
            const drop = removeSet.has(pointIndex);
            pointIndex++;
            if (drop) continue;
        }
        parts.push(entryBuf.subarray(f.tagStart, f.valEnd));
    }
    return Buffer.concat(parts);
}
function _zigzagEncode(n) {
    return n >= 0 ? 2 * n : -2 * n - 1;
}
// One [2] point field (tag + length + value), zero coords omitted to match the robot's encoding (x=0 -> no
// field 1, y=0 -> no field 2; an all-zero point is the empty anchor sub-message {}).
function _pointField(xCm, yCm) {
    const value = protobufEncode({ 1: _zigzagEncode(xCm) || undefined, 2: _zigzagEncode(yCm) || undefined });
    return protobufField(2, 2, value);
}
// New entry buffer with its [2] points REPLACED by pointList [{x,y}] (used by move/smooth — same count). The
// points are contiguous, so the new block is injected at the first [2] position and the originals dropped;
// every non-point field (id, name, anchor, settings) passes through verbatim. Each point is re-encoded with
// standard proto3 zero-omission, which is FUNCTIONALLY faithful (decodes to identical geometry — the decoder
// coerces a missing field to 0). It is byte-identical for ~99% of points; the robot's encoder occasionally
// emits an explicit zero (it's inconsistent), which we normalise away — harmless. Non-targeted entries are
// untouched (their original bytes pass through), so only points we actually move are ever re-encoded.
function _replacePointsInEntry(entryBuf, pointList) {
    const parts = [];
    let injected = false;
    for (const f of protobufScan(entryBuf)) {
        if (f.field === 2) {
            if (!injected) {
                for (const pt of pointList) parts.push(_pointField(pt.x, pt.y));
                injected = true;
            }
            continue;
        }
        parts.push(entryBuf.subarray(f.tagStart, f.valEnd));
    }
    return Buffer.concat(parts);
}

const _FIELD_FOR_TYPE = { zone: 1, obstacle: 3, path: 2, docking: 2 };
// data_points top-level field -> element type. Field 2 is paths; the connect/docking split comes from the model.
function _entryTypeFor(field, isDocking) {
    if (field === 1) return 'zone';
    if (field === 3) return 'obstacle';
    if (field === 2) return isDocking ? 'docking' : 'path';
    return undefined;
}
// Resolve the requested types. No type → zones + obstacles + connect-paths (docking is excluded by default, as
// it is a special case the robot is sensitive to — request it explicitly with type 'docking').
function _resolveTypes(type) {
    if (!type) return ['zone', 'obstacle', 'path'];
    const t = String(type).toLowerCase().replace(/s$/, '');
    if (['zone', 'obstacle', 'path', 'docking'].includes(t)) return [t];
    throw new Error(`unknown optimise target '${type}' (zone|obstacle|path|docking)`);
}

function _polygonAreaCm2(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        a += points[i].x * points[j].y - points[j].x * points[i].y;
    }
    return Math.abs(a) / 2;
}

// Reduce (collinear-remove) the geometry of a loaded StigaAPIPerimeters model. MUTATES the model's raw
// data_points + preview.numPoints in place (so the caller can write() it); does NOT write. The caller owns
// loading and committing — it just inspects the returned package and writes only on an explicit commit.
//
// `type` limits to one of zone|obstacle|path|docking (undefined = zones+obstacles+connect-paths; docking is
// excluded by default — request it explicitly). `id` limits to a single element. Paths are split into connect
// ('path') vs 'docking' via the model's docking-path ids.
//
// Returns a self-describing results package so neither the CLI nor a future front-end recomputes anything:
//   {
//     operation: 'reduce', epsilon,
//     totals: { removed, numPointsBefore, numPointsAfter, bytesBefore, bytesAfter, areaDeltaM2 },
//     byType: { zone: { elements, removed }, ... },          // only types that were examined
//     changes: [ { type, id, before, after, removed, removedIndices, areaDeltaM2 } ],   // per examined element
//   }
// areaDeltaM2 is the (small, signed) shape impact — exactly 0 at epsilon 0, sub-cm² at epsilon 1cm.
function reducePerimeter(perimeters, { type, id, epsilon = REDUCE_DEFAULT_EPSILON_CM } = {}) {
    const raw = perimeters.getRawData();
    if (!raw?.attributes?.data_points?.data) throw new Error('no perimeter loaded');
    const wantTypes = new Set(_resolveTypes(type));
    const dockingIds = new Set((perimeters.getDockingPaths?.() || []).map((p) => p.getId()));
    const targetId = id === undefined || id === null ? undefined : Number(id);
    const numPointsBefore = raw.attributes.preview?.numPoints;

    const dataBuf = Buffer.from(raw.attributes.data_points.data);
    const parts = [];
    const changes = [];
    for (const f of protobufScan(dataBuf)) {
        const entryBuf = Buffer.from(dataBuf.subarray(f.valStart, f.valEnd));
        let entryId;
        try {
            entryId = protobufDecode(entryBuf)[1];
        } catch {
            entryId = undefined;
        }
        const entryType = _entryTypeFor(f.field, dockingIds.has(entryId));
        const targeted = entryType && wantTypes.has(entryType) && (targetId === undefined || targetId === entryId);
        if (targeted) {
            const pts = _entryPoints(entryBuf);
            const closed = entryType === 'zone' || entryType === 'obstacle';
            const { removed } = reduceCollinear(pts, { closed, epsilon });
            const kept = pts.filter((_, k) => !removed.has(k));
            const areaDeltaM2 = closed ? (_polygonAreaCm2(kept) - _polygonAreaCm2(pts)) / 10_000 : 0;
            changes.push({ type: entryType, id: entryId, before: pts.length, after: kept.length, removed: removed.size, removedIndices: [...removed].sort((a, b) => a - b), areaDeltaM2 });
            if (removed.size > 0) {
                parts.push(protobufField(f.field, 2, _deletePointsFromEntry(entryBuf, removed)));
                continue;
            }
        }
        parts.push(dataBuf.subarray(f.tagStart, f.valEnd));
    }

    const optimisedData = Buffer.concat(parts);
    const removed = changes.reduce((a, c) => a + c.removed, 0);
    if (removed > 0) {
        raw.attributes.data_points.data = [...optimisedData]; // mutate the model; write() restamps checksums
        _applyNumPointsToPreview(raw.attributes.preview, changes);
    }
    const byType = {};
    for (const c of changes) {
        byType[c.type] = byType[c.type] || { elements: 0, removed: 0 };
        byType[c.type].elements++;
        byType[c.type].removed += c.removed;
    }
    return {
        operation: 'reduce',
        epsilon,
        totals: { removed, numPointsBefore, numPointsAfter: raw.attributes.preview?.numPoints, bytesBefore: dataBuf.length, bytesAfter: optimisedData.length, areaDeltaM2: changes.reduce((a, c) => a + c.areaDeltaM2, 0) },
        byType,
        changes,
    };
}

// Keep the app-facing preview counts honest after a reduce (the robot recomputes everything on adoption, but a
// stale count would mis-display until then). Decrement the per-element numPoints (matched by id within its
// category) and the grand total.
const _PREVIEW_CATEGORY = { zone: 'zones', obstacle: 'obstacles', path: 'connectPaths', docking: 'dockingPaths' };
function _applyNumPointsToPreview(preview, report) {
    if (!preview) return;
    for (const r of report) {
        if (r.removed === 0) continue;
        const elements = preview[_PREVIEW_CATEGORY[r.type]]?.elements;
        const el = Array.isArray(elements) ? elements.find((e) => e.id === r.id) : undefined;
        if (el && typeof el.numPoints === 'number') el.numPoints -= r.removed;
    }
    const total = report.reduce((a, r) => a + r.removed, 0);
    if (typeof preview.numPoints === 'number') preview.numPoints -= total;
}

// ---- pure geometry: smoothing -------------------------------------------------------------------------------
const SMOOTH_DEFAULT_ITERATIONS = 2;
const SMOOTH_DEFAULT_STRENGTH = 0.5;

// Laplacian corner-cutting: each pass nudges every point toward the midpoint of its neighbours by `strength`,
// rounding sharp corners while keeping the point count. `closed` smooths every vertex (polygon); otherwise the
// endpoints are pinned (an open line — e.g. a connector path docks into its zones and must not move there).
// NO boundary/guard awareness — it can move points across borders; that's intentional for now (the future
// front-end will show the result before commit). points: [{x,y}]. Returns new [{x,y}] (same length).
function smoothLine(points, { closed = false, iterations = SMOOTH_DEFAULT_ITERATIONS, strength = SMOOTH_DEFAULT_STRENGTH } = {}) {
    if (!Array.isArray(points) || points.length < 3) return (points || []).map((p) => ({ x: p.x, y: p.y }));
    let p = points.map((q) => ({ x: q.x, y: q.y }));
    for (let it = 0; it < iterations; it++) {
        const n = p.length;
        const lo = closed ? 0 : 1,
            hi = closed ? n : n - 1;
        const next = p.map((q) => ({ x: q.x, y: q.y }));
        for (let i = lo; i < hi; i++) {
            const a = p[(i - 1 + n) % n],
                b = p[i],
                c = p[(i + 1) % n];
            next[i] = { x: b.x + strength * ((a.x + c.x) / 2 - b.x), y: b.y + strength * ((a.y + c.y) / 2 - b.y) };
        }
        p = next;
    }
    return p;
}

// Smooth perimeter geometry — applies the move-point wire-surgery and MUTATES the model's data_points in place
// (point count, and so preview.numPoints, are unchanged); does NOT write. The caller commits explicitly. NO
// boundary/guard awareness — it can move points across borders (intentional for now; the front-end will show
// the result before commit). `type` limits to zone|obstacle|path|docking (undefined = zones+obstacles+paths).
// Returns:
//   { operation:'smooth', iterations, strength,
//     totals: { elements, moved, bytesBefore, bytesAfter },
//     byType: { path: { elements, maxMoveCm }, ... },
//     changes: [{ type, id, points, avgMoveCm, maxMoveCm, smoothed:[{x,y}] }] }
function smoothPerimeter(perimeters, { type, id, iterations = SMOOTH_DEFAULT_ITERATIONS, strength = SMOOTH_DEFAULT_STRENGTH } = {}) {
    const raw = perimeters.getRawData();
    if (!raw?.attributes?.data_points?.data) throw new Error('no perimeter loaded');
    const wantTypes = new Set(_resolveTypes(type));
    const dockingIds = new Set((perimeters.getDockingPaths?.() || []).map((p) => p.getId()));
    const targetId = id === undefined || id === null ? undefined : Number(id);

    const dataBuf = Buffer.from(raw.attributes.data_points.data);
    const parts = [];
    const changes = [];
    for (const f of protobufScan(dataBuf)) {
        const entryBuf = Buffer.from(dataBuf.subarray(f.valStart, f.valEnd));
        let entryId;
        try {
            entryId = protobufDecode(entryBuf)[1];
        } catch {
            entryId = undefined;
        }
        const entryType = _entryTypeFor(f.field, dockingIds.has(entryId));
        const targeted = entryType && wantTypes.has(entryType) && (targetId === undefined || targetId === entryId);
        if (targeted) {
            const pts = _entryPoints(entryBuf);
            const closed = entryType === 'zone' || entryType === 'obstacle';
            const smoothed = smoothLine(pts, { closed, iterations, strength }).map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
            let sum = 0,
                max = 0;
            for (const [i, pt] of pts.entries()) {
                const d = Math.hypot(smoothed[i].x - pt.x, smoothed[i].y - pt.y);
                sum += d;
                if (d > max) max = d;
            }
            changes.push({ type: entryType, id: entryId, points: pts.length, avgMoveCm: pts.length > 0 ? sum / pts.length : 0, maxMoveCm: max, smoothed });
            parts.push(protobufField(f.field, 2, _replacePointsInEntry(entryBuf, smoothed))); // re-encode (identical bytes if unmoved)
            continue;
        }
        parts.push(dataBuf.subarray(f.tagStart, f.valEnd));
    }

    const optimisedData = Buffer.concat(parts);
    const moved = changes.filter((c) => c.maxMoveCm > 0).length;
    if (moved > 0) raw.attributes.data_points.data = [...optimisedData]; // mutate the model; write() restamps checksums
    const byType = {};
    for (const c of changes) {
        byType[c.type] = byType[c.type] || { elements: 0, maxMoveCm: 0 };
        byType[c.type].elements++;
        byType[c.type].maxMoveCm = Math.max(byType[c.type].maxMoveCm, c.maxMoveCm);
    }
    return { operation: 'smooth', iterations, strength, totals: { elements: changes.length, moved, bytesBefore: dataBuf.length, bytesAfter: optimisedData.length }, byType, changes };
}

module.exports = { reduceCollinear, reducePerimeter, smoothLine, smoothPerimeter, REDUCE_DEFAULT_EPSILON_CM, SMOOTH_DEFAULT_ITERATIONS, SMOOTH_DEFAULT_STRENGTH };
