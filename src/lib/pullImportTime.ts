import { chatTimestamp } from '../../functions/src/imports/pullParser';
export function importWallTime(iso: string, timeZone: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' }).formatToParts(new Date(iso));
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}`;
}
export function importWallTimeToUtc(value: string, timeZone: string): string {
  const [date, time] = value.split('T');
  if (!date || !time) return '';
  const [year, month, day] = date.split('-');
  return chatTimestamp(`${month}/${day}/${year}`, time, timeZone);
}
