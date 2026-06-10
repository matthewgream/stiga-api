// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

const { StigaAPIUtilities, StigaAPIElements } = require('../../../api/StigaAPI');
const { protobufDecode } = StigaAPIUtilities;
const { decodeRobotStatusType, decodeRobotBatteryStatus } = StigaAPIElements;

const AnalyserBase = require('./Analyser');

const mean = (values) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : undefined);

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

class BatteryConsumptionAnalyser extends AnalyserBase {
    static getMetadata() {
        return {
            command: 'battery-consumption',
            description: 'Analyze battery consumption during mowing',
            detailedDescription: 'Tracks battery usage during mowing sessions (>15 min) and estimates mowing time — including a real-world estimate over the actual usable band (the typical auto-leave ~96% down to auto-return ~13%), alongside the fixed-band estimates.',
            options: { '--detailed': 'Show additional statistics (status distribution, consumption by battery level)' },
            examples: ['stiga-analyser.js battery-consumption', 'stiga-analyser.js battery-consumption --detailed'],
        };
    }

    constructor(databasePath) {
        super(databasePath);
        this.statusEvents = [];
        this.mowingSessions = [];
    }

    async analyze(options = {}) {
        const showDetailed = options['--detailed'] || false;
        console.log('Loading status events from database...');
        this.loadStatusEvents(options.robotMac);
        console.log(`Found ${this.statusEvents.length} status messages with battery info`);
        const dockedCount = this.statusEvents.filter((e) => e.isDocked).length,
            undockedCount = this.statusEvents.filter((e) => !e.isDocked).length;
        console.log(`  Docked: ${dockedCount}, Undocked: ${undockedCount}`);
        console.log('\nIdentifying mowing sessions...');
        this.identifyMowingSessions();
        console.log(`Found ${this.mowingSessions.length} valid mowing sessions (>15 minutes)\n`);
        this.displayResults();
        if (showDetailed) this.getDetailedStats();
    }

    loadStatusEvents(robotMac) {
        const query = `
            SELECT timestamp, data 
            FROM messages 
            WHERE topic LIKE '%${robotMac}/LOG/STATUS%'
            ORDER BY timestamp
        `;
        for (const row of this.db.prepare(query).all()) {
            try {
                const decoded = protobufDecode(row.data);
                if (decoded[17]) {
                    const battery = decodeRobotBatteryStatus(decoded[17]);
                    const isDocked = Boolean(decoded[13] === 1);
                    const statusType = decodeRobotStatusType(decoded[3]);
                    if (battery && battery.charge !== undefined) {
                        this.statusEvents.push({
                            timestamp: row.timestamp,
                            time: new Date(row.timestamp).getTime(),
                            batteryCharge: battery.charge,
                            batteryCapacity: battery.capacity,
                            isDocked,
                            statusType,
                            statusCode: decoded[3],
                        });
                    }
                }
            } catch {
                // Skip messages that can't be decoded
            }
        }
    }

    identifyMowingSessions() {
        if (this.statusEvents.length < 2) return;
        let undockedStart;
        let lastBatteryBeforeDocking;
        for (let i = 0; i < this.statusEvents.length; i++) {
            const event = this.statusEvents[i],
                prevEvent = i > 0 ? this.statusEvents[i - 1] : undefined;
            if (prevEvent && prevEvent.isDocked && !event.isDocked && !undockedStart) undockedStart = event;
            if (undockedStart && !event.isDocked) lastBatteryBeforeDocking = event;
            if (undockedStart && prevEvent && !prevEvent.isDocked && event.isDocked) {
                const endEvent = lastBatteryBeforeDocking || prevEvent,
                    duration = endEvent.time - undockedStart.time;
                if (duration >= 15 * 60 * 1000) {
                    const batteryUsed = undockedStart.batteryCharge - endEvent.batteryCharge;
                    if (batteryUsed > 0)
                        this.mowingSessions.push({
                            startTime: undockedStart.timestamp,
                            endTime: endEvent.timestamp,
                            startCharge: undockedStart.batteryCharge,
                            endCharge: endEvent.batteryCharge,
                            duration,
                            capacity: undockedStart.batteryCapacity,
                            batteryUsed,
                            startStatus: undockedStart.statusType,
                            endStatus: endEvent.statusType,
                        });
                }
                undockedStart = undefined;
                lastBatteryBeforeDocking = undefined;
            }
        }
        if (undockedStart && lastBatteryBeforeDocking) {
            const duration = lastBatteryBeforeDocking.time - undockedStart.time;
            if (duration >= 15 * 60 * 1000) {
                const batteryUsed = undockedStart.batteryCharge - lastBatteryBeforeDocking.batteryCharge;
                if (batteryUsed > 0)
                    this.mowingSessions.push({
                        startTime: undockedStart.timestamp,
                        endTime: lastBatteryBeforeDocking.timestamp,
                        startCharge: undockedStart.batteryCharge,
                        endCharge: lastBatteryBeforeDocking.batteryCharge,
                        duration,
                        capacity: undockedStart.batteryCapacity,
                        batteryUsed,
                        startStatus: undockedStart.statusType,
                        endStatus: lastBatteryBeforeDocking.statusType,
                        incomplete: true,
                    });
            }
        }
    }

