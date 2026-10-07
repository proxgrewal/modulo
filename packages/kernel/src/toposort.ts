/**
 * Stable topological sort. `edges` maps node -> nodes that must come BEFORE it.
 * Ties are broken by the original order, so results are deterministic.
 */
export function toposort<T extends string>(nodes: T[], edges: Map<T, Set<T>>): T[] {
  const order = new Map(nodes.map((n, i) => [n, i]));
  const remaining = new Map<T, number>();
  for (const n of nodes) remaining.set(n, [...(edges.get(n) ?? [])].filter((d) => order.has(d)).length);
  const out: T[] = [];
  const ready = nodes.filter((n) => remaining.get(n) === 0);
  const dependents = new Map<T, T[]>();
  for (const n of nodes) for (const d of edges.get(n) ?? []) if (order.has(d)) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(n);
  while (ready.length) {
    ready.sort((a, b) => order.get(a)! - order.get(b)!);
    const n = ready.shift()!;
    out.push(n);
    for (const m of dependents.get(n) ?? []) {
      const r = remaining.get(m)! - 1;
      remaining.set(m, r);
      if (r === 0) ready.push(m);
    }
  }
  if (out.length !== nodes.length) {
    const stuck = nodes.filter((n) => !out.includes(n));
    throw new CycleError(stuck);
  }
  return out;
}

export class CycleError extends Error {
  constructor(public nodes: string[]) {
    super(`Dependency cycle among: ${nodes.join(', ')}`);
  }
}
