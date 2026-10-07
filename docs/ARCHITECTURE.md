# Modulo architecture

Modulo is a microkernel website/app builder: Odoo's module principles (declarative models, a dependency graph,
inheritance-by-extension, per-module data and migrations) implemented with web-native, explicit mechanisms.

```
┌──────────────────────── Editor (apps/editor, React + dnd-kit) ────────────────────────┐
│ Canvas iframe ← server edit-mode HTML (same renderer as production → true WYSIWYG)     │
│ Inspector auto-generated from block field schemas · Yjs doc per page (CRDT)            │
└──────────────▲───────────────────────────── REST / GraphQL / WebSocket ──▲─────────────┘
┌──────────────┴──────────────────── Server (packages/server, Hono) ────────┴─────────────┐
│ auth · sites · members · modules plan/apply · data + GraphQL · render · media · collab │
│ publish plane: layout composition → data load → HTML (islands only) → cache → CDN purge│
├────────────────────────────────── Kernel (packages/kernel) ────────────────────────────┤
│ resolver (semver, glue, lockfile) · schema compiler · repositories (RLS) · hook bus     │
│ per-site runtimes · transactional install/upgrade · shipped records (3-way merge)       │
│ transactional outbox · job queue · webhooks                                              │
├────────────────────────────────── Modules (modules/*) ─────────────────────────────────┤
│ core · pages · media · blog · forms · seo · shop · payments · shop-blog (glue) · studio │
│ marketplace (signed community apps → packages/sandbox, QuickJS) · ai                    │
└──────────────────────────── PostgreSQL (PGlite in dev) + object storage ──────────────┘
```

## Packages

| Package | Role |
|---|---|
| `@modulo/core` | Isomorphic: VNode renderer (`h`, `slot`, `raw`), field DSL → zod + inspector metadata, page tree ops, design tokens, atomic CSS, block registry + migrations, patch engine, model definitions, HTML sanitizer |
| `@modulo/kernel` | Module contract, resolver, hook bus, schema compiler, repositories, site contexts, runtimes, auth, shipped records, installer, events/jobs |
| `@modulo/collab` | Pages as a CRDT (flat Yjs node map + fractional ordering), sync room, client provider |
| `@modulo/server` | HTTP API, publish plane, GraphQL, media storage (local/S3), WebSocket collaboration, module discovery |
| `@modulo/sandbox` | Runs community app code in QuickJS (WASM) with capability-scoped host APIs and CPU/memory limits |
| `@modulo/cli` | `modulo` CLI: migrate, users, sites, module install/upgrade/new/export, compatibility matrix |
| `@modulo/editor` | The visual editor SPA |

## How Odoo's ideas map

| Odoo | Modulo |
|---|---|
| `_name` models, ORM creates tables | `defineModel` → `composeModels` → `syncSchema` (create table / add column / indexes / FKs / RLS; never drops) |
| `_inherit` class extension (MRO, `super()`) | `extendModels` (additive fields, computed fields, indexes) + typed hooks: filter / action / around-with-`next()` |
| XML views + XPath inheritance | JSON templates with stable node ids + named slots; patch ops (`append`, `insertBefore`, `replace`, `remove`, `setProp`, `wrap`, `setStyle`) with static conflict detection and admin-chosen winners |
| `depends`, topological load order | semver ranges for kernel and modules, resolver with lockfile per site; deterministic hook order from `before`/`after` |
| `auto_install` glue modules | `activatesWhen: ['shop','blog']`; removed automatically when a trigger is uninstalled |
| XML ids, `noupdate` | `records` with stable keys and `$ref`; upgrades do a three-way merge (user edits win, conflicts reported) |
| `migrations/<ver>/pre|post` | `migrations: { '2.0.0': { schema(db), data(ctx) } }` — schema steps before sync, data steps per site |
| `ir.model.access` + record rules | model `access` (public / auth / permission), `model.<name>.where` filter hooks, PostgreSQL RLS per site |
| Odoo Studio | Studio module: no-code models published as real versioned modules, exportable as source |

## Design system

- **Style catalog** (`packages/core/src/style.ts`): ~90 properties in 9 groups — layout (flex/grid, gaps, tracks),
  flex/grid child, spacing (per side), size, position (absolute/fixed/sticky, offsets, z-index), typography,
  background (colors, gradients, images, parallax, overlay tint), borders (per side, per corner), effects (opacity,
  shadows, transforms, transitions, filters, backdrop blur, blend modes). One catalog drives CSS compilation,
  validation (injection-safe), and the editor's Style panel.