    // Where the robot actually leaves/returns, thresholded so MANUAL cycles are excluded (a genuine auto
    // full-charge leave is >90%, a genuine low-battery auto-return is <20%). Duplicated from the
    // battery-charge analyser — same dock-transition walk over the (time-ordered) status events.
    getDockingStats() {
        const returns = [],
            leaves = [];
        for (let i = 1; i < this.statusEvents.length; i++) {
            const prev = this.statusEvents[i - 1],
                cur = this.statusEvents[i];
            if (!prev.isDocked && cur.isDocked) returns.push(cur.batteryCharge); // arrived: charge at return
            else if (prev.isDocked && !cur.isDocked) leaves.push(prev.batteryCharge); // departing: charge it left at
        }
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
        console.log('Mowing Sessions (off dock for >15 minutes):');
        console.log('='.repeat(110));
        console.log('Start Time'.padEnd(25) + 'Duration'.padEnd(12) + 'Start %'.padEnd(8) + 'End %'.padEnd(8) + 'Used %'.padEnd(10) + 'Rate'.padEnd(18) + 'Status');
        console.log('-'.repeat(110));
        let totalRates = [];
        let weightedRates = [];
        for (const session of this.mowingSessions) {
            const durationMinutes = session.duration / (60 * 1000),
                consumptionRate = (session.batteryUsed / durationMinutes) * 15;
            totalRates.push(consumptionRate);
            weightedRates.push({ rate: consumptionRate, duration: durationMinutes });
            console.log(
                session.startTime.padEnd(25) +
                    `${durationMinutes.toFixed(1)} min`.padEnd(12) +
                    `${session.startCharge}%`.padEnd(8) +
                    `${session.endCharge}%`.padEnd(8) +
                    `${session.batteryUsed}%`.padEnd(10) +
                    `${consumptionRate.toFixed(2)}% / 15min`.padEnd(18) +
                    (session.incomplete ? '(incomplete)' : `${session.startStatus} → ${session.endStatus}`)
            );
        }
        console.log('='.repeat(110));
        if (totalRates.length > 0) {
            const avgRate = totalRates.reduce((a, b) => a + b, 0) / totalRates.length,
                totalDuration = weightedRates.reduce((sum, item) => sum + item.duration, 0),
                weightedAvgRate = weightedRates.reduce((sum, item) => sum + item.rate * item.duration, 0) / totalDuration,
                minRate = Math.min(...totalRates),
                maxRate = Math.max(...totalRates);
            console.log('\nSummary Statistics:');
            console.log(`  Total mowing sessions analyzed: ${this.mowingSessions.length}`);
            console.log(`  Total mowing time: ${(totalDuration / 60).toFixed(1)} hours`);
            console.log(`  Average consumption rate: ${avgRate.toFixed(2)}% per 15 minutes`);
            console.log(`  Weighted average rate: ${weightedAvgRate.toFixed(2)}% per 15 minutes (weighted by duration)`);
            console.log(`  Minimum consumption rate: ${minRate.toFixed(2)}% per 15 minutes`);
            console.log(`  Maximum consumption rate: ${maxRate.toFixed(2)}% per 15 minutes`);
            const usableCapacity = 80,
                totalRuntime = (usableCapacity / weightedAvgRate) * 15;
            console.log(`\nEstimated mowing time (using weighted average rate):`);
            console.log(`  With 80% usable capacity (100% → 20%): ${totalRuntime.toFixed(0)} minutes (${(totalRuntime / 60).toFixed(1)} hours)`);
            console.log(`  With 60% typical capacity (80% → 20%): ${((60 / weightedAvgRate) * 15).toFixed(0)} minutes (${(((60 / weightedAvgRate) * 15) / 60).toFixed(1)} hours)`);
            const dock = this.getDockingStats();
            if (dock.avgLeaveHigh !== undefined && dock.avgReturnLow !== undefined) {
                const realRuntime = ((dock.avgLeaveHigh - dock.avgReturnLow) / weightedAvgRate) * 15;
                console.log(`  Real-world band (${dock.avgLeaveHigh.toFixed(0)}% → ${dock.avgReturnLow.toFixed(0)}%, auto leave→return): ${realRuntime.toFixed(0)} minutes (${(realRuntime / 60).toFixed(1)} hours)`);
            }
            // the actual auto leave/return levels the real-world estimate is built on (manual cycles excluded)
            console.log('\nDocking behaviour (thresholds exclude manual cycles):');
            console.log(`  Leaves (dock→undock): ${dock.leaveTotal} observed, ${dock.leaveHighCount} at >90% (auto full-charge)`);
            if (dock.avgLeaveHigh !== undefined) console.log(`    Average charge at leave, when >90%: ${dock.avgLeaveHigh.toFixed(1)}%`);
            console.log(`  Returns (undock→dock): ${dock.returnTotal} observed, ${dock.returnLowCount} at <20% (auto low-battery)`);
            if (dock.avgReturnLow !== undefined) console.log(`    Average charge at return, when <20%: ${dock.avgReturnLow.toFixed(1)}%`);
            console.log('\nSession length distribution:');
            const shortSessions = this.mowingSessions.filter((s) => s.duration < 30 * 60 * 1000).length,
                mediumSessions = this.mowingSessions.filter((s) => s.duration >= 30 * 60 * 1000 && s.duration < 60 * 60 * 1000).length,
                longSessions = this.mowingSessions.filter((s) => s.duration >= 60 * 60 * 1000).length;
            console.log(`  < 30 minutes: ${shortSessions} sessions`);
            console.log(`  30-60 minutes: ${mediumSessions} sessions`);
            console.log(`  > 60 minutes: ${longSessions} sessions`);
        } else {
            console.log('\nNo valid mowing sessions found.');
        }
    }

    getDetailedStats() {
        console.log('\n\nDetailed Battery Usage Analysis:');
        console.log('='.repeat(50));
        console.log('\nStatus type distribution:');
        const statusCounts = new Map();
        for (const event of this.statusEvents) statusCounts.set(event.statusType, (statusCounts.get(event.statusType) || 0) + 1);
        for (const [status, count] of statusCounts) console.log(`  ${status}: ${count}`);
        if (this.mowingSessions.length === 0) return;
        const consumptionByStartLevel = new Map();
        for (const session of this.mowingSessions) {
            const bucket = Math.floor(session.startCharge / 10) * 10;
            if (!consumptionByStartLevel.has(bucket)) consumptionByStartLevel.set(bucket, []);
            consumptionByStartLevel.get(bucket).push((session.batteryUsed / (session.duration / (60 * 1000))) * 15);
        }
        console.log('\nConsumption rate by starting battery level:');
        for (let b = 0; b <= 90; b += 10) {
            const rates = consumptionByStartLevel.get(b) || [];
            if (rates.length > 0) console.log(`  ${b}-${b + 9}%: ${(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2)}% / 15min (${rates.length} sessions)`);
        }
    }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------

module.exports = BatteryConsumptionAnalyser;

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
