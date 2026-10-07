import { cloneTree, defineBlock, defineModel, emptyPage, f, mf, slot, walk, type PageNode } from '@modulo/core';
import { defineModule, ValidationError, type SiteContext } from '@modulo/kernel';

/**
 * Component library: save any block/section as a reusable component.
 * Insert it as an independent copy, or as a synced instance — instances are
 * expanded at render time (hook `page.tree`), so editing the component updates
 * every page that uses it. Expanded node ids are "<instanceId>~<componentNodeId>",
 * which the editor maps back to the instance.
 */
export const INSTANCE = 'library:instance';
const MAX_DEPTH = 5;

export const instance = defineBlock({
  type: INSTANCE,
  version: 1,
  label: 'Component instance',
  category: 'Library',
  internal: true,
  icon: 'card',
  fields: { component: f.collection({ label: 'Component', model: 'library.component' }) },
  slots: [{ name: 'default' }],
  css: '.l-inst-empty{padding:var(--space-md);border:1px dashed var(--color-border);color:var(--color-muted);text-align:center}',
  render: (p, ctx) => ctx.root('div', { class: 'l-inst', 'data-component': p.component || undefined }, slot('default')),
});

function checkNode(ctx: SiteContext, node: unknown): PageNode {
  if (!node || typeof node !== 'object' || typeof (node as PageNode).type !== 'string') throw new ValidationError('node must be a block node');
  const n = cloneTree(node as PageNode);
  const problems = ctx.runtime.blocks.validateTree({ ...emptyPage(), slots: { default: [n] } });
  if (problems.length) throw new ValidationError(`Invalid component: ${problems.slice(0, 3).join('; ')}`, problems);
  let count = 0;
  walk(n, () => void count++);
  if (count > 2000) throw new ValidationError('Component too large (max 2000 nodes)');
  return n;
}

/** Replace instance slots with (prefixed) component trees; nested instances up to MAX_DEPTH, cycles cut. */
export async function expandInstances(tree: PageNode, ctx: SiteContext): Promise<PageNode> {
  const repo = ctx.asSudo().repo('library.component');
  const cache = new Map<string, PageNode | null>();
  const load = async (id: string) => {
    if (!cache.has(id)) {
      const rec = /^[0-9a-f-]{36}$/i.test(id) ? await repo.findOne({ id }) : null;
      cache.set(id, (rec?.node as PageNode) ?? null);
    }
    return cache.get(id)!;
  };
  const expand = async (node: PageNode, depth: number, chain: string[]): Promise<void> => {
    if (node.type === INSTANCE) {
      const cid = String(node.props.component ?? '');
      const comp = cid && depth < MAX_DEPTH && !chain.includes(cid) ? await load(cid) : null;
      if (comp) {
        const copy = cloneTree(comp);
        walk(copy, (n) => {
          n.id = `${node.id}~${n.id}`;
          n.origin = 'library';
        });
        await expand(copy, depth + 1, [...chain, cid]);
        node.slots = { default: [copy] };
      } else node.slots = { default: [] };
      return;
    }
    for (const kids of Object.values(node.slots ?? {})) for (const k of kids) await expand(k, depth, chain);
  };
  const out = cloneTree(tree);
  await expand(out, 0, []);
  return out;
}

export default defineModule({
  name: 'library',
  version: '1.0.0',
  label: 'Component library',
  description: 'Save any block or section and reuse it — as a copy or as a synced component.',
  kernel: '^1.0.0',
  depends: { core: '^1.0.0' },
  required: true,
  category: 'Foundation',
  models: [
    defineModel({
      name: 'library.component',
      label: 'Component',
      titleField: 'name',
      order: 'name asc',
      fields: {
        name: mf.string({ required: true, max: 120 }),
        category: mf.string({ default: 'General', max: 60, index: true }),
        description: mf.text(),
        node: mf.json({ required: true }),
      },
      access: { read: 'auth', create: 'library.manage', update: 'library.manage', delete: 'library.manage' },
    }),
  ],
  blocks: [instance],
  permissions: [{ key: 'library.manage', label: 'Manage the component library' }],
  grants: { editor: ['library.manage'], author: ['library.manage'] },
  hooks: [{ hook: 'page.tree', kind: 'filter', id: 'expand-instances', fn: (tree: PageNode, info: { ctx: SiteContext }) => expandInstances(tree, info.ctx) }],
  routes: [
    {
      method: 'GET',
      path: '/components',
      surface: 'api',
      permission: 'auth',
      handler: async ({ ctx, query }) => ({ body: await ctx.repo('library.component').find({ search: query.q, where: query.category ? { category: query.category } : undefined, limit: 500 }) }),
    },
    {
      method: 'POST',
      path: '/components',
      surface: 'api',
      permission: 'library.manage',
      handler: async ({ ctx, body }) => {
        const b = (body ?? {}) as any;
        const node = checkNode(ctx, b.node);
        return { status: 201, body: await ctx.repo('library.component').create({ name: String(b.name ?? 'Component').slice(0, 120), category: String(b.category || 'General').slice(0, 60), description: b.description ?? null, node }) };
      },
    },
    {
      method: 'PUT',
      path: '/components/:id',
      surface: 'api',
      permission: 'library.manage',
      handler: async ({ ctx, params, body }) => {
        const b = (body ?? {}) as any;
        const patch: Record<string, unknown> = {};
        if (b.name !== undefined) patch.name = String(b.name).slice(0, 120);
        if (b.category !== undefined) patch.category = String(b.category).slice(0, 60);
        if (b.description !== undefined) patch.description = b.description;
        if (b.node !== undefined) patch.node = checkNode(ctx, b.node);
        const rec = await ctx.repo('library.component').update(params.id!, patch);
        await ctx.tx((c) => c.emit('site.library.changed', { id: rec.id }));
        return { body: rec };
      },
    },
    {
      method: 'DELETE',
      path: '/components/:id',
      surface: 'api',
      permission: 'library.manage',
      handler: async ({ ctx, params }) => {
        await ctx.repo('library.component').delete(params.id!);
        return { status: 204 };
      },
    },
  ],
});
