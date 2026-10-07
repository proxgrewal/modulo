import { newQuickJSWASMModule, type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle, type QuickJSRuntime, type QuickJSWASMModule } from 'quickjs-emscripten';
import { ModuloError } from '@modulo/kernel';

/**
 * QuickJS (WASM) execution engine for untrusted app code.
 *
 * Every invocation gets a brand-new QuickJS runtime + context (≈0.3ms) inside
 * one shared WASM module, so no state leaks between invocations, sites or
 * apps. Limits per invocation: heap (setMemoryLimit), native stack
 * (setMaxStackSize), CPU time (interrupt handler; time spent waiting on host
 * I/O is not counted), wall-clock time, and number of host calls.
 *
 * Host functions are async: each host call returns a QuickJS promise that the
 * host settles when its native work finishes, after which pending jobs are
 * pumped. (We deliberately use the promise bridge on the sync WASM build rather
 * than the asyncify build: asyncify can only suspend from evalCodeAsync, so a
 * host call made after the first `await` — i.e. from executePendingJobs —
 * cannot suspend, and one asyncify module allows only a single suspended call
 * at a time, which would serialise every app invocation in the process.)
 */

export interface SandboxLimits {
  /** QuickJS heap limit (bytes). Default 32MB. */
  memoryBytes?: number;
  /** Native stack limit (bytes). Default 256KB (larger values can exhaust the host stack before QuickJS notices). */
  stackBytes?: number;
  /** CPU budget for guest code (ms), excluding time awaiting host calls. */
  cpuMs?: number;
  /** Wall-clock limit including host I/O (ms). */
  wallMs?: number;
  /** Max host API calls per invocation. Default 200. */
  maxHostCalls?: number;
  /** Max size of the JSON result / host call payloads (bytes). Default 2MB. */
  maxPayloadBytes?: number;
}

export type HostHandler = (op: string, args: unknown[]) => Promise<unknown> | unknown;

export interface RunRequest {
  /** Label used in errors, e.g. the app name. */
  app: string;
  code: string;
  /** Handler registry kind + key ("route", "GET /x"). */
  kind: string;
  key: string;
  args: unknown[];
  host: HostHandler;
  limits?: SandboxLimits;
}

export type SandboxFailure = 'timeout' | 'memory' | 'error' | 'limit' | 'load' | 'deadlock';

export class SandboxError extends ModuloError {
  constructor(
    message: string,
    readonly failure: SandboxFailure,
    readonly app: string,
    status = 500,
    code = 'app_error',
    readonly guestStack?: string,
  ) {
    super(message, status, code, { app, failure });
  }
}

const DEFAULTS: Required<SandboxLimits> = {
  memoryBytes: 32 * 1024 * 1024,
  stackBytes: 256 * 1024,
  cpuMs: 200,
  wallMs: 5_000,
  maxHostCalls: 200,
  maxPayloadBytes: 2 * 1024 * 1024,
};

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModule().catch((e) => {
    modulePromise = null;
    throw e;
  });
  return modulePromise;
}

/**
 * Guest-side bootstrap. Captures intrinsics before app code runs, exposes the
 * `host` and `app` globals, and hides the raw bridge. All capability checks
 * happen on the host side; nothing here is trusted.
 */
const BOOTSTRAP = `(() => {
  const raw = globalThis.__host;
  delete globalThis.__host;
  const P = JSON.parse, S = JSON.stringify, freeze = Object.freeze;
  const call = (op, args) => raw(op, S(args)).then((r) => P(r).v);
  const handlers = { hook: {}, route: {}, on: {}, block: {} };
  const reg = (kind, key, fn) => {
    if (typeof fn !== 'function') throw new TypeError('app.' + kind + '(' + key + '): handler must be a function');
    handlers[kind][key] = fn;
  };
  const repo = (model) => freeze({
    find: (q) => call('repo.find', [model, q === undefined ? {} : q]),
    findOne: (where) => call('repo.findOne', [model, where === undefined ? {} : where]),
    count: (where) => call('repo.count', [model, where === undefined ? {} : where]),
    get: (id) => call('repo.get', [model, id]),
    create: (values) => call('repo.create', [model, values]),
    update: (id, values) => call('repo.update', [model, id, values]),
    delete: (id) => call('repo.delete', [model, id]),
  });
  const fmt = (a) => { try { return typeof a === 'string' ? a : S(a); } catch (e) { return String(a); } };
  const log = (...a) => { call('log', a.map(fmt)); };
  globalThis.host = freeze({
    repo,
    fetch: (url, init) => call('fetch', [String(url), init === undefined ? {} : init]),
    emit: (event, payload) => call('emit', [String(event), payload === undefined ? {} : payload]),
    settings: () => call('settings', []),
    log,
  });
  globalThis.console = freeze({ log, info: log, warn: log, error: log, debug: log });
  globalThis.app = freeze({
    hook: (name, fn) => reg('hook', String(name), fn),
    route: (method, path, fn) => reg('route', String(method).toUpperCase() + ' ' + String(path), fn),
    on: (event, fn) => reg('on', String(event), fn),
    block: (type, fn) => reg('block', String(type), fn),
  });
  return function invoke(kind, key, argsJson) {
    const h = handlers[kind] && handlers[kind][key];
    if (typeof h !== 'function') throw new Error('App did not register a ' + kind + ' handler for "' + key + '"');
    const args = P(argsJson);
    return Promise.resolve().then(() => h.apply(undefined, args)).then((v) => S({ v }));
  };
})()`;

interface GuestErrorInfo {
  name: string;
  message: string;
  stack?: string;
}

/** Run one handler of an app inside a fresh QuickJS runtime. Resolves with the handler's JSON result. */
export async function runInSandbox(req: RunRequest): Promise<unknown> {
  const L: Required<SandboxLimits> = { ...DEFAULTS };
  for (const [k, v] of Object.entries(req.limits ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) (L as Record<string, number>)[k] = v;
  }
  const mod = await getModule();
  const rt: QuickJSRuntime = mod.newRuntime();
  let ctx: QuickJSContext | null = null;
  let alive = true;
  const deferreds = new Set<QuickJSDeferredPromise>();
  let pendingOps = 0;
  let hostCalls = 0;
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  // CPU accounting: only time spent inside the VM counts.
  const startWall = performance.now();
  let cpuUsed = 0;
  let enteredAt = -1;
  let interrupted: 'cpu' | 'wall' | null = null;
  const enter = () => (enteredAt = performance.now());
  const exit = () => {
    if (enteredAt >= 0) cpuUsed += performance.now() - enteredAt;
    enteredAt = -1;
  };
  const fail = (msg: string, failure: SandboxFailure, stack?: string, status = 500, code = 'app_error') =>
    new SandboxError(`App "${req.app}" ${req.kind} "${req.key}" ${msg}`, failure, req.app, status, code, stack);

  try {
    rt.setMemoryLimit(L.memoryBytes);
    rt.setMaxStackSize(L.stackBytes);
    rt.setInterruptHandler(() => {
      const now = performance.now();
      if (enteredAt >= 0 && cpuUsed + (now - enteredAt) > L.cpuMs) interrupted = 'cpu';
      else if (now - startWall > L.wallMs) interrupted = 'wall';
      return interrupted !== null;
    });
    const vm = rt.newContext();
    ctx = vm;

    const describe = (h: QuickJSHandle): GuestErrorInfo => {
      try {
        const d = vm.dump(h);
        if (d && typeof d === 'object') return { name: String(d.name ?? 'Error'), message: String(d.message ?? ''), stack: d.stack ? String(d.stack) : undefined };
        return { name: 'Error', message: String(d) };
      } catch {
        return { name: 'Error', message: 'unknown error (could not inspect)' };
      } finally {
        if (h.alive) h.dispose();
      }
    };
    const toFailure = (info: GuestErrorInfo, phase: string): SandboxError => {
      if (interrupted === 'cpu') return fail(`exceeded its CPU budget of ${L.cpuMs}ms`, 'timeout');
      if (interrupted === 'wall') return fail(`exceeded its time limit of ${L.wallMs}ms`, 'timeout');
      if (/out of memory/i.test(info.message)) return fail(`exceeded its memory limit of ${Math.round(L.memoryBytes / 1048576)}MB`, 'memory');
      if (/stack overflow/i.test(info.message)) return fail(`overflowed its stack`, 'memory');
      const cap = /Capability denied/.test(info.message);
      return fail(`${phase}: ${info.name}: ${info.message}`, phase === 'failed to load' ? 'load' : 'error', info.stack, cap ? 403 : 500, cap ? 'capability_denied' : 'app_error');
    };

    // Host bridge: __host(op, argsJson) -> Promise<string>
    const bridge = vm.newFunction('__host', (opH, argsH) => {
      const d = vm.newPromise();
      deferreds.add(d);
      const op = vm.typeof(opH) === 'string' ? vm.getString(opH) : '';
      const argsJson = vm.typeof(argsH) === 'string' ? vm.getString(argsH) : '[]';
      hostCalls++;
      pendingOps++;
      const settle = (ok: boolean, payload: string) => {
        if (!alive || !d.alive) return;
        enter();
        try {
          if (ok) vm.newString(payload).consume((s) => d.resolve(s));
          else vm.newError({ name: 'HostError', message: payload }).consume((e) => d.reject(e));
        } finally {
          exit();
          deferreds.delete(d);
        }
      };
      Promise.resolve()
        .then(() => {
          if (hostCalls > L.maxHostCalls) throw new Error(`Host call limit exceeded (${L.maxHostCalls} per invocation)`);
          if (argsJson.length > L.maxPayloadBytes) throw new Error('Host call payload too large');
          const args = JSON.parse(argsJson);
          return req.host(op, Array.isArray(args) ? args : []);
        })
        .then(
          (v) => {
            const s = JSON.stringify({ v: v === undefined ? null : v });
            if (s.length > L.maxPayloadBytes) throw new Error('Host call result too large');
            return s;
          },
        )
        .then(
          (s) => settle(true, s),
          (e) => settle(false, String(e?.message ?? e)),
        )
        .finally(() => {
          pendingOps--;
          signal();
        });
      return d.handle;
    });
    vm.setProp(vm.global, '__host', bridge);
    bridge.dispose();

    enter();
    const boot = vm.evalCode(BOOTSTRAP, 'modulo-bootstrap.js');
    exit();
    if (boot.error) throw toFailure(describe(boot.error), 'bootstrap failed');
    const invokeFn = boot.value;

    try {
      enter();
      const loaded = vm.evalCode(req.code, `${req.app}.js`, { type: 'global', strict: true });
      exit();
      if (loaded.error) throw toFailure(describe(loaded.error), 'failed to load');
      loaded.value.dispose();

      const argsJson = safeJson(req.args);
      if (argsJson.length > L.maxPayloadBytes) throw fail('input too large', 'limit');
      const kindH = vm.newString(req.kind);
      const keyH = vm.newString(req.key);
      const argsH = vm.newString(argsJson);
      enter();
      const called = vm.callFunction(invokeFn, vm.undefined, kindH, keyH, argsH);
      exit();
      kindH.dispose();
      keyH.dispose();
      argsH.dispose();
      if (called.error) throw toFailure(describe(called.error), 'failed');
      const promise = called.value;

      try {
        for (;;) {
          enter();
          const jobs = rt.executePendingJobs();
          exit();
          if (jobs.error) {
            // A job threw outside a promise chain (e.g. interrupted / OOM).
            throw toFailure(describe(jobs.error), 'failed');
          }
          if (interrupted) throw toFailure({ name: 'InternalError', message: 'interrupted' }, 'failed');
          const st = vm.getPromiseState(promise);
          if (st.type === 'fulfilled') {
            const raw = vm.typeof(st.value) === 'string' ? vm.getString(st.value) : 'null';
            if (st.value !== promise) st.value.dispose();
            if (raw.length > L.maxPayloadBytes) throw fail('returned a result that is too large', 'limit');
            return (JSON.parse(raw) as { v?: unknown }).v;
          }
          if (st.type === 'rejected') throw toFailure(describe(st.error), 'failed');
          if (pendingOps === 0) throw fail('never settled (awaited a promise that can never resolve)', 'deadlock');
          const remaining = L.wallMs - (performance.now() - startWall);
          if (remaining <= 0) {
            interrupted = 'wall';
            throw toFailure({ name: 'InternalError', message: 'interrupted' }, 'failed');
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, remaining);
          });
          clearTimeout(timer);
        }
      } finally {
        if (promise.alive) promise.dispose();
      }
    } finally {
      if (invokeFn.alive) invokeFn.dispose();
    }
  } catch (e) {
    if (e instanceof SandboxError) throw e;
    // Engine-level failure (WASM abort etc.): drop the module so the next call starts clean.
    modulePromise = null;
    throw new SandboxError(`App "${req.app}" ${req.kind} "${req.key}" crashed the sandbox: ${(e as Error)?.message ?? e}`, 'error', req.app);
  } finally {
    alive = false;
    for (const d of deferreds) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    try {
      ctx?.dispose();
    } catch {
      /* ignore leak assertions after OOM */
    }
    try {
      rt.dispose();
    } catch {
      /* ignore */
    }
  }
}

/** JSON-serialise host values for the guest: drops functions, breaks cycles, stringifies bigints. */
export function safeJson(value: unknown, skip?: (v: unknown) => boolean): string {
  const stack: unknown[] = [];
  return JSON.stringify(value, function (this: unknown, _k, v) {
    if (skip?.(v)) return undefined;
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (typeof v === 'bigint') return v.toString();
    if (v && typeof v === 'object') {
      // `this` is the parent; trim the stack back to it to detect true cycles only.
      while (stack.length && stack[stack.length - 1] !== this) stack.pop();
      if (stack.includes(v)) return '[Circular]';
      stack.push(v);
    }
    return v;
  }) ?? 'null';
}
