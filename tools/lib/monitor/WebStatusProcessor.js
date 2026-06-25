// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// WebStatusProcessor — a monitor plugin that serves a lightweight real-time status web page.
//
// Runs an Express server with a full-screen Google Maps canvas showing a pin for the base
// station and a pin for the robot (the robot pin moves as position updates arrive). A fixed
// status box (top-left, unaffected by map pan/zoom) shows the headline robot state; hovering
// either pin reveals a detail popup. The browser polls /api/state; this processor keeps that
// state fresh by decoding the live MQTT stream; the shared RequestPoller drives the requests.
//
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Client-side URL query parameters (kiosk-mode knobs — all optional, sensible defaults)
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
//
// Layout
//   boxStatus               lt | rt | lb | rb | no            Status-box position (default lt). 'no' hides it.
//   boxNotify               st | lt | rt | lb | rb | no       Notifications-box position (default st).
//                                                             'st' = stacked under status box, same width as it (also
//                                                             reads as "status" — pun intended). 'no' hides it.
//
// Map
//   mapPosition             <lat>,<lon>[,<zoom>]         Absolute view. Disables auto-fit.
//                                                        Example: mapPosition=59.6624,12.9952,19
//                           <dLat>,<dLon>[,<zoom>]       Offset from the zones bounding-box centre (which the
//                                                        client also console.logs at startup so you can copy it).
//                                                        Units required on at least one part: 'm' or 'cm'.
//                                                        Examples: mapPosition=+5m,-5m  mapPosition=+23cm,0m,19
//                           fit                          Frame the zones bounding box and keep it framed —
//                                                        re-fits on window resize, ignores the robot-centric
//                                                        auto-fit. Good for a fixed wall display.
//                           (omitted)                    Default: fit to zones bounding box once perimeters arrive.
//   mapControls             on | off                     'off' = disableDefaultUI (no zoom/fullscreen/etc.).
//
// Tracks (breadcrumb trail)
//   tracks                  on | off | <window>          Tracks state AND window in one. 'off' disables;
//                                                        'on' (or absent) enables with the default window;
//                                                        a window-spec (e.g. tracks=8,p20k) enables AND sets
//                                                        the window. Default on. The window grammar — comma-
//                                                        separated terms, the window being the MAX (furthest-
//                                                        back) of all terms:
//                                                          N    last N contiguous mowing runs (a run = a
//                                                               contiguous one-zone span; revisiting a zone
//                                                               is a new run). Default 1 (current run).
//                                                          pN   last N crumb points (k = ×1000: p20k).
//                                                          tX   last X wall-clock time (s|m|h|d: t24h, t7d).
//                                                          off|inf|∞  entire cache.
//                                                        e.g. ?tracks=16,p20k = whichever reaches further
//                                                        back, 16 runs or 20000 points. Governs the one-shot
//                                                        history baked into the page at connect time (change
//                                                        needs a reload). The #N status-box button is a live
//                                                        DISPLAY filter over what's loaded, in runs, cycling
//                                                        1 → 2 → … → R → ∞ (R = runs currently buffered, grows
//                                                        over time). Server caching is always on; --persist on
//                                                        stiga-monitor opts into cross-restart persistence
//                                                        (default off, 14 days).
//   tracksClr               <window>                     Deprecated alias for the tracks window (same grammar
//                                                        as above), still honoured for backwards compat; if
//                                                        both are given, a window in `tracks` wins.
//   follow                  on | off                     Keep the robot centred: pan the map to it on each
//                                                        position update (default ON; ?follow=off disables).
//                                                        Toggle live with the ⌖ status-box button.
//
// Status-box content
//   statusTracksControls    on | off                     Show the Tracks line (default on).
//
// Commands (active control panel, stacked between status & notify boxes)
//   commands                on | off                     Show command box with [Start|Stop] [Home] (default off).
//                                                        Start/Stop is context-aware (the relevant verb is shown).
//   diagnostics             on | off                     Show the 🔧 diagnostics row (default off, collapsed;
//                                                        the 🔧 status-row button toggles it). Buttons run
//                                                        whitelisted stiga-analyse.js reports server-side:
//                                                        'text' ones (battery charge/consumption) show in a
//                                                        console overlay; 'map' ones (satellite coverage,
//                                                        mobile signal — 7-day --format json) paint a value-
//                                                        coloured heatmap on the live map. AUTH-GATED like
//                                                        commands (only offered when a credential is
//                                                        configured); single-slot (one run at a time).
//   settingsAlert           off | 0 | <n>[smhd]         Settings-change alert: the ⚙ wheel reddens and the
//                                                        panel red-dots each changed global setting (cleared
//                                                        when you next view the panel). 'off'/'0' disables it;
//                                                        <n>[smhd] sets how long accumulated changes persist
//                                                        unseen before auto-clearing (default 24h, bare n=h) —
//                                                        so an unattended kiosk doesn't stay red forever.
//
// Example kiosk URL:
//   /?boxNotify=no&mapPosition=59.6624,12.9952,19&mapControls=off&tracks=on&tracksClr=3,p20k&follow=on
//
// More knobs will be added here over time; structure new ones the same way (URL_CONFIG entry +
// a single usage site) so each option stays small and removable.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

// Diagnostics the kiosk can trigger (with ?diagnostics=on, auth-gated exactly like commands). Each maps a
// name to a FIXED stiga-analyse.js argv — never interpolate request input — with a per-type timeout. The
// child is spawned with an argv array (no shell), output is capped, and only one runs at a time.
const STIGA_ANALYSE = path.join(__dirname, '..', '..', 'stiga-analyse.js');
const DIAGNOSTICS = {
    // type 'text' → console overlay; type 'map' → JSON (lat/lng cells) painted as a heatmap on the live map.
    // front-end runs are day-capped for recent locality (the CLI can run unconstrained); battery 90d, maps 14d.
    'battery-charge': { argv: ['battery-charge', '--days', '90'], timeoutMs: 90_000, label: 'Battery charge (90d)', icon: '⚡', type: 'text' },
    'battery-consumption': { argv: ['battery-consumption', '--days', '90'], timeoutMs: 90_000, label: 'Battery consumption (90d)', icon: '🪫', type: 'text' },
    'satellites': { argv: ['position-heatmap', '--format', 'json', '--metric', 'satellites', '--days', '14'], timeoutMs: 180_000, label: 'Satellite coverage (14d)', icon: '🛰️', type: 'map', metric: 'satellites' },
    'mobile-signal': { argv: ['position-heatmap', '--format', 'json', '--metric', 'rssi', '--days', '14'], timeoutMs: 180_000, label: 'Mobile signal (14d)', icon: '📶', type: 'map', metric: 'rssi' },
};
const DIAGNOSTIC_OUTPUT_CAP = 256 * 1024; // bytes; guards against a runaway returning a huge payload
const express = require('express');

// Optional minifiers — present in production, gracefully absent in lean installs (we then serve the assets
// unminified; gzip still applies). minifyStaticAssets() does a one-off pass over PAGE_CSS/CLIENT_JS at startup.
function _optionalRequire(name) {
    try {
        return require(name);
    } catch {
        return undefined;
    }
}
const _terser = _optionalRequire('terser'),
    _CleanCSS = _optionalRequire('clean-css');

const { StigaAPIUtilities, StigaAPIElements: elements, StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPIGarage, StigaAPIPerimeters, StigaAPINotifications } = require('../../../api/StigaAPI');
const { protobufDecode, stringToBytes, formatNetworkId } = StigaAPIUtilities;

const DEFAULT_PORT = 3001;
const POLL_MS = 2500; // browser -> server poll interval (local, cheap)
const SUMMARY_STALE_MS = 120 * 1000; // /api/summary 'online' flag flips false once the freshest update is older than this
const NOTIF_POLL_MS_UNDOCKED = 60 * 1000; // notifications poll interval when robot is active
const NOTIF_POLL_MS_DOCKED = 5 * 60 * 1000; // notifications poll interval when robot is parked
const SCHEDULE_TIMEZONE_DEFAULT = 'Europe/Stockholm'; // garden tz fallback if not configured
const PERSIST_DEFAULT_DIR = '/dev/shm';
const PERSIST_INTERVAL_MS = 60 * 1000; // flush cached crumbs to disk every minute when persistence is enabled
const PERSIST_DEFAULT_DAYS = 14;
const CRUMB_DEFAULT_INITIAL_ZONES = 1; // semantic default — cover the current (most-recent) mowing zone only

// zone-completion trail: a sparse record of "robot finished N% of zone X at time T". Recorded
// only on transition out of a zone, and only when the percent meets a threshold to filter
// aborted starts. Persisted separately from crumbs (much smaller, much longer retention).
const ZONE_COMPLETION_THRESHOLD_PERCENT = 5; // ignore <5% departures (likely aborted attempts)
const ZONE_COMPLETIONS_PER_ZONE_KEEP = 10; // server retains up to N per zone (on disk + memory)
const ZONE_COMPLETIONS_PER_ZONE_SERVE = 5; // up to N per zone served to the client
const ZONE_COMPLETIONS_PERSIST_DEFAULT_DAYS = 90; // longer retention than crumbs — they're tiny
const ZONE_COMPLETION_DEDUPE_WINDOW_MS = 60 * 60 * 1000; // merge same-zone records within 1h: treat as one session

// zone spatial-coverage estimate: at each zone-departure we compute how much of the zone polygon the robot
// actually drove over while cutting, as a cross-check on the robot's self-reported zoneCompleted%. The
// positions are the cached crumbs flagged mow=1 (cutting) for the run just ended (walk back to the last zone
// change); coverage is the fraction of the polygon painted by a swath-width capsule along that path. It's a
// per-run estimate (so it reads lower than the cumulative reported %), consistent enough to flag a zone the
// robot calls done but visibly under-covered. SWATH is an estimate (body 40cm, cut ~25-30cm) — recalibrate
// against a zone known to have finished cleanly so it reads ~100%.
const CRUMB_SWATH_M = 0.28; // estimated cutting swath width (metres)
const COVERAGE_GRID_M = 0.25; // rasterisation cell for the swath-capsule paint
const COVERAGE_MIN_CRUMBS = 20; // need at least this many cutting crumbs in the run to bother computing

// geofence violation: for EVERY recorded position (not just cutting — the robot can wander through an obstacle
// in transit, it doesn't strictly follow the connector paths), compute how far the fix is into a place it
// shouldn't be. Signed depth in cm stored per crumb: +ve = inside an obstacle (permanent or temporary), -ve =
// out of bounds (outside every zone), 0 = clean. Out-of-bounds excuses fixes within a corridor of a
// connect/docking path or near the dock, since transiting those is legitimate. The display/alarm margin is
// applied to |depth| at render time, so it stays tunable later without recomputing history. Computed once at
// capture against the perimeter as it was THEN (temp obstacles are transient), with a bbox pre-reject so the
// per-position cost is a couple of comparisons in the common (clean) case.
const VIOLATION_MARGIN_CM = 20; // |depth| must exceed this to count as a violation (absorbs GNSS noise / polygon granularity)
const VIOLATION_PATH_CORRIDOR_M = 0.6; // out-of-bounds fixes within this of a connect/docking path are legitimate transit
const VIOLATION_BASE_RADIUS_M = 2; // ...as are fixes within this of the dock/reference origin (undock manoeuvring)
const VIOLATION_DEPTH_CAP_CM = 6000; // clamp stored magnitude (~60 m) so one wild fix can't blow up the int

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// tracksClr — modular trail-window spec. A comma-separated list of window terms; the effective window is the
// MAX (furthest-back / most inclusive) of all terms, so combining terms widens rather than narrows. Terms:
//   N         last N contiguous mowing runs. A "run" is a contiguous span of one zone; revisiting a zone
//             starts a NEW run, so this tracks recent activity instead of distinct zone IDs (the old model,
//             which jumped straight to "everything" once you asked for more IDs than the garden has).
//   pN        last N crumb points          (k suffix ×1000: p20k = 20000)
//   tX        last X of wall-clock time     (s|m|h|d: t90s, t24h, t7d)
//   off|inf|∞ everything (whole cache)
// e.g. "16,p20k" = whichever reaches further back, 16 runs or 20000 points. This parser/cutoff runs
// server-side (the one-shot hydration window) and is mirrored client-side (the #N display filter). The
// empty/default spec is 1 run (the current zone only).
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function _tracksClrParseCount(s) {
    const m = /^(\d+(?:\.\d+)?)(k)?$/i.exec(s);
    if (!m) return undefined;
    return Math.round(Number.parseFloat(m[1]) * (m[2] ? 1000 : 1));
}
const _TRACKS_CLR_UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
function _tracksClrParseDuration(s) {
    const m = /^(\d+(?:\.\d+)?)([dhms])?$/i.exec(s);
    if (!m) return undefined;
    return Math.round(Number.parseFloat(m[1]) * _TRACKS_CLR_UNIT_MS[(m[2] || 's').toLowerCase()]);
}
function parseTracksClrSpec(raw) {
    const spec = { off: false, runs: undefined, points: undefined, timeMs: undefined };
    if (raw === undefined) return spec;
    for (const tok of String(raw).split(',')) {
        const t = tok.trim().toLowerCase();
        if (t === '') continue;
        if (t === 'off' || t === 'inf' || t === '∞') {
            spec.off = true;
            continue;
        }
        if (t[0] === 'p') {
            const v = _tracksClrParseCount(t.slice(1));
            if (v !== undefined) spec.points = spec.points === undefined ? v : Math.max(spec.points, v);
            continue;
        }
        if (t[0] === 't') {
            const v = _tracksClrParseDuration(t.slice(1));
            if (v !== undefined) spec.timeMs = spec.timeMs === undefined ? v : Math.max(spec.timeMs, v);
            continue;
        }
        const v = Number.parseInt(t, 10);
        if (Number.isFinite(v) && v >= 0) spec.runs = spec.runs === undefined ? v : Math.max(spec.runs, v);
    }
    return spec;
}
// Cutoff t for "keep the last N contiguous runs" over the columnar store (store.zone[i] is the zone int,
// -1 = unzoned; store.t[i] the timestamp). Walk newest→oldest, new run on each zone change; return the
// boundary t just inside the Nth run (−∞ if fewer than N runs exist). Unzoned crumbs belong to the
// current run, so going-home/transition points inside the window are kept.
function tracksClrRunsCutoff(store, n) {
    n = Math.max(n, 1);
    const len = store.t.length;
    let runs = 0,
        cur,
        hasCur = false;
    for (let i = len - 1; i >= 0; i--) {
        const z = store.zone[i];
        if (z === -1) continue;
        if (!hasCur || z !== cur) {
            runs++;
            if (runs > n) return i + 1 < len ? store.t[i + 1] : store.t[i];
            cur = z;
            hasCur = true;
        }
    }
    return Number.NEGATIVE_INFINITY;
}
function tracksClrPointsCutoff(store, n) {
    n = Math.max(n, 1);
    const len = store.t.length;
    return len <= n ? Number.NEGATIVE_INFINITY : store.t[len - n];
}
// Resolve a parsed spec against the store to one cutoff timestamp (keep crumbs with t >= cutoff). The MAX
// window = the furthest-back term = the MIN of the per-term cutoffs. Empty spec defaults to 1 run.
function tracksClrCutoff(store, spec, nowMs) {
    if (spec.off) return Number.NEGATIVE_INFINITY;
    const cutoffs = [];
    if (spec.runs !== undefined) cutoffs.push(tracksClrRunsCutoff(store, spec.runs));
    if (spec.points !== undefined) cutoffs.push(tracksClrPointsCutoff(store, spec.points));
    if (spec.timeMs !== undefined) cutoffs.push(nowMs - spec.timeMs);
    if (cutoffs.length === 0) cutoffs.push(tracksClrRunsCutoff(store, CRUMB_DEFAULT_INITIAL_ZONES));
    return Math.min(...cutoffs);
}
// Resolve the `tracks` + `tracksClr` query params to { on, window }. `tracks` may be 'on' | 'off' | a
// window-spec; a spec both enables tracks and sets the hydration window (new combined form, e.g.
// tracks=8,p20k), while 'on'/'off'/absent fall back to tracksClr (backwards compat). The server only needs
// the window; `on` is the client's display concern. Mirrored client-side.
function resolveTracks(tracksParam, tracksClrParam) {
    if (tracksParam === 'off') return { on: false, window: tracksClrParam };
    if (tracksParam === undefined || tracksParam === '' || tracksParam === 'on') return { on: true, window: tracksClrParam };
    return { on: true, window: tracksParam };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Columnar crumb store — parallel arrays instead of an object per crumb. lat/lng are 1e7-scaled integers
// (~1cm, packed SMIs), t is epoch ms, zone is an int (-1 = unzoned), col is an index into a small colour
// palette, and err is a plain inline column (null for the ~98% of crumbs with no fault — kept in the list,
// not a side cache). ~24 B/crumb vs ~180 B for the old form. Used in-memory (server + client), persisted
// (v3), and — with lat/lng/t delta-encoded — on the wire. err/zone/col are NOT delta'd (low-entropy or
// categorical); only the three high-entropy numeric columns are, which is the whole gzip win.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function makeCrumbStore() {
    return { lat: [], lng: [], t: [], zone: [], col: [], err: [], mow: [], vdepth: [], pal: [] };
}
function crumbPalIndex(store, hex) {
    let k = store.pal.indexOf(hex);
    if (k === -1) {
        k = store.pal.length;
        store.pal.push(hex);
    }
    return k;
}
// Append one crumb (degrees in, scaled internally). zone: int or -1; err: string or null/undefined;
// mow: 1 = cutting (MOWING/CUTTING_BORDER), 0 = not — the semantic flag the coverage calc keys off.
// vdepth: signed cm geofence violation depth (+inside obstacle / −out of bounds / 0 clean).
function crumbPush(store, latDeg, lngDeg, t, zone, hex, err, mow, vdepth) {
    store.lat.push(Math.round(latDeg * 1e7));
    store.lng.push(Math.round(lngDeg * 1e7));
    store.t.push(t);
    store.zone.push(zone);
    store.col.push(crumbPalIndex(store, hex));
    // eslint-disable-next-line unicorn/no-null
    store.err.push(err || null);
    store.mow.push(mow ? 1 : 0);
    store.vdepth.push(vdepth || 0);
}
// First index with t >= cutoff (binary search; t ascending). −∞ cutoff → 0.
function crumbStartIndex(store, cutoff) {
    if (cutoff === Number.NEGATIVE_INFINITY) return 0;
    let lo = 0,
        hi = store.t.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (store.t[mid] < cutoff) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
// Encode crumbs [startIdx..end] as the wire payload: lat/lng/t as first-absolute-then-delta arrays; zone,
// col and err sent verbatim per crumb. Empty -> { n: 0 }.
function encodeCrumbsWire(store, startIdx) {
    const end = store.t.length,
        n = end - startIdx;
    if (n <= 0) return { n: 0 };
    const lat = [],
        lng = [],
        t = [],
        z = [],
        c = [],
        err = [],
        m = [],
        v = [];
    let pl = 0,
        pn = 0,
        pt = 0;
    for (let i = startIdx; i < end; i++) {
        const la = store.lat[i],
            lo = store.lng[i],
            tt = store.t[i],
            first = i === startIdx;
        lat.push(first ? la : la - pl);
        lng.push(first ? lo : lo - pn);
        t.push(first ? tt : tt - pt);
        pl = la;
        pn = lo;
        pt = tt;
        z.push(store.zone[i]);
        c.push(store.col[i]);
        err.push(store.err[i]);
        m.push(store.mow[i]);
        v.push(store.vdepth[i]);
    }
    return { n, pal: store.pal, lat, lng, t, z, c, err, m, v };
}

// ---- zone spatial-coverage estimate -------------------------------------------------------------------------
// The "thick calculation": rasterise a swath-width capsule along the cutting path and measure what fraction of
// the zone polygon it paints. All geometry is in local ENU metres (origin = RTK reference), so the crumb
// lat/lng and the zone polygon must both be projected through llToMetres against the same reference first.
function llToMetres(latDeg, lngDeg, ref) {
    const R = 6_371_000;
    return {
        x: ((lngDeg - ref.longitude) * Math.PI * R * Math.cos((ref.latitude * Math.PI) / 180)) / 180,
        y: ((latDeg - ref.latitude) * Math.PI * R) / 180,
    };
}
function pointInPolygon(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x,
            yi = poly[i].y,
            xj = poly[j].x,
            yj = poly[j].y;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}
function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax,
        dy = by - ay,
        l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// poly/pos are arrays of {x,y} (pos also carry {t}) in metres. Returns coverage 0..100 = painted-in-polygon
// cells / total-in-polygon cells, where each consecutive cutting pair paints a capsule of width=swath.
function swathCoveragePercent(poly, pos, swath, cell) {
    let mnx = Infinity,
        mxx = -Infinity,
        mny = Infinity,
        mxy = -Infinity;
    for (const p of poly) {
        if (p.x < mnx) mnx = p.x;
        if (p.x > mxx) mxx = p.x;
        if (p.y < mny) mny = p.y;
        if (p.y > mxy) mxy = p.y;
    }
    const nx = Math.ceil((mxx - mnx) / cell) + 1,
        ny = Math.ceil((mxy - mny) / cell) + 1;
    const inPoly = new Uint8Array(nx * ny);
    let total = 0;
    for (let iy = 0; iy < ny; iy++)
        for (let ix = 0; ix < nx; ix++)
            if (pointInPolygon(mnx + (ix + 0.5) * cell, mny + (iy + 0.5) * cell, poly)) {
                inPoly[iy * nx + ix] = 1;
                total++;
            }
    if (total === 0) return undefined;
    const r = swath / 2;
    const vis = new Uint8Array(nx * ny);
    const paint = (ax, ay, bx, by) => {
        let ix0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - mnx) / cell)),
            ix1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx) + r - mnx) / cell)),
            iy0 = Math.max(0, Math.floor((Math.min(ay, by) - r - mny) / cell)),
            iy1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by) + r - mny) / cell));
        for (let iy = iy0; iy <= iy1; iy++)
            for (let ix = ix0; ix <= ix1; ix++) {
                const k = iy * nx + ix;
                if (!inPoly[k] || vis[k]) continue;
                if (distToSegment(mnx + (ix + 0.5) * cell, mny + (iy + 0.5) * cell, ax, ay, bx, by) <= r) vis[k] = 1;
            }
    };
    for (let i = 0; i < pos.length; i++) {
        const p = pos[i];
        if (i > 0) {
            const a = pos[i - 1],
                d = Math.hypot(p.x - a.x, p.y - a.y);
            if (d < 3 && p.t - a.t < 8000) {
                paint(a.x, a.y, p.x, p.y); // capsule between consecutive cutting fixes
                continue;
            }
        }
        paint(p.x, p.y, p.x, p.y); // lone disc at a gap / first point
    }
    let covered = 0;
    for (let k = 0; k < vis.length; k++) if (vis[k]) covered++;
    return (100 * covered) / total;
}

