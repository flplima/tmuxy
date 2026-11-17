/**
 * A markdown document, drawn by the app: GFM, sanitized raw HTML, and
 * ```mermaid / ```pele fences as diagrams, in the theme's colours.
 *
 * It renders in the APP's origin, so nothing in it may execute: raw HTML in
 * the document is parsed in an inert document and filtered by an explicit
 * tag/attribute allowlist (`sanitizeMarkdownHtml`), a diagram is sanitized
 * before the app adopts it (`DiagramBlock`), and a link opens in the system
 * browser only when it is http(s) or mailto — never by navigating the app. An
 * image beside the document is read through `read_preview`; a remote one is
 * loaded only when the preview was opened with `--net`, since loading it tells
 * its host the document was opened, and without a referrer.
 *
 * Interactive `<input>`, `<select>` and `<textarea>` controls emit a JSON line
 * (`{"input":"…","type":"…","value":…}`) into the preview's pane whenever
 * changed (`onInput`, which tmux types only while the pane previews), so an
 * agent or script listening (`tmuxy pane listen`) can react in real time.
 */

import { useEffect, useMemo, useRef } from 'react';
import { CHAR_HEIGHT } from '../../../constants/layout';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { DiagramBlock } from './DiagramBlock';
import { rehypeSanitizeRawHtml } from './sanitizeMarkdownHtml';
import { useKeyedRequest } from './useKeyedRequest';
import { useBindingOwnsKey } from '../../../machines/appHooks';
import { isRealFormControl } from '../../../machines/actors/keyboard/keyFormatting';
import type { PreviewSource } from './previewSource';
import type { PreviewTheme } from './previewTheme';
import {
  previewResourcePath,
  splitFrontMatter,
  type PreviewDocument,
} from '../../../domain/preview';
import { openExternalUrl, safeHref } from '../../../infra/openUrl';

const INPUT_THROTTLE_MS = 60;
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSanitizeRawHtml];

type PreviewInputValue = string | number | boolean;

function formatPreviewInputEvent(input: string, type: string, value: PreviewInputValue): string {
  return JSON.stringify({ input, type, value });
}

interface ThrottledReporter {
  report(input: string, type: string, value: PreviewInputValue): void;
  flush(input?: string): void;
  dispose(): void;
}

/**
 * Leading + trailing throttle per input name: a discrete edit (typing a key,
 * clicking a checkbox, picking a select option) fires immediately on the
 * leading edge, while a continuous scrub (`range`, `color`) coalesces updates
 * within `INPUT_THROTTLE_MS` and flushes the final value on blur or unmount.
 */
function createThrottledReporter(emit: (json: string) => void): ThrottledReporter {
  const lastSent = new Map<string, number>();
  const pending = new Map<string, { json: string; timer: ReturnType<typeof setTimeout> }>();

  const flushKey = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(key);
    lastSent.set(key, Date.now());
    emit(entry.json);
  };

  return {
    report(input, type, value) {
      const json = formatPreviewInputEvent(input, type, value);
      const now = Date.now();
      const prev = lastSent.get(input) ?? 0;
      const existing = pending.get(input);
      if (existing) clearTimeout(existing.timer);
      if (now - prev >= INPUT_THROTTLE_MS && !existing) {
        lastSent.set(input, now);
        emit(json);
        return;
      }
      const wait = Math.max(0, INPUT_THROTTLE_MS - (now - prev));
      const timer = setTimeout(() => flushKey(input), wait);
      pending.set(input, { json, timer });
    },
    flush(input) {
      if (input !== undefined) {
        flushKey(input);
        return;
      }
      for (const key of Array.from(pending.keys())) flushKey(key);
    },
    dispose() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
    },
  };
}

function inputIdentifier(
  props: {
    name?: string;
    id?: string;
    'aria-label'?: string;
    placeholder?: string;
  },
  fallback: string,
): string {
  return props.name || props.id || props['aria-label'] || props.placeholder || fallback;
}

function coerceInputValue(type: string, raw: string, checked: boolean): PreviewInputValue {
  if (type === 'checkbox') return checked;
  if (type === 'range' || type === 'number') {
    const num = Number(raw);
    return raw !== '' && Number.isFinite(num) ? num : raw;
  }
  return raw;
}

