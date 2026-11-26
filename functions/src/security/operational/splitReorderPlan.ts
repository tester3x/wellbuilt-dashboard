import type {SplitRemovalLeg} from './removeSplitLegPlan';
const terminal = new Set(['completed','cancelled','canceled','declined','dismissed']);
const liveStates = new Set(['pending','accepted','in_progress','paused']);

/** Reorder existing future stops, never move the current anchor/started work. */
export function planSplitFamilyReorder(legs: SplitRemovalLeg[], ids: string[]):
  | {ok:false;reason:string}
  | {ok:true;base:number;order:Array<{id:string;splitSequence:number}>;rerouteAnchor?:{id:string;destination:string}} {
  const live=legs.filter(l=>!terminal.has(l.status)).sort((a,b)=>a.splitSequence-b.splitSequence);
  if (!live.length || live.length>100 || live.some(l=>!liveStates.has(l.status)
      || !Number.isSafeInteger(l.splitSequence) || l.splitSequence<1)
      || new Set(live.map(l=>l.id)).size!==live.length
      || new Set(live.map(l=>l.splitSequence)).size!==live.length) return {ok:false,reason:'invalid_split_family'};
  const known=new Set(live.map(l=>l.id));
  if (ids.length!==live.length || new Set(ids).size!==ids.length || ids.some(id=>!known.has(id)))
    return {ok:false,reason:'exact_live_legs_required'};
  if (ids[0]!==live[0].id) return {ok:false,reason:'anchor_cannot_move'};
  if (live.some((leg,i)=>leg.status!=='pending' && ids[i]!==leg.id)) return {ok:false,reason:'started_leg_cannot_move'};
  const base=live[0].splitSequence;
  const order=ids.map((id,i)=>({id,splitSequence:base+i}));
  if (ids.length>1 && ids[1]!==live[1].id) {
    if (live[0].status!=='pending') return {ok:false,reason:'first_destination_already_started'};
    const next=live.find(l=>l.id===ids[1])!;
    const destination=(next.wellName||next.ndicWellName||'').trim();
    if (!destination) return {ok:false,reason:'next_destination_missing'};
    return {ok:true,base,order,rerouteAnchor:{id:ids[0],destination}};
  }
  return {ok:true,base,order};
}
