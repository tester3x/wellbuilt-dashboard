/** Server-side projection for a driver's Suite payroll view. */
export type PayrollWindow = { start: Date; end: Date };

export function parsePayrollWindow(raw: unknown): PayrollWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  if (typeof input.startISO !== 'string' || typeof input.endISO !== 'string') return null;
  const start = new Date(input.startISO);
  const end = new Date(input.endISO);
  const span = end.getTime() - start.getTime();
  if (!Number.isFinite(span) || span < 0 || span > 32 * 24 * 60 * 60 * 1000) return null;
  return { start, end };
}

function str(value: unknown): string { return typeof value === 'string' ? value : ''; }
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function timestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toDate' in value) {
    const date = (value as { toDate: () => Date }).toDate();
    if (date instanceof Date && Number.isFinite(date.getTime())) return date.toISOString();
  }
  return str(value);
}

export function projectOwnPayrollInvoice(
  id: string,
  raw: Record<string, unknown>,
  companyId: string,
  trustedDriverIds: readonly string[],
): Record<string, unknown> | null {
  if (raw.companyId !== companyId) return null;
  const ownerFields = [raw.driverId, raw.driverHash, raw.driverUid, raw.driverKey];
  if (!ownerFields.some(value => typeof value === 'string' && trustedDriverIds.includes(value))) return null;

  const invoiceNumber = str(raw.invoiceNumber);
  const tickets = Array.isArray(raw.tickets) ? raw.tickets : [];
  const displayNumber = invoiceNumber && invoiceNumber !== 'N/A'
    ? invoiceNumber
    : str(raw.ticketNumber) || String(tickets[0] ?? '') || str(raw.wellName) || id.slice(0, 8);
  return {
    id,
    invoiceNumber: displayNumber,
    driver: str(raw.driver),
    operator: str(raw.operator),
    wellName: str(raw.wellName),
    hauledTo: str(raw.hauledTo),
    jobType: str(raw.commodityType) || str(raw.jobType),
    totalBBL: num(raw.totalBBL),
    totalHours: num(raw.totalHours) ?? 0,
    status: str(raw.status) || 'open',
    date: str(raw.date),
    createdAt: timestamp(raw.createdAt),
    county: str(raw.county),
    companyId,
    bblsField: num(raw.bbls),
    qtyField: typeof raw.qty === 'string' || typeof raw.qty === 'number' ? raw.qty : null,
    qtyUnit: str(raw.qtyUnit) || null,
    unit: str(raw.unit) || null,
    tons: num(raw.tons),
    netWeight: num(raw.netWeight),
    allocatedHours: num(raw.allocatedHours),
    observedHours: num(raw.observedHours),
    actualDriveMinutes: num(raw.actualDriveMinutes),
    allocationMethod: str(raw.splitTimeAllocation) || str(raw.allocationMethod) || null,
  };
}

export function projectOwnPayConfig(company: Record<string, unknown>): Record<string, unknown> {
  const pay = company.payConfig && typeof company.payConfig === 'object' && !Array.isArray(company.payConfig)
    ? company.payConfig as Record<string, unknown> : {};
  return {
    employeeSplit: num(pay.employeeSplit),
    defaultSplit: num(pay.defaultSplit),
    rateSheets: company.rateSheets && typeof company.rateSheets === 'object' && !Array.isArray(company.rateSheets)
      ? company.rateSheets : {},
    frostZones: pay.frostZones && typeof pay.frostZones === 'object' && !Array.isArray(pay.frostZones)
      ? pay.frostZones : {},
  };
}
