import { useStore } from '../lib/store.ts';
import { dismiss, toasts } from './toast.ts';
import { Icon } from './Icon.tsx';

export function Toasts() {
  const list = useStore(toasts, (s) => s.list);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false" role="status">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : undefined}>
          <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={16} />
          <span className="toast-msg">{t.message}</span>
          {t.link && (
            <a className="toast-link" href={t.link.href} target="_blank" rel="noreferrer">
              {t.link.label}
            </a>
          )}
          <button className="icon-btn sm" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
