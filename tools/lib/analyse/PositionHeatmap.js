// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

/* eslint-disable unicorn/new-for-builtins */

const fs = require('fs');
const path = require('path');
const https = require('https');
// eslint-disable-next-line no-redeclare
const { createCanvas, Image } = require('canvas');

const { StigaAPIUtilities, StigaAPIConfig } = require('../../../api/StigaAPI');
const { protobufDecode } = StigaAPIUtilities;

const AnalyserBase = require('./Analyser');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class PositionHeatmapAnalyser extends AnalyserBase {
    static getMetadata() {
        return {
            command: 'position-heatmap',
            description: 'Generate position heatmaps from robot data',
            detailedDescription: 'Creates satellite and RSSI signal strength heatmaps overlaid on Google Maps satellite imagery.',
            options: {
                '--apikey': 'Google Maps API key (REQUIRED for image format)',
                '--format': 'Output: image (default, JPEGs) or json (lat/lng coordinate cells for a live map overlay; no apikey needed)',
                '--days': 'Limit analysis to the last N days (default: all data)',
                '--metric': 'For --format json: satellites | rssi (default: both)',
                '--lat': 'Center latitude (override stiga-config.js referencePosition.latitude)',
                '--lon': 'Center longitude (override stiga-config.js referencePosition.longitude)',
                '--zoom': 'Map zoom level (default: 18)',
                '--size': 'Map size in pixels (default: 640)',
                '--grid': 'Grid resolution (default: 100)',
                '--smooth': 'Smoothing radius (default: 3)',
                '--color': 'Color scheme: default or thermal (default: default)',
                '--dynamic-range': 'Use dynamic data range instead of static',
                '--clamp-percentile': 'Clamp to percentile range, e.g. 5:95',
                '--output': 'Output directory (default: /opt/stiga-api/assets)',
            },
            examples: [
                'stiga-analyse.js position-heatmap --apikey YOUR_KEY',
                'stiga-analyse.js position-heatmap --apikey YOUR_KEY --zoom 19 --smooth 5 --color thermal',
                'stiga-analyse.js position-heatmap --apikey YOUR_KEY --dynamic-range --clamp-percentile 10:90',
            ],
        };
    }

    constructor(databasePath) {
        super(databasePath);
        const ref = StigaAPIConfig.load().referencePosition;
        this.positionData = {
            metadata: {
                generated: new Date().toISOString(),
                totalMatches: 0,
                robotPositions: 0,
                robotStatuses: 0,
                timeTolerance: 2000,
                baseReferenceLocation: ref,
            },
            matches: [],
        };
    }

    async analyze(options = {}) {
        this.format = options['--format'] || 'image';
        this.metric = options['--metric']; // 'satellites' | 'rssi' | undefined (both)
        this.days = options['--days'] === undefined ? undefined : Number.parseFloat(options['--days']);
        this.quiet = this.format === 'json'; // json output must be clean stdout — suppress progress logs
        const ref = StigaAPIConfig.load().referencePosition;
        if (options['--lat'] === undefined && ref?.latitude === undefined) throw new Error('Error: center latitude not set; provide --lat or referencePosition in stiga-config.js');
        if (options['--lon'] === undefined && ref?.longitude === undefined) throw new Error('Error: center longitude not set; provide --lon or referencePosition in stiga-config.js');
        this.centerLat = options['--lat'] === undefined ? ref.latitude : Number.parseFloat(options['--lat']);
        this.centerLng = options['--lon'] === undefined ? ref.longitude : Number.parseFloat(options['--lon']);
        this.originalCenterLat = this.centerLat;
        this.originalCenterLng = this.centerLng;

        // JSON mode: no Google base map (so no apikey), no canvas — just emit lat/lng cells for a live overlay.
        if (this.format === 'json') {
            this.loadPositionData(options.robotMac);
            this._emitHeatmapJson();
            return;
        }

        this.apiKey = options['--apikey'];
        if (!this.apiKey) throw new Error('Error: Google Maps API key is required (--apikey)');
        this.zoom = Number.parseInt(options['--zoom'] || '18');
        this.mapSize = Number.parseInt(options['--size'] || '640');
        this.gridSize = Number.parseInt(options['--grid'] || '100');
        this.smoothingRadius = Number.parseInt(options['--smooth'] || '3');
        this.colorScheme = options['--color'] || 'default';
        this.useDynamicRange = options['--dynamic-range'] || false;
        this.percentileClamp = options['--clamp-percentile'] ? options['--clamp-percentile'].split(':').map((v) => Number.parseFloat(v)) : undefined;
        this.outputDir = options['--output'] || '/opt/stiga-api/assets';

        this.metersPerPixel = (156543.03392 * Math.cos((this.centerLat * Math.PI) / 180)) / 2 ** this.zoom;
        this.originalCenterLat = this.centerLat;
        this.originalCenterLng = this.centerLng;
        this.dataRanges = {
            satellites: { min: Infinity, max: -Infinity },
            rssi: { min: Infinity, max: -Infinity },
        };

        console.log('Loading position and status data from database...');
        this.loadPositionData(options.robotMac);
        console.log(`Found ${this.positionData.matches.length} matched data points`);

        console.log(`\nConfiguration:`);
        console.log(`  Initial center: ${this.centerLat}, ${this.centerLng}`);
        console.log(`  Zoom: ${this.zoom}`);
        console.log(`  Map size: ${this.mapSize}x${this.mapSize}`);
        console.log(`  Grid resolution: ${this.gridSize}x${this.gridSize}`);
        console.log(`  Smoothing radius: ${this.smoothingRadius}`);
        console.log(`  Color scheme: ${this.colorScheme}`);
        console.log(`  Range mode: ${this.useDynamicRange ? 'dynamic' : 'static'}`);
        console.log(`  Output directory: ${this.outputDir}`);

        await this.generateHeatmaps();
    }

    // SQL fragment to cap the query to the last N days (this.days), or '' for all data.
    _daysClause() {
        if (this.days === undefined || !Number.isFinite(this.days)) return '';
        const cutoff = new Date(Date.now() - this.days * 24 * 60 * 60 * 1000).toISOString();
        return `AND timestamp > '${cutoff}'`;
    }

    // eslint-disable-next-line sonarjs/cognitive-complexity
    loadPositionData(robotMac) {
        const robotPositions = [],
            robotStatuses = [];
        const positionQuery = `
            SELECT timestamp, data
            FROM messages
            WHERE topic LIKE '%${robotMac}/LOG/ROBOT_POSITION%' ${this._daysClause()}
            ORDER BY timestamp
        `;
        for (const row of this.db.prepare(positionQuery).all())
            try {
                const decoded = protobufDecode(row.data);
                if (decoded[1] && decoded[2]) {
                    const xOffsetM = this.hexToDouble(decoded[1]),
                        yOffsetM = this.hexToDouble(decoded[2]);
                    if (xOffsetM !== undefined && yOffsetM !== undefined) {
                        const position = {
                            timestamp: row.timestamp,
                            time: new Date(row.timestamp).getTime(),
                            xOffsetM,
                            yOffsetM,
                            offsetDistanceM: Math.hypot(xOffsetM, yOffsetM),
                            offsetDegrees: (Math.atan2(xOffsetM, yOffsetM) * 180) / Math.PI,
                            offsetCompass: (90 - (Math.atan2(xOffsetM, yOffsetM) * 180) / Math.PI + 360) % 360,
                        };
                        if (decoded[3]) {
                            const orientRad = this.hexToDouble(decoded[3]);
                            if (orientRad !== undefined) {
                                position.orientRad = orientRad;
                                position.orientationDegrees = (orientRad * 180) / Math.PI;
                                position.orientationCompass = (450 - position.orientationDegrees) % 360;
                            }
                        }
                        robotPositions.push(position);
                    }
                }
            } catch {
                // Skip messages that can't be decoded
            }
        const statusQuery = `
            SELECT timestamp, data
            FROM messages
            WHERE topic LIKE '%${robotMac}/LOG/STATUS%' ${this._daysClause()}
            ORDER BY timestamp
        `;
        for (const row of this.db.prepare(statusQuery).all())
            try {
                const decoded = protobufDecode(row.data);
                const status = {
                    timestamp: row.timestamp,
                    time: new Date(row.timestamp).getTime(),
                };
                if (decoded[19]) {
                    const location = {};
                    if (decoded[19][1] !== undefined) location.coverage = decoded[19][1];
                    if (decoded[19][2] !== undefined) location.satellites = decoded[19][2];
                    if (Object.keys(location).length > 0) status.location = location;
                }
                if (decoded[20]?.[3]) {
                    const network = {};
                    const netData = decoded[20][3];
                    if (netData[4]) network.network = netData[4];
                    if (netData[5]) network.type = netData[5];
                    if (netData[6]) network.band = netData[6];
                    if (netData[7] !== undefined) network.rssi = netData[7] > 0x7fffffff ? netData[7] - 0x100000000 : netData[7];
                    if (Object.keys(network).length > 0) status.network = network;
                }
                if (status.location || status.network) robotStatuses.push(status);
            } catch {
                // Skip messages that can't be decoded
            }
        if (!this.quiet) console.log(`  Robot positions: ${robotPositions.length}`);
        if (!this.quiet) console.log(`  Robot statuses with location/network: ${robotStatuses.length}`);
        // Match each position to the closest status within tolerance. Both arrays are time-sorted, so a
        // forward-only two-pointer (the closest is always one of the two neighbours of the position's time)
        // does this in O(n+m) instead of O(n*m) — ~60x faster on a week of data.
        const tol = this.positionData.metadata.timeTolerance;
        let j = 0;
        for (const robotPosition of robotPositions) {
            while (j < robotStatuses.length && robotStatuses[j].time < robotPosition.time) j++;
            let best,
                bestDiff = Infinity;
            if (j < robotStatuses.length) {
                const d = robotStatuses[j].time - robotPosition.time;
                if (d <= tol && d < bestDiff) {
                    best = robotStatuses[j];
                    bestDiff = d;
                }
            }
            if (j > 0) {
                const d = robotPosition.time - robotStatuses[j - 1].time;
                if (d <= tol && d < bestDiff) {
                    best = robotStatuses[j - 1];
                    bestDiff = d;
                }
            }
            const match = { timestamp: robotPosition.timestamp, robotPosition };
            if (best) match.robotStatus = { ...best, timeDiffMs: bestDiff };
            this.positionData.matches.push(match);
        }
        this.positionData.metadata.totalMatches = this.positionData.matches.length;
        this.positionData.metadata.robotPositions = robotPositions.length;
        this.positionData.metadata.robotStatuses = robotStatuses.length;
    }

    // Emit a JSON heatmap for a live map overlay: spatially aggregate matched points into ~metre cells (in the
    // base-relative ENU frame), average the metric per cell, convert the cell centre back to lat/lng, and
    // normalise the value to 0..1 over a static range. Pure JSON to stdout (no progress, no images, no apikey).
    _emitHeatmapJson() {
        const CELL_M = 1.5; // grid cell size, metres
        const RANGES = { satellites: { min: 0, max: 30, unit: '' }, rssi: { min: -110, max: -50, unit: 'dBm' } };
        const metrics = this.metric ? [this.metric] : ['satellites', 'rssi'];
        const out = { format: 'heatmap', generated: new Date().toISOString(), days: this.days, cellM: CELL_M, base: { lat: this.centerLat, lng: this.centerLng }, metrics: {} };
        for (const metric of metrics) {
            const range = RANGES[metric];
            if (!range) continue;
            const cells = new Map(); // "gx,gy" -> { sum, count, gx, gy }
            for (const match of this.positionData.matches) {
                const rp = match.robotPosition;
                if (!rp) continue;
                const value = metric === 'satellites' ? match.robotStatus?.location?.satellites : match.robotStatus?.network?.rssi;
                if (value === undefined || value === null) continue;
                const gx = Math.round(rp.xOffsetM / CELL_M),
                    gy = Math.round(rp.yOffsetM / CELL_M),
                    key = `${gx},${gy}`;
                const cell = cells.get(key) || { sum: 0, count: 0, gx, gy };
                cell.sum += value;
                cell.count++;
                cells.set(key, cell);
            }
            const list = [];
            for (const cell of cells.values()) {
                const avg = cell.sum / cell.count,
                    xM = cell.gx * CELL_M,
                    yM = cell.gy * CELL_M;
                const lat = this.centerLat + (yM / 6371000) * (180 / Math.PI),
                    lng = this.centerLng + ((xM / 6371000) * (180 / Math.PI)) / Math.cos((this.centerLat * Math.PI) / 180);
                const v = Math.max(0, Math.min(1, (avg - range.min) / (range.max - range.min)));
                list.push({ lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)), v: Number(v.toFixed(3)), value: Math.round(avg * 10) / 10, n: cell.count });
            }
            out.metrics[metric] = { range, cells: list };
        }
        out.stats = { matches: this.positionData.matches.length };
        process.stdout.write(`${JSON.stringify(out)}\n`);
    }

    hexToDouble(value) {
        if (Buffer.isBuffer(value)) return value.length === 8 ? value.readDoubleLE(0) : undefined;
        let hexStr = String(value).replaceAll(/["']/g, '');
        if (hexStr && hexStr.length < 16 && hexStr.length % 2 === 0) hexStr = hexStr.padStart(16, '0');
        if (!hexStr || hexStr.length !== 16 || !/^[\da-f]+$/i.test(hexStr)) return undefined;
        try {
            return Buffer.from(hexStr, 'hex').readDoubleLE(0);
        } catch {
            return undefined;
        }
    }

    async generateHeatmaps() {
        if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });

        console.log(`\nProcessing ${this.positionData.matches.length} data points...`);
        this.calculateDataCenter(this.positionData);
        console.log(`\nData center calculated:`);
        console.log(`  Latitude: ${this.centerLat}`);
        console.log(`  Longitude: ${this.centerLng}`);

        if (this.useDynamicRange) {
            this.calculateDataRanges(this.positionData);
            console.log('\nUsing dynamic data ranges:');
            if (this.percentileClamp) console.log(`  (Clamped to ${this.percentileClamp[0]}-${this.percentileClamp[1]} percentiles)`);
            console.log(`  Satellites: ${this.dataRanges.satellites.min} to ${this.dataRanges.satellites.max}`);
            console.log(`  RSSI: ${this.dataRanges.rssi.min} to ${this.dataRanges.rssi.max} dBm\n`);
        } else {
            console.log('\nUsing static data ranges:');
            console.log('  Satellites: 0 to 30');
            console.log('  RSSI: -110 to -50 dBm\n');
        }

        const baseMapPath = path.join(this.outputDir, 'base_map.jpg');
        await this.downloadBaseMap(baseMapPath);
        console.log(`Base map saved to: ${baseMapPath}`);

        const satelliteData = this.extractSatelliteData(this.positionData);
        if (satelliteData.length > 0) {
            const satelliteHeatmap = await this.generateHeatmap(satelliteData, 'satellites', baseMapPath);
            const satellitePath = path.join(this.outputDir, 'heatmap_satellites.jpg');
            await this.saveImage(satelliteHeatmap, satellitePath);
            console.log(`Satellite heatmap saved to: ${satellitePath}`);
        }

        const rssiData = this.extractRSSIData(this.positionData);
        if (rssiData.length > 0) {
            const rssiHeatmap = await this.generateHeatmap(rssiData, 'rssi', baseMapPath);
            const rssiPath = path.join(this.outputDir, 'heatmap_rssi.jpg');
            await this.saveImage(rssiHeatmap, rssiPath);
            console.log(`RSSI heatmap saved to: ${rssiPath}`);
        }

        await this.generateCombinedVisualization(this.positionData, this.outputDir);
    }

    calculateDataRanges(positionData) {
        const satelliteValues = [];
        const rssiValues = [];

        positionData.matches.forEach((match) => {
            if (match.robotStatus?.location?.satellites !== undefined) satelliteValues.push(match.robotStatus.location.satellites);
            if (match.robotStatus?.network?.rssi !== undefined) rssiValues.push(match.robotStatus.network.rssi);
        });

        if (this.percentileClamp) {
            const [lowPerc, highPerc] = this.percentileClamp;
            if (satelliteValues.length > 0) {
                this.dataRanges.satellites.min = this.calculatePercentile(satelliteValues, lowPerc);
                this.dataRanges.satellites.max = this.calculatePercentile(satelliteValues, highPerc);
            }
            if (rssiValues.length > 0) {
                this.dataRanges.rssi.min = this.calculatePercentile(rssiValues, lowPerc);
                this.dataRanges.rssi.max = this.calculatePercentile(rssiValues, highPerc);
            }
        } else {
            satelliteValues.forEach((val) => {
                this.dataRanges.satellites.min = Math.min(this.dataRanges.satellites.min, val);
                this.dataRanges.satellites.max = Math.max(this.dataRanges.satellites.max, val);
            });
            rssiValues.forEach((val) => {
                this.dataRanges.rssi.min = Math.min(this.dataRanges.rssi.min, val);
                this.dataRanges.rssi.max = Math.max(this.dataRanges.rssi.max, val);
            });
            if (this.dataRanges.satellites.min !== Infinity) {
                const satelliteBuffer = (this.dataRanges.satellites.max - this.dataRanges.satellites.min) * 0.05 || 1;
                this.dataRanges.satellites.min = Math.max(0, this.dataRanges.satellites.min - satelliteBuffer);
                this.dataRanges.satellites.max += satelliteBuffer;
            }
            if (this.dataRanges.rssi.min !== Infinity) {
                const rssiBuffer = (this.dataRanges.rssi.max - this.dataRanges.rssi.min) * 0.05 || 5;
                this.dataRanges.rssi.min -= rssiBuffer;
                this.dataRanges.rssi.max += rssiBuffer;
            }
        }
    }

    calculatePercentile(data, percentile) {
        const sorted = [...data].sort((a, b) => a - b);
        const index = Math.floor((percentile / 100) * sorted.length);
        return sorted[Math.min(index, sorted.length - 1)];
    }

    calculateDataCenter(positionData) {
        const positions = positionData.matches
            .filter((match) => match.robotPosition)
            .map((match) => ({
                lat: this.centerLat + (match.robotPosition.yOffsetM / 6371000) * (180 / Math.PI),
                lon: this.centerLng + ((match.robotPosition.xOffsetM / 6371000) * (180 / Math.PI)) / Math.cos((this.centerLat * Math.PI) / 180),
            }));
        if (positions.length > 0) {
            let minLat = Infinity,
                maxLat = -Infinity;
            let minLon = Infinity,
                maxLon = -Infinity;
            positions.forEach((pos) => {
                minLat = Math.min(minLat, pos.lat);
                maxLat = Math.max(maxLat, pos.lat);
                minLon = Math.min(minLon, pos.lon);
                maxLon = Math.max(maxLon, pos.lon);
            });
            this.centerLat = (minLat + maxLat) / 2;
            this.centerLng = (minLon + maxLon) / 2;
            this.metersPerPixel = (156543.03392 * Math.cos((this.centerLat * Math.PI) / 180)) / 2 ** this.zoom;
            console.log(`  Bounding box: ${minLat},${minLon} to ${maxLat},${maxLon}`);
        }
    }

    async downloadBaseMap(outputPath) {
        const url = `https://maps.googleapis.com/maps/api/staticmap?center=${this.centerLat},${this.centerLng}&zoom=${this.zoom}&size=${this.mapSize}x${this.mapSize}&maptype=satellite&key=${this.apiKey}`;
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(outputPath);
            https
                .get(url, (response) => {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        resolve();
                    });
                })
                .on('error', (err) => {
                    fs.unlink(outputPath, () => {}); // Delete the file on error
                    reject(err);
                });
        });
    }

    extractSatelliteData(positionData) {
        return positionData.matches
            .filter((match) => match.robotPosition && match.robotStatus?.location?.satellites)
            .map((match) => {
                const pos = this.offsetToPixel(match.robotPosition.xOffsetM, match.robotPosition.yOffsetM);
                return {
                    x: pos.x,
                    y: pos.y,
                    value: match.robotStatus.location.satellites,
                };
            });
    }

    extractRSSIData(positionData) {
        return positionData.matches
            .filter((match) => match.robotPosition && match.robotStatus?.network?.rssi)
            .map((match) => {
                const pos = this.offsetToPixel(match.robotPosition.xOffsetM, match.robotPosition.yOffsetM);
                return {
                    x: pos.x,
                    y: pos.y,
                    value: match.robotStatus.network.rssi,
                };
            });
    }

    offsetToPixel(xOffsetM, yOffsetM) {
        const latOffset = (yOffsetM / 6371000) * (180 / Math.PI),
            lonOffset = ((xOffsetM / 6371000) * (180 / Math.PI)) / Math.cos((this.originalCenterLat * Math.PI) / 180);
        const actualLat = this.originalCenterLat + latOffset,
            actualLon = this.originalCenterLng + lonOffset;
        const dLat = actualLat - this.centerLat,
            dLon = actualLon - this.centerLng;
        const yMeters = dLat * (Math.PI / 180) * 6371000,
            xMeters = dLon * (Math.PI / 180) * 6371000 * Math.cos((this.centerLat * Math.PI) / 180);
        const centerX = this.mapSize / 2,
            centerY = this.mapSize / 2;
        const pixelX = centerX + xMeters / this.metersPerPixel,
            pixelY = centerY - yMeters / this.metersPerPixel; // Y is inverted
        return { x: Math.round(pixelX), y: Math.round(pixelY) };
    }

    async generateHeatmap(data, type, baseMapPath) {
        const canvas = createCanvas(this.mapSize, this.mapSize);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(await this.loadImage(baseMapPath), 0, 0);
        this.drawHeatmapOverlay(ctx, this.applyGaussianSmoothing(this.createDataGrid(data, type)), type);
        this.drawLegend(ctx, type);
        this.drawTitle(ctx, type);
        return canvas;
    }

    createDataGrid(data, type) {
        const grid = Array(this.gridSize)
            .fill(undefined)
            .map(() =>
                Array(this.gridSize)
                    .fill(undefined)
                    .map(() => ({ sum: 0, count: 0 }))
            );
        data.forEach((point) => {
            const gridX = Math.floor((point.x * this.gridSize) / this.mapSize),
                gridY = Math.floor((point.y * this.gridSize) / this.mapSize);
            if (gridX >= 0 && gridX < this.gridSize && gridY >= 0 && gridY < this.gridSize) {
                grid[gridY][gridX].sum += point.value;
                grid[gridY][gridX].count += 1;
            }
        });
        const resultGrid = Array(this.gridSize)
            .fill(undefined)
            .map(() => Array(this.gridSize).fill(undefined));
        for (let y = 0; y < this.gridSize; y++)
            for (let x = 0; x < this.gridSize; x++)
                if (grid[y][x].count > 0) {
                    const avgValue = grid[y][x].sum / grid[y][x].count;
                    let range;
                    if (type === 'satellites')
                        range = this.useDynamicRange ? this.dataRanges.satellites : { min: 0, max: 30 }; // 0-30 satellites
                    else if (type === 'rssi') range = this.useDynamicRange ? this.dataRanges.rssi : { min: -110, max: -50 }; // -110 to -50 dBm
                    resultGrid[y][x] = Math.max(0, Math.min(1, (avgValue - range.min) / (range.max - range.min)));
                }
        return resultGrid;
    }

    applyGaussianSmoothing(grid) {
        const kernelSize = this.smoothingRadius * 2 + 1;
        const kernel = this.createGaussianKernel(this.smoothingRadius);
        const smoothed = Array(this.gridSize)
            .fill(undefined)
            .map(() => Array(this.gridSize).fill(undefined));
        for (let y = 0; y < this.gridSize; y++)
            for (let x = 0; x < this.gridSize; x++) {
                let sum = 0,
                    weightSum = 0;
                for (let ky = 0; ky < kernelSize; ky++)
                    for (let kx = 0; kx < kernelSize; kx++) {
                        const gridY = y + ky - this.smoothingRadius,
                            gridX = x + kx - this.smoothingRadius;
                        if (gridY >= 0 && gridY < this.gridSize && gridX >= 0 && gridX < this.gridSize && grid[gridY][gridX] !== undefined) {
                            sum += grid[gridY][gridX] * kernel[ky][kx];
                            weightSum += kernel[ky][kx];
                        }
                    }
                smoothed[y][x] = weightSum > 0 ? sum / weightSum : undefined;
            }
        return smoothed;
    }

    createGaussianKernel(radius) {
        const size = radius * 2 + 1;
        const kernel = Array(size)
            .fill(undefined)
            .map(() => Array(size).fill(0));
        const sigma = radius / 3;
        const norm = 1 / (2 * Math.PI * sigma * sigma);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) kernel[y][x] = norm * Math.exp(-((x - radius) * (x - radius) + (y - radius) * (y - radius)) / (2 * sigma * sigma));
        return kernel;
    }

    drawHeatmapOverlay(ctx, grid, type) {
        const cellWidth = this.mapSize / this.gridSize,
            cellHeight = this.mapSize / this.gridSize;
        ctx.globalAlpha = 0.6;
        for (let y = 0; y < this.gridSize; y++)
            for (let x = 0; x < this.gridSize; x++)
                if (grid[y][x] !== undefined) {
                    ctx.fillStyle = this.valueToColor(grid[y][x], type);
                    ctx.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);
                }
        ctx.globalAlpha = 1;
    }

    valueToColor(value, _type) {
        const stops =
            this.colorScheme === 'thermal'
                ? [
                      { pos: 0, color: [0, 0, 0] },
                      { pos: 0.15, color: [0, 0, 139] },
                      { pos: 0.3, color: [0, 255, 255] },
                      { pos: 0.45, color: [0, 255, 0] },
                      { pos: 0.6, color: [255, 255, 0] },
                      { pos: 0.8, color: [255, 0, 0] },
                      { pos: 1, color: [255, 255, 255] },
                  ] // Thermal color scheme: black -> blue -> cyan -> green -> yellow -> red -> white
                : [
                      { pos: 0, color: [0, 0, 255] },
                      { pos: 0.33, color: [0, 255, 0] },
                      { pos: 0.66, color: [255, 255, 0] },
                      { pos: 1, color: [255, 0, 0] },
                  ]; // Default color scheme: blue -> green -> yellow -> red
        return this.interpolateColor(value, stops);
    }

    interpolateColor(value, stops) {
        let lower, upper;
        for (let i = 0; i < stops.length - 1; i++)
            if (value >= stops[i].pos && value <= stops[i + 1].pos) {
                lower = stops[i];
                upper = stops[i + 1];
                break;
            }
        if (!lower || !upper) return value <= 0 ? `rgb(${stops[0].color.join(',')})` : `rgb(${stops[stops.length - 1].color.join(',')})`;
        const t = (value - lower.pos) / (upper.pos - lower.pos),
            r = Math.round(lower.color[0] + t * (upper.color[0] - lower.color[0])),
            g = Math.round(lower.color[1] + t * (upper.color[1] - lower.color[1])),
            b = Math.round(lower.color[2] + t * (upper.color[2] - lower.color[2]));
        return `rgb(${r},${g},${b})`;
    }

    drawLegend(ctx, type) {
        const legendWidth = 200,
            legendHeight = 30;
        const legendX = this.mapSize - legendWidth - 20,
            legendY = this.mapSize - legendHeight - 60;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(legendX - 10, legendY - 30, legendWidth + 20, legendHeight + 50);
        const gradient = ctx.createLinearGradient(legendX, legendY, legendX + legendWidth, legendY);
        for (let i = 0; i <= 10; i++) gradient.addColorStop(i / 10, this.valueToColor(i / 10, type));
        ctx.fillStyle = gradient;
        ctx.fillRect(legendX, legendY, legendWidth, legendHeight);
        ctx.strokeStyle = '#000';
        ctx.strokeRect(legendX, legendY, legendWidth, legendHeight);
        ctx.fillStyle = '#000';
        ctx.font = '12px Arial';
        ctx.textAlign = 'center';
        let minLabel, maxLabel, title;
        if (this.useDynamicRange) {
            if (type === 'satellites') {
                minLabel = Math.floor(this.dataRanges.satellites.min).toString();
                maxLabel = Math.ceil(this.dataRanges.satellites.max).toString();
                title = 'Satellites (dynamic)';
            } else if (type === 'rssi') {
                minLabel = `${Math.floor(this.dataRanges.rssi.min)} dBm`;
                maxLabel = `${Math.ceil(this.dataRanges.rssi.max)} dBm`;
                title = 'RSSI Signal (dynamic)';
            }
        } else {
            if (type === 'satellites') {
                minLabel = '0';
                maxLabel = '30';
                title = 'Satellites';
            } else if (type === 'rssi') {
                minLabel = '-110 dBm';
                maxLabel = '-50 dBm';
                title = 'RSSI Signal';
            }
        }
        ctx.fillText(title, legendX + legendWidth / 2, legendY - 10);
        ctx.textAlign = 'left';
        ctx.fillText(minLabel, legendX, legendY + legendHeight + 15);
        ctx.textAlign = 'right';
        ctx.fillText(maxLabel, legendX + legendWidth, legendY + legendHeight + 15);
    }

    drawTitle(ctx, type) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(10, 10, 350, 40);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'left';
        ctx.fillText((type === 'satellites' ? 'Satellite Coverage Heatmap' : 'RSSI Signal Strength Heatmap') + (this.useDynamicRange ? ' (Dynamic Range)' : ''), 20, 35);
        ctx.font = '12px Arial';
        ctx.fillText(`Generated: ${new Date().toISOString().split('T')[0]}`, 20, 48);
    }

    async generateCombinedVisualization(positionData, outputDir) {
        const canvas = createCanvas(this.mapSize * 2 + 20, this.mapSize + 100);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const satellitePath = path.join(outputDir, 'heatmap_satellites.jpg');
        if (fs.existsSync(satellitePath)) ctx.drawImage(await this.loadImage(satellitePath), 10, 50);
        const rssiPath = path.join(outputDir, 'heatmap_rssi.jpg');
        if (fs.existsSync(rssiPath)) ctx.drawImage(await this.loadImage(rssiPath), this.mapSize + 20, 50);
        ctx.fillStyle = '#000';
        ctx.font = 'bold 24px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Stiga Robot Coverage Analysis' + (this.useDynamicRange ? ' (Dynamic Range)' : ''), canvas.width / 2, 30);
        const stats = this.calculateStats(positionData);
        ctx.font = '14px Arial';
        ctx.fillText(`Total data points: ${stats.totalPoints} | Time range: ${stats.timeRange}`, canvas.width / 2, canvas.height - 20);
        const combinedPath = path.join(outputDir, 'heatmap_combined.jpg');
        await this.saveImage(canvas, combinedPath);
        console.log(`Combined visualization saved to: ${combinedPath}`);
    }

    calculateStats(positionData) {
        let minTime = Infinity,
            maxTime = -Infinity;
        let totalPoints = 0;
        positionData.matches.forEach((match) => {
            const time = new Date(match.timestamp).getTime();
            minTime = Math.min(minTime, time);
            maxTime = Math.max(maxTime, time);
            totalPoints++;
        });
        const timeRange = minTime === Infinity ? 'N/A' : `${new Date(minTime).toISOString().split('T')[0]} to ${new Date(maxTime).toISOString().split('T')[0]}`;
        return { totalPoints, timeRange };
    }

    /* eslint-disable unicorn/prefer-add-event-listener */
    async loadImage(path) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = path;
        });
    }

    async saveImage(canvas, path) {
        await fs.promises.writeFile(path, canvas.toBuffer('image/jpeg', { quality: 0.95 }));
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = PositionHeatmapAnalyser;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
