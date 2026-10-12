import * as admin from 'firebase-admin';

/** Governed builder selection approves an inactive reference for this company only. */
export async function approveInactivePlace(companyId: string, wellName: string, config: Record<string, any>, actorUid: string, db: admin.firestore.Firestore = admin.firestore()) {
 const api = config.ndicApiNo;
 if (typeof api !== 'string' || !/^\d{2}-\d{3}-\d{5}-\d{2}-\d{2}$/.test(api)) return;
 const active=await db.collection('wells').doc(api).get();
 if(active.exists && active.data()?.status==='A') return;
 const inactive=await db.collection('wells_inactive').doc(api).get();
 if(!inactive.exists || inactive.data()?.status!=='IA') return;
 const ndic=inactive.data()!;
 await db.collection('customLocations').doc(`approved-inactive-${companyId}-${api}`).set({
  company:ndic.operator,companyId,locationName:wellName,operationalWellName:wellName,
  api_no:api,ndicApiNo:api,ndicName:ndic.well_name,ndicStatus:'IA',
  ndicInactiveApproved:true,latitude:ndic.latitude??null,longitude:ndic.longitude??null,
  usageCount:admin.firestore.FieldValue.increment(0),approvedBy:actorUid,approvedAt:admin.firestore.FieldValue.serverTimestamp(),
 },{merge:true});
}

