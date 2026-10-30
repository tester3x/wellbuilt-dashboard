type CatalogRow = { operator?: unknown };
export type OperatorLookup = (collection: 'wells' | 'wells_inactive', field: 'api_no' | 'well_name', value: string) => Promise<CatalogRow[]>;

/** Operator identity belongs to the linked catalogue, never the form payload.
 * Active records win; an inactive well may still have an approved hauling job. */
export async function canonicalWellOperator(lookup: OperatorLookup, apiNo: string, name: string): Promise<string | undefined> {
  for (const [field, value] of [['api_no', apiNo], ['well_name', name]] as const) {
    if (!value.trim()) continue;
    for (const collection of ['wells', 'wells_inactive'] as const) {
      const rows = await lookup(collection, field, value);
      if (!rows.length) continue;
      const operators = new Set(rows.map(row => row.operator).filter((operator): operator is string => typeof operator === 'string' && !!operator.trim()).map(operator => operator.trim()));
      return operators.size === 1 ? [...operators][0] : undefined;
    }
  }
  return undefined;
}
