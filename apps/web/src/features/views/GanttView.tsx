import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUpdateTask } from '@/lib/queries';
import type { Task } from '@/lib/types';
import { StatusDot } from '@/components/pickers';
import { useOpenTask } from '@/components/task/TaskDrawer';
import { Button, cx, Tabs } from '@/components/ui';
import { isDone } from '@/components/views/grouping';
import { useDependencyPairs } from './api';
import { canEdit } from './cells';
import { usePref } from './config';
import { addDays, dayNum, dayOf, diffDays, isoOnDay, monthShort, startOfMonth, startOfWeek, todayKey, weekday, type DayKey } from './dates';

type Zoom = 'day' | 'week' | 'month';
const PX: Record<Zoom, number> = { day: 36, week: 16, month: 5 };
const ROW_H = 34;
const HEAD_H = 48;
const NAME_W = 280;
const OVERSCAN = 10;

type DragMode = 'move' | 'start' | 'end';
interface Drag { id: string; mode: DragMode; x0: number; delta: number; moved: boolean }

/** Bar extent of a task: start→due, single day when only one is set, null when neither. */
function span(t: Task): [DayKey, DayKey] | null {
  const s = dayOf(t.startAt) ?? dayOf(t.dueAt);
  const e = dayOf(t.dueAt) ?? dayOf(t.startAt);
  if (!s || !e) return null;
  return s <= e ? [s, e] : [e, s];
}

