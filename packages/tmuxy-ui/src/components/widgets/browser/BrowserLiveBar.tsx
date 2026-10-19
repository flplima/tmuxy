/**
 * BrowserLiveBar — the address bar over a live browser pane (`tmuxy browser`).
 *
 * The same bar the file widget wears (`BrowserNav`), laid over the pane's top
 * row, which the pane program leaves for it. The page below is the program's
 * own picture, so every button drives the program the way an agent does: it
 * types a verb line into the pane (`:back`, `:goto …`, `:viewport mobile`).
 *
 * One button only a website has: the page size. `Auto` lays the page out for
 * the pane; a device size is drawn at its own aspect in the middle of it. The
 * menu marks the current choice; the button keeps one icon whatever it is.
 */

import { memo, useRef, useState } from 'react';
import { useAppSend, useReadOnly } from '../../../machines/appHooks';
import { FloatingMenu } from '../../floating/Menu';
import { renderSpec, useMenuDispatch } from '../../menus/SpecMenu';
import { belowElement, useNativeMenu } from '../../menus/useNativeMenu';
import { browserSizeMenuSpec } from '../../../domain/menus/browserSizeMenu';
import { Tooltip } from '../../Tooltip';
import { BrowserNav } from './BrowserNav';
import { ThemeColorFilter } from './TmuxyBrowser';
import { LIVE_VIEWPORTS, verbLine, type LiveBrowserHeader } from './live';
import type { PaneId } from '../../../domain/ids';

interface BrowserLiveBarProps {
  paneId: PaneId;
  header: LiveBrowserHeader;
  /** The page's address (`@tmuxy-pane-url`). */
  url: string;
  /** The theme filter's id for this pane and theme (see `TerminalPane`). */
  filterId: string;
}

/** nf-fa-expand: the page-size button, whichever size is chosen. */
const VIEWPORT_ICON = '\uf065';
/** nf-fa-terminal: the REPL view button. */
const REPL_ICON = '\uf120';

export const BrowserLiveBar = memo(function BrowserLiveBar({
  paneId,
  header,
  url,
  filterId,
}: BrowserLiveBarProps) {
  const send = useAppSend();
  const readOnly = useReadOnly();
  const sizeButton = useRef<HTMLButtonElement>(null);
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false);
  const verb = (line: string) => send({ type: 'WRITE_TO_PANE', paneId, data: verbLine(line) });
  const current = LIVE_VIEWPORTS.find((v) => v.value === header.viewport) ?? LIVE_VIEWPORTS[0];

  const sizeControl = (
    <>
      <Tooltip label={header.repl ? 'Show the page' : 'Show the REPL (verb log)'}>
        <button
          type="button"
          className="browser-nav-button"
          data-testid="browser-nav-repl"
          aria-label="REPL"
          aria-pressed={header.repl}
          disabled={readOnly}
          onClick={() => verb(header.repl ? 'repl off' : 'repl on')}
        >
          <span className="browser-nav-glyph">{REPL_ICON}</span>
        </button>
      </Tooltip>
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
          <span className="browser-nav-glyph">{VIEWPORT_ICON}</span>
        </button>
      </Tooltip>
      {sizeMenuOpen && (
        <SizeMenu
          paneId={paneId}
          viewport={header.viewport}
          button={sizeButton}
          onClose={() => setSizeMenuOpen(false)}
        />
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
      {header.colorFilter && <ThemeColorFilter id={filterId} />}
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

/** The page-size menu: native on the desktop, the floating menu elsewhere. */
function SizeMenu({
  paneId,
  viewport,
  button,
  onClose,
}: {
  paneId: PaneId;
  viewport: string;
  button: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const dispatch = useMenuDispatch();
  const spec = browserSizeMenuSpec(paneId, viewport);
  const choose = (action: Parameters<typeof dispatch>[0]) => {
    dispatch(action);
    onClose();
  };
  const inApp = useNativeMenu(spec, choose, belowElement(button.current), onClose);
  if (!inApp) return null;
  return (
    <FloatingMenu
      id="browser-viewport-menu"
      label="Page size"
      testId="browser-viewport-menu"
      anchor={{ kind: 'element', element: button.current }}
      ignoreRef={button}
      onClose={onClose}
    >
      {renderSpec(spec, choose)}
    </FloatingMenu>
  );
}
