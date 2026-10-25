/**
 * Calendar-day arithmetic on "yyyy-mm-dd" keys (days in the user's timezone). Keys are converted to
 * UTC-midnight Dates only for arithmetic, so DST and browser timezone never shift a day.
 */
import { fromDateInput, toDateInput } from '@/lib/format';

export type DayKey = string;

const toUtc = (k: DayKey) => {
  const [y, m, d] = k.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number): DayKey => new Date(ms).toISOString().slice(0, 10);

export const todayKey = (): DayKey => toDateInput(new Date().toISOString());
export const dayOf = (iso: string | null | undefined): DayKey | null => (iso ? toDateInput(iso) : null);
export const addDays = (k: DayKey, n: number): DayKey => fromUtc(toUtc(k) + n * 86_400_000);
export const diffDays = (a: DayKey, b: DayKey) => Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
/** 0 = Monday … 6 = Sunday */
export const weekday = (k: DayKey) => (new Date(toUtc(k)).getUTCDay() + 6) % 7;
export const startOfWeek = (k: DayKey) => addDays(k, -weekday(k));
export const startOfMonth = (k: DayKey) => `${k.slice(0, 7)}-01`;
export const addMonths = (k: DayKey, n: number): DayKey => {
  const d = new Date(toUtc(startOfMonth(k)));
  d.setUTCMonth(d.getUTCMonth() + n);
  return fromUtc(d.getTime());
};
export const dayNum = (k: DayKey) => Number(k.slice(8, 10));
export const sameMonth = (a: DayKey, b: DayKey) => a.slice(0, 7) === b.slice(0, 7);

const fmt = (k: DayKey, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...o }).format(new Date(toUtc(k)));
export const monthLabel = (k: DayKey) => fmt(k, { month: 'long', year: 'numeric' });
export const shortLabel = (k: DayKey) => fmt(k, { month: 'short', day: 'numeric' });
export const weekdayShort = (k: DayKey) => fmt(k, { weekday: 'short' });
export const monthShort = (k: DayKey) => fmt(k, { month: 'short' });

/** Move an instant by whole days, keeping its time of day. */
export const shiftIso = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();

/** Put a date on day `k`: keep the time of day of `prev` if given, else noon (date-only semantics). */
export function isoOnDay(k: DayKey, prev?: string | null): string {
  if (prev) {
    const from = dayOf(prev);
    if (from) return shiftIso(prev, diffDays(k, from));
  }
  return fromDateInput(k)!;
}
