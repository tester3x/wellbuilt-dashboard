/** Parse a keyboard-entered local deadline without converting it to UTC. */
export function parseDispatchOnsiteByInput(input: string): string | null {
  const match = input.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[,\s]+(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return null;

  const [, monthText, dayText, yearText, hourText, minuteText, meridiem] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  const year = Number(yearText);
  let hour = Number(hourText);
  const minute = Number(minuteText);
  if (year < 1 || year > 2099 || month < 1 || month > 12 || minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = hour % 12 + (meridiem.toUpperCase() === 'PM' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;

  return `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${minuteText}`;
}

export function formatDispatchOnsiteByInput(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return '';
  const [, year, month, day, hourText, minute] = match;
  const hour = Number(hourText);
  return `${month}/${day}/${year} ${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
}
