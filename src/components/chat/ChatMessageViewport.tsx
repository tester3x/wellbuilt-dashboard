"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatMessage } from './ChatTypes';

/** Each pane follows only while its reader stays at the latest message. */
export function ChatMessageViewport({scope, messages, participantId, onRead, children}: {
  scope: string; messages: ChatMessage[]; participantId: string; onRead?: () => void; children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const state = useRef({scope:'', initialized:false, follow:true, seen:new Set<string>(), pending:new Set<string>(), read:'', anchor:null as null | {id:string; offset:number}});
  const [notice,setNotice]=useState({up:false,count:0});
  const latest=useRef({messages,onRead});latest.current={messages,onRead};
  const selected = () => {
    const selection=window.getSelection();
    return !!selection && !selection.isCollapsed && !!selection.anchorNode && !!viewport.current?.contains(selection.anchorNode);
  };
  const publish=()=>setNotice({up:!state.current.follow,count:state.current.pending.size});
  const read=()=>{
    const s=state.current, rows=latest.current.messages, id=rows.at(-1)?.id;
    if(!s.follow || !id || document.visibilityState!=='visible' || s.read===id || !latest.current.onRead)return;
    s.read=id;latest.current.onRead();
  };
  const rememberAnchor=()=>{
    const el=viewport.current;if(!el)return;
    const top=el.getBoundingClientRect().top;
    const first=Array.from(el.querySelectorAll<HTMLElement>('[data-chat-message-id]')).find(row=>row.getBoundingClientRect().bottom>top);
    state.current.anchor=first?{id:first.dataset.chatMessageId!,offset:first.getBoundingClientRect().top-top}:null;
  };
  const jump=()=>{
    const el=viewport.current;if(!el)return;
    state.current.follow=true;state.current.pending.clear();state.current.anchor=null;
    el.scrollTop=el.scrollHeight;publish();read();
  };
  useLayoutEffect(()=>{
    const el=viewport.current;if(!el)return;
    let s=state.current;
    if(s.scope!==scope){state.current={scope,initialized:false,follow:true,seen:new Set(),pending:new Set(),read:'',anchor:null};s=state.current;el.scrollTop=0;}
    if(!messages.length){publish();return;}
    if(s.follow && selected()){s.follow=false;rememberAnchor();}
    if(s.initialized){for(const row of messages)if(!s.seen.has(row.id)&&row.senderId!==participantId&&!row.pending&&!s.follow)s.pending.add(row.id);}
    s.initialized=true;
    for(const row of messages)s.seen.add(row.id);
    if(s.follow){el.scrollTop=el.scrollHeight;s.pending.clear();read();}
    else if(s.anchor){
      const anchor=Array.from(el.querySelectorAll<HTMLElement>('[data-chat-message-id]')).find(row=>row.dataset.chatMessageId===s.anchor?.id);
      if(anchor)el.scrollTop+=anchor.getBoundingClientRect().top-el.getBoundingClientRect().top-s.anchor.offset;
    }
    publish();
  },[scope,messages,participantId]);
  useLayoutEffect(()=>{
    const resized=()=>{if(state.current.follow && !selected()){const el=viewport.current;if(el)el.scrollTop=el.scrollHeight;}};
    const observer=new ResizeObserver(resized);
    if(content.current)observer.observe(content.current);
    if(viewport.current)observer.observe(viewport.current);
    const visible=()=>{if(document.visibilityState==='visible')read();};
    document.addEventListener('visibilitychange',visible);
    return()=>{observer.disconnect();document.removeEventListener('visibilitychange',visible);};
  },[]);
  return <div className="relative flex-1 min-h-0 flex flex-col" data-chat-viewport-scope={scope}>
    <div ref={viewport} data-chat-scroll className="flex-1 min-h-0 overflow-y-auto p-3" style={{overflowAnchor:'none'}} onScroll={()=>{
      const el=viewport.current;if(!el)return;
      const s=state.current;s.follow=el.scrollHeight-el.clientHeight-el.scrollTop<=48;
      if(s.follow){s.pending.clear();s.anchor=null;read();}else rememberAnchor();publish();
    }}>
      <div ref={content} className="space-y-1.5">{children}</div>
    </div>
    {notice.up && <button key={notice.count} type="button" onClick={jump} aria-label={notice.count ? `${notice.count} new message${notice.count===1?'':'s'}, go to latest` : 'Go to latest messages'}
      className={`absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-[#FFD700] text-black shadow-lg border border-black/30 px-3 py-1.5 text-xs font-semibold whitespace-nowrap ${notice.count?'chat-arrival-pulse':''}`}>
      {notice.count ? `${notice.count} new message${notice.count===1?'':'s'}` : 'Latest messages'} ↓
    </button>}
    <style>{`@keyframes chatIncomingPulse {0%,100%{box-shadow:0 0 0 0 #FFD70000}45%{box-shadow:0 0 0 7px #FFD70066}} .chat-arrival-pulse{animation:chatIncomingPulse 1.2s ease-out} @media(prefers-reduced-motion:reduce){.chat-arrival-pulse{animation:none}}`}</style>
  </div>;
}
