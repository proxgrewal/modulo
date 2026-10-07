import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Breakpoint, PageNode, PatchOp, StyleProps, StyleState } from '@modulo/core';
import { errorMessage } from '../../api.ts';
import {
  BP_LABEL,
  childGroupVisible,
  cleanClassNames,
  effectiveValue,
  GROUP_ORDER,
  hasAnyStyle,
  inheritedValue,
  layerCounts,
  layerName,
  layerValues,
  parseLength,
  presetNameFrom,
  propVisible,
  sideValue,
  SIDES,
  STATE_LABEL,
  styleLayersOf,
  tokenLabel,
  validateStyleValue,
  withValue,
  type GateContext,
  type Side,
  type StyleData,
  type StyleLayer,
} from '../../lib/style.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import type { Device, SitePreset, StyleCatalogEntry } from '../../types.ts';
import { useLocalValue, useUid } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { canvas } from '../canvas.ts';
import { actions, DEVICE_BP, editor } from '../state.ts';
import { StyleControl } from './StyleControls.tsx';

/* ───────────────────────── targets: where edits go ───────────────────────── */

export interface StyleTarget {
  kind: 'page' | 'layout' | 'preset';
  /** Stable identity (node id / preset name). */
  id: string;
  data: StyleData;
  /** Canvas element used for display/position gating (null = show everything). */
  elementId: string | null;
  disabled: boolean;
  set(values: Record<string, string | undefined>, layer: StyleLayer): void;
  replace(next: { style?: StyleProps; responsive?: PageNode['responsive']; states?: PageNode['states'] }): void;
  setPresets?(names: string[]): void;
  setClassName?(v: string): void;
}

export function pageTarget(node: PageNode, disabled: boolean): StyleTarget {
  return {
    kind: 'page',
    id: node.id,
    data: node,
    elementId: node.id,
    disabled,
    set: (values, l) => actions.setStyle(node.id, Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v ?? ''])), l.bp, l.state),
    replace: (next) => actions.replaceStyle(node.id, next),
    setPresets: (names) => actions.setField(node.id, 'presets', names),
    setClassName: (v) => actions.setField(node.id, 'className', v),
  };
}

/** Header/footer nodes: edits become site layout patch ops (setStyle with bp/state, setField). */
export function layoutTarget(node: PageNode, disabled: boolean): StyleTarget {
  const styleOp = (style: StyleProps, l: StyleLayer): PatchOp => ({ op: 'setStyle', target: node.id, style, ...(l.state ? { state: l.state } : l.bp ? { bp: l.bp } : {}) });
  return {
    kind: 'layout',
    id: node.id,
    data: node,
    elementId: node.id,
    disabled,
    set: (values, l) => void actions.layoutEdit([styleOp(values as StyleProps, l)]),
    replace: (next) => {
      const ops: PatchOp[] = [];
      const layers: StyleLayer[] = [{}, ...(['md', 'sm', 'xs'] as Breakpoint[]).map((bp) => ({ bp })), ...(['hover', 'focus', 'active'] as StyleState[]).map((state) => ({ state }))];
      for (const l of layers) {
        const cur = layerValues(node, l);
        const nxt = layerValues(next, l);
        const style: StyleProps = {};
        for (const k of Object.keys(cur)) if (!(k in nxt)) style[k] = undefined;
        Object.assign(style, nxt);
        if (Object.keys(style).length) ops.push(styleOp(style, l));
      }
      if (ops.length) void actions.layoutEdit(ops);
    },
    setPresets: (names) => void actions.layoutEdit([{ op: 'setField', target: node.id, field: 'presets', value: names }]),
    setClassName: (v) => void actions.layoutEdit([{ op: 'setField', target: node.id, field: 'className', value: v }]),
  };
}

