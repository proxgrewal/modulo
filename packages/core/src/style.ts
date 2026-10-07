import { BREAKPOINTS, type Breakpoint, type StyleProps, type StyleState, STYLE_STATES } from './tree.ts';
import { cssValue } from './tokens.ts';
import type { TokenGroup } from './fields.ts';

/**
 * The style system. A single catalog describes every style property: how it
 * compiles to CSS, how it is validated, and how the editor presents it. Nodes
 * store values per breakpoint and per interaction state; the renderer compiles
 * them to short deterministic atomic classes, de-duplicated across the page.
 * Reusable style presets (like design-tool "classes") compile to named classes.
 */
export type StyleGroup = 'layout' | 'child' | 'spacing' | 'size' | 'position' | 'typography' | 'background' | 'border' | 'effects';

export type StyleControl =
  | 'length' // number + unit, or token (space/radius/fontSize)
  | 'color'
  | 'select'
  | 'segmented'
  | 'number'
  | 'text'
  | 'image'
  | 'shadow'
  | 'font'
  | 'tracks'; // grid template (number of equal columns or a template string)

export interface StyleProp {
  key: string;
  group: StyleGroup;
  label: string;
  control: StyleControl;
  /** Design token group offered for this property. */
  token?: TokenGroup;
  options?: { value: string; label: string }[];
  units?: string[];
  placeholder?: string;
  /** Only meaningful when the element (or its parent) uses this display. */
  when?: 'flex' | 'grid' | 'flex-or-grid' | 'parent-flex' | 'parent-grid' | 'positioned';
  /** Compile a sanitised value to declarations. */
  css: (v: string) => string | null;
}

const opts = (...xs: (string | [string, string])[]) => xs.map((x) => (Array.isArray(x) ? { value: x[0], label: x[1] } : { value: x, label: x }));
const LEN = ['px', '%', 'rem', 'em', 'vw', 'vh', 'auto'];
const one = (prop: string) => (v: string) => `${prop}:${v}`;
const pick = (prop: string, allowed: string[], map: Record<string, string> = {}) => (v: string) => (allowed.includes(v) ? `${prop}:${map[v] ?? v}` : null);

