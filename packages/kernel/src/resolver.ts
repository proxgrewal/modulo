import semver from 'semver';
import type { ModuleDefinition } from './module.ts';
import { KERNEL_API_VERSION } from './module.ts';
import { CycleError, toposort } from './toposort.ts';

/**
 * Module resolver: validates semver ranges (kernel + inter-module), expands
 * dependencies, auto-activates glue modules, detects cycles, and produces a
 * deterministic lockfile. Fails before any change is made.
 */
export interface Lockfile {
  kernel: string;
  /** Modules in install (dependency) order. */
  modules: { name: string; version: string; auto?: boolean }[];
}

export interface ResolveProblem {
  module: string;
  message: string;
}

export class ResolveError extends Error {
  constructor(public problems: ResolveProblem[]) {
    super('Module resolution failed:\n' + problems.map((p) => `  - ${p.module}: ${p.message}`).join('\n'));
  }
}

export interface Catalog {
  /** All available versions per module name. */
  get(name: string): ModuleDefinition[];
  names(): string[];
}

export class MapCatalog implements Catalog {
  private map = new Map<string, ModuleDefinition[]>();
  constructor(defs: ModuleDefinition[] = []) {
    for (const d of defs) this.add(d);
  }
  add(def: ModuleDefinition) {
    if (!semver.valid(def.version)) throw new Error(`Module ${def.name} has invalid version ${def.version}`);
    const list = this.map.get(def.name) ?? [];
    if (list.some((d) => d.version === def.version)) return;
    list.push(def);
    list.sort((a, b) => semver.rcompare(a.version, b.version));
    this.map.set(def.name, list);
  }
  remove(name: string, version?: string) {
    if (!version) this.map.delete(name);
    else this.map.set(name, (this.map.get(name) ?? []).filter((d) => d.version !== version));
  }
  get(name: string) {
    return this.map.get(name) ?? [];
  }
  names() {
    return [...this.map.keys()];
  }
}

export interface ResolveOptions {
  /** Explicitly requested modules (by name, optionally with range). */
  requested: Record<string, string>;
  /** Current lockfile; existing versions are preferred when still satisfying (stable upgrades). */
  current?: Lockfile;
  /** Modules to upgrade to the newest satisfying version. */
  upgrade?: string[];
  kernelVersion?: string;
}

export function resolve(catalog: Catalog, opts: ResolveOptions): { lock: Lockfile; defs: ModuleDefinition[] } {
  const kernel = opts.kernelVersion ?? KERNEL_API_VERSION;
  const problems: ResolveProblem[] = [];
  const chosen = new Map<string, ModuleDefinition>();
  const constraints = new Map<string, { range: string; from: string }[]>();
  const pinned = new Map((opts.current?.modules ?? []).map((m) => [m.name, m.version]));
  const upgrade = new Set(opts.upgrade ?? []);
  const auto = new Set<string>();

  const pick = (name: string): ModuleDefinition | null => {
    const cs = constraints.get(name) ?? [];
    const candidates = catalog.get(name).filter((d) => cs.every((c) => semver.satisfies(d.version, c.range, { includePrerelease: true })));
    if (!candidates.length) {
      const avail = catalog.get(name).map((d) => d.version);
      problems.push({
        module: name,
        message: avail.length
          ? `no version satisfies ${cs.map((c) => `${c.range} (from ${c.from})`).join(' and ')}; available: ${avail.join(', ')}`
          : `not found in catalog${cs.length ? ` (required by ${cs.map((c) => c.from).join(', ')})` : ''}`,
      });
      return null;
    }
    const kernelOk = candidates.filter((d) => semver.satisfies(kernel, d.kernel, { includePrerelease: true }));
    if (!kernelOk.length) {
      problems.push({ module: name, message: `no version compatible with kernel ${kernel} (module requires ${candidates.map((d) => `${d.version}→${d.kernel}`).join(', ')})` });
      return null;
    }
    const pin = pinned.get(name);
    if (pin && !upgrade.has(name)) {
      const kept = kernelOk.find((d) => d.version === pin);
      if (kept) return kept;
    }
    return kernelOk[0]!; // newest
  };

  const addConstraint = (name: string, range: string, from: string) => {
    if (!semver.validRange(range)) {
      problems.push({ module: from, message: `invalid range "${range}" for ${name}` });
      return;
    }
    (constraints.get(name) ?? constraints.set(name, []).get(name)!).push({ range, from });
  };

  // Fixed-point expansion: re-pick when new constraints arrive.
  const queue: string[] = [];
  for (const [name, range] of Object.entries(opts.requested)) {
    addConstraint(name, range || '*', '<request>');
    queue.push(name);
  }
  let guard = 0;
  const expand = () => {
    while (queue.length) {
      if (++guard > 10_000) throw new Error('resolver did not converge');
      const name = queue.shift()!;
      const def = pick(name);
      if (!def) continue;
      const prev = chosen.get(name);
      if (prev && prev.version === def.version) continue;
      chosen.set(name, def);
      for (const [dep, range] of Object.entries(def.depends ?? {})) {
        addConstraint(dep, range, `${name}@${def.version}`);
        queue.push(dep);
      }
    }
  };
  expand();

  // Glue modules: activate when all their triggers are installed.
  let changed = true;
  while (changed && !problems.length) {
    changed = false;
    for (const name of catalog.names()) {
      if (chosen.has(name)) continue;
      const newest = catalog.get(name)[0];
      if (newest?.activatesWhen?.length && newest.activatesWhen.every((t) => chosen.has(t))) {
        addConstraint(name, '*', '<auto>');
        auto.add(name);
        queue.push(name);
        expand();
        changed = true;
      }
    }
  }

  // Verify final picks satisfy every constraint (a later constraint may have invalidated an earlier pick).
  for (const [name, def] of chosen) {
    for (const c of constraints.get(name) ?? []) {
      if (!semver.satisfies(def.version, c.range, { includePrerelease: true })) {
        problems.push({ module: name, message: `${def.version} does not satisfy ${c.range} from ${c.from}` });
      }
    }
  }
  if (problems.length) throw new ResolveError(dedupe(problems));

  const names = [...chosen.keys()].sort();
  const edges = new Map<string, Set<string>>();
  for (const n of names) edges.set(n, new Set(Object.keys(chosen.get(n)!.depends ?? {})));
  let order: string[];
  try {
    order = toposort(names, edges);
  } catch (e) {
    if (e instanceof CycleError) throw new ResolveError(e.nodes.map((m) => ({ module: m, message: 'part of a dependency cycle' })));
    throw e;
  }
  const defs = order.map((n) => chosen.get(n)!);
  return {
    defs,
    lock: { kernel, modules: defs.map((d) => ({ name: d.name, version: d.version, ...(auto.has(d.name) ? { auto: true } : {}) })) },
  };
}

function dedupe(p: ResolveProblem[]) {
  const seen = new Set<string>();
  return p.filter((x) => {
    const k = x.module + x.message;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Modules that depend (transitively) on `name` within a lockfile's resolved defs. */
export function dependents(defs: ModuleDefinition[], name: string): string[] {
  const out = new Set<string>();
  let frontier = [name];
  while (frontier.length) {
    const next: string[] = [];
    for (const d of defs) {
      if (out.has(d.name)) continue;
      const deps = [...Object.keys(d.depends ?? {}), ...(d.activatesWhen ?? [])];
      if (deps.some((x) => frontier.includes(x))) {
        out.add(d.name);
        next.push(d.name);
      }
    }
    frontier = next;
  }
  return [...out];
}
