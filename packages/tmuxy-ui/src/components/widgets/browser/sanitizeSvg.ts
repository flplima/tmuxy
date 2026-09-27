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
 * - **`DOMParser` with `image/svg+xml`** builds the tree in an inert document.
 *   Nothing in it runs while it is being parsed, unlike assigning to
 *   `innerHTML`, where a `<script>` still does not execute but an inline
 *   handler on a rendered element very much does.
 * - **Every `on*` attribute goes**, whatever its case, because that is the one
 *   thing adoption would otherwise carry into the live document alive.
 * - **`<script>` and `<foreignObject>` go.** A script adopted this way does not
 *   execute, but removing it costs nothing and means nobody has to remember
 *   why it was safe. `<foreignObject>` is the door from SVG back into HTML, and
 *   a diagram has no business using it.
 * - **Only `http(s):`, `data:` and same-document `#` references survive** on
 *   `href`/`xlink:href`, the same shape of allowlist the terminal's own links
 *   use (`utils/openUrl`).
 *
 * Returns null when the string does not parse as SVG at all, which the caller
 * shows as a render error rather than an empty box.
 */

const SAFE_REF = /^(?:https?:\/\/|data:image\/|#)/i;

export function sanitizeSvg(svg: string): SVGElement | null {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  // A parse failure produces a <parsererror> document rather than throwing.
  if (parsed.getElementsByTagName('parsererror').length > 0) return null;

  const root = parsed.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg') return null;

  for (const el of Array.from(root.querySelectorAll('script, foreignObject'))) {
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
