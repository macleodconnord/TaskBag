import { AlertTriangle } from 'lucide-react';
import { useEffect } from 'react';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { setUserTimezone } from '@/lib/format';
import { useMe, useUsers } from '@/lib/queries';
import { setTheme } from '@/lib/theme';
import { TaskDrawer } from '@/components/task/TaskDrawer';
import { Loading } from '@/components/ui';
import { Sidebar } from './Sidebar';

export function AppLayout() {
  const { data, isLoading, error } = useMe();
  const location = useLocation();
  const [params] = useSearchParams();
  useUsers(); // warm the people cache for pickers and @mentions
  useEffect(() => {
    if (data?.user) {
      setTheme(data.user.theme);
      setUserTimezone(data.user.timezone);
    }
  }, [data?.user]);

  if (isLoading) return <Loading />;
  if (error || !data) return <Navigate to={`/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`} replace />;

  const taskRef = params.get('task');
  return (
    <div className="flex h-full flex-col">
      {data.viaBreakglass && (
        <div className="flex items-center justify-center gap-2 bg-amber-500 px-3 py-1 text-xs font-medium text-black">
          <AlertTriangle className="size-3.5" /> Signed in with the break-glass admin account. Every action is logged — sign out when done.
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <Sidebar me={data.user} />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <Outlet />
        </main>
      </div>
      {taskRef && <TaskDrawer taskRef={taskRef} />}
    </div>
  );
}
