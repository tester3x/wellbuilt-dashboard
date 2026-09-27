import type {
  CustomJobType,
  CustomJobTypeFamily,
  CustomJobTypePayBasis,
  CustomJobTypeLifecycle,
} from './companySettings';

export const CANONICAL_BUILTIN_JOB_TYPE_IDS: readonly string[] = Object.freeze([
  'pw',
  'service-work',
  'fresh-water',
  'flowback-water',
]);

export const ALLOWED_FAMILIES: readonly CustomJobTypeFamily[] = Object.freeze([
  'pw',
  'service-work',
]);

export const ALLOWED_PAY_BASES: readonly CustomJobTypePayBasis[] = Object.freeze([
  'per_bbl',
  'hourly',
]);

export const ALLOWED_LIFECYCLES: readonly CustomJobTypeLifecycle[] = Object.freeze([
  'pickup_dropoff',
  'onsite_only',
]);

/** Convert a display label to a canonical kebab-case ID slug. */
export function slugifyCustomJobType(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s_]+/g, '-');
}

/** Determine conservative capability grants based strictly on lifecycle shape. */
export function defaultCapabilitiesForLifecycle(
  lifecycle: CustomJobTypeLifecycle,
): string[] {
  switch (lifecycle) {
    case 'onsite_only':
      return ['lifecycle'];
    case 'pickup_dropoff':
    default:
      return ['lifecycle', 'pickup'];
  }
}

export interface NewCustomJobTypeInput {
  label: string;
  baseJobTypeId: string;
  payBasis: string;
  lifecycleShape: string;
  packages: string[];
}

export type CustomJobTypeValidationResult =
  | { ok: true; value: CustomJobType }
  | { ok: false; reason: string; error: string; field: keyof NewCustomJobTypeInput | 'id' };

/**
 * Validate a new custom job type input against all governance constraints.
 * Fails closed if any of the 5 required fields is missing, invalid, or collides.
 */
export function validateNewCustomJobType(
  input: Partial<NewCustomJobTypeInput>,
  existingCustomTypes: CustomJobType[] = [],
  forbiddenIds: readonly string[] = CANONICAL_BUILTIN_JOB_TYPE_IDS,
): CustomJobTypeValidationResult {
  // 1. Label
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) {
    return { ok: false, reason: 'label_required', error: 'Job type name is required.', field: 'label' };
  }
  if (label.length > 50) {
    return { ok: false, reason: 'label_too_long', error: 'Job type name cannot exceed 50 characters.', field: 'label' };
  }

  // Duplicate label check (case-insensitive)
  if (existingCustomTypes.some(t => t.label.trim().toLowerCase() === label.toLowerCase())) {
    return { ok: false, reason: 'duplicate_label', error: `A custom job type named "${label}" already exists.`, field: 'label' };
  }

  // 2. Slug & collision check
  const slug = slugifyCustomJobType(label);
  if (!slug) {
    return { ok: false, reason: 'invalid_slug', error: 'Job type name must contain alphanumeric characters.', field: 'label' };
  }
  if (forbiddenIds.includes(slug)) {
    return {
      ok: false,
      reason: 'canonical_collision',
      error: `Cannot use "${label}": matches built-in system job type "${slug}".`,
      field: 'id',
    };
  }
  if (existingCustomTypes.some(t => (t.id || slugifyCustomJobType(t.label)) === slug)) {
    return { ok: false, reason: 'duplicate_slug', error: `A job type with ID "${slug}" already exists.`, field: 'id' };
  }

  // 3. Family
  const family = input.baseJobTypeId as CustomJobTypeFamily;
  if (!family || !ALLOWED_FAMILIES.includes(family)) {
    return { ok: false, reason: 'family_required', error: 'Governed family is required (Production Water or Service Work).', field: 'baseJobTypeId' };
  }

  // 4. Pay Basis
  const payBasis = input.payBasis as CustomJobTypePayBasis;
  if (!payBasis || !ALLOWED_PAY_BASES.includes(payBasis)) {
    return { ok: false, reason: 'pay_basis_required', error: 'Pay basis is required (Per BBL or Hourly).', field: 'payBasis' };
  }

  // 5. Lifecycle
  const lifecycleShape = input.lifecycleShape as CustomJobTypeLifecycle;
  if (!lifecycleShape || !ALLOWED_LIFECYCLES.includes(lifecycleShape)) {
    return { ok: false, reason: 'lifecycle_required', error: 'Lifecycle is required (Pickup -> Drop-off or On Site only).', field: 'lifecycleShape' };
  }

  // 6. Packages
  const packages = Array.isArray(input.packages) ? input.packages.filter(Boolean) : [];
  if (packages.length === 0) {
    return { ok: false, reason: 'package_required', error: 'At least one package must be selected.', field: 'packages' };
  }

  const capabilities = defaultCapabilitiesForLifecycle(lifecycleShape);

  return {
    ok: true,
    value: {
      id: slug,
      label,
      packages,
      baseJobTypeId: family,
      payBasis,
      lifecycleShape,
      capabilities,
    },
  };
}

/** Normalize legacy/existing custom job types into full CustomJobType objects */
export function normalizeCustomJobType(raw: unknown): CustomJobType | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const label = raw.trim();
    if (!label) return null;
    return {
      id: slugifyCustomJobType(label),
      label,
      packages: [],
      baseJobTypeId: 'service-work',
      lifecycleShape: 'pickup_dropoff',
      capabilities: ['lifecycle', 'pickup'],
      payBasis: undefined,
    };
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    const label = typeof rec.label === 'string' ? rec.label.trim() : '';
    if (!label) return null;
    const slug = typeof rec.id === 'string' && rec.id.trim()
      ? rec.id.trim()
      : slugifyCustomJobType(label);
    const packages = Array.isArray(rec.packages)
      ? (rec.packages as unknown[]).map(p => String(p).trim()).filter(Boolean)
      : [];
    const baseJobTypeId = rec.baseJobTypeId === 'pw' ? 'pw' : 'service-work';
    const lifecycleShape = rec.lifecycleShape === 'onsite_only' ? 'onsite_only' : 'pickup_dropoff';
    const payBasis = rec.payBasis === 'per_bbl' || rec.payBasis === 'hourly'
      ? (rec.payBasis as CustomJobTypePayBasis)
      : undefined;
    const capabilities = Array.isArray(rec.capabilities) && rec.capabilities.length > 0
      ? (rec.capabilities as unknown[]).map(c => String(c).trim()).filter(Boolean)
      : defaultCapabilitiesForLifecycle(lifecycleShape);

    return {
      id: slug,
      label,
      packages,
      baseJobTypeId,
      payBasis,
      lifecycleShape,
      capabilities,
    };
  }
  return null;
}
