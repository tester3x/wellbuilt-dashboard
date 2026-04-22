import type { ActivityRef, SourceRef } from './types';
import type { ActivityCanonicalView } from './types.canonical';

type Conf = 'strong' | 'medium' | 'weak';
const CONF_RANK = { weak: 0, medium: 1, strong: 2 } as const;

function bumpConfidence(a: Conf, b: Conf): Conf {
  const max = Math.max(CONF_RANK[a], CONF_RANK[b]);
  if (max === 2) return 'strong';
  if (max === 1) return 'medium';
  return 'weak';
}

export function resolveCanonicalActivity(
  refs: ActivityRef[]
): ActivityCanonicalView[] {
  const groups = new Map<string, ActivityRef[]>();
  for (const r of refs) {
    const arr = groups.get(r.activityKey) ?? [];
    arr.push(r);
    groups.set(r.activityKey, arr);
  }

  const views: ActivityCanonicalView[] = [];
  for (const [canonicalActivityKey, members] of groups.entries()) {
    let canonicalLabel: string | undefined;
    let family: ActivityRef['family'] | undefined;
    let confidence: Conf = 'weak';
    const rawLabels: ActivityRef['rawLabels'] = [];
    const sourceRefs: SourceRef[] = [];

    for (const r of members) {
      canonicalLabel = canonicalLabel ?? r.canonicalLabel;
      if (!family || family === 'unknown') family = r.family;
      confidence = bumpConfidence(confidence, r.confidence ?? 'weak');
      const seen = new Set(
        rawLabels.map((l) => `${l.value}|${l.field}|${l.system ?? ''}`)
      );
      for (const l of r.rawLabels) {
        const k = `${l.value}|${l.field}|${l.system ?? ''}`;
        if (!seen.has(k)) rawLabels.push(l);
      }
      sourceRefs.push(...r.sourceRefs);
    }

    const linkedKeys = [canonicalActivityKey];
    const mergedFrom: string[] = [];

    const view: ActivityCanonicalView = {
      canonicalActivityKey,
      canonicalLabel: canonicalLabel ?? canonicalActivityKey,
      rawLabels,
      linkedKeys,
      mergedFrom,
      confidence,
      sourceRefs,
    };
    if (family !== undefined) view.family = family;
    views.push(view);
  }

  return views.sort((a, b) =>
    a.canonicalActivityKey.localeCompare(b.canonicalActivityKey)
  );
}
