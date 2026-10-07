import { useDroppable } from '@dnd-kit/core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage, post, sitePath } from '../api.ts';
import { useStore } from '../lib/store.ts';
import { canvasSelectableId, OUTLET_ID } from '../lib/tree.ts';
import type { RenderResult } from '../types.ts';
import { Spinner } from '../ui/controls.tsx';
import { canvas } from './canvas.ts';
import { Overlay } from './Overlay.tsx';
import { actions, DEVICE_WIDTH, editor } from './state.ts';

const FRAME_DOC =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style id="m-css"></style><style id="m-edit"></style>' +
  // Canvas-only affordances: embedded iframes must not eat clicks; empty page hint.
  '<style>iframe{pointer-events:none}a,button,summary,label{cursor:default}html{scrollbar-gutter:stable}' +
  'm-slot[data-parent="main"]:empty{min-height:240px;display:flex;align-items:center;justify-content:center;margin:24px}' +
  'm-slot[data-parent="main"]:empty::after{content:"Drag blocks here from the Insert panel";font:14px system-ui;color:#7b84a3}' +
  // Synced library component instances get a distinct dashed outline.
  '.l-inst{outline:1px dashed #a855f7;outline-offset:-1px}</style>' +
  '</head><body></body></html>';

const RENDER_DEBOUNCE = 120;

