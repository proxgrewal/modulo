import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDb, Kernel, type ModuleDefinition } from '@modulo/kernel';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

export interface DiscoveredModule {
  dir: string;
  defs: ModuleDefinition[];
  onKernelBoot?: (kernel: Kernel) => Promise<void> | void;
}

/** Import every modules/<name>/src/index.ts (default export: definition or array). */
export async function discoverModules(root = join(REPO_ROOT, 'modules')): Promise<DiscoveredModule[]> {
  if (!existsSync(root)) return [];
  const out: DiscoveredModule[] = [];
  for (const dir of readdirSync(root).sort()) {
    const entry = join(root, dir, 'src', 'index.ts');
    if (!existsSync(entry)) continue;
    const mod = await import(pathToFileURL(entry).href);
    const d = mod.default;
    const defs = (Array.isArray(d) ? d : d ? [d] : []) as ModuleDefinition[];
    out.push({ dir: join(root, dir), defs, onKernelBoot: mod.onKernelBoot });
  }
  return out;
}

export interface BootOptions {
  /** postgres://… for Postgres, a directory path for persistent PGlite, or "memory". */
  databaseUrl?: string;
  /** Override module discovery (tests). */
  modules?: ModuleDefinition[];
  extraBootHooks?: ((kernel: Kernel) => Promise<void> | void)[];
  log?: (msg: string, extra?: unknown) => void;
}

/** Create the kernel with all discovered modules and run their onKernelBoot hooks. */
export async function bootKernel(opts: BootOptions = {}): Promise<Kernel> {
  const discovered = opts.modules ? [] : await discoverModules();
  const modules = opts.modules ?? discovered.flatMap((d) => d.defs);
  const db = await createDb(opts.databaseUrl ?? process.env.DATABASE_URL ?? join(REPO_ROOT, '.modulo-data', 'pglite'));
  const kernel = await Kernel.create({ db, modules, log: opts.log });
  for (const d of discovered) await d.onKernelBoot?.(kernel);
  for (const h of opts.extraBootHooks ?? []) await h(kernel);
  const added = await kernel.ensureRequiredModules();
  for (const [slug, mods] of Object.entries(added)) opts.log?.(`installed required modules on ${slug}: ${mods.join(', ')}`);
  return kernel;
}
