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

const { protobufDecode, protobufScan, protobufField, protobufEncode, protobufSetFields } = require('./StigaAPIUtilitiesProtobuf');

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
// A ring is STORED with its first vertex repeated as its last; that trailing duplicate is a closure marker, not
// a vertex. Every closed-mode routine here must exclude it from the geometry it operates on: it is an ENDPOINT
// of the segment through its own neighbours (so any collinearity test scores it 0 and deletes it), and it must
// track whatever happens to vertex 0 (so any smoothing that treats it as independent tears the ring open at the
// seam). Both mistakes were live bugs — see the reduceCollinear/smoothLine notes below.
function _hasClosingDuplicate(points) {
    return points.length > 1 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y;
}
const _MIN_RING_VERTICES = 3; // a polygon needs three; an open line keeps both endpoints plus something between

// Greedily remove vertices that sit within `epsilon` of the segment between their two neighbours (i.e. add no
// shape). `closed` = polygon (wrap-around); otherwise an open line (endpoints fixed). points: [{x,y}] in any
// consistent unit (epsilon in the same unit). Returns { removed: Set<originalIndex>, kept }. Because a collinear
// vertex contributes nothing to the shoelace area, removing these is lossless: the boundary and the enclosed
// area are unchanged.
//
// A closed ring's trailing closure marker is never a candidate (it would always score 0 — see above; until
// 2026-07-17 it was a candidate, and it was the ONLY thing this ever removed on a real map: 28 of 28 "removals"
// across the garden were closure markers, unclosing every ring while reporting a saving). Index 0 is likewise
// never removed: the closure marker is a copy of it, so dropping it would leave the ring's last vertex no longer
// matching its first.
function reduceCollinear(points, { closed = true, epsilon = REDUCE_DEFAULT_EPSILON_CM } = {}) {
    const removed = new Set();
    if (!Array.isArray(points)) return { removed, kept: 0 };
    const vertices = closed && _hasClosingDuplicate(points) ? points.slice(0, -1) : points;
    if (vertices.length < _MIN_RING_VERTICES) return { removed, kept: points.length };
    const work = vertices.map((p, i) => ({ x: p.x, y: p.y, i }));
    let changed = true;
    while (changed && work.length > _MIN_RING_VERTICES) {
        changed = false;
        const n = work.length;
        const hi = closed ? n : n - 1;
        for (let k = 1; k < hi; k++) {
            const b = work[k];
            if (b.i === 0) continue; // keep vertex 0 — the closure marker is a copy of it
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
//
// A closed ring is smoothed over its DISTINCT vertices and re-closed afterwards. Until 2026-07-17 the trailing
// closure marker was smoothed as if it were an independent vertex, which both gave vertex 0 and the marker the
// wrong neighbours (each saw the other instead of the true adjacent vertex) and let them drift apart — tearing
// a test ring open by 23cm at the seam.
function smoothLine(points, { closed = false, iterations = SMOOTH_DEFAULT_ITERATIONS, strength = SMOOTH_DEFAULT_STRENGTH } = {}) {
    if (!Array.isArray(points)) return [];
    const closing = closed && _hasClosingDuplicate(points);
    const vertices = closing ? points.slice(0, -1) : points;
    if (vertices.length < _MIN_RING_VERTICES) return points.map((q) => ({ x: q.x, y: q.y }));
    let p = vertices.map((q) => ({ x: q.x, y: q.y }));
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
    if (closing) p.push({ ...p[0] }); // re-close on the smoothed vertex 0, keeping the caller's point count
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

// ---- pure geometry: shape fitting ---------------------------------------------------------------------------
// Regularise a hand-driven trace into the ideal shape it was meant to be. Driving a mower round a tree by hand
// yields a wobbly 4-8 vertex polygon; these fits recover the underlying circle/rectangle from it.
//
// WHY LEAST SQUARES ON THE VERTICES, and not centroid+mean-radius or an area-preserving radius: a traced polygon
// is INSCRIBED in the curve it was sampled from, so its area falls short of the true disc (a 4-gon holds only
// 64% of its circle, a 6-gon 83%) — sizing by area therefore shrinks the obstacle, badly, exactly when points
// are sparse. The vertices themselves sit ON the true curve (that is where the robot actually was), so solving
// for centre and radius together lets the drive wobble average out. Verified against ground truth — the app's
// own circular obstacles (a known r=100cm 16-gon, and decimated 8/9-point copies of it): the vertex fit recovers
// r=99.5-99.7cm from as few as 8 points, while the area-equivalent radius errs by -1.6cm (16pts) to -5.6cm
// (8pts), always small. Robust/outlier-rejecting fits (Tukey IRLS) were tried and REJECTED: at 4-8 vertices
// there is no statistical basis to identify an outlier, so they reject nothing and merely perturb the fit. A bad
// trace is instead surfaced honestly through the reported residual (rms/rMin/rMax) for the caller to judge.
const CIRCLE_DEFAULT_POINTS = 16; // matches the app's own circular obstacles: a 16-gon (+ the closing vertex)
const RECT_RESAMPLE_CM = 5; // side fits are driven by boundary length, not vertex count — see fitRectangle

// A closed ring stores its first vertex again as its last; strip that to get the distinct vertices.
function _ring(points) {
    const p = points.map((q) => ({ x: q.x, y: q.y }));
    while (p.length > 1 && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y) p.pop();
    return p;
}
function _polygonSignedAreaCm2(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
        const j = (i + 1) % points.length;
        a += points[i].x * points[j].y - points[j].x * points[i].y;
    }
    return a / 2;
}
// Each vertex speaks for half of each edge it touches, so a densely-sampled arc cannot outvote a sparse one.
function _arcWeights(points) {
    const n = points.length;
    return points.map((_, i) => {
        const a = points[(i - 1 + n) % n],
            b = points[i],
            c = points[(i + 1) % n];
        return (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2;
    });
}
// Gaussian elimination with partial pivoting on a 3x3; undefined if singular.
function _solve3(A, B) {
    const M = A.map((row, i) => [...row, B[i]]);
    for (let c = 0; c < 3; c++) {
        let pivot = c;
        for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
        if (Math.abs(M[pivot][c]) < 1e-12) return undefined;
        [M[c], M[pivot]] = [M[pivot], M[c]];
        for (let r = 0; r < 3; r++) {
            if (r === c) continue;
            const f = M[r][c] / M[c][c];
            for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
        }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}
// Weighted Kasa fit: minimising the ALGEBRAIC residual (x²+y²-2ax-2by-c) is linear in (a,b,c), so this is a
// direct 3x3 solve — biased on short arcs, but a good starting point for the geometric refinement below.
function _fitCircleAlgebraic(points, weights) {
    let Sw = 0,
        Sx = 0,
        Sy = 0,
        Sxx = 0,
        Syy = 0,
        Sxy = 0,
        Sz = 0,
        Sxz = 0,
        Syz = 0;
    for (const [i, q] of points.entries()) {
        const w = weights[i],
            z = q.x * q.x + q.y * q.y;
        Sw += w;
        Sx += w * q.x;
        Sy += w * q.y;
        Sxx += w * q.x * q.x;
        Syy += w * q.y * q.y;
        Sxy += w * q.x * q.y;
        Sz += w * z;
        Sxz += w * q.x * z;
        Syz += w * q.y * z;
    }
    const s = _solve3(
        [
            [Sxx, Sxy, Sx],
            [Sxy, Syy, Sy],
            [Sx, Sy, Sw],
        ],
        [Sxz, Syz, Sz]
    );
    if (!s) return undefined;
    const cx = s[0] / 2,
        cy = s[1] / 2;
    return { cx, cy, r: Math.sqrt(Math.max(0, s[2] + cx * cx + cy * cy)) };
}
// Geometric fit: minimise the true radial residual Σw(|p-c| - r)². The stationary point of that objective is
// c = mean(p) + r·mean(unit vector from c to p), which this iterates to a fixed point (Landau's method) — each
// pass recomputes r as the weighted mean radius, then re-centres. Converges from the algebraic seed in a few
// dozen passes; the cap is only a guard against a pathological (near-collinear) input.
function _refineCircle(points, weights, init) {
    let { cx, cy } = init;
    for (let iteration = 0; iteration < 500; iteration++) {
        let Sw = 0,
            Sr = 0,
            Sux = 0,
            Suy = 0;
        for (const [i, q] of points.entries()) {
            const d = Math.hypot(q.x - cx, q.y - cy) || 1e-9;
            Sw += weights[i];
            Sr += weights[i] * d;
            Sux += (weights[i] * (q.x - cx)) / d;
            Suy += (weights[i] * (q.y - cy)) / d;
        }
        const r = Sr / Sw,
            nx = cx + r * (Sux / Sw),
            ny = cy + r * (Suy / Sw);
        const step = Math.hypot(nx - cx, ny - cy);
        cx = nx;
        cy = ny;
        if (step < 1e-9) break;
    }
    let Sw = 0,
        Sr = 0;
    for (const [i, q] of points.entries()) {
        Sw += weights[i];
        Sr += weights[i] * Math.hypot(q.x - cx, q.y - cy);
    }
    return { cx, cy, r: Sr / Sw };
}

// Best-fit circle through a polygon's vertices. points: [{x,y}] cm (closing vertex optional). Returns
// { cx, cy, r, rms, rMin, rMax, points, ccw } — rms is the radial residual (fit quality: sub-cm means the trace
// really was a circle; a large rms, or an rMin far below r, means the drive wandered and no fit can rescue it).
function fitCircle(points) {
    const p = _ring(points);
    if (p.length < 3) throw new Error(`need at least 3 distinct points to fit a circle (got ${p.length})`);
    const w = _arcWeights(p);
    const seed = _fitCircleAlgebraic(p, w) ?? { cx: p.reduce((s, q) => s + q.x, 0) / p.length, cy: p.reduce((s, q) => s + q.y, 0) / p.length };
    const { cx, cy, r } = _refineCircle(p, w, seed);
    const d = p.map((q) => Math.hypot(q.x - cx, q.y - cy));
    return {
        cx,
        cy,
        r,
        rms: Math.sqrt(d.reduce((s, x) => s + (x - r) ** 2, 0) / d.length),
        rMin: Math.min(...d),
        rMax: Math.max(...d),
        points: p.length,
        ccw: _polygonSignedAreaCm2(p) > 0,
    };
}
// Regular n-gon on the fitted circle, closed (first vertex repeated last) to match how the robot stores rings.
// `startAngle` defaults to the bearing of the original first vertex, so the new ring begins where the old one
// did (keeping it near the entry anchor); `ccw` follows the original winding.
function circlePoints({ cx, cy, r }, { count = CIRCLE_DEFAULT_POINTS, startAngle = 0, ccw = true } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const a = startAngle + ((ccw ? 1 : -1) * (2 * Math.PI * i)) / count;
        out.push({ x: Math.round(cx + r * Math.cos(a)), y: Math.round(cy + r * Math.sin(a)) });
    }
    out.push({ ...out[0] });
    return out;
}

// Andrew's monotone chain convex hull, CCW.
function _cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}
function _hullChain(points) {
    const chain = [];
    for (const q of points) {
        while (chain.length >= 2 && _cross(chain[chain.length - 2], chain[chain.length - 1], q) <= 0) chain.pop();
        chain.push(q);
    }
    chain.pop(); // the last point starts the opposite chain
    return chain;
}
function _hull(points) {
    const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    if (p.length < 3) return p;
    return [..._hullChain(p), ..._hullChain([...p].reverse())];
}
// Minimum-area enclosing rectangle (rotating calipers): the optimum always has a side flush with a hull edge, so
// test every hull edge direction. Its ORIENTATION is what we want; its extents are not (see fitRectangle).
function _minAreaRect(points) {
    const h = _hull(points);
    if (h.length < 3) return undefined;
    let best;
    for (const [i, a] of h.entries()) {
        const b = h[(i + 1) % h.length];
        const theta = Math.atan2(b.y - a.y, b.x - a.x),
            c = Math.cos(-theta),
            s = Math.sin(-theta);
        let minX = Infinity,
            maxX = -Infinity,
            minY = Infinity,
            maxY = -Infinity;
        for (const q of h) {
            const X = q.x * c - q.y * s,
                Y = q.x * s + q.y * c;
            minX = Math.min(minX, X);
            maxX = Math.max(maxX, X);
            minY = Math.min(minY, Y);
            maxY = Math.max(maxY, Y);
        }
        const area = (maxX - minX) * (maxY - minY);
        if (!best || area < best.area) best = { area, theta, minX, maxX, minY, maxY };
    }
    return best;
}
// Walk the ring emitting a point every `step` cm, so each side's fit is weighted by how much BOUNDARY faces it
// rather than by how many vertices happen to sit on it.
function _resampleRing(points, step = RECT_RESAMPLE_CM) {
    const out = [];
    for (const [i, a] of points.entries()) {
        const b = points[(i + 1) % points.length];
        const length = Math.hypot(b.x - a.x, b.y - a.y),
            n = Math.max(1, Math.round(length / step));
        for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
    return out;
}
// A side with no samples of its own keeps whatever the calipers gave it.
function _meanOr(values, fallback) {
    return values.length > 0 ? values.reduce((x, y) => x + y, 0) / values.length : fallback;
}
// Fit the four side offsets at a fixed orientation: assign every boundary sample to its nearest side, then set
// each side to the MEAN of its samples, and repeat until the assignment settles. The mean is the unbiased
// estimate of where the side truly was (drive wobble is roughly symmetric about it) — unlike the calipers, which
// must reach the worst outward wobble on each side and so inflate.
function _sideFitExtents(samples, theta, seed) {
    const c = Math.cos(-theta),
        s = Math.sin(-theta);
    const rotated = samples.map((q) => ({ X: q.x * c - q.y * s, Y: q.x * s + q.y * c }));
    let { minX, maxX, minY, maxY } = seed;
    for (let iteration = 0; iteration < 50; iteration++) {
        const bucket = { minX: [], maxX: [], minY: [], maxY: [] };
        for (const q of rotated) {
            // nearest side wins the sample; the offset it contributes is its coordinate along that side's normal
            const sides = [
                { d: q.X - minX, side: 'minX', at: q.X },
                { d: maxX - q.X, side: 'maxX', at: q.X },
                { d: q.Y - minY, side: 'minY', at: q.Y },
                { d: maxY - q.Y, side: 'maxY', at: q.Y },
            ];
            let nearest = sides[0];
            for (const s of sides) if (s.d < nearest.d) nearest = s;
            bucket[nearest.side].push(nearest.at);
        }
        const next = { minX: _meanOr(bucket.minX, minX), maxX: _meanOr(bucket.maxX, maxX), minY: _meanOr(bucket.minY, minY), maxY: _meanOr(bucket.maxY, maxY) };
        const moved = Math.abs(next.minX - minX) + Math.abs(next.maxX - maxX) + Math.abs(next.minY - minY) + Math.abs(next.maxY - maxY);
        ({ minX, maxX, minY, maxY } = next);
        if (moved < 1e-6) break;
    }
    return { minX, maxX, minY, maxY };
}

// Best-fit rectangle for a polygon. Orientation comes from the minimum-area enclosing rectangle (robust — it is
// set by the overall shape); the extents are then re-fitted per side, because the calipers' extents are biased
// outward by every wobble (measured on real traces: 27-36% too much area). Returns
// { cx, cy, a, b, theta, bearing, rectAreaCm2, polyAreaCm2, fill, points, ccw } — `a` is the LONGER side and
// `theta` runs along it; `bearing` is a's compass bearing (deg from north, mod 180); `fill` = polygon area /
// rectangle area, the fit-quality measure (1.0 = the trace really was this rectangle).
function fitRectangle(points, { resampleCm = RECT_RESAMPLE_CM } = {}) {
    const p = _ring(points);
    if (p.length < 3) throw new Error(`need at least 3 distinct points to fit a rectangle (got ${p.length})`);
    const caliper = _minAreaRect(p);
    if (!caliper) throw new Error('cannot fit a rectangle: points are collinear');
    const e = _sideFitExtents(_resampleRing(p, resampleCm), caliper.theta, caliper);
    const cos = Math.cos(caliper.theta),
        sin = Math.sin(caliper.theta);
    const mx = (e.minX + e.maxX) / 2,
        my = (e.minY + e.maxY) / 2;
    let w = e.maxX - e.minX,
        h = e.maxY - e.minY;
    let { theta } = caliper;
    if (h > w) {
        [w, h] = [h, w]; // keep `a` the longer side, with theta running along it
        theta += Math.PI / 2;
    }
    const polyAreaCm2 = Math.abs(_polygonSignedAreaCm2(p));
    return {
        cx: mx * cos - my * sin,
        cy: mx * sin + my * cos,
        a: w,
        b: h,
        theta,
        bearing: (((90 - (theta * 180) / Math.PI) % 180) + 180) % 180,
        rectAreaCm2: w * h,
        polyAreaCm2,
        fill: w * h > 0 ? polyAreaCm2 / (w * h) : 0,
        points: p.length,
        ccw: _polygonSignedAreaCm2(p) > 0,
    };
}
// The rectangle's four corners, closed, in the requested winding. `subdivide` optionally adds intermediate
// vertices along each side (n segments per side) — 1 (default) emits the exact 4-corner form.
function rectanglePoints({ cx, cy, a, b, theta }, { ccw = true, subdivide = 1 } = {}) {
    const cos = Math.cos(theta),
        sin = Math.sin(theta);
    const corner = (sa, sb) => ({ x: cx + ((sa * a) / 2) * cos - ((sb * b) / 2) * sin, y: cy + ((sa * a) / 2) * sin + ((sb * b) / 2) * cos });
    const corners = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]; // CCW in the rectangle frame
    if (!ccw) corners.reverse();
    const out = [];
    for (const [i, from] of corners.entries()) {
        const to = corners[(i + 1) % corners.length];
        for (let k = 0; k < Math.max(1, subdivide); k++) {
            const t = k / Math.max(1, subdivide);
            out.push({ x: Math.round(from.x + (to.x - from.x) * t), y: Math.round(from.y + (to.y - from.y) * t) });
        }
    }
    out.push({ ...out[0] });
    return out;
}

// ---- wire-surgery: shape + move -----------------------------------------------------------------------------

// Walk the data_points entries, hand each targeted one to `rewrite`, and splice the result back in. `rewrite`
// returns a replacement entry buffer (or undefined to leave the entry byte-identical). Non-targeted entries are
// never re-encoded. Returns { data, changes, dataBuf } — the caller decides whether to adopt `data`.
function _rewriteEntries(perimeters, { type, id }, rewrite) {
    const raw = perimeters.getRawData();
    if (!raw?.attributes?.data_points?.data) throw new Error('no perimeter loaded');
    const wantTypes = new Set(_resolveTypes(type));
    const dockingIds = new Set((perimeters.getDockingPaths?.() || []).map((p) => p.getId()));
    const idList = Array.isArray(id) ? id : [id];
    const wantIds = id === undefined || id === null ? undefined : new Set(idList.map(Number));

    const dataBuf = Buffer.from(raw.attributes.data_points.data);
    const parts = [];
    const changes = [];
    const seen = new Set();
    for (const f of protobufScan(dataBuf)) {
        const entryBuf = Buffer.from(dataBuf.subarray(f.valStart, f.valEnd));
        let decoded;
        try {
            decoded = protobufDecode(entryBuf);
        } catch {
            decoded = {};
        }
        const entryId = decoded[1];
        const entryType = _entryTypeFor(f.field, dockingIds.has(entryId));
        if (entryType && wantTypes.has(entryType) && (wantIds === undefined || wantIds.has(entryId))) {
            seen.add(entryId);
            const result = rewrite({ entryBuf, decoded, entryType, entryId, points: _entryPoints(entryBuf) });
            if (result?.entry) {
                changes.push(result.change);
                parts.push(protobufField(f.field, 2, result.entry));
                continue;
            }
            if (result?.change) changes.push(result.change);
        }
        parts.push(dataBuf.subarray(f.tagStart, f.valEnd));
    }
    if (wantIds) for (const wanted of wantIds) if (!seen.has(wanted)) throw new Error(`no ${type || 'element'} with id ${wanted} in the perimeter`);
    return { data: Buffer.concat(parts), changes, dataBuf, raw };
}

// Keep the app-facing preview honest after a shape change (the robot recomputes on adoption, but a stale count
// mis-displays until then). Sets each element's numPoints/m2Area, then re-derives the category area total and
// the grand point total from the elements. preview.m2Area tracks the ZONES total only, so it moves only when a
// zone was reshaped.
function _applyPreviewForShape(preview, changes) {
    if (!preview) return;
    for (const c of changes) {
        const category = preview[_PREVIEW_CATEGORY[c.type]];
        const element = Array.isArray(category?.elements) ? category.elements.find((e) => e.id === c.id) : undefined;
        if (!element) continue;
        if (typeof c.after.points === 'number') element.numPoints = c.after.points;
        if (typeof c.after.areaM2 === 'number') element.m2Area = Number(c.after.areaM2.toFixed(2));
    }
    for (const key of Object.values(_PREVIEW_CATEGORY)) {
        const category = preview[key];
        if (Array.isArray(category?.elements) && typeof category.m2Area === 'number') category.m2Area = Number(category.elements.reduce((a, e) => a + (e.m2Area || 0), 0).toFixed(2));
    }
    const total = Object.values(_PREVIEW_CATEGORY).reduce((a, key) => a + (preview[key]?.elements || []).reduce((s, e) => s + (e.numPoints || 0), 0), 0);
    if (typeof preview.numPoints === 'number') preview.numPoints = total;
    if (typeof preview.m2Area === 'number' && typeof preview.zones?.m2Area === 'number') preview.m2Area = Math.round(preview.zones.m2Area);
}

// Replace a traced element's geometry with the ideal shape fitted to it. Shared by make-* (delta 0) and tune-*
// (delta applied to the fitted size): refitting an already-ideal shape recovers it, so tuning composes and
// repeats without needing to remember the shape anywhere. Points are stored as integer cm, so each make/tune
// cycle re-fits rounded vertices and the size drifts ~0.1cm per cycle — irrelevant against a drive that wobbles
// by 10cm, but it is why the delta is applied to a fresh fit rather than accumulated.
//
// `shape` is 'circle' or 'rectangle'. `deltaA`/`deltaB` are TOTAL-EXTENT deltas in cm: for a circle, deltaA is
// the diameter change (so +10 = 5cm more clearance all round); for a rectangle, deltaA/deltaB change the length
// of side A (the longer) and side B. MUTATES the model's data_points + preview; does NOT write.
//
// Returns { operation, totals: { elements, bytesBefore, bytesAfter, numPointsBefore, numPointsAfter,
// areaDeltaM2 }, changes: [{ type, id, shape, before, after, maxMoveCm }] } — before/after each carry the full
// shape description so the caller can show the element before and after without recomputing.
function shapePerimeter(perimeters, { shape, type = 'obstacle', id, deltaA = 0, deltaB = 0, count = CIRCLE_DEFAULT_POINTS, subdivide = 1 } = {}) {
    if (!['circle', 'rectangle'].includes(shape)) throw new Error(`unknown shape '${shape}' (circle|rectangle)`);
    const numPointsBefore = perimeters.getRawData()?.attributes?.preview?.numPoints;
    const { data, changes, dataBuf, raw } = _rewriteEntries(perimeters, { type, id }, ({ entryBuf, entryType, entryId, points }) => {
        const before = _describeShape(shape, points);
        const after = _applyDelta(shape, before, deltaA, deltaB);
        const emitted = shape === 'circle' ? circlePoints(after, { count, startAngle: Math.atan2(points[0].y - after.cy, points[0].x - after.cx), ccw: before.ccw }) : rectanglePoints(after, { ccw: before.ccw, subdivide });
        const areaCm2 = Math.abs(_polygonSignedAreaCm2(_ring(emitted)));
        return {
            entry: _replacePointsInEntry(entryBuf, emitted),
            change: {
                type: entryType,
                id: entryId,
                shape,
                before: { ..._publicShape(shape, before), points: points.length, areaM2: Math.abs(_polygonSignedAreaCm2(_ring(points))) / 10_000 },
                after: { ..._publicShape(shape, after), points: emitted.length, areaM2: areaCm2 / 10_000 },
                maxMoveCm: _maxBoundaryMove(shape, _ring(points), after),
            },
        };
    });
    if (changes.length > 0) {
        raw.attributes.data_points.data = [...data]; // mutate the model; write() restamps checksums
        _applyPreviewForShape(raw.attributes.preview, changes);
    }
    return {
        operation: deltaA === 0 && deltaB === 0 ? `make-${shape}` : `tune-${shape}`,
        shape,
        deltaA,
        deltaB,
        totals: {
            elements: changes.length,
            bytesBefore: dataBuf.length,
            bytesAfter: data.length,
            numPointsBefore,
            numPointsAfter: raw.attributes.preview?.numPoints,
            areaDeltaM2: changes.reduce((a, c) => a + (c.after.areaM2 - c.before.areaM2), 0),
        },
        changes,
    };
}
function _describeShape(shape, points) {
    return shape === 'circle' ? fitCircle(points) : fitRectangle(points);
}
// Grow/shrink the fitted shape by a TOTAL-EXTENT delta (diameter, or side length).
function _applyDelta(shape, fit, deltaA, deltaB) {
    if (shape === 'circle') {
        const r = fit.r + deltaA / 2;
        if (r <= 0) throw new Error(`diameter delta ${deltaA >= 0 ? '+' : ''}${deltaA}cm would leave a diameter of ${(2 * r).toFixed(1)}cm`);
        return { ...fit, r };
    }
    const a = fit.a + deltaA,
        b = fit.b + deltaB;
    if (a <= 0 || b <= 0) throw new Error(`side deltas (${deltaA}, ${deltaB}) would leave sides of ${a.toFixed(1)}cm x ${b.toFixed(1)}cm`);
    return { ...fit, a, b };
}
// The report's view of a fit: everything a caller needs to print, nothing internal.
function _publicShape(shape, fit) {
    if (shape === 'circle') return { centre: { x: fit.cx, y: fit.cy }, diameterCm: 2 * fit.r, radiusCm: fit.r, rmsCm: fit.rms, rMinCm: fit.rMin, rMaxCm: fit.rMax };
    return { centre: { x: fit.cx, y: fit.cy }, aCm: fit.a, bCm: fit.b, bearingDeg: fit.bearing, fill: fit.fill };
}
// How far the boundary actually travels: the furthest any ORIGINAL vertex has to move to reach the new shape.
// Measured against the trace, not against the fitted shape — a make-* fit leaves the fitted shape unmoved by
// definition, so comparing fit-to-fit would report 0 while every vertex in the garden shifts.
function _maxBoundaryMove(shape, points, after) {
    const distance = shape === 'circle' ? (q) => Math.abs(Math.hypot(q.x - after.cx, q.y - after.cy) - after.r) : (q) => Math.abs(_signedDistanceToBox(q, after));
    return Math.max(...points.map((q) => distance(q)));
}
// Signed distance from a point to an oriented rectangle's outline — negative inside, positive outside.
function _signedDistanceToBox(q, { cx, cy, a, b, theta }) {
    const cos = Math.cos(-theta),
        sin = Math.sin(-theta);
    const px = q.x - cx,
        py = q.y - cy;
    const dx = Math.abs(px * cos - py * sin) - a / 2,
        dy = Math.abs(px * sin + py * cos) - b / 2;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
}

// Anchor doubles: [16] zone / [8] path / [6] obstacle, { 1: east metres, 2: north metres } from the reference
// position — matched in the same precedence the geometry decoder uses.
const _ANCHOR_FIELDS = [16, 8, 6];
function _anchorFieldOf(decoded) {
    return _ANCHOR_FIELDS.find((f) => decoded[f]?.[1] !== undefined && decoded[f]?.[2] !== undefined);
}
function _readAnchor(decoded, field) {
    return { east: Buffer.from(decoded[field][1], 'hex').readDoubleLE(0), north: Buffer.from(decoded[field][2], 'hex').readDoubleLE(0) };
}
function _anchorBuffer(east, north) {
    const e = Buffer.alloc(8),
        n = Buffer.alloc(8);
    e.writeDoubleLE(east, 0);
    n.writeDoubleLE(north, 0);
    return Buffer.concat([protobufField(1, 1, e), protobufField(2, 1, n)]);
}

// Translate an element by (dNorth, dEast) CENTIMETRES. Every point is stored as an offset from the entry's
// anchor, so moving the ANCHOR moves the whole element — the point list is left untouched. That is both lossless
// (the anchor is a metre double, so there is no integer-cm rounding) and minimal (no geometry is re-encoded).
// MUTATES the model's data_points; does NOT write. preview carries no position, so it needs no update.
//
// Returns { operation:'move', dNorthCm, dEastCm, totals: { elements, bytesBefore, bytesAfter },
// changes: [{ type, id, before: { anchorEastM, anchorNorthM }, after: {...}, movedCm }] }
function movePerimeter(perimeters, { type = 'obstacle', id, dNorth = 0, dEast = 0 } = {}) {
    const { data, changes, dataBuf, raw } = _rewriteEntries(perimeters, { type, id }, ({ entryBuf, decoded, entryType, entryId }) => {
        const field = _anchorFieldOf(decoded);
        if (!field) throw new Error(`${entryType} ${entryId} has no anchor to move`);
        const before = _readAnchor(decoded, field);
        const after = { east: before.east + dEast / 100, north: before.north + dNorth / 100 };
        return {
            entry: protobufSetFields(entryBuf, [{ field, wire: 2, value: _anchorBuffer(after.east, after.north) }]),
            change: {
                type: entryType,
                id: entryId,
                before: { anchorEastM: before.east, anchorNorthM: before.north },
                after: { anchorEastM: after.east, anchorNorthM: after.north },
                movedCm: Math.hypot(dNorth, dEast),
            },
        };
    });
    if (changes.length > 0) raw.attributes.data_points.data = [...data]; // mutate the model; write() restamps checksums
    return { operation: 'move', dNorthCm: dNorth, dEastCm: dEast, totals: { elements: changes.length, bytesBefore: dataBuf.length, bytesAfter: data.length }, changes };
}

module.exports = {
    reduceCollinear,
    reducePerimeter,
    smoothLine,
    smoothPerimeter,
    fitCircle,
    circlePoints,
    fitRectangle,
    rectanglePoints,
    shapePerimeter,
    movePerimeter,
    REDUCE_DEFAULT_EPSILON_CM,
    SMOOTH_DEFAULT_ITERATIONS,
    SMOOTH_DEFAULT_STRENGTH,
    CIRCLE_DEFAULT_POINTS,
};
