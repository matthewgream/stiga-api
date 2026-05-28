// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

function _candidates() {
    const list = [];
    if (process.env.STIGA_CONFIG) list.push({ path: path.resolve(process.env.STIGA_CONFIG), kind: 'env' });
    const host = os.hostname();
    if (host) list.push({ path: path.join(ROOT, `stiga-config.${host}.js`), kind: 'host' });
    list.push({ path: path.join(ROOT, 'stiga-config.js'), kind: 'default' });
    list.push({ path: path.join(ROOT, 'stiga_user_and_pass.js'), kind: 'legacy' });
    return list;
}

let _cached;
let _warnedLegacy = false;

// Apply the broker override (if any) as a one-time side effect of loading config, so any
// tool that calls load() picks it up automatically — no per-tool wiring needed. Required to
// fix robots whose garage metadata reports a brokerId (e.g. 'broker1') that doesn't actually
// accept MQTT, where 'broker' (no suffix) is the working endpoint. See issue #7.
function _applyBrokerOverride(cfg) {
    if (cfg && cfg.brokerOverride) {
        // Lazy-require to avoid pulling MQTT/mqtt.js into tools that only need the config
        // fields and never make an MQTT connection (e.g. cloud-only probe scripts).
        require('./StigaAPIConnectionMQTT').brokerOverride = cfg.brokerOverride;
    }
}

function load() {
    if (_cached) return _cached;
    const tried = [];
    for (const { path: p, kind } of _candidates()) {
        try {
            _cached = require(p);
            if (kind === 'legacy' && !_warnedLegacy) {
                process.emitWarning(`${p} is deprecated; rename to stiga-config.js and add { referencePosition: { latitude, longitude } }`, 'DeprecationWarning');
                _warnedLegacy = true;
            }
            _applyBrokerOverride(_cached);
            return _cached;
        } catch (e) {
            if (e.code !== 'MODULE_NOT_FOUND') throw e;
            // An explicit STIGA_CONFIG that doesn't exist is a hard error — the
            // user asked for a specific file; don't silently fall through.
            if (kind === 'env') throw new Error(`STIGA_CONFIG points to ${p} but it was not found`);
            tried.push(p);
        }
    }
    throw new Error(`No config found. Tried (in order): ${tried.join(', ')}. Create stiga-config.js exporting { username, password, referencePosition: { latitude, longitude } }, or set STIGA_CONFIG to a path.`);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = { load };

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
