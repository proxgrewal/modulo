import { defineModule, type RouteRequest, type SiteContext, type Where } from '@modulo/kernel';
import { defineBlock, defineModel, f, h, mf, raw, type PageNode, type VNode } from '@modulo/core';
import { sanitizeHtml } from './sanitize.ts';
import { escapeXml, formatDate, isAnonymousReader, siteOrigin } from './util.ts';

export { sanitizeHtml, decodeEntities, safeHref } from './sanitize.ts';
export { escapeXml, siteOrigin } from './util.ts';

interface PostSummary {
  id: string;
  title: string;
  slug: string;
  excerpt: string | null;
  cover: string | null;
  published_at: string | null;
  author: string | null;
  tags: string[];
}

export function normaliseTags(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  const out: string[] = [];
  for (const t of arr) {
    const s = String(t ?? '').trim().slice(0, 64);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 50);
}

function summarise(p: Record<string, any>): PostSummary {
  return {
    id: p.id,
    title: String(p.title ?? ''),
    slug: String(p.slug ?? ''),
    excerpt: p.excerpt ?? null,
    cover: p.cover ?? null,
    published_at: p.published_at ?? null,
    author: p.author ?? null,
    tags: normaliseTags(p.tags),
  };
}

const postUrl = (base: string, slug: string) => `${base}/blog/${encodeURIComponent(slug)}`;
const tagUrl = (base: string, tag: string) => `${base}/blog/tag/${encodeURIComponent(tag)}`;

/** Published posts, newest first. Optionally filtered by tag (case-insensitive). */
export async function publishedPosts(ctx: SiteContext, opts: { limit?: number; tag?: string } = {}): Promise<PostSummary[]> {
  const limit = Math.min(Math.max(Math.floor(Number(opts.limit) || 10), 1), 1000);
  const tag = (opts.tag ?? '').trim().toLowerCase();
  const rows = await ctx.repo('blog.post').find({ where: { status: 'published' }, order: 'published_at desc, created_at desc', limit: tag ? 1000 : limit });
  const posts = rows.map(summarise);
  return (tag ? posts.filter((p) => p.tags.some((t) => t.toLowerCase() === tag)) : posts).slice(0, limit);
}

/* ───────────────────────── blocks ───────────────────────── */

const LIST_CSS =
  '.blog-list__items{list-style:none;margin:0;padding:0;display:grid;gap:var(--space-lg,24px)}' +
  '.blog-list--grid .blog-list__items{grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}' +
  '.blog-card{display:flex;flex-direction:column;gap:var(--space-xs,6px)}' +
  '.blog-card img{border-radius:var(--radius-md,8px);aspect-ratio:16/9;object-fit:cover;width:100%}' +
  '.blog-card h2{font-size:var(--font-size-lg,1.4rem);margin:0}.blog-card h2 a{text-decoration:none;color:inherit}' +
  '.blog-card time,.blog-meta{color:var(--color-muted,#667);font-size:.9em}' +
  '.blog-tags{display:flex;flex-wrap:wrap;gap:var(--space-xs,6px);list-style:none;padding:0;margin:0}' +
  '.blog-tags a{font-size:.8em;padding:2px 8px;border-radius:999px;background:var(--color-surface,#eef);text-decoration:none}';

const CONTENT_CSS =
  '.blog-post{max-width:var(--content-width,720px);margin:0 auto}.blog-post__cover{border-radius:var(--radius-md,8px);margin:var(--space-md,16px) 0}' +
  '.blog-post__body{line-height:1.7}.blog-post__body pre{overflow:auto;padding:var(--space-md,16px);background:var(--color-surface,#f4f4f8);border-radius:var(--radius-sm,4px)}' +
  '.blog-post__body blockquote{margin:0;padding-left:var(--space-md,16px);border-left:3px solid var(--color-primary)}';

function tagList(tags: string[], base: string): VNode {
  if (!tags.length) return null;
  return h('ul', { class: 'blog-tags', 'aria-label': 'Tags' }, ...tags.map((t) => h('li', null, h('a', { href: tagUrl(base, t), rel: 'tag' }, t))));
}

