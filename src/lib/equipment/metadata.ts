/**
 * Shared metadata types for all canonical eQuipment records.
 * Kept aligned with functions/src/equipment/types/metadata.ts
 */

export type ActorRef =
  | { type: 'driver'; driverHash: string; displayName?: string }
  | { type: 'dashboard'; uid: string; displayName?: string }
  | { type: 'system'; reason?: string };

export interface RecordMetadata {
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

export function buildRecordMetadata(
  actor: ActorRef,
  existing?: Partial<RecordMetadata>,
): RecordMetadata {
  const now = new Date().toISOString();
  return {
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || actor,
    updatedAt: now,
    updatedBy: actor,
  };
}