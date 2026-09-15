/**
 * TmuxyBrowser — the `browser` widget: page content in a pane, no chrome.
 *
 * One widget covers every viewable thing a pane can be pointed at: a local
 * HTML file, a website, a markdown file (rendered, mermaid included) or an
 * image. There are deliberately no toolbar controls — zoom, refresh and close
 * live in the pane's ⋮ menu (contributed by this widget's definition) and on
 * ctrl+r / ctrl+c, so the pane shows nothing but content.
 *
 * A page goes in an `<iframe>`; markdown and images are rendered by the app so
 * they inherit its typography and theme. Websites that refuse to be framed
 * (`X-Frame-Options`) show their own refusal — tmuxy does not proxy them.
 */

import { memo, useSyncExternalStore, type CSSProperties } from 'react';
import { useAppSelector } from '../../../machines/AppContext';
import type { WidgetProps } from '../index';
import { browserView } from './view';
import { classifySource, isRemote, loadUrl, parseColorFilter } from './source';
import { rampTables, readThemeRamp, themeFilterId } from '../../../utils/themeColorFilter';
import { getThemeVersion, subscribeTheme } from '../../../utils/themeManager';
import { MarkdownView } from './MarkdownView';

/**
 * What a local page may do in its frame. There is no `allow-same-origin`, so
 * the page runs in an opaque origin of its own: served by tmuxy it would
 * otherwise share the app's origin, free to reach into the app and, on the
 * web, to POST tmux commands. A website is another origin already and is
 * framed as it is, keeping its storage and logins.
 */
const LOCAL_PAGE_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

/**
 * The SVG filter `--color-filter` points the content at: luminance mapped onto
 * a ramp of theme colours (utils/themeColorFilter). Memoised on its id, so the
 * pane's content ticks do not re-read the theme; the theme subscription is
 * what re-renders it, once the new theme's colours have landed. Renders
 * nothing until the theme's colours resolve.
 */
const ThemeColorFilter = memo(function ThemeColorFilter({ id }: { id: string }) {
  useSyncExternalStore(subscribeTheme, getThemeVersion, getThemeVersion);
  const ramp = readThemeRamp();
  if (!ramp) return null;
  const tables = rampTables(ramp);
  return (
    <svg aria-hidden="true" width="0" height="0" style={{ position: 'absolute' }}>
      <filter id={id} colorInterpolationFilters="sRGB">
        {/* Luminance (Rec. 709) into every channel, alpha untouched. */}
        <feColorMatrix
          type="matrix"
          values="0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0.2126 0.7152 0.0722 0 0  0 0 0 1 0"
        />
        <feComponentTransfer>
          <feFuncR type="table" tableValues={tables.r} />
          <feFuncG type="table" tableValues={tables.g} />
          <feFuncB type="table" tableValues={tables.b} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
});

export function TmuxyBrowser({ paneId, lines }: WidgetProps) {
  // The raw per-pane record, not a derived object: it is reference-stable
  // across unrelated model ticks, so the pane does not re-render on every
  // snapshot the way a freshly-built view object would make it.
  const state = useAppSelector((context) => context.browserStates[paneId]);
  const view = browserView(state, lines);

  if (!view.url) {
    return <div className="widget-browser-empty">Waiting for a page...</div>;
  }

  const src = loadUrl(view.url, view.reloadNonce);
  const kind = classifySource(view.url);
  // Markdown is drawn by the app in the theme's colours already; the filter is
  // for what brings its own: a page in the frame, and images.
  const filterId = parseColorFilter(lines) ? themeFilterId(paneId) : null;
  const themeFilter = filterId ? <ThemeColorFilter id={filterId} /> : null;
  const filterStyle = filterId ? { filter: `url(#${filterId})` } : undefined;

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
        {themeFilter}
        <img
          src={src}
          alt={view.url}
          style={{ transform: `scale(${view.zoom})`, ...filterStyle }}
          data-testid="browser-image"
        />
      </div>
    );
  }

  return (
    <div className="widget-browser">
      {themeFilter}
      <iframe
        // A refresh changes the src (its cache-buster) and remounts the frame:
        // re-assigning the attribute alone would not get past a cached page.
        key={src}
        className="widget-browser-frame"
        src={src}
        title={view.url}
        sandbox={isRemote(view.url) ? undefined : LOCAL_PAGE_SANDBOX}
        // Scale from the top-left and give the frame back the size the scale
        // took away, so the page lays out at the zoomed width instead of being
        // cropped to a fraction of the pane.
        style={{
          width: `${100 / view.zoom}%`,
          height: `${100 / view.zoom}%`,
          transform: `scale(${view.zoom})`,
          transformOrigin: '0 0',
          ...filterStyle,
        }}
      />
    </div>
  );
}
