import { getFirebaseDatabase } from '../firebase';
import { ref, get } from 'firebase/database';

const cache = new Map<string, string>();

export async function resolveDriverDisplayName(driverHash: string): Promise<string> {
  const key = driverHash.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key)!;

  try {
    const db = getFirebaseDatabase();
    const snap = await get(ref(db, `drivers/approved/${key}`));
    if (snap.exists()) {
      const data = snap.val() as { displayName?: string; legalName?: string };
      const name = data.displayName || data.legalName || key.slice(0, 8);
      cache.set(key, name);
      return name;
    }
  } catch {
    // fall through
  }

  const fallback = key.slice(0, 8);
  cache.set(key, fallback);
  return fallback;
}

export async function resolveDriverNames(driverHashes: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(driverHashes.map((h) => h.trim().toLowerCase()).filter(Boolean))];
  const entries = await Promise.all(unique.map(async (hash) => [hash, await resolveDriverDisplayName(hash)] as const));
  return Object.fromEntries(entries);
}