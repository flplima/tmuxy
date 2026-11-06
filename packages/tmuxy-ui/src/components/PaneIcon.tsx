/**
 * A pane's process icon (paneTabDisplay's `getTabIcon`) as the header tab,
 * the sidebar tree and the "all tabs" view draw it: text as text, an SVG as
 * its shape in the text colour beside it. The SVG is a CSS mask over
 * `currentColor`, so its own colours never show: what it covers takes the
 * colour of the text, what it leaves transparent shows the background, and
 * it follows the tab from inactive to active as the title does.
 */

import type { CSSProperties } from 'react';
import { useAppSelector } from '../machines/appHooks';
import { getTabIcon, isSvgIcon } from './paneTabDisplay';
import type { TmuxPane } from '../domain/client';

export function PaneIcon({
  pane,
  className,
  titleOverride,
}: {
  pane: TmuxPane;
  className: string;
  titleOverride?: string;
}) {
  const custom = useAppSelector((ctx) => ctx.processIcons);
  const icon = getTabIcon(pane, titleOverride, custom);
  if (!icon) return null;
  if (isSvgIcon(icon)) {
    const mask = `url("${icon}")`;
    const style: CSSProperties = { maskImage: mask, WebkitMaskImage: mask };
    return (
      <span className={className} aria-hidden="true">
        <span className="process-icon-svg" style={style} />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      {icon}
    </span>
  );
}
