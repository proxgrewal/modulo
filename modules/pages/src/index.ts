import { defineModel, emptyPage, mf, nodeId, walk, type PageNode } from '@modulo/core';
import { defineModule, NotFoundError, ValidationError, type SiteContext } from '@modulo/kernel';

const PATH_RE = /^\/(?:[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)?$/;
const AUTOSAVE_EVERY_MS = 5 * 60 * 1000;

const n = (type: string, props: Record<string, unknown> = {}, slots?: Record<string, PageNode[]>): PageNode => ({ id: nodeId(), type, props, ...(slots ? { slots } : {}), origin: 'pages' });

/** Starter documents offered when creating a page. */
export const PAGE_TEMPLATES: Record<string, { label: string; build: (title: string) => PageNode }> = {
  blank: { label: 'Blank', build: () => emptyPage() },
  landing: {
    label: 'Landing page',
    build: (title) => ({
      ...emptyPage(),
      slots: {
        default: [
          n('core:hero', { title, subtitle: 'Explain the value of your offer in one or two sentences.', ctaLabel: 'Get started', ctaHref: '#', align: 'center' }),
          n('core:section', {}, { default: [n('core:features')] }),
          n('core:section', { background: 'token:color.surface' }, { default: [n('core:testimonial')] }),
          n('core:section', {}, { default: [n('core:heading', { text: 'Pricing', level: 'h2', align: 'center' }), n('core:pricing')] }),
          n('core:section', {}, { default: [n('core:heading', { text: 'Questions', level: 'h2' }), n('core:faq')] }),
        ],
      },
    }),
  },
  about: {
    label: 'About',
    build: (title) => ({
      ...emptyPage(),
      slots: {
        default: [
          n('core:section', { width: 'narrow' }, {
            default: [
              n('core:heading', { text: title, level: 'h1' }),
              n('core:text', { html: '<p>Tell your story: who you are, what you do, and why it matters.</p>' }),
              n('core:image', { alt: 'Team photo', ratio: '16/9', rounded: true }),
            ],
          }),
        ],
      },
    }),
  },
};

function validatePath(path: unknown) {
  if (typeof path !== 'string' || !PATH_RE.test(path)) throw new ValidationError('Path must look like "/" or "/about" (lowercase letters, digits, dashes)');
  if (/^\/(_api|api|s|media|_editor)(\/|$)/.test(path)) throw new ValidationError(`Path ${path} is reserved`);
}

function checkTree(ctx: SiteContext, tree: unknown): PageNode {
  if (!tree || typeof tree !== 'object' || (tree as PageNode).type !== 'core:page') throw new ValidationError('Document root must be a core:page node');
  const t = tree as PageNode;
  const problems = ctx.runtime.blocks.validateTree(t);
  let count = 0;
  walk(t, () => void count++);
  if (count > 5000) problems.push('Document too large (max 5000 nodes)');
  if (problems.length) throw new ValidationError(`Invalid document: ${problems.slice(0, 5).join('; ')}`, problems);
  return t;
}

async function saveRevision(ctx: SiteContext, pageId: string, tree: PageNode, kind: 'autosave' | 'publish' | 'manual', note = '') {
  return ctx.repo('pages.revision').create({ page: pageId, tree, kind, note, author: ctx.user?.email ?? 'system' });
}

function summary(p: Record<string, any>) {
  const { draft, published, ...rest } = p;
  return { ...rest, hasUnpublishedChanges: p.status !== 'published' || JSON.stringify(draft) !== JSON.stringify(published) };
}

export const services = (ctx: SiteContext) => ({
  async findPublishedByPath(path: string) {
    return ctx.asSudo().repo('pages.page').findOne({ path, status: 'published' });
  },
  async create(input: { title: string; path: string; template?: string; tree?: PageNode }) {
    validatePath(input.path);
    const tpl = PAGE_TEMPLATES[input.template ?? 'blank'];
    if (!tpl && !input.tree) throw new ValidationError(`Unknown template ${input.template}`);
    const tree = input.tree ? checkTree(ctx, input.tree) : tpl!.build(input.title);
    return ctx.repo('pages.page').create({ title: input.title, path: input.path, draft: tree, status: 'draft' });
  },
  async saveDraft(id: string, tree: unknown) {
    ctx.require('pages.edit');
    const t = checkTree(ctx, tree);
    return ctx.tx(async (c) => {
      const page = await c.repo('pages.page').update(id, { draft: t });
      const last = await c.repo('pages.revision').findOne({ page: id, kind: 'autosave' });
      if (!last || Date.now() - Date.parse(last.created_at) > AUTOSAVE_EVERY_MS) await saveRevision(c, id, t, 'autosave');
      return page;
    });
  },
  async publish(id: string, note = '') {
    ctx.require('pages.publish');
    return ctx.tx(async (c) => {
      const page = await c.repo('pages.page').get(id);
      const { tree } = c.runtime.blocks.migrateTree(checkTree(c, page.draft ?? emptyPage()));
      const updated = await c.repo('pages.page').update(id, { draft: tree, published: tree, status: 'published', published_at: new Date().toISOString() });
      await saveRevision(c, id, tree, 'publish', note);
      await c.emit('pages.page.published', { id, path: updated.path });
      return updated;
    });
  },
  async unpublish(id: string) {
    ctx.require('pages.publish');
    const page = await ctx.repo('pages.page').update(id, { status: 'draft' });
    await ctx.tx((c) => c.emit('pages.page.unpublished', { id, path: page.path }));
    return page;
  },
  async restore(id: string, revisionId: string) {
    ctx.require('pages.edit');
    const rev = await ctx.repo('pages.revision').get(revisionId);
    if (rev.page !== id) throw new NotFoundError('Revision does not belong to this page');
    return ctx.repo('pages.page').update(id, { draft: rev.tree });
  },
});

export default defineModule({
  name: 'pages',
  version: '1.0.0',
  label: 'Pages',
  description: 'Pages with drafts, publishing and revision history.',
  kernel: '^1.0.0',
  depends: { core: '^1.0.0' },
  required: true,
  category: 'Foundation',
  models: [
    defineModel({
      name: 'pages.page',
      label: 'Page',
      titleField: 'title',
      order: 'path asc',
      fields: {
        title: mf.string({ required: true, label: 'Title' }),
        path: mf.string({ required: true, unique: true, max: 200, label: 'URL path' }),
        description: mf.text({ label: 'Description' }),
        status: mf.enum(['draft', 'published'], { default: 'draft', index: true }),
        layout: mf.string({ default: 'core:layout', max: 100 }),
        draft: mf.json({ private: true }),
        published: mf.json(),
        published_at: mf.datetime(),
      },
      access: { read: 'public', create: 'pages.edit', update: 'pages.edit', delete: 'pages.publish' },
    }),
    defineModel({
      name: 'pages.revision',
      label: 'Revision',
      fields: {
        page: mf.ref('pages.page', { required: true, onDelete: 'cascade' }),
        tree: mf.json({ required: true }),
        kind: mf.enum(['autosave', 'publish', 'manual'], { default: 'manual' }),
        note: mf.string(),
        author: mf.string(),
      },
      access: { read: 'pages.edit', create: 'pages.edit', update: 'pages.edit', delete: 'pages.publish' },
    }),
  ],
  hooks: [
    {
      // Anonymous visitors only ever see published pages through the data API.
      hook: 'model.pages.page.where',
      kind: 'filter',
      id: 'published-only',
      fn: (where: any, ctx: SiteContext) => (ctx.user || ctx.sudo ? where : { ...(where ?? {}), status: 'published' }),
    },
    {
      hook: 'model.pages.page.beforeCreate',
      kind: 'filter',
      id: 'validate-path',
      fn: (v: any) => {
        validatePath(v.path);
        if (!v.draft) v.draft = emptyPage();
        return v;
      },
    },
    {
      hook: 'model.pages.page.beforeUpdate',
      kind: 'filter',
      id: 'validate-path-update',
      fn: (v: any) => {
        if (v.path !== undefined) validatePath(v.path);
        return v;
      },
    },
  ],
  permissions: [
    { key: 'pages.edit', label: 'Edit pages' },
    { key: 'pages.publish', label: 'Publish pages' },
  ],
  grants: { editor: ['pages.edit', 'pages.publish'], author: ['pages.edit'] },
  services,
  routes: [
    {
      method: 'GET',
      path: '/pages',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, query }) => ({ body: (await ctx.repo('pages.page').find({ search: query.q, limit: 500 })).map(summary) }),
    },
    {
      method: 'GET',
      path: '/templates',
      surface: 'api',
      permission: 'pages.edit',
      handler: () => ({ body: Object.entries(PAGE_TEMPLATES).map(([id, t]) => ({ id, label: t.label })) }),
    },
    {
      method: 'POST',
      path: '/pages',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, body }) => {
        const b = (body ?? {}) as any;
        return { status: 201, body: await services(ctx).create({ title: String(b.title ?? 'Untitled'), path: b.path, template: b.template, tree: b.tree }) };
      },
    },
    { method: 'GET', path: '/pages/:id', surface: 'api', permission: 'pages.edit', handler: async ({ ctx, params }) => ({ body: await ctx.repo('pages.page').get(params.id!) }) },
    {
      method: 'PATCH',
      path: '/pages/:id',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, params, body }) => {
        const { title, path, description, layout } = (body ?? {}) as any;
        return { body: summary(await ctx.repo('pages.page').update(params.id!, Object.fromEntries(Object.entries({ title, path, description, layout }).filter(([, v]) => v !== undefined)))) };
      },
    },
    { method: 'DELETE', path: '/pages/:id', surface: 'api', permission: 'pages.publish', handler: async ({ ctx, params }) => (await ctx.repo('pages.page').delete(params.id!), { status: 204 }) },
    {
      method: 'PUT',
      path: '/pages/:id/draft',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, params, body }) => ({ body: summary(await services(ctx).saveDraft(params.id!, (body as any)?.tree)) }),
    },
    { method: 'POST', path: '/pages/:id/publish', surface: 'api', permission: 'pages.publish', handler: async ({ ctx, params, body }) => ({ body: summary(await services(ctx).publish(params.id!, (body as any)?.note)) }) },
    { method: 'POST', path: '/pages/:id/unpublish', surface: 'api', permission: 'pages.publish', handler: async ({ ctx, params }) => ({ body: summary(await services(ctx).unpublish(params.id!)) }) },
    {
      method: 'POST',
      path: '/pages/:id/duplicate',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, params }) => {
        const p = await ctx.repo('pages.page').get(params.id!);
        let path = `${p.path === '/' ? '/home' : p.path}-copy`;
        for (let i = 2; await ctx.repo('pages.page').findOne({ path }); i++) path = `${p.path === '/' ? '/home' : p.path}-copy-${i}`;
        return { status: 201, body: summary(await ctx.repo('pages.page').create({ title: `${p.title} (copy)`, path, draft: p.draft, description: p.description })) };
      },
    },
    {
      method: 'GET',
      path: '/pages/:id/revisions',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, params }) => ({
        body: (await ctx.repo('pages.revision').find({ where: { page: params.id! }, limit: 100 })).map(({ tree, ...r }) => r),
      }),
    },
    {
      method: 'GET',
      path: '/pages/:id/revisions/:rev',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, params }) => ({ body: await ctx.repo('pages.revision').get(params.rev!) }),
    },
    {
      method: 'POST',
      path: '/pages/:id/revisions/:rev/restore',
      surface: 'api',
      permission: 'pages.edit',
      handler: async ({ ctx, params }) => ({ body: summary(await services(ctx).restore(params.id!, params.rev!)) }),
    },
  ],
  lifecycle: {
    install: async (ctx) => {
      const home = PAGE_TEMPLATES.landing!.build('Welcome to your new site');
      const page = await ctx.repo('pages.page').create({ title: 'Home', path: '/', draft: home, description: 'Home page' });
      await services(ctx).publish(page.id, 'Initial version');
    },
  },
  editor: { collections: [{ model: 'pages.page', label: 'Pages', columns: ['title', 'path', 'status', 'published_at'] }] },
});
