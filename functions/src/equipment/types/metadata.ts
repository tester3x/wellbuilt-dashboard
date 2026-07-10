import { ActorRef } from './actor';

/** Standard metadata stamped on canonical eQuipment records. */
export interface RecordMetadata {
  createdAt: string;
  createdBy: ActorRef;
  updatedAt: string;
  updatedBy: ActorRef;
}

export function buildMetadata(
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