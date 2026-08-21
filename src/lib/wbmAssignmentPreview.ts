/**
 * Bind Dashboard WB-M Apply to the exact Preview snapshot.
 * Changing checkboxes after Preview must disable Apply.
 */
export type BoundAssignmentPreview = {
  driverId: string;
  companyId: string;
  beforeDigest: string;
  proposedDigest: string;
  beforeRevision: unknown;
  assignedRoutes: string[];
  assignedWells: string[];
  before: { assignedRoutes: unknown; assignedWells: unknown };
};

export function listsEqual(a: string[], b: string[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function selectionsMatchPreview(
  preview: BoundAssignmentPreview | null,
  selectedRoutes: string[],
  selectedWells: string[],
): boolean {
  if (!preview) return false;
  return listsEqual(preview.assignedRoutes, selectedRoutes)
    && listsEqual(preview.assignedWells, selectedWells);
}

export function applyEnabled(
  preview: BoundAssignmentPreview | null,
  selectedRoutes: string[],
  selectedWells: string[],
): boolean {
  return selectionsMatchPreview(preview, selectedRoutes, selectedWells);
}
