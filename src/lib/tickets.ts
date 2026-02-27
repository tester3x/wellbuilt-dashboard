import { getFirestoreDb } from './firebase';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';

export interface Ticket {
  id: string;
  ticketNumber: string;
  date: string;
  company: string;
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
  createdAt: Date | null;
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

function mapTicketDoc(doc: any): Ticket {
  const data = doc.data();
  return {
    id: doc.id,
    ticketNumber: data.ticketNumber || '',
    date: data.date || '',
    company: data.company || '',
    location: data.location || '',
    hauledTo: data.hauledTo || '',
    type: data.type || '',
    qty: data.qty || '',
    top: data.top || '',
    bottom: data.bottom || '',
    driver: data.driver || '',
    truck: data.truck || '',
    trailer: data.trailer || '',
    notes: data.notes || '',
    apiNo: data.apiNo || '',
    invoiceNumber: data.invoiceNumber || '',
    createdAt: data.createdAt?.toDate?.() || null,
  };
}
