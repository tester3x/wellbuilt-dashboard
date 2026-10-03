/** Shared, side-effect-free WhatsApp parser. Input is data, never instructions. */
export interface PullImportOptions {
  defaultWell?: string;
  wellNames?: string[];
  defaultBbls?: number;
  timeZone?: string;
  dateOrder?: 'mdy' | 'dmy';
  startDate?: string;
  endDate?: string;
}
export interface PullImportRow {
  id: string;
  wellName: string;
  postedAt: string;
  dateTimeUTC: string;
  tankLevelFeet: number | null;
  bottomLevelFeet: number | null;
  bblsTaken: number | null;
  author: string;
  source: string;
  issues: string[];
  excluded: boolean;
}
export interface ChatMessage { index: number; date: string; time: string; author: string; body: string }
const header = /^(?:\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*([^\]]+)\]\s*|(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(.*?)\s+-\s+)(.*)$/;
export function splitChat(text: string): ChatMessage[] {
  if (text.length > 2_000_000) throw new Error('Chat text exceeds 2 MB. Export a shorter date range.');
  const messages: ChatMessage[] = [];
  for (const line of text.replace(/[\u200e\u200f\u202a-\u202e\ufeff]/g, '').split(/\r?\n/)) {
    const match = header.exec(line);
    if (match) {
      const content = match[5];
      const colon = content.indexOf(': ');
      messages.push({ index: messages.length, date: match[1] || match[3], time: match[2] || match[4], author: colon >= 0 ? content.slice(0, colon) : '', body: colon >= 0 ? content.slice(colon + 2) : content });
    } else if (messages.length) messages[messages.length - 1].body += '\n' + line;
  }
  return messages;
}
function clock(text: string): { hour: number; minute: number; second: number } | null {
  const value = text.trim().replace(/[\u202f\u00a0]/g, ' ');
  const hourOnly = /^(\d{1,2})\s*([ap](?:m)?)$/i.exec(value);
  if(hourOnly){const h=Number(hourOnly[1]);return h>=1&&h<=12?{hour:h%12+(hourOnly[2].toLowerCase().startsWith('p')?12:0),minute:0,second:0}:null;}
  const match = /^(\d{1,2})(?::(\d{2}))(?::(\d{2}))?\s*([ap](?:m)?)?$/i.exec(value) || /^(\d{1,2})(\d{2})\s*([ap](?:m)?)?$/i.exec(value);
  if (!match) return null;
  const compact = !value.includes(':');
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = compact ? 0 : Number(match[3] || 0);
  const meridiem = compact ? match[3] : match[4];
  if (minute > 59 || second > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) return null;
  if (meridiem) hour = hour % 12 + (meridiem.toLowerCase().startsWith('p') ? 12 : 0);
  return { hour, minute, second };
}
/** Resolve wall time in the selected zone; reject nonexistent/ambiguous DST times. */
export function chatTimestamp(date: string, time: string, zone = 'America/Chicago', order: 'mdy' | 'dmy' = 'mdy'): string {
  const pieces = date.split('/').map(Number);
  const year = pieces[2] < 100 ? 2000 + pieces[2] : pieces[2];
  const month = pieces[order === 'mdy' ? 0 : 1];
  const day = pieces[order === 'mdy' ? 1 : 0];
  const parsedClock = clock(time);
  if (!parsedClock) throw new Error('Invalid time');
  const wall = Date.UTC(year, month - 1, day, parsedClock.hour, parsedClock.minute, parsedClock.second);
  const check = new Date(wall);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error('Invalid date');
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  function wallAt(instant: number): number {
    const fields: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(instant))) if (part.type !== 'literal') fields[part.type] = Number(part.value);
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  }
  const candidates = new Set<number>();
  for (const offset of [-86_400_000, 0, 86_400_000]) {
    const probe = wall + offset;
    const candidate = wall - (wallAt(probe) - probe);
    if (wallAt(candidate) === wall) candidates.add(candidate);
  }
  if (candidates.size !== 1) throw new Error('Ambiguous or nonexistent daylight-saving time');
  return new Date([...candidates][0]).toISOString();
}
export function parseFeet(text: string): number | null {
  const value = text.trim().replace(/[’′]/g, "'").replace(/[”″]/g, '"');
  const inch = /^(\d{1,2})\s*(?:'|ft\s*|[- ]\s*)(\d{1,2})?\s*(?:"|in)?$/i.exec(value);
  if (inch) {
    const inches = Number(inch[2] || 0);
    return inches < 12 ? Number(inch[1]) + inches / 12 : null;
  }
  const decimal = /^(\d{1,2}(?:\.\d+)?)\s*(?:feet|ft)?$/i.exec(value);
  return decimal ? Number(decimal[1]) : null;
}
const wellPattern = /\b(Gunslinger(?:\s+Federal)?\s*[35](?:-\d+(?:-\d+)*[Hh])?|Cyclone\s*[2-5](?:-\d+(?:-\d+)*[Hh])?|Kahuna\s*5(?:-\d+(?:-\d+)*[Hh])?)/ig;
export function normalizeWell(text: string): string { return text.toLowerCase().replace(/[^a-z0-9]/g, ''); }
export function parsePullChat(text: string, options: PullImportOptions = {}): PullImportRow[] {
  const rows: PullImportRow[] = [];
  const catalogueNames = (options.wellNames || []).filter(Boolean).sort((a, b) => b.length - a.length).map(name => [...name].map(character => String.fromCharCode(92) + 'u' + character.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
  const boundary = String.fromCharCode(92) + 'b';
  const namesPattern = catalogueNames.length ? new RegExp(boundary + '(?:' + wellPattern.source + '|' + catalogueNames.join('|') + ')' + boundary, 'ig') : wellPattern;
  for (const message of splitChat(text)) {
    const body = message.body.trim();
    if (/message was deleted|<.*omitted>|message_history_notice|end-to-end encrypted/i.test(body)) continue;
    const matches = [...body.matchAll(namesPattern)];
    const segments = matches.length ? matches.map((match, i) => ({ well: match[0], body: body.slice((match.index || 0) + match[0].length, matches[i + 1]?.index ?? body.length) })) : [{ well: options.defaultWell || '', body }];
    for (let part = 0; part < segments.length; part++) {
      const segment = segments[part];
      let inlineTime = '';
      const lines = segment.body.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
        const suffix = /\s+(\d{1,4}(?::\d{2})?\s*[ap](?:m)?)$/i.exec(line);
        if (suffix && clock(suffix[1])) { inlineTime = suffix[1]; line = line.slice(0, suffix.index).trim(); }
        return line.replace(/^(?:T|B)\s+(?=\d)/i, '').replace(/\.(?!\d)$/, '').trim();
      });
      const labelled = /\btop\s*[:=-]?\s*([^\n]+)/i.exec(segment.body);
      const bottom = /\bbottom\s*[:=-]?\s*([^\n]+)/i.exec(segment.body);
      const pair = /^\s*[-:]?\s*(\d+(?:\.\d+)?|\d+['’]\d*)\s*\/\s*(\d+(?:\.\d+)?|\d+['’]\d*)\s*(?:\n|$)/.exec(segment.body);
      const levelLines = lines.map(line => parseFeet(line));
      const unlabelled = !labelled && !pair && levelLines.length >= 2 && levelLines[0] !== null && levelLines[1] !== null;
      const top = labelled ? parseFeet(labelled[1]) : pair ? parseFeet(pair[1]) : unlabelled ? levelLines[0] : null;
      const low = bottom ? parseFeet(bottom[1]) : pair ? parseFeet(pair[2]) : unlabelled ? levelLines[1] : null;
      const amount = /\b(\d+(?:\.\d+)?)\s*bbls?\b/i.exec(segment.body);
      const bareAmount = (pair || unlabelled) ? /^\s*(\d{2,3})(?:\.(?!\d))?\s*(.*)$/.exec(lines[pair ? 1 : 2] || '') : null;
      const bbls = amount ? Number(amount[1]) : bareAmount ? Number(bareAmount[1]) : options.defaultBbls || null;
      // A routing instruction containing a well and barrels is not a pull.
      if (!labelled && !pair && !unlabelled) {
        if (matches.length && /\btop\b|(?:^|\n)\s*(?:[TB]\s+)?\d/i.test(segment.body)) rows.push({ id: `${message.index}:${part}`, wellName: segment.well, postedAt: '', dateTimeUTC: '', tankLevelFeet: null, bottomLevelFeet: null, bblsTaken: bbls, author: message.author, source: body, issues: ['Unreadable levels'], excluded: false });
        continue;
      }
      const issues: string[] = [];
      let postedAt = '';
      try { postedAt = chatTimestamp(message.date, message.time, options.timeZone, options.dateOrder); } catch (error) { issues.push(String(error)); }
      let eventTime = postedAt;
      const explicit = inlineTime || lines.find((line, index) => index >= (pair ? 2 : unlabelled ? 3 : 0) && !!clock(line)) || bareAmount?.[2]?.trim();
      if (explicit && clock(explicit)) {
        let resolved = explicit;
        // Bare 1:30 can mean AM or PM. Choose nearest post only within two hours.
        if (!/[ap]/i.test(explicit) && Number(clock(explicit)?.hour) < 12) {
          const choices = [explicit + ' AM', explicit + ' PM'].map(time => {
            try { return { time, difference: Math.abs(Date.parse(chatTimestamp(message.date, time, options.timeZone, options.dateOrder)) - Date.parse(postedAt)) }; } catch { return { time, difference: Infinity }; }
          }).sort((a, b) => a.difference - b.difference);
          if (choices[0].difference <= 7_200_000) resolved = choices[0].time;
          else issues.push('Pull time lacks AM/PM; confirm');
        }
        try { eventTime = chatTimestamp(message.date, resolved, options.timeZone, options.dateOrder); } catch { issues.push('Invalid stated pull time'); }
      }
      if (eventTime && postedAt && (Date.parse(eventTime) > Date.parse(postedAt) + 600_000 || Date.parse(eventTime) < Date.parse(postedAt) - 7_200_000)) issues.push('Stated time is far from the post; confirm the pull date and time');
      if (matches.length > 1 && !explicit) issues.push('Multiple wells in one message; confirm individual pull times');
      if (!segment.well) issues.push('Choose the well for this shorthand message');
      if (top === null) issues.push('Invalid top level');
      if (!(bbls && bbls > 0)) issues.push('Missing barrels');
      if (top !== null && low !== null && low > top) issues.push('Bottom is higher than top');
      const date = `${message.date.split('/')[2]?.padStart(4, '20')}-${message.date.split('/')[options.dateOrder === 'dmy' ? 1 : 0]?.padStart(2, '0')}-${message.date.split('/')[options.dateOrder === 'dmy' ? 0 : 1]?.padStart(2, '0')}`;
      const excluded = !!((options.startDate && date < options.startDate) || (options.endDate && date > options.endDate));
      rows.push({ id: `${message.index}:${part}`, wellName: segment.well, postedAt, dateTimeUTC: eventTime, tankLevelFeet: top, bottomLevelFeet: low, bblsTaken: bbls, author: message.author, source: body, issues, excluded });
    }
  }
  if (rows.filter(row => !row.excluded).length > 2000) throw new Error('More than 2,000 pulls; split the export into smaller batches.');
  return rows;
}

export interface PullChatNotice { messageIndex: number; source: string; reason: string }
/** Operational changes require dated calibration review, never automatic config writes. */
export function findPullChatNotices(text: string): PullChatNotice[] {
  return splitChat(text).filter(message => /(?:opened|closed|active|inactive|added|removed|tank setup|tanks?\s+(?:on|off))[^\n]{0,50}tank|tank[^\n]{0,50}(?:opened|closed|active|inactive|setup)|\bbbls?\s*\/\s*ft/i.test(message.body)).map(message => ({ messageIndex: message.index, source: message.body, reason: 'Tank configuration may have changed; confirm the calibration and applicable date range.' }));
}

