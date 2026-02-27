/**
 * Fix Script: Recalculate status.calculated for wells with "Unknown" values
 *
 * This script:
 * 1. Reads all wells from wells/
 * 2. For wells with "Unknown" flow rate, recalculates from history
 * 3. Updates wells/{wellName}/status.calculated
 *
 * Run with: cd functions && npx ts-node src/fix-status-calculated.ts
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
  if (days <= 0 || !isFinite(days)) return 'Unknown';
  const totalSeconds = Math.floor(days * 24 * 60 * 60);
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Helper: Format days to H:MM
function daysToHMM(days: number): string {
  if (days <= 0 || !isFinite(days)) return 'Unknown';
  const totalMinutes = Math.floor(days * 24 * 60);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}:${mins.toString().padStart(2, '0')}`;
}

// Calculate AFR from flow rates using 5-pull rolling average
function calculateAFR(flowRates: number[]): number {
  if (flowRates.length === 0) return 0;
  if (flowRates.length < 3) return flowRates[flowRates.length - 1];

  // Use 5-pull rolling average
  const windowSize = Math.min(5, flowRates.length);
  const recentRates = flowRates.slice(-windowSize);
  return recentRates.reduce((a, b) => a + b, 0) / recentRates.length;
}

async function fixStatusCalculated() {
  console.log('Fixing wells with Unknown calculated values...\n');

  // Get all wells
  const wellsSnap = await db.ref('wells').once('value');
  if (!wellsSnap.exists()) {
    console.log('No wells found');
    return;
  }

  const wells = wellsSnap.val();
  let fixedCount = 0;
  let skippedCount = 0;

  for (const wellName of Object.keys(wells)) {
    const wellData = wells[wellName];
    const status = wellData.status;
    const history = wellData.history;

    if (!status || !history) {
      console.log(`${wellName}: No status or history, skipping`);
      skippedCount++;
      continue;
    }

    // Check if this well needs fixing
    if (status.calculated?.flowRate !== 'Unknown') {
      console.log(`${wellName}: Already has valid flow rate (${status.calculated?.flowRate}), skipping`);
      skippedCount++;
      continue;
    }

    console.log(`\nFixing: ${wellName}`);

    // Get history entries sorted by time (oldest first)
    const historyEntries = Object.values(history) as any[];
    historyEntries.sort((a: any, b: any) => {
      const timeA = new Date(a.dateTimeUTC || a.dateTime).getTime() || 0;
      const timeB = new Date(b.dateTimeUTC || b.dateTime).getTime() || 0;
      return timeA - timeB; // Oldest first
    });

    // Calculate flow rates from history
    const flowRates: number[] = [];

    for (let i = 1; i < historyEntries.length; i++) {
      const current = historyEntries[i];
      const previous = historyEntries[i - 1];

      const currentTime = new Date(current.dateTimeUTC).getTime();
      const previousTime = new Date(previous.dateTimeUTC).getTime();

      if (isNaN(currentTime) || isNaN(previousTime) || currentTime <= previousTime) {
        continue;
      }

      const timeDifDays = (currentTime - previousTime) / (1000 * 60 * 60 * 24);

      // Recovery = current top level - previous bottom level
      const currentTopInches = current.topLevelInches || 0;
      const previousBottomInches = previous.bottomLevelInches || 0;
      const recoveryInches = currentTopInches - previousBottomInches;

      if (recoveryInches >= 0.5 && timeDifDays > 0 && timeDifDays < 30) {
        // Flow rate = days per foot
        const flowRateDays = (timeDifDays / recoveryInches) * 12;
        if (flowRateDays > 0 && flowRateDays < 365) {
          flowRates.push(flowRateDays);
        }
      }
    }

    console.log(`  Found ${flowRates.length} valid flow rates from ${historyEntries.length} history entries`);

    if (flowRates.length === 0) {
      console.log(`  No valid flow rates, cannot fix`);
      skippedCount++;
      continue;
    }

    // Calculate AFR
    const afr = calculateAFR(flowRates);
    const afrMinutes = afr * 24 * 60;

    console.log(`  Calculated AFR: ${daysToHMMSS(afr)} (${afrMinutes.toFixed(2)} min/ft)`);

    // Get config values
    const tanks = status.config?.tanks || 1;
    const bottomLevel = status.config?.bottomLevel || 3;
    const pullBbls = status.config?.pullBbls || 140;

    // Get last pull info
    const lastPullBottomInches = status.lastPull?.bottomLevelInches || 0;
    const lastPullTime = new Date(status.lastPull?.dateTimeUTC || '').getTime();

    // Calculate time till pull
    const pullHeightInches = (pullBbls / 20 / tanks) * 12;
    const targetLevel = bottomLevel * 12 + pullHeightInches;
    const recoveryNeeded = Math.max(0, targetLevel - lastPullBottomInches);

    let estDays = 0;
    let estDateTime: Date | null = null;

    if (afr > 0 && recoveryNeeded > 0 && !isNaN(lastPullTime)) {
      estDays = (recoveryNeeded / 12) * afr;
      estDateTime = new Date(lastPullTime + estDays * 24 * 60 * 60 * 1000);
    }

    // BBLs per 24 hours
    const bbls24hrs = afr > 0 ? Math.round((1 / afr) * 20 * tanks) : 0;

    // Calculate current level estimate
    const nowTime = Date.now();
    const elapsedDays = !isNaN(lastPullTime) ? (nowTime - lastPullTime) / (1000 * 60 * 60 * 24) : 0;
    const inchesRisen = afr > 0 ? (elapsedDays / afr) * 12 : 0;
    const currentLevelInches = lastPullBottomInches + inchesRisen;

    // Build updated calculated object
    const calculated = {
      flowRate: daysToHMMSS(afr),
      flowRateMinutes: Math.round(afrMinutes * 100) / 100,
      bbls24hrs,
      nextPullTime: estDateTime ? estDateTime.toLocaleString() : 'Unknown',
      nextPullTimeUTC: estDateTime ? estDateTime.toISOString() : '',
      timeTillPull: status.isDown ? 'Down' : (estDays > 0 ? daysToHMM(estDays) : 'Unknown'),
    };

    const current = {
      level: inchesToFeetInches(currentLevelInches),
      levelInches: Math.round(currentLevelInches * 100) / 100,
      asOf: new Date().toISOString(),
    };

    console.log(`  New calculated: flowRate=${calculated.flowRate}, bbls24hrs=${calculated.bbls24hrs}, timeTillPull=${calculated.timeTillPull}`);

    // Update Firebase
    await db.ref(`wells/${wellName}/status/calculated`).set(calculated);
    await db.ref(`wells/${wellName}/status/current`).set(current);
    await db.ref(`wells/${wellName}/status/updatedAt`).set(new Date().toISOString());

    console.log(`  Updated wells/${wellName}/status`);
    fixedCount++;
  }

  console.log(`\n========================================`);
  console.log(`Fix complete!`);
  console.log(`  Fixed: ${fixedCount}`);
  console.log(`  Skipped: ${skippedCount}`);
  console.log(`========================================\n`);

  process.exit(0);
}

fixStatusCalculated().catch((err) => {
  console.error('Fix failed:', err);
  process.exit(1);
});
