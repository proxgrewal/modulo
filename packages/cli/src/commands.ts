import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import semver from 'semver';
import {
  KERNEL_API_VERSION,
  MapCatalog,
  NotFoundError,
  resolve,
  ResolveError,
  type InstallPlan,
  type InstallReport,
  type Kernel,
  type ModuleChange,
  type ModuleDefinition,
  type SyncReport,
} from '@modulo/kernel';
import { exportLocalModule } from '../../../modules/studio/src/index.ts';
import { REPO_ROOT } from '../../server/src/boot.ts';
import { table, UsageError, type IO } from './io.ts';
import { moduleTemplate, NEW_MODULE_NAME_RE } from './templates.ts';

/** Parsed command-line values plus positionals (`_`). */
export type Args = { _: string[] } & Record<string, string | boolean | string[] | undefined>;

const str = (a: Args, k: string): string | undefined => (typeof a[k] === 'string' ? (a[k] as string) : undefined);
function need(a: Args, k: string): string {
  const v = str(a, k);
  if (!v) throw new UsageError(`--${k} is required`);
  return v;
}

/* ───────────────────────── migrate ───────────────────────── */

export function printSchemaReport(report: SyncReport | null, io: IO) {
  if (!report) {
    io.out('Schema: no changes needed.');
    return;
  }
  const { createdTables, addedColumns, alteredColumns } = report;
  if (!createdTables.length && !addedColumns.length && !alteredColumns.length) {
    io.out(`Schema up to date (${report.indexes.length} indexes verified).`);
    return;
  }
  if (createdTables.length) io.out(`Created tables (${createdTables.length}): ${createdTables.join(', ')}`);
  if (addedColumns.length) io.out(`Added columns (${addedColumns.length}): ${addedColumns.join(', ')}`);
  if (alteredColumns.length) io.out(`Altered columns (${alteredColumns.length}): ${alteredColumns.join(', ')}`);
}

/** Compose every installed module's models and sync the database schema. */
export async function migrate(kernel: Kernel, _args: Args, io: IO) {
  const report = await kernel.recompose();
  printSchemaReport(report, io);
  const installed = (await kernel.db.query<{ n: number }>(`SELECT count(DISTINCT module)::int AS n FROM modulo_site_modules`)).rows[0]?.n ?? 0;
  io.out(`Models: ${kernel.models.size} (from ${installed} installed module(s); ${kernel.catalog.names().length} in catalog — tables are created when a module is first installed on a site)`);
  return 0;
}

/* ───────────────────────── users & sites ───────────────────────── */

export async function userCreate(kernel: Kernel, args: Args, io: IO) {
  const user = await kernel.createUser({ email: need(args, 'email'), password: need(args, 'password'), name: str(args, 'name'), superadmin: !!args.superadmin });
  io.out(`Created user ${user.email} (${user.id})${user.is_superadmin ? ' [superadmin]' : ''}`);
  return 0;
}

async function userIdByEmail(kernel: Kernel, email: string): Promise<string> {
  const r = await kernel.db.query<{ id: string }>(`SELECT id FROM modulo_users WHERE email=$1`, [email.trim().toLowerCase()]);
  if (!r.rows[0]) throw new NotFoundError(`No user with email ${email}`);
  return r.rows[0].id;
}

function parseModuleList(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [name, range] = part.split('@');
    out[name!] = range || '*';
  }
  return out;
}

export async function siteCreate(kernel: Kernel, args: Args, io: IO) {
  const owner = str(args, 'owner');
  const ownerId = owner ? await userIdByEmail(kernel, owner) : undefined;
  const site = await kernel.createSite({ slug: need(args, 'slug'), name: need(args, 'name'), ownerId, modules: parseModuleList(str(args, 'modules')) });
  io.out(`Created site ${site.slug} (${site.id})${owner ? ` owned by ${owner}` : ''}`);
  const mods = await kernel.installedModules(site.id);
  io.out(`Modules: ${mods.map((m) => `${m.name}@${m.version}${m.auto ? ' (auto)' : ''}`).join(', ') || '(none)'}`);
  return 0;
}

