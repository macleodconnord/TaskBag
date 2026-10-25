import { useUnreadCount } from './api';

/** Unread count badge in the sidebar (polls every 30 s). */
export function InboxBadge() {
  const { data } = useUnreadCount();
  const n = data?.count ?? 0;
  if (!n) return null;
  return (
    <span
      className="min-w-5 rounded-full bg-accent-600 px-1.5 text-center text-[11px] font-semibold leading-5 text-white"
      aria-label={`${n} unread notifications`}
    >
      {n > 99 ? '99+' : n}
    </span>
  );
}
