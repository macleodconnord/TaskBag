import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
import { AdminGroupsPage } from './pages/admin/AdminGroupsPage';
import { AdminUsersPage } from './pages/admin/AdminUsersPage';
import { LoginPage } from './pages/LoginPage';
import { MyWorkPage } from './pages/MyWorkPage';
import { ScopePage } from './pages/ScopePage';
import { SearchPage } from './pages/SearchPage';
import { SettingsPage } from './pages/SettingsPage';
import { TaskPage } from './pages/TaskPage';
import { NotFoundPage } from './pages/NotFoundPage';
// feature modules
import { DocPage } from './features/docs/DocPage';
import { AdminImportPage } from './features/import/AdminImportPage';
import { AdminIntegrationsPage } from './features/integrations/AdminIntegrationsPage';
import { AdminWebhooksPage } from './features/integrations/AdminWebhooksPage';
import { InboxPage } from './features/notifications/InboxPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <MyWorkPage /> },
      { path: '/inbox', element: <InboxPage /> },
      { path: '/search', element: <SearchPage /> },
      { path: '/s/:id', element: <ScopePage scope="space" /> },
      { path: '/f/:id', element: <ScopePage scope="folder" /> },
      { path: '/l/:id', element: <ScopePage scope="list" /> },
      { path: '/everything', element: <ScopePage scope="everything" /> },
      { path: '/t/:ref', element: <TaskPage /> },
      { path: '/docs/:id', element: <DocPage /> },
      { path: '/settings', element: <SettingsPage /> },
      { path: '/admin', element: <Navigate to="/admin/users" replace /> },
      { path: '/admin/users', element: <AdminUsersPage /> },
      { path: '/admin/groups', element: <AdminGroupsPage /> },
      { path: '/admin/integrations', element: <AdminIntegrationsPage /> },
      { path: '/admin/webhooks', element: <AdminWebhooksPage /> },
      { path: '/admin/import', element: <AdminImportPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
