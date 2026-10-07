import {watchdogSenderKey,resolveWatchdogOwner} from '../senderOwnership';
const binding={enabled:true,companyId:'liquid-gold',driverId:'driver-test-123'};
const profile={active:true,companyId:'liquid-gold',displayName:'Test Driver',assignedRoutes:['Gabriels']};
const well={companyId:'liquid-gold',route:'Gabriels'};
test('uses exact sender IDs rather than display names',()=>{expect(watchdogSenderKey('123456789@lid')).toMatch(/^[a-f0-9]{64}$/);expect(()=>watchdogSenderKey('Test Driver')).toThrow('invalid_sender_id');});
test('unmapped sender receives no driver ownership',()=>expect(resolveWatchdogOwner(null,null,'Gabriel 4',well)).toBeNull());
test('mapped sender uses active same-company server profile and assigned scope',()=>expect(resolveWatchdogOwner(binding,profile,'Gabriel 4',well)).toEqual({driverId:'driver-test-123',driverName:'Test Driver'}));
test.each([{...profile,active:false},{...profile,companyId:'other'}])('inactive or cross-company profile is rejected',p=>expect(()=>resolveWatchdogOwner(binding,p,'Gabriel 4',well)).toThrow('sender_driver_unavailable'));
test('unassigned or cross-company wells are rejected',()=>{expect(()=>resolveWatchdogOwner(binding,{...profile,assignedRoutes:['Other']},'Gabriel 4',well)).toThrow('sender_well_out_of_scope');expect(()=>resolveWatchdogOwner(binding,profile,'Gabriel 4',{...well,companyId:'other'})).toThrow('sender_well_out_of_scope');});
