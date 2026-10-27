/**
 * Bind Dashboard WB-M Apply to the exact Preview snapshot, target, and
 * request generation. A delayed Driver A preview must not enable Apply for B.
 */
export type BoundAssignmentPreview = {
  driverId: string;
  companyId: string;
  beforeDigest: string;
  proposedDigest: string;
  previewContextDigest: string;
  beforeRevision: unknown;
  assignedRoutes: string[];
  assignedWells: string[];
  assignedFreshWaterRoutes?: string[];
  before: { assignedRoutes: unknown; assignedWells: unknown; assignedFreshWaterRoutes?: unknown };
  generation: number;
};

export function listsEqual(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function bumpPreviewGeneration(current: number): number {
  return current + 1;
}

export function shouldInstallPreview(input: {
  capturedGeneration: number;
  currentGeneration: number;
  capturedDriverId: string;
  currentDriverId: string | null;
}): boolean {
  return input.capturedGeneration === input.currentGeneration
    && !!input.currentDriverId
    && input.capturedDriverId === input.currentDriverId;
}

export function selectionsMatchPreview(
  preview: BoundAssignmentPreview | null,
  selectedRoutes: string[],
  selectedWells: string[],
  selectedFreshWaterRoutes: string[] = [],
): boolean {
  if (!preview) return false;
  return listsEqual(preview.assignedRoutes, selectedRoutes)
    && listsEqual(preview.assignedWells, selectedWells)
    && listsEqual(preview.assignedFreshWaterRoutes || [], selectedFreshWaterRoutes);
}

export function applyEnabled(
  preview: BoundAssignmentPreview | null,
  selectedRoutes: string[],
  selectedWells: string[],
  routeTarget?: { driverId: string; companyId?: string } | null,
  currentGeneration?: number,
  selectedFreshWaterRoutes: string[] = [],
): boolean {
  if (!selectionsMatchPreview(preview, selectedRoutes, selectedWells, selectedFreshWaterRoutes) || !preview) return false;
  if (routeTarget && preview.driverId !== routeTarget.driverId) return false;
  if (routeTarget && preview.companyId !== (routeTarget.companyId || '')) return false;
  if (currentGeneration !== undefined && preview.generation !== currentGeneration) return false;
  return true;
}
