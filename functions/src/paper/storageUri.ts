/**
 * Governed Storage resolution. Never fetch arbitrary HTTP URLs.
 *
 * WB-T job photo object paths (do not invent a new write convention):
 *   photos/{companyId}/{invoiceDocId}/{photoId}.jpg
 *   photos/{companyId}/{YYYY-MM-DD}/{invoiceDocId}_{timestamp}.jpg
 *
 * A broad prefix such as photos/ is not tenant authorization. The companyId
 * path segment must match the ticket/invoice company. When invoiceDocId is
 * known, the object must also belong to that invoice.
 */

export const MAX_SOURCE_ASSET_BYTES = 8 * 1024 * 1024;

const ALLOWED_HOSTS = new Set([
  'storage.googleapis.com',
  'firebasestorage.googleapis.com',
]);

const DATE_SEG = /^\d{4}-\d{2}-\d{2}$/;

const GOVERNED_PREFIXES = [
  'photos',
  'tickets',
  'invoices',
  'ticket-photos',
  'invoice-photos',
] as const;

export type GovernedAssetRef =
  | { ok: true; bucket: string; objectPath: string }
  | { ok: false; reason: string; message: string };

export type GovernedAssetOwner = {
  projectBucket: string;
  companyId?: string;
  invoiceDocId?: string;
  ticketDocId?: string;
};

function pathOwnedByTenant(objectPath: string, opts: GovernedAssetOwner): boolean {
  const companyId = (opts.companyId || '').trim();
  if (!companyId) return false;
  const segs = objectPath.split('/').filter(Boolean);
  if (segs.length < 2) return false;
  if (segs.includes('..')) return false;

  const root = segs[0];
  if (root === companyId) {
    return segs.length >= 2;
  }
  if (!(GOVERNED_PREFIXES as readonly string[]).includes(root)) return false;
  if (segs[1] !== companyId) return false;
  if (segs.length < 3) return false;

  const invoiceDocId = (opts.invoiceDocId || '').trim();
  if (root === 'photos' && invoiceDocId) {
    // photos/{companyId}/{invoiceDocId}/{photoId}.jpg
    if (segs[2] === invoiceDocId) return segs.length >= 4;
    // photos/{companyId}/{YYYY-MM-DD}/{invoiceDocId}_{timestamp}.jpg
    if (DATE_SEG.test(segs[2]) && segs.length >= 4) {
      const fileName = segs.slice(3).join('/');
      return fileName.startsWith(`${invoiceDocId}_`) || fileName.startsWith(`${invoiceDocId}.`);
    }
    return false;
  }
  if (root === 'invoices' && invoiceDocId) {
    return segs.includes(invoiceDocId);
  }
  const ticketDocId = (opts.ticketDocId || '').trim();
  if ((root === 'tickets' || root === 'ticket-photos') && ticketDocId) {
    return segs.includes(ticketDocId);
  }
  return true;
}

export function parseGovernedStorageUri(
  uri: string,
  opts: GovernedAssetOwner,
): GovernedAssetRef {
  const raw = (uri || '').trim();
  if (!raw) return { ok: false, reason: 'empty_uri', message: 'Asset URI is empty.' };
  if (/^data:/i.test(raw)) {
    return { ok: false, reason: 'data_uri_forbidden', message: 'data: URIs are not fetched by the paper server.' };
  }
  let bucket = '';
  let objectPath = '';
  if (raw.startsWith('gs://')) {
    const rest = raw.slice(5);
    const slash = rest.indexOf('/');
    if (slash < 1) return { ok: false, reason: 'malformed_gs', message: 'Malformed gs:// URI.' };
    bucket = rest.slice(0, slash);
    objectPath = decodeURIComponent(rest.slice(slash + 1).split('?')[0]);
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'malformed_url', message: 'Malformed asset URL.' };
    }
    if (url.protocol !== 'https:') {
      return { ok: false, reason: 'unsupported_scheme', message: 'Only https Storage URLs are allowed.' };
    }
    if (!ALLOWED_HOSTS.has(url.hostname)) {
      return { ok: false, reason: 'unknown_host', message: 'Asset host is not project Storage.' };
    }
    if (url.hostname === 'storage.googleapis.com') {
      const parts = url.pathname.replace(/^\//, '').split('/');
      bucket = parts.shift() || '';
      objectPath = decodeURIComponent(parts.join('/'));
    } else {
      const b = url.pathname.match(/\/b\/([^/]+)/);
      const o = url.pathname.match(/\/o\/([^?]+)/);
      bucket = b ? decodeURIComponent(b[1]) : '';
      objectPath = o ? decodeURIComponent(o[1]) : '';
    }
  }
  if (!bucket || !objectPath) {
    return { ok: false, reason: 'malformed_url', message: 'Storage bucket or object path missing.' };
  }
  if (bucket !== opts.projectBucket) {
    return { ok: false, reason: 'wrong_bucket', message: 'Asset is not in the project bucket.' };
  }
  if (objectPath.includes('..') || objectPath.startsWith('/')) {
    return { ok: false, reason: 'malformed_path', message: 'Illegal object path.' };
  }
  if (!pathOwnedByTenant(objectPath, opts)) {
    return { ok: false, reason: 'path_not_owned', message: 'Asset path is outside this company ticket/invoice Storage tree.' };
  }
  return { ok: true, bucket, objectPath };
}
