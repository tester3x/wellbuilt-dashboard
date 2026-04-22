import type { ActivityRef, SourceRef, SourceSystem } from './types';

const CODE_TO_LABEL: Record<string, string> = {
  pw: 'Production Water',
  'production water': 'Production Water',
  'prod water': 'Production Water',
  service: 'Service Work',
  'service work': 'Service Work',
  sw: 'Service Work',
  pull: 'Production Water',
  pulls: 'Production Water',
  transfer: 'Transfer',
  aggregate: 'Aggregate',
  oil: 'Oil',
  'fresh water': 'Fresh Water',
  'water hauling': 'Water Hauling',
};

const LABEL_FAMILY: Record<string, ActivityRef['family']> = {
  'production water': 'transport',
  'fresh water': 'transport',
  'water hauling': 'transport',
  'service work': 'service',
  transfer: 'transport',
  aggregate: 'transport',
  oil: 'transport',
};

export function toCanonicalActivityLabel(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (CODE_TO_LABEL[lower]) return CODE_TO_LABEL[lower];
  return trimmed
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

export interface ActivityResolveInput {
  perWellJobType?: string;
  jobActivityName?: string;
  task?: string;
  jsaType?: string;
  jobType?: string;
  serviceType?: string;
  commodityType?: string;
  sourceRef?: SourceRef;
  sourceSystem?: SourceSystem;
}

export function resolveActivityRef(
  input: ActivityResolveInput
): ActivityRef | null {
  const candidates: Array<{ value: string; field: string }> = [];
  const push = (value: unknown, field: string) => {
    if (typeof value === 'string' && value.trim()) {
      candidates.push({ value: value.trim(), field });
    }
  };

  push(input.perWellJobType, 'wells[].jobType');
  push(input.jobActivityName, 'jobActivityName');
  push(input.task, 'task');
  push(input.jsaType, 'jsaType');
  push(input.jobType, 'jobType');
  push(input.serviceType, 'serviceType');
  push(input.commodityType, 'commodityType');

  if (candidates.length === 0) return null;

  const primary = candidates[0];
  const canonicalLabel = toCanonicalActivityLabel(primary.value);
  if (!canonicalLabel) return null;

  const rawLabels = candidates.map((c) => {
    const label: ActivityRef['rawLabels'][number] = { value: c.value, field: c.field };
    if (input.sourceSystem !== undefined) label.system = input.sourceSystem;
    return label;
  });

  const distinct = new Set(
    candidates.map((c) => toCanonicalActivityLabel(c.value).toLowerCase())
  );
  const confidence: ActivityRef['confidence'] =
    distinct.size === 1 && candidates.length >= 2
      ? 'strong'
      : distinct.size === 1
      ? 'medium'
      : 'weak';

  const ref: ActivityRef = {
    activityKey: `act:${canonicalLabel.toLowerCase()}`,
    canonicalLabel,
    family: LABEL_FAMILY[canonicalLabel.toLowerCase()] ?? 'unknown',
    rawLabels,
    sourceRefs: input.sourceRef ? [input.sourceRef] : [],
    confidence,
  };
  return ref;
}

export function mergeActivityRefs(refs: ActivityRef[]): ActivityRef[] {
  const byKey = new Map<string, ActivityRef>();
  for (const r of refs) {
    const existing = byKey.get(r.activityKey);
    if (!existing) {
      byKey.set(r.activityKey, {
        ...r,
        rawLabels: [...r.rawLabels],
        sourceRefs: [...r.sourceRefs],
      });
      continue;
    }
    const seen = new Set(
      existing.rawLabels.map((l) => `${l.value}|${l.field}|${l.system ?? ''}`)
    );
    const newLabels = r.rawLabels.filter(
      (l) => !seen.has(`${l.value}|${l.field}|${l.system ?? ''}`)
    );
    const merged: ActivityRef = {
      ...existing,
      rawLabels: [...existing.rawLabels, ...newLabels],
      sourceRefs: [...existing.sourceRefs, ...r.sourceRefs],
    };
    byKey.set(r.activityKey, merged);
  }
  return Array.from(byKey.values()).sort((a, b) =>
    a.activityKey.localeCompare(b.activityKey)
  );
}
