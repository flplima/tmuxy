/**
 * BrowserLiveBar — the address bar over a live browser pane (`tmuxy browser`).
 *
 * The same bar the file widget wears (`BrowserNav`), laid over the pane's top
 * row, which the pane program leaves for it. The page below is the program's
 * own picture, so every button drives the program the way an agent does: it
 * types a verb line into the pane (`:back`, `:goto …`).
 */

import { memo } from 'react';
import { useAppSend, useReadOnly } from '../../../machines/AppContext';
import { themeFilterId } from '../../../utils/themeColorFilter';
import { BrowserNav } from './BrowserNav';
import { ThemeColorFilter } from './TmuxyBrowser';
import { verbLine, type LiveBrowserHeader } from './live';
import type { PaneId } from '../../../domain/ids';

interface BrowserLiveBarProps {
  paneId: PaneId;
  header: LiveBrowserHeader;
  /** The page's address: the pane's title (see `live.ts`). */
  url: string;
}

export const BrowserLiveBar = memo(function BrowserLiveBar({
  paneId,
  header,
  url,
}: BrowserLiveBarProps) {
  const send = useAppSend();
  const readOnly = useReadOnly();
  const verb = (line: string) => send({ type: 'WRITE_TO_PANE', paneId, data: verbLine(line) });

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
      />
    </div>
  );
});
