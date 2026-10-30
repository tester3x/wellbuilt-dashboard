import {storedEditHistoryPaths,expandedEditHistoryPaths} from '../editOutbox';
test('audit history paths survive Firebase-safe outbox persistence and expand for root update',()=>{
 const paths={'packets/editHistory/test_packet/test_event':{before:12,after:185}};
 const stored=storedEditHistoryPaths(paths);
 expect(Object.keys(stored).every(key=>!/[.#$\/\[\]]/.test(key))).toBe(true);
 expect(expandedEditHistoryPaths(JSON.parse(JSON.stringify(stored)))).toEqual(paths);
 expect(expandedEditHistoryPaths(paths)).toEqual(paths);
});
