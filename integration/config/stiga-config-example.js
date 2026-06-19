// Copy this to ./config/stiga-config.js (it is mounted into the container at /config/stiga-config.js
// via STIGA_CONFIG). It is plain JS exporting a single object — never commit the real file.
//
//   cp stiga-config-example.js config/stiga-config.js   # then edit
//
module.exports = {
    // Stiga account credentials (the same login you use in the Stiga.Go app).
    username: 'you@example.com',
    password: 'your-password',

    // RTK reference origin — the anchor the robot's relative position is resolved against.
    // Use your base station's coordinates (or anywhere near the garden); decimal degrees.
    referencePosition: { latitude: 59.6620665, longitude: 12.9959925 },

    // Google Maps JavaScript API key. Required to start --webstatus because the same process
    // serves the human map page; the /api/* JSON endpoints themselves do not use it. A key
    // restricted to the Maps JavaScript API is fine.
    mapsApiKey: 'YOUR_GOOGLE_MAPS_JS_API_KEY',

    // Optional: IANA timezone for schedule display (defaults to Europe/Stockholm).
    // scheduleTimezone: 'Europe/London',

    // Optional: override the MQTT broker suffix if your garage metadata reports a broker that
    // does not accept MQTT (see issue #7). Usually unnecessary.
    // brokerOverride: 'broker',
};
