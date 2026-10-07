/**
 * A small allowlist HTML sanitiser for rich-text post bodies.
 *
 * Strategy: tokenise the input and re-serialise *only* what is on the
 * allowlist. Anything that does not parse as a well-formed tag is emitted as
 * escaped text, so the output never contains markup we did not generate.
 */

const ALLOWED: Record<string, string[]> = {
  p: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  ol: [],
  li: [],
  a: ['href'],
  strong: [],
  em: [],
  blockquote: [],
  code: [],
  pre: [],
  img: ['src', 'alt'],
  br: [],
};
const VOID = new Set(['br', 'img']);
/** Elements whose entire content is dropped, not just the tags. */
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'xmp', 'noembed', 'noframes', 'plaintext', 'svg', 'math', 'select', 'frameset', 'head']);
const URL_ATTRS = new Set(['href', 'src']);

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n', sol: '/', lpar: '(', rpar: ')', semi: ';', period: '.', comma: ',',
};

/** Decode character references (as a browser would inside an attribute value). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    const v = NAMED[ref.toLowerCase()];
    return v ?? m;
  });
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' })[c]!);
}

function escapeText(s: string): string {
  // Keep existing character references, escape bare ampersands and angle brackets.
  return s.replace(/&(?!(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isIgnorable(c: number): boolean {
  return c <= 0x20 || (c >= 0x7f && c <= 0xa0) || c === 0x1680 || (c >= 0x2000 && c <= 0x200f) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** Returns a safe URL or null. Allows http(s), mailto/tel (links only) and relative URLs. */
export function safeHref(raw: string, kind: 'href' | 'src'): string | null {
  // Browsers ignore control characters and whitespace inside the scheme.
  const decoded = decodeEntities(raw);
  const compact = Array.from(decoded).filter((ch) => !isIgnorable(ch.codePointAt(0)!)).join('');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    const ok = kind === 'href' ? ['http', 'https', 'mailto', 'tel'] : ['http', 'https'];
    if (!ok.includes(scheme)) return null;
  } else if ((compact.split(/[/?#]/)[0] ?? '').includes(':')) {
    return null; // scheme-like prefix we could not classify
  }
  return decoded.trim();
}

const TAG_RE = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s/>"'=<]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/;
const ATTR_RE = /([^\s/>"'=<]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function renderAttrs(tag: string, attrStr: string): string | null {
  const allowed = ALLOWED[tag]!;
  const vals: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrStr))) {
    const name = m[1]!.toLowerCase();
    if (!allowed.includes(name) || name in vals) continue;
    vals[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  let out = '';
  for (const name of allowed) {
    if (!(name in vals)) continue;
    let v = vals[name]!;
    if (URL_ATTRS.has(name)) {
      const safe = safeHref(v, name as 'href' | 'src');
      if (safe === null) continue;
      v = safe;
    } else v = decodeEntities(v);
    out += ` ${name}="${escapeAttr(v)}"`;
  }
  if (tag === 'img' && !out.includes(' src="')) return null; // drop images without a safe src
  if (tag === 'a' && out.includes(' href=')) out += ' rel="noopener noreferrer nofollow"';
  return out;
}

/** Sanitise untrusted rich-text HTML down to a small, safe subset. */
export function sanitizeHtml(input: unknown): string {
  const html = typeof input === 'string' ? input : '';
  let out = '';
  const stack: string[] = [];
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out += escapeText(html.slice(i));
      break;
    }
    if (lt > i) out += escapeText(html.slice(i, lt));
    i = lt;
    const rest = html.slice(i);
    // Comments, doctypes, CDATA, processing instructions: drop entirely.
    if (rest.startsWith('<!--')) {
      const end = html.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      const end = html.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const m = TAG_RE.exec(rest);
    if (!m) {
      out += '&lt;';
      i += 1;
      continue;
    }
    i += m[0].length;
    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();
    if (!closing && DROP_CONTENT.has(tag)) {
      if (m[4] === '/') continue;
      const re = new RegExp(`</${tag}\\s*>`, 'i');
      const r = re.exec(html.slice(i));
      i = r ? i + r.index + r[0].length : n;
      continue;
    }
    if (!(tag in ALLOWED)) continue; // unknown tag: drop the tag, keep its text
    if (closing) {
      if (VOID.has(tag)) continue;
      const idx = stack.lastIndexOf(tag);
      if (idx === -1) continue;
      while (stack.length > idx) out += `</${stack.pop()}>`;
      continue;
    }
    const attrs = renderAttrs(tag, m[3] ?? '');
    if (attrs === null) continue;
    out += `<${tag}${attrs}>`;
    if (!VOID.has(tag)) stack.push(tag);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}
