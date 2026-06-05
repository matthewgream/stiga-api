// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const protobuf = require('protobufjs');

const WIRE_TYPES = {
    VARINT: 0,
    FIXED64: 1,
    LENGTH_DELIMITED: 2,
    START_GROUP: 3, // Deprecated
    END_GROUP: 4, // Deprecated
    FIXED32: 5,
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function protobufEncode(obj) {
    const writer = protobuf.Writer.create();
    const encode = (field, value) => {
        if (value === null || value === undefined) return;
        if (typeof value === 'boolean') {
            writer.uint32((field << 3) | WIRE_TYPES.VARINT);
            writer.bool(value);
        } else if (typeof value === 'number') {
            if (Number.isInteger(value)) {
                writer.uint32((field << 3) | WIRE_TYPES.VARINT);
                writer.uint64(value);
            } else {
                writer.uint32((field << 3) | WIRE_TYPES.FIXED32);
                writer.float(value);
            }
        } else if (Buffer.isBuffer(value)) {
            writer.uint32((field << 3) | WIRE_TYPES.LENGTH_DELIMITED);
            writer.bytes(value);
        } else if (typeof value === 'string') {
            writer.uint32((field << 3) | WIRE_TYPES.LENGTH_DELIMITED);
            writer.string(value);
        } else if (typeof value === 'object') {
            writer.uint32((field << 3) | WIRE_TYPES.LENGTH_DELIMITED);
            writer.bytes(protobufEncode(value));
        }
    };
    for (const [key, value] of Object.entries(obj)) {
        const field = Number.parseInt(key);
        if (!Number.isNaN(field)) (Array.isArray(value) ? value : [value]).forEach((item) => encode(field, item));
    }
    return writer.finish();
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function convertsixtyfourbits(bytes) {
    const buf = Buffer.alloc(8);
    bytes.forEach((b, i) => (buf[i] = b));
    return buf.toString('hex');
}
function convertvariableinteger(value) {
    if (typeof value === 'object' && value.toNumber) {
        const num = value.toNumber();
        if (num <= Number.MAX_SAFE_INTEGER && num >= Number.MIN_SAFE_INTEGER) return num;
    }
    return value;
}

function protobufDecode(buffer, options = {}) {
    const reader = protobuf.Reader.create(buffer);
    const decoded = {};
    while (reader.pos < reader.len) {
        const tag = reader.uint32(),
            field = tag >>> 3,
            type = tag & 7;
        if (field === 0) break;
        let value;
        switch (type) {
            case WIRE_TYPES.VARINT:
                value = convertvariableinteger(reader.uint64());
                break;
            case WIRE_TYPES.FIXED64:
                value = options.fixed64AsNumber ? reader.double() : convertsixtyfourbits(reader.fixed64().toBytesLE());
                break;
            case WIRE_TYPES.LENGTH_DELIMITED:
                const bytes = reader.bytes();
                const str = bytes.toString('utf8');
                // eslint-disable-next-line sonarjs/duplicates-in-character-class, regexp/no-dupe-characters-character-class
                if (/^[\s\x20-\x7E]*$/.test(str) && str.length > 0) value = str;
                else
                    try {
                        const nested = protobufDecode(bytes, options);
                        value = Object.keys(nested).length > 0 ? nested : bytes.toString('hex');
                    } catch {
                        value = bytes.toString('hex');
                    }
                break;
            case WIRE_TYPES.FIXED32:
                value = options.fixed32AsInt ? reader.int32() : reader.float();
                break;
            case WIRE_TYPES.START_GROUP:
            case WIRE_TYPES.END_GROUP:
                reader.skipType(type);
                continue;
            default:
                value = `wireType${type}`;
                reader.skipType(type);
        }
        if (decoded[field] === undefined) decoded[field] = value;
        else {
            if (!Array.isArray(decoded[field])) decoded[field] = [decoded[field]];
            decoded[field].push(value);
        }
    }
    return decoded;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function stringToBytes(string) {
    let bytes = [];
    let i = 0;
    while (i < string.length) {
        const byte = Number.parseInt(string.slice(i, i + 2), 16);
        i += byte & 0x80 && i < string.length ? 4 : 2;
        bytes.push(byte);
    }
    return bytes;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Low-level wire-format helpers for surgical, loss-free edits of an EXISTING protobuf message.
// protobufDecode is lossy (FIXED64 -> hex string, FIXED32 -> float, string/bytes ambiguity), so a
// decode -> mutate -> protobufEncode round-trip corrupts geometry. These helpers instead walk the
// raw bytes and rewrite only the fields we target, copying every other field through verbatim.
// Used to patch per-zone settings inside the perimeter data_points blob without touching the
// (large, fragile) point/anchor geometry. See StigaAPIPerimeters.setZoneSettings.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function _readRawVarint(buf, pos) {
    let result = 0n,
        shift = 0n,
        p = pos;
    for (;;) {
        const byte = buf[p++];
        result |= BigInt(byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7n;
    }
    return { value: result, next: p };
}
function _encodeRawVarint(value) {
    let v = BigInt.asUintN(64, BigInt(value)); // two's-complement 64-bit, so negatives encode like protobuf int64
    const out = [];
    for (;;) {
        const byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v === 0n) {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
    return Buffer.from(out);
}
function _encodeTag(field, wire) {
    return _encodeRawVarint((field << 3) | wire);
}

// Walk one message level, returning each field's wire type and exact byte ranges. tagStart..valEnd is
// the whole field (copy that slice to preserve a field verbatim); valStart..valEnd is just the value.
function protobufScan(buf, start = 0, end = buf.length) {
    const fields = [];
    let p = start;
    while (p < end) {
        const tagStart = p;
        const tag = _readRawVarint(buf, p);
        p = tag.next;
        const field = Number(tag.value) >>> 3,
            wire = Number(tag.value) & 7;
        let valStart = p,
            valEnd;
        switch (wire) {
            case WIRE_TYPES.VARINT:
                valEnd = _readRawVarint(buf, p).next;
                break;
            case WIRE_TYPES.FIXED64:
                valEnd = p + 8;
                break;
            case WIRE_TYPES.FIXED32:
                valEnd = p + 4;
                break;
            case WIRE_TYPES.LENGTH_DELIMITED: {
                const len = _readRawVarint(buf, p);
                valStart = len.next;
                valEnd = len.next + Number(len.value);
                break;
            }
            default:
                throw new Error(`protobufScan: unsupported wire type ${wire} for field ${field}`);
        }
        fields.push({ field, wire, tagStart, valStart, valEnd });
        p = valEnd;
    }
    return fields;
}

// Build a complete field (tag + value) buffer. For LENGTH_DELIMITED, `value` may be a Buffer or a
// string (encoded UTF-8). For FIXED32, `value` is written as a little-endian float.
function protobufField(field, wire, value) {
    switch (wire) {
        case WIRE_TYPES.VARINT:
            return Buffer.concat([_encodeTag(field, wire), _encodeRawVarint(value)]);
        case WIRE_TYPES.FIXED32: {
            const b = Buffer.alloc(4);
            b.writeFloatLE(Number(value), 0);
            return Buffer.concat([_encodeTag(field, wire), b]);
        }
        case WIRE_TYPES.FIXED64: {
            const b = Buffer.isBuffer(value) ? value : Buffer.from(value, 'hex');
            return Buffer.concat([_encodeTag(field, wire), b]);
        }
        case WIRE_TYPES.LENGTH_DELIMITED: {
            const content = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
            return Buffer.concat([_encodeTag(field, wire), _encodeRawVarint(content.length), content]);
        }
        default:
            throw new Error(`protobufField: unsupported wire type ${wire}`);
    }
}

// Replace-or-append top-level fields, preserving all others byte-for-byte. `patches` is an array of
// { field, wire, value } (replace existing occurrence, else append) or { field, delete: true }.
// Singular fields only — intended for scalar settings, not repeated fields.
function protobufSetFields(buf, patches) {
    const byField = new Map(patches.map((p) => [p.field, p]));
    const handled = new Set();
    const parts = [];
    for (const f of protobufScan(buf)) {
        const patch = byField.get(f.field);
        if (patch) {
            if (!handled.has(f.field)) {
                if (!patch.delete) parts.push(protobufField(f.field, patch.wire, patch.value));
                handled.add(f.field);
            }
            continue; // drop the original (replaced or deleted)
        }
        parts.push(buf.subarray(f.tagStart, f.valEnd));
    }
    for (const patch of patches) if (!handled.has(patch.field) && !patch.delete) parts.push(protobufField(patch.field, patch.wire, patch.value));
    return Buffer.concat(parts);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function hexToProtobuf(hexString) {
    return protobufDecode(Buffer.from(hexString, 'hex'));
}

function protobufToHex(obj) {
    return protobufEncode(obj).toString('hex');
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = {
    protobufEncode,
    protobufDecode,
    encode: protobufEncode,
    decode: protobufDecode,
    protobufScan,
    protobufField,
    protobufSetFields,
    stringToBytes,
    hexToProtobuf,
    protobufToHex,
    WIRE_TYPES,
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
