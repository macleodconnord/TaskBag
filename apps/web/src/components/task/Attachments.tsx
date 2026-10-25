import { useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fileSize, timeAgo } from '@/lib/format';
import { refreshTasks } from '@/lib/queries';
import type { Attachment, TaskDetail } from '@/lib/types';
import { Button, Modal, useDialogs } from '../ui';
import { toast } from '../toast';
import { Section } from './TaskDetailView';

export const fileUrl = (a: Pick<Attachment, 'id' | 'filename'>, download = false) =>
  `/api/attachments/${a.id}/${encodeURIComponent(a.filename)}${download ? '?download=1' : ''}`;
const isImage = (a: Attachment) => a.contentType.startsWith('image/');
const isPdf = (a: Attachment) => a.contentType === 'application/pdf';

export async function uploadFiles(target: { taskId?: string; docId?: string; commentId?: string }, files: FileList | File[]) {
  const form = new FormData();
  for (const [k, v] of Object.entries(target)) if (v) form.append(k, v);
  for (const f of Array.from(files)) form.append('file', f, f.name);
  return api.upload<Attachment[]>('/attachments', form);
}

export function Attachments({ task, canEdit }: { task: TaskDetail; canEdit: boolean }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const { confirm } = useDialogs();
  const files = task.attachments.filter((a) => !a.commentId);
  if (!files.length && !canEdit) return null;

  const upload = async (list: FileList | File[]) => {
    if (!list.length) return;
    setBusy(true);
    try {
      await uploadFiles({ taskId: task.id }, list);
      refreshTasks(qc);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={`Attachments${files.length ? ` (${files.length})` : ''}`} icon={<Paperclip className="size-4 text-muted" />}
      action={canEdit && <Button size="sm" loading={busy} onClick={() => input.current?.click()}><Upload className="size-3.5" />Upload</Button>}>
      <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} />
      <div
        onDragOver={(e) => { if (canEdit) { e.preventDefault(); setDrag(true); } }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (canEdit) void upload(e.dataTransfer.files); }}
        className={`grid grid-cols-2 gap-2 rounded-lg sm:grid-cols-3 ${drag ? 'outline-2 outline-dashed outline-accent-500' : ''}`}
      >
        {files.map((a) => (
          <div key={a.id} className="group relative overflow-hidden rounded-lg border border-app">
            <button className="flex h-24 w-full items-center justify-center bg-subtle" onClick={() => (isImage(a) || isPdf(a) ? setPreview(a) : window.open(fileUrl(a, true)))}>
              {isImage(a) ? <img src={fileUrl(a)} alt={a.filename} className="h-full w-full object-cover" loading="lazy" /> : <FileText className="size-8 text-subtle" />}
            </button>
            <div className="px-2 py-1.5">
              <div className="truncate text-xs font-medium" title={a.filename}>{a.filename}</div>
              <div className="text-[11px] text-subtle">{fileSize(a.sizeBytes)} · {timeAgo(a.createdAt)}</div>
            </div>
            <div className="absolute right-1 top-1 hidden gap-1 group-hover:flex">
              <a href={fileUrl(a, true)} className="rounded bg-black/60 p-1 text-white" title="Download"><Download className="size-3.5" /></a>
              {canEdit && <button className="rounded bg-black/60 p-1 text-white" title="Delete" onClick={async () => { if (await confirm({ title: `Delete ${a.filename}?`, confirm: 'Delete', danger: true })) { await api.delete(`/attachments/${a.id}`); refreshTasks(qc); } }}><Trash2 className="size-3.5" /></button>}
            </div>
          </div>
        ))}
        {canEdit && !files.length && (
          <button onClick={() => input.current?.click()} className="col-span-full rounded-lg border border-dashed border-app p-4 text-sm text-muted hover-bg">
            Drop files here or click to upload
          </button>
        )}
      </div>
      {preview && (
        <Modal open onClose={() => setPreview(null)} title={preview.filename} width={1000}>
          {isImage(preview) ? <img src={fileUrl(preview)} alt={preview.filename} className="mx-auto max-h-[75vh]" /> : <iframe title={preview.filename} src={fileUrl(preview)} className="h-[75vh] w-full rounded" />}
        </Modal>
      )}
    </Section>
  );
}
