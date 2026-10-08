import * as httpsV2 from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { requireSecureDriver } from './requireDriverAuth';
import { loadVerifiedRevisionFromData, parseDispatchId, parsePacketRef, requireCompleteBinding, resolveCanonicalJobType, verifyDispatchPinsAgainstEnvelope } from './operational/dispatchPacketPin';
import { REVISION_COLLECTION, revisionDocId } from './operational/jobPacketRevisionStore';

type Stop = { dispatchId: string; name: string; latitude?: number; longitude?: number; destinationType?: string; plannedBbls?: number };
const name = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const invalid = (message: string): never => { throw new httpsV2.HttpsError('invalid-argument', message); };
function parseStop(raw: unknown, field: string): Stop {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid(`${field}_required`);
  const stop = raw as Record<string, unknown>;
  if (Object.keys(stop).some(key => !['dispatchId', 'name', 'latitude', 'longitude', 'destinationType', 'plannedBbls'].includes(key))) return invalid(`${field}_unexpected_field`);
  const id = parseDispatchId(stop.dispatchId);
  if (!id.ok) return invalid(`${field}_invalid_id`);
  const location = name(stop.name);
  if (!location) return invalid(`${field}_name_required`);
  const planned = stop.plannedBbls;
  if (planned !== undefined && (typeof planned !== 'number' || !Number.isFinite(planned) || planned < 0)) return invalid(`${field}_invalid_bbls`);
  for (const coord of ['latitude', 'longitude'] as const) {
    if (stop[coord] !== undefined && (typeof stop[coord] !== 'number' || !Number.isFinite(stop[coord]))) return invalid(`${field}_invalid_${coord}`);
  }
  if (stop.destinationType !== undefined && !['well', 'swd', 'location', 'custom'].includes(name(stop.destinationType))) return invalid(`${field}_invalid_destination_type`);
  return { dispatchId: id.dispatchId, name: location,
    ...(stop.latitude !== undefined ? { latitude: stop.latitude as number } : {}),
    ...(stop.longitude !== undefined ? { longitude: stop.longitude as number } : {}),
    ...(stop.destinationType !== undefined ? { destinationType: name(stop.destinationType) } : {}),
    ...(planned !== undefined ? { plannedBbls: planned as number } : {}),
  };
}

