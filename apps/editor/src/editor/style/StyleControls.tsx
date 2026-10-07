import { useState, type ReactNode } from 'react';
import type { StyleCatalogEntry } from '../../types.ts';
import { normalizeLength, parseLength, tokenLabel } from '../../lib/style.ts';
import { useStore } from '../../lib/store.ts';
import { useLocalValue } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { MediaPicker } from '../MediaPicker.tsx';
import { editor } from '../state.ts';

/**
 * Inputs for one style property. Every control reports raw strings through
 * `commit`; the row validates (compileDecl) and writes. `undefined` = reset.
 */
export interface StyleControlProps {
  prop: StyleCatalogEntry;
  id: string;
  value: string | undefined;
  /** Inherited value shown as a placeholder. */
  placeholder?: string;
  commit: (v: string | undefined) => void;
  disabled?: boolean;
}

function useTokens(group: string | undefined) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStore(editor, (s) => (group ? ((s.runtime?.tokens as any)?.[group] ?? []) : [])) as { value: string; label: string; preview: string }[];
}

/* ───────── length: number + unit + token + keywords ───────── */

export function LengthControl({ prop, id, value, placeholder, commit, disabled }: StyleControlProps) {
  const options = useTokens(prop.token);
  const isToken = !!tokenLabel(value);
  const parsed = parseLength(value);
  const units = (prop.units ?? ['px']).filter((u, i, a) => a.indexOf(u) === i);
  const [pendingUnit, setPendingUnit] = useState<string | undefined>(undefined);
  const unit = value === 'auto' ? 'auto' : parsed ? parsed.unit : (pendingUnit ?? '');
  const [text, setText, h] = useLocalValue(isToken ? '' : (value ?? ''), (t: string) => {
    const v = normalizeLength(t, units, parsed?.unit ?? pendingUnit);
    commit(v || undefined);
  });
  const ph = placeholder ? (tokenLabel(placeholder) ?? placeholder) : (prop.placeholder ?? (isToken ? '' : '—'));
  return (
    <div className="sc-length">
      {isToken ? (
        <button type="button" className="sc-token-chip" disabled={disabled} title="Design token: click to type a custom value" onClick={() => commit(undefined)}>
          <span>{tokenLabel(value)}</span>
          <Icon name="x" size={11} />
        </button>
      ) : (
        <input
          id={id}
          className="input sc-num"
          value={text}
          placeholder={ph}
          disabled={disabled}
          inputMode="decimal"
          aria-label={prop.label}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
            const p = parseLength(value ?? placeholder);
            if (!p) return;
            e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1) * (['em', 'rem', ''].includes(p.unit) ? 0.1 : 1);
            const n = Math.round((Number(p.num) + step) * 100) / 100;
            commit(`${n}${n === 0 && p.unit !== '' ? '' : p.unit}` || '0');
          }}
          {...h}
        />
      )}
      {units.length > 0 && !isToken && (
        <select
          className="input sc-unit"
          aria-label={`${prop.label} unit`}
          disabled={disabled}
          value={units.includes(unit) ? unit : ''}
          onChange={(e) => {
            const u = e.target.value;
            if (u === 'auto') return commit('auto');
            setPendingUnit(u);
            if (parsed) commit(`${parsed.num}${u}`);
          }}
        >
          {!units.includes(unit) && <option value="">{unit || '—'}</option>}
          {units.map((u) => (
            <option key={u || 'none'} value={u}>
              {u || '—'}
            </option>
          ))}
        </select>
      )}
      {options.length > 0 && (
        <select className="input sc-token" aria-label={`${prop.label} token`} title="Design tokens" disabled={disabled} value={isToken ? value : ''} onChange={(e) => e.target.value && commit(e.target.value)}>
          <option value="">{isToken ? '—' : 'Token'}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label} · {o.preview}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/* ───────── color: token swatches + native picker + free text (gradients ok) ───────── */

function toHex(v: string | undefined): string {
  if (!v) return '#000000';
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) return '#' + v.slice(1).split('').map((c) => c + c).join('');
  return '#000000';
}

export function ColorControl({ prop, id, value, placeholder, commit, disabled }: StyleControlProps) {
  const options = useTokens(prop.token ?? 'color');
  const isToken = !!tokenLabel(value);
  const [text, setText, h] = useLocalValue(isToken ? '' : (value ?? ''), (t: string) => commit(t.trim() || undefined));
  const tokenPreview = isToken ? options.find((o) => o.value === value)?.preview : undefined;
  return (
    <div className="sc-color">
      <div className="sc-swatches" role="radiogroup" aria-label={`${prop.label} tokens`}>
        {options.map((o) => (
          <button
            type="button"
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.label}
            title={`${o.label} · ${o.preview}`}
            disabled={disabled}
            className={`sc-swatch${value === o.value ? ' active' : ''}`}
            style={{ background: o.preview }}
            onClick={() => commit(value === o.value ? undefined : o.value)}
          />
        ))}
      </div>
      <div className="sc-color-row">
        <input type="color" aria-label={`${prop.label} picker`} value={toHex(tokenPreview ?? value)} disabled={disabled} onChange={(e) => commit(e.target.value)} />
        {isToken ? (
          <button type="button" className="sc-token-chip grow" disabled={disabled} onClick={() => commit(undefined)} title="Remove token">
            <i style={{ background: tokenPreview }} />
            <span>{tokenLabel(value)}</span>
            <Icon name="x" size={11} />
          </button>
        ) : (
          <input id={id} className="input" value={text} disabled={disabled} aria-label={prop.label} placeholder={placeholder ? (tokenLabel(placeholder) ?? placeholder) : (prop.placeholder ?? '#hex, rgba(), gradient')} onChange={(e) => setText(e.target.value)} {...h} />
        )}
      </div>
    </div>
  );
}

