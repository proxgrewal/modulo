import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/** Labelled form row. */
export function Row({ label, help, children, htmlFor, inline }: { label: ReactNode; help?: string; children: ReactNode; htmlFor?: string; inline?: boolean }) {
  return (
    <div className={`row${inline ? ' row-inline' : ''}`}>
      <label className="row-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="row-control">{children}</div>
      {help && <p className="row-help">{help}</p>}
    </div>
  );
}

export function Switch({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string; disabled?: boolean }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, disabled }: { value: T | undefined; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          disabled={disabled}
          className={value === o.value ? 'active' : ''}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.value === o.value);
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              const n = options[(i + 1) % options.length]!;
              onChange(n.value);
              (e.currentTarget.parentElement?.children[(i + 1) % options.length] as HTMLElement)?.focus();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              const j = (i - 1 + options.length) % options.length;
              onChange(options[j]!.value);
              (e.currentTarget.parentElement?.children[j] as HTMLElement)?.focus();
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A text value that edits locally (no caret jumps) and syncs from the
 * document whenever the input isn't focused.
 */
export function useLocalValue<T>(external: T, commit: (v: T) => void): [T, (v: T) => void, { onFocus: () => void; onBlur: () => void }] {
  const [local, setLocal] = useState(external);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setLocal(external);
  }, [external]);
  const set = (v: T) => {
    setLocal(v);
    commit(v);
  };
  return [
    local,
    set,
    {
      onFocus: () => (focused.current = true),
      onBlur: () => {
        focused.current = false;
        setLocal(external);
      },
    },
  ];
}

export function TextInput({ value, onChange, id, placeholder, type = 'text', disabled, label, multiline, rows }: { value: string; onChange: (v: string) => void; id?: string; placeholder?: string; type?: string; disabled?: boolean; label?: string; multiline?: boolean; rows?: number }) {
  const [v, set, handlers] = useLocalValue(value, onChange);
  if (multiline)
    return <textarea id={id} className="input" value={v} rows={rows ?? 3} placeholder={placeholder} disabled={disabled} aria-label={label} onChange={(e) => set(e.target.value)} {...handlers} />;
  return <input id={id} className="input" type={type} value={v} placeholder={placeholder} disabled={disabled} aria-label={label} onChange={(e) => set(e.target.value)} {...handlers} />;
}

export function useUid(prefix = 'f') {
  return prefix + useId().replace(/:/g, '');
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="spinner" role="progressbar" aria-label={label} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
