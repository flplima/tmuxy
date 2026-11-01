/**
 * Mermaid, drawing a diagram somewhere that is not the app.
 *
 * Mermaid lays a diagram out by drawing it into a live document and
 * measuring it, and only then hands back the SVG — so whatever a diagram's
 * labels hold is in a document BEFORE `sanitizeSvg` ever sees it. Under
 * `securityLevel: 'strict'` that document is the app's own `document.body`:
 * an `<img>` in a label loads from there, which tells its host the file was
 * read even without `--net`, and a bypass of mermaid's sanitizer runs with
 * the app's access to the API.
 *
 * So mermaid draws in sandbox mode, into a frame this module makes for it:
 *
 * - **The frame may run nothing.** Its `sandbox` attribute (`allow-same-origin`
 *   only, so mermaid can still reach in and measure) is set BEFORE the frame
 *   is inserted, which is when its document is made. Mermaid's own sandbox
 *   frame gets its attribute only after insertion, so its document is an
 *   ordinary one of the app's origin, with scripts.
 * - **The frame may fetch nothing** but `data:` pictures — and the web's too
 *   with `--net` — by a policy put in its head before mermaid draws.
 * - **A formula is drawn as its text.** Mermaid measures a `$$…$$` formula by
 *   putting it, with the rest of its line, into a `<div>` of the app's
 *   document, outside any frame; the `$$` is broken so it never does.
 *
 * Diagrams draw one at a time: mermaid's configuration is global, and so is
 * the one lookup this module answers from the frame (see `draw`).
 */

import mermaid from 'mermaid';
import type { PreviewTheme } from './previewTheme';

let renderCounter = 0;
let queue: Promise<unknown> = Promise.resolve();

/** Mermaid is configured globally, so each render sets the theme it draws in. */
function configure(theme: PreviewTheme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'sandbox',
    // A diagram's `%%{init}%%` directive may not change these: `themeCSS`
    // would put the document's own CSS into the app.
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'maxTextSize',
      'suppressErrorRendering',
      'maxEdges',
      'theme',
      'themeCSS',
      'themeVariables',
      'darkMode',
      'fontFamily',
      'altFontFamily',
    ],
    theme: 'base',
    darkMode: theme.mode === 'dark',
    fontFamily: 'inherit',
    themeVariables: {
      background: theme.background,
      primaryColor: theme.surface,
      primaryTextColor: theme.foreground,
      primaryBorderColor: theme.accent,
      secondaryColor: theme.surface,
      tertiaryColor: theme.background,
      lineColor: theme.muted,
      textColor: theme.foreground,
      mainBkg: theme.surface,
      nodeBorder: theme.accent,
      clusterBkg: theme.background,
      clusterBorder: theme.border,
      titleColor: theme.foreground,
      edgeLabelBackground: theme.background,
    },
  });
}

/** What the drawing document may load: its own styles, and pictures. */
function drawingPolicy(net: boolean): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:${net ? ' http: https:' : ''}`;
}

/**
 * The element mermaid is told to draw in. Mermaid puts its sandbox frame in
 * it with `appendChild`, which is where the frame is sandboxed and given its
 * policy; `frame()` is the document it got, null if mermaid never asked.
 */
function drawingHost(net: boolean) {
  const host = document.createElement('div');
  host.className = 'preview-mermaid-drawing';
  host.setAttribute('aria-hidden', 'true');
  let frame: Document | null = null;
  Object.defineProperty(host, 'appendChild', {
    value: <T extends Node>(node: T): T => {
      const isFrame = node instanceof HTMLIFrameElement;
      if (isFrame) node.setAttribute('sandbox', 'allow-same-origin');
      Node.prototype.appendChild.call(host, node);
      if (isFrame && node.contentDocument) {
        const doc = node.contentDocument;
        const policy = doc.createElement('meta');
        policy.httpEquiv = 'Content-Security-Policy';
        policy.content = drawingPolicy(net);
        doc.head.appendChild(policy);
        frame = doc;
      }
      return node;
    },
  });
  return { host, frame: () => frame };
}

/** Sandbox mode hands the SVG back inside a `data:` frame; this is the markup in it. */
function framedMarkup(frameHtml: string): string {
  const data = /\bsrc="data:text\/html;charset=UTF-8;base64,([A-Za-z0-9+/=]+)"/.exec(
    frameHtml,
  )?.[1];
  if (!data) throw new Error('mermaid returned the diagram in a form the preview does not read');
  return new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
}

async function draw(chart: string, theme: PreviewTheme, net: boolean) {
  configure(theme);
  const id = `preview-mermaid-${++renderCounter}`;
  const { host, frame } = drawingHost(net);
  // gitGraph and eventmodeling look their SVG up in the app's document even
  // in sandbox mode (d3's `select`, i.e. `document.querySelector`). That one
  // selector, unique to this diagram, is answered from the frame.
  const lookup = `[id="${id}"]`;
  Object.defineProperty(document, 'querySelector', {
    configurable: true,
    value: (selector: string) =>
      selector === lookup && frame()
        ? frame()!.querySelector(selector)
        : Document.prototype.querySelector.call(document, selector),
  });
  document.body.appendChild(host);
  try {
    const { svg } = await mermaid.render(id, chart.replace(/\$\$/g, '$​$'), host);
    if (!frame()) throw new Error('mermaid did not draw the diagram in its frame');
    return { id, markup: framedMarkup(svg) };
  } finally {
    Reflect.deleteProperty(document, 'querySelector');
    host.remove();
  }
}

/**
 * Draw `chart` and return its SVG markup, unsanitized, with the id its
 * styles are scoped to.
 */
export function drawMermaid(
  chart: string,
  theme: PreviewTheme,
  net: boolean,
): Promise<{ id: string; markup: string }> {
  const drawn = queue.then(() => draw(chart, theme, net));
  queue = drawn.catch(() => undefined);
  return drawn;
}
