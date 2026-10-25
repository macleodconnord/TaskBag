import { useNavigate, useParams } from 'react-router';
import { TaskDetailView } from '@/components/task/TaskDetailView';

export function TaskPage() {
  const { ref } = useParams();
  const nav = useNavigate();
  return (
    <div className="h-full overflow-y-auto">
      <TaskDetailView taskRef={ref!} onDeleted={() => nav('/')} />
    </div>
  );
}
