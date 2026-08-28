/**
 * Project companies/{companyId}/spill_incidents/{incidentId} (WB-T cde5645)
 * into Dashboard list/detail views. Never invents delivery, media readiness,
 * or acknowledgment. Never returns raw public Storage URLs.
 */

export const SPILL_SCHEMA_VERSION = 1;
export const SPILL_COLLECTION = 'spill_incidents' as const;

export type SpillListFilter = 'open' | 'acknowledged' | 'resolved' | 'closed' | 'all';

export type SpillWorkflowStatus = 'open' | 'acknowledged' | 'resolved' | 'closed';

export type SpillLoadState =
  | { kind: 'loading' }
  | { kind: 'empty' }
  | { kind: 'denied' }
  | { kind: 'missing_index' }
  | { kind: 'retryable'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export type SpillMediaState = 'pending' | 'unavailable' | 'ready';

export type SpillNotifyRollup =
  | 'notification_service_not_configured'
  | 'queued'
  | 'partial'
  | 'failed'
  | 'delivered';

const PUBLIC_STORAGE_RE = /firebasestorage\.googleapis\.com|storage\.googleapis\.com|[?&]token=/i;

export function isPublicStorageUrl(value: unknown): boolean {
  return typeof value === 'string' && PUBLIC_STORAGE_RE.test(value);
}

export function isoFromUnknown(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'object') {
    const v = value as { toDate?: () => Date; _seconds?: number; seconds?: number; _ts?: string };
    if (typeof v._ts === 'string') return v._ts;
    if (typeof v.toDate === 'function') {
      try { return v.toDate().toISOString(); } catch { return null; }
    }
    const sec = typeof v._seconds === 'number' ? v._seconds : v.seconds;
    if (typeof sec === 'number' && Number.isFinite(sec)) return new Date(sec * 1000).toISOString();
  }
  return null;
}

export function classifySpillWorkflowStatus(raw: unknown): SpillWorkflowStatus {
  const s = String(raw || '').toLowerCase();
  if (s === 'acknowledged') return 'acknowledged';
  if (s === 'resolved') return 'resolved';
  if (s === 'closed') return 'closed';
  return 'open';
}

export function classifyFirestoreSpillError(err: unknown): SpillLoadState {
  const e = err as { code?: string; message?: string };
  const code = String(e?.code || '').toLowerCase();
  const msg = String(e?.message || err || '');
  if (code.includes('permission-denied') || /permission|insufficient/i.test(msg)) {
    return { kind: 'denied' };
  }
  if (code.includes('failed-precondition') || /requires an index|FAILED_PRECONDITION/i.test(msg)) {
    return { kind: 'missing_index' };
  }
  if (code.includes('unavailable') || code.includes('deadline') || /unavailable|network|timeout/i.test(msg)) {
    return { kind: 'retryable', message: msg || 'Service unavailable' };
  }
  return { kind: 'error', message: msg || 'Failed to load spill incidents' };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function text(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export interface SpillPhotoView {
  photoId: string;
  slot: string | null;
  capturedAtIso: string | null;
  fileSize: number | null;
  storagePath: string | null;
  mediaState: SpillMediaState;
}

export interface SpillVideoView {
  videoId: string;
  capturedAtIso: string | null;
  durationSec: number | null;
  muted: boolean | null;
  fileSize: number | null;
  storagePath: string | null;
  uploadState: string | null;
  mediaState: SpillMediaState;
}

export interface SpillDeliveryView {
  deliveryId: string;
  channel: string;
  recipientKey: string;
  displayName: string | null;
  /** Masked destination — never a raw unredacted target in the list. */
  addressMasked: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  updatedAtIso: string | null;
}

export interface SpillAuditView {
  atIso: string | null;
  actorUid: string | null;
  actorName: string | null;
  action: string;
  reason: string | null;
  priorStatus: string | null;
  resultingStatus: string | null;
}

export interface SpillListRow {
  incidentId: string;
  companyId: string;
  malformed: boolean;
  status: SpillWorkflowStatus;
  rawStatus: string | null;
  severity: string | null;
  occurredAtIso: string | null;
  updatedAtIso: string | null;
  driverName: string | null;
  driverId: string | null;
  companyName: string | null;
  ticketNumber: string | null;
  invoiceNumber: string | null;
  invoiceDocId: string | null;
  phase: string | null;
  location: string | null;
  photoCount: number;
  videoCount: number;
  notifyRollup: SpillNotifyRollup;
}

export interface SpillDetailView extends SpillListRow {
  schemaVersion: number;
  material: string | null;
  estimatedAmount: number | string | null;
  amountUnit: string | null;
  sourceCause: string | null;
  flowState: string | null;
  contained: boolean | null;
  waterwayThreat: boolean | null;
  injuriesOrDanger: boolean | null;
  actionsTaken: string | null;
  emergencyServicesContacted: boolean | null;
  notes: string | null;
  gps: { lat: number; lng: number; accuracy?: number | null; capturedAtIso?: string | null } | null;
  operator: string | null;
  wellName: string | null;
  hauledTo: string | null;
  truckNumber: string | null;
  trailer: string | null;
  createdAtIso: string | null;
  submittedAtIso: string | null;
  acceptedAtIso: string | null;
  notifyPolicyVersion: number | null;
  notificationsCreated: boolean;
  photos: SpillPhotoView[];
  video: SpillVideoView | null;
  deliveries: SpillDeliveryView[];
  audit: SpillAuditView[];
  followUpOwner: string | null;
  followUpNotes: Array<{ atIso: string | null; actorName: string | null; text: string }>;
}

function mediaStateFrom(item: Record<string, unknown> | null, infraReady: boolean): SpillMediaState {
  if (!infraReady) {
    const upload = text(item?.uploadState) || text(item?.deliveryState);
    if (upload === 'uploaded' || upload === 'ready') return 'pending';
    return 'pending';
  }
  const path = text(item?.storagePath);
  if (!path) return 'unavailable';
  const upload = text(item?.uploadState) || text(item?.deliveryState);
  if (upload === 'authorized' || upload === 'pending' || !upload) return 'pending';
  if (upload === 'uploaded' || upload === 'ready') return 'ready';
  return 'unavailable';
}

function stripPublicUrls<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPublicStorageUrl(v)) continue;
    if (k === 'downloadUrl' || k === 'sampleUrl' || k === 'url' || k === 'publicUrl') continue;
    out[k] = v;
  }
  return out as T;
}

