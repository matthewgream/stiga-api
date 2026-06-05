// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { formatStruct } = require('./StigaAPIUtilitiesFormat');
const { protobufDecode } = require('./StigaAPIUtilitiesProtobuf');
const StigaAPIComponent = require('./StigaAPIComponent');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// Notification payload decoders. A notification's `data.payload` is a base64 protobuf blob whose shape
// depends on `data.type`. Register a decoder per type here; unknown types fall back to the raw decoded
// protobuf so new metadata can be inspected before a dedicated decoder is written. Each decoder gets
// (decoded, referencePosition) where referencePosition is an optional { latitude, longitude } used to
// turn ENU-metre geometry into lat/lng.
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function _asArray(value) {
    return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
// A circular obstacle: { 1:{1:east, 2:north}, 2:radius } — fixed32 floats, same layout as GO_AWAY.
function _decodeCircle(obstacle, ref) {
    const east = obstacle?.[1]?.[1],
        north = obstacle?.[1]?.[2],
        radius = obstacle?.[2];
    if (typeof east !== 'number' || typeof north !== 'number') return undefined;
    const circle = { east, north, radius };
    if (ref?.latitude !== undefined && ref?.longitude !== undefined) {
        const mPerDegLat = 111320,
            mPerDegLon = 111320 * Math.cos((ref.latitude * Math.PI) / 180);
        circle.latitude = ref.latitude + north / mPerDegLat;
        circle.longitude = ref.longitude + east / mPerDegLon;
    }
    return circle;
}

const NOTIFICATION_PAYLOAD_DECODERS = {
    // "I bumped one or more obstacles during the session; save them as permanent?" — repeated circles.
    obstacle_proposal: (decoded, ref) => ({
        obstacles: _asArray(decoded?.[1])
            .map((obstacle) => _decodeCircle(obstacle, ref))
            .filter(Boolean),
    }),
};

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPINotification {
    constructor(notificationData, detailData = undefined) {
        this.data = notificationData;
        this.details = detailData;
    }

    getUuid() {
        return this.data?.attributes?.uuid || undefined;
    }

    getNotificationUuid() {
        return this.data?.attributes?.notification_uuid || undefined;
    }

    isRead() {
        return this.data?.attributes?.read_at !== undefined;
    }

    getReadAt() {
        const readAt = this.data?.attributes?.read_at;
        return readAt ? new Date(readAt) : undefined;
    }

    getCreatedAt() {
        const createdAt = this.data?.attributes?.created_at;
        return createdAt ? new Date(createdAt) : undefined;
    }

    getTitle() {
        return this.details?.attributes?.title || 'No title';
    }

    getBody() {
        return this.details?.attributes?.body || 'No body';
    }

    getTopic() {
        return this.details?.attributes?.topic || undefined;
    }

    getData() {
        return this.details?.attributes?.data || {};
    }

    getType() {
        return this.getData()?.type || undefined;
    }

    getCategory() {
        return this.getData()?.category || undefined;
    }

    getDeviceUuid() {
        return this.getData()?.deviceUuid || undefined;
    }

    getPosition() {
        const data = this.getData();
        return data?.x && data?.y ? { x: Number.parseFloat(data.x), y: Number.parseFloat(data.y) } : undefined;
    }

    // Decode the notification's base64 protobuf `data.payload` into structured metadata, dispatched by
    // `data.type`. Known types (see NOTIFICATION_PAYLOAD_DECODERS) return structured data; unknown types
    // return { raw: <decoded protobuf> } so future metadata can be inspected. referencePosition (optional
    // { latitude, longitude }) converts ENU-metre geometry to lat/lng. Returns undefined if no payload.
    getMetadata(referencePosition) {
        const payload = this.getData()?.payload;
        if (!payload) return undefined;
        let decoded;
        try {
            decoded = protobufDecode(Buffer.from(payload, 'base64'));
        } catch {
            return undefined;
        }
        const decoder = NOTIFICATION_PAYLOAD_DECODERS[this.getType()];
        return decoder ? decoder(decoded, referencePosition) : { raw: decoded };
    }

    // Convenience for obstacle_proposal notifications: the proposed circles [{ latitude, longitude,
    // east, north, radius }]. Empty array for other types.
    getObstacleProposals(referencePosition) {
        return (this.getType() === 'obstacle_proposal' && this.getMetadata(referencePosition)?.obstacles) || [];
    }

    toString() {
        return formatStruct({ title: this.getTitle(), status: this.isRead() ? 'read' : 'unread', createdAt: this.getCreatedAt()?.toLocaleString() || 'unknown' }, 'notification');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPINotifications extends StigaAPIComponent {
    constructor(serverConnection, options = {}) {
        super(options);
        this.server = serverConnection;
        this.notificationsData = undefined;
        this.notifications = [];
    }

    async load() {
        try {
            const response = await this.server.get('/api/user/notifications');
            if (response.ok) {
                this.notificationsData = await response.json();
                this._parseNotifications();
                return true;
            }
        } catch (e) {
            this.display.error('notifications: failed to load:', e);
        }
        return false;
    }

    _parseNotifications() {
        const details = new Map();
        if (this.notificationsData?.included) this.notificationsData.included.filter((item) => item.type === 'Notifications').forEach((item) => details.set(item.id, item));
        this.notifications = this.notificationsData?.data?.map((notification) => new StigaAPINotification(notification, details.get(notification.attributes?.notification_uuid))) ?? [];
    }

    getAll() {
        return this.notifications;
    }

    getUnread() {
        return this.notifications.filter((n) => !n.isRead());
    }

    getRead() {
        return this.notifications.filter((n) => n.isRead());
    }

    getByType(type) {
        return this.notifications.filter((n) => n.getType() === type);
    }

    getByCategory(category) {
        return this.notifications.filter((n) => n.getCategory() === category);
    }

    getByDevice(deviceUuid) {
        return this.notifications.filter((n) => n.getDeviceUuid() === deviceUuid);
    }

    getRecent(hours = 24) {
        const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
        return this.notifications.filter((notification) => {
            const createdAt = notification.getCreatedAt();
            return createdAt && createdAt > cutoff;
        });
    }

    getCount() {
        return this.notifications.length;
    }

    getUnreadCount() {
        return this.getUnread().length;
    }

    toString() {
        return formatStruct({ total: this.getCount(), unread: this.getUnreadCount() }, 'notifications');
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPINotifications;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
