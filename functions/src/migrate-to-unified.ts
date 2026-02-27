/**
 * Migration Script: Move existing data to new unified wells/ structure
 *
 * This script:
 * 1. Reads all wells from well_config
 * 2. For each well, finds all packets from packets/processed
 * 3. Creates wells/{wellName}/status with current state
 * 4. Creates wells/{wellName}/history/{timestamp} for each pull
 *
 * Run with: cd functions && npx ts-node src/migrate-to-unified.ts
 */

import * as admin from 'firebase-admin';

// Initialize Firebase Admin
const serviceAccount = require('../../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://wellbuilt-sync-default-rtdb.firebaseio.com'
});

const db = admin.database();

// Helper: Convert inches to feet'inches" format
function inchesToFeetInches(inches: number): string {
  const feet = Math.floor(inches / 12);
  const remainingInches = Math.floor(inches % 12);
  return `${feet}'${remainingInches}"`;
}

// Helper: Format days to H:MM:SS
function daysToHMMSS(days: number): string {
  if (days <= 0 || !isFinite(days)) return '--';
  const totalSeconds = Math.floor(days * 24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Helper: Format days to H:MM
function daysToHMM(days: number): string {
  if (days <= 0 || !isFinite(days)) return '--';
  const totalMinutes = Math.floor(days * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}`;
}

// Calculate AFR from flow rates
function calculateAFR(flowRates: number[]): number {
  if (flowRates.length === 0) return 0;
  if (flowRates.length < 3) return flowRates[flowRates.length - 1];

  // Use 5-pull rolling average
  const windowSize = Math.min(5, flowRates.length);
  const recentRates = flowRates.slice(-windowSize);
  return recentRates.reduce((a, b) => a + b, 0) / recentRates.length;
}

async function migrate() {
  console.log('Starting migration to unified wells/ structure...\n');

  // Get all well configs
  const configSnap = await db.ref('well_config').once('value');
  if (!configSnap.exists()) {
    console.log('No well_config found - nothing to migrate');
    return;
  }

  const configs = configSnap.val();
  const wellNames = Object.keys(configs);
  console.log(`Found ${wellNames.length} wells in config\n`);

  // Get all processed packets
  const processedSnap = await db.ref('packets/processed').once('value');
  const allPackets = processedSnap.exists() ? processedSnap.val() : {};
  console.log(`Found ${Object.keys(allPackets).length} total processed packets\n`);

  let migratedWells = 0;
  let migratedPulls = 0;

  for (const wellName of wellNames) {
    const config = configs[wellName];
    console.log(`\nProcessing: ${wellName}`);

    // Find all packets for this well
    const wellPackets: any[] = [];
    const cleanWellName = wellName.toLowerCase().replace(/\s/g, '');

    for (const [packetId, packet] of Object.entries(allPackets) as [string, any][]) {
      if (packet.wellName && packet.wellName.toLowerCase().replace(/\s/g, '') === cleanWellName) {
        wellPackets.push({ packetId, ...packet });
      }
    }

    // Sort by timestamp (newest first)
    wellPackets.sort((a, b) => {
      const timeA = new Date(a.dateTimeUTC || a.dateTime).getTime() || 0;
      const timeB = new Date(b.dateTimeUTC || b.dateTime).getTime() || 0;
      return timeB - timeA;
    });

    console.log(`  Found ${wellPackets.length} packets`);

    // Collect flow rates for AFR calculation
    const flowRates: number[] = [];
    for (const packet of wellPackets) {
      if (packet.flowRateDays && packet.flowRateDays > 0 && packet.flowRateDays < 365) {
        flowRates.push(packet.flowRateDays);
      }
    }
    flowRates.reverse(); // Oldest first for AFR calc

    const afr = calculateAFR(flowRates);
    const afrMinutes = afr * 24 * 60;

    // Get most recent packet for current status
    const mostRecent = wellPackets[0];

    // Build well status
    const tanks = config.tanks || config.numTanks || 1;
    const bottomLevel = config.bottomLevel || config.allowedBottom || 3;
    const pullBbls = config.pullBbls || 140;
    const route = config.route || 'Unassigned';

    if (mostRecent) {
      const tankTopInches = mostRecent.tankTopInches || (mostRecent.tankLevelFeet || 0) * 12;
      const bblsInInches = mostRecent.bblsTaken > 0 ? (mostRecent.bblsTaken / 20 / tanks) * 12 : 0;
      const tankAfterInches = tankTopInches - bblsInInches;

      // Calculate current level estimate based on time since last pull
      const lastPullTime = new Date(mostRecent.dateTimeUTC || mostRecent.dateTime).getTime();
      const nowTime = Date.now();
      const elapsedDays = (nowTime - lastPullTime) / (1000 * 60 * 60 * 24);
      const inchesRisen = afr > 0 ? (elapsedDays / afr) * 12 : 0;
      const currentLevelInches = tankAfterInches + inchesRisen;

      // Calculate time till pull
      const pullHeightInches = (pullBbls / 20 / tanks) * 12;
      const targetLevel = bottomLevel * 12 + pullHeightInches;
      const recoveryNeeded = Math.max(0, targetLevel - tankAfterInches);
      const estDays = afr > 0 && recoveryNeeded > 0 ? (recoveryNeeded / 12) * afr : 0;
      const estDateTime = estDays > 0 ? new Date(lastPullTime + estDays * 24 * 60 * 60 * 1000) : null;

      // BBLs per 24 hours
      const bbls24hrs = afr > 0 ? Math.round((1 / afr) * 20 * tanks) : 0;

      const wellStatus = {
        wellName,
        config: {
          tanks,
          bottomLevel,
          route,
          pullBbls,
        },
        current: {
          level: inchesToFeetInches(currentLevelInches),
          levelInches: Math.round(currentLevelInches * 100) / 100,
          asOf: new Date().toISOString(),
        },
        lastPull: {
          dateTime: mostRecent.dateTime || new Date(mostRecent.dateTimeUTC).toLocaleString(),
          dateTimeUTC: mostRecent.dateTimeUTC,
          topLevel: inchesToFeetInches(tankTopInches),
          topLevelInches: tankTopInches,
          bottomLevel: inchesToFeetInches(tankAfterInches),
          bottomLevelInches: tankAfterInches,
          bblsTaken: mostRecent.bblsTaken,
          driverName: mostRecent.driverName,
          packetId: mostRecent.packetId,
        },
        calculated: {
          flowRate: afr > 0 ? daysToHMMSS(afr) : 'Unknown',
          flowRateMinutes: Math.round(afrMinutes * 100) / 100,
          bbls24hrs,
          nextPullTime: estDateTime ? estDateTime.toLocaleString() : 'Unknown',
          nextPullTimeUTC: estDateTime ? estDateTime.toISOString() : '',
          timeTillPull: mostRecent.wellDown ? 'Down' : (estDays > 0 ? daysToHMM(estDays) : 'Unknown'),
        },
        isDown: mostRecent.wellDown || false,
        updatedAt: new Date().toISOString(),
      };

      // Write status
      await db.ref(`wells/${wellName}/status`).set(wellStatus);
      console.log(`  Wrote status`);
    } else {
      // No packets - write minimal status from config
      const wellStatus = {
        wellName,
        config: {
          tanks,
          bottomLevel,
          route,
          pullBbls,
        },
        current: {
          level: '--',
          levelInches: 0,
          asOf: new Date().toISOString(),
        },
        lastPull: null,
        calculated: {
          flowRate: 'Unknown',
          flowRateMinutes: 0,
          bbls24hrs: 0,
          nextPullTime: 'Unknown',
          nextPullTimeUTC: '',
          timeTillPull: 'Unknown',
        },
        isDown: false,
        updatedAt: new Date().toISOString(),
      };

      await db.ref(`wells/${wellName}/status`).set(wellStatus);
      console.log(`  Wrote status (no history)`);
    }

    // Write history entries
    for (const packet of wellPackets) {
      const tankTopInches = packet.tankTopInches || (packet.tankLevelFeet || 0) * 12;
      const bblsInInches = packet.bblsTaken > 0 ? (packet.bblsTaken / 20 / tanks) * 12 : 0;
      const tankAfterInches = tankTopInches - bblsInInches;

      const historyTs = (packet.dateTimeUTC || packet.dateTime || '').replace(/[-:T]/g, '').split('.')[0];
      if (!historyTs) continue;

      const historyEntry = {
        packetId: packet.packetId,
        dateTime: packet.dateTime || new Date(packet.dateTimeUTC).toLocaleString(),
        dateTimeUTC: packet.dateTimeUTC,
        topLevel: inchesToFeetInches(tankTopInches),
        topLevelInches: tankTopInches,
        bottomLevel: inchesToFeetInches(tankAfterInches),
        bottomLevelInches: tankAfterInches,
        bblsTaken: packet.bblsTaken,
        driverName: packet.driverName,
        timeDif: packet.timeDif || '',
        timeDifDays: packet.timeDifDays || 0,
        recoveryInches: packet.recoveryInches || 0,
        flowRate: packet.flowRate || '',
        flowRateDays: packet.flowRateDays || 0,
        processedAt: packet.processedAt || new Date().toISOString(),
      };

      await db.ref(`wells/${wellName}/history/${historyTs}`).set(historyEntry);
      migratedPulls++;
    }

    console.log(`  Wrote ${wellPackets.length} history entries`);
    migratedWells++;
  }

  console.log(`\n========================================`);
  console.log(`Migration complete!`);
  console.log(`  Wells migrated: ${migratedWells}`);
  console.log(`  History entries: ${migratedPulls}`);
  console.log(`========================================\n`);

  process.exit(0);
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
