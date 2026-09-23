/**
 * Core Create Project workflow identity and orchestration.
 *
 * Provides stable workflow identity that survives:
 * - component rerenders
 * - repeated handler submissions
 * - transport network uncertainty
 * - partial batch success
 * - validation corrections followed by retry
 * - button re-enable
 *
 * Preallocates projectId once at workflow start and uses that exact ID for:
 * - Firestore project document (with idempotent replay and conflict detection)
 * - Coordinator actionId (`proj_create_${projectId}`)
 * - All related dispatch units (`projectId: projectId`)
 *
 * Retains identity until whole workflow succeeds AND UI completion is confirmed,
 * or the user cancels.
 */

import {
  DispatchCreationCoordinator,
} from './staffWriteDispatchCore.ts';
import type { CallableInvoker } from './staffWriteDispatchCore.ts';
import { assignmentIdentityForDriver } from './dispatchWriterIdentity.ts';
import type { DriverIdentity } from './dispatchDriverIdentity.ts';

export interface CreateProjectWorkflowState {
  projectId: string;
  actionId: string;
  projectCommitted: boolean;
  createdAt: number;
}

export interface FirestoreProjectSnapshot {
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

export interface FirestoreProjectWriter {
  getDoc: (projectId: string) => Promise<FirestoreProjectSnapshot>;
  setDoc: (projectId: string, data: Record<string, unknown>) => Promise<void>;
}

export interface ProjectDataInput {
  name: string;
  wellNames: string[];
  operatorName: string;
  companyId: string;
  createdBy: string;
  startDate: string;
  projectedEndDate: string | null;
  status: string;
  jobType: 'service' | 'pw';
  serviceType: string | null;
  notes: string | null;
  driverSchedule: Record<string, string[]>;
  dayDriverHashes?: string[];
  nightDriverHashes?: string[];
  driverDisposals?: Record<string, { name: string; lat?: number; lng?: number }>;
  createdAt?: unknown;
}

export interface ProjectWellInfo {
  wellName: string;
  ndicName?: string;
  route?: string;
}

export interface ProjectDriverInput extends DriverIdentity {
  key: string;
}

export interface ExecuteCreateProjectInput {
  workflow: CreateProjectWorkflowState;
  coordinator: DispatchCreationCoordinator;
  invoke: CallableInvoker;
  projectWriter: FirestoreProjectWriter;
  projectData: ProjectDataInput;
  wells: ProjectWellInfo[];
  drivers: ProjectDriverInput[];
  assignedBy: string;
  tenantId?: string;
  userId?: string;
  onUiComplete?: (projectId: string) => Promise<void> | void;
}

export interface ExecuteCreateProjectResult {
  projectId: string;
  actionId: string;
  dispatches: Array<{ dispatchId: string; unitId: string }>;
}

/**
 * Mints a Firestore-compatible 20-character auto ID if firestore collection is not supplied.
 */
export function mintProjectId(firestoreCollection?: { doc?: () => { id: string } }): string {
  if (firestoreCollection && typeof firestoreCollection.doc === 'function') {
    return firestoreCollection.doc().id;
  }
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let autoId = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    for (let i = 0; i < 20; i++) {
      autoId += chars.charAt(bytes[i] % chars.length);
    }
    return autoId;
  }
  for (let i = 0; i < 20; i++) {
    autoId += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return autoId;
}

/**
 * Creates a stable Create Project workflow identity object when the user enters or resets
 * the create-project workflow.
 */
export function createProjectWorkflow(options?: {
  projectId?: string;
  firestoreCollection?: { doc?: () => { id: string } };
}): CreateProjectWorkflowState {
  const projectId = options?.projectId || mintProjectId(options?.firestoreCollection);
  return {
    projectId,
    actionId: `proj_create_${projectId}`,
    projectCommitted: false,
    createdAt: Date.now(),
  };
}

/**
 * Checks if an existing project matches identical immutable creation identity.
 */
export function projectImmutableIdentityMatches(
  existing: Record<string, unknown>,
  input: ProjectDataInput
): boolean {
  if (String(existing.companyId || '').trim() !== String(input.companyId || '').trim()) return false;
  if (String(existing.name || '').trim() !== String(input.name || '').trim()) return false;
  if (String(existing.jobType || '').trim() !== String(input.jobType || '').trim()) return false;
  if ((String(existing.serviceType || '').trim() || null) !== (String(input.serviceType || '').trim() || null)) return false;
  if (String(existing.operatorName || '').trim() !== String(input.operatorName || '').trim()) return false;

  const existingWells = Array.isArray(existing.wellNames)
    ? [...existing.wellNames].map(w => String(w).trim()).sort()
    : [];
  const inputWells = [...input.wellNames].map(w => String(w).trim()).sort();

  if (existingWells.length !== inputWells.length) return false;
  for (let i = 0; i < existingWells.length; i++) {
    if (existingWells[i] !== inputWells[i]) return false;
  }
  return true;
}

/**
 * Executes project creation with stable workflow identity, idempotent project write,
 * partial dispatch retention, and UI completion finalization.
 */
export async function executeCreateProjectWorkflow(
  input: ExecuteCreateProjectInput
): Promise<ExecuteCreateProjectResult> {
  const {
    workflow,
    coordinator,
    invoke,
    projectWriter,
    projectData,
    wells,
    drivers,
    assignedBy,
    tenantId,
    userId,
    onUiComplete,
  } = input;

  if (!projectData.name.trim()) throw new Error('project_name_required');
  if (projectData.wellNames.length === 0) throw new Error('project_wells_required');

  // Step 1: Idempotent Firestore project document creation
  const existingDoc = await projectWriter.getDoc(workflow.projectId);
  if (existingDoc.exists) {
    const existingData = existingDoc.data() || {};
    if (!projectImmutableIdentityMatches(existingData, projectData)) {
      throw new Error(`project_conflict:conflicting_existing_project:${workflow.projectId}`);
    }
    // Identical replay: mark committed
    workflow.projectCommitted = true;
  } else {
    // Write new document with preallocated ID
    await projectWriter.setDoc(workflow.projectId, {
      ...projectData,
      id: workflow.projectId,
    });
    workflow.projectCommitted = true;
  }

  // Step 2: Create dispatches for today's assigned drivers
  const assignedDriverHashes = Array.from(projectData.driverSchedule[projectData.startDate] || []);
  const dispatches: Array<{ dispatchId: string; unitId: string }> = [];

  if (assignedDriverHashes.length > 0) {
    coordinator.beginAction({
      actionId: workflow.actionId,
      actionScope: 'create-project',
      tenantId,
      userId,
    });

    for (const wellName of projectData.wellNames) {
      const wellData = wells.find(w => w.wellName === wellName);
      for (const driverHash of assignedDriverHashes) {
        const driver = drivers.find(d => d.key === driverHash);
        if (!driver) continue;
        const driverFirstName = driver.legalName ? driver.legalName.split(' ')[0] : driver.displayName;
        const driverDisposal = projectData.driverDisposals?.[driverHash];
        const unitId = `${wellName}::${driverHash}`;

        const job: Record<string, unknown> = {
          ...assignmentIdentityForDriver(driver),
          driverFirstName,
          wellName,
          ndicWellName: wellData?.ndicName || wellName,
          operator: projectData.operatorName.trim(),
          route: wellData?.route || '',
          jobType: projectData.jobType,
          serviceType: projectData.serviceType || null,
          status: 'pending',
          priority: 500,
          assignedAt: new Date().toISOString(),
          assignedBy: assignedBy || 'dashboard',
          projectId: workflow.projectId,
          notes: projectData.notes || null,
          ...(driverDisposal ? {
            disposal: driverDisposal.name,
            disposalLat: driverDisposal.lat,
            disposalLng: driverDisposal.lng,
          } : {}),
        };

        const res = await coordinator.executeUnit(invoke, job, {
          actionId: workflow.actionId,
          actionScope: 'create-project',
          unitId,
        });
        dispatches.push({ dispatchId: res.dispatchId, unitId });
      }
    }
  }

  // Step 3: Success Retention & UI Completion:
  // Downstream UI completion is awaited before finalization.
  if (onUiComplete) {
    await onUiComplete(workflow.projectId);
  }

  if (assignedDriverHashes.length > 0) {
    coordinator.finalizeAction(workflow.actionId);
  }

  return {
    projectId: workflow.projectId,
    actionId: workflow.actionId,
    dispatches,
  };
}

/**
 * Explicitly cancels the Create Project workflow.
 * Clears ONLY this project's action and units from the coordinator.
 * Preserves any project document that may already have been committed.
 */
export function cancelCreateProjectWorkflow(
  workflow: CreateProjectWorkflowState,
  coordinator: DispatchCreationCoordinator
): void {
  coordinator.cancelAction(workflow.actionId);
}
