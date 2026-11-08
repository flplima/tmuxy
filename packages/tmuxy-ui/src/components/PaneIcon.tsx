/**
 * An SVG icon is drawn as a CSS mask over `currentColor`, so its own colours
 * never show and it follows the tab's text colour from inactive to active.
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