const postList = defineBlock<{ limit: number; tag: string; layout: string; showExcerpt: boolean }, { posts: PostSummary[]; base: string; error?: string }>({
  type: 'blog:post-list',
  version: 1,
  label: 'Blog posts',
  category: 'Blog',
  icon: 'list',
  description: 'A list or grid of the latest published posts.',
  fields: {
    limit: f.number({ label: 'Number of posts', default: 10, min: 1, max: 100 }),
    tag: f.text({ label: 'Only posts tagged', default: '' }),
    layout: f.select(['list', 'grid'], { label: 'Layout' }),
    showExcerpt: f.boolean({ label: 'Show excerpt', default: true }),
  },
  css: LIST_CSS,
  load: async (props, { services, scope }) => {
    const base = String(scope.base ?? '');
    const ctx = services?.ctx as SiteContext | undefined;
    if (!ctx) return { posts: [], base };
    return { posts: await publishedPosts(ctx, { limit: props.limit, tag: props.tag }), base };
  },
  render: (props, ctx) => {
    const base = String(ctx.scope.base ?? ctx.data?.base ?? '');
    const posts = ctx.data?.posts ?? [];
    const layout = props.layout === 'grid' ? 'grid' : 'list';
    if (!posts.length) return ctx.root('div', { class: `blog-list blog-list--${layout}` }, h('p', { class: 'blog-empty' }, 'No posts yet.'));
    return ctx.root(
      'div',
      { class: `blog-list blog-list--${layout}` },
      h(
        'ul',
        { class: 'blog-list__items', role: 'list' },
        ...posts.map((p) =>
          h(
            'li',
            { class: 'blog-card' },
            h(
              'article',
              null,
              p.cover ? h('img', { src: p.cover, alt: '', loading: 'lazy' }) : null,
              h('h2', null, h('a', { href: postUrl(base, p.slug) }, p.title)),
              p.published_at ? h('time', { datetime: p.published_at }, formatDate(p.published_at)) : null,
              props.showExcerpt && p.excerpt ? h('p', null, p.excerpt) : null,
              tagList(p.tags, base),
            ),
          ),
        ),
      ),
    );
  },
});

const postContent = defineBlock<Record<string, never>, { record: Record<string, any> | null; base: string }>({
  type: 'blog:post-content',
  version: 1,
  label: 'Post content',
  category: 'Blog',
  icon: 'article',
  description: 'Title, date, cover and body of the current post (used on /blog/:slug).',
  fields: {},
  css: CONTENT_CSS,
  load: async (_props, { scope }) => ({ record: (scope.record as Record<string, any>) ?? null, base: String(scope.base ?? '') }),
  render: (_props, ctx) => {
    const rec = (ctx.data?.record ?? (ctx.scope.record as Record<string, any> | undefined)) || null;
    const base = String(ctx.scope.base ?? ctx.data?.base ?? '');
    if (!rec) {
      return ctx.root('article', { class: 'blog-post' }, ctx.mode === 'edit' ? h('p', { class: 'blog-meta' }, 'The post title, cover and body appear here.') : null);
    }
    const tags = normaliseTags(rec.tags);
    return ctx.root(
      'article',
      { class: 'blog-post' },
      h(
        'header',
        null,
        h('h1', null, String(rec.title ?? '')),
        h(
          'p',
          { class: 'blog-meta' },
          rec.published_at ? h('time', { datetime: String(rec.published_at) }, formatDate(rec.published_at)) : null,
          rec.author ? [' · ', h('span', { class: 'blog-author' }, String(rec.author))] : null,
        ),
      ),
      rec.cover ? h('img', { class: 'blog-post__cover', src: String(rec.cover), alt: '' }) : null,
      h('div', { class: 'blog-post__body' }, raw(sanitizeHtml(rec.body ?? ''))),
      tags.length ? h('footer', null, tagList(tags, base)) : null,
    );
  },
});

/* ───────────────────────── routes ───────────────────────── */

function pageTree(children: PageNode[]): PageNode {
  return { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'blog-section', type: 'core:section', props: {}, slots: { default: children } }] } };
}

