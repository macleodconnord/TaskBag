/** Pure unit tests for the ClickUp importer: markdown/comment converters and the HTTP client's rate limiting. */
import './load-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpClickUpClient } from '../src/modules/import/clickup/client';
import { commentToRichText, markdownToRichText } from '../src/modules/import/markdown';

describe('markdownToRichText', () => {
  it('converts blocks and inline marks', () => {
    const doc = markdownToRichText('# Title\n\nSome **bold**, *italic*, ~~gone~~ and `code` with a [link](https://x.test).\nNext line\n\n> quoted\n\n```ts\nconst a = 1;\n```\n\n---')!;
    expect(doc.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'blockquote', 'codeBlock', 'horizontalRule']);
    expect(doc.content[0]).toEqual({ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Title' }] });
    const p = doc.content[1].content!;
    expect(p.find((n) => n.text === 'bold')?.marks).toEqual([{ type: 'bold' }]);
    expect(p.find((n) => n.text === 'italic')?.marks).toEqual([{ type: 'italic' }]);
    expect(p.find((n) => n.text === 'gone')?.marks).toEqual([{ type: 'strike' }]);
    expect(p.find((n) => n.text === 'code')?.marks).toEqual([{ type: 'code' }]);
    expect(p.find((n) => n.text === 'link')?.marks).toEqual([{ type: 'link', attrs: { href: 'https://x.test' } }]);
    expect(p.some((n) => n.type === 'hardBreak')).toBe(true);
    expect(doc.content[3]).toEqual({ type: 'codeBlock', attrs: { language: 'ts' }, content: [{ type: 'text', text: 'const a = 1;' }] });
  });

  it('nests lists by indentation and handles task lists', () => {
    const doc = markdownToRichText('- a\n  - a1\n  - a2\n- b\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo')!;
    expect(doc.content.map((n) => n.type)).toEqual(['bulletList', 'orderedList', 'taskList']);
    const a = doc.content[0].content![0];
    expect(a.content!.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(a.content![1].content).toHaveLength(2);
    expect(doc.content[1].attrs).toEqual({ start: 3 });
    expect(doc.content[2].content!.map((n) => n.attrs?.checked)).toEqual([true, false]);
  });

  it('returns null for empty input and keeps unsafe links as text', () => {
    expect(markdownToRichText('  \n ')).toBeNull();
    const doc = markdownToRichText('[x](javascript:alert(1))')!;
    expect(JSON.stringify(doc)).not.toContain('javascript:');
  });
});

describe('commentToRichText', () => {
  it('converts Quill ops with mentions, lists and attachments', () => {
    const r = commentToRichText([
      { text: 'Hi ' }, { type: 'tag', user: { id: '1', username: 'Ann' } }, { type: 'tag', user: { id: '2', username: 'Bob' } }, { text: '\n' },
      { text: 'one' }, { text: '\n', attributes: { list: 'ordered' } }, { text: 'two' }, { text: '\n', attributes: { list: 'ordered' } },
      { type: 'attachment', attachment: { id: 'f1', title: 'a.png', url: 'https://files.test/a.png' } }, { text: '\n' },
    ], null, (id) => (id === '1' ? 'uuid-ann' : null));
    expect(r.doc.content.map((n) => n.type)).toEqual(['paragraph', 'orderedList', 'paragraph']);
    expect(r.doc.content[0].content).toEqual([
      { type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: 'uuid-ann', label: 'Ann' } }, { type: 'text', text: '@Bob' },
    ]);
    expect(r.doc.content[1].content).toHaveLength(2);
    expect(r.attachments).toEqual([{ id: 'f1', title: 'a.png', url: 'https://files.test/a.png' }]);
  });
});

describe('HttpClickUpClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('backs off on 429 and reads the rate-limit headers', async () => {
    const calls: string[] = [];
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      calls.push(String(url));
      expect((init.headers as Record<string, string>).authorization).toBe('pk_test');
      n++;
      const reset = String(Math.ceil(Date.now() / 1000));
      if (n === 1) return new Response('{"err":"Rate limit reached","ECODE":"APP_002"}', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } });
      return new Response(JSON.stringify({ ok: true, extra: 1 }), { status: 200, headers: { 'x-ratelimit-remaining': '97', 'x-ratelimit-limit': '100', 'x-ratelimit-reset': reset } });
    }));
    const c = new HttpClickUpClient('pk_test', '1', { rpm: 6000 });
    const r = await c.request('/team', z.looseObject({ ok: z.boolean() }), { query: { archived: false, skip: undefined } });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe('https://api.clickup.com/api/v2/team?archived=false');
    expect(c.stats()).toMatchObject({ requests: 2, retries: 1, remaining: 97, limit: 100 });
  }, 10_000);

  it('raises readable errors and validates response shapes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"err":"Token invalid","ECODE":"OAUTH_025"}', { status: 401 })));
    const c = new HttpClickUpClient('bad', '1', { rpm: 6000 });
    await expect(c.request('/team', z.object({}))).rejects.toThrow('Token invalid (OAUTH_025)');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"teams":"nope"}', { status: 200 })));
    await expect(c.getWorkspace()).rejects.toThrow(/Unexpected ClickUp response for \/team: teams/);
  });

  it('spreads requests to stay inside the budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const c = new HttpClickUpClient('t', '1', { rpm: 600 }); // 100 ms apart
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) await c.request('/x', z.object({}));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
  });
});