function projectPhoto(raw: unknown, infraReady: boolean): SpillPhotoView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const photoId = text(r.photoId) || text(r.id);
  if (!photoId) return null;
  const cleaned = stripPublicUrls(r);
  return {
    photoId,
    slot: text(cleaned.slot),
    capturedAtIso: isoFromUnknown(cleaned.capturedAtIso || cleaned.capturedAt),
    fileSize: num(cleaned.fileSize),
    storagePath: text(cleaned.storagePath),
    mediaState: mediaStateFrom(cleaned, infraReady),
  };
}

function projectVideo(raw: unknown, infraReady: boolean): SpillVideoView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const videoId = text(r.videoId) || text(r.id);
  if (!videoId) return null;
  const cleaned = stripPublicUrls(r);
  return {
    videoId,
    capturedAtIso: isoFromUnknown(cleaned.capturedAtIso),
    durationSec: num(cleaned.durationSec),
    muted: typeof cleaned.muted === 'boolean' ? cleaned.muted : null,
    fileSize: num(cleaned.fileSize),
    storagePath: text(cleaned.storagePath),
    uploadState: text(cleaned.uploadState) || text(cleaned.deliveryState),
    mediaState: mediaStateFrom(cleaned, infraReady),
  };
}

function maskAddress(raw: unknown): string | null {
  const s = text(raw);
  if (!s) return null;
  if (s.includes('@')) {
    const [u, d] = s.split('@');
    return `${u.slice(0, 1)}…@${d}`;
  }
  if (s.length > 4) return `…${s.slice(-4)}`;
  return '…';
}

export function projectDelivery(raw: unknown): SpillDeliveryView | null {
  const r = asRecord(raw);
  if (!r) return null;
  const deliveryId = text(r.deliveryId) || text(r.id);
  if (!deliveryId) return null;
  return {
    deliveryId,
    channel: text(r.channel) || 'unknown',
    recipientKey: text(r.recipientKey) || deliveryId,
    displayName: text(r.displayName),
    addressMasked: maskAddress(r.address || r.target),
    status: text(r.status) || text(r.state) || 'queued',
    attempts: num(r.attempts) ?? 0,
    lastError: text(r.lastError),
    updatedAtIso: isoFromUnknown(r.updatedAtIso || r.updatedAt),
  };
}

export function rollupNotificationStatus(input: {
  notificationsCreated?: unknown;
  deliveries: SpillDeliveryView[];
  workerDeployed: boolean;
  providerConfigured: boolean;
}): SpillNotifyRollup {
  if (!input.workerDeployed || !input.providerConfigured) {
    return 'notification_service_not_configured';
  }
  if (input.notificationsCreated !== true) return 'notification_service_not_configured';
  const dels = input.deliveries || [];
  if (dels.length === 0) return 'notification_service_not_configured';
  const authoritativeSent = dels.filter((d) => d.status === 'sent' || d.status === 'delivered' || d.status === 'opened');
  const failed = dels.filter((d) => d.status === 'failed' || d.status === 'permanently_failed');
  if (authoritativeSent.length === dels.length) return 'delivered';
  if (authoritativeSent.length > 0) return 'partial';
  if (failed.length === dels.length) return 'failed';
  return 'queued';
}

