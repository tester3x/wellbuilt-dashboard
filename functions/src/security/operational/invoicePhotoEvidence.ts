/** Merge against the transaction's current invoice, not a client's stale read.
 * No photo tombstone protocol exists: omitted/empty arrays cannot erase evidence. */
type Photo = Record<string, any>;
const uploadRank = (v: unknown) => (({failed:0,queued:1,pending:1,uploading:2,done:3} as Record<string,number>)[String(v)] ?? -1);
const cloud = (v: unknown) => typeof v === 'string' && /^(https?:\/\/|gs:\/\/)/i.test(v);
const settled = (v: any) => !!v && (['pass','fail'].includes(v.status) || v.overrideUsed === true
  || typeof v.score === 'number' && typeof v.threshold === 'number');
function clean(value: unknown): Photo | string | null {
  if (typeof value === 'string') return cloud(value) ? value : null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const p = {...value} as Photo;
  delete p.localUri;
  for (const key of ['uri','remoteUrl','gsUri']) if (p[key] && !cloud(p[key])) delete p[key];
  if (typeof p.storagePath !== 'string' || /^(file|content|ph):/i.test(p.storagePath)) delete p.storagePath;
  return p;
}
function merge(a: Photo, b: Photo): Photo {
  const out: Photo = {...a,...b,photoId:a.photoId || b.photoId};
  for (const key of ['uri','remoteUrl','gsUri','storagePath','takenAt','requirementId','captureConnectivity']) {
    if (a[key]) out[key] = a[key];
  }
  const au = a.upload || {}, bu = b.upload || {};
  const winner = uploadRank(bu.status) > uploadRank(au.status) ? bu : au;
  if (a.upload || b.upload) out.upload = {...winner,attempts:Math.max(au.attempts || 0,bu.attempts || 0)};
  if (cloud(out.uri) || cloud(out.remoteUrl) || cloud(out.gsUri) || out.storagePath) {
    delete out.deliveryPending;
    out.upload = {...out.upload,status:'done'};
  }
  if (a.compliance || b.compliance) {
    const ac=a.compliance,bc=b.compliance;
    const newer = (Date.parse(bc?.validatedAt) || 0) >= (Date.parse(ac?.validatedAt) || 0);
    out.compliance = settled(ac) && !settled(bc) ? ac
      : settled(bc) && !settled(ac) ? bc : newer ? bc || ac : ac || bc;
    if (ac?.retakeUnavailable || bc?.retakeUnavailable) out.compliance={...out.compliance,
      retakeUnavailable:true,retakeUnavailableReason:ac?.retakeUnavailableReason || bc?.retakeUnavailableReason || null};
  }
  return out;
}
export function mergeInvoicePhotoEvidence(existing: unknown, incoming: unknown): Array<Photo | string> {
  const result:Array<Photo|string>=[];
  const positions=new Map<string,number>();
  for (const raw of [...(Array.isArray(existing)?existing:[]),...(Array.isArray(incoming)?incoming:[])]) {
    const p=clean(raw);if(!p)continue;
    const id=typeof p==='object' && typeof p.photoId==='string' && p.photoId ? p.photoId : null;
    const prior=id ? positions.get(id) : undefined;
    if(prior!==undefined) result[prior]=merge(result[prior] as Photo,p as Photo);
    else {if(id)positions.set(id,result.length);result.push(p);}
  }
  // Firestore rejects undefined nested fields; JSON data contains no sentinels here.
  return JSON.parse(JSON.stringify(result));
}
