// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function formatHexDump(buffer, prefix = '') {
    const lines = [];
    for (let i = 0; i < buffer.length; i += 16) {
        const hex = [],
            ascii = [];
        for (let j = 0; j < 16; j++) {
            if (i + j < buffer.length) {
                const byte = buffer[i + j];
                hex.push(byte.toString(16).padStart(2, '0'));
                ascii.push(byte >= 0x20 && byte <= 0x7e ? String.fromCodePoint(byte) : '.');
            } else {
                hex.push('  ');
                ascii.push(' ');
            }
            if (j === 7 && i + j < buffer.length) hex.push('');
        }
        const hexStr = hex.slice(0, 8).join(' ') + '  ' + hex.slice(9).join(' '),
            asciiStr = ascii.slice(0, 8).join('') + ' ' + ascii.slice(8).join('');
        const offset = i.toString(16).padStart(4, '0');
        lines.push(`${prefix}${offset}  ${hexStr.padEnd(49)}  |${asciiStr}|`);
    }
    return lines;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function __process_k(key, _value, options) {
    if (options[key]?.nokey) return '';
    if (options[key]?.rename) key = options[key].rename;
    return key ? key + '=' : '';
}
function __process_v(key, value, options) {
    if (options[key] && typeof options[key] === 'function') value = options[key](value);
    else {
        if (options[key]?.process && typeof options[key].process === 'function') value = options[key].process(value);
        if (options[key]?.recurse && typeof value === 'object') value = formatStruct(value);
        if (options[key]?.onoff) value = value ? 'on' : 'off';
        if (options[key]?.units) value += options[key]?.units;
        if (options[key]?.quote) value = `'${value}'`;
        if (options[key]?.squarebrackets) value = `[${value}]`;
    }
    return value;
}
function is_ignore(key, options) {
    return options?.[key]?.ignore || (options?.ignore && ((Array.isArray(options.ignore) && options.ignore.includes(key)) || options.ignore === key));
}
function formatStruct(struct, _name = undefined, options = {}) {
    return struct
        ? Object.entries(struct)
              .filter(([key, value]) => !key.startsWith('_') && value !== null && value !== undefined && typeof value !== 'function' && !is_ignore(key, options))
              .map(([key, value]) => `${options.compressed ? '' : __process_k(key, value, options)}${__process_v(key, value, options)}`)
              // eslint-disable-next-line sonarjs/no-nested-conditional
              .join(options.compressed ? '/' : ', ')
        : `-`;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const mcc_mnc_list = require('mcc-mnc-list');
function formatNetworkId(id) {
    const mccmnc = Number.parseInt(id.replaceAll('"', ''));
    if (mccmnc > 0) {
        const network = mcc_mnc_list.find({ mccmnc });
        if (network?.brand) return `'${network.brand} (${mccmnc})'`;
    }
    return id;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function formatMinutesNicely(mins) {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m === 0 ? `${h}h` : `${h}h${m}m`;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = {
    formatHexDump,
    formatStruct,
    formatNetworkId,
    formatMinutesNicely,
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
