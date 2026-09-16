/**
 * Pure Firebase-free CORE for Dispatch Job Types vocabulary configuration.
 *
 * Each hauler defines the flat list of job-type terms its dispatchers and drivers see.
 * Every entry maps internally to canonical parent workClass ('pw' | 'sw').
 *
 * This module is pure (no Firebase, no network, no side effects) and can be fully
 * tested in node test runner.
 */

export type WorkClass = 'pw' | 'sw';

export interface DispatchJobTypeEntry {
  /** Immutable stable ID — never regenerated on code or label edits */
  id: string;
  /** Exactly two-letter uppercase code, e.g. "PW", "SW", "DW", "FW" */
  code: string;
  /** Human-readable display name, e.g. "Production Water", "Fresh Water" */
  name: string;
  /** Canonical parent work class */
  workClass: WorkClass;
  /** Whether dispatchers and drivers see this option */
  enabled: boolean;
  /** Deterministic 0-indexed display sort order */
  order: number;
}

export interface DispatchJobTypeConfig {
  version: 1;
  items: DispatchJobTypeEntry[];
  updatedAtIso?: string;
  updatedByUid?: string;
}

/** In-memory fallback defaults when company has no stored configuration. */
export const DEFAULT_DISPATCH_JOB_TYPES: readonly DispatchJobTypeEntry[] = Object.freeze([
  Object.freeze({
    id: 'pw-default',
    code: 'PW',
    name: 'Production Water',
    workClass: 'pw' as WorkClass,
    enabled: true,
    order: 0,
  }),
  Object.freeze({
    id: 'sw-default',
    code: 'SW',
    name: 'Service Work',
    workClass: 'sw' as WorkClass,
    enabled: true,
    order: 1,
  }),
]);

/** Clone defaults as mutable array */
export function getDefaultDispatchJobTypes(): DispatchJobTypeEntry[] {
  return DEFAULT_DISPATCH_JOB_TYPES.map(e => ({ ...e }));
}

/** Generate an immutable stable ID for a new job type entry */
export function generateJobTypeId(): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `djt_${timestamp}_${rand}`;
}

/** Normalize two-letter code to uppercase trimmed */
export function normalizeJobTypeCode(raw: string): string {
  return (raw || '').trim().toUpperCase();
}

/** Normalize display name */
export function normalizeJobTypeName(raw: string): string {
  return (raw || '').trim();
}

/**
 * Parses and sanitizes stored configuration from Firestore.
 * Fails safely to in-memory defaults if missing or malformed.
 */
export function parseDispatchJobTypesConfig(raw: unknown): DispatchJobTypeConfig {
  if (!raw || typeof raw !== 'object') {
    return { version: 1, items: getDefaultDispatchJobTypes() };
  }

  const candidate = raw as Record<string, unknown>;
  const rawItems = Array.isArray(candidate.items)
    ? candidate.items
    : Array.isArray(raw)
      ? (raw as unknown[])
      : null;

  if (!rawItems || rawItems.length === 0) {
    return { version: 1, items: getDefaultDispatchJobTypes() };
  }

  const parsedItems: DispatchJobTypeEntry[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    if (!item || typeof item !== 'object') continue;

    const obj = item as Record<string, unknown>;
    const code = normalizeJobTypeCode(String(obj.code || ''));
    const name = normalizeJobTypeName(String(obj.name || ''));
    const workClass: WorkClass = obj.workClass === 'sw' ? 'sw' : 'pw';
    const enabled = obj.enabled !== false;

    // Stable ID preservation or deterministic fallback
    let id = typeof obj.id === 'string' && obj.id.trim().length > 0 ? obj.id.trim() : '';
    if (!id || seenIds.has(id)) {
      id = `djt_recovered_${i}_${code.toLowerCase() || 'item'}`;
    }
    seenIds.add(id);

    // Only accept items that have at least some valid identifier
    if (code || name) {
      parsedItems.push({
        id,
        code: code || 'XX',
        name: name || code || 'Unnamed Type',
        workClass,
        enabled,
        order: typeof obj.order === 'number' && Number.isFinite(obj.order) ? obj.order : i,
      });
    }
  }

  if (parsedItems.length === 0) {
    return { version: 1, items: getDefaultDispatchJobTypes() };
  }

  // Sort by order deterministically and normalize order indices
  parsedItems.sort((a, b) => a.order - b.order);
  const normalizedItems = parsedItems.map((item, idx) => ({ ...item, order: idx }));

  return {
    version: 1,
    items: normalizedItems,
    updatedAtIso: typeof candidate.updatedAtIso === 'string' ? candidate.updatedAtIso : undefined,
    updatedByUid: typeof candidate.updatedByUid === 'string' ? candidate.updatedByUid : undefined,
  };
}

/** Resolve effective job types from company configuration (fails safely to defaults). */
export function resolveDispatchJobTypes(raw: unknown): DispatchJobTypeEntry[] {
  return parseDispatchJobTypesConfig(raw).items;
}

