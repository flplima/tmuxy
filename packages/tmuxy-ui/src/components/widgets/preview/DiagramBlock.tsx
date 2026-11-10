/**
 * A ```mermaid or ```pele fence, drawn as a diagram in the theme's colours.
 *
 * Pele draws it: it reads Mermaid's syntax and returns SVG from the text
 * alone, with no document to lay it out in, and its colours are CSS variables
 * the theme sets (`preview.css`), so a theme change repaints without a redraw.
 * Mounted, it lays the diagram out again when the pane's width changes.
 *
 * What a diagram holds comes from the file, and anything that executes in the
 * APP's origin can drive the API. So whatever drew it, the SVG is sanitized at
 * the sink (`sanitizeSvg`) before any of it is adopted.
 *
 * A diagram pele cannot draw goes to mermaid itself, loaded only then, which
 * draws in a frame that can run and fetch nothing (`drawMermaid`).
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { mountAsync, renderAsync, type MountOptions } from 'pele/lazy';
import { sanitizeSvg } from './sanitizeSvg';
import type { PreviewTheme } from './previewTheme';
import { openExternalUrl, safeHref } from '../../../infra/openUrl';

const WEB = ['http', 'https'];
let diagramCounter = 0;

/**
 * A click on a link in the diagram, left or middle: a web link opens in the
 * browser, the way the markdown's own links do, and nothing ever navigates
 * the app itself — nor opens a tab of its own on a middle click.
 */
function onDiagramClick(event: MouseEvent<HTMLDivElement>) {
  const link = (event.target as Element).closest('a');
  if (!link || event.button > 1) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? '';
  const safe = href.startsWith('#') ? undefined : safeHref(href);
  if (safe) openExternalUrl(safe);
}

function sanitized(markup: string, id: string, net: boolean): SVGElement {
  const safe = sanitizeSvg(markup, { id, net });
  if (!safe) throw new Error('the diagram did not render as valid SVG');
  return safe;
}

/** Links to the web only, and pictures from it only when the preview may fetch. */
function peleOptions(id: string, net: boolean): MountOptions {
  return {
    idPrefix: id,
    linkSchemes: WEB,
    images: net,
    imageSchemes: net ? WEB : [],
    sanitize: (svg) => sanitized(svg, id, net),
  };
}

/** Mermaid's own drawing of `chart`, for what pele refused. */
async function drawWithMermaid(chart: string, theme: PreviewTheme, net: boolean) {
  const { drawMermaid } = await import('./drawMermaid');
  const { id, markup } = await drawMermaid(chart, theme, net);
  return sanitized(markup, id, net);
}

export function DiagramBlock({
  chart,
  theme,
  net,
}: {
  chart: string;
  theme: PreviewTheme;
  net: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    const options = peleOptions(`preview-diagram-${++diagramCounter}`, net);

    const draw = async () => {
      try {
        // Asked first without a mount: a mount draws its own error into the
        // container, and a refusal here is mermaid's to try instead.
        await renderAsync(chart, options);
        if (cancelled) return;
        const mounted = await mountAsync(container, chart, options);
        if (cancelled) mounted.destroy();
        else stop = () => mounted.destroy();
      } catch (refusal) {
        try {
          const svg = await drawWithMermaid(chart, themeRef.current, net);
          if (!cancelled) container.replaceChildren(svg);
        } catch {
          throw refusal;
        }
      }
    };
    draw().then(
      () => !cancelled && setError(null),
      (err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)),
    );

    return () => {
      cancelled = true;
      stop?.();
      container.replaceChildren();
    };
  }, [chart, net]);

  return (
    <>
      {error && <pre className="preview-markdown-error">{error}</pre>}
      <div
        ref={containerRef}
        className="preview-diagram"
        hidden={error !== null}
        onClick={onDiagramClick}
        onAuxClick={onDiagramClick}
      />
    </>
  );
}
