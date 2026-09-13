/**
 * Firebase-free CORE for company-settings controls (Operations / Photos / DOE
 * Region). Holds the exact field payloads each control writes and the write-path
 * runner, so tests can prove the contract at runtime through an injected mock
 * writer — no Firebase, no network, no production writes.
 *
 * NOTE on authorization: these settings are written with a DIRECT Firestore
 * updateDoc (updateCompanyFields → companies/{id}). The deployed rules permit
 * ANY authenticated caller to update non-protected company keys, so the client
 * capability gate is the ONLY capability enforcement for them. The gate lives in
 * the components (hasCapability); this core only models the payloads + writes.
 */

/** A company-field writer: real one is updateCompanyFields; tests pass a mock. */
export type CompanyFieldWriter = (companyId: string, fields: Record<string, unknown>) => Promise<void>;

/** Push a field-merge through an injected writer (the tested write path). */
export async function runCompanyFieldWrite(
  write: CompanyFieldWriter,
  companyId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await write(companyId, fields);
}

// ── Operations payloads ──────────────────────────────────────────────────────
export const buildBooleanToggle = (field: string, current: boolean): Record<string, unknown> => ({ [field]: !current });
export const buildCancelledNumberHandling = (mode: 'recycle' | 'void'): Record<string, unknown> => ({ cancelledNumberHandling: mode });
export const buildInvoicingMode = (mode: 'invoice_tickets' | 'ticket_only' | 'hybrid'): Record<string, unknown> => ({ invoicingMode: mode });
/** value is true | false | a deleteField() sentinel supplied by the caller. */
export const buildLiveDispatchSync = (value: unknown): Record<string, unknown> => ({ liveDispatchSync: value });

// ── Photos payloads ──────────────────────────────────────────────────────────
export const buildRequirePhotos = (current: boolean): Record<string, unknown> => ({ requirePhotos: !current });
export const buildMinPhotoCount = (value: number): Record<string, unknown> => ({ minPhotoCount: value });
export const buildPhotoRetentionDays = (value: number): Record<string, unknown> => ({ photoRetentionDays: value });
/** Parse a numeric-string setting; null means "invalid — do not write". */
export function parsePositivePhotoInt(raw: string): number | null {
  const v = parseInt(raw, 10);
  return Number.isNaN(v) || v < 1 ? null : v;
}

// ── Billing payload ──────────────────────────────────────────────────────────
export const buildDoeRegion = (region: string): Record<string, unknown> => ({ doeRegion: region });
