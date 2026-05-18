#!/usr/bin/env node

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const express = require('express');
const fs = require('fs');
const Database = require('better-sqlite3');

const { StigaAPIUtilities, StigaAPIConfig } = require('../api/StigaAPI');
const { protobufDecode } = StigaAPIUtilities;

const REFERENCE_POSITION = (() => {
    const ref = StigaAPIConfig.load().referencePosition;
    if (!ref?.latitude || !ref?.longitude) throw new Error('stiga-position-viewer: referencePosition not set in stiga-config.js');
    return ref;
})();

const TIME_TOLERANCE_MS = 2000;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

function displayHelp() {
    console.log(`
Robot Position Map Viewer

Usage:
  position-viewer.js <database> --apikey <key> [options]

Required:
  <database>               Path to SQLite database file
  --apikey                 Google Maps API key

Optional:
  --lat                    Override center latitude (default: auto-calculated from data)
  --lon                    Override center longitude (default: auto-calculated from data)
  --x-offset               X offset in centimeters (default: 0)
  --y-offset               Y offset in centimeters (default: 0)
  --port                   Port number (default: 3000)
  --time-from              Start time filter (e.g., 2025-06-22T09:00)
  --time-to                End time filter (e.g., 2025-06-22T13:30)

Time format examples:
  2025-06-22T09:00:00      Full timestamp
  2025-06-22T09:30         Without seconds
  2025-06-22T9             Just hour

Example:
  position-viewer.js capture.db --apikey YOUR_KEY
  position-viewer.js capture.db --apikey YOUR_KEY --lat 59.66 --lon 13.00
  position-viewer.js capture.db --apikey YOUR_KEY --x-offset 150 --y-offset -200
  position-viewer.js capture.db --apikey YOUR_KEY --time-from 2025-06-22T9 --time-to 2025-06-22T13
`);
}

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {
        help: false,
        databasePath: undefined,
        options: {},
    };
    if (args.length > 0 && !args[0].startsWith('--')) parsed.databasePath = args[0];
    for (let i = 1; i < args.length; i++)
        if (args[i] === '--help' || args[i] === '-h') parsed.help = true;
        else if (args[i].startsWith('--')) parsed.options[args[i]] = i + 1 < args.length && !args[i + 1].startsWith('--') ? args[++i] : true;
    return parsed;
}

const args = parseArgs();

if (args.help || !args.databasePath || !args.options['--apikey']) {
    displayHelp();
    process.exit(args.help ? 0 : 1);
}

