/** Dispatches contain both Firestore timestamps and epoch milliseconds from WB Tickets. */
export function dispatchTimestampToDate(value: unknown): Date | null {
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else if (value && typeof value === 'object') {
    const timestamp = value as { toDate?: () => Date; seconds?: number };
    if (typeof timestamp.toDate === 'function') {
      date = timestamp.toDate();
    } else if (typeof timestamp.seconds === 'number') {
      date = new Date(timestamp.seconds * 1000);
    } else {
      return null;
    }
  } else {
    return null;
  }
  return Number.isFinite(date.getTime()) ? date : null;
}
