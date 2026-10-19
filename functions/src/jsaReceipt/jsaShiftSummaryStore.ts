import type {Firestore} from 'firebase-admin/firestore';
import type {ShiftJsaSummaryDeps} from './jsaShiftSummary';
/** All queries narrow by canonical company, driver and an exact shift/context.
 * Lifetime history size therefore cannot make a recent shift disappear. */
export function shiftJsaSummaryStore(db:Firestore):ShiftJsaSummaryDeps{return {
  async list(collection,companyId,driverId,scope){
    if(!scope)throw Error('missing_scope');
    const filters:[string,string][]=collection==='jsa_work_periods'?[['shiftId',scope.shiftId]]
      :collection==='jsa_governed_requests'?[['binding.periodId',scope.shiftId],['binding.associatedPeriodId',scope.shiftId],...scope.periodIds.map(id=>['binding.jsaPeriodId',id] as [string,string])]
      :[['periodId',scope.shiftId],...scope.periodIds.map(id=>['requirementKey','jsa:'+id] as [string,string])];
    const pages=await Promise.all(filters.map(([field,value])=>db.collection(collection).where('companyId','==',companyId).where('driverId','==',driverId).where(field,'==',value).limit(2001).get()));
    return [...new Map(pages.flatMap(page=>page.docs.map(d=>[d.id,{...d.data(),id:d.id}] as const))).values()];
  },
  async artifact(id){const a=await db.collection('jsa_governed_artifacts').doc(id).get();return a.exists?a.data()!:null;},
};}