/** A site style preset: edits are saved with PUT /styles (debounced). */
export function presetTarget(name: string, preset: SitePreset, disabled: boolean): StyleTarget {
  const save = (next: SitePreset) => {
    const all = { ...(editor.get().runtime?.stylePresets ?? {}) };
    all[name] = next;
    actions.saveStylePresets(all).catch(() => {});
  };
  return {
    kind: 'preset',
    id: `preset:${name}`,
    data: preset,
    elementId: null,
    disabled,
    set: (values, l) => save({ label: preset.label, ...withValue(preset, l, values) } as SitePreset),
    replace: (next) => save({ label: preset.label, ...styleLayersOf(next) }),
  };
}

/* ───────────────────────── context: breakpoint + state ───────────────────────── */

const DEVICES: { device: Device; label: string; icon: string; bp?: Breakpoint; title: string }[] = [
  { device: 'desktop', label: 'Desktop', icon: 'desktop', title: 'Desktop: base styles, all screen sizes' },
  { device: 'tablet', label: 'Tablet', icon: 'tablet', bp: 'md', title: 'Tablet: ≤1024px' },
  { device: 'mobile', label: 'Mobile', icon: 'mobile', bp: 'sm', title: 'Mobile: ≤640px' },
  { device: 'small', label: 'Small', icon: 'small', bp: 'xs', title: 'Small phone: ≤420px' },
];

export function useStyleLayer(): StyleLayer {
  const { device, state } = useStore(editor, (s) => ({ device: s.device, state: s.styleState }), shallowEqual);
  return useMemo(() => (state ? { state } : { bp: DEVICE_BP[device] }), [device, state]);
}

