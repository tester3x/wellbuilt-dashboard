import {extractWellOperatingStatus as detect} from '../wellOperatingStatus';
import {parsePullChat} from '../pullParser';
const chat=(body:string)=>`[10/15/2026, 12:00:00 PM] Driver: ${body}`;
const opts={wellNames:['Thor 1','Atlas 1'],levelNotation:'feet_inches' as const};
test.each(['well down','down','off','well is offline','shut in','well shut down','turned off','well not producing'])( '%s marks down',text=>expect(detect(text).wellDown).toBe(true));
test.each(['well up','live','on','well is on','back online','turned back on','well running'])( '%s marks online',text=>expect(detect(text).wellDown).toBe(false));
test.each(['on my way','loaded on truck','down the road','pulled down to 3ft',`6'5" off`,'turn the well off tomorrow','well was down','well will be on','well is not down'])( '%s is not an operating signal',text=>expect(detect(text).wellDown).toBeUndefined());
test('status before and after unlabelled measurements does not break gauges',()=>{
 for(const text of [`Thor 1\nwell down\n12'6\n5'6\n140 bbl`,`Thor 1\n12'6\n5'6\n140 bbl\nwell down`]){const [r]=parsePullChat(chat(text),opts);expect(r).toMatchObject({wellDown:true,tankLevelFeet:12.5,bottomLevelFeet:5.5,bblsTaken:140,issues:[]});}
});
test('status is scoped to its well; absence does not imply up',()=>{
 const rows=parsePullChat(chat(`Thor 1\nTop 12'6\nBottom 5'6\n140 bbl\nwell down\nAtlas 1\nTop 10'6\nBottom 3'6\n140 bbl\n12:00 PM`),opts);expect(rows[0].wellDown).toBe(true);expect(rows[1].wellDown).toBeUndefined();
});
test('contradictory or questioned well states are held for review',()=>{
 for(const text of ['well down\nwell up','well down?']){const [r]=parsePullChat(chat(`Thor 1\nTop 12'6\nBottom 5'6\n140 bbl\n${text}`),opts);expect(r.wellDown).toBeUndefined();expect(r.issues.join(' ')).toMatch(/Ambiguous well operating status/);}
});
