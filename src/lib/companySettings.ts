// Shared types and helpers for company settings
// Used by both CompaniesTab (admin) and Settings page (self-service)

import { getFirestoreDb, getFirebaseStorage } from '@/lib/firebase';
import { collection, getDocs, doc, getDoc, updateDoc } from 'firebase/firestore';

// ── Types ──────────────────────────────────────────────────────────────────────

export type Tier = 'free' | 'field' | 'god';

export const TIER_LABELS: Record<Tier, string> = {
  free: 'Free',
  field: 'Field',
  god: 'God',
};

export const TIER_COLORS: Record<Tier, string> = {
  free: 'bg-gray-600 text-gray-200',
  field: 'bg-blue-600 text-blue-100',
  god: 'bg-yellow-600 text-yellow-100',
};

export const TIER_DESCRIPTIONS: Record<Tier, string> = {
  free: 'WB Mobile only — 5 well cap, demo monitoring',
  field: 'WB Mobile + WB Tickets — no well cap',
  god: 'Everything — Hub + Tickets + Mobile + Dashboard + Billing & Payroll',
};

export const TIER_ORDER: Tier[] = ['free', 'field', 'god'];

export interface RateEntry {
  jobType: string;
  method: 'per_bbl' | 'hourly';
  rate: number;
}

export interface PayConfig {
  defaultSplit: number;       // e.g. 0.25 for 25%
  payrollRounding: 'match_billing' | 'none' | 'quarter_hour' | 'half_hour';
  payPeriod: 'weekly' | 'biweekly' | 'monthly';
  autoApproveHours?: number;  // hours before auto-approve (0 = disabled)
}

// ── Billing Types ────────────────────────────────────────────────────────────

export type FuelSurchargeMethod = 'none' | 'hourly' | 'per_mile' | 'percentage' | 'flat' | 'flat_doe';
export type PaymentTerms = 'due_on_receipt' | 'net_30' | 'net_60' | 'net_90';

export interface OperatorBillingConfig {
  paymentTerms: PaymentTerms;
  fuelSurchargeMethod: FuelSurchargeMethod;
  fuelSurchargeRate?: number;       // $/load (flat manual only)
  fuelSurchargePercent?: number;    // decimal: 0.08 = 8%
  fuelSurchargeBaseline?: number;   // DOE baseline $/gal (hourly, per_mile, flat_doe)
  fuelSurchargeMPG?: number;        // truck fuel efficiency (hourly + per_mile, default 6)
  fuelSurchargeSpeed?: number;      // average speed MPH (hourly only, default 30)
  fuelSurchargeMultiplier?: number; // gallons per load (flat_doe only, default 8)
  fuelSurchargeStep?: number;       // rounding step (flat_doe only, default 0.10)
}

export const PAYMENT_TERMS_OPTIONS: { value: PaymentTerms; label: string }[] = [
  { value: 'due_on_receipt', label: 'Due on Receipt' },
  { value: 'net_30', label: 'Net 30' },
  { value: 'net_60', label: 'Net 60' },
  { value: 'net_90', label: 'Net 90' },
];

export const FUEL_SURCHARGE_METHODS: { value: FuelSurchargeMethod; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'flat_doe', label: 'DOE per Hour (Bakken-style)' },
  { value: 'hourly', label: 'Per Hour (DOE-based)' },
  { value: 'per_mile', label: 'Per Mile (DOE-based)' },
  { value: 'percentage', label: '% of Linehaul' },
  { value: 'flat', label: 'Flat per Load (manual)' },
];

// ── DOE/EIA PADD Regions ────────────────────────────────────────────────────
// Weekly diesel prices published by DOE Energy Information Administration
// https://www.eia.gov/petroleum/gasdiesel/

export type DoeRegion = 'us' | 'padd1' | 'padd1a' | 'padd1b' | 'padd1c' | 'padd2' | 'padd3' | 'padd4' | 'padd5' | 'padd5_no_ca' | 'california';

export const DOE_REGIONS: { value: DoeRegion; label: string; description: string }[] = [
  { value: 'us', label: 'U.S. Average', description: 'National average' },
  { value: 'padd1', label: 'East Coast (PADD 1)', description: 'All East Coast states' },
  { value: 'padd1a', label: 'New England (PADD 1A)', description: 'CT, ME, MA, NH, RI, VT' },
  { value: 'padd1b', label: 'Central Atlantic (PADD 1B)', description: 'DE, DC, MD, NJ, NY, PA' },
  { value: 'padd1c', label: 'Lower Atlantic (PADD 1C)', description: 'FL, GA, NC, SC, VA, WV' },
  { value: 'padd2', label: 'Midwest (PADD 2)', description: 'IL, IN, IA, KS, KY, MI, MN, MO, NE, ND, SD, OH, OK, TN, WI' },
  { value: 'padd3', label: 'Gulf Coast (PADD 3)', description: 'AL, AR, LA, MS, NM, TX' },
  { value: 'padd4', label: 'Rocky Mountain (PADD 4)', description: 'CO, ID, MT, UT, WY' },
  { value: 'padd5', label: 'West Coast (PADD 5)', description: 'AK, AZ, CA, HI, NV, OR, WA' },
  { value: 'padd5_no_ca', label: 'West Coast less CA', description: 'AK, AZ, HI, NV, OR, WA' },
  { value: 'california', label: 'California', description: 'California only' },
];

