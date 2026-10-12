import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';
import { requireSecureDriver } from '../security/requireDriverAuth';
import { requireTrustedCompanyCapability } from '../security/trustedStaffAuthority';
import { newShopOrder, updateShopOrder, shopCanRead, shopId, shopPhotos, type ShopActor, type ShopOrder } from './shopModel';

/** Admin SDK only. No client rules or caller-supplied roles grant access. */
export const equipmentShop = onCall({ timeoutSeconds: 30, memory: '256MiB', enforceAppCheck: false }, async request => {
  const fs = admin.firestore();
  let actor: ShopActor;
  if (request.auth?.token.kind === 'driver') {
    const driver = await requireSecureDriver(request, { allowLegacyHash: false });
    if (!driver.companyId) throw new HttpsError('permission-denied','Company account required');
    const profile = (await admin.database().ref('drivers/profiles/'+driver.driverId).once('value')).val();
    if (!profile || profile.active === false || profile.companyId !== driver.companyId) throw new HttpsError('permission-denied','Active company profile required');
    const membership = await fs.collection('equipment_shop_access').doc(driver.companyId).collection('members').doc(driver.driverId).get();
    actor = { uid: driver.uid, driverId: driver.driverId, companyId: driver.companyId,
      displayName: profile.legalName || driver.displayName || driver.driverId, staff: membership.data()?.enabled === true };
  } else {
    const staff = await requireTrustedCompanyCapability(request.auth?.uid, 'manageEquipment');
    actor = { uid: staff.uid, driverId: staff.uid, companyId: staff.companyId, displayName: staff.uid, staff: true };
  }
  const raw = (request.data ?? {}) as Record<string, unknown>;
  const allowed = new Set(['op','id','equipmentType','equipmentNumber','title','description','outOfService','photos','scheduledDate','revision','action','assignedTo','repairNotes','cursor']);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !allowed.has(k))) throw new HttpsError('invalid-argument','Unexpected report fields');
  const orders = fs.collection('equipment_shop_orders');
  try {
    if (raw.op === 'list') {
      let q = orders.where('companyId','==',actor.companyId);
      if (!actor.staff) q = q.where('driverId','==',actor.driverId);
      // Stable document-ID pagination needs no compound date index.
      q = q.orderBy(admin.firestore.FieldPath.documentId()).limit(101);
      if (raw.cursor) q = q.startAfter(shopId(raw.cursor));
      const snap = await q.get();
      const page = snap.docs.slice(0,100);
      return { staff: actor.staff, orders: page.map(d=>d.data()), cursor: snap.size>100 ? page[99].id : null };
    }
    const id = shopId(raw.id);
    const ref = orders.doc(id);
    if (raw.op === 'create') {
      const at = new Date().toISOString();
      const order = newShopOrder(raw, actor, at);
      const photos = shopPhotos(raw.photos ?? []);
      const digest = createHash('sha256').update(JSON.stringify({equipmentType:order.equipmentType,equipmentNumber:order.equipmentNumber,title:order.title,description:order.description,outOfService:order.outOfService,scheduledDate:order.scheduledDate,photos})).digest('hex');
      await fs.runTransaction(async tx => {
        const existing = await tx.get(ref);
        if (existing.exists) {
          if (existing.data()?.companyId !== actor.companyId || existing.data()?.driverId !== actor.driverId || existing.data()?.creationDigest !== digest) throw new HttpsError('already-exists','Report ID already used');
          return;
        }
        tx.create(ref,{...order,creationDigest:digest});
        photos.forEach((base64,i)=>tx.create(ref.collection('photos').doc(String(i)),{base64}));
        tx.create(ref.collection('events').doc('1'),{action:'reported',actorUid:actor.uid,driverId:actor.driverId,at,revision:1});
      });
      return { id };
    }
    if (raw.op === 'get') {
      const snap = await ref.get();
      const order = snap.data() as ShopOrder | undefined;
      if (!order || !shopCanRead(order,actor)) throw new HttpsError('not-found','Report unavailable');
      const [photos,events] = await Promise.all([ref.collection('photos').get(), ref.collection('events').orderBy('revision','desc').limit(100).get()]);
      return { staff: actor.staff, order, photos: photos.docs.map(d=>d.data().base64), events: events.docs.map(d=>d.data()) };
    }
    if (raw.op === 'update') {
      if (!actor.staff) throw new HttpsError('permission-denied','Shop access required');
      await fs.runTransaction(async tx=>{
        const snap=await tx.get(ref); const order=snap.data() as ShopOrder | undefined;
        if (!order || !shopCanRead(order,actor)) throw new HttpsError('not-found','Report unavailable');
        const next=updateShopOrder(order,raw,actor,new Date().toISOString());
        tx.update(ref,{...next});
        tx.create(ref.collection('events').doc(String(next.revision)),{action:raw.action,actorUid:actor.uid,driverId:actor.driverId,at:next.updatedAt,revision:next.revision,repairNotes:next.repairNotes,assignedTo:next.assignedTo,outOfService:next.outOfService});
      });
      return { id };
    }
    throw new HttpsError('invalid-argument','Unknown shop operation');
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    if (e instanceof Error && /index|UNAVAILABLE|DEADLINE|INTERNAL/i.test(e.message)) throw new HttpsError('unavailable','Shop is unavailable. Retry without creating a new report.');
    throw new HttpsError('failed-precondition',e instanceof Error ? e.message : 'Shop request failed');
  }
});
