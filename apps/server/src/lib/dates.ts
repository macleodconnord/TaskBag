/** Timezone helpers (no external deps). Store UTC; interpret relative tokens in the user's timezone. */
export const DEFAULT_TZ = 'America/Chicago';

/** Offset in minutes of `tz` at instant `d` (e.g. -300 for CDT). */
export function tzOffsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - d.getTime()) / 60_000);
}

/** Start of the calendar day containing `d` in `tz`, as a UTC Date. */
export function startOfDay(d: Date, tz: string): Date {
  const off = tzOffsetMinutes(d, tz);
  const local = new Date(d.getTime() + off * 60_000);
  const midnightLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // re-evaluate offset at midnight (DST transitions)
  const off2 = tzOffsetMinutes(new Date(midnightLocalAsUtc - off * 60_000), tz);
  return new Date(midnightLocalAsUtc - off2 * 60_000);
}

export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/** Monday-based week start in `tz`. */
export function startOfWeek(d: Date, tz: string): Date {
  const sod = startOfDay(d, tz);
  const local = new Date(sod.getTime() + tzOffsetMinutes(sod, tz) * 60_000);
  const dow = (local.getUTCDay() + 6) % 7;
  return startOfDay(addDays(sod, -dow), tz);
}

/** Resolve a filter date value (ISO or relative token) to a [start, end) range. */
export function resolveDateRange(value: unknown, tz: string, now = new Date()): [Date, Date] | null {
  if (typeof value !== 'string' || !value) return null;
  const today = startOfDay(now, tz);
  switch (value) {
    case 'now': return [now, now];
    case 'today': return [today, startOfDay(addDays(today, 1.5), tz)];
    case 'yesterday': return [startOfDay(addDays(today, -0.5), tz), today];
    case 'tomorrow': {
      const t = startOfDay(addDays(today, 1.5), tz);
      return [t, startOfDay(addDays(t, 1.5), tz)];
    }
    case 'this_week': {
      const w = startOfWeek(now, tz);
      return [w, startOfWeek(addDays(w, 7.5), tz)];
    }
    case 'next_week': {
      const w = startOfWeek(addDays(startOfWeek(now, tz), 7.5), tz);
      return [w, startOfWeek(addDays(w, 7.5), tz)];
    }
    case 'next_7_days': return [today, startOfDay(addDays(today, 7.5), tz)];
    case 'last_7_days': return [startOfDay(addDays(today, -6.5), tz), startOfDay(addDays(today, 1.5), tz)];
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    // date-only: whole local day
    const s = startOfDay(new Date(d.getTime() + 12 * 3_600_000), tz);
    return [s, startOfDay(addDays(s, 1.5), tz)];
  }
  return [d, d];
}

export function formatInTz(d: Date, tz: string, withTime: boolean) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, month: 'short', day: 'numeric', year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(d);
}
