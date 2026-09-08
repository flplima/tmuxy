/**
 * TmuxyBrowser — the `browser` widget: page content in a pane, no chrome.
 *
 * One widget covers every viewable thing a pane can be pointed at: a local
 * HTML file, a website, a markdown file (rendered, mermaid included) or an
 * image. There are deliberately no toolbar controls — back, forward, zoom,
 * refresh and close live in the pane's ⋮ menu (contributed by this widget's
 * definition) and on ctrl+r / ctrl+c, so the pane shows nothing but content.
 *
 * A page goes in an `<iframe>`; markdown and images are rendered by the app so
 * they inherit its typography and theme. Websites that refuse to be framed
 * (`X-Frame-Options`) show their own refusal — tmuxy does not proxy them.
 */

import { useRef, type CSSProperties } from 'react';
import { useAppSend, useAppSelector } from '../../../machines/AppContext';
import type { WidgetProps } from '../index';
import { browserView } from './view';
import { classifySource, loadUrl } from './source';
import { pathFromFileUrl } from '../../../utils/fileUrl';
import { MarkdownView } from './MarkdownView';

/** Strip the cache-buster a refresh adds, so a reported URL is the real one. */
function withoutReloadParam(url: string): string {
  return url.replace(/[?&]_tmuxyReload=\d+/, '');
}

export function TmuxyBrowser({ paneId, lines }: WidgetProps) {
  const send = useAppSend();
  // The raw per-pane record, not a derived object: it is reference-stable
  // across unrelated model ticks, so the pane does not re-render on every
  // snapshot the way a freshly-built view object would make it.
  const state = useAppSelector((context) => context.browserStates[paneId]);
  const view = browserView(state, lines);

  // What the frame is actually showing, and the src+key React last handed it.
  // A link followed inside the page moves the frame on its own; recording that
  // lets the next render hand back the identical src under the identical key,
  // so React writes nothing and the page the user just opened is not reloaded
  // under them. A URL the frame did NOT reach by itself — a Back, a Forward, a
  // refresh — bumps the key instead of just the src, because re-assigning an
  // attribute React never saw change (the frame moved behind its back) would
  // leave the frame where it is.
  const frameUrlRef = useRef('');
  const frameSrcRef = useRef('');
  const frameNonceRef = useRef(-1);
  const loadSeqRef = useRef(0);

  if (!view.url) {
    return <div className="widget-browser-empty">Waiting for a page...</div>;
  }

  const src = loadUrl(view.url, view.reloadNonce);
  const kind = classifySource(view.url);

  // Zoom reaches the rendered views as a CSS variable: markdown scales by type
  // size (so lines re-wrap to the pane, as page zoom does) while the frame and
  // an image scale by transform.
  const zoomVar = { '--widget-zoom': view.zoom } as CSSProperties;

  if (kind === 'markdown') {
    return (
      <div className="widget-browser" style={zoomVar}>
        <MarkdownView url={src} />
      </div>
    );
  }

  if (kind === 'image') {
    return (
      <div className="widget-browser widget-browser-image">
        <img
          src={src}
          alt={view.url}
          style={{ transform: `scale(${view.zoom})` }}
          data-testid="browser-image"
        />
      </div>
    );
  }

  if (frameUrlRef.current !== view.url || frameNonceRef.current !== view.reloadNonce) {
    frameUrlRef.current = view.url;
    frameNonceRef.current = view.reloadNonce;
    frameSrcRef.current = src;
    loadSeqRef.current += 1;
  }

  return (
    <div className="widget-browser">
      <iframe
        key={loadSeqRef.current}
        className="widget-browser-frame"
        src={frameSrcRef.current}
        title={view.url}
        // Scale from the top-left and give the frame back the size the scale
        // took away, so the page lays out at the zoomed width instead of being
        // cropped to a fraction of the pane.
        style={{
          width: `${100 / view.zoom}%`,
          height: `${100 / view.zoom}%`,
          transform: `scale(${view.zoom})`,
          transformOrigin: '0 0',
        }}
        onLoad={(e) => {
          // Links followed inside a page we serve ourselves are same-origin,
          // so they can be recorded and become Back-able. A cross-origin page
          // throws on the same read: its internal navigation stays its own.
          let href: string | undefined;
          try {
            href = e.currentTarget.contentWindow?.location.href;
          } catch {
            return;
          }
          if (!href || href === 'about:blank') return;
          const url = pathFromFileUrl(withoutReloadParam(href));
          if (url === view.url) return;
          frameUrlRef.current = url;
          send({ type: 'BROWSER_NAVIGATE', paneId, source: view.source, url });
        }}
      />
    </div>
  );
}
