/**
 * A ```mermaid fence, drawn as a diagram in the theme's colours.
 *
 * What a diagram holds comes from the file, and anything that executes in the
 * APP's origin can drive the API. So mermaid never draws in the app's
 * document: it draws in a frame that can run and fetch nothing
 * (`drawMermaid`), sanitizing each label as it goes, and what comes back is
 * sanitized again at the sink (`sanitizeSvg`) before any of it is adopted.
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { drawMermaid } from './drawMermaid';
import { sanitizeSvg } from './sanitizeSvg';
import type { PreviewTheme } from './previewTheme';
import { openExternalUrl, safeHref } from '../../../utils/openUrl';

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

export function MermaidBlock({
  chart,
  theme,
  net,
}: {
  chart: string;
  theme: PreviewTheme;
  net: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    drawMermaid(chart, theme, net).then(
      ({ id, markup }) => {
        if (cancelled || !containerRef.current) return;
        const safe = sanitizeSvg(markup, { id, net });
        if (!safe) {
          setError('the diagram did not render as valid SVG');
          return;
        }
        containerRef.current.replaceChildren(
          containerRef.current.ownerDocument.importNode(safe, true),
        );
        setError(null);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [chart, theme, net]);

  if (error) return <pre className="preview-markdown-error">{error}</pre>;
  return (
    <div
      ref={containerRef}
      className="preview-mermaid"
      onClick={onDiagramClick}
      onAuxClick={onDiagramClick}
    />
  );
}
