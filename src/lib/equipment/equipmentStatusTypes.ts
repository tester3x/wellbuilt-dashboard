/**
 * Reserved equipmentStatus model — operational availability projection.
 *
 * equipmentStatus represents operational availability of an asset.
 * It is NOT driven by DVIR directly and is NOT the same as registry `status`
 * (ready, needs_service, scheduled, in_shop, out_of_service).
 *
 * Future: domain events → availability projection → equipmentStatus.
 * No service writes equipmentStatus automatically in Phase 1D.
 * No UI workflows, dispatch restrictions, or business logic yet.
 */

export const EQUIPMENT_OPERATIONAL_STATUSES = [
  'active',
  'shop',
  'out_of_service',
  'retired',
  'loaned',
  'unknown',
] as const;

export type EquipmentOperationalStatus = (typeof EQUIPMENT_OPERATIONAL_STATUSES)[number];

export const EQUIPMENT_OPERATIONAL_STATUS_LABELS: Record<EquipmentOperationalStatus, string> = {
  active: 'Active',
  shop: 'In Shop',
  out_of_service: 'Out of Service',
  retired: 'Retired',
  loaned: 'Loaned',
  unknown: 'Unknown',
};