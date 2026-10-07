import { applyPatches, BlockRegistry, defaultsFor, type LayoutPreset, type Patch, type PatchResult, type PageNode } from '@modulo/core';
import { HookBus } from './hooks.ts';
import type { EventSubscription, JobDef, ModuleDefinition, PermissionDef, RouteDef } from './module.ts';
import type { SiteContext } from './context.ts';

/**
 * The composed, per-site view of the installed modules: hooks, blocks,
 * templates (with patches applied), routes, permissions, services. Built from
 * the site's lockfile and cached until the next install/uninstall/upgrade.
 */
export interface RouteEntry extends RouteDef {
  module: string;
}

export class SiteRuntime {
  readonly hooks = new HookBus();
  readonly blocks = new BlockRegistry();
  readonly routes: RouteEntry[] = [];
  readonly permissions: (PermissionDef & { module: string })[] = [];
  readonly grants = new Map<string, Set<string>>();
  readonly events: (EventSubscription & { module: string })[] = [];
  readonly jobs = new Map<string, JobDef & { module: string }>();
  readonly services = new Map<string, (ctx: SiteContext) => Record<string, (...args: any[]) => any>>();
  readonly settings = new Map<string, Record<string, unknown>>();
  readonly presets: (LayoutPreset & { module: string })[] = [];
  readonly installed: Set<string>;
  private templatesRaw = new Map<string, { tree: PageNode; module: string; label?: string }>();
  private patchList: Patch[] = [];
  private templateCache = new Map<string, PatchResult>();

  constructor(
    readonly defs: ModuleDefinition[],
    moduleSettings: Record<string, Record<string, unknown>>,
    readonly resolutions: Record<string, string>,
  ) {
    this.installed = new Set(defs.map((d) => d.name));
    for (const def of defs) {
      for (const h of def.hooks ?? []) this.hooks.register(h, def.name);
      for (const b of def.blocks ?? []) this.blocks.register(b, def.name);
      for (const p of def.presets ?? []) this.presets.push({ ...p, id: `${def.name}.${p.id}`, module: def.name });
      for (const r of def.routes ?? []) this.routes.push({ ...r, module: def.name });
      for (const p of def.permissions ?? []) this.permissions.push({ ...p, module: def.name });
      for (const [role, perms] of Object.entries(def.grants ?? {})) {
        const set = this.grants.get(role) ?? new Set();
        perms.forEach((p) => set.add(p));
        this.grants.set(role, set);
      }
      for (const e of def.events ?? []) this.events.push({ ...e, module: def.name });
      for (const j of def.jobs ?? []) this.jobs.set(`${def.name}:${j.name}`, { ...j, module: def.name });
      if (def.services) this.services.set(def.name, def.services);
      for (const t of def.templates ?? []) {
        if (this.templatesRaw.has(t.id)) throw new Error(`Template ${t.id} defined by both ${this.templatesRaw.get(t.id)!.module} and ${def.name}`);
        this.templatesRaw.set(t.id, { tree: t.tree, module: def.name, label: t.label });
      }
      for (const p of def.patches ?? []) this.patchList.push({ ...p, id: `${def.name}.${p.id}`, module: def.name });
      this.settings.set(def.name, { ...defaultsFor(def.settings ?? {}), ...(moduleSettings[def.name] ?? {}) });
    }
  }

  templateIds() {
    return [...this.templatesRaw.entries()].map(([id, t]) => ({ id, module: t.module, label: t.label }));
  }

  patches(template?: string): Patch[] {
    return template ? this.patchList.filter((p) => p.template === template) : this.patchList;
  }

  /** Template with every installed module's patches applied (dependency order). */
  template(id: string): PatchResult | null {
    const cached = this.templateCache.get(id);
    if (cached) return cached;
    const raw = this.templatesRaw.get(id);
    if (!raw) return null;
    const res = applyPatches(raw.tree, this.patches(id), this.resolutions);
    this.templateCache.set(id, res);
    return res;
  }

  /** All patch conflicts across templates (for the admin UI / install report). */
  conflicts() {
    return [...this.templatesRaw.keys()].flatMap((id) => (this.template(id)?.conflicts ?? []).map((c) => ({ template: id, ...c })));
  }

  permissionsForRole(role: string, custom?: string[]): Set<string> {
    if (role === 'owner' || role === 'admin') return new Set(['*']);
    const s = new Set<string>(this.grants.get(role) ?? []);
    custom?.forEach((p) => s.add(p));
    return s;
  }
}
