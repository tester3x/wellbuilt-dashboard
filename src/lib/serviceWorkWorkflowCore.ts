/**
 * Core Service Work workflow identity and orchestration.
 *
 * Provides stable workflow identity that survives:
 * - component rerenders
 * - repeated handler submissions
 * - transport network uncertainty
 * - partial batch success
 * - validation corrections followed by retry
 * - button re-enable
 *
 * Retains actionId, serviceGroupId, splitGroupId, and unit identities until the
 * entire workflow succeeds AND UI completion is confirmed, or the user cancels.
 */

import {
  DispatchCreationCoordinator,
  mintDispatchId,
} from './staffWriteDispatchCore.ts';
import type { CallableInvoker } from './staffWriteDispatchCore.ts';
import { assignmentIdentityForDriver } from './dispatchWriterIdentity.ts';
import type { DriverIdentity } from './dispatchDriverIdentity.ts';

export interface ServiceWorkWorkflowState {
  workflowId: string;
  actionId: string;
  serviceGroupId?: string;
  splitGroupId?: string;
  createdAt: number;
}

export interface ServiceWorkDriverInput extends DriverIdentity {
  key: string;
  companyId?: string;
}

export interface ExtraSplitLegInput {
  id?: string;
  disposal: string;
  bbls?: string | number;
  notes?: string;
}

export interface ExecuteServiceWorkInput {
  workflow: ServiceWorkWorkflowState;
  coordinator: DispatchCreationCoordinator;
  invoke: CallableInvoker;
  selectedDrivers: ServiceWorkDriverInput[];
  wellName: string;
  ndicWellName: string;
  serviceType: string;
  packageId?: string;
  dropoff?: string;
  onsiteBy?: string;
  notes?: string;
  isSplitTicket?: boolean;
  isHeavyWater?: boolean;
  extraSplitLegs?: ExtraSplitLegInput[];
  assignedBy: string;
  userEmail?: string;
  tenantId?: string;
  userId?: string;
  onUiComplete?: () => Promise<void> | void;
}

export interface ExecuteServiceWorkResult {
  actionId: string;
  serviceGroupId?: string;
  splitGroupId?: string;
  dispatches: Array<{ dispatchId: string; unitId: string }>;
}

/**
 * Creates a stable Service Work workflow identity object when the user enters or resets
 * the service-work workflow.
 */
export function createServiceWorkWorkflow(initial?: Partial<ServiceWorkWorkflowState>): ServiceWorkWorkflowState {
  const workflowId = initial?.workflowId || `sw_${mintDispatchId()}`;
  const actionId = initial?.actionId || `act_${workflowId}`;
  return {
    workflowId,
    actionId,
    serviceGroupId: initial?.serviceGroupId,
    splitGroupId: initial?.splitGroupId,
    createdAt: initial?.createdAt || Date.now(),
  };
}

/**
 * Ensures group IDs are allocated once and retained across retries for this workflow.
 */
export function ensureServiceWorkGroupIds(
  workflow: ServiceWorkWorkflowState,
  hasMultipleDrivers: boolean,
  isSplit: boolean
): void {
  if (hasMultipleDrivers && !workflow.serviceGroupId) {
    workflow.serviceGroupId = `sg_${mintDispatchId()}`;
  }
  if (isSplit && !workflow.splitGroupId) {
    workflow.splitGroupId = `split_${mintDispatchId()}`;
  }
}

/**
 * Executes a service-work batch creation with stable workflow identity.
 */
