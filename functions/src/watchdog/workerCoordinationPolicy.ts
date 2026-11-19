export const workerLeaseMs = 90_000;
export const backupGraceMs = 120_000;

export function workerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{3,64}$/.test(value)) throw Error('invalid_worker_id');
  return value;
}

// Server time and server-assigned roles; a backup cannot promote itself.
export function claimDecision(input: {
  now: number; role: 'main' | 'backup'; workerId: string;
  previous?: {firstSeenAt: number; owner?: string; leaseUntil?: number};
}) {
  const firstSeenAt = input.previous?.firstSeenAt ?? input.now;
  if (input.previous?.leaseUntil && input.previous.leaseUntil > input.now && input.previous.owner !== input.workerId)
    return {granted: false, reason: 'other_worker_active', firstSeenAt};
  if (input.role === 'backup' && input.now - firstSeenAt < backupGraceMs)
    return {granted: false, reason: 'main_grace_period', firstSeenAt};
  return {granted: true, reason: input.role === 'backup' ? 'backup_takeover' : 'main', firstSeenAt};
}
