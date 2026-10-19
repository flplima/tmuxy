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
 *   `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`, `<form>`.
 *   A script adopted this way does not execute, but removing it costs nothing
 *   and means nobody has to remember why it was safe.
 *
 *   `<foreignObject>` STAYS, and that is a deliberate trade rather than an
 *   oversight. It is the door from SVG back into HTML — but mermaid's default
 *   `htmlLabels` renders every node's label through one, so removing it
 *   removes the text of the diagram. What made it dangerous is the HTML it can
 *   carry, and that HTML is walked by the same two rules as everything else:
 *   no `on*` handlers, nothing that fetches or runs. `<style>` stays too,
 *   because mermaid's theming is in it.
 * - **Only `http(s):`, `data:` and same-document `#` references survive** on
 *   `href`/`xlink:href`, the same shape of allowlist the terminal's own links
 *   use (`utils/openUrl`).
 *
 * Returns null when the string does not parse as SVG at all, which the caller
 * shows as a render error rather than an empty box.
 */

const SAFE_REF = /^(?:https?:\/\/|data:image\/|#)/i;

export function sanitizeSvg(svg: string): SVGElement | null {
  // The HTML parser puts `<svg>` in the SVG namespace as foreign content, so
  // the element that comes out is a real SVGElement and imports as one.
  const parsed = new DOMParser().parseFromString(svg, 'text/html');
  const root = parsed.body.querySelector('svg');
  if (!root) return null;

  const REMOVE = 'script, iframe, object, embed, link, meta, base, form';
  for (const el of Array.from(root.querySelectorAll(REMOVE))) {
    el.remove();
  }

  const walk = (el: Element) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        if (!SAFE_REF.test(attr.value.trim())) el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children)) walk(child);
  };
  walk(root);

  return root as unknown as SVGElement;
}
