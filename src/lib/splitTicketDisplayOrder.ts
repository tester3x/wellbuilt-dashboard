/** Keep linked Service Work tickets together in their work sequence.
 * The input is already sorted by physical priority; unrelated jobs retain that order.
 * Current work stays above queued split siblings, even when a later ticket is active.
 */
export function orderSplitTicketChains<T extends {
  jobType: string;
  splitGroupId?: string;
  splitSequence?: number;
}>(jobs: readonly T[], isCurrent: (job: T) => boolean = () => false): T[] {
  const current = new Set(jobs.filter(isCurrent));
  const waiting = jobs.filter(job => !current.has(job));
  const chains = new Map<string, T[]>();
  for (const job of waiting) {
    if (job.jobType !== 'service' || !job.splitGroupId) continue;
    const chain = chains.get(job.splitGroupId) || [];
    chain.push(job);
    chains.set(job.splitGroupId, chain);
  }

  const emitted = new Set<string>();
  const ordered: T[] = [...current];
  for (const job of waiting) {
    const groupId = job.jobType === 'service' ? job.splitGroupId : undefined;
    if (!groupId || (chains.get(groupId)?.length || 0) < 2) {
      ordered.push(job);
      continue;
    }
    if (emitted.has(groupId)) continue;
    emitted.add(groupId);
    ordered.push(...chains.get(groupId)!.sort((a, b) => {
      const sequence = (n: number | undefined) => Number.isInteger(n) && n! > 0 ? n! : Number.POSITIVE_INFINITY;
      return sequence(a.splitSequence) - sequence(b.splitSequence);
    }));
  }
  return ordered;
}
