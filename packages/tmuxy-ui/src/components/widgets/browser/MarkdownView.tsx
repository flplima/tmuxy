/**
 * Markdown rendered as a page: GFM plus ```mermaid fences drawn as diagrams.
 *
 * Fetching happens during render, keyed by url+nonce, rather than in an effect
 * (see the project's React guidelines): a render with a new key starts the
 * request, and a response whose key is no longer current is dropped — which
 * also covers the post-unmount setState, since nothing re-matches once a later
 * render has moved the key on.
 */

import { useState, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { MermaidBlock } from './MermaidBlock';

const components: Components = {
  code({ className, children, ...props }) {
    if (/language-mermaid/.exec(className || '')) {
      return <MermaidBlock chart={String(children).trimEnd()} />;
    }
    if (!className) {
      return (
        <code className="widget-markdown-inline-code" {...props}>
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
      <pre className="widget-markdown-pre" {...props}>
        {children}
      </pre>
    );
  },
};

function useFetchText(url: string): { text: string; error: string | null } {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const lastFetchRef = useRef('');

  if (url && url !== lastFetchRef.current) {
    lastFetchRef.current = url;
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then((body) => {
        if (lastFetchRef.current !== url) return;
        setText(body);
        setError(null);
      })
      .catch((err) => {
        if (lastFetchRef.current !== url) return;
        setError(String(err));
      });
  }

  return { text, error };
}

interface MarkdownViewProps {
  /** The URL to read the markdown source from. */
  url: string;
}

export function MarkdownView({ url }: MarkdownViewProps) {
  const { text, error } = useFetchText(url);

  if (error) {
    return <div className="widget-markdown-empty">{error}</div>;
  }

  if (!text) {
    return <div className="widget-markdown-empty">Waiting for content...</div>;
  }

  return (
    <div className="widget-markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
}
