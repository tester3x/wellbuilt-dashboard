import {calculateFlowWindows,FlowWindowResult} from './flowWindows';
import type {JsonRecord} from './imports/pullImportModel';
export function effectiveFlow(history:JsonRecord,config:JsonRecord):{averageDays:number;results:FlowWindowResult[]}|null {
 const threshold=Number(config.flowWindowMinimumRecoveryInches);
 if(!Number.isFinite(threshold)||threshold<3||threshold>24)return null;
 const results=calculateFlowWindows(history,threshold);
 const rates=results.filter(r=>r.flowRateDays>0).slice(-15).map(r=>r.flowRateDays);
 let averageDays=rates[0]||Number(config.avgFlowRateMinutes)/1440||0;
 for(const rate of rates.slice(1))averageDays=0.4*rate+0.6*averageDays;
 return {averageDays,results};
}
