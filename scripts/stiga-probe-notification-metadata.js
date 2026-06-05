#!/usr/bin/env node
// One-off probe: dump full metadata for every cloud notification, to discover which carry position
// or other structured data. Reads creds + referencePosition from stiga-config.js (StigaAPIConfig).
//   node scripts/stiga-probe-notification-metadata.js

const { StigaAPIConfig, StigaAPIAuthentication, StigaAPIConnectionServer, StigaAPINotifications } = require('../api/StigaAPI');

(async () => {
    const config = StigaAPIConfig.load();
    const ref = config.referencePosition; // { latitude, longitude } for ENU->lat/lng in getMetadata
    const auth = new StigaAPIAuthentication(config.username, config.password);
    if (!(await auth.isValid())) throw new Error('authentication failed');
    const server = new StigaAPIConnectionServer(auth);
    if (!(await server.isConnected())) throw new Error('server connection failed');

    const notifications = new StigaAPINotifications(server);
    if (!(await notifications.load())) throw new Error('notifications load failed');

    const all = notifications.getAll();
    console.log(`# ${all.length} notifications (reference ${ref ? ref.latitude + ',' + ref.longitude : 'none'})\n`);

    all.forEach((n, i) => {
        const data = n.getData() || {};
        const pos = n.getPosition();
        const meta = n.getMetadata(ref);
        console.log(`[${i}] ${n.getType() || '(no type)'}  ·  ${n.isRead() ? 'read' : 'UNREAD'}  ·  ${n.getCreatedAt()?.toISOString() || '?'}`);
        console.log(`    title:    ${n.getTitle()}`);
        if (n.getCategory()) console.log(`    category: ${n.getCategory()}`);
        // position from the notification data (x/y), if present
        if (pos) console.log(`    position: x=${pos.x} y=${pos.y}`);
        // every data.* key except the bulky payload, so any lat/lng/coords surface
        const dataKeys = Object.keys(data).filter((k) => k !== 'payload');
        if (dataKeys.length) console.log(`    data:     ${JSON.stringify(Object.fromEntries(dataKeys.map((k) => [k, data[k]])))}`);
        if (data.payload) console.log(`    payload:  <${data.payload.length} b64 chars>`);
        // decoded payload metadata (known decoders -> structured; unknown -> { raw })
        if (meta) console.log(`    metadata: ${JSON.stringify(meta)}`);
        console.log('');
    });
})().catch((e) => {
    console.error('probe failed:', e.message);
    process.exit(1);
});
