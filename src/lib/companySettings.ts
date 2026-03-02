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
}

export const JOB_TYPES = ['Production %', 'Service Work', 'Rig Move', 'Hot Shot', 'Frac Water', 'Other'];

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
