import type { WellResponse } from './wellPoolCore';
/** Display only: never substitute a produced-water rate or infer consumption from a name. */
export function freshWaterRateDisplay(well: WellResponse) {
 const raw=well.inventoryDailyBbl;
 const daily=typeof raw==='number' && Number.isFinite(raw) && raw>=0 ? raw : null;
 const bpf=well.bblPerFoot;
 const minutes=daily != null && daily>0 && bpf != null && Number.isFinite(bpf) && bpf>0 ? 1440*bpf/daily : null;
 const duration=(minutes:number|null,inch=false)=>{
  if(minutes==null)return '--';
  const seconds=Math.round(minutes*60),hours=Math.floor(seconds/3600),mins=Math.floor(seconds%3600/60),secs=seconds%60;
  return (inch && hours===0 ? String(mins) : hours+':'+String(mins).padStart(2,'0'))+':'+String(secs).padStart(2,'0');
 };
 return {daily,minutesPerFoot:minutes,perFoot:duration(minutes),perInch:duration(minutes==null?null:minutes/12,true),
  perDay:daily==null?'Unknown':daily.toLocaleString('en-US',{maximumFractionDigits:2})+' BBL/day',
  paused:well.isDown===true||well.wellDown===true,provenance:'Estimated consumption from canonical freshwater inventory'};
}