/** Gantt / timeline (V-07): bars, drag to move, drag edges to resize, dependency arrows, zoom. */
export function GanttView({ tasks, prefKey }: { tasks: Task[]; prefKey: string }) {
  const [zoom, setZoom] = usePref<Zoom>(`gantt-zoom:${prefKey}`, 'week');
  const px = PX[zoom];
  const today = todayKey();
  const update = useUpdateTask();
  const open = useOpenTask();
  const { data: deps = [] } = useDependencyPairs(useMemo(() => tasks.map((t) => t.id), [tasks]));

  // timeline range: all bars + today, padded, aligned to the zoom unit
  const [rangeStart, days] = useMemo(() => {
    let min = today;
    let max = today;
    for (const t of tasks) {
      const s = span(t);
      if (!s) continue;
      if (s[0] < min) min = s[0];
      if (s[1] > max) max = s[1];
    }
    const pad = zoom === 'day' ? 7 : zoom === 'week' ? 21 : 60;
    let start = addDays(min, -pad);
    start = zoom === 'month' ? startOfMonth(start) : startOfWeek(start);
    const minDays = Math.ceil(2400 / px);
    const n = Math.max(diffDays(addDays(max, pad * 2), start), minDays);
    return [start, n] as const;
  }, [tasks, zoom, px, today]);
  const width = days * px;
  const xOf = (d: DayKey) => diffDays(d, rangeStart) * px;

  // scroll to today on first render / zoom change
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(800);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, xOf(today) - 160);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [zoom]); // eslint-disable-line react-hooks/exhaustive-deps
  const scrollToToday = () => { if (scroller.current) scroller.current.scrollLeft = Math.max(0, xOf(today) - 160); };

  // ── drag / resize ──
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const startDrag = (t: Task, mode: DragMode) => (e: React.PointerEvent) => {
    if (!canEdit(t) || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const d: Drag = { id: t.id, mode, x0: e.clientX, delta: 0, moved: false };
    dragRef.current = d;
    setDrag(d);
    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current!;
      const delta = Math.round((ev.clientX - cur.x0) / px);
      const moved = cur.moved || Math.abs(ev.clientX - cur.x0) > 3;
      if (delta !== cur.delta || moved !== cur.moved) {
        dragRef.current = { ...cur, delta, moved };
        setDrag(dragRef.current);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const cur = dragRef.current!;
      dragRef.current = null;
      setDrag(null);
      if (!cur.moved) { if (mode === 'move') open(t.key); return; }
      if (!cur.delta) return;
      commit(t, cur.mode, cur.delta);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const preview = (t: Task): [DayKey, DayKey] | null => {
    const s = span(t);
    if (!s || !drag || drag.id !== t.id || !drag.delta) return s;
    const [a, b] = s;
    if (drag.mode === 'move') return [addDays(a, drag.delta), addDays(b, drag.delta)];
    if (drag.mode === 'start') { const n = addDays(a, drag.delta); return [n > b ? b : n, b]; }
    const n = addDays(b, drag.delta);
    return [a, n < a ? a : n];
  };

  const commit = (t: Task, mode: DragMode, delta: number) => {
    const [a, b] = span(t)!;
    const patch: { startAt?: string | null; dueAt?: string | null } = {};
    if (mode === 'move') {
      if (t.startAt) patch.startAt = isoOnDay(addDays(dayOf(t.startAt)!, delta), t.startAt);
      if (t.dueAt) patch.dueAt = isoOnDay(addDays(dayOf(t.dueAt)!, delta), t.dueAt);
    } else if (mode === 'start') {
      let n = addDays(a, delta);
      if (n > b) n = b;
      patch.startAt = isoOnDay(n, t.startAt);
      if (!t.dueAt) patch.dueAt = isoOnDay(b, t.startAt); // was a start-only bar: keep its end
    } else {
      let n = addDays(b, delta);
      if (n < a) n = a;
      patch.dueAt = isoOnDay(n, t.dueAt);
      if (!t.startAt) patch.startAt = isoOnDay(a, t.dueAt); // was a due-only bar: keep its start
    }
    update.mutate({ id: t.id, ...patch });
  };

  const schedule = (t: Task, e: React.MouseEvent<HTMLDivElement>) => {
    if (!canEdit(t) || span(t)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const day = addDays(rangeStart, Math.floor((e.clientX - rect.left) / px));
    update.mutate({ id: t.id, startAt: isoOnDay(day), dueAt: isoOnDay(day) });
  };

  // ── windowing + arrows ──
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(tasks.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const rowOf = useMemo(() => new Map(tasks.map((t, i) => [t.id, i])), [tasks]);
  const arrows = deps.flatMap((d) => {
    const from = rowOf.get(d.dependsOnTaskId);
    const to = rowOf.get(d.taskId);
    if (from === undefined || to === undefined) return [];
    if (Math.max(from, to) < first || Math.min(from, to) > last) return [];
    const sa = preview(tasks[from]);
    const sb = preview(tasks[to]);
    if (!sa || !sb) return [];
    const x1 = xOf(sa[1]) + px;
    const y1 = from * ROW_H + ROW_H / 2;
    const x2 = xOf(sb[0]);
    const y2 = to * ROW_H + ROW_H / 2;
    const late = sb[0] <= sa[1];
    const path = x2 - 6 >= x1 + 6
      ? `M${x1},${y1} H${x1 + 6} V${y2} H${x2 - 1}`
      : `M${x1},${y1} H${x1 + 6} V${y1 + (y2 > y1 ? ROW_H / 2 : -ROW_H / 2)} H${x2 - 10} V${y2} H${x2 - 1}`;
    return [{ key: `${d.dependsOnTaskId}>${d.taskId}`, path, late }];
  });

  const scale = useMemo(() => buildScale(rangeStart, days, zoom), [rangeStart, days, zoom]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-app px-4 py-1.5">
        <Button size="sm" onClick={scrollToToday}>Today</Button>
        <span className="text-xs text-subtle">Drag bars to move, drag their edges to change start or due. Click an empty row to schedule.</span>
        <Tabs className="ml-auto" value={zoom} onChange={setZoom} items={[{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }]} />
      </div>
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div className="relative" style={{ width: NAME_W + width, height: HEAD_H + tasks.length * ROW_H }}>
          {/* header */}
          <div className="sticky top-0 z-30 flex border-b border-app bg-subtle" style={{ height: HEAD_H }}>
            <div className="sticky left-0 z-10 flex items-end border-r border-app bg-subtle px-3 pb-1.5 text-xs font-medium text-muted" style={{ width: NAME_W, minWidth: NAME_W }}>Task</div>
            <div className="relative" style={{ width }}>
              {scale.top.map((s) => (
                <div key={`t${s.x}`} className="absolute top-0 truncate border-l border-app px-1.5 pt-1 text-xs font-semibold" style={{ left: s.x, width: s.w, height: HEAD_H / 2 }}>{s.label}</div>
              ))}
              {scale.bottom.map((s) => (
                <div key={`b${s.x}`} className={cx('absolute truncate border-l border-app text-center text-[11px]', s.today ? 'font-semibold text-accent-600' : s.weekend ? 'text-subtle' : 'text-muted')}
                  style={{ left: s.x, width: s.w, top: HEAD_H / 2, height: HEAD_H / 2, lineHeight: `${HEAD_H / 2}px` }}>{s.label}</div>
              ))}
            </div>
          </div>
          {/* grid background: weekends (day zoom) and today line */}
          <div className="pointer-events-none absolute bottom-0" style={{ left: NAME_W, top: HEAD_H, width }}>
            {zoom === 'day' && scale.bottom.filter((s) => s.weekend).map((s) => <div key={s.x} className="absolute inset-y-0 bg-muted opacity-60" style={{ left: s.x, width: s.w }} />)}
            <div className="absolute inset-y-0 w-0.5 bg-accent-500/70" style={{ left: xOf(today) + px / 2 }} title="Today" />
          </div>
          {/* dependency arrows */}
          <svg className="pointer-events-none absolute" style={{ left: NAME_W, top: HEAD_H, width, height: tasks.length * ROW_H }} aria-hidden>
            <defs>
              <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#94a3b8" /></marker>
              <marker id="gantt-arrow-late" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#ef4444" /></marker>
            </defs>
            {arrows.map((a) => (
              <path key={a.key} d={a.path} fill="none" strokeWidth={1.5} markerEnd={a.late ? 'url(#gantt-arrow-late)' : 'url(#gantt-arrow)'}
                stroke={a.late ? '#ef4444' : '#94a3b8'}><title>{a.late ? 'Starts before the task it waits on is due' : 'Waits on'}</title></path>
            ))}
          </svg>
          {/* rows */}
          {tasks.slice(first, last).map((t, i) => {
            const row = first + i;
            const s = preview(t);
            const done = isDone(t);
            const editable = canEdit(t);
            const color = t.status?.color ?? '#94a3b8';
            return (
              <div key={t.id} className="group absolute left-0 flex" style={{ top: HEAD_H + row * ROW_H, height: ROW_H, width: NAME_W + width }}>
                <div className="sticky left-0 z-20 flex items-center gap-2 border-b border-r border-app bg-app px-3 text-sm group-hover:bg-[var(--bg-hover)]" style={{ width: NAME_W, minWidth: NAME_W }}>
                  <StatusDot status={t.status} size={11} />
                  <button className={cx('min-w-0 truncate text-left hover:underline', done && 'text-muted line-through')} onClick={() => open(t.key)} title={t.name}>
                    {t.parentTaskId && <span className="mr-1 text-subtle">↳</span>}{t.name}
                  </button>
                </div>
                <div className={cx('relative border-b border-app', !s && editable && 'cursor-copy')} style={{ width }} onClick={(e) => schedule(t, e)}
                  title={!s && editable ? 'Click to schedule on this day' : undefined}>
                  {s && (
                    <div
                      className={cx('absolute top-1.5 flex select-none items-center rounded-md text-[11px] font-medium text-white shadow-sm',
                        editable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer', drag?.id === t.id && 'ring-2 ring-accent-500')}
                      style={{ left: xOf(s[0]) + 1, width: Math.max(px * (diffDays(s[1], s[0]) + 1) - 2, 6), height: ROW_H - 12, backgroundColor: color, opacity: done ? 0.55 : 1 }}
                      onPointerDown={editable ? startDrag(t, 'move') : undefined}
                      onClick={editable ? undefined : (e) => { e.stopPropagation(); open(t.key); }}
                      title={`${t.name}\n${s[0]} → ${s[1]}`}
                      data-bar={t.key}
                    >
                      {editable && <span onPointerDown={startDrag(t, 'start')} className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md hover:bg-black/20" aria-label="Change start" />}
                      <span className="truncate px-2">{px * (diffDays(s[1], s[0]) + 1) > 60 ? t.name : ''}</span>
                      {editable && <span onPointerDown={startDrag(t, 'end')} className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md hover:bg-black/20" aria-label="Change due" />}
                    </div>
                  )}
                  {s && px * (diffDays(s[1], s[0]) + 1) <= 60 && (
                    <span className="pointer-events-none absolute top-0 truncate text-xs text-muted" style={{ left: xOf(s[1]) + px + 6, lineHeight: `${ROW_H}px`, maxWidth: 240 }}>{t.name}</span>
                  )}
                </div>
              </div>
            );
          })}
          {!tasks.length && <div className="absolute p-8 text-sm text-muted" style={{ top: HEAD_H, left: NAME_W }}>No tasks match this view.</div>}
        </div>
      </div>
    </div>
  );
}

interface Seg { x: number; w: number; label: string; today?: boolean; weekend?: boolean }

function buildScale(start: DayKey, days: number, zoom: Zoom): { top: Seg[]; bottom: Seg[] } {
  const px = PX[zoom];
  const today = todayKey();
  const top: Seg[] = [];
  const bottom: Seg[] = [];
  const push = (arr: Seg[], i: number, label: string, extra: Partial<Seg> = {}) => {
    const prev = arr[arr.length - 1];
    if (prev) prev.w = i * px - prev.x;
    arr.push({ x: i * px, w: 0, label, ...extra });
  };
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    if (zoom === 'month') {
      if (i === 0 || d.slice(5) === '01-01') push(top, i, d.slice(0, 4));
      if (i === 0 || dayNum(d) === 1) push(bottom, i, monthShort(d));
    } else {
      if (i === 0 || dayNum(d) === 1) push(top, i, `${monthShort(d)} ${d.slice(0, 4)}`);
      if (zoom === 'day') push(bottom, i, String(dayNum(d)), { today: d === today, weekend: weekday(d) >= 5 });
      else if (i === 0 || weekday(d) === 0) push(bottom, i, `${monthShort(d)} ${dayNum(d)}`, { today: startOfWeek(today) === d });
    }
  }
  for (const arr of [top, bottom]) { const l = arr[arr.length - 1]; if (l) l.w = days * px - l.x; }
  return { top, bottom };
}