export async function executeServiceWorkWorkflow(
  input: ExecuteServiceWorkInput
): Promise<ExecuteServiceWorkResult> {
  const {
    workflow,
    coordinator,
    invoke,
    selectedDrivers,
    wellName,
    ndicWellName,
    serviceType,
    packageId,
    dropoff,
    onsiteBy,
    notes,
    isSplitTicket,
    isHeavyWater,
    extraSplitLegs,
    assignedBy,
    userEmail,
    tenantId,
    userId,
    onUiComplete,
  } = input;

  if (!wellName.trim()) throw new Error('well_name_required');
  if (!serviceType.trim()) throw new Error('service_type_required');
  if (selectedDrivers.length === 0) throw new Error('no_drivers_selected');

  // Allocate group IDs once per workflow; retain across all retries
  ensureServiceWorkGroupIds(workflow, selectedDrivers.length > 1, !!isSplitTicket);

  const getFirstName = (d: ServiceWorkDriverInput) => {
    if (d.legalName) return d.legalName.split(' ')[0];
    return d.displayName || d.key;
  };
  const assignedDrivers = selectedDrivers.length > 1 ? selectedDrivers.map(getFirstName) : undefined;
  const splitTotal = isSplitTicket ? 2 + (extraSplitLegs?.length || 0) : undefined;

  coordinator.beginAction({
    actionId: workflow.actionId,
    actionScope: 'service-work-modal',
    tenantId,
    userId,
  });

  const dispatches: Array<{ dispatchId: string; unitId: string }> = [];

  const driverPromises = selectedDrivers.map(async driver => {
    const baseJob: Record<string, unknown> = {
      ...assignmentIdentityForDriver(driver),
      ...(driver.legalName ? { driverFirstName: getFirstName(driver) } : {}),
      wellName: wellName.trim(),
      ndicWellName: ndicWellName.trim() || wellName.trim(),
      ...(dropoff?.trim() ? { disposal: dropoff.trim() } : {}),
      ...(onsiteBy ? { onsiteBy } : {}),
      jobType: 'service',
      serviceType: serviceType.trim(),
      ...(packageId ? { packageId } : {}),
      status: 'pending',
      notes: notes || '',
      priority: 5,
      assignedAt: new Date().toISOString(),
      assignedBy: userEmail || assignedBy || 'dashboard',
      ...(workflow.serviceGroupId ? { serviceGroupId: workflow.serviceGroupId } : {}),
      ...(assignedDrivers ? { assignedDrivers } : {}),
      ...(isHeavyWater ? { isHeavyWater: true } : {}),
      ...(workflow.splitGroupId ? { splitGroupId: workflow.splitGroupId, splitSequence: 1, ...(splitTotal != null ? { splitTotal } : {}) } : {}),
    };

    const unit1Id = `${driver.key}::leg1`;
    const res1 = await coordinator.executeUnit(invoke, baseJob, {
      actionId: workflow.actionId,
      actionScope: 'service-work-modal',
      unitId: unit1Id,
    });
    dispatches.push({ dispatchId: res1.dispatchId, unitId: unit1Id });

    if (isSplitTicket && dropoff?.trim()) {
      const job2: Record<string, unknown> = {
        ...baseJob,
        wellName: dropoff.trim(),
        ndicWellName: dropoff.trim(),
        disposal: dropoff.trim(),
        notes: `Split ticket B — ${notes || serviceType.trim()}`,
        splitGroupId: workflow.splitGroupId!,
        splitSequence: 2,
        ...(splitTotal != null ? { splitTotal } : {}),
      };
      const unit2Id = `${driver.key}::leg2`;
      const res2 = await coordinator.executeUnit(invoke, job2, {
        actionId: workflow.actionId,
        actionScope: 'service-work-modal',
        unitId: unit2Id,
      });
      dispatches.push({ dispatchId: res2.dispatchId, unitId: unit2Id });
    }

    if (isSplitTicket && extraSplitLegs && extraSplitLegs.length > 0) {
      for (let idx = 0; idx < extraSplitLegs.length; idx++) {
        const extra = extraSplitLegs[idx];
        const letter = String.fromCharCode(67 + idx);
        const bblsNum = extra.bbls ? (typeof extra.bbls === 'number' ? extra.bbls : parseFloat(String(extra.bbls))) : NaN;
        const extraJob: Record<string, unknown> = {
          ...baseJob,
          wellName: extra.disposal.trim(),
          ndicWellName: extra.disposal.trim(),
          disposal: extra.disposal.trim(),
          notes: extra.notes
            ? `Split ticket ${letter} — ${extra.notes}`
            : `Split ticket ${letter} — ${serviceType.trim()}`,
          splitGroupId: workflow.splitGroupId!,
          splitSequence: 3 + idx,
          ...(splitTotal != null ? { splitTotal } : {}),
          ...(isFinite(bblsNum) && bblsNum > 0 ? { bbls: bblsNum } : {}),
        };
        const extraUnitId = `${driver.key}::leg${3 + idx}`;
        const resExtra = await coordinator.executeUnit(invoke, extraJob, {
          actionId: workflow.actionId,
          actionScope: 'service-work-modal',
          unitId: extraUnitId,
        });
        dispatches.push({ dispatchId: resExtra.dispatchId, unitId: extraUnitId });
      }
    }
  });

  // Await all units
  await Promise.all(driverPromises);

  // Success Retention & UI Completion:
  // Only when downstream UI completion is confirmed do we finalize the coordinator action.
  if (onUiComplete) {
    await onUiComplete();
  }

  coordinator.finalizeAction(workflow.actionId);

  return {
    actionId: workflow.actionId,
    serviceGroupId: workflow.serviceGroupId,
    splitGroupId: workflow.splitGroupId,
    dispatches,
  };
}

/**
 * Explicitly cancels the Service Work workflow.
 * Clears ONLY this workflow's action and units from the coordinator.
 */
export function cancelServiceWorkWorkflow(
  workflow: ServiceWorkWorkflowState,
  coordinator: DispatchCreationCoordinator
): void {
  coordinator.cancelAction(workflow.actionId);
}
