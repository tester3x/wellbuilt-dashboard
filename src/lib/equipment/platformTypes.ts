/**
 * Platform-default equipment types (hybrid model).
 * Seeded per company; companies may add source=company types later.
 */

export interface PlatformEquipmentTypeDef {
  typeId: string;
  label: string;
  sortOrder: number;
}

export const PLATFORM_EQUIPMENT_TYPES: PlatformEquipmentTypeDef[] = [
  { typeId: 'truck', label: 'Truck', sortOrder: 0 },
  { typeId: 'trailer', label: 'Trailer', sortOrder: 1 },
  { typeId: 'generator', label: 'Generator', sortOrder: 2 },
  { typeId: 'pump', label: 'Pump', sortOrder: 3 },
  { typeId: 'tank', label: 'Tank', sortOrder: 4 },
  { typeId: 'compressor', label: 'Compressor', sortOrder: 5 },
];