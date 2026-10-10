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
  splitFamilyIds?: Record<string, string>;
  createdAt: number;
}

export interface ServiceWorkDriverInput extends DriverIdentity {
  key: string;
  companyId?: string;
}

export interface ExtraSplitLegInput {
  id?: string;
  disposal: string;
  bbls?: string | number; // Planned delivery at this stop, not load entering it.
  notes?: string;
}

export interface SplitLoadPlanInput {
  id: string;
  wellName: string;
  ndicWellName?: string;
  pickupBbls?: string | number;
  loadCount: number;
  dropoff: string;
  splitBBbls?: string | number;
  splitBNotes?: string;
  extraSplitLegs?: ExtraSplitLegInput[];
}

export interface ExecuteServiceWorkInput {
  workflow: ServiceWorkWorkflowState;
  coordinator: DispatchCreationCoordinator;
  invoke: CallableInvoker;
  selectedDrivers: ServiceWorkDriverInput[];
  wellName: string;
  ndicWellName: string;
  operator?: string;
  serviceType: string;
  packageId?: string;
  dropoff?: string;
  splitABbls?: string | number; // Total load picked up on A.
  splitBBbls?: string | number; // Planned delivery at B.
  splitBNotes?: string;
  splitLoadCount?: number;
  splitLoadPlans?: SplitLoadPlanInput[];
  projectId?: string;
  onsiteBy?: string;
  notes?: string;
  isSplitTicket?: boolean;
  isHeavyWater?: boolean;
  extraSplitLegs?: ExtraSplitLegInput[];
  assignedBy: string;
  userEmail?: string;
  tenantId?: string;
  userId?: string;
  customJobTypes?: unknown[];
  onUiComplete?: () => Promise<void> | void;
}

export interface ExecuteServiceWorkResult {
  actionId: string;
  serviceGroupId?: string;
  splitGroupId?: string;
  dispatches: Array<{ dispatchId: string; unitId: string }>;
}

