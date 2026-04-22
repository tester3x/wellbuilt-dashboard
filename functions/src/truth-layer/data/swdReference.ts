/**
 * Phase 18 — static SWD / disposal reference dataset.
 *
 * Seeded from disposal-kind locations observed in live Truth Debug that
 * fell to `custom/fallback-only` because their driver-entered form
 * didn't match the well_config key (the well_config key typically
 * carries an operator-suffix, e.g. `"HYDRO CLEAR SWD 1 — Tallgrass
 * Water North Dakota"`, while invoices carry the short form drivers
 * actually type: `"HYDRO CLEAR SWD 1"`).
 *
 * Add entries here when new SWD / disposal names are observed as
 * fallback-only in production. Keep entries minimal — just the canonical
 * short form drivers and operators both recognize. Type/operator metadata
 * is optional and purely informational (not used in matching).
 */
export interface SwdReferenceEntry {
  name: string;
  type?: 'swd' | 'disposal';
  operator?: string;
}

export const SWD_REFERENCE: ReadonlyArray<SwdReferenceEntry> = [
  { name: 'HYDRO CLEAR SWD 1', type: 'swd' },
  { name: 'CURL 23-14', type: 'disposal' },
  { name: 'MAUSER FEDERAL 3-1 8-17H', type: 'disposal' },
  { name: 'MAUSER FEDERAL 9-18-17TFH', type: 'disposal' },
  // Phase 19 additions — disposals observed as fallback-only in live data
  // after Phase 18 deploy.
  { name: 'MORK 24-8', type: 'disposal' },
];
