/**
 * A ```mermaid fence, drawn as a diagram in the theme's colours.
 *
 * Mermaid renders into the APP's own origin, where anything that executes can
 * drive the API, so its output is sanitized twice: by mermaid itself
 * (`securityLevel: 'strict'`) and again at the sink (`sanitizeSvg`), the pass
 * a bypass would also have to get past.
 */

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import mermaid from 'mermaid';
import { sanitizeSvg } from './sanitizeSvg';
import type { PreviewTheme } from './previewTheme';
import { openExternalUrl, safeHref } from '../../../utils/openUrl';

let renderCounter = 0;

/** Mermaid is configured globally, so each render sets the theme it draws in. */
function configure(theme: PreviewTheme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
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

/**
 * A click on a link in the diagram: a web link opens in the browser, the way
 * the markdown's own links do, and nothing ever navigates the app itself.
 */
function onDiagramClick(event: MouseEvent<HTMLDivElement>) {
  const link = (event.target as Element).closest('a');
  if (!link) return;
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
    configure(theme);
    mermaid.render(`preview-mermaid-${++renderCounter}`, chart).then(
      ({ svg }) => {
        if (cancelled || !containerRef.current) return;
        const safe = sanitizeSvg(svg, { net });
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
  return <div ref={containerRef} className="preview-mermaid" onClick={onDiagramClick} />;
}
