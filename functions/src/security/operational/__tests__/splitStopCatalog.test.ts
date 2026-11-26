import {approvedSplitDisposal} from '../splitStopCatalog';
function fixture(base:any[]=[{id:'base',well_name:'HYDRO',search_name:'hydro'}],directory:any[]=[]) {
  const queries:any[]=[];
  const query=(collection:string)=>({collection,field:'',values:[] as string[],cap:0,
    where(field:string,_op:string,values:string[]){return {...this,field,values};},
    limit(cap:number){return {...this,cap};},doc(id:string){return {collection:(child:string)=>query(`${collection}/${id}/${child}`)};}});
  const db={collection:query};
  const tx={get:async(q:any)=>{queries.push(q);const all=q.collection==='disposals'?base:directory;
    return {docs:all.filter(r=>q.values.includes(r[q.field])).slice(0,q.cap).map(r=>({id:r.id,data:()=>r,get:(key:string)=>r[key]}))};}};
  return {db:db as any,tx:tx as any,queries};
}
test('exact approved shared disposal uses bounded lookups, never scans the catalog',async()=>{
  const f=fixture();expect(await approvedSplitDisposal(f.tx,f.db,'company',{wellName:'HYDRO'})).toBe(true);
  expect(f.queries).toHaveLength(4);expect(f.queries.every(q=>q.field&&q.values.length<=10&&q.cap<=8)).toBe(true);
});
test('unknown, ambiguous, foreign and company-blacklisted SWDs stay unauthorized',async()=>{
  const cases=[fixture([]),fixture([{id:'a',well_name:'HYDRO'},{id:'b',well_name:'HYDRO'}]),
    fixture([{id:'a',well_name:'HYDRO',companyId:'foreign'}]),
    fixture(undefined,[{id:'blocked',ndicWellName:'HYDRO',isBlacklisted:true}])];
  for(const f of cases)expect(await approvedSplitDisposal(f.tx,f.db,'company',{wellName:'HYDRO'})).toBe(false);
});
test('company-approved custom names and renamed NDIC identities work without trusting caller GPS',async()=>{
  const custom=fixture([],[{id:'custom',displayName:'Yard',isCustom:true,companyId:'company'}]);
  expect(await approvedSplitDisposal(custom.tx,custom.db,'company',{wellName:'Yard',latitude:99})).toBe(true);
  const renamed=fixture(undefined,[{id:'rename',displayName:'Home SWD',ndicWellName:'HYDRO'}]);
  expect(await approvedSplitDisposal(renamed.tx,renamed.db,'company',{wellName:'Home SWD',ndicWellName:'HYDRO'})).toBe(true);
  expect(await approvedSplitDisposal(renamed.tx,renamed.db,'company',{wellName:'Home SWD',ndicWellName:'Other'})).toBe(false);
});