- **Layers of a node's style**: base (desktop) → breakpoint overrides `md` 1024 / `sm` 640 / `xs` 420 → interaction
  states `hover` / `focus` / `active`. Compiled to deterministic atomic classes, de-duplicated per page.
- **Style presets** (site-level, like design-tool classes): named reusable styles with their own breakpoints/states,
  applied to any node; node styles override presets. Plus site **custom CSS** and per-node class names.
- **Primitives**: `core:box` (any tag, optional link) + the catalog can express any layout; `core:columns`, `icon`,
  `list`, `embed` (allow-listed, sandboxed). Composite blocks can be **unpacked** (`toPrimitives`) into primitives so
  every inner element is editable. Modules contribute **layout presets** (ready-made sections) to the palette.
- **Component library** (`modules/library`): save any subtree; insert as a copy or a synced instance. Instances are
  expanded by the `page.tree` render hook, so editing a component updates every page.
- **Layout (header/footer)**: styled with the same panel via patch ops (`setStyle` with `bp`/`state`, `setField`).

## Request flows

**Published page**: `GET /s/<slug>/<path>` (or a custom domain) → module site route or `pages.page` by path → layout
template with module patches and site patches applied → page children placed in `core:outlet` → block `load()` in
parallel → render to HTML + atomic CSS + island scripts → `page.head`/`page.bodyEnd` hooks → cache (ETag) → events
(`pages.page.published`, any model change) invalidate the cache and call the CDN adapter.

**Editing**: the editor joins `ws /api/sites/:site/collab/:pageId` (Yjs). Edits are CRDT ops; the room persists a
validated draft after edits settle. The canvas re-renders through `POST /api/sites/:site/render` in edit mode (node ids
and `<m-slot>` drop zones).

**Install**: `plan` resolves the new lockfile and reports added/removed/upgraded modules and patch conflicts →
`apply` syncs the schema, then in one transaction runs uninstall hooks, install hooks, data migrations, shipped
records, and writes the lockfile. Any failure rolls back the site's data changes; the in-memory registry is restored.

## Multi-tenancy & security

- Every model table has `site_id` with `FORCE ROW LEVEL SECURITY`; site work runs in a transaction with
  `SET LOCAL ROLE modulo_app` and `app.site_id`, plus explicit `site_id` filters (defence in depth). Verified on
  PGlite, Postgres as superuser, and Postgres as a non-superuser owner (`MODULO_APP_ROLE` configurable).
- Sessions: httpOnly SameSite=Lax cookies (or Bearer tokens); passwords hashed with scrypt.
- CSRF: cookie-authenticated state changes must be JSON or send `x-modulo-client: 1`.
- Rendering escapes all text/attributes, blocks `javascript:` URLs and inline handlers; rich text goes through an
  allowlist sanitizer; uploads are sniffed by magic bytes; SVG is served with a sandbox CSP.
- Community apps run in QuickJS with memory/CPU limits and capability-gated host functions, installed only from
  signed packages with explicit capability consent.

## Known limits (honest list)

- Schema DDL from an install is additive and is not rolled back if the install's data phase fails (the in-memory
  registry is). Columns are never dropped automatically.
- The S3 adapter implements SigV4 but has only been exercised through the interface, not against live S3/MinIO.
- Stripe integration is unit-tested with mocked HTTP; it has not been run against Stripe's API.
- Page cache is in-process; multi-instance deployments need a shared cache or CDN purge adapter.
- Stock is reserved at order creation; unpaid orders hold stock until cancelled.
- PGlite (dev) is single-process: the kernel holds an exclusive lock on the data directory. Use PostgreSQL for
  multiple server processes.
- Sandbox `fetch` allowlists hostnames; it does not defend against DNS rebinding to internal IPs.
- The `fake` payment provider confirms payments publicly by design — never enable it on a production site.
- Editor: no inline on-canvas text editing (double-click focuses the inspector); interactive islands are static on
  the canvas; layout-node style edits apply to all breakpoints; only pure logic is unit-tested (no component tests).
- jsonb does not preserve key order; `modulo_models.def.fieldOrder` carries field order for UIs.
