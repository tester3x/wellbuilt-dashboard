export type ShopStatus = 'reported' | 'working' | 'ready' | 'closed';
export interface ShopOrder {
  id: string; companyId: string; driverId: string; equipmentType: 'truck' | 'trailer';
  equipmentNumber: string; title: string; description: string; outOfService: boolean;
  status: ShopStatus; assignedTo: string; repairNotes: string; scheduledDate: string | null;
  photoCount: number; revision: number; createdAt: string; updatedAt: string;
  signedOffBy: string | null; signedOffAt: string | null;
}
export interface ShopActor { uid: string; driverId: string; companyId: string; displayName: string; staff: boolean }
export function shopText(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`Invalid ${field}`);
  const s = value.trim(); if (required && !s) throw new Error(`Enter ${field}`); return s;
}
export function shopId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw new Error('Invalid report ID'); return value;
}
export function shopCanRead(order: ShopOrder, actor: ShopActor): boolean {
  return order.companyId === actor.companyId && (actor.staff || order.driverId === actor.driverId);
}
export function shopPhotos(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('Attach up to three photos');
  return value.map(x => {
    if (typeof x !== 'string' || x.length > 250000 || !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(x)) throw new Error('Invalid or oversized photo');
    return x;
  });
}
export function newShopOrder(raw: Record<string, unknown>, actor: ShopActor, at: string): ShopOrder {
  if (!['truck','trailer'].includes(String(raw.equipmentType)) || typeof raw.outOfService !== 'boolean') throw new Error('Choose equipment and service status');
  const scheduledDate = raw.scheduledDate ? shopText(raw.scheduledDate, 'service date', 10) : null;
  if (scheduledDate && (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate) || new Date(scheduledDate+'T00:00:00Z').toISOString().slice(0,10) !== scheduledDate)) throw new Error('Invalid service date');
  return { id: shopId(raw.id), companyId: actor.companyId, driverId: actor.driverId,
    equipmentType: raw.equipmentType as 'truck' | 'trailer', equipmentNumber: shopText(raw.equipmentNumber,'equipment number',40),
    title: shopText(raw.title,'problem title',100), description: shopText(raw.description,'description',2000),
    outOfService: raw.outOfService, status: 'reported', assignedTo: '', repairNotes: '', scheduledDate,
    photoCount: shopPhotos(raw.photos ?? []).length, revision: 1, createdAt: at, updatedAt: at, signedOffBy: null, signedOffAt: null };
}
export function updateShopOrder(order: ShopOrder, raw: Record<string, unknown>, actor: ShopActor, at: string): ShopOrder {
  if (!actor.staff || order.companyId !== actor.companyId) throw new Error('Shop access required');
  if (raw.revision !== order.revision) throw new Error('This report changed. Refresh before saving.');
  if (order.status === 'closed') throw new Error('Signed-off reports are read-only');
  const action = raw.action;
  if (!['work','ready','signoff','reopen'].includes(String(action))) throw new Error('Invalid repair action');
  if (action === 'signoff' && order.status !== 'ready') throw new Error('Mark repair ready for review before signing off');
  if (action === 'ready' && order.status !== 'working') throw new Error('Start work before marking ready');
  const notes = shopText(raw.repairNotes ?? order.repairNotes,'repair notes',4000, action === 'ready' || action === 'signoff');
  const assignedTo = shopText(raw.assignedTo ?? order.assignedTo,'mechanic',100,false);
  const status: ShopStatus = action === 'signoff' ? 'closed' : action === 'ready' ? 'ready' : 'working';
  return { ...order, status, assignedTo, repairNotes: notes, revision: order.revision+1, updatedAt: at,
    // A completed repair does not release equipment until a separate approval.
    outOfService: action === 'signoff' ? false : order.outOfService,
    signedOffBy: action === 'signoff' ? actor.displayName : null,
    signedOffAt: action === 'signoff' ? at : null };
}
