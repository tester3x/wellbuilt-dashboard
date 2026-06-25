import { getFirestoreDb } from './firebase';
import { collection, getDocs, getDoc, doc, query, orderBy, limit, where, startAfter, Timestamp, type QueryConstraint, type QueryDocumentSnapshot, type DocumentData } from 'firebase/firestore';

export interface Ticket {
  id: string;
  ticketNumber: string;
  date: string;
  company: string;
  companyId: string;
  location: string;
  hauledTo: string;
  type: string;
  qty: string;
  bbls: string;
  // Split-tickets bbls split. Mirror qty/bbls for normal tickets; for s_t
  // chains (split-tickets feature) they diverge: ticket A → pickup=N,
  // dropoff=0 (water stays in truck); ticket B/C → pickup=0, dropoff=N
  // (delivered amount). When undefined (legacy tickets), renderers fall
  // back to qty/bbls.
  pickupBbls?: number;
  dropoffBbls?: number;
  splitChainId?: string;
  splitChainSeq?: number;
  top: string;
  bottom: string;
  driver: string;
  truck: string;
  trailer: string;
  notes: string;
  apiNo: string;
  invoiceNumber: string;
  invoiceDocId: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  submittedBy: string;
  updatedBy: string;
  // Status / void
  status: string; // 'active' | 'void'
  voidedAt: Date | null;
  // GPS / location
  gpsLat: string;
  gpsLng: string;
  legalDesc: string;
  county: string;
  fieldName: string;
  disposalApiNo: string;
  disposalGpsLat: string;
  disposalGpsLng: string;
  hauledToLegalDesc: string;
  hauledToCounty: string;
  hauledToOperator: string;
  // Time
  startTime: string;
  stopTime: string;
  hours: string;
  timeGauged: string;
  // Package / aggregate
  packageId: string;
  materialType: string;
  grossWeight: string;
  tareWeight: string;
  netWeight: string;
  tons: string;
  sourceName: string;
  deliverySite: string;
  customer: string;
  // Split
  splitGroupId: string;
  splitRole: string;
  state: string;
  operator: string;
}

export interface TimelineEvent {
  type: 'depart' | 'arrive' | 'depart_site' | 'close' | 'pause' | 'resume' | 'transfer';
  timestamp: string;
  lat: number | null;
  lng: number | null;
  source: string;
  locationName: string | null;
  leg: number;
  reason?: string;
}

export interface InvoiceDetail {
  id: string;
  invoiceNumber: string;
  status: string;
  driver: string;
  wellName: string;
  operator: string;
  hauledTo: string;
  totalBBL: number;
  totalHours: number;
  commodityType: string;
  date: string;
  tickets: string[];
  timeline: TimelineEvent[];
  createdAt: Date | null;
  closedAt: Date | null;
  voidedAt: Date | null;
  voidReason: string;
  fuelMinutes: number;
  swdWaitMinutes: number;
  actualDriveMinutes: number;
  driveDistanceMiles: number;
  startTime: string;
  stopTime: string;
  truckNumber: string;
  trailer: string;
  splitGroupId: string;
  haulGroupId: string;
  packageId: string;
  driverState: string;
  notes: string;
  photos: Array<{ uri: string; location?: string; type?: string; takenAt?: string } | string>;
}

export interface FetchTicketsOptions {
  /** Scope to this company. When set, query adds where('companyId','==',companyId). */
  companyId?: string | null;
  /** Platform-admin global view (no company filter). Ignored when companyId is set. */
  isGlobal?: boolean;
  /** Page size. Default 200 (a page/group size, NOT a total cap). */
  limitCount?: number;
  /** startAfter cursor for the next page (the lastDoc of the prior page). */
  cursor?: QueryDocumentSnapshot<DocumentData> | null;
  startDate?: Date | null;
  endDate?: Date | null;
}

export interface TicketsPage {
  tickets: Ticket[];
  firstDoc: QueryDocumentSnapshot<DocumentData> | null;
  lastDoc: QueryDocumentSnapshot<DocumentData> | null;
  /** True when another page exists after this one. */
  hasMore: boolean;
}

/**
 * Tenant-scoped, paginated ticket fetch.
 * - Customer admin: pass companyId → query filters where('companyId','==',companyId).
 * - Platform admin: pass isGlobal:true for an unscoped view, or a companyId to scope.
 * - Neither companyId nor isGlobal → returns empty (never leaks global data).
 * `limitCount` is the PAGE size; use `cursor` (prior page's lastDoc) for Next.
 */
