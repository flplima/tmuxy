/**
 * BrowserNav — the browser widget's address bar.
 *
 * A row under the pane header, in the shape every browser uses: back, forward,
 * refresh, the address, and a way out to the real browser. Minimal on purpose —
 * it is one terminal row tall and carries no chrome of its own, because the
 * pane it sits in is usually a third of a screen.
 *
 * Two browsers wear it. The file widget (`TmuxyBrowser`) moves through the
 * places the pane has been POINTED — a framed document's own history cannot be
 * read from out here. A website runs in a real engine (`tmuxy browser`), which
 * reports its own address and history, so there the bar is the page's
 * (`BrowserLiveBar`). The bar itself only shows and asks; what a button does is
 * the caller's.
 *
 * The address is a real input: it holds what the user is typing (so a render
 * mid-edit does not snatch the text away) and falls back to the current URL
 * whenever that changes underneath — a refresh, a back, a new page pushed into
 * the pane by the CLI.
 */

import { memo, useRef, useState, type ReactNode } from 'react';
import { useAppSend } from '../../../machines/AppContext';
import { isOpenableUrl } from '../../../utils/openUrl';
import { Tooltip } from '../../Tooltip';

interface BrowserNavProps {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  onHistory: (delta: -1 | 1) => void;
  onReload: () => void;
  /** An address typed into the bar and submitted. */
  onNavigate: (url: string) => void;
  /** A viewer that cannot drive the pane sees the address, not the controls. */
  readOnly?: boolean;
  /** The caller's own buttons, between the address and the way out. */
  extra?: ReactNode;
}

/** nf-fa-external_link — the way out to the system browser. */
const EXTERNAL_ICON = '';

export const BrowserNav = memo(function BrowserNav({
  url,
  canGoBack,
  canGoForward,
  onHistory,
  onReload,
  onNavigate,
  readOnly = false,
  extra,
}: BrowserNavProps) {
  const send = useAppSend();
  const [draft, setDraft] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);
  // Follow the pane when the page changes under the bar, but never while the
  // user is mid-edit in it — that would delete what they are typing.
  const shownUrl = useRef(url);
  if (shownUrl.current !== url) {
    shownUrl.current = url;
    if (document.activeElement !== inputRef.current) setDraft(url);
  }

  const canOpenExternally = isOpenableUrl(url);

  return (
    <div className="browser-nav" data-testid="browser-nav">
      <Tooltip label="Back">
        <button
          type="button"
          className="browser-nav-button"
          data-testid="browser-nav-back"
          aria-label="Back"
          disabled={readOnly || !canGoBack}
          onClick={() => onHistory(-1)}
        >
          ‹
        </button>
      </Tooltip>
      <Tooltip label="Forward">
        <button
          type="button"
          className="browser-nav-button"
          data-testid="browser-nav-forward"
          aria-label="Forward"
          disabled={readOnly || !canGoForward}
          onClick={() => onHistory(1)}
        >
          ›
        </button>
      </Tooltip>
      <Tooltip label="Refresh (ctrl+r)">
        <button
          type="button"
          className="browser-nav-button"
          data-testid="browser-nav-reload"
          aria-label="Refresh"
          disabled={readOnly}
          onClick={onReload}
        >
          ⟳
        </button>
      </Tooltip>
      <form
        className="browser-nav-address"
        onSubmit={(e) => {
          e.preventDefault();
          if (!readOnly) onNavigate(draft);
          inputRef.current?.blur();
        }}
      >
        <input
          ref={inputRef}
          className="browser-nav-input"
          data-testid="browser-nav-input"
          type="text"
          value={draft}
          readOnly={readOnly}
          aria-label="Address"
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          onChange={(e) => setDraft(e.target.value)}
          // Escape abandons the edit and puts the current page back, the way
          // it does in a browser; the pane keeps the keystroke either way
          // because a focused input is where the keyboard actor stops.
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setDraft(url);
              inputRef.current?.blur();
            }
          }}
          // Selecting the whole address on focus is what makes "click, type,
          // Enter" work without reaching for the keyboard to clear it first.
          onFocus={(e) => e.currentTarget.select()}
        />
      </form>
      {extra}
      <Tooltip
        label={
          canOpenExternally
            ? 'Open in default browser'
            : 'Only http(s) pages can be opened in the default browser'
        }
      >
        <button
          type="button"
          className="browser-nav-button browser-nav-external"
          data-testid="browser-nav-external"
          aria-label="Open in default browser"
          disabled={!canOpenExternally}
          onClick={() => send({ type: 'BROWSER_OPEN_EXTERNAL', url })}
        >
          {EXTERNAL_ICON}
        </button>
      </Tooltip>
    </div>
  );
});