/** Convert an active single dispatch to A, and create on-site B (optional C) atomically. */
export const startPickupSplit = httpsV2.onCall(
  { timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false },
  async request => {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new httpsV2.HttpsError('failed-precondition', 'unscoped_driver');
    const raw = (request.data || {}) as Record<string, unknown>;
    if (Object.keys(raw).some(key => !['parentDispatchId', 'invoiceDocId', 'pickupBbls', 'firstStop', 'remainingStop'].includes(key))) return invalid('unexpected_field');
    const parsed = parseDispatchId(raw.parentDispatchId);
    if (!parsed.ok) return invalid('parent_dispatch_id_required');
    const invoiceDocId = name(raw.invoiceDocId);
    if (!invoiceDocId || invoiceDocId.includes('/')) return invalid('invoice_doc_id_required');
    const first = parseStop(raw.firstStop, 'first_stop');
    const remaining = raw.remainingStop == null ? null : parseStop(raw.remainingStop, 'remaining_stop');
    if (new Set([parsed.dispatchId, first.dispatchId, remaining?.dispatchId].filter(Boolean)).size !== (remaining ? 3 : 2)) return invalid('duplicate_dispatch_id');
    const pickupBbls = raw.pickupBbls;
    if (pickupBbls !== undefined && (typeof pickupBbls !== 'number' || !Number.isFinite(pickupBbls) || pickupBbls < 0)) return invalid('invalid_pickup_bbls');
    if (first.plannedBbls !== undefined && pickupBbls !== undefined && first.plannedBbls > pickupBbls) return invalid('planned_bbls_exceed_pickup');
    if (remaining?.plannedBbls !== undefined && first.plannedBbls !== undefined && pickupBbls !== undefined && first.plannedBbls + remaining.plannedBbls > pickupBbls) return invalid('planned_bbls_exceed_pickup');
    const fs = admin.firestore();
    const parentRef = fs.collection('dispatches').doc(parsed.dispatchId);
    const invoiceRef = fs.collection('invoices').doc(invoiceDocId);
    const childRefs = [first, ...(remaining ? [remaining] : [])].map(stop => fs.collection('dispatches').doc(stop.dispatchId));
    const splitGroupId = `split_${parsed.dispatchId}`;
    const result = await fs.runTransaction(async tx => {
      const [parentSnap, invoiceSnap, ...childSnaps] = await Promise.all([
        tx.get(parentRef), tx.get(invoiceRef), ...childRefs.map(ref => tx.get(ref)),
      ]);
      if (!parentSnap.exists || !invoiceSnap.exists) throw new httpsV2.HttpsError('not-found', 'active_job_missing');
      const parent = parentSnap.data() as Record<string, unknown>;
      const invoice = invoiceSnap.data() as Record<string, unknown>;
      if (name(parent.companyId) !== driver.companyId || name(parent.driverId) !== driver.driverId || name(invoice.companyId) !== driver.companyId || name(invoice.dispatchId) !== parsed.dispatchId) {
        throw new httpsV2.HttpsError('permission-denied', 'job_owner_mismatch');
      }
      if (['closed', 'cancelled'].includes(name(invoice.status))) throw new httpsV2.HttpsError('failed-precondition', 'invoice_closed');
      const bound = requireCompleteBinding(parent);
      if (!bound.ok) throw new httpsV2.HttpsError('failed-precondition', 'dispatch_binding_unverified');
      const packetRef = parsePacketRef({ packageId: bound.binding.packageId, revision: bound.binding.packetRevision });
      if (!packetRef.ok) throw new httpsV2.HttpsError('failed-precondition', 'dispatch_packet_invalid');
      const revisionId = revisionDocId(driver.companyId, packetRef.packetRef.packageId, packetRef.packetRef.revision);
      const [revisionSnap, companySnap] = await Promise.all([
        tx.get(fs.collection(REVISION_COLLECTION).doc(revisionId)),
        tx.get(fs.collection('companies').doc(driver.companyId)),
      ]);
      const verified = await loadVerifiedRevisionFromData(revisionSnap.exists, revisionSnap.data() as Record<string, unknown> | undefined, driver.companyId, packetRef.packetRef);
      if (!verified.ok) throw new httpsV2.HttpsError('failed-precondition', 'dispatch_packet_revision_invalid');
      const company = companySnap.data() as Record<string, unknown> | undefined;
      const customTypes = Array.isArray(company?.customJobTypes) ? company.customJobTypes : undefined;
      const pins = verifyDispatchPinsAgainstEnvelope(parent, verified.envelope, driver.companyId, customTypes);
      if (!pins.ok) throw new httpsV2.HttpsError('failed-precondition', 'dispatch_packet_pins_invalid');
      const jobTypeId = name(parent.jobTypeId) || name(parent.jobType);
      if (!['service-work', 'pw'].includes(jobTypeId)) throw new httpsV2.HttpsError('failed-precondition', 'job_type_not_supported');
      const targetJobTypeId = jobTypeId === 'pw' ? 'service-work' : jobTypeId;
      const targetJobType = resolveCanonicalJobType(targetJobTypeId, verified.envelope.jobTypes, customTypes);
      // PW has no splitTicket grant. A pickup split explicitly converts it to
      // Service Work, whose grant must be present in this pinned revision.
      if (!targetJobType.ok || !targetJobType.capabilities?.includes('splitTicket')) throw new httpsV2.HttpsError('failed-precondition', 'split_ticket_not_authorized');
      const convertedToServiceWork = jobTypeId === 'pw';
      const status = name(parent.status);
      if (['completed', 'cancelled', 'declined', 'dismissed'].includes(status)) throw new httpsV2.HttpsError('failed-precondition', 'job_closed');
      const stage = name(parent.driverStage);
      if (stage && !['on_site_pickup', 'en_route_dropoff'].includes(stage)) throw new httpsV2.HttpsError('failed-precondition', 'job_not_at_pickup_or_dropoff_route');
      const previousGroup = name(parent.splitGroupId);
      if (previousGroup) {
        const requestedStops = [first, ...(remaining ? [remaining] : [])];
        const replay = previousGroup === splitGroupId && name(parent.disposal) === first.name &&
          childSnaps.every((snap, i) => snap.exists &&
            name(snap.data()?.parentDispatchId) === parsed.dispatchId &&
            name(snap.data()?.disposal) === requestedStops[i].name);
        if (!replay) throw new httpsV2.HttpsError('already-exists', 'job_already_split');
        return { result: 'already_exists' as const,
          convertedToServiceWork: name(parent.splitConvertedFromJobTypeId) === 'pw' };
      }
      if (childSnaps.some(snap => snap.exists)) throw new httpsV2.HttpsError('already-exists', 'child_dispatch_id_in_use');
      const timeline = Array.isArray(invoice.timeline) ? invoice.timeline as Array<Record<string, unknown>> : [];
      const departedPickup = stage === 'en_route_dropoff' || timeline.some(event => event.type === 'depart_site');
      if (departedPickup && pickupBbls !== undefined) throw new httpsV2.HttpsError('failed-precondition', 'pickup_bbls_locked_after_depart');
      const total = remaining ? 3 : 2;
      const child = (stop: Stop, sequence: number) => ({
        driverId: parent.driverId, driverHash: parent.driverHash ?? parent.driverId,
        driverName: parent.driverName ?? null, driverFirstName: parent.driverFirstName ?? null,
        companyId: parent.companyId, operator: parent.operator ?? null,
        wellName: stop.name, ndicWellName: '', disposal: stop.name,
        pickupWellName: first.name,
        disposalLat: stop.latitude ?? null,
        disposalLng: stop.longitude ?? null,
        destinationType: stop.destinationType ?? null,
        jobType: convertedToServiceWork ? 'Service Work' : parent.jobType,
        jobTypeId: targetJobTypeId,
        serviceType: convertedToServiceWork ? 'Service Work' : (parent.serviceType ?? null),
        ...bound.binding, priority: parent.priority ?? 5, onsiteBy: parent.onsiteBy ?? null,
        splitGroupId, splitSequence: sequence, splitTotal: total,
        parentDispatchId: parsed.dispatchId, status: 'pending',
        notes: `Split ticket ${String.fromCharCode(64 + sequence)} — ${stop.plannedBbls !== undefined ? `Planned delivery ${stop.plannedBbls} BBL — ` : ''}${name(parent.notes) || name(parent.serviceType) || 'Service Work'}`,
        assignedBy: `driver:${driver.driverId}`, source: 'driver', loadCount: 1, loadsCompleted: 0,
        assignedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
      });
      tx.update(parentRef, {
        ...(convertedToServiceWork ? {
          jobType: 'Service Work', jobTypeId: 'service-work', serviceType: 'Service Work',
          splitConvertedFromJobTypeId: 'pw',
        } : {}),
        disposal: first.name,
        disposalLat: first.latitude ?? null,
        disposalLng: first.longitude ?? null,
        destinationType: first.destinationType ?? null,
        ...(pickupBbls !== undefined ? { bbls: pickupBbls } : {}),
        splitGroupId, splitSequence: 1, splitTotal: total, updatedAt: FieldValue.serverTimestamp(),
      });
      tx.update(invoiceRef, {
        ...(convertedToServiceWork ? { commodityType: 'Service Work', jobTypeId: 'service-work' } : {}),
        hauledTo: first.name,
        hauledToLat: first.latitude ?? null,
        hauledToLng: first.longitude ?? null,
        ...(departedPickup ? { enRouteDestName: first.name, enRouteDestLat: first.latitude ?? null, enRouteDestLng: first.longitude ?? null } : {}),
        dispatchSplitGroupId: splitGroupId, dispatchSplitSequence: 1, dispatchSplitTotal: total,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.create(childRefs[0], child(first, 2));
      if (remaining) tx.create(childRefs[1], child(remaining, 3));
      return { result: 'created' as const, convertedToServiceWork };
    });
    return { ok: true, ...result, splitGroupId, splitTotal: remaining ? 3 : 2,
      childDispatchIds: [first.dispatchId, ...(remaining ? [remaining.dispatchId] : [])] };
  },
);
