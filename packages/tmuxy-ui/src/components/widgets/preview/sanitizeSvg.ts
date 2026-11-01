/**
 * Turn a mermaid-rendered SVG string into a node that cannot run anything.
 *
 * Markdown is rendered in the APP's own origin, not in
 * the sandboxed iframe a page gets, so anything that executes here can POST
 * tmux commands exactly as the app does. Mermaid draws in a frame of its own
 * (`drawMermaid.ts`) and sanitizes each label it draws, and this is not a
 * claim that it does so badly — it is that mermaid has had bypasses before
 * and the blast radius on this side of the boundary is a shell. So what comes
 * back is treated as hostile, and only what a diagram is drawn with is kept:
 *
 * - **`DOMParser` with `text/html`** builds the tree in an inert document.
 *   Nothing in it runs while it is being parsed, unlike assigning to
 *   `innerHTML`, where a `<script>` still does not execute but an inline
 *   handler on a rendered element very much does. `text/html` and not
 *   `image/svg+xml`: the latter is a STRICT XML parse, and mermaid's real
 *   output is not well-formed XML — it puts HTML in its labels (`<br>`,
 *   `&nbsp;`), so strict parsing rejected the whole diagram and the story
 *   asserting `.widget-mermaid svg` got null. The HTML parser is as lenient as
 *   `innerHTML` about that while still being inert, which is the property that
 *   matters here.
 * - **Elements are allowed by name and namespace, not refused by name.** Out
 *   of a label, an element stays only when it is SVG (`SVG_TAGS`: shapes,
 *   text, paint servers, filter effects); anything else goes with what is in
 *   it — `<script>`, `<feImage>`, SVG's animation elements (one can write
 *   `href="javascript:…"` onto a link AFTER this walk has passed it), and any
 *   HTML the parser put in the SVG. `<title>` and `<desc>` are kept as their
 *   text alone: the HTML parser builds HTML inside them, exactly as it does
 *   inside a `<foreignObject>`, so `<desc><img src=…>` would otherwise be a
 *   live `<img>`.
 *
 *   `<foreignObject>` STAYS, and that is a deliberate trade rather than an
 *   oversight. It is the door from SVG back into HTML — but mermaid's default
 *   `htmlLabels` renders every node's label through one, so removing it
 *   removes the text of the diagram. Inside one, only HTML text formatting
 *   survives (`LABEL_TAGS`); anything else is replaced by its text.
 * - **Every `on*` attribute goes**, whatever its case, and so does every
 *   attribute that sends a request or opens a window of its own (`ping`,
 *   `rel`, `target`, …): a middle click on a link is not a `click`, so the
 *   block's own handler never sees it.
 * - **The diagram's id is the caller's**, never the markup's: `<style>` keeps
 *   only rules scoped to it (`#<id> …`, the form mermaid writes), so a diagram
 *   cannot restyle the app around it, nor claim an id of the app's (`root`)
 *   to do so. Nothing in it — or in any attribute — may fetch: `url(…)` other
 *   than a same-document `url(#…)`, `src(…)`, `@import`, `image(…)`,
 *   `image-set(…)` or a backslash escape that could spell one.
 * - **References**: a link (`<a>`) keeps `http(s):` and `#` targets, an
 *   `<image>` `data:image/…` (plus `http(s):` when the preview was opened with
 *   `--net`, docs/SECURITY-CONTENT.md), and anything else a same-document `#…`.
 *
 * Returns null when the string does not parse as SVG at all, which the caller
 * shows as a render error rather than an empty box.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** The SVG a diagram is drawn with, by lowercased local name. */
const SVG_TAGS = new Set([
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'switch',
  'style',
  'title',
  'desc',
  'a',
  'foreignobject',
  'image',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'textpath',
  'marker',
  'clippath',
  'mask',
  'pattern',
  'lineargradient',
  'radialgradient',
  'stop',
  'filter',
  'feblend',
  'fecolormatrix',
  'fecomponenttransfer',
  'fecomposite',
  'feconvolvematrix',
  'fediffuselighting',
  'fedisplacementmap',
  'fedistantlight',
  'fedropshadow',
  'feflood',
  'fefunca',
  'fefuncb',
  'fefuncg',
  'fefuncr',
  'fegaussianblur',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fepointlight',
  'fespecularlighting',
  'fespotlight',
  'fetile',
  'feturbulence',
]);