/** Map US state abbreviation to DOE PADD region */
export const STATE_TO_PADD: Record<string, DoeRegion> = {
  // PADD 1A — New England
  CT: 'padd1a', ME: 'padd1a', MA: 'padd1a', NH: 'padd1a', RI: 'padd1a', VT: 'padd1a',
  // PADD 1B — Central Atlantic
  DE: 'padd1b', DC: 'padd1b', MD: 'padd1b', NJ: 'padd1b', NY: 'padd1b', PA: 'padd1b',
  // PADD 1C — Lower Atlantic
  FL: 'padd1c', GA: 'padd1c', NC: 'padd1c', SC: 'padd1c', VA: 'padd1c', WV: 'padd1c',
  // PADD 2 — Midwest (includes ND, SD)
  IL: 'padd2', IN: 'padd2', IA: 'padd2', KS: 'padd2', KY: 'padd2', MI: 'padd2',
  MN: 'padd2', MO: 'padd2', NE: 'padd2', ND: 'padd2', SD: 'padd2', OH: 'padd2',
  OK: 'padd2', TN: 'padd2', WI: 'padd2',
  // PADD 3 — Gulf Coast
  AL: 'padd3', AR: 'padd3', LA: 'padd3', MS: 'padd3', NM: 'padd3', TX: 'padd3',
  // PADD 4 — Rocky Mountain (includes MT)
  CO: 'padd4', ID: 'padd4', MT: 'padd4', UT: 'padd4', WY: 'padd4',
  // PADD 5 — West Coast
  AK: 'padd5', AZ: 'padd5', HI: 'padd5', NV: 'padd5', OR: 'padd5', WA: 'padd5',
  CA: 'california',
};

// ── Ticket Template Types ─────────────────────────────────────────────────

export type FieldSize = 'normal' | 'small' | 'tiny';

export interface TicketTemplate {
  // Header / Branding
  companyLogo: boolean;
  companyName: boolean;
  companyAddress: boolean;
  // Ticket Identity
  ticketNumber: boolean;
  ticketDate: boolean;
  timeGauged: boolean;
  // Pickup Location
  pickupCompany: boolean;
  pickupLocation: boolean;
  pickupApiNo: boolean;
  pickupGps: boolean;
  pickupLegalDesc: boolean;
  pickupCounty: boolean;
  // Drop-off Location
  dropoffLocation: boolean;
  dropoffApiNo: boolean;
  dropoffGps: boolean;
  dropoffCounty: boolean;
  dropoffLegalDesc: boolean;
  // Invoice
  invoiceNumber: boolean;
  // Measurements
  jobType: boolean;
  quantity: boolean;
  tankTop: boolean;
  tankBottom: boolean;
  // Notes
  notes: boolean;
  // Time Tracking
  startTime: boolean;
  stopTime: boolean;
  hours: boolean;
  // Driver Info
  driverName: boolean;
  truckNumber: boolean;
  trailerNumber: boolean;
  // Signatures
  driverSignature: boolean;
  receiverSignature: boolean;
  // Timeline
  timelineStamps: boolean;
  // Layout customization
  fieldSizes?: Partial<Record<string, FieldSize>>;
  groupOrder?: string[];
}

export const DEFAULT_TICKET_TEMPLATE: TicketTemplate = {
  companyLogo: true, companyName: true, companyAddress: true,
  ticketNumber: true, ticketDate: true, timeGauged: true,
  pickupCompany: true, pickupLocation: true, pickupApiNo: true,
  pickupGps: true, pickupLegalDesc: true, pickupCounty: true,
  dropoffLocation: true, dropoffApiNo: true, dropoffGps: true,
  dropoffCounty: true, dropoffLegalDesc: true,
  invoiceNumber: true,
  jobType: true, quantity: true, tankTop: true, tankBottom: true,
  notes: true,
  startTime: true, stopTime: true, hours: true,
  driverName: true, truckNumber: true, trailerNumber: true,
  driverSignature: true, receiverSignature: true,
  timelineStamps: true,
};

