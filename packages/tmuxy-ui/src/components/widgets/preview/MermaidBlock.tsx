/**
 * A ```mermaid fence, drawn as a diagram in the theme's colours.
 *
 * Mermaid renders into the APP's own origin, where anything that executes can
 * drive the API, so its output is sanitized twice: by mermaid itself
 * (`securityLevel: 'strict'`) and again at the sink (`sanitizeSvg`), the pass
 * a bypass would also have to get past.
 */

import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { sanitizeSvg } from './sanitizeSvg';
import type { PreviewTheme } from './previewTheme';

let renderCounter = 0;

/** Mermaid is configured globally, so each render sets the theme it draws in. */
function configure(theme: PreviewTheme) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
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

export function MermaidBlock({ chart, theme }: { chart: string; theme: PreviewTheme }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    configure(theme);
    mermaid.render(`preview-mermaid-${++renderCounter}`, chart).then(
      ({ svg }) => {
        if (cancelled || !containerRef.current) return;
        const safe = sanitizeSvg(svg);
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
  }, [chart, theme]);

  if (error) return <pre className="preview-markdown-error">{error}</pre>;
  return <div ref={containerRef} className="preview-mermaid" />;
}