export async function siteList(kernel: Kernel, _args: Args, io: IO) {
  const sites = await kernel.listSites();
  if (!sites.length) {
    io.out('No sites. Create one with: modulo site create --slug my-site --name "My site"');
    return 0;
  }
  const rows = [];
  for (const s of sites) {
    const mods = await kernel.installedModules(s.id);
    rows.push([s.slug, s.name, s.domain ?? '', mods.map((m) => m.name).join(',')]);
  }
  table(['slug', 'name', 'domain', 'modules'], rows).forEach((l) => io.out(l));
  return 0;
}

/* ───────────────────────── modules ───────────────────────── */

export async function moduleList(kernel: Kernel, args: Args, io: IO) {
  const slug = str(args, 'site');
  if (slug) {
    const site = await kernel.getSite(slug);
    const installed = await kernel.installedModules(site.id);
    const names = new Set(installed.map((m) => m.name));
    const rows: string[][] = installed.map((m) => [m.name, m.version, kernel.catalog.get(m.name)[0]?.version ?? '?', m.updateAvailable ? `update → ${m.updateAvailable}` : 'installed', m.auto ? 'auto' : m.requested ? '' : 'dependency']);
    for (const name of kernel.catalog.names().sort()) {
      if (names.has(name) || kernel.catalog.get(name)[0]?.category === 'local') continue;
      rows.push([name, '', kernel.catalog.get(name)[0]!.version, 'available', '']);
    }
    io.out(`Modules for site ${site.slug}:`);
    table(['module', 'installed', 'latest', 'status', 'note'], rows).forEach((l) => io.out(l));
    return 0;
  }
  const counts = new Map<string, number>(
    (await kernel.db.query<{ module: string; n: number }>(`SELECT module, count(*)::int AS n FROM modulo_site_modules GROUP BY module`)).rows.map((r) => [r.module, Number(r.n)]),
  );
  const rows = kernel.catalog
    .names()
    .sort()
    .map((name) => {
      const defs = kernel.catalog.get(name);
      const d = defs[0]!;
      return [name, defs.map((x) => x.version).join(', '), d.kernel, Object.entries(d.depends ?? {}).map(([n, r]) => `${n} ${r}`).join(', '), String(counts.get(name) ?? 0), d.category === 'local' ? 'local' : d.required ? 'required' : ''];
    });
  table(['module', 'versions', 'kernel', 'depends', 'sites', 'note'], rows).forEach((l) => io.out(l));
  return 0;
}

export function printPlan(plan: InstallPlan, io: IO) {
  if (!plan.added.length && !plan.removed.length && !plan.upgraded.length) io.out('  (no module changes)');
  for (const a of plan.added) io.out(`  + ${a.name} ${a.version}${plan.lock.modules.find((m) => m.name === a.name)?.auto ? ' (auto)' : ''}`);
  for (const u of plan.upgraded) io.out(`  ^ ${u.name} ${u.from} -> ${u.to}`);
  for (const r of plan.removed) io.out(`  - ${r.name} ${r.version}`);
  for (const c of plan.conflicts) io.out(`  ! conflict on ${c.target} (${c.kind}) between ${c.modules.join(', ')}; winner: ${c.winner}`);
  for (const f of plan.patchFailures) io.out(`  ! patch ${f.patch} (${f.module}) on ${f.template} target ${f.target}: ${f.reason}`);
}

