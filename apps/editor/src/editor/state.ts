import { CollabProvider, nodesMap, readTree, Y, yInsert, yMove, yRemove, yReplaceStyle, ySetField, ySetProps, ySetStyle } from '@modulo/collab';
import type { Breakpoint, PageNode, PatchOp, StyleProps, StyleState } from '@modulo/core';
import { del, get, pagesPath, patch, post, put, sitePath, errorMessage } from '../api.ts';
import { keyToCommand, planCommand, type Command, type DocOp } from '../lib/commands.ts';
import type { DropTarget } from '../lib/drop.ts';
import { applyLayoutOpLocally, mergeLayoutOps } from '../lib/layout-ops.ts';
import { createStore } from '../lib/store.ts';
import { findNode, locateNode, schemaMap, shareTree, type SchemaMap } from '../lib/tree.ts';
import type { Device, LayoutInfo, LibraryComponent, ModelInfo, PageSummary, Runtime, SitePreset } from '../types.ts';
import { toast } from '../ui/toast.ts';

export interface Selection {
  id: string;
  /** "layout" nodes belong to the site layout (header/footer), edited via patch ops. */
  mode: 'page' | 'layout';
}

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  selection: string | null;
}

export interface DragInfo {
  kind: 'new' | 'move';
  type: string;
  id?: string;
  label: string;
  /** For layout presets / library items: builds the node to insert (fresh ids). */
  make?: () => PageNode;
}

export interface LayerDrop {
  targetId: string;
  position: 'before' | 'after' | 'inside';
  valid: boolean;
}

export type SaveState = 'saved' | 'saving' | 'offline' | 'connecting';

export interface EditorState {
  site: string;
  runtime: Runtime | null;
  schemas: SchemaMap;
  pages: PageSummary[];
  pageId: string | null;
  tree: PageNode | null;
  synced: boolean;
  selection: Selection | null;
  hoverId: string | null;
  device: Device;
  leftTab: string;
  inspectorTab: 'content' | 'style';
  saveState: SaveState;
  peers: Peer[];
  canUndo: boolean;
  canRedo: boolean;
  layout: LayoutInfo | null;
  layoutNodeIds: Set<string>;
  renderNonce: number;
  drop: DropTarget | null;
  layerDrop: LayerDrop | null;
  dragging: DragInfo | null;
  models: ModelInfo[] | null;
  canEdit: boolean;
  /** Style panel: interaction state being edited (null = normal). */
  styleState: StyleState | null;
  /** Style panel: a site preset being edited instead of the selection. */
  editingPreset: string | null;
  /** Component library (null = not loaded). */
  library: LibraryComponent[] | null;
  /** Detached copies -> the component they came from (enables "update component from this copy"). */
  detached: Record<string, string>;
}

export const editor = createStore<EditorState>({
  site: '',
  runtime: null,
  schemas: new Map(),
  pages: [],
  pageId: null,
  tree: null,
  synced: false,
  selection: null,
  hoverId: null,
  device: 'desktop',
  leftTab: 'insert',
  inspectorTab: 'content',
  saveState: 'connecting',
  peers: [],
  canUndo: false,
  canRedo: false,
  layout: null,
  layoutNodeIds: new Set(),
  renderNonce: 0,
  drop: null,
  layerDrop: null,
  dragging: null,
  models: null,
  canEdit: true,
  styleState: null,
  editingPreset: null,
  library: null,
  detached: {},
});

export const DEVICE_WIDTH: Record<Device, number | null> = { desktop: null, tablet: 1024, mobile: 640, small: 420 };
export const DEVICE_BP: Record<Device, Breakpoint | undefined> = { desktop: undefined, tablet: 'md', mobile: 'sm', small: 'xs' };
export const BP_DEVICE: Record<Breakpoint, Device> = { md: 'tablet', sm: 'mobile', xs: 'small' };

