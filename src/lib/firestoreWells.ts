// Firestore well data queries (ND + MT)
// Uses the same `wellbuilt-sync` Firestore that WB Tickets populates via scripts/importWellData.ts
// Collections: operators (ND ~103 + MT), wells (ND ~19K + MT ~13K), disposals (ND ~1K + MT)

import { getFirestoreDb } from './firebase';
import {
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
} from 'firebase/firestore';

export interface NdicWell {
  well_name: string;
  operator: string;
  api_no: string;
  latitude?: number;
  longitude?: number;
  legal_desc?: string;
  county?: string;
  field_name?: string;
  search_name?: string;
  search_operator?: string;
  state?: string; // 'ND' | 'MT'
}

export interface NdicOperator {
  name: string;
  well_count?: number;
  search_name?: string;
  state?: string; // 'ND' | 'MT'
}

// ── In-memory cache ─────────────────────────────────────────────────────────

let operatorsCache: NdicOperator[] | null = null;
let wellsCacheByOperator: Record<string, NdicWell[]> = {};

// ── Operators ───────────────────────────────────────────────────────────────

export async function loadOperators(): Promise<NdicOperator[]> {
  if (operatorsCache) return operatorsCache;

  const db = getFirestoreDb();
  const q = query(collection(db, 'operators'), orderBy('name'));
  const snapshot = await getDocs(q);
  operatorsCache = snapshot.docs.map(d => d.data() as NdicOperator);
  console.log(`[firestoreWells] Loaded ${operatorsCache.length} operators`);
  return operatorsCache;
}

// ── Wells by operator ───────────────────────────────────────────────────────

export async function loadWellsForOperator(operatorName: string): Promise<NdicWell[]> {
  if (wellsCacheByOperator[operatorName]) {
    return wellsCacheByOperator[operatorName];
  }

  const db = getFirestoreDb();
  const q = query(
    collection(db, 'wells'),
    where('operator', '==', operatorName),
    orderBy('well_name'),
  );
  const snapshot = await getDocs(q);
  const wells = snapshot.docs.map(d => d.data() as NdicWell);
  wellsCacheByOperator[operatorName] = wells;
  console.log(`[firestoreWells] Loaded ${wells.length} wells for ${operatorName}`);
  return wells;
}

// ── Inactive wells fallback ────────────────────────────────────────────────

let inactiveWellsCacheByOperator: Record<string, NdicWell[]> = {};

export async function loadInactiveWellsForOperator(operatorName: string): Promise<NdicWell[]> {
  if (inactiveWellsCacheByOperator[operatorName]) {
    return inactiveWellsCacheByOperator[operatorName];
  }

  const db = getFirestoreDb();
  const q = query(
    collection(db, 'wells_inactive'),
    where('operator', '==', operatorName),
    orderBy('well_name'),
  );
  const snapshot = await getDocs(q);
  const wells = snapshot.docs.map(d => d.data() as NdicWell);
  inactiveWellsCacheByOperator[operatorName] = wells;
  console.log(`[firestoreWells] Loaded ${wells.length} inactive wells for ${operatorName}`);
  return wells;
}

/**
 * Find a well by exact name. Checks active wells first, falls back to inactive.
 * Used when a well_config entry references a name not in the active collection.
 */
export async function findWellByName(wellName: string, operatorWells?: NdicWell[]): Promise<NdicWell | null> {
  const lower = wellName.toLowerCase();

  // 1. Check provided operator wells
  if (operatorWells) {
    const match = operatorWells.find(w => (w.search_name || w.well_name.toLowerCase()) === lower);
    if (match) return match;
  }

  // 2. Query active wells collection
  const db = getFirestoreDb();
  const activeQuery = query(
    collection(db, 'wells'),
    where('search_name', '==', lower),
    limit(1),
  );
  const activeSnap = await getDocs(activeQuery);
  if (!activeSnap.empty) return activeSnap.docs[0].data() as NdicWell;

  // 3. Fallback: query inactive wells collection
  const inactiveQuery = query(
    collection(db, 'wells_inactive'),
    where('search_name', '==', lower),
    limit(1),
  );
  const inactiveSnap = await getDocs(inactiveQuery);
  if (!inactiveSnap.empty) {
    console.log(`[firestoreWells] Found "${wellName}" in inactive wells`);
    return inactiveSnap.docs[0].data() as NdicWell;
  }

  return null;
}

// ── Search wells across all operators (by well name substring) ──────────────

/**
 * Search wells by name across all operators (ND + MT).
 * Uses the search_name field (lowercase) for matching.
 * Returns up to `maxResults` matches.
 */
export function searchWellsByName(
  searchText: string,
  operatorWells: NdicWell[],
  maxResults: number = 20,
): NdicWell[] {
  if (!searchText || searchText.length < 2) return [];

  const lower = searchText.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(w => w.length > 0);

  // Multi-word matching: every word must appear in well_name or search_name
  const matches = operatorWells.filter(well => {
    const name = (well.search_name || well.well_name || '').toLowerCase();
    return words.every(w => name.includes(w));
  });

  return matches.slice(0, maxResults);
}

// ── Disposals (SWD facilities) ──────────────────────────────────────────────

let disposalsCache: NdicWell[] | null = null;

export async function loadDisposals(): Promise<NdicWell[]> {
  if (disposalsCache) return disposalsCache;

  const db = getFirestoreDb();
  const q = query(collection(db, 'disposals'), orderBy('well_name'));
  const snapshot = await getDocs(q);
  disposalsCache = snapshot.docs.map(d => d.data() as NdicWell);
  console.log(`[firestoreWells] Loaded ${disposalsCache.length} disposals`);
  return disposalsCache;
}

export function searchDisposals(
  searchText: string,
  disposals: NdicWell[],
  maxResults: number = 15,
): NdicWell[] {
  if (!searchText || searchText.length < 2) return [];

  const lower = searchText.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(w => w.length > 0);

  const matches = disposals.filter(disp => {
    const name = (disp.search_name || disp.well_name || '').toLowerCase();
    const op = (disp.search_operator || disp.operator || '').toLowerCase();
    return words.every(w => name.includes(w) || op.includes(w));
  });

  return matches.slice(0, maxResults);
}

// ── Search operators ────────────────────────────────────────────────────────

export function searchOperators(
  searchText: string,
  operators: NdicOperator[],
  maxResults: number = 10,
): NdicOperator[] {
  if (!searchText || searchText.length < 1) return [];

  const lower = searchText.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(w => w.length > 0);

  const matches = operators.filter(op => {
    const name = (op.search_name || op.name || '').toLowerCase();
    return words.every(w => name.includes(w));
  });

  return matches.slice(0, maxResults);
}
