#!/usr/bin/env node

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

const protobuf = require('../api/StigaAPIUtilitiesProtobuf');

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

const colors = {
    green: '\x1B[32m',
    red: '\x1B[31m',
    yellow: '\x1B[33m',
    blue: '\x1B[34m',
    reset: '\x1B[0m',
};
function pass(msg) {
    console.log(`${colors.green}✓${colors.reset} ${msg}`);
}
function fail(msg) {
    console.log(`${colors.red}✗${colors.reset} ${msg}`);
}
function section(msg) {
    console.log(`\n${colors.blue}=== ${msg} ===${colors.reset}`);
}
function info(msg) {
    console.log(`${colors.yellow}→${colors.reset} ${msg}`);
}

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
    totalTests++;
    try {
        fn();
        pass(name);
        passedTests++;
    } catch (e) {
        fail(`${name}: ${e.message}`);
        console.error(e.stack);
    }
}

function deepEqualWithFloatTolerance(a, b, tolerance = 0.0001) {
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object' || a === null) return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < tolerance : a === b;
    const keysA = Object.keys(a),
        keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) if (!deepEqualWithFloatTolerance(a[key], b[key], tolerance)) return false;
    return true;
}

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

section('Basic Type Tests');

test('Integer encoding/decoding', () => {
    const obj = { 1: 42, 2: 0, 3: 2147483647 };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    if (!deepEqualWithFloatTolerance(obj, decoded)) throw new Error(`Expected ${JSON.stringify(obj)}, got ${JSON.stringify(decoded)}`);
});

test('String encoding/decoding', () => {
    const obj = { 1: 'hello', 2: 'world', 3: 'UTF-8: 你好世界 🌍' };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    // Non-ASCII strings decode as hex
    const expected = { 1: 'hello', 2: 'world', 3: '5554462d383a20e4bda0e5a5bde4b896e7958c20f09f8c8d' };
    if (!deepEqualWithFloatTolerance(expected, decoded)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(decoded)}`);
});

test('Boolean encoding/decoding', () => {
    const obj = { 1: true, 2: false, 3: true };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    // Booleans decode as 1/0
    const expected = { 1: 1, 2: 0, 3: 1 };
    if (!deepEqualWithFloatTolerance(expected, decoded)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(decoded)}`);
});

test('Float encoding/decoding', () => {
    const obj = { 1: 3.14159, 2: -1.23, 3: 0 };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    // Check floats with tolerance
    if (!deepEqualWithFloatTolerance(obj, decoded, 0.0001)) {
        throw new Error(`Float values don't match within tolerance`);
    }
});

test('Buffer encoding/decoding', () => {
    const obj = { 1: Buffer.from([1, 2, 3, 4]), 2: Buffer.from('binary data', 'utf8') };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    // Buffers decode based on content - ASCII strings stay as strings, binary as hex
    const expected = {
        1: '01020304',
        2: 'binary data', // This is valid ASCII so it stays as string
    };
    if (!deepEqualWithFloatTolerance(expected, decoded)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(decoded)}`);
});

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

section('Complex Structure Tests');

test('Nested message encoding/decoding', () => {
    const obj = {
        1: 'root',
        2: {
            1: 'nested1',
            2: 42,
            3: {
                1: 'deeply nested',
                2: 3.14,
            },
        },
        3: {
            1: 'nested2',
        },
    };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);

    if (!deepEqualWithFloatTolerance(obj, decoded)) throw new Error(`Nested messages don't match`);
});

test('Repeated fields (arrays)', () => {
    const obj = {
        1: [1, 2, 3, 4, 5],
        2: ['hello', 'world'],
        3: [{ 1: 'msg1' }, { 1: 'msg2' }, { 1: 'msg3' }],
    };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    if (!deepEqualWithFloatTolerance(obj, decoded)) throw new Error(`Arrays don't match`);
});

test('Mixed types in same message', () => {
    const obj = {
        1: 42,
        2: 'hello',
        3: 3.14159,
        4: true,
        5: Buffer.from([0xff, 0xee, 0xdd]),
        6: {
            1: 'nested',
            2: [1, 2, 3],
        },
        7: ['a', 'b', 'c'],
    };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    // Adjust expectations for types that change during encode/decode
    const expected = {
        1: 42,
        2: 'hello',
        3: 3.14159,
        4: 1, // boolean -> number
        5: 'ffeedd', // buffer -> hex
        6: {
            1: 'nested',
            2: [1, 2, 3],
        },
        7: ['a', 'b', 'c'],
    };
    // Check with tolerance for float
    if (!deepEqualWithFloatTolerance(expected, decoded)) {
        throw new Error(`Mixed types don't match`);
    }
});

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