export async function fetchTickets(opts: FetchTicketsOptions = {}): Promise<TicketsPage> {
  const { companyId = null, isGlobal = false, limitCount = 200, cursor = null, startDate = null, endDate = null } = opts;
  const db = getFirestoreDb();
  const EMPTY: TicketsPage = { tickets: [], firstDoc: null, lastDoc: null, hasMore: false };

  // A scoped fetch requires a company; only a platform admin may go global.
  if (!companyId && !isGlobal) return EMPTY;

  const build = (orderField: 'createdAt' | 'ticketNumber') => {
    const c: QueryConstraint[] = [];
    if (companyId) c.push(where('companyId', '==', companyId));
    if (orderField === 'createdAt') {
      if (startDate) c.push(where('createdAt', '>=', Timestamp.fromDate(startDate)));
      if (endDate) c.push(where('createdAt', '<=', Timestamp.fromDate(endDate)));
    }
    c.push(orderBy(orderField, 'desc'));
    if (cursor) c.push(startAfter(cursor));
    c.push(limit(limitCount + 1)); // +1 sentinel to detect a following page
    return query(collection(db, 'tickets'), ...c);
  };

  let snapshot;
  try {
    snapshot = await getDocs(build('createdAt'));
  } catch (e) {
    // Composite index (companyId + createdAt) missing or createdAt absent —
    // degrade to ticketNumber ordering (drops date-range filtering).
    console.warn('[tickets] createdAt query failed, falling back to ticketNumber:', e);
    snapshot = await getDocs(build('ticketNumber'));
  }

  const docs = snapshot.docs;
  const hasMore = docs.length > limitCount;
  const pageDocs = hasMore ? docs.slice(0, limitCount) : docs;
  return {
    tickets: pageDocs.map(mapTicketDoc),
    firstDoc: pageDocs[0] ?? null,
    lastDoc: pageDocs[pageDocs.length - 1] ?? null,
    hasMore,
  };
}

/** Fetch the parent invoice for a ticket (by invoiceDocId or invoiceNumber lookup) */
export async function fetchInvoiceForTicket(ticket: Ticket): Promise<InvoiceDetail | null> {
  const db = getFirestoreDb();

  // Try direct doc lookup first
  if (ticket.invoiceDocId) {
    try {
      const snap = await getDoc(doc(db, 'invoices', ticket.invoiceDocId));
      if (snap.exists()) return mapInvoiceDetail(snap);
    } catch { /* fall through */ }
  }

  // Fallback: query by invoiceNumber
  if (ticket.invoiceNumber) {
    try {
      const q = query(
        collection(db, 'invoices'),
        where('invoiceNumber', '==', ticket.invoiceNumber),
        limit(1)
      );
      const snap = await getDocs(q);
      if (!snap.empty) return mapInvoiceDetail(snap.docs[0]);
    } catch { /* fall through */ }
  }

  // Fallback: query by ticketNumber. ticket_only invoices have an empty
  // invoiceNumber and the tickets-collection doc often lacks invoiceDocId, so
  // the two lookups above can't reach them — but the invoice still carries the
  // ticketNumber (and a tickets[] array). Without this, photos + AI compliance
  // never surface for ticket_only jobs (e.g. Liquid Gold / Slawson SW).
  if (ticket.ticketNumber) {
    try {
      const q = query(
        collection(db, 'invoices'),
        where('ticketNumber', '==', ticket.ticketNumber),
        limit(1)
      );
      const snap = await getDocs(q);
      if (!snap.empty) return mapInvoiceDetail(snap.docs[0]);
    } catch { /* fall through */ }
    try {
      const q = query(
        collection(db, 'invoices'),
        where('tickets', 'array-contains', ticket.ticketNumber),
        limit(1)
      );
      const snap = await getDocs(q);
      if (!snap.empty) return mapInvoiceDetail(snap.docs[0]);
    } catch { /* fall through */ }
  }

  return null;
}

/** Fetch sibling tickets that share the same invoice */
export async function fetchSiblingTickets(invoiceNumber: string, excludeTicketId: string): Promise<Ticket[]> {
  if (!invoiceNumber) return [];
  const db = getFirestoreDb();
  try {
    const q = query(
      collection(db, 'tickets'),
      where('invoiceNumber', '==', invoiceNumber),
      limit(20)
    );
    const snap = await getDocs(q);
    return snap.docs.map(mapTicketDoc).filter(t => t.id !== excludeTicketId);
  } catch {
    return [];
  }
}