// ---- geofence violation geometry ----------------------------------------------------------------------------
// Project a {path:[{latitude,longitude}]} ring/line into local-metre points plus its bbox, for cheap pre-reject.
function projectRing(path, ref) {
    const pts = path.map((p) => llToMetres(p.latitude, p.longitude, ref));
    let mnx = Infinity,
        mxx = -Infinity,
        mny = Infinity,
        mxy = -Infinity;
    for (const p of pts) {
        if (p.x < mnx) mnx = p.x;
        if (p.x > mxx) mxx = p.x;
        if (p.y < mny) mny = p.y;
        if (p.y > mxy) mxy = p.y;
    }
    return { pts, mnx, mxx, mny, mxy };
}
// Distance from a point to a polygon's boundary (min over its edges). Used as the "how deep" magnitude.
function distToRingEdges(x, y, pts) {
    let best = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const d = distToSegment(x, y, pts[j].x, pts[j].y, pts[i].x, pts[i].y);
        if (d < best) best = d;
    }
    return best;
}
// Distance from a point to an open polyline (connect/docking path), min over its segments.
function distToPolyline(x, y, pts) {
    if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
    let best = Infinity;
    for (let i = 1; i < pts.length; i++) {
        const d = distToSegment(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
        if (d < best) best = d;
    }
    return best;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class WebStatusProcessor {
    constructor(connection, options = {}) {
        this.connection = connection;
        this.logger = options.logger || console.log;
        this.location = options.location;
        if (!this.location) throw new Error('WebStatusProcessor: options.location is required (RTK reference origin)');
        this.apiKey = options.apiKey;
        if (!this.apiKey) throw new Error('WebStatusProcessor: options.apiKey is required (Google Maps API key)');
        this.port = options.port || DEFAULT_PORT;
        this.username = options.username;
        this.password = options.password;
        this.basicAuth = this._parseBasicAuth(options.auth);
        // Auth scope: 'all' (default) protects every request; 'commands' protects only the command-enabled
        // page load (?commands=on, so the browser caches the credential) and the /api/command endpoint
        // itself — leaving read-only access and server ops (e.g. /api/refresh) open without a password.
        this.authScope = options.authScope === 'commands' ? 'commands' : 'all';
        this._diagnosticRunning = false; // single-slot guard for /api/diagnostic
        this.scheduleTimezone = options.scheduleTimezone || SCHEDULE_TIMEZONE_DEFAULT;
        this.perimeters = undefined;
        this.notifications = [];
        this.cloudServer = undefined;
        this.notificationsTimer = undefined;
        this.poller = options.poller;

        // crumb cache: always on (in-memory). Persistence to disk is opt-in via --persist; when
        // enabled the cache survives restarts and is pruned to persistDays of history.
        this.persistEnabled = Boolean(options.persist);
        this.persistDir = typeof options.persist === 'string' && options.persist ? options.persist : PERSIST_DEFAULT_DIR;
        this.persistDays = options.persistDays || PERSIST_DEFAULT_DAYS;
        this.persistanceTimer = undefined;
        this.crumbs = makeCrumbStore(); // columnar store (see makeCrumbStore)
        this.crumbsDirty = false;

        // zone-completion tracking — see ZONE_COMPLETION_* constants for retention/threshold.
        // Hardcoded 90-day default (vs the configurable crumb retention) because the records
        // are tiny and the value of a long trail (seasonal mowing history) outweighs the cost.
        this.zoneCompletions = []; // chronological [{ zone: "5", percent: 87, t: ..., trigger: 'docked'|'progressed' }] (older entries lack trigger)
        this.zoneCompletionsDirty = false;
        this.zoneCompletionDays = options.zoneCompletionDays || ZONE_COMPLETIONS_PERSIST_DEFAULT_DAYS;
        this._activeMowingZone = undefined; // last seen non-null zone (used for transition detection)
        this._activeMowingPercent = 0;

        this.state = {
            base: {
                mac: options.baseMac,
                latitude: this.location.latitude,
                longitude: this.location.longitude,
                status: undefined,
                location: undefined,
                network: undefined,
                version: undefined,
                updatedStatus: undefined,
            },
            robot: {
                mac: options.robotMac,
                name: undefined,
                latitude: undefined,
                longitude: undefined,
                offsetDistanceMetres: undefined,
                offsetCompass: undefined,
                orientationCompass: undefined,
                docked: undefined,
                statusType: undefined,
                statusMessage: undefined,
                statusText: undefined,
                statusValid: undefined,
                statusFlag: undefined,
                interventionRequired: undefined,
                battery: undefined,
                mowing: undefined,
                schedule: undefined,
                location: undefined,
                network: undefined,
                version: undefined,
                updatedStatus: undefined,
                updatedPosition: undefined,
                updatedSchedule: undefined,
            },
        };
    }

    //

    async start() {
        this.connection.on('message', (topic, message) => this._handleMessage(topic, message));

        await minifyStaticAssets(this.logger); // one-off; serves verbatim if minifiers absent
        const app = express();
        app.disable('x-powered-by');
        // gzip responses for clients that accept it — the page's INITIAL_CRUMBS blob, CLIENT_JS and CSS are
        // highly repetitive and compress ~10x. Hand-rolled on zlib (already a dep) to avoid pulling in the
        // compression middleware. Wraps res.send so res.json (which calls send) is covered too; only touches
        // string/Buffer bodies past a small threshold and never double-encodes.
        app.use((req, res, next) => {
            if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
                next();
                return;
            }
            const rawSend = res.send.bind(res);
            res.send = (body) => {
                if ((typeof body === 'string' || Buffer.isBuffer(body)) && !res.getHeader('Content-Encoding')) {
                    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
                    if (buf.length >= 1024) {
                        res.setHeader('Content-Encoding', 'gzip');
                        res.setHeader('Vary', 'Accept-Encoding');
                        res.removeHeader('Content-Length');
                        return rawSend(zlib.gzipSync(buf));
                    }
                }
                return rawSend(body);
            };
            next();
        });
        if (this.basicAuth)
            app.use((req, res, next) => {
                if (this._authRequired(req)) this._basicAuthMiddleware(req, res, next);
                else next();
            });
        app.get('/', (req, res) => res.type('html').send(this._renderPage(req)));
        app.get('/api/state', (req, res) => res.json({ generated: new Date().toISOString(), ...this.state, zoneCompletions: this._serializeZoneCompletions() }));
        app.get('/api/summary', (req, res) => res.json(this._summary()));
        app.get('/api/perimeters', (req, res) => res.json(this.perimeters ?? { zones: [], obstacles: [] }));
        app.get('/api/notifications', (req, res) => res.json(this.notifications));
        app.post('/api/command/:name', (req, res) => this._handleCommandPost(req, res));
        app.post('/api/diagnostic/:name', (req, res) => this._handleDiagnosticPost(req, res));
        app.post('/api/refresh', (req, res) => this._handleRefreshPost(req, res));
        await new Promise((resolve, reject) => {
            this.server = app.listen(this.port, '0.0.0.0', () => resolve());
            this.server.on('error', reject);
        });

        this.poller?.acquire();

        if (this.persistEnabled) {
            // Ensure the persist dir exists — the default (/dev/shm) always does, but an explicit
            // --persist=/some/dir (e.g. a mounted Docker volume subdir) may not, and the save path
            // only catches+logs, so without this persistence would silently never write.
            try {
                fs.mkdirSync(this.persistDir, { recursive: true });
            } catch (e) {
                this.logger(`WebStatus: could not create persist dir ${this.persistDir}: ${e.message}`);
            }
            this._loadCrumbs();
            this._loadZoneCompletions();
            this.persistanceTimer = setInterval(() => {
                this._saveCrumbs();
                this._saveZoneCompletions();
            }, PERSIST_INTERVAL_MS);
            this.logger(`WebStatus: persistence ON (dir=${this.persistDir}, crumbs=${this.persistDays}d, zones=${this.zoneCompletionDays}d)`);
        }

        this._loadPerimeters()
            .then(() => this._startNotificationPoll())
            .catch((e) => this.logger(`WebStatus: cloud features unavailable (${e.message})`));

        this.logger(`WebStatus started on port ${this.port}`);
    }

    async stop() {
        this.poller?.release();
        if (this.notificationsTimer) {
            clearTimeout(this.notificationsTimer);
            this.notificationsTimer = undefined;
        }
        if (this.persistanceTimer) {
            clearInterval(this.persistanceTimer);
            this.persistanceTimer = undefined;
        }
        if (this.persistEnabled) {
            this._saveCrumbs();
            this._saveZoneCompletions();
        }
        if (this.server) await new Promise((resolve) => this.server.close(resolve));
        this.logger('WebStatus stopped');
    }

    //

    // Accepts "user:pass" (full credentials) or "pass" (password only — any username accepted).
    // Returns undefined when no protection is requested, so the middleware is never installed.
    _parseBasicAuth(spec) {
        if (!spec) return undefined;
        const colon = spec.indexOf(':');
        if (colon === -1) return { user: undefined, pass: spec };
        return { user: spec.slice(0, colon), pass: spec.slice(colon + 1) };
    }

    // Does this request need authentication? In 'all' scope, everything does. In 'commands' scope, only the
    // command/diagnostics-enabled page load (?commands=on / ?diagnostics=on — fires the browser's native auth
    // dialog at load so the credential is cached for the realm) and the privileged endpoints (/api/command/*
    // and /api/diagnostic/*, which shell out — the under-the-hood backstop). Read GETs and server ops like
    // /api/refresh stay open.
    _authRequired(req) {
        if (this.authScope === 'all') return true;
        if (req.query && (req.query.commands === 'on' || req.query.diagnostics === 'on')) return true;
        return req.path.startsWith('/api/command') || req.path.startsWith('/api/diagnostic');
    }

    _basicAuthMiddleware(req, res, next) {
        const header = req.headers.authorization || '';
        if (header.startsWith('Basic ')) {
            const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
            const split = decoded.indexOf(':');
            const user = split === -1 ? decoded : decoded.slice(0, split);
            const pass = split === -1 ? '' : decoded.slice(split + 1);
            if ((this.basicAuth.user === undefined || user === this.basicAuth.user) && pass === this.basicAuth.pass) {
                next();
                return;
            }
        }
        res.setHeader('WWW-Authenticate', 'Basic realm="Stiga Webstatus", charset="UTF-8"');
        res.status(401).type('text/plain').send('Authentication required');
    }

    // Active robot commands the kiosk can trigger. Each maps to a ROBOT_COMMAND_IDS entry and
    // is published directly on the shared MQTT connection (same path RequestPoller uses for
    // its own commands). Fire-and-forget — the robot's next STATUS will reflect the new state.
    _handleCommandPost(req, res) {
        const name = (req.params.name || '').toLowerCase();
        // Schedule on/off is a write that must resend the FULL current schedule (time blocks preserved)
        // with only [1] flipped — exactly what the app sends. Handled specially (see _handleScheduleToggle).
        if (name === 'schedule-on' || name === 'schedule-off') {
            this._handleScheduleToggle(name === 'schedule-on', res);
            return;
        }
        const simple = { 'start': 'START', 'stop': 'STOP', 'home': 'GO_HOME', 'reset-error': 'RESET_ERROR', 'boot': 'BOOT' };
        const zoned = { 'force-cut': 'FORCE_CUT', 'force-border-cut': 'FORCE_BORDER_CUT' };
        const id = simple[name] || zoned[name];
        if (!id) {
            res.status(400).json({ ok: false, error: `unknown command '${req.params.name}'` });
            return;
        }
        let params;
        if (zoned[name]) {
            const zone = Number.parseInt(req.query.zone, 10);
            if (!Number.isInteger(zone) || zone < 1) {
                res.status(400).json({ ok: false, error: 'force-cut requires a valid zone' });
                return;
            }
            params = elements.encodeRobotForceCut(zone);
        }
        if (!this.connection.isConnected()) {
            res.status(503).json({ ok: false, error: 'MQTT not connected' });
            return;
        }
        try {
            this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS[id], params), { qos: 2 });
            this.logger(`WebStatus: command ${id} dispatched${params ? ' (zone ' + req.query.zone + ')' : ''}`);
            res.json({ ok: true, command: id });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    }
    // Enable/disable scheduled mowing: resend the robot's last-reported schedule (its time blocks, stashed
    // in _handleRobotSchedule) via SCHEDULING_SETTINGS_UPDATE (cmd 20) with [1] flipped — never a flag-only
    // update, which could wipe the blocks. Byte-identical to what the app sends.
    _handleScheduleToggle(enabled, res) {
        if (!this.connection.isConnected()) {
            res.status(503).json({ ok: false, error: 'MQTT not connected' });
            return;
        }
        if (this.scheduleBlocks === undefined) {
            res.status(409).json({ ok: false, error: 'no schedule received from robot yet' });
            return;
        }
        try {
            const params = { 1: enabled ? 1 : 0, 2: Buffer.from(this.scheduleBlocks, 'hex'), 4: 0 };
            this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.SCHEDULING_SETTINGS_UPDATE, params), { qos: 2 });
            this.logger(`WebStatus: schedule ${enabled ? 'enabled' : 'disabled'}`);
            res.json({ ok: true, command: 'SCHEDULING_SETTINGS_UPDATE', enabled });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    }

    // Run a whitelisted diagnostic (a stiga-analyse.js command) server-side and return its console output.
    // Auth is enforced by the middleware (commands scope) AND defensively here: never shell out without a
    // configured credential. Single-slot (409 if one's already running), fixed argv (no shell, no input
    // interpolation), per-type timeout, capped output.
    _handleDiagnosticPost(req, res) {
        if (!this.basicAuth) {
            res.status(403).json({ ok: false, error: 'diagnostics require authentication to be configured' });
            return;
        }
        const name = (req.params.name || '').toLowerCase();
        const diag = DIAGNOSTICS[name];
        const from = req.ip || req.socket?.remoteAddress || '?';
        if (!diag) {
            this.logger(`WebStatus: diagnostic rejected — unknown '${name}' (from ${from})`);
            res.status(404).json({ ok: false, error: `unknown diagnostic '${name}'` });
            return;
        }
        if (this._diagnosticRunning) {
            this.logger(`WebStatus: diagnostic '${name}' rejected — another is already running (from ${from})`);
            res.status(409).json({ ok: false, error: 'a diagnostic is already running' });
            return;
        }
        this._diagnosticRunning = true;
        const started = Date.now();
        const argvStr = [STIGA_ANALYSE, ...diag.argv].join(' ');
        this.logger(`WebStatus: diagnostic '${name}' — shelling out: ${process.execPath} ${argvStr} (from ${from})`);
        let output = '',
            truncated = false,
            settled = false;
        const finish = (payload) => {
            if (settled) return;
            settled = true;
            this._diagnosticRunning = false;
            const ms = Date.now() - started;
            this.logger(`WebStatus: diagnostic '${name}' finished — ${payload.ok ? 'ok' : 'FAILED'} (exit ${payload.code ?? '-'}${payload.signal ? '/' + payload.signal : ''}, ${ms}ms, ${output.length}b${payload.error ? ', error: ' + payload.error : ''})`);
            res.json({ name, label: diag.label, ms, ...payload });
        };
        try {
            const child = spawn(process.execPath, [STIGA_ANALYSE, ...diag.argv], { cwd: path.join(__dirname, '..', '..', '..'), timeout: diag.timeoutMs, killSignal: 'SIGTERM' });
            const collect = (chunk) => {
                if (output.length < DIAGNOSTIC_OUTPUT_CAP) output += chunk.toString();
                else truncated = true;
            };
            child.stdout.on('data', collect);
            child.stderr.on('data', collect);
            child.on('error', (e) => finish({ ok: false, error: e.message, output }));
            child.on('close', (code, signal) => {
                const timedOut = signal === 'SIGTERM';
                if (truncated) output += '\n…[output truncated]';
                if (timedOut) output += `\n[timed out after ${Math.round(diag.timeoutMs / 1000)}s]`;
                finish({ ok: code === 0 && !timedOut, code, signal, output });
            });
        } catch (e) {
            finish({ ok: false, error: e.message, output });
        }
    }

    // Re-fetch cloud-side data on demand (perimeters from the cloud, then notification poll
    // immediately). The MQTT state is already live, so nothing to do for it.
    async _handleRefreshPost(req, res) {
        try {
            this.perimeters = undefined;
            this._perimMetres = undefined; // invalidate the projected-metre cache; rebuilt on next violation check
            await this._loadPerimeters(); // perimeters incl. per-zone settings (cloud)
            if (this.notificationsTimer) clearTimeout(this.notificationsTimer);
            this._startNotificationPoll(); // notifications (cloud)
            // force a fresh global-settings push from the robot (MQTT) so the settings panel re-syncs too
            if (this.connection?.isConnected()) this.connection.publish(`${this.connection.getRobotMac()}/CMD_ROBOT`, elements.encodeRobotCommand(elements.ROBOT_COMMAND_IDS.SETTINGS_REQUEST), { qos: 2 });
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    }

    _handleMessage(topic, message) {
        if (topic.includes('/JSON_NOTIFICATION')) {
            this._handleJsonNotification(topic, message);
            return;
        }
        try {
            const decoded = protobufDecode(message);
            if (topic.includes(this.connection.getRobotMac())) this._handleRobotMessage(topic, decoded);
            else if (topic.includes(this.connection.getBaseMac())) this._handleBaseMessage(topic, decoded);
        } catch {
            // not all messages are protobuf
        }
    }

    // <MAC>/JSON_NOTIFICATION is plain JSON (not protobuf); so far only seen carrying firmware OTA progress
    // (decodeFirmwareNotification). Surface the latest phase/percent on the robot state as a transient
    // qualifier on the status; phase 0 (complete/idle) clears it. The client also expires it if it goes stale.
    _handleJsonNotification(topic, message) {
        if (!topic.includes(this.connection.getRobotMac())) return;
        const firmware = elements.decodeFirmwareNotification(message);
        if (!firmware) return;
        this.state.robot.firmware = firmware.active ? { phaseName: firmware.phaseName, percent: firmware.percent, updatedAt: new Date().toISOString() } : undefined;
    }

    _handleRobotMessage(topic, decoded) {
        if (topic.endsWith('ACK')) return;
        if (topic.includes('/LOG/STATUS')) this._handleRobotStatus(decoded);
        else if (topic.includes('/LOG/VERSION')) this.state.robot.version = this._version(decoded);
        else if (topic.includes('/LOG/ROBOT_POSITION')) this._handleRobotPosition(decoded);
        else if (topic.includes('/LOG/SCHEDULING_SETTINGS')) this._handleRobotSchedule(decoded);
        else if (topic.includes('/LOG/SETTINGS')) this._handleRobotSettings(decoded);
    }
    // Global robot settings (LOG/SETTINGS) for the read-only settings panel. Schedule is handled
    // separately (_handleRobotSchedule) and intentionally NOT part of this. Plain key/value object;
    // decodeRobotSettings' helper methods are functions and drop out of the JSON sent to the client.
    _handleRobotSettings(decoded) {
        const settings = elements.decodeRobotSettings(decoded);
        if (settings) {
            this.state.robot.settings = settings;
            this.state.robot.updatedSettings = new Date().toISOString();
        }
    }

    _handleBaseMessage(topic, decoded) {
        if (topic.endsWith('ACK')) return;
        if (topic.includes('/LOG/STATUS')) this._handleBaseStatus(decoded);
        else if (topic.includes('/LOG/VERSION')) this.state.base.version = this._version(decoded);
    }

    //

    _handleRobotStatus(decoded) {
        const r = this.state.robot;
        r.statusType = elements.formatRobotStatusType(elements.decodeRobotStatusType(decoded[3]));
        const errorObj = elements.decodeRobotStatusError(decoded[4]);
        // When the parent type is ERROR and we have a known (code1,code2) → "GPS searching" /
        // "Navigation initialising" / etc., the app shows the message *in place of* the ERROR
        // label. We surface it as statusMessage so the UI can prefer it without losing the raw
        // statusType (which color logic, isRobotActive, etc. still key off). When the message
        // takes over we suppress the error from statusText so it isn't shown twice.
        r.statusMessage = r.statusType === 'ERROR' && errorObj?.message ? errorObj.message : undefined;
        const info = elements.formatRobotStatusInfo(elements.decodeRobotStatusInfo(decoded[10])).replaceAll('-', '');
        const error = r.statusMessage ? '' : elements.formatRobotStatusError(errorObj).replaceAll('-', '');
        r.statusText = [info, error].filter(Boolean).join(', ');
        r.statusValid = elements.formatRobotStatusValid(elements.decodeRobotStatusValid(decoded[1]));
        r.statusFlag = elements.formatRobotStatusFlag(elements.decodeRobotStatusFlag(decoded[2]));
        r.docked = elements.formatRobotStatusDocking(elements.decodeRobotStatusDocking(decoded[13])).startsWith('yes');
        r.interventionRequired = elements.decodeRobotStatusFlag(decoded[12]);
        if (decoded[17]) {
            const battery = elements.decodeRobotBatteryStatus(decoded[17]);
            r.battery = battery ? { charge: battery.charge, capacity: battery.capacity } : undefined;
        }
        if (decoded[18]) {
            const mowing = elements.decodeRobotMowingStatus(decoded[18], this.location);
            r.mowing = mowing ? { zone: mowing.zone, zoneCompleted: mowing.zoneCompleted, gardenCompleted: mowing.gardenCompleted, strategy: mowing.strategy } : undefined;
        }
        if (decoded[19]) r.location = this._rtk(decoded[19]);
        if (decoded[20]) r.network = this._network(decoded[20]);
        r.updatedStatus = new Date().toISOString();
        this._trackZoneCompletions();
    }

    // Detect "robot left zone X" transitions and record the % complete at departure. We track
    // the active (zone, percent) on every status decode, and when the zone changes we attribute
    // the previous percent to the previous zone — provided it meets the threshold (filters out
    // aborted starts where the robot drove out and immediately came back).
    _trackZoneCompletions() {
        const r = this.state.robot;
        const m = r.mowing;
        const currentZone = m && !r.docked && m.zone !== undefined && m.zone !== null ? String(m.zone) : undefined;
        const currentPercent = m && typeof m.zoneCompleted === 'number' ? m.zoneCompleted : 0;
        const previousZone = this._activeMowingZone;
        const previousPercent = this._activeMowingPercent;
        // Tag how the zone ended: a switch to ANOTHER zone is 'progressed'; leaving to a non-zone state
        // (currentZone undefined = docked / going-home / stopped) is 'docked' — a return to base, which can be
        // for many reasons (battery, schedule, rain, fault, …), so the tag is "returned", not "completed".
        if (currentZone !== previousZone && previousZone !== undefined && previousPercent >= ZONE_COMPLETION_THRESHOLD_PERCENT)
            this._appendZoneCompletions(previousZone, previousPercent, currentZone === undefined ? 'docked' : 'progressed', this._computeZoneCoverage(previousZone));
        this._activeMowingZone = currentZone;
        this._activeMowingPercent = currentZone ? currentPercent : 0;
    }

    // The thick calc: spatial coverage of the just-ended run as a cross-check on the reported %. Walks the
    // crumb buffer back to the last zone change, keeps the cutting (mow=1) fixes for this zone, projects them
    // and the zone polygon into local metres against the RTK reference, and measures swath-capsule coverage.
    // Returns a rounded percent, or undefined when we can't compute one (no perimeters / unknown zone / too
    // few fixes) — callers store undefined and the UI renders it as "no estimate".
    _computeZoneCoverage(zoneStr) {
        const ref = this.perimeters?.referencePosition;
        const zone = this.perimeters?.zones?.find((z) => String(z.id) === String(zoneStr));
        if (!ref?.latitude || !zone?.path || zone.path.length < 3) return undefined;
        const zid = Number(zoneStr);
        const s = this.crumbs;
        const pos = [];
        // newest→oldest: collect this zone's cutting fixes, stop at the previous run (a different real zone).
        for (let i = s.t.length - 1; i >= 0; i--) {
            const z = s.zone[i];
            if (z === zid) {
                if (s.mow[i]) pos.push({ ...llToMetres(s.lat[i] / 1e7, s.lng[i] / 1e7, ref), t: s.t[i] });
            } else if (z !== -1) break; // hit the prior run; -1 (transit) crumbs are skipped, not a boundary
        }
        if (pos.length < COVERAGE_MIN_CRUMBS) return undefined;
        pos.reverse(); // back to chronological for the capsule continuity gate
        const poly = zone.path.map((p) => llToMetres(p.latitude, p.longitude, ref));
        const pct = swathCoveragePercent(poly, pos, CRUMB_SWATH_M, COVERAGE_GRID_M);
        return pct === undefined ? undefined : Math.round(pct);
    }

    // Lazily project the current perimeter into local metres (+ bboxes) for the violation check. Cached and
    // rebuilt only when the perimeter reloads (which sets this._perimMetres = undefined). Combines permanent
    // and temporary obstacles — both are no-go — and connect+docking paths as legitimate-transit corridors.
    _perimGeometry() {
        if (this._perimMetres) return this._perimMetres;
        const ref = this.perimeters?.referencePosition;
        if (!ref?.latitude) return undefined;
        const rings = (list, minPts) => (list || []).filter((e) => Array.isArray(e?.path) && e.path.length >= minPts).map((e) => projectRing(e.path, ref));
        this._perimMetres = {
            zones: rings(this.perimeters.zones, 3),
            obstacles: rings([...(this.perimeters.obstacles || []), ...(this.perimeters.tempObstacles || [])], 3),
            paths: rings([...(this.perimeters.connectPaths || []), ...(this.perimeters.dockingPaths || [])], 2),
        };
        return this._perimMetres;
    }

    // Signed violation depth in cm for one position: +ve = inside an obstacle (deepest), -ve = out of bounds
    // (distance past the nearest zone edge), 0 = clean or excused. Bbox pre-reject keeps the clean case cheap.
    _violationDepthCm(latDeg, lngDeg) {
        const pm = this._perimGeometry();
        if (!pm || pm.zones.length === 0) return 0;
        const { x, y } = llToMetres(latDeg, lngDeg, this.perimeters.referencePosition);
        const cap = (m) => Math.min(Math.round(m * 100), VIOLATION_DEPTH_CAP_CM);
        // inside any obstacle? (always a violation — covers transit-through-obstacle). Take the deepest.
        let deepest = 0;
        for (const o of pm.obstacles) {
            if (x < o.mnx || x > o.mxx || y < o.mny || y > o.mxy) continue; // bbox reject
            if (pointInPolygon(x, y, o.pts)) {
                const d = distToRingEdges(x, y, o.pts);
                if (d > deepest) deepest = d;
            }
        }
        if (deepest > 0) return cap(deepest);
        // inside any zone? then it's in bounds — clean.
        for (const z of pm.zones) {
            if (x < z.mnx || x > z.mxx || y < z.mny || y > z.mxy) continue;
            if (pointInPolygon(x, y, z.pts)) return 0;
        }
        // outside every zone: excuse legitimate transit (on a path corridor, or manoeuvring at the dock)
        if (Math.hypot(x, y) <= VIOLATION_BASE_RADIUS_M) return 0;
        for (const p of pm.paths) if (distToPolyline(x, y, p.pts) <= VIOLATION_PATH_CORRIDOR_M) return 0;
        // genuinely out of bounds: depth = distance past the nearest zone boundary, negative
        let nearest = Infinity;
        for (const z of pm.zones) {
            const d = distToRingEdges(x, y, z.pts);
            if (d < nearest) nearest = d;
        }
        return nearest === Infinity ? 0 : -cap(nearest);
    }

    _appendZoneCompletions(zone, percent, trigger, coveragePct) {
        const rounded = Math.round(percent);
        // De-dupe transient oscillations: if the most recent record for this zone is within the
        // dedupe window, treat the new event as a continuation of the same session and update
        // it in-place (bumping percent to whichever is higher, refreshing the timestamp). This
        // stops a stuck/retried robot from filling the log with identical entries.
        let recent;
        for (let i = this.zoneCompletions.length - 1; i >= 0; i--) {
            if (this.zoneCompletions[i].zone === zone) {
                recent = this.zoneCompletions[i];
                break;
            }
        }
        if (recent && Date.now() - recent.t < ZONE_COMPLETION_DEDUPE_WINDOW_MS) {
            const merged = Math.max(recent.percent, rounded);
            if (merged !== recent.percent || recent.trigger !== trigger || coveragePct !== undefined || Date.now() - recent.t > 30_000) {
                recent.percent = merged;
                recent.trigger = trigger; // the merged session's tag reflects how it most recently ended
                if (coveragePct !== undefined) recent.coveragePct = coveragePct; // freshest estimate for the merged run
                recent.t = Date.now();
                this.zoneCompletionsDirty = true;
            }
            return;
        }
        this.zoneCompletions.push({ zone, percent: rounded, t: Date.now(), trigger, coveragePct });
        this._pruneZoneCompletions();
        this.zoneCompletionsDirty = true;
        const covNote = coveragePct === undefined ? '' : `, ~${coveragePct}% covered`;
        this.logger(`WebStatus: zone ${zone} completion ${rounded}% (${trigger})${covNote} recorded`);
    }

    // Two-axis prune: by absolute age (zoneCompletionDays) and per-zone count cap. The latter
    // keeps any one zone's history from monopolising the cache if the robot oscillates there.
    _pruneZoneCompletions() {
        const cutoff = Date.now() - this.zoneCompletionDays * 24 * 60 * 60 * 1000;
        this.zoneCompletions = this.zoneCompletions.filter((c) => c.t >= cutoff);
        const perZone = new Map();
        let pruned = false;
        for (let i = this.zoneCompletions.length - 1; i >= 0; i--) {
            const entry = this.zoneCompletions[i];
            const count = (perZone.get(entry.zone) || 0) + 1;
            perZone.set(entry.zone, count);
            if (count > ZONE_COMPLETIONS_PER_ZONE_KEEP) {
                entry._drop = true;
                pruned = true;
            }
        }
        this.zoneCompletions = this.zoneCompletions.filter((c) => !c._drop);
        return pruned;
    }

    // Serialise for the wire: per-zone cap of ZONE_COMPLETIONS_PER_ZONE_SERVE, sorted newest-first
    // across all zones (so the client can render "most recent overall" as entry [0]).
    _serializeZoneCompletions() {
        const out = [];
        const perZone = new Map();
        for (const entry of [...this.zoneCompletions].sort((a, b) => b.t - a.t)) {
            const count = (perZone.get(entry.zone) || 0) + 1;
            perZone.set(entry.zone, count);
            if (count <= ZONE_COMPLETIONS_PER_ZONE_SERVE) out.push(entry);
        }
        return out;
    }

    _filenameZoneCompletions() {
        const mac = String(this.state.robot.mac || 'unknown').replaceAll(':', '');
        return path.join(this.persistDir, `stiga-zonecompletions-${mac}.json.gz`);
    }

    _saveZoneCompletions() {
        if (this.zoneCompletionsDirty)
            try {
                const json = JSON.stringify({ version: 3, robotMac: this.state.robot.mac, savedAt: new Date().toISOString(), retentionDays: this.zoneCompletionDays, completions: this.zoneCompletions });
                fs.writeFileSync(this._filenameZoneCompletions(), zlib.gzipSync(json));
                this.zoneCompletionsDirty = false;
            } catch (e) {
                this.logger(`WebStatus: zone-completions save failed: ${e.message}`);
            }
    }

    _loadZoneCompletions() {
        const file = this._filenameZoneCompletions();
        if (fs.existsSync(file))
            try {
                const json = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
                const data = JSON.parse(json);
                if (Array.isArray(data?.completions)) {
                    this.zoneCompletions = data.completions;
                    this.zoneCompletionsDirty = this._pruneZoneCompletions();
                    this.logger(`WebStatus: zone-completions load ${this.zoneCompletions.length} from ${file}`);
                }
            } catch (e) {
                this.logger(`WebStatus: zone-completions load failed: ${e.message}`);
            }
    }

    _handleRobotPosition(decoded) {
        if (!decoded[1] || !decoded[2]) return;
        const position = elements.decodeRobotPosition(decoded, this.location);
        if (!position) return;
        const r = this.state.robot;
        r.latitude = position.latitude;
        r.longitude = position.longitude;
        r.offsetDistanceMetres = position.offsetDistanceMetres;
        r.offsetCompass = position.offsetCompass;
        r.orientationCompass = position.orientationCompass;
        r.updatedPosition = new Date().toISOString();
        this._trackCrumbs(position.latitude, position.longitude);
    }

    // Compact the schedule down to just what the client needs to compute "next mow": a flag
    // for whether scheduling is on, and the list of weekly time blocks with their start time.
    _handleRobotSchedule(decoded) {
        // Field 2 carries the packed per-day timeblocks as a bytes blob — protobufDecode
        // surfaces it as a string by default, so we must re-byte it before decode walks it.
        // Same shim MonitorProcessor uses; without it the decoder returns an empty schedule.
        // Stash the raw [2] blocks (hex) so the enable/disable toggle can resend them verbatim.
        if (decoded[2] !== undefined) this.scheduleBlocks = decoded[2];
        const schedule = elements.decodeRobotScheduleSettings({ ...decoded, 2: stringToBytes(decoded[2] || '') });
        if (schedule) {
            const blocks = [];
            for (const day of schedule.days || [])
                for (const block of day.timeBlocks || [])
                    blocks.push({
                        dayIndex: day.dayIndex,
                        dayName: day.dayName,
                        startHour: block.startTime?.hour ?? Math.floor(block.startSlot / 2),
                        startMinute: block.startTime?.minute ?? (block.startSlot % 2) * 30,
                        durationMinutes: block.durationMinutes,
                        displayTime: block.displayTime,
                    });
            this.state.robot.schedule = { enabled: schedule.enabled, blocks };
            this.state.robot.updatedSchedule = new Date().toISOString();
        }
    }

    // mirror of the client crumbColor mapping — kept in sync so cached crumbs render the same
    // colours as live ones recorded by the browser. Pure function of the current robot state.
    _serverCrumbColor() {
        const r = this.state.robot;
        if (!r) return '#ffffff';
        if (/error|fault|stuck|blocked|fail|trapped/i.test(r.statusText || '')) return '#ea4335';
        const t = (r.statusType || '').toUpperCase();
        if (t === 'ERROR' || t === 'BLOCKED' || t === 'LID_OPEN') return '#ea4335';
        if (t === 'MOWING' || t === 'CUTTING_BORDER') return '#34a853';
        if (t === 'GOING_HOME' || t === 'NAVIGATING_TO_AREA' || t === 'REACHING_FIRST_POINT' || t === 'PLANNING_ONGOING') return '#ffffff';
        return '#fbbc04';
    }

    _trackCrumbs(lat, lng) {
        const r = this.state.robot;
        if (r.docked) return; // don't collect crumbs while parked — the robot just sits on the dock reporting the same spot
        const zone = r.mowing && !r.docked && r.mowing.zone !== undefined && r.mowing.zone !== null ? Number(r.mowing.zone) : -1;
        const color = this._serverCrumbColor();
        // mow flag: 1 = actively cutting (MOWING/CUTTING_BORDER), 0 = otherwise. The coverage calc only counts
        // cutting fixes — driving to/from a zone or pausing in it shouldn't paint coverage.
        const st = (r.statusType || '').toUpperCase();
        const mow = st === 'MOWING' || st === 'CUTTING_BORDER' ? 1 : 0;
        // Geofence violation depth for THIS fix, against the perimeter as it is right now (temp obstacles are
        // transient — capture-time is the only correct moment). Mirror the current value into state so the
        // browser can flag the live position and border the "!" button without re-doing the geometry.
        const vdepth = this._violationDepthCm(lat, lng);
        r.violationDepthCm = vdepth;
        // For red ("alarm") crumbs capture a short fault text (stored full-size inline in the err column —
        // ~2% of crumbs, so cheap). lat/lng are scaled to 1e7 ints (~1cm) inside crumbPush.
        const err = color === '#ea4335' ? [r.statusMessage || r.statusType, r.statusText].filter(Boolean).join(' · ') || undefined : undefined;
        crumbPush(this.crumbs, lat, lng, Date.now(), Number.isFinite(zone) ? zone : -1, color, err, mow, vdepth);
        this._pruneCrumbs();
        this.crumbsDirty = true;
    }

    // Drop crumbs older than the retention window from the front of every column (kept aligned).
    _pruneCrumbs() {
        const cutoff = Date.now() - this.persistDays * 24 * 60 * 60 * 1000;
        const s = this.crumbs;
        let k = 0;
        while (k < s.t.length && s.t[k] < cutoff) k++;
        if (k === 0) return false;
        s.lat.splice(0, k);
        s.lng.splice(0, k);
        s.t.splice(0, k);
        s.zone.splice(0, k);
        s.col.splice(0, k);
        s.err.splice(0, k);
        s.mow.splice(0, k);
        s.vdepth.splice(0, k);
        return true;
    }

    _filenameCrumbs() {
        const mac = String(this.state.robot.mac || 'unknown').replaceAll(':', '');
        return path.join(this.persistDir, `stiga-crumbs-${mac}.json.gz`);
    }

    // Persist as gzipped JSON (v3 columnar): the parallel arrays dumped verbatim. Still gunzip+jq
    // inspectable. The full file is rewritten each tick — fine at /dev/shm speeds and crumb cadence.
    _saveCrumbs() {
        if (this.crumbsDirty)
            try {
                const s = this.crumbs;
                const json = JSON.stringify({
                    version: 5,
                    robotMac: this.state.robot.mac,
                    savedAt: new Date().toISOString(),
                    retentionDays: this.persistDays,
                    pal: s.pal,
                    lat: s.lat,
                    lng: s.lng,
                    t: s.t,
                    zone: s.zone,
                    col: s.col,
                    err: s.err,
                    mow: s.mow,
                    vdepth: s.vdepth,
                });
                fs.writeFileSync(this._filenameCrumbs(), zlib.gzipSync(json));
                this.crumbsDirty = false;
            } catch (e) {
                this.logger(`WebStatus: crumbs save failed: ${e.message}`);
            }
    }

    _loadCrumbs() {
        const file = this._filenameCrumbs();
        if (fs.existsSync(file))
            try {
                const json = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
                const data = JSON.parse(json);
                if (!Array.isArray(data?.t)) return; // only the columnar persist is supported (v4+)
                // vdepth (v5) is the only field that may be absent in a current file; missing → zeros now and a
                // one-off backfill once perimeters load. (Pre-v4 object-array persists are no longer migrated.)
                const vdepth = Array.isArray(data.vdepth) ? data.vdepth : data.t.map(() => 0);
                if (!Array.isArray(data.vdepth)) this._violationBackfillPending = true;
                this.crumbs = { lat: data.lat || [], lng: data.lng || [], t: data.t || [], zone: data.zone || [], col: data.col || [], err: data.err || [], mow: data.mow || data.t.map(() => 0), vdepth, pal: data.pal || [] };
                this.crumbsDirty = this._pruneCrumbs() || !Array.isArray(data.vdepth); // re-persist as v5 if migrated
                this.logger(`WebStatus: crumbs load ${this.crumbs.t.length} from ${file}`);
            } catch (e) {
                this.logger(`WebStatus: crumbs load failed: ${e.message}`);
            }
    }

    _handleBaseStatus(decoded) {
        const b = this.state.base;
        b.status = {
            type: elements.formatBaseStatusType(elements.decodeBaseStatusType(decoded[1])),
            value: elements.formatBaseStatusValue(elements.decodeBaseStatusValue(decoded[2])),
            detail: elements.formatBaseStatusDetail(elements.decodeBaseStatusDetail(decoded[3])),
            flag: elements.formatBaseStatusFlag(elements.decodeBaseStatusFlag(decoded[4])),
            led: elements.formatBaseSettingLED(elements.decodeBaseSettingLED(decoded[10])),
        };
        if (decoded[8]) b.location = this._rtk(decoded[8]);
        if (decoded[9]) b.network = this._network(decoded[9]);
        b.updatedStatus = new Date().toISOString();
    }

    _version(decoded) {
        const version = elements.decodeVersion(decoded);
        return version ? { hardware: version.hardware, firmware: version.firmware, build: version.build, modem: version.modem } : undefined;
    }

    _rtk(decoded) {
        const location = elements.decodeLocationStatus(decoded);
        return location ? { satellites: location.satellites, coverage: location.coverage, offsetDistance: location.offsetDistance, rtkQuality: location.rtkQuality } : undefined;
    }

    _network(decoded) {
        const network = elements.decodeNetworkStatus(decoded);
        if (!network) return undefined;
        return {
            name: formatNetworkId(String(network.network)).replaceAll("'", ''),
            type: network.type,
            band: network.band,
            rssi: network.rssi,
            rsrp: network.rsrp,
            rsrq: network.rsrq,
            sq: network.sq,
        };
    }

    // A flat, stable, versioned projection of the live state for external integrations (Home Assistant,
    // scripts, dashboards). Unlike /api/state — which mirrors the internal UI model and may change shape as
    // the page evolves — the field names and structure here are a deliberate contract: additive changes only,
    // a breaking change bumps the `schema` string. See integration/INTEGRATION.md.
    _summary() {
        /* eslint-disable unicorn/no-null -- explicit JSON null is intentional: every contract key stays present so consumers (HA templates) see a stable shape; undefined would silently drop keys. */
        const r = this.state.robot,
            b = this.state.base;
        const now = Date.now();
        const stamps = [r.updatedStatus, r.updatedPosition, b.updatedStatus].map((s) => (s ? Date.parse(s) : 0));
        const freshest = Math.max(0, ...stamps);
        const type = (r.statusType || '').toUpperCase();
        const active = ['MOWING', 'CUTTING_BORDER', 'REACHING_FIRST_POINT', 'NAVIGATING_TO_AREA', 'PLANNING_ONGOING', 'GOING_HOME'].includes(type);
        const errored = type === 'ERROR' || type === 'BLOCKED' || type === 'LID_OPEN' || Boolean(r.interventionRequired) || /error|fault|stuck|blocked|fail|trapped/iu.test(r.statusText || '');
        return {
            schema: 'stiga-summary/1',
            generated: new Date().toISOString(),
            online: freshest > 0 && now - freshest < SUMMARY_STALE_MS,
            age_seconds: freshest > 0 ? Math.round((now - freshest) / 1000) : null,
            robot: {
                name: r.name ?? null,
                mac: r.mac ?? null,
                status: r.statusType ?? null,
                status_detail: r.statusMessage || r.statusText || null,
                docked: r.docked ?? null,
                active,
                error: errored,
                intervention_required: Boolean(r.interventionRequired),
                battery_percent: r.battery?.charge ?? null,
                latitude: r.latitude ?? null,
                longitude: r.longitude ?? null,
                heading_compass: r.orientationCompass ?? null,
                distance_from_base_m: r.offsetDistanceMetres ?? null,
                zone: r.mowing?.zone ?? null,
                zone_completed_percent: r.mowing?.zoneCompleted ?? null,
                garden_completed_percent: r.mowing?.gardenCompleted ?? null,
                satellites: r.location?.satellites ?? null,
                rtk_quality_percent: r.location?.rtkQuality ?? null,
                gps_coverage: r.location?.coverage ?? null,
                signal_rssi_dbm: r.network?.rssi ?? null,
                firmware: r.version?.firmware ?? null,
                schedule_enabled: r.schedule?.enabled ?? null,
                updated_status: r.updatedStatus ?? null,
                updated_position: r.updatedPosition ?? null,
            },
            base: {
                mac: b.mac ?? null,
                latitude: b.latitude ?? null,
                longitude: b.longitude ?? null,
                satellites: b.location?.satellites ?? null,
                rtk_quality_percent: b.location?.rtkQuality ?? null,
                gps_coverage: b.location?.coverage ?? null,
                firmware: b.version?.firmware ?? null,
                updated_status: b.updatedStatus ?? null,
            },
        };
        /* eslint-enable unicorn/no-null */
    }

    // fetch the garden perimeters from the Cloud (once, at startup). Uses the perimeter
    // referencePosition as the RTK origin so zones and the robot share one frame. The
    // authenticated cloud connection is cached on `this.cloudServer` for reuse by the
    // notifications poll.
    async _loadPerimeters() {
        if (!this.username || !this.password) {
            this.logger('WebStatus: no credentials supplied — zones disabled');
            return;
        }
        const auth = new StigaAPIAuthentication(this.username, this.password);
        if (!(await auth.isValid())) throw new Error('authentication failed');
        const server = new StigaAPIConnectionServer(auth);
        if (!(await server.isConnected())) throw new Error('server connection failed');
        this.cloudServer = server;
        const garage = new StigaAPIGarage(server);
        if (!(await garage.load())) throw new Error('garage load failed');
        const device = garage.getDevice(this.connection.getRobotMac()) || (garage.getDevices() || [])[0];
        if (!device) throw new Error('no device in garage');
        // User-assigned device name from the cloud (e.g. "Stiga Stuga"). Surfaced in the
        // webstatus title so the kiosk shows the user's pet name instead of a generic label.
        // Falls back to undefined; client renders "Stiga Robot" when absent.
        const deviceName = (await device.getName())?.value;
        if (deviceName) this.state.robot.name = deviceName;
        // Cloud-only settings (from the garage, not MQTT) for the settings panel. Only the supported ones.
        this.state.robot.cloudSettings = { autoUpdate: (await device.getAutoUpdate())?.value };
        const perimeters = new StigaAPIPerimeters(server, device);
        if (!(await perimeters.load())) throw new Error('perimeter load failed');

        const ref = perimeters.getReferencePosition();
        this.perimeters = {
            referencePosition: ref,
            zones: perimeters.getZones().map((zone) => ({ id: zone.getId(), name: zone.getName(), area: zone.getArea(), path: zone.getPath() })),
            closedZones: perimeters.getClosedZones().map((zone) => ({ id: zone.getId(), name: zone.getName(), area: zone.getArea(), path: zone.getPath() })),
            obstacles: perimeters.getObstacles().map((obstacle) => ({ id: obstacle.getId(), area: obstacle.getArea(), path: obstacle.getPath() })),
            tempObstacles: perimeters.getTempObstacles().map((obstacle) => ({ id: obstacle.getId(), area: obstacle.getArea(), path: obstacle.getPath() })),
            connectPaths: perimeters.getConnectPaths().map((p) => ({ id: p.getId(), fromZone: p.getFromZone(), toZone: p.getToZone(), path: p.getPath() })),
            dockingPaths: perimeters.getDockingPaths().map((p) => ({ id: p.getId(), fromZone: p.getFromZone(), toZone: p.getToZone(), path: p.getPath() })),
            pickupPoints: perimeters.getPickupPoints(),
            // Per-zone settings for the read-only settings panel: { id, name, cuttingHeight, cuttingMode,
            // priority, customAngleActive, customAngle, borderCut }. Cloud-sourced (reloaded on refresh).
            zoneSettings: perimeters.getAllZoneSettings(),
        };
        this._perimMetres = undefined; // invalidate the projected-metre cache; rebuilt lazily on next check
        if (ref?.latitude && ref?.longitude) {
            this.location = ref;
            this.state.base.latitude = ref.latitude;
            this.state.base.longitude = ref.longitude;
        }
        this.logger(
            `WebStatus: loaded ${this.perimeters.zones.length} zones (+${this.perimeters.closedZones.length} closed), ` +
                `${this.perimeters.obstacles.length} obstacles (+${this.perimeters.tempObstacles.length} temp), ` +
                `${this.perimeters.connectPaths.length} connect-paths, ${this.perimeters.dockingPaths.length} docking-paths, ` +
                `${this.perimeters.pickupPoints.length} pickup-points`
        );
        this._backfillCrumbViolations(); // one-off: populate vdepth on crumbs migrated from a pre-violation persist
    }

    // One-time migration helper: when crumbs were loaded from a v3/v4 persist (no vdepth column), they come in
    // flagged _violationBackfillPending. Once the perimeter is available we compute each crumb's vdepth against
    // the CURRENT map and persist forward as v5, so it never runs again. Not temporally exact for crumbs from
    // when a since-changed temp obstacle existed, but it lights up recent incidents (whose temp obstacle is
    // still present) and is correct for the unchanging zones + permanent obstacles.
    _backfillCrumbViolations() {
        if (!this._violationBackfillPending || !this._perimGeometry()) return;
        const s = this.crumbs;
        let hits = 0;
        for (let i = 0; i < s.t.length; i++) {
            const v = this._violationDepthCm(s.lat[i] / 1e7, s.lng[i] / 1e7);
            s.vdepth[i] = v;
            if (Math.abs(v) >= VIOLATION_MARGIN_CM) hits++;
        }
        this._violationBackfillPending = false;
        this.crumbsDirty = true; // re-persist as v5 so this is a one-time cost
        this.logger(`WebStatus: backfilled violation depth on ${s.t.length} crumbs (${hits} over threshold)`);
    }

    // poll the cloud for notifications. Frequency is adaptive: a fast cadence while the
    // robot is undocked (where messages tend to arrive), and a slow cadence while it is
    // parked. Self-rescheduling so the interval is recomputed each tick from current state.
    _startNotificationPoll() {
        if (this.cloudServer) {
            const tick = async () => {
                try {
                    const notifications = new StigaAPINotifications(this.cloudServer);
                    if (await notifications.load())
                        this.notifications = notifications.getAll().map((n) => ({
                            uuid: n.getUuid(),
                            title: n.getTitle(),
                            body: n.getBody(),
                            type: n.getType(),
                            category: n.getCategory(),
                            read: n.isRead(),
                            createdAt: n.getCreatedAt()?.toISOString(),
                            // decoded payload metadata (e.g. obstacle_proposal -> { obstacles:[{lat,lng,radius}] })
                            metadata: n.getMetadata(this.location),
                            // single-point event location (stuck / out-of-perimeter / skip / job-done): { x, y, latitude, longitude }
                            position: n.getPosition(this.location),
                        }));
                } catch (e) {
                    this.logger(`WebStatus: notifications poll failed (${e.message})`);
                }
                this.notificationsTimer = setTimeout(tick, this.state.robot.docked ? NOTIF_POLL_MS_DOCKED : NOTIF_POLL_MS_UNDOCKED);
            };
            tick();
        }
    }

    //

    // One-shot crumb delivery: at request time we slice the cached crumbs to the zone window
    // implied by ?tracksClr=N (default 1 — the CURRENT zone only). Time-based windowing was
    // intentionally dropped: the robot sleeps/charges between mowing sessions, so wall-clock
    // history is mostly empty space, while "current zone" tracks the activity we actually care
    // about. ?tracksClr=off delivers the entire cache (useful with --persist for diagnostics).
    // One-shot only: a page reload is required to change the window; live updates extend from
    // the last cached point.
    _renderPage(req) {
        const q = req?.query || {};
        // One-shot hydration window per ?tracksClr (see parseTracksClrSpec). Default = 1 run (current zone).
        const crumbCutoff = tracksClrCutoff(this.crumbs, parseTracksClrSpec(resolveTracks(q.tracks, q.tracksClr).window), Date.now());
        const crumbStart = crumbStartIndex(this.crumbs, crumbCutoff);
        const config = JSON.stringify({
            baseLat: this.location.latitude,
            baseLng: this.location.longitude,
            pollMs: POLL_MS,
            notifPollMs: NOTIF_POLL_MS_UNDOCKED,
            scheduleTimezone: this.scheduleTimezone,
            violationMarginCm: VIOLATION_MARGIN_CM, // |vdepth| threshold for flagging a geofence violation (tunable)
            // diagnostics are auth-gated, so only offer them when a credential is configured. The client
            // shows the 🔧 row when ?diagnostics=on AND this list is non-empty.
            diagnostics: this.basicAuth ? Object.entries(DIAGNOSTICS).map(([name, d]) => ({ name, label: d.label, icon: d.icon, type: d.type, metric: d.metric })) : [],
        });
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stiga Robot — Live Status</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect y='21' width='32' height='11' fill='%23137333'/><path fill='%2334a853' d='M2 21 L3 11 L4 21 Z M6 21 L7 13 L8 21 Z M10 21 L11 10 L12 21 Z M13 21 L14 14 L15 21 Z M17 21 L18 9 L19 21 Z M21 21 L22 12 L23 21 Z M25 21 L26 11 L27 21 Z M29 21 L30 13 L31 21 Z'/></svg>">
<style>${PAGE_CSS_OUT}</style>
</head>
<body>
<div id="map"></div>
<div id="statusbox" class="pos-lt"><div class="muted">connecting…</div></div>
<div id="cmdbox" class="pos-st pos-no"></div>
<div id="notifbox" class="pos-st empty"></div>
<div id="settingsbox" class="pos-st empty"></div>
<div id="zonepanel"></div>
<div id="schedpanel"></div>
<div id="diagoverlay"><div class="diagwin"><div class="diaghdr"><span class="diagtitle"></span><span class="diagtools"><span class="diagcopy" title="copy" onclick="copyDiagnosticOutput()">⧉ copy</span><span class="diagclose" title="close" onclick="closeDiagnosticOverlay()">×</span></span></div><pre class="diagpre"></pre></div></div>
<div id="diagslider"><span class="dslabel"></span><div class="dsgrad"></div><input type="range" min="0" max="100" value="50" oninput="onDiagSlider(this.value)" title="shift the colour boundaries to reveal gradations"></div>
<script>
var CONFIG = ${config};
var INITIAL_CRUMBS = ${JSON.stringify(encodeCrumbsWire(this.crumbs, crumbStart))};
var INITIAL_STATE = ${JSON.stringify({ generated: new Date().toISOString(), ...this.state, zoneCompletions: this._serializeZoneCompletions() })};
var INITIAL_NOTIFICATIONS = ${JSON.stringify(this.notifications)};
var CUTTING_MODE_LABELS = ${JSON.stringify(elements.getCuttingModeLabels())};
</script>
<script>${CLIENT_JS_OUT}</script>
<script async src="https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(this.apiKey)}&loading=async&callback=initMap&libraries=marker"></script>
</body>
</html>`;
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const PAGE_CSS = `
html,body{margin:0;height:100%}
#map{height:100%;width:100%;background:#222}
.pos-lt{top:12px;left:12px;right:auto;bottom:auto}
.pos-rt{top:12px;right:12px;left:auto;bottom:auto}
.pos-lb{bottom:12px;left:12px;right:auto;top:auto}
.pos-rb{bottom:12px;right:12px;left:auto;top:auto}
.pos-no{display:none !important}
.pos-st{right:auto;bottom:auto;box-sizing:border-box} /* stacked under status box; top/left/width set by JS — border-box so the width set in JS includes the notif-box padding */
#statusbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:9px 13px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:13px/1.45 system-ui,Segoe UI,Arial,sans-serif;min-width:200px;color:#202124}
#statusbox h1{font-size:13px;margin:0 0 6px;display:flex;align-items:center}
#statusbox .row{display:flex;justify-content:space-between;gap:18px}
#statusbox .k{color:#80868b}
#statusbox .v{font-weight:600;text-align:right}
#statusbox .v.mowstrat{font-weight:400;font-size:11px;color:#80868b;cursor:default}
#statusbox .v.alert{animation:statusAlertFlash 1.1s ease-in-out infinite;padding:1px 7px;border-radius:5px}
#statusbox .v.fwupd{color:#a142f4} /* firmware OTA progress qualifier (purple, distinct from green/red/blue) */
@keyframes statusAlertFlash{0%,100%{background:#ffffff;color:#202124}50%{background:#ea4335;color:#ffffff}}
#statusbox .muted{color:#9aa0a6;font-size:11px;margin-top:5px}
.dot{width:9px;height:9px;border-radius:50%;margin-right:6px;display:inline-block}
.infobox{font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;max-width:280px;color:#202124}
.infobox h2{font-size:13px;margin:0 0 5px}
.infobox table{border-collapse:collapse;width:100%}
.infobox td{padding:1px 0;vertical-align:top}
.infobox td.k{color:#80868b;padding-right:12px;white-space:nowrap}
.infobox .muted{color:#9aa0a6;margin-top:4px}
#statusbox .tracks{margin-top:6px;font-size:11px;color:#80868b}
#statusbox .btn{display:inline-block;vertical-align:middle;cursor:pointer;border:1px solid #c4c7c5;border-radius:3px;padding:0 6px;margin-left:4px;color:#202124;user-select:none}
/* tracks cluster: a tight segmented box — child buttons drop their own border/radius/margin and share thin dividers */
#statusbox .btngroup{display:inline-flex;vertical-align:middle;margin-left:4px;border:1px solid #c4c7c5;border-radius:3px;overflow:hidden}
#statusbox .btngroup .btn{margin-left:0;border:0;border-left:1px solid #c4c7c5;border-radius:0}
#statusbox .btngroup .btn:first-child{border-left:0}
#statusbox .btn.on{background:#34a853;border-color:#34a853;color:#fff}
/* discreet "look under the hood" cue: a red border ring + soft glow, layered over either the default or .on
   state via box-shadow so it shows regardless. Deliberately static (no pulse) so false positives stay quiet. */
#statusbox .btn.alert{border-color:#ea4335;box-shadow:0 0 0 1px #ea4335,0 0 4px rgba(234,67,53,.6)}
#statusbox .btn.dirty{background:#ea4335;border-color:#ea4335;color:#fff;animation:wheelDirtyPulse 1.3s ease-in-out infinite}
@keyframes wheelDirtyPulse{0%,100%{opacity:1}50%{opacity:.5}}
#statusbox .btn.busy{opacity:.4;pointer-events:none}
/* diagnostics drawer row (🔧) under the tracks row */
#statusbox .tracks.diag,#statusbox .tracks.perim{display:flex;align-items:center;gap:6px}
#statusbox .diagbtns{margin-left:auto}
#statusbox .diagstat{font-size:11px}
#statusbox .diagstat.idle{color:#9aa0a6}
#statusbox .diagstat.run{color:#1a73e8}
#statusbox .diagstat.ready{color:#ea4335;font-weight:600;cursor:pointer;animation:statusAlertFlash 1.1s ease-in-out infinite;padding:1px 7px;border-radius:5px}
/* full-screen-ish console overlay for diagnostic output */
#diagoverlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;display:none;align-items:center;justify-content:center}
#diagoverlay.show{display:flex}
#diagoverlay .diagwin{width:80vw;height:80vh;min-width:320px;min-height:200px;background:#1e1e1e;color:#d4d4d4;border-radius:8px;box-shadow:0 10px 40px rgba(0,0,0,.5);display:flex;flex-direction:column;overflow:hidden;resize:both}
#diagoverlay .diaghdr{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#2d2d2d;border-bottom:1px solid #3a3a3a;font:13px system-ui,Segoe UI,Arial,sans-serif}
#diagoverlay .diagtitle{font-weight:600;color:#fff}
#diagoverlay .diagtools{display:flex;gap:12px;align-items:center}
#diagoverlay .diagcopy{cursor:pointer;color:#9aa0a6;font-size:12px;user-select:none}
#diagoverlay .diagcopy:hover{color:#fff}
#diagoverlay .diagclose{cursor:pointer;color:#9aa0a6;font-weight:700;font-size:18px;line-height:1;user-select:none}
#diagoverlay .diagclose:hover{color:#ea4335}
#diagoverlay .diagpre{flex:1;margin:0;padding:12px;overflow:auto;white-space:pre;font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;color:#d4d4d4}
/* heatmap midtone slider — appears with a map overlay; shifts the colour boundaries live */
#diagslider{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:900;display:none;width:240px;background:rgba(32,33,36,.85);color:#e8eaed;padding:7px 12px 9px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4);font:11px system-ui,Segoe UI,Arial,sans-serif}
#diagslider.show{display:block}
#diagslider .dslabel{display:block;text-align:center;margin-bottom:5px}
#diagslider .dsgrad{height:6px;border-radius:3px;background:linear-gradient(to right,rgb(255,0,0),rgb(255,255,0) 50%,rgb(0,255,0));margin-bottom:3px}
#diagslider input[type=range]{width:100%;margin:0;cursor:pointer;accent-color:#e8eaed}
/* box-level close × shared by the notif + settings boxes (hides the whole box) */
.boxclose{cursor:pointer;color:#9aa0a6;font-weight:700;margin-right:7px;user-select:none;font-size:13px;line-height:1}
.boxclose:hover{color:#ea4335}
#notifbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;max-width:560px;color:#202124}
#notifbox.empty{display:none}
#notifbox h2{font-size:10px;margin:0 0 6px;color:#80868b;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
#notifbox .nrow{display:flex;gap:10px;align-items:flex-start;padding:4px 0}
#notifbox .nrow + .nrow{border-top:1px solid #eee}
#notifbox .nago{color:#80868b;flex:0 0 auto;font-size:11px;white-space:nowrap;padding-top:1px}
#notifbox .ncol{flex:1 1 auto;min-width:0}
#notifbox .nline{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#notifbox .nline strong{font-weight:600}
#notifbox .nline .nsep{color:#9aa0a6;margin:0 4px}
#notifbox .nbody{color:#5f6368}
#notifbox .nrow:hover .nline{white-space:normal;overflow:visible;text-overflow:clip}
#notifbox .nmeta{display:none;font-size:11px;color:#80868b;padding-top:3px;opacity:.85}
#notifbox .nrow:hover .nmeta{display:block}
#notifbox .ndismiss{cursor:pointer;color:#5f6368;padding:0 4px;user-select:none;font-size:14px;line-height:1}
#notifbox .ndismiss:hover{color:#ea4335}
/* Read-only settings panel (stacked below status/command/notifications) */
#settingsbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;max-width:320px;color:#202124}
#settingsbox.empty{display:none}
#settingsbox h2{font-size:10px;margin:0 0 6px;color:#80868b;text-transform:uppercase;letter-spacing:.5px;font-weight:600}
#settingsbox .szsel{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 7px}
#settingsbox .szchip{cursor:pointer;min-width:16px;text-align:center;border:1px solid #c4c7c5;border-radius:4px;padding:1px 6px;font-weight:600;color:#5f6368;background:#fff;user-select:none}
#settingsbox .szchip:hover{background:#f1f3f4}
#settingsbox .szchip.on{background:#1967d2;border-color:#1967d2;color:#fff}
#settingsbox table{border-collapse:collapse;width:100%}
#settingsbox td{padding:1px 0;vertical-align:top}
#settingsbox td.k{color:#80868b;padding-right:14px;white-space:nowrap}
#settingsbox td.sv{text-align:right;font-weight:600}
#settingsbox .cloudtag{color:#1a73e8;font-size:11px;margin-left:4px}
#settingsbox .schg{color:#ea4335;font-size:18px;line-height:0;margin-right:3px;vertical-align:middle}
#statusbox h1 .linktag{margin-left:auto;font-size:9px;padding:2px 8px;border-radius:10px;
  font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:#fff;background:#9aa0a6}
#statusbox h1 .linktag.online{background:#34a853}
#statusbox h1 .linktag.stale{background:#fbbc04;color:#202124}
#statusbox h1 .linktag.offline{background:#ea4335}
#statusbox .zonelast{font-size:11px;color:#5f6368;text-align:right;cursor:default;padding:1px 0;font-weight:500}
#statusbox .zonelast:hover{color:#202124}
#zonepanel,#schedpanel{position:absolute;z-index:6;background:rgba(255,255,255,.98);border-radius:8px;
  padding:9px 13px;box-shadow:0 2px 12px rgba(0,0,0,.35);box-sizing:border-box;
  font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;color:#202124;display:none}
#zonepanel.show,#schedpanel.show{display:block}
.alarmtip{font:12px/1.45 system-ui,Segoe UI,Arial,sans-serif;max-width:280px;color:#202124}
.alarmtip .aerr{font-weight:600;color:#c5221f;margin-bottom:3px}
.alarmtip .atime{color:#80868b;font-size:11px}
#schedpanel h2{font-size:11px;margin:0 0 7px;color:#80868b;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
#schedpanel table{border-collapse:collapse;width:100%}
#schedpanel td{padding:2px 0;vertical-align:top;font-size:12px}
#schedpanel td.swhen{padding-right:12px;white-space:nowrap;font-weight:600}
#schedpanel td.stime{padding-right:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
#schedpanel td.sdur{color:#80868b;white-space:nowrap;text-align:right;font-size:11px}
#schedpanel .now{color:#137333}
#statusbox .sched-trigger{cursor:default}
#zonepanel h2{font-size:11px;margin:0 0 7px;color:#80868b;text-transform:uppercase;letter-spacing:.4px;font-weight:600}
#zonepanel table{border-collapse:collapse;width:100%}
#zonepanel td{padding:2px 0;vertical-align:top;font-size:12px}
#zonepanel td.zn{padding-right:12px;white-space:nowrap;font-weight:600}
#zonepanel td.zp{padding-right:8px;white-space:nowrap;text-align:right;color:#137333;font-variant-numeric:tabular-nums}
#zonepanel td.zc{padding-right:10px;white-space:nowrap;text-align:right;color:#9aa0a6;font-variant-numeric:tabular-nums;cursor:default}
#zonepanel td.zg{padding-right:10px;text-align:center;color:#5f6368;cursor:default}
#zonepanel td.zt{color:#80868b;white-space:nowrap;text-align:right;font-size:11px}
#statusbox .zonelast .ztrig{color:#80868b;cursor:default}
#statusbox .zonelast .zcov{color:#9aa0a6;cursor:default}
#zonepanel .zsep td{border-top:1px solid #eee;padding-top:5px}
#cmdbox{position:absolute;z-index:5;background:rgba(255,255,255,.96);
  border-radius:8px;padding:8px 12px;box-shadow:0 2px 10px rgba(0,0,0,.35);
  font:12px/1.4 system-ui,Segoe UI,Arial,sans-serif;color:#202124;
  display:flex;flex-direction:column;gap:6px;align-items:stretch}
#cmdbox .crow{display:flex;gap:8px;align-items:center}
#cmdbox .cbtn{cursor:pointer;border:1px solid #c4c7c5;border-radius:4px;padding:5px 14px;
  font-size:12px;font-weight:600;color:#202124;background:#fff;user-select:none;letter-spacing:.3px}
#cmdbox .cbtn:hover{background:#f1f3f4}
#cmdbox .cbtn:active{background:#e8eaed}
#cmdbox .cbtn.start{color:#137333;border-color:#137333}
#cmdbox .cbtn.stop{color:#c5221f;border-color:#c5221f}
#cmdbox .cbtn.home{color:#1967d2;border-color:#1967d2}
#cmdbox .cbtn.reset{color:#c5221f;border-color:#c5221f}
#cmdbox .cbtn.boot{color:#00838f;border-color:#00838f}
#cmdbox .cbtn.sched{color:#5f6368;border-color:#c4c7c5}
#cmdbox .cbtn.sched.on{background:#137333;border-color:#137333;color:#fff}
#cmdbox .cbtn.cut,#cmdbox .cbtn.edge{color:#b06000;border-color:#b06000}
#cmdbox .cbtn.zgo{color:#137333;border-color:#137333;font-size:13px;line-height:1}
#cmdbox .czone,#cmdbox .zcmd{min-width:0;font:12px system-ui,Segoe UI,Arial,sans-serif;border:1px solid #c4c7c5;border-radius:4px;padding:4px 6px;color:#202124;background:#fff;cursor:pointer}
#cmdbox .czone{flex:1 1 auto}
#cmdbox .zcmd{flex:0 1 auto}
#cmdbox .cbtn.busy{opacity:.55;pointer-events:none}
#cmdbox .cmsg{font-size:11px;color:#9aa0a6;margin-top:2px}
`;

// Client-side script. Uses only quoted strings and concatenation (no template literals,
// no backticks, no ${...}) so it can be embedded verbatim into the page template above.
const CLIENT_JS = `
var map, infoWindow, baseMarker, robotMarker, robotPin, robotArrow, robotArrowMarker;
var mowTargetMarker = null, mowTargetEl = null, mowTargetFlash = null; // yellow cut-position reticle, shown only on hover
var state = null, hovered = null, closeTimer = null, userMoved = false, didFit = false;
var perimetersDrawn = false, perimetersLoading = false;
var zonePolys = {}, zoneNames = {};
var tracksOn = true, tracksVisible = true, alarmsHighlighted = false, crumbs = makeCrumbStore(), crumbSegments = [], lastCrumbTime = null;
var notifications = [], dismissed = {};
// Hovering a notification that carries decoded geometry (e.g. obstacle_proposal -> metadata.obstacles)
// flashes it on the map — distinct purple, on/off, only while hovered. Generic: any future notification
// metadata exposing {latitude,longitude,radius} circles renders the same way.
var proposalCircles = [], proposalFlash = null; // fixed purple proposal/crosshair geometry (no longer flashes)
var leaderLines = [], savedMapView = null; // leader line(s) base->point + the map view to restore when the hover ends
var flashRedCircles = []; // large red locator ring(s) overlaid on the point — the only flashing element
var cutZones = [], cutZone = null, lastCmdSig = ''; // zone selector state ([{id,name}] from perimeters)
var zoneCmd = 'force-cut'; // selected zone-action command (extensible: force-cut, force-border-cut, …)
// Zone-action commands offered in the command dropdown (extend here to add enable/disable/etc later).
var ZONE_COMMANDS = [{ cmd: 'force-cut', label: 'Force cut' }, { cmd: 'force-border-cut', label: 'Force edge' }];
var CMD_IDLE = 'ready · awaiting command'; // command status line text when nothing is in flight (used by renderCommandBox at init)
var notifBoxClosed = false, notifClosedUuids = {}; // whole-box hide; reopens when a NEW (unseen) notification arrives
var settingsOpen = false, settingsZone = '*', zoneSettings = []; // read-only settings panel state (* = global)
// Diagnostics drawer (single-slot): one run in flight at a time; result held until viewed in the overlay.
// diagOpen toggles the 🔧 row's visibility (the 🔧 button lives in the status button row; default collapsed).
var diagState = { busy: false, running: null, ready: false, result: null }, diagOpen = false, diagHeatmap = [];
// Perimeters tool row (🗺️ button in the status row; always available — no auth/CGI gate). perimVertices is
// collected from the perimeter geometry as it's drawn (no extra fetch); the "points" toggle illuminates them.
var perimOpen = false, perimPointsOn = false, perimVertices = [], perimPointMarkers = [];
var diagPivot = 0.5; // heatmap midtone pivot (0.5 = neutral); the slider bends the value->colour curve
// The ⚙ wheel turns red when global settings change while the panel is hidden, and the panel suffixes each
// changed setting with a red dot. settingsChanged accumulates the keys that changed since the panel was last
// shown (NOT self-healing — a value that flip-flops back still counts, so multiple changes over a long unseen
// stretch are all surfaced); settingsPrev is the previous snapshot we diff each update against. A staleness
// timer (restarted on every change) clears the accumulation after a long idle stretch, so an unattended kiosk
// doesn't stay red forever.
var SETTINGS_CHANGE_EXPIRY_DEFAULT_MS = 24 * 60 * 60 * 1000;
// ?settingsAlert : 'off' or '0' disables the alert entirely; '<n>[smhd]' sets the staleness auto-clear window
// (default unit hours); absent -> default 24h. Returns { on, expiryMs }.
function parseSettingsAlert(v){
  if(v === undefined || v === null || v === '') return { on: true, expiryMs: SETTINGS_CHANGE_EXPIRY_DEFAULT_MS };
  var s = String(v).toLowerCase();
  if(s === 'off' || s === '0') return { on: false, expiryMs: 0 };
  var m = /^(\\d+(?:\\.\\d+)?)([smhd])?$/.exec(s);
  if(m){ var u = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] || 'h']; return { on: true, expiryMs: Math.round(parseFloat(m[1]) * u) }; }
  return { on: true, expiryMs: SETTINGS_CHANGE_EXPIRY_DEFAULT_MS };
}
var settingsAlertCfg = { on: true, expiryMs: SETTINGS_CHANGE_EXPIRY_DEFAULT_MS }; // re-parsed from URL_CONFIG once that's defined
var settingsPrev = null, settingsChanged = {}, settingsChangeTimer = null;
function notifByUuid(uuid){ for(var i = 0; i < notifications.length; i++) if(notifications[i].uuid === uuid) return notifications[i]; return null; }
function clearProposalCircles(){
  if(proposalFlash){ clearInterval(proposalFlash); proposalFlash = null; }
  for(var i = 0; i < proposalCircles.length; i++) proposalCircles[i].setMap(null);
  proposalCircles = [];
  for(var k = 0; k < leaderLines.length; k++) leaderLines[k].setMap(null);
  leaderLines = [];
  for(var m = 0; m < flashRedCircles.length; m++) flashRedCircles[m].setMap(null);
  flashRedCircles = [];
  restoreMapView();
}
// Overlay a large flashing red locator ring (same 1.5 m radius / red as the "!" alarm clusters) on each
// point. This is the ONLY flashing element — the underlying purple proposal/crosshair stays fixed — so a
// tiny or far-off location is easy to pick out: look for the pulsing red ring. points: [{lat,lng}, ...].
function flashRedAt(points){
  if(typeof map === 'undefined' || !map || !points || !points.length) return;
  for(var i = 0; i < points.length; i++)
    flashRedCircles.push(new google.maps.Circle({
      center: points[i], radius: 1.5,
      fillColor: '#ea4335', fillOpacity: 0.15,
      strokeColor: '#ea4335', strokeOpacity: 0.95, strokeWeight: 2,
      clickable: false, zIndex: 9, map: map
    }));
  var on = true;
  proposalFlash = setInterval(function(){ on = !on; for(var j = 0; j < flashRedCircles.length; j++) flashRedCircles[j].setVisible(on); }, 450);
}
// Snapshot the current map view once, so we can restore it when the hover ends (after fitBounds moved it).
function saveMapView(){
  if(savedMapView || typeof map === 'undefined' || !map) return;
  savedMapView = { center: map.getCenter(), zoom: map.getZoom() };
}
function restoreMapView(){
  if(!savedMapView || typeof map === 'undefined' || !map) return;
  map.setCenter(savedMapView.center); map.setZoom(savedMapView.zoom);
  savedMapView = null;
}
// The docking base position — a fixed, always-present anchor for the leader line. null until state arrives.
function basePos(){
  if(state && state.base && typeof state.base.latitude === 'number' && typeof state.base.longitude === 'number')
    return { lat: state.base.latitude, lng: state.base.longitude };
  return null;
}
// Draw a dashed sight line from the base to each target point and fit the map so the base + all points
// (and thus the whole line) are on-screen, saving the prior view for restore. Makes a tiny faraway flash
// easy to find: follow the line from the base. Dashes signal it's a temporary, transient guide; the dash
// weight (2) matches the red locator ring. points: [{lat,lng}, ...].
function locateOnMap(points){
  if(typeof map === 'undefined' || !map || !points || !points.length) return;
  saveMapView();
  var bp = basePos();
  var bounds = new google.maps.LatLngBounds();
  for(var i = 0; i < points.length; i++) bounds.extend(points[i]);
  if(bp){
    bounds.extend(bp);
    var dash = { path: 'M 0,-1 0,1', strokeColor: '#ea4335', strokeOpacity: 0.8, strokeWeight: 2, scale: 2 };
    for(var j = 0; j < points.length; j++)
      leaderLines.push(new google.maps.Polyline({ path: [bp, points[j]], strokeOpacity: 0, icons: [{ icon: dash, offset: '0', repeat: '12px' }], clickable: false, zIndex: 6, map: map }));
  }
  if(bp || points.length > 1) map.fitBounds(bounds, 80); else map.panTo(points[0]);
}
function showProposalCircles(obstacles){
  clearProposalCircles();
  if(typeof map === 'undefined' || !map) return;
  for(var i = 0; i < obstacles.length; i++){
    var o = obstacles[i];
    if(typeof o.latitude !== 'number' || typeof o.longitude !== 'number') continue;
    proposalCircles.push(new google.maps.Circle({
      center: { lat: o.latitude, lng: o.longitude }, radius: (typeof o.radius === 'number' && o.radius > 0 ? o.radius : 0.5),
      fillColor: '#ffffff', fillOpacity: 0.5, strokeColor: '#ffffff', strokeOpacity: 1, strokeWeight: 2,
      clickable: false, zIndex: 7, map: map
    }));
  }
  // The white proposal circle stays fixed at its real size; a large flashing red ring overlaid on each
  // (plus the dashed sight line) is what makes the location easy to find.
  var pts = obstacles.filter(function(o){ return typeof o.latitude === 'number' && typeof o.longitude === 'number'; }).map(function(o){ return { lat: o.latitude, lng: o.longitude }; });
  flashRedAt(pts);
  locateOnMap(pts);
}
// Single-point notification location (stuck / out-of-perimeter / skip / job-done): a fixed white
// crosshair (matching the obstacle-proposal colour, high-contrast against grass/earth) marks the exact
// spot, while a large flashing red locator ring overlaid on it makes the location easy to find.
function showProposalCrosshair(lat, lng){
  clearProposalCircles();
  if(typeof map === 'undefined' || !map) return;
  if(typeof lat !== 'number' || typeof lng !== 'number') return;
  var R = 1; // metres — matches an obstacle proposal of radius 1
  var dLat = R / 111320, dLng = R / (111320 * Math.cos(lat * Math.PI / 180));
  function arm(path){ return new google.maps.Polyline({ path: path, strokeColor: '#ffffff', strokeOpacity: 1, strokeWeight: 2, clickable: false, zIndex: 8, map: map }); }
  proposalCircles.push(arm([{ lat: lat, lng: lng - dLng }, { lat: lat, lng: lng + dLng }]));
  proposalCircles.push(arm([{ lat: lat - dLat, lng: lng }, { lat: lat + dLat, lng: lng }]));
  proposalCircles.push(new google.maps.Circle({ center: { lat: lat, lng: lng }, radius: R * 0.55, fillOpacity: 0, strokeColor: '#ffffff', strokeOpacity: 0.9, strokeWeight: 2, clickable: false, zIndex: 8, map: map }));
  flashRedAt([{ lat: lat, lng: lng }]);
  locateOnMap([{ lat: lat, lng: lng }]);
}

// Hydrate from the snapshot baked into the page so the boxes show real data from first paint
// instead of "connecting…". The first /api/state poll will replace this with fresher values,
// but even a stale snapshot is a consistent and dated view (the "Xs ago" age tells the user).
if(typeof INITIAL_STATE !== 'undefined' && INITIAL_STATE) state = INITIAL_STATE;
if(typeof INITIAL_NOTIFICATIONS !== 'undefined' && Array.isArray(INITIAL_NOTIFICATIONS)) notifications = INITIAL_NOTIFICATIONS;

// kiosk-mode URL config — query params let us position/disable boxes, lock the map,
// preset the tracks toggle and decay limit, and trim status-box contents. All optional.
//   boxStatus, boxNotify   lt|rt|lb|rb|no   (default: lt for status, lb for notify)
//   mapPosition            lat,lon,zoom     (locks map view)
//   mapControls            on|off           (off = disableDefaultUI)
//   tracks                 on|off|<window>  (tracks state + window: off disables; on/absent = default window; a window-spec e.g. tracks=8,p20k enables AND sets it. window = MAX of comma terms: N runs / pN points / tX time / off=all. #N button is a live runs display filter. default on, 1 run)
//   tracksClr              <window>         (deprecated alias for the tracks window, still honoured; a window in tracks= wins)
//   follow                 on|off           (keep the robot centred — pan to it each update; ⌖ button toggles live; default ON, follow=off disables)
//   followCenter           area|screen      (where follow centres the robot: 'area' (default) = centre of the VISIBLE area, accounting for the status/command/notification boxes; 'screen' = geometric centre of the map (old behaviour))
//   followOffset           x:y              (manual nudge applied ON TOP of followCenter, for either mode. Each value is a percentage of map width/height by default, or suffix 'px' for pixels; +x = right, +y = down. e.g. followOffset=8:0 (8% further right), followOffset=-40px:0 (40px left))
//   statusTracksControls   on|off           (default on)
//   commands               on|off           (active control panel: Start/Stop/Home; default off)
//   diagnostics            on|off           (🔧 row: run whitelisted stiga-analyse.js reports server-side into a console overlay; auth-gated like commands, single-slot; default off)
var URL_CONFIG = (function(){
  var p = new URLSearchParams(window.location.search);
  return {
    boxStatus: p.get('boxStatus'),
    boxNotify: p.get('boxNotify'),
    mapPosition: p.get('mapPosition'),
    mapControls: p.get('mapControls'),
    tracks: p.get('tracks'),
    tracksClr: p.get('tracksClr'),
    follow: p.get('follow'),
    followCenter: p.get('followCenter'),
    followOffset: p.get('followOffset'),
    statusTracksControls: p.get('statusTracksControls'),
    commands: p.get('commands'),
    diagnostics: p.get('diagnostics'),
    experimental: p.get('experimental'),
    settingsAlert: p.get('settingsAlert')
  };
})();
settingsAlertCfg = parseSettingsAlert(URL_CONFIG.settingsAlert); // now URL_CONFIG is defined; re-parse from it

// followOffset=x:y -> a manual nudge added to the follow centring. Each term is a percentage of the
// map dimension (default) or pixels (suffix 'px'); stored split so it can be resolved against the live
// map size at pan time. Returns null on absent/malformed input.
function parseFollowOffset(spec){
  if(!spec) return null;
  var parts = String(spec).split(':');
  if(parts.length !== 2) return null;
  function term(s){
    var m = s.trim().match(/^([+-]?\\d+(?:\\.\\d+)?)(px|%)?$/i);
    if(!m) return null;
    var v = Number.parseFloat(m[1]);
    return (m[2] && m[2].toLowerCase() === 'px') ? { px: v, pct: 0 } : { px: 0, pct: v };
  }
  var x = term(parts[0]), y = term(parts[1]);
  return (x && y) ? { x: x, y: y } : null;
}
var FOLLOW_OFFSET = parseFollowOffset(URL_CONFIG.followOffset);

// mapPosition supports two forms:
//   absolute: "lat,lon[,zoom]" e.g. "59.6624,12.9952,19"
//   offset:   "<dLatM>,<dLonM>[,zoom]" with m/cm unit on at least one of the first two parts,
//             e.g. "+5m,-5m" or "+23cm,0m". Offsets are applied relative to the bounding-box
//             centre of all zones, computed once the perimeters arrive.
function parseUnitToMeters(s){
  var m = (typeof s === 'string') ? s.match(/^([+-]?\\d+(?:\\.\\d+)?)(m|cm)$/i) : null;
  if(!m) return null;
  var v = Number.parseFloat(m[1]);
  return m[2].toLowerCase() === 'cm' ? v / 100 : v;
}
function parseMapPositionSpec(spec){
  if(!spec) return null;
  if(spec.trim().toLowerCase() === 'fit') return { fit: true, raw: spec }; // declarative "frame the zones"
  var parts = spec.split(',').map(function(s){ return s.trim(); });
  if(parts.length < 2) return null;
  var hasUnit = /(m|cm)$/i.test(parts[0]) || /(m|cm)$/i.test(parts[1]);
  var zoom;
  if(parts.length >= 3){ var z = Number.parseFloat(parts[2]); if(!Number.isNaN(z)) zoom = z; }
  if(hasUnit){
    var latM = parseUnitToMeters(parts[0]);
    var lonM = parseUnitToMeters(parts[1]);
    if(latM === null || lonM === null) return null;
    return { offset: { latM: latM, lonM: lonM }, zoom: zoom, raw: spec };
  }
  var lat = Number.parseFloat(parts[0]);
  var lon = Number.parseFloat(parts[1]);
  if(Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { abs: { lat: lat, lng: lon }, zoom: zoom, raw: spec };
}
function applyOffsetFromCenter(center, latM, lonM){
  var dLat = latM / 111_320;
  var dLon = lonM / (111_320 * Math.cos(center.lat * Math.PI / 180));
  return { lat: center.lat + dLat, lng: center.lng + dLon };
}

// The floating overlay panels that occlude the map. Each is anchored to a corner (or stacked under
// the status box), so the truly visible area is the map rectangle minus whatever these cover.
var OVERLAY_BOX_IDS = ['statusbox', 'cmdbox', 'notifbox', 'settingsbox', 'zonepanel', 'schedpanel'];
function visibleOverlayRects(){
  var rects = [];
  for(var i = 0; i < OVERLAY_BOX_IDS.length; i++){
    var el = document.getElementById(OVERLAY_BOX_IDS[i]);
    if(!el || el.classList.contains('pos-no') || el.classList.contains('empty')) continue;
    var cs = window.getComputedStyle(el);
    if(cs.display === 'none' || cs.visibility === 'hidden' || Number.parseFloat(cs.opacity) === 0) continue;
    var r = el.getBoundingClientRect();
    if(r.width > 0 && r.height > 0) rects.push(r);
  }
  return rects;
}
// Pixel offset from the map's geometric centre to the centre of the unoccluded (visible) area. The
// overlay boxes form a vertical lane down one side, so their WIDTH defines the visible horizontal band
// — independent of how tall they are. We deliberately do NOT gate the horizontal shift on the box
// reaching the robot's row: otherwise collapsing the stacked notif/settings boxes (which shortens the
// column so it no longer crosses the middle) would snap centring back to the screen centre. Vertical
// shifting is reserved for a box that actually spans the horizontal centre (a full-width top/bottom
// banner); the side lanes never move the robot vertically. Returns {x,y} in CSS px (x right, y down),
// unclamped (followTarget combines this with the manual nudge and clamps the total).
function visibleCenterOffsetPx(m){
  var cx = m.left + m.width / 2, cy = m.top + m.height / 2;
  var left = m.left, right = m.right, top = m.top, bottom = m.bottom;
  var rects = visibleOverlayRects();
  for(var i = 0; i < rects.length; i++){
    var r = rects[i];
    if(r.right <= cx) left = Math.max(left, r.right);        // a box wholly left of centre -> left lane
    else if(r.left >= cx) right = Math.min(right, r.left);   // a box wholly right of centre -> right lane
    else if(r.left < cx && r.right > cx){                    // straddles the vertical centre -> a banner; shift up/down
      if(r.top <= cy) top = Math.max(top, Math.min(r.bottom, cy));
      if(r.bottom >= cy) bottom = Math.min(bottom, Math.max(r.top, cy));
    }
  }
  return { x: (left + right) / 2 - cx, y: (top + bottom) / 2 - cy };
}
// The followOffset manual nudge resolved to CSS px against the live map size (% terms need the size).
function manualFollowOffsetPx(m){
  if(!FOLLOW_OFFSET) return { x: 0, y: 0 };
  return {
    x: FOLLOW_OFFSET.x.px + (FOLLOW_OFFSET.x.pct / 100) * m.width,
    y: FOLLOW_OFFSET.y.px + (FOLLOW_OFFSET.y.pct / 100) * m.height
  };
}
// The latLng to pan to so the robot lands in the centre of the VISIBLE area (followCenter=screen reverts
// to the geometric centre), plus any followOffset nudge. Converts the combined pixel offset to a lat/lng
// shift via the Web-Mercator metres-per-pixel at the current zoom/latitude (accurate enough for centring
// aesthetics): to place the robot ox px right / oy px down of centre, the map centre must sit ox px west
// and oy px north of the robot. The total is clamped to 45% so the robot is never jammed against an edge.
function followTarget(pos){
  var zoom = map.getZoom();
  if(typeof zoom !== 'number') return pos;
  var mapEl = document.getElementById('map');
  if(!mapEl) return pos;
  var m = mapEl.getBoundingClientRect();
  if(m.width === 0 || m.height === 0) return pos;
  var base = (URL_CONFIG.followCenter === 'screen') ? { x: 0, y: 0 } : visibleCenterOffsetPx(m);
  var man = manualFollowOffsetPx(m);
  var ox = base.x + man.x, oy = base.y + man.y;
  var maxX = m.width * 0.45, maxY = m.height * 0.45;
  ox = Math.max(-maxX, Math.min(maxX, ox));
  oy = Math.max(-maxY, Math.min(maxY, oy));
  if(!ox && !oy) return pos;
  var mpp = 156543.03392 * Math.cos(pos.lat * Math.PI / 180) / Math.pow(2, zoom);
  return applyOffsetFromCenter(pos, oy * mpp, -ox * mpp);
}
function computeZonesBoundsCenter(zones){
  if(!zones || zones.length === 0) return null;
  var minLat = Number.POSITIVE_INFINITY, maxLat = Number.NEGATIVE_INFINITY;
  var minLon = Number.POSITIVE_INFINITY, maxLon = Number.NEGATIVE_INFINITY;
  for(var i = 0; i < zones.length; i++){
    var path = zones[i].path || [];
    for(var j = 0; j < path.length; j++){
      var pt = path[j];
      if(pt.latitude < minLat) minLat = pt.latitude;
      if(pt.latitude > maxLat) maxLat = pt.latitude;
      if(pt.longitude < minLon) minLon = pt.longitude;
      if(pt.longitude > maxLon) maxLon = pt.longitude;
    }
  }
  return Number.isFinite(minLat) ? { lat: (minLat + maxLat) / 2, lng: (minLon + maxLon) / 2 } : null;
}
var MAP_POSITION = parseMapPositionSpec(URL_CONFIG.mapPosition);
var ZONES_CENTRE = null; // populated when perimeters arrive; used as the offset reference
var PERIMETER_BOUNDS = null; // google.maps.LatLngBounds of the zones; retained so mapPosition=fit can re-fit on resize

// tracksClr — modular trail window (mirror of the server-side parser; same syntax). The #N status button is
// a simple client-side DISPLAY filter over the crumbs already loaded: it keeps the last N contiguous runs,
// or ∞ = all. tracksClr holds that filter as a run count (or Infinity). Server hydration already trimmed the
// buffer to the URL window; this only shrinks what's drawn, and its ceiling grows as runs accumulate live.
function tcParseCount(s){
  var m = /^(\\d+(?:\\.\\d+)?)(k)?$/i.exec(s);
  return m ? Math.round(Number.parseFloat(m[1]) * (m[2] ? 1000 : 1)) : null;
}
function tcParseDuration(s){
  var m = /^(\\d+(?:\\.\\d+)?)(s|m|h|d)?$/i.exec(s);
  if(!m) return null;
  var unit = (m[2] || 's').toLowerCase();
  var mult = unit === 'd' ? 86400000 : unit === 'h' ? 3600000 : unit === 'm' ? 60000 : 1000;
  return Math.round(Number.parseFloat(m[1]) * mult);
}
function parseTracksClrSpec(raw){
  var spec = { off: false, runs: null, points: null, timeMs: null };
  if(raw === null || raw === undefined) return spec;
  var toks = String(raw).split(',');
  for(var i = 0; i < toks.length; i++){
    var t = toks[i].trim().toLowerCase();
    if(t === '') continue;
    if(t === 'off' || t === 'inf' || t === '∞'){ spec.off = true; continue; }
    if(t.charAt(0) === 'p'){ var pv = tcParseCount(t.slice(1)); if(pv !== null) spec.points = spec.points === null ? pv : Math.max(spec.points, pv); continue; }
    if(t.charAt(0) === 't'){ var tv = tcParseDuration(t.slice(1)); if(tv !== null) spec.timeMs = spec.timeMs === null ? tv : Math.max(spec.timeMs, tv); continue; }
    var rv = Number.parseInt(t, 10);
    if(!Number.isNaN(rv) && rv >= 0) spec.runs = spec.runs === null ? rv : Math.max(spec.runs, rv);
  }
  return spec;
}
// Columnar crumb store (mirror of the server form): parallel arrays + colour palette + inline err column.
// lat/lng are 1e7-scaled ints; accessors hand back degrees / hex. zone is an int, -1 = unzoned.
function makeCrumbStore(){ return { lat:[], lng:[], t:[], zone:[], col:[], err:[], mow:[], vdepth:[], pal:[] }; }
var VIOLATION_MARGIN_CM = CONFIG.violationMarginCm || 20; // |vdepth| at/above this counts as a violation
var VIOLATION_RECENT_MS = 20 * 60 * 1000; // a violation within this window borders the "!" button
function isViolation(vd){ return Math.abs(vd || 0) >= VIOLATION_MARGIN_CM; }
// True if any crumb within the recent window breached the margin — drives the discreet "!" button border.
// Walks newest→oldest and stops at the window edge, so it only ever touches the tail (cheap each poll).
function hasRecentViolation(){
  var cutoff = Date.now() - VIOLATION_RECENT_MS;
  for(var i = crumbs.t.length - 1; i >= 0; i--){ if(crumbs.t[i] < cutoff) break; if(isViolation(crumbs.vdepth[i])) return true; }
  return false;
}
function crumbN(){ return crumbs.t.length; }
function crumbPalIdx(hex){ var k = crumbs.pal.indexOf(hex); if(k < 0){ k = crumbs.pal.length; crumbs.pal.push(hex); } return k; }
// Number of distinct contiguous runs currently in the client crumb buffer (a run = a contiguous one-zone
// span; revisiting a zone is a new run). This is the live ceiling for the #N filter — it grows over time.
function availableRuns(){
  var runs = 0, cur, hasCur = false, n = crumbN();
  for(var i = 0; i < n; i++){
    var z = crumbs.zone[i];
    if(z === -1) continue;
    if(!hasCur || z !== cur){ runs++; cur = z; hasCur = true; }
  }
  return Math.max(runs, 1);
}
// Cutoff t for "keep last N contiguous runs" (client mirror of tracksClrRunsCutoff) — drives the display decay.
function runsCutoffClient(n){
  n = Math.max(n, 1);
  var runs = 0, cur, hasCur = false, len = crumbN();
  for(var i = len - 1; i >= 0; i--){
    var z = crumbs.zone[i];
    if(z === -1) continue;
    if(!hasCur || z !== cur){
      runs++;
      if(runs > n) return (i+1 < len) ? crumbs.t[i+1] : crumbs.t[i];
      cur = z; hasCur = true;
    }
  }
  return Number.NEGATIVE_INFINITY;
}
// Resolve the tracks + tracksClr params into { on, window }. tracks may be 'on' | 'off' | a window-spec; a
// spec both enables tracks AND sets the window (new combined form, e.g. ?tracks=8,p20k). 'on'/'off'/absent
// fall back to tracksClr for the window (backwards compat). See parseTracksClrSpec for the window grammar.
function resolveTracks(tracksParam, tracksClrParam){
  if(tracksParam === 'off') return { on: false, window: tracksClrParam };
  if(tracksParam === null || tracksParam === undefined || tracksParam === '' || tracksParam === 'on') return { on: true, window: tracksClrParam };
  return { on: true, window: tracksParam };
}
var trackCfg = resolveTracks(URL_CONFIG.tracks, URL_CONFIG.tracksClr);
tracksOn = trackCfg.on;
// Initial display filter (count of contiguous runs, or Infinity = all) from the resolved window: a bare
// run-count spec selects that many; off/points/time/combos show everything hydrated (dial down with #N);
// no window = 1 (current run).
var tracksClr = 1;
(function(){
  if(trackCfg.window === null || trackCfg.window === undefined) return;
  var spec = parseTracksClrSpec(trackCfg.window);
  if(spec.off || spec.points !== null || spec.timeMs !== null) { tracksClr = Number.POSITIVE_INFINITY; return; }
  if(spec.runs !== null) tracksClr = Math.max(spec.runs, 1);
  else tracksClr = Number.POSITIVE_INFINITY;
})();
// follow: keep the robot centred — the map pans to the robot on each position update. On by default;
// ?follow=off disables it, and the ⌖ status-box button toggles it live.
var followMode = URL_CONFIG.follow !== 'off';

// ---- diagnostics drawer ----------------------------------------------------------------------------------
// Shown (🔧 row under the tracks row) only when ?diagnostics=on AND the server offered some (it only does so
// when auth is configured, since /api/diagnostic shells out and is auth-gated). Single-slot: while one runs
// the buttons disable; the result is held and flashed as "ready" until opened in the overlay.
function diagnosticsAvailable(){
  return URL_CONFIG.diagnostics === 'on' && typeof CONFIG !== 'undefined' && Array.isArray(CONFIG.diagnostics) && CONFIG.diagnostics.length > 0;
}
// The 🔧 button (in the status button row) toggles this row open/closed.
function toggleDiagnostics(){ diagOpen = !diagOpen; renderStatusBox(); }
function diagConfig(name){ for(var i = 0; i < CONFIG.diagnostics.length; i++) if(CONFIG.diagnostics[i].name === name) return CONFIG.diagnostics[i]; return null; }
function renderDiagnosticsRow(){
  if(!diagnosticsAvailable() || !diagOpen) return '';
  var left;
  if(diagState.busy) left = '<span class="diagstat run">running ' + esc(diagState.running) + '…</span>';
  else if(diagState.ready && diagState.result && diagState.result.type === 'map') left = '<span class="diagstat ready" data-diagopen="1" title="clear the overlay">● ' + esc(diagState.result.label) + ' — clear</span>';
  else if(diagState.ready) left = '<span class="diagstat ready" data-diagopen="1" title="view result">● result ready</span>';
  else left = '<span class="diagstat idle">diagnostics</span>';
  var btns = CONFIG.diagnostics.map(function(d){
    return '<span class="btn' + (diagState.busy ? ' busy' : '') + '" data-diag="' + esc(d.name) + '" title="' + esc(d.label) + '">' + esc(d.icon || '?') + '</span>';
  }).join('');
  return '<div class="tracks diag">' + left + '<span class="diagbtns">' + btns + '</span></div>';
}
// wire the data-attr buttons after the status box innerHTML is set (avoids inline onclick string args, which
// don't survive the CLIENT_JS template-literal escaping)
function attachDiagnosticsHandlers(){
  var box = document.getElementById('statusbox');
  if(!box) return;
  var btns = box.querySelectorAll('.btn[data-diag]');
  for(var i = 0; i < btns.length; i++)(function(el){ el.addEventListener('click', function(){ runDiagnostic(el.getAttribute('data-diag')); }); })(btns[i]);
  var open = box.querySelector('[data-diagopen]');
  if(open) open.addEventListener('click', onDiagReadyClick);
}
// clicking the ● ready indicator: map result -> clear the overlay; text result -> open the console overlay.
function onDiagReadyClick(){
  if(!diagState.result) return;
  if(diagState.result.type === 'map'){ clearDiagHeatmap(); diagState.ready = false; diagState.result = null; renderStatusBox(); }
  else openDiagnosticOverlay();
}
function runDiagnostic(name){
  if(diagState.busy || !diagnosticsAvailable()) return; // single-slot
  clearDiagHeatmap(); // a new run replaces any previous map overlay
  diagState.busy = true; diagState.running = name; diagState.ready = false; diagState.result = null;
  renderStatusBox();
  fetch('api/diagnostic/' + encodeURIComponent(name), { method: 'POST', cache: 'no-store' })
    .then(function(r){ return r.json().then(function(j){ return { http: r.status, body: j }; }); })
    .then(function(rsp){
      diagState.busy = false; diagState.running = null; diagState.ready = true;
      var b = rsp.body || {}, cfg = diagConfig(name), out = b.output || '';
      if(cfg && cfg.type === 'map' && b.ok){
        var parsed = null; try { parsed = JSON.parse(out); } catch(e){ parsed = null; }
        if(parsed){ renderDiagHeatmap(parsed, cfg.metric, cfg.label); diagState.result = { name: name, type: 'map', label: cfg.label, ok: true }; }
        else diagState.result = { name: name, type: 'text', label: (cfg.label || name), ok: false, output: 'failed to parse heatmap JSON:\\n' + out };
      } else {
        diagState.result = { name: name, type: 'text', label: (b.label || name), ok: !!b.ok, ms: b.ms,
          output: out || ('(no output)' + (b.error ? ' — ' + b.error : '') + (rsp.http !== 200 ? ' [HTTP ' + rsp.http + ']' : '')) };
      }
      renderStatusBox();
    })
    .catch(function(e){
      diagState.busy = false; diagState.running = null; diagState.ready = true;
      diagState.result = { name: name, type: 'text', label: name, ok: false, output: 'request failed: ' + e.message };
      renderStatusBox();
    });
}
// ---- map heatmap overlay (for type:'map' diagnostics) -----------------------------------------------------
function clearDiagHeatmap(){
  for(var i = 0; i < diagHeatmap.length; i++) diagHeatmap[i].setMap(null);
  diagHeatmap = [];
  var sl = document.getElementById('diagslider'); if(sl) sl.classList.remove('show');
}
// Midtone pivot: remap the normalised value so the gradient's midpoint (yellow) sits at diagPivot instead of
// 0.5 — values around the pivot spread across more of the red→yellow→green range, revealing gradations where
// readings cluster. pivot<0.5 expands the high end, >0.5 the low end.
function diagRemap(v){
  var p = diagPivot;
  if(p <= 0) return 1; if(p >= 1) return 0;
  return v < p ? (v / p) * 0.5 : 0.5 + ((v - p) / (1 - p)) * 0.5;
}
function applyDiagPivot(){
  for(var i = 0; i < diagHeatmap.length; i++) diagHeatmap[i].setOptions({ fillColor: valueToColorClient(diagRemap(diagHeatmap[i].heatV)) });
}
// slider 0..100 -> pivot 0.1..0.9 (50 = neutral 0.5); recolour live + move the gradient preview's yellow stop.
function onDiagSlider(val){
  diagPivot = 0.1 + (Number(val) / 100) * 0.8;
  applyDiagPivot();
  var g = document.querySelector('#diagslider .dsgrad');
  if(g) g.style.background = 'linear-gradient(to right, rgb(255,0,0), rgb(255,255,0) ' + Math.round(diagPivot * 100) + '%, rgb(0,255,0))';
}
window.onDiagSlider = onDiagSlider;
// value 0..1 -> colour. v is normalised so HIGH = good (more satellites / stronger signal), so we use the
// signal-quality convention: red (low/bad) → yellow → green (high/good).
function valueToColorClient(v){
  var stops = [[0,255,0,0],[0.5,255,255,0],[1,0,255,0]];
  var lo, hi;
  for(var i = 0; i < stops.length - 1; i++) if(v >= stops[i][0] && v <= stops[i+1][0]){ lo = stops[i]; hi = stops[i+1]; break; }
  if(!lo){ var s = v <= 0 ? stops[0] : stops[stops.length - 1]; return 'rgb(' + s[1] + ',' + s[2] + ',' + s[3] + ')'; }
  var t = (v - lo[0]) / (hi[0] - lo[0]);
  return 'rgb(' + Math.round(lo[1] + t*(hi[1]-lo[1])) + ',' + Math.round(lo[2] + t*(hi[2]-lo[2])) + ',' + Math.round(lo[3] + t*(hi[3]-lo[3])) + ')';
}
function renderDiagHeatmap(json, metric, label){
  clearDiagHeatmap();
  if(typeof map === 'undefined' || !map || !json || !json.metrics) return;
  var m = json.metrics[metric];
  if(!m || !m.cells) return;
  diagPivot = 0.5; // reset to neutral for a fresh heatmap
  var radius = (json.cellM || 1.5) * 0.75; // metres; slight overlap reads as a continuous field
  for(var i = 0; i < m.cells.length; i++){
    var c = m.cells[i];
    var circle = new google.maps.Circle({ center: { lat: c.lat, lng: c.lng }, radius: radius,
      fillColor: valueToColorClient(diagRemap(c.v)), fillOpacity: 0.55, strokeOpacity: 0, clickable: false, zIndex: 5, map: map });
    circle.heatV = c.v;
    diagHeatmap.push(circle);
  }
  // show the midtone slider (reset to neutral) for this overlay
  var sl = document.getElementById('diagslider');
  if(sl){
    var inp = sl.querySelector('input'); if(inp) inp.value = 50;
    var lab = sl.querySelector('.dslabel'); if(lab) lab.textContent = (label || metric) + ' — drag to reveal gradations';
    var g = sl.querySelector('.dsgrad'); if(g) g.style.background = 'linear-gradient(to right, rgb(255,0,0), rgb(255,255,0) 50%, rgb(0,255,0))';
    sl.classList.add('show');
  }
}
function openDiagnosticOverlay(){
  if(!diagState.result) return;
  var r = diagState.result;
  var ov = document.getElementById('diagoverlay');
  ov.querySelector('.diagtitle').textContent = r.label + (r.ok ? '' : ' — failed') + (typeof r.ms === 'number' ? '  (' + (r.ms/1000).toFixed(1) + 's)' : '');
  ov.querySelector('.diagpre').textContent = r.output;
  ov.classList.add('show');
  diagState.ready = false; // viewing clears the "ready" flash
  renderStatusBox();
}
function closeDiagnosticOverlay(){ document.getElementById('diagoverlay').classList.remove('show'); }
function copyDiagnosticOutput(){
  if(!diagState.result) return;
  var t = diagState.result.output;
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t);
}
window.toggleDiagnostics = toggleDiagnostics;
window.runDiagnostic = runDiagnostic;
window.openDiagnosticOverlay = openDiagnosticOverlay;
window.closeDiagnosticOverlay = closeDiagnosticOverlay;
window.copyDiagnosticOutput = copyDiagnosticOutput;

// ---- Perimeters tool row (🗺️) ---------------------------------------------------------------------------------
// Mirrors the diagnostics row, but always available (no auth/CGI gate). The buttons act on the perimeter
// geometry already drawn on the map — no extra fetch. First button: illuminate every perimeter vertex.
function togglePerimeters(){ perimOpen = !perimOpen; renderStatusBox(); }
// Collected as the perimeter is drawn (loadPerimeters): one entry per vertex, tagged with its line colour.
function perimAddVerts(path, color){ if(!path) return; for(var i = 0; i < path.length; i++) perimVertices.push({ lat: path[i].latitude, lng: path[i].longitude, color: color }); }
function clearPerimeterPoints(){ for(var i = 0; i < perimPointMarkers.length; i++) perimPointMarkers[i].setMap(null); perimPointMarkers = []; }
function drawPerimeterPoints(){
  clearPerimeterPoints();
  if(!map) return;
  for(var i = 0; i < perimVertices.length; i++){
    var v = perimVertices[i], c = brightenHex(v.color, 0.45); // the line's own colour, gamma-lifted for contrast
    perimPointMarkers.push(new google.maps.Circle({
      center: { lat: v.lat, lng: v.lng }, radius: 0.18, // a touch wider than the polyline so vertices read clearly
      fillColor: c, fillOpacity: 0.95, strokeColor: c, strokeOpacity: 1, strokeWeight: 1,
      clickable: false, zIndex: 6, map: map
    }));
  }
}
function togglePerimeterPoints(){ perimPointsOn = !perimPointsOn; if(perimPointsOn) drawPerimeterPoints(); else clearPerimeterPoints(); renderStatusBox(); }
function renderPerimetersRow(){
  if(!perimOpen) return '';
  var pointsBtn = '<span class="btn' + (perimPointsOn ? ' on' : '') + '" onclick="togglePerimeterPoints()" title="illuminate perimeter vertices (borders, obstacles, paths)">⦿</span>';
  return '<div class="tracks perim"><span class="diagstat idle">perimeters</span><span class="diagbtns">' + pointsBtn + '</span></div>';
}
window.togglePerimeters = togglePerimeters;
window.togglePerimeterPoints = togglePerimeterPoints;

function applyBoxPosition(id, defaultClass, override){
  var el = document.getElementById(id);
  if(!el) return;
  ['pos-lt','pos-rt','pos-lb','pos-rb','pos-no','pos-st'].forEach(function(c){ el.classList.remove(c); });
  // clear inline styles that 'st' mode writes, so a switch back to a corner mode is clean
  el.style.top = el.style.left = el.style.right = el.style.bottom = el.style.width = el.style.maxWidth = '';
  var cls = defaultClass;
  if(override === 'lt' || override === 'rt' || override === 'lb' || override === 'rb') cls = 'pos-' + override;
  else if(override === 'no') cls = 'pos-no';
  else if(override === 'st') cls = 'pos-st';
  el.classList.add(cls);
}
applyBoxPosition('statusbox', 'pos-lt', URL_CONFIG.boxStatus);
applyBoxPosition('notifbox', 'pos-st', URL_CONFIG.boxNotify);
// commands box: default hidden ('no'); 'on' enables stacked layout under the status box
applyBoxPosition('cmdbox', 'pos-no', URL_CONFIG.commands === 'on' ? 'st' : URL_CONFIG.commands);

// Stacked-mode layout: each .pos-st box chains under the previous one — statusbox → cmdbox →
// notifbox. Boxes that are hidden or not in stacked mode are skipped, so the chain collapses
// naturally when, say, the cmdbox is off. Re-runs on any box resize and on window resize.
function applyStackedNotifyPosition(){
  var sb = document.getElementById('statusbox');
  if(!sb) return;
  var sbRect = sb.getBoundingClientRect();
  var topRef = sb;
  var leftPx = sbRect.left;
  var widthPx = sbRect.width;
  ['cmdbox', 'notifbox', 'settingsbox'].forEach(function(id){
    var el = document.getElementById(id);
    if(!el || !el.classList.contains('pos-st')) return;
    // hidden boxes (display:none) report 0-size rect and don't push the chain forward
    var visible = !el.classList.contains('pos-no') && !el.classList.contains('empty');
    var refRect = topRef.getBoundingClientRect();
    el.style.top = (refRect.bottom + 8) + 'px';
    el.style.left = leftPx + 'px';
    el.style.width = widthPx + 'px';
    el.style.maxWidth = 'none';
    if(visible) topRef = el;
  });
}
if(window.ResizeObserver){
  ['statusbox', 'cmdbox', 'notifbox', 'settingsbox'].forEach(function(id){
    var el = document.getElementById(id);
    if(el) new window.ResizeObserver(applyStackedNotifyPosition).observe(el);
  });
}
window.addEventListener('resize', applyStackedNotifyPosition);

// Initial render from the baked-in snapshot. Function declarations are hoisted so we can call
// them here even though they're defined further down. Runs synchronously at script parse time,
// before the Google Maps script loads — so the user never sees "connecting…" if the server
// already had state to share.
if(state) { renderStatusBox(); renderCommandBox(); }
if(notifications.length > 0) renderNotifBox();

var COVERAGE = ['GOOD','POOR','BAD','WORSE'];
var ZONE_COLORS = ['#fbbc04','#34a853','#4285f4','#a142f4','#ff6d01'];

function esc(s){ var d = document.createElement('div'); d.textContent = (s === null || s === undefined) ? '' : String(s); return d.innerHTML; }
function fmt(v,dash){ return (v === null || v === undefined || v === '') ? (dash === undefined ? '-' : dash) : v; }
// Soften DISPLAY-only enum strings: NAVIGATING_TO_AREA -> "Navigating to area",
// GPS_SEARCHING -> "GPS searching". The raw enums stay in r.statusType / r.statusMessage etc.
// on the wire so automation/scripts can parse them. Two preserve-lists (inlined so the
// function is safe to call from the early initial-render path before module-level vars are
// assigned — function declarations are hoisted but var assignments aren't):
//   KEEP_UPPER  — whole-token critical labels that stay all caps (ERROR).
//   ACRONYMS    — sub-tokens (between underscores) that keep their capitalisation when
//                 softened, so "GPS_SEARCHING" -> "GPS searching" not "Gps searching".
// Applied narrowly at known enum-rendering sites only (status box header).
function soften(s){
  if(s === null || s === undefined) return s;
  var KEEP_UPPER = { ERROR: 1 };
  var ACRONYMS = { GPS: 1, RTK: 1, GNSS: 1, MQTT: 1, RSSI: 1, LED: 1, MAC: 1, API: 1 };
  return String(s).replace(/[A-Z][A-Z0-9_]*/g, function(m){
    if(KEEP_UPPER[m]) return m;
    var parts = m.split('_').map(function(part, i){
      if(ACRONYMS[part]) return part;
      var lower = part.toLowerCase();
      return i === 0 ? (lower.charAt(0).toUpperCase() + lower.slice(1)) : lower;
    });
    return parts.join(' ');
  });
}
function ago(iso){
  if(!iso) return 'never';
  var s = Math.round((Date.now() - new Date(iso).getTime())/1000);
  if(s < 60) return s + 's ago';
  if(s < 3600) return Math.round(s/60) + 'm ago';
  if(s < 86_400){
    var hr = Math.round(s/3600);
    if(hr < 24) return hr + 'h ago';
    // round-up lands on a full day boundary — drop through to the day formatter
  }
  // 24h+: split into days + hours so "166h ago" reads as "6d22h ago".
  var d = Math.floor(s / 86_400);
  var h = Math.round((s % 86_400) / 3600);
  if(h === 24){ d++; h = 0; }
  return h === 0 ? (d + 'd ago') : (d + 'd' + h + 'h ago');
}

function initMap(){
  var base = { lat: CONFIG.baseLat, lng: CONFIG.baseLng };
  var center = base, zoom = 18, locked = false;
  if(MAP_POSITION && MAP_POSITION.abs){
    center = { lat: MAP_POSITION.abs.lat, lng: MAP_POSITION.abs.lng };
    if(MAP_POSITION.zoom !== undefined) zoom = MAP_POSITION.zoom;
    locked = true;
  } else if(MAP_POSITION && MAP_POSITION.offset){
    // offset mode — wait for perimeters to resolve the reference centre; lock the view now
    locked = true;
  }
  var mapOpts = {
    center: center, zoom: zoom, mapTypeId: 'satellite', tilt: 0,
    mapId: 'robot_position_map', gestureHandling: 'greedy', streetViewControl: false
  };
  if(URL_CONFIG.mapControls === 'off') mapOpts.disableDefaultUI = true;
  map = new google.maps.Map(document.getElementById('map'), mapOpts);
  if(locked){ userMoved = true; didFit = true; } // suppress auto-fit when caller fixed the view
  infoWindow = new google.maps.InfoWindow();
  map.addListener('dragstart', function(){ userMoved = true; });
  map.addListener('idle', logMapPositionFromCurrentView);
  // mapPosition=fit: keep the garden framed as the window changes size (until the user pans/zooms away)
  if(MAP_POSITION && MAP_POSITION.fit) window.addEventListener('resize', function(){ if(PERIMETER_BOUNDS && !userMoved) map.fitBounds(PERIMETER_BOUNDS, 60); });

  var basePin = new google.maps.marker.PinElement({ background:'#1a73e8', borderColor:'#ffffff', glyphColor:'#ffffff', glyphText:'B' });
  baseMarker = new google.maps.marker.AdvancedMarkerElement({ map: map, position: base, title: 'Base station', content: basePin });
  attachHover(baseMarker, 'base');

  robotPin = new google.maps.marker.PinElement({ background:'#34a853', borderColor:'#ffffff', glyphColor:'#ffffff', glyphText:'R' });
  robotMarker = new google.maps.marker.AdvancedMarkerElement({ position: base, title: 'Robot', content: robotPin });
  attachHover(robotMarker, 'robot');
  // Heading arrow is its own overlay marker (sharing the robot's position) rather than a wrapper around
  // the pin — that lets the pin stay a plain PinElement (no deprecated .element access). The arrow box is
  // centred on the marker anchor (= the robot's location) via negative margins and rotated by
  // orientationCompass (0=N, clockwise).
  robotArrow = document.createElement('div');
  robotArrow.style.cssText = 'position:absolute; left:50%; bottom:0; width:40px; height:40px; margin-left:-20px; margin-bottom:-20px; transform-origin:50% 50%; transition:transform .25s ease; pointer-events:none; display:none;';
  robotArrow.innerHTML = '<svg viewBox="0 0 40 40" width="40" height="40" style="overflow:visible; filter:drop-shadow(0 1px 1px rgba(0,0,0,.45))"><path d="M20 6 L26 16 L20 13 L14 16 Z" fill="currentColor" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  robotArrowMarker = new google.maps.marker.AdvancedMarkerElement({ position: base, title: '', content: robotArrow, zIndex: 1 });

  // Yellow cut-position reticle (the old "Mowing target" symbol) — created hidden; shown + flashed only
  // while the status-box strategy line is hovered (showMowTarget/clearMowTarget).
  mowTargetEl = document.createElement('div');
  mowTargetEl.style.cssText = 'position:relative;width:0;height:0;';
  mowTargetEl.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" style="position:absolute;left:-12px;top:-12px;pointer-events:none;filter:drop-shadow(0 1px 1px rgba(0,0,0,.4))"><circle cx="12" cy="12" r="8" fill="none" stroke="#fbbc04" stroke-width="2.5"/><circle cx="12" cy="12" r="2.5" fill="#fbbc04"/></svg>';
  mowTargetMarker = new google.maps.marker.AdvancedMarkerElement({ position: base, content: mowTargetEl, zIndex: 8 });
  mowTargetMarker.map = null;

  hydrateInitialCrumbs();

  refresh();
  setInterval(refresh, CONFIG.pollMs);
  refreshNotifications();
  setInterval(refreshNotifications, CONFIG.notifPollMs);
}

// One-shot crumb hydration. The server bakes a window of cached crumbs into the page as
// INITIAL_CRUMBS; here we replay them into the crumbs[] array and rebuild the matching
// polyline segments so the live recordCrumb() path naturally extends from the last point.
function hydrateInitialCrumbs(){
  var W = (typeof INITIAL_CRUMBS !== 'undefined') ? INITIAL_CRUMBS : null;
  if(!W || !W.n) return;
  crumbs.pal = (W.pal || []).slice();
  var la = 0, lo = 0, tt = 0;
  for(var i = 0; i < W.n; i++){
    la = (i === 0) ? W.lat[i] : la + W.lat[i]; // undo lat/lng/t delta encoding
    lo = (i === 0) ? W.lng[i] : lo + W.lng[i];
    tt = (i === 0) ? W.t[i]   : tt + W.t[i];
    crumbs.lat.push(la); crumbs.lng.push(lo); crumbs.t.push(tt);
    crumbs.zone.push(W.z[i]); crumbs.col.push(W.c[i]); crumbs.err.push(W.err ? W.err[i] : null); crumbs.mow.push(W.m ? W.m[i] : 0);
    crumbs.vdepth.push(W.v ? W.v[i] : 0);
    if(i > 0){
      var hex = crumbs.pal[W.c[i]];
      var seg = new google.maps.Polyline({
        path: [{ lat: crumbs.lat[i-1]/1e7, lng: crumbs.lng[i-1]/1e7 }, { lat: la/1e7, lng: lo/1e7 }],
        strokeColor: hex, strokeOpacity: 0.55, strokeWeight: 3, clickable: false, zIndex: 1,
        map: (tracksOn && tracksVisible) ? map : null
      });
      seg.crumbColor = hex;
      seg.crumbT = tt;
      seg.violation = isViolation(W.v ? W.v[i] : 0) || isViolation(W.v ? W.v[i-1] : 0); // either endpoint over threshold
      crumbSegments.push(seg);
    }
  }
  applyTracksClr();
  applyAlarmsHighlight();
  console.log('WebStatus: hydrated ' + crumbN() + ' cached crumbs');
}
window.initMap = initMap;
window.toggleTracks = toggleTracks;
window.clearTracks = clearTracks;
window.toggleTracksVisible = toggleTracksVisible;

function attachHover(marker, kind){
  var node = marker.content;
  node.style.cursor = 'pointer';
  node.addEventListener('mouseenter', function(){
    if(closeTimer){ clearTimeout(closeTimer); closeTimer = null; }
    hovered = kind;
    infoWindow.setContent(kind === 'base' ? baseInfo() : robotInfo());
    infoWindow.open({ map: map, anchor: marker });
  });
  node.addEventListener('mouseleave', function(){
    closeTimer = setTimeout(function(){ infoWindow.close(); hovered = null; closeTimer = null; }, 300);
  });
}

function loadPerimeters(){
  if(perimetersDrawn || perimetersLoading) return;
  perimetersLoading = true;
  fetch('api/perimeters', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(p){
      perimetersLoading = false;
      if(!p.zones || p.zones.length === 0) return; // server still fetching from cloud — retried on next poll
      perimetersDrawn = true;
      perimVertices = []; // rebuilt below as each element is drawn, for the perimeters "points" toggle
      // valid zones for the force-cut selector (id + name)
      cutZones = p.zones.filter(function(z){ return typeof z.id === 'number'; }).map(function(z){ return { id: z.id, name: z.name }; });
      var ids = cutZones.map(function(z){ return z.id; });
      if((cutZone === null || ids.indexOf(cutZone) < 0) && cutZones.length) cutZone = cutZones[0].id;
      renderCommandBox();
      // per-zone settings for the read-only settings panel
      zoneSettings = p.zoneSettings || [];
      renderSettingsBox();
      var bounds = new google.maps.LatLngBounds();
      var any = false;
      // Layer order (bottom → top): satellite base → crumb tracks (z=1, semi-transparent so
       // vegetation still shows) → connector + docking paths (z=2) → zone boundaries (z=3) →
       // obstacles + temp obstacles (z=4) → pickup points (z=5). Perimeter data always sits
       // above the tracks so zone/obstacle borders are never obscured by a dense crumb trail.
      (p.zones || []).forEach(function(z, i){
        var color = ZONE_COLORS[i % ZONE_COLORS.length];
        var poly = makePolygon(z.path, color, 0.12, 4, 3);
        perimAddVerts(z.path, color);
        if(poly){
          poly.getPath().forEach(function(ll){ bounds.extend(ll); });
          any = true;
          zonePolys[z.id] = poly;
          zoneNames[z.id] = z.name;
        }
      });
      // Closed zones — same colour rotation as live zones but much lighter fill, signalling
      // "defined but currently disabled in the app". Cycle continues from where live zones end.
      (p.closedZones || []).forEach(function(z, i){
        var color = ZONE_COLORS[(p.zones.length + i) % ZONE_COLORS.length];
        makePolygon(z.path, color, 0.05, 2, 3);
        perimAddVerts(z.path, color);
      });
      (p.obstacles || []).forEach(function(o){
        makePolygon(o.path, '#ea4335', 0.20, 3, 4);
        perimAddVerts(o.path, '#ea4335');
      });
      // Temporary obstacles — same shape treatment as permanent obstacles but a brighter red
      // with stronger fill, since they're transient and the user should notice them.
      (p.tempObstacles || []).forEach(function(o){
        makePolygon(o.path, '#ff3b30', 0.32, 3, 4);
        perimAddVerts(o.path, '#ff3b30');
      });
      // Inter-zone connector paths — drawn ABOVE tracks now, as a thinner grey line. With
      // tracks made semi-transparent below, the bright crumb colours still show through the
      // path's reduced opacity, so you can see both "where the route goes" and "where the
      // robot has been" simultaneously.
      (p.connectPaths || []).forEach(function(pp){
        if(!pp.path || pp.path.length < 2) return;
        new google.maps.Polyline({
          path: pp.path.map(function(pt){ return { lat: pt.latitude, lng: pt.longitude }; }),
          strokeColor: '#9aa0a6', strokeOpacity: 0.40, strokeWeight: 7,
          clickable: false, zIndex: 2, map: map
        });
        perimAddVerts(pp.path, '#9aa0a6');
      });
      // Docking paths — same treatment in base-pin blue. Slightly higher opacity since blue is
      // less dominant visually than the grey at the same opacity.
      (p.dockingPaths || []).forEach(function(pp){
        if(!pp.path || pp.path.length < 2) return;
        new google.maps.Polyline({
          path: pp.path.map(function(pt){ return { lat: pt.latitude, lng: pt.longitude }; }),
          strokeColor: '#1a73e8', strokeOpacity: 0.50, strokeWeight: 7,
          clickable: false, zIndex: 2, map: map
        });
        perimAddVerts(pp.path, '#1a73e8');
      });
      // Pickup points — small red circles, top of the stack so they're never hidden.
      (p.pickupPoints || []).forEach(function(pt){
        var lat = pt.latitude ?? pt.lat ?? pt.y;
        var lng = pt.longitude ?? pt.lng ?? pt.x;
        if(typeof lat !== 'number' || typeof lng !== 'number') return;
        new google.maps.Circle({
          center: { lat: lat, lng: lng }, radius: 0.4,
          fillColor: '#ea4335', fillOpacity: 0.85,
          strokeColor: '#ea4335', strokeOpacity: 1, strokeWeight: 2,
          clickable: false, zIndex: 5, map: map
        });
      });
      if(perimPointsOn) drawPerimeterPoints(); // re-illuminate if the toggle was on before perimeters arrived
      highlightActiveZone();
      ZONES_CENTRE = computeZonesBoundsCenter(p.zones || []);
      if(ZONES_CENTRE) console.log('WebStatus: zones centre = ' + ZONES_CENTRE.lat.toFixed(7) + ', ' + ZONES_CENTRE.lng.toFixed(7) + ' (use as mapPosition reference)');
      if(any) PERIMETER_BOUNDS = bounds; // retained for mapPosition=fit re-fit on resize
      if(MAP_POSITION && MAP_POSITION.offset && ZONES_CENTRE){
        var target = applyOffsetFromCenter(ZONES_CENTRE, MAP_POSITION.offset.latM, MAP_POSITION.offset.lonM);
        map.setCenter(target);
        if(MAP_POSITION.zoom !== undefined) map.setZoom(MAP_POSITION.zoom);
        console.log('WebStatus: mapPosition offset ' + MAP_POSITION.raw + ' -> ' + target.lat.toFixed(7) + ', ' + target.lng.toFixed(7));
      } else if(any && !userMoved){
        didFit = true;
        map.fitBounds(bounds, 60);
      }
    })
    .catch(function(){ perimetersLoading = false; });
}

// Print the current map view as a ready-to-paste mapPosition= spec whenever the user finishes
// dragging or zooming. Workflow: drag the map to the desired view, then copy the last line
// printed (e.g. mapPosition=+5.20m,-1.80m,19) into the URL or stiga-monitor invocation.
var lastLoggedMapSpec = null;
function logMapPositionFromCurrentView(){
  if(followMode) return; // follow pans the map for us — those moves aren't intentional, so don't log them (noisy)
  if(!ZONES_CENTRE || !map) return;
  var c = map.getCenter();
  if(!c) return;
  var dLatM = (c.lat() - ZONES_CENTRE.lat) * 111_320;
  var dLonM = (c.lng() - ZONES_CENTRE.lng) * 111_320 * Math.cos(ZONES_CENTRE.lat * Math.PI / 180);
  function fmt(v){
    var sign = v >= 0 ? '+' : '-';
    var abs = Math.abs(v);
    return abs < 1 ? sign + Math.round(abs * 100) + 'cm' : sign + abs.toFixed(2) + 'm';
  }
  var spec = 'mapPosition=' + fmt(dLatM) + ',' + fmt(dLonM) + ',' + map.getZoom();
  if(spec === lastLoggedMapSpec) return;
  lastLoggedMapSpec = spec;
  console.log('WebStatus: current view = ' + spec);
}

function makePolygon(path, color, fillOpacity, weight, zIndex){
  if(!path || path.length < 3) return null;
  return new google.maps.Polygon({
    paths: path.map(function(pt){ return { lat: pt.latitude, lng: pt.longitude }; }),
    strokeColor: color, strokeWeight: weight, strokeOpacity: 0.9,
    fillColor: color, fillOpacity: fillOpacity, clickable: false, zIndex: zIndex, map: map
  });
}

// accentuate the zone the robot is currently mowing (brighter fill + heavier stroke)
function highlightActiveZone(){
  var active = (state && state.robot && state.robot.mowing && !state.robot.docked) ? state.robot.mowing.zone : null;
  for(var id in zonePolys){
    var on = String(id) === String(active);
    zonePolys[id].setOptions({
      fillOpacity: on ? 0.45 : 0.12,
      strokeWeight: on ? 6 : 4,
      strokeOpacity: on ? 1 : 0.85
    });
  }
}

function zoneLabel(zoneId){
  if(zoneId === null || zoneId === undefined) return '-';
  return zoneNames[zoneId] ? (zoneNames[zoneId] + ' (' + zoneId + ')') : ('Zone ' + zoneId);
}
// How a zone-completion ended: → progressed to the next zone, ⌂ returned to dock (any reason), ? legacy entry
// recorded before we tracked the trigger (renders as undetermined; expires with the data).
function zoneTriggerMark(trigger){
  if(trigger === 'progressed') return { sym: '→', title: 'progressed to next zone' };
  if(trigger === 'docked') return { sym: '⌂', title: 'returned to dock' };
  return { sym: '?', title: 'undetermined (legacy entry — recorded before trigger tracking)' };
}
// Spatial-coverage estimate for a completion entry: the fraction of the zone the robot actually drove over
// while cutting on that run. Reads lower than the reported % (per-run, not cumulative); '' when unavailable.
function zoneCoverageText(pct){ return (typeof pct === 'number') ? '~' + pct + '%' : ''; }

function refresh(){
  loadPerimeters();
  fetch('api/state', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(s){
      state = s;
      var r = s.robot;
      if(typeof r.latitude === 'number' && typeof r.longitude === 'number'){
        var pos = { lat: r.latitude, lng: r.longitude };
        robotMarker.position = pos;
        if(!robotMarker.map) robotMarker.map = map;
        robotArrowMarker.position = pos;
        robotPin.background = robotColor(r);
        if(typeof r.orientationCompass === 'number'){
          if(!robotArrowMarker.map) robotArrowMarker.map = map;
          robotArrow.style.display = 'block';
          robotArrow.style.color = robotColor(r);
          robotArrow.style.transform = 'rotate(' + r.orientationCompass + 'deg)';
        } else {
          robotArrow.style.display = 'none';
          if(robotArrowMarker.map) robotArrowMarker.map = null;
        }
        // the mowing strategy's cut position is no longer drawn on the map; it flashes only on hover of
        // the status-box strategy line (attachMowFlashHover -> showProposalCircles).
        if(followMode){
          map.panTo(followTarget(pos)); // keep the robot in the visible-area centre (zoom unchanged); takes precedence over the one-time fit
        } else if(!didFit && !userMoved && !(MAP_POSITION && MAP_POSITION.fit)){
          // mapPosition=fit stays framed on the whole garden, so skip the robot-centric base+robot auto-fit
          didFit = true;
          var b = new google.maps.LatLngBounds();
          b.extend({ lat: CONFIG.baseLat, lng: CONFIG.baseLng });
          b.extend(pos);
          map.fitBounds(b, 90);
        }
      }
      recordCrumb();
      noteSettingsForDirty();
      renderStatusBox();
      renderCommandBox();
      renderSettingsBox();
      highlightActiveZone();
      if(hovered) infoWindow.setContent(hovered === 'base' ? baseInfo() : robotInfo());
    })
    .catch(function(){ /* keep last good state */ });
}

function robotColor(r){
  if(!r) return '#9aa0a6';
  if(r.statusText && /error|fault|stuck|blocked|fail/i.test(r.statusText)) return '#ea4335';
  if(r.docked) return '#1a73e8';
  var t = (r.statusType || '').toUpperCase();
  if(t.indexOf('MOW') >= 0 || t.indexOf('WORK') >= 0 || t.indexOf('CUT') >= 0) return '#34a853'; // actively cutting (incl. CUTTING_BORDER) → green
  if(t.indexOf('PLAN') >= 0) return '#fbbc04'; // planning/preparing → yellow (transitional, not yet cutting)
  if(t.indexOf('CHARG') >= 0) return '#1a73e8';
  return '#fbbc04';
}

// client-side breadcrumb trail — a point is appended on each fresh position report while
// tracks are ON. Each segment is colored by the robot's status at the time the crumb was
// laid down, so the trail visually shows what the robot was doing where. Session-only:
// not persisted, lost on page refresh.
function crumbColor(r){
  if(!r) return '#ffffff';
  if(r.statusText && /error|fault|stuck|blocked|fail|trapped/i.test(r.statusText)) return '#ea4335';
  var t = (r.statusType || '').toUpperCase();
  if(t === 'ERROR' || t === 'BLOCKED' || t === 'LID_OPEN') return '#ea4335';
  if(t === 'MOWING' || t === 'CUTTING_BORDER') return '#34a853';
  if(t === 'GOING_HOME' || t === 'NAVIGATING_TO_AREA' || t === 'REACHING_FIRST_POINT' || t === 'PLANNING_ONGOING') return '#ffffff';
  return '#fbbc04'; // waiting, updating, calibrating, blades-calibrating, storing, startup, docked, charging, etc.
}

function recordCrumb(){
  if(!tracksOn || !state || !state.robot) return;
  var r = state.robot;
  if(r.docked) return; // mirror the server: no crumbs while docked
  if(typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return;
  if(r.updatedPosition === lastCrumbTime) return;
  lastCrumbTime = r.updatedPosition;
  var color = crumbColor(r);
  var zone = (r.mowing && !r.docked && r.mowing.zone !== null && r.mowing.zone !== undefined) ? Number(r.mowing.zone) : -1;
  var st = (r.statusType || '').toUpperCase();
  var mow = (st === 'MOWING' || st === 'CUTTING_BORDER') ? 1 : 0; // mirror the server mow flag
  var vdepth = (typeof r.violationDepthCm === 'number') ? r.violationDepthCm : 0; // server-computed for this fix
  // Capture an alarm string for red crumbs so the alarm panel can dedupe by it (stored full-size inline).
  var err = color === '#ea4335' ? ([r.statusMessage || r.statusType, r.statusText].filter(Boolean).join(' · ') || null) : null;
  var i = crumbN(), hadPrev = i > 0, prevLat, prevLng, prevVd;
  if(hadPrev){ prevLat = crumbs.lat[i-1]; prevLng = crumbs.lng[i-1]; prevVd = crumbs.vdepth[i-1]; }
  var latInt = Math.round(r.latitude * 1e7), lngInt = Math.round(r.longitude * 1e7), t = Date.now();
  crumbs.lat.push(latInt); crumbs.lng.push(lngInt); crumbs.t.push(t);
  crumbs.zone.push(isFinite(zone) ? zone : -1); crumbs.col.push(crumbPalIdx(color)); crumbs.err.push(err); crumbs.mow.push(mow); crumbs.vdepth.push(vdepth);
  if(hadPrev){
    var seg = new google.maps.Polyline({
      path: [{ lat: prevLat/1e7, lng: prevLng/1e7 }, { lat: latInt/1e7, lng: lngInt/1e7 }],
      strokeColor: color, strokeOpacity: 0.55, strokeWeight: 3, clickable: false, zIndex: 1,
      map: tracksVisible ? map : null
    });
    seg.crumbColor = color;
    seg.crumbT = t;
    seg.violation = isViolation(vdepth) || isViolation(prevVd); // either endpoint over threshold
    crumbSegments.push(seg);
    if(color === '#ea4335' && alarmsHighlighted){
      styleAlarmSegment(seg, true);
      // Rebuild clusters so a freshly-recorded alarm shows up as a circle straight away.
      buildAlarmClusters();
    }
    // a freshly-recorded violation joins the flashing set immediately (the running timer styles it next tick)
    if(seg.violation && alarmsHighlighted) styleViolationSegment(seg, violationFlashOn);
  }
  applyTracksClr();
}

// The #N display filter is just a visibility condition layered onto the normal show/hide logic, so it can
// widen as well as narrow without ever destroying segments (the crumb data is retained). applyTracksMap()
// owns the actual setMap; this is the re-apply hook called after the filter or the crumb set changes.
function applyTracksClr(){ applyTracksMap(); }

// cycle the decay limit through the canonical values; called from the [#N] button in the
// status box. Re-applies immediately so segments drop or remain as appropriate.
// Alarm highlighting. When alarmsHighlighted is on, red crumb segments get fatter & brighter
// (so the path through an error region is obvious) AND each error LOCATION gets a red Circle
// drawn on top with its own hover tooltip. Clusters of nearby same-error crumbs (within ~2m
// AND ±5min) collapse into a single circle so a robot stuck in one spot doesn't paint dozens
// of overlapping dots.
var ALARM_CLUSTER_TIME_WINDOW_MS = 5 * 60 * 1000;
var ALARM_CLUSTER_DISTANCE_M = 2;
var alarmClusters = []; // [{lat, lng, err, firstT, lastT, count, circle}]
var alarmInfoWindow = null;
var alarmTipCloseTimer = null;

function styleAlarmSegment(seg, highlight){
  if(highlight) seg.setOptions({ strokeWeight: 6, strokeOpacity: 0.95, zIndex: 6 });
  else seg.setOptions({ strokeWeight: 3, strokeOpacity: 0.45, zIndex: 1 });
}
function applyAlarmSegmentHighlight(){
  crumbSegments.forEach(function(s){
    if(s.crumbColor === '#ea4335') styleAlarmSegment(s, alarmsHighlighted);
  });
}

function distanceMetres(lat1, lng1, lat2, lng2){
  var dLat = (lat2 - lat1) * 111_320;
  var dLng = (lng2 - lng1) * 111_320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function buildAlarmClusters(){
  clearAlarmClusters();
  if(!map) return;
  var red = [], cn = crumbN();
  for(var ri = 0; ri < cn; ri++){
    var re = crumbs.err[ri];
    if(!re) continue; // err is only set on red crumbs, so its presence is sufficient
    red.push({ lat: crumbs.lat[ri]/1e7, lng: crumbs.lng[ri]/1e7, t: crumbs.t[ri], err: re });
  }
  red.sort(function(a, b){ return a.t - b.t; });
  red.forEach(function(c){
    // try to attach to any recent same-error cluster within range, scanning newest-first
    var match;
    for(var i = alarmClusters.length - 1; i >= 0; i--){
      var cl = alarmClusters[i];
      if(cl.err !== c.err) continue;
      if(c.t - cl.lastT > ALARM_CLUSTER_TIME_WINDOW_MS) continue;
      if(distanceMetres(c.lat, c.lng, cl.lat, cl.lng) > ALARM_CLUSTER_DISTANCE_M) continue;
      match = cl; break;
    }
    if(match){
      match.count++;
      match.lat = match.lat + (c.lat - match.lat) / match.count;
      match.lng = match.lng + (c.lng - match.lng) / match.count;
      match.lastT = c.t;
    } else {
      alarmClusters.push({ lat: c.lat, lng: c.lng, err: c.err, firstT: c.t, lastT: c.t, count: 1 });
    }
  });
  // draw circles
  alarmClusters.forEach(function(cl){
    cl.circle = new google.maps.Circle({
      center: { lat: cl.lat, lng: cl.lng }, radius: 1.5,
      fillColor: '#ea4335', fillOpacity: 0.25,
      strokeColor: '#ea4335', strokeOpacity: 0.95, strokeWeight: 2,
      clickable: true, zIndex: 7, map: map
    });
    cl.circle.addListener('mouseover', function(){ showAlarmTooltip(cl); });
    cl.circle.addListener('mouseout',  function(){ scheduleAlarmTooltipClose(); });
  });
}
function clearAlarmClusters(){
  alarmClusters.forEach(function(cl){ if(cl.circle){ cl.circle.setMap(null); cl.circle = null; } });
  alarmClusters = [];
  if(alarmInfoWindow) alarmInfoWindow.close();
}

function showAlarmTooltip(cluster){
  if(alarmTipCloseTimer){ clearTimeout(alarmTipCloseTimer); alarmTipCloseTimer = null; }
  if(!alarmInfoWindow) alarmInfoWindow = new google.maps.InfoWindow({ disableAutoPan: true });
  var when = ago(new Date(cluster.lastT).toISOString());
  var spanMin = Math.round((cluster.lastT - cluster.firstT) / 60_000);
  var detail = [when];
  if(spanMin >= 1) detail.push('over ' + spanMin + 'm');
  if(cluster.count > 1) detail.push(cluster.count + ' samples');
  var html = '<div class="alarmtip">' +
    '<div class="aerr">' + esc(cluster.err) + '</div>' +
    '<div class="atime">' + esc(detail.join(' · ')) + '</div>' +
  '</div>';
  alarmInfoWindow.setContent(html);
  alarmInfoWindow.setPosition({ lat: cluster.lat, lng: cluster.lng });
  alarmInfoWindow.open(map);
}
function scheduleAlarmTooltipClose(){
  if(alarmTipCloseTimer) clearTimeout(alarmTipCloseTimer);
  alarmTipCloseTimer = setTimeout(function(){ if(alarmInfoWindow) alarmInfoWindow.close(); alarmTipCloseTimer = null; }, 250);
}

// Geofence-violation flashing. When alarms are highlighted, segments whose endpoint is inside an obstacle /
// out of bounds pulse between their own colour and a gamma-lifted (brighter) version of it, so a run that
// drove somewhere it shouldn't have stands out from the ordinary track without recolouring it to a fixed hue.
var violationFlashOn = false, violationFlashTimer = null;
function brightenHex(hex, amt){ // lift toward white by amt (0..1) — the "more gamma" enrichment
  if(typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  function up(x){ return Math.round(x + (255 - x) * amt); }
  function h2(x){ return ('0' + x.toString(16)).slice(-2); }
  return '#' + h2(up(r)) + h2(up(g)) + h2(up(b));
}
function styleViolationSegment(seg, bright){
  if(bright) seg.setOptions({ strokeColor: brightenHex(seg.crumbColor, 0.6), strokeOpacity: 1, strokeWeight: 6, zIndex: 8 });
  else seg.setOptions({ strokeColor: seg.crumbColor, strokeOpacity: 0.95, strokeWeight: 5, zIndex: 8 });
}
function tickViolationFlash(){
  violationFlashOn = !violationFlashOn;
  for(var i = 0; i < crumbSegments.length; i++) if(crumbSegments[i].violation) styleViolationSegment(crumbSegments[i], violationFlashOn);
}
function startViolationFlash(){
  if(violationFlashTimer) return;
  tickViolationFlash();
  violationFlashTimer = setInterval(tickViolationFlash, 650);
}
function stopViolationFlash(){
  if(violationFlashTimer){ clearInterval(violationFlashTimer); violationFlashTimer = null; }
  violationFlashOn = false;
  // restore violation segments to the ordinary track style (red alarm segments are restyled separately below)
  for(var i = 0; i < crumbSegments.length; i++){
    var s = crumbSegments[i];
    if(s.violation && s.crumbColor !== '#ea4335') s.setOptions({ strokeColor: s.crumbColor, strokeOpacity: 0.55, strokeWeight: 3, zIndex: 1 });
  }
}
function applyAlarmsHighlight(){
  applyAlarmSegmentHighlight();
  if(alarmsHighlighted){ buildAlarmClusters(); startViolationFlash(); }
  else { clearAlarmClusters(); stopViolationFlash(); }
}
function setAlarmsHighlight(on){
  if(alarmsHighlighted === on) return;
  alarmsHighlighted = on;
  applyAlarmsHighlight();
  renderStatusBox();
}
function toggleAlarmsHighlight(){ setAlarmsHighlight(!alarmsHighlighted); }
window.toggleAlarmsHighlight = toggleAlarmsHighlight;

// #N button: cycle the display filter 1 -> 2 -> ... -> R -> ∞ -> 1, where R = runs currently in the buffer.
// R is recomputed each click, so the numeric ceiling grows as new runs accumulate while the page is open.
function cycleTracksClr(){
  var ceiling = availableRuns();
  if(tracksClr === Number.POSITIVE_INFINITY) tracksClr = 1;
  else if(tracksClr >= ceiling) tracksClr = Number.POSITIVE_INFINITY;
  else tracksClr = tracksClr + 1;
  applyTracksClr();
  renderStatusBox();
}
window.cycleTracksClr = cycleTracksClr;
// follow toggle: when on, refresh() pans the map to the robot each update. Turning it on recentres now.
function toggleFollow(){
  followMode = !followMode;
  if(followMode && state && state.robot && typeof state.robot.latitude === 'number' && typeof state.robot.longitude === 'number')
    map.panTo(followTarget({ lat: state.robot.latitude, lng: state.robot.longitude }));
  renderStatusBox();
}
window.toggleFollow = toggleFollow;
// Segments are on the map only when BOTH recording is on AND visibility is on. Visibility is a
// purely UI concern (lets the user peek under tracks at zones/paths/obstacles without losing the
// crumb data); recording continues regardless.
function applyTracksMap(){
  var show = tracksOn && tracksVisible;
  // run-window filter: hide (don't destroy) segments older than the last tracksClr contiguous runs
  var cutoff = (tracksClr === Number.POSITIVE_INFINITY) ? Number.NEGATIVE_INFINITY : runsCutoffClient(tracksClr);
  crumbSegments.forEach(function(s){
    var inWindow = cutoff === Number.NEGATIVE_INFINITY || typeof s.crumbT !== 'number' || s.crumbT >= cutoff;
    s.setMap(show && inWindow ? map : null);
  });
}
function setTracks(on){
  if(tracksOn === on) return;
  tracksOn = on;
  applyTracksMap();
  if(tracksOn){ lastCrumbTime = null; recordCrumb(); }
}
function toggleTracks(){ setTracks(!tracksOn); renderStatusBox(); }
function setTracksVisible(on){
  if(tracksVisible === on) return;
  tracksVisible = on;
  applyTracksMap();
  renderStatusBox();
}
function toggleTracksVisible(){ setTracksVisible(!tracksVisible); }
function clearTracks(){
  crumbs = makeCrumbStore();
  lastCrumbTime = null;
  crumbSegments.forEach(function(s){ s.setMap(null); });
  crumbSegments = [];
  renderStatusBox();
}

// Extract "now" in the schedule's home timezone — Stockholm by default. The robot's schedule
// blocks are defined in that local time, so the client must not use its own browser timezone
// for the comparison. Intl.DateTimeFormat is the standard way to get day-of-week / hour /
// minute for an arbitrary IANA zone without a third-party library.
var SCHEDULE_TZ_FMT = null;
function nowInScheduleTz(){
  var tz = (CONFIG && CONFIG.scheduleTimezone) || 'Europe/Stockholm';
  if(!SCHEDULE_TZ_FMT) SCHEDULE_TZ_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  var parts = SCHEDULE_TZ_FMT.formatToParts(new Date());
  var weekday = parts.find(function(p){ return p.type === 'weekday'; }).value;
  var hour = Number.parseInt(parts.find(function(p){ return p.type === 'hour'; }).value, 10);
  var minute = Number.parseInt(parts.find(function(p){ return p.type === 'minute'; }).value, 10);
  // schedule day index: Mon=0..Sun=6 (matches what the protobuf decoder produces)
  var dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return { dayIndex: dayMap[weekday], hour: hour, minute: minute, nowMin: hour * 60 + minute };
}

// Walk the schedule forward from "now" (in the garden's timezone) and return up to maxEntries
// upcoming sessions, oldest first. Each entry: { dayName, displayTime, startTime,
// durationMinutes, daysAway }. Empty array if scheduling is disabled or has no blocks.
function upcomingScheduledSessions(maxEntries){
  var max = maxEntries || 5;
  if(!state || !state.robot || !state.robot.schedule) return [];
  var s = state.robot.schedule;
  if(!s.enabled || !s.blocks || s.blocks.length === 0) return [];
  var now = nowInScheduleTz();
  var out = [];
  for(var offset = 0; offset < 8 && out.length < max; offset++){
    var scheduleDay = (now.dayIndex + offset) % 7;
    var bucket = s.blocks
      .filter(function(b){ return b.dayIndex === scheduleDay; })
      .sort(function(a, b){ return a.startHour * 60 + a.startMinute - (b.startHour * 60 + b.startMinute); });
    for(var i = 0; i < bucket.length; i++){
      var b = bucket[i];
      var blockMin = b.startHour * 60 + b.startMinute;
      if(offset === 0 && blockMin <= now.nowMin) continue;
      // Minutes from now until this block starts. Today is a simple subtract; future days
      // assume 24h per day — fine for a "(in XhYm)" hint, DST jitter is acceptable.
      var minutesUntil = offset === 0 ? (blockMin - now.nowMin) : ((24 * 60 - now.nowMin) + (offset - 1) * 24 * 60 + blockMin);
      out.push({
        dayName: b.dayName,
        displayTime: b.displayTime,
        startTime: (b.displayTime || '').split('-')[0],
        durationMinutes: b.durationMinutes,
        daysAway: offset,
        minutesUntil: minutesUntil
      });
      if(out.length >= max) break;
    }
  }
  return out;
}

function fmtScheduleDuration(mins){
  if(mins === null || mins === undefined) return '';
  if(mins < 60) return mins + 'm';
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return m === 0 ? (h + 'h') : (h + 'h' + m + 'm');
}

function scheduleWhenLabel(daysAway, dayName){
  if(daysAway === 0) return 'Today';
  if(daysAway === 1) return 'Tomorrow';
  return dayName;
}

// If "now" falls inside one of today's scheduled blocks, return its end time + remaining
// minutes; otherwise null. Used by formatScheduleSummary to show "Now to HH:MM · …" while
// a session is in progress instead of jumping ahead to the next-after-this one.
function currentScheduledSession(){
  if(!state || !state.robot || !state.robot.schedule) return null;
  var s = state.robot.schedule;
  if(!s.enabled || !s.blocks || s.blocks.length === 0) return null;
  var now = nowInScheduleTz();
  for(var i = 0; i < s.blocks.length; i++){
    var b = s.blocks[i];
    if(b.dayIndex !== now.dayIndex) continue;
    var startMin = b.startHour * 60 + b.startMinute;
    var endMin = startMin + (b.durationMinutes || 0);
    if(now.nowMin >= startMin && now.nowMin < endMin){
      var endHour = Math.floor(endMin / 60);
      var endMinute = endMin % 60;
      // Everything's now in Stockholm minutes-of-day, so the remaining delta is a simple subtract.
      return {
        endTime: endHour + ':' + String(endMinute).padStart(2, '0'),
        remainingMin: Math.max(0, endMin - now.nowMin)
      };
    }
  }
  return null;
}

// One-line status row text. States:
//   "Inactive"                                       — schedule disabled
//   "Active (no sessions)"                           — enabled but no blocks defined
//   "Until 11:00 (1h5m)"                             — currently inside a scheduled block
//   "Today at 09:00 for 2h (in 1h3m)"                — today, future block; (in …) is countdown
//   "Tomorrow at 09:00 for 2h" / "Wednesday at …"    — non-today, just the day label is enough
function formatScheduleSummary(){
  if(!state || !state.robot || !state.robot.schedule) return '-';
  var s = state.robot.schedule;
  if(!s.enabled) return 'Inactive';
  var current = currentScheduledSession();
  if(current) return 'Until ' + current.endTime + ' (' + fmtScheduleDuration(current.remainingMin) + ')';
  var sessions = upcomingScheduledSessions(1);
  if(sessions.length === 0) return 'Active (no sessions)';
  var n = sessions[0];
  var line = scheduleWhenLabel(n.daysAway, n.dayName) + ' at ' + n.startTime + ' for ' + fmtScheduleDuration(n.durationMinutes);
  // For today's upcoming block, append a "(in …)" countdown so the user can see how soon.
  if(n.daysAway === 0 && typeof n.minutesUntil === 'number' && n.minutesUntil > 0) line += ' (in ' + fmtScheduleDuration(n.minutesUntil) + ')';
  return line;
}

// MQTT link health, derived from the freshest update timestamp across both endpoints.
// Returned as a {cls,label} pair so it can render inline in the status-box title row.
function linkState(){
  var ages = [];
  if(state && state.robot){
    if(state.robot.updatedStatus) ages.push(Date.now() - new Date(state.robot.updatedStatus).getTime());
    if(state.robot.updatedPosition) ages.push(Date.now() - new Date(state.robot.updatedPosition).getTime());
  }
  if(state && state.base && state.base.updatedStatus) ages.push(Date.now() - new Date(state.base.updatedStatus).getTime());
  if(ages.length === 0) return { cls: 'offline', label: 'connecting' };
  var freshest = Math.min.apply(null, ages);
  if(freshest < 60_000) return { cls: 'online', label: 'online' };
  if(freshest < 180_000) return { cls: 'stale', label: 'stale ' + Math.round(freshest / 1000) + 's' };
  return { cls: 'offline', label: 'offline ' + Math.round(freshest / 60_000) + 'm' };
}

function row(k,v,vcls){
  return '<div class="row"><span class="k">' + esc(k) + '</span><span class="v' + (vcls ? ' ' + vcls : '') + '">' + esc(v) + '</span></div>';
}

// Floating panel showing the per-zone completion trail, opened on hover of the latest-zone
// line in the status box. Positioned beside the status box; closes when the pointer leaves
// either the trigger line or the panel itself.
// Shared positioner for hover panels (zone, schedule, …): match the status-box width and place
// the panel to its right if there's room, otherwise stacked directly underneath. Width is set
// in border-box mode so the panel's padding sits inside that width (matches statusbox visually).
function positionHoverPanel(panel, box){
  var br = box.getBoundingClientRect();
  panel.style.width = br.width + 'px';
  var pr = panel.getBoundingClientRect();
  var gap = 8;
  if(br.right + gap + pr.width <= window.innerWidth){
    panel.style.left = (br.right + gap) + 'px';
    panel.style.top = br.top + 'px';
  } else {
    panel.style.left = br.left + 'px';
    panel.style.top = (br.bottom + gap) + 'px';
  }
}

var zonePanelCloseTimer = null;
// Show/flash the yellow cut-position reticle at lat/lng (flashing on/off so it stands out); hide on clear.
function showMowTarget(lat, lng){
  clearMowTarget();
  if(!mowTargetMarker || typeof map === 'undefined' || !map) return;
  if(typeof lat !== 'number' || typeof lng !== 'number') return;
  mowTargetMarker.position = { lat: lat, lng: lng };
  mowTargetMarker.map = map;
  var on = true;
  mowTargetFlash = setInterval(function(){ on = !on; if(mowTargetEl) mowTargetEl.style.visibility = on ? 'visible' : 'hidden'; }, 450);
}
function clearMowTarget(){
  if(mowTargetFlash){ clearInterval(mowTargetFlash); mowTargetFlash = null; }
  if(mowTargetEl) mowTargetEl.style.visibility = 'visible';
  if(mowTargetMarker) mowTargetMarker.map = null;
}
// Hovering the mowing-strategy sub-line flashes its cut position on the map as the yellow target reticle,
// then clears on leave. The point itself is otherwise not drawn.
function attachMowFlashHover(){
  var box = document.getElementById('statusbox');
  var trigger = box && box.querySelector('[data-mowflash]');
  if(!trigger) return;
  trigger.addEventListener('mouseenter', function(){
    var cp = state && state.robot && state.robot.mowing && state.robot.mowing.strategy && state.robot.mowing.strategy.cutPosition;
    if(cp && typeof cp.latitude === 'number') showMowTarget(cp.latitude, cp.longitude);
  });
  trigger.addEventListener('mouseleave', clearMowTarget);
}
function attachZonePanelHover(){
  var box = document.getElementById('statusbox');
  var trigger = box && box.querySelector('.zonelast');
  if(!trigger) return;
  trigger.addEventListener('mouseenter', showZonePanel);
  trigger.addEventListener('mouseleave', scheduleZonePanelClose);
  var panel = document.getElementById('zonepanel');
  if(panel && !panel.dataset.bound){
    panel.dataset.bound = '1';
    panel.addEventListener('mouseenter', function(){ if(zonePanelCloseTimer){ clearTimeout(zonePanelCloseTimer); zonePanelCloseTimer = null; } });
    panel.addEventListener('mouseleave', scheduleZonePanelClose);
  }
}
function showZonePanel(){
  var panel = document.getElementById('zonepanel');
  var box = document.getElementById('statusbox');
  if(!panel || !box || !state || !Array.isArray(state.zoneCompletions) || state.zoneCompletions.length === 0) return;
  if(zonePanelCloseTimer){ clearTimeout(zonePanelCloseTimer); zonePanelCloseTimer = null; }
  // Group by zone, newest-first within each group; zones themselves ordered by most-recent entry.
  var byZone = {}, zoneOrder = [];
  state.zoneCompletions.forEach(function(c){
    if(!byZone[c.zone]){ byZone[c.zone] = []; zoneOrder.push(c.zone); }
    byZone[c.zone].push(c);
  });
  var html = '<h2>Zone completions</h2><table>';
  for(var i = 0; i < zoneOrder.length; i++){
    var z = zoneOrder[i];
    var entries = byZone[z];
    for(var j = 0; j < entries.length; j++){
      var e = entries[j];
      var mk = zoneTriggerMark(e.trigger);
      var cov = zoneCoverageText(e.coveragePct);
      html += '<tr' + (j === 0 && i > 0 ? ' class="zsep"' : (j > 0 ? '' : (i === 0 ? '' : ''))) + '>' +
        '<td class="zn">' + (j === 0 ? esc(zoneLabel(z)) : '') + '</td>' +
        '<td class="zp">' + esc(e.percent) + '%</td>' +
        '<td class="zc" title="estimated spatial coverage of this run (cutting positions painted over the zone area) — a per-run cross-check on the reported %">' + esc(cov) + '</td>' +
        '<td class="zg" title="' + esc(mk.title) + '">' + mk.sym + '</td>' +
        '<td class="zt">' + esc(ago(new Date(e.t).toISOString())) + '</td>' +
      '</tr>';
    }
  }
  html += '</table>';
  panel.innerHTML = html;
  panel.classList.add('show');
  positionHoverPanel(panel, box);
}
function scheduleZonePanelClose(){
  if(zonePanelCloseTimer) clearTimeout(zonePanelCloseTimer);
  zonePanelCloseTimer = setTimeout(function(){
    var panel = document.getElementById('zonepanel');
    if(panel) panel.classList.remove('show');
    zonePanelCloseTimer = null;
  }, 250);
}

// Schedule panel — same hover pattern as the zone panel. Lists the upcoming 5 sessions next
// to / under the status box. Only attaches when scheduling is enabled (no point hovering an
// "Inactive" line — nothing to show).
var schedPanelCloseTimer = null;
function attachSchedPanelHover(){
  var box = document.getElementById('statusbox');
  var trigger = box && box.querySelector('.sched-trigger');
  if(!trigger) return;
  if(!state || !state.robot || !state.robot.schedule || !state.robot.schedule.enabled) return;
  trigger.addEventListener('mouseenter', showSchedPanel);
  trigger.addEventListener('mouseleave', scheduleSchedPanelClose);
  var panel = document.getElementById('schedpanel');
  if(panel && !panel.dataset.bound){
    panel.dataset.bound = '1';
    panel.addEventListener('mouseenter', function(){ if(schedPanelCloseTimer){ clearTimeout(schedPanelCloseTimer); schedPanelCloseTimer = null; } });
    panel.addEventListener('mouseleave', scheduleSchedPanelClose);
  }
}
function showSchedPanel(){
  var panel = document.getElementById('schedpanel');
  var box = document.getElementById('statusbox');
  if(!panel || !box) return;
  var sessions = upcomingScheduledSessions(5);
  if(sessions.length === 0) return;
  if(schedPanelCloseTimer){ clearTimeout(schedPanelCloseTimer); schedPanelCloseTimer = null; }
  var html = '<h2>Upcoming schedule</h2><table>';
  for(var i = 0; i < sessions.length; i++){
    var s = sessions[i];
    var when = scheduleWhenLabel(s.daysAway, s.dayName);
    html += '<tr' + (i === 0 ? ' class="now"' : '') + '>' +
      '<td class="swhen">' + esc(when) + '</td>' +
      '<td class="stime">' + esc(s.displayTime) + '</td>' +
      '<td class="sdur">' + esc(fmtScheduleDuration(s.durationMinutes)) + '</td>' +
    '</tr>';
  }
  html += '</table>';
  panel.innerHTML = html;
  panel.classList.add('show');
  positionHoverPanel(panel, box);
}
function scheduleSchedPanelClose(){
  if(schedPanelCloseTimer) clearTimeout(schedPanelCloseTimer);
  schedPanelCloseTimer = setTimeout(function(){
    var panel = document.getElementById('schedpanel');
    if(panel) panel.classList.remove('show');
    schedPanelCloseTimer = null;
  }, 250);
}

// Active-control panel. Hidden unless URL_CONFIG.commands === 'on'. Start/Stop is shown as
// the contextually-appropriate verb based on the live robot status; Home is always present.
// Commands POST to /api/command/:name and the local server publishes via MQTT.
var commandBusy = false;
function isRobotActive(r){
  if(!r) return false;
  var t = (r.statusType || '').toUpperCase();
  return t === 'MOWING' || t === 'CUTTING_BORDER' || t === 'REACHING_FIRST_POINT' || t === 'NAVIGATING_TO_AREA' || t === 'PLANNING_ONGOING' || t === 'GOING_HOME';
}
function renderCommandBox(){
  var box = document.getElementById('cmdbox');
  if(!box) return;
  if(URL_CONFIG.commands !== 'on'){ box.classList.add('pos-no'); return; }
  box.classList.remove('pos-no');
  var r = state && state.robot;
  var active = isRobotActive(r);
  var busy = commandBusy ? ' busy' : '';
  // Context-aware intervention button: the action depends on the state the robot needs help out of.
  //   STARTUP_REQUIRED (252)  -> Boot  (BOOT/9 — clears it, robot proceeds to calibration)
  //   ERROR (255) / [12] set  -> Reset (RESET_ERROR/37 — clears a recoverable error)
  // [12] (intervention required) also drives the red status flash; it is set for STARTUP_REQUIRED too,
  // so STARTUP_REQUIRED must be checked first. Deliberately loose — the button may appear when the
  // command doesn't actually apply, but that's harmless, and we're still learning the exact gates.
  var st = r ? (r.statusType || '').toUpperCase() : '';
  var intervene = null;
  if(st === 'STARTUP_REQUIRED') intervene = { cmd: 'boot', label: 'Boot', cls: 'boot', title: 'boot the robot out of "startup required"' };
  else if(st === 'ERROR' || (r && r.interventionRequired)) intervene = { cmd: 'reset-error', label: 'Reset', cls: 'reset', title: 'clear a recoverable error (may not work for every fault)' };
  // Schedule on/off toggle — shown once the robot has reported its schedule; the button shows current state.
  var schedKnown = !!(r && r.schedule);
  var schedOn = schedKnown && !!r.schedule.enabled;
  // Only rebuild the controls when something that affects them actually changes — otherwise the 2.5s
  // refresh would snap the zone <select> shut while the user is picking. (The cmsg span is updated
  // in place by setCommandMessage and is intentionally excluded from the signature.)
  var sig = (active ? 'A' : '_') + (intervene ? intervene.cmd : '_') + (schedKnown ? (schedOn ? 'S' : 's') : '_') + busy + '|' + cutZones.map(function(z){ return z.id + ':' + (z.name || ''); }).join(',') + '|' + cutZone + '|' + zoneCmd;
  if(sig === lastCmdSig && box.innerHTML){ return; }
  lastCmdSig = sig;
  var primary = active
    ? '<span class="cbtn stop' + busy + '" data-cmd="stop">Stop</span>'
    : '<span class="cbtn start' + busy + '" data-cmd="start">Start</span>';
  var home = '<span class="cbtn home' + busy + '" data-cmd="home">Home</span>';
  var reset = intervene ? '<span class="cbtn ' + intervene.cls + busy + '" data-cmd="' + intervene.cmd + '" title="' + intervene.title + '">' + intervene.label + '</span>' : '';
  var sched = schedKnown ? '<span class="cbtn sched' + (schedOn ? ' on' : '') + busy + '" data-cmd="schedule-' + (schedOn ? 'off' : 'on') + '" title="enable/disable scheduled mowing (📅)">📅 ' + (schedOn ? 'ON' : 'OFF') + '</span>' : '';
  // Extensible zone-action row: [command ▾] [zone ▾] [▶] — pick a command + zone, then Go.
  var cut = '';
  if(cutZones.length){
    var cmdOpts = '';
    for(var c = 0; c < ZONE_COMMANDS.length; c++) cmdOpts += '<option value="' + ZONE_COMMANDS[c].cmd + '"' + (ZONE_COMMANDS[c].cmd === zoneCmd ? ' selected' : '') + '>' + esc(ZONE_COMMANDS[c].label) + '</option>';
    var opts = '';
    for(var z = 0; z < cutZones.length; z++){
      var zid = cutZones[z].id, zname = cutZones[z].name;
      var zlabel = zname ? (zid + ' · ' + zname) : ('Zone ' + zid);
      opts += '<option value="' + zid + '"' + (zid === cutZone ? ' selected' : '') + '>' + esc(zlabel) + '</option>';
    }
    cut = '<select class="zcmd" title="zone command">' + cmdOpts + '</select>' +
      '<select class="czone" title="zone">' + opts + '</select>' +
      '<span class="cbtn zgo' + busy + '" data-cmd="zone-go" title="run the selected command on the selected zone">▶</span>';
  }
  var msg = box.querySelector('.cmsg');
  var msgHtml = msg ? msg.outerHTML : '<div class="cmsg">' + CMD_IDLE + '</div>';
  // Buttons on their row(s); the command status/idle line is its own muted third row (same colour/size as
  // the status box's "status … · position …" line) so transient dispatch messages aren't cramped beside the
  // buttons. Zone-targeted commands wrap to their own row so long zone names don't overflow the box width.
  box.innerHTML = '<div class="crow">' + primary + home + sched + reset + '</div>' +
    (cut ? '<div class="crow">' + cut + '</div>' : '') +
    msgHtml;
  var sel = box.querySelector('.czone');
  if(sel) sel.addEventListener('change', function(){ cutZone = parseInt(sel.value, 10); lastCmdSig = ''; });
  var cmdSel = box.querySelector('.zcmd');
  if(cmdSel) cmdSel.addEventListener('change', function(){ zoneCmd = cmdSel.value; lastCmdSig = ''; });
  var btns = box.querySelectorAll('.cbtn');
  for(var i = 0; i < btns.length; i++){
    (function(el){
      el.addEventListener('click', function(){
        var cmd = el.getAttribute('data-cmd');
        if(cmd === 'zone-go') sendCommand(zoneCmd, cutZone); // run the chosen zone command on the chosen zone
        else sendCommand(cmd);
      });
    })(btns[i]);
  }
}
function setCommandMessage(text, isError){
  var box = document.getElementById('cmdbox');
  if(!box) return;
  var span = box.querySelector('.cmsg');
  if(!span) return;
  span.textContent = text || CMD_IDLE; // never blank — fall back to the idle message
  span.style.color = isError ? '#c5221f' : '#9aa0a6';
}
function sendCommand(name, zone){
  if(commandBusy) return;
  commandBusy = true;
  renderCommandBox();
  var label = name + (zone != null ? ' zone ' + zone : '');
  setCommandMessage('sending ' + label + '…', false);
  var url = 'api/command/' + encodeURIComponent(name) + (zone != null ? '?zone=' + encodeURIComponent(zone) : '');
  fetch(url, { method: 'POST', cache: 'no-store' })
    .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
    .then(function(rsp){
      commandBusy = false;
      if(rsp.ok) setCommandMessage(label + ' dispatched', false);
      else setCommandMessage(label + ' failed: ' + ((rsp.body && rsp.body.error) || 'unknown'), true);
      renderCommandBox();
      setTimeout(function(){ setCommandMessage('', false); }, 4000);
    })
    .catch(function(e){
      commandBusy = false;
      setCommandMessage(label + ' error: ' + e.message, true);
      renderCommandBox();
    });
}

// Refresh button (passive read; lives in the status box). Triggers a server-side re-fetch
// of perimeters and notifications, then redraws the relevant client state.
var refreshBusy = false;
function triggerRefresh(){
  if(refreshBusy) return;
  refreshBusy = true;
  renderStatusBox();
  fetch('api/refresh', { method: 'POST', cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(){
      perimetersDrawn = false;
      Object.keys(zonePolys).forEach(function(id){ zonePolys[id].setMap(null); });
      zonePolys = {}; zoneNames = {};
      loadPerimeters();
      refreshNotifications();
    })
    .catch(function(){})
    .finally(function(){ refreshBusy = false; renderStatusBox(); });
}
window.triggerRefresh = triggerRefresh;
window.sendCommand = sendCommand;

// ---- Read-only settings panel (⚙ in the status box; stacked below status/command/notifications) ----
// settingsChanged accumulates the global-setting keys changed-but-not-yet-acknowledged. It reddens the ⚙ wheel
// while the panel is hidden, and the open panel red-dots each changed setting (a PREFIX dot, so the right-
// justified value doesn't jump when it clears). It is NOT cleared on routine re-renders — so the dots persist
// the whole time the panel is open and new changes add to them live — only when the panel is CLOSED (the user
// has seen them; a reopen then starts fresh) or when the staleness timer fires after a long idle stretch (so an
// unattended kiosk doesn't stay red forever). Not self-healing: a value that flip-flops back still counts.
// Keyed on the global settings only; the first snapshot seeds the baseline so the initial load isn't flagged.
function noteSettingsForDirty(){
  if(!settingsAlertCfg.on) return;
  var s = state && state.robot && state.robot.settings;
  if(!s) return;
  if(settingsPrev){
    var any = false;
    for(var k in s) if(JSON.stringify(s[k]) !== JSON.stringify(settingsPrev[k])){ settingsChanged[k] = true; any = true; }
    if(any && settingsAlertCfg.expiryMs > 0){
      if(settingsChangeTimer) clearTimeout(settingsChangeTimer);
      settingsChangeTimer = setTimeout(function(){ clearSettingsChanges(); renderStatusBox(); renderSettingsBox(); }, settingsAlertCfg.expiryMs);
    }
  }
  settingsPrev = s;
}
function settingsHasChanges(){ if(!settingsAlertCfg.on) return false; for(var k in settingsChanged) return true; return false; }
function clearSettingsChanges(){ settingsChanged = {}; if(settingsChangeTimer){ clearTimeout(settingsChangeTimer); settingsChangeTimer = null; } }
// The zone the robot is actively mowing right now, as a numeric id — but only when we actually hold
// settings for it (so a matching chip exists). null when docked / not in a zone / unknown / no settings.
function currentMowingZone(){
  if(!(state && state.robot && state.robot.mowing && !state.robot.docked)) return null;
  var z = parseInt(state.robot.mowing.zone, 10);
  if(isNaN(z)) return null;
  for(var i = 0; i < zoneSettings.length; i++) if(zoneSettings[i].id === z) return z;
  return null;
}
function toggleSettings(){
  settingsOpen = !settingsOpen;
  if(settingsOpen){
    // Open straight to the zone being mowed, if any (otherwise keep the last/global selection).
    var z = currentMowingZone();
    if(z !== null) settingsZone = z;
  } else {
    clearSettingsChanges(); // closing acknowledges the changes (clears dots + red); reopen starts fresh
  }
  renderSettingsBox();
  renderStatusBox();
}
function closeSettings(){ settingsOpen = false; clearSettingsChanges(); renderSettingsBox(); renderStatusBox(); }
window.toggleSettings = toggleSettings;

// camelCase / snake_case key -> "Title case" label.
function humanizeKey(k){
  var s = String(k).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
// Units appended to numeric settings so the panel shows user values, not bare numbers.
var SETTINGS_UNITS = { rainSensorDelay: ' h', zoneCuttingHeight: ' mm', longExitDistance: ' cm', cuttingHeight: ' mm', customAngle: '°' };
function fmtSettingValue(k, v){
  if(k === 'cuttingMode') return (typeof CUTTING_MODE_LABELS !== 'undefined' && CUTTING_MODE_LABELS[v]) || v;
  if(v === true) return 'on';   // match the CLI (on/off, not yes/no)
  if(v === false) return 'off';
  if(v === null || v === undefined || v === '') return '-';
  if(typeof v === 'number' && SETTINGS_UNITS[k] !== undefined) return v + SETTINGS_UNITS[k];
  return String(v);
}
// Turn a settings object into [label, value, tag, changed] rows, skipping plumbing keys and any functions.
// 'changed' (a key->true map, optional) flags rows whose setting changed since the panel was last shown.
function settingsRows(obj, changed){
  if(!obj) return [];
  var skip = { id: 1, name: 1, unknown: 1 }; // id/name shown as the panel title; unknown is internal
  var rows = [];
  Object.keys(obj).forEach(function(k){
    if(skip[k]) return;
    if(typeof obj[k] === 'function' || (obj[k] && typeof obj[k] === 'object')) return;
    var chg = !!(changed && changed[k]);
    // zone 'enabled' reads better as yes/no than the on/off used for the other booleans
    if(k === 'enabled'){ rows.push(['Enabled', obj[k] ? 'yes' : 'no', undefined, chg]); return; }
    rows.push([humanizeKey(k), fmtSettingValue(k, obj[k]), undefined, chg]);
  });
  return rows;
}
function renderSettingsBox(){
  var box = document.getElementById('settingsbox');
  if(!box) return;
  if(!settingsOpen){ box.classList.add('empty'); box.innerHTML = ''; applyStackedNotifyPosition(); return; }
  box.classList.remove('empty');
  // Zone chips: * (global) then each zone id that has settings, ascending.
  var ids = zoneSettings.map(function(z){ return z.id; }).filter(function(x){ return typeof x === 'number'; }).sort(function(a, b){ return a - b; });
  var chips = '<span class="szchip' + (settingsZone === '*' ? ' on' : '') + '" data-z="*" title="global">*</span>';
  ids.forEach(function(id){ chips += '<span class="szchip' + (settingsZone === id ? ' on' : '') + '" data-z="' + id + '">' + id + '</span>'; });
  // Rows + title for the current selection.
  var rows, title;
  if(settingsZone === '*'){
    rows = settingsRows(state && state.robot && state.robot.settings, settingsAlertCfg.on ? settingsChanged : null);
    // Cloud-only settings (from the garage, not the robot) stack at the bottom, each tagged with a cloud icon.
    var cloud = state && state.robot && state.robot.cloudSettings;
    if(cloud){
      var cloudLabels = { autoUpdate: 'Firmware automatic update' };
      Object.keys(cloud).forEach(function(ck){
        if(cloud[ck] === undefined || cloud[ck] === null) return;
        rows.push([ cloudLabels[ck] || humanizeKey(ck), fmtSettingValue(ck, cloud[ck]), 'cloud' ]);
      });
    }
    title = 'Global';
  }
  else {
    var zs = null;
    for(var i = 0; i < zoneSettings.length; i++) if(zoneSettings[i].id === settingsZone) zs = zoneSettings[i];
    rows = settingsRows(zs);
    title = (zs && zs.name) ? zs.name : ('Zone ' + settingsZone);
  }
  var tbl = '<table>';
  if(rows.length === 0) tbl += '<tr><td class="k">' + (settingsZone === '*' ? 'waiting for settings…' : 'no settings') + '</td><td class="sv"></td></tr>';
  else for(var j = 0; j < rows.length; j++){
    var klab = esc(rows[j][0]) + (rows[j][2] === 'cloud' ? ' <span class="cloudtag" title="cloud setting (read-only, not stored on the robot)">☁</span>' : '');
    var chgdot = rows[j][3] ? '<span class="schg" title="changed since you last viewed">·</span>' : '';
    tbl += '<tr><td class="k">' + klab + '</td><td class="sv">' + chgdot + esc(rows[j][1]) + '</td></tr>';
  }
  tbl += '</table>';
  box.innerHTML = '<h2><span class="boxclose" title="close (or toggle the ⚙)">×</span>Settings · ' + esc(title) + '</h2>' +
    '<div class="szsel">' + chips + '</div>' + tbl;
  var sclose = box.querySelector('.boxclose');
  if(sclose) sclose.addEventListener('click', closeSettings);
  var chipsEls = box.querySelectorAll('.szchip');
  for(var k = 0; k < chipsEls.length; k++){
    (function(el){
      el.addEventListener('click', function(){ var z = el.getAttribute('data-z'); settingsZone = (z === '*' ? '*' : parseInt(z, 10)); renderSettingsBox(); });
    })(chipsEls[k]);
  }
  applyStackedNotifyPosition();
}

function renderStatusBox(){
  var box = document.getElementById('statusbox');
  if(!state){ box.innerHTML = '<div class="muted">connecting…</div>'; return; }
  var r = state.robot;
  var place = r.docked === true ? 'Docked' : (r.docked === false ? 'Out' : '-');
  // Prefer the human override (e.g. "GPS_SEARCHING", "STUCK") when present, else fall back
  // to the raw statusType — both are enum-style so soften() handles them uniformly (and the
  // SOFTEN_ACRONYMS list ensures GPS/RTK/etc keep their caps). Raw type stays in r.statusType
  // for color and active-state logic to key off unchanged.
  var op = fmt(soften(r.statusMessage || r.statusType));
  if(r.statusText) op += ' · ' + soften(r.statusText);
  var batt = r.battery ? (r.battery.charge + '%') : '-';
  var sched = formatScheduleSummary();
  var schedRow = '<div class="row"><span class="k">Schedule</span><span class="v sched-trigger" data-schedpanel="1">' + esc(sched) + '</span></div>';
  var mow = '-';
  if(r.mowing) mow = zoneLabel(r.mowing.zone) + ' ' + fmt(r.mowing.zoneCompleted,0) + '% · garden ' + fmt(r.mowing.gardenCompleted,0) + '%';
  // The mowing STRATEGY [18][4] as a single label-less sub-line of Mowing (always shown when present):
  //   <progress>/<maximum> · <±orientation>° · <startX,startY> · <unknown1>/<unknown2>
  // Hovering it flashes the cut position on the map (showMowTarget, via attachMowFlashHover). The
  // absolute target lat/lng + heading are intentionally not surfaced. (URL_CONFIG.experimental kept for future use.)
  var tgtRow = '';
  if(r.mowing && r.mowing.strategy){
    var s = r.mowing.strategy;
    var parts = [s.cutEffortProgress + '/' + s.cutEffortMaximum + 'ε'];
    if(typeof s.cutDirection === 'number'){ var ori = ((s.cutDirection % 360) + 540) % 360 - 180; parts.push((ori >= 0 ? '+' : '') + Math.round(ori) + '°'); } // normalise to (-180,180]
    if(s.cutPosition) parts.push(fmt(s.cutPosition.east,1) + ',' + fmt(s.cutPosition.north,1) + 'm');
    parts.push(s.cutUnknown1 + '/' + s.cutUnknown2);
    tgtRow = '<div class="row" data-mowflash="1"><span class="k"></span><span class="v mowstrat">' + esc(parts.join(' · ')) + '</span></div>';
  }
  var zoneLastRow = '';
  var zc = state.zoneCompletions;
  if(Array.isArray(zc) && zc.length > 0){
    var latest = zc[0];
    var lmk = zoneTriggerMark(latest.trigger);
    var lcov = zoneCoverageText(latest.coveragePct);
    zoneLastRow = '<div class="zonelast" data-zonepanel="1">' + esc(zoneLabel(latest.zone)) + ' - ' + esc(latest.percent) + '% ' + (lcov ? '<span class="zcov" title="estimated spatial coverage of this run">' + esc(lcov) + '</span> ' : '') + '<span class="ztrig" title="' + esc(lmk.title) + '">' + lmk.sym + '</span> · ' + esc(ago(new Date(latest.t).toISOString())) + '</div>';
  }
  var link = linkState();
  var linkTag = '<span class="linktag ' + link.cls + '">' + esc(link.label) + '</span>';
  var trk = '';
  if(URL_CONFIG.statusTracksControls !== 'off'){
    var clrLabel = tracksClr === Number.POSITIVE_INFINITY ? '∞' : String(tracksClr);
    // spaced functional buttons (follow, refresh, errors, notifications, settings)
    var followBtn = '<span class="btn' + (followMode ? ' on' : '') + '" onclick="toggleFollow()" title="follow: keep the robot centred as it moves">⌖</span>';
    var refreshBtn = '<span class="btn" onclick="triggerRefresh()" title="re-sync everything: perimeters, zone settings, notifications, robot settings">' + (refreshBusy ? '↻…' : '↻') + '</span>';
    // Discreet alert border: robot in an error state OR a geofence violation in the recent window. It's a
    // quiet "something under the hood" cue (not a loud alarm), so false positives from the synthetic check
    // stay low-key. Independent of whether the highlight is toggled on.
    var alarmAlert = (state && state.robot && crumbColor(state.robot) === '#ea4335') || hasRecentViolation();
    var alarmTitle = alarmAlert ? 'error or geofence violation detected — click to highlight tracks and reveal the alarm log on hover' : 'highlight error tracks and reveal deduped alarm log on hover';
    var alarmBtn = '<span class="btn' + (alarmsHighlighted ? ' on' : '') + (alarmAlert ? ' alert' : '') + '" onclick="toggleAlarmsHighlight()" title="' + alarmTitle + '">!</span>';
    var notifBtn = '<span class="btn' + (notifBoxClosed ? '' : ' on') + '" onclick="toggleNotifBox()" title="show/hide the notifications box">#</span>';
    var settingsBtn = '<span class="btn' + (settingsOpen ? ' on' : (settingsHasChanges() ? ' dirty' : '')) + '" onclick="toggleSettings()" title="zone &amp; global settings (read-only)">⚙</span>';
    // tracks cluster — bundled tight in one segmented box (power=record, eye=show/hide, ✕=clear, #N=run filter)
    var powerBtn = '<span class="btn' + (tracksOn ? ' on' : '') + '" onclick="toggleTracks()" title="trail recording on/off">⏻</span>';
    var visBtn = '<span class="btn' + (tracksVisible ? ' on' : '') + '" onclick="toggleTracksVisible()" title="show/hide the trail (recording continues)">◉</span>';
    var clrBtn = '<span class="btn" onclick="clearTracks()" title="clear the trail">✕</span>';
    var selBtn = '<span class="btn" onclick="cycleTracksClr()" title="trail filter: how many recent mowing runs to show (∞ = all loaded)">#' + clrLabel + '</span>';
    var trackGroup = '<span class="btngroup" title="trail">' + powerBtn + visBtn + clrBtn + selBtn + '</span>';
    // 🔧 diagnostics toggle — only exists with ?diagnostics=on (and the server offered it = auth configured);
    // green when the diagnostics row is open, white when collapsed. Far right, after settings.
    var diagBtn = diagnosticsAvailable() ? '<span class="btn' + (diagOpen ? ' on' : '') + '" onclick="toggleDiagnostics()" title="diagnostics">🔧</span>' : '';
    // perimeters tool row toggle — always shown (no auth/CGI gate)
    var perimBtn = '<span class="btn' + (perimOpen ? ' on' : '') + '" onclick="togglePerimeters()" title="perimeters">🗺️</span>';
    trk = '<div class="tracks">' + followBtn + refreshBtn + trackGroup + alarmBtn + notifBtn + settingsBtn + diagBtn + perimBtn + '</div>';
  }
  // firmware OTA progress qualifies the status while an update runs (from JSON_NOTIFICATION). Expire it if
  // it goes stale (~20s without an update — the robot finished or rebooted mid-flight).
  var fwRow = '';
  if(r.firmware && r.firmware.updatedAt && (Date.now() - new Date(r.firmware.updatedAt).getTime() < 20000)){
    var fwTxt = r.firmware.phaseName + ((r.firmware.percent !== undefined && r.firmware.percent !== null) ? ' ' + r.firmware.percent + '%' : '');
    fwRow = '<div class="row"><span class="k">Firmware</span><span class="v fwupd">' + esc(fwTxt) + '</span></div>';
  }
  box.innerHTML =
    '<h1><span class="dot" style="background:' + robotColor(r) + '"></span>' + (r.name ? "'" + esc(r.name) + "'" : 'Stiga Robot') + linkTag + '</h1>' +
    row('State', place) + row('Status', op, r.interventionRequired ? 'alert' : '') + fwRow + row('Battery', batt) + schedRow + row('Mowing', mow) + tgtRow + zoneLastRow +
    '<div class="muted">status ' + ago(r.updatedStatus) + ' · position ' + ago(r.updatedPosition) + '</div>' + trk + renderDiagnosticsRow() + renderPerimetersRow();
  attachZonePanelHover();
  attachSchedPanelHover();
  attachMowFlashHover();
  attachDiagnosticsHandlers();
}

function table(rows){
  var h = '<table>';
  for(var i = 0; i < rows.length; i++)
    if(rows[i])
      h += '<tr><td class="k">' + esc(rows[i][0]) + '</td><td>' + esc(rows[i][1]) + '</td></tr>';
  return h + '</table>';
}
function netLine(n){
  if(!n) return '-';
  var s = fmt(n.name);
  if(n.type) s += ' (' + n.type + ')';
  if(typeof n.rssi === 'number') s += ' · ' + n.rssi + ' dBm';
  return s;
}
function rtkLine(l){
  if(!l) return '-';
  var s = fmt(l.satellites) + ' sats';
  if(typeof l.coverage === 'number') s += ' · ' + (COVERAGE[l.coverage] || l.coverage);
  if(typeof l.offsetDistance === 'number') s += ' · RTK ' + l.offsetDistance.toFixed(1) + ' cm';
  return s;
}
function verLine(v){
  return v ? (fmt(v.firmware) + (v.build ? ' (build ' + v.build + ')' : '')) : '-';
}

function robotInfo(){
  if(!state) return '<div class="infobox">connecting…</div>';
  var r = state.robot;
  // Combined Location: offset-from-base + orientation, e.g. "1.7m at 242°, oriented 338°".
  // Each half degrades independently when its source is missing.
  var fromBase = (typeof r.offsetDistanceMetres === 'number') ? (r.offsetDistanceMetres.toFixed(1) + 'm at ' + Math.round(r.offsetCompass) + '°') : null;
  var heading = (typeof r.orientationCompass === 'number') ? ('oriented ' + Math.round(r.orientationCompass) + '°') : null;
  var location = [fromBase, heading].filter(Boolean).join(', ') || '-';
  var rows = [
    ['Status', fmt(r.statusMessage || r.statusType) + (r.statusText ? ' · ' + r.statusText : '')],
    ['Validity', fmt(r.statusValid) + ' · ' + fmt(r.statusFlag)],
    ['Docked', r.docked === undefined ? '-' : (r.docked ? 'yes' : 'no')],
    ['Battery', r.battery ? (r.battery.charge + '% · ' + r.battery.capacity + ' mAh') : '-'],
    ['Position', (typeof r.latitude === 'number') ? (r.latitude.toFixed(7) + ', ' + r.longitude.toFixed(7)) : 'no fix yet'],
    ['Location', location],
    ['GNSS/RTK', rtkLine(r.location)],
    ['Network', netLine(r.network)],
    ['Firmware', verLine(r.version)]
  ];
  return '<div class="infobox"><h2>Robot</h2>' + table(rows) + '<div class="muted">status ' + ago(r.updatedStatus) + ' · position ' + ago(r.updatedPosition) + '</div></div>';
}

// notifications — polled on a slow cadence (60s by default) and rendered in a bottom-left
// box. The server already has them in cached form; dismissal is client-only, so dismissed
// items reappear on page refresh (acceptable — we have no cloud "mark read" path yet).
function refreshNotifications(){
  fetch('api/notifications', { cache: 'no-store' })
    .then(function(r){ return r.json(); })
    .then(function(list){ notifications = list || []; renderNotifBox(); })
    .catch(function(){ /* keep last list */ });
}

// Hide the whole notif box and remember every uuid currently present, so it stays hidden until a
// notification with an unseen uuid arrives (handled in renderNotifBox). Dismissed-but-present uuids
// are remembered too, so dismissing then closing doesn't make the box pop back for the same items.
function closeNotifBox(){
  notifBoxClosed = true;
  notifClosedUuids = {};
  for(var i = 0; i < notifications.length; i++) notifClosedUuids[notifications[i].uuid] = true;
  renderNotifBox();
}
// The '#' button in the status box toggles the notif box: bring it back if removed, or hide it if shown.
// (Illuminated when the box is active i.e. not closed; re-rendered via renderStatusBox.)
function toggleNotifBox(){
  if(notifBoxClosed){ notifBoxClosed = false; renderNotifBox(); }
  else { closeNotifBox(); }
  renderStatusBox();
}
window.toggleNotifBox = toggleNotifBox;
function renderNotifBox(){
  var box = document.getElementById('notifbox');
  if(!box) return;
  // Sort all notifications newest-first and assign 1-based ranks against the full list, so the
  // header can express "showing items 2-3 of 5" — useful when dismissals shift the visible window.
  var sorted = notifications.slice().sort(function(a, b){
    return (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0);
  });
  var total = sorted.length;
  var rankByUuid = {};
  sorted.forEach(function(n, i){ rankByUuid[n.uuid] = i + 1; });
  // Whole-box hide: stays hidden until a notification arrives that wasn't present when it was closed
  // (per-uuid), so a stack of old ones can be ignored but anything new brings the box back.
  if(notifBoxClosed){
    var hasNew = sorted.some(function(n){ return !notifClosedUuids[n.uuid] && !dismissed[n.uuid]; });
    if(hasNew) notifBoxClosed = false;
    else { box.classList.add('empty'); box.innerHTML = ''; applyStackedNotifyPosition(); return; }
  }
  var visible = sorted.filter(function(n){ return !dismissed[n.uuid]; }).slice(0, 3);
  if(visible.length === 0){ box.classList.add('empty'); box.innerHTML = ''; return; }
  box.classList.remove('empty');
  var ranks = visible.map(function(n){ return rankByUuid[n.uuid]; });
  var firstRank = Math.min.apply(null, ranks);
  var lastRank = Math.max.apply(null, ranks);
  var rangeLabel = firstRank === lastRank ? String(firstRank) : firstRank + '-' + lastRank;
  var html = '<h2><span class="boxclose" title="hide box (returns when a new notification arrives)">×</span>Notifications (' + rangeLabel + ' of ' + total + ')</h2>';
  for(var i = 0; i < visible.length; i++){
    var n = visible[i];
    var meta = [n.type, n.category].filter(Boolean).join(' · ');
    var body = n.body && n.body !== 'No body' ? n.body : '';
    var bodyChunk = body ? '<span class="nsep">—</span><span class="nbody">' + esc(body) + '</span>' : '';
    html += '<div class="nrow" data-uuid="' + esc(n.uuid) + '">' +
      '<span class="ndismiss" data-uuid="' + esc(n.uuid) + '" title="dismiss">×</span>' +
      '<span class="nago">' + esc(ago(n.createdAt)) + '</span>' +
      '<div class="ncol">' + '<div class="nline"><strong>' + esc(n.title) + '</strong>' + bodyChunk + '</div>' + (meta ? '<div class="nmeta">' + esc(meta) + '</div>' : '') + '</div>' +
    '</div>';
  }
  box.innerHTML = html;
  var nclose = box.querySelector('.boxclose');
  if(nclose) nclose.addEventListener('click', closeNotifBox);
  var buttons = box.querySelectorAll('.ndismiss');
  for(var j = 0; j < buttons.length; j++){
    (function(el){
      el.addEventListener('click', function(){ dismissed[el.getAttribute('data-uuid')] = true; renderNotifBox(); });
    })(buttons[j]);
  }
  // hover a notification that has decoded geometry -> flash it on the map
  var nrows = box.querySelectorAll('.nrow');
  for(var k = 0; k < nrows.length; k++){
    (function(row){
      var n = notifByUuid(row.getAttribute('data-uuid'));
      var obs = n && n.metadata && n.metadata.obstacles;
      var pos = n && n.position;
      if(obs && obs.length){
        row.addEventListener('mouseenter', function(){ showProposalCircles(obs); });
        row.addEventListener('mouseleave', clearProposalCircles);
      } else if(pos && typeof pos.latitude === 'number'){
        row.addEventListener('mouseenter', function(){ showProposalCrosshair(pos.latitude, pos.longitude); });
        row.addEventListener('mouseleave', clearProposalCircles);
      }
    })(nrows[k]);
  }
  applyStackedNotifyPosition();
}

function baseInfo(){
  if(!state) return '<div class="infobox">connecting…</div>';
  var b = state.base;
  var st = b.status || {};
  var rows = [
    ['Status', fmt(st.type)],
    ['Detail', fmt(st.value) + ' / ' + fmt(st.detail)],
    ['Flag', fmt(st.flag)],
    ['Position', b.latitude.toFixed(7) + ', ' + b.longitude.toFixed(7)],
    ['GNSS/RTK', rtkLine(b.location)],
    ['Network', netLine(b.network)],
    ['Firmware', verLine(b.version)]
  ];
  return '<div class="infobox"><h2>Base station</h2>' + table(rows) + '<div class="muted">status ' + ago(b.updatedStatus) + '</div></div>';
}
`;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// One-off startup minification of the two static assets. Served versions default to the originals and are
// replaced in place when terser/clean-css are available — so the page is identical either way, just smaller.
// terser runs with mangle.toplevel:false because CLIENT_JS exposes global functions by name (initMap for the
// Maps callback, the onclick="..." handlers); renaming them would break the page. clean-css level 1 is safe.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

let PAGE_CSS_OUT = PAGE_CSS,
    CLIENT_JS_OUT = CLIENT_JS,
    _assetsMinified = false;
async function minifyStaticAssets(logger) {
    if (_assetsMinified) return; // idempotent — only the first webstatus instance pays the cost
    _assetsMinified = true;
    const log = logger || (() => {});
    if (_CleanCSS) {
        try {
            const out = new _CleanCSS({ level: 1, returnPromise: false, rebase: false }).minify(PAGE_CSS);
            if (out.styles && out.errors.length === 0) PAGE_CSS_OUT = out.styles;
            else if (out.errors.length > 0) log('WebStatus: CSS minify errors: ' + out.errors.join('; '));
        } catch (e) {
            log('WebStatus: CSS minify failed: ' + e.message);
        }
    }
    if (_terser) {
        try {
            const out = await _terser.minify(CLIENT_JS, {
                compress: { drop_debugger: true, passes: 2 },
                mangle: { toplevel: false },
                format: { comments: false },
            });
            if (out.code) CLIENT_JS_OUT = out.code;
        } catch (e) {
            log('WebStatus: JS minify failed: ' + e.message);
        }
    }
    const on = _terser || _CleanCSS;
    log(`WebStatus: assets ${on ? 'minified' : 'served verbatim (terser/clean-css absent)'} — css ${PAGE_CSS.length}→${PAGE_CSS_OUT.length}, js ${CLIENT_JS.length}→${CLIENT_JS_OUT.length}`);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = WebStatusProcessor;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
