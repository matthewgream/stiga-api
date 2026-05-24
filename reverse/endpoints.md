# Stiga Cloud — endpoint notebook

A scratch-pad for cloud REST endpoints discovered while reverse engineering. Not the spec, just what's been seen on the wire. Everything here is **GET unless otherwise noted**, behind the standard OAuth bearer token from `StigaAPIAuthentication`. Base URL: `https://connectivity-production.stiga.com`.

Endpoints already wired into the API (`/api/user`, `/api/garage`, `/api/perimeters`, `/api/user/notifications`) are not repeated here — see `api/StigaAPI*.js`.

---

## `/api/worksessions`

**Query**: `device_uuid=<UUID>` (mandatory). Standard `page=`/`size=` for pagination — server defaults to `size=10`.

A historical log of mowing sessions. **900 entries** in my account at probe time — this is the long-term history of every cutting session the robot has ever done.

```json
{
  "type": "worksessions",
  "attributes": {
    "uuid": "7a590b98-…",
    "start_date": "2026-05-24T05:39:31.000Z",
    "end_date":   "2026-05-24T06:27:58.000Z",
    "worksession_details": [],
    "worksession_type": "cutting",
    "created_at": "2026-05-24T06:27:58.980Z",
    "updated_at": "2026-05-24T06:27:58.980Z"
  }
}
```

Response envelope is paged:

```json
{
  "data": [ … 10 sessions … ],
  "data_info": { "page": 1, "size": 10, "total_pages": 90, "count": 900 },
  "links":     { "first": …, "last": …, "prev": …, "next": … }
}
```

**Observations**
- Sessions appear in **newest-first** order.
- Only `worksession_type: "cutting"` seen — even after sampling 13 months of history, every entry is this same type.
- `worksession_details` is **always `[]`** — checked on the list endpoint, on `/api/worksessions/<uuid>` directly, and with every `?include=…` / `?expand=…` / `?fields=*` / `?relationships=…` variant. Companion sub-collections (`/api/worksessions/<uuid>/details`, `/api/worksessiondetails`, `/api/worksession_details`) all 404. The field appears to be reserved schema space the cloud never fills.
- `created_at` ≈ `end_date` — the cloud record is written when the session ends.
- Sessions are short and bimodal — many `<1min` (false starts, stuck-and-back) and many `>2h` (proper sessions), with everything in between.

**Sample stats (one device, 13 months, 900 sessions)**
- Total cutting time: 778 h (~32 days)
- Average session: ~52 min
- Duration buckets: `<1min` 8% · `1-5min` 19% · `5-15min` 15% · `15-60min` 21% · `1-2h` 18% · `>2h` 19%

**Potential uses**
- Long-term completion analytics (cumulative cutting time per day/week/month).
- Cross-check the local capture DB against the cloud-side authoritative history.
- Detect anomalous session counts (e.g. lots of <1min sessions = robot in a stuck/retry loop).

---

## `/api/commons/maintenanceactions`

**Query**: none. Returns the full **catalogue of maintenance action types** the cloud knows about (global, not per-device).

```json
{
  "data": [
    { "type": "maintenanceactions",
      "attributes": { "uuid": "0b441276-…", "action": "note_mantainance", "created_at": "2022-10-29…", "updated_at": "2022-10-29…" } },
    { "type": "maintenanceactions",
      "attributes": { "uuid": "0eebb49c-…", "action": "hibernation",      "created_at": "2020-09-30…", "updated_at": "2020-09-30…" } },
    { "type": "maintenanceactions",
      "attributes": { "uuid": "8bef7736-…", "action": "wake_hibernation", "created_at": "2020-09-30…", "updated_at": "2020-09-30…" } }
  ]
}
```

**Observations**
- Three action types catalogued: `note_mantainance` (sic — typo in the cloud schema), `hibernation`, `wake_hibernation`.
- This is a lookup table — `uuid` here is referenced as `maintenanceaction_uuid` in `/api/maintenances` records.

---

## `/api/maintenances`

**Query**: `device_uuid=<UUID>` (mandatory). Per-device log of maintenance events the cloud has recorded.

```json
{
  "type": "mainantenances",
  "attributes": {
    "uuid": "979e50c0-…",
    "maintenanceaction_uuid": "8bef7736-…",
    "done": true,
    "workhours": 0,
    "note": "wake_hibernation",
    "battery_level": 100,
    "created_at": "2026-04-27T09:33:14.227Z",
    "updated_at": "2026-04-27T09:33:14.227Z"
  }
}
```

**Observations**
- 8 entries in my account, all `wake_hibernation` / `hibernation` pairs from end-of-season / start-of-season transitions.
- The `type` field is `mainantenances` — typo'd in the API schema, matches the `note_mantainance` typo above. Use `Mainantenances` if instantiating models from the JSON-API type.
- `maintenanceaction_uuid` is a foreign key into `/api/commons/maintenanceactions`.
- `note` looks like a free-text field but in practice mirrors the action name.
- `battery_level` sometimes `null` (older records pre-firmware update?), sometimes `0..100`.
- `workhours` is always `0` in my data — unclear if it's ever populated for cutting-related maintenance.

**Potential uses**
- Detect when the robot entered/left winter storage.
- Audit trail of "things were touched" events for ops history.

---

## `/api/bases`

**Query**: `mac_address=<MAC_NO_COLONS>` (mandatory; 400 Bad Request without it).

Lightweight product lookup by MAC. The same endpoint accepts both robot and base MACs — it does a product lookup on whatever you give it.

