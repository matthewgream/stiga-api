// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const StigaAPIComponent = require('./StigaAPIComponent');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaAPIConnectionServer extends StigaAPIComponent {
    static getServerURL() {
        return 'https://connectivity-production.stiga.com';
    }

    constructor(auth, options = {}) {
        super(options);
        this.auth = auth;
        this.baseUrl = StigaAPIConnectionServer.getServerURL();
        this._connected = false;
    }

    async isConnected() {
        try {
            const response = await this.get('/api/user');
            this._connected = response.ok;
            return this._connected;
        } catch {
            this._connected = false;
            return false;
        }
    }

    async get(endpoint, queryParams = {}) {
        const url = new URL(this.baseUrl + endpoint);

        Object.entries(queryParams).forEach(([key, value]) => url.searchParams.append(key, value));
        const requestOptions = {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        };
        await this.auth.addAuthentication(requestOptions);

        try {
            const response = await fetch(url.toString(), requestOptions);
            if (!response.ok) this.display.error(`connection: http get request failed: ${response.status} ${response.statusText}`);
            return response;
        } catch (e) {
            this.display.error(`connection: http get request error:`, e);
            throw e;
        }
    }

    async post(endpoint, data = {}) {
        const url = new URL(this.baseUrl + endpoint);

        const requestOptions = {
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        };
        await this.auth.addAuthentication(requestOptions);

        try {
            const response = await fetch(url.toString(), requestOptions);
            if (!response.ok) this.display.error(`connection: http post request failed: ${response.status} ${response.statusText}`);
            return response;
        } catch (e) {
            this.display.error(`connection: http post request error:`, e);
            throw e;
        }
    }

    async patch(endpoint, data = {}) {
        const url = new URL(this.baseUrl + endpoint);

        const requestOptions = {
            method: 'PATCH',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        };
        await this.auth.addAuthentication(requestOptions);

        try {
            const response = await fetch(url.toString(), requestOptions);
            if (!response.ok) this.display.error(`connection: http patch request failed: ${response.status} ${response.statusText}`);
            return response;
        } catch (e) {
            this.display.error(`connection: http patch request error:`, e);
            throw e;
        }
    }

    async delete(endpoint) {
        const url = new URL(this.baseUrl + endpoint);

        const requestOptions = {
            method: 'DELETE',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
        };
        await this.auth.addAuthentication(requestOptions);

        try {
            const response = await fetch(url.toString(), requestOptions);
            if (!response.ok) this.display.error(`connection: http delete request failed: ${response.status} ${response.statusText}`);
            return response;
        } catch (e) {
            this.display.error(`connection: http delete request error:`, e);
            throw e;
        }
    }

    getBaseUrl() {
        return this.baseUrl;
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = StigaAPIConnectionServer;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
