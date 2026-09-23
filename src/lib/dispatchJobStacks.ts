/** Display-only stacks for the Dashboard's per-driver Active Jobs list.
 * Every dispatch stays addressable by its own id and retains its own controls.
 */
export interface StackableDispatch {
  id?: string;
  companyId?: string;
  driverHash: string;
  driverName: string;
  wellName: string;
  ndicWellName?: string;
  jobType: string;
  status: string;
  assignedBy?: string;
  source?: string;
  type?: string;
  loadCount?: number;
  loadsCompleted?: number;
  driverStage?: string;
  splitGroupId?: string;
  serviceGroupId?: string;
  projectId?: string;
  operator?: string;
  route?: string;
  serviceType?: string;
  packageId?: string;
  notes?: string;
  priority?: number;
  estimatedPullTime?: string;
  currentLevel?: string;
  flowRate?: string;
  disposal?: string;
  disposalName?: string;
  disposalLat?: number;
  disposalLng?: number;
  disposalApiNo?: string;
  disposalLegalDesc?: string;
  disposalCounty?: string;
  hauledTo?: string;
  onsiteBy?: string;
  driverDest?: string;
  invoiceNumber?: string;
  ticketNumber?: string;
  invoiceDocId?: string;
  bbls?: number;
  isHeavyWater?: boolean;
}

export interface DispatchRowGroup<T extends StackableDispatch> {
  key: string;
  jobs: T[];
  remainingLoads: number;
}

/** Only fields describing the job itself. Document IDs and timestamps are unique
 * per dispatch; time-sensitive ages stay visible on the expanded original rows.
 */
const identityFields = [
  'companyId', 'driverHash', 'driverName', 'wellName', 'ndicWellName',
  'jobType', 'status', 'assignedBy', 'source', 'type', 'operator', 'route',
  'serviceType', 'packageId', 'notes', 'priority', 'estimatedPullTime',
  'currentLevel', 'flowRate', 'disposal', 'disposalName', 'disposalLat',
  'disposalLng', 'disposalApiNo', 'disposalLegalDesc', 'disposalCounty',
  'hauledTo', 'onsiteBy', 'driverDest', 'invoiceNumber', 'ticketNumber',
  'invoiceDocId', 'bbls', 'isHeavyWater', 'loadCount',
] as const;

function remaining(job: StackableDispatch): number {
  const count = Number.isFinite(job.loadCount) && (job.loadCount ?? 0) > 0 ? job.loadCount! : 1;
  return Math.max(0, count - (job.loadsCompleted || 0));
}

function stackKey(job: StackableDispatch): string | null {
  if (!job.id || job.jobType !== 'pw' || !['pending', 'accepted'].includes(job.status)
    || job.driverStage || job.type === 'transfer' || job.splitGroupId
    || job.serviceGroupId || job.projectId || (job.loadsCompleted || 0) > 0) return null;
  if (!job.wellName || !(job.assignedBy || (job.source === 'driver' && job.driverHash))) return null;
  return JSON.stringify(identityFields.map(field => job[field] ?? null));
}

/** A visual grouping only: each result retains every original dispatch object. */
export function groupDispatchRows<T extends StackableDispatch>(jobs: readonly T[]): DispatchRowGroup<T>[] {
  const rows: DispatchRowGroup<T>[] = [];
  const stacks = new Map<string, DispatchRowGroup<T>>();
  jobs.forEach((job, index) => {
    const identity = stackKey(job);
    if (identity === null) {
      rows.push({ key: `single:${job.id || index}`, jobs: [job], remainingLoads: remaining(job) });
      return;
    }
    let row = stacks.get(identity);
    if (!row) {
      row = { key: `stack:${job.id}`, jobs: [], remainingLoads: 0 };
      stacks.set(identity, row);
      rows.push(row);
    }
    row.jobs.push(job);
    row.remainingLoads += remaining(job);
  });
  return rows;
}
