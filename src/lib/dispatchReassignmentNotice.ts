type Job = { wellName?: string; ndicWellName?: string; driverName?: string; driverFirstName?: string; status?: string; driverStage?: string; source?: string; assignedBy?: string };

export function isDriverBuiltDispatch(job: Job): boolean {
  const assignedBy = job.assignedBy?.trim() || '';
  return job.source?.trim() === 'driver' || assignedBy === 'driver' || assignedBy.startsWith('driver:');
}

export function reassignmentBlockedReason(job: Job | null): string | null {
  if (!job) return 'This dispatch is no longer available. Refresh Dispatch before trying again.';
  const well = job.ndicWellName || job.wellName || 'This job';
  const driver = job.driverName || job.driverFirstName || 'The assigned driver';
  if (isDriverBuiltDispatch(job)) {
    return `${well} was built by ${driver}. The job builder owns this job, so Dispatch cannot reassign it, even while it is queued. Ask the builder to manage it in WB T or use the load-transfer workflow when appropriate.`;
  }
  if (job.status === 'in_progress' || job.status === 'paused') {
    const stages: Record<string, string> = {
      en_route_pickup: 'en route to pickup', on_site_pickup: 'at pickup',
      en_route_dropoff: 'en route to drop-off', on_site_dropoff: 'at drop-off',
    };
    const stage = stages[job.driverStage || ''] || (job.status === 'paused' ? 'paused' : 'in progress');
    return `${well} cannot be reassigned because ${driver} has already started it (${stage}). For an empty job, have the driver cancel or return it to the queue in WB T first. For a loaded job, use Load Transfer.`;
  }
  if (job.status === 'completed' || job.status === 'dismissed') {
    return `${well} is already ${job.status}. Refresh Dispatch and create a new assignment if more work is needed.`;
  }
  if (!['pending', 'accepted', 'declined', 'cancelled'].includes(job.status || '')) {
    return `${well} cannot be reassigned in its current state. Refresh Dispatch and review its status first.`;
  }
  return null;
}

export function reassignmentFailureMessage(error: unknown): string {
  const code = String((error as { code?: unknown })?.code || '');
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  if (message.includes('driver_built_job_owned_by_builder')) return 'Dispatch cannot reassign a driver-built job. The original job builder owns it, including while it is queued. Ask the builder to manage it in WB T.';
  if (/permission-denied|unauthenticated/.test(code)) return 'Reassignment was not confirmed. Your account could not authorize this change. Sign in again or contact your administrator.';
  if (/unavailable|deadline-exceeded/.test(code)) return 'Reassignment was not confirmed by the server. Check your connection and retry; your selection is still here.';
  if (/invalid_transition/.test(message)) return 'The job changed state while you were reassigning it. Refresh Dispatch and check whether the driver has started it. An empty started job must be cancelled or returned to the queue first; a loaded job needs Load Transfer.';
  return `Reassignment was not confirmed. ${message.replace(/^FirebaseError:\s*/i, '')}`;
}
