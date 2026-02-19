import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

let mermaidInitialized = false;
let renderCounter = 0;

function initMermaid() {
  if (mermaidInitialized) return;
  mermaidInitialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      primaryColor: '#2d4f2d',
      primaryTextColor: '#e5e5e5',
      primaryBorderColor: '#00cd00',
      lineColor: '#7f7f7f',
      secondaryColor: '#2d2d4f',
      tertiaryColor: '#4f2d2d',
      background: '#1e1e1e',
      mainBkg: '#2d4f2d',
      nodeBorder: '#00cd00',
      clusterBkg: '#2d2d2d',
      clusterBorder: '#7f7f7f',
      titleColor: '#e5e5e5',
      edgeLabelBackground: '#1e1e1e',
    },
    fontFamily: 'inherit',
  });
}

interface MermaidBlockProps {
  chart: string;
}

export function MermaidBlock({ chart }: MermaidBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    initMermaid();
    const id = `mermaid-${++renderCounter}`;
    let cancelled = false;

    mermaid.render(id, chart).then(
      ({ svg }) => {
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
          setError(null);
        }
      },
      (err) => {
        if (!cancelled) {
          setError(String(err));
        }
      }
    );

    return () => { cancelled = true; };
  }, [chart]);

  if (error) {
    return <pre className="widget-markdown-error">{error}</pre>;
  }

  return <div ref={containerRef} className="widget-mermaid" />;
}
