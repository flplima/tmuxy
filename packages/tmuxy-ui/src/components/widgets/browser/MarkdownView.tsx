/**
 * Markdown rendered as a page: GFM plus ```mermaid fences drawn as diagrams.
 *
 * Fetching happens during render, keyed by url+nonce, rather than in an effect
 * (see the project's React guidelines): a render with a new key starts the
 * request, and a response whose key is no longer current is dropped — which
 * also covers the post-unmount setState, since nothing re-matches once a later
 * render has moved the key on.
 */

import { useState, useRef, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { MermaidBlock } from './MermaidBlock';
import { openExternalUrl, safeHref } from '../../../utils/openUrl';
import { resolveAgainstDocument } from './markdownUrls';

function markdownComponents(base: string): Components {
  return {
    /**
     * A link the document wrote opens the way a terminal's does: through the
     * http(s)/mailto allowlist, in a new tab, never navigating the app.
     */
    a({ href, children, ...props }) {
      const resolved = resolveAgainstDocument(href, base, window.location.href);
      const safe = resolved ? safeHref(resolved) : undefined;
      return (
        <a
          {...props}
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            if (safe) openExternalUrl(safe);
          }}
        >
          {children}
        </a>
      );
    },
    img({ src, alt, ...props }) {
      const resolved = resolveAgainstDocument(
        typeof src === 'string' ? src : undefined,
        base,
        window.location.href,
      );
      if (!resolved) return null;
      return <img {...props} src={resolved} alt={alt ?? ''} />;
    },
    ...staticComponents,
  };
}

const staticComponents: Components = {
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
  // Rebuilt only when the document changes: every link and image in it is
  // resolved against this URL.
  const components = useMemo(() => markdownComponents(url), [url]);

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
