/**
 * Governed Storage resolution. Never fetch arbitrary HTTP URLs.
 */

export const MAX_SOURCE_ASSET_BYTES = 8 * 1024 * 1024;

const ALLOWED_HOSTS = new Set([
  'storage.googleapis.com',
  'firebasestorage.googleapis.com',
]);

const ALLOWED_PATH_PREFIXES = [
  'tickets/',
  'invoices/',
  'photos/',
  'ticket-photos/',
  'invoice-photos/',
];

export type GovernedAssetRef =
  | { ok: true; bucket: string; objectPath: string }
  | { ok: false; reason: string; message: string };

export function parseGovernedStorageUri(
  uri: string,
  opts: { projectBucket: string; companyId?: string },
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
  const companyOk = opts.companyId && (
    objectPath.startsWith(`${opts.companyId}/`) || objectPath.includes(`/${opts.companyId}/`)
  );
  const prefixOk = ALLOWED_PATH_PREFIXES.some((p) => objectPath.startsWith(p));
  if (!prefixOk && !companyOk) {
    return { ok: false, reason: 'path_not_owned', message: 'Asset path is outside governed ticket/invoice photo prefixes.' };
  }
  return { ok: true, bucket, objectPath };
}
