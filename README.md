# Modulo

A modular, low-code website & application builder: a Squarespace-grade visual editor on top of an Odoo-grade
module system — in a lightweight, web-native TypeScript stack.

- **Everything is a module.** Pages, blog, shop, forms, SEO and even the base blocks are modules with declared
  dependencies (semver), models, blocks, hooks, patches, routes, permissions, settings, shipped data and migrations.
- **Extend without forking.** Modules add fields to other modules' models, wrap behaviour with ordered hooks, and
  patch the site layout by stable ids/slots — conflicts are detected and resolved explicitly, never silently.
- **Low-code ⇄ pro-code.** Studio turns a no-code data model into a real, versioned module you can export as source.
- **Fast published sites.** Server-rendered HTML with atomic CSS and tiny islands (the default page ships < 30KB JS).
- **Design anything.** A catalog-driven style system (flex/grid, spacing, position, typography, backgrounds, borders,
  effects) with breakpoints, hover/focus states, reusable style presets, layout presets and a component library.
- **Real-time collaboration** (Yjs CRDT), **headless** REST + GraphQL, **multi-tenant** with PostgreSQL RLS.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/MODULE-CONVENTIONS.md](docs/MODULE-CONVENTIONS.md).

## Quick start (no setup — embedded Postgres)

```bash
pnpm install
pnpm dev            # API on :4000 (PGlite in .modulo-data/) + editor on :5173
```

Open http://localhost:5173, sign up (the first account becomes the superadmin), create a site, and edit.
Published sites are served at `http://localhost:4000/s/<site-slug>/` (or on a custom domain set in site settings).

## Production-like stack

```bash
docker compose up --build    # Postgres 16 + Modulo on :4000 (media on a volume; S3 via S3_* env)
```

Environment: `DATABASE_URL` (postgres://… or a PGlite directory), `S3_*` for object storage, `MODULO_OPEN_SIGNUP=0`,
`MODULO_SECURE_COOKIES=1` behind HTTPS, `MODULO_APP_ROLE` (RLS role name), `ANTHROPIC_API_KEY` (AI layouts),
Stripe keys are module settings of `payments`.

## CLI

```bash
pnpm modulo --help
pnpm modulo user create --email you@x.io --password ******** --superadmin
pnpm modulo site create --slug demo --name "Demo" --modules shop,blog
pnpm modulo module install forms --site demo     # prints the plan, then applies it
pnpm modulo module new reviews                   # scaffold a module
pnpm modulo module export --site demo --module events --out ./modules/events --rename events
pnpm modulo check --run-tests                    # compatibility matrix vs kernel N / N+1
```

## Tests

```bash
pnpm test                                        # everything on PGlite
TEST_DATABASE_URL=postgres://… npx vitest run packages/kernel --no-file-parallelism   # kernel on real Postgres
pnpm typecheck
```

## Repository layout

```
packages/core      isomorphic: renderer, fields, tree, tokens, styles, blocks, patches, models, sanitizer
packages/kernel    module system: resolver, hooks, schema, repositories, runtimes, installer, events, jobs
packages/collab    Yjs page CRDT + sync protocol
packages/server    HTTP API, publishing, GraphQL, media, collaboration, module discovery
packages/sandbox   QuickJS sandbox for community apps
packages/cli       the modulo CLI
apps/editor        the visual editor (React + dnd-kit)
modules/*          first-party modules (auto-discovered)
```

## Roadmap status

| Phase | Scope | Status |
|---|---|---|
| 0–3 mo | Kernel (loader, resolver, model registry → SQL, hook bus), page document model, publish renderer, editor with core blocks, tokens | Done |
| 3–6 mo | Collections/CMS bindings, forms, patch engine with conflict detection, Yjs collaboration, revisions, multi-tenant RLS, SaaS-ready API | Done |
| 6–12 mo | Shop, no-code model builder (Studio), module export, sandboxed third-party runtime, marketplace, AI-assisted layouts | Done (see known limits in ARCHITECTURE.md) |
