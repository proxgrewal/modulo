import { useRef, useSyncExternalStore } from 'react';

/** Tiny external store with selector subscriptions (no re-render unless the selected slice changes). */
export interface Store<T> {
  get(): T;
  set(partial: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(partial) {
      const p = typeof partial === 'function' ? partial(state) : partial;
      let changed = false;
      for (const k in p) if ((p as any)[k] !== (state as any)[k]) changed = true;
      if (!changed) return;
      state = { ...state, ...p };
      subs.forEach((s) => s());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as any)[k], (b as any)[k]));
}

export function useStore<T, S>(store: Store<T>, selector: (s: T) => S, eq: (a: S, b: S) => boolean = Object.is): S {
  const cache = useRef<{ state: T; selector: (s: T) => S; value: S } | null>(null);
  const getSnap = () => {
    const state = store.get();
    const c = cache.current;
    if (c && c.state === state && c.selector === selector) return c.value;
    const value = selector(state);
    if (c && eq(c.value, value)) {
      cache.current = { state, selector, value: c.value };
      return c.value;
    }
    cache.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, getSnap);
}
