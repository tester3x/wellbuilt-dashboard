import {planSplitFamilyReorder} from '../splitReorderPlan';
const family=()=>[
  {id:'a',splitSequence:1,status:'pending',wellName:'Source'},
  {id:'b',splitSequence:2,status:'pending',wellName:'First'},
  {id:'c',splitSequence:3,status:'pending',wellName:'Second'},
  {id:'d',splitSequence:4,status:'pending',wellName:'Third'},
];
test('swaps future stops and reroutes the still-pending pickup',()=>{
  expect(planSplitFamilyReorder(family(),['a','c','b','d'])).toMatchObject({ok:true,base:1,
    order:[{id:'a',splitSequence:1},{id:'c',splitSequence:2},{id:'b',splitSequence:3},{id:'d',splitSequence:4}],
    rerouteAnchor:{id:'a',destination:'Second'}});
});
test.each([['a','b','b','d'],['a','b','c'],['a','b','c','foreign'],['b','a','c','d']])('refuses ambiguous membership or moved anchor %j',(...ids)=>{
  expect(planSplitFamilyReorder(family(),ids).ok).toBe(false);
});
test('started anchor retains destination; later pending legs can still swap',()=>{
  const f=family();f[0].status='in_progress';
  expect(planSplitFamilyReorder(f,['a','c','b','d'])).toEqual({ok:false,reason:'first_destination_already_started'});
  expect(planSplitFamilyReorder(f,['a','b','d','c'])).toMatchObject({ok:true});
  f[2].status='accepted';
  expect(planSplitFamilyReorder(f,['a','b','d','c'])).toEqual({ok:false,reason:'started_leg_cannot_move'});
});
test('history is retained outside live slots and lowest live sequence is preserved',()=>{
  const f=family();f[0].status='completed';f[1].status='in_progress';
  expect(planSplitFamilyReorder(f,['b','c','d'])).toMatchObject({ok:true,base:2,order:[
    {id:'b',splitSequence:2},{id:'c',splitSequence:3},{id:'d',splitSequence:4}]});
  const g=family();g.push({...g[1],id:'removed',status:'cancelled'});
  expect(planSplitFamilyReorder(g,['a','b','c','d']).ok).toBe(true);
  g[2].splitSequence=2;expect(planSplitFamilyReorder(g,['a','b','c','d']).ok).toBe(false);
});