if (!fs.existsSync(args.databasePath)) {
    console.error(`Database file not found: ${args.databasePath}`);
    process.exit(1);
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

console.log(`Loading position data from database: ${args.databasePath}`);
const allPositionData = loadFromDatabase(args.databasePath);

let centerLatitude, centerLongitude;
if (args.options['--lat'] && args.options['--lon']) {
    centerLatitude = Number.parseFloat(args.options['--lat']);
    centerLongitude = Number.parseFloat(args.options['--lon']);
    console.log(`Using provided center: ${centerLatitude}, ${centerLongitude}`);
} else {
    const { centerLat, centerLng } = calculateDataCenter(allPositionData);
    centerLatitude = centerLat;
    centerLongitude = centerLng;
    console.log(`Auto-calculated center: ${centerLatitude}, ${centerLongitude}`);
}

const xOffset = Number.parseFloat(args.options['--x-offset'] || '0'),
    yOffset = Number.parseFloat(args.options['--y-offset'] || '0');
const metersPerDegreeLat = 111320,
    metersPerDegreeLon = 111320 * Math.cos((centerLatitude * Math.PI) / 180);
centerLatitude = centerLatitude + yOffset / 100 / metersPerDegreeLat;
centerLongitude = centerLongitude + xOffset / 100 / metersPerDegreeLon;
if (xOffset || yOffset) console.log(`Applied offset: X=${xOffset}cm, Y=${yOffset}cm`);

let positionData = { ...allPositionData };
if (args.options['--time-from'] || args.options['--time-to']) {
    const parseTime = (timeStr) => {
        if (!timeStr) return undefined;
        if (timeStr.length < 19) {
            const parts = timeStr.split('T');
            if (parts.length === 2) {
                const timePart = parts[1];
                if (timePart.length === 1 || timePart.length === 2) timeStr = `${parts[0]}T${timePart.padStart(2, '0')}:00:00`;
                else if (timePart.length === 5) timeStr = `${timeStr}:00`;
            }
        }
        return new Date(timeStr);
    };

    const fromTime = parseTime(args.options['--time-from']),
        toTime = parseTime(args.options['--time-to']);
    console.log(`Filtering times: ${fromTime || 'start'} to ${toTime || 'end'}`);

    positionData.matches = allPositionData.matches.filter((match) => {
        const matchTime = new Date(match.timestamp);
        if (fromTime && matchTime < fromTime) return false;
        if (toTime && matchTime > toTime) return false;
        return true;
    });
}

console.log(`Loaded ${positionData.matches.length} position matches (of ${allPositionData.matches.length} total)`);

const port = Number.parseInt(args.options['--port'] || '3000');
const apiKey = args.options['--apikey'];

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line sonarjs/cognitive-complexity
function loadFromDatabase(dbPath) {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');
    const robotPositions = [];
    const robotStatuses = [];
    const positionQuery = `
        SELECT timestamp, data 
        FROM messages 
        WHERE topic LIKE '%D0:EF:76:64:32:BA/LOG/ROBOT_POSITION%'
        ORDER BY timestamp
    `;
    for (const row of db.prepare(positionQuery).all()) {
        try {
            const decoded = protobufDecode(row.data);
            if (decoded[1] && decoded[2]) {
                const xOffset = hexToDouble(decoded[1]),
                    yOffset = hexToDouble(decoded[2]);
                if (xOffset !== undefined && yOffset !== undefined) {
                    const position = {
                        timestamp: row.timestamp,
                        time: new Date(row.timestamp).getTime(),
                        xOffsetM: xOffset,
                        yOffsetM: yOffset,
                        offsetDistanceM: Math.hypot(xOffset, yOffset),
                        offsetDegrees: (Math.atan2(xOffset, yOffset) * 180) / Math.PI,
                        offsetCompass: (90 - (Math.atan2(xOffset, yOffset) * 180) / Math.PI + 360) % 360,
                    };
                    if (decoded[3]) {
                        const orientRad = hexToDouble(decoded[3]);
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
    }
    const statusQuery = `
        SELECT timestamp, data 
        FROM messages 
        WHERE topic LIKE '%D0:EF:76:64:32:BA/LOG/STATUS%'
        ORDER BY timestamp
    `;
    for (const row of db.prepare(statusQuery).all()) {
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
                if (decoded[19][3] && decoded[19][4]) {
                    const latOffset = hexToDouble(decoded[19][3]),
                        lonOffset = hexToDouble(decoded[19][4]);
                    if (latOffset !== undefined && lonOffset !== undefined) {
                        location.offsetLatitudeCm = latOffset;
                        location.offsetLongitudeCm = lonOffset;
                        location.offsetDistanceCm = Math.hypot(latOffset, lonOffset);
                        location.offsetDegrees = (Math.atan2(lonOffset, latOffset) * 180) / Math.PI;
                        location.offsetCompass = (90 - location.offsetDegrees + 360) % 360;
                    }
                }
                if (decoded[19][5] !== undefined) location.rtkQuality = decoded[19][5];
                if (Object.keys(location).length > 0) status.location = location;
            }
            if (decoded[20]?.[3]) {
                const network = {};
                const netData = decoded[20][3];
                if (netData[4]) network.network = netData[4];
                if (netData[5]) network.type = netData[5];
                if (netData[6]) network.band = netData[6];
                if (netData[7] !== undefined) network.rssi = netData[7] > 0x7fffffff ? netData[7] - 0x100000000 : netData[7];
                if (netData[10] !== undefined) network.rsrp = netData[10] > 0x7fffffff ? netData[10] - 0x100000000 : netData[10];
                if (netData[12] !== undefined) network.rsrq = netData[12] > 0x7fffffff ? netData[12] - 0x100000000 : netData[12];
                if (netData[11] !== undefined) network.sq = netData[11] > 0x7fffffff ? netData[11] - 0x100000000 : netData[11];
                if (Object.keys(network).length > 0) status.network = network;
            }
            status.statusType = decoded[3];
            if (decoded[17] && decoded[17][2] !== undefined) status.batteryCharge = decoded[17][2];
            status.docked = decoded[13];
            if (status.location || status.network) robotStatuses.push(status);
        } catch {
            // Skip messages that can't be decoded
        }
    }
    db.close();
    console.log(`  Robot positions: ${robotPositions.length}`);
    console.log(`  Robot statuses with location/network: ${robotStatuses.length}`);
    const matches = [];
    for (const robotPosition of robotPositions) {
        const match = {
            timestamp: robotPosition.timestamp,
            robotPosition,
        };
        const robotStatus = findClosestInWindow(robotPosition.time, robotStatuses, TIME_TOLERANCE_MS);
        if (robotStatus) match.robotStatus = { ...robotStatus, timeDiffMs: Math.abs(robotPosition.time - robotStatus.time) };
        matches.push(match);
    }
    return {
        metadata: {
            generated: new Date().toISOString(),
            totalMatches: matches.length,
            robotPositions: robotPositions.length,
            robotStatuses: robotStatuses.length,
            timeTolerance: TIME_TOLERANCE_MS,
            baseReferenceLocation: REFERENCE_POSITION,
        },
        matches,
    };
}

function findClosestInWindow(targetTime, dataArray, toleranceMs) {
    let closest;
    let closestDiff = Infinity;
    for (const item of dataArray) {
        const diff = Math.abs(targetTime - item.time);
        if (diff <= toleranceMs && diff < closestDiff) {
            closest = item;
            closestDiff = diff;
        }
    }
    return closest;
}

function hexToDouble(value) {
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

function calculateDataCenter(positionData) {
    const baseRefLat = REFERENCE_POSITION.latitude,
        baseRefLng = REFERENCE_POSITION.longitude;
    const positions = positionData.matches
        .filter((match) => match.robotPosition)
        .map((match) => ({
            lat: baseRefLat + (match.robotPosition.yOffsetM / 6371000) * (180 / Math.PI),
            lon: baseRefLng + ((match.robotPosition.xOffsetM / 6371000) * (180 / Math.PI)) / Math.cos((baseRefLat * Math.PI) / 180),
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
        return {
            centerLat: (minLat + maxLat) / 2,
            centerLng: (minLon + maxLon) / 2,
        };
    }
    return { centerLat: baseRefLat, centerLng: baseRefLng };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line sonarjs/x-powered-by
const app = express();

app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Robot Position Map</title>
    <style>
        #map { height: 100vh; width: 100%; }
        body { margin: 0; padding: 0; font-family: Arial, sans-serif; }
        #info {
            position: absolute;
            top: 10px;
            left: 10px;
            background: white;
            padding: 10px;
            border-radius: 5px;
            box-shadow: 0 2px 6px rgba(0,0,0,.3);
            z-index: 1000;
            max-width: 300px;
        }
        #controls {
            position: absolute;
            top: 10px;
            right: 10px;
            background: white;
            padding: 10px;
            border-radius: 5px;
            box-shadow: 0 2px 6px rgba(0,0,0,.3);
            z-index: 1000;
            width: 280px;
        }
        .control-group {
            margin-bottom: 10px;
        }
        label {
            display: inline-block;
            width: 120px;
            font-size: 14px;
        }
        select, input[type="range"], input[type="number"] {
            width: 150px;
        }
        input[type="checkbox"] {
            margin-left: 0;
        }
        .value-display {
            display: inline-block;
            width: 50px;
            text-align: right;
            font-size: 12px;
        }
        h3 {
            margin-top: 0;
            margin-bottom: 10px;
        }
        .mode-specific {
            border-top: 1px solid #ccc;
            margin-top: 10px;
            padding-top: 10px;
        }
        #legend {
            position: absolute;
            bottom: 30px;
            left: 10px;
            background: white;
            padding: 10px;
            border-radius: 5px;
            box-shadow: 0 2px 6px rgba(0,0,0,.3);
            z-index: 1000;
            display: none;
        }
        .legend-item {
            display: flex;
            align-items: center;
            margin-bottom: 5px;
        }
        .legend-color {
            width: 20px;
            height: 20px;
            margin-right: 10px;
            border: 1px solid #000;
        }
    </style>
</head>
<body>
    <div id="map"></div>
    <div id="info">
        <h3>Robot Position Viewer</h3>
        <div>Total positions: <span id="totalPositions">${positionData.matches.length}</span></div>
        <div>Center: ${centerLatitude.toFixed(6)}, ${centerLongitude.toFixed(6)}</div>
        ${xOffset || yOffset ? `<div>Offset: X=${xOffset}cm, Y=${yOffset}cm</div>` : ''}
        ${args.options['--time-from'] || args.options['--time-to'] ? `<div>Time filter: ${args.options['--time-from'] || 'start'} to ${args.options['--time-to'] || 'end'}</div>` : ''}
        <div>Selected: <span id="selectedInfo">None</span></div>
    </div>
    
    <div id="controls">
        <h3>Display Mode</h3>
        <div class="control-group">
            <select id="displayMode" style="width: 100%;">
                <option value="position">Show Positions</option>
                <option value="network">Network Heat Map</option>
                <option value="location">Location Heat Map</option>
            </select>
        </div>
        
        <div class="control-group">
            <label>Opacity:</label>
            <input type="range" id="opacity" min="0" max="100" value="70">
            <span class="value-display" id="opacityValue">70%</span>
        </div>
        
        <div class="control-group">
            <label>Heat radius:</label>
            <input type="range" id="heatRadius" min="10" max="100" value="20">
            <span class="value-display" id="heatRadiusValue">20px</span>
        </div>

        <div class="control-group">
            <label>Grid overlay:</label>
            <input type="checkbox" id="showGrid">
            <label for="gridSize" style="width: 60px;">Size (m):</label>
            <input type="number" id="gridSize" value="5" min="1" max="50" style="width: 50px;">
        </div>
        
        <div id="positionControls" class="mode-specific">
            <h4>Position Options</h4>
            <div class="control-group">
                <label>Show robot path:</label>
                <input type="checkbox" id="showPath" checked>
            </div>
            <div class="control-group">
                <label>Show orientation:</label>
                <input type="checkbox" id="showOrientation" checked>
            </div>
            <div class="control-group">
                <label>Filter by status:</label>
                <select id="statusFilter">
                    <option value="all">All</option>
                    <option value="has_network">Has Network</option>
                    <option value="has_location">Has Location</option>
                    <option value="both">Has Both</option>
                </select>
            </div>
        </div>
        
        <div id="networkControls" class="mode-specific" style="display: none;">
            <h4>Network Options</h4>
            <div class="control-group">
                <label>Signal type:</label>
                <select id="networkSignal">
                    <option value="rssi">RSSI</option>
                    <option value="rsrp">RSRP</option>
                    <option value="rsrq">RSRQ</option>
                </select>
            </div>
        </div>
        
        <div id="locationControls" class="mode-specific" style="display: none;">
            <h4>Location Options</h4>
            <div class="control-group">
                <label>Metric:</label>
                <select id="locationMetric">
                    <option value="satellites">Satellite Count</option>
                    <option value="rtkQuality">RTK Quality</option>
                    <option value="coverage">Coverage</option>
                </select>
            </div>
        </div>
    </div>
    
    <div id="legend">
        <h4 id="legendTitle">Legend</h4>
        <div id="legendContent"></div>
    </div>

    <script>
        let map;
        let markers = [];
        let polyline;
        let infoWindow;
        let heatmap;
        let gridLines = [];
        let filteredMatches = [];
        
        const positionData = ${JSON.stringify(positionData)};
        const centerLat = ${centerLatitude};
        const centerLng = ${centerLongitude};

        function initMap() {
            map = new google.maps.Map(document.getElementById('map'), {
                center: { lat: centerLat, lng: centerLng },
                zoom: 18,
                mapTypeId: 'satellite',
                mapId: 'robot_position_map' // Required for AdvancedMarkerElement
            });

            infoWindow = new google.maps.InfoWindow();

            loadHeatmapLibrary();

            const centerPin = new google.maps.marker.PinElement({
                scale: 1.2,
                background: '#FF0000',
                borderColor: '#FFFFFF',
                glyphColor: '#FFFFFF'
            });
            
            new google.maps.marker.AdvancedMarkerElement({
                map,
                position: { lat: centerLat, lng: centerLng },
                title: 'Reference Center',
                content: centerPin.element
            });

            updateDisplay();
            setupControls();

            map.addListener('click', (e) => {
                let closestMarker;
                let closestDistance = Infinity;
                let closestIndex = -1;
                
                markers.forEach((marker, index) => {
                    if (!marker.position) return;
                    
                    const markerPos = marker.position;
                    const distance = google.maps.geometry.spherical.computeDistanceBetween(
                        e.latLng,
                        new google.maps.LatLng(markerPos.lat, markerPos.lng)
                    );
                    
                    if (distance < closestDistance && distance < 10) { // 10 meter threshold
                        closestDistance = distance;
                        closestMarker = marker;
                        closestIndex = index;
                    }
                });
                
                if (closestMarker && closestIndex >= 0) {
                    const match = filteredMatches[closestIndex];
                    const content = createInfoContent(match, closestIndex);
                    infoWindow.setContent(content);
                    infoWindow.open(map, closestMarker);
                    document.getElementById('selectedInfo').textContent = 'Position ' + closestIndex + ' at ' + match.timestamp;
                }
            });            
        }

        async function loadHeatmapLibrary() {
            const { HeatmapLayer } = await google.maps.importLibrary("visualization");
            window.HeatmapLayer = HeatmapLayer;
        }

        function calculatePosition(xOffsetM, yOffsetM) {
            const metersPerDegreeLat = 111320;
            const metersPerDegreeLon = 111320 * Math.cos(centerLat * Math.PI / 180);            
            const lat = centerLat + (yOffsetM / metersPerDegreeLat);
            const lng = centerLng + (xOffsetM / metersPerDegreeLon);            
            return { lat, lng };
        }

        function updateDisplay() {
            const mode = document.getElementById('displayMode').value;
            document.getElementById('info').innerHTML += '<div id="loading" style="color: red;">Loading...</div>';
            requestAnimationFrame(() => {
                clearMarkers();
                clearPath();
                clearHeatmap();
                clearGrid();
                if (document.getElementById('showGrid').checked)
                    drawGrid();
                switch (mode) {
                    case 'position':
                        displayPositions();
                        break;
                    case 'network':
                        displayNetworkHeatmap();
                        break;
                    case 'location':
                        displayLocationHeatmap();
                        break;
                }
                const loadingEl = document.getElementById('loading');
                if (loadingEl) loadingEl.remove();
            });
        }
            
        function clearMarkers() {
            markers.forEach(marker => {
                if (marker?.map)
                    marker.setMap(undefined);
            });
            markers = [];
        }

        function clearPath() {
            if (polyline) {
                polyline.setMap(null);
                polyline = null;
            }
        }

        function clearHeatmap() {
            if (heatmap) {
                heatmap.setMap(null);
                heatmap = null;
            }
            document.getElementById('legend').style.display = 'none';
        }

        function clearGrid() {
            gridLines.forEach(line => line.setMap(null));
            gridLines = [];
        }

        function drawGrid() {
            const gridSize = Number.parseInt(document.getElementById('gridSize').value);
            const bounds = map.getBounds();
            if (!bounds) return;

            const ne = bounds.getNorthEast();
            const sw = bounds.getSouthWest();
            
            const metersPerDegreeLat = 111320;
            const metersPerDegreeLon = 111320 * Math.cos(centerLat * Math.PI / 180);
            const gridDegreesLat = gridSize / metersPerDegreeLat;
            const gridDegreesLon = gridSize / metersPerDegreeLon;
            
            const startLat = Math.floor((sw.lat() - centerLat) / gridDegreesLat) * gridDegreesLat + centerLat;
            const startLng = Math.floor((sw.lng() - centerLng) / gridDegreesLon) * gridDegreesLon + centerLng;
            
            for (let lng = startLng; lng <= ne.lng(); lng += gridDegreesLon) {
                const line = new google.maps.Polyline({
                    path: [ { lat: sw.lat(), lng }, { lat: ne.lat(), lng } ],
                    strokeColor: '#FFFFFF',
                    strokeOpacity: 0.3,
                    strokeWeight: 1,
                    map
                });
                gridLines.push(line);
            }
            for (let lat = startLat; lat <= ne.lat(); lat += gridDegreesLat) {
                const line = new google.maps.Polyline({
                    path: [ { lat, lng: sw.lng() }, { lat, lng: ne.lng() } ],
                    strokeColor: '#FFFFFF',
                    strokeOpacity: 0.3,
                    strokeWeight: 1,
                    map
                });
                gridLines.push(line);
            }
        }

        function displayPositions() {
            const showPath = document.getElementById('showPath').checked;
            const showOrientation = document.getElementById('showOrientation').checked;
            const opacity = document.getElementById('opacity').value / 100;
            const statusFilter = document.getElementById('statusFilter').value;

            const pathCoordinates = [];
            filteredMatches = positionData.matches.filter(match => {
                if (statusFilter === 'all') return true;
                if (statusFilter === 'has_network') return match.robotStatus?.network;
                if (statusFilter === 'has_location') return match.robotStatus?.location;
                if (statusFilter === 'both') return match.robotStatus?.network && match.robotStatus?.location;
                return true;
            });

            filteredMatches.forEach((match, index) => {
                const pos = match.robotPosition;
                if (!pos || pos.xOffsetM === undefined || pos.yOffsetM === undefined) return;

                const position = calculatePosition(pos.xOffsetM, pos.yOffsetM);
                pathCoordinates.push(position);

                let color = '#00FF00'; // Green - default
                if (match.robotStatus) {
                    if (match.robotStatus.network && match.robotStatus.location) 
                        color = '#00FF00'; // Green - both
                    else if (match.robotStatus.network) 
                        color = '#FFFF00'; // Yellow - network only
                    else if (match.robotStatus.location) 
                        color = '#00FFFF'; // Cyan - location only
                } else
                    color = '#FF00FF'; // Magenta - no status

                const pinElement = document.createElement('div');
                pinElement.style.width = '12px';
                pinElement.style.height = '12px';
                pinElement.style.borderRadius = showOrientation && pos.orientationCompass !== undefined ? '0' : '50%';
                pinElement.style.backgroundColor = color;
                pinElement.style.opacity = opacity;
                pinElement.style.border = '1px solid #000';
                
                if (showOrientation && pos.orientationCompass !== undefined) {
                    pinElement.style.width = '0';
                    pinElement.style.height = '0';
                    pinElement.style.borderLeft = '6px solid transparent';
                    pinElement.style.borderRight = '6px solid transparent';
                    pinElement.style.borderBottom = '12px solid ' + color;
                    pinElement.style.backgroundColor = 'transparent';
                    pinElement.style.transform = 'rotate(' + (pos.orientationCompass - 180) + 'deg)';
                }

                const marker = new google.maps.marker.AdvancedMarkerElement({
                    map,
                    position,
                    content: pinElement,
                    title: 'Position ' + index
                });

                markers.push(marker);
            });

            if (showPath && pathCoordinates.length > 1) 
                polyline = new google.maps.Polyline({
                    path: pathCoordinates,
                    geodesic: true,
                    strokeColor: '#FFFFFF',
                    strokeOpacity: 0.5,
                    strokeWeight: 2,
                    map
                });

            document.getElementById('totalPositions').textContent = filteredMatches.length + ' (of ' + positionData.matches.length + ')';
        }

        function displayNetworkHeatmap() {
            if (!window.HeatmapLayer) {
                setTimeout(displayNetworkHeatmap, 100);
                return;
            }

            const signalType = document.getElementById('networkSignal').value;
            const opacity = document.getElementById('opacity').value / 100;
            
            const heatmapData = [];
            let minValue = Infinity;
            let maxValue = -Infinity;

            positionData.matches.forEach(match => {
                if (!match.robotPosition || !match.robotStatus?.network) return;
                
                const signal = match.robotStatus.network[signalType];
                if (signal === undefined || signal === null) return;                

                const position = calculatePosition(match.robotPosition.xOffsetM, match.robotPosition.yOffsetM);
                
                let weight;
                switch (signalType) {
                    case 'rssi':
                        weight = (signal + 110) / 60; // -110 to -50 dBm range
                        break;
                    case 'rsrp':
                        weight = (signal + 110) / 60; // -110 to -50 dBm range
                        break;
                    case 'rsrq':
                        weight = (signal + 20) / 15; // -20 to -5 dB range
                        break;
                }
                
                weight = Math.max(0, Math.min(1, weight));
                minValue = Math.min(minValue, signal);
                maxValue = Math.max(maxValue, signal);
                
                heatmapData.push({ location: new google.maps.LatLng(position.lat, position.lng), weight });
            });

            if (heatmapData.length > 0) {
                heatmap = new google.maps.visualization.HeatmapLayer({
                    data: heatmapData,
                    map,
                    radius: parseInt(document.getElementById('heatRadius').value),
                    opacity
                });
                showNetworkLegend(signalType, minValue, maxValue);
            }
        }

        function displayLocationHeatmap() {
            if (!window.HeatmapLayer) {
                setTimeout(displayLocationHeatmap, 100);
                return;
            }

            const metric = document.getElementById('locationMetric').value;
            const opacity = document.getElementById('opacity').value / 100;
            
            const heatmapData = [];
            let minValue = Infinity;
            let maxValue = -Infinity;

            positionData.matches.forEach(match => {
                if (!match.robotPosition || !match.robotStatus?.location) return;
                
                const value = match.robotStatus.location[metric];
                if (value === undefined || value === null) return;
                
                const position = calculatePosition(match.robotPosition.xOffsetM, match.robotPosition.yOffsetM);
                
                let weight;
                switch (metric) {
                    case 'satellites':
                        weight = value / 30; // 0-30 satellites
                        break;
                    case 'rtkQuality':
                        weight = value; // Already 0-1
                        break;
                    case 'coverage':
                        weight = 1 - (value / 3); // 0=good, 3=worst
                        break;
                }
                
                weight = Math.max(0, Math.min(1, weight));
                minValue = Math.min(minValue, value);
                maxValue = Math.max(maxValue, value);
                
                heatmapData.push({ location: new google.maps.LatLng(position.lat, position.lng), weight });
            });

            if (heatmapData.length > 0) {
                heatmap = new google.maps.visualization.HeatmapLayer({
                    data: heatmapData,
                    map,
                    radius: parseInt(document.getElementById('heatRadius').value),
                    opacity
                });

                showLocationLegend(metric, minValue, maxValue);
            }
        }

        function showNetworkLegend(signalType, minValue, maxValue) {
            const legend = document.getElementById('legend');
            const title = document.getElementById('legendTitle');
            const content = document.getElementById('legendContent');
            
            title.textContent = signalType.toUpperCase() + ' Signal Strength';
            
            const unit = signalType === 'rsrq' ? 'dB' : 'dBm';
            content.innerHTML = '';
            
            const gradient = document.createElement('div');
            gradient.style.width = '200px';
            gradient.style.height = '20px';
            gradient.style.background = 'linear-gradient(to right, blue, cyan, green, yellow, red)';
            gradient.style.marginBottom = '5px';
            content.appendChild(gradient);
            
            const labels = document.createElement('div');
            labels.style.display = 'flex';
            labels.style.justifyContent = 'space-between';
            labels.innerHTML = '<span>Poor (' + minValue + unit + ')</span><span>Good (' + maxValue + unit + ')</span>';
            content.appendChild(labels);
            
            legend.style.display = 'block';
        }

        function showLocationLegend(metric, minValue, maxValue) {
            const legend = document.getElementById('legend');
            const title = document.getElementById('legendTitle');
            const content = document.getElementById('legendContent');
            
            const titles = {
                'satellites': 'Satellite Count',
                'rtkQuality': 'RTK Quality',
                'coverage': 'Coverage Quality'
            };
            
            title.textContent = titles[metric];
            content.innerHTML = '';
            
            const gradient = document.createElement('div');
            gradient.style.width = '200px';
            gradient.style.height = '20px';
            gradient.style.background = 'linear-gradient(to right, blue, cyan, green, yellow, red)';
            gradient.style.marginBottom = '5px';
            content.appendChild(gradient);
            
            const labels = document.createElement('div');
            labels.style.display = 'flex';
            labels.style.justifyContent = 'space-between';
            
            if (metric === 'coverage') 
                labels.innerHTML = '<span>Good</span><span>Worse</span>';
            else if (metric === 'rtkQuality')
                labels.innerHTML = '<span>0%</span><span>100%</span>';
            else
                labels.innerHTML = '<span>' + Math.floor(minValue) + '</span><span>' + Math.floor(maxValue) + '</span>';
            
            content.appendChild(labels);
            legend.style.display = 'block';
        }

        function createInfoContent(match, index) {
            let html = '<div style="font-family: monospace; font-size: 12px; max-width: 400px;">';
            html += '<b>Position ' + index + '</b><br>';
            html += 'Time: ' + match.timestamp + '<br>';
            html += '<br><b>Robot Position:</b><br>';
            html += 'X Offset: ' + match.robotPosition.xOffsetM.toFixed(2) + 'm<br>';
            html += 'Y Offset: ' + match.robotPosition.yOffsetM.toFixed(2) + 'm<br>';
            html += 'Distance: ' + match.robotPosition.offsetDistanceM.toFixed(2) + 'm<br>';
            html += 'Bearing: ' + match.robotPosition.offsetCompass.toFixed(1) + '°<br>';
            if (match.robotPosition.orientationCompass !== undefined)
                html += 'Orientation: ' + match.robotPosition.orientationCompass.toFixed(1) + '°<br>';

            if (match.robotStatus) {
                html += '<br><b>Robot Status:</b><br>';
                html += 'Time diff: ' + match.robotStatus.timeDiffMs + 'ms<br>';
                
                if (match.robotStatus.location) {
                    html += '<br><b>Location:</b><br>';
                    html += 'Satellites: ' + match.robotStatus.location.satellites + '<br>';
                    html += 'Coverage: ' + match.robotStatus.location.coverage + '<br>';
                    if (match.robotStatus.location.rtkQuality !== undefined)
                        html += 'RTK Quality: ' + match.robotStatus.location.rtkQuality + '<br>';
                    if (match.robotStatus.location.offsetDistanceCm !== undefined)
                        html += 'GPS Offset: ' + match.robotStatus.location.offsetDistanceCm.toFixed(1) + 'cm at ' + match.robotStatus.location.offsetCompass.toFixed(1) + '°<br>';
                }

                if (match.robotStatus.network) {
                    html += '<br><b>Network:</b><br>';
                    html += 'Network: ' + match.robotStatus.network.network + '<br>';
                    html += 'Type: ' + match.robotStatus.network.type + '<br>';
                    html += 'Band: ' + match.robotStatus.network.band + '<br>';
                    html += 'RSSI: ' + match.robotStatus.network.rssi + ' dBm<br>';
                    html += 'RSRP: ' + match.robotStatus.network.rsrp + ' dBm<br>';
                    html += 'RSRQ: ' + match.robotStatus.network.rsrq + ' dB<br>';
                }
                
                if (match.robotStatus.batteryCharge !== undefined)
                    html += '<br><b>Battery:</b> ' + match.robotStatus.batteryCharge + '%<br>';
            }

            html += '</div>';
            return html;
        }

        function setupControls() {

        document.getElementById('displayMode').addEventListener('change', (e) => {
                document.getElementById('positionControls').style.display = e.target.value === 'position' ? 'block' : 'none';
                document.getElementById('networkControls').style.display = e.target.value === 'network' ? 'block' : 'none';
                document.getElementById('locationControls').style.display = e.target.value === 'location' ? 'block' : 'none';
                updateDisplay();
            });

            document.getElementById('opacity').addEventListener('input', (e) => {
                document.getElementById('opacityValue').textContent = e.target.value + '%';
                updateDisplay();
            });

            document.getElementById('heatRadius').addEventListener('input', (e) => {
                document.getElementById('heatRadiusValue').textContent = e.target.value + 'px';
                updateDisplay();
            });            

            document.getElementById('showGrid').addEventListener('change', updateDisplay);
            document.getElementById('gridSize').addEventListener('change', updateDisplay);

            document.getElementById('showPath').addEventListener('change', updateDisplay);
            document.getElementById('showOrientation').addEventListener('change', updateDisplay);
            document.getElementById('statusFilter').addEventListener('change', updateDisplay);
            
            document.getElementById('networkSignal').addEventListener('change', updateDisplay);
            
            document.getElementById('locationMetric').addEventListener('change', updateDisplay);
            
            map.addListener('bounds_changed', () => {
                if (document.getElementById('showGrid').checked) {
                    clearGrid();
                    drawGrid();
                }
            });
        }
    </script>
    <script async
        src="https://maps.googleapis.com/maps/api/js?key=${apiKey}&loading=async&callback=initMap&libraries=visualization,marker,geometry">
    </script>
</body>
</html>
    `;
    res.send(html);
});

app.get('/api/positions', (req, res) => res.json(positionData));

app.listen(port, () => {
    console.log(`
Robot Position Map Viewer running at:
  http://localhost:${port}

Center coordinates: ${centerLatitude}, ${centerLongitude}
Total positions: ${positionData.matches.length}
${xOffset || yOffset ? `Offset applied: X=${xOffset}cm, Y=${yOffset}cm` : ''}
${args.options['--time-from'] || args.options['--time-to'] ? `Time filter: ${args.options['--time-from'] || 'start'} to ${args.options['--time-to'] || 'end'}` : ''}

Open the URL in your browser to view the map.
Press Ctrl+C to stop the server.
    `);
});
