import { useState, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WidgetProps } from './index';
import { MermaidBlock } from './MermaidBlock';
import type { Components } from 'react-markdown';

/** Extract file path and sequence number from widget lines */
function extractMeta(lines: string[]): { filePath: string; seq: string } | null {
  let filePath = '';
  let seq = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('__FILE__:')) filePath = trimmed.slice('__FILE__:'.length);
    if (trimmed.startsWith('__SEQ__:')) seq = trimmed.slice('__SEQ__:'.length);
  }
  return filePath ? { filePath, seq } : null;
}

const components: Components = {
  code({ className, children, ...props }) {
    if (/language-mermaid/.exec(className || '')) {
      return <MermaidBlock chart={String(children).trimEnd()} />;
    }
    if (!className) {
      return (
        <code className="tmuxy-widget-markdown-inline-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre({ children, ...props }) {
    return (
      <pre className="tmuxy-widget-markdown-pre" {...props}>
        {children}
      </pre>
    );
  },
};

/** Fetch file content, triggered during render when meta changes (no useEffect) */
function useFetchFile(filePath: string | undefined, seq: string | undefined) {
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef('');

  const fetchKey = `${filePath}:${seq}`;
  if (filePath && fetchKey !== lastFetchRef.current) {
    lastFetchRef.current = fetchKey;
    const url = `/api/file?path=${encodeURIComponent(filePath)}`;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then((text) => {
        setContent(text);
        setError(null);
      })
      .catch((err) => setError(String(err)));
  }

  return { content, error };
}

export function TmuxyMarkdown({ lines }: WidgetProps) {
  const meta = extractMeta(lines);
  const { content, error } = useFetchFile(meta?.filePath, meta?.seq);

  if (error) {
    return <div className="tmuxy-widget-markdown-empty">{error}</div>;
  }

  if (!content.trim()) {
    return <div className="tmuxy-widget-markdown-empty">Waiting for content...</div>;
  }

  return (
    <div className="tmuxy-widget-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
