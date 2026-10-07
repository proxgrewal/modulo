import { toposort } from './toposort.ts';

/**
 * Typed hook bus — replaces Odoo's super() chains and WordPress's priority
 * numbers. Ordering comes from module dependency order plus explicit
 * before/after constraints. "around" hooks are middleware; a handler that
 * returns without calling next() must declare itself terminal, so a forgotten
 * next() fails loudly instead of silently disabling every other module.
 */
export type HookKind = 'filter' | 'action' | 'around';

export interface HookRegistration<Ctx = any> {
  hook: string;
  kind: HookKind;
  /** Local id; becomes "<module>.<id>" for ordering constraints. */
  id?: string;
  before?: string[];
  after?: string[];
  /** around only: may intentionally short-circuit without calling next(). */
  terminal?: boolean;
  fn: (...args: any[]) => any;
  /** Filled in by the kernel. */
  module?: string;
  ctx?: Ctx;
}

export class HookChainError extends Error {}

interface Entry extends HookRegistration {
  key: string;
  seq: number;
}

export class HookBus {
  private byHook = new Map<string, Entry[]>();
  private sorted = new Map<string, Entry[]>();
  private seq = 0;

  register(reg: HookRegistration, module: string) {
    const key = `${module}.${reg.id ?? `${reg.hook}#${this.seq}`}`;
    const list = this.byHook.get(reg.hook) ?? [];
    if (list.some((e) => e.key === key)) throw new Error(`Duplicate hook handler ${key}`);
    list.push({ ...reg, module, key, seq: this.seq++ });
    this.byHook.set(reg.hook, list);
    this.sorted.delete(reg.hook);
  }

  handlers(hook: string): Entry[] {
    let s = this.sorted.get(hook);
    if (s) return s;
    const list = this.byHook.get(hook) ?? [];
    const keys = list.map((e) => e.key);
    const edges = new Map<string, Set<string>>();
    for (const e of list) {
      const deps = edges.get(e.key) ?? new Set();
      for (const a of e.after ?? []) for (const k of resolveRefs(a, keys)) deps.add(k);
      edges.set(e.key, deps);
      for (const b of e.before ?? []) {
        for (const k of resolveRefs(b, keys)) {
          const d = edges.get(k) ?? new Set();
          d.add(e.key);
          edges.set(k, d);
        }
      }
    }
    const order = toposort(keys, edges);
    s = order.map((k) => list.find((e) => e.key === k)!);
    this.sorted.set(hook, s);
    return s;
  }

  has(hook: string) {
    return (this.byHook.get(hook)?.length ?? 0) > 0;
  }

  /** Each handler transforms the value: v = fn(v, ...args). */
  async filter<T>(hook: string, value: T, ...args: unknown[]): Promise<T> {
    let v = value;
    for (const h of this.handlers(hook)) if (h.kind === 'filter') v = await h.fn(v, ...args);
    return v;
  }

  /** Side effects, in order. */
  async action(hook: string, ...args: unknown[]): Promise<void> {
    for (const h of this.handlers(hook)) if (h.kind === 'action') await h.fn(...args);
  }

  /** Middleware chain around a core implementation: fn(args, next, ...extra). */
  async around<A, R>(hook: string, args: A, core: (args: A) => Promise<R>, ...extra: unknown[]): Promise<R> {
    const chain = this.handlers(hook).filter((h) => h.kind === 'around');
    const run = async (i: number, a: A): Promise<R> => {
      if (i >= chain.length) return core(a);
      const h = chain[i]!;
      let called = false;
      const next = (na?: A) => {
        called = true;
        return run(i + 1, na ?? a);
      };
      const out = await h.fn(a, next, ...extra);
      if (!called && !h.terminal) throw new HookChainError(`Hook "${hook}" handler ${h.key} did not call next() and is not declared terminal`);
      return out;
    };
    return run(0, args);
  }

  /** Introspection for the admin UI / debugging. */
  describe(): Record<string, { key: string; kind: HookKind; module: string }[]> {
    const out: Record<string, { key: string; kind: HookKind; module: string }[]> = {};
    for (const hook of this.byHook.keys()) out[hook] = this.handlers(hook).map((h) => ({ key: h.key, kind: h.kind, module: h.module! }));
    return out;
  }
}

/** "seo" matches every handler of module seo; "seo.meta" matches exactly. */
function resolveRefs(ref: string, keys: string[]): string[] {
  if (keys.includes(ref)) return [ref];
  return keys.filter((k) => k.startsWith(ref + '.'));
}
