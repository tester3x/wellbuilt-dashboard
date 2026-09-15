#!/usr/bin/env node
/**
 * tools/audit-wellpool-identity.mjs
 *
 * Source-only, read-only preflight audit tool for well-pool identity and ingress coverage.
 * 
 * Reports:
 * 1. Active well_config total
 * 2. Active well_config records missing companyId
 * 3. Active well_config records missing canonical wellId
 * 4. Duplicate (companyId, wellId) pairs
 * 5. Duplicate wellName across multiple companies (cross-tenant collision matrix)
 * 6. Every ingress path and whether it server-stamps companyId
 * 7. Incoming legacy / Watchdog paths that may lack companyId
 *
 * STOP CONDITION:
 * Stage 1 writer deployment is STRICTLY BLOCKED until the audit confirms acceptable
 * identity coverage or a governed mapping/backfill is approved.
 *
 * Usage:
 *   node tools/audit-wellpool-identity.mjs [--file <path-to-well_config.json>] [--dry-run]
 */

import fs from 'fs';
import path from 'path';

export const INGRESS_PATHS_INVENTORY = [
  {
    path: 'packets/incoming (WB-T driver pull)',
    function: 'processIncomingPull',
    file: 'functions/src/index.ts',
    serverStampsCompanyId: true,
    mechanism: 'resolveAuthoritativeWellConfig matches driver credentials / fails closed on ambiguous un-stamped packets',
    legacyWatchdogRisk: 'Medium (WB-T legacy clients omitting companyId fail closed if wellName is shared)',
  },
  {
    path: 'recoverRejectedPull (callable)',
    function: 'recoverRejectedPull',
    file: 'functions/src/recoverRejectedPullCallable.ts',
    serverStampsCompanyId: true,
    mechanism: 'Authenticated driver claim (driver.companyId) server-stamped onto replacement incoming packet',
    legacyWatchdogRisk: 'None (callable requires secure driver claim and verifies company ownership)',
  },
  {
    path: 'packets/incoming (WB-M / Dashboard edit)',
    function: 'processEditRequest',
    file: 'functions/src/index.ts',
    serverStampsCompanyId: true,
    mechanism: 'Preserves original packet companyId or resolves authoritative well_config binding',
    legacyWatchdogRisk: 'Low (edits require existing processed packet identity)',
  },
  {
    path: 'packets/incoming (Watchdog / synthetic sweeps)',
    function: 'watchdogPullCheck / cronIngress',
    file: 'functions/src/index.ts',
    serverStampsCompanyId: false,
    mechanism: 'Direct writes by legacy automated jobs without explicit tenant context',
    legacyWatchdogRisk: 'HIGH — Automated sweeps writing packets without companyId will be quarantined under fail-closed composite rules',
  },
  {
    path: 'packets/incoming (Delete requests)',
    function: 'processDeleteRequest',
    file: 'functions/src/index.ts',
    serverStampsCompanyId: true,
    mechanism: 'Authenticated caller must own the target packet; survivor row reconciled by companyId',
    legacyWatchdogRisk: 'None (owner-scoped)',
  },
];

export function auditWellConfigData(wellConfig) {
  const records = wellConfig && typeof wellConfig === 'object' ? wellConfig : {};
  const entries = Object.entries(records);

  const total = entries.length;
  const missingCompanyId = [];
  const missingWellId = [];
  const pairCounts = new Map();
  const nameToCompanies = new Map();

  for (const [key, val] of entries) {
    if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
    const rec = val;
    const companyId = typeof rec.companyId === 'string' ? rec.companyId.trim() : '';
    const wellId = (typeof rec.wellId === 'string' && rec.wellId.trim()) || (typeof rec.id === 'string' && rec.id.trim()) || '';
    const wellName = typeof rec.wellName === 'string' ? rec.wellName.trim() : key;

    if (!companyId) {
      missingCompanyId.push({ key, wellName });
    }
    if (!wellId) {
      missingWellId.push({ key, wellName });
    }

    if (companyId && wellId) {
      const pairKey = `${companyId}__${wellId}`;
      const list = pairCounts.get(pairKey) || [];
      list.push(key);
      pairCounts.set(pairKey, list);
    }

    if (wellName) {
      const cos = nameToCompanies.get(wellName) || new Set();
      cos.add(companyId || '(missing-company)');
      nameToCompanies.set(wellName, cos);
    }
  }

  const duplicatePairs = [];
  for (const [pair, keys] of pairCounts.entries()) {
    if (keys.length > 1) {
      duplicatePairs.push({ pair, keys });
    }
  }

  const duplicateWellNames = [];
  for (const [wellName, cos] of nameToCompanies.entries()) {
    if (cos.size > 1) {
      duplicateWellNames.push({ wellName, companies: Array.from(cos) });
    }
  }

  return {
    total,
    missingCompanyId,
    missingWellId,
    duplicatePairs,
    duplicateWellNames,
  };
}

