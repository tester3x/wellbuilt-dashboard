import * as admin from 'firebase-admin';
import {createHash} from 'crypto';

export const whatsappLevelsId = (companyId: string) => 'whatsapp_levels_' + createHash('sha256').update(companyId).digest('hex').slice(0,32);
export const isWhatsappLevelsId = (id: unknown) => typeof id === 'string' && id.startsWith('whatsapp_levels_');
const text = (v: unknown) => typeof v === 'string' ? v.trim().slice(0,160) : '';
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const identity = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim();
const level = (feet: number | null) => feet === null ? 'Not reported' : `${Math.floor(feet)} ft ${Math.round((feet % 1)*120)/10} in`;
/** Allowlist only display fields. A projection never creates pulls or conversations. */
export function projectWhatsappLevels(companyId: string, packets: Record<string, any>) {
  const rows = new Map<string, any>();
  for (const [key, p] of Object.entries(packets)) {
    if (!p || p.companyId !== companyId) continue;
    const whatsapp = ['whatsapp_watchdog','whatsapp_import'].includes(p.source) || p.historicalImport?.source === 'whatsapp' || /whatsapp/.test(String(p.importSource?.type || ''));
    if (p.source === 'whatsapp_watchdog_stop' || p.noLevel === true && !Number(p.bblsTaken)) continue;
    if (/^(edit_|delete_)/.test(key) || p.requestType && p.requestType !== 'pull' || p.isDelete || p.action === 'delete' || p.deleted === true) continue;
    // Watchdog receipts distinguish accepted processed observations from partial writes.
    if ((p.source === 'whatsapp_watchdog' && p.canonicalProcessingComplete !== true) || p.canonicalProcessingComplete === false) continue;
    const wellName = text(p.wellName), provenance = p.watchdogProvenance || {}, historical = p.historicalImport || {};
    const author = text(provenance.author) || text(historical.author) || text(provenance.timedLevelReporter?.author) || text(p.driverName) || 'Reporter unavailable';
    const wellKey = wellName ? identity(wellName) : '__unidentified__';
    const driverKey = text(p.driverId) ? 'driver:' + text(p.driverId) : 'whatsapp:' + identity(author);
    const timestamp = text(p.dateTimeUTC);
    if (!Number.isFinite(Date.parse(timestamp))) continue;
    const packetId = text(p.packetId) || key;
    const top = p.noLevel === true ? null : number(p.tankTopInches) !== null ? p.tankTopInches/12 : number(p.tankLevelFeet);
    const reportedBottom = number(provenance.reportedBottomFeet) ?? number(historical.reportedBottomFeet) ?? number(p.importSource?.reportedBottomFeet);
    const after = number(p.tankAfterInches) !== null ? p.tankAfterInches/12 : number(p.bottomLevelFeet);
    const bbls = number(p.bblsTaken);
    const sourceLabel = whatsapp ? 'WhatsApp' : p.originAppContext === 'wbt' || p.source === 'submitTicket' ? 'WB T' : p.source === 'wbm' || p.authSource === 'claims' ? 'WB M' : 'WB pull packet';
    const channel = whatsapp ? text(provenance.channelName) || text(historical.channelName) || 'WhatsApp' : sourceLabel;
    const body = `${wellName || 'Well needs identification'}\n${author}\nTop: ${level(top)}\nReported bottom: ${level(reportedBottom)}\nProcessed bottom: ${level(after)}\nBarrels: ${bbls === null ? 'Not reported' : bbls}${provenance.barrels?.status === 'provisional' ? ' (provisional)' : ''}\nPull time: ${timestamp}\nSource: ${sourceLabel === channel ? channel : sourceLabel + " · " + channel}`;
    rows.set(packetId, {id:packetId, packetId, text:body, senderId:'whatsapp:'+driverKey, senderName:author, type:'level_report', timestamp,
      wellName:wellName || 'Well needs identification', wellKey, driverKey, channel, sourceLabel, top, reportedBottom, after, bbls,
      provisional:provenance.barrels?.status === 'provisional'});
  }
  return [...rows.values()].sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp)||a.id.localeCompare(b.id));
}
// Scope the short-lived read cache by trusted company. Never cache authorization.
const cache = new Map<string,{expires:number;rows:any[]}>();
export async function readWhatsappLevels(companyId: string) {
  const old = cache.get(companyId);
  if(old && old.expires>Date.now()) return old.rows;
  const snap = await admin.database().ref('packets/processed').orderByChild('companyId').equalTo(companyId).once('value');
  const rows = projectWhatsappLevels(companyId,snap.val() || {});
  if(cache.size>=20)cache.delete(cache.keys().next().value!);
  cache.set(companyId,{expires:Date.now()+10000,rows});
  return rows;
}
export function whatsappLevelsThread(companyId: string) {
  return {id:whatsappLevelsId(companyId),companyId,type:'whatsapp_levels',title:'WhatsApp Levels',subtitle:'WhatsApp + WB app pulls · dispatch only · read only',
    permanent:true,readOnly:true,status:'active',participants:[],participantNames:{},lastRead:{},unreadCount:0};
}
