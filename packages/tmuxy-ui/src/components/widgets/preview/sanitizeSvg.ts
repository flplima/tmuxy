/**
 * Turn a mermaid-rendered SVG string into a node that cannot run anything.
 *
 * SEC-20. Markdown is rendered in the APP's own origin, not in the sandboxed
 * iframe a page gets, so anything that executes here can POST tmux commands
 * exactly as the app does. Mermaid sanitizes its own output (`securityLevel:
 * strict`, DOMPurify) and this is not a claim that it does so badly — it is
 * that mermaid has had bypasses before (fixed in 11.10.0) and the blast radius
 * on this side of the boundary is a shell.
 *
 * So the SVG is parsed as SVG and stripped again before it is adopted:
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
 * - **Every `on*` attribute goes**, whatever its case, because that is the one
 *   thing adoption would otherwise carry into the live document alive.
 * - **Elements that fetch or run go**, anywhere in the tree: `<script>`,
 *   `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`,
 *   and the media and filter elements that load a URL of their own
 *   (`<audio>`, `<video>`, `<feImage>`). So do SVG's animation elements
 *   (`<animate>`, `<set>`, `<animateTransform>`, `<animateMotion>`): one can
 *   write `href="javascript:…"` onto a link AFTER this walk has passed it.
 *
 *   `<foreignObject>` STAYS, and that is a deliberate trade rather than an
 *   oversight. It is the door from SVG back into HTML — but mermaid's default
 *   `htmlLabels` renders every node's label through one, so removing it
 *   removes the text of the diagram. Inside one, only text formatting
 *   survives (`LABEL_TAGS`); anything else is replaced by its text.
 * - **`<style>` keeps only rules scoped to this diagram** (`#<svg id> …`, the
 *   form mermaid writes), so a diagram cannot restyle the app around it, and
 *   nothing in it — or in any attribute — may fetch: `url(…)` other than a
 *   same-document `url(#…)`, `@import`, `image-set(…)` or a backslash escape
 *   that could spell one.
 * - **References**: a link (`<a>`) keeps `http(s):` and `#` targets; anything
 *   else that names a URL keeps only `#…` and `data:image/…`, plus `http(s):`
 *   when the preview was opened with `--net` (docs/SECURITY-CONTENT.md).
 *
 * Returns null when the string does not parse as SVG at all, which the caller
 * shows as a render error rather than an empty box.
 */

/** What can fetch or run, by lowercased local name. */
const REMOVE = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'form',
  'audio',
  'video',
  'feimage',
  'animate',
  'set',
  'animatetransform',
  'animatemotion',
]);

/** The HTML a `<foreignObject>` label may hold: text and its formatting. */
const LABEL_TAGS = new Set(['div', 'span', 'p', 'b', 'i', 'strong', 'em', 'br', 'code', 'u', 's']);

const LINK_REF = /^(?:https?:\/\/|#)/i;
const LOCAL_REF = /^(?:#|data:image\/)/i;
const NET_REF = /^https?:\/\//i;

/** CSS that would fetch something, or hide what it fetches behind an escape. */
const FETCHING_CSS = /url\(\s*['"]?\s*(?!#)|@import|image-set\(|\\/i;

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

export function sanitizeSvg(svg: string, options: { net?: boolean } = {}): SVGElement | null {
  // The HTML parser puts `<svg>` in the SVG namespace as foreign content, so
  // the element that comes out is a real SVGElement and imports as one.
  const parsed = new DOMParser().parseFromString(svg, 'text/html');
  const root = parsed.body.querySelector('svg');
  if (!root) return null;
  const id = root.getAttribute('id');

  const allowedRef = (el: Element, value: string): boolean => {
    if (el.localName.toLowerCase() === 'a') return LINK_REF.test(value);
    return LOCAL_REF.test(value) || (options.net === true && NET_REF.test(value));
  };

  const walk = (el: Element, inLabel: boolean) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on') || FETCHING_CSS.test(value)) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'xlink:href') && !allowedRef(el, value)) {
        el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children)) {
      const tag = child.localName.toLowerCase();
      if (REMOVE.has(tag)) {
        child.remove();
      } else if (tag === 'style') {
        child.textContent = id ? scopedCss(child.textContent ?? '', id) : '';
      } else if (inLabel && !LABEL_TAGS.has(tag)) {
        child.replaceWith(parsed.createTextNode(child.textContent ?? ''));
      } else {
        walk(child, inLabel || tag === 'foreignobject');
      }
    }
  };
  walk(root, false);

  return root as unknown as SVGElement;
}
