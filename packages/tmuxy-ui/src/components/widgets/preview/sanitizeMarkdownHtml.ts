/**
 * Parse and sanitize raw HTML inside a markdown document (`MarkdownPreview`).
 *
 * Markdown renders in the APP's own origin (unlike an `.html` preview, which
 * runs in a sandboxed iframe), so nothing in it may execute, style the app
 * around it, or fetch without the preview's own `a` / `img` / `source` rules:
 *
 * - Raw HTML nodes from `remark-rehype` are parsed in an inert `DOMParser`
 *   document (`text/html`), where scripts never run and images never load.
 *   Verbatim code blocks (`<pre>`, `<code>`) and GFM footnote sections are
 *   held aside in slots so their contents are never re-parsed as markup.
 * - Elements are kept by explicit allowlist (`ALLOWED_TAGS`): common markdown
 *   HTML (`<details>`, `<summary>`, `<kbd>`, `<sub>`, `<sup>`, `<br>`,
 *   `<img>`, `<picture>`, `<source>`, `<div align>`, `<mark>`, `<ins>`, `<u>`,
 *   `<dl>`/`<dt>`/`<dd>`, `<table>` with `colspan`/`rowspan`, `<ruby>`, etc.)
 *   plus interactive form controls (`<input>`, `<select>`, `<textarea>`,
 *   `<label>`). `<script>`, `<style>`, `<iframe>`, `<svg>`, `<object>` and
 *   `<button>` are dropped with their contents; `<form>` is unwrapped so its
 *   controls render without a form that could submit or navigate.
 * - Attributes are kept by per-tag allowlist: no `on*` handlers, no `style`
 *   (which could `position: fixed` over the app or fetch via `url()`), and no
 *   `class` (which could impersonate app chrome selectors).
 */

type PropertyValue = string | number | boolean | (string | number)[] | null | undefined;
type Properties = Record<string, PropertyValue>;

interface Text {
  type: 'text';
  value: string;
}

interface Raw {
  type: 'raw';
  value: string;
}

interface Comment {
  type: 'comment';
  value: string;
}

interface Doctype {
  type: 'doctype';
}

interface Element {
  type: 'element';
  tagName: string;
  properties?: Properties;
  children: ElementContent[];
}

type ElementContent = Element | Text | Raw | Comment;
type RootContent = ElementContent | Doctype;

interface Root {
  type: 'root';
  children: RootContent[];
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** Tags kept intact in slots so code text and GFM footnotes are never re-parsed as HTML. */
const SLOT_BLOCK_TAGS = new Set(['pre', 'section']);
const SLOT_INLINE_TAGS = new Set(['code']);

/** HTML void elements that take no closing tag or children. */
const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'source', 'col', 'wbr']);

/** Elements whose children are dropped with them (code, styles, frames, foreign namespaces). */
const DROP_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'head',
  'title',
  'noscript',
  'template',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
  'map',
  'area',
  'portal',
  'slot',
  'button',
  'datalist',
  'dialog',
]);

/** Elements allowed in the rendered markdown tree. Unknown non-dropped tags are unwrapped. */
const ALLOWED_TAGS = new Set([
  'div',
  'p',
  'span',
  'br',
  'hr',
  'blockquote',
  'pre',
  'code',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'details',
  'summary',
  'b',
  'i',
  'strong',
  'em',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'kbd',
  'samp',
  'var',
  'abbr',
  'dfn',
  'q',
  'cite',
  'time',
  'ruby',
  'rt',
  'rp',
  'wbr',
  'bdi',
  'bdo',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'caption',
  'colgroup',
  'col',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'a',
  'img',
  'picture',
  'source',
  'figure',
  'figcaption',
  'label',
  'input',
  'select',
  'option',
  'optgroup',
  'textarea',
  'fieldset',
  'legend',
  'meter',
  'progress',
  'output',
]);

/** Safe `<input type="…">` values; `image`, `file`, `submit`, `reset`, `button`, `hidden` become `text`. */
const ALLOWED_INPUT_TYPES = new Set([
  'text',
  'number',
  'range',
  'color',
  'checkbox',
  'radio',
  'search',
  'email',
  'url',
  'tel',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
]);

