import { useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../../api.ts';
import { presetNameFrom } from '../../lib/style.ts';
import { humanize } from '../../lib/fields.ts';
import { useStore } from '../../lib/store.ts';
import type { Theme } from '../../types.ts';
import { useUid } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { actions, editor } from '../state.ts';

const FONT_PRESETS: { label: string; value: string }[] = [
  { label: 'System UI', value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
  { label: 'Humanist sans', value: '"Seravek", "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif' },
  { label: 'Geometric sans', value: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif' },
  { label: 'Transitional serif', value: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif' },
  { label: 'Old style serif', value: '"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, serif' },
  { label: 'Monospace', value: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
];

const GROUPS: { key: keyof Theme; label: string; hint: string }[] = [
  { key: 'color', label: 'Colors', hint: 'Brand and surface colors used by every block.' },
  { key: 'font', label: 'Fonts', hint: 'Font stacks for body text and headings.' },
  { key: 'fontSize', label: 'Type scale', hint: 'Sizes available to text and headings.' },
  { key: 'space', label: 'Spacing', hint: 'Padding, margins and gaps.' },
  { key: 'radius', label: 'Corner radius', hint: 'Rounded corners on cards, buttons and images.' },
  { key: 'shadow', label: 'Shadows', hint: 'Elevation for cards and popovers.' },
];

function toHex(v: string): string {
  return /^#[0-9a-f]{6}$/i.test(v) ? v : /^#[0-9a-f]{3}$/i.test(v) ? '#' + v.slice(1).split('').map((c) => c + c).join('') : '#000000';
}

export function ThemePanel() {
  const runtimeTheme = useStore(editor, (s) => s.runtime?.theme ?? null);
  const canDesign = useStore(editor, (s) => !!s.runtime && (s.runtime.user.isSuperadmin || s.runtime.user.permissions.some((p) => p === '*' || p === 'core.design')));
  const [theme, setTheme] = useState<Theme | null>(runtimeTheme);
  const [open, setOpen] = useState<string>('color');
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uid = useUid('th');
  useEffect(() => {
    if (!timer.current) setTheme(runtimeTheme);
  }, [runtimeTheme]);

  const update = (group: keyof Theme, name: string, value: string) => {
    if (!theme) return;
    const next = { ...theme, [group]: { ...theme[group], [name]: value } } as Theme;
    setTheme(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      setSaving(true);
      try {
        await actions.saveTheme(next as any);
      } catch (e) {
        toast.error(`Theme not saved: ${errorMessage(e)}`);
      } finally {
        setSaving(false);
      }
    }, 450);
  };

  if (!theme) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title-row">
          <h2>Theme</h2>
          <span className="muted small" aria-live="polite">
            {saving ? 'Saving…' : ''}
          </span>
        </div>
        <p className="muted small">Design tokens restyle the whole site instantly — no page edits needed.</p>
        {!canDesign && <p className="note">You need the “Edit theme and layout” permission to change the theme.</p>}
      </div>
      <div className="panel-body">
        {GROUPS.map((g) => (
          <section key={g.key} className={`accordion${open === g.key ? ' open' : ''}`}>
            <h3>
              <button aria-expanded={open === g.key} onClick={() => setOpen(open === g.key ? '' : g.key)}>
                <Icon name={open === g.key ? 'chevron-down' : 'chevron-right'} size={14} />
                {g.label}
                {g.key === 'color' && (
                  <span className="mini-swatches" aria-hidden="true">
                    {Object.values(theme.color).slice(0, 6).map((c, i) => (
                      <i key={i} style={{ background: c }} />
                    ))}
                  </span>
                )}
              </button>
            </h3>
            {open === g.key && (
              <div className="accordion-body">
                <p className="muted small">{g.hint}</p>
                {Object.entries(theme[g.key] ?? {}).map(([name, value]) => {
                  const id = `${uid}-${g.key}-${name}`;
                  return (
                    <div key={name} className="token-row">
                      <label htmlFor={id}>{humanize(name)}</label>
                      {g.key === 'color' ? (
                        <div className="color-row">
                          <input type="color" aria-label={`${humanize(name)} color picker`} value={toHex(value)} disabled={!canDesign} onChange={(e) => update(g.key, name, e.target.value)} />
                          <input id={id} className="input" value={value} disabled={!canDesign} onChange={(e) => update(g.key, name, e.target.value)} />
                        </div>
                      ) : g.key === 'font' ? (
                        <div className="font-row">
                          <select className="input" aria-label={`${humanize(name)} preset`} disabled={!canDesign} value={FONT_PRESETS.find((f) => f.value === value)?.value ?? ''} onChange={(e) => e.target.value && update(g.key, name, e.target.value)}>
                            <option value="">Custom…</option>
                            {FONT_PRESETS.map((f) => (
                              <option key={f.label} value={f.value}>
                                {f.label}
                              </option>
                            ))}
                          </select>
                          <input id={id} className="input" style={{ fontFamily: value }} value={value} disabled={!canDesign} onChange={(e) => update(g.key, name, e.target.value)} />
                        </div>
                      ) : (
                        <div className="token-value">
                          <input id={id} className="input" value={value} disabled={!canDesign} onChange={(e) => update(g.key, name, e.target.value)} />
                          {g.key === 'fontSize' && <span className="token-preview" style={{ fontSize: value }}>Aa</span>}
                          {g.key === 'radius' && <span className="token-preview box" style={{ borderRadius: value }} />}
                          {g.key === 'shadow' && <span className="token-preview box" style={{ boxShadow: value }} />}
                          {g.key === 'space' && <span className="token-preview bar" style={{ width: value }} />}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))}
        <section className={`accordion${open === 'presets' ? ' open' : ''}`}>
          <h3>
            <button aria-expanded={open === 'presets'} onClick={() => setOpen(open === 'presets' ? '' : 'presets')}>
              <Icon name={open === 'presets' ? 'chevron-down' : 'chevron-right'} size={14} />
              Style presets
            </button>
          </h3>
          {open === 'presets' && (
            <div className="accordion-body">
              <StylePresetsManager canDesign={canDesign} />
            </div>
          )}
        </section>
        <section className={`accordion${open === 'css' ? ' open' : ''}`}>
          <h3>
            <button aria-expanded={open === 'css'} onClick={() => setOpen(open === 'css' ? '' : 'css')}>
              <Icon name={open === 'css' ? 'chevron-down' : 'chevron-right'} size={14} />
              Custom CSS
            </button>
          </h3>
          {open === 'css' && (
            <div className="accordion-body">
              <CustomCssEditor canDesign={canDesign} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ───────── style presets (site "classes") ───────── */

function StylePresetsManager({ canDesign }: { canDesign: boolean }) {
  const presets = useStore(editor, (s) => s.runtime?.stylePresets ?? {});
  const editing = useStore(editor, (s) => s.editingPreset);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const entries = Object.entries(presets);
  const save = (next: typeof presets, immediate = false) => actions.saveStylePresets(next, immediate).catch(() => {});
  return (
    <div className="presets-manager">
      <p className="muted small">Reusable named styles. Apply them to any element from the Style tab; editing a preset restyles every element that uses it.</p>
      {entries.length === 0 && <p className="muted small">No presets yet. Select an element, style it, then use “Create preset from style”.</p>}
      <ul className="preset-list">
        {entries.map(([name, p]) => {
          const n = Object.keys(p.style ?? {}).length + Object.values(p.responsive ?? {}).reduce((a, x) => a + Object.keys(x ?? {}).length, 0) + Object.values(p.states ?? {}).reduce((a, x) => a + Object.keys(x ?? {}).length, 0);
          return (
            <li key={name} className={`preset-item${editing === name ? ' active' : ''}`} data-preset={name}>
              <input
                className="input sm"
                aria-label={`Label of preset ${name}`}
                defaultValue={p.label ?? name}
                disabled={!canDesign}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== p.label) save({ ...presets, [name]: { ...p, label: v } }, true);
                }}
              />
              <span className="preset-meta muted small">
                <code>.s-{name}</code> · {n} value{n === 1 ? '' : 's'}
              </span>
              <button className="icon-btn sm" aria-label={`Edit preset ${p.label ?? name}`} title="Edit styles" disabled={!canDesign} onClick={() => editor.set({ editingPreset: name })}>
                <Icon name="edit" size={13} />
              </button>
              {confirm === name ? (
                <button
                  className="btn sm danger"
                  onClick={() => {
                    const rest = { ...presets };
                    delete rest[name];
                    if (editing === name) editor.set({ editingPreset: null });
                    setConfirm(null);
                    save(rest, true);
                  }}
                >
                  Delete?
                </button>
              ) : (
                <button className="icon-btn sm danger" aria-label={`Delete preset ${p.label ?? name}`} disabled={!canDesign} onClick={() => setConfirm(name)}>
                  <Icon name="trash" size={13} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <form
        className="pb-create"
        onSubmit={(e) => {
          e.preventDefault();
          const label = newLabel.trim();
          if (!label) return;
          const name = presetNameFrom(label, Object.keys(presets));
          save({ ...presets, [name]: { label, style: {} } }, true).then(() => editor.set({ editingPreset: name }));
          setNewLabel('');
        }}
      >
        <input className="input sm" aria-label="New preset name" placeholder="New preset name" value={newLabel} disabled={!canDesign} onChange={(e) => setNewLabel(e.target.value)} />
        <button className="btn sm" disabled={!canDesign || !newLabel.trim()}>
          <Icon name="plus" size={12} /> Add
        </button>
      </form>
    </div>
  );
}

/* ───────── custom CSS ───────── */

const CSS_PLACEHOLDER = '.brand-glow {\n  box-shadow: 0 0 40px #2f5bea55;\n}';

function CustomCssEditor({ canDesign }: { canDesign: boolean }) {
  const saved = useStore(editor, (s) => s.runtime?.customCss ?? '');
  const [css, setCss] = useState(saved);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!timer.current && status !== 'saving') setCss(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const change = (v: string) => {
    setCss(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null;
      setStatus('saving');
      try {
        await actions.saveCustomCss(v);
        setStatus('saved');
        setError(null);
      } catch (e) {
        setStatus('error');
        const details = e instanceof ApiError && Array.isArray(e.details) ? (e.details as string[]).join('\n') : '';
        setError(details || errorMessage(e));
      }
    }, 700);
  };
  return (
    <div className="custom-css">
      <p className="muted small">
        Site-wide CSS, added after all generated styles. Target elements with the class names set in the Style tab (e.g. <code>.brand-glow</code>) or preset classes (<code>.s-name</code>).
      </p>
      <textarea
        className="input code-area"
        aria-label="Custom CSS"
        spellCheck={false}
        rows={14}
        value={css}
        disabled={!canDesign}
        placeholder={CSS_PLACEHOLDER}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const t = e.currentTarget;
            const a = t.selectionStart;
            const b = t.selectionEnd;
            change(css.slice(0, a) + '  ' + css.slice(b));
            requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
          }
        }}
      />
      <p className="muted small" aria-live="polite" data-css-status={status}>
        {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Not saved' : `${css.length.toLocaleString()} characters`}
      </p>
      {error && (
        <pre className="form-error css-error" role="alert">
          {error}
        </pre>
      )}
    </div>
  );
}
