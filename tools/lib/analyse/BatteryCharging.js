// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIUtilities, StigaAPIElements } = require('../../../api/StigaAPI');
const { protobufDecode } = StigaAPIUtilities;
const { decodeRobotBatteryStatus } = StigaAPIElements;

const AnalyserBase = require('./Analyser');

const mean = (values) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class BatteryChargingAnalyser extends AnalyserBase {
    static getMetadata() {
        return {
            command: 'battery-charge',
            description: 'Analyze battery charging patterns',
            detailedDescription: 'Tracks charging sessions from <30% to >80%, charging rates, and estimated charging times — plus real-world docking behaviour: the average charge at auto-return (<20%) and auto-leave (>90%), and the resulting real-world return→leave charge time.',
            options: {
                '--detailed': 'Show additional statistics (charging events by hour, battery level distribution)',
                '--days': 'Limit analysis to the last N days (default: all data)',
            },
            examples: ['stiga-analyser.js battery-charge', 'stiga-analyser.js battery-charge --detailed'],
        };
    }

    constructor(databasePath) {
        super(databasePath);
        this.chargingEvents = [];
        this.chargingSessions = [];
        this.dockEvents = []; // every status with battery + docked flag (for return/leave transitions)
        this.dockReturns = []; // undock->dock transitions: charge at return
        this.dockLeaves = []; // dock->undock transitions: charge at leave
    }

    async analyze(options = {}) {
        const showDetailed = options['--detailed'] || false;
        this.days = options['--days'] === undefined ? undefined : Number.parseFloat(options['--days']);
        console.log('Loading charging events from database...' + (this.days ? ` (last ${this.days} days)` : ''));
        this.loadChargingEvents(options.robotMac);
        console.log(`Found ${this.chargingEvents.length} charging status messages`);
        console.log('\nIdentifying complete charging sessions...');
        this.identifyChargingSessions();
        console.log(`Found ${this.chargingSessions.length} complete charging sessions\n`);
        this.loadDockEvents(options.robotMac);
        this.identifyDockTransitions();
        this.displayResults();
        if (showDetailed) this.getDetailedStats();
    }

    // SQL fragment to cap the query to the last N days (this.days), or '' for all data.
    _daysClause() {
        if (this.days === undefined || !Number.isFinite(this.days)) return '';
        return `AND timestamp > '${new Date(Date.now() - this.days * 24 * 60 * 60 * 1000).toISOString()}'`;
    }

    loadChargingEvents(robotMac) {
        const query = `
            SELECT timestamp, data
            FROM messages
            WHERE topic LIKE '%${robotMac}/LOG/STATUS%' ${this._daysClause()}
            ORDER BY timestamp
        `;
        for (const row of this.db.prepare(query).all()) {
            try {
                const decoded = protobufDecode(row.data);
                if (decoded[17] && decoded[3] === 3) {
                    const battery = decodeRobotBatteryStatus(decoded[17]);
                    const isDocked = Boolean(decoded[13] === 1);
                    if (battery && isDocked) {
                        this.chargingEvents.push({
                            timestamp: row.timestamp,
                            time: new Date(row.timestamp).getTime(),
                            batteryCharge: battery.charge,
                            batteryCapacity: battery.capacity,
                            isDocked,
                            statusType: 'CHARGING',
                        });
                    }
                }
            } catch {
                // Skip messages that can't be decoded
            }
        }
    }

    identifyChargingSessions() {
        if (this.chargingEvents.length < 2) return;
        let sessionStart;
        let lastEvent;
        for (const event of this.chargingEvents) {
            if (!sessionStart && event.batteryCharge < 30) {
                sessionStart = event;
                lastEvent = event;
                continue;
            }
            if (sessionStart) {
                const timeDiff = event.time - lastEvent.time;
                if (timeDiff > 30 * 60 * 1000) {
                    sessionStart = event.batteryCharge < 30 ? event : undefined;
                    lastEvent = event;
                    continue;
                }
                if (event.batteryCharge < lastEvent.batteryCharge - 2) {
                    sessionStart = event.batteryCharge < 30 ? event : undefined;
                    lastEvent = event;
                    continue;
                }
                if (event.batteryCharge > 80 && sessionStart.batteryCharge < 30) {
                    this.chargingSessions.push({
                        startTime: sessionStart.timestamp,
                        endTime: event.timestamp,
                        startCharge: sessionStart.batteryCharge,
                        endCharge: event.batteryCharge,
                        duration: event.time - sessionStart.time,
                        capacity: event.batteryCapacity,
                    });
                    sessionStart = undefined;
                }
                lastEvent = event;
            }
        }
    }

    // Every LOG/STATUS carrying a battery reading, with its docked flag — regardless of charging status.
    // Needed to see the FULL on-dock charge (past the ~81% where the 'charging' status ends) and the
    // actual return/leave levels.
    loadDockEvents(robotMac) {
        const query = `
            SELECT timestamp, data
            FROM messages
            WHERE topic LIKE '%${robotMac}/LOG/STATUS%' ${this._daysClause()}
            ORDER BY timestamp
        `;
        for (const row of this.db.prepare(query).all()) {
            try {
                const decoded = protobufDecode(row.data);
                if (!decoded[17]) continue;
                const battery = decodeRobotBatteryStatus(decoded[17]);
                if (!battery || battery.charge === undefined) continue;
                this.dockEvents.push({
                    time: new Date(row.timestamp).getTime(),
                    timestamp: row.timestamp,
                    charge: battery.charge,
                    isDocked: Boolean(decoded[13] === 1),
                });
            } catch {
                // Skip messages that can't be decoded
            }
        }
    }

    // Walk the timeline; a undock->dock edge is a "return" (charge at arrival), dock->undock is a "leave"
    // (charge it had charged to before departing).
    identifyDockTransitions() {
        let prev;
        for (const event of this.dockEvents) {
            if (prev) {
                if (!prev.isDocked && event.isDocked) this.dockReturns.push({ charge: event.charge, timestamp: event.timestamp });
                else if (prev.isDocked && !event.isDocked) this.dockLeaves.push({ charge: prev.charge, timestamp: prev.timestamp });
            }
            prev = event;
        }
    }

    // Return/leave charge stats, thresholded so MANUAL cycles are excluded: a genuine low-battery auto-return
    // is <20%, a genuine "fully charged, off it goes" leave is >90%. Manually sending it home at 60% or
    // starting it at 40% won't pollute the averages.
    getDockingStats() {
        const returns = this.dockReturns.map((r) => r.charge),
            leaves = this.dockLeaves.map((l) => l.charge);
        const lowReturns = returns.filter((c) => c < 20),
            highLeaves = leaves.filter((c) => c > 90);
        return {
            returnTotal: returns.length,
            returnLowCount: lowReturns.length,
            avgReturnLow: mean(lowReturns),
            leaveTotal: leaves.length,
            leaveHighCount: highLeaves.length,
            avgLeaveHigh: mean(highLeaves),
        };
    }

    displayResults() {
        console.log('Complete Charging Sessions (< 30% to > 80%):');
        console.log('='.repeat(100));
        console.log('Start Time'.padEnd(25) + 'Duration'.padEnd(12) + 'From %'.padEnd(8) + 'To %'.padEnd(8) + 'Change'.padEnd(10) + 'Rate'.padEnd(15) + 'Capacity');
        console.log('-'.repeat(100));
        let totalRates = [];
        for (const session of this.chargingSessions) {
            const durationMinutes = session.duration / (60 * 1000),
                chargeChange = session.endCharge - session.startCharge,
                ratePerQuarter = (chargeChange / durationMinutes) * 15;
            totalRates.push(ratePerQuarter);
            console.log(
                session.startTime.padEnd(25) +
                    `${durationMinutes.toFixed(1)} min`.padEnd(12) +
                    `${session.startCharge}%`.padEnd(8) +
                    `${session.endCharge}%`.padEnd(8) +
                    `+${chargeChange}%`.padEnd(10) +
                    `${ratePerQuarter.toFixed(2)}% / 15min`.padEnd(15) +
                    `${session.capacity} mAh`
            );
        }
        console.log('='.repeat(100));
        if (totalRates.length > 0) {
            const avgRate = totalRates.reduce((a, b) => a + b, 0) / totalRates.length,
                minRate = Math.min(...totalRates),
                maxRate = Math.max(...totalRates);
            console.log('\nSummary Statistics:');
            console.log(`  Total charging sessions analyzed: ${this.chargingSessions.length}`);
            console.log(`  Average charging rate: ${avgRate.toFixed(2)}% per 15 minutes`);
            console.log(`  Minimum charging rate: ${minRate.toFixed(2)}% per 15 minutes`);
            console.log(`  Maximum charging rate: ${maxRate.toFixed(2)}% per 15 minutes`);
            const timeFor30To80 = (50 / avgRate) * 15,
                timeFor0To100 = (100 / avgRate) * 15;
            console.log(`\nEstimated charging times (based on average rate):`);
            console.log(`  30% to 80%: ${timeFor30To80.toFixed(0)} minutes`);
            console.log(`  0% to 100%: ${timeFor0To100.toFixed(0)} minutes`);
            const dock = this.getDockingStats();
            if (dock.avgReturnLow !== undefined && dock.avgLeaveHigh !== undefined) {
                const timeForObserved = ((dock.avgLeaveHigh - dock.avgReturnLow) / avgRate) * 15;
                console.log(`  ${dock.avgReturnLow.toFixed(0)}% to ${dock.avgLeaveHigh.toFixed(0)}% (real-world auto return→leave): ${timeForObserved.toFixed(0)} minutes`);
            }
            // Where the robot actually returns/leaves — thresholded to exclude manual return/leave cycles.
            console.log(`\nDocking behaviour (thresholds exclude manual cycles):`);
            console.log(`  Returns (undock→dock): ${dock.returnTotal} observed, ${dock.returnLowCount} at <20% (auto low-battery)`);
            if (dock.avgReturnLow !== undefined) console.log(`    Average charge at return, when <20%: ${dock.avgReturnLow.toFixed(1)}%`);
            console.log(`  Leaves (dock→undock): ${dock.leaveTotal} observed, ${dock.leaveHighCount} at >90% (auto full-charge)`);
            if (dock.avgLeaveHigh !== undefined) console.log(`    Average charge at leave, when >90%: ${dock.avgLeaveHigh.toFixed(1)}%`);
        } else {
            console.log('\nNo complete charging sessions found.');
        }
    }

    getDetailedStats() {
        const stats = {
            totalEvents: 0,
        };
        const hours = new Map();
        const chargeBuckets = new Map();
        for (const event of this.chargingEvents) {
            stats.totalEvents++;
            const hour = new Date(event.timestamp).getHours();
            hours.set(hour, (hours.get(hour) || 0) + 1);
            const bucket = Math.floor(event.batteryCharge / 10) * 10;
            chargeBuckets.set(bucket, (chargeBuckets.get(bucket) || 0) + 1);
        }
        console.log('\n\nDetailed Statistics:');
        console.log('='.repeat(50));
        console.log(`Total charging events: ${stats.totalEvents}`);
        console.log('\nCharging events by hour of day:');
        for (let h = 0; h < 24; h++) {
            const count = hours.get(h) || 0;
            if (count > 0) console.log(`  ${h.toString().padStart(2, '0')}:00 - ${'█'.repeat(Math.ceil(count / 5))} (${count})`);
        }
        console.log('\nBattery level distribution during charging:');
        for (let b = 0; b <= 90; b += 10) {
            const count = chargeBuckets.get(b) || 0;
            if (count > 0) console.log(`  ${b}-${b + 9}%: ${'█'.repeat(Math.ceil(count / 10))} (${count})`);
        }
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = BatteryChargingAnalyser;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