const GLOBAL_ATTRS = new Set(['id', 'title', 'dir', 'lang', 'align', 'hidden', 'aria-label']);

const CELL_ATTRS = new Set(['colspan', 'rowspan', 'headers', 'scope', 'width', 'height', 'valign']);

const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height', 'align']),
  source: new Set(['src', 'srcset', 'media', 'type', 'width', 'height']),
  details: new Set(['open']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
  td: CELL_ATTRS,
  th: new Set([...CELL_ATTRS, 'abbr']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  q: new Set(['cite']),
  blockquote: new Set(['cite']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
  time: new Set(['datetime']),
  meter: new Set(['value', 'min', 'max', 'low', 'high', 'optimum']),
  progress: new Set(['value', 'max']),
  label: new Set(['for']),
  optgroup: new Set(['label', 'disabled']),
  option: new Set(['value', 'selected', 'disabled', 'label']),
  select: new Set(['name', 'disabled', 'multiple', 'size', 'required']),
  textarea: new Set([
    'name',
    'rows',
    'cols',
    'placeholder',
    'disabled',
    'readonly',
    'maxlength',
    'minlength',
    'required',
  ]),
  fieldset: new Set(['disabled', 'name']),
  input: new Set([
    'type',
    'name',
    'value',
    'checked',
    'disabled',
    'readonly',
    'placeholder',
    'min',
    'max',
    'step',
    'maxlength',
    'minlength',
    'pattern',
    'size',
    'required',
  ]),
};

const BOOLEAN_ATTRS = new Set([
  'open',
  'disabled',
  'checked',
  'readonly',
  'multiple',
  'required',
  'reversed',
  'selected',
  'hidden',
]);

const HAST_PROP_NAME: Record<string, string> = {
  for: 'htmlFor',
  colspan: 'colSpan',
  rowspan: 'rowSpan',
  maxlength: 'maxLength',
  minlength: 'minLength',
  readonly: 'readOnly',
  srcset: 'srcSet',
  valign: 'vAlign',
};

const NO_WHITESPACE_TEXT_PARENTS = new Set([
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'select',
  'optgroup',
]);

const VALID_ALIGN = /^(?:left|center|right|justify)$/i;
const VALID_DIR = /^(?:ltr|rtl|auto)$/i;

let slotNonce = 0;

function hasRawNode(node: Root | RootContent): boolean {
  if (node.type === 'raw') return true;
  if ('children' in node) return node.children.some(hasRawNode);
  return false;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlAttrName(prop: string): string {
  if (prop === 'className') return 'class';
  if (prop === 'htmlFor') return 'for';
  return prop.toLowerCase();
}

function serializeProps(props: Properties | undefined): string {
  if (!props) return '';
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (raw === false || raw === null || raw === undefined) continue;
    const attr = htmlAttrName(key);
    if (raw === true) {
      parts.push(attr);
    } else if (Array.isArray(raw)) {
      parts.push(`${attr}="${escapeHtml(raw.join(' '))}"`);
    } else {
      parts.push(`${attr}="${escapeHtml(String(raw))}"`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function serializeHast(
  nodes: ReadonlyArray<RootContent>,
  slots: Element[],
  slotAttr: string,
): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'raw') {
      out += node.value;
    } else if (node.type === 'text') {
      out += escapeHtml(node.value);
    } else if (node.type === 'element') {
      const tag = node.tagName.toLowerCase();
      if (SLOT_BLOCK_TAGS.has(tag) || SLOT_INLINE_TAGS.has(tag)) {
        const idx = slots.push(node) - 1;
        const wrapper = SLOT_BLOCK_TAGS.has(tag) ? 'div' : 'span';
        out += `<${wrapper} ${slotAttr}="${idx}"></${wrapper}>`;
      } else if (VOID_TAGS.has(tag)) {
        out += `<${tag}${serializeProps(node.properties)}>`;
      } else {
        out += `<${tag}${serializeProps(node.properties)}>${serializeHast(node.children, slots, slotAttr)}</${tag}>`;
      }
    }
  }
  return out;
}

function isAllowedAttrValue(tag: string, name: string, value: string): boolean {
  if (name === 'align') return VALID_ALIGN.test(value);
  if (name === 'dir') return VALID_DIR.test(value);
  if (tag === 'ol' && name === 'type') return /^[1aAiI]$/.test(value);
  return true;
}

function applyDefaultControlValue(tag: string, el: globalThis.Element, props: Properties): void {
  if (tag === 'input' && typeof props.type !== 'string') {
    props.type = 'text';
  } else if (tag === 'textarea') {
    props.value = el.textContent ?? '';
  } else if (tag === 'select') {
    const selected = el.querySelector('option[selected]');
    if (selected) {
      props.value = selected.getAttribute('value') ?? selected.textContent ?? '';
    }
  }
}

function sanitizeAttributes(tag: string, el: globalThis.Element): Properties {
  const allowedForTag = TAG_ATTRS[tag];
  const props: Properties = {};
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const value = attr.value.trim();
    if (!GLOBAL_ATTRS.has(name) && !allowedForTag?.has(name)) continue;
    if (!isAllowedAttrValue(tag, name, value)) continue;
    const propName = HAST_PROP_NAME[name] ?? name;
    props[propName] = BOOLEAN_ATTRS.has(name) ? true : value;
  }
  if (tag === 'input' && typeof props.type === 'string') {
    props.type = props.type.toLowerCase();
  }
  applyDefaultControlValue(tag, el, props);
  return props;
}

function isDroppedElement(tag: string, el: globalThis.Element): boolean {
  if (el.namespaceURI !== HTML_NS || DROP_TAGS.has(tag)) return true;
  if (tag !== 'input') return false;
  const inputType = (el.getAttribute('type') ?? 'text').trim().toLowerCase();
  return !ALLOWED_INPUT_TYPES.has(inputType);
}

function domChildToHast(
  node: ChildNode,
  parentTag: string,
  slots: ReadonlyArray<Element>,
  slotAttr: string,
): ElementContent[] {
  if (node.nodeType === 3) {
    const value = node.nodeValue ?? '';
    if (NO_WHITESPACE_TEXT_PARENTS.has(parentTag) && /^\s*$/.test(value)) return [];
    return [{ type: 'text', value }];
  }
  if (node.nodeType !== 1) return [];
  const el = node as globalThis.Element;
  if (el.hasAttribute(slotAttr)) {
    const slot = slots[Number(el.getAttribute(slotAttr))];
    return slot ? [slot] : [];
  }
  const tag = el.localName.toLowerCase();
  if (isDroppedElement(tag, el)) return [];
  if (!ALLOWED_TAGS.has(tag)) {
    return domChildrenToHast(el, parentTag, slots, slotAttr);
  }
  const properties = sanitizeAttributes(tag, el);
  if (tag === 'option') delete properties.selected;
  const isLeaf = VOID_TAGS.has(tag) || tag === 'textarea';
  const children = isLeaf ? [] : domChildrenToHast(el, tag, slots, slotAttr);
  return [{ type: 'element', tagName: tag, properties, children }];
}

function domChildrenToHast(
  parent: ParentNode,
  parentTag: string,
  slots: ReadonlyArray<Element>,
  slotAttr: string,
): ElementContent[] {
  const out: ElementContent[] = [];
  for (const child of Array.from(parent.childNodes)) {
    out.push(...domChildToHast(child, parentTag, slots, slotAttr));
  }
  return out;
}

/**
 * Rehype plugin that turns raw HTML in a markdown document into sanitized HAST
 * elements, parsed in an inert `DOMParser` document.
 */
export function rehypeSanitizeRawHtml() {
  return (tree: Root): void => {
    if (!hasRawNode(tree)) return;
    const slots: Element[] = [];
    const slotAttr = `data-hast-slot-${++slotNonce}`;
    const html = serializeHast(tree.children, slots, slotAttr);
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    tree.children = domChildrenToHast(parsed.body, 'body', slots, slotAttr);
  };
}
