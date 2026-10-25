import type { RichText } from '@app/shared';
import { Extension, type Editor as CoreEditor, type Range } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Mention from '@tiptap/extension-mention';
import { TableKit } from '@tiptap/extension-table';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { Placeholder } from '@tiptap/extensions';
import { PluginKey } from '@tiptap/pm/state';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import {
  Bold, Code, Columns3, Heading1, Heading2, Heading3, Image as ImageIcon, Italic, Link2, List, ListChecks, ListOrdered,
  Minus, Quote, Rows3, SquareCode, Strikethrough, Table as TableIcon, Text, Trash2,
} from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { queryClient, keys } from '@/lib/queries';
import type { User } from '@/lib/types';
import { toast } from './toast';
import { Avatar, cx } from './ui';

/** Uploads an image file and returns the URL to embed. */
export type ImageUploader = (file: File) => Promise<string>;

// ───────────── suggestion popup (shared by @mentions and the / menu) ─────────────

type PopupHandle = { onKeyDown: (p: SuggestionKeyDownProps) => boolean };
type PopupList<T> = ComponentType<SuggestionProps<T> & { ref?: React.Ref<PopupHandle> }>;

/** Renders a React list next to the caret while a TipTap suggestion is active. */
function popupRenderer<T>(List: PopupList<T>, width: number) {
  return () => {
    let el: HTMLDivElement | null = null;
    let root: Root | null = null;
    const handle = { current: null as PopupHandle | null };
    const place = (props: SuggestionProps<T>) => {
      const rect = props.clientRect?.();
      if (!rect || !el) return;
      const below = rect.bottom + 4;
      const h = el.offsetHeight || 280;
      el.style.top = `${below + h > window.innerHeight - 8 ? Math.max(8, rect.top - h - 4) : below}px`;
      el.style.left = `${Math.min(rect.left, window.innerWidth - width - 8)}px`;
    };
    const render = (props: SuggestionProps<T>) => root?.render(<List ref={(r: PopupHandle | null) => { handle.current = r; }} {...props} />);
    return {
      onStart: (props: SuggestionProps<T>) => {
        el = document.createElement('div');
        el.style.position = 'fixed';
        el.style.zIndex = '60';
        el.dataset.popover = '';
        document.body.appendChild(el);
        root = createRoot(el);
        render(props);
        requestAnimationFrame(() => place(props));
      },
      onUpdate: (props: SuggestionProps<T>) => {
        render(props);
        place(props);
      },
      onKeyDown: (props: SuggestionKeyDownProps) => (props.event.key === 'Escape' ? false : handle.current?.onKeyDown(props) ?? false),
      onExit: () => {
        const r = root;
        setTimeout(() => r?.unmount());
        el?.remove();
        el = null;
        root = null;
      },
    };
  };
}

function useListKeys<T>(items: T[], pick: (i: number) => void, ref: React.Ref<PopupHandle> | undefined) {
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      const n = Math.max(1, items.length);
      if (event.key === 'ArrowDown') { setIndex((i) => (i + 1) % n); return true; }
      if (event.key === 'ArrowUp') { setIndex((i) => (i - 1 + n) % n); return true; }
      if (event.key === 'Enter' || event.key === 'Tab') { pick(index); return true; }
      return false;
    },
  }));
  return [index, setIndex] as const;
}

// ───────────── @mentions ─────────────

type MentionItem = { id: string; label: string; user: User };

const MentionList = forwardRef<PopupHandle, SuggestionProps<MentionItem>>((props, ref) => {
  const pick = (i: number) => {
    const item = props.items[i];
    if (item) props.command({ id: item.id, label: item.label });
  };
  const [index] = useListKeys(props.items, pick, ref);
  if (!props.items.length) return <div className="rounded-lg border border-app bg-app px-3 py-2 text-sm text-muted shadow-xl">No people found</div>;
  return (
    <div className="w-60 rounded-lg border border-app bg-app p-1 shadow-xl">
      {props.items.map((it, i) => (
        <button key={it.id} onMouseDown={(e) => { e.preventDefault(); pick(i); }} className={cx('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm', i === index ? 'bg-muted' : 'hover-bg')}>
          <Avatar user={it.user} size={18} />
          <span className="truncate">{it.label}</span>
        </button>
      ))}
    </div>
  );
});