export function notifyRollupLabel(r: SpillNotifyRollup): string {
  switch (r) {
    case 'notification_service_not_configured':
      return 'Notification service not configured';
    case 'queued':
      return 'Queued (not sent)';
    case 'partial':
      return 'Partial delivery';
    case 'failed':
      return 'Delivery failed';
    case 'delivered':
      return 'Delivered';
  }
}

function reportOf(data: Record<string, unknown>): Record<string, unknown> {
  return asRecord(data.report) || {};
}

function jobOf(data: Record<string, unknown>, report: Record<string, unknown>): Record<string, unknown> {
  return asRecord(report.job) || asRecord(data.job) || {};
}

export function isMalformedIncident(data: unknown): boolean {
  const r = asRecord(data);
  if (!r) return true;
  const id = text(r.incidentId);
  const companyId = text(r.companyId);
  return !id || !companyId;
}

export function projectSpillListRow(
  data: unknown,
  opts: { companyName?: string | null; workerDeployed?: boolean; providerConfigured?: boolean; mediaInfraReady?: boolean } = {},
): SpillListRow | null {
  const r = asRecord(data);
  if (!r) return null;
  const incidentId = text(r.incidentId);
  const companyId = text(r.companyId);
  if (!incidentId || !companyId) {
    return {
      incidentId: incidentId || '(malformed)',
      companyId: companyId || '',
      malformed: true,
      status: 'open',
      rawStatus: text(r.status),
      severity: null,
      occurredAtIso: null,
      updatedAtIso: null,
      driverName: null,
      driverId: null,
      companyName: opts.companyName ?? null,
      ticketNumber: null,
      invoiceNumber: null,
      invoiceDocId: null,
      phase: null,
      location: null,
      photoCount: 0,
      videoCount: 0,
      notifyRollup: 'notification_service_not_configured',
    };
  }
  const report = reportOf(r);
  const job = jobOf(r, report);
  const manifest = asRecord(r.mediaManifest) || {};
  const photos = Array.isArray(manifest.photos) ? manifest.photos : Array.isArray(report.photos) ? report.photos : [];
  const video = manifest.video || report.video || null;
  const gps = asRecord(report.gps) || asRecord(r.gps);
  const well = text(job.wellName) || text(report.wellName) || text(r.wellName);
  const hauledTo = text(job.hauledTo) || text(report.hauledTo) || text(r.hauledTo);
  const location = well || hauledTo || (gps ? `${num(gps.lat)}, ${num(gps.lng)}` : null);
  const deliveries: SpillDeliveryView[] = [];
  return {
    incidentId,
    companyId,
    malformed: false,
    status: classifySpillWorkflowStatus(r.status),
    rawStatus: text(r.status),
    severity: text(r.severity) || text(report.severity),
    occurredAtIso: isoFromUnknown(r.acceptedAt || r.submittedAt || r.createdAt || report.createdAtIso),
    updatedAtIso: isoFromUnknown(r.updatedAt || r.acceptedAt || r.createdAt),
    driverName: text(report.driverName) || text(r.driverName),
    driverId: text(r.driverId) || text(r.driverHash) || text(report.driverHash),
    companyName: opts.companyName ?? null,
    ticketNumber: text(job.ticketNumber) || text(r.ticketNumber) || text(report.ticketNumber),
    invoiceNumber: text(job.invoiceNumber) || text(r.invoiceNumber),
    invoiceDocId: text(job.invoiceDocId) || text(r.invoiceDocId),
    phase: text(job.lifecyclePhase) || text(r.lifecyclePhase) || text(report.lifecyclePhase),
    location,
    photoCount: photos.filter(Boolean).length,
    videoCount: video ? 1 : 0,
    notifyRollup: rollupNotificationStatus({
      notificationsCreated: r.notificationsCreated,
      deliveries,
      workerDeployed: opts.workerDeployed === true,
      providerConfigured: opts.providerConfigured === true,
    }),
  };
}

