/**
 * A markdown document, drawn by the app: GFM, with ```mermaid fences as
 * diagrams, in the theme's colours.
 *
 * It renders in the APP's origin, so nothing in it may execute: raw HTML in
 * the document is not rendered at all (react-markdown without rehype-raw), a
 * mermaid diagram is sanitized twice (`MermaidBlock`), and a link opens in the
 * system browser only when it is http(s) or mailto — never by navigating the
 * app. An image beside the document is read through `read_preview`; a remote
 * one is loaded only when the preview was opened with `--net`, since loading it
 * tells its host the document was opened.
 */

import { useEffect, useMemo, useRef } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidBlock } from './MermaidBlock';
import { useKeyedRequest } from './useKeyedRequest';
import { useBindingOwnsKey } from '../../../machines/appHooks';
import type { PreviewSource } from './previewSource';
import type { PreviewTheme } from './previewTheme';
import {
  previewResourcePath,
  splitFrontMatter,
  type PreviewDocument,
} from '../../../domain/preview';
import { openExternalUrl, safeHref } from '../../../utils/openUrl';

function LocalImage({ path, alt, source }: { path: string; alt: string; source: PreviewSource }) {
  const image = useKeyedRequest(path, () => source.readResource(path));
  if (!image.value) return <span className="preview-image-blocked">{alt || path}</span>;
  const { mime, data } = image.value;
  return <img src={`data:${mime.split(';')[0]};base64,${data}`} alt={alt} />;
}

function components(source: PreviewSource, theme: PreviewTheme, net: boolean): Components {
  return {
    a({ href, children }) {
      const safe = href ? safeHref(href) : undefined;
      if (!safe) {
        return (
          <span className="preview-link-inert" title={href}>
            {children}
          </span>
        );
      }
      return (
        <a
          href={safe}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => {
            e.preventDefault();
            openExternalUrl(safe);
          }}
        >
          {children}
        </a>
      );
    },
    img({ src, alt }) {
      const ref = typeof src === 'string' ? src : '';
      const path = previewResourcePath(ref);
      if (path) return <LocalImage path={path} alt={alt ?? ''} source={source} />;
      if (net && /^https?:\/\//i.test(ref)) return <img src={ref} alt={alt ?? ''} />;
      return (
        <span className="preview-image-blocked" title={ref}>
          {alt || ref}
        </span>
      );
    },
    code({ className, children }) {
      if (/language-mermaid/.test(className ?? '')) {
        return <MermaidBlock chart={String(children).trimEnd()} theme={theme} net={net} />;
      }
      return className ? (
        <code className={className}>{children}</code>
      ) : (
        <code className="preview-inline-code">{children}</code>
      );
    },
    pre({ children }) {
      return <pre className="preview-pre">{children}</pre>;
    },
  };
}

/** A YAML line's key, after any indent and list dash: `title:`, `  - name:`. */
const YAML_KEY = /^(\s*(?:-\s+)?)([^\s:#][^:#]*?):(?=\s|$)/;

/**
 * The document's front matter, as the YAML it is: a block of its own above
 * the document, its keys picked out. Text only, so a value is never markup.
 */
function FrontMatter({ yaml }: { yaml: string }) {
  return (
    <pre className="preview-front-matter">
      {yaml.split(/\r?\n/).map((line, i) => {
        const key = YAML_KEY.exec(line);
        return (
          <div key={i}>
            {key ? (
              <>
                {key[1]}
                <span className="preview-front-matter-key">{key[2]}</span>:
                {line.slice(key[0].length)}
              </>
            ) : (
              line || '\n'
            )}
          </div>
        );
      })}
    </pre>
  );
}

const LINE = 24;

/**
 * The pager keys, while the preview is the pane with the keyboard: what a
 * reader expects of `less`. Captured before the keyboard actor, which would
 * otherwise send them to the pane, where nothing reads them — except a key
 * that is a binding's, the `j` of `prefix j`, which goes on to the actor.
 */
function usePagerKeys(scrollRef: React.RefObject<HTMLDivElement | null>, active: boolean) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const bindingOwnsKey = useBindingOwnsKey();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = scrollRef.current;
      if (!activeRef.current || !el || e.metaKey || e.altKey) return;
      if (bindingOwnsKey(e.key)) return;
      const page = el.clientHeight;
      const step: Record<string, number> = {
        j: LINE,
        ArrowDown: LINE,
        k: -LINE,
        ArrowUp: -LINE,
        ' ': page,
        PageDown: page,
        b: -page,
        PageUp: -page,
      };
      let to: number | null = null;
      if (e.ctrlKey) {
        if (e.key === 'd') to = el.scrollTop + page / 2;
        else if (e.key === 'u') to = el.scrollTop - page / 2;
      } else if (e.key in step) to = el.scrollTop + step[e.key];
      else if (e.key === 'g' || e.key === 'Home') to = 0;
      else if (e.key === 'G' || e.key === 'End') to = el.scrollHeight;
      if (to === null) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      el.scrollTop = to;
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [scrollRef, bindingOwnsKey]);
}

export function MarkdownPreview({
  doc,
  theme,
  source,
  active,
}: {
  doc: PreviewDocument;
  theme: PreviewTheme;
  source: PreviewSource;
  /** The pane holds the keyboard. */
  active: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  usePagerKeys(scrollRef, active);
  const rendering = useMemo(() => components(source, theme, doc.net), [source, theme, doc.net]);
  const { frontMatter, body } = useMemo(() => splitFrontMatter(doc.text), [doc.text]);
  // The scroller outlives each re-read: the document is replaced inside it,
  // so the reader stays where they were when the file changes.
  return (
    <div ref={scrollRef} className="preview-markdown" tabIndex={0}>
      {frontMatter?.trim() ? <FrontMatter yaml={frontMatter} /> : null}
      <Markdown remarkPlugins={[remarkGfm]} components={rendering}>
        {body}
      </Markdown>
    </div>
  );
}
