import type { CustomJobType, RateEntry } from './companySettings';

export type OperatorRateSheets = Record<string, RateEntry[]>;

export function ratePrimaryForFamily(family: CustomJobType['baseJobTypeId']): string {
  return family === 'pw' ? 'Production Water' : 'Service Work';
}

export function customTypeForLabel(types: unknown[] | undefined, label: string): CustomJobType | undefined {
  const match = types?.find(raw => {
    const name = typeof raw === 'string' ? raw : (raw && typeof raw === 'object' ? (raw as CustomJobType).label : '');
    return typeof name === 'string' && name.trim().toLowerCase() === label.trim().toLowerCase();
  });
  if (!match) return undefined;
  if (typeof match === 'string') return {
    label: match, packages: [], baseJobTypeId: 'service-work', lifecycleShape: 'pickup_dropoff', capabilities: [],
  };
  return match as CustomJobType;
}

/** A dispatch service type is a work label under SW, even when its label says Production Water. */
export function rateIdentityForInvoice(
  invoice: { commodityType?: string | null; jobType?: string | null; serviceType?: string | null; subjob?: string | null },
  types: unknown[] | undefined,
): { primary: string; subtype: string; payBasis?: 'per_bbl' | 'hourly' } {
  const rawPrimary = (invoice.commodityType || invoice.jobType || '').trim();
  if (rawPrimary.toLowerCase() === 'production water (hr)' ||
      invoice.serviceType?.trim().toLowerCase() === 'production water') {
    return { primary: 'Service Work', subtype: 'Production Water', payBasis: 'hourly' };
  }
  const label = (invoice.serviceType || (rawPrimary === 'Service Work' ? invoice.subjob : null) || rawPrimary).trim();
  const custom = customTypeForLabel(types, label);
  if (custom) {
    return { primary: ratePrimaryForFamily(custom.baseJobTypeId), subtype: custom.label, payBasis: custom.payBasis };
  }
  if (invoice.serviceType?.trim()) {
    return { primary: 'Service Work', subtype: invoice.subjob?.trim() || invoice.serviceType.trim(), payBasis: 'hourly' };
  }
  return {
    primary: rawPrimary,
    subtype: invoice.subjob?.trim() || '',
  };
}

/** Add operator-specific exceptions under the existing primary rule without changing other rates. */
export function addCustomTypeRateOverrides(
  sheets: OperatorRateSheets,
  type: CustomJobType,
  overrides: Record<string, number>,
): OperatorRateSheets {
  const primary = ratePrimaryForFamily(type.baseJobTypeId);
  const next: OperatorRateSheets = { ...sheets };
  for (const [operator, rate] of Object.entries(overrides)) {
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Invalid rate for ${operator}`);
    const entries = sheets[operator] || [];
    const primaryIndex = entries.findIndex(entry => !entry.primaryJobType &&
      (entry.jobType === primary || (primary === 'Production Water' && entry.jobType === 'Production %')));
    const base = primaryIndex >= 0 ? entries[primaryIndex] : null;
    if (entries.some(entry => entry.jobType.toLowerCase() === type.label.toLowerCase())) {
      throw new Error(`${type.label} already has a rate for ${operator}. Edit it in Rate Sheets.`);
    }
    if (base && base.method === type.payBasis) {
      if (Object.keys(base.subtypeRates || {}).some(label => label.toLowerCase() === type.label.toLowerCase())) {
        throw new Error(`${type.label} already has a rate for ${operator}. Edit it in Rate Sheets.`);
      }
      next[operator] = entries.map((entry, index) => index === primaryIndex
        ? { ...entry, subtypeRates: { ...entry.subtypeRates, [type.label]: rate } }
        : entry);
    } else {
      // A custom type can deliberately have a pay basis different from its family.
      next[operator] = [...entries, { jobType: type.label, primaryJobType: primary, method: type.payBasis || 'hourly', rate }];
    }
  }
  return next;
}