/* ───────── segmented buttons (with visual icons for flex/grid alignment) ───────── */

const SEG_ICONS: Record<string, Record<string, string>> = {
  direction: { row: 'M4 12h14M14 8l4 4-4 4', column: 'M12 4v14M8 14l4 4 4-4', 'row-reverse': 'M20 12H6M10 8l-4 4 4 4', 'column-reverse': 'M12 20V6M8 10l4-4 4 4' },
  justify: {
    start: 'M4 4v16M7 8h4v8H7zM13 8h4v8h-4z',
    center: 'M12 4v16M5 8h4v8H5zM15 8h4v8h-4z',
    end: 'M20 4v16M7 8h4v8H7zM13 8h4v8h-4z',
    between: 'M3 4v16M21 4v16M5 8h4v8H5zM15 8h4v8h-4z',
    around: 'M3 4v16M21 4v16M6 8h3v8H6zM15 8h3v8h-3z',
    evenly: 'M3 4v16M21 4v16M7 8h3v8H7zM14 8h3v8h-3z',
    stretch: 'M3 4v16M21 4v16M5 8h6v8H5zM13 8h6v8h-6z',
  },
  items: {
    stretch: 'M4 3h16M4 21h16M6 5h4v14H6zM14 5h4v14h-4z',
    start: 'M4 4h16M6 6h4v10H6zM14 6h4v6h-4z',
    center: 'M4 12h16M6 6h4v12H6zM14 9h4v6h-4z',
    end: 'M4 20h16M6 8h4v10H6zM14 12h4v6h-4z',
    baseline: 'M4 13h16M6 6h4v10H6zM14 9h4v6h-4z',
  },
  alignSelf: { auto: 'M4 12h16', start: 'M4 4h16M9 6h6v8H9z', center: 'M4 12h16M9 7h6v10H9z', end: 'M4 20h16M9 10h6v8H9z', stretch: 'M4 3h16M4 21h16M9 5h6v14H9z' },
  align: { left: 'M4 6h16M4 10h10M4 14h16M4 18h10', center: 'M4 6h16M7 10h10M4 14h16M7 18h10', right: 'M4 6h16M10 10h10M4 14h16M10 18h10', justify: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
};

function SegIcon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function SegmentedControl({ prop, value, placeholder, commit, disabled }: StyleControlProps) {
  const icons = SEG_ICONS[prop.key];
  const opts = prop.options ?? [];
  return (
    <div className={`sc-seg${icons ? ' icons' : ''}`} role="radiogroup" aria-label={prop.label}>
      {opts.map((o) => {
        const active = value === o.value;
        const inherited = !value && placeholder === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={icons ? `${prop.label}: ${o.label}` : undefined}
            title={active ? `${o.label} (click again to reset)` : o.label}
            disabled={disabled}
            className={`${active ? 'active' : ''}${inherited ? ' inherited' : ''}`}
            onClick={() => commit(active ? undefined : o.value)}
          >
            {icons?.[o.value] ? <SegIcon d={icons[o.value]!} /> : o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SelectControl({ prop, id, value, placeholder, commit, disabled }: StyleControlProps) {
  const opts = prop.options ?? [];
  return (
    <select id={id} className="input" value={value ?? ''} disabled={disabled} aria-label={prop.label} onChange={(e) => commit(e.target.value || undefined)}>
      <option value="">{placeholder ? `— (${opts.find((o) => o.value === placeholder)?.label ?? placeholder})` : '—'}</option>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {value && !opts.some((o) => o.value === value) && <option value={value}>{value}</option>}
    </select>
  );
}

export function TextControl({ prop, id, value, placeholder, commit, disabled, mono }: StyleControlProps & { mono?: boolean }) {
  const [text, setText, h] = useLocalValue(value ?? '', (t: string) => commit(t.trim() || undefined));
  return <input id={id} className={`input${mono ? ' mono' : ''}`} value={text} disabled={disabled} aria-label={prop.label} placeholder={placeholder ?? prop.placeholder ?? ''} onChange={(e) => setText(e.target.value)} {...h} />;
}

export function NumberControl(p: StyleControlProps) {
  return <TextControl {...p} />;
}

/** Token choice (shadow / font) + free text. */
export function TokenTextControl({ prop, id, value, placeholder, commit, disabled, group }: StyleControlProps & { group: string }) {
  const options = useTokens(prop.token ?? group);
  const isToken = !!tokenLabel(value);
  const [text, setText, h] = useLocalValue(isToken ? '' : (value ?? ''), (t: string) => commit(t.trim() || undefined));
  return (
    <div className="sc-stack">
      {options.length > 0 && (
        <select className="input" aria-label={`${prop.label} token`} disabled={disabled} value={isToken ? value : ''} onChange={(e) => commit(e.target.value || undefined)} style={group === 'font' && isToken ? { fontFamily: options.find((o) => o.value === value)?.preview } : undefined}>
          <option value="">{isToken ? '—' : placeholder ? `— (${tokenLabel(placeholder) ?? placeholder})` : 'Choose…'}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value} style={group === 'font' ? { fontFamily: o.preview } : undefined}>
              {o.label} · {o.preview.length > 30 ? o.preview.slice(0, 30) + '…' : o.preview}
            </option>
          ))}
        </select>
      )}
      {!isToken && <input id={id} className="input" value={text} disabled={disabled} aria-label={`${prop.label} (custom)`} placeholder={group === 'font' ? 'Custom font stack' : (prop.placeholder ?? '0 4px 12px rgba(0,0,0,.15)')} onChange={(e) => setText(e.target.value)} {...h} />}
    </div>
  );
}

const TRACK_TEMPLATES = ['1fr 2fr', '2fr 1fr', '1fr 1fr 2fr', 'repeat(auto-fit,minmax(220px,1fr))', 'repeat(auto-fill,minmax(160px,1fr))'];

export function TracksControl({ prop, id, value, placeholder, commit, disabled }: StyleControlProps) {
  const [text, setText, h] = useLocalValue(value ?? '', (t: string) => commit(t.trim() || undefined));
  const isRows = prop.key === 'rows';
  return (
    <div className="sc-stack">
      <div className="sc-seg" role="radiogroup" aria-label={`${prop.label}: equal tracks`}>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === String(n)} className={value === String(n) ? 'active' : !value && placeholder === String(n) ? 'inherited' : ''} disabled={disabled} title={`${n} equal ${isRows ? 'rows' : 'columns'}`} onClick={() => commit(value === String(n) ? undefined : String(n))}>
            {n}
          </button>
        ))}
      </div>
      <div className="sc-inline">
        <input id={id} className="input mono" value={text} disabled={disabled} aria-label={`${prop.label} template`} placeholder={placeholder ?? prop.placeholder} onChange={(e) => setText(e.target.value)} {...h} />
        {!isRows && (
          <select className="input sc-unit" aria-label={`${prop.label} templates`} disabled={disabled} value="" onChange={(e) => e.target.value && commit(e.target.value)}>
            <option value="">Templates</option>
            {TRACK_TEMPLATES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

export function ImageStyleControl({ prop, id, value, placeholder, commit, disabled }: StyleControlProps) {
  const [open, setOpen] = useState(false);
  const [text, setText, h] = useLocalValue(value ?? '', (t: string) => commit(t.trim() || undefined));
  return (
    <div className="sc-stack">
      <div className="sc-inline">
        <button type="button" className={`sc-thumb${value ? '' : ' empty'}`} disabled={disabled} onClick={() => setOpen(true)} aria-label={value ? `Change ${prop.label}` : `Choose ${prop.label}`} title="Choose from media library">
          {value && value !== 'none' ? <img src={value} alt="" /> : <Icon name="image" size={16} />}
        </button>
        <input id={id} className="input" value={text} disabled={disabled} aria-label={`${prop.label} URL`} placeholder={placeholder ?? 'https://… or /media/…'} onChange={(e) => setText(e.target.value)} {...h} />
      </div>
      {open && (
        <MediaPicker
          onClose={() => setOpen(false)}
          onPick={(a) => {
            commit(a.url);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** Dispatcher by catalog control kind. */
export function StyleControl(p: StyleControlProps): ReactNode {
  switch (p.prop.control) {
    case 'length':
      return <LengthControl {...p} />;
    case 'color':
      return <ColorControl {...p} />;
    case 'segmented':
      return <SegmentedControl {...p} />;
    case 'select':
      return <SelectControl {...p} />;
    case 'number':
      return <NumberControl {...p} />;
    case 'image':
      return <ImageStyleControl {...p} />;
    case 'shadow':
      return <TokenTextControl {...p} group="shadow" />;
    case 'font':
      return <TokenTextControl {...p} group="font" />;
    case 'tracks':
      return <TracksControl {...p} />;
    default:
      return <TextControl {...p} mono={['border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'outline', 'transform', 'filter', 'backdropFilter'].includes(p.prop.key)} />;
  }
}