const mentionSuggestion = {
  items: ({ query }: { query: string }): MentionItem[] => {
    const users = queryClient.getQueryData<User[]>(keys.users) ?? [];
    return users
      .filter((u) => !u.isSystem && u.displayName.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8)
      .map((u) => ({ id: u.id, label: u.displayName, user: u }));
  },
  render: popupRenderer(MentionList as PopupList<MentionItem>, 250),
};

// ───────────── "/" insert menu ─────────────

type SlashItem = { title: string; hint: string; icon: ReactNode; keywords: string; run: (editor: CoreEditor, range: Range) => void };

function slashItems(pickImage: (() => void) | null): SlashItem[] {
  const items: SlashItem[] = [
    { title: 'Text', hint: 'Plain paragraph', icon: <Text className="size-4" />, keywords: 'paragraph p', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
    { title: 'Heading 1', hint: 'Large section title', icon: <Heading1 className="size-4" />, keywords: 'h1 title', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
    { title: 'Heading 2', hint: 'Medium section title', icon: <Heading2 className="size-4" />, keywords: 'h2 subtitle', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
    { title: 'Heading 3', hint: 'Small section title', icon: <Heading3 className="size-4" />, keywords: 'h3', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
    { title: 'Bulleted list', hint: 'Simple list', icon: <List className="size-4" />, keywords: 'ul bullet', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
    { title: 'Numbered list', hint: '1, 2, 3', icon: <ListOrdered className="size-4" />, keywords: 'ol ordered number', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
    { title: 'Checklist', hint: 'Tick-off items', icon: <ListChecks className="size-4" />, keywords: 'todo task checkbox', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
    { title: 'Table', hint: '3 × 3 with a header row', icon: <TableIcon className="size-4" />, keywords: 'grid columns rows', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { title: 'Quote', hint: 'Call out a quote', icon: <Quote className="size-4" />, keywords: 'blockquote', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
    { title: 'Code block', hint: 'Monospaced block', icon: <SquareCode className="size-4" />, keywords: 'pre snippet', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
    { title: 'Divider', hint: 'Horizontal line', icon: <Minus className="size-4" />, keywords: 'hr rule separator', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  ];
  if (pickImage) {
    items.splice(7, 0, { title: 'Image', hint: 'Upload a picture', icon: <ImageIcon className="size-4" />, keywords: 'picture photo screenshot upload', run: (e, r) => { e.chain().focus().deleteRange(r).run(); pickImage(); } });
  }
  return items;
}

const SlashList = forwardRef<PopupHandle, SuggestionProps<SlashItem>>((props, ref) => {
  const pick = (i: number) => {
    const item = props.items[i];
    if (item) props.command(item);
  };
  const [index, setIndex] = useListKeys(props.items, pick, ref);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${index}"]`)?.scrollIntoView({ block: 'nearest' }); }, [index]);
  if (!props.items.length) return <div className="rounded-lg border border-app bg-app px-3 py-2 text-sm text-muted shadow-xl">No matching blocks</div>;
  return (
    <div ref={listRef} className="max-h-80 w-64 overflow-y-auto rounded-lg border border-app bg-app p-1 shadow-xl">
      <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">Insert</div>
      {props.items.map((it, i) => (
        <button key={it.title} data-i={i} onMouseEnter={() => setIndex(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }}
          className={cx('flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left', i === index ? 'bg-muted' : 'hover-bg')}>
          <span className="flex size-8 items-center justify-center rounded-md border border-app bg-app text-muted">{it.icon}</span>
          <span className="min-w-0">
            <span className="block text-sm">{it.title}</span>
            <span className="block truncate text-xs text-muted">{it.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
});

function slashCommands(getPickImage: () => (() => void) | null) {
  return Extension.create({
    name: 'slashCommands',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: '/',
          pluginKey: new PluginKey('slashCommands'),
          items: ({ query }) => {
            const q = query.toLowerCase();
            return slashItems(getPickImage()).filter((i) => !q || i.title.toLowerCase().includes(q) || i.keywords.includes(q));
          },
          command: ({ editor, range, props }) => props.run(editor, range),
          render: popupRenderer(SlashList as PopupList<SlashItem>, 264),
        }),
      ];
    },
  });
}

// ───────────── editor ─────────────

export interface RichEditorHandle {
  clear: () => void;
  focus: () => void;
  getJSON: () => RichText;
  isEmpty: () => boolean;
}

export const RichEditor = forwardRef<RichEditorHandle, {
  value: RichText | null | undefined;
  onChange?: (doc: RichText) => void;
  /** called on blur with the latest content, if it changed */
  onCommit?: (doc: RichText) => void;
  onSubmit?: () => void;
  placeholder?: string;
  editable?: boolean;
  toolbar?: boolean;
  className?: string;
  minHeight?: number;
  autofocus?: boolean;
  /**
   * `boxed` (default): bordered field with a toolbar — for comments and descriptions.
   * `document`: reads like a finished page; formatting appears on selection and blocks are inserted with "/".
   */
  variant?: 'boxed' | 'document';
  /** Enables tables, the "/" menu and (with `uploadImage`) inline images. Always on for `document`. */
  blocks?: boolean;
  uploadImage?: ImageUploader;
}>(({ value, onChange, onCommit, onSubmit, placeholder, editable = true, toolbar = true, className, minHeight = 60, autofocus, variant = 'boxed', blocks, uploadImage }, ref) => {
  const isDoc = variant === 'document';
  const rich = isDoc || !!blocks;
  const dirty = useRef(false);
  const submitRef = useRef(onSubmit);
  submitRef.current = onSubmit;
  const uploadRef = useRef(uploadImage);
  uploadRef.current = uploadImage;
  const fileInput = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Editor | null>(null);

  const insertImages = async (files: File[], pos?: number) => {
    const upload = uploadRef.current;
    const ed = editorRef.current;
    if (!upload || !ed) return;
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      try {
        const src = await upload(file);
        const chain = ed.chain().focus();
        (pos !== undefined ? chain.insertContentAt(pos, { type: 'image', attrs: { src, alt: file.name } }) : chain.setImage({ src, alt: file.name })).run();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Image upload failed');
      }
    }
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      Link.configure({ openOnClick: !editable, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({ placeholder: placeholder ?? (rich ? 'Write something, or type / for headings, tables and images…' : 'Write something… (@ to mention)') }),
      Mention.configure({ HTMLAttributes: { class: 'mention' }, suggestion: mentionSuggestion }),
      ...(rich
        ? [
            Image.configure({ HTMLAttributes: { loading: 'lazy' } }),
            TableKit.configure({ table: { resizable: true, HTMLAttributes: { class: 'doc-table' } } }),
            slashCommands(() => (uploadRef.current ? () => fileInput.current?.click() : null)),
          ]
        : []),
    ],
    content: value ?? '',
    editable,
    autofocus: autofocus ? 'end' : false,
    editorProps: {
      attributes: { class: cx('prose-app', isDoc && 'prose-doc') },
      handleKeyDown: (_view, e) => {
        if (submitRef.current && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          submitRef.current();
          return true;
        }
        return false;
      },
      handlePaste: (_view, e) => {
        const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!rich || !uploadRef.current || !files.length) return false;
        void insertImages(files);
        return true;
      },
      handleDrop: (view, e, _slice, moved) => {
        const files = Array.from((e as DragEvent).dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (moved || !rich || !uploadRef.current || !files.length) return false;
        const pos = view.posAtCoords({ left: (e as DragEvent).clientX, top: (e as DragEvent).clientY })?.pos;
        void insertImages(files, pos);
        return true;
      },
    },
    onUpdate: ({ editor: ed }) => {
      dirty.current = true;
      onChange?.(ed.getJSON() as RichText);
    },
    onBlur: ({ editor: ed }) => {
      if (dirty.current && onCommit) {
        dirty.current = false;
        onCommit(ed.getJSON() as RichText);
      }
    },
  });
  editorRef.current = editor;

  // follow external value changes (polling) when the user isn't editing
  useEffect(() => {
    if (!editor || editor.isFocused || dirty.current) return;
    const next = JSON.stringify(value ?? null);
    if (next !== JSON.stringify(editor.isEmpty ? null : editor.getJSON())) editor.commands.setContent(value ?? '', { emitUpdate: false });
  }, [value, editor]);
  useEffect(() => editor?.setEditable(editable), [editor, editable]);

  useImperativeHandle(ref, () => ({
    clear: () => { editor?.commands.clearContent(); dirty.current = false; },
    focus: () => editor?.commands.focus('end'),
    getJSON: () => (editor?.getJSON() ?? { type: 'doc', content: [] }) as RichText,
    isEmpty: () => editor?.isEmpty ?? true,
  }), [editor]);

  const boxed = editable && !isDoc;
  return (
    <div className={cx(boxed && 'rounded-md border border-app focus-within:border-accent-500', className)}>
      {boxed && toolbar && editor && <Toolbar editor={editor} rich={rich} onImage={uploadImage ? () => fileInput.current?.click() : undefined} />}
      {editable && editor && rich && <TableMenu editor={editor} />}
      {editable && editor && isDoc && <SelectionMenu editor={editor} />}
      <EditorContent editor={editor} className={cx(boxed && 'px-3 py-2')} style={{ minHeight: editable ? minHeight : undefined }} />
      {rich && uploadImage && (
        <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(e) => { void insertImages(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      )}
    </div>
  );
});

// ───────────── toolbars ─────────────

function ToolButton({ active, onClick, icon, label }: { active?: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button type="button" title={label} aria-label={label} onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={cx('inline-flex size-7 items-center justify-center rounded text-muted hover-bg hover:text-app', active && 'bg-muted text-app')}>
      {icon}
    </button>
  );
}
const Sep = () => <span className="mx-1 h-4 w-px bg-[var(--border)]" />;

function setLink(editor: Editor) {
  const prev = editor.getAttributes('link').href as string | undefined;
  const url = window.prompt('Link URL', prev ?? 'https://');
  if (url === null) return;
  if (!url.trim()) editor.chain().focus().extendMarkRange('link').unsetLink().run();
  else editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
}

function Toolbar({ editor, rich, onImage }: { editor: Editor; rich: boolean; onImage?: () => void }) {
  const c = () => editor.chain().focus();
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-app px-1 py-0.5">
      <ToolButton active={editor.isActive('bold')} onClick={() => c().toggleBold().run()} icon={<Bold className="size-4" />} label="Bold" />
      <ToolButton active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()} icon={<Italic className="size-4" />} label="Italic" />
      <ToolButton active={editor.isActive('strike')} onClick={() => c().toggleStrike().run()} icon={<Strikethrough className="size-4" />} label="Strikethrough" />
      <ToolButton active={editor.isActive('code')} onClick={() => c().toggleCode().run()} icon={<Code className="size-4" />} label="Code" />
      <Sep />
      <ToolButton active={editor.isActive('heading', { level: 2 })} onClick={() => c().toggleHeading({ level: 2 }).run()} icon={<Heading2 className="size-4" />} label="Heading" />
      <ToolButton active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()} icon={<List className="size-4" />} label="Bullet list" />
      <ToolButton active={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()} icon={<ListOrdered className="size-4" />} label="Numbered list" />
      <ToolButton active={editor.isActive('taskList')} onClick={() => c().toggleTaskList().run()} icon={<ListChecks className="size-4" />} label="Checklist" />
      <ToolButton active={editor.isActive('blockquote')} onClick={() => c().toggleBlockquote().run()} icon={<Quote className="size-4" />} label="Quote" />
      {rich && (
        <>
          <Sep />
          <ToolButton onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} icon={<TableIcon className="size-4" />} label="Insert table" />
          {onImage && <ToolButton onClick={onImage} icon={<ImageIcon className="size-4" />} label="Insert image" />}
        </>
      )}
    </div>
  );
}

const floating = 'flex items-center gap-0.5 rounded-lg border border-app bg-app p-0.5 shadow-lg';

/** Formatting bar that appears over selected text (document variant). */
function SelectionMenu({ editor }: { editor: Editor }) {
  const c = () => editor.chain().focus();
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionMenu"
      shouldShow={({ editor: ed, state }) => ed.isEditable && !state.selection.empty && !ed.isActive('image') && state.selection.constructor.name !== 'CellSelection'}
      className={floating}
    >
      <ToolButton active={editor.isActive('bold')} onClick={() => c().toggleBold().run()} icon={<Bold className="size-4" />} label="Bold" />
      <ToolButton active={editor.isActive('italic')} onClick={() => c().toggleItalic().run()} icon={<Italic className="size-4" />} label="Italic" />
      <ToolButton active={editor.isActive('strike')} onClick={() => c().toggleStrike().run()} icon={<Strikethrough className="size-4" />} label="Strikethrough" />
      <ToolButton active={editor.isActive('code')} onClick={() => c().toggleCode().run()} icon={<Code className="size-4" />} label="Code" />
      <ToolButton active={editor.isActive('link')} onClick={() => setLink(editor)} icon={<Link2 className="size-4" />} label="Link" />
      <Sep />
      <ToolButton active={editor.isActive('heading', { level: 1 })} onClick={() => c().toggleHeading({ level: 1 }).run()} icon={<Heading1 className="size-4" />} label="Heading 1" />
      <ToolButton active={editor.isActive('heading', { level: 2 })} onClick={() => c().toggleHeading({ level: 2 }).run()} icon={<Heading2 className="size-4" />} label="Heading 2" />
      <ToolButton active={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()} icon={<List className="size-4" />} label="Bullet list" />
      <ToolButton active={editor.isActive('blockquote')} onClick={() => c().toggleBlockquote().run()} icon={<Quote className="size-4" />} label="Quote" />
    </BubbleMenu>
  );
}

/** Row/column controls shown while the cursor is inside a table. */
function TableMenu({ editor }: { editor: Editor }) {
  const c = () => editor.chain().focus();
  const btn = (label: string, onClick: () => void, icon?: ReactNode, danger?: boolean) => (
    <button type="button" title={label} onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={cx('inline-flex h-7 items-center gap-1 rounded px-1.5 text-xs hover-bg', danger ? 'text-red-600 dark:text-red-400' : 'text-muted hover:text-app')}>
      {icon}{label}
    </button>
  );
  return (
    <BubbleMenu
      editor={editor}
      pluginKey="tableMenu"
      shouldShow={({ editor: ed }) => ed.isEditable && ed.isActive('table')}
      options={{ placement: 'bottom-end', offset: 6 }}
      getReferencedVirtualElement={() => {
        // anchor to the whole table, not the caret
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === 'table') {
            const dom = editor.view.nodeDOM($from.before(d)) as HTMLElement | null;
            if (dom) return { getBoundingClientRect: () => dom.getBoundingClientRect(), getClientRects: () => dom.getClientRects() };
          }
        }
        return null;
      }}
      className={floating}
    >
      <Rows3 className="mx-1 size-3.5 text-subtle" />
      {btn('Row above', () => c().addRowBefore().run())}
      {btn('Row below', () => c().addRowAfter().run())}
      {btn('Delete row', () => c().deleteRow().run())}
      <Sep />
      <Columns3 className="mx-1 size-3.5 text-subtle" />
      {btn('Col left', () => c().addColumnBefore().run())}
      {btn('Col right', () => c().addColumnAfter().run())}
      {btn('Delete col', () => c().deleteColumn().run())}
      <Sep />
      {btn('Header row', () => c().toggleHeaderRow().run())}
      {btn('Delete table', () => c().deleteTable().run(), <Trash2 className="size-3.5" />, true)}
    </BubbleMenu>
  );
}

/** Read-only renderer for stored rich text. */
export function RichView({ value, className, variant }: { value: RichText | null | undefined; className?: string; variant?: 'boxed' | 'document' }) {
  if (!value) return null;
  return <RichEditor value={value} editable={false} toolbar={false} className={className} variant={variant} blocks />;
}
