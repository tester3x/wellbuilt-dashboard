import type { InvoiceSourceRecord, TicketSourceRecord } from '../types';

/** Synthetic ticket-only Water Ticket #20100. Not a production record. */
export const TICKET_20100_ID = 'ticket-20100-doc';
export const INVOICE_20100_ID = 'invoice-shell-20100';
export const COMPANY_LG = 'liquid-gold';

export const ticket20100: TicketSourceRecord = {
  id: TICKET_20100_ID,
  ticketNumber: '20100',
  date: '08/23/2026',
  company: 'Kraken Oil & Gas',
  companyId: COMPANY_LG,
  operator: 'Kraken Oil & Gas',
  location: 'KAHUNA 2',
  hauledTo: 'HYDRO CLEAR SWD',
  driver: 'Mike ZFold7 Burger',
  truck: '102',
  trailer: 'T30',
  qty: '90',
  bbls: '90',
  pickupBbls: 90,
  dropoffBbls: 90,
  top: '12′1″',
  bottom: '7′8″',
  invoiceNumber: '',
  invoiceDocId: INVOICE_20100_ID,
  submittedBy: '2cad521c-13ac-4b6c-b1ab-07843c6bf06f',
  createdAtMs: Date.parse('2026-08-23T18:17:00.000Z'),
};

export const invoice20100: InvoiceSourceRecord = {
  id: INVOICE_20100_ID,
  invoiceNumber: '',
  invoicingMode: 'ticket_only',
  operator: 'Kraken Oil & Gas',
  wellName: 'KAHUNA 2',
  hauledTo: 'HYDRO CLEAR SWD',
  driver: 'Mike ZFold7 Burger',
  truckNumber: '102',
  trailer: 'T30',
  totalBBL: 90,
  totalHours: 0,
  invoiceStartedAt: '2026-08-23T18:17:00.000Z',
  companyId: COMPANY_LG,
  tickets: ['20100'],
  timeline: [
    { type: 'depart', timestamp: '2026-08-23T18:17:00.000Z', locationName: 'Yard' },
    { type: 'arrive', timestamp: '2026-08-23T18:42:00.000Z', locationName: 'KAHUNA 2' },
    { type: 'depart_site', timestamp: '2026-08-23T19:05:00.000Z', locationName: 'KAHUNA 2' },
    { type: 'arrive', timestamp: '2026-08-23T19:40:00.000Z', locationName: 'HYDRO CLEAR SWD' },
    { type: 'depart_site', timestamp: '2026-08-23T20:01:00.000Z', locationName: 'HYDRO CLEAR SWD' },
    { type: 'close', timestamp: '2026-08-23T20:10:00.000Z', locationName: 'HYDRO CLEAR SWD' },
  ],
  photos: [
    { uri: 'https://storage.example/b.jpg', type: 'dropoff', location: 'HYDRO CLEAR SWD', takenAt: '2026-08-23T19:50:00.000Z' },
    { uri: 'https://storage.example/a.jpg', type: 'pickup', location: 'KAHUNA 2', takenAt: '2026-08-23T18:50:00.000Z' },
    { uri: 'https://storage.example/jsa.pdf', type: 'jsa' },
  ],
};

export const staffLg = { uid: 'staff-lg', companyId: COMPANY_LG, isPlatformAdmin: false };
export const staffOther = { uid: 'staff-other', companyId: 'other-co', isPlatformAdmin: false };
export const platformAdmin = { uid: 'admin', isPlatformAdmin: true };
