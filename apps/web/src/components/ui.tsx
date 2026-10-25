import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import {
  createContext, forwardRef, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { initials } from '@/lib/format';

export { clsx as cx };

/** Black or white, whichever reads better on `bg` (a #rgb/#rrggbb color) — for text on status, tag and space colors. */
export function textOn(bg: string | null | undefined): string {
  const m = (bg ?? '').trim().replace('#', '');
  const hex = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-f]{6}$/i.test(hex)) return '#ffffff';
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  // pick the side with the higher WCAG contrast ratio
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#09090b' : '#ffffff';
}

// ───────────── buttons & inputs ─────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-accent-600 text-white hover:bg-accent-700 disabled:opacity-50',
  secondary: 'border border-app bg-app hover-bg text-app disabled:opacity-50',
  ghost: 'hover-bg text-app disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }>(
  ({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }, ref) => (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent-500',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm',
        variants[variant],
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  ),
);

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: 'sm' | 'md' }>(
  ({ label, size = 'md', className, children, ...rest }, ref) => (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={clsx('inline-flex items-center justify-center rounded-md text-muted hover-bg hover:text-app disabled:opacity-40', size === 'sm' ? 'size-6' : 'size-8', className)}
      {...rest}
    >
      {children}
    </button>
  ),
);

/** width defaults to full unless the caller passes a w-* class */
const width = (c?: string) => (c && /(^|\s)w-/.test(c) ? '' : 'w-full');
const field = 'rounded-md border border-app bg-app px-2.5 text-sm text-app placeholder-dim focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/20';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...rest }, ref) => (
  <input ref={ref} className={clsx(field, width(className), 'h-8', className)} {...rest} />
));
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={clsx(field, width(className), 'py-1.5', className)} {...rest} />
));
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...rest }, ref) => (
  <select ref={ref} className={clsx(field, width(className), 'h-8 pr-7', className)} {...rest} />
));

export function Label({ children, hint, className }: { children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={clsx('mb-1 block text-xs font-medium text-muted', className)}>
      {children}
      {hint && <span className="ml-1 font-normal text-subtle">{hint}</span>}
    </label>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label hint={hint}>{label}</Label>
      {children}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 text-sm', disabled && 'cursor-default opacity-60', className)}>
      <input type="checkbox" className="size-4 rounded accent-accent-600" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export const Spinner = ({ className }: { className?: string }) => <Loader2 className={clsx('size-4 animate-spin text-subtle', className)} />;

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted">
      <Spinner /> {label}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-10 text-center">
      {icon && <div className="text-subtle">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Badge({ children, color, className }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={clsx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none', !color && 'bg-muted text-muted', className)}
      style={color ? { backgroundColor: `${color}22`, color } : undefined}
    >
      {children}
    </span>
  );
}

// ───────────── avatars ─────────────

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];
const colorFor = (id: string) => AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

export function Avatar({ user, size = 24, className }: { user: { id: string; displayName: string; avatarUrl?: string | null }; size?: number; className?: string }) {
  if (user.avatarUrl) {
    return <img src={user.avatarUrl} alt={user.displayName} title={user.displayName} className={clsx('shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />;
  }
  return (
    <span
      title={user.displayName}
      className={clsx('inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-[var(--bg)]', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.4), backgroundColor: colorFor(user.id) }}
    >
      {initials(user.displayName)}
    </span>
  );
}

export function AvatarStack({ users, max = 3, size = 22 }: { users: Array<{ id: string; displayName: string; avatarUrl?: string | null }>; max?: number; size?: number }) {
  const shown = users.slice(0, max);
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {shown.map((u) => <Avatar key={u.id} user={u} size={size} />)}
      {users.length > max && (
        <span className="inline-flex items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted ring-2 ring-[var(--bg)]" style={{ width: size, height: size }}>
          +{users.length - max}
        </span>
      )}
    </span>
  );
}

// ───────────── popover / menu ─────────────

/**
 * Click-to-open popover rendered in a portal and positioned under its trigger.
 * `trigger` receives props to spread on the anchor element.
 */
export function Popover({
  trigger, children, align = 'start', className, open: controlled, onOpenChange, width,
}: {
  trigger: (p: { ref: (el: HTMLElement | null) => void; onClick: (e: React.MouseEvent) => void; 'aria-expanded': boolean }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: 'start' | 'end';
  className?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  width?: number;
}) {
  const [internal, setInternal] = useState(false);
  const open = controlled ?? internal;
  const setOpen = useCallback((o: boolean) => {
    setInternal(o);
    onOpenChange?.(o);
  }, [onOpenChange]);
  const anchor = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const pw = panel.current?.offsetWidth ?? width ?? 220;
      const ph = panel.current?.offsetHeight ?? 200;
      let left = align === 'end' ? r.right - pw : r.left;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      let top = r.bottom + 4;
      if (top + ph > window.innerHeight - 8 && r.top - ph - 4 > 8) top = r.top - ph - 4;
      setPos({ top, left });
    };
    place();
    const id = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      // clicks inside nested popovers (also portaled) shouldn't close the parent
      if ((t as HTMLElement).closest?.('[data-popover]')) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpen]);

  const close = () => setOpen(false);
  return (
    <>
      {trigger({
        ref: (el) => { anchor.current = el; },
        onClick: (e) => { e.stopPropagation(); setOpen(!open); },
        'aria-expanded': open,
      })}
      {open && createPortal(
        <div
          ref={panel}
          data-popover
          onClick={(e) => e.stopPropagation()}
          className={clsx('fixed z-50 rounded-lg border border-app bg-app p-1 shadow-xl', className)}
          style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, width }}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>,
        document.body,
      )}
    </>
  );
}

