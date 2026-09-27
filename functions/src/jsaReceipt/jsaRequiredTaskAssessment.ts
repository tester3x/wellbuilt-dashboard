import { createHash } from 'crypto';
import { readJsaTaskCatalog, selectJsaTaskTemplates } from './jsaTaskCatalog';

type Catalog = Awaited<ReturnType<typeof readJsaTaskCatalog>>;

/** Server-resolved job requirements, never a client-supplied completion claim. */
export interface RequiredJobTasks {
  tasks: string[];
  packageId: string | null;
}

const taskKey = (value: unknown): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error('Invalid required task');
  return value.trim().toLowerCase();
};

/** Resolve exact task assignments within one operator/package. No fuzzy matching
 * or cross-package fallback: a missing/ambiguous assessment requires repair.
 * Call only after obtaining requirements from the authoritative job source.
 */
export function resolveRequiredTaskAssessment(catalog: Catalog, requirements: RequiredJobTasks) {
  if (catalog.schemaVersion !== 2) throw new Error('Task catalog required');
  if (!Array.isArray(requirements.tasks) || !requirements.tasks.length || requirements.tasks.length > 20) throw new Error('Required tasks unavailable');
  if (requirements.packageId !== null && (typeof requirements.packageId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(requirements.packageId))) throw new Error('Invalid task package');
  const tasks = [...new Set(requirements.tasks.map(taskKey))].sort();
  const candidates = catalog.templates.filter(t => t.packageId === requirements.packageId);
  const defaults = candidates.filter(t => t.tasks.length === 0);
  const selected = new Map<string, Catalog['templates'][number]>();
  for (const task of tasks) {
    const exact = candidates.filter(t => t.tasks.map(taskKey).includes(task));
    const matches = exact.length ? exact : defaults;
    if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous required assessment' : 'Required assessment unavailable');
    selected.set(matches[0].id, matches[0]);
  }
  const assessment = selectJsaTaskTemplates(catalog, [...selected.values()].map(({id, version, contentHash}) => ({id, version, contentHash})));
  const binding = {
    schemaVersion: 1 as const,
    packageId: requirements.packageId,
    tasks,
    templateRefs: assessment.templates.map(({id, version, contentHash}) => ({id, version, contentHash})),
  };
  return {...binding, assessmentHash: createHash('sha256').update(JSON.stringify(binding)).digest('hex'), assessment};
}
