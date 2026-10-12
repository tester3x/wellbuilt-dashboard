/** Compatibility at driver-create only; publication/pin/capability checks still decide authority. */
export function driverRequestedJobType(fields:Record<string,unknown>):unknown {
 const raw=typeof fields.jobTypeId==='string'&&fields.jobTypeId.trim()?fields.jobTypeId:fields.jobType;
 if(typeof raw!=='string')return raw;
 const n=raw.trim().toLowerCase();
 const aliases:Record<string,string>={pw:'pw','production water':'pw','production-water':'pw','production_water':'pw',sw:'service-work','service work':'service-work','service-work':'service-work',fresh:'fresh-water','fresh water':'fresh-water','fresh-water':'fresh-water',fw:'flowback-water',flowback:'flowback-water','flowback water':'flowback-water','flowback-water':'flowback-water',frack:'frac-water','frac water':'frac-water','frac-water':'frac-water','production water (hr)':'service-work','production-water-hourly':'service-work'};
 if(n==='service'&&typeof fields.serviceType==='string'){
  const label=fields.serviceType.trim().toLowerCase();
  return label==='production water'?'service-work':aliases[label]||raw;
 }
 return aliases[n]||raw;
}
