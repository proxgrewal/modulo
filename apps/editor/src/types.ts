import type { Breakpoint, FieldMap, LayoutPreset, NodeTemplate, PageNode, PatchOp, SlotSpec, StyleProps, StyleState, Theme, TokenGroup } from '@modulo/core';

export type { PageNode, PatchOp, FieldMap, Theme, TokenGroup, NodeTemplate, LayoutPreset, StyleProps, StyleState, Breakpoint };

/** One entry of the style catalog (GET /runtime styleCatalog; css functions stripped). */
export interface StyleCatalogEntry {
  key: string;
  group: 'layout' | 'child' | 'spacing' | 'size' | 'position' | 'typography' | 'background' | 'border' | 'effects';
  label: string;
  control: 'length' | 'color' | 'select' | 'segmented' | 'number' | 'text' | 'image' | 'shadow' | 'font' | 'tracks';
  token?: TokenGroup;
  options?: { value: string; label: string }[];
  units?: string[];
  placeholder?: string;
  when?: 'flex' | 'grid' | 'flex-or-grid' | 'parent-flex' | 'parent-grid' | 'positioned';
}

/** A site style preset (like a design-tool class). */
export interface SitePreset {
  label?: string;
  style?: StyleProps;
  responsive?: Partial<Record<Breakpoint, StyleProps>>;
  states?: Partial<Record<StyleState, StyleProps>>;
}

/** A saved library component (model library.component). */
export interface LibraryComponent {
  id: string;
  name: string;
  category: string;
  description?: string | null;
  node: PageNode;
  updated_at?: string;
}

/** A block schema as served by GET /api/sites/:site/runtime (render/load stripped). */
export interface BlockSchema {
  type: string;
  version: number;
  label: string;
  category?: string;
  icon?: string;
  description?: string;
  fields: FieldMap;
  slots?: SlotSpec[];
  internal?: boolean;
  /** Module that contributed the block. */
  module: string;
  /** Children created with a fresh instance (e.g. Columns starts with two boxes). */
  defaultChildren?: Record<string, NodeTemplate[]>;
  /** Style applied to a fresh instance. */
  defaultStyle?: StyleProps;
  /** Can be unpacked into editable primitives (POST /blocks/unpack). */
  unpackable?: boolean;
}

export interface Site {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  theme: Record<string, Record<string, string>>;
  settings: Record<string, unknown>;
  plan?: string;
  role?: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  is_superadmin?: boolean;
}

export interface InstalledModule {
  name: string;
  version: string;
  auto: boolean;
  requested: boolean;
  label: string;
  description?: string;
  required: boolean;
  settings: Record<string, unknown> | null;
  updateAvailable: string | null;
}

export interface CatalogModule {
  name: string;
  versions: string[];
  label: string;
  description?: string;
  category?: string;
  depends: Record<string, string>;
  activatesWhen?: string[];
  required: boolean;
}

export interface ConflictInfo {
  template: string;
  target: string;
  kind: string;
  modules: string[];
  patches: string[];
  winner: string;
}

export interface EditorContribution {
  module: string;
  collections?: { model: string; label: string; icon?: string; columns?: string[] }[];
  panels?: { id: string; label: string; kind: 'settings' | 'iframe'; src?: string }[];
}

export interface TokenOption {
  value: string;
  label: string;
  preview: string;
}

export interface Runtime {
  site: Site;
  user: { id: string; email: string; name: string; role: string | null; permissions: string[]; isSuperadmin: boolean };
  theme: Theme;
  tokens: Record<TokenGroup, TokenOption[]>;
  blocks: BlockSchema[];
  templates: { id: string; label?: string }[];
  modules: InstalledModule[];
  permissions: { key: string; label: string; module?: string }[];
  editor: EditorContribution[];
  settingsSchemas: Record<string, FieldMap>;
  settings: Record<string, Record<string, unknown>>;
  conflicts: ConflictInfo[];
  /** Ready-made layouts/sections contributed by modules (namespaced ids). */
  presets?: LayoutPreset[];
  styleCatalog?: StyleCatalogEntry[];
  breakpoints?: Record<Breakpoint, number>;
  styleStates?: StyleState[];
  stylePresets?: Record<string, SitePreset>;
  customCss?: string;
}

export interface PageSummary {
  id: string;
  title: string;
  path: string;
  description?: string | null;
  status: 'draft' | 'published';
  layout?: string;
  published_at?: string | null;
  updated_at?: string;
  hasUnpublishedChanges: boolean;
}

export interface RenderResult {
  html: string;
  css: string;
  editCss: string;
  layoutNodeIds: string[];
  pageRootId: string | null;
}

export interface LayoutInfo {
  tree: PageNode | null;
  provenance: Record<string, string>;
  conflicts: ConflictInfo[];
  failures: { patch: string; module: string; op: string; target: string; reason: string }[];
  ops: PatchOp[];
}

export interface ModelFieldDef {
  kind: string;
  name: string;
  module: string;
  label?: string;
  help?: string;
  required?: boolean;
  default?: unknown;
  options?: string[];
  model?: string;
  max?: number;
  private?: boolean;
}

export interface ModelInfo {
  name: string;
  label?: string;
  module: string;
  titleField?: string;
  fields: Record<string, ModelFieldDef>;
  computed: Record<string, { kind: string }>;
  columns: string[];
}

export interface Revision {
  id: string;
  page: string;
  kind: 'autosave' | 'publish' | 'manual';
  note?: string;
  author?: string;
  created_at: string;
  tree?: PageNode;
}

export interface Member {
  id: string;
  email: string;
  name: string;
  role: string;
}

export type Device = 'desktop' | 'tablet' | 'mobile' | 'small';
