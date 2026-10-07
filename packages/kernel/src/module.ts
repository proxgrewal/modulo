import type { BlockDefinition, FieldMap, LayoutPreset, ModelDef, ModelExtension, PageNode, PatchOp } from '@modulo/core';
import type { HookRegistration } from './hooks.ts';
import type { SiteContext } from './context.ts';
import type { Db } from './db.ts';

/** Version of the kernel API that modules declare compatibility with. */
export const KERNEL_API_VERSION = '1.0.0';

export type TrustTier = 'core' | 'verified' | 'community' | 'local';

export interface PermissionDef {
  key: string;
  label: string;
}

/** Records a module ships (Odoo's XML data with external ids). */
export interface ShippedRecord {
  /** Stable key, unique within the module, e.g. "default_category". */
  key: string;
  model: string;
  values: Record<string, unknown>;
  /** Like Odoo noupdate="1": created once, never touched by upgrades. */
  noupdate?: boolean;
}

export interface TemplateDef {
  /** e.g. "core:layout" */
  id: string;
  label?: string;
  tree: PageNode;
}

export interface PatchDef {
  id: string;
  template: string;
  ops: PatchOp[];
}

export interface ModuleMigration {
  /** Runs once per database when the module's schema reaches this version. */
  schema?: (db: Db) => Promise<void>;
  /** Runs per site when that site upgrades past this version. */
  data?: (ctx: SiteContext) => Promise<void>;
}

/** A route handler receives the request plus a site-scoped context. */
export interface RouteRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  /** Exact request body text (for signature verification, e.g. payment webhooks). */
  rawBody?: string;
  ctx: SiteContext;
}

export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body (objects) or text/html (strings). */
  body?: unknown;
  /** Render this page tree inside the site layout. */
  page?: { tree: PageNode; title: string; scope?: Record<string, unknown>; head?: string };
}

export type RouteHandler = (req: RouteRequest) => Promise<RouteResponse> | RouteResponse;

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Hono-style path, e.g. "/products/:id". */
  path: string;
  /**
   * "api": mounted at /api/sites/:site/m/<module><path>, requires auth unless public.
   * "site": mounted on the published site (e.g. /blog/:slug, /cart).
   */
  surface: 'api' | 'site';
  /** Permission required (api surface). "public" allows anonymous. Default: "auth". */
  permission?: string;
  handler: RouteHandler;
}

export interface EventSubscription {
  event: string;
  id?: string;
  handler: (payload: any, ctx: SiteContext) => Promise<void> | void;
}

export interface JobDef {
  name: string;
  handler: (payload: any, ctx: SiteContext) => Promise<void> | void;
  /** Max attempts before the job is marked failed. */
  maxAttempts?: number;
}

export interface ModuleDefinition {
  name: string;
  version: string;
  label?: string;
  description?: string;
  /** semver range of KERNEL_API_VERSION this module supports. */
  kernel: string;
  depends?: Record<string, string>;
  /** Glue module: auto-installs when all listed modules are installed. */
  activatesWhen?: string[];
  /** Installed on every site (cannot be uninstalled). */
  required?: boolean;
  category?: string;

  models?: ModelDef[];
  extendModels?: ModelExtension[];
  blocks?: BlockDefinition<any, any>[];
  templates?: TemplateDef[];
  /** Ready-made layouts/sections for the insert palette. */
  presets?: LayoutPreset[];
  patches?: PatchDef[];
  hooks?: HookRegistration[];
  routes?: RouteDef[];
  permissions?: PermissionDef[];
  /** Default grants: role -> permission keys. */
  grants?: Record<string, string[]>;
  settings?: FieldMap;
  records?: ShippedRecord[];
  migrations?: Record<string, ModuleMigration>;
  events?: EventSubscription[];
  jobs?: JobDef[];
  /** Services other modules can call via ctx.service(name). */
  services?: (ctx: SiteContext) => Record<string, (...args: any[]) => any>;
  lifecycle?: {
    install?: (ctx: SiteContext) => Promise<void> | void;
    uninstall?: (ctx: SiteContext) => Promise<void> | void;
    upgrade?: (ctx: SiteContext, from: string) => Promise<void> | void;
  };
  /** Editor contributions declared as data (rendered by the generic editor shell). */
  editor?: {
    /** Admin sections listing model records, e.g. [{ model: "shop.product", label: "Products" }]. */
    collections?: { model: string; label: string; icon?: string; columns?: string[] }[];
    /** Extra sidebar panels backed by module API routes. */
    panels?: { id: string; label: string; kind: 'settings' | 'iframe'; src?: string }[];
  };
}

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  return def;
}
