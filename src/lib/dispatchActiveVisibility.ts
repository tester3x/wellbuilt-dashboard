/** Rejected work stays in the review tab until Dispatch reassigns or dismisses it. */
export function isCancelledDispatchCard(job: { status: string; reassignedTo?: string | null }): boolean {
  return job.status === 'declined'
    || (job.status === 'cancelled' && !job.reassignedTo?.trim());
}
export function isActiveDispatchCard(job: { status: string; reassignedTo?: string | null }): boolean {
  return job.status !== 'completed' && job.status !== 'dismissed'
    && !isCancelledDispatchCard(job)
    && !(job.status === 'cancelled' && !!job.reassignedTo?.trim());
}