function ContextBar({ data }: { data: StyleData }) {
  const device = useStore(editor, (s) => s.device);
  const state = useStore(editor, (s) => s.styleState);
  const counts = layerCounts(data);
  return (
    <div className="sp-context" role="group" aria-label="Style layer">
      <div className="sp-ctx-row" role="radiogroup" aria-label="Breakpoint">
        {DEVICES.map((d) => {
          const n = d.bp ? counts.bp[d.bp] : counts.base;
          return (
            <button key={d.device} type="button" role="radio" aria-checked={device === d.device} className={`sp-ctx-btn${device === d.device ? ' active' : ''}`} title={d.title} onClick={() => actions.setDevice(d.device)}>
              <Icon name={d.icon} size={14} />
              <span>{d.label}</span>
              {!!n && <b className="sp-count">{n}</b>}
            </button>
          );
        })}
      </div>
      <div className="sp-ctx-row states" role="radiogroup" aria-label="State">
        {([null, 'hover', 'focus', 'active'] as (StyleState | null)[]).map((st) => {
          const n = st ? counts.state[st] : 0;
          return (
            <button key={st ?? 'normal'} type="button" role="radio" aria-checked={state === st} className={`sp-ctx-btn${state === st ? ' active' : ''}`} onClick={() => editor.set({ styleState: st })}>
              <span>{st ? STATE_LABEL[st] : 'Normal'}</span>
              {!!n && <b className="sp-count">{n}</b>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────── gating from the canvas ───────────────────────── */

function useGate(target: StyleTarget, layer: StyleLayer): GateContext {
  const elementId = target.elementId;
  type Facts = ReturnType<typeof canvas.computed>;
  const [facts, setFacts] = useState<Facts>(() => (elementId ? canvas.computed(elementId) : null));
  useEffect(() => {
    if (!elementId) return;
    // Re-read computed display/position after renders; only re-render the panel when they change.
    const update = () => {
      const c = canvas.computed(elementId);
      setFacts((prev) => (prev && c && prev.display === c.display && prev.position === c.position && prev.parentDisplay === c.parentDisplay ? prev : c));
    };
    update();
    return canvas.subscribe(update);
  }, [elementId]);
  if (!elementId) return { unknown: true };
  return {
    display: effectiveValue(target.data, 'display', layer) ?? facts?.display ?? 'block',
    position: effectiveValue(target.data, 'position', layer) ?? facts?.position ?? 'static',
    parentDisplay: facts?.parentDisplay ?? 'block',
  };
}

/* ───────────────────────── one property row ───────────────────────── */

function useCatalog(): StyleCatalogEntry[] {
  return useStore(editor, (s) => s.runtime?.styleCatalog ?? []);
}

interface RowProps {
  prop: StyleCatalogEntry;
  target: StyleTarget;
  layer: StyleLayer;
  label?: string;
  compact?: boolean;
}

const PropRow = memo(function PropRow({ prop, target, layer, label, compact }: RowProps) {
  const id = useUid('sp');
  const [error, setError] = useState<string | null>(null);
  const own = layerValues(target.data, layer)[prop.key];
  const value = own === undefined || own === '' ? undefined : String(own);
  const inh = inheritedValue(target.data, prop.key, layer);
  useEffect(() => setError(null), [value, layer.bp, layer.state]);
  const commit = (v: string | undefined) => {
    if (target.disabled) return;
    const err = validateStyleValue(prop.key, v);
    if (err) return setError(err);
    setError(null);
    if ((v ?? undefined) === value) return;
    target.set({ [prop.key]: v }, layer);
  };
  const scrubbable = prop.control === 'length' || prop.control === 'number';
  const onScrubStart = (e: React.PointerEvent) => {
    if (!scrubbable || target.disabled || e.button !== 0) return;
    const p = parseLength(value ?? inh?.value ?? (prop.control === 'number' ? '0' : '0px'));
    if (!p) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = Number(p.num);
    const unit = p.unit || (prop.control === 'length' ? (prop.units?.find((u) => u && u !== 'auto') ?? '') : '');
    const fine = ['em', 'rem', ''].includes(unit) && prop.key !== 'zIndex' && prop.key !== 'order';
    let last = '';
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const n = fine ? Math.round((start + dx * 0.05) * 100) / 100 : Math.round(start + dx * (ev.shiftKey ? 5 : 1));
      const v = `${n}${n === 0 && prop.control === 'length' ? '' : unit}`;
      if (v !== last && !validateStyleValue(prop.key, v)) {
        last = v;
        target.set({ [prop.key]: v }, layer);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('scrubbing');
    };
    document.body.classList.add('scrubbing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <div className={`sp-row${compact ? ' compact' : ''}${value !== undefined ? ' is-set' : ''}`} data-prop={prop.key}>
      <div className="sp-label">
        {value !== undefined ? <span className="sp-dot" title={`Set at ${layerName(layer)}`} aria-label="set at this layer" /> : inh ? <span className="sp-dot hollow" title={`Inherited from ${inh.from}`} /> : <span className="sp-dot none" />}
        <label htmlFor={id} className={scrubbable ? 'scrub' : undefined} onPointerDown={onScrubStart} title={scrubbable ? 'Drag to adjust' : undefined}>
          {label ?? prop.label}
        </label>
        {inh && value === undefined && <span className="sp-inh" title={`Inherited from ${inh.from}`}>{tokenLabel(inh.value) ?? inh.value}</span>}
        {value !== undefined && (
          <button type="button" className="sp-reset" disabled={target.disabled} onClick={() => commit(undefined)} aria-label={`Reset ${prop.label}`} title="Reset (remove at this layer)">
            <Icon name="x" size={11} />
          </button>
        )}
      </div>
      <div className="sp-control">
        <StyleControl prop={prop} id={id} value={value} placeholder={inh?.value} commit={commit} disabled={target.disabled} />
      </div>
      {error && (
        <p className="sp-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});

/* ───────────────────────── spacing: box model ───────────────────────── */

function BoxModel({ target, layer, catalog }: { target: StyleTarget; layer: StyleLayer; catalog: Map<string, StyleCatalogEntry> }) {
  const [key, setKey] = useState<string>('paddingTop');
  const own = layerValues(target.data, layer);
  // Effective values at this layer for display: own layer first, then what is inherited.
  const merged: StyleProps = {};
  for (const p of ['padding', 'margin']) for (const k of [p, `${p}X`, `${p}Y`, ...SIDES.map((s) => p + s)]) {
    const v = effectiveValue(target.data, k, layer);
    if (v !== undefined) merged[k] = v;
  }
  const cell = (prop: 'padding' | 'margin', side: Side) => {
    const ownHit = sideValue(own, prop, side);
    const hit = ownHit ?? sideValue(merged, prop, side);
    const k = `${prop}${side}`;
    const txt = hit ? (tokenLabel(hit.value) ?? hit.value) : '–';
    return (
      <button
        type="button"
        className={`bm-cell bm-${side.toLowerCase()}${key === k ? ' active' : ''}${ownHit ? ' set' : hit ? ' inherited' : ''}`}
        aria-label={`${prop} ${side.toLowerCase()}: ${hit ? hit.value : 'not set'}`}
        aria-pressed={key === k}
        title={`${prop === 'padding' ? 'Padding' : 'Margin'} ${side.toLowerCase()}${hit ? ` = ${hit.value} (${hit.key})` : ''}`}
        onClick={() => setKey(k)}
      >
        {txt}
      </button>
    );
  };
  const editing = catalog.get(key);
  const shortcut = (k: string, text: string) => (
    <button type="button" className={`chip-btn${key === k ? ' active' : ''}${own[k] !== undefined ? ' set' : ''}`} onClick={() => setKey(k)} aria-pressed={key === k}>
      {text}
    </button>
  );
  return (
    <div className="box-model-wrap">
      <div className="box-model" role="group" aria-label="Box model: margin and padding">
        <span className="bm-tag m">Margin</span>
        {cell('margin', 'Top')}
        {cell('margin', 'Right')}
        {cell('margin', 'Bottom')}
        {cell('margin', 'Left')}
        <div className="bm-padding">
          <span className="bm-tag p">Padding</span>
          {cell('padding', 'Top')}
          {cell('padding', 'Right')}
          {cell('padding', 'Bottom')}
          {cell('padding', 'Left')}
          <div className="bm-content" aria-hidden="true" />
        </div>
      </div>
      <div className="bm-shortcuts">
        <span className="muted small">Padding</span>
        {shortcut('padding', 'All')}
        {shortcut('paddingX', 'X')}
        {shortcut('paddingY', 'Y')}
        <span className="muted small">Margin</span>
        {shortcut('margin', 'All')}
        {shortcut('marginX', 'X')}
        {shortcut('marginY', 'Y')}
      </div>
      {editing && <PropRow key={key} prop={editing} target={target} layer={layer} />}
      {Object.keys(own).filter((k) => /^(padding|margin)/.test(k) && k !== key && catalog.has(k)).length > 0 && (
        <div className="bm-set-list">
          <span className="muted small">Set here:</span>
          {Object.keys(own)
            .filter((k) => /^(padding|margin)/.test(k) && catalog.has(k))
            .map((k) => (
              <button key={k} type="button" className={`chip-btn set${key === k ? ' active' : ''}`} onClick={() => setKey(k)}>
                {catalog.get(k)!.label}: {tokenLabel(String(own[k])) ?? String(own[k])}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── border: all/per side + linked radius ───────────────────────── */

function BorderGroup({ target, layer, catalog }: { target: StyleTarget; layer: StyleLayer; catalog: Map<string, StyleCatalogEntry> }) {
  const own = layerValues(target.data, layer);
  const anySide = ['borderTop', 'borderRight', 'borderBottom', 'borderLeft'].some((k) => effectiveValue(target.data, k, layer) !== undefined);
  const anyCorner = ['radiusTopLeft', 'radiusTopRight', 'radiusBottomRight', 'radiusBottomLeft'].some((k) => effectiveValue(target.data, k, layer) !== undefined);
  const [perSide, setPerSide] = useState(anySide);
  const [linked, setLinked] = useState(!anyCorner);
  const row = (k: string, label?: string, compact?: boolean) => {
    const p = catalog.get(k);
    return p ? <PropRow key={k} prop={p} target={target} layer={layer} label={label} compact={compact} /> : null;
  };
  void own;
  return (
    <>
      <div className="sp-mode" role="radiogroup" aria-label="Border sides">
        <button type="button" role="radio" aria-checked={!perSide} className={!perSide ? 'active' : ''} onClick={() => setPerSide(false)}>
          All sides
        </button>
        <button type="button" role="radio" aria-checked={perSide} className={perSide ? 'active' : ''} onClick={() => setPerSide(true)}>
          Per side
        </button>
      </div>
      {perSide ? (
        <>
          {row('borderTop')}
          {row('borderRight')}
          {row('borderBottom')}
          {row('borderLeft')}
        </>
      ) : (
        <>
          {row('border', 'Border (shorthand)')}
          {row('borderWidth')}
          {row('borderStyle')}
          {row('borderColor')}
        </>
      )}
      <div className="sp-subhead">
        <span>Corner radius</span>
        <button type="button" className={`chip-btn${linked ? ' active' : ''}`} aria-pressed={linked} title={linked ? 'Corners linked: click to edit each corner' : 'Link corners'} onClick={() => setLinked(!linked)}>
          <Icon name={linked ? 'link2' : 'link-off'} size={13} /> {linked ? 'Linked' : 'Per corner'}
        </button>
      </div>
      {linked ? (
        row('radius', 'Radius')
      ) : (
        <div className="sp-grid2">
          {row('radiusTopLeft', '↖ Top left', true)}
          {row('radiusTopRight', '↗ Top right', true)}
          {row('radiusBottomLeft', '↙ Bottom left', true)}
          {row('radiusBottomRight', '↘ Bottom right', true)}
        </div>
      )}
      {row('outline')}
    </>
  );
}

/* ───────────────────────── sections ───────────────────────── */

const OPEN_KEY = 'modulo:style-sections';
const DEFAULT_OPEN = ['layout', 'child', 'spacing', 'size', 'typography', 'background'];
function readOpen(): string[] {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_OPEN;
  } catch {
    return DEFAULT_OPEN;
  }
}

function Section({ group, label, count, open, onToggle, children }: { group: string; label: string; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`sp-section${open ? ' open' : ''}`} data-group={group}>
      <h3>
        <button type="button" aria-expanded={open} onClick={onToggle}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
          {label}
          {count > 0 && <b className="sp-count">{count}</b>}
        </button>
      </h3>
      {open && <div className="sp-section-body">{children}</div>}
    </section>
  );
}

/* ───────────────────────── the panel ───────────────────────── */

export function StylePanel({ target, presetBar }: { target: StyleTarget; presetBar?: boolean }) {
  const catalog = useCatalog();
  const layer = useStyleLayer();
  const gate = useGate(target, layer);
  const byKey = useMemo(() => new Map(catalog.map((p) => [p.key, p])), [catalog]);
  const [open, setOpen] = useState<string[]>(readOpen);
  const toggle = (g: string) =>
    setOpen((o) => {
      const n = o.includes(g) ? o.filter((x) => x !== g) : [...o, g];
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  const here = layerValues(target.data, layer);
  const hereKeys = Object.keys(here).filter((k) => here[k] !== undefined && here[k] !== '');
  if (!catalog.length) return <p className="muted small">The server did not provide a style catalog.</p>;

  const clearLayer = () => {
    if (!hereKeys.length) return;
    target.set(Object.fromEntries(hereKeys.map((k) => [k, undefined])), layer);
    toast.info(`Cleared ${hereKeys.length} style${hereKeys.length > 1 ? 's' : ''} at ${layerName(layer)}`);
  };

  return (
    <div className="style-panel">
      {presetBar && target.kind !== 'preset' && <PresetBar target={target} />}
      <ContextBar data={target.data} />
      <p className="sp-layer-note" aria-live="polite">
        Editing <strong>{layerName(layer)}</strong>
        {layer.state ? ' — applies at every screen size' : layer.bp ? ` — overrides wider screens (≤${({ md: 1024, sm: 640, xs: 420 } as const)[layer.bp]}px)` : ' — applies everywhere unless overridden'}
      </p>
      {GROUP_ORDER.map(({ group, label }) => {
        if (group === 'child' && !childGroupVisible(gate) && !catalog.some((p) => p.group === 'child' && here[p.key] !== undefined)) return null;
        const props = catalog.filter((p) => p.group === group);
        const count = props.filter((p) => here[p.key] !== undefined && here[p.key] !== '').length;
        let body: ReactNode;
        if (group === 'spacing') body = <BoxModel target={target} layer={layer} catalog={byKey} />;
        else if (group === 'border') body = <BorderGroup target={target} layer={layer} catalog={byKey} />;
        else {
          const visible = props.filter((p) => propVisible(p, gate) || (here[p.key] !== undefined && here[p.key] !== ''));
          const hidden = props.length - visible.length;
          body = (
            <>
              {visible.map((p) => (
                <PropRow key={p.key} prop={p} target={target} layer={layer} />
              ))}
              {hidden > 0 && group === 'layout' && <p className="muted small">Set Display to flex or grid for alignment, gap and column controls.</p>}
              {hidden > 0 && group === 'position' && <p className="muted small">Choose a position other than static to place it with top / right / bottom / left.</p>}
            </>
          );
        }
        return (
          <Section key={group} group={group} label={label} count={count} open={open.includes(group)} onToggle={() => toggle(group)}>
            {body}
          </Section>
        );
      })}
      <div className="sp-footer">
        <button type="button" className="btn sm ghost danger" disabled={target.disabled || !hereKeys.length} onClick={clearLayer}>
          <Icon name="trash" size={13} /> Clear all styles at {layer.state ? `${STATE_LABEL[layer.state]} state` : layer.bp ? BP_LABEL[layer.bp] : 'Desktop'}
          {hereKeys.length ? ` (${hereKeys.length})` : ''}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── presets, copy/paste, class names ───────────────────────── */

const STYLE_CLIP = 'modulo:style-clipboard';

function PresetBar({ target }: { target: StyleTarget }) {
  const presets = useStore(editor, (s) => s.runtime?.stylePresets ?? {});
  const canDesign = useStore(editor, (s) => !!s.runtime && (s.runtime.user.isSuperadmin || s.runtime.user.permissions.some((p) => p === '*' || p === 'core.design')));
  const applied = target.data.presets ?? [];
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [classText, setClassText, ch] = useLocalValue(target.data.className ?? '', (v: string) => target.setClassName?.(cleanClassNames(v)));
  const uid = useUid('pb');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);
  const available = Object.entries(presets).filter(([n]) => !applied.includes(n));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const lbl = label.trim();
    if (!lbl) return;
    const before = editor.get().runtime?.stylePresets ?? {};
    const name = presetNameFrom(lbl, Object.keys(before));
    const layers = styleLayersOf(target.data as PageNode);
    setBusy(true);
    try {
      await actions.saveStylePresets({ ...before, [name]: { label: lbl, ...layers } }, true);
      // Apply it and drop the node's own copies of those values (the preset now carries them).
      if (target.kind === 'page') {
        actions.transact(() => {
          target.setPresets?.([...applied, name]);
          target.replace({ style: {} });
        });
      } else {
        target.setPresets?.([...applied, name]);
        target.replace({ style: {} });
      }
      setCreating(false);
      setLabel('');
      toast.success(`Preset “${lbl}” created and applied`);
    } catch (err) {
      await actions.saveStylePresets(before, true).catch(() => {});
      toast.error(`Couldn’t create preset: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = () => {
    try {
      localStorage.setItem(STYLE_CLIP, JSON.stringify(styleLayersOf(target.data as PageNode)));
      toast.info('Style copied');
    } catch {
      toast.error('Clipboard storage is blocked');
    }
  };
  const paste = () => {
    try {
      const raw = localStorage.getItem(STYLE_CLIP);
      if (!raw) return toast.info('Copy a style first');
      target.replace(JSON.parse(raw));
      toast.info('Style pasted');
    } catch {
      toast.error('Nothing to paste');
    }
  };

  return (
    <div className="preset-bar">
      <div className="pb-row">
        <span className="pb-title">
          <Icon name="tag" size={13} /> Presets
        </span>
        <div className="pb-chips">
          {applied.map((n) => (
            <span key={n} className={`preset-chip${presets[n] ? '' : ' missing'}`}>
              <button type="button" className="pc-main" title={presets[n] ? 'Edit this preset' : 'This preset no longer exists'} disabled={!presets[n] || !canDesign} onClick={() => editor.set({ editingPreset: n })}>
                {presets[n]?.label ?? n}
              </button>
              <button type="button" className="pc-x" aria-label={`Remove preset ${presets[n]?.label ?? n}`} disabled={target.disabled} onClick={() => target.setPresets?.(applied.filter((x) => x !== n))}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          {available.length > 0 && (
            <select className="input sm pb-apply" aria-label="Apply a style preset" disabled={target.disabled} value="" onChange={(e) => e.target.value && target.setPresets?.([...applied, e.target.value])}>
              <option value="">+ Apply preset…</option>
              {available.map(([n, p]) => (
                <option key={n} value={n}>
                  {p.label ?? n}
                </option>
              ))}
            </select>
          )}
          {!applied.length && !available.length && <span className="muted small">None yet</span>}
        </div>
      </div>
      {creating ? (
        <form className="pb-create" onSubmit={create}>
          <input ref={inputRef} className="input sm" aria-label="New preset name" placeholder="Preset name, e.g. Soft card" value={label} onChange={(e) => setLabel(e.target.value)} />
          <button className="btn sm primary" disabled={!label.trim() || busy}>
            Create
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="pb-actions">
          <button type="button" className="btn sm" disabled={target.disabled || !canDesign || !hasAnyStyle(target.data as PageNode)} title="Move this element’s styles into a reusable site preset" onClick={() => setCreating(true)}>
            <Icon name="plus" size={12} /> Create preset from style
          </button>
          <button type="button" className="icon-btn sm" title="Copy style" aria-label="Copy style" onClick={copy}>
            <Icon name="copy" size={14} />
          </button>
          <button type="button" className="icon-btn sm" title="Paste style (replaces this element’s styles)" aria-label="Paste style" disabled={target.disabled} onClick={paste}>
            <Icon name="paste" size={14} />
          </button>
        </div>
      )}
      <div className="pb-row">
        <label className="pb-title" htmlFor={`${uid}-cls`}>
          <Icon name="code" size={13} /> Classes
        </label>
        <input id={`${uid}-cls`} className="input sm mono" placeholder="custom-class other-class" value={classText} disabled={target.disabled} onChange={(e) => setClassText(e.target.value)} {...ch} />
      </div>
    </div>
  );
}

/** Inspector body while a site preset is being edited. */
export function PresetEditor({ name }: { name: string }) {
  const preset = useStore(editor, (s) => s.runtime?.stylePresets?.[name]);
  const canDesign = useStore(editor, (s) => !!s.runtime && (s.runtime.user.isSuperadmin || s.runtime.user.permissions.some((p) => p === '*' || p === 'core.design')));
  const usage = useStore(editor, (s) => {
    let n = 0;
    const rec = (x: PageNode | null | undefined) => {
      if (!x) return;
      if (x.presets?.includes(name)) n++;
      Object.values(x.slots ?? {}).forEach((k) => k.forEach(rec));
    };
    rec(s.tree);
    rec(s.layout?.tree);
    return n;
  });
  const target = useMemo(() => (preset ? presetTarget(name, preset, !canDesign) : null), [name, preset, canDesign]);
  if (!preset || !target)
    return (
      <div className="insp-empty">
        <p>This preset no longer exists.</p>
        <button className="btn" onClick={() => editor.set({ editingPreset: null })}>
          Done
        </button>
      </div>
    );
  return (
    <div className="insp">
      <header className="insp-head">
        <div className="insp-title">
          <span className="insp-icon preset">
            <Icon name="tag" size={16} />
          </span>
          <div>
            <h2>Preset: {preset.label ?? name}</h2>
            <p className="muted small">
              .s-{name} · used by {usage} element{usage === 1 ? '' : 's'} here
            </p>
          </div>
          <button className="btn sm primary" onClick={() => editor.set({ editingPreset: null })}>
            Done
          </button>
        </div>
        <p className="note">Changes apply to every element using this preset, on every page. Element styles still override the preset.</p>
      </header>
      <div className="insp-body">
        <StylePanel target={target} />
      </div>
    </div>
  );
}