export function Canvas() {
  const tree = useStore(editor, (s) => s.tree);
  const synced = useStore(editor, (s) => s.synced);
  const renderNonce = useStore(editor, (s) => s.renderNonce);
  const site = useStore(editor, (s) => s.site);
  const device = useStore(editor, (s) => s.device);
  const pagePath = useStore(editor, (s) => s.pages.find((p) => p.id === s.pageId)?.path ?? '/');
  const selectionId = useStore(editor, (s) => s.selection?.id ?? null);
  const dragging = useStore(editor, (s) => !!s.dragging);
  const areaRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rendered, setRendered] = useState(false);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const pending = useRef<RenderResult | null>(null);
  const last = useRef<{ css: string; html: string; edit: string }>({ css: '', html: '', edit: '' });
  const seq = useRef(0);
  const { setNodeRef } = useDroppable({ id: 'canvas' });

  /* ── apply a render result to the iframe by patching (no reload, keeps scroll) ── */
  const apply = useCallback((r: RenderResult) => {
    const doc = canvas.doc();
    if (!doc || !doc.body || !doc.getElementById('m-css')) {
      pending.current = r;
      return;
    }
    if (last.current.css !== r.css) doc.getElementById('m-css')!.textContent = r.css;
    // Empty slots of layout nodes (e.g. header#actions) are not page drop zones: hide their placeholders.
    const layoutSlotCss = r.layoutNodeIds
      .filter((id) => id !== r.pageRootId)
      .map((id) => `m-slot[data-parent="${CSS.escape(id)}"]:empty`)
      .join(',');
    const editCss = r.editCss + (layoutSlotCss ? `${layoutSlotCss}{display:none}` : '');
    if (last.current.edit !== editCss) doc.getElementById('m-edit')!.textContent = editCss;
    if (last.current.html !== r.html) {
      const win = doc.defaultView!;
      const y = win.scrollY;
      doc.body.innerHTML = r.html;
      if (win.scrollY !== y) win.scrollTo(0, y);
    }
    last.current = { css: r.css, html: r.html, edit: editCss };
    canvas.layoutIds = new Set(r.layoutNodeIds);
    canvas.pageRootId = r.pageRootId ?? OUTLET_ID;
    editor.set({ layoutNodeIds: canvas.layoutIds });
    setRendered(true);
    canvas.notify();
  }, []);

  /* ── debounced server render ── */
  useEffect(() => {
    if (!tree || !site) return;
    const my = ++seq.current;
    const t = setTimeout(
      async () => {
        try {
          const r = await post<RenderResult>(sitePath(site, '/render'), { tree, layout: true, path: pagePath });
          if (my !== seq.current) return;
          setError(null);
          apply(r);
        } catch (e) {
          if (my === seq.current) setError(errorMessage(e));
        }
      },
      rendered ? RENDER_DEBOUNCE : 0,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, renderNonce, site, pagePath, apply]);

  /* ── iframe wiring: hover / select / keyboard / geometry ── */
  const onLoad = useCallback(() => {
    const doc = canvas.doc();
    const win = iframeRef.current?.contentWindow;
    if (!doc || !win) return;
    setReady(true);
    const nodeAt = (t: EventTarget | null) => (t && typeof (t as Element).closest === 'function' ? ((t as Element).closest('[data-node-id]') as HTMLElement | null) : null);
    const selectable = (el: HTMLElement | null) => {
      // The layout's own page root and the outlet are structural, not selectable.
      if (el && (el.dataset.nodeId === 'root' || el.dataset.nodeId === canvas.pageRootId)) return null;
      return el;
    };
    // Expanded synced-instance nodes ("<instance>~<inner>") select the instance itself.
    const idOf = (el: HTMLElement | null) => (el?.dataset.nodeId ? canvasSelectableId(el.dataset.nodeId) : null);
    let raf = 0;
    doc.addEventListener('mousemove', (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        actions.hover(idOf(selectable(nodeAt(e.target))));
      });
    });
    doc.addEventListener('mouseleave', () => actions.hover(null));
    doc.addEventListener(
      'click',
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = idOf(selectable(nodeAt(e.target)));
        if (!id) return actions.select(null);
        actions.select({ id, mode: canvas.isLayoutNode(id) ? 'layout' : 'page' });
      },
      true,
    );
    doc.addEventListener('dblclick', (e) => {
      e.preventDefault();
      editor.set({ inspectorTab: 'content' });
      setTimeout(() => (document.querySelector('.inspector [data-first-field] :is(input,textarea,[contenteditable])') as HTMLElement | null)?.focus(), 30);
    });
    doc.addEventListener('submit', (e) => e.preventDefault(), true);
    doc.addEventListener('dragstart', (e) => e.preventDefault());
    doc.addEventListener('keydown', (e) => actions.handleKey(e));
    doc.addEventListener('load', () => canvas.notify(), true); // images
    win.addEventListener('scroll', () => canvas.notify(), { passive: true });
    win.addEventListener('resize', () => canvas.notify());
    const RO = (win as any).ResizeObserver ?? ResizeObserver;
    new RO(() => canvas.notify()).observe(doc.body);
    if (pending.current) {
      const r = pending.current;
      pending.current = null;
      last.current = { css: '', html: '', edit: '' };
      apply(r);
    }
  }, [apply]);

  useEffect(() => {
    canvas.iframe = iframeRef.current;
    canvas.viewport = areaRef.current;
    return () => {
      canvas.iframe = null;
      canvas.viewport = null;
    };
  }, []);

  /* ── zoom to fit for device widths wider than the available area ── */
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setArea({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setArea({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  const deviceWidth = DEVICE_WIDTH[device];
  const pad = deviceWidth ? 32 : 0;
  const scale = deviceWidth && area.w ? Math.min(1, (area.w - pad * 2) / deviceWidth) : 1;
  const frameW = deviceWidth ?? area.w;
  const frameH = deviceWidth ? Math.max(200, (area.h - pad) / scale) : area.h;
  canvas.scale = scale;
  useEffect(() => canvas.notify(), [scale, frameW, frameH]);

  /* ── keep the selection visible ── */
  useEffect(() => {
    if (selectionId && rendered) canvas.scrollIntoView(selectionId);
  }, [selectionId, rendered]);

  const setArea2 = useCallback(
    (el: HTMLDivElement | null) => {
      areaRef.current = el;
      setNodeRef(el);
      canvas.viewport = el;
    },
    [setNodeRef],
  );

  return (
    <div className={`canvas-area${deviceWidth ? ' device' : ''}${dragging ? ' dragging' : ''}`} ref={setArea2} aria-label="Page canvas">
      <div
        className="canvas-frame"
        style={{
          width: frameW,
          height: frameH,
          transform: scale !== 1 ? `scale(${scale})` : undefined,
          left: deviceWidth ? Math.max(pad, (area.w - frameW * scale) / 2) : 0,
          top: deviceWidth ? pad / 2 : 0,
        }}
      >
        <iframe ref={iframeRef} title="Page preview (editable canvas)" srcDoc={FRAME_DOC} onLoad={onLoad} />
      </div>
      {(!synced || !rendered || !ready) && !error && (
        <div className="canvas-loading">
          <Spinner label="Loading page" />
          <span>{synced ? 'Rendering…' : 'Connecting…'}</span>
        </div>
      )}
      {error && (
        <div className="canvas-error" role="alert">
          Couldn’t render the page: {error}
          <button className="btn sm" onClick={() => actions.bumpRender()}>
            Retry
          </button>
        </div>
      )}
      {deviceWidth && scale < 1 && <div className="zoom-badge">{Math.round(scale * 100)}%</div>}
      <Overlay />
    </div>
  );
}
