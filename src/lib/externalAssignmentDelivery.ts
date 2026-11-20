import { httpsCallable } from 'firebase/functions';
import { getFirebaseFunctions } from './firebase';

export const STAFF_EXTERNAL_ASSIGNMENT_DELIVERY_CALLABLE = 'staffExternalAssignmentDelivery';

export type ExternalDeliveryChannel = 'sms' | 'whatsapp';

export type ExternalDriver = {
  externalDriverId: string;
  companyId: string;
  displayName: string;
  phoneE164: string;
  channels: ExternalDeliveryChannel[];
  active: boolean;
};

export type ExternalDelivery = {
  deliveryId: string;
  companyId: string;
  dispatchId: string;
  currentRevision: number;
  currentStatus: 'queued' | 'sent' | 'delivered' | 'accepted' | 'declined' | 'failed';
  assignmentState: 'active' | 'cancelled';
  externalDriverId: string;
  channel: ExternalDeliveryChannel;
  updatedAt: string;
  failureCode?: string;
};

async function invoke<T>(payload: Record<string, unknown>): Promise<T> {
  const callable = httpsCallable(getFirebaseFunctions(), STAFF_EXTERNAL_ASSIGNMENT_DELIVERY_CALLABLE);
  const result = await callable(payload);
  return result.data as T;
}

export async function listExternalDrivers(): Promise<ExternalDriver[]> {
  const result = await invoke<{ ok: true; drivers: ExternalDriver[] }>({ op: 'listRoster' });
  return result.drivers;
}

export async function saveExternalDriver(driver: Omit<ExternalDriver, 'companyId'>): Promise<ExternalDriver> {
  const result = await invoke<{ ok: true; driver: ExternalDriver }>({ op: 'upsertDriver', driver });
  return result.driver;
}

export async function listExternalDeliveries(): Promise<ExternalDelivery[]> {
  const result = await invoke<{ ok: true; deliveries: ExternalDelivery[] }>({ op: 'listDeliveries' });
  return result.deliveries;
}

export async function writeExternalDelivery(input: {
  op: 'queue' | 'retry' | 'reassign' | 'cancel';
  idempotencyKey: string;
  dispatchId?: string;
  deliveryId?: string;
  externalDriverId?: string;
  channel?: ExternalDeliveryChannel;
}): Promise<{
  ok: true;
  idempotent: boolean;
  delivery: ExternalDelivery;
  provider?: { configured: boolean; sent: boolean; reason?: string };
}> {
  return invoke(input);
}
