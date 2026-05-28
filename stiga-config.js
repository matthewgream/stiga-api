module.exports = {
    username: 'user@email.com',
    password: 'pass',
    // RTK reference origin used as the zero point for all offset reporting
    // by the robot and the base reference station.
    referencePosition: { latitude: 59.661923, longitude: 12.996271 },
    mapsApiKey: '0123456789ABCDEF0123456789ABCDEF0123456',
    // Override the MQTT broker hostname suffix. Normally the cloud's /api/garage returns a
    // brokerId (e.g. 'broker1', 'broker2', or empty) and we connect to
    // robot-mqtt-${brokerId || 'broker'}.stiga.com:8883. Some robots report a brokerId whose
    // hostname is unreachable, even though the bare 'broker' endpoint works for them — see
    // issue #7 (STIGA A 500 reports broker1 but only robot-mqtt-broker.stiga.com accepts
    // connections). Uncomment and set to the working suffix to force the URL. You can also
    // override at the command line: `tools/stiga-command.js check --mqtt-broker=broker`
    // (or `tools/stiga-monitor.js --mqtt-broker=broker`) to probe variants before committing
    // a value here. Valid examples: 'broker', 'broker2'.
    // brokerOverride: 'broker',
    // IANA timezone the robot's schedule is defined in (the *garden's* local time, not the
    // user's account timezone — those can differ for travellers). The webstatus client uses
    // this to compute "now" when deciding which scheduled block is active, so the same UI
    // works correctly regardless of where the browser sits. The cloud /api/user has its own
    // 'timezone' field but it reflects the user's account preference, not the device location.
    scheduleTimezone: 'Europe/Stockholm'
};
