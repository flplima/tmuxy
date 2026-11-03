/**
 * A pane's process icon (paneTabDisplay's `getTabIcon`) as the header tab,
 * the sidebar tree and the "all tabs" view draw it: a glyph as text, an
 * image in the theme's colours (utils/themedIcon.ts).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAppSelector } from '../machines/appHooks';
import { getTabIcon, isImageIcon } from './paneTabDisplay';
import { paletteVersion, subscribePalette, themedIcon, themedIconNow } from '../utils/themedIcon';
import type { TmuxPane } from '../domain/client';

function ThemedImage({ src, className }: { src: string; className: string }) {
  const filter = useAppSelector((ctx) => ctx.processIcons.filter);
  const version = useSyncExternalStore(subscribePalette, paletteVersion);
  const key = `${version}\u0000${filter}\u0000${src}`;
  const [drawn, setDrawn] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    let live = true;
    void themedIcon(src, filter).then((url) => {
      if (live) setDrawn({ key, url });
    });
    return () => {
      live = false;
    };
  }, [src, filter, key]);
  // Nothing until it is drawn: the image in its own colours would flash.
  const url = themedIconNow(src, filter) ?? (drawn?.key === key ? drawn.url : null);
  return (
    <span className={`${className} process-icon-image`} aria-hidden="true">
      {url && <img src={url} alt="" draggable={false} />}
    </span>
  );
}

export function PaneIcon({
  pane,
  className,
  widgetName,
  titleOverride,
}: {
  pane: TmuxPane;
  className: string;
  widgetName?: string;
  titleOverride?: string;
}) {
  const custom = useAppSelector((ctx) => ctx.processIcons.map);
  const icon = getTabIcon(pane, widgetName, titleOverride, custom);
  if (!icon) return null;
  if (isImageIcon(icon)) return <ThemedImage src={icon} className={className} />;
  return (
    <span className={className} aria-hidden="true">
      {icon}
    </span>
  );
}