/** `module install|uninstall|upgrade <name> --site <slug>`: print the plan, then apply it (unless --dry-run). */
export async function moduleChange(kernel: Kernel, args: Args, io: IO) {
  const [action, name] = args._;
  if (!action || !['install', 'uninstall', 'upgrade'].includes(action)) throw new UsageError('expected install, uninstall or upgrade');
  if (!name) throw new UsageError(`module ${action} needs a module name`);
  const site = await kernel.getSite(need(args, 'site'));
  const change: ModuleChange =
    action === 'install'
      ? { install: { [name]: str(args, 'version') ?? '*' } }
      : action === 'uninstall'
        ? { uninstall: [name], cascade: !!args.cascade }
        : { upgrade: [name] };
  if (action === 'upgrade' && !(await kernel.installedModules(site.id)).some((m) => m.name === name)) throw new NotFoundError(`${name} is not installed on ${site.slug}`);
  const plan = await kernel.plan(site.id, change);
  io.out(`Plan for site ${site.slug}:`);
  printPlan(plan, io);
  if (args['dry-run']) {
    io.out('Dry run: nothing applied.');
    return 0;
  }
  if (!plan.added.length && !plan.removed.length && !plan.upgraded.length) return 0;
  const report: InstallReport = await kernel.applyChange(site.id, change);
  printSchemaReport(report.schema, io);
  for (const [mod, r] of Object.entries(report.records)) {
    const rr = r as any;
    if (rr?.conflicts?.length) io.out(`  records ${mod}: ${rr.conflicts.length} field(s) kept user edits`);
  }
  io.out('Applied.');
  return 0;
}

/** Scaffold modules/<name> from templates. */
export async function moduleNew(_kernel: Kernel | null, args: Args, io: IO) {
  const name = args._[0];
  if (!name) throw new UsageError('module new needs a name');
  if (!NEW_MODULE_NAME_RE.test(name)) throw new UsageError(`invalid module name "${name}" (lowercase letters, digits, dashes; 2-31 chars)`);
  const root = resolvePath(str(args, 'dir') ?? join(REPO_ROOT, 'modules'));
  const dir = join(root, name);
  if (existsSync(dir)) throw new UsageError(`${dir} already exists`);
  for (const [path, content] of Object.entries(moduleTemplate(name))) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    io.out(`  created ${file}`);
  }
  io.out(`Module ${name} scaffolded. Next: pnpm install && npx vitest run modules/${name}`);
  return 0;
}

