import type { CatalogBlock } from './layout.ts';

export interface GenerateInput {
  prompt: string;
  mode: 'page' | 'section';
  catalog: CatalogBlock[];
  siteName?: string;
}

/** Anything that can propose a layout. Output is untrusted and normalised afterwards. */
export interface LayoutModel {
  generate(input: GenerateInput): Promise<unknown>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/*
 * Structured-output schema. JSON-schema outputs do not support recursive
 * schemas or free-form objects (every object needs additionalProperties:false),
 * so the tree is expressed with a fixed depth of three levels and each block's
 * props travel as a JSON-encoded string that the normaliser parses and validates.
 */
const node = (children?: object) => ({
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Block type from the catalog, e.g. "core:hero"' },
    props: { type: 'string', description: 'JSON object of prop values for this block, e.g. {"title":"Hi"}' },
    ...(children ? { children: { type: 'array', items: children } } : {}),
  },
  required: children ? ['type', 'props', 'children'] : ['type', 'props'],
  additionalProperties: false,
});
export const LAYOUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Page title' },
    sections: { type: 'array', items: node(node(node())) },
  },
  required: ['title', 'sections'],
  additionalProperties: false,
};

export function systemPrompt(catalog: CatalogBlock[]): string {
  return [
    'You design website layouts for a low-code website builder.',
    'Compose the layout ONLY from the block types in this catalog. Each block lists its fields (kind, allowed options, defaults) and its slots.',
    'Only blocks that have slots may have children; children go into the first slot. Prefer wrapping simple blocks (headings, text, buttons, images) in "core:section" (and "core:stack"/"core:grid" for arrangement) when those exist; composite blocks such as heroes, feature lists, pricing tables and FAQs stand on their own.',
    'Props: use the field names exactly as listed; select fields must use one of the listed options; list fields are arrays of objects with the listed item fields; richtext fields take simple HTML (<p>, <strong>, <em>, <a>, <ul>, <li>) only.',
    'Write specific, realistic copy for the business described by the user (no lorem ipsum). Leave image fields as empty strings unless the user gave an image URL.',
    'Respond with JSON only: {"title": string, "sections": [{"type": string, "props": "<JSON object as a string>", "children": [...]}]}. No prose, no code fences.',
    '',
    'Block catalog:',
    JSON.stringify(catalog),
  ].join('\n');
}

/** Extract a JSON value from model text that may be wrapped in prose or code fences. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]!.trim());
    } catch {
      /* fall through */
    }
  }
  const starts = [t.indexOf('{'), t.indexOf('[')].filter((i) => i >= 0);
  if (starts.length) {
    const start = Math.min(...starts);
    const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error('model response did not contain valid JSON');
}

export interface ClaudeAdapterOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** output_config.effort; layout generation is routine work. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Use JSON-schema structured outputs (default true). */
  structuredOutput?: boolean;
}

/** Calls the Claude Messages API over raw HTTP (no SDK dependency). */
export class ClaudeAdapter implements LayoutModel {
  constructor(private opts: ClaudeAdapterOptions) {}

  async generate(input: GenerateInput): Promise<unknown> {
    const o = this.opts;
    const body: Record<string, unknown> = {
      model: o.model || DEFAULT_MODEL,
      max_tokens: o.maxTokens ?? 16000,
      // Server-side fallback: if the model declines on policy grounds, the API retries on its recommended fallback model.
      fallbacks: 'default',
      output_config: {
        effort: o.effort ?? 'medium',
        ...(o.structuredOutput === false ? {} : { format: { type: 'json_schema', schema: LAYOUT_SCHEMA } }),
      },
      system: systemPrompt(input.catalog),
      messages: [
        {
          role: 'user',
          content: `${input.mode === 'section' ? 'Design ONE section (a single top-level block)' : 'Design a complete landing page (4-7 sections)'} for this request:\n\n${input.prompt}${input.siteName ? `\n\nSite name: ${input.siteName}` : ''}`,
        },
      ],
    };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? 90_000);
    let res: Response;
    try {
      res = await globalThis.fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': o.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'server-side-fallback-2026-07-01',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e: any) {
      throw new Error(e?.name === 'AbortError' ? 'request timed out' : `network error: ${e?.message ?? e}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const j: any = await res.json();
        detail = j?.error?.message ? `: ${String(j.error.message).slice(0, 200)}` : '';
      } catch {
        /* ignore */
      }
      throw new Error(`Claude API returned HTTP ${res.status}${detail}`);
    }
    const data: any = await res.json();
    if (data?.stop_reason === 'refusal') throw new Error('Claude declined the request');
    const text = Array.isArray(data?.content) ? data.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text ?? '')).join('') : '';
    if (!text.trim()) throw new Error('Claude returned no text');
    try {
      return extractJson(text);
    } catch (e) {
      if (data?.stop_reason === 'max_tokens') throw new Error('Claude response was truncated (max_tokens)');
      throw e;
    }
  }
}
