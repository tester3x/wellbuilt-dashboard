import {canonicalHistory,type JsonRecord} from '../imports/pullImportModel';
// Only corroborate against a preceding completed historical calculation. Never
// substitute today's flow for a historical pull or guess a missing calibration.
export function corroborateInferredLevels(row:any,history:JsonRecord,bank:number){
 const at=Date.parse(row.dateTimeUTC);const previous=canonicalHistory(history).filter(p=>p.wellName===row.wellName&&p.canonicalProcessingComplete===true&&Date.parse(p.dateTimeUTC)<at).pop();
 if(!previous||previous.wellDown!==false||!Number.isFinite(bank)||bank<=0)return false;
 const elapsed=(at-Date.parse(previous.dateTimeUTC))/60000;
 const rate=Number(previous.flowRateDays)*1440;
 const bottom=previous.tankAfterInches;
 if(elapsed<=0||elapsed>1440||!Number.isFinite(rate)||rate<=0||typeof bottom!=='number'||!Number.isFinite(bottom))return false;
 const expectedTop=bottom/12+elapsed/rate;
 const top=row.tankLevelFeet,low=row.bottomLevelFeet,bbl=row.bblsTaken;
 if(typeof top!=='number'||typeof low!=='number'||typeof bbl!=='number'||low<0||top<=low||Math.abs(expectedTop-top)>2/12)return false;
 const drop=(top-low)*bank,production=bank/rate;
 // Reported volume must fit drawdown plus 0–30 minutes of production,
 // allowing two inches of combined gauge rounding.
 return bbl>0&&Math.abs(drop-bbl)<=30*production+bank*2/12&&drop<=bbl+bank*2/12;
}