function listPage(ctx: SiteContext, title: string, tag: string) {
  const tree = pageTree([
    { id: 'blog-heading', type: 'core:heading', props: { text: title, level: 'h1' } },
    { id: 'blog-list', type: 'blog:post-list', v: 1, props: { limit: 20, tag, layout: 'list', showExcerpt: true } },
  ]);
  const settings = ctx.settings('blog');
  return { page: { tree, title, scope: { description: tag ? `Posts tagged ${tag}` : String(settings.description ?? '') || undefined } } };
}

async function rss(req: RouteRequest) {
  const ctx = req.ctx;
  const origin = siteOrigin(req);
  const settings = ctx.settings('blog');
  const title = `${String(settings.title || 'Blog')} – ${ctx.site.name}`;
  const posts = await ctx.repo('blog.post').find({ where: { status: 'published' }, order: 'published_at desc, created_at desc', limit: 50 });
  const items = posts.map((p) => {
    const link = origin + postUrl('', String(p.slug));
    const desc = p.excerpt ? String(p.excerpt) : sanitizeHtml(p.body ?? '');
    return (
      `<item><title>${escapeXml(p.title)}</title><link>${escapeXml(link)}</link><guid isPermaLink="true">${escapeXml(link)}</guid>` +
      (p.published_at ? `<pubDate>${escapeXml(new Date(p.published_at).toUTCString())}</pubDate>` : '') +
      (p.author ? `<dc:creator>${escapeXml(p.author)}</dc:creator>` : '') +
      normaliseTags(p.tags).map((t) => `<category>${escapeXml(t)}</category>`).join('') +
      `<description>${escapeXml(desc)}</description></item>`
    );
  });
  const last = posts[0]?.published_at ? new Date(posts[0].published_at).toUTCString() : new Date().toUTCString();
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>` +
    `<title>${escapeXml(title)}</title><link>${escapeXml(origin + '/blog')}</link>` +
    `<description>${escapeXml(settings.description || `Latest posts from ${ctx.site.name}`)}</description>` +
    `<atom:link href="${escapeXml(origin + '/blog/rss.xml')}" rel="self" type="application/rss+xml"/>` +
    `<lastBuildDate>${escapeXml(last)}</lastBuildDate>` +
    items.join('') +
    `</channel></rss>`;
  return { status: 200, headers: { 'content-type': 'application/rss+xml; charset=utf-8' }, body };
}

/* ───────────────────────── module ───────────────────────── */

const now = () => new Date().toISOString();

export default defineModule({
  name: 'blog',
  version: '1.0.0',
  label: 'Blog',
  description: 'Posts, tags, an RSS feed and blog blocks.',
  category: 'content',
  kernel: '^1.0.0',
  models: [
    defineModel({
      name: 'blog.post',
      label: 'Post',
      titleField: 'title',
      order: 'created_at desc',
      fields: {
        title: mf.string({ required: true, label: 'Title' }),
        slug: mf.slug('title', { label: 'Slug' }),
        excerpt: mf.text({ label: 'Excerpt' }),
        body: mf.richtext({ label: 'Body' }),
        cover: mf.media({ label: 'Cover image' }),
        status: mf.enum(['draft', 'published'], { default: 'draft', index: true, label: 'Status' }),
        published_at: mf.datetime({ label: 'Published at', index: true }),
        author: mf.string({ label: 'Author' }),
        tags: mf.json({ label: 'Tags', default: [] }),
      },
      access: { read: 'public' },
    }),
  ],
  blocks: [postList, postContent],
  patches: [
    {
      id: 'header-nav-blog',
      template: 'core:layout',
      ops: [{ op: 'append', target: 'header#nav', node: { id: 'nav-blog', type: 'core:link', props: { label: 'Blog', href: '/blog' } } }],
    },
  ],
  hooks: [
    {
      // Anonymous visitors (and members without blog.manage) only ever see published posts.
      hook: 'model.blog.post.where',
      kind: 'filter',
      id: 'published-only',
      fn: (where: Where | undefined, ctx: SiteContext): Where | undefined => {
        if (!isAnonymousReader(ctx)) return where;
        if (!where || !Object.keys(where).length) return { status: 'published' };
        return { $or: [where], status: 'published' };
      },
    },
    {
      hook: 'model.blog.post.beforeCreate',
      kind: 'filter',
      id: 'publish-date-create',
      fn: (values: Record<string, any>) => {
        if (values.tags !== undefined && values.tags !== null) values.tags = normaliseTags(values.tags);
        if (values.status === 'published' && !values.published_at) values.published_at = now();
        return values;
      },
    },
    {
      hook: 'model.blog.post.beforeUpdate',
      kind: 'filter',
      id: 'publish-date-update',
      fn: (values: Record<string, any>, existing: Record<string, any>) => {
        if (values.tags !== undefined && values.tags !== null) values.tags = normaliseTags(values.tags);
        if (values.status === 'published' && !existing.published_at && !values.published_at) values.published_at = now();
        return values;
      },
    },
    {
      // Consumed by the seo module when installed; blog does not depend on it.
      hook: 'seo.sitemap',
      kind: 'filter',
      id: 'sitemap-posts',
      fn: async (entries: unknown, ctx: SiteContext) => {
        const list = Array.isArray(entries) ? entries : [];
        const posts = await ctx.asSudo().repo('blog.post').find({ where: { status: 'published' }, order: 'published_at desc', limit: 1000 });
        return [
          ...list,
          { loc: '/blog', lastmod: posts[0]?.updated_at ?? undefined },
          ...posts.map((p) => ({ loc: postUrl('', String(p.slug)), lastmod: p.updated_at ?? p.published_at })),
        ];
      },
    },
  ],
  routes: [
    { method: 'GET', path: '/blog', surface: 'site', permission: 'public', handler: (req) => listPage(req.ctx, String(req.ctx.settings('blog').title || 'Blog'), '') },
    // Must precede /blog/:slug.
    { method: 'GET', path: '/blog/rss.xml', surface: 'site', permission: 'public', handler: rss },
    {
      method: 'GET',
      path: '/blog/tag/:tag',
      surface: 'site',
      permission: 'public',
      handler: (req) => {
        const tag = String(req.params.tag ?? '').trim().slice(0, 64);
        if (!tag) return { status: 404, body: 'Not found' };
        return listPage(req.ctx, `Posts tagged “${tag}”`, tag);
      },
    },
    {
      method: 'GET',
      path: '/blog/:slug',
      surface: 'site',
      permission: 'public',
      handler: async (req) => {
        const slug = String(req.params.slug ?? '');
        const post = slug ? await req.ctx.repo('blog.post').findOne({ slug, status: 'published' }) : null;
        if (!post) return { status: 404, body: 'Not found' };
        const tree: PageNode = { id: 'root', type: 'core:page', props: {}, slots: { default: [{ id: 'post-content', type: 'blog:post-content', v: 1, props: {} }] } };
        return { page: { tree, title: String(post.title), scope: { record: post, description: post.excerpt ?? undefined } } };
      },
    },
  ],
  permissions: [{ key: 'blog.manage', label: 'Manage blog posts' }],
  grants: { editor: ['blog.manage'] },
  settings: {
    title: f.text({ label: 'Blog title', default: 'Blog' }),
    description: f.textarea({ label: 'Feed description', default: '' }),
  },
  records: [
    {
      key: 'hello_world',
      model: 'blog.post',
      noupdate: true,
      values: {
        title: 'Hello world',
        excerpt: 'Welcome to your new blog. Edit or delete this post, then start writing!',
        body: '<p>Welcome to your new blog. This is your first post — edit or delete it, then start writing.</p><h2>Getting started</h2><ul><li>Write posts in the <strong>Posts</strong> collection.</li><li>Publish them to make them visible.</li></ul>',
        status: 'published',
        author: 'Modulo',
        tags: ['news'],
      },
    },
  ],
  editor: { collections: [{ model: 'blog.post', label: 'Posts', icon: 'article', columns: ['title', 'status', 'published_at', 'author'] }] },
});