const PALETTE = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f'];
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length]!;
}
export function initials(name: string): string {
  const parts = name.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

/* ───────────────────────── collaborative document session ───────────────────────── */

class DocSession {
  readonly doc = new Y.Doc();
  readonly provider: CollabProvider;
  readonly undo: Y.UndoManager;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshQueued = false;
  private connected = false;
  private destroyed = false;

  constructor(
    readonly site: string,
    readonly pageId: string,
    user: { name: string; color: string },
  ) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/api/sites/${encodeURIComponent(site)}/collab/${pageId}`;
    this.undo = new Y.UndoManager(nodesMap(this.doc), { captureTimeout: 600 });
    this.provider = new CollabProvider(url, this.doc, {
      onStatus: (s) => {
        if (this.destroyed) return;
        this.connected = s === 'connected';
        if (s === 'disconnected') editor.set({ saveState: 'offline' });
        else if (s === 'connecting' && editor.get().saveState !== 'offline') editor.set({ saveState: 'connecting' });
        else if (s === 'connected' && !this.saveTimer) editor.set({ saveState: 'saved' });
      },
      onSynced: () => {
        if (this.destroyed) return;
        editor.set({ synced: true });
        this.refresh();
      },
    });
    this.doc.on('update', (_u: Uint8Array, origin: unknown) => {
      this.queueRefresh();
      if (origin !== this.provider) this.markDirty();
    });
    const stackChange = () => editor.set({ canUndo: this.undo.undoStack.length > 0, canRedo: this.undo.redoStack.length > 0 });
    this.undo.on('stack-item-added', (e: any) => {
      e.stackItem.meta.set('selection', editor.get().selection);
      stackChange();
    });
    this.undo.on('stack-item-popped', (e: any) => {
      const sel = e.stackItem.meta.get('selection') as Selection | null | undefined;
      queueMicrotask(() => {
        if (sel && findNode(editor.get().tree, sel.id)) editor.set({ selection: sel });
      });
      stackChange();
    });
    this.provider.awareness.setLocalState({ user, selection: null });
    this.provider.awareness.on('change', () => this.updatePeers());
  }

  private markDirty() {
    if (!this.connected) {
      editor.set({ saveState: 'offline' });
      return;
    }
    editor.set({ saveState: 'saving' });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // The server persists ~800ms after edits settle.
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (!this.destroyed) editor.set({ saveState: this.connected ? 'saved' : 'offline' });
    }, 1400);
  }

  private queueRefresh() {
    if (this.refreshQueued) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }

  refresh() {
    if (this.destroyed) return;
    const s = editor.get();
    const tree = shareTree(s.tree, readTree(this.doc));
    const sel = s.selection;
    const keepSel = !sel || sel.mode === 'layout' || !!findNode(tree, sel.id);
    editor.set({ tree, selection: keepSel ? sel : null });
  }

  private updatePeers() {
    const peers: Peer[] = [];
    this.provider.awareness.getStates().forEach((st: any, clientId: number) => {
      if (clientId === this.doc.clientID || !st?.user) return;
      peers.push({ clientId, name: String(st.user.name ?? 'Someone'), color: String(st.user.color ?? '#888'), selection: st.selection ?? null });
    });
    editor.set({ peers });
  }

  setSelection(id: string | null) {
    this.provider.awareness.setLocalStateField('selection', id);
  }

  apply(ops: DocOp[]) {
    if (!ops.length) return;
    this.doc.transact(() => {
      for (const op of ops) {
        if (op.op === 'insert') yInsert(this.doc, op.node, op.parentId, op.slot, op.index);
        else if (op.op === 'move') yMove(this.doc, op.id, op.parentId, op.slot, op.index);
        else yRemove(this.doc, op.id);
      }
    });
  }

  /** Commit pending text-typing into its own undo step. */
  stopCapturing() {
    this.undo.stopCapturing();
  }

  destroy() {
    this.destroyed = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.provider.destroy();
    this.undo.destroy();
    this.doc.destroy();
  }
}

let session: DocSession | null = null;
export const currentSession = () => session;

/* ───────────────────────── clipboard ───────────────────────── */

const CLIP_KEY = 'modulo:clipboard';
let clipboard: PageNode | null = null;
function readClipboard(): PageNode | null {
  if (clipboard) return clipboard;
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    return raw ? (JSON.parse(raw) as PageNode) : null;
  } catch {
    return null;
  }
}
function writeClipboard(n: PageNode) {
  clipboard = n;
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify(n));
  } catch {
    /* storage full or blocked */
  }
}

/* ───────────────────────── detached component copies ───────────────────────── */

const DETACH_KEY = (site: string) => `modulo:detached:${site}`;
function readDetached(site: string): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DETACH_KEY(site)) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
export function rememberDetached(nodeId: string, componentId: string | null) {
  const s = editor.get();
  const next = { ...s.detached };
  if (componentId) next[nodeId] = componentId;
  else delete next[nodeId];
  editor.set({ detached: next });
  try {
    localStorage.setItem(DETACH_KEY(s.site), JSON.stringify(next));
  } catch {
    /* storage blocked */
  }
}

/* ───────────────────────── actions ───────────────────────── */

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export const actions = {
  async openSite(slug: string) {
    const s = editor.get();
    if (s.site === slug && s.runtime) return;
    actions.closePage();
    editor.set({ site: slug, runtime: null, pages: [], layout: null, models: null, selection: null, library: null, editingPreset: null, detached: readDetached(slug) });
    const [runtime, pages, layout] = await Promise.all([
      get<Runtime>(sitePath(slug, '/runtime')),
      get<PageSummary[]>(pagesPath(slug, '/pages')).catch(() => [] as PageSummary[]),
      get<LayoutInfo>(sitePath(slug, '/layout')).catch(() => null),
    ]);
    const perms = runtime.user.permissions;
    // Component names for layers / overlay labels (background; the Library panel reloads on demand).
    if (runtime.modules.some((m) => m.name === 'library')) queueMicrotask(() => void actions.loadLibrary().catch(() => {}));
    editor.set({
      runtime,
      schemas: schemaMap(runtime.blocks),
      pages,
      layout,
      canEdit: runtime.user.isSuperadmin || perms.includes('*') || perms.includes('pages.edit'),
    });
  },

  async reloadRuntime() {
    const slug = editor.get().site;
    const runtime = await get<Runtime>(sitePath(slug, '/runtime'));
    editor.set((s) => ({ runtime, schemas: schemaMap(runtime.blocks), renderNonce: s.renderNonce + 1 }));
  },

  async reloadPages() {
    const pages = await get<PageSummary[]>(pagesPath(editor.get().site, '/pages'));
    editor.set({ pages });
    return pages;
  },

  async reloadLayout() {
    const layout = await get<LayoutInfo>(sitePath(editor.get().site, '/layout'));
    editor.set((s) => ({ layout, renderNonce: s.renderNonce + 1 }));
  },

  async loadModels() {
    if (editor.get().models) return editor.get().models!;
    const models = await get<ModelInfo[]>(sitePath(editor.get().site, '/models'));
    editor.set({ models });
    return models;
  },

  openPage(pageId: string) {
    const s = editor.get();
    if (session && session.pageId === pageId && session.site === s.site) return;
    actions.closePage();
    const name = s.runtime?.user.name || s.runtime?.user.email || 'Me';
    session = new DocSession(s.site, pageId, { name, color: colorFor(s.runtime?.user.id ?? name) });
    editor.set({ pageId, tree: null, synced: false, selection: null, hoverId: null, peers: [], canUndo: false, canRedo: false, saveState: 'connecting' });
  },

  closePage() {
    session?.destroy();
    session = null;
    editor.set({ pageId: null, tree: null, synced: false, selection: null, peers: [] });
  },

  select(sel: Selection | null) {
    const cur = editor.get().selection;
    if (cur?.id === sel?.id && cur?.mode === sel?.mode) return;
    session?.stopCapturing();
    // Picking an element ends preset editing so the inspector follows the selection.
    editor.set({ selection: sel, editingPreset: sel ? null : editor.get().editingPreset });
    session?.setSelection(sel?.mode === 'page' ? sel.id : null);
  },

  selectPage(id: string | null) {
    actions.select(id ? { id, mode: 'page' } : null);
  },

  hover(id: string | null) {
    if (editor.get().hoverId !== id) editor.set({ hoverId: id });
  },

  apply(ops: DocOp[], select?: string | null) {
    if (!session || !editor.get().canEdit) return;
    try {
      session.apply(ops);
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    session.refresh();
    if (select !== undefined) actions.selectPage(select);
  },

  setProps(id: string, props: Record<string, unknown>) {
    if (!session || !editor.get().canEdit) return;
    ySetProps(session.doc, id, props);
  },

  setStyle(id: string, style: Partial<StyleProps>, bp?: Breakpoint, state?: StyleState) {
    if (!session || !editor.get().canEdit) return;
    try {
      ySetStyle(session.doc, id, style, state ? undefined : bp, state);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  },

  /** Replace all style layers of a node (paste style / clear after creating a preset). */
  replaceStyle(id: string, next: { style?: StyleProps; responsive?: PageNode['responsive']; states?: PageNode['states'] }) {
    if (!session || !editor.get().canEdit) return;
    yReplaceStyle(session.doc, id, next);
  },

  setField(id: string, field: 'presets' | 'className' | 'name', value: unknown) {
    if (!session || !editor.get().canEdit) return;
    ySetField(session.doc, id, field, value);
  },

  /** Several node edits as one undoable step. */
  transact(fn: () => void) {
    if (!session || !editor.get().canEdit) return;
    session.stopCapturing();
    session.doc.transact(fn);
    session.stopCapturing();
  },

  /** Replace a page node with another in one undoable step (unpack / detach / re-link). */
  replaceNode(id: string, next: PageNode) {
    const s = editor.get();
    const loc = locateNode(s.tree, id);
    if (!loc || !session) return false;
    session.stopCapturing();
    actions.apply(
      [
        { op: 'remove', id },
        { op: 'insert', node: next, parentId: loc.parent.id, slot: loc.slot, index: loc.index },
      ],
      next.id,
    );
    session.stopCapturing();
    return true;
  },

  /** Unpack a composite block into editable primitives (POST /blocks/unpack). */
  async unpack(id: string) {
    const s = editor.get();
    const node = findNode(s.tree, id);
    if (!node) return;
    try {
      const res = await post<{ node: PageNode }>(sitePath(s.site, '/blocks/unpack'), { node });
      const out = res.node;
      // Composites with their own children (section/card) keep them inside the new box.
      const kids = Object.values(node.slots ?? {}).flat();
      if (kids.length && out.slots?.default) out.slots.default = [...out.slots.default, ...kids];
      if (actions.replaceNode(id, out)) toast.success(`${s.schemas.get(node.type)?.label ?? 'Block'} unpacked: every part is now editable`);
    } catch (e) {
      toast.error(`Couldn’t unpack: ${errorMessage(e)}`);
    }
  },

  /* ───────── site style presets & custom CSS ───────── */
  stylesTimer: null as ReturnType<typeof setTimeout> | null,
  /** Update presets locally right away; persist (debounced unless immediate). */
  async saveStylePresets(presets: Record<string, SitePreset>, immediate = false): Promise<void> {
    const s = editor.get();
    if (!s.runtime) return;
    editor.set({ runtime: { ...s.runtime, stylePresets: presets } });
    if (actions.stylesTimer) clearTimeout(actions.stylesTimer);
    actions.stylesTimer = null;
    const save = async () => {
      actions.stylesTimer = null;
      const res = await put<{ stylePresets: Record<string, SitePreset>; customCss: string }>(sitePath(editor.get().site, '/styles'), { presets: editor.get().runtime?.stylePresets ?? presets });
      editor.set((st) => ({ runtime: st.runtime ? { ...st.runtime, stylePresets: res.stylePresets } : st.runtime, renderNonce: st.renderNonce + 1 }));
    };
    if (immediate) return save();
    return new Promise((resolve, reject) => {
      actions.stylesTimer = setTimeout(() => {
        save().then(resolve, (e) => {
          toast.error(`Preset not saved: ${errorMessage(e)}`);
          reject(e);
        });
      }, 400);
    });
  },

  async saveCustomCss(css: string) {
    const res = await put<{ stylePresets: Record<string, SitePreset>; customCss: string }>(sitePath(editor.get().site, '/styles'), { customCss: css });
    editor.set((st) => ({ runtime: st.runtime ? { ...st.runtime, customCss: res.customCss } : st.runtime, renderNonce: st.renderNonce + 1 }));
  },

  /* ───────── component library ───────── */
  async loadLibrary(force = false) {
    const s = editor.get();
    if (s.library && !force) return s.library;
    const list = await get<LibraryComponent[]>(sitePath(s.site, '/m/library/components'));
    editor.set({ library: list });
    return list;
  },

  async createComponent(input: { name: string; category: string; description?: string; node: PageNode }) {
    const rec = await post<LibraryComponent>(sitePath(editor.get().site, '/m/library/components'), input);
    await actions.loadLibrary(true);
    return rec;
  },

  async updateComponent(id: string, body: Partial<Pick<LibraryComponent, 'name' | 'category' | 'description' | 'node'>>) {
    const rec = await put<LibraryComponent>(sitePath(editor.get().site, `/m/library/components/${id}`), body);
    await actions.loadLibrary(true);
    if (body.node) actions.bumpRender();
    return rec;
  },

  async deleteComponent(id: string) {
    await del(sitePath(editor.get().site, `/m/library/components/${id}`));
    await actions.loadLibrary(true);
    actions.bumpRender();
  },


  undo() {
    session?.undo.undo();
  },
  redo() {
    session?.undo.redo();
  },

  setDevice(device: Device) {
    editor.set({ device });
  },

  bumpRender() {
    editor.set((s) => ({ renderNonce: s.renderNonce + 1 }));
  },

  /** Run a keyboard/toolbar command against the page document. */
  run(cmd: Command): boolean {
    const s = editor.get();
    if (cmd === 'undo') return actions.undo(), true;
    if (cmd === 'redo') return actions.redo(), true;
    if (cmd === 'focusSearch') {
      editor.set({ leftTab: 'insert' });
      setTimeout(() => (document.getElementById('insert-search') as HTMLInputElement | null)?.focus(), 30);
      return true;
    }
    if (s.selection?.mode === 'layout') {
      if (cmd === 'selectParent' || cmd === 'deselect') {
        actions.select(null);
        return true;
      }
      return false;
    }
    const res = planCommand(cmd, { tree: s.tree, selection: s.selection?.id ?? null, clipboard: readClipboard(), schemas: s.schemas });
    if (res.clipboard) writeClipboard(res.clipboard);
    if (res.ops.length) actions.apply(res.ops, res.select);
    else if (res.select !== undefined) actions.selectPage(res.select);
    if (res.announce && cmd !== 'delete') toast.info(res.announce);
    return res.ops.length > 0 || res.select !== undefined || !!res.clipboard;
  },

  /** Global keyboard handling (parent document and canvas iframe). */
  handleKey(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const cmd = keyToCommand(e, isMac);
    if (!cmd) return false;
    if (typing) return false;
    if (document.querySelector('[role="dialog"][aria-modal="true"]')) return false;
    // Arrow keys / delete only act on the canvas selection when focus isn't in a list/tree widget.
    if ((cmd === 'selectPrev' || cmd === 'selectNext') && t?.closest?.('[role="tree"],[role="listbox"],[role="tablist"]')) return false;
    if (cmd === 'selectParent' && !editor.get().selection) return false;
    const handled = actions.run(cmd);
    if (handled) e.preventDefault();
    return handled;
  },

  /* ───────── layout (site patches) ───────── */
  layoutSaveTimer: null as ReturnType<typeof setTimeout> | null,
  async layoutEdit(ops: PatchOp[], immediate = false) {
    const s = editor.get();
    if (!s.layout) return;
    const merged = mergeLayoutOps(s.layout.ops ?? [], ops);
    // Optimistic local update of the composed tree so the inspector feels instant.
    const tree = s.layout.tree ? structuredClone(s.layout.tree) : null;
    if (tree) for (const op of ops) applyLayoutOpLocally(tree, op);
    editor.set({ layout: { ...s.layout, ops: merged, tree } });
    if (actions.layoutSaveTimer) clearTimeout(actions.layoutSaveTimer);
    const save = async () => {
      try {
        const res = await put<Omit<LayoutInfo, 'ops'>>(sitePath(editor.get().site, '/layout'), { ops: editor.get().layout!.ops });
        editor.set((st) => ({ layout: { ...res, ops: st.layout!.ops }, renderNonce: st.renderNonce + 1 }));
        if (res.failures?.some((f) => f.module === 'site')) toast.error('Some layout changes could not be applied (see Layout panel).');
      } catch (e) {
        toast.error(`Layout not saved: ${errorMessage(e)}`);
      }
    };
    if (immediate) await save();
    else actions.layoutSaveTimer = setTimeout(save, 350);
  },

  async setLayoutOps(ops: PatchOp[]) {
    const s = editor.get();
    if (!s.layout) return;
    editor.set({ layout: { ...s.layout, ops } });
    const res = await put<Omit<LayoutInfo, 'ops'>>(sitePath(s.site, '/layout'), { ops });
    editor.set((st) => ({ layout: { ...res, ops }, renderNonce: st.renderNonce + 1 }));
  },

  /* ───────── theme ───────── */
  async saveTheme(theme: Record<string, Record<string, string>>) {
    const s = editor.get();
    await patch(sitePath(s.site), { theme });
    await actions.reloadRuntime();
  },

  /** Persist the current tree as the draft right away (before publish/preview). */
  async flushDraft() {
    const s = editor.get();
    if (!s.tree || !s.pageId || !s.canEdit) return;
    await put(pagesPath(s.site, `/pages/${s.pageId}/draft`), { tree: s.tree });
  },
};

export function keyCommandFor(e: KeyboardEvent) {
  return keyToCommand(e, isMac);
}
export { isMac };