```bash
# Robot MAC -> base it ships with
scripts/stiga-probe-endpoint.js /api/bases mac_address=D0EF766432BA
{ "data": [ { "type": "bases", "attributes": { "product_code": "2R7102028/ST1", "serial_number": "25BA1RMO001168" } } ] }

# Base MAC -> reference station identity
scripts/stiga-probe-endpoint.js /api/bases mac_address=FCE8C072EC62
{ "data": [ { "type": "bases", "attributes": { "product_code": "REFERENCE_STATION", "serial_number": "FCE8C072EC62" } } ] }
```

**Observations**
- Returns at most one element (a single matched base).
- For a **base** MAC: `product_code` is the generic `"REFERENCE_STATION"`, `serial_number` is the MAC itself.
- For a **robot** MAC: `product_code` is the model code (e.g. `2R7102028/ST1` = the A1500 SKU), `serial_number` is the manufacturer's serial.
- MAC format: hex, no colons, uppercase. With colons it might also work but untested.
- Looks like a SKU lookup utility — useful for "what model is this MAC?" without going through the full garage.

**Potential uses**
- Stand-alone product identification from a MAC alone (no garage load required).
- Verify a serial number against a physical sticker before pairing.

---

## `/api/sim` and `/api/sim/<uuid>`

**Note the singular** — `/api/sims/<uuid>` returns 404. Both variants exist:

- `/api/sim?sim_imsi=<IMSI>` — lookup by IMSI (the 15-digit `sim_id` from the response below)
- `/api/sim/<uuid>` — lookup by SIM UUID (the `sim_uuid` exposed in `/api/garage` data)

Both return the same shape:

```json
{
  "type": "sims",
  "attributes": {
    "uuid":       "e777e8bf-…",
    "sim_id":     "123456784012077",
    "last_info": {
      "imei":           "1234567826617838",
      "iccid":          "12345678000783004560",
      "state":          "T",
      "bytesIn":        2987535,
      "bytesOut":       4314781,
      "country":        "",
      "lastUsed":       "2026-05-24T06:57:59.000Z",
      "lastCellId":     "240-08-11050-33833247-130",
      "serviceProfile": "STIGA_PACK1_CSP_TELIA"
    },
    "sim_status": "active",
    "created_at": "2025-04-21T10:43:19.974Z",
    "updated_at": "2026-05-24T03:11:11.561Z"
  }
}
```

**Field notes**
- `sim_id` is the **IMSI** despite the generic name. 15 digits, MCC prefix (`901` = global mobile-satellite or IoT range, depending on the operator).
- `iccid` is the physical SIM card serial.
- `imei` is the modem identifier (matches the `EG912UGLAAR03A09M08…` modem version shown by the robot).
- `last_info.state = "T"` — meaning unclear (likely `T`erminated/`T`ransmitting/`T`est? observed value while SIM is `sim_status: "active"`).
- `lastCellId` decodes as `MCC-MNC-TAC-ECI-PCI`:
  - `240-08` = Sweden/Telenor (matches `Telenor (24008)` in robot network status).
  - `TAC` (Tracking Area Code) — the LTE serving region. `11050` here.
  - `ECI` (E-UTRAN Cell Identifier, 28-bit) — split as `(eNodeB ID << 8) | Cell ID`. For `33833247`: eNodeB = `132160`, cell-within-eNB = `95`.
  - `PCI` (Physical Cell ID, 0-503) — the over-the-air identifier the UE uses for handover. `130` here.
  Together these pinpoint exactly which sector of which Telenor eNB the SIM last attached to — useful for tower-level diagnostics.
- `serviceProfile = "STIGA_PACK1_CSP_TELIA"` — Stiga's connectivity pack #1 on Telia roaming through Telenor.
- `bytesIn`/`bytesOut` are counters that **increase between probes** — between two ~4h apart they jumped `1967751→2987535` (≈1MB) and `2759273→4314781` (≈1.5MB). **Reset cycle is unknown** — almost certainly not lifetime (a recent OTA firmware download would have pushed totals into double-digit MB, but we see only ~7 MB total after 398 days). Probably resets monthly on a billing/pack-pack anniversary, or on each device reboot — needs sampling over a longer window to confirm. Useful for monitoring data usage *drift* regardless of the cycle.

**Mandatory params**
- `/api/sim` without query → `400 "Should have required property: sim_imsi"`.
- `/api/sims/<uuid>` (plural) → `404`.

**Potential uses**
- Monitor data usage by sampling `bytesIn`/`bytesOut` over time (great for capacity/Stiga-charging visibility once the reset cycle is determined).
- Detect connectivity-pack expiry / state changes (`sim_status`).
- Verify the SIM is "alive" before suspecting MQTT problems.

---

## Notes on schema oddities

- **JSON-API type strings vary**: `worksessions`, `mainantenances` (typo), `maintenanceactions`. Don't pluralise programmatically — copy the literal.
- **Pagination only on `/api/worksessions`** so far. The maintenance and base lookups are small enough to fit in one page.
- **No `include=` support tested** — every probe used the bare endpoint plus the mandatory filter. The `/api/garage` endpoint accepts `relationships=base,connpack` so other endpoints might honour similar joins.
- **Mandatory query params yield 400** with a useful `errors[].detail` message — worth handling explicitly when wrapping these in API code.

---

## Future probes to try

These weren't checked but the naming suggests they exist (from app strings / API style):

- `/api/worksessions/<uuid>` — single session with `worksession_details` populated. (Probed: always empty, no expansion variant unlocks it.)
- `/api/devices/<uuid>` — direct device fetch (versus garage).
- `/api/stores` / `/api/buyers` — referenced from garage relationships.
- `~~/api/sims/<uuid>~~` — actually the singular `/api/sim/<uuid>` (covered above).
- `POST /api/maintenances` — write a maintenance record (the catalogue suggests this is settable).
