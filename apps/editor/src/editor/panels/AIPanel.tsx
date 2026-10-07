import { useState } from 'react';
import { errorMessage, post, sitePath } from '../../api.ts';
import { aiNodes } from '../../lib/ai.ts';
import { insertAfterSelection, replacePageOps } from '../../lib/commands.ts';
import { useStore } from '../../lib/store.ts';
import { cloneWithNewIds } from '../../lib/tree.ts';
import { Segmented, useUid } from '../../ui/controls.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { toast } from '../../ui/toast.ts';
import { actions, editor } from '../state.ts';

export function AIPanel() {
  const site = useStore(editor, (s) => s.site);
  const hasSel = useStore(editor, (s) => s.selection?.mode === 'page');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'section' | 'page'>('section');
  const [busy, setBusy] = useState(false);
  const uid = useUid('ai');
  const generate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      const res = await post(sitePath(site, '/m/ai/generate'), { prompt, mode });
      const nodes = aiNodes(res).map((n) => cloneWithNewIds(n));
      if (!nodes.length) throw new Error('The AI returned no blocks');
      const s = editor.get();
      if (!s.tree) return;
      if (mode === 'page') actions.apply(replacePageOps(s.tree, nodes), nodes[0]!.id);
      else actions.apply(insertAfterSelection(s.tree, s.selection?.mode === 'page' ? s.selection.id : null, nodes, s.schemas), nodes[0]!.id);
      toast.success(mode === 'page' ? 'Page generated. Press Ctrl+Z to undo.' : `Inserted ${nodes.length} block${nodes.length > 1 ? 's' : ''}`);
    } catch (e2) {
      toast.error(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>AI</h2>
        <p className="muted small">Describe what you want; the result is inserted as normal, editable blocks.</p>
      </div>
      <form className="panel-body form" onSubmit={generate}>
        <Segmented
          label="Generate"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'section', label: 'Section' },
            { value: 'page', label: 'Whole page' },
          ]}
        />
        <label htmlFor={`${uid}-p`} className="row-label">
          Prompt
        </label>
        <textarea id={`${uid}-p`} className="input" rows={5} value={prompt} placeholder="A pricing section with three plans for a yoga studio" onChange={(e) => setPrompt(e.target.value)} />
        <p className="muted small">{mode === 'page' ? 'Replaces the current page content.' : hasSel ? 'Inserted after the selected block.' : 'Added to the end of the page.'}</p>
        <button className="btn primary" disabled={busy || !prompt.trim()}>
          <Icon name="sparkles" size={15} /> {busy ? 'Generating…' : 'Generate'}
        </button>
      </form>
    </div>
  );
}
