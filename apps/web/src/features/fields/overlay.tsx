import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { DialogProvider } from '@/components/ui';
import { queryClient } from '@/lib/queries';

/**
 * Mount a modal in its own React root, so it outlives the menu/popover that opened it
 * (menu items unmount when their popover closes). Has the query client and dialogs, not the router:
 * pass callbacks (e.g. a captured `navigate`) for navigation.
 */
export function openOverlay(render: (close: () => void) => ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    setTimeout(() => { root.unmount(); el.remove(); }, 0);
  };
  root.render(
    <QueryClientProvider client={queryClient}>
      <DialogProvider>{render(close)}</DialogProvider>
    </QueryClientProvider>,
  );
  return close;
}
