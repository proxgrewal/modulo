import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon.tsx';

/**
 * Small rich-text editor (bold / italic / link / lists) on contenteditable.
 * Produces HTML; the server sanitises it on render/save.
 */
export function RichText({ value, onChange, id, label, disabled }: { value: string; onChange: (html: string) => void; id?: string; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [href, setHref] = useState('');
  const savedRange = useRef<Range | null>(null);
  const [active, setActive] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (ref.current && !focused.current && ref.current.innerHTML !== value) ref.current.innerHTML = value || '';
  }, [value]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const commit = (immediate = false) => {
    if (timer.current) clearTimeout(timer.current);
    const run = () => {
      const el = ref.current;
      if (!el) return;
      let html = el.innerHTML.replace(/<br>$/, '');
      if (html && !/^\s*<(p|ul|ol|h[1-6]|blockquote|div)[\s>]/i.test(html)) html = `<p>${html}</p>`;
      onChange(html);
    };
    if (immediate) run();
    else timer.current = setTimeout(run, 200);
  };

  const refreshActive = () => {
    try {
      setActive({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        ul: document.queryCommandState('insertUnorderedList'),
        ol: document.queryCommandState('insertOrderedList'),
      });
    } catch {
      /* not supported */
    }
  };

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    refreshActive();
    commit();
  };

  const openLink = () => {
    const sel = window.getSelection();
    savedRange.current = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const a = sel?.anchorNode?.parentElement?.closest('a');
    setHref(a?.getAttribute('href') ?? '');
    setLinkOpen(true);
  };
  const applyLink = () => {
    ref.current?.focus();
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
    if (href.trim()) document.execCommand('createLink', false, href.trim());
    else document.execCommand('unlink');
    setLinkOpen(false);
    commit(true);
  };

  const Btn = ({ cmd, icon, title, on }: { cmd: () => void; icon: string; title: string; on?: boolean }) => (
    <button type="button" className={`rt-btn${on ? ' on' : ''}`} aria-label={title} aria-pressed={on} title={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={cmd}>
      <Icon name={icon} size={14} />
    </button>
  );

  return (
    <div className={`richtext${disabled ? ' disabled' : ''}`}>
      <div className="rt-toolbar" role="toolbar" aria-label={`${label} formatting`}>
        <Btn cmd={() => exec('bold')} icon="bold" title="Bold (Ctrl+B)" on={active.bold} />
        <Btn cmd={() => exec('italic')} icon="italic" title="Italic (Ctrl+I)" on={active.italic} />
        <Btn cmd={openLink} icon="link" title="Link" />
        <Btn cmd={() => exec('insertUnorderedList')} icon="list" title="Bulleted list" on={active.ul} />
        <Btn cmd={() => exec('insertOrderedList')} icon="list-ordered" title="Numbered list" on={active.ol} />
      </div>
      {linkOpen && (
        <div className="rt-link">
          <input
            className="input"
            autoFocus
            placeholder="https://… or /page"
            aria-label="Link URL"
            value={href}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                applyLink();
              }
              if (e.key === 'Escape') {
                e.stopPropagation();
                setLinkOpen(false);
              }
            }}
          />
          <button type="button" className="btn sm primary" onClick={applyLink}>
            {href.trim() ? 'Apply' : 'Remove'}
          </button>
        </div>
      )}
      <div
        ref={ref}
        id={id}
        className="rt-content input"
        contentEditable={!disabled}
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={label}
        onFocus={() => {
          focused.current = true;
          refreshActive();
        }}
        onBlur={() => {
          focused.current = false;
          commit(true);
        }}
        onInput={() => commit()}
        onKeyUp={refreshActive}
        onMouseUp={refreshActive}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            openLink();
          }
        }}
        onPaste={(e) => {
          // Paste as plain text to keep markup clean.
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
      />
    </div>
  );
}
