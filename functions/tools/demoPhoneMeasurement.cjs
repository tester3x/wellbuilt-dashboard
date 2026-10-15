/** Verify the WB Tickets live calculation before an automated demo departure. */
function verifiedPickupDraftLog(log, plan, startedAt) {
  for (const line of log.split(/\r?\n/).reverse()) {
    if (!line.includes('[LiveBottomDiag]')) continue;
    const observedAt = Number(line.trim().split(/\s+/)[0]) * 1000;
    if (!Number.isFinite(observedAt) || observedAt < startedAt - 1000) continue;
    // React Native escapes apostrophes in foot-inch strings as \' in logcat,
    // making the whole logged object invalid JSON. Read only numeric fields.
    if (!line.includes('"keypadActiveFieldKey":"top"')) continue;
    const topFeet = Number(/"topFeet":(-?\d+(?:\.\d+)?)/.exec(line)?.[1]);
    const bbls = Number(/"bbls":(\d+)/.exec(line)?.[1]);
    if (!Number.isFinite(topFeet) || !Number.isFinite(bbls)) continue;
    return Math.abs(topFeet - plan.topFeet) < 0.01
      && bbls === plan.bbls
      && Math.abs(topFeet * 12 - plan.topInches) < 0.12;
  }
  return false;
}

module.exports = { verifiedPickupDraftLog };
