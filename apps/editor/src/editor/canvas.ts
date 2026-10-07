import { detectFlow, type Point, type Rect, type SlotGeom } from '../lib/drop.ts';
import { canvasSelectableId, canvasToDocParent, findNode, INSTANCE_TYPE, OUTLET_ID, PAGE_ROOT } from '../lib/tree.ts';
import { editor } from './state.ts';

/**
 * Bridge between the editor (parent document) and the canvas iframe:
 * coordinate mapping (zoom + iframe offset), element lookup, and geometry
 * snapshots for drop resolution. Geometry listeners fire on scroll, resize
 * and every render so the overlay stays glued to the content.
 */
class CanvasController {
  iframe: HTMLIFrameElement | null = null;
  viewport: HTMLElement | null = null;
  scale = 1;
  pageRootId: string | null = OUTLET_ID;
  layoutIds = new Set<string>();
  private listeners = new Set<() => void>();
  private raf = 0;
  private slotCache: SlotGeom[] | null = null;

  doc(): Document | null {
    try {
      return this.iframe?.contentDocument ?? null;
    } catch {
      return null;
    }
  }

  el(id: string): HTMLElement | null {
    return (this.doc()?.querySelector(`[data-node-id="${CSS.escape(id)}"]`) as HTMLElement | null) ?? null;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Geometry changed (scroll/resize/render): coalesce into one frame. */
  notify() {
    this.slotCache = null;
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.listeners.forEach((l) => l());
    });
  }

  /** Is this canvas node part of the site layout (header/footer) rather than the page? */
  isLayoutNode(id: string): boolean {
    return this.layoutIds.has(id);
  }

  /** Rect of a canvas node in viewport (overlay) coordinates. */
  rectOf(id: string): Rect | null {
    const el = this.el(id);
    if (!el) return null;
    return this.toViewport(el.getBoundingClientRect());
  }

  /** Convert a rect in iframe CSS px into overlay coordinates. */
  toViewport(r: { left: number; top: number; right: number; bottom: number }): Rect | null {
    if (!this.iframe || !this.viewport) return null;
    const f = this.iframe.getBoundingClientRect();
    const v = this.viewport.getBoundingClientRect();
    const s = this.scale;
    return { left: f.left - v.left + r.left * s, top: f.top - v.top + r.top * s, right: f.left - v.left + r.right * s, bottom: f.top - v.top + r.bottom * s };
  }

  /** Map a client (parent window) point into iframe CSS px. */
  clientToIframe(p: Point): Point | null {
    if (!this.iframe) return null;
    const f = this.iframe.getBoundingClientRect();
    return { x: (p.x - f.left) / this.scale, y: (p.y - f.top) / this.scale };
  }

  iframeVisibleRect(): Rect | null {
    if (!this.iframe) return null;
    const f = this.iframe.getBoundingClientRect();
    return { left: f.left, top: f.top, right: f.right, bottom: f.bottom };
  }

  /** While dragging, the iframe must not swallow pointer events (the parent tracks the pointer). */
  setInteractive(on: boolean) {
    if (this.iframe) this.iframe.style.pointerEvents = on ? '' : 'none';
  }

  scrollBy(dy: number) {
    this.iframe?.contentWindow?.scrollBy(0, dy);
  }

  scrollIntoView(id: string) {
    const el = this.el(id);
    const win = this.iframe?.contentWindow;
    if (!el || !win) return;
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > win.innerHeight) el.scrollIntoView({ block: r.height > win.innerHeight ? 'start' : 'center', behavior: 'smooth' });
  }

  /** Computed layout facts for the style panel: own display/position and the parent's display. */
  computed(id: string): { display: string; position: string; parentDisplay: string } | null {
    const el = this.el(id);
    const win = this.doc()?.defaultView;
    if (!el || !win) return null;
    const cs = win.getComputedStyle(el);
    let parent: HTMLElement | null = el.parentElement;
    while (parent && win.getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
    return { display: cs.display, position: cs.position, parentDisplay: parent ? win.getComputedStyle(parent).display : 'block' };
  }

  /** Measure every page slot on the canvas (cached until the next geometry change). */
  snapshotSlots(): SlotGeom[] {
    if (this.slotCache) return this.slotCache;
    const doc = this.doc();
    if (!doc) return [];
    const tree = editor.get().tree;
    const out: SlotGeom[] = [];
    const win = doc.defaultView!;
    doc.querySelectorAll('m-slot').forEach((m) => {
      const slotEl = m as HTMLElement;
      const canvasParent = slotEl.dataset.parent ?? '';
      const slot = slotEl.dataset.slot ?? 'default';
      // Layout slots (header/footer) are not part of the page document.
      if (canvasParent !== this.pageRootId && this.layoutIds.has(canvasParent)) return;
      const parentId = canvasToDocParent(canvasParent, this.pageRootId);
      // Expanded synced-instance content ("<instance>~<node>") is not part of the page document.
      if (canvasParent.includes('~')) return;
      const parentNode = parentId === PAGE_ROOT ? tree : findNode(tree, parentId);
      if (!parentNode || parentNode.type === INSTANCE_TYPE) return;
      const owner = (canvasParent ? doc.querySelector(`[data-node-id="${CSS.escape(canvasParent)}"]`) : null) as HTMLElement | null;
      const ancestors: string[] = [];
      for (let a: Element | null = slotEl; a; a = a.parentElement?.closest('[data-node-id]') ?? null) {
        const id = (a as HTMLElement).dataset?.nodeId;
        if (id && !ancestors.includes(id)) ancestors.unshift(canvasToDocParent(id, this.pageRootId));
      }
      if (!ancestors.includes(parentId)) ancestors.push(parentId);
      const kids = [...slotEl.children].filter((c) => c.hasAttribute('data-node-id')) as HTMLElement[];
      const children = kids.map((k) => ({ id: canvasSelectableId(k.dataset.nodeId!), rect: plain(k.getBoundingClientRect()) }));
      let emptyRect: Rect | null = null;
      if (!kids.length) {
        const r = slotEl.getBoundingClientRect();
        emptyRect = r.width > 0 && r.height > 0 ? plain(r) : owner ? plain(owner.getBoundingClientRect()) : null;
      }
      let container: HTMLElement | null = slotEl.parentElement;
      while (container && win.getComputedStyle(container).display === 'contents') container = container.parentElement;
      const cs = container ? win.getComputedStyle(container) : null;
      const flow = detectFlow(cs ? { display: cs.display, flexDirection: cs.flexDirection, gridTemplateColumns: cs.gridTemplateColumns } : null, children.map((c) => c.rect));
      const parentRect = owner ? plain(owner.getBoundingClientRect()) : emptyRect ?? { left: 0, top: 0, right: 0, bottom: 0 };
      out.push({ parentId, parentType: parentNode.type, slot, ancestors, depth: ancestors.length, parentRect, emptyRect, flow, children });
    });
    this.slotCache = out;
    return out;
  }
}

function plain(r: DOMRect): Rect {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export const canvas = new CanvasController();
