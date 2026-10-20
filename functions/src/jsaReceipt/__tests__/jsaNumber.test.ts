import {jsaNumber} from '../jsaNumber';
const time=Date.parse('2026-10-19T15:25:13Z');
test('human number contains signing date, time and six decimal digits',()=>{
 expect(jsaNumber('JSA-'+ 'A'.repeat(43),time)).toMatch(/^JSA-20261019-102513-\d{6}$/);
});
test('the same signed source resolves identically everywhere, with no viewing date input',()=>{
 const n=jsaNumber('source',time);expect(jsaNumber('source',time)).toBe(n);
 expect(jsaNumber('another',time)).not.toBe(n);
 expect(jsaNumber('source',time+86400000,n)).toBe(n);
});
test('overnight reference uses original civil signing time; it never determines shift scope',()=>{
 expect(jsaNumber('a',Date.parse('2026-10-20T04:59:59Z'))).toMatch(/^JSA-20261019-235959-/);
 expect(jsaNumber('b',Date.parse('2026-10-20T05:00:00Z'))).toMatch(/^JSA-20261020-000000-/);
});
test('opaque IDs are converted, never abbreviated or substituted as lookup authority',()=>{
 const source='JSA-'+ 'Ab_-'.repeat(12),number=jsaNumber(source,time,source);
 expect(number).not.toContain('…');expect(number).not.toContain('Ab_');expect(source).toHaveLength(52);
});
test('invalid timestamp cannot generate a number using the current time',()=>{
 expect(()=>jsaNumber('source',NaN)).toThrow('jsa_number_source_missing');
});
