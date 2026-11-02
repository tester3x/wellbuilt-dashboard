'use client';
import {useEffect,useRef,useState} from 'react';
import type React from 'react';
export type ChatDrag={threadId:string;title:string;scope:string};
type Gesture={payload:ChatDrag;x:number;y:number;active:boolean;timer:ReturnType<typeof setTimeout>|null};
/** Mouse threshold + touch hold, preserving ordinary list scrolling before the hold. */
export function useChatGridDrag(scope:string,onDrop:(payload:ChatDrag,index:number)=>void){
 const [drag,setDrag]=useState<{payload:ChatDrag;x:number;y:number;target:number|null}|null>(null);
 const gesture=useRef<Gesture|null>(null),drop=useRef(onDrop),suppressUntil=useRef(0);
 drop.current=onDrop;
 useEffect(()=>{
  const targetAt=(x:number,y:number)=>{const el=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-chat-slot]');return el?Number(el.dataset.chatSlot):null;};
  const activate=(g:Gesture,x:number,y:number)=>{g.active=true;setDrag({payload:g.payload,x,y,target:targetAt(x,y)});window.getSelection()?.removeAllRanges();};
  const cancel=()=>{const g=gesture.current;if(g?.timer)clearTimeout(g.timer);if(g?.active)suppressUntil.current=Date.now()+600;gesture.current=null;setDrag(null);};
  const move=(x:number,y:number,touch:boolean,event:Event)=>{const g=gesture.current;if(!g)return;const distance=Math.hypot(x-g.x,y-g.y);if(!g.active){if(touch){if(distance>10)cancel();return;}if(distance<6)return;activate(g,x,y);}if(event.cancelable)event.preventDefault();setDrag({payload:g.payload,x,y,target:targetAt(x,y)});};
  const end=(x:number,y:number)=>{const g=gesture.current,index=targetAt(x,y);cancel();if(g?.active&&g.payload.scope===scope&&index!==null)drop.current(g.payload,index);};
  const pointerMove=(e:PointerEvent)=>{if(e.pointerType!=='touch')move(e.clientX,e.clientY,false,e);};
  const pointerUp=(e:PointerEvent)=>{if(e.pointerType!=='touch')end(e.clientX,e.clientY);};
  const touchMove=(e:TouchEvent)=>{if(e.touches.length!==1){cancel();return;}move(e.touches[0].clientX,e.touches[0].clientY,true,e);};
  const touchEnd=(e:TouchEvent)=>{const t=e.changedTouches[0];if(t)end(t.clientX,t.clientY);else cancel();};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape')cancel();};
  const context=(e:Event)=>{if(gesture.current)e.preventDefault();};
  window.addEventListener('pointermove',pointerMove);window.addEventListener('pointerup',pointerUp);window.addEventListener('pointercancel',cancel);
  window.addEventListener('touchmove',touchMove,{passive:false});window.addEventListener('touchend',touchEnd);window.addEventListener('touchcancel',cancel);
  window.addEventListener('blur',cancel);window.addEventListener('keydown',key);window.addEventListener('contextmenu',context);
  return()=>{cancel();window.removeEventListener('pointermove',pointerMove);window.removeEventListener('pointerup',pointerUp);window.removeEventListener('pointercancel',cancel);window.removeEventListener('touchmove',touchMove);window.removeEventListener('touchend',touchEnd);window.removeEventListener('touchcancel',cancel);window.removeEventListener('blur',cancel);window.removeEventListener('keydown',key);window.removeEventListener('contextmenu',context);};
 },[scope]);
 const begin=(payload:ChatDrag,x:number,y:number,touch:boolean)=>{
  if(gesture.current?.timer)clearTimeout(gesture.current.timer);
  const g:Gesture={payload,x,y,active:false,timer:null};gesture.current=g;
  if(touch)g.timer=setTimeout(()=>{if(gesture.current!==g)return;g.active=true;setDrag({payload,x,y,target:null});window.getSelection()?.removeAllRanges();},450);
 };
 const handles=(payload:ChatDrag,disabled=false)=>({
  onPointerDown:(e:React.PointerEvent)=>{suppressUntil.current=0;if(disabled||e.pointerType==='touch'||e.button!==0||(e.target as HTMLElement).closest('button,input,textarea,select,a')&& (e.target as HTMLElement).closest('button,input,textarea,select,a')!==e.currentTarget)return;begin(payload,e.clientX,e.clientY,false);},
  onTouchStart:(e:React.TouchEvent)=>{suppressUntil.current=0;if(disabled||e.touches.length!==1||(e.target as HTMLElement).closest('button,input,textarea,select,a')&&(e.target as HTMLElement).closest('button,input,textarea,select,a')!==e.currentTarget)return;begin(payload,e.touches[0].clientX,e.touches[0].clientY,true);},
  onClickCapture:(e:React.MouseEvent)=>{if(Date.now()<suppressUntil.current){e.preventDefault();e.stopPropagation();}},
 });
 return {drag,handles};
}
