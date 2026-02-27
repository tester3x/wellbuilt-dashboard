/**
 * Backfill NDIC well names and API numbers into well_config
 *
 * For each well in well_config, tries to find a matching NDIC well in Firestore
 * and writes ndicName + ndicApiNo to the well_config entry.
 *
 * Matching strategy:
 * 1. Search the wells collection for well_name containing the well_config key
 * 2. Use the extractShortWellName regex to match NDIC names back to short names
 *
 * Usage: node scripts/backfill-ndic.js [--dry-run]
 */

const RTDB_URL = 'https://wellbuilt-sync-default-rtdb.firebaseio.com';
const API_KEY = 'AIzaSyAGWXa-doFGzo7T5SxHVD_v5-SHXIc8wAI';
const FIRESTORE_PROJECT = 'wellbuilt-sync';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT}/databases/(default)/documents`;

const isDryRun = process.argv.includes('--dry-run');

async function rtdbGet(path) {
  const url = `${RTDB_URL}/${path}.json?auth=${API_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`RTDB GET ${path}: ${resp.status}`);
  return resp.json();
}

async function rtdbPatch(path, data) {
  const url = `${RTDB_URL}/${path}.json?auth=${API_KEY}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!resp.ok) throw new Error(`RTDB PATCH ${path}: ${resp.status}`);
  return resp.json();
}

async function firestoreQuery(collectionId, fieldPath, op, value, orderByField, pageSize) {
  const url = `${FIRESTORE_URL}:runQuery?key=${API_KEY}`;
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      where: {
        fieldFilter: {
          field: { fieldPath },
          op,
          value: { stringValue: value },
        },
      },
      orderBy: orderByField ? [{ field: { fieldPath: orderByField }, direction: 'ASCENDING' }] : undefined,
      limit: pageSize || 100,
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Firestore query failed: ${resp.status} ${text}`);
  }
  const results = await resp.json();
  // Extract documents from Firestore response
  return results
    .filter(r => r.document)
    .map(r => {
      const fields = r.document.fields || {};
      const doc = {};
      for (const [key, val] of Object.entries(fields)) {
        if (val.stringValue !== undefined) doc[key] = val.stringValue;
        else if (val.doubleValue !== undefined) doc[key] = val.doubleValue;
        else if (val.integerValue !== undefined) doc[key] = parseInt(val.integerValue);
        else if (val.booleanValue !== undefined) doc[key] = val.booleanValue;
      }
      return doc;
    });
}

