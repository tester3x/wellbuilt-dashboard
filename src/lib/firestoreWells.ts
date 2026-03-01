// Firestore NDIC well data queries
// Uses the same `wellbuilt-sync` Firestore that WB Tickets populates via scripts/importWellData.ts
// Collections: operators (~103), wells (~19,276), disposals (~1,007)

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
}

export interface NdicOperator {
  name: string;
  well_count?: number;
  search_name?: string;
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

// ── Search wells across all operators (by well name substring) ──────────────

/**
 * Search NDIC wells by name across all operators.
 * Uses the search_name field (lowercase, no noise words) for matching.
 * Returns up to `maxResults` matches.
 *
 * NOTE: Firestore doesn't support LIKE/contains queries, so for global search
 * we load all wells for matched operators or do client-side filtering.
 * For the dashboard admin well picker, we search by operator first (more practical).
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
