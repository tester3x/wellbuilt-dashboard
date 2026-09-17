/**
 * Phase 1A public company projection — PURE allowlist.
 *
 * `public_companies/{id}` is a server-owned, sanitized copy of
 * `companies/{id}`. The projector never copies address, phone, rates,
 * pay, billing, capabilities, contracts, contacts, operators, templates,
 * or operational settings. `updatedAt` is stamped by the writer, never
 * taken from the source document.
 */

export const PUBLIC_COMPANY_COLLECTION = 'public_companies';

/** String fields copied from the source company document when present. */
export const PUBLIC_COMPANY_COPIED_FIELDS = [
  'name',
  'status',
  'tier',
  'logoUrl',
  'thermalLogoUrl',
  'primaryColor',
] as const;

export type PublicCompanyCopiedField = (typeof PUBLIC_COMPANY_COPIED_FIELDS)[number];

/** Full public document keys, including the writer-owned stamp. */
export const PUBLIC_COMPANY_WHITELIST = [
  ...PUBLIC_COMPANY_COPIED_FIELDS,
  'updatedAt',
] as const;

export type PublicCompanyWhitelistField = (typeof PUBLIC_COMPANY_WHITELIST)[number];

/**
 * Fields that must never appear on a public projection. Tests pin this
 * list against projector output; the writer never consults it as an
 * allow-path (deny-by-default via the copied-field allowlist).
 */
export const PUBLIC_COMPANY_SENSITIVE_NEVER = [
  'address',
  'city',
  'state',
  'zip',
  'phone',
  'rateSheet',
  'rateSheets',
  'payConfig',
  'billingConfig',
  'currentDieselPrice',
  'doeRegion',
  'roleCapabilities',
  'roleLabels',
  'wellbuiltContract',
  'contractVersion',
  'planId',
  'entitlement',
  'entitlementOverrides',
  'workPeriodMode',
  'workPeriodConfiguration',
  'effectiveCapabilities',
  'configurationVersion',
  'contractEnforced',
  'spillReporting',
  'emergencyContacts',
  'companyContacts',
  'assignedOperators',
  'ticketTemplates',
  'activePackages',
  'customJobTypes',
  'invoicingMode',
  'invoicePrefix',
  'invoiceBook',
  'invoiceStartNumber',
  'ticketPrefix',
  'liveDispatchSync',
  'transferRequiresApproval',
  'cancelledNumberHandling',
  'splitTickets',
  'invoiceConsolidation',
  'splitTimeAllocation',
  'wellMonitoring',
  'jsaMode',
  'jsaAllowAcknowledge',
  'jsaJobPolicy',
  'requirePhotos',
  'minPhotoCount',
  'photoRetentionDays',
  'sendLevelToDispatch',
  'levelReportTemplate',
  'enabledApps',
  'requiredApps',
  'adminUsers',
  'notes',
  'shortCode',
] as const;

export type PublicCompanyCopied = Partial<Record<PublicCompanyCopiedField, string>>;

export type PublicCompanyDocument = PublicCompanyCopied & {
  updatedAt: unknown;
};

/**
 * Copy allowlisted string fields from a source company document.
 * Non-strings, empty strings, and every non-allowlisted key are dropped
 * so a full-document `set` cannot leave stale public fields.
 */
export function projectPublicCompanyFields(
  source: Record<string, unknown> | null | undefined,
): PublicCompanyCopied {
  const out: PublicCompanyCopied = {};
  if (!source) return out;
  for (const key of PUBLIC_COMPANY_COPIED_FIELDS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
    }
  }
  return out;
}

/** Public document payload: copied strings + writer-owned `updatedAt`. */
export function buildPublicCompanyDocument(
  source: Record<string, unknown> | null | undefined,
  updatedAt: unknown,
): PublicCompanyDocument {
  return {
    ...projectPublicCompanyFields(source),
    updatedAt,
  };
}

export function isPublicCompanySensitiveKey(key: string): boolean {
  return (PUBLIC_COMPANY_SENSITIVE_NEVER as readonly string[]).includes(key);
}

/** True when every key is on the public whitelist (copied fields + updatedAt). */
export function isStrictPublicCompanyDocument(doc: Record<string, unknown>): boolean {
  const allowed = new Set<string>(PUBLIC_COMPANY_WHITELIST);
  return Object.keys(doc).every((key) => allowed.has(key));
}
