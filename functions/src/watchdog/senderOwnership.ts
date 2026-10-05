import {createHash} from 'crypto';
import {evaluateWbmWellScope,wellBelongsToDriverCompany,wellMatchesWbmScope} from '../security/operational/wbmWellScope';
export function watchdogSenderKey(senderId: string): string {
 if(!/^\d{5,25}@(lid|c\.us)$/.test(senderId))throw Error('invalid_sender_id');
 return createHash('sha256').update(senderId).digest('hex');
}
export function resolveWatchdogOwner(binding:any,profile:any,wellName:string,well:any){
 if(!binding)return null;
 if(binding.enabled!==true||binding.companyId!=='liquid-gold'||typeof binding.driverId!=='string'||!/^[a-zA-Z0-9_-]{8,128}$/.test(binding.driverId))throw Error('sender_binding_invalid');
 if(!profile||profile.active!==true||profile.companyId!==binding.companyId||typeof profile.displayName!=='string'||!profile.displayName.trim())throw Error('sender_driver_unavailable');
 const scope=evaluateWbmWellScope(profile.assignedRoutes,profile.assignedWells);
 if(!scope.ok||!wellBelongsToDriverCompany(well,binding.companyId)||!wellMatchesWbmScope(wellName,well,scope))throw Error('sender_well_out_of_scope');
 return {driverId:binding.driverId,driverName:profile.displayName};
}
