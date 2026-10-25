import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { Toaster } from './components/toast';
import { DialogProvider } from './components/ui';
import { queryClient } from './lib/queries';
import { router } from './routes';
import '@fontsource-variable/inter';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <DialogProvider>
        <RouterProvider router={router} />
        <Toaster />
      </DialogProvider>
    </QueryClientProvider>
  </StrictMode>,
);
