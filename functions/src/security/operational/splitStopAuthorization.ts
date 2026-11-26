import { fail, type ImmutableRevisionEnvelope, type StoreResult } from './jobPacketRevisionStore';
import { DISPATCH_BINDING_KEYS, type DispatchBinding } from './dispatchPacketPin';

const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
const same = (a: unknown, b: unknown) => !!text(a) && text(a).toLowerCase() === text(b).toLowerCase();
type Row = Record<string, any>;

/** A later delivery is not another tank pull. Its authority still comes from
 * the authenticated owner, immutable pickup birth, pinned split grant and a
 * server-approved destination. This is never an alternative pickup allowlist. */
export async function authorizeSplitDeliveryStop(input: {
  dispatchId: string; record: Row; caller: {companyId: string; driverId: string};
  binding: DispatchBinding; jobTypeId: string; envelope: ImmutableRevisionEnvelope;
  getFamily: (group: string) => Promise<Array<{id: string; data: Row}>>;
  getBirth: (id: string) => Promise<Row | null>;
  sourceAllowed: (row: Row) => boolean;
  destinationAllowed: (row: Row) => Promise<boolean>;
}): Promise<StoreResult<{wellName: string}>> {
  const {record: r, caller: c} = input;
  const group = text(r.splitGroupId), seq = r.splitSequence, total = r.splitTotal;
  if (!group || group.length > 500 || group.includes('/') || !Number.isSafeInteger(seq) || seq < 2
      || !Number.isSafeInteger(total) || total < seq || total > 100) return fail('invalid_split_delivery');
  const grant = input.envelope.jobTypes.find(j => j.jobTypeId === input.jobTypeId);
  if (!grant?.capabilities.includes('splitTicket')
      || !input.envelope.capabilities.some(g => g.capabilityId === 'splitTicket')) return fail('split_ticket_not_authorized');
  if (!same(r.wellName, r.disposal || r.hauledTo)) return fail('split_delivery_stop_mismatch');
  const history = await input.getFamily(group);
  // Removed stops remain as audit records and can share an old sequence with
  // a survivor after resequencing. They never count as a live slot or anchor.
  // Even historical records must still belong to this exact owner and family.
  if (history.some(j => j.data.companyId !== c.companyId || j.data.driverId !== c.driverId
      || j.data.splitGroupId !== group)) return fail('split_family_owner_mismatch');
  const family = history.filter(j => !['cancelled','declined','dismissed'].includes(j.data.status));
  const sequences = family.map(j => j.data.splitSequence);
  if (family.length > total || sequences.some(n => !Number.isSafeInteger(n) || n < 1 || n > total)
      || new Set(sequences).size !== sequences.length) return fail('split_family_ambiguous');
  const anchors = family.filter(j => j.data.splitSequence === 1);
  if (anchors.length !== 1) return fail('split_anchor_unconfirmed');
  const anchor = anchors[0], a = anchor.data;
  if (a.builderOwnership?.kind !== 'driver' || a.builderOwnership.actorId !== c.driverId
      || !['pending','accepted','in_progress','paused','completed'].includes(a.status)
      || a.splitTotal !== total || a.jobTypeId !== input.jobTypeId
      || !same(a.operator, r.operator)
      || DISPATCH_BINDING_KEYS.some(k => a[k] !== input.binding[k])
      || !input.sourceAllowed(a)) return fail('split_anchor_unconfirmed');
  const occupied = family.filter(j => j.data.splitSequence === seq);
  if (occupied.some(j => j.id !== input.dispatchId)) return fail('split_sequence_conflict');
  const birth = await input.getBirth(anchor.id);
  if (!birth || birth.dispatchId !== anchor.id || birth.companyId !== c.companyId
      || birth.driverId !== c.driverId) return fail('split_anchor_birth_unconfirmed');
  if (!await input.destinationAllowed(r)) return fail('split_destination_not_authorized');
  return {ok: true, wellName: text(r.wellName)};
}
