import type { InvoiceSourceRecord, PaperCaller, TicketSourceRecord } from '../types';

/** Synthetic ticket-only Water Ticket #20100. Not a production record. */
export const TICKET_20100_ID = 'ticket-20100-doc';
export const INVOICE_20100_ID = 'invoice-shell-20100';
export const COMPANY_LG = 'liquid-gold';
export const DRIVER_ZFOLD = '2cad521c-13ac-4b6c-b1ab-07843c6bf06f';
export const DRIVER_OTHER = '99ff4b35-51ab-4d45-8d54-18b3b8515c9b';
export const CLOSED_AT_MS = Date.parse('2026-08-23T20:10:00.000Z');

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
  submittedBy: DRIVER_ZFOLD,
  ownerDriverId: DRIVER_ZFOLD,
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
  closedAtMs: CLOSED_AT_MS,
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

export const PIXEL_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
export const PIXEL_B = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
export const JSA_BYTES = Buffer.from('%PDF-1.4 jsa-snapshot');

export const staffLg: PaperCaller = {
  kind: 'dashboard',
  uid: 'staff-lg',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  roles: ['manager'],
  caps: ['manageDrivers', 'viewTickets', 'viewDispatch'],
};
export const dispatchLg: PaperCaller = {
  kind: 'dashboard',
  uid: 'dispatch-lg',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  roles: ['dispatch'],
  caps: [],
};
export const payrollLg: PaperCaller = {
  kind: 'dashboard',
  uid: 'payroll-lg',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  roles: ['payroll'],
  caps: [],
};
export const staffOther: PaperCaller = {
  kind: 'dashboard',
  uid: 'staff-other',
  companyId: 'other-co',
  isPlatformAdmin: false,
  roles: ['manager'],
  caps: ['manageDrivers', 'viewTickets'],
};
export const platformAdmin: PaperCaller = {
  kind: 'dashboard',
  uid: 'admin',
  isPlatformAdmin: true,
  roles: ['it'],
  caps: ['viewAllCompanies', 'manageDrivers', 'viewTickets'],
};
export const driverOwner: PaperCaller = {
  kind: 'driver',
  uid: 'driver-auth',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  driverId: DRIVER_ZFOLD,
};
export const driverOther: PaperCaller = {
  kind: 'driver',
  uid: 'driver-other',
  companyId: COMPANY_LG,
  isPlatformAdmin: false,
  driverId: DRIVER_OTHER,
};
