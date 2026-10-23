/** Keep NDIC's actual status/type; confidential wells are valid work locations. */
export function ndicCatalogDestination(statusValue: unknown, typeValue: unknown): 'wells' | 'wells_inactive' | 'disposals' | null {
  const status = String(statusValue || '').trim().toUpperCase();
  const type = String(typeValue || '').trim().toUpperCase();
  if (status === 'CONFIDENTIAL' && type === 'CONFIDENTIAL') return 'wells';
  if (['SWD', 'WI'].includes(type)) return status === 'A' ? 'disposals' : null;
  if (type === 'OG') return status === 'A' ? 'wells' : status === 'IA' ? 'wells_inactive' : null;
  return null;
}