function extractShortWellName(ndicName) {
  if (!ndicName) return null;
  const cleaned = ndicName.replace(/#/g, '').trim();
  const match = cleaned.match(/^([A-Za-z\s]+?)\s*(\d+)\s*-/);
  if (!match) return null;
  const baseName = match[1].trim();
  const number = match[2];
  const titleCase = baseName.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return `${titleCase} ${number}`;
}

async function main() {
  console.log(`Backfill NDIC data into well_config${isDryRun ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  // 1. Load well_config
  const wellConfig = await rtdbGet('well_config');
  const wellNames = Object.keys(wellConfig).sort();
  console.log(`\nFound ${wellNames.length} wells in well_config\n`);

  // 2. Load ALL operators from Firestore to get the operator names
  // We'll search wells by each well_config key against Firestore
  let matched = 0;
  let skipped = 0;
  let notFound = 0;
  const notFoundList = [];

  for (const wellKey of wellNames) {
    const config = wellConfig[wellKey];

    // Skip if already has NDIC data
    if (config.ndicApiNo) {
      console.log(`  [SKIP] ${wellKey} — already linked (${config.ndicApiNo})`);
      skipped++;
      continue;
    }

    // Extract the base name and number from the key
    // "Gabriel 1" → search for wells with "GABRIEL" and "1" in the name
    const parts = wellKey.match(/^(.+?)\s*(\d+)?\s*(SOG)?$/i);
    let searchName = wellKey;
    if (parts) {
      searchName = parts[1].trim();
    }

    // Try to find matching NDIC wells by operator name
    // Search Firestore wells where search_name contains the well key components
    let ndicWells = [];
    try {
      // Use REST API to query Firestore
      // Since Firestore doesn't support CONTAINS/LIKE, we'll use a different approach:
      // Search by operator name and then filter client-side
      // Actually, let's use the search_name field with EQUAL (exact) first,
      // then fall back to loading by likely operators

      // Strategy: Load wells from likely operators and match
      // First, let's see if any operator name matches part of the well name
      const searchTerm = searchName.toUpperCase();

      // Try to find wells from all operators that match this well name
      // Since we can't do full-text search on Firestore, we'll query by
      // the Firestore REST API with a range query on search_name

      // Actually, simplest approach: query wells collection where well_name starts with the search term
      // Firestore supports >= and < for range prefix queries
      const prefix = searchTerm;
      const prefixEnd = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);

      const url = `${FIRESTORE_URL}/wells?key=${API_KEY}&orderBy=well_name&pageSize=50`;
      const startAt = encodeURIComponent(`well_name >= "${prefix}"`);

      // Use structured query for prefix match
      const queryUrl = `${FIRESTORE_URL}:runQuery?key=${API_KEY}`;
      const queryBody = {
        structuredQuery: {
          from: [{ collectionId: 'wells' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: 'well_name' },
                    op: 'GREATER_THAN_OR_EQUAL',
                    value: { stringValue: prefix },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'well_name' },
                    op: 'LESS_THAN',
                    value: { stringValue: prefixEnd },
                  },
                },
              ],
            },
          },
          orderBy: [{ field: { fieldPath: 'well_name' }, direction: 'ASCENDING' }],
          limit: 50,
        },
      };

      const resp = await fetch(queryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody),
      });

      if (resp.ok) {
        const results = await resp.json();
        ndicWells = results
          .filter(r => r.document)
          .map(r => {
            const fields = r.document.fields || {};
            const doc = {};
            for (const [key, val] of Object.entries(fields)) {
              if (val.stringValue !== undefined) doc[key] = val.stringValue;
              else if (val.doubleValue !== undefined) doc[key] = val.doubleValue;
              else if (val.integerValue !== undefined) doc[key] = parseInt(val.integerValue);
            }
            return doc;
          });
      }
    } catch (err) {
      console.log(`  [ERROR] ${wellKey} — Firestore query failed: ${err.message}`);
    }

    // Now match: find the NDIC well whose short name matches the well_config key
    let bestMatch = null;

    for (const ndicWell of ndicWells) {
      const shortName = extractShortWellName(ndicWell.well_name);
      if (shortName && shortName.toLowerCase() === wellKey.toLowerCase()) {
        bestMatch = ndicWell;
        break;
      }
      // Also try exact match on well_name
      if (ndicWell.well_name && ndicWell.well_name.toLowerCase() === wellKey.toLowerCase()) {
        bestMatch = ndicWell;
        break;
      }
    }

    // Also try: well_config key contains the NDIC well or vice versa
    if (!bestMatch) {
      for (const ndicWell of ndicWells) {
        const ndicLower = (ndicWell.well_name || '').toLowerCase();
        const keyLower = wellKey.toLowerCase();
        if (ndicLower.includes(keyLower) || keyLower.includes(ndicLower.split('-')[0].trim().toLowerCase())) {
          bestMatch = ndicWell;
          break;
        }
      }
    }

    if (bestMatch) {
      console.log(`  [MATCH] ${wellKey} → ${bestMatch.well_name} (API: ${bestMatch.api_no})`);
      matched++;

      if (!isDryRun) {
        await rtdbPatch(`well_config/${wellKey}`, {
          ndicName: bestMatch.well_name,
          ndicApiNo: bestMatch.api_no,
        });
      }
    } else {
      console.log(`  [MISS]  ${wellKey} — no NDIC match found (${ndicWells.length} candidates)`);
      notFound++;
      notFoundList.push(wellKey);
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${matched} matched, ${skipped} already linked, ${notFound} not found`);
  if (notFoundList.length > 0) {
    console.log(`\nNot found (need manual linking via dashboard):`);
    notFoundList.forEach(n => console.log(`  - ${n}`));
  }
  if (isDryRun) {
    console.log('\nThis was a DRY RUN — no changes were written.');
  }
}

main().catch(console.error);
