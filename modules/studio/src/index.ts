import semver from 'semver';
import { defineModel, mf } from '@modulo/core';
import {
  ConflictError,
  defineModule,
  ModuloError,
  NotFoundError,
  ValidationError,
  type Kernel,
  type ModuleDefinition,
  type RouteRequest,
  type SiteContext,
} from '@modulo/kernel';
import { exportModule, EXPORT_NAME_RE } from './codegen.ts';
import {
  buildModule,
  COMMON_FIELD_PROPS,
  emptyDefinition,
  FIELD_KIND_INFO,
  incompatibleChanges,
  LOCAL_NAME_RE,
  localModuleName,
  packOrder,
  unpackOrder,
  retainedSchema,
  validateDefinition,
  type SiteModelInfo,
  type ValidationResult,
} from './definition.ts';

export * from './definition.ts';
export { exportModule, moduleSource, lit, fieldExpr, EXPORT_NAME_RE, type ExportResult } from './codegen.ts';

const MODEL = 'studio.local_module';
const TABLE = 'm_studio__local_module';
/** Meta flag marking writes made by Studio itself (protects version bookkeeping from direct edits). */
const INTERNAL = 'studioInternal';
const PROTECTED_FIELDS = ['version', 'status', 'published_version', 'versions'];

/** Which site registered each generated module name (guards against id8 prefix collisions). */
const owners = new WeakMap<Kernel, Map<string, string>>();
function ownerMap(kernel: Kernel) {
  let m = owners.get(kernel);
  if (!m) owners.set(kernel, (m = new Map()));
  return m;
}

function register(kernel: Kernel, siteId: string, def: ModuleDefinition) {
  const map = ownerMap(kernel);
  const owner = map.get(def.name);
  if (owner && owner !== siteId) {
    throw new ConflictError(`Module name ${def.name} is already used by another site; choose a different name`);
  }
  map.set(def.name, siteId);
  kernel.catalog.add(def);
}

/* ───────────────────────── helpers ───────────────────────── */

function siteModels(ctx: SiteContext): Map<string, SiteModelInfo> {
  const out = new Map<string, SiteModelInfo>();
  for (const [name, m] of ctx.kernel.models) {
    if (!ctx.runtime.installed.has(m.module)) continue;
    out.set(name, {
      module: m.module,
      fields: Object.fromEntries(Object.values(m.fields).filter((f) => ctx.runtime.installed.has(f.module)).map((f) => [f.name, { kind: f.kind, module: f.module }])),
    });
  }
  return out;
}

async function otherLocals(ctx: SiteContext, exceptId?: string): Promise<Map<string, string>> {
  const rows = await ctx.asSudo().repo(MODEL).find({ limit: 1000 });
  return new Map(rows.filter((r) => r.id !== exceptId).map((r) => [r.name as string, localModuleName(ctx.site.id, r.name)]));
}

async function validateFor(ctx: SiteContext, name: string, definition: unknown, recordId?: string): Promise<ValidationResult> {
  return validateDefinition(unpackOrder(definition), {
    localName: name,
    moduleName: localModuleName(ctx.site.id, name),
    siteModels: siteModels(ctx),
    otherLocals: await otherLocals(ctx, recordId),
  });
}

function fail(res: ValidationResult): never {
  throw new ValidationError(`Invalid module definition:\n  - ${res.problems.join('\n  - ')}`, res.problems);
}

/** Modules owning the models this definition extends or references (with a compatible range). */
function computeDepends(ctx: SiteContext, built: ModuleDefinition): Record<string, string> {
  const deps: Record<string, string> = {};
  const targets = [
    ...(built.extendModels ?? []).map((e) => e.model),
    ...[...(built.models ?? []), ...(built.extendModels ?? [])].flatMap((m) => Object.values(m.fields ?? {}).filter((f) => f.kind === 'ref').map((f) => f.model!)),
  ];
  for (const t of targets) {
    const owner = ctx.kernel.models.get(t)?.module;
    if (!owner || owner === built.name) continue;
    const installed = ctx.runtime.defs.find((d) => d.name === owner);
    if (installed) deps[owner] = `^${installed.version}`;
  }
  return deps;
}

async function nextVersion(ctx: SiteContext, moduleName: string, rec: Record<string, any>): Promise<string> {
  const known: string[] = [];
  if (rec.published_version) known.push(rec.published_version);
  known.push(...Object.keys(rec.versions ?? {}));
  const newest = ctx.kernel.catalog.get(moduleName)[0];
  if (newest) known.push(newest.version);
  const sv = await ctx.kernel.db.query<{ version: string }>(`SELECT version FROM modulo_schema_versions WHERE module=$1`, [moduleName]);
  if (sv.rows[0]) known.push(sv.rows[0].version);
  const valid = known.filter((v) => semver.valid(v)).sort(semver.rcompare);
  return valid.length ? semver.inc(valid[0]!, 'patch')! : '1.0.0';
}