section('Edge Case Tests');

test('Empty message', () => {
    const obj = {};
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    if (!deepEqualWithFloatTolerance(obj, decoded)) throw new Error(`Empty message failed`);
});

test('Empty nested message', () => {
    const obj = { 1: 'test', 2: {} };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    // Empty objects might decode as empty hex
    if (decoded[1] !== 'test') throw new Error(`Field 1 mismatch`);
});

test('Large field numbers', () => {
    const obj = { 100: 'large', 1000: 'larger', 10000: 'largest' };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    if (!deepEqualWithFloatTolerance(obj, decoded)) throw new Error(`Large field numbers don't match`);
});

test('Null and undefined handling', () => {
    // eslint-disable-next-line unicorn/no-null
    const obj = { 1: 'defined', 2: null, 3: undefined, 4: 'also defined' };
    const encoded = protobuf.encode(obj);
    const decoded = protobuf.decode(encoded);
    // null and undefined should be skipped
    const expected = { 1: 'defined', 4: 'also defined' };
    if (!deepEqualWithFloatTolerance(expected, decoded)) throw new Error(`Null/undefined handling failed`);
});

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

section('Hex String Interface Tests');

test('hexToProtobuf/protobufToHex roundtrip', () => {
    const obj = {
        1: 1,
        2: 1,
        3: 4,
        5: 1,
        13: 1,
        17: { 1: 5000, 2: 100 },
    };
    const hex = protobuf.protobufToHex(obj);
    const decoded = protobuf.hexToProtobuf(hex);
    if (!deepEqualWithFloatTolerance(obj, decoded)) throw new Error(`Hex roundtrip failed`);
});

test('Original test case', () => {
    const data = '08 01 10 01 18 04 28 01 68 01 8a 01 05 08 88 27 10 64'.replaceAll(' ', '');
    info(`Input hex: ${data}`);
    const decoded = protobuf.hexToProtobuf(data);
    info(`Decoded: ${JSON.stringify(decoded, undefined, 2)}`);

    // Verify the nested message is properly decoded
    if (typeof decoded[17] !== 'object') throw new Error(`Field 17 should be an object`);
    if (decoded[17][1] !== 5000) throw new Error(`Field 17.1 should be 5000`);
    if (decoded[17][2] !== 100) throw new Error(`Field 17.2 should be 100`);
});

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

section('Large/Complex Message Test');

test('Debug string encoding issue', () => {
    // Simple test to isolate the problem
    const obj = {
        1: 'Premium',
    };

    console.log('Encoding simple string object:', obj);
    const encoded = protobuf.encode(obj);
    console.log('Encoded hex:', encoded.toString('hex'));

    const decoded = protobuf.decode(encoded);
    console.log('Decoded:', decoded);

    if (decoded[1] !== 'Premium') {
        throw new Error(`String encoding is broken: expected 'Premium', got ${JSON.stringify(decoded[1])}`);
    }
});

test('Complex real-world-like message', () => {
    const obj = {
        1: 'user-12345',
        2: 'John Doe',
        3: 'john.doe@example.com',
        4: 1234567890,
        5: true,
        10: {
            1: 'Premium',
            2: 29.99,
            3: 'monthly',
            4: true,
        },
        15: [
            { 1: 'setting1', 2: 'value1' },
            { 1: 'setting2', 2: 'value2' },
            { 1: 'setting3', 2: 'value3' },
        ],
        20: {
            1: {
                1: 'address1',
                2: '123 Main St',
                3: 'City',
                4: 'State',
                5: '12345',
            },
            2: [
                { 1: 'tag1', 2: 1 },
                { 1: 'tag2', 2: 2 },
                { 1: 'tag3', 2: 3 },
            ],
        },
    };

    const encoded = protobuf.encode(obj);
    info(`Encoded size: ${encoded.length} bytes`);
    const decoded = protobuf.decode(encoded);

    // Adjust for type conversions
    const expected = structuredClone(obj);
    expected[5] = 1; // boolean -> number
    expected[10][4] = 1; // boolean -> number

    if (!deepEqualWithFloatTolerance(expected, decoded)) {
        console.log('Expected:', JSON.stringify(expected, undefined, 2));
        console.log('Got:', JSON.stringify(decoded, undefined, 2));
        throw new Error(`Complex message roundtrip failed`);
    }
});

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

section('Performance Test');

