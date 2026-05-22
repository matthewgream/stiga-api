// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');

const blessed = require('blessed');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class DisplayBase {
    constructor() {
        this.socketPath = path.join(os.tmpdir(), 'stiga-monitor.sock');
        this.blessed = blessed;
    }

    //

    getSocketPath() {
        return this.socketPath;
    }

    removeSocket() {
        try {
            fs.unlinkSync(this.socketPath);
        } catch {
            // Ignore
        }
    }

    //

    displayStart(data, location) {
        this._displayData = data;
        this._displayLocation = location;
        this.screen = this.blessed.screen({
            smartCSR: true,
            title: `STIGA MONITOR - ${location} Display`,
            fullUnicode: true,
        });
        this.robotBox = this.blessed.box({
            parent: this.screen,
            label: ` Robot (${data.robotMac || '-'}) `,
            top: 0,
            left: 0,
            width: '50%',
            height: '60%',
            border: { type: 'line' },
            scrollable: true,
            alwaysScroll: true,
            mouse: true,
            style: {
                fg: 'white',
                border: { fg: location === 'remote' ? 'yellow' : 'cyan' },
            },
        });
        this.baseBox = this.blessed.box({
            parent: this.screen,
            label: ` Base (${data.baseMac || '-'}) `,
            top: 0,
            left: '50%',
            width: '50%',
            height: '60%',
            border: { type: 'line' },
            scrollable: true,
            alwaysScroll: true,
            mouse: true,
            style: {
                fg: 'white',
                border: { fg: location === 'remote' ? 'yellow' : 'cyan' },
            },
        });
        this.logBox = this.blessed.log({
            parent: this.screen,
            label: ' Event Log ',
            top: '60%',
            left: 0,
            width: '100%',
            height: '40%',
            border: { type: 'line' },
            scrollable: true,
            alwaysScroll: true,
            mouse: true,
            scrollbar: {
                ch: ' ',
                track: { bg: location === 'remote' ? 'yellow' : 'cyan' },
                style: { inverse: true },
            },
            style: {
                fg: 'white',
                border: { fg: location === 'remote' ? 'yellow' : 'cyan' },
            },
        });
        this.statusBar = this.blessed.box({
            parent: this.screen,
            bottom: 0,
            left: 0,
            width: '100%',
            height: 1,
            tags: true,
            style: {
                fg: 'black',
                bg: 'white',
                border: { fg: location === 'remote' ? 'yellow' : 'cyan' },
            },
        });

        this.screen.key(['q', 'C-c'], () => this.terminate());

        this.displayUpdate(data, location);
        this.screen.render();
    }
    displayStop() {
        if (this.screen) this.screen.destroy();
    }
    displayRefresh() {
        this.screen.render();
    }
    displayUpdate(data) {
        if (data) this._displayData = data;
        const displayData = this._displayData,
            location = this._displayLocation;
        const robotLines = [
            ``,
            `Version:   ${displayData.robotData.version ?? '-'}`,
            `           ${displayData.robotData.version2 ?? '-'}`,
            ``,
            `Network:   ${displayData.robotData.networkDetail ?? '-'}`,
            `           ${displayData.robotData.networkSignal ?? '-'}`,
            ``,
            `Location:  ${displayData.robotData.locationPosition ?? '-'}`,
            `           ${displayData.robotData.locationOffset ?? '-'}`,
            ``,
            `Status:    ${displayData.robotData.statusType ?? '-'}`,
            `           ${displayData.robotData.statusText ?? '-'}`,
            `           ${displayData.robotData.statusFlag ?? '-'}`,
            `           ${displayData.robotData.statusDocked ?? '-'}`,
            ``,
            `Battery:   ${displayData.robotData.battery ?? '-'}`,
            ``,
            `Position:  ${displayData.robotData.position ?? '-'}`,
            ``,
            `Mowing:    ${displayData.robotData.mowing ?? '-'}`,
            `           ${displayData.robotData.schedule ?? '-'}`,
        ];
        if (data.robotMac !== this.robotMac) {
            this.robotMac = data.robotMac;
            this.robotBox.setLabel(` Robot (${this.robotMac || '-'}) `);
        }
        this.robotBox.setContent(robotLines.join('\n'));
        const baseLines = [
            ``,
            `Version:   ${displayData.baseData.version ?? '-'}`,
            `           ${displayData.baseData.version2 ?? '-'}`,
            ``,
            `Network:   ${displayData.baseData.networkDetail ?? '-'}`,
            `           ${displayData.baseData.networkSignal ?? '-'}`,
            ``,
            `Location:  ${displayData.baseData.locationPosition ?? '-'}`,
            `           ${displayData.baseData.locationOffset ?? '-'}`,
            ``,
            `Status:    ${displayData.baseData.statusType ?? '-'}`,
            `           ${displayData.baseData.statusText ?? '-'}`,
            `           ${displayData.baseData.statusFlag ?? '-'}`,
            `           ${displayData.baseData.statusLED ?? '-'}`,
        ];
        if (data.baseMac !== this.baseMac) {
            this.baseMac = data.baseMac;
            this.baseBox.setLabel(` Base (${data.baseMac || '-'}) `);
        }
        this.baseBox.setContent(baseLines.join('\n'));
        const statusItems = ['monitor', 'capture', 'listen', 'intercept', 'webstatus'].map((item) => `${item[0].toUpperCase()}${item.slice(1)}: ${this._formatStatus(displayData.statusData[item])}`);
        this.statusBar.setContent(` ${location.toUpperCase()} | ${statusItems.join(' | ')} | Press 'q' to quit`);
        this.screen.render();
    }
    displayLog(data) {
        if (this.logBox) {
            this.logBox.log(data);
            this.screen.render();
            return true;
        }
        return false;
    }

    //

    _formatStatus(status) {
        if (status === undefined || status === 'INACTIVE') return '{red-fg}●{/red-fg} OFF';
        if (status === 'ACTIVE') return '{green-fg}●{/green-fg} ON';
        return `{green-fg}●{/green-fg} ${status}`;
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = DisplayBase;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
