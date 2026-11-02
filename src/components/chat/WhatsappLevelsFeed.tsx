"use client";
import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {ChatMessageViewport} from './ChatMessageViewport';
import {ChatMessageFooter} from './ChatMessageFooter';
import type {ChatMessage} from './ChatTypes';
import {selectChatMessageText} from '@/lib/chatTextSelection';

type Pull = ChatMessage & {wellName:string;wellKey:string;driverKey:string;channel:string;sourceLabel?:string;top:number|null;reportedBottom:number|null;after:number|null;bbls:number|null;provisional:boolean};
type Option = {value:string;label:string};
function SearchFilter({label,options,value,onChange}:{label:string;options:Option[];value:string;onChange:(value:string)=>void}) {
  const id=useId(),[open,setOpen]=useState(false),[query,setQuery]=useState(''),[active,setActive]=useState(0);
  const selected=options.find(row=>row.value===value);
  const choices=options.filter(row=>row.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const choose=(row:Option)=>{onChange(row.value);setQuery('');setOpen(false);};
  return <div className="relative min-w-0 flex-1">
    <label htmlFor={id} className="block text-[10px] text-gray-400 mb-1">{label}</label>
    <div className="flex border border-gray-700 rounded bg-[#151515]">
      <input id={id} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={id+'-options'} aria-activedescendant={open&&choices[active]?id+'-'+active:undefined}
        value={open?query:selected?.label||'All '+label.toLowerCase()} placeholder={selected?.label||'All '+label.toLowerCase()}
        onFocus={()=>{setOpen(true);setQuery('');setActive(0);}} onBlur={()=>setOpen(false)}
        onChange={e=>{setQuery(e.target.value);setActive(0);setOpen(true);}}
        onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);e.preventDefault();}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();setOpen(true);setActive(i=>Math.max(0,Math.min(choices.length-1,i+(e.key==='ArrowDown'?1:-1))));}if(e.key==='Enter'&&open&&choices[active]){e.preventDefault();choose(choices[active]);}}}
        className="w-full min-w-0 bg-transparent px-2 py-1.5 text-xs text-white outline-none"/>
      <button type="button" aria-label={'Clear '+label.toLowerCase()+' filter'} onClick={()=>{onChange('');setQuery('');setOpen(false);}} className="px-2 text-gray-400 hover:text-[#FFD700]">×</button>
    </div>
    {open&&<div id={id+'-options'} role="listbox" aria-label={label+' choices'} className="absolute z-20 left-0 right-0 mt-1 max-h-52 overflow-auto rounded border border-gray-600 bg-[#171717] shadow-xl">
      <button role="option" aria-selected={!value} onMouseDown={e=>e.preventDefault()} onClick={()=>choose({value:'',label:''})} className="block w-full text-left px-2 py-2 text-xs text-[#FFD700]">All {label.toLowerCase()}</button>
      {choices.map((row,i)=><button id={id+'-'+i} role="option" aria-selected={value===row.value} key={row.value} onMouseDown={e=>e.preventDefault()} onClick={()=>choose(row)} className={'block w-full text-left px-2 py-2 text-xs text-white hover:bg-[#343014] '+(i===active?'bg-[#292714]':'')}>{row.label}</button>)}
      {!choices.length&&<p className="px-2 py-2 text-xs text-gray-400">No matching {label.toLowerCase()}</p>}
    </div>}
  </div>;
}
const level=(feet:number|null)=>feet===null?'Not reported':`${Math.floor(feet)}′ ${Math.round((feet%1)*120)/10}″`;
export function WhatsappLevelsFeed({messages,scope,participantId}:{messages:ChatMessage[];scope:string;participantId:string}) {
  const rows=messages as Pull[],[well,setWell]=useState(''),[driver,setDriver]=useState(''),[hidden,setHidden]=useState<Set<string>>(new Set());
  const seen=useRef<Set<string>|null>(null);
  const matches=(row:Pull)=>(!well||row.wellKey===well)&&(!driver||row.driverKey===driver);
  const filtered=rows.filter(matches);
  const [windowSize,setWindowSize]=useState(100),windowRef=useRef({filter:'',count:0});
  const filterKey=well+':'+driver;
  useEffect(()=>{
    const old=windowRef.current;
    if(old.filter!==filterKey)setWindowSize(100);
    else if(old.count>0&&filtered.length>old.count)setWindowSize(size=>size+filtered.length-old.count);
    windowRef.current={filter:filterKey,count:filtered.length};
  },[filterKey,filtered.length]);
  // Keep filters over the complete snapshot; expand older cards without trimming
  // cards under a reader when new observations arrive.
  const visible=filtered.slice(-windowSize);
  const options=useMemo(()=>{
    const wells=new Map<string,string>(),drivers=new Map<string,string>();
    for(const row of rows){wells.set(row.wellKey,row.wellName);drivers.set(row.driverKey,row.senderName);}
    wells.set('__unidentified__','Needs identification');
    const sorted=(map:Map<string,string>)=>[...map].map(([value,label])=>({value,label})).sort((a,b)=>a.label.localeCompare(b.label));
    return {wells:sorted(wells),drivers:sorted(drivers)};
  },[messages]);
  useEffect(()=>{
    const old=seen.current;
    // The initial empty subscription is not a first snapshot. Existing history is not a new arrival.
    if(!old){if(rows.length)seen.current=new Set(rows.map(row=>row.id));return;}
    const additions=rows.filter(row=>!old.has(row.id)&&!matches(row));
    seen.current=new Set(rows.map(row=>row.id));
    setHidden(previous=>new Set([...previous,...additions.map(row=>row.id)].filter(id=>rows.some(row=>row.id===id&&!matches(row)))));
  },[messages,well,driver]);
  return <div data-whatsapp-levels-feed className="flex flex-col min-h-0 flex-1">
    <div className="border-b border-gray-700 bg-[#101410] px-3 py-2 flex-shrink-0">
      <div className="flex gap-2"><SearchFilter label="Wells" options={options.wells} value={well} onChange={setWell}/><SearchFilter label="Drivers" options={options.drivers} value={driver} onChange={setDriver}/></div>
      <p className="text-[10px] text-gray-400 mt-2">{filtered.length} of {rows.length} pulls · Display only · No messages sent to WhatsApp</p>
      {hidden.size>0&&<button className="mt-1 text-xs text-[#FFD700]" onClick={()=>{setWell('');setDriver('');setHidden(new Set());}} aria-live="polite">{hidden.size} new {hidden.size===1?'pull':'pulls'} outside these filters · Show all ↓</button>}
    </div>
    <ChatMessageViewport scope={scope+':'+well+':'+driver} messages={visible} participantId={participantId}>
      {filtered.length>visible.length&&<button className="text-xs text-[#FFD700] p-2" onClick={()=>setWindowSize(size=>size+100)}>Show older pulls ({filtered.length-visible.length})</button>}
      {!visible.length&&<p className="text-xs text-gray-400 p-3">{rows.length?'No pulls match these filters.':'No processed pulls available yet.'}</p>}
      {visible.map(row=><article key={row.id} data-chat-message-id={row.id} data-pull-card className="bg-[#171b18] border border-[#344037] rounded-lg px-3 py-2 my-1" onContextMenu={selectChatMessageText}>
        <p className="font-semibold text-sm text-[#FFD700]">{row.wellName}</p>
        <p className="text-xs text-white mt-1">{row.senderName}</p>
        <div data-chat-message-text className="select-text text-xs text-gray-200 whitespace-pre-wrap mt-2">{`Top: ${level(row.top)}\nReported bottom: ${level(row.reportedBottom)}\nProcessed bottom: ${level(row.after)}\nBarrels: ${row.bbls??'Not reported'}${row.provisional?' (provisional)':''}`}</div>
        <p className="text-[10px] text-gray-400 mt-2">Pull: {new Date(String(row.timestamp)).toLocaleString()} · {row.sourceLabel && row.sourceLabel!==row.channel ? row.sourceLabel+' · ' : ''}{row.channel}</p>
        <ChatMessageFooter message={row}/>
      </article>)}
    </ChatMessageViewport>
  </div>;
}
