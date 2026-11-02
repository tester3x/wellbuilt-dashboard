/** Historical edits intentionally do not replace the latest outgoing well view. */
export function historicalReviewCommitted(outbox:any,packet:any,entry:any,identity:string):boolean {
 const pending=entry?.pendingReview,review=pending?.review,m=outbox?.measurements;
 return !!pending&&!!review&&outbox?.completed===true&&outbox.stage==='done'&&outbox.isLatestPull===false
  &&outbox.eventId===pending.eventId&&outbox.originalPacketId===entry.packetId
  &&outbox.companyId==='liquid-gold'&&outbox.wellName===entry.wellName
  &&packet?.companyId==='liquid-gold'&&packet.wellName===entry.wellName&&packet.canonicalProcessingComplete===true
  &&packet.watchdogProvenance?.observationDigest===identity
  &&packet.activeEditEventId===pending.eventId&&Number.isInteger(outbox.sequence)&&outbox.sequence>0&&packet.editCount===outbox.sequence
  &&m?.bblsTaken===review.bblsTaken&&m.tankLevelFeet===review.tankLevelFeet&&m.dateTimeUTC===review.dateTimeUTC
  &&packet.bblsTaken===review.bblsTaken&&packet.tankLevelFeet===review.tankLevelFeet&&packet.dateTimeUTC===review.dateTimeUTC
  &&Number.isFinite(m.tankAfterInches)&&Math.abs(m.tankAfterInches-Number(review.bottomLevelFeet)*12)<0.01
  &&packet.tankAfterInches===m.tankAfterInches;
}