function LocalImage({
  path,
  alt,
  width,
  height,
  title,
  align,
  source,
}: {
  path: string;
  alt: string;
  width?: string | number;
  height?: string | number;
  title?: string;
  align?: string;
  source: PreviewSource;
}) {
  const image = useKeyedRequest(path, () => source.readResource(path));
  if (!image.value) return <span className="preview-image-blocked">{alt || path}</span>;
  const { mime, data } = image.value;
  return (
    <img
      src={`data:${mime.split(';')[0]};base64,${data}`}
      alt={alt}
      width={width}
      height={height}
      title={title}
      {...(align ? { align } : {})}
    />
  );
}

function LocalSource({
  path,
  media,
  type,
  source,
}: {
  path: string;
  media?: string;
  type?: string;
  source: PreviewSource;
}) {
  const image = useKeyedRequest(path, () => source.readResource(path));
  if (!image.value) return null;
  const { mime, data } = image.value;
  const baseMime = mime.split(';')[0];
  return (
    <source srcSet={`data:${baseMime};base64,${data}`} media={media} type={type ?? baseMime} />
  );
}

function blurOnEscape(e: React.KeyboardEvent<HTMLElement>) {
  if (e.key === 'Escape') e.currentTarget.blur();
}

function renderInputControl(
  props: React.ComponentPropsWithoutRef<'input'> & { node?: unknown },
  reporter: ThrottledReporter,
) {
  const { type = 'text', value, checked, disabled, node: _node, ...rest } = props;
  const kind = typeof type === 'string' ? type.toLowerCase() : 'text';
  const isToggle = kind === 'checkbox' || kind === 'radio';
  if (disabled) {
    return (
      <input
        {...rest}
        type={kind}
        disabled
        defaultValue={isToggle ? undefined : value}
        defaultChecked={isToggle ? Boolean(checked) : undefined}
      />
    );
  }
  const idKey = inputIdentifier(rest, kind);
  const revKey = `${idKey}:${String(value ?? '')}:${String(Boolean(checked))}`;
  return (
    <input
      key={revKey}
      {...rest}
      type={kind}
      defaultValue={isToggle ? value : (value ?? '')}
      defaultChecked={isToggle ? Boolean(checked) : undefined}
      onChange={(e) => {
        const next = coerceInputValue(kind, e.currentTarget.value, e.currentTarget.checked);
        reporter.report(idKey, kind, next);
      }}
      onBlur={() => reporter.flush(idKey)}
      onKeyDown={blurOnEscape}
    />
  );
}

function renderImageControl(
  props: React.ComponentPropsWithoutRef<'img'> & { align?: string },
  source: PreviewSource,
  net: boolean,
) {
  const { src, alt, width, height, title, align } = props;
  const ref = typeof src === 'string' ? src : '';
  const path = previewResourcePath(ref);
  if (path) {
    return (
      <LocalImage
        path={path}
        alt={alt ?? ''}
        width={width}
        height={height}
        title={title}
        align={align}
        source={source}
      />
    );
  }
  if (net && /^https?:\/\//i.test(ref)) {
    return (
      <img
        src={ref}
        alt={alt ?? ''}
        width={width}
        height={height}
        title={title}
        referrerPolicy="no-referrer"
        {...(align ? { align } : {})}
      />
    );
  }
  return (
    <span className="preview-image-blocked" title={ref}>
      {alt || ref}
    </span>
  );
}

function renderSelectControl(
  props: React.ComponentPropsWithoutRef<'select'> & { node?: unknown },
  reporter: ThrottledReporter,
) {
  const { value, disabled, children, node: _node, ...rest } = props;
  const idKey = inputIdentifier(rest, 'select');
  return (
    <select
      key={`${idKey}:${String(value ?? '')}`}
      {...rest}
      disabled={disabled}
      defaultValue={value}
      onChange={(e) => reporter.report(idKey, 'select', e.currentTarget.value)}
      onBlur={() => reporter.flush(idKey)}
      onKeyDown={blurOnEscape}
    >
      {children}
    </select>
  );
}

