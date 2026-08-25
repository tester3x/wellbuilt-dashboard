import { timestampMs } from './format';
import { splitLivePhotos } from './photos';
import { paperSourceFingerprint } from './projection';
import type {
  InvoiceSourceRecord,
  PaperEditSource,
  PaperOp,
  PaperSourceSnapshot,
  TicketSourceRecord,
} from './types';

function freezeValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  const ms = timestampMs(v);
  if (ms != null && typeof v === 'object') return ms;
  if (Array.isArray(v)) return v.map(freezeValue);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'function' || val === undefined) continue;
      out[k] = freezeValue(val);
    }
    return out;
  }
  return null;
}

export function freezeRecord<T extends Record<string, unknown>>(rec: T): T {
  return freezeValue(rec) as T;
}

export function buildPaperSourceSnapshot(input: {
  op: PaperOp;
  editSource?: PaperEditSource;
  ticket: TicketSourceRecord;
  invoice: InvoiceSourceRecord | null;
  paperTimeZone: string;
  legalName?: string;
  displayName?: string;
}): PaperSourceSnapshot {
  const ticket = freezeRecord({ ...input.ticket });
  const invoice = input.invoice ? freezeRecord({ ...input.invoice }) : null;
  const live = splitLivePhotos(invoice?.photos);
  const snapshot: PaperSourceSnapshot = {
    op: input.op,
    ticket,
    invoice,
    fingerprint: paperSourceFingerprint(ticket, invoice),
    paperTimeZone: input.paperTimeZone,
    assetUris: [...live.photos.map((p) => p.uri), ...(live.jsaUri ? [live.jsaUri] : [])],
  };
  if (input.editSource) snapshot.editSource = input.editSource;
  if (input.legalName) snapshot.legalName = input.legalName;
  if (input.displayName) snapshot.displayName = input.displayName;
  return snapshot;
}