/** Export a Studio (no-code) module of a site as a standalone module package. */
export async function moduleExport(kernel: Kernel, args: Args, io: IO) {
  const site = need(args, 'site');
  const local = need(args, 'module');
  const out = resolvePath(need(args, 'out'));
  if (existsSync(out) && readdirSync(out).length && !args.force) throw new UsageError(`${out} is not empty (use --force to overwrite)`);
  const ctx = await kernel.context(site, null, { sudo: true });
  if (!ctx.hasModule('studio')) throw new NotFoundError(`Studio is not installed on ${site}`);
  const result = await exportLocalModule(ctx, local, { rename: str(args, 'rename') });
  for (const [path, content] of Object.entries(result.files)) {
    const file = join(out, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    io.out(`  wrote ${file}`);
  }
  io.out(`Exported ${local} as module "${result.name}" v${result.definition.version}.`);
  return 0;
}

/* ───────────────────────── check: compatibility matrix ───────────────────────── */

export interface CheckEntry {
  def: ModuleDefinition;
  /** Module directory (for --run-tests). */
  dir?: string;
}

export interface CheckOptions {
  entries: CheckEntry[];
  kernelVersion?: string;
  /** Test runner override (tests); default spawns `npx vitest run modules/<name>`. */
  runTests?: (entry: CheckEntry) => boolean;
}

export interface CheckRow {
  module: string;
  version: string;
  current: boolean;
  nextMinor: boolean;
  nextMajor: boolean;
  deps: string;
  depsOk: boolean;
  tests?: boolean;
}

export function compatibilityMatrix(opts: CheckOptions): { kernel: string; minor: string; major: string; rows: CheckRow[] } {
  const kernel = opts.kernelVersion ?? KERNEL_API_VERSION;
  const minor = semver.inc(kernel, 'minor')!;
  const major = semver.inc(kernel, 'major')!;
  const catalog = new MapCatalog();
  const invalid: ModuleDefinition[] = [];
  for (const e of opts.entries) {
    try {
      catalog.add(e.def);
    } catch {
      invalid.push(e.def);
    }
  }
  const ok = (v: string, range: string) => !!semver.validRange(range) && semver.satisfies(v, range, { includePrerelease: true });
  const rows: CheckRow[] = opts.entries.map(({ def }) => {
    const problems: string[] = [];
    if (invalid.includes(def)) problems.push(`invalid version "${def.version}"`);
    for (const [dep, range] of Object.entries(def.depends ?? {})) {
      const avail = catalog.get(dep);
      if (!semver.validRange(range)) problems.push(`${dep}: invalid range ${range}`);
      else if (!avail.length) problems.push(`${dep}: missing`);
      else if (!avail.some((d) => ok(d.version, range))) problems.push(`${dep} ${range}: unsatisfied (have ${avail.map((d) => d.version).join(', ')})`);
    }
    if (!problems.length) {
      try {
        resolve(catalog, { requested: { [def.name]: def.version }, kernelVersion: kernel });
      } catch (e) {
        if (e instanceof ResolveError) problems.push(...e.problems.filter((p) => p.module !== def.name || !/kernel/.test(p.message)).map((p) => `${p.module}: ${p.message}`));
        else problems.push(String((e as Error).message));
      }
    }
    return {
      module: def.name,
      version: def.version,
      current: ok(kernel, def.kernel),
      nextMinor: ok(minor, def.kernel),
      nextMajor: ok(major, def.kernel),
      deps: problems.length ? problems.join('; ') : 'ok',
      depsOk: !problems.length,
    };
  });
  return { kernel, minor, major, rows };
}

export async function check(_kernel: Kernel | null, args: Args, io: IO, opts: CheckOptions) {
  const m = compatibilityMatrix(opts);
  if (args['run-tests']) {
    const run =
      opts.runTests ??
      ((e: CheckEntry) => {
        if (!e.dir) return false;
        const rel = `modules/${e.dir.split(/[\\/]/).pop()}`;
        io.out(`Running tests: ${rel}`);
        return spawnSync('npx', ['vitest', 'run', rel], { cwd: REPO_ROOT, stdio: 'inherit', shell: true }).status === 0;
      });
    const tested = new Map<string, boolean>();
    for (const [i, e] of opts.entries.entries()) {
      const key = e.dir ?? e.def.name;
      if (!tested.has(key)) tested.set(key, run(e));
      m.rows[i]!.tests = tested.get(key);
    }
  }
  const yes = (b: boolean) => (b ? 'ok' : 'FAIL');
  const headers = ['module', 'version', `kernel ${m.kernel}`, `${m.minor} (minor)`, `${m.major} (major)`, 'deps'];
  if (args['run-tests']) headers.push('tests');
  const rows = m.rows.map((r) => [r.module, r.version, yes(r.current), yes(r.nextMinor), r.nextMajor ? 'ok' : 'no', r.deps, ...(args['run-tests'] ? [yes(!!r.tests)] : [])]);
  table(headers, rows).forEach((l) => io.out(l));
  const failing = m.rows.filter((r) => !r.current || !r.depsOk || (args['run-tests'] && !r.tests));
  io.out('');
  if (failing.length) {
    io.err(`${failing.length} module(s) incompatible with kernel ${m.kernel}: ${failing.map((r) => `${r.module}@${r.version}`).join(', ')}`);
    return 1;
  }
  const majorBreak = m.rows.filter((r) => !r.nextMajor).length;
  io.out(`All ${m.rows.length} module(s) compatible with kernel ${m.kernel}.${majorBreak ? ` ${majorBreak} would need an update for kernel ${m.major}.` : ''}`);
  return 0;
}

/* ───────────────────────── dev ───────────────────────── */

export function dev(io: IO): Promise<number> {
  io.out('Starting server: pnpm --filter @modulo/server dev');
  return new Promise((done) => {
    const child = spawn('pnpm', ['--filter', '@modulo/server', 'dev'], { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => done(code ?? 0));
    child.on('error', (e) => {
      io.err(`error: ${e.message}`);
      done(1);
    });
  });
}