export function evaluateSplitBblPlan(
  pickupRaw: string | number | undefined,
  deliveryRaws: Array<string | number | undefined>,
): { pickupBbls?: number; deliveryBbls: Array<number | undefined>; plannedTotal: number; unallocatedBbls?: number; warning?: 'missing_pickup' | 'exceeds_pickup' } {
  const parse = (raw: string | number | undefined): number | undefined => {
    if (raw == null || String(raw).trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error('split_bbls_invalid');
    return value;
  };
  const pickupBbls = parse(pickupRaw);
  const deliveryBbls = deliveryRaws.map(parse);
  const plannedTotal = deliveryBbls.reduce<number>((sum, value) => sum + (value || 0), 0);
  return {
    pickupBbls,
    deliveryBbls,
    plannedTotal,
    unallocatedBbls: pickupBbls == null ? undefined : Math.max(0, Math.round((pickupBbls - plannedTotal) * 100) / 100),
    warning: pickupBbls == null && plannedTotal > 0 ? 'missing_pickup'
      : pickupBbls != null && plannedTotal > pickupBbls + 1e-9 ? 'exceeds_pickup'
      : undefined,
  };
}

/**
 * Canonical jobTypeId mapping for water-hauling packet revision 4.
 * Resolves human-readable labels, legacy tokens, or slugs:
 * Built-in global types:
 * - 'pw'
 * - 'service-work'
 * - 'fresh-water'
 * - 'flowback-water'
 * Custom job types (e.g. 'ground-water') slugify to their canonical identifier.
 */
export function canonicalJobTypeIdForServiceType(
  rawType: string | null | undefined,
  companyCustomJobTypes?: unknown[],
): string {
  const trimmed = (rawType || '').trim();
  if (!trimmed) return 'service-work';
  const norm = trimmed.toLowerCase().replace(/[\s_-]+/g, '');

  if (norm === 'pw' || norm === 'productionwater' || norm === 'producedwater') {
    return 'pw';
  }
  if (norm === 'freshwater' || norm === 'fresh' || norm === 'fw') {
    return 'fresh-water';
  }
  if (norm === 'flowbackwater' || norm === 'flowback') {
    return 'flowback-water';
  }
  if (norm === 'servicework' || norm === 'service') {
    return 'service-work';
  }
  // Check if rawType matches an approved company custom job type
  if (Array.isArray(companyCustomJobTypes) && companyCustomJobTypes.length > 0) {
    const slug = trimmed.toLowerCase().replace(/[\s_]+/g, '-');
    for (const rawEntry of companyCustomJobTypes) {
      if (!rawEntry) continue;
      const entryObj = typeof rawEntry === 'object' && !Array.isArray(rawEntry) ? (rawEntry as Record<string, unknown>) : null;
      const entryLabel = entryObj && typeof entryObj.label === 'string' ? entryObj.label.trim() : (typeof rawEntry === 'string' ? rawEntry.trim() : '');
      const entrySlug = (entryObj && typeof entryObj.id === 'string' && entryObj.id.trim())
        ? entryObj.id.trim()
        : entryLabel.toLowerCase().replace(/[\s_]+/g, '-');
      if (slug === entrySlug || trimmed.toLowerCase() === entryLabel.toLowerCase()) {
        return entrySlug;
      }
    }
  }
  // All other service work subtypes (e.g. Hot Shot, Equipment Delivery, Tank Cleanout, Rig Move, Other)
  // belong to the canonical governed 'service-work' jobTypeId.
  return 'service-work';
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
    splitFamilyIds: initial?.splitFamilyIds || {},
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
    operator,
    serviceType,
    packageId,
    dropoff,
    splitABbls,
    splitBBbls,
    splitBNotes,
    splitLoadCount = 1,
    splitLoadPlans = [],
    projectId,
    onsiteBy,
    notes,
    isSplitTicket,
    isHeavyWater,
    extraSplitLegs,
    assignedBy,
    userEmail,
    tenantId,
    userId,
    customJobTypes,
    onUiComplete,
  } = input;

  if (!wellName.trim()) throw new Error('well_name_required');
  if (!serviceType.trim()) throw new Error('service_type_required');
  if (selectedDrivers.length === 0) throw new Error('no_drivers_selected');
  if (isSplitTicket && !dropoff?.trim()) throw new Error('split_dropoff_required');
  const plans: SplitLoadPlanInput[] = isSplitTicket
    ? [{ id: 'base', wellName, ndicWellName, pickupBbls: splitABbls, loadCount: splitLoadCount,
        dropoff: dropoff || '', splitBBbls, splitBNotes, extraSplitLegs }, ...splitLoadPlans]
    : [];
  for (const plan of plans) {
    if (!plan.id.trim() || !plan.wellName.trim() || !plan.dropoff.trim()) throw new Error('split_plan_location_required');
    if (!Number.isInteger(plan.loadCount) || plan.loadCount < 1 || plan.loadCount > 20) throw new Error('split_load_count_invalid');
    if (plan.extraSplitLegs?.some(leg => !leg.disposal.trim())) throw new Error('split_dropoff_required');
    evaluateSplitBblPlan(plan.pickupBbls, [plan.splitBBbls, ...(plan.extraSplitLegs || []).map(leg => leg.bbls)]);
  }
  if (plans.reduce((sum, plan) => sum + plan.loadCount, 0) > 20) throw new Error('split_total_load_count_invalid');

  // Allocate group IDs once per workflow; retain across all retries
  ensureServiceWorkGroupIds(workflow, selectedDrivers.length > 1, !!isSplitTicket);

  const getFirstName = (d: ServiceWorkDriverInput) => {
    if (d.legalName) return d.legalName.split(' ')[0];
    return d.displayName || d.key;
  };
  const assignedDrivers = selectedDrivers.length > 1 ? selectedDrivers.map(getFirstName) : undefined;
  const resolvedPackageId = (packageId && packageId !== 'custom') ? packageId : 'water-hauling';

  coordinator.beginAction({
    actionId: workflow.actionId,
    actionScope: 'service-work-modal',
    tenantId,
    userId,
  });

  const dispatches: Array<{ dispatchId: string; unitId: string }> = [];

  const driverPromises = selectedDrivers.map(async driver => {
    const driverPlans = isSplitTicket ? plans : [{ id: 'base', wellName, ndicWellName, dropoff: dropoff || '', loadCount: 1 }];
    for (const plan of driverPlans) {
      const bblPlan = isSplitTicket
        ? evaluateSplitBblPlan(plan.pickupBbls, [plan.splitBBbls, ...(plan.extraSplitLegs || []).map(leg => leg.bbls)])
        : null;
      const splitTotal = isSplitTicket ? 2 + (plan.extraSplitLegs?.length || 0) : undefined;
      for (let loadIndex = 0; loadIndex < plan.loadCount; loadIndex++) {
        const familyKey = `${driver.key}::${plan.id}::${loadIndex}`;
        let familyId: string | undefined;
        if (isSplitTicket) {
          workflow.splitFamilyIds ||= {};
          familyId = workflow.splitFamilyIds[familyKey];
          if (!familyId) {
            familyId = Object.keys(workflow.splitFamilyIds).length === 0 && workflow.splitGroupId
              ? workflow.splitGroupId : `split_${mintDispatchId()}`;
            workflow.splitFamilyIds[familyKey] = familyId;
          }
        }
        const unitPrefix = plan.id === 'base' && loadIndex === 0 ? driver.key : familyKey;
        const baseJob: Record<string, unknown> = {
          ...assignmentIdentityForDriver(driver),
          ...(driver.legalName ? { driverFirstName: getFirstName(driver) } : {}),
          wellName: plan.wellName.trim(),
          ndicWellName: (plan.ndicWellName || '').trim(),
          ...(operator?.trim() ? { operator: operator.trim() } : {}),
          ...(plan.dropoff.trim() ? { disposal: plan.dropoff.trim() } : {}),
          ...(onsiteBy ? { onsiteBy } : {}),
          jobType: 'service',
          serviceType: serviceType.trim(),
          jobTypeId: canonicalJobTypeIdForServiceType(serviceType, customJobTypes),
          packageId: resolvedPackageId,
          packetRevision: 4,
          status: 'pending',
          notes: notes || '',
          priority: 5,
          assignedAt: new Date().toISOString(),
          assignedBy: userEmail || assignedBy || 'dashboard',
          ...(projectId ? { projectId } : {}),
          ...(workflow.serviceGroupId ? { serviceGroupId: workflow.serviceGroupId } : {}),
          ...(assignedDrivers ? { assignedDrivers } : {}),
          ...(isHeavyWater ? { isHeavyWater: true } : {}),
          ...(familyId ? { splitGroupId: familyId, splitSequence: 1, splitTotal } : {}),
        };
        const createLeg = async (leg: number, job: Record<string, unknown>) => {
          const unitId = `${unitPrefix}::leg${leg}`;
          const result = await coordinator.executeUnit(invoke, job, {
            actionId: workflow.actionId,
            actionScope: 'service-work-modal',
            unitId,
          });
          dispatches.push({ dispatchId: result.dispatchId, unitId });
        };
        await createLeg(1, { ...baseJob, ...(bblPlan?.pickupBbls != null ? { bbls: bblPlan.pickupBbls } : {}) });
        if (!isSplitTicket) continue;
        await createLeg(2, {
          ...baseJob,
          wellName: plan.dropoff.trim(),
          ndicWellName: '',
          notes: `Split ticket B — ${bblPlan?.deliveryBbls[0] != null ? `Planned delivery ${bblPlan.deliveryBbls[0]} BBL — ` : ''}${plan.splitBNotes?.trim() || notes || serviceType.trim()}`,
          splitSequence: 2,
          // The carry from A supplies the amount entering B.
        });
        for (let idx = 0; idx < (plan.extraSplitLegs?.length || 0); idx++) {
          const extra = plan.extraSplitLegs![idx];
          const letter = String.fromCharCode(67 + idx);
          const plannedDelivery = bblPlan?.deliveryBbls[idx + 1];
          await createLeg(3 + idx, {
            ...baseJob,
            wellName: extra.disposal.trim(),
            ndicWellName: '',
            disposal: extra.disposal.trim(),
            notes: `Split ticket ${letter} — ${plannedDelivery != null ? `Planned delivery ${plannedDelivery} BBL — ` : ''}${extra.notes || serviceType.trim()}`,
            splitSequence: 3 + idx,
          });
        }
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
