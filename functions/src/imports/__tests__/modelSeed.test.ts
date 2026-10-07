import { seededOutgoing, seededStatus } from '../modelSeed';
test('seed updates predictions without replacing last pull, timestamps or down state',()=>{
 const outgoing={wellName:'Kahuna 5',lastPullPacketId:'live',lastPullDateTimeUTC:'2026-09-20T20:00:00Z',lastPullBottomLevel:'7\'0"',timestampUTC:'2026-09-20T21:00:00Z',currentLevel:'7\'0"',wellDown:true};
 const result=seededOutgoing(outgoing,{bottomLevel:4,pullBbls:180},1/12,180,'batch');
 expect(result.lastPullPacketId).toBe('live');expect(result.lastPullBottomLevel).toBe(outgoing.lastPullBottomLevel);expect(result.timestampUTC).toBe(outgoing.timestampUTC);expect(result.wellDown).toBe(true);expect(result.timeTillPull).toBe('Down');expect(result.currentLevel).toBe('7\'6"');expect(result.flowRate).toBe('2:00:00');
 const status={lastPull:{dateTimeUTC:outgoing.lastPullDateTimeUTC,bottomLevelInches:84},current:{level:'7\'0"'},isDown:true};
 const seeded=seededStatus(status,{bottomLevel:4,pullBbls:180},1/12,180,'batch');expect(seeded.lastPull).toEqual(status.lastPull);expect(seeded.current).toEqual(status.current);expect(seeded.calculated.timeTillPull).toBe('Down');
});
