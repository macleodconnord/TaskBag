import { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, X } from 'lucide-react';

type Toast = { id: number; kind: 'ok' | 'error'; text: string };
let next = 1;
let items: Toast[] = [];
const subs = new Set<(t: Toast[]) => void>();
const publish = () => subs.forEach((s) => s([...items]));

function push(kind: Toast['kind'], text: string) {
  const t = { id: next++, kind, text };
  items = [...items.slice(-3), t];
  publish();
  setTimeout(() => dismiss(t.id), kind === 'error' ? 6000 : 3000);
}
function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  publish();
}

export const toast = { ok: (t: string) => push('ok', t), error: (t: string) => push('error', t) };

export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    subs.add(setList);
    return () => void subs.delete(setList);
  }, []);
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {list.map((t) => (
        <div key={t.id} className="flex max-w-sm items-start gap-2 rounded-lg border border-app bg-app px-3 py-2 text-sm shadow-lg">
          {t.kind === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-600" /> : <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-600" />}
          <span className="flex-1">{t.text}</span>
          <button className="text-subtle hover:text-app" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
