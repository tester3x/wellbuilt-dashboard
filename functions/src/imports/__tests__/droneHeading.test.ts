import {parsePullChat} from '../pullParser';
import {reviewPulls} from '../pullImportModel';
import {reportedTrackingBottom} from '../../watchdog/barrelDecision';
const options={wellNames:['Dagger 1','Dagger 2','Drone','Taboo','Turbo 1','Turbo 2']};
const message=(heading:string,bottom='6\'9"')=>`[10/29/26, 4:59:47 PM] Driver: ${heading}\n11'0"\n${bottom}\n170 bbls`;

test.each(['Drone','Drone 1','Drone1'])('%s heading never becomes a gauge',heading=>{
 const rows=parsePullChat(message(heading),options);
 expect(rows).toHaveLength(1);
 expect(rows[0]).toMatchObject({wellName:'Drone',tankLevelFeet:11,bottomLevelFeet:6.75,bblsTaken:170,issues:[]});
 const [review]=reviewPulls(rows,{Drone:{numTanks:2,bblPerFoot:40}}, {},{},new Set());
 expect(review.afterFeet).toBe(6.75);
});
test('unlisted Drone numbers remain unresolved instead of becoming a gauge',()=>{
 expect(parsePullChat(message('Drone 2'),options).every(r=>r.wellName!=='Drone')).toBe(true);
 expect(parsePullChat(message('Drone 1'),{wellNames:['Taboo']}).every(r=>r.wellName!=='Drone')).toBe(true);
});
test.each([1,6.75])('written 170 BBL preserves calculated 81-inch bottom despite posted %s feet',bottom=>{
 const packet={source:'whatsapp_watchdog',bblsTaken:170,watchdogProvenance:{principalId:'laptop-watchdog-v2',barrelSource:'written',reportedBottomFeet:bottom}};
 expect(reportedTrackingBottom(packet,132)??(132-packet.bblsTaken/40*12)).toBe(81);
 expect(reportedTrackingBottom({...packet,watchdogProvenance:{...packet.watchdogProvenance,timeEstimate:{status:'estimated'}}},132)).toBeNull();
});
