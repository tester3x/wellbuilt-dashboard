export const INDEPENDENT_SECTORS = [
  { id: 'water-hauling', label: 'Water Hauling', style: 'oilfield', description: 'Water type, volume, source and disposal reference' },
  { id: 'ltl', label: 'LTL Freight', style: 'freight', description: 'Pieces, pallets, weight and freight class' },
  { id: 'otr', label: 'Over-the-Road', style: 'trip', description: 'Trailer, commodity and pickup/delivery appointments' },
  { id: 'hot-shot', label: 'Hot Shot', style: 'urgent', description: 'Urgency, cargo and vehicle requirement' },
  { id: 'aggregate', label: 'Aggregate', style: 'bulk', description: 'Material, tons, loads and scale ticket' },
] as const;
export type IndependentSector = typeof INDEPENDENT_SECTORS[number]['id'];
export type SectorField = { key: string; label: string; required?: boolean; type?: 'number' | 'datetime-local'; options?: readonly string[] };
export const SECTOR_FIELDS: Record<IndependentSector, readonly SectorField[]> = {
  'water-hauling': [
    { key: 'waterType', label: 'Water type', required: true, options: ['Production water', 'Fresh water', 'Flowback', 'Frac water', 'Other'] },
    { key: 'volumeBbl', label: 'Estimated barrels', required: true, type: 'number' },
    { key: 'sourceReference', label: 'Well / source reference' },
    { key: 'disposalReference', label: 'Disposal / delivery reference' },
  ],
  ltl: [
    { key: 'freightDescription', label: 'Freight description', required: true },
    { key: 'pieces', label: 'Pieces', required: true, type: 'number' },
    { key: 'pallets', label: 'Pallets', type: 'number' },
    { key: 'weightLbs', label: 'Weight (lb)', type: 'number' },
    { key: 'freightClass', label: 'Freight class' },
  ],
  otr: [
    { key: 'trailerType', label: 'Trailer type', required: true, options: ['Dry van', 'Reefer', 'Flatbed', 'Step deck', 'Other'] },
    { key: 'commodity', label: 'Commodity', required: true },
    { key: 'weightLbs', label: 'Weight (lb)', type: 'number' },
    { key: 'pickupAppointment', label: 'Pickup appointment', type: 'datetime-local' },
    { key: 'deliveryAppointment', label: 'Delivery appointment', type: 'datetime-local' },
  ],
  'hot-shot': [
    { key: 'urgency', label: 'Urgency', required: true, options: ['Same day', 'Next day', 'Scheduled'] },
    { key: 'cargoDetails', label: 'Cargo and dimensions', required: true },
    { key: 'vehicleRequirement', label: 'Vehicle requirement' },
    { key: 'readyBy', label: 'Ready by', type: 'datetime-local' },
  ],
  aggregate: [
    { key: 'material', label: 'Material', required: true, options: ['Gravel', 'Sand', 'Scoria', 'Topsoil', 'Other'] },
    { key: 'estimatedTons', label: 'Estimated tons', required: true, type: 'number' },
    { key: 'loadCount', label: 'Estimated loads', type: 'number' },
    { key: 'scaleTicket', label: 'Scale ticket', options: ['Required', 'Not required'] },
  ],
};
export const sectorLabel = (sector: string | undefined) => INDEPENDENT_SECTORS.find(item => item.id === sector)?.label || 'General';
