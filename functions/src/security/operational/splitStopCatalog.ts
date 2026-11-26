import type {Firestore, Transaction} from 'firebase-admin/firestore';
import {applyDispatchSwdDirectory} from '../dispatchSwdDirectory';

/** Exact, bounded lookups only; never download the location catalog per stop. */
export async function approvedSplitDisposal(tx: Transaction, db: Firestore, companyId: string,
  record: Record<string, unknown>): Promise<boolean> {
  const name = typeof record.wellName === 'string' ? record.wellName.trim() : '';
  const ndic = typeof record.ndicWellName === 'string' ? record.ndicWellName.trim() : '';
  const names = [...new Set([name, ndic].filter(Boolean))];
  if (!names.length) return false;
  const directory = db.collection('companies').doc(companyId).collection('swd_directory');
  const aliases = await tx.get(directory.where('displayName', 'in', names).limit(4));
  const canonical = [...new Set([...names, ...aliases.docs.map(d => d.get('ndicWellName'))
    .filter((v): v is string => typeof v === 'string' && !!v.trim())])].slice(0, 10);
  const [byName, bySearch, overrides] = await Promise.all([
    tx.get(db.collection('disposals').where('well_name', 'in', canonical).limit(8)),
    tx.get(db.collection('disposals').where('search_name', 'in', canonical.map(n => n.toLowerCase())).limit(8)),
    tx.get(directory.where('ndicWellName', 'in', canonical).limit(8)),
  ]);
  const scoped = (row: Record<string, any>) => !row.companyId || row.companyId === companyId;
  const disposals = [...new Map([...byName.docs, ...bySearch.docs].map(d => [d.id, d.data()])).values()]
    .filter(scoped).map(row => ({...row, ndicWellName: row.well_name}));
  const entries = [...new Map([...aliases.docs, ...overrides.docs].map(d => [d.id, d.data()])).values()].filter(scoped);
  const matches = applyDispatchSwdDirectory(disposals, entries).filter(row => {
    const aliases = [row.well_name, row.ndicWellName, row.ndicName].filter(v => typeof v === 'string').map(v => v.trim().toLowerCase());
    return aliases.includes(name.toLowerCase()) && (!ndic || aliases.includes(ndic.toLowerCase()));
  });
  return matches.length === 1;
}