export function printAuditReport(dataAudit, isOfflineSample = false) {
  console.log('================================================================================');
  console.log('              WELL-POOL IDENTITY & INGRESS PREFLIGHT AUDIT                     ');
  console.log('================================================================================\n');

  console.log('1. ACTIVE WELL_CONFIG IDENTITY METRICS' + (isOfflineSample ? ' (SAMPLE / OFFLINE)' : ''));
  console.log('--------------------------------------------------------------------------------');
  console.log(`Total active well_config records:        ${dataAudit.total}`);
  console.log(`Records missing companyId:                ${dataAudit.missingCompanyId.length}`);
  console.log(`Records missing canonical wellId:         ${dataAudit.missingWellId.length}`);
  console.log(`Duplicate (companyId, wellId) pairs:      ${dataAudit.duplicatePairs.length}`);
  console.log(`Cross-tenant same-name well collisions:   ${dataAudit.duplicateWellNames.length}\n`);

  if (dataAudit.missingCompanyId.length > 0) {
    console.log('(!) Wells missing companyId:');
    dataAudit.missingCompanyId.slice(0, 10).forEach((w) => console.log(`    - Key: ${w.key} (wellName: "${w.wellName}")`));
    if (dataAudit.missingCompanyId.length > 10) console.log(`    ... and ${dataAudit.missingCompanyId.length - 10} more`);
    console.log('');
  }

  if (dataAudit.missingWellId.length > 0) {
    console.log('(!) Wells missing canonical wellId:');
    dataAudit.missingWellId.slice(0, 10).forEach((w) => console.log(`    - Key: ${w.key} (wellName: "${w.wellName}")`));
    if (dataAudit.missingWellId.length > 10) console.log(`    ... and ${dataAudit.missingWellId.length - 10} more`);
    console.log('');
  }

  if (dataAudit.duplicateWellNames.length > 0) {
    console.log('(!) Cross-tenant well name collisions:');
    dataAudit.duplicateWellNames.forEach((d) => {
      console.log(`    - "${d.wellName}" configured across ${d.companies.length} tenants: ${d.companies.join(', ')}`);
    });
    console.log('');
  }

  console.log('2. INGRESS PATHS & SERVER-STAMPING COVERAGE');
  console.log('--------------------------------------------------------------------------------');
  console.table(
    INGRESS_PATHS_INVENTORY.map((p) => ({
      'Ingress Path': p.path,
      'Server Stamps Co?': p.serverStampsCompanyId ? 'YES' : 'NO',
      'Function': p.function,
      'Legacy / Watchdog Risk': p.legacyWatchdogRisk,
    }))
  );
  console.log('');

  console.log('3. DEPLOYMENT STOP CONDITION');
  console.log('--------------------------------------------------------------------------------');
  const hasIdentityDefects = dataAudit.missingCompanyId.length > 0 || dataAudit.missingWellId.length > 0;
  if (hasIdentityDefects) {
    console.log('>>> [DEPLOYMENT GATE: BLOCKED] <<<');
    console.log('Active configuration records lack explicit companyId or canonical wellId.');
    console.log('Deploying the composite-writer without complete identity will cause unstamped');
    console.log('incoming pulls to fail closed or be quarantined.');
    console.log('ACTION REQUIRED: Complete governed identity backfill before deploying Stage 1.\n');
  } else {
    console.log('>>> [DEPLOYMENT GATE: CONDITIONAL] <<<');
    console.log('Configuration records carry complete identity.');
    console.log('NOTICE: Production deployment is BLOCKED until this audit is executed against');
    console.log('the live database with acceptable identity coverage and governed rollout approval.\n');
  }
}

// Command-line entry point
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  const args = process.argv.slice(2);
  let filePath = '';
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    filePath = args[fileIdx + 1];
  }

  let wellConfigData = {};
  let isOffline = true;
  if (filePath && fs.existsSync(filePath)) {
    try {
      wellConfigData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      isOffline = false;
    } catch (err) {
      console.error(`Error reading ${filePath}: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Demonstration/baseline structure
    wellConfigData = {
      'well-a': { wellName: 'Shared Well', companyId: 'company-a', wellId: 'well-a' },
      'well-b': { wellName: 'Shared Well', companyId: 'company-b', wellId: 'well-b' },
      'sample-unassigned': { wellName: 'Orphan Well', companyId: '', wellId: '' },
    };
  }

  const audit = auditWellConfigData(wellConfigData);
  printAuditReport(audit, isOffline);
}
