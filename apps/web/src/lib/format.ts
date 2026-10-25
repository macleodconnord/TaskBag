/** Dates are stored in UTC and shown in the user's timezone (or the browser's). */
let userTz: string | undefined;
export const setUserTimezone = (tz: string | null | undefined) => {
  userTz = tz || undefined;
};
export const timezone = () => userTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export function dayDiff(iso: string, now = new Date()): number {
  const a = new Date(dayKey(new Date(iso)));
  const b = new Date(dayKey(now));
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

export function formatDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  const sameYear = dayKey(d).slice(0, 4) === dayKey(new Date()).slice(0, 4);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone(), month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(d);
}

/** "Today", "Tomorrow", "Yesterday", weekday within a week, else date. */
export function formatDue(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '';
  const diff = dayDiff(iso);
  const time = withTime ? ` ${new Intl.DateTimeFormat('en-US', { timeZone: timezone(), hour: 'numeric', minute: '2-digit' }).format(new Date(iso))}` : '';
  if (diff === 0) return `Today${time}`;
  if (diff === 1) return `Tomorrow${time}`;
  if (diff === -1) return `Yesterday${time}`;
  if (diff > 1 && diff < 7) return new Intl.DateTimeFormat('en-US', { timeZone: timezone(), weekday: 'short' }).format(new Date(iso)) + time;
  return formatDate(iso, withTime);
}

export function dueTone(iso: string | null | undefined, done: boolean): string {
  if (!iso || done) return 'text-muted';
  const diff = dayDiff(iso);
  if (diff < 0) return 'text-red-600 dark:text-red-400';
  if (diff === 0) return 'text-amber-600 dark:text-amber-400';
  return 'text-muted';
}

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return formatDate(iso);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function minutesLabel(min: number | null | undefined): string {
  if (!min) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  let total = 0;
  const re = /(\d+(?:\.\d+)?)\s*(h|m|d)/g;
  let m: RegExpExecArray | null;
  let matched = false;
  while ((m = re.exec(t))) {
    matched = true;
    total += Number(m[1]) * (m[2] === 'h' ? 60 : m[2] === 'd' ? 480 : 1);
  }
  return matched ? Math.round(total) : null;
}

/** ISO date (yyyy-mm-dd) in the user's timezone, for <input type="date">. */
export const toDateInput = (iso: string | null | undefined) => (iso ? dayKey(new Date(iso)) : '');

/** A yyyy-mm-dd picked in the UI → ISO instant at local noon (date-only semantics survive tz shifts). */
export function fromDateInput(v: string): string | null {
  if (!v) return null;
  return new Date(`${v}T12:00:00`).toISOString();
}

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
