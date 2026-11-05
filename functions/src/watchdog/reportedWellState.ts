import {normalizeWell,parseFeet,type PullImportRow} from '../imports/pullParser';
import {isProvisionalPull} from './barrelDecision';
import type {JsonRecord} from '../imports/pullImportModel';

/** Only the complete, single-well gauge report "Well @ level off" is a shutdown.
 * Never infer state from routing prose, an ordinary pull, or a sender label. */
export function reportedWellOff(row:PullImportRow,verifiedOwner:boolean):boolean {
 if(!verifiedOwner||row.levelOnly!==true||row.bblsTaken!==0||row.bottomLevelFeet!==null)return false;
 const match=/^\s*([^\n@]+?)\s*@\s*([^\n]+?)\s+off\s*$/i.exec(row.source);
 return !!match&&normalizeWell(match[1])===normalizeWell(row.wellName)&&parseFeet(match[2])===row.tankLevelFeet;
}

const restartRiseInches = 12;
const maxReportAgeMs = 6 * 60 * 60 * 1000;

export function measuredWellRestart(
 row: PullImportRow,
 config: JsonRecord,
 status: JsonRecord | null,
 history: Record<string, JsonRecord>,
 now: number,
) {
 if (status?.isDown !== true || config.shutIn?.resumeRequiresConfirmation === true ||
     row.levelOnly || row.inferredSeparator || row.bblsTaken == null || row.bblsTaken <= 0 ||
     row.tankLevelFeet == null || !Number.isFinite(row.tankLevelFeet)) return null;

 const measuredAt = Date.parse(row.dateTimeUTC);
 const postedAt = Date.parse(row.postedAt);
 const lastPullAt = Date.parse(status.lastPull?.dateTimeUTC);
 if (![measuredAt, postedAt, lastPullAt].every(Number.isFinite) ||
     measuredAt <= lastPullAt || measuredAt > postedAt + 60_000 ||
     postedAt > now + 60_000 || measuredAt < now - maxReportAgeMs) return null;
 // Let pending state or level changes settle before assigning authority.
 if (Object.values(history).some(pull => pull.watchdogProcessed === false &&
     Date.parse(pull.dateTimeUTC) >= lastPullAt)) return null;

 const recent = Object.entries(history)
   .filter(([id, pull]) => !/^(edit_|delete_|history_)/.test(id) && !pull.deleted &&
     pull.watchdogProcessed === true && pull.canonicalProcessingComplete === true &&
     Number.isFinite(Date.parse(pull.dateTimeUTC)))
   .sort(([, a], [, b]) => Date.parse(b.dateTimeUTC) - Date.parse(a.dateTimeUTC));
 const [last] = recent;
 if (!last || last[0] !== status.lastPull?.packetId || isProvisionalPull(last[1])) return null;
 const shutDown = recent.find(([, pull]) => pull.wellDown === true ||
   pull.watchdogProvenance?.wellRestart?.kind === 'measured_tank_rise');
 if (!shutDown || shutDown[1].wellDown !== true || isProvisionalPull(shutDown[1]) ||
     shutDown[1].noLevel || shutDown[1].source !== 'whatsapp_watchdog' ||
     shutDown[1].watchdogProvenance?.observationKind !== 'top_only' ||
     shutDown[1].watchdogProvenance?.ownershipSource !== 'verified_sender_binding') return null;
 const shutDownInches = Number(shutDown[1].tankTopInches ?? Number(shutDown[1].tankLevelFeet) * 12);
 const previousBottomInches = Number(last[1].tankAfterInches);
 const topInches = row.tankLevelFeet * 12;
 if (!(shutDownInches > 0) || !Number.isFinite(previousBottomInches) || previousBottomInches < 0 ||
     topInches - Math.max(shutDownInches, previousBottomInches) < restartRiseInches) return null;
 return {kind:'measured_tank_rise', shutdownPacketId:shutDown[0], previousPacketId:last[0],
   shutdownInches:shutDownInches, previousBottomInches, topInches, minimumRiseInches:restartRiseInches};
}
