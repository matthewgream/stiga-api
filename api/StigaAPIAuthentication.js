// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const StigaAPIComponent = require('./StigaAPIComponent');

const API_KEY_DEFAULT = 'AIzaSyCPtRBU_hwWZYsguHp9ucGrfNac0kXR6ug';

const URL_DEFAULT = 'https://www.googleapis.com/identitytoolkit/v3/relyingparty/verifyPassword';

const TOKEN_EXPIRY_GRACE_PERIOD = 5 * 60 * 1000;

// Firebase verifyPassword returns distinct errors, so the message itself is diagnostic — notably
// INVALID_PASSWORD implies the EMAIL is recognised (the account exists; only the password was rejected).
const AUTH_ERROR_HINTS = new Map([
    ['INVALID_PASSWORD', 'email is recognised but the password was rejected — check for stray/invisible characters in the password (a smart quote, a trailing newline, a non-breaking space, shell/env mangling)'],
    ['EMAIL_NOT_FOUND', 'no account exists for this email'],
    ['INVALID_EMAIL', 'the email is malformed'],
    ['USER_DISABLED', 'the account is disabled'],
    ['MISSING_PASSWORD', 'no password was supplied'],
]);

// Render a credential for --debug so character anomalies stand out: char count, utf-8 byte length (a mismatch
// flags non-ASCII), any anomaly flags, and the value with every non printable-ASCII char escaped — a smart
// quote shows as \u{2019}, a trailing newline as \u{a}, a non-breaking space as \u{a0}.
function _inspectCredential(s) {
    if (typeof s !== 'string') return `(not a string: ${typeof s})`;
    const chars = [...s];
    const escaped = chars.map((ch) => (ch.codePointAt(0) >= 0x20 && ch.codePointAt(0) <= 0x7e ? ch : `\\u{${ch.codePointAt(0).toString(16)}}`)).join('');
    const flags = [];
    if (chars.length > 0 && (/\s/u.test(chars[0]) || /\s/u.test(chars[chars.length - 1]))) flags.push('LEADING/TRAILING WHITESPACE');
    if (chars.some((ch) => ch.codePointAt(0) > 0x7f)) flags.push('NON-ASCII');
    if (chars.some((ch) => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f)) flags.push('CONTROL CHAR');
    return `chars=${chars.length} utf8bytes=${Buffer.byteLength(s, 'utf8')}${flags.length > 0 ? ' [' + flags.join(', ') + ']' : ''} value="${escaped}"`;
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIAuthentication extends StigaAPIComponent {
    constructor(email, password, apiKey = API_KEY_DEFAULT, url = URL_DEFAULT, options = {}) {
        super(options);
        this.email = email;
        this.password = password;
        this.apiKey = apiKey;
        this.url = url;
        this.token = undefined;
        this.tokenExpiry = undefined;
        this.tokenRefresh = undefined;
    }

    async isValid() {
        try {
            await this._ensureValidToken();
            return true;
        } catch {
            return false;
        }
    }

    async addAuthentication(request) {
        await this._ensureValidToken();
        if (!request.headers) request.headers = {};
        request.headers.Authorization = `Bearer ${this.token}`;
        return request;
    }

    async _ensureValidToken() {
        if (!this.tokenIsValid()) await this._authenticate();
    }

    async _authenticate() {
        const payload = {
            email: this.email,
            password: this.password,
            returnSecureToken: true,
        };
        const params = new URL(this.url);
        params.searchParams.append('key', this.apiKey);
        // --debug surfaces exactly what is being submitted, with character anomalies made visible, so a mangled
        // credential (smart quote, stray whitespace, non-ASCII, shell/env damage) is obvious. Sensitive: the
        // password value is shown, so only under --debug.
        this.display.debug(`auth: POST ${this.url} (key ${String(this.apiKey).slice(0, 8)}…)`);
        this.display.debug(`auth: email    ${_inspectCredential(this.email)}`);
        this.display.debug(`auth: password ${_inspectCredential(this.password)}`);
        try {
            const response = await fetch(params.toString(), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (response.ok) {
                this.token = data.idToken;
                this.tokenRefresh = data.tokenRefresh;
                // Firebase tokens typically expire in 1 hour (3600 seconds)
                const expiresIn = Number.parseInt(data.expiresIn) || 3600;
                this.tokenExpiry = Date.now() + expiresIn * 1000;
            } else {
                const hint = AUTH_ERROR_HINTS.get(data?.error?.message);
                this.display.error(`auth: authentication failed, status: ${response.status} - ${JSON.stringify(data)}${hint ? '\n      -> ' + hint : ''}`);
                throw new Error('Authentication failed');
            }
        } catch (e) {
            this.display.error(`auth: authentication failed, error:`, e);
            throw e;
        }
    }

    async tokenRefreshNow() {
        this.token = undefined;
        this.tokenExpiry = undefined;
        await this._ensureValidToken();
    }

    tokenIsValid() {
        const graceTime = Date.now() + TOKEN_EXPIRY_GRACE_PERIOD;
        return this.token && this.tokenExpiry && this.tokenExpiry > graceTime;
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIAuthentication;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
