"use client";
import React, {useMemo, useState} from 'react';
import type {DriverIdentity} from '@/lib/dispatchDriverIdentity';
import {operationalDriverName} from '@/lib/operationalDriverName';
import type {WaterPlan, WaterTank} from '@/lib/waterOrderPlanner';
import {releasableWaterTrips, waterTripStatus} from '@/lib/waterOrderProgress';

const display = (at:string) => new Date(at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const field = 'min-w-0 rounded border border-gray-600 bg-gray-900 px-2 py-2 text-sm text-white';
const button = 'rounded border border-gray-600 px-3 py-2 text-xs disabled:opacity-40';

export function WaterOrderPlanReview({plan, drivers, selectedKeys, tanks, sent, closed, linked, now}: {
  plan:WaterPlan; drivers:DriverIdentity[]; selectedKeys:string[]; tanks:WaterTank[];
  sent:string[]; closed:Record<string,number>; linked:Record<string,string>; now:number;
}) {
  const [search,setSearch]=useState(''),[driver,setDriver]=useState(''),[status,setStatus]=useState(''),[page,setPage]=useState(0);
  const names=useMemo(()=>new Map(drivers.map(d=>[d.key,operationalDriverName(d)])),[drivers]);
  const ready=new Set(releasableWaterTrips(plan,sent,now,closed,linked).map(t=>t.id));
  const rows=plan.trips.map(t=>({trip:t,status:waterTripStatus(t,plan,sent,now,closed,linked,ready)}));
  const crew=[...new Set([...selectedKeys,...plan.trips.map(t=>t.driverKey)])].map(key=>{
    const trips=plan.trips.filter(t=>t.driverKey===key);
    return {key,name:names.get(key)||'Unavailable driver',loads:trips.length,bbl:trips.reduce((n,t)=>n+t.bbl,0)};
  }).sort((a,b)=>a.name.localeCompare(b.name));
  const filtered=rows.filter(r=>(!driver||r.trip.driverKey===driver)&&(!status||r.status===status)&&
    (!search.trim()||`${names.get(r.trip.driverKey)||''} ${r.trip.wellName}`.toLowerCase().includes(search.trim().toLowerCase())));
  const pages=Math.max(1,Math.ceil(filtered.length/25)),current=Math.min(page,pages-1);
  const delivered=Object.values(closed).reduce((a,b)=>a+b,0);
  return <section aria-label="Water order plan review" className="min-w-0 space-y-3">
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-center text-xs">
      {[["Fill targets",plan.target],["Already present",plan.existing],["Needed",plan.needed],["Planned",plan.planned],["Delivered",delivered],["Still needed",Math.max(0,plan.needed-delivered)]].map(([label,value])=><div key={label} className="rounded bg-gray-900 p-2"><div className="text-gray-400">{label}</div><strong>{value} BBL</strong></div>)}
    </div>
    <p className="text-sm">{plan.trips.length} loads · {crew.filter(d=>d.loads).length} drivers assigned · {crew.filter(d=>!d.loads).length} selected without loads · {ready.size} ready</p>
    {plan.shortfall>0&&<p role="alert" className="text-amber-300 text-sm">{plan.shortfall} BBL cannot be supplied within this plan. {plan.trips.length>=300?'The 300-load planning limit was reached; split the remaining requirement into another order.':'Check supply, turnaround, deadline and available truck hours.'}</p>}
    <p className="text-xs text-gray-400">Ready means the planned start is due; live supply is checked again before sending. Future loads require reopening this order and pressing Dispatch. Later loads wait for that driver’s earlier load to finish. Forecasts are estimates; truck hours are planning inputs, not a remaining HOS calculation.</p>
    {rows.some(r=>r.status==='Cancelled')&&<p className="text-sm text-amber-300">Cancelled loads do not count as delivered. Review the remaining water requirement before arranging replacements.</p>}
    <details><summary className="cursor-pointer py-2 text-sm">Driver workload · {crew.length} selected</summary>
      <div className="max-h-64 overflow-auto"><table className="w-full text-xs"><thead className="sticky top-0 bg-gray-900"><tr><th className="text-left p-2">Driver</th><th>Loads</th><th>BBL</th><th /></tr></thead><tbody>{crew.map(d=><tr key={d.key} className="border-t border-gray-700"><td className="p-2 break-words">{d.name}</td><td className="text-center">{d.loads}</td><td className="text-center">{d.bbl}</td><td><button className={button} onClick={()=>{setDriver(d.key);setSearch('');setStatus('');setPage(0);}} aria-label={`Show loads for ${d.name}`}>View</button></td></tr>)}</tbody></table></div>
    </details>
    <details><summary className="cursor-pointer py-2 text-sm">Source forecast · {plan.sources.length} wells</summary>
      <div className="max-h-64 overflow-auto"><table className="w-full min-w-[450px] text-xs"><thead className="sticky top-0 bg-gray-900"><tr><th className="text-left p-2">Source / operator</th><th>Available*</th><th>BBL/day</th><th>Reserved</th><th>Cycle</th></tr></thead><tbody>{plan.sources.map(s=><tr key={s.wellName} className="border-t border-gray-700"><td className="p-2">{s.wellName}<div className="text-gray-400">{s.operator}</div></td><td className="text-center">{s.available}</td><td className="text-center">{s.daily}</td><td className="text-center">{s.reserved}</td><td className="text-center">{s.cycleMinutes} min</td></tr>)}</tbody></table></div>
      <p className="text-xs text-gray-400">*Estimated above minimum level after dispatch commitments, as of {display(plan.createdAt)}.</p>
    </details>
    <div className="flex flex-wrap gap-2">
      <input type="search" aria-label="Search planned loads" placeholder="Search driver or source" className={`${field} w-full sm:w-auto`} value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}}/>
      <select aria-label="Filter loads by driver" className={`${field} max-w-full`} value={driver} onChange={e=>{setDriver(e.target.value);setPage(0);}}><option value="">All drivers</option>{crew.map(d=><option key={d.key} value={d.key}>{d.name} · {d.loads} loads</option>)}</select>
      <select aria-label="Filter loads by status" className={field} value={status} onChange={e=>{setStatus(e.target.value);setPage(0);}}><option value="">All statuses</option>{['Ready','Waiting','Scheduled','Sent','Delivered','Completed','Cancelled','Expired'].map(s=><option key={s}>{s}</option>)}</select>
      <button className={button} onClick={()=>{setSearch('');setDriver('');setStatus('');setPage(0);}}>Clear filters</button>
    </div>
    <p role="status" className="text-xs text-gray-400">{filtered.length} of {rows.length} loads · Page {current+1} of {pages}</p>
    <div className="max-h-96 overflow-auto"><table aria-label="Planned water loads" className="w-full min-w-[500px] text-xs"><thead className="sticky top-0 bg-gray-900"><tr><th className="text-left p-2">Pickup / delivery</th><th className="text-left p-2">Driver / source</th><th className="text-left p-2">BBL / tank</th><th className="text-left p-2">Status</th></tr></thead><tbody>
      {filtered.slice(current*25,(current+1)*25).map(({trip:t,status:s})=><tr key={t.id} className="border-t border-gray-700"><td className="p-2">{display(t.pickupAt)}<div className="text-gray-400">→ {display(t.deliveryAt)}</div></td><td className="p-2">{names.get(t.driverKey)||'Unavailable driver'}<div className="text-gray-400">{t.wellName}</div></td><td className="p-2">{t.bbl}<div className="text-gray-400">{t.tanks.map(a=>`${tanks.find(tank=>tank.id===a.id)?.name||a.id}: ${a.bbl}`).join('; ')}</div></td><td className="p-2">{s==='Delivered'?`Delivered ${closed[t.id]} BBL`:s==='Waiting'?'Waiting for earlier load':s==='Sent'?linked[t.id]||'Sent':s==='Completed'?'Completed · awaiting volume':s}</td></tr>)}
      {!filtered.length&&<tr><td colSpan={4} className="p-4 text-gray-400">No loads match these filters.</td></tr>}
    </tbody></table></div>
    <div className="flex items-center gap-2"><button className={button} disabled={!current} onClick={()=>setPage(current-1)}>Previous loads</button><button className={button} disabled={current>=pages-1} onClick={()=>setPage(current+1)}>Next loads</button></div>
  </section>;
}