/** SVG whose words are kept and nothing else: the HTML parser builds HTML in them. */
const TEXT_ONLY_TAGS = new Set(['title', 'desc']);

/** The HTML a `<foreignObject>` label may hold: text and its formatting. */
const LABEL_TAGS = new Set(['div', 'span', 'p', 'b', 'i', 'strong', 'em', 'br', 'code', 'u', 's']);

/** Attributes that send a request, open a window or load a source of their own. */
const DROP_ATTRS = new Set([
  'ping',
  'rel',
  'target',
  'download',
  'referrerpolicy',
  'src',
  'srcset',
  'formaction',
]);

const LINK_REF = /^(?:https?:\/\/|#)/i;
const FRAGMENT_REF = /^#/;
const IMAGE_REF = /^data:image\//i;
const NET_REF = /^https?:\/\//i;

/** CSS that would fetch something, or hide what it fetches behind an escape. */
const FETCHING_CSS = /url\(\s*['"]?\s*(?!#)|src\(|@import|image(?:-set)?\(|\\/i;

/**
 * The rules of a mermaid `<style>` that apply inside the diagram `id` and
 * fetch nothing. At-rules (`@import`, `@font-face`, `@keyframes`) go, and so
 * does any rule with a selector that is not under `#id`.
 */
function scopedCss(css: string, id: string): string {
  const prefix = `#${id}`;
  const kept: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) {
      const rule = css.slice(start, i + 1).trim();
      start = i + 1;
      const open = rule.indexOf('{');
      const selectors = rule
        .slice(0, open)
        .split(',')
        .map((s) => s.trim());
      const body = rule.slice(open);
      // `#id` itself, or followed by a combinator, class or pseudo — never
      // by more of a name, which would be another diagram (`#id` vs `#id0`).
      const scoped =
        !rule.startsWith('@') &&
        selectors.every(
          (s) => s.startsWith(prefix) && /^(?:$|[\s.:>~+[])/.test(s.slice(prefix.length)),
        );
      if (scoped && !FETCHING_CSS.test(body) && !body.slice(1).includes('{')) kept.push(rule);
    }
  }
  return kept.join('\n');
}

/** Whether `el` may keep a reference to `value`. */
function allowedRef(el: Element, value: string, net: boolean): boolean {
  const tag = el.localName.toLowerCase();
  if (tag === 'a') return LINK_REF.test(value);
  if (tag === 'image') return IMAGE_REF.test(value) || (net && NET_REF.test(value));
  return FRAGMENT_REF.test(value);
}

export function sanitizeSvg(
  svg: string,
  options: { id: string; net?: boolean },
): SVGElement | null {
  // The HTML parser puts `<svg>` in the SVG namespace as foreign content, so
  // the element that comes out is a real SVGElement and imports as one.
  const parsed = new DOMParser().parseFromString(svg, 'text/html');
  const root = parsed.body.querySelector('svg');
  if (!root) return null;
  const net = options.net === true;

  const cleanAttributes = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || DROP_ATTRS.has(name) || FETCHING_CSS.test(value)) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'xlink:href') && !allowedRef(el, value, net)) {
        el.removeAttribute(attr.name);
      }
    }
  };

  const walk = (el: Element, inLabel: boolean) => {
    cleanAttributes(el);
    for (const child of Array.from(el.children)) {
      const tag = child.localName.toLowerCase();
      if (tag === 'style') {
        cleanAttributes(child);
        child.textContent = scopedCss(child.textContent ?? '', options.id);
      } else if (inLabel) {
        if (child.namespaceURI === HTML_NS && LABEL_TAGS.has(tag)) walk(child, true);
        else child.replaceWith(parsed.createTextNode(child.textContent ?? ''));
      } else if (child.namespaceURI !== SVG_NS || !SVG_TAGS.has(tag)) {
        child.remove();
      } else if (TEXT_ONLY_TAGS.has(tag)) {
        cleanAttributes(child);
        child.replaceChildren(child.textContent ?? '');
      } else {
        walk(child, tag === 'foreignobject');
      }
    }
  };
  root.setAttribute('id', options.id);
  walk(root, false);

  return root as unknown as SVGElement;
}
