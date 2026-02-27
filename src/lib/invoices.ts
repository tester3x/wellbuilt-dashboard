import { getFirestoreDb } from './firebase';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';

export type InvoiceStatus = 'open' | 'closed' | 'submitted' | 'approved' | 'paid';

export interface DashboardInvoice {
  id: string;
  invoiceNumber: string;
  operator: string;
  wellName: string;
  status: InvoiceStatus;
  totalBBL: number;
  totalHours: number;
  commodityType: string;
  driver: string;
  truckNumber: string;
  date: string;
  tickets: string[];
  notes: string;
}

export async function fetchInvoices(limitCount = 200): Promise<DashboardInvoice[]> {
  const db = getFirestoreDb();
  const q = query(
    collection(db, 'invoices'),
    orderBy('createdAt', 'desc'),
    limit(limitCount)
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => {
    const d = doc.data();
    return {
      id: doc.id,
      invoiceNumber: d.invoiceNumber || '',
      operator: d.operator || '',
      wellName: d.wellName || '',
      status: d.status || 'open',
      totalBBL: d.totalBBL || 0,
      totalHours: d.totalHours || 0,
      commodityType: d.commodityType || '',
      driver: d.driver || '',
      truckNumber: d.truckNumber || '',
      date: d.date || '',
      tickets: d.tickets || [],
      notes: d.notes || '',
    };
  });
}

export function getStatusColor(status: InvoiceStatus): string {
  switch (status) {
    case 'open': return 'bg-yellow-600/20 text-yellow-400';
    case 'closed': return 'bg-gray-600/20 text-gray-400';
    case 'submitted': return 'bg-blue-600/20 text-blue-400';
    case 'approved': return 'bg-green-600/20 text-green-400';
    case 'paid': return 'bg-green-600 text-white';
    default: return 'bg-gray-600/20 text-gray-400';
  }
}
