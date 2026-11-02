import { HttpsError } from 'firebase-functions/v2/https';
export const EMPLOYEE_ROLE_CAPABILITIES: Record<string,string[]> = {
 driver: [],
 viewer: ['viewHome','viewMobile','viewTickets','viewDispatch','viewBilling','viewPayroll','viewDriverLogs','viewEQuipment','viewDVIR','viewEquipmentDocuments'],
 dispatch: ['viewHome','viewMobile','viewTickets','viewDispatch','viewSafety','viewChat','createDispatch','sendChat','manageEquipmentAssignments','viewEQuipment','viewDVIR','viewEquipmentDocuments'],
 payroll: ['viewHome','viewBilling','viewPayroll','viewChat','editBilling','approvePayroll','sendChat'],
 safety: ['viewHome','viewTickets','viewDispatch','viewSafety','viewChat','sendChat','manageSafety','viewEQuipment','viewDVIR'],
 lead: ['viewHome','viewTickets','viewDispatch','viewSafety','viewChat','sendChat','manageSafety','viewEQuipment','viewDVIR'],
 manager: ['viewHome','viewMobile','viewTickets','viewDispatch','viewPayroll','viewDriverLogs','viewSafety','viewChat','createDispatch','sendChat','manageDrivers','manageEquipmentAssignments','viewEQuipment','viewDVIR','viewEquipmentDocuments','manageSafety'],
 admin: ['viewHome','viewMobile','viewTickets','viewDispatch','viewBilling','viewPayroll','viewDriverLogs','viewSafety','viewSettings','viewAdmin','viewChat','createDispatch','manageDrivers','manageCompany','editBilling','approvePayroll','manageWells','manageRoutes','viewEQuipment','manageEquipment','manageEquipmentAssignments','viewDVIR','manageDVIR','viewEquipmentDocuments','manageEquipmentDocuments','sendChat','manageSafety'],
};
const levels:Record<string,number>={driver:1,viewer:1,dispatch:2,payroll:2,safety:2,lead:3,manager:3,admin:4};
export function employeeRoleGrant(raw:unknown, actorCapabilities:readonly string[]) {
 if (!Array.isArray(raw)||raw.length<1||raw.length>8||raw.some(r=>typeof r!=='string'||!Object.prototype.hasOwnProperty.call(EMPLOYEE_ROLE_CAPABILITIES,r))||new Set(raw).size!==raw.length) throw new HttpsError('invalid-argument','Choose valid employee responsibilities');
 const roles=raw as string[];
 const capabilities=[...new Set(roles.flatMap(r=>EMPLOYEE_ROLE_CAPABILITIES[r]))];
 if(capabilities.some(c=>!actorCapabilities.includes(c)))throw new HttpsError('permission-denied','You cannot grant responsibilities beyond your own access');
 return {roles,role:roles.reduce((a,b)=>levels[a]>=levels[b]?a:b),capabilities};
}
export function exactEmployeeInput(raw:unknown,allowed:string[]) {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!allowed.includes(k)))throw new HttpsError('invalid-argument','Invalid employee request');
 return raw as Record<string,unknown>;
}
