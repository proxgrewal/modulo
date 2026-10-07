import { f, type PageNode } from '@modulo/core';
import { defineModule, ValidationError, type RouteRequest, type SiteContext } from '@modulo/kernel';
import { ClaudeAdapter, DEFAULT_MODEL, type GenerateInput, type LayoutModel } from './claude.ts';
import { FallbackAdapter } from './fallback.ts';
import { buildCatalog, normalizeLayout } from './layout.ts';

export * from './claude.ts';
export * from './fallback.ts';
export * from './layout.ts';

export interface GenerateResult {
  tree: PageNode;
  source: 'claude' | 'fallback';
  warnings: string[];
  title?: string;
}

/** Hook for tests / embedders to supply a different primary model. Default: Claude when a key is configured. */
let modelFactory: ((ctx: SiteContext) => LayoutModel | null) | null = null;
export function setLayoutModelFactory(factory: ((ctx: SiteContext) => LayoutModel | null) | null) {
  modelFactory = factory;
}

function primaryModel(ctx: SiteContext): LayoutModel | null {
  if (modelFactory) return modelFactory(ctx);
  const s = ctx.settings('ai');
  const apiKey = (typeof s.apiKey === 'string' && s.apiKey.trim()) || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return new ClaudeAdapter({ apiKey, model: typeof s.model === 'string' && s.model.trim() ? s.model.trim() : DEFAULT_MODEL });
}

/** Generate a validated page tree for this site's installed blocks. */
export async function generateLayout(ctx: SiteContext, prompt: string, mode: 'page' | 'section' = 'page'): Promise<GenerateResult> {
  const registry = ctx.runtime.blocks;
  const input: GenerateInput = { prompt, mode, catalog: buildCatalog(registry), siteName: ctx.site.name };
  const warnings: string[] = [];
  const model = primaryModel(ctx);
  if (model) {
    try {
      const raw = await model.generate(input);
      const out = normalizeLayout(raw, registry, { mode });
      if (out.tree.slots!.default!.length) return { tree: out.tree, source: 'claude', warnings: out.warnings, title: out.title };
      warnings.push(...out.warnings, 'The AI layout contained no usable blocks; used the built-in generator instead');
    } catch (e: any) {
      warnings.push(`AI generation failed (${String(e?.message ?? e).slice(0, 300)}); used the built-in generator instead`);
    }
  }
  const out = normalizeLayout(await new FallbackAdapter().generate(input), registry, { mode });
  return { tree: out.tree, source: 'fallback', warnings: [...warnings, ...out.warnings], title: out.title };
}

async function generateRoute(req: RouteRequest) {
  const b = (req.body ?? {}) as { prompt?: unknown; mode?: unknown };
  if (typeof b.prompt !== 'string' || !b.prompt.trim()) throw new ValidationError('prompt is required');
  if (b.prompt.length > 4000) throw new ValidationError('prompt is too long (max 4000 characters)');
  const mode = b.mode === undefined ? 'page' : b.mode;
  if (mode !== 'page' && mode !== 'section') throw new ValidationError('mode must be "page" or "section"');
  return { body: await generateLayout(req.ctx, b.prompt.trim(), mode) };
}

export default defineModule({
  name: 'ai',
  version: '1.0.0',
  kernel: '^1.0.0',
  label: 'AI layouts',
  description: 'Generate page layouts from a prompt using the blocks installed on the site.',
  category: 'tools',
  depends: {},
  permissions: [{ key: 'ai.use', label: 'Generate layouts with AI' }],
  grants: { editor: ['ai.use'] },
  settings: {
    apiKey: f.text({ label: 'Anthropic API key (falls back to ANTHROPIC_API_KEY)', default: '' }),
    model: f.text({ label: 'Claude model', default: DEFAULT_MODEL }),
  },
  routes: [{ method: 'POST', path: '/generate', surface: 'api', permission: 'ai.use', handler: generateRoute }],
});
