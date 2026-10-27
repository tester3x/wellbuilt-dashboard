import {createHash} from 'crypto';

/** Human reference, separate from the canonical lookup/authorization ID.
 * Always use the original signing time, never the viewing time or a later stop.
 * Central civil time follows the operation's existing reference timezone;
 * this has no effect on shift/policy scope or midnight handling.
 */
export function jsaNumber(reference:string,signedAtMs:number,existing?:unknown):string {
  if(typeof existing==='string' && /^JSA-\d{8}-\d{6}-\d{6}$/.test(existing))return existing;
  if(!reference || !Number.isFinite(signedAtMs))throw Error('jsa_number_source_missing');
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(signedAtMs);
  const part=(type:string)=>parts.find(p=>p.type===type)!.value;
  const suffix=(parseInt(createHash('sha256').update(reference).digest('hex').slice(0,12),16)%1000000).toString().padStart(6,'0');
  return `JSA-${part('year')}${part('month')}${part('day')}-${part('hour')}${part('minute')}${part('second')}-${suffix}`;
}

/** Acknowledgements refer to a signed document; their receipt IDs are separate. */
export function signedReadJsaNumber(read:{requestId?:unknown;completedAtMs?:unknown;jsaNumber?:unknown}):string {
  if(typeof read.requestId!=='string'||!read.requestId||typeof read.completedAtMs!=='number'||!Number.isFinite(read.completedAtMs))throw Error('jsa_number_source_missing');
  return jsaNumber('JSA-'+read.requestId,read.completedAtMs,read.jsaNumber);
}
