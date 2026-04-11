import { getFirestoreDb } from './firebase';
import { collection, getDocs, getDoc, doc, query, orderBy, limit, where } from 'firebase/firestore';

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

export async function fetchTickets(limitCount = 200): Promise<Ticket[]> {
  const db = getFirestoreDb();

  // Try ordering by createdAt (newest first). Falls back to ticketNumber if createdAt missing.
  let q;
  try {
    q = query(
      collection(db, 'tickets'),
      orderBy('createdAt', 'desc'),
      limit(limitCount)
    );
    const snapshot = await getDocs(q);
    if (snapshot.size > 0) {
      return snapshot.docs.map(mapTicketDoc);
    }
  } catch {
    // Index may not exist yet — fall back to ticketNumber ordering
  }

  // Fallback: order by ticketNumber (legacy)
  q = query(
    collection(db, 'tickets'),
    orderBy('ticketNumber', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(mapTicketDoc);
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
    qty: d.qty || '',
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
