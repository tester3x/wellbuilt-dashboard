import {normalizeWell,parseFeet,type PullImportRow} from '../imports/pullParser';

/** Only the complete, single-well gauge report "Well @ level off" is a shutdown.
 * Never infer state from routing prose, an ordinary pull, or a sender label. */
export function reportedWellOff(row:PullImportRow,verifiedOwner:boolean):boolean {
 if(!verifiedOwner||row.levelOnly!==true||row.bblsTaken!==0||row.bottomLevelFeet!==null)return false;
 const match=/^\s*([^\n@]+?)\s*@\s*([^\n]+?)\s+off\s*$/i.exec(row.source);
 return !!match&&normalizeWell(match[1])===normalizeWell(row.wellName)&&parseFeet(match[2])===row.tankLevelFeet;
}