export function MenuItem({ icon, children, onClick, danger, active, disabled, right }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; danger?: boolean; active?: boolean; disabled?: boolean; right?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover-bg disabled:opacity-40',
        danger ? 'text-red-600 dark:text-red-400' : 'text-app',
        active && 'bg-muted',
      )}
    >
      {icon && <span className="flex size-4 items-center justify-center text-muted">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {right}
    </button>
  );
}
export const MenuSeparator = () => <div className="my-1 h-px bg-[var(--border)]" />;
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">{children}</div>;

// ───────────── modal ─────────────

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full rounded-xl border border-app bg-app shadow-2xl" style={{ maxWidth: width }} role="dialog" aria-modal>
        {title && (
          <div className="flex items-center justify-between border-b border-app px-4 py-3">
            <h2 className="font-semibold">{title}</h2>
            <IconButton label="Close" size="sm" onClick={onClose}><X className="size-4" /></IconButton>
          </div>
        )}
        <div className="p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-app px-4 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ───────────── confirm / prompt dialogs (promise-based) ─────────────

type DialogReq =
  | { kind: 'confirm'; title: string; body?: ReactNode; confirm?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: 'prompt'; title: string; label?: string; initial?: string; confirm?: string; resolve: (v: string | null) => void };
const DialogCtx = createContext<(r: DialogReq) => void>(() => {});

export function DialogProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<DialogReq | null>(null);
  const [value, setValue] = useState('');
  const close = (result: boolean) => {
    if (!req) return;
    if (req.kind === 'confirm') req.resolve(result);
    else req.resolve(result ? value : null);
    setReq(null);
  };
  return (
    <DialogCtx.Provider value={(r) => { setValue(r.kind === 'prompt' ? r.initial ?? '' : ''); setReq(r); }}>
      {children}
      <Modal
        open={!!req}
        onClose={() => close(false)}
        title={req?.title}
        width={420}
        footer={
          <>
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={req?.kind === 'confirm' && req.danger ? 'danger' : 'primary'} onClick={() => close(true)} disabled={req?.kind === 'prompt' && !value.trim()}>
              {req?.confirm ?? 'OK'}
            </Button>
          </>
        }
      >
        {req?.kind === 'confirm' && <div className="text-sm text-muted">{req.body}</div>}
        {req?.kind === 'prompt' && (
          <form onSubmit={(e) => { e.preventDefault(); if (value.trim()) close(true); }}>
            {req.label && <Label>{req.label}</Label>}
            <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          </form>
        )}
      </Modal>
    </DialogCtx.Provider>
  );
}

export function useDialogs() {
  const open = useContext(DialogCtx);
  return {
    confirm: (o: { title: string; body?: ReactNode; confirm?: string; danger?: boolean }) => new Promise<boolean>((resolve) => open({ kind: 'confirm', ...o, resolve })),
    prompt: (o: { title: string; label?: string; initial?: string; confirm?: string }) => new Promise<string | null>((resolve) => open({ kind: 'prompt', ...o, resolve })),
  };
}

// ───────────── tabs ─────────────

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: ReactNode; icon?: ReactNode }>; className?: string }) {
  return (
    <div className={clsx('flex items-center gap-0.5', className)}>
      {items.map((i) => (
        <button
          key={i.value}
          onClick={() => onChange(i.value)}
          className={clsx(
            'inline-flex h-8 items-center gap-1.5 border-b-2 px-2.5 text-sm font-medium',
            value === i.value ? 'border-accent-600 text-app' : 'border-transparent text-muted hover:text-app',
          )}
        >
          {i.icon}
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, children, icon }: { title: ReactNode; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-3 border-b border-app px-5">
      {icon}
      <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
      {children}
    </div>
  );
}
