type Wall = { year: number; month: number; day: number; hour: number; minute: number };
export function wallTime(at: number, timeZone: string): Wall {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])) as Wall;
}
const naive = (value: Wall) => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute);
const fromUtc = (at: number): Wall => {
  const d = new Date(at);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
};
function instant(value: Wall, zone: string): number | null {
  const target = naive(value);
  if (JSON.stringify(fromUtc(target)) !== JSON.stringify(value)) return null;
  // Check offsets on both sides of a DST change. An ambiguous minute requires an explicit different time.
  const offsets = new Set([-2, 0, 2].map(days => {
    const sample = target + days * 86400000;
    return naive(wallTime(sample, zone)) - sample;
  }));
  const matches = [...offsets].map(offset => target - offset).filter(candidate => naive(wallTime(candidate, zone)) === target);
  return matches.length === 1 ? matches[0]! : null;
}
export function calendarDeadline(now: number, zone: string, days: number, hour?: number) {
  const time = wallTime(now, zone);
  const day = fromUtc(naive(time) + days * 86400000);
  if (hour !== undefined) { day.hour = hour; day.minute = 0; }
  return instant(day, zone);
}
export function parseDeadline(text: string, now: number, zone: string): number | null {
  const parts = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s+(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!parts) return null;
  const [, day, month, year, hour, minute] = parts;
  const current = wallTime(now, zone);
  const value = { year: year ? Number(year) : current.year, month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) };
  if (!year && (value.month < current.month || value.month === current.month && value.day < current.day)) value.year++;
  if (value.year > current.year + 5 || value.year < current.year) return null;
  const result = instant(value, zone);
  return result !== null && result > now ? result : null;
}
export const dayKey = (at: number, zone: string) => {
  const { year, month, day } = wallTime(at, zone);
  return year * 10000 + month * 100 + day;
};