export const DEFAULT_GROUP_ORDER: string[] = [
  'header', 'identity', 'pickup', 'dropoff', 'invoice',
  'measurements', 'notes', 'time', 'timeline', 'driver', 'signatures',
];

export const DEFAULT_FIELD_SIZES: Record<string, FieldSize> = {
  header: 'normal', identity: 'normal',
  pickup: 'normal', pickup_legal: 'small',
  dropoff: 'normal', dropoff_legal: 'small',
  invoice: 'normal', measurements: 'normal', notes: 'normal',
  time: 'normal', timeline: 'normal', driver: 'normal', signatures: 'normal',
};

export interface TemplateFieldGroup {
  id: string;
  label: string;
  color: string;
  fields: { key: keyof TicketTemplate; label: string; required?: boolean }[];
}

export const TEMPLATE_FIELD_GROUPS: TemplateFieldGroup[] = [
  {
    id: 'header', label: 'Header / Branding', color: 'yellow',
    fields: [
      { key: 'companyLogo', label: 'Company Logo' },
      { key: 'companyName', label: 'Company Name' },
      { key: 'companyAddress', label: 'Address & Phone' },
    ],
  },
  {
    id: 'identity', label: 'Ticket Identity', color: 'yellow',
    fields: [
      { key: 'ticketNumber', label: 'Ticket #', required: true },
      { key: 'ticketDate', label: 'Date', required: true },
      { key: 'timeGauged', label: 'Time Gauged' },
    ],
  },
  {
    id: 'pickup', label: 'Pickup Location', color: 'green',
    fields: [
      { key: 'pickupCompany', label: 'Operator / Company' },
      { key: 'pickupLocation', label: 'Well Name' },
      { key: 'pickupApiNo', label: 'API #' },
      { key: 'pickupGps', label: 'GPS Coordinates' },
      { key: 'pickupLegalDesc', label: 'Legal Description' },
      { key: 'pickupCounty', label: 'County' },
    ],
  },
  {
    id: 'dropoff', label: 'Drop-off Location', color: 'blue',
    fields: [
      { key: 'dropoffLocation', label: 'Location Name' },
      { key: 'dropoffApiNo', label: 'API #' },
      { key: 'dropoffGps', label: 'GPS Coordinates' },
      { key: 'dropoffCounty', label: 'County' },
      { key: 'dropoffLegalDesc', label: 'Legal Description' },
    ],
  },
  {
    id: 'invoice', label: 'Invoice', color: 'purple',
    fields: [
      { key: 'invoiceNumber', label: 'Invoice #' },
    ],
  },
  {
    id: 'measurements', label: 'Measurements', color: 'orange',
    fields: [
      { key: 'jobType', label: 'Type' },
      { key: 'quantity', label: 'Quantity (BBLs)', required: true },
      { key: 'tankTop', label: 'Tank Top' },
      { key: 'tankBottom', label: 'Tank Bottom' },
    ],
  },
  {
    id: 'notes', label: 'Notes', color: 'gray',
    fields: [
      { key: 'notes', label: 'Notes / Remarks' },
    ],
  },
  {
    id: 'time', label: 'Time Tracking', color: 'cyan',
    fields: [
      { key: 'startTime', label: 'Start Time' },
      { key: 'stopTime', label: 'Stop Time' },
      { key: 'hours', label: 'Hours' },
    ],
  },
  {
    id: 'timeline', label: 'Timeline Stamps', color: 'cyan',
    fields: [
      { key: 'timelineStamps', label: 'Timeline Events' },
    ],
  },
  {
    id: 'driver', label: 'Driver Info', color: 'indigo',
    fields: [
      { key: 'driverName', label: 'Driver Name' },
      { key: 'truckNumber', label: 'Truck #' },
      { key: 'trailerNumber', label: 'Trailer #' },
    ],
  },
  {
    id: 'signatures', label: 'Signatures', color: 'red',
    fields: [
      { key: 'driverSignature', label: 'Driver Signature' },
      { key: 'receiverSignature', label: 'Receiver Signature' },
    ],
  },
];

export interface CompanyConfig {
  id: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  invoicePrefix?: string;
  invoiceBook?: boolean;
  ticketPrefix?: string;
  rateSheet?: Record<string, number>;  // legacy simple format
  rateSheets?: Record<string, RateEntry[]>;  // per-operator rate sheets
  payConfig?: PayConfig;
  billingConfig?: Record<string, OperatorBillingConfig>;  // per-operator billing config
  currentDieselPrice?: number;  // admin-set DOE regional price, updated weekly
  doeRegion?: DoeRegion;        // DOE PADD region for diesel price lookup
  notes?: string;
  assignedOperators?: string[];
  logoUrl?: string;
  primaryColor?: string;
  phone?: string;
  splitTickets?: boolean;
  tier?: Tier;
  enabledApps?: string[];
  requiredApps?: string[];
  transferRequiresApproval?: boolean;
  ticketTemplates?: Record<string, TicketTemplate>;
}

