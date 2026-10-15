#!/usr/bin/env node
/**
 * CLI tool: Check live BMTC bus locations and ETA
 * Usage:
 *   node track.js <route> [target_stop]
 * Example:
 *   node track.js KIA-7A
 *   node track.js KIA-7A "Kempegowda International Airport"
 *   node track.js 500-D "Silk Board"
 */

const { trackBus } = require('./bmtc');

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Usage: node track.js <route> [target_bus_stop]');
    console.log('Examples:');
    console.log('  node track.js KIA-7A');
    console.log('  node track.js KIA-7A "HSR Layout"');
    console.log('  node track.js 500-D "Silk Board"\n');
    process.exit(1);
  }

  const routeQuery = args[0];
  const targetStop = args[1] || null;

  console.log(`\n🔍 Searching live data for route [${routeQuery}]${targetStop ? ` towards stop [${targetStop}]` : ''}...\n`);

  try {
    const result = await trackBus(routeQuery, targetStop);

    if (!result.success) {
      console.log(`❌ ${result.message}`);
      return;
    }

    console.log(`🚌 Route: ${result.route} (ID: ${result.routeId})`);
    console.log(`📊 Active buses on road: ${result.totalActiveBuses}\n`);

    if (result.totalActiveBuses === 0) {
      console.log('⚠️ No active GPS buses currently reported on this route by BMTC.');
      console.log('   (Buses may not be running right now or drivers haven\'t turned on telematics)');
      return;
    }

    result.buses.forEach((bus, i) => {
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🚌 Bus #${i + 1}: ${bus.vehicleNumber} (${bus.serviceType})`);
      console.log(`📍 Direction: ${bus.direction}`);
      console.log(`📌 Currently near: ${bus.currentLocation.nearestStop} (~${bus.currentLocation.distanceFromNearestStopKm} km away)`);
      console.log(`⏱️ Last live ping: ${bus.lastUpdated}`);
      console.log(`🗺️ Coordinates: ${bus.coordinates.lat}, ${bus.coordinates.lon}`);
      console.log(`🔗 Map link: ${bus.googleMapsLink}`);

      if (bus.targetStopAnalysis) {
        const t = bus.targetStopAnalysis;
        console.log(`\n🎯 ETA for [${t.targetStop}]:`);
        if (t.hasPassed) {
          console.log(`   ⚠️ This bus has already passed ${t.targetStop}.`);
        } else {
          console.log(`   📏 Distance to stop: ~${t.distanceKm} km (${t.stopsAway} stops away)`);
          console.log(`   ⏳ Estimated Time of Arrival: ~${t.estimatedMinutes} minutes`);
        }
      }
      console.log(``);
    });
  } catch (err) {
    console.error('❌ Error fetching BMTC live data:', err.message);
  }
}

main();
