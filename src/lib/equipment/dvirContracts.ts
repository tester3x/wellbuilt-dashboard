/**
 * DVIR domain contracts — planning only (Phase 1D).
 *
 * Do not implement inspections, defects, maintenance, or health logic here.
 * These types document boundaries for the first vertical slice.
 *
 * Lifecycle (planned):
 *   Equipment → Assignment → Equipment Profile → Start Inspection → DVIR
 *   → Defect (optional) → Photos → Shop Notification → Repair
 *   → Return To Service → Health Projection
 *
 * Domain responsibilities (do not merge):
 *   DVIR        — inspection, observations, pass/fail recording
 *   Defects     — repair requests, affected components, severity, photo evidence
 *   Maintenance — work performed, parts, labor, completion
 *   Health      — long-term projection, analytics, scoring (read-only projection)
 *
 * AI direction (WB-T reference):
 *   AI may assist: component visibility, image quality, lighting, framing.
 *   AI must NOT: diagnose failures, determine OOS, approve repairs, replace mechanics.
 *   Shop remains authority for safety and repair decisions.
 */

/** Driver-initiated entry point from Equipment Profile. */
export interface StartInspectionIntent {
  companyId: string;
  equipmentId: string;
  assignmentId: string | null;
  assignmentSource: 'canonical' | 'legacy';
  driverHash: string;
  /** ISO timestamp when driver opened inspection flow. */
  initiatedAt: string;
}

/**
 * DVIR record — inspection session owned by DVIR domain.
 * Linked to equipment via equipmentId; optional assignmentId for custody context.
 */
export type InspectionItemResult = 'pass' | 'needs_attention';

export const PRE_TRIP_CATEGORY_IDS = [
  'lights',
  'brakes',
  'tires',
  'emergency_equipment',
  'fluid_leaks',
  'tank',
  'hoses',
  'pto',
  'miscellaneous',
] as const;

export type PreTripCategoryId = (typeof PRE_TRIP_CATEGORY_IDS)[number];

export interface InspectionCategoryResult {
  categoryId: PreTripCategoryId;
  categoryLabel: string;
  result: InspectionItemResult;
  /** Reserved — not implemented in slice 1 */
  defectId?: string | null;
  photoEvidenceIds?: string[];
  comments?: string;
  severity?: string;
}

export interface DvirInspectionContract {
  dvirId: string;
  companyId: string;
  equipmentId: string;
  assignmentId?: string | null;
  driverHash: string;
  inspectionType: 'pre_trip' | 'post_trip' | 'periodic';
  status: 'draft' | 'submitted' | 'reviewed';
  /** Slice 1: pass | needs_attention. Reserved: fail, conditional */
  result?: 'pass' | 'needs_attention' | 'fail' | 'conditional';
  overallResult?: InspectionItemResult;
  categories?: InspectionCategoryResult[];
  driverSignature?: string;
  equipmentLabel?: string;
  assignmentSource?: 'canonical' | 'legacy';
  startedAt: string;
  submittedAt?: string;
  /** Observation lines — DVIR-owned; not defect records until promoted. */
  observationCount?: number;
}

/**
 * Defect promotion — separate domain from DVIR observations.
 * A failed observation may create zero or one defect record.
 */
export interface DefectPromotionContract {
  defectId: string;
  companyId: string;
  equipmentId: string;
  dvirId?: string;
  componentId?: string;
  severity: 'minor' | 'major' | 'critical';
  status: 'open' | 'acknowledged' | 'in_repair' | 'resolved';
  photoEvidenceIds?: string[];
}

/** Maintenance work order — shop-owned completion domain. */
export interface MaintenanceWorkContract {
  workOrderId: string;
  companyId: string;
  equipmentId: string;
  defectId?: string;
  status: 'scheduled' | 'in_progress' | 'completed';
  completedAt?: string;
}

/** Health projection input — read-only aggregate; no domain writes healthScore directly. */
export interface HealthProjectionInputContract {
  equipmentId: string;
  companyId: string;
  sources: Array<'assignment' | 'dvir' | 'defect' | 'maintenance' | 'status' | 'documents'>;
}

export const DVIR_PLANNED_EVENTS = [
  'InspectionStarted',
  'DvirSubmitted',
  'DvirPassed',
  'DvirFailed',
  'DefectOpened',
  'ShopNotified',
  'MaintenanceCompleted',
  'ReturnToService',
  'HealthProjectionUpdated',
] as const;

export type DvirPlannedEvent = (typeof DVIR_PLANNED_EVENTS)[number];