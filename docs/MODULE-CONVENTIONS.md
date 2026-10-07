# Modulo module conventions

Modulo is a microkernel website/app builder. Everything is a module. Read this before writing one.

## Layout

```
modules/<name>/
  package.json        name "@modulo/mod-<name>", "type": "module", exports "./src/index.ts"
  src/index.ts        default export: ModuleDefinition | ModuleDefinition[]
                      optional named export: onKernelBoot(kernel: Kernel): Promise<void>
  test/*.test.ts      vitest, run from repo root: `npx vitest run modules/<name>`
```

The server discovers modules automatically by importing `modules/*/src/index.ts` (no central registry to edit).
`onKernelBoot` runs once after the kernel is created (used by Studio/marketplace to register dynamic modules).

Dependencies: `@modulo/core` and `@modulo/kernel` via `"workspace:*"`. Avoid third-party deps; if one is
unavoidable add it to your package.json and run `pnpm install` from the repo root.

There is no build step: TypeScript runs directly via tsx/vitest/vite. Use `.ts` extensions in relative imports.

## The contract (`packages/kernel/src/module.ts`)

```ts
import { defineModule } from '@modulo/kernel';
import { defineModel, extendModel, mf, defineBlock, f, h, slot } from '@modulo/core';

export default defineModule({
  name: 'shop', version: '1.0.0', kernel: '^1.0.0',
  depends: { pages: '^1.0.0' },
  activatesWhen: ['shop', 'blog'],          // glue modules only
  models: [defineModel({ name: 'shop.product', fields: { title: mf.string({ required: true }), price: mf.money() }, access: { read: 'public' } })],
  extendModels: [extendModel({ model: 'pages.page', fields: { ... } })],
  blocks: [defineBlock({ type: 'shop:product-grid', version: 1, label: 'Products', fields: { columns: f.number({ default: 3 }) },
    load: async (props, { services }) => ...,           // server-side data (services.ctx is the SiteContext)
    render: (props, ctx) => ctx.root('div', null, ...) })],
  templates: [], patches: [{ id: 'header-cart', template: 'core:layout', ops: [{ op: 'append', target: 'header#actions', node: {...} }] }],
  hooks: [{ hook: 'page.head', kind: 'filter', fn: (html, info) => html + '...' }],
  routes: [{ method: 'GET', path: '/products', surface: 'api', permission: 'public', handler: async (req) => ({ body: ... }) }],
  permissions: [{ key: 'shop.manage', label: 'Manage shop' }],
  grants: { editor: ['shop.manage'] },
  settings: { currency: f.select(['USD', 'EUR']) },
  records: [{ key: 'default_category', model: 'shop.category', values: { name: 'General' } }],
  events: [{ event: 'shop.order.created', handler: async (payload, ctx) => {} }],
  jobs: [{ name: 'send-receipt', handler: async (payload, ctx) => {} }],
  services: (ctx) => ({ cartTotal: async (cartId: string) => ... }),
  lifecycle: { install: async (ctx) => {}, uninstall: async (ctx) => {}, upgrade: async (ctx, from) => {} },
  migrations: { '1.1.0': { schema: async (db) => {}, data: async (ctx) => {} } },
  editor: { collections: [{ model: 'shop.product', label: 'Products' }] },
});
```

### Rules

- **Namespacing**: model names `<module>.<name>` (module dashes become underscores), block types `<module>:<name>`,
  permission keys `<module>.<action>`, event names `<model>.<created|updated|deleted>` (emitted automatically) or
  `<module>.<something>`.
- **Never edit another module or the kernel/core.** Extend through `extendModels`, `hooks`, `patches`, `services`.
- **Data access** only through `ctx.repo('<model>')` (`find/findOne/get/count/create/update/delete`), which enforces
  access rules, RLS (site isolation), validation, hooks and events. `ctx.asSudo()` bypasses permission checks for
  trusted server logic (e.g. an anonymous visitor placing an order).
- Repository `where`: `{ field: value }` or `{ field: { eq, ne, gt, gte, lt, lte, in, like, ilike, null } }`, `$or: [...]`.
- Model access defaults: read requires sign-in (`'auth'`), writes require `<module>.manage`. Use `'public'` for
  anonymous read.
- Model hooks emitted by repositories: filter `model.<name>.beforeCreate(values, ctx)`,
  `model.<name>.beforeUpdate(values, existing, ctx)`, action `model.<name>.afterCreate(rec, ctx)`, `afterUpdate`,
  `beforeDelete`, `afterDelete`; around `model.<name>.create|update|delete`; filter `model.<name>.where(where, ctx)`
  to restrict visibility.
- Around hooks: `fn(args, next, ctx)` and must call `next()` unless declared `terminal: true`.
- Order hooks with `before`/`after: ['othermodule']` or `['othermodule.handlerId']`, never priorities.
- Routes: `surface: 'api'` is mounted at `/api/sites/:site/m/<module><path>` (JSON). `surface: 'site'` is
  mounted on the published site; return `{ page: { tree, title, scope } }` to render a page inside the site
  layout, or `{ body: '<html>' }` / `{ status, headers, body }`.
  Permission: `'public'`, `'auth'`, or a permission key. API default `'auth'`; site default `'public'`.
- Blocks: render to VNodes with `h()`, `slot()`, `raw()` from `@modulo/core`, and **always** spread `ctx.attrs` via
  `ctx.root(tag, extraAttrs, ...children)` on the outermost element. Style using design tokens
  (`var(--color-primary)`, `var(--space-md)` …) in the block's static `css`. Interactive behaviour goes in an
  `island` (tiny vanilla JS `(el, props) => {}` string); keep it under 2KB. No React on published pages.
- Block `load(props, loadCtx)` runs server-side before render; `loadCtx.services.ctx` is the `SiteContext`,
  `loadCtx.scope` has `{ path, params, record?, query }`.
- Shipped records may reference each other with `{ $ref: 'module.key' }`.

## Testing

```ts
import { Kernel, createPgliteDb, invokeRoute } from '@modulo/kernel';
import base from '../../pages/src/index.ts'; // if needed
const kernel = await Kernel.create({ db: await createPgliteDb(), modules: [myModule, ...deps] });
const site = await kernel.createSite({ slug: 't', name: 'T', modules: { mymodule: '*' } });
const ctx = await kernel.context(site.id, null, { sudo: true });
await invokeRoute(ctx, { module: 'mymodule', method: 'GET', path: '/things' });
await kernel.drain();   // process outbox events + jobs
await kernel.close();
```

Rendering a tree: `renderDocument(tree, { registry: ctx.runtime.blocks, theme: kernel.theme(site), title })` from
`@modulo/core`, after `loadData(tree, registry, { siteId, scope, services: { ctx } })`.
