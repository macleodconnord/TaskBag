import type { RichText } from '@app/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CornerDownRight, MoreHorizontal, Paperclip, Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { keys, POLL_FAST, useMe, useUsers, refreshTasks } from '@/lib/queries';
import type { Comment } from '@/lib/types';
import { RichEditor, RichView, type RichEditorHandle } from '../editor';
import { toast } from '../toast';
import { Avatar, Button, MenuItem, Popover, useDialogs } from '../ui';
import { fileUrl, uploadFiles } from './Attachments';

/** Threaded comments for a task or a doc. */
export function Comments({ kind, id, canComment }: { kind: 'task' | 'doc'; id: string; canComment: boolean }) {
  const { data = [] } = useQuery({ queryKey: keys.comments(kind, id), queryFn: () => api.get<Comment[]>(`/comments/${kind}/${id}`), refetchInterval: POLL_FAST });
  const roots = data.filter((c) => !c.parentId);
  return (
    <div className="space-y-4">
      {roots.map((c) => (
        <div key={c.id}>
          <CommentItem comment={c} kind={kind} targetId={id} canComment={canComment} />
          {data.filter((r) => r.parentId === c.id).map((r) => (
            <div key={r.id} className="ml-9 mt-3 border-l-2 border-app pl-3">
              <CommentItem comment={r} kind={kind} targetId={id} canComment={canComment} isReply />
            </div>
          ))}
        </div>
      ))}
      {!roots.length && <div className="text-sm text-subtle">No comments yet.</div>}
      {canComment && <CommentComposer kind={kind} targetId={id} />}
    </div>
  );
}

function CommentItem({ comment, kind, targetId, canComment, isReply }: { comment: Comment; kind: 'task' | 'doc'; targetId: string; canComment: boolean; isReply?: boolean }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const { confirm } = useDialogs();
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const draft = useRef<RichText | null>(null);
  const mine = me?.user.id === comment.authorId;
  const refresh = () => qc.invalidateQueries({ queryKey: keys.comments(kind, targetId) });
  const author = comment.author ?? { id: comment.authorId, displayName: 'Unknown', avatarUrl: null, isSystem: false };

  return (
    <div className="group flex gap-2.5">
      <Avatar user={author} size={26} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{author.displayName}</span>
          <span className="text-xs text-subtle" title={new Date(comment.createdAt).toLocaleString()}>{timeAgo(comment.createdAt)}{comment.editedAt && ' · edited'}</span>
          {mine && !comment.deletedAt && (
            <Popover align="end" width={150} trigger={(p) => <button {...p} className="ml-auto text-subtle opacity-0 hover:text-app group-hover:opacity-100" aria-label="Comment actions"><MoreHorizontal className="size-4" /></button>}>
              {(close) => (
                <>
                  <MenuItem icon={<Pencil className="size-4" />} onClick={() => { close(); setEditing(true); }}>Edit</MenuItem>
                  <MenuItem danger icon={<Trash2 className="size-4" />} onClick={async () => { close(); if (await confirm({ title: 'Delete comment?', confirm: 'Delete', danger: true })) { await api.delete(`/comments/${comment.id}`); void refresh(); } }}>Delete</MenuItem>
                </>
              )}
            </Popover>
          )}
        </div>
        {comment.deletedAt ? (
          <div className="text-sm italic text-subtle">Comment deleted</div>
        ) : editing ? (
          <div className="mt-1">
            <RichEditor value={comment.body} onChange={(d) => (draft.current = d)} autofocus toolbar={false} />
            <div className="mt-1 flex gap-2">
              <Button size="sm" variant="primary" onClick={async () => { if (draft.current) await api.patch(`/comments/${comment.id}`, { body: draft.current }); setEditing(false); void refresh(); }}>Save</Button>
              <Button size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <RichView value={comment.body} className="text-sm" />
        )}
        {comment.attachments.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {comment.attachments.map((a) => a.contentType.startsWith('image/')
              ? <a key={a.id} href={fileUrl(a)} target="_blank" rel="noreferrer"><img src={fileUrl(a)} alt={a.filename} className="h-20 rounded border border-app object-cover" /></a>
              : <a key={a.id} href={fileUrl(a, true)} className="inline-flex items-center gap-1 rounded border border-app px-2 py-1 text-xs hover-bg"><Paperclip className="size-3" />{a.filename}</a>)}
          </div>
        )}
        {!isReply && canComment && !comment.deletedAt && !replying && (
          <button className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-app" onClick={() => setReplying(true)}><CornerDownRight className="size-3" />Reply</button>
        )}
        {replying && <div className="mt-2"><CommentComposer kind={kind} targetId={targetId} parentId={comment.id} onDone={() => setReplying(false)} autofocus /></div>}
      </div>
    </div>
  );
}

function CommentComposer({ kind, targetId, parentId, onDone, autofocus }: { kind: 'task' | 'doc'; targetId: string; parentId?: string; onDone?: () => void; autofocus?: boolean }) {
  const qc = useQueryClient();
  const { data: users = [] } = useUsers();
  const editor = useRef<RichEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!editor.current || (editor.current.isEmpty() && !files.length)) return;
    setBusy(true);
    try {
      const body = editor.current.isEmpty() ? { type: 'doc' as const, content: [{ type: 'paragraph', content: [{ type: 'text', text: '📎' }] }] } : editor.current.getJSON();
      const c = await api.post<Comment & { cannotSee: string[] }>(`/comments/${kind}/${targetId}`, { body, parentId: parentId ?? null });
      if (files.length) await uploadFiles({ commentId: c.id }, files);
      if (c.cannotSee.length) {
        const names = c.cannotSee.map((id) => users.find((u) => u.id === id)?.displayName ?? 'Someone').join(', ');
        toast.error(`${names} can’t see this ${kind}, so they won’t be notified.`);
      }
      editor.current.clear();
      setFiles([]);
      void qc.invalidateQueries({ queryKey: keys.comments(kind, targetId) });
      refreshTasks(qc);
      onDone?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <RichEditor ref={editor} value={null} onSubmit={submit} placeholder={parentId ? 'Reply… (Ctrl+Enter to send)' : 'Comment… @ to mention, Ctrl+Enter to send'} toolbar={false} autofocus={autofocus} minHeight={44} />
      <div className="mt-1.5 flex items-center gap-2">
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => { setFiles([...files, ...Array.from(e.target.files ?? [])]); e.target.value = ''; }} />
        <button className="text-subtle hover:text-app" title="Attach files" onClick={() => fileInput.current?.click()}><Paperclip className="size-4" /></button>
        {files.map((f, i) => <span key={i} className="rounded bg-muted px-1.5 py-0.5 text-xs">{f.name} <button onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></span>)}
        <div className="ml-auto flex gap-2">
          {onDone && <Button size="sm" onClick={onDone}>Cancel</Button>}
          <Button size="sm" variant="primary" loading={busy} onClick={submit}>{parentId ? 'Reply' : 'Comment'}</Button>
        </div>
      </div>
    </div>
  );
}