function renderTextareaControl(
  props: React.ComponentPropsWithoutRef<'textarea'> & { node?: unknown },
  reporter: ThrottledReporter,
) {
  const { value, disabled, children, node: _node, ...rest } = props;
  const idKey = inputIdentifier(rest, 'textarea');
  const initial = value ?? (typeof children === 'string' ? children : '');
  return (
    <textarea
      key={`${idKey}:${String(initial)}`}
      {...rest}
      disabled={disabled}
      defaultValue={initial}
      onChange={(e) => reporter.report(idKey, 'textarea', e.currentTarget.value)}
      onBlur={() => reporter.flush(idKey)}
      onKeyDown={blurOnEscape}
    />
  );
}

function components(
  source: PreviewSource,
  theme: PreviewTheme,
  net: boolean,
  reporter: ThrottledReporter,
): Components {
  return {
    a({ href, children, title }) {
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
          title={title}
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
    img(props) {
      return renderImageControl(props as typeof props & { align?: string }, source, net);
    },
    source({ src, srcSet, media, type }) {
      const raw = (typeof srcSet === 'string' && srcSet) || (typeof src === 'string' ? src : '');
      const firstRef = raw.split(',')[0]?.trim().split(/\s+/)[0] ?? '';
      const path = previewResourcePath(firstRef);
      if (path) return <LocalSource path={path} media={media} type={type} source={source} />;
      if (net && /^https?:\/\//i.test(firstRef)) {
        return <source srcSet={firstRef} media={media} type={type} />;
      }
      return null;
    },
    input(props) {
      return renderInputControl(props as typeof props & { node?: unknown }, reporter);
    },
    select(props) {
      return renderSelectControl(props as typeof props & { node?: unknown }, reporter);
    },
    textarea(props) {
      return renderTextareaControl(props as typeof props & { node?: unknown }, reporter);
    },
    code({ className, children }) {
      if (/language-(?:mermaid|pele)\b/.test(className ?? '')) {
        return <DiagramBlock chart={String(children).trimEnd()} theme={theme} net={net} />;
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

const LINE = CHAR_HEIGHT;

/**
 * The pager keys, while the preview is the pane with the keyboard: what a
 * reader expects of `less`. Captured before the keyboard actor, which would
 * otherwise send them to the pane, where nothing reads them — except a key
 * that is a binding's, the `j` of `prefix j`, which goes on to the actor, or a
 * key typed inside a form field (`<input>`, `<textarea>`, `<select>`).
 */
function nextPagerScrollTop(e: KeyboardEvent, el: HTMLDivElement): number | null {
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
  if (e.ctrlKey) {
    if (e.key === 'd') return el.scrollTop + page / 2;
    if (e.key === 'u') return el.scrollTop - page / 2;
    return null;
  }
  if (e.key in step) return el.scrollTop + step[e.key];
  if (e.key === 'g' || e.key === 'Home') return 0;
  if (e.key === 'G' || e.key === 'End') return el.scrollHeight;
  return null;
}

function usePagerKeys(scrollRef: React.RefObject<HTMLDivElement | null>, active: boolean) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const bindingOwnsKey = useBindingOwnsKey();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = scrollRef.current;
      if (!activeRef.current || !el || e.metaKey || e.altKey) return;
      if (isRealFormControl(e.target) || bindingOwnsKey(e.key)) return;
      const to = nextPagerScrollTop(e, el);
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
  onInput,
}: {
  doc: PreviewDocument;
  theme: PreviewTheme;
  source: PreviewSource;
  active: boolean;
  onInput?: (json: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const onInputRef = useRef(onInput);
  onInputRef.current = onInput;
  usePagerKeys(scrollRef, active);

  const reporter = useMemo(() => createThrottledReporter((json) => onInputRef.current?.(json)), []);
  useEffect(() => () => reporter.dispose(), [reporter]);

  const rendering = useMemo(
    () => components(source, theme, doc.net, reporter),
    [source, theme, doc.net, reporter],
  );
  const { frontMatter, body } = useMemo(() => splitFrontMatter(doc.text), [doc.text]);
  // The scroller outlives each re-read: the document is replaced inside it,
  // so the reader stays where they were when the file changes.
  return (
    <div ref={scrollRef} className="preview-markdown" tabIndex={0}>
      {frontMatter?.trim() ? <FrontMatter yaml={frontMatter} /> : null}
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={rendering}
      >
        {body}
      </Markdown>
    </div>
  );
}
