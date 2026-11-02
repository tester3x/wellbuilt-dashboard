/** Explicit, channel-scoped gauge reporters need not own a WellBuilt driver account. */
export function isTimedLevelReporter(channel:any,senderKey:string|null,row:any):boolean {
 if(!senderKey||row.levelOnly!==true||row.measurementTimeSource!=='stated'||row.bblsTaken!==0||row.bottomLevelFeet!==null)return false;
 const rule=channel?.timedLevelReporters?.[senderKey];
 if(rule?.enabled!==true||typeof rule.startAt!=='string')return false;
 const start=Date.parse(rule.startAt),posted=Date.parse(row.postedAt),measured=Date.parse(row.dateTimeUTC);
 return Number.isFinite(start)&&Number.isFinite(posted)&&Number.isFinite(measured)&&posted>=start&&measured>=start&&measured<=posted+600000&&measured>=posted-7200000;
}
