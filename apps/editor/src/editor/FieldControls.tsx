import { memo, useEffect, useMemo, useState } from 'react';
import type { Field, FieldMap, ListField, NumberField, SelectField, TokenGroup } from '@modulo/core';
import { get, sitePath } from '../api.ts';
import { coerceNumber, fieldSpecs, fieldValue, listItemLabel, moveItem, newListItem, type FieldSpec } from '../lib/fields.ts';
import { useStore } from '../lib/store.ts';
import { Row, Segmented, Switch, TextInput, useLocalValue, useUid } from '../ui/controls.tsx';
import { Icon } from '../ui/Icon.tsx';
import { MediaPicker } from './MediaPicker.tsx';
import { RichText } from './RichText.tsx';
import { actions, editor } from './state.ts';

export interface ControlProps<V = unknown> {
  id: string;
  label: string;
  value: V;
  onChange: (v: V) => void;
  disabled?: boolean;
}

/* ───────── token picker (colors as swatches, others as a select with previews) ───────── */

export function TokenPicker({ group, value, onChange, label, id, disabled, inherited }: { group: TokenGroup; value: string | undefined; onChange: (v: string) => void; label: string; id?: string; disabled?: boolean; inherited?: string }) {
  const options = useStore(editor, (s) => s.runtime?.tokens[group] ?? []);
  if (group === 'color') {
    return (
      <div className="swatches" role="radiogroup" aria-label={label} id={id}>
        <button type="button" role="radio" aria-checked={!value} className={`swatch none${!value ? ' active' : ''}`} title={inherited ? `Default (${inherited.split('.').pop()})` : 'Default'} aria-label="Default" disabled={disabled} onClick={() => onChange('')}>
          <Icon name="x" size={12} />
        </button>
        {options.map((o) => (
          <button
            type="button"
            key={o.value}
            role="radio"
            aria-checked={value === o.value}
            aria-label={o.label}
            title={`${o.label} · ${o.preview}`}
            disabled={disabled}
            className={`swatch${value === o.value ? ' active' : ''}`}
            style={{ background: o.preview }}
            onClick={() => onChange(o.value)}
          />
        ))}
      </div>
    );
  }
  return (
    <select id={id} className="input" value={value ?? ''} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      <option value="">{inherited ? `Default (${inherited.split('.').pop()})` : 'Default'}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label} — {o.preview.length > 28 ? o.preview.slice(0, 28) + '…' : o.preview}
        </option>
      ))}
      {value && !options.some((o) => o.value === value) && <option value={value}>{value}</option>}
    </select>
  );
}

/* ───────── individual controls ───────── */

function NumberControl({ id, label, value, onChange, disabled, field, slider }: ControlProps<number | undefined> & { field: NumberField; slider: boolean }) {
  const [v, set, h] = useLocalValue(value === undefined ? '' : String(value), (s) => {
    const n = coerceNumber(s, field);
    if (n !== undefined) onChange(n);
  });
  return (
    <div className="number-row">
      {slider && <input type="range" aria-label={`${label} slider`} min={field.min} max={field.max} step={field.step ?? 1} value={value ?? field.min ?? 0} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} />}
      <input id={id} className="input num" type="number" min={field.min} max={field.max} step={field.step ?? 1} value={v} disabled={disabled} onChange={(e) => set(e.target.value)} {...h} />
    </div>
  );
}

function ColorControl({ id, label, value, onChange, disabled }: ControlProps<string>) {
  const hex = /^#[0-9a-f]{6}$/i.test(value ?? '') ? value : '#000000';
  return (
    <div className="color-row">
      <input type="color" aria-label={`${label} picker`} value={hex} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      <TextInput id={id} value={value ?? ''} onChange={onChange} placeholder="#2f5bea" disabled={disabled} />
    </div>
  );
}