function mapTicketDoc(doc: any): Ticket {
  const d = doc.data();
  return {
    id: doc.id,
    ticketNumber: d.ticketNumber || '',
    date: d.date || '',
    company: d.company || '',
    companyId: d.companyId || '',
    location: d.location || d.wellName || '',
    hauledTo: d.hauledTo || d.disposal || '',
    type: d.type || d.commodityType || '',
    qty: d.qty || d.bbls || '',
    bbls: d.bbls || d.qty || '',
    top: d.top || '',
    bottom: d.bottom || '',
    driver: d.driver || '',
    truck: d.truck || '',
    trailer: d.trailer || '',
    notes: d.notes || '',
    apiNo: d.apiNo || '',
    invoiceNumber: d.invoiceNumber || '',
    invoiceDocId: d.invoiceDocId || '',
    createdAt: d.createdAt?.toDate?.() || null,
    updatedAt: d.updatedAt?.toDate?.() || null,
    submittedBy: d.submittedBy || '',
    updatedBy: d.updatedBy || '',
    status: d.status === 'void' ? 'void' : 'active',
    voidedAt: d.voidedAt?.toDate?.() || null,
    gpsLat: d.gpsLat || '',
    gpsLng: d.gpsLng || '',
    legalDesc: d.legalDesc || '',
    county: d.county || '',
    fieldName: d.fieldName || '',
    disposalApiNo: d.disposalApiNo || '',
    disposalGpsLat: d.disposalGpsLat || '',
    disposalGpsLng: d.disposalGpsLng || '',
    hauledToLegalDesc: d.hauledToLegalDesc || '',
    hauledToCounty: d.hauledToCounty || '',
    hauledToOperator: d.hauledToOperator || '',
    startTime: d.startTime || '',
    stopTime: d.stopTime || '',
    hours: d.hours || '',
    timeGauged: d.timeGauged || '',
    packageId: d.packageId || '',
    materialType: d.materialType || '',
    grossWeight: d.grossWeight || '',
    tareWeight: d.tareWeight || '',
    netWeight: d.netWeight || '',
    tons: d.tons || '',
    sourceName: d.sourceName || '',
    deliverySite: d.deliverySite || '',
    customer: d.customer || '',
    splitGroupId: d.splitGroupId || '',
    splitRole: d.splitRole || '',
    state: d.state || '',
    operator: d.operator || '',
  };
}

function mapInvoiceDetail(snap: any): InvoiceDetail {
  const d = snap.data();
  return {
    id: snap.id,
    invoiceNumber: d.invoiceNumber || '',
    status: d.status || 'open',
    driver: d.driver || '',
    wellName: d.wellName || '',
    operator: d.operator || '',
    hauledTo: d.hauledTo || '',
    totalBBL: d.totalBBL || 0,
    totalHours: d.totalHours || 0,
    commodityType: d.commodityType || '',
    date: d.date || '',
    tickets: d.tickets || [],
    timeline: (d.timeline || []).map((e: any) => ({
      type: e.type || '',
      timestamp: e.timestamp || '',
      lat: e.lat ?? null,
      lng: e.lng ?? null,
      source: e.source || '',
      locationName: e.locationName || null,
      leg: e.leg || 1,
      reason: e.reason,
    })),
    createdAt: d.createdAt?.toDate?.() || null,
    closedAt: d.closedAt?.toDate?.() || null,
    voidedAt: d.voidedAt?.toDate?.() || null,
    voidReason: d.voidReason || '',
    fuelMinutes: d.fuelMinutes || 0,
    swdWaitMinutes: d.swdWaitMinutes || 0,
    actualDriveMinutes: d.actualDriveMinutes || 0,
    driveDistanceMiles: d.driveDistanceMiles || 0,
    startTime: d.startTime || '',
    stopTime: d.stopTime || '',
    truckNumber: d.truckNumber || '',
    trailer: d.trailer || '',
    splitGroupId: d.splitGroupId || '',
    haulGroupId: d.haulGroupId || '',
    packageId: d.packageId || '',
    driverState: d.driverState || '',
    notes: d.notes || '',
    photos: d.photos || [],
  };
}
