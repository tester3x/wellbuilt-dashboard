const types = ['Production Water', 'Production Water (hr)', 'Service Work'] as const;
export type PickupJobType = typeof types[number];

export function pickupJobType(value: unknown): PickupJobType | undefined {
  return types.find(type => type === value);
}

export function pickupJobTypeFields(type: PickupJobType) {
  const production = type === 'Production Water';
  const hourlyWater = type === 'Production Water (hr)';
  return {
    commodityType: type,
    jobType: production ? 'pw' : 'service',
    jobTypeId: production ? 'pw' : 'service-work',
    serviceType: hourlyWater ? 'Production Water' : null,
    subjob: hourlyWater ? 'Production Water' : null,
  };
}

export function pickupTypeCorrectionState(input: {
  companyId: string;
  driverId: string;
  dispatchId: string;
  dispatch: Record<string, unknown>;
  invoice: Record<string, unknown>;
  from: PickupJobType;
  to: PickupJobType;
}): 'apply' | 'already_applied' | 'owner_mismatch' | 'pickup_locked' | 'type_changed' {
  const { dispatch, invoice, from, to } = input;
  if (dispatch.companyId !== input.companyId || invoice.companyId !== input.companyId
    || dispatch.driverId !== input.driverId || (invoice.driverHash || invoice.driverId) !== input.driverId
    || invoice.dispatchId !== input.dispatchId) {
    return 'owner_mismatch';
  }
  const timeline = Array.isArray(invoice.timeline) ? invoice.timeline : [];
  if (dispatch.status !== 'in_progress' || dispatch.driverStage !== 'on_site_pickup'
    || invoice.status !== 'open' || invoice.invoicingMode !== 'ticket_only'
    || timeline.some(event => event?.type === 'depart_site')
    || (Array.isArray(invoice.tickets) && invoice.tickets.length > 0)
    || [dispatch, invoice].some(row =>
      row.packetId || row.packetSentAt || row.haulGroupId || row.splitGroupId ||
      row.splitChainId || row.splitChainSeq || row.dispatchSplitGroupId ||
      row.transferSourceDocId || row.transferredToHash || row.lockedForTransfer
    )) {
    return 'pickup_locked';
  }
  const type = invoice.serviceType === 'Production Water'
    ? 'Production Water (hr)' : pickupJobType(invoice.commodityType);
  if (!type || dispatch.jobTypeId !== pickupJobTypeFields(type).jobTypeId) return 'type_changed';
  const correction = dispatch.pickupJobTypeCorrection as { from?: unknown; to?: unknown } | undefined;
  if (type === to && correction?.from === from && correction?.to === to) return 'already_applied';
  return type === from ? 'apply' : 'type_changed';
}
