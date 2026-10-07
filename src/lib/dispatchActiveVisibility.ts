/** Reassigned cancellations are history; driver rejections still need dispatch action. */
export function isActiveDispatchCard(job: { status: string; reassignedTo?: string | null }): boolean {
  return job.status !== 'completed' && job.status !== 'dismissed'
    && !(job.status === 'cancelled' && !!job.reassignedTo?.trim());
}
