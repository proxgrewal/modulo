import { parseArgs } from 'node:util';
import type { Kernel } from '@modulo/kernel';
import { bootKernel, discoverModules } from '../../server/src/boot.ts';
import { check, dev, migrate, moduleChange, moduleExport, moduleList, moduleNew, siteCreate, siteList, userCreate, type Args } from './commands.ts';
import { processIO, reportError, UsageError, type IO } from './io.ts';

type OptionSpec = { type: 'string' | 'boolean'; short?: string; description: string };

interface CommandSpec {
  path: string[];
  args?: string;
  summary: string;
  options?: Record<string, OptionSpec>;
  /** none: no database; boot: full kernel; migrate: kernel booted without modules, then modules added. */
  kernel: 'none' | 'boot' | 'migrate';
  run(kernel: Kernel | null, args: Args, io: IO): Promise<number>;
}

const GLOBAL: Record<string, OptionSpec> = {
  db: { type: 'string', description: 'Database: postgres://… URL, PGlite data directory, or "memory" (default: $DATABASE_URL or .modulo-data/pglite)' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
};

const site: OptionSpec = { type: 'string', description: 'Site slug' };

export const COMMANDS: CommandSpec[] = [
  { path: ['dev'], summary: 'Start the development server', kernel: 'none', run: (_k, _a, io) => dev(io) },
  { path: ['migrate'], summary: 'Sync the database schema with all modules and print the report', kernel: 'migrate', run: (k, a, io) => migrate(k!, a, io) },
  {
    path: ['user', 'create'],
    summary: 'Create a user',
    kernel: 'boot',
    options: {
      email: { type: 'string', description: 'Email (required)' },
      password: { type: 'string', description: 'Password, at least 8 characters (required)' },
      name: { type: 'string', description: 'Display name' },
      superadmin: { type: 'boolean', description: 'Grant platform superadmin' },
    },
    run: (k, a, io) => userCreate(k!, a, io),
  },
  {
    path: ['site', 'create'],
    summary: 'Create a site',
    kernel: 'boot',
    options: {
      slug: { type: 'string', description: 'URL slug (required)' },
      name: { type: 'string', description: 'Site name (required)' },
      owner: { type: 'string', description: 'Owner email (existing user)' },
      modules: { type: 'string', description: 'Comma-separated modules to install, e.g. shop,blog@^1.0.0' },
    },
    run: (k, a, io) => siteCreate(k!, a, io),
  },
  { path: ['site', 'list'], summary: 'List sites', kernel: 'boot', run: (k, a, io) => siteList(k!, a, io) },
  {
    path: ['module', 'list'],
    summary: 'List the module catalog, or a site’s modules with available updates',
    kernel: 'boot',
    options: { site },
    run: (k, a, io) => moduleList(k!, a, io),
  },
  ...(['install', 'uninstall', 'upgrade'] as const).map(
    (action): CommandSpec => ({
      path: ['module', action],
      args: '<name>',
      summary: `${action[0]!.toUpperCase() + action.slice(1)} a module on a site (prints the plan, then applies it)`,
      kernel: 'boot',
      options: {
        site: { ...site, description: 'Site slug (required)' },
        ...(action === 'install' ? { version: { type: 'string', description: 'Version range (default *)' } as OptionSpec } : {}),
        ...(action === 'uninstall' ? { cascade: { type: 'boolean', description: 'Also uninstall modules that depend on it' } as OptionSpec } : {}),
        'dry-run': { type: 'boolean', description: 'Only print the plan' },
      },
      run: (k, a, io) => moduleChange(k!, { ...a, _: [action, ...a._] }, io),
    }),
  ),
  {
    path: ['module', 'new'],
    args: '<name>',
    summary: 'Scaffold modules/<name> (model + block + route + test)',
    kernel: 'none',
    options: { dir: { type: 'string', description: 'Parent directory (default: <repo>/modules)' } },
    run: (_k, a, io) => moduleNew(null, a, io),
  },
  {
    path: ['module', 'export'],
    summary: 'Export a Studio (no-code) module as a standalone module package',
    kernel: 'boot',
    options: {
      site: { ...site, description: 'Site slug (required)' },
      module: { type: 'string', description: 'Local module name (required)' },
      out: { type: 'string', description: 'Output directory (required)' },
      rename: { type: 'string', description: 'Module name for the export, e.g. "events"' },
      force: { type: 'boolean', description: 'Write into a non-empty directory' },
    },
    run: (k, a, io) => moduleExport(k!, a, io),
  },
  {
    path: ['check'],
    summary: 'Compatibility matrix: kernel ranges (current / next minor / next major) and dependencies',
    kernel: 'none',
    options: { 'run-tests': { type: 'boolean', description: 'Also run each module’s tests' } },
    run: async (_k, a, io) => {
      const found = await discoverModules();
      return check(null, a, io, { entries: found.flatMap((d) => d.defs.map((def) => ({ def, dir: d.dir }))) });
    },
  },
];

function usageLine(c: CommandSpec) {
  return `modulo ${c.path.join(' ')}${c.args ? ' ' + c.args : ''}`;
}

function printOptions(opts: Record<string, OptionSpec>, io: IO) {
  for (const [name, o] of Object.entries(opts)) {
    const flag = `${o.short ? `-${o.short}, ` : '    '}--${name}${o.type === 'string' ? ' <value>' : ''}`;
    io.out(`  ${flag.padEnd(26)} ${o.description}`);
  }
}

export function printHelp(io: IO, cmd?: CommandSpec) {
  if (cmd) {
    io.out(`Usage: ${usageLine(cmd)} [options]`);
    io.out('');
    io.out(cmd.summary);
    io.out('');
    io.out('Options:');
    printOptions({ ...(cmd.options ?? {}), ...(cmd.kernel === 'none' ? { help: GLOBAL.help! } : GLOBAL) }, io);
    return;
  }
  io.out('Usage: modulo <command> [options]');
  io.out('');
  io.out('Commands:');
  const w = Math.max(...COMMANDS.map((c) => usageLine(c).length - 7));
  for (const c of COMMANDS) io.out(`  ${usageLine(c).slice(7).padEnd(w)}  ${c.summary}`);
  io.out('');
  io.out('Global options:');
  printOptions(GLOBAL, io);
  io.out('');
  io.out('Run "modulo <command> --help" for command options.');
}

function findCommand(words: string[]): { cmd: CommandSpec; rest: string[] } | null {
  let best: CommandSpec | null = null;
  for (const c of COMMANDS) {
    if (c.path.every((p, i) => words[i] === p) && (!best || c.path.length > best.path.length)) best = c;
  }
  return best ? { cmd: best, rest: words.slice(best.path.length) } : null;
}

export interface MainDeps {
  io?: IO;
  /** Kernel factory (tests inject an in-memory kernel). */
  boot?: (opts: { databaseUrl?: string; mode: 'boot' | 'migrate' }) => Promise<Kernel>;
}

/** Boot hooks deferred until after `migrate` has printed its report. */
const afterRun = new WeakMap<Kernel, ((k: Kernel) => Promise<void> | void)[]>();

async function defaultBoot({ databaseUrl, mode }: { databaseUrl?: string; mode: 'boot' | 'migrate' }): Promise<Kernel> {
  if (mode === 'boot') return bootKernel({ databaseUrl });
  // migrate: boot without modules so the schema sync report reflects the real changes,
  // then add the discovered modules (the command recomposes), then run boot hooks.
  const discovered = await discoverModules();
  const kernel = await bootKernel({ databaseUrl, modules: [] });
  for (const d of discovered) for (const def of d.defs) kernel.catalog.add(def);
  afterRun.set(kernel, discovered.flatMap((d) => (d.onKernelBoot ? [d.onKernelBoot] : [])));
  return kernel;
}

/** Entry point: returns the process exit code. */
export async function main(argv: string[], deps: MainDeps = {}): Promise<number> {
  const io = deps.io ?? processIO;
  const words: string[] = [];
  for (const a of argv) {
    if (a.startsWith('-')) break;
    words.push(a);
  }
  if (!words.length) {
    printHelp(io);
    return argv.includes('--help') || argv.includes('-h') ? 0 : 2;
  }
  const found = findCommand(words);
  if (!found) {
    io.err(`error: unknown command "${words.join(' ')}"`);
    printHelp(io);
    return 2;
  }
  const { cmd } = found;
  let parsed;
  try {
    parsed = parseArgs({
      args: argv.slice(cmd.path.length),
      options: { ...GLOBAL, ...(cmd.options ?? {}) } as any,
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    io.err(`error: ${(e as Error).message}`);
    printHelp(io, cmd);
    return 2;
  }
  if ((parsed.values as Record<string, unknown>).help) {
    printHelp(io, cmd);
    return 0;
  }
  const args: Args = { ...(parsed.values as Record<string, string | boolean>), _: parsed.positionals };
  let kernel: Kernel | null = null;
  try {
    if (cmd.kernel !== 'none') {
      kernel = await (deps.boot ?? defaultBoot)({ databaseUrl: args.db as string | undefined, mode: cmd.kernel });
    }
    const code = await cmd.run(kernel, args, io);
    if (kernel) for (const h of afterRun.get(kernel) ?? []) await h(kernel);
    return code;
  } catch (e) {
    const code = reportError(e, io);
    if (e instanceof UsageError) printHelp(io, cmd);
    return code;
  } finally {
    await kernel?.close().catch(() => {});
  }
}
