#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const fs = require('fs');
const Database = require('better-sqlite3');
const { StigaAPIUtilities } = require('../api/StigaAPI');
const { protobufDecode, formatHexDump, formatStruct } = StigaAPIUtilities;
const { google } = require('googleapis');
const { interpret: interpretMessage } = require('../api/StigaAPIMessages');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class StigaDatabaseExporter {
    constructor(databasePath) {
        this.databasePath = databasePath;
    }

    open() {
        this.db = new Database(this.databasePath, { readonly: true, fileMustExist: true });
        this.db.pragma('journal_mode = WAL');
    }

    close() {
        if (this.db) this.db.close();
    }

    getRowsData(startTime, endTime, head, tail) {
        let query = 'SELECT timestamp, topic, data FROM messages';
        const params = [],
            conditions = [];
        if (startTime) {
            conditions.push('timestamp >= ?');
            params.push(startTime);
        }
        if (endTime) {
            conditions.push('timestamp <= ?');
            params.push(endTime);
        }
        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY timestamp';
        if (head) {
            query += ' LIMIT ?';
            params.push(head);
        } else if (tail) {
            query = `SELECT * FROM (${query} DESC LIMIT ?) ORDER BY timestamp`;
            params.push(tail);
        }
        return this.db.prepare(query).iterate(...params);
    }

    getRowsSchema() {
        return this.db.prepare(`SELECT DISTINCT topic, data FROM messages`).all();
    }

    getTopics() {
        return this.db
            .prepare(`SELECT DISTINCT topic FROM messages`)
            .all()
            .map((row) => row.topic);
    }

    // The canonical message name for a topic: the path with the device/base MAC stripped, e.g.
    //   D0:..:BA/LOG/ROBOT_POSITION  -> LOG/ROBOT_POSITION
    //   CMD_ROBOT_ACK/D0:..:BA       -> CMD_ROBOT_ACK
    // Also reports which device the topic belongs to ('base' or 'robot') for the group shortcuts.
    _classifyTopic(topic, mac_device, mac_base) {
        let name = topic;
        let device;
        for (const [mac, dev] of [
            [mac_device, 'robot'],
            [mac_base, 'base'],
        ]) {
            if (name.startsWith(mac + '/')) {
                name = name.slice(mac.length + 1);
                device = dev;
            } else if (name.endsWith('/' + mac)) {
                name = name.slice(0, name.length - mac.length - 1);
                device = dev;
            }
        }
        return { name, device };
    }

    // A message is "undecoded" if it has no handler (unknown topic), failed protobuf decode, carries
    // protobuf fields the interpreter did not recognise (the "Unknown: [..]" summary line), or decodes a
    // value to the unknown-enum sentinel "UNKNOWN(0xNN)" — e.g. an unmapped command/status type, which
    // otherwise hides mid-line (e.g. "[1] Command Type: UNKNOWN(0x19) (25)") and would slip through.
    _isUndecoded(topic, data, mac_device, mac_base) {
        let lines;
        try {
            lines = interpretMessage(topic, data, { MAC_ROBOT: mac_device, MAC_BASE: mac_base });
        } catch {
            return true;
        }
        return lines.some((line) => line.startsWith('UNKNOWN::') || line.startsWith('Failed to decode message:') || line.startsWith('Unknown: ') || line.includes('UNKNOWN(0x'));
    }

    // Build a row predicate from a comma-separated filter spec, e.g. "undecoded" or
    // "no-base,no-LOG/ROBOT_POSITION". Returns undefined when no filter is requested. A row passes
    // when it matches every requested positive selector ('undecoded') and none of the 'no-*' exclusions.
    // Exclusion targets are the literal message names from the topics (case-insensitive, prefix match):
    //   no-base / no-robot          drop a whole device
    //   no-LOG                      drop every LOG/* message
    //   no-LOG/STATUS               drop LOG/STATUS and LOG/STATUS/ACK
    //   no-CMD_REFERENCE            drop CMD_REFERENCE and CMD_REFERENCE_ACK
    _buildRowFilter(filterStr, mac_device, mac_base) {
        if (!filterStr) return undefined;
        const tokens = filterStr
            .split(',')
            .map((token) => token.trim())
            .filter(Boolean);

        const wantUndecoded = tokens.includes('undecoded');
        const excludeTokens = tokens.filter((token) => token.startsWith('no-')).map((token) => token.slice(3));
        const unknownTokens = tokens.filter((token) => token !== 'undecoded' && !token.startsWith('no-'));
        if (unknownTokens.length > 0) throw new Error(`Unknown filter '${unknownTokens[0]}' (expected 'undecoded' or 'no-<name>')`);

        // Validate exclusion targets against names actually present, so typos are caught early.
        const availableNames = new Set();
        for (const topic of this.getTopics()) availableNames.add(this._classifyTopic(topic, mac_device, mac_base).name);
        const matchesName = (target) => target === 'base' || target === 'robot' || [...availableNames].some((name) => name.toLowerCase().startsWith(target.toLowerCase()));
        for (const target of excludeTokens) if (!matchesName(target)) throw new Error(`Unknown filter 'no-${target}' (available: base, robot, ${[...availableNames].sort().join(', ')})`);

        return (row) => {
            const { name, device } = this._classifyTopic(row.topic, mac_device, mac_base);
            for (const target of excludeTokens) {
                if (target === 'base' || target === 'robot') {
                    if (device === target) return false;
                } else if (name.toLowerCase().startsWith(target.toLowerCase())) return false;
            }
            if (wantUndecoded && !this._isUndecoded(row.topic, row.data, mac_device, mac_base)) return false;
            return true;
        };
    }

    exportToLog({ startTime, endTime, head, tail }, outputFile, filterFn) {
        const output = fs.createWriteStream(outputFile);
        let count = 0;

        for (const row of this.getRowsData(startTime, endTime, head, tail)) {
            if (filterFn && !filterFn(row)) continue;
            this._writeLogRow(output, row);
            if (++count % 10000 === 0) console.log(`Exported ${count} messages...`);
        }

        output.end();
        console.log(`Export complete: ${count} messages written to ${outputFile}`);
        return count;
    }

    async exportToLogVerbose({ startTime, endTime, head, tail }, outputFile, mac_device, mac_base, filterFn) {
        const output = fs.createWriteStream(outputFile);
        let count = 0;
        for (const row of this.getRowsData(startTime, endTime, head, tail)) {
            if (filterFn && !filterFn(row)) continue;
            this._writeLogVerboseRow(output, row, mac_device, mac_base);
            if (++count % 1000 === 0) console.log(`Exported ${count} messages...`);
        }
        output.end();
        console.log(`Export complete: ${count} messages written to ${outputFile}`);
        return count;
    }

    _writeLogRow(output, row) {
        output.write(`${row.timestamp}|${row.topic}|${row.data.toString('hex')}\n`);
    }

    _writeLogVerboseRow(output, row, mac_device, mac_base) {
        const direction = this._getDirection(row.topic, mac_device, mac_base);
        output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} ${direction} PUBLISH\n`);
        output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} Time:       ${row.timestamp}\n`);
        output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} Topic:      ${row.topic}\n`);
        output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} Length:     ${row.data.length} bytes\n`);
        if (row.data.length > 0) {
            formatHexDump(row.data, 'Payload:    ').forEach((line) => output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} ${line}\n`));
            try {
                interpretMessage(row.topic, row.data, { MAC_ROBOT: mac_device, MAC_BASE: mac_base }).forEach((line) => output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} Decode:     ${line}\n`));
            } catch (e) {
                output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} Decode:     Error - ${e.message}\n`);
            }
        }
        output.write(`${row.timestamp} COMMAND=${row.topic.padEnd(48, ' ')} ${'═'.repeat(70)}\n`);
    }

    // Follow capture.db as the monitor writes to it: start at the current max rowid and poll for
    // newly-inserted rows, emitting each (filtered) row in the same plain/verbose format as the
    // one-shot exports. Runs until interrupted (Ctrl-C). `id` autoincrements on insert, so it is a
    // reliable high-water mark even though timestamps can tie. Resolves when `stop()` is called.
    async followLog(output, mac_device, mac_base, filterFn, verbose, pollMs = 1000) {
        const writeRow = verbose ? (row) => this._writeLogVerboseRow(output, row, mac_device, mac_base) : (row) => this._writeLogRow(output, row);
        const stmt = this.db.prepare('SELECT id, timestamp, topic, data FROM messages WHERE id > ? ORDER BY id');
        let lastId = this.db.prepare('SELECT MAX(id) AS id FROM messages').get().id ?? 0;
        let timer;
        await new Promise((resolve) => {
            this._followStop = () => {
                clearInterval(timer);
                resolve();
            };
            timer = setInterval(() => {
                for (const row of stmt.iterate(lastId)) {
                    lastId = row.id;
                    if (filterFn && !filterFn(row)) continue;
                    writeRow(row);
                }
            }, pollMs);
        });
    }

    stopFollow() {
        if (this._followStop) this._followStop();
    }

    _getDirection(topic, mac_device, mac_base) {
        if (topic.includes('/CMD_ROBOT')) return '[]->ROBOT';
        if (topic.includes('CMD_ROBOT_ACK/')) return 'ROBOT->[]';
        if (topic.includes('/CMD_REFERENCE')) return '[]->BASE';
        if (topic.includes('CMD_REFERENCE_ACK/')) return 'BASE->[]';
        if (topic.includes('/LOG/') || topic.includes('/JSON_NOTIFICATION')) {
            if (topic.startsWith(mac_device)) return 'ROBOT->[]';
            if (topic.startsWith(mac_base)) return 'BASE->[]';
            return 'UNKNOWN->[]';
        }
        return 'UNKNOWN';
    }

    async exportToCSV({ startTime, endTime, head, tail }, outputFile, filterFn) {
        console.log('Building schema from database...');
        const schema = this.buildSchema();

        const fields = new Set();
        for (const topicFields of Object.values(schema)) topicFields.forEach((field) => fields.add(field));
        const sortedFields = [...fields].sort((a, b) => {
            const aNum = Number.parseInt(a.split('.')[0]),
                bNum = Number.parseInt(b.split('.')[0]);
            if (!Number.isNaN(aNum) && !Number.isNaN(bNum) && aNum !== bNum) return aNum - bNum;
            return a.localeCompare(b);
        });

        const output = fs.createWriteStream(outputFile);
        let count = 0;

        output.write(['timestamp', 'topic', 'protobuf_hex', ...sortedFields].join(',') + '\n');
        for (const row of this.getRowsData(startTime, endTime, head, tail)) {
            if (filterFn && !filterFn(row)) continue;
            let decoded = {};
            try {
                let buffer = row.data;
                if (row.topic.includes('CMD_REFERENCE_ACK/') && buffer.length > 2 && buffer[0] === 0x20) buffer = buffer.slice(1);
                decoded = protobufDecode(buffer);
            } catch {
                // Keep empty decoded object
            }
            const flattened = this.flattenObject(decoded);
            const csvRow = [row.timestamp, row.topic, row.data.toString('hex')];
            for (const field of sortedFields) {
                const value = flattened[field];
                if (value === undefined) csvRow.push('');
                else if (typeof value === 'string' && value.includes(',')) csvRow.push(`"${value.replaceAll('"', '""')}"`);
                else csvRow.push(value.toString());
            }

            output.write(csvRow.join(',') + '\n');
            if (++count % 10000 === 0) console.log(`Exported ${count} messages...`);
        }

        output.end();
        console.log(`Export complete: ${count} messages written to ${outputFile}`);
        return count;
    }

    async exportToGoogleSheets({ startTime, endTime, head, tail }, spreadsheetName, userEmail, credentialsPath, filterFn) {
        console.log('Building schema from database...');
        const schema = this.buildSchema();

        const fields = new Set();
        for (const topicFields of Object.values(schema)) topicFields.forEach((field) => fields.add(field));
        const sortedFields = [...fields].sort((a, b) => {
            const aNum = Number.parseInt(a.split('.')[0]),
                bNum = Number.parseInt(b.split('.')[0]);
            if (!Number.isNaN(aNum) && !Number.isNaN(bNum) && aNum !== bNum) return aNum - bNum;
            return a.localeCompare(b);
        });

        // Build CSV data in memory
        const data = [];
        data.push(['timestamp', 'topic', 'protobuf_hex', ...sortedFields]);

        let count = 0;
        for (const row of this.getRowsData(startTime, endTime, head, tail)) {
            if (filterFn && !filterFn(row)) continue;
            let decoded = {};
            try {
                let buffer = row.data;
                if (row.topic.includes('CMD_REFERENCE_ACK/') && buffer.length > 2 && buffer[0] === 0x20) buffer = buffer.slice(1);
                decoded = protobufDecode(buffer);
            } catch {
                // Keep empty decoded object
            }
            const flattened = this.flattenObject(decoded);
            const csvRow = [row.timestamp, row.topic, row.data.toString('hex')];
            for (const field of sortedFields) {
                const value = flattened[field];
                if (value === undefined) csvRow.push('');
                else if (typeof value === 'string' && value.includes(',')) csvRow.push(`"${value.replaceAll('"', '""')}"`);
                else csvRow.push(value.toString());
            }
            data.push(csvRow);
            if (++count % 10000 === 0) console.log(`Processed ${count} messages...`);
        }

        console.log(`Processed ${count} messages, uploading to Google Sheets...`);

        // Upload to Google Sheets
        const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

        if (credentials.type !== 'service_account') {
            throw new Error('This requires a service account credentials file!');
        }

        const auth = new google.auth.JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            keyId: credentials.private_key_id,
            scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
            subject: userEmail,
        });

        const sheets = google.sheets({ version: 'v4', auth });

        const columns = data[0] ? data[0].length : 26;
        const rows = data.length || 1000;

        const createResponse = await sheets.spreadsheets.create({
            requestBody: {
                properties: { title: spreadsheetName || `MQTT Export ${new Date().toISOString()}` },
                sheets: [{ properties: { gridProperties: { rowCount: rows + 100, columnCount: Math.max(columns + 10, 26) } } }],
            },
        });

        const { spreadsheetId, properties } = createResponse.data;
        const { sheetId } = createResponse.data.sheets[0].properties;

        console.log(`Created spreadsheet: ${properties.title}`);
        console.log(`Spreadsheet ID: ${spreadsheetId}`);
        console.log(`Sheet ID: ${sheetId}`);
        console.log(`Owner: ${userEmail}`);
        console.log(`Dimensions: ${columns} columns, ${rows} rows`);

        const requests = [];
        requests.push({
            updateCells: {
                range: { sheetId, startRowIndex: 0, startColumnIndex: 0 },
                rows: data.map((row) => ({
                    values: row.map((cell) => ({
                        userEnteredValue: { stringValue: cell.toString() },
                    })),
                })),
                fields: 'userEnteredValue',
            },
        });
        requests.push({
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                    userEnteredFormat: {
                        textFormat: { bold: true },
                        backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                    },
                },
                fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
            },
        });
        requests.push({
            updateSheetProperties: {
                properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                fields: 'gridProperties.frozenRowCount',
            },
        });
        await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

        console.log(`Uploaded ${data.length} rows (including header)`);
        console.log(`URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}`);

        return spreadsheetId;
    }

    buildSchema() {
        const schema = {};
        for (const row of this.getRowsSchema())
            try {
                let buffer = row.data;
                if (row.topic.includes('CMD_REFERENCE_ACK/') && buffer.length > 2 && buffer[0] === 0x20) buffer = buffer.slice(1);
                const decoded = protobufDecode(buffer);
                if (!schema[row.topic]) schema[row.topic] = new Set();
                this.extractFields(decoded, schema[row.topic]);
            } catch {
                // Ignore decode errors
            }
        for (const topic of Object.keys(schema)) schema[topic] = [...schema[topic]];

        return schema;
    }

    extractFields(obj, fieldSet, prefix = '') {
        for (const [key, value] of Object.entries(obj)) {
            const fieldPath = prefix ? `${prefix}.${key}` : key;
            fieldSet.add(fieldPath);
            if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Array.isArray(value)) this.extractFields(value, fieldSet, fieldPath);
        }
    }

    flattenObject(obj, prefix = '') {
        const flattened = {};
        for (const [key, value] of Object.entries(obj)) {
            const fieldPath = prefix ? `${prefix}.${key}` : key;
            if (value === null || value === undefined) flattened[fieldPath] = '';
            else if (Buffer.isBuffer(value)) flattened[fieldPath] = value.toString('hex');
            else if (typeof value === 'object' && !Array.isArray(value)) Object.assign(flattened, this.flattenObject(value, fieldPath));
            else if (Array.isArray(value)) flattened[fieldPath] = JSON.stringify(value);
            else flattened[fieldPath] = value;
        }
        return flattened;
    }

    getStats() {
        const stats = {
            totalMessages: 0,
            topics: {},
            timeRange: { start: undefined, end: undefined },
        };

        const summary = this.db.prepare(`SELECT COUNT(*) as count, MIN(timestamp) as start, MAX(timestamp) as end FROM messages`).get();
        stats.totalMessages = summary.count;
        stats.timeRange.start = summary.start;
        stats.timeRange.end = summary.end;

        const topicCounts = this.db.prepare(`SELECT topic, COUNT(*) as count FROM messages GROUP BY topic ORDER BY count DESC`).all();
        for (const row of topicCounts) stats.topics[row.topic] = row.count;

        return stats;
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args[0] === '--help') {
        console.log(`
Stiga Exporter (SQLite)

Usage:
  stiga-exporter.js <database> [options]
    
Options:
  --format <log|csv|sheets>     Output format (default: log)
  --output <filename>           Output file (for log/csv formats)
  --credentials <file>          Google service account JSON file (required for sheets)
  --sheet-name <name>           Name for the Google Sheet (optional)
  --mac_device=MAC              Device MAC address (default: D0:EF:76:64:32:BA) (for verbose format)
  --mac_base=MAC                Base MAC address (default: FC:E8:C0:72:EC:62) (for verbose format)
  --start <ISO timestamp>       Start time (inclusive)
  --end <ISO timestamp>         End time (inclusive)
  --head <number>               Export only the first N messages
  --tail <number>               Export only the last N messages
  --filter <list>               Comma-separated message filters (applied after head/tail):
                                  undecoded         keep only unknown/undecodable messages
                                  no-base|no-robot  drop a whole device
                                  no-<NAME>         drop messages by topic name (prefix match),
                                                    e.g. no-LOG/ROBOT_POSITION, no-LOG/STATUS,
                                                    no-CMD_REFERENCE, no-LOG (drops all LOG/*)
  --stats                       Show database statistics only
  --verbose                     For log format: output in listen.log format with full decoding
  --follow, -f                  Follow capture.db: stream new messages as the monitor writes them
                                (log format only; honours --filter/--verbose; runs until Ctrl-C).
                                Output defaults to stdout; use --output - explicitly or a filename.

Environment (for Google Sheets):
  GOOGLE_IMPERSONATE_EMAIL      Email to impersonate (REQUIRED for sheets format)
  
Examples:
  stiga-exporter.js capture.db --stats
  stiga-exporter.js capture.db --format csv --output analysis.csv
  stiga-exporter.js capture.db --format sheets --credentials creds.json --sheet-name "MQTT Analysis"
  stiga-exporter.js capture.db --start 2025-06-22T00:00:00Z --end 2025-06-23T00:00:00Z
  stiga-exporter.js capture.db --verbose --filter undecoded
  stiga-exporter.js capture.db --verbose --filter no-base,no-LOG/ROBOT_POSITION
  stiga-exporter.js capture.db --follow --verbose --filter undecoded
  stiga-exporter.js capture.db -f --filter undecoded | grep '|41542b'

Note: This exporter can run while capture is active (uses read-only mode).

Google Sheets Setup:
1. In Google Admin Console, go to Security > API Controls > Domain-wide Delegation
2. Add your service account's client ID
3. Add scopes: https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/drive
`);
        return;
    }

    const dbPath = args[0];
    let format = 'log';
    let outputFile;
    let credentialsFile;
    let sheetName;
    let startTime;
    let endTime;
    let head;
    let tail;
    let showStats = false;
    let verbose = false;
    let follow = false;
    let filter;
    let mac_device = 'D0:EF:76:64:32:BA';
    let mac_base = 'FC:E8:C0:72:EC:62';

    for (let i = 1; i < args.length; i += 2) {
        switch (args[i]) {
            case '--format':
                format = args[i + 1];
                break;
            case '--output':
                outputFile = args[i + 1];
                break;
            case '--credentials':
                credentialsFile = args[i + 1];
                break;
            case '--sheet-name':
                sheetName = args[i + 1];
                break;
            case '--start':
                startTime = args[i + 1];
                break;
            case '--end':
                endTime = args[i + 1];
                break;
            case '--head':
                head = Number.parseInt(args[i + 1]);
                break;
            case '--tail':
                tail = Number.parseInt(args[i + 1]);
                break;
            case '--filter':
                filter = args[i + 1];
                break;
            case '--mac_device':
                mac_device = args[i + 1];
                break;
            case '--mac_base':
                mac_base = args[i + 1];
                break;
            case '--stats':
                showStats = true;
                // eslint-disable-next-line sonarjs/updated-loop-counter
                i--; // No value for this flag
                break;
            case '--verbose':
                verbose = true;
                // eslint-disable-next-line sonarjs/updated-loop-counter
                i--; // No value for this flag
                break;
            case '--follow':
            case '-f':
                follow = true;
                // eslint-disable-next-line sonarjs/updated-loop-counter
                i--; // No value for this flag
                break;
        }
    }

    if (!fs.existsSync(dbPath)) {
        console.error(`Database not found: ${dbPath}`);
        process.exit(1);
    }

    const exporter = new StigaDatabaseExporter(dbPath);
    try {
        exporter.open();
        (follow ? console.error : console.log)(`Opened database: ${dbPath} (read-only mode)`);

        if (showStats) {
            const stats = exporter.getStats();
            console.log('\nDatabase Statistics:');
            console.log(`Total messages: ${stats.totalMessages.toLocaleString()}`);
            console.log(`Time range: ${stats.timeRange.start} to ${stats.timeRange.end}`);
            console.log('\nMessages by topic:');
            Object.entries(stats.topics)
                .sort(([, a], [, b]) => b - a)
                .forEach(([topic, count]) => console.log(`  ${topic}: ${count.toLocaleString()}`));
        } else if (follow) {
            // Stream new rows as the monitor appends them. Diagnostics go to stderr so stdout stays
            // a clean message stream that can be piped to grep/etc.
            const filterFn = exporter._buildRowFilter(filter, mac_device, mac_base);
            const toStdout = !outputFile || outputFile === '-';
            const output = toStdout ? process.stdout : fs.createWriteStream(outputFile);
            console.error(`Following ${dbPath} for new messages (${verbose ? 'verbose' : 'plain'} log${filter ? ', filter: ' + filter : ''}) - Ctrl-C to stop`);
            process.on('SIGINT', () => exporter.stopFollow());
            await exporter.followLog(output, mac_device, mac_base, filterFn, verbose);
            if (!toStdout) output.end();
            console.error('Stopped.');
        } else {
            const filters = { startTime, endTime, head, tail };
            console.log(`format: ${format}`);
            console.log(`filters: ${formatStruct(filters, 'filters')}`);
            const filterFn = exporter._buildRowFilter(filter, mac_device, mac_base);
            if (filter) console.log(`message filter: ${filter}`);

            switch (format) {
                case 'csv':
                    if (!outputFile) outputFile = `export_${new Date().toISOString().split('T')[0]}.csv`;
                    console.log(`Output file: ${outputFile}`);
                    await exporter.exportToCSV(filters, outputFile, filterFn);
                    break;

                case 'sheets':
                    if (!credentialsFile) {
                        console.error('ERROR: --credentials file is required for Google Sheets export!');
                        process.exit(1);
                    }
                    if (!fs.existsSync(credentialsFile)) {
                        console.error(`Credentials file not found: ${credentialsFile}`);
                        process.exit(1);
                    }
                    const userEmail = process.env.GOOGLE_IMPERSONATE_EMAIL;
                    if (!userEmail) {
                        console.error('ERROR: GOOGLE_IMPERSONATE_EMAIL environment variable is required!');
                        console.error('Set it to the email address to impersonate.');
                        process.exit(1);
                    }
                    await exporter.exportToGoogleSheets(filters, sheetName, userEmail, credentialsFile, filterFn);
                    break;

                default: // 'log' format
                    if (!outputFile) outputFile = `export_${new Date().toISOString().split('T')[0]}.log`;
                    console.log(`Output file: ${outputFile}`);
                    verbose ? await exporter.exportToLogVerbose(filters, outputFile, mac_device, mac_base, filterFn) : await exporter.exportToLog(filters, outputFile, filterFn);
                    break;
            }
        }
    } catch (e) {
        console.error('Error:', e.message);
        if (e.message.includes('unauthorized_client')) {
            console.error('\nThis error usually means domain-wide delegation is not configured.');
            console.error('See --help for setup instructions.');
        }
        process.exit(1);
    } finally {
        exporter.close();
    }
}

main().catch(console.error);

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
