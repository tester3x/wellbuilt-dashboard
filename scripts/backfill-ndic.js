/**
 * Backfill NDIC/MBOGC well names and API numbers into well_config
 *
 * For each well in well_config that's missing ndicName/ndicApiNo,
 * loads ALL wells from assigned operators and matches by name.
 *
 * Matching strategy:
 * 1. Extract short name from NDIC name (e.g., "BAYONET 21-36-25H" → "Bayonet 21")
 * 2. Match against well_config key
 * 3. Also try containment match (NDIC name contains well_config key)
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

async function firestoreQueryAll(collectionId, fieldPath, op, value) {
  const url = `${FIRESTORE_URL}:runQuery?key=${API_KEY}`;
  const allDocs = [];
  let pageToken = null;

  do {
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
        limit: 500,
        ...(pageToken ? { startAt: { values: [{ referenceValue: pageToken }] } } : {}),
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
    const docs = results
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
        doc._ref = r.document.name;
        return doc;
      });
    allDocs.push(...docs);
    // No more pages if fewer results than limit
    if (docs.length < 500) break;
    pageToken = docs[docs.length - 1]._ref;
  } while (true);

  return allDocs;
}

function extractShortName(ndicName) {
  if (!ndicName) return null;
  // "BAYONET 21-36-25H" → "Bayonet 21"
  // "GABRIEL 1-36-25H" → "Gabriel 1"
  // "SAIL AND ANCHOR 4-36-25H" → "Sail And Anchor 4"
  // "STAMPEDE 2-36-25H-158-100" → "Stampede 2"
  const cleaned = ndicName.replace(/#/g, '').trim();
  // Match: NAME(s) NUMBER-section-township...
  const match = cleaned.match(/^([A-Za-z\s]+?)\s+(\d+)\s*-/);
  if (!match) return null;
  const baseName = match[1].trim();
  const number = match[2];
  const titleCase = baseName.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return `${titleCase} ${number}`;
}

function normalizeForMatch(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function main() {
  console.log(`Backfill NDIC/MBOGC data into well_config${isDryRun ? ' (DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  // 1. Load well_config
  const wellConfig = await rtdbGet('well_config');
  const wellNames = Object.keys(wellConfig).sort();
  console.log(`\nFound ${wellNames.length} wells in well_config`);

  // 2. Find wells that need backfill
  const needsBackfill = wellNames.filter(key => !wellConfig[key].ndicApiNo);
  const alreadyLinked = wellNames.length - needsBackfill.length;
  console.log(`Already linked: ${alreadyLinked}, Needs backfill: ${needsBackfill.length}\n`);

  if (needsBackfill.length === 0) {
    console.log('All wells already linked!');
    return;
  }

  // 3. Load ALL operators to get operator names
  console.log('Loading operators from Firestore...');
  const operatorsUrl = `${FIRESTORE_URL}/operators?key=${API_KEY}&pageSize=500`;
  const opResp = await fetch(operatorsUrl);
  const opData = await opResp.json();
  const operators = (opData.documents || []).map(d => {
    const fields = d.fields || {};
    return {
      name: fields.name?.stringValue || '',
      state: fields.state?.stringValue || 'ND',
    };
  });
  console.log(`Found ${operators.length} operators (ND + MT)\n`);

  // 4. Load wells for ALL operators (batch by operator)
  console.log('Loading wells from all operators...');
  const allNdicWells = [];
  for (const op of operators) {
    try {
      const wells = await firestoreQueryAll('wells', 'operator', 'EQUAL', op.name);
      allNdicWells.push(...wells);
      if (wells.length > 0) {
        process.stdout.write(`  ${op.name}: ${wells.length} wells\n`);
      }
    } catch (err) {
      console.log(`  [ERROR] ${op.name}: ${err.message}`);
    }
    // Small delay between operator queries
    await new Promise(r => setTimeout(r, 50));
  }
  console.log(`\nTotal NDIC/MBOGC wells loaded: ${allNdicWells.length}\n`);

  // 5. Build lookup maps
  // Map from normalized short name → NDIC well
  const shortNameMap = new Map();
  // Map from normalized full name → NDIC well
  const fullNameMap = new Map();

  for (const well of allNdicWells) {
    if (!well.well_name) continue;
    const shortName = extractShortName(well.well_name);
    if (shortName) {
      const key = normalizeForMatch(shortName);
      if (!shortNameMap.has(key)) shortNameMap.set(key, well);
    }
    fullNameMap.set(normalizeForMatch(well.well_name), well);
  }
  console.log(`Short name index: ${shortNameMap.size} entries`);
  console.log(`Full name index: ${fullNameMap.size} entries\n`);

  // 6. Match each unlinked well
  let matched = 0;
  let notFound = 0;
  const notFoundList = [];

  for (const wellKey of needsBackfill) {
    const normalized = normalizeForMatch(wellKey);
    // Strip SOG suffix for matching
    const withoutSog = wellKey.replace(/\s*SOG\s*$/i, '').trim();
    const normalizedNoSog = normalizeForMatch(withoutSog);

    let bestMatch = null;

    // Strategy 1: Exact short name match ("Gabriel 1" → "GABRIEL 1-36-25H")
    bestMatch = shortNameMap.get(normalized) || shortNameMap.get(normalizedNoSog);

    // Strategy 2: Full name exact match
    if (!bestMatch) {
      bestMatch = fullNameMap.get(normalized) || fullNameMap.get(normalizedNoSog);
    }

    // Strategy 3: NDIC name contains the well_config key (case-insensitive)
    if (!bestMatch) {
      const keyLower = withoutSog.toLowerCase();
      bestMatch = allNdicWells.find(w => {
        const ndicLower = (w.well_name || '').toLowerCase();
        // NDIC name starts with the well key base name
        return ndicLower.startsWith(keyLower + ' ') || ndicLower.startsWith(keyLower + '-');
      });
    }

    // Strategy 4: Containment — well key base matches start of NDIC name word
    if (!bestMatch) {
      const keyParts = withoutSog.toLowerCase().split(/\s+/);
      if (keyParts.length >= 2) {
        const baseName = keyParts.slice(0, -1).join(' ');
        const number = keyParts[keyParts.length - 1];
        bestMatch = allNdicWells.find(w => {
          const ndicLower = (w.well_name || '').toLowerCase();
          // Base name must match at start of NDIC name (word boundary)
          const nameStart = ndicLower.split(/\s+/)[0];
          return nameStart === baseName && ndicLower.includes(number);
        });
      }
    }

    if (bestMatch) {
      console.log(`  [MATCH] ${wellKey} → ${bestMatch.well_name} (${bestMatch.api_no || 'no API'}) [${bestMatch.state || 'ND'}]`);
      matched++;

      if (!isDryRun) {
        const patch = { ndicName: bestMatch.well_name };
        if (bestMatch.api_no) patch.ndicApiNo = bestMatch.api_no;
        await rtdbPatch(`well_config/${wellKey}`, patch);
      }
    } else {
      console.log(`  [MISS]  ${wellKey}`);
      notFound++;
      notFoundList.push(wellKey);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${matched} matched, ${alreadyLinked} already linked, ${notFound} not found`);
  if (notFoundList.length > 0) {
    console.log(`\nNot found (custom locations or need manual linking):`);
    notFoundList.forEach(n => console.log(`  - ${n}`));
  }
  if (isDryRun) {
    console.log('\nThis was a DRY RUN — no changes were written.');
    console.log('Run without --dry-run to write changes.');
  }
}

main().catch(console.error);
