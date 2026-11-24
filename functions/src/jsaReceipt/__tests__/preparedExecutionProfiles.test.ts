import {readPreparedExecutionProfiles} from '../preparedExecutionProfiles';
import {loadVerifiedRevisionFromData} from '../../security/operational/dispatchPacketPin';
jest.mock('../../security/operational/dispatchPacketPin',()=>({loadVerifiedRevisionFromData:jest.fn()}));
const hash='a'.repeat(64),policy='b'.repeat(64);
const index={companyId:'company',packageId:'water-hauling',schemaVersion:1,latestRevision:4,contentHash:hash,policyHash:policy};
function fixture(revision:any){const where=jest.fn(()=>({get:async()=>({docs:[{id:'index',data:()=>index}]})}));
 const db={collection:(name:string)=>name==='job_packet_package_index'?{where}:{doc:()=>({get:async()=>({exists:true,data:()=>revision})})}};
 return {db,where};}
const revision={companyId:'company',status:'published',revision:4,jobTypes:[{jobTypeId:'pw',capabilities:['multiHaul']}]};
beforeEach(()=>{jest.resetAllMocks();(loadVerifiedRevisionFromData as jest.Mock).mockResolvedValue({ok:true,envelope:{contentHash:hash,policyHash:policy}});});
test('prepares only scoped published and verified exact revision permissions',async()=>{
 const {db,where}=fixture(revision);const rows=await readPreparedExecutionProfiles(db,'company');
 expect(where).toHaveBeenCalledWith('companyId','==','company');expect(rows).toHaveLength(1);
 expect(rows[0].jobTypes[0].capabilities).toEqual(['multiHaul']);
 expect(loadVerifiedRevisionFromData).toHaveBeenCalledWith(true,revision,'company',{packageId:'water-hauling',revision:4});
});
test.each([{...revision,status:'draft'},{...revision,companyId:'other'},{...revision,revision:5}])('rejects unpublished/cross-company/revision mismatch',async r=>{
 expect(await readPreparedExecutionProfiles(fixture(r).db,'company')).toEqual([]);
});
test('rejects failed verification and mismatched content pins',async()=>{
 (loadVerifiedRevisionFromData as jest.Mock).mockResolvedValueOnce({ok:false});
 expect(await readPreparedExecutionProfiles(fixture(revision).db,'company')).toEqual([]);
 (loadVerifiedRevisionFromData as jest.Mock).mockResolvedValueOnce({ok:true,envelope:{contentHash:'other',policyHash:policy}});
 expect(await readPreparedExecutionProfiles(fixture(revision).db,'company')).toEqual([]);
});
