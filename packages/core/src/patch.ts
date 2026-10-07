import { cloneTree, findNode, locate, walk, type Breakpoint, type PageNode, type StyleProps, type StyleState } from './tree.ts';

/**
 * The patch engine: Odoo-style view inheritance without XPath. Modules patch
 * templates by stable node id ("header") or slot ("header#actions"), never by
 * structure, so markup refactors don't break them. Destructive ops on the same
 * target from different modules are detected as conflicts up front.
 */
export type PatchOp =
  | { op: 'append' | 'prepend'; target: string; node: PageNode }
  | { op: 'insertBefore' | 'insertAfter'; target: string; node: PageNode }
  | { op: 'replace'; target: string; node: PageNode }
  | { op: 'remove'; target: string }
  | { op: 'setProp'; target: string; prop: string; value: unknown }
  | { op: 'setStyle'; target: string; style: StyleProps; bp?: Breakpoint; state?: StyleState }
  | { op: 'setField'; target: string; field: 'presets' | 'className' | 'name'; value: unknown }
  | { op: 'wrap'; target: string; node: PageNode; slot?: string };

export interface Patch {
  /** Stable key, e.g. "shop.header-cart". */
  id: string;
  module: string;
  /** Template the patch applies to, e.g. "core:layout". */
  template: string;
  ops: PatchOp[];
}

export interface Conflict {
  target: string;
  /** e.g. "replace" or "setProp:title" */
  kind: string;
  modules: string[];
  patches: string[];
  /** Module whose op is applied (last in dependency order unless resolved). */
  winner: string;
}

export interface PatchFailure {
  patch: string;
  module: string;
  op: PatchOp['op'];
  target: string;
  reason: string;
}

export interface PatchResult {
  tree: PageNode;
  applied: string[];
  failures: PatchFailure[];
  conflicts: Conflict[];
  /** node id -> module that contributed or last modified it. */
  provenance: Record<string, string>;
}

const DESTRUCTIVE = new Set(['replace', 'remove', 'wrap']);

function conflictKey(op: PatchOp): string | null {
  if (DESTRUCTIVE.has(op.op)) return `${op.target}|structure`;
  if (op.op === 'setProp') return `${op.target}|setProp:${op.prop}`;
  return null;
}

/** Static conflict detection (no tree needed). `resolutions` maps "target|kind" -> winning module. */
export function detectConflicts(patches: Patch[], resolutions: Record<string, string> = {}): Conflict[] {
  const groups = new Map<string, { module: string; patch: string }[]>();
  for (const p of patches) {
    for (const op of p.ops) {
      const k = conflictKey(op);
      if (!k) continue;
      const list = groups.get(k) ?? [];
      list.push({ module: p.module, patch: p.id });
      groups.set(k, list);
    }
  }
  const out: Conflict[] = [];
  for (const [key, list] of groups) {
    const modules = [...new Set(list.map((l) => l.module))];
    if (modules.length < 2) continue;
    const [target, kind] = key.split('|') as [string, string];
    out.push({
      target,
      kind,
      modules,
      patches: list.map((l) => l.patch),
      winner: resolutions[key] && modules.includes(resolutions[key]!) ? resolutions[key]! : modules[modules.length - 1]!,
    });
  }
  return out;
}

function prefixIds(node: PageNode, module: string): PageNode {
  const copy = cloneTree(node);
  walk(copy, (n) => {
    if (!n.id.startsWith(`${module}.`)) n.id = `${module}.${n.id}`;
    n.origin ??= module;
  });
  return copy;
}

/**
 * Apply patches (already sorted in module dependency order) to a template tree.
 * Losing sides of conflicts are skipped and reported, never silently applied.
 */
