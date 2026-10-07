import { useEffect, useState } from 'react';
import { errorMessage } from '../api.ts';
import { navigate } from '../router.ts';
import { useStore } from '../lib/store.ts';
import { Spinner } from '../ui/controls.tsx';
import { Icon } from '../ui/Icon.tsx';
import { Canvas } from './Canvas.tsx';
import { EditorDnd } from './Dnd.tsx';
import { Inspector } from './Inspector.tsx';
import { AIPanel } from './panels/AIPanel.tsx';
import { DataPanel } from './panels/DataPanel.tsx';
import { HistoryPanel } from './panels/HistoryPanel.tsx';
import { InsertPanel } from './panels/InsertPanel.tsx';
import { LayersPanel } from './panels/LayersPanel.tsx';
import { LibraryPanel } from './panels/LibraryPanel.tsx';
import { LayoutPanel } from './panels/LayoutPanel.tsx';
import { MembersPanel } from './panels/MembersPanel.tsx';
import { ModulesPanel } from './panels/ModulesPanel.tsx';
import { PagesPanel } from './panels/PagesPanel.tsx';
import { ThemePanel } from './panels/ThemePanel.tsx';
import { actions, editor } from './state.ts';
import { TopBar } from './TopBar.tsx';

const TABS: { id: string; label: string; icon: string; render: () => React.ReactNode; when?: (mods: string[]) => boolean }[] = [
  { id: 'insert', label: 'Insert', icon: 'insert', render: () => <InsertPanel /> },
  { id: 'layers', label: 'Layers', icon: 'layers', render: () => <LayersPanel /> },
  { id: 'library', label: 'Library', icon: 'library', render: () => <LibraryPanel />, when: (mods) => mods.includes('library') },
  { id: 'pages', label: 'Pages', icon: 'file', render: () => <PagesPanel /> },
  { id: 'theme', label: 'Theme', icon: 'palette', render: () => <ThemePanel /> },
  { id: 'layout', label: 'Layout', icon: 'layout', render: () => <LayoutPanel /> },
  { id: 'data', label: 'Data', icon: 'database', render: () => <DataPanel /> },
  { id: 'modules', label: 'Modules', icon: 'puzzle', render: () => <ModulesPanel /> },
  { id: 'history', label: 'History', icon: 'clock', render: () => <HistoryPanel /> },
  { id: 'members', label: 'Members', icon: 'users', render: () => <MembersPanel /> },
  { id: 'ai', label: 'AI', icon: 'sparkles', render: () => <AIPanel />, when: (mods) => mods.includes('ai') },
];

function Sidebar() {
  const tab = useStore(editor, (s) => s.leftTab);
  const mods = useStore(editor, (s) => (s.runtime?.modules ?? []).map((m) => m.name).join(','));
  const tabs = TABS.filter((t) => !t.when || t.when(mods.split(',')));
  const active = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  return (
    <div className="sidebar">
      <nav className="rail" role="tablist" aria-label="Editor panels" aria-orientation="vertical">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            id={`tab-${t.id}`}
            aria-controls="side-panel"
            aria-selected={active.id === t.id}
            tabIndex={active.id === t.id ? 0 : -1}
            className={`rail-btn${active.id === t.id ? ' active' : ''}`}
            title={t.label}
            onClick={() => editor.set({ leftTab: t.id })}
            onKeyDown={(e) => {
              const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const n = tabs[(i + d + tabs.length) % tabs.length]!;
              editor.set({ leftTab: n.id });
              document.getElementById(`tab-${n.id}`)?.focus();
            }}
          >
            <Icon name={t.icon} size={19} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
      <section id="side-panel" className="side-panel" role="tabpanel" aria-labelledby={`tab-${active.id}`}>
        {active.render()}
      </section>
    </div>
  );
}

export function EditorShell({ site, page, onLogout }: { site: string; page?: string; onLogout: () => void }) {
  const runtime = useStore(editor, (s) => (s.site === site ? s.runtime : null));
  const pages = useStore(editor, (s) => s.pages);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    actions.openSite(site).catch((e) => setError(errorMessage(e)));
  }, [site]);

  useEffect(() => {
    if (!runtime) return;
    if (page && pages.some((p) => p.id === page)) {
      actions.openPage(page);
      return;
    }
    const home = pages.find((p) => p.path === '/') ?? pages[0];
    if (home) navigate({ name: 'editor', site, page: home.id }, true);
  }, [runtime, page, pages, site]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => actions.handleKey(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => () => actions.closePage(), []);

  // Close open <details> menus when clicking elsewhere.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      document.querySelectorAll('details.menu[open]').forEach((d) => {
        if (!d.contains(e.target as Node)) (d as HTMLDetailsElement).open = false;
      });
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  if (error)
    return (
      <div className="screen-center">
        <div className="card narrow">
          <h1>Can’t open this site</h1>
          <p className="form-error">{error}</p>
          <button className="btn primary" onClick={() => navigate({ name: 'sites' })}>
            Back to sites
          </button>
        </div>
      </div>
    );
  if (!runtime)
    return (
      <div className="screen-center">
        <Spinner label="Loading editor" />
      </div>
    );
  if (!pages.length)
    return (
      <div className="screen-center">
        <div className="card narrow">
          <h1>No pages yet</h1>
          <p className="muted">This site has no pages (is the Pages module installed?).</p>
        </div>
      </div>
    );
  return (
    <EditorDnd>
      <div className="editor">
        <a className="skip-link" href="#side-panel">
          Skip to panels
        </a>
        <TopBar onLogout={onLogout} />
        <div className="workspace">
          <Sidebar />
          <main className="stage" aria-label="Canvas">
            <Canvas />
          </main>
          <Inspector />
        </div>
      </div>
    </EditorDnd>
  );
}