export interface ValidationIssue {
  field?: 'code' | 'name' | 'workClass' | 'general';
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  rowErrors: Record<string, { code?: string; name?: string }>;
  generalError?: string;
}

/**
 * Validates the draft entries.
 * Rules:
 * - code is exactly 2 letters [A-Z]{2}
 * - codes are unique (case-insensitive)
 * - name is non-empty
 * - names are unique (case-insensitive)
 * - stable IDs are unique and non-empty
 * - at least one entry must remain enabled
 * - single-class configs (all PW or all SW) are allowed
 */
export function validateDispatchJobTypes(entries: DispatchJobTypeEntry[]): ValidationResult {
  const rowErrors: Record<string, { code?: string; name?: string }> = {};
  const codeMap = new Map<string, string>(); // upper code -> first entry id
  const nameMap = new Map<string, string>(); // lower name -> first entry id
  const idSet = new Set<string>();

  let enabledCount = 0;

  for (const entry of entries) {
    const rowErr: { code?: string; name?: string } = {};

    // ID uniqueness & presence
    if (!entry.id || idSet.has(entry.id)) {
      rowErr.code = 'Internal error: duplicate or missing stable ID.';
    } else {
      idSet.add(entry.id);
    }

    // Code validation: exactly 2 letters
    const normalizedCode = normalizeJobTypeCode(entry.code);
    if (!normalizedCode) {
      rowErr.code = 'Code is required.';
    } else if (!/^[A-Z]{2}$/.test(normalizedCode)) {
      rowErr.code = 'Code must be exactly 2 letters (e.g. PW, SW, DW).';
    } else if (codeMap.has(normalizedCode)) {
      rowErr.code = `Duplicate code "${normalizedCode}". Codes must be unique.`;
      const prevId = codeMap.get(normalizedCode)!;
      if (!rowErrors[prevId]) rowErrors[prevId] = {};
      rowErrors[prevId].code = `Duplicate code "${normalizedCode}". Codes must be unique.`;
    } else {
      codeMap.set(normalizedCode, entry.id);
    }

    // Display Name validation
    const normalizedName = normalizeJobTypeName(entry.name);
    if (!normalizedName) {
      rowErr.name = 'Display name is required.';
    } else {
      const lowerName = normalizedName.toLowerCase();
      if (nameMap.has(lowerName)) {
        rowErr.name = `Duplicate name "${normalizedName}". Names must be unique.`;
        const prevId = nameMap.get(lowerName)!;
        if (!rowErrors[prevId]) rowErrors[prevId] = {};
        rowErrors[prevId].name = `Duplicate name "${normalizedName}". Names must be unique.`;
      } else {
        nameMap.set(lowerName, entry.id);
      }
    }

    if (entry.enabled) {
      enabledCount++;
    }

    if (rowErr.code || rowErr.name) {
      rowErrors[entry.id] = { ...rowErrors[entry.id], ...rowErr };
    }
  }

  let generalError: string | undefined;
  if (entries.length === 0) {
    generalError = 'At least one job type must be defined.';
  } else if (enabledCount === 0) {
    generalError = 'At least one job type must remain enabled.';
  }

  const valid = Object.keys(rowErrors).length === 0 && !generalError;
  return { valid, rowErrors, generalError };
}

/** Move an entry up in order */
export function moveJobTypeUp(entries: DispatchJobTypeEntry[], index: number): DispatchJobTypeEntry[] {
  if (index <= 0 || index >= entries.length) return entries;
  const copy = [...entries];
  const item = copy[index];
  copy[index] = copy[index - 1];
  copy[index - 1] = item;
  return copy.map((e, idx) => ({ ...e, order: idx }));
}

/** Move an entry down in order */
export function moveJobTypeDown(entries: DispatchJobTypeEntry[], index: number): DispatchJobTypeEntry[] {
  if (index < 0 || index >= entries.length - 1) return entries;
  const copy = [...entries];
  const item = copy[index];
  copy[index] = copy[index + 1];
  copy[index + 1] = item;
  return copy.map((e, idx) => ({ ...e, order: idx }));
}

/**
 * Builds the payload for Firestore persistence.
 * Normalizes all codes and names and sets deterministic 0..N-1 order.
 */
export function buildDispatchJobTypesPayload(
  entries: DispatchJobTypeEntry[],
  actorUid?: string,
): DispatchJobTypeConfig {
  const normalizedItems: DispatchJobTypeEntry[] = entries.map((entry, idx) => ({
    id: entry.id,
    code: normalizeJobTypeCode(entry.code),
    name: normalizeJobTypeName(entry.name),
    workClass: entry.workClass === 'sw' ? 'sw' : 'pw',
    enabled: Boolean(entry.enabled),
    order: idx,
  }));

  const payload: DispatchJobTypeConfig = {
    version: 1,
    items: normalizedItems,
    updatedAtIso: new Date().toISOString(),
  };

  if (actorUid) {
    payload.updatedByUid = actorUid;
  }

  return payload;
}
