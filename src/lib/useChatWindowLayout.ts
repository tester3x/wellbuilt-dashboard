"use client";
import {useEffect,useState,type SetStateAction} from 'react';
import {CHAT_WINDOW_LAYOUT_KEY,cleanChatWindowLayout,emptyChatWindowLayout,type ChatWindowLayout} from './chatWindowLayout';
/** Open profiles and their protection belong to this tab and signed-in company,
 * never to the shared monitor document or another window's localStorage. */
export function useChatWindowLayout(scope:string){
 const [snapshot,setSnapshot]=useState<{scope:string;layout:ChatWindowLayout}>({scope:'',layout:emptyChatWindowLayout()});
 const ready=!!scope&&snapshot.scope===scope;
 useEffect(()=>{
  if(!scope)return;
  let layout=emptyChatWindowLayout();
  try{
   const stored=sessionStorage.getItem(CHAT_WINDOW_LAYOUT_KEY);
   if(stored)layout=cleanChatWindowLayout(JSON.parse(stored)?.scopes?.[scope]);
   else{
    const ids=JSON.parse(localStorage.getItem('wb-chat-profile-stack')||'null');
    const legacy=localStorage.getItem('wb-chat-profile');
    layout=cleanChatWindowLayout({profileIds:Array.isArray(ids)?ids:legacy?[legacy]:[]});
   }
  }catch{ /* Invalid local preferences cannot prevent access to chat. */ }
  setSnapshot({scope,layout});
 },[scope]);
 useEffect(()=>{
  if(!ready)return;
  try{
   const saved=JSON.parse(sessionStorage.getItem(CHAT_WINDOW_LAYOUT_KEY)||'{"scopes":{}}');
   sessionStorage.setItem(CHAT_WINDOW_LAYOUT_KEY,JSON.stringify({scopes:{...saved?.scopes,[scope]:snapshot.layout}}));
  }catch{ /* Keep this window usable if browser storage is unavailable. */ }
 },[ready,scope,snapshot]);
 const update=(value:SetStateAction<ChatWindowLayout>)=>setSnapshot(old=>old.scope!==scope?old:{scope,layout:cleanChatWindowLayout(typeof value==='function'?value(old.layout):value)});
 return [ready?snapshot.layout:emptyChatWindowLayout(),update,ready] as const;
}
