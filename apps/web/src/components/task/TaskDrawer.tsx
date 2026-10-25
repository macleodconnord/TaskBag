import { Maximize2, X } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router';
import { IconButton } from '../ui';
import { TaskDetailView } from './TaskDetailView';

/** Task detail as a right-hand drawer, opened from any page with `?task=KEY`. */
export function TaskDrawer({ taskRef }: { taskRef: string }) {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const close = () => {
    const p = new URLSearchParams(params);
    p.delete('task');
    setParams(p, { replace: false });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[data-popover], [role=dialog]')) close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  return createPortal(
    <div className="fixed inset-0 z-30 flex justify-end bg-black/20" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="flex h-full w-full max-w-4xl flex-col border-l border-app bg-app shadow-2xl">
        <div className="flex h-11 shrink-0 items-center justify-end gap-1 border-b border-app px-2">
          <IconButton label="Open full page" onClick={() => nav(`/t/${taskRef}`)}><Maximize2 className="size-4" /></IconButton>
          <IconButton label="Close" onClick={close}><X className="size-4" /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TaskDetailView taskRef={taskRef} onDeleted={close} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Hook: open a task in the drawer (keeps the current page). */
export function useOpenTask() {
  const [params, setParams] = useSearchParams();
  return (key: string) => {
    const p = new URLSearchParams(params);
    p.set('task', key);
    setParams(p);
  };
}