const JUSTIFY = { start: 'flex-start', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' };
const ALIGN = { start: 'flex-start', end: 'flex-end' };

export const STYLE_PROPS: StyleProp[] = [
  /* ── layout ── */
  { key: 'display', group: 'layout', label: 'Display', control: 'segmented', options: opts('block', 'flex', 'grid', 'inline-block', 'inline', 'inline-flex', 'none'), css: pick('display', ['block', 'flex', 'grid', 'inline-block', 'inline', 'inline-flex', 'inline-grid', 'none', 'contents']) },
  { key: 'direction', group: 'layout', label: 'Direction', control: 'segmented', when: 'flex', options: opts(['row', 'Row'], ['column', 'Column'], ['row-reverse', 'Row ⟲'], ['column-reverse', 'Column ⟲']), css: pick('flex-direction', ['row', 'column', 'row-reverse', 'column-reverse']) },
  { key: 'wrap', group: 'layout', label: 'Wrap', control: 'segmented', when: 'flex', options: opts(['nowrap', 'No wrap'], ['wrap', 'Wrap'], ['wrap-reverse', 'Reverse']), css: pick('flex-wrap', ['nowrap', 'wrap', 'wrap-reverse']) },
  { key: 'justify', group: 'layout', label: 'Justify', control: 'segmented', when: 'flex-or-grid', options: opts('start', 'center', 'end', 'between', 'around', 'evenly', 'stretch'), css: pick('justify-content', ['start', 'center', 'end', 'between', 'around', 'evenly', 'stretch'], JUSTIFY) },
  { key: 'items', group: 'layout', label: 'Align', control: 'segmented', when: 'flex-or-grid', options: opts('stretch', 'start', 'center', 'end', 'baseline'), css: pick('align-items', ['stretch', 'start', 'center', 'end', 'baseline'], ALIGN) },
  { key: 'alignContent', group: 'layout', label: 'Align lines', control: 'select', when: 'flex-or-grid', options: opts('normal', 'start', 'center', 'end', 'between', 'around', 'stretch'), css: pick('align-content', ['normal', 'start', 'center', 'end', 'between', 'around', 'stretch'], JUSTIFY) },
  { key: 'gap', group: 'layout', label: 'Gap', control: 'length', token: 'space', units: LEN, when: 'flex-or-grid', css: one('gap') },
  { key: 'rowGap', group: 'layout', label: 'Row gap', control: 'length', token: 'space', units: LEN, when: 'flex-or-grid', css: one('row-gap') },
  { key: 'columnGap', group: 'layout', label: 'Column gap', control: 'length', token: 'space', units: LEN, when: 'flex-or-grid', css: one('column-gap') },
  {
    key: 'columns', group: 'layout', label: 'Columns', control: 'tracks', when: 'grid', placeholder: '3 or 1fr 2fr',
    css: (v) => (/^\d{1,2}$/.test(v) && Number(v) > 0 ? `grid-template-columns:repeat(${v},minmax(0,1fr))` : `grid-template-columns:${v}`),
  },
  {
    key: 'rows', group: 'layout', label: 'Rows', control: 'tracks', when: 'grid', placeholder: 'auto or 200px 1fr',
    css: (v) => (/^\d{1,2}$/.test(v) && Number(v) > 0 ? `grid-template-rows:repeat(${v},minmax(0,auto))` : `grid-template-rows:${v}`),
  },
  { key: 'autoFlow', group: 'layout', label: 'Auto flow', control: 'select', when: 'grid', options: opts('row', 'column', 'dense', 'row dense', 'column dense'), css: pick('grid-auto-flow', ['row', 'column', 'dense', 'row dense', 'column dense']) },

  /* ── as a child of a flex/grid parent ── */
  { key: 'grow', group: 'child', label: 'Grow', control: 'number', when: 'parent-flex', css: (v) => (/^\d+(\.\d+)?$/.test(v) ? `flex-grow:${v}` : null) },
  { key: 'shrink', group: 'child', label: 'Shrink', control: 'number', when: 'parent-flex', css: (v) => (/^\d+(\.\d+)?$/.test(v) ? `flex-shrink:${v}` : null) },
  { key: 'basis', group: 'child', label: 'Basis', control: 'length', units: LEN, when: 'parent-flex', css: one('flex-basis') },
  { key: 'alignSelf', group: 'child', label: 'Align self', control: 'segmented', options: opts('auto', 'start', 'center', 'end', 'stretch'), css: pick('align-self', ['auto', 'start', 'center', 'end', 'stretch'], ALIGN) },
  { key: 'order', group: 'child', label: 'Order', control: 'number', css: (v) => (/^-?\d{1,3}$/.test(v) ? `order:${v}` : null) },
  { key: 'colSpan', group: 'child', label: 'Column span', control: 'number', when: 'parent-grid', css: (v) => (/^\d{1,2}$/.test(v) ? `grid-column:span ${v}/span ${v}` : v === 'full' ? 'grid-column:1/-1' : null) },
  { key: 'rowSpan', group: 'child', label: 'Row span', control: 'number', when: 'parent-grid', css: (v) => (/^\d{1,2}$/.test(v) ? `grid-row:span ${v}/span ${v}` : null) },

  /* ── spacing ── */
  { key: 'padding', group: 'spacing', label: 'Padding', control: 'length', token: 'space', units: LEN, css: one('padding') },
  { key: 'paddingX', group: 'spacing', label: 'Padding X', control: 'length', token: 'space', units: LEN, css: (v) => `padding-left:${v};padding-right:${v}` },
  { key: 'paddingY', group: 'spacing', label: 'Padding Y', control: 'length', token: 'space', units: LEN, css: (v) => `padding-top:${v};padding-bottom:${v}` },
  { key: 'paddingTop', group: 'spacing', label: 'Padding top', control: 'length', token: 'space', units: LEN, css: one('padding-top') },
  { key: 'paddingRight', group: 'spacing', label: 'Padding right', control: 'length', token: 'space', units: LEN, css: one('padding-right') },
  { key: 'paddingBottom', group: 'spacing', label: 'Padding bottom', control: 'length', token: 'space', units: LEN, css: one('padding-bottom') },
  { key: 'paddingLeft', group: 'spacing', label: 'Padding left', control: 'length', token: 'space', units: LEN, css: one('padding-left') },
  { key: 'margin', group: 'spacing', label: 'Margin', control: 'length', token: 'space', units: LEN, css: one('margin') },
  { key: 'marginX', group: 'spacing', label: 'Margin X', control: 'length', token: 'space', units: LEN, css: (v) => `margin-left:${v};margin-right:${v}` },
  { key: 'marginY', group: 'spacing', label: 'Margin Y', control: 'length', token: 'space', units: LEN, css: (v) => `margin-top:${v};margin-bottom:${v}` },
  { key: 'marginTop', group: 'spacing', label: 'Margin top', control: 'length', token: 'space', units: LEN, css: one('margin-top') },
  { key: 'marginRight', group: 'spacing', label: 'Margin right', control: 'length', token: 'space', units: LEN, css: one('margin-right') },
  { key: 'marginBottom', group: 'spacing', label: 'Margin bottom', control: 'length', token: 'space', units: LEN, css: one('margin-bottom') },
  { key: 'marginLeft', group: 'spacing', label: 'Margin left', control: 'length', token: 'space', units: LEN, css: one('margin-left') },

  /* ── size ── */
  { key: 'width', group: 'size', label: 'Width', control: 'length', units: LEN, css: one('width') },
  { key: 'height', group: 'size', label: 'Height', control: 'length', units: LEN, css: one('height') },
  { key: 'minWidth', group: 'size', label: 'Min width', control: 'length', units: LEN, css: one('min-width') },
  { key: 'maxWidth', group: 'size', label: 'Max width', control: 'length', units: LEN, css: one('max-width') },
  { key: 'minHeight', group: 'size', label: 'Min height', control: 'length', units: LEN, css: one('min-height') },
  { key: 'maxHeight', group: 'size', label: 'Max height', control: 'length', units: LEN, css: one('max-height') },
  { key: 'aspectRatio', group: 'size', label: 'Aspect ratio', control: 'select', options: opts('auto', '1/1', '4/3', '3/2', '16/9', '21/9', '3/4', '9/16'), css: (v) => (/^(auto|\d{1,3}\s*\/\s*\d{1,3})$/.test(v) ? `aspect-ratio:${v}` : null) },
  { key: 'overflow', group: 'size', label: 'Overflow', control: 'segmented', options: opts('visible', 'hidden', 'auto', 'scroll', 'clip'), css: pick('overflow', ['visible', 'hidden', 'auto', 'scroll', 'clip']) },
  { key: 'objectFit', group: 'size', label: 'Fit (media)', control: 'segmented', options: opts('fill', 'cover', 'contain', 'none', 'scale-down'), css: pick('object-fit', ['fill', 'cover', 'contain', 'none', 'scale-down']) },
  { key: 'objectPosition', group: 'size', label: 'Media position', control: 'select', options: opts('center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'), css: one('object-position') },

  /* ── position ── */
  { key: 'position', group: 'position', label: 'Position', control: 'segmented', options: opts('static', 'relative', 'absolute', 'fixed', 'sticky'), css: pick('position', ['static', 'relative', 'absolute', 'fixed', 'sticky']) },
  { key: 'top', group: 'position', label: 'Top', control: 'length', units: LEN, when: 'positioned', css: one('top') },
  { key: 'right', group: 'position', label: 'Right', control: 'length', units: LEN, when: 'positioned', css: one('right') },
  { key: 'bottom', group: 'position', label: 'Bottom', control: 'length', units: LEN, when: 'positioned', css: one('bottom') },
  { key: 'left', group: 'position', label: 'Left', control: 'length', units: LEN, when: 'positioned', css: one('left') },
  { key: 'zIndex', group: 'position', label: 'Z-index', control: 'number', css: (v) => (/^-?\d{1,5}$/.test(v) ? `z-index:${v}` : null) },
  { key: 'float', group: 'position', label: 'Float', control: 'segmented', options: opts('none', 'left', 'right'), css: pick('float', ['none', 'left', 'right']) },

  /* ── typography ── */
  { key: 'font', group: 'typography', label: 'Font', control: 'font', token: 'font', css: one('font-family') },
  { key: 'fontSize', group: 'typography', label: 'Size', control: 'length', token: 'fontSize', units: ['px', 'rem', 'em', 'vw', '%'], css: one('font-size') },
  { key: 'fontWeight', group: 'typography', label: 'Weight', control: 'select', options: opts(['100', 'Thin'], ['200', 'Extra light'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Black']), css: (v) => (/^[1-9]00$/.test(v) || v === 'normal' || v === 'bold' ? `font-weight:${v}` : null) },
  { key: 'lineHeight', group: 'typography', label: 'Line height', control: 'length', units: ['', 'px', 'em', '%'], placeholder: '1.5', css: one('line-height') },
  { key: 'letterSpacing', group: 'typography', label: 'Letter spacing', control: 'length', units: ['em', 'px'], placeholder: '0.02em', css: one('letter-spacing') },
  { key: 'color', group: 'typography', label: 'Color', control: 'color', token: 'color', css: one('color') },
  { key: 'align', group: 'typography', label: 'Align', control: 'segmented', options: opts('left', 'center', 'right', 'justify'), css: pick('text-align', ['left', 'center', 'right', 'justify', 'start', 'end']) },
  { key: 'fontStyle', group: 'typography', label: 'Style', control: 'segmented', options: opts('normal', 'italic'), css: pick('font-style', ['normal', 'italic']) },
  { key: 'textTransform', group: 'typography', label: 'Case', control: 'segmented', options: opts(['none', 'Aa'], ['uppercase', 'AA'], ['lowercase', 'aa'], ['capitalize', 'Ab']), css: pick('text-transform', ['none', 'uppercase', 'lowercase', 'capitalize']) },
  { key: 'textDecoration', group: 'typography', label: 'Decoration', control: 'segmented', options: opts('none', 'underline', 'line-through', 'overline'), css: pick('text-decoration', ['none', 'underline', 'line-through', 'overline']) },
  { key: 'whiteSpace', group: 'typography', label: 'Wrapping', control: 'select', options: opts('normal', 'nowrap', 'pre', 'pre-wrap', 'balance'), css: (v) => (v === 'balance' ? 'text-wrap:balance' : pick('white-space', ['normal', 'nowrap', 'pre', 'pre-wrap'])(v)) },
  { key: 'textShadow', group: 'typography', label: 'Text shadow', control: 'shadow', css: one('text-shadow') },

  /* ── background ── */
  { key: 'background', group: 'background', label: 'Background', control: 'color', token: 'color', placeholder: '#fff or linear-gradient(…)', css: one('background') },
  { key: 'backgroundImage', group: 'background', label: 'Image', control: 'image', css: (v) => imageDecl(v) },
  { key: 'backgroundSize', group: 'background', label: 'Image size', control: 'segmented', options: opts('auto', 'cover', 'contain'), css: (v) => (/^(auto|cover|contain|\d{1,4}(px|%)(\s+\d{1,4}(px|%))?)$/.test(v) ? `background-size:${v}` : null) },
  { key: 'backgroundPosition', group: 'background', label: 'Image position', control: 'select', options: opts('center', 'top', 'bottom', 'left', 'right', 'top left', 'top right', 'bottom left', 'bottom right'), css: one('background-position') },
  { key: 'backgroundRepeat', group: 'background', label: 'Repeat', control: 'segmented', options: opts('no-repeat', 'repeat', 'repeat-x', 'repeat-y'), css: pick('background-repeat', ['no-repeat', 'repeat', 'repeat-x', 'repeat-y']) },
  { key: 'backgroundAttachment', group: 'background', label: 'Attachment', control: 'segmented', options: opts(['scroll', 'Scroll'], ['fixed', 'Fixed (parallax)']), css: pick('background-attachment', ['scroll', 'fixed']) },
  { key: 'overlay', group: 'background', label: 'Overlay tint', control: 'color', token: 'color', placeholder: 'rgba(0,0,0,.4)', css: (v) => `box-shadow:inset 0 0 0 100vmax ${v}` },

  /* ── border ── */
  { key: 'border', group: 'border', label: 'Border', control: 'text', placeholder: '1px solid #ddd', css: one('border') },
  { key: 'borderWidth', group: 'border', label: 'Width', control: 'length', units: ['px'], css: one('border-width') },
  { key: 'borderStyle', group: 'border', label: 'Style', control: 'segmented', options: opts('none', 'solid', 'dashed', 'dotted', 'double'), css: pick('border-style', ['none', 'solid', 'dashed', 'dotted', 'double']) },
  { key: 'borderColor', group: 'border', label: 'Color', control: 'color', token: 'color', css: one('border-color') },
  { key: 'borderTop', group: 'border', label: 'Top', control: 'text', placeholder: '1px solid #ddd', css: one('border-top') },
  { key: 'borderRight', group: 'border', label: 'Right', control: 'text', placeholder: '1px solid #ddd', css: one('border-right') },
  { key: 'borderBottom', group: 'border', label: 'Bottom', control: 'text', placeholder: '1px solid #ddd', css: one('border-bottom') },
  { key: 'borderLeft', group: 'border', label: 'Left', control: 'text', placeholder: '1px solid #ddd', css: one('border-left') },
  { key: 'radius', group: 'border', label: 'Radius', control: 'length', token: 'radius', units: ['px', '%', 'rem'], css: one('border-radius') },
  { key: 'radiusTopLeft', group: 'border', label: 'Top left', control: 'length', token: 'radius', units: ['px', '%'], css: one('border-top-left-radius') },
  { key: 'radiusTopRight', group: 'border', label: 'Top right', control: 'length', token: 'radius', units: ['px', '%'], css: one('border-top-right-radius') },
  { key: 'radiusBottomRight', group: 'border', label: 'Bottom right', control: 'length', token: 'radius', units: ['px', '%'], css: one('border-bottom-right-radius') },
  { key: 'radiusBottomLeft', group: 'border', label: 'Bottom left', control: 'length', token: 'radius', units: ['px', '%'], css: one('border-bottom-left-radius') },
  { key: 'outline', group: 'border', label: 'Outline', control: 'text', placeholder: '2px solid #2f5bea', css: one('outline') },

  /* ── effects ── */
  { key: 'opacity', group: 'effects', label: 'Opacity', control: 'number', placeholder: '0–1', css: (v) => (/^(0|1|0?\.\d+|\d{1,3}%)$/.test(v) ? `opacity:${v}` : null) },
  { key: 'shadow', group: 'effects', label: 'Shadow', control: 'shadow', token: 'shadow', css: one('box-shadow') },
  { key: 'transform', group: 'effects', label: 'Transform', control: 'text', placeholder: 'translateY(-4px) scale(1.02)', css: (v) => (/^((translate[XYZ]?|scale[XYZ]?|rotate[XYZ]?|skew[XY]?|perspective)\([^()]*\)\s*)+$|^none$/.test(v) ? `transform:${v}` : null) },
  { key: 'transition', group: 'effects', label: 'Transition', control: 'select', options: opts(['none', 'None'], ['all .2s ease', 'Smooth (0.2s)'], ['all .4s ease', 'Slow (0.4s)'], ['transform .2s ease', 'Transform only'], ['opacity .3s ease', 'Fade']), css: (v) => (/^[a-z-]+(\s+[\d.]+m?s)?(\s+[a-z-]+(\([^()]*\))?)?(\s*,\s*[a-z-]+\s+[\d.]+m?s(\s+[a-z-]+)?)*$/.test(v) ? `transition:${v}` : null) },
  { key: 'filter', group: 'effects', label: 'Filter', control: 'text', placeholder: 'blur(4px) grayscale(1)', css: (v) => (filterOk(v) ? `filter:${v}` : null) },
  { key: 'backdropFilter', group: 'effects', label: 'Backdrop filter', control: 'text', placeholder: 'blur(12px)', css: (v) => (filterOk(v) ? `backdrop-filter:${v};-webkit-backdrop-filter:${v}` : null) },
  { key: 'blendMode', group: 'effects', label: 'Blend', control: 'select', options: opts('normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'), css: pick('mix-blend-mode', ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference']) },
  { key: 'cursor', group: 'effects', label: 'Cursor', control: 'select', options: opts('auto', 'pointer', 'default', 'text', 'move', 'not-allowed', 'grab'), css: pick('cursor', ['auto', 'pointer', 'default', 'text', 'move', 'not-allowed', 'grab']) },
  { key: 'visibility', group: 'effects', label: 'Visibility', control: 'segmented', options: opts('visible', 'hidden'), css: pick('visibility', ['visible', 'hidden']) },
];

export const STYLE_PROP_MAP: Record<string, StyleProp> = Object.fromEntries(STYLE_PROPS.map((p) => [p.key, p]));

/** JSON-serialisable catalog for the editor (css functions stripped). */
export function styleCatalog() {
  return STYLE_PROPS.map(({ css, ...rest }) => rest);
}

function filterOk(v: string) {
  return /^((blur|brightness|contrast|grayscale|hue-rotate|invert|saturate|sepia|opacity|drop-shadow)\([^()]*(\([^()]*\))?[^()]*\)\s*)+$|^none$/.test(v);
}

/** Background images take a URL (never raw CSS), optionally layered over a gradient: "gradient|url". */
function imageDecl(v: string): string | null {
  const url = v.trim();
  if (url === 'none') return 'background-image:none';
  if (!/^(https?:\/\/|\/)/.test(url) && !/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(url)) return null;
  const safe = encodeURI(decodeSafe(url)).replace(/["'()\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `background-image:url("${safe}");background-size:cover;background-position:center`;
}
function decodeSafe(u: string) {
  try {
    return decodeURI(u);
  } catch {
    return u;
  }
}

/** Validate + compile one property value. Returns null for unknown keys or unsafe values. */
export function compileDecl(key: string, raw: unknown): string | null {
  const prop = STYLE_PROP_MAP[key];
  if (!prop || raw === undefined || raw === null || raw === '') return null;
  if (prop.control === 'image') return prop.css(String(raw));
  const v = cssValue(raw);
  if (v === null) return null;
  return prop.css(v);
}

/* ───────────────────────── stylesheet ───────────────────────── */

export interface StylePreset {
  label?: string;
  style?: StyleProps;
  responsive?: Partial<Record<Breakpoint, StyleProps>>;
  states?: Partial<Record<StyleState, StyleProps>>;
}

export const PRESET_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const STATE_SELECTOR: Record<StyleState, string> = { hover: ':hover', focus: ':focus-visible', active: ':active' };

type Rule = { layer: 0 | 1; bp: Breakpoint | null; css: string };

export class StyleSheet {
  private rules = new Map<string, Rule>();

  private add(selector: string, decls: string[], bp: Breakpoint | null, layer: 0 | 1, key: string) {
    if (!decls.length || this.rules.has(key)) return;
    this.rules.set(key, { layer, bp, css: `${selector}{${decls.join(';')}}` });
  }

  private declsOf(style: StyleProps | undefined): string[] {
    const out: string[] = [];
    for (const [k, raw] of Object.entries(style ?? {})) {
      const d = compileDecl(k, raw);
      if (d) out.push(d);
    }
    return out;
  }

  /** Atomic classes for a node's style, responsive overrides and interaction states. */
  classesFor(style?: StyleProps, responsive?: Partial<Record<Breakpoint, StyleProps>>, states?: Partial<Record<StyleState, StyleProps>>): string[] {
    const out: string[] = [];
    const add = (props: StyleProps | undefined, bp: Breakpoint | null, state: StyleState | null) => {
      for (const [k, raw] of Object.entries(props ?? {})) {
        const decl = compileDecl(k, raw);
        if (!decl) continue;
        const cls = `m-${bp ? bp + '-' : ''}${state ? state[0] + '-' : ''}${k}-${hash(String(raw))}`;
        const sel = `.${cls}${state ? STATE_SELECTOR[state] : ''}`;
        // Declarations get !important-free specificity; state rules use the same class + pseudo, so they win naturally.
        this.add(sel, [decl], bp, 1, cls);
        out.push(cls);
      }
    };
    add(style, null, null);
    for (const bp of Object.keys(BREAKPOINTS) as Breakpoint[]) add(responsive?.[bp], bp, null);
    for (const st of STYLE_STATES) add(states?.[st], null, st);
    return out;
  }

  /** Named preset class (emitted before atomic rules so per-node styles override presets). */
  presetClass(name: string, preset: StylePreset | undefined): string | null {
    if (!preset || !PRESET_NAME_RE.test(name)) return null;
    const cls = `s-${name}`;
    this.add(`.${cls}`, this.declsOf(preset.style), null, 0, `preset:${name}`);
    for (const bp of Object.keys(BREAKPOINTS) as Breakpoint[]) this.add(`.${cls}`, this.declsOf(preset.responsive?.[bp]), bp, 0, `preset:${name}:${bp}`);
    for (const st of STYLE_STATES) this.add(`.${cls}${STATE_SELECTOR[st]}`, this.declsOf(preset.states?.[st]), null, 0, `preset:${name}:${st}`);
    return cls;
  }

  /** Add a raw, block-owned rule (static block CSS), keyed for de-duplication. Emitted first. */
  addBlockCss(key: string, css: string) {
    if (!this.rules.has(key)) this.rules.set(key, { layer: 0, bp: null, css });
  }

  toString(): string {
    // Order: block css + presets (layer 0) then atomic (layer 1); within each, base then breakpoints large→small.
    const bps = (Object.entries(BREAKPOINTS) as [Breakpoint, number][]).sort((a, b) => b[1] - a[1]);
    let out = '';
    for (const layer of [0, 1] as const) {
      const rules = [...this.rules.values()].filter((r) => r.layer === layer);
      out += rules.filter((r) => !r.bp).map((r) => r.css).join('');
      for (const [bp, px] of bps) {
        const inBp = rules.filter((r) => r.bp === bp);
        if (inBp.length) out += `@media (max-width:${px}px){${inBp.map((r) => r.css).join('')}}`;
      }
    }
    return out;
  }

  get size() {
    return this.rules.size;
  }
}
