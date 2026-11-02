export const CHAT_WINDOW_LAYOUT_KEY='wb-chat-window-layout-v1';
export type ChatWindowLayout={profileIds:string[];activeId:string|null;locked:boolean;pinnedIds:string[]};
export const emptyChatWindowLayout=():ChatWindowLayout=>({profileIds:[],activeId:null,locked:false,pinnedIds:[]});
export function cleanChatWindowLayout(raw:any):ChatWindowLayout{
 const ids=Array.isArray(raw?.profileIds)?[...new Set<string>(raw.profileIds.filter((id:unknown)=>typeof id==='string'&&id.length>0))]:[];
 return {profileIds:ids,activeId:ids.includes(raw?.activeId)?raw.activeId:ids.at(-1)||null,locked:raw?.locked===true,pinnedIds:Array.isArray(raw?.pinnedIds)?raw.pinnedIds.filter((id:string)=>ids.includes(id)):[]};
}