export function applyPatches(template: PageNode, patches: Patch[], resolutions: Record<string, string> = {}): PatchResult {
  let tree = cloneTree(template);
  const conflicts = detectConflicts(patches, resolutions);
  const losers = new Set<string>(); // "patchId|conflictKey"
  for (const c of conflicts) {
    const key = `${c.target}|${c.kind}`;
    for (const p of patches) {
      if (p.module !== c.winner && c.patches.includes(p.id)) losers.add(`${p.id}|${key}`);
    }
  }
  const provenance: Record<string, string> = {};
  walk(tree, (n) => {
    provenance[n.id] = n.origin ?? 'template';
  });
  const failures: PatchFailure[] = [];
  const applied: string[] = [];

  for (const p of patches) {
    let okAll = true;
    for (const op of p.ops) {
      const ck = conflictKey(op);
      if (ck && losers.has(`${p.id}|${ck}`)) {
        failures.push({ patch: p.id, module: p.module, op: op.op, target: op.target, reason: 'lost conflict' });
        okAll = false;
        continue;
      }
      const res = applyOp(tree, op, p.module, provenance);
      if (typeof res === 'string') {
        failures.push({ patch: p.id, module: p.module, op: op.op, target: op.target, reason: res });
        okAll = false;
      } else tree = res;
    }
    if (okAll) applied.push(p.id);
  }
  return { tree, applied, failures, conflicts, provenance };
}

function track(node: PageNode, provenance: Record<string, string>) {
  walk(node, (n) => {
    provenance[n.id] = n.origin ?? 'unknown';
  });
}

function applyOp(tree: PageNode, op: PatchOp, module: string, provenance: Record<string, string>): PageNode | string {
  const [targetId, slotName] = op.target.split('#') as [string, string | undefined];
  const target = findNode(tree, targetId);
  if (!target) return `target "${targetId}" not found`;

  switch (op.op) {
    case 'append':
    case 'prepend': {
      const name = slotName ?? 'default';
      target.slots ??= {};
      const list = (target.slots[name] ??= []);
      const node = prefixIds(op.node, module);
      if (findNode(tree, node.id)) return `node id "${node.id}" already exists`;
      if (op.op === 'append') list.push(node);
      else list.unshift(node);
      track(node, provenance);
      return tree;
    }
    case 'insertBefore':
    case 'insertAfter': {
      const loc = locate(tree, targetId);
      if (!loc) return 'cannot insert next to root';
      const node = prefixIds(op.node, module);
      if (findNode(tree, node.id)) return `node id "${node.id}" already exists`;
      loc.parent.slots![loc.slot]!.splice(op.op === 'insertBefore' ? loc.index : loc.index + 1, 0, node);
      track(node, provenance);
      return tree;
    }
    case 'replace': {
      const loc = locate(tree, targetId);
      if (!loc) return 'cannot replace root';
      const node = prefixIds(op.node, module);
      loc.parent.slots![loc.slot]![loc.index] = node;
      track(node, provenance);
      return tree;
    }
    case 'remove': {
      const loc = locate(tree, targetId);
      if (!loc) return 'cannot remove root';
      loc.parent.slots![loc.slot]!.splice(loc.index, 1);
      return tree;
    }
    case 'setProp': {
      target.props = { ...target.props, [op.prop]: op.value };
      // An explicit value overrides a data binding on the same prop (e.g. footer text bound to site data).
      if (target.bind?.[op.prop]) {
        const { [op.prop]: _drop, ...rest } = target.bind;
        target.bind = Object.keys(rest).length ? rest : undefined;
      }
      provenance[target.id] = module;
      return tree;
    }
    case 'setStyle': {
      const merge = (cur: StyleProps | undefined) => {
        const next: StyleProps = { ...(cur ?? {}) };
        for (const [k, v] of Object.entries(op.style)) v === '' || v === undefined || v === null ? delete next[k] : (next[k] = v);
        return next;
      };
      if (op.state) target.states = { ...(target.states ?? {}), [op.state]: merge(target.states?.[op.state]) };
      else if (op.bp) target.responsive = { ...(target.responsive ?? {}), [op.bp]: merge(target.responsive?.[op.bp]) };
      else target.style = merge(target.style);
      return tree;
    }
    case 'setField': {
      if (op.field === 'presets') target.presets = Array.isArray(op.value) ? op.value.map(String) : undefined;
      else if (op.field === 'className') target.className = op.value ? String(op.value) : undefined;
      else target.name = op.value ? String(op.value) : undefined;
      return tree;
    }
    case 'wrap': {
      const loc = locate(tree, targetId);
      if (!loc) return 'cannot wrap root';
      const wrapper = prefixIds(op.node, module);
      const s = op.slot ?? 'default';
      wrapper.slots ??= {};
      wrapper.slots[s] = [...(wrapper.slots[s] ?? []), target];
      loc.parent.slots![loc.slot]![loc.index] = wrapper;
      provenance[wrapper.id] = module;
      return tree;
    }
  }
}
