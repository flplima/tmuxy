/**
 * BrowserLiveBar — the address bar over a live browser pane (`tmuxy browser`).
 *
 * The same bar the file widget wears (`BrowserNav`), laid over the pane's top
 * row, which the pane program leaves for it. The page below is the program's
 * own picture, so every button drives the program the way an agent does: it
 * types a verb line into the pane (`:back`, `:goto …`, `:viewport mobile`).
 *
 * One button only a website has: the page size. `Auto` lays the page out for
 * the pane; a device size is drawn at its own aspect in the middle of it.
 */

import { memo, useRef, useState } from 'react';
import { useAppSend, useReadOnly } from '../../../machines/AppContext';
import { themeFilterId } from '../../../utils/themeColorFilter';
import { FloatingMenu, MenuItem, MenuRadioGroup } from '../../floating/Menu';
import { Tooltip } from '../../Tooltip';
import { BrowserNav } from './BrowserNav';
import { ThemeColorFilter } from './TmuxyBrowser';
import { LIVE_VIEWPORTS, verbLine, type LiveBrowserHeader, type LiveViewport } from './live';
import type { PaneId } from '../../../domain/ids';

interface BrowserLiveBarProps {
  paneId: PaneId;
  header: LiveBrowserHeader;
  /** The page's address: the pane's title (see `live.ts`). */
  url: string;
}

/** nf-fa-expand / nf-fa-desktop / nf-fa-mobile: what the page is laid out for. */
const VIEWPORT_ICON: Record<LiveViewport, string> = {
  auto: '',
  desktop: '',
  mobile: '',
};

export const BrowserLiveBar = memo(function BrowserLiveBar({
  paneId,
  header,
  url,
}: BrowserLiveBarProps) {
  const send = useAppSend();
  const readOnly = useReadOnly();
  const sizeButton = useRef<HTMLButtonElement>(null);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const verb = (line: string) => send({ type: 'WRITE_TO_PANE', paneId, data: verbLine(line) });
  const current = LIVE_VIEWPORTS.find((v) => v.value === header.viewport) ?? LIVE_VIEWPORTS[0];

  const sizeControl = (
    <>
      <Tooltip label={`Page size: ${current.label}`}>
        <button
          ref={sizeButton}
          type="button"
          className="browser-nav-button"
          data-testid="browser-nav-viewport"
          aria-label="Page size"
          aria-haspopup="menu"
          aria-expanded={sizeMenuOpen}
          disabled={readOnly}
          onClick={() => setSizeMenuOpen((open) => !open)}
        >
          {VIEWPORT_ICON[header.viewport]}
        </button>
      </Tooltip>
      {sizeMenuOpen && (
        <FloatingMenu
          id="browser-viewport-menu"
          label="Page size"
          testId="browser-viewport-menu"
          anchor={{ kind: 'element', element: sizeButton.current }}
          ignoreRef={sizeButton}
          onClose={() => setSizeMenuOpen(false)}
        >
          <MenuRadioGroup
            value={header.viewport}
            onRadioChange={({ value }) => verb(`viewport ${value}`)}
          >
            {LIVE_VIEWPORTS.map((option) => (
              <MenuItem key={option.value} type="radio" value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </MenuRadioGroup>
        </FloatingMenu>
      )}
    </>
  );

  return (
    <div
      className="browser-live-bar"
      data-testid="browser-live-bar"
      // The bar is the app's, not the page's: a click on it must not reach the
      // pane as a mouse report, nor start a text selection under it.
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
    >
      {header.colorFilter && <ThemeColorFilter id={themeFilterId(paneId)} />}
      <BrowserNav
        url={url}
        canGoBack={header.canGoBack}
        canGoForward={header.canGoForward}
        readOnly={readOnly}
        onHistory={(delta) => verb(delta < 0 ? 'back' : 'forward')}
        onReload={() => verb('reload')}
        onNavigate={(address) => verb(`goto ${address}`)}
        extra={sizeControl}
      />
    </div>
  );
});
