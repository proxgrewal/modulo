/**
 * Allowlist HTML sanitiser for rich text (no DOM dependency, runs on server
 * and in the editor). Anything not explicitly allowed is dropped or escaped.
 */
const ALLOWED: Record<string, string[]> = {
  p: [], br: [], strong: [], b: [], em: [], i: [], u: [], s: [], code: [], pre: [], blockquote: [],
  h2: [], h3: [], h4: [], ul: [], ol: [], li: [], hr: [], span: [], sub: [], sup: [],
  a: ['href', 'title', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
};
const VOID = new Set(['br', 'hr', 'img']);
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'textarea', 'select', 'svg', 'math']);

function escapeText(s: string) {
  return s.replace(/&(?!(#\d+|#x[0-9a-f]+|[a-z]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(colon|tab|newline);/gi, (_, n) => ({ colon: ':', tab: '\t', newline: '\n' })[n.toLowerCase() as 'colon']!);
}
function safeHref(v: string, img = false) {
  const d = decodeEntities(v).replace(/[\u0000- ]+/g, '').toLowerCase();
  if (/^(javascript|vbscript|data):/.test(d) && !(img && /^data:image\/(png|gif|jpe?g|webp);/.test(d))) return null;
  return v;
}

export function sanitizeHtml(input: string): string {
  if (!input) return '';
  let out = '';
  const stack: string[] = [];
  let i = 0;
  let dropDepth = 0;
  let dropTag = '';
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s/>"'=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const text = input.slice(i, m.index);
    if (!dropDepth) out += escapeText(text);
    i = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const tag = m[1]!.toLowerCase();
    const closing = m[0][1] === '/';
    if (DROP_CONTENT.has(tag)) {
      if (!closing && !m[0].endsWith('/>')) {
        if (!dropDepth) dropTag = tag;
        if (tag === dropTag) dropDepth++;
      } else if (closing && tag === dropTag && dropDepth) dropDepth--;
      continue;
    }
    if (dropDepth || !(tag in ALLOWED)) continue;
    if (closing) {
      const idx = stack.lastIndexOf(tag);
      if (idx >= 0) {
        while (stack.length > idx) out += `</${stack.pop()}>`;
      }
      continue;
    }
    let attrs = '';
    const attrRe = /([^\s/>"'=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a: RegExpExecArray | null;
    const allowed = ALLOWED[tag]!;
    let hasTargetBlank = false;
    while ((a = attrRe.exec(m[2] ?? ''))) {
      const name = a[1]!.toLowerCase();
      if (!allowed.includes(name)) continue;
      let val = a[2] ?? a[3] ?? a[4] ?? '';
      if (name === 'href' || name === 'src') {
        const s = safeHref(val, name === 'src');
        if (s === null) continue;
        val = s;
      }
      if (name === 'target') {
        if (val !== '_blank') continue;
        hasTargetBlank = true;
      }
      if (name === 'rel') continue;
      attrs += ` ${name}="${escapeAttr(val)}"`;
    }
    if (hasTargetBlank) attrs += ' rel="noopener noreferrer"';
    out += `<${tag}${attrs}>`;
    if (!VOID.has(tag)) stack.push(tag);
  }
  if (!dropDepth) out += escapeText(input.slice(i));
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}