function summary(ctx: SiteContext, r: Record<string, any>) {
  const moduleName = localModuleName(ctx.site.id, r.name);
  const installed = ctx.runtime.defs.find((d) => d.name === moduleName);
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    description: r.description ?? null,
    module: moduleName,
    version: r.version,
    status: r.status,
    published_version: r.published_version ?? null,
    installed_version: installed?.version ?? null,
    versions: Object.keys(r.versions ?? {}).sort(semver.compare),
    definition: unpackOrder(r.definition),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function assertNotInTx(ctx: SiteContext) {
  if (ctx.inSiteTx || ctx.db.inTx) {
    throw new ModuloError('Module changes must run outside a transaction (applyChange opens its own)', 500, 'studio_tx');
  }
}

/* ───────────────────────── operations (also used by the CLI) ───────────────────────── */

export async function createLocalModule(ctx: SiteContext, input: { name?: unknown; label?: unknown; description?: unknown; definition?: unknown }) {
  const name = String(input.name ?? '');
  if (!LOCAL_NAME_RE.test(name)) throw new ValidationError('name must match /^[a-z][a-z0-9_]{1,30}$/ (lowercase letters, digits, underscores; 2-31 chars)');
  const definition = input.definition ?? emptyDefinition();
  const res = await validateFor(ctx, name, definition);
  if (!res.ok) fail(res);
  const rec = await ctx.withMeta({ [INTERNAL]: true }).repo(MODEL).create({
    name,
    label: input.label ? String(input.label) : name,
    description: input.description ? String(input.description) : null,
    definition: packOrder(res.definition),
    status: 'draft',
    version: '1.0.0',
    versions: {},
  });
  return summary(ctx, rec);
}

export async function updateLocalModule(ctx: SiteContext, id: string, input: { label?: unknown; description?: unknown; definition?: unknown }) {
  const repo = ctx.withMeta({ [INTERNAL]: true }).repo(MODEL);
  const rec = await repo.get(id);
  const values: Record<string, unknown> = {};
  if (input.label !== undefined) values.label = String(input.label);
  if (input.description !== undefined) values.description = input.description === null ? null : String(input.description);
  if (input.definition !== undefined) {
    const res = await validateFor(ctx, rec.name, input.definition, rec.id);
    if (!res.ok) fail(res);
    values.definition = packOrder(res.definition);
    values.status = 'draft';
  }
  return summary(ctx, await repo.update(id, values));
}

export async function publishLocalModule(ctx: SiteContext, id: string) {
  assertNotInTx(ctx);
  const repo = ctx.withMeta({ [INTERNAL]: true }).repo(MODEL);
  const rec = await repo.get(id);
  const moduleName = localModuleName(ctx.site.id, rec.name);
  const res = await validateFor(ctx, rec.name, rec.definition, rec.id);
  if (!res.ok) fail(res);
  const version = await nextVersion(ctx, moduleName, rec);
  const draft = buildModule({ moduleName, localName: rec.name, version, label: rec.label, description: rec.description, definition: res.definition!, refMap: res.refMap });
  const built = buildModule({
    moduleName,
    localName: rec.name,
    version,
    label: rec.label,
    description: rec.description,
    definition: res.definition!,
    refMap: res.refMap,
    depends: computeDepends(ctx, draft),
  });
  const prev: ModuleDefinition | null = rec.published_version ? unpackOrder(rec.versions?.[rec.published_version] ?? null) : null;
  const incompatible = incompatibleChanges(prev, built);
  if (incompatible.length) throw new ValidationError(`Cannot publish:\n  - ${incompatible.join('\n  - ')}`, incompatible);

  register(ctx.kernel, ctx.site.id, built);
  let report;
  try {
    report = await ctx.kernel.applyChange(ctx.site.id, { install: { [moduleName]: `^${version}` } }, { actorId: ctx.user?.id });
  } catch (e) {
    ctx.kernel.catalog.remove(moduleName, version);
    throw e;
  }
  const { retainedColumns, retainedTables } = retainedSchema(prev, built);
  await repo.update(id, {
    version,
    published_version: version,
    status: 'published',
    versions: { ...(rec.versions ?? {}), [version]: packOrder(JSON.parse(JSON.stringify(built))) },
  });
  return {
    module: moduleName,
    version,
    previous: prev?.version ?? null,
    depends: built.depends ?? {},
    added: report.added,
    upgraded: report.upgraded,
    removed: report.removed,
    conflicts: report.conflicts,
    patchFailures: report.patchFailures,
    schema: report.schema,
    retainedColumns,
    retainedTables,
    ...(retainedColumns.length || retainedTables.length
      ? { note: 'Removed fields/models keep their database columns/tables (the kernel never drops data); they are simply no longer exposed.' }
      : {}),
  };
}

/** The ModuleDefinition to export: the latest published version, or the current draft built in memory. */
export async function exportLocalModule(ctx: SiteContext, idOrName: string, opts: { rename?: string } = {}) {
  const repo = ctx.repo(MODEL);
  const rec = /^[0-9a-f-]{36}$/i.test(idOrName) ? await repo.get(idOrName) : await repo.findOne({ name: idOrName });
  if (!rec) throw new NotFoundError(`Local module ${idOrName} not found`);
  if (opts.rename !== undefined && !EXPORT_NAME_RE.test(opts.rename)) throw new ValidationError(`Invalid module name "${opts.rename}" (lowercase letters, digits and dashes)`);
  let built: ModuleDefinition | null = rec.published_version ? unpackOrder(rec.versions?.[rec.published_version] ?? null) : null;
  if (!built) {
    const moduleName = localModuleName(ctx.site.id, rec.name);
    const res = await validateFor(ctx, rec.name, rec.definition, rec.id);
    if (!res.ok) fail(res);
    const draft = buildModule({ moduleName, localName: rec.name, version: rec.version ?? '1.0.0', label: rec.label, description: rec.description, definition: res.definition!, refMap: res.refMap });
    built = { ...draft, depends: computeDepends(ctx, draft) };
    if (!Object.keys(built.depends!).length) delete built.depends;
  }
  return exportModule(built, opts);
}

export async function deleteLocalModule(ctx: SiteContext, id: string, opts: { cascade?: boolean } = {}) {
  assertNotInTx(ctx);
  const repo = ctx.withMeta({ [INTERNAL]: true }).repo(MODEL);
  const rec = await repo.get(id);
  const moduleName = localModuleName(ctx.site.id, rec.name);
  const installed = (await ctx.kernel.installedModules(ctx.site.id)).some((m) => m.name === moduleName);
  const report = installed ? await ctx.kernel.applyChange(ctx.site.id, { uninstall: [moduleName], cascade: !!opts.cascade }, { actorId: ctx.user?.id }) : null;
  await repo.delete(id);
  return {
    module: moduleName,
    uninstalled: !!report,
    removed: report?.removed ?? [],
    note: 'Database tables and columns are retained; re-creating a module with the same name continues its version history.',
  };
}

/* ───────────────────────── boot: re-register published local modules ───────────────────────── */

/**
 * Local modules live in the database, not in modules/*: after a restart the
 * catalog must be repopulated before any site that installed one can build its
 * runtime. Every published version is registered so locked versions resolve.
 */
export async function onKernelBoot(kernel: Kernel) {
  const exists = await kernel.db.query(`SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [TABLE]);
  if (!exists.rows.length) return;
  // Bind app.site_id per site so this also works when the connection role is subject to
  // FORCE ROW LEVEL SECURITY (non-superuser table owner on Postgres).
  const rows = await kernel.db.tx(async (t) => {
    const sites = (await t.query<{ id: string }>(`SELECT id FROM modulo_sites`)).rows;
    const out: { site_id: string; name: string; versions: Record<string, ModuleDefinition> | null }[] = [];
    for (const s of sites) {
      await t.query(`SELECT set_config('app.site_id', $1, true)`, [s.id]);
      out.push(...(await t.query(`SELECT site_id, name, versions FROM ${TABLE} WHERE site_id=$1`, [s.id])).rows);
    }
    return out;
  });
  let added = 0;
  for (const r of rows) {
    const expected = localModuleName(r.site_id, r.name);
    for (const [v, packed] of Object.entries(r.versions ?? {})) {
      const def = unpackOrder(packed);
      // Never trust a stored definition to claim another module's name.
      if (!def || def.name !== expected || def.version !== v || !semver.valid(v)) continue;
      register(kernel, r.site_id, def);
      added++;
    }
  }
  if (added) {
    await kernel.recompose();
    kernel.invalidate();
  }
}

/* ───────────────────────── module definition ───────────────────────── */

const id = (req: RouteRequest) => req.params.id!;
const body = (req: RouteRequest) => (req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {});

export default defineModule({
  name: 'studio',
  version: '1.0.0',
  label: 'Studio',
  description: 'No-code model builder: define custom data models that publish as real site-local modules and export as code.',
  kernel: '^1.0.0',
  category: 'developer',
  models: [
    defineModel({
      name: MODEL,
      label: 'Custom module',
      titleField: 'label',
      fields: {
        name: mf.string({ required: true, unique: true, max: 31, label: 'Name', help: 'Lowercase identifier, e.g. "events"' }),
        label: mf.string({ required: true, label: 'Label' }),
        description: mf.text({ label: 'Description' }),
        version: mf.string({ max: 32, default: '1.0.0', label: 'Version' }),
        definition: mf.json({ label: 'Definition' }),
        status: mf.enum(['draft', 'published'], { default: 'draft', label: 'Status' }),
        published_version: mf.string({ max: 32, label: 'Published version' }),
        versions: mf.json({ label: 'Published definitions', private: true }),
      },
      access: { read: 'studio.manage', create: 'studio.manage', update: 'studio.manage', delete: 'studio.manage' },
      order: 'label asc',
    }),
  ],
  hooks: [
    {
      hook: `model.${MODEL}.beforeCreate`,
      kind: 'filter',
      id: 'guard-create',
      fn: (values: Record<string, any>, ctx: SiteContext) => {
        if (!LOCAL_NAME_RE.test(String(values.name ?? ''))) throw new ValidationError('name must match /^[a-z][a-z0-9_]{1,30}$/');
        if (!ctx.meta[INTERNAL]) {
          for (const f of PROTECTED_FIELDS) delete values[f];
          values.status = 'draft';
          values.versions = {};
          values.definition ??= emptyDefinition();
        }
        return values;
      },
    },
    {
      hook: `model.${MODEL}.beforeUpdate`,
      kind: 'filter',
      id: 'guard-update',
      fn: (values: Record<string, any>, existing: Record<string, any>, ctx: SiteContext) => {
        if (values.name !== undefined && values.name !== existing.name) throw new ValidationError('A custom module cannot be renamed; create a new one instead');
        if (!ctx.meta[INTERNAL]) {
          for (const f of PROTECTED_FIELDS) delete values[f];
          if (values.definition !== undefined) values.status = 'draft';
        }
        return values;
      },
    },
  ],
  routes: [
    {
      method: 'GET',
      path: '/field-kinds',
      surface: 'api',
      permission: 'studio.manage',
      handler: () => ({ body: { kinds: FIELD_KIND_INFO, commonProps: COMMON_FIELD_PROPS, onDelete: ['set null', 'cascade', 'restrict'] } }),
    },
    {
      method: 'GET',
      path: '/modules',
      surface: 'api',
      permission: 'studio.manage',
      handler: async ({ ctx }) => ({ body: (await ctx.repo(MODEL).find({ limit: 500 })).map((r) => summary(ctx, r)) }),
    },
    {
      method: 'POST',
      path: '/modules',
      surface: 'api',
      permission: 'studio.manage',
      handler: async (req) => ({ status: 201, body: await createLocalModule(req.ctx, body(req)) }),
    },
    {
      method: 'GET',
      path: '/modules/:id',
      surface: 'api',
      permission: 'studio.manage',
      handler: async (req) => {
        const rec = await req.ctx.repo(MODEL).get(id(req));
        const res = await validateFor(req.ctx, rec.name, rec.definition, rec.id);
        return { body: { ...summary(req.ctx, rec), problems: res.problems } };
      },
    },
    {
      method: 'PUT',
      path: '/modules/:id',
      surface: 'api',
      permission: 'studio.manage',
      handler: async (req) => ({ body: await updateLocalModule(req.ctx, id(req), body(req)) }),
    },
    {
      method: 'POST',
      path: '/modules/:id/publish',
      surface: 'api',
      permission: 'studio.manage',
      handler: async (req) => ({ body: await publishLocalModule(req.ctx, id(req)) }),
    },
    {
      method: 'GET',
      path: '/modules/:id/export',
      surface: 'api',
      permission: 'studio.manage',
      handler: async (req) => {
        const out = await exportLocalModule(req.ctx, id(req), { rename: req.query.rename || undefined });
        return { body: { name: out.name, files: out.files } };
      },
    },
    {
      method: 'DELETE',
      path: '/modules/:id',
      surface: 'api',
      permission: 'studio.manage',
      handler: async (req) => ({ body: await deleteLocalModule(req.ctx, id(req), { cascade: req.query.cascade === '1' || req.query.cascade === 'true' }) }),
    },
  ],
  permissions: [{ key: 'studio.manage', label: 'Build custom data modules' }],
  editor: { collections: [{ model: MODEL, label: 'Custom data', icon: 'database', columns: ['label', 'name', 'status', 'published_version'] }] },
});