test('Encode/decode 1000 messages', () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
        const obj = {
            1: i,
            2: `message-${i}`,
            3: Math.random() * 1000,
            4: i % 2 === 0,
            5: { 1: `nested-${i}`, 2: i * 2 },
        };
        protobuf.decode(protobuf.encode(obj));
    }
    const elapsed = Date.now() - start;
    info(`1000 encode/decode cycles took ${elapsed}ms (${elapsed / 1000}ms per cycle)`);
    if (elapsed > 1000) throw new Error(`Performance test too slow`);
});

// --------------------------------------------------------------------------------------------
// Wire-level surgical edit helpers (protobufScan / protobufField / protobufSetFields). These back
// the per-zone settings patcher, which must rewrite specific fields while preserving every other
// byte (so it never corrupts the perimeter geometry on a write).
// --------------------------------------------------------------------------------------------

section('Wire-level Edit Helpers');

test('protobufScan reports field/wire/byte-ranges', () => {
    const buf = protobuf.encode({ 1: 6, 8: 6, 15: 'hi' });
    const fields = protobuf.protobufScan(buf);
    if (fields.length !== 3) throw new Error(`expected 3 fields, got ${fields.length}`);
    const f15 = fields.find((f) => f.field === 15);
    if (f15.wire !== 2) throw new Error('field 15 should be length-delimited');
    if (buf.subarray(f15.valStart, f15.valEnd).toString('utf8') !== 'hi') throw new Error('value range wrong');
});

test('protobufField builds a FIXED32 float field', () => {
    const b = protobuf.protobufField(18, 5, -15);
    // tag 0x95 0x01 (field 18, wire 5) + little-endian float32 -15.0 (0x0000 70c1)
    if (b.toString('hex') !== '9501000070c1') throw new Error(`got ${b.toString('hex')}`);
    if (protobuf.decode(b)[18] !== -15) throw new Error('round-trip float failed');
});

test('protobufSetFields replaces a field in place, preserving others', () => {
    const buf = protobuf.encode({ 1: 6, 9: 6, 15: 'zone' });
    const out = protobuf.protobufSetFields(buf, [{ field: 9, wire: 0, value: 8 }]);
    const dec = protobuf.decode(out);
    if (dec[9] !== 8 || dec[1] !== 6 || dec[15] !== 'zone') throw new Error(`unexpected ${JSON.stringify(dec)}`);
});

test('protobufSetFields appends an absent field', () => {
    const buf = protobuf.encode({ 1: 6 });
    const out = protobuf.protobufSetFields(buf, [{ field: 19, wire: 0, value: 1 }]);
    const dec = protobuf.decode(out);
    if (dec[1] !== 6 || dec[19] !== 1) throw new Error(`unexpected ${JSON.stringify(dec)}`);
});

test('protobufSetFields preserves untouched FIXED32/bytes verbatim (no lossy round-trip)', () => {
    // Build a message with a float and a name, patch an unrelated varint, and confirm the float and
    // name bytes are byte-identical (a decode->encode round-trip would corrupt the FIXED32).
    const original = Buffer.concat([protobuf.protobufField(1, 0, 6), protobuf.protobufField(18, 5, -15), protobuf.protobufField(15, 2, Buffer.from('Grönsaksland', 'utf8')), protobuf.protobufField(9, 0, 6)]);
    const patched = protobuf.protobufSetFields(original, [{ field: 9, wire: 0, value: 8 }]);
    const fOrig = protobuf.protobufScan(original).find((f) => f.field === 18);
    const fNew = protobuf.protobufScan(patched).find((f) => f.field === 18);
    if (!original.subarray(fOrig.valStart, fOrig.valEnd).equals(patched.subarray(fNew.valStart, fNew.valEnd))) throw new Error('FIXED32 angle bytes changed');
    const nOrig = protobuf.protobufScan(original).find((f) => f.field === 15);
    const nNew = protobuf.protobufScan(patched).find((f) => f.field === 15);
    if (!original.subarray(nOrig.valStart, nOrig.valEnd).equals(patched.subarray(nNew.valStart, nNew.valEnd))) throw new Error('name bytes changed');
});

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------

console.log(`\n${colors.blue}==============================${colors.reset}`);
console.log(`${colors.blue}Test Summary${colors.reset}`);
console.log(`${colors.blue}==============================${colors.reset}`);
console.log(`Total tests: ${totalTests}`);
console.log(`${colors.green}Passed: ${passedTests}${colors.reset}`);
console.log(`${colors.red}Failed: ${totalTests - passedTests}${colors.reset}`);

if (passedTests === totalTests) {
    console.log(`\n${colors.green}All tests passed! 🎉${colors.reset}`);
    process.exit(0);
} else {
    console.log(`\n${colors.red}Some tests failed 😞${colors.reset}`);
    process.exit(1);
}

// --------------------------------------------------------------------------------------------
// --------------------------------------------------------------------------------------------
