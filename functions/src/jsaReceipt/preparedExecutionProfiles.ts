import {buildGovernedPackageProfile,revisionDocIdFromIndex} from '../security/operational/governedProfileCore';
import {loadVerifiedRevisionFromData} from '../security/operational/dispatchPacketPin';

/** Published, hash-verified permissions carried in the protected shift grant.
 * These authorize local capture, never claim that a dispatch was accepted. */
export async function readPreparedExecutionProfiles(db:any,companyId:string){
 const indexes=await db.collection('job_packet_package_index').where('companyId','==',companyId).get();
 const profiles=[];
 for(const row of indexes.docs){
  const index=row.data(),id=revisionDocIdFromIndex(row.id,index);if(!id)continue;
  const revision=await db.collection('job_packet_revisions').doc(id).get();
  const profile=buildGovernedPackageProfile({companyId,indexDocId:row.id,indexData:index,revisionData:revision.data()});
  if(!profile)continue;
  const verified=await loadVerifiedRevisionFromData(revision.exists,revision.data(),companyId,{packageId:profile.packageId,revision:profile.packetRevision});
  if(!verified.ok||verified.envelope.contentHash!==profile.contentHash||verified.envelope.policyHash!==profile.policyHash)continue;
  profiles.push(profile);
 }
 return profiles;
}
