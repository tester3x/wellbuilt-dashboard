// A held channel is listened to only for an explicitly armed, new well report.
// The signed receiver repeats these checks against its authoritative policy.
export function heldReportAllowed(wells, message, row, now=Date.now()) {
 const held=(wells||[]).find(w=>w.wellName===row.wellName&&w.state==='held'&&w.channels?.includes(message.channel));
 if(!held)return true;
 const armed=Date.parse(held.hold?.autoResume?.armedAt),posted=Date.parse(row.postedAt),measured=Date.parse(row.dateTimeUTC);
 return held.hold?.autoResume?.mode==='next_load_or_level'&&
  Number.isFinite(armed)&&posted>armed&&posted<=now+300000&&
  measured>=Date.parse(held.hold.effectiveAt)&&measured<=now+300000&&
  !row.excluded&&Number.isFinite(row.tankLevelFeet)&&row.tankLevelFeet>=0&&
  (row.bottomLevelFeet==null||(Number.isFinite(row.bottomLevelFeet)&&row.bottomLevelFeet>=0&&row.bottomLevelFeet<=row.tankLevelFeet));
}