export function projectSpillDetail(
  data: unknown,
  extras: {
    deliveries?: unknown[];
    audit?: unknown[];
    companyName?: string | null;
    workerDeployed?: boolean;
    providerConfigured?: boolean;
    mediaInfraReady?: boolean;
  } = {},
): SpillDetailView | null {
  const row = projectSpillListRow(data, extras);
  if (!row) return null;
  const r = asRecord(data) || {};
  const report = reportOf(r);
  const job = jobOf(r, report);
  const gpsRaw = asRecord(report.gps) || asRecord(r.gps);
  const lat = gpsRaw ? num(gpsRaw.lat) : null;
  const lng = gpsRaw ? num(gpsRaw.lng) : null;
  const infra = extras.mediaInfraReady === true;
  const manifest = asRecord(r.mediaManifest) || {};
  const photoSrc = Array.isArray(manifest.photos) ? manifest.photos : Array.isArray(report.photos) ? report.photos : [];
  const photos = photoSrc.map((p) => projectPhoto(p, infra)).filter((p): p is SpillPhotoView => !!p);
  const video = projectVideo(manifest.video || report.video, infra);
  const deliveries = (extras.deliveries || []).map(projectDelivery).filter((d): d is SpillDeliveryView => !!d);
  const auditSrc = extras.audit || (Array.isArray(r.audit) ? r.audit : Array.isArray(report.audit) ? report.audit : []);
  const audit: SpillAuditView[] = auditSrc.map((a) => {
    const x = asRecord(a);
    if (!x) return null;
    return {
      atIso: isoFromUnknown(x.atIso || x.at || x.timestamp),
      actorUid: text(x.actorUid) || text(x.actor),
      actorName: text(x.actorName),
      action: text(x.action) || 'unknown',
      reason: text(x.reason) || text(x.detail),
      priorStatus: text(x.priorStatus) || text(x.from),
      resultingStatus: text(x.resultingStatus) || text(x.to),
    };
  }).filter((a): a is SpillAuditView => !!a);

  const notesSrc = Array.isArray(r.followUpNotes) ? r.followUpNotes : [];
  const followUpNotes = notesSrc.map((n) => {
    const x = asRecord(n);
    if (!x || !text(x.text)) return null;
    return { atIso: isoFromUnknown(x.atIso || x.at), actorName: text(x.actorName), text: text(x.text)! };
  }).filter((n): n is { atIso: string | null; actorName: string | null; text: string } => !!n);

  return {
    ...row,
    notifyRollup: rollupNotificationStatus({
      notificationsCreated: r.notificationsCreated,
      deliveries,
      workerDeployed: extras.workerDeployed === true,
      providerConfigured: extras.providerConfigured === true,
    }),
    schemaVersion: num(r.schemaVersion) ?? SPILL_SCHEMA_VERSION,
    material: text(report.material) || text(r.material),
    estimatedAmount: num(report.estimatedAmount) ?? text(report.estimatedAmount) ?? num(r.estimatedAmount) ?? text(r.estimatedAmount),
    amountUnit: text(report.amountUnit) || text(r.amountUnit),
    sourceCause: text(report.sourceCause) || text(r.sourceCause),
    flowState: text(report.flowState) || text(r.flowState),
    contained: typeof report.contained === 'boolean' ? report.contained : typeof r.contained === 'boolean' ? r.contained : null,
    waterwayThreat: typeof report.waterwayThreat === 'boolean' ? report.waterwayThreat : null,
    injuriesOrDanger: typeof report.injuriesOrDanger === 'boolean' ? report.injuriesOrDanger : null,
    actionsTaken: text(report.actionsTaken) || text(r.actionsTaken),
    emergencyServicesContacted: typeof report.emergencyServicesContacted === 'boolean' ? report.emergencyServicesContacted : null,
    notes: text(report.notes) || text(r.notes),
    gps: lat != null && lng != null ? {
      lat, lng,
      accuracy: num(gpsRaw?.accuracy),
      capturedAtIso: isoFromUnknown(gpsRaw?.capturedAtIso || gpsRaw?.capturedAt),
    } : null,
    operator: text(job.operator) || text(r.operator) || text(report.operator),
    wellName: text(job.wellName) || text(report.wellName) || text(r.wellName),
    hauledTo: text(job.hauledTo) || text(report.hauledTo) || text(r.hauledTo),
    truckNumber: text(report.truckNumber) || text(r.truckNumber),
    trailer: text(report.trailer) || text(r.trailer),
    createdAtIso: isoFromUnknown(r.createdAt || report.createdAtIso),
    submittedAtIso: isoFromUnknown(r.submittedAt),
    acceptedAtIso: isoFromUnknown(r.acceptedAt),
    notifyPolicyVersion: num(r.notifyPolicyVersion),
    notificationsCreated: r.notificationsCreated === true,
    photos,
    video,
    deliveries,
    audit,
    followUpOwner: text(r.followUpOwnerId) || text(r.assignedOwnerId),
    followUpNotes,
  };
}

export function filterSpillRows(rows: SpillListRow[], filter: SpillListFilter): SpillListRow[] {
  if (filter === 'all') return rows;
  return rows.filter((r) => !r.malformed && r.status === filter);
}

export function emptyListCopy(): string {
  return 'No spill incidents';
}