export function ImageControl({ id, label, value, onChange, disabled }: ControlProps<string>) {
  const [open, setOpen] = useState(false);
  return (
    <div className="image-control">
      <button type="button" className={`image-preview${value ? '' : ' empty'}`} onClick={() => setOpen(true)} disabled={disabled} aria-label={value ? `Change ${label}` : `Choose ${label}`}>
        {value ? <img src={value} alt="" /> : <Icon name="image" size={22} />}
        <span>{value ? 'Replace' : 'Choose image'}</span>
      </button>
      <div className="image-actions">
        <TextInput id={id} value={value ?? ''} onChange={onChange} placeholder="Image URL" label={`${label} URL`} disabled={disabled} />
        {value && (
          <button type="button" className="icon-btn" aria-label={`Remove ${label}`} title="Remove" disabled={disabled} onClick={() => onChange('')}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </div>
      {open && (
        <MediaPicker
          onClose={() => setOpen(false)}
          onPick={(a) => {
            onChange(a.url);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function LinkControl({ id, label, value, onChange, disabled }: ControlProps<string>) {
  const pages = useStore(editor, (s) => s.pages);
  const match = pages.find((p) => p.path === value);
  return (
    <div className="link-control">
      <TextInput id={id} value={value ?? ''} onChange={onChange} placeholder="https://… or /path" label={label} disabled={disabled} />
      <select className="input" aria-label={`${label}: link to a page`} value={match ? match.path : ''} disabled={disabled} onChange={(e) => e.target.value && onChange(e.target.value)}>
        <option value="">Link to page…</option>
        {pages.map((p) => (
          <option key={p.id} value={p.path}>
            {p.title} ({p.path})
          </option>
        ))}
      </select>
    </div>
  );
}

function CollectionControl({ id, label, value, onChange, disabled, model }: ControlProps<string> & { model?: string }) {
  const site = useStore(editor, (s) => s.site);
  const [items, setItems] = useState<{ id: string; title: string }[] | null>(null);
  useEffect(() => {
    if (!model) return;
    let off = false;
    Promise.all([actions.loadModels().catch(() => []), get<{ items: any[] }>(sitePath(site, `/data/${encodeURIComponent(model)}?limit=200`))])
      .then(([models, r]) => {
        const m = models.find((x) => x.name === model);
        const tf = m?.titleField ?? Object.keys(m?.fields ?? {}).find((k) => ['title', 'name', 'label'].includes(k)) ?? 'id';
        if (!off) setItems(r.items.map((it) => ({ id: String(it.id), title: String(it[tf] ?? it.id) })));
      })
      .catch(() => !off && setItems([]));
    return () => void (off = true);
  }, [model, site]);
  if (!model) return <TextInput id={id} value={value ?? ''} onChange={onChange} label={label} disabled={disabled} placeholder="Record id" />;
  return (
    <select id={id} className="input" value={value ?? ''} disabled={disabled || !items} onChange={(e) => onChange(e.target.value)}>
      <option value="">{items ? 'Choose a record…' : 'Loading…'}</option>
      {items?.map((it) => (
        <option key={it.id} value={it.id}>
          {it.title}
        </option>
      ))}
    </select>
  );
}

function ListControl({ label, value, onChange, disabled, field }: ControlProps<Record<string, unknown>[]> & { field: ListField }) {
  const items = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState<number | null>(items.length === 1 ? 0 : null);
  const update = (i: number, key: string, v: unknown) => onChange(items.map((it, j) => (j === i ? { ...it, [key]: v } : it)));
  return (
    <div className="list-control">
      <ul className="list-items" aria-label={label}>
        {items.map((it, i) => {
          const isOpen = open === i;
          return (
            <li key={i} className={`list-item${isOpen ? ' open' : ''}`}>
              <div className="list-item-head">
                <button type="button" className="list-item-toggle" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : i)}>
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={14} />
                  <span>{listItemLabel(it, field.of, field.itemLabel, i)}</span>
                </button>
                <button type="button" className="icon-btn sm" aria-label={`Move item ${i + 1} up`} disabled={disabled || i === 0} onClick={() => (onChange(moveItem(items, i, i - 1)), setOpen(open === i ? i - 1 : open))}>
                  <Icon name="arrow-up" size={13} />
                </button>
                <button type="button" className="icon-btn sm" aria-label={`Move item ${i + 1} down`} disabled={disabled || i === items.length - 1} onClick={() => (onChange(moveItem(items, i, i + 1)), setOpen(open === i ? i + 1 : open))}>
                  <Icon name="arrow-down" size={13} />
                </button>
                <button type="button" className="icon-btn sm danger" aria-label={`Remove item ${i + 1}`} disabled={disabled} onClick={() => (onChange(items.filter((_, j) => j !== i)), setOpen(null))}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
              {isOpen && (
                <div className="list-item-body">
                  <FieldList fields={field.of} props={it} onChange={(k, v) => update(i, k, v)} disabled={disabled} idPrefix={`li${i}`} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn sm add-item"
        disabled={disabled}
        onClick={() => {
          onChange([...items, newListItem(field.of)]);
          setOpen(items.length);
        }}
      >
        <Icon name="plus" size={14} /> Add {field.itemLabel ? 'item' : (field.label ?? 'item').toLowerCase().replace(/s$/, '')}
      </button>
    </div>
  );
}

/* ───────── dispatcher ───────── */

export const FieldControl = memo(function FieldControl({ spec, value, onChange, disabled, idPrefix, first }: { spec: FieldSpec; value: unknown; onChange: (key: string, v: unknown) => void; disabled?: boolean; idPrefix: string; first?: boolean }) {
  const id = `${idPrefix}-${spec.key}`;
  const f: Field = spec.field;
  const set = (v: unknown) => onChange(spec.key, v);
  const common = { id, label: spec.label, disabled };
  let control: React.ReactNode;
  switch (spec.control) {
    case 'text':
      control = <TextInput {...common} value={String(value ?? '')} onChange={set} placeholder={(f as any).placeholder} />;
      break;
    case 'textarea':
      control = <TextInput {...common} multiline rows={(f as any).rows ?? 3} value={String(value ?? '')} onChange={set} />;
      break;
    case 'richtext':
      control = <RichText {...common} value={String(value ?? '')} onChange={set} />;
      break;
    case 'number':
    case 'slider':
      control = <NumberControl {...common} value={value as number | undefined} onChange={set} field={f as NumberField} slider={spec.control === 'slider'} />;
      break;
    case 'switch':
      return (
        <div className="row row-inline" data-first-field={first || undefined}>
          <label className="row-label" htmlFor={id}>
            {spec.label}
          </label>
          <Switch id={id} label={spec.label} checked={!!value} onChange={set} disabled={disabled} />
          {f.help && <p className="row-help">{f.help}</p>}
        </div>
      );
    case 'segmented':
      control = <Segmented label={spec.label} value={String(value ?? '')} options={(f as SelectField).options.map((o) => ({ value: o.value, label: o.label }))} onChange={set} disabled={disabled} />;
      break;
    case 'select':
      control = (
        <select id={id} className="input" value={String(value ?? '')} disabled={disabled} onChange={(e) => set(e.target.value)}>
          {(f as SelectField).options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'swatches':
    case 'token-select':
      control = <TokenPicker {...common} group={(f as any).group} value={(value as string) || ''} onChange={set} />;
      break;
    case 'image':
      control = <ImageControl {...common} value={String(value ?? '')} onChange={set} />;
      break;
    case 'link':
      control = <LinkControl {...common} value={String(value ?? '')} onChange={set} />;
      break;
    case 'color':
      control = <ColorControl {...common} value={String(value ?? '')} onChange={set} />;
      break;
    case 'list':
      control = <ListControl {...common} value={value as Record<string, unknown>[]} onChange={set} field={f as ListField} />;
      break;
    case 'collection':
      control = <CollectionControl {...common} value={String(value ?? '')} onChange={set} model={(f as any).model} />;
      break;
  }
  return (
    <div data-first-field={first || undefined}>
      <Row label={spec.label} help={f.help} htmlFor={id}>
        {control}
      </Row>
    </div>
  );
});

/** Auto-generated form for a FieldMap. */
export function FieldList({ fields, props, onChange, disabled, idPrefix }: { fields: FieldMap; props: Record<string, unknown>; onChange: (key: string, v: unknown) => void; disabled?: boolean; idPrefix?: string }) {
  const uid = useUid(idPrefix ?? 'fld');
  const specs = useMemo(() => fieldSpecs(fields), [fields]);
  if (!specs.length) return <p className="muted small">This block has no settings.</p>;
  return (
    <div className="field-list">
      {specs.map((s, i) => (
        <FieldControl key={s.key} spec={s} value={fieldValue(s.field, props, s.key)} onChange={onChange} disabled={disabled} idPrefix={uid} first={i === 0} />
      ))}
    </div>
  );
}
