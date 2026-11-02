export type ChatSlot={driverHash?:string;driverName?:string;threadId?:string;threadTitle?:string};
/** Local positions only: locked profile slots are never displaced by a drag. */
export function moveChatToSlot(saved:(ChatSlot|null)[],temporary:Record<number,ChatSlot>,open:(string|null)[],threadId:string,assignment:ChatSlot,target:number){
 if(!Number.isInteger(target)||target<0||target>=open.length)return null;
 const source=open.indexOf(threadId);
 if(source===target)return temporary;
 if(saved[target]&&!temporary[target])return null;
 if(source>=0&&saved[source]&&!temporary[source])return null;
 const next={...temporary},displaced=temporary[target];
 if(source>=0){delete next[source];if(displaced)next[source]=displaced;}
 else if(displaced){const empty=open.findIndex((id,i)=>!id&&i!==target&&!saved[i]);if(empty<0)return null;next[empty]=displaced;}
 next[target]=assignment;
 return next;
}