// Must match WB T's COMMODITY_TYPES + HOURLY_COMMODITY_TYPES in utils/constants.ts
export const JOB_TYPES = [
  'Production Water',
  'Fresh Water',
  'Flowback Water',
  'Pit Water',
  'Invert',
  'Service Work',
  'Vac Work',
  'Pushers',
  'Rig Work',
  'Fuel Service',
  'Other',
];

// Aliases: legacy rate sheet names → current WB T commodity types,
// and old invoice commodity types → current names
export const JOB_TYPE_ALIASES: Record<string, string> = {
  'Production %': 'Production Water',
  'Frac Water': 'Fresh Water',
  'Hot Shot': 'Fuel Service',
  'Flowback': 'Flowback Water',
  'Pit': 'Pit Water',
};

export const BILLING_METHODS: { value: 'per_bbl' | 'hourly'; label: string }[] = [
  { value: 'per_bbl', label: '$/BBL' },
  { value: 'hourly', label: '$/hr' },
];

// ── Firestore Helpers ──────────────────────────────────────────────────────────

export async function loadAllCompanies(): Promise<CompanyConfig[]> {
  const firestore = getFirestoreDb();
  const snap = await getDocs(collection(firestore, 'companies'));
  const list: CompanyConfig[] = [];
  snap.forEach(d => {
    list.push({ id: d.id, ...d.data() } as CompanyConfig);
  });
  list.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  return list;
}

export async function loadCompanyById(companyId: string): Promise<CompanyConfig | null> {
  const firestore = getFirestoreDb();
  const snap = await getDoc(doc(firestore, 'companies', companyId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as CompanyConfig;
}

export async function updateCompanyFields(
  companyId: string,
  fields: Record<string, any>
): Promise<void> {
  const firestore = getFirestoreDb();
  await updateDoc(doc(firestore, 'companies', companyId), fields);
}

// ── Branding Helpers ───────────────────────────────────────────────────────────

/** Extract up to 5 prominent colors from an image */
export function extractColorPalette(imageUrl: string): Promise<string[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const size = 100;
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve([]); return; }

      ctx.drawImage(img, 0, 0, size, size);
      const data = ctx.getImageData(0, 0, size, size).data;

      // Bucket colors (quantize to reduce space)
      const colorCounts: Record<string, { r: number; g: number; b: number; count: number }> = {};

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) continue;

        const brightness = (r + g + b) / 3;
        if (brightness > 240 || brightness < 15) continue;

        const qr = Math.round(r / 24) * 24;
        const qg = Math.round(g / 24) * 24;
        const qb = Math.round(b / 24) * 24;
        const key = `${qr},${qg},${qb}`;

        if (!colorCounts[key]) {
          colorCounts[key] = { r: qr, g: qg, b: qb, count: 0 };
        }
        colorCounts[key].count++;
      }

      // Score each color: prefer saturated + frequent
      const scored = Object.entries(colorCounts).map(([key, val]) => {
        const maxC = Math.max(val.r, val.g, val.b);
        const minC = Math.min(val.r, val.g, val.b);
        const saturation = maxC > 0 ? (maxC - minC) / maxC : 0;
        const score = val.count * (1 + saturation * 3);
        const hex = '#' + [val.r, val.g, val.b].map(c => Math.min(255, c).toString(16).padStart(2, '0')).join('');
        return { hex: hex.toUpperCase(), score, r: val.r, g: val.g, b: val.b };
      });

      scored.sort((a, b) => b.score - a.score);

      // Pick top colors that are visually distinct
      const palette: string[] = [];
      const colorDistance = (a: typeof scored[0], b: typeof scored[0]) =>
        Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

      for (const color of scored) {
        if (palette.length >= 5) break;
        const picked = palette.map(hex => scored.find(s => s.hex === hex)!);
        const tooClose = picked.some(p => colorDistance(color, p) < 60);
        if (!tooClose) {
          palette.push(color.hex);
        }
      }

      resolve(palette);
    };
    img.onerror = () => resolve([]);
    img.src = imageUrl;
  });
}

export async function uploadCompanyLogo(
  companyId: string,
  file: File
): Promise<string> {
  const bucket = 'wellbuilt-sync.firebasestorage.app';
  const objectPath = `companies/${companyId}/logo.png`;
  const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;

  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!uploadRes.ok) {
    const errBody = await uploadRes.text();
    throw new Error(`Upload failed (${uploadRes.status}): ${errBody.slice(0, 100)}`);
  }

  await uploadRes.json();
  return `https://storage.googleapis.com/${bucket}/${objectPath}`;
}
