/** Terminal/rejected work stays one click away in the cancellation tab. */
export function isCancelledDispatchCard(job: { status: string }): boolean {
  return ['cancelled', 'declined', 'dismissed'].includes(job.status);
}
export function isActiveDispatchCard(job: { status: string; reassignedTo?: string | null }): boolean {
  return job.status !== 'completed' && !isCancelledDispatchCard(job);
}
