'use client';
import {useMemo,useRef,useState} from 'react';
import type {DriverIdentity} from '@/lib/dispatchDriverIdentity';
import {operationalDriverName} from '@/lib/operationalDriverName';
import type {ShiftDotView} from '@/lib/shiftDotCore';

const searchText=(value:string)=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,'');
type Props={drivers:DriverIdentity[];selectedKeys:string[];onChange:(keys:string[])=>void;disabled?:boolean;shiftForDriver?:(driver:DriverIdentity)=>ShiftDotView};
/** Local roster selection only: never assigns work or fetches a driver per row. */
export function WaterOrderDriverPicker({drivers,selectedKeys,onChange,disabled=false,shiftForDriver}:Props){
 const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[filter,setFilter]=useState<'all'|'on_shift'|'selected'>('all');
 const toggle=useRef<HTMLButtonElement>(null);
 const selected=useMemo(()=>new Set(selectedKeys),[selectedKeys]);
 const roster=useMemo(()=>{
  const rank={green:0,gray:1,red:2};
  return [...new Map(drivers.map(driver=>[driver.key,driver])).values()].map(driver=>({driver,name:operationalDriverName(driver),shift:shiftForDriver?.(driver)}))
   .sort((a,b)=>(rank[a.shift?.dot||'gray']-rank[b.shift?.dot||'gray'])||a.name.localeCompare(b.name)||a.driver.key.localeCompare(b.driver.key));
 },[drivers,shiftForDriver]);
 const onShift=roster.filter(row=>row.shift?.dot==='green');
 const selectedRows=roster.filter(row=>selected.has(row.driver.key));
 const missing=selectedKeys.filter(key=>!roster.some(row=>row.driver.key===key));
 const needle=searchText(search);
 const visible=roster.filter(row=>(filter==='all'||filter==='on_shift'&&row.shift?.dot==='green'||filter==='selected'&&selected.has(row.driver.key))&&(!needle||[row.name,row.driver.legalName||'',row.driver.loginAlias||''].some(value=>searchText(value).includes(needle))));
 const summary=selectedRows.slice(0,2).map(row=>row.name).join(', ')+(selectedRows.length>2?` +${selectedRows.length-2} more`:'');
 const close=()=>{setOpen(false);toggle.current?.focus();};
 function choose(key:string,checked:boolean){onChange(checked?[...new Set([...selectedKeys,key])]:selectedKeys.filter(value=>value!==key));}
 return <section aria-label="Water order drivers" className="min-w-0 rounded-lg border border-gray-600 bg-gray-950/40" onKeyDown={event=>{if(event.key==='Escape'&&open){event.preventDefault();event.stopPropagation();close();}}}>
  <button ref={toggle} type="button" disabled={disabled} aria-expanded={open} onClick={()=>setOpen(value=>!value)} className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm text-white disabled:opacity-50">
   <span className="min-w-0"><span className="block font-semibold">Drivers · {selected.size} selected</span><span className="block text-xs text-gray-400">{roster.length} available{shiftForDriver?` · ${onShift.length} on shift`:''}</span></span>
   <span className="shrink-0 text-cyan-300">{open?'Close':'Choose drivers'} <span aria-hidden="true">{open?'▴':'▾'}</span></span>
  </button>
  {!open&&summary&&<p className="break-words px-3 pb-2 text-xs text-gray-300">{summary}</p>}
  {open&&<div className="space-y-2 border-t border-gray-700 p-3">
   <label className="block text-xs text-gray-300">Search drivers<input type="search" value={search} disabled={disabled} onChange={event=>setSearch(event.target.value)} className="mt-1 w-full min-w-0 rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-white" placeholder="Search by name"/></label>
   <div role="group" aria-label="Driver filters" className="flex flex-wrap gap-2">
    {([['all',`All (${roster.length})`],...(shiftForDriver?[['on_shift',`On shift (${onShift.length})`]]:[]),['selected',`Selected (${selected.size})`]] as [typeof filter,string][]).map(([value,label])=><button key={value} type="button" aria-pressed={filter===value} disabled={disabled} onClick={()=>setFilter(value)} className={`min-h-10 rounded px-3 py-1 text-xs ${filter===value?'bg-cyan-800 text-white':'bg-gray-800 text-gray-300'}`}>{label}</button>)}
   </div>
   <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
    <span role="status" className="text-gray-400">{visible.length} shown · {selected.size} selected</span>
    <div className="flex flex-wrap gap-3"><button type="button" disabled={disabled||!visible.some(row=>!selected.has(row.driver.key))} onClick={()=>onChange([...new Set([...selectedKeys,...visible.map(row=>row.driver.key)])])} className="min-h-9 text-cyan-300 underline disabled:opacity-40">Select shown ({visible.length})</button><button type="button" disabled={disabled||selected.size===0} onClick={()=>onChange([])} className="min-h-9 text-gray-300 underline disabled:opacity-40">Clear selection</button></div>
   </div>
   <ul aria-label="Driver roster" className="max-h-64 overflow-y-auto overscroll-contain rounded border border-gray-700 divide-y divide-gray-800">
    {visible.map(row=><li key={row.driver.key}><label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm"><input type="checkbox" disabled={disabled} checked={selected.has(row.driver.key)} onChange={event=>choose(row.driver.key,event.target.checked)} className="h-4 w-4 shrink-0"/><span className="min-w-0 flex-1 break-words text-white">{row.name}</span><span className="shrink-0 text-xs text-gray-400" title={row.shift?.title}>{row.shift?`${row.shift.symbol} ${row.shift.title}`:'Shift unverified'}</span></label></li>)}
   </ul>
   {!visible.length&&<p className="py-2 text-sm text-gray-400">{filter==='selected'?'No selected drivers match this search.':filter==='on_shift'?'No verified on-shift drivers match this search.':'No drivers match this search.'}</p>}
   {missing.length>0&&<p role="alert" className="text-xs text-amber-300">{missing.length} selected driver{missing.length===1?' is':'s are'} no longer in this roster. Clear selection to choose current drivers.</p>}
   <div className="flex justify-end"><button type="button" onClick={close} className="min-h-10 rounded bg-cyan-800 px-4 py-2 text-sm font-semibold text-white">Done</button></div>
  </div>}
 </section>;
}
