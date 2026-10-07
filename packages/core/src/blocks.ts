import { h, type Attrs, type VNode } from './h.ts';
import { defaultsFor, fieldsToZod, type FieldMap } from './fields.ts';
import { instantiate, type NodeTemplate, type PageNode, type StyleProps } from './tree.ts';
import type { Theme } from './tokens.ts';
import { walk } from './tree.ts';

export type RenderMode = 'publish' | 'edit';

export interface RenderContext<D = unknown> {
  node: PageNode;
  mode: RenderMode;
  theme: Theme;
  /** Result of the block's load() (server-side data), if any. */
  data: D;
  /** Root attributes the block must spread onto its outermost element (classes, node id, island marker). */
  attrs: Attrs;
  /** Convenience: h(tag, {...ctx.attrs, ...extra}, ...children) with class merging. */
  root(tag: string, extra?: Attrs | null, ...children: VNode[]): VNode;
  /** Arbitrary scope values (site, current record, request path...). */
  scope: Record<string, unknown>;
}

export interface LoadContext {
  siteId: string;
  scope: Record<string, unknown>;
  /** Kernel-provided services (repositories, etc). Typed loosely so core stays isomorphic. */
  services: Record<string, any>;
}

export interface SlotSpec {
  name: string;
  label?: string;
  /** Allowed child block types (glob-ish "shop:*" supported). Empty = any. */
  allow?: string[];
}

export interface IslandSpec {
  /** Unique name, e.g. "shop:cart-button". */
  name: string;
  /**
   * Source of a function `(el, props) => void` run in the browser on hydration.
   * Keep it tiny: islands are the only JS a published page ships.
   */
  script: string;
}

export interface BlockDefinition<P extends Record<string, unknown> = Record<string, any>, D = any> {
  type: string;
  version: number;
  label: string;
  category?: string;
  icon?: string;
  description?: string;
  fields: FieldMap;
  slots?: SlotSpec[];
  /** Static CSS for the block, emitted once per page when the block is used. */
  css?: string;
  island?: IslandSpec;
  /** Props passed to the island (defaults to none). Must be JSON-serialisable. */
  islandProps?: (props: P, data: D) => Record<string, unknown>;
  load?: (props: P, ctx: LoadContext) => Promise<D>;
  render: (props: P, ctx: RenderContext<D>) => VNode;
  /** Upgrade props written at an older version, one step at a time. */
  migrate?: (props: Record<string, any>, fromVersion: number) => Record<string, any>;
  /** Hidden from the insert palette (e.g. page root, template-only blocks). */
  internal?: boolean;
  /** Children created with a fresh instance (e.g. Columns starts with two boxes). */
  defaultChildren?: Record<string, NodeTemplate[]>;
  /** Style applied to a fresh instance (fully editable afterwards). */
  defaultStyle?: StyleProps;
  /** Unpack a composite block into primitives so every inner part becomes editable. */
  toPrimitives?: (props: P) => NodeTemplate;
  /** Approx JS budget in bytes for the island; checked by the publish budget test. */
  jsBudget?: number;
}

export function defineBlock<P extends Record<string, unknown> = Record<string, any>, D = any>(def: BlockDefinition<P, D>): BlockDefinition<P, D> {
  return def;
}

export interface RegisteredBlock extends BlockDefinition {
  /** Module that contributed it. */
  module: string;
}

export class BlockRegistry {
  private blocks = new Map<string, RegisteredBlock>();

  register(def: BlockDefinition<any, any>, module: string) {
    const existing = this.blocks.get(def.type);
    if (existing && existing.module !== module) {
      throw new Error(`Block "${def.type}" from module "${module}" collides with module "${existing.module}"`);
    }
    if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(def.type)) throw new Error(`Invalid block type "${def.type}" (expected "module:name")`);
    this.blocks.set(def.type, { ...def, module } as RegisteredBlock);
  }

  get(type: string): RegisteredBlock | undefined {
    return this.blocks.get(type);
  }

  has(type: string) {
    return this.blocks.has(type);
  }

  list(): RegisteredBlock[] {
    return [...this.blocks.values()];
  }

  /** Create a fresh node for a block type with defaults applied. */
  create(type: string, id: string, origin = 'user'): PageNode {
    const def = this.get(type);
    if (!def) throw new Error(`Unknown block ${type}`);
    const node: PageNode = { id, type, v: def.version, props: defaultsFor(def.fields), origin };
    if (def.slots?.length) node.slots = Object.fromEntries(def.slots.map((s) => [s.name, (def.defaultChildren?.[s.name] ?? []).map((t) => instantiate(t, origin))]));
    if (def.defaultStyle) node.style = structuredClone(def.defaultStyle);
    return node;
  }

  validate(node: PageNode): { ok: true } | { ok: false; error: string } {
    const def = this.get(node.type);
    if (!def) return { ok: false, error: `Unknown block ${node.type}` };
    const res = fieldsToZod(def.fields).safeParse(node.props);
    if (!res.success) return { ok: false, error: `${node.type}#${node.id}: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
    return { ok: true };
  }

  /** Validate a whole tree and slot allow-lists. Returns list of problems. */
  validateTree(root: PageNode): string[] {
    const problems: string[] = [];
    const ids = new Set<string>();
    walk(root, (n, parent, slotName) => {
      if (ids.has(n.id)) problems.push(`Duplicate node id ${n.id}`);
      ids.add(n.id);
      if (n.type === 'core:page' && parent === null) return;
      const v = this.validate(n);
      if (!v.ok) problems.push(v.error);
      if (parent && slotName) {
        const pdef = this.get(parent.type);
        const spec = pdef?.slots?.find((s) => s.name === slotName);
        if (pdef && !spec && parent.type !== 'core:page') problems.push(`${parent.type} has no slot "${slotName}"`);
        if (spec?.allow?.length && !spec.allow.some((a) => matchType(a, n.type))) {
          problems.push(`${n.type} not allowed in ${parent.type}.${slotName}`);
        }
      }
    });
    return problems;
  }

  /** Run block migrate() functions so stored documents match current block versions. */
  migrateTree(root: PageNode): { tree: PageNode; changed: number } {
    const tree = structuredClone(root);
    let changed = 0;
    walk(tree, (n) => {
      const def = this.get(n.type);
      if (!def) return;
      let v = n.v ?? 1;
      while (v < def.version) {
        if (!def.migrate) throw new Error(`${n.type} is at v${v} but block has no migrate() to reach v${def.version}`);
        n.props = def.migrate(n.props, v);
        v++;
        changed++;
      }
      n.v = def.version;
    });
    return { tree, changed };
  }
}

export function matchType(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

export function makeRoot(attrs: Attrs) {
  return (tag: string, extra?: Attrs | null, ...children: VNode[]): VNode => {
    const merged: Attrs = { ...attrs, ...(extra ?? {}) };
    const cls = [attrs.class, extra?.class].filter(Boolean).join(' ');
    if (cls) merged.class = cls;
    return h(tag, merged, ...children);
  };
}
