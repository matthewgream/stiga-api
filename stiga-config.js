module.exports = {
    username: 'user@email.com',
    password: 'pass',
    // RTK reference origin used as the zero point for all offset reporting
    // by the robot and the base reference station.
    referencePosition: { latitude: 59.661923, longitude: 12.996271 },
    mapsApiKey: '0123456789ABCDEF0123456789ABCDEF0123456',
    // IANA timezone the robot's schedule is defined in (the *garden's* local time, not the
    // user's account timezone — those can differ for travellers). The webstatus client uses
    // this to compute "now" when deciding which scheduled block is active, so the same UI
    // works correctly regardless of where the browser sits. The cloud /api/user has its own
    // 'timezone' field but it reflects the user's account preference, not the device location.
    scheduleTimezone: 'Europe/Stockholm'
};
