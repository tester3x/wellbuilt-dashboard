/** Task assignments are metadata; uploaded assessment wording is never rewritten. */
export function normalizeJsaTasks(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(v => String(v).trim().toLowerCase()).filter(Boolean))].sort();
}

export interface ActiveJsaTaskTemplate {
  id: string;
  name: string;
  version: number;
  packageId: string | null;
  tasks: string[];
}

export function assignActiveJsaTemplate(
  current: ActiveJsaTaskTemplate[], next: ActiveJsaTaskTemplate,
): ActiveJsaTaskTemplate[] {
  const tasks = normalizeJsaTasks(next.tasks);
  for (const other of current.filter(t => t.id !== next.id)) {
    if ((other.packageId || null) !== (next.packageId || null)) continue;
    const otherTasks = normalizeJsaTasks(other.tasks);
    if ((!tasks.length && !otherTasks.length) || tasks.some(t => otherTasks.includes(t))) {
      throw new Error(`Task assignment conflicts with “${other.name}”. Deactivate it or change its tasks first.`);
    }
  }
  return [...current.filter(t => t.id !== next.id), {...next, tasks}];
}
