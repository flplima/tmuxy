/**
 * BrowserNav — the browser widget's address bar.
 *
 * A row under the pane header, in the shape every browser uses: back, forward,
 * refresh, the address, and a way out to the real browser. Minimal on purpose —
 * it is one terminal row tall and carries no chrome of its own, because the
 * pane it sits in is usually a third of a screen.
 *
 * What back and forward move through is the pane's OWN history — the places
 * this pane has been POINTED (its `__SRC__` marker, then whatever was typed
 * here). A link followed inside the page is invisible from out here: the frame
 * is a separate document, and for a website a separate origin, so neither its
 * current URL nor its history can be read. Showing the address anyway and
 * calling it the page's would be a lie the first time someone clicked a link;
 * this shows where the pane was aimed, which is a thing the app actually knows.
 *
 * The address is a real input: it holds what the user is typing (so a render
 * mid-edit does not snatch the text away) and falls back to the current URL
 * whenever that changes underneath — a refresh, a back, a new page pushed into
 * the pane by the CLI.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { useAppSend } from '../../../machines/AppContext';
import { isOpenableUrl } from '../../../utils/openUrl';
import { Tooltip } from '../../Tooltip';
import type { BrowserView } from './view';

interface BrowserNavProps {
  paneId: string;
  view: BrowserView;
}

/** nf-fa-external_link — the way out to the system browser. */
const EXTERNAL_ICON = '';

export const BrowserNav = memo(function BrowserNav({ paneId, view }: BrowserNavProps) {
  const send = useAppSend();
  const { url, source } = view;
  const [draft, setDraft] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);
  // Follow the pane when the page changes under the bar, but never while the
  // user is mid-edit in it — that would delete what they are typing.
  const shownUrl = useRef(url);
  if (shownUrl.current !== url) {
    shownUrl.current = url;
    if (document.activeElement !== inputRef.current) setDraft(url);
  }
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(url);
  }, [url]);

  const canOpenExternally = isOpenableUrl(url);

  const go = (delta: -1 | 1) => send({ type: 'BROWSER_HISTORY', paneId, source, delta });

  return (
    <div className="browser-nav" data-testid="browser-nav">
      <Tooltip label="Back">
        <button
          type="button"
          className="browser-nav-button"
          data-testid="browser-nav-back"
          aria-label="Back"
          disabled={!view.canGoBack}
          onClick={() => go(-1)}
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
          disabled={!view.canGoForward}
          onClick={() => go(1)}
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
          onClick={() => send({ type: 'BROWSER_RELOAD', paneId, source })}
        >
          ⟳
        </button>
      </Tooltip>
      <form
        className="browser-nav-address"
        onSubmit={(e) => {
          e.preventDefault();
          send({ type: 'BROWSER_NAVIGATE', paneId, source, url: draft });
          inputRef.current?.blur();
        }}
      >
        <input
          ref={inputRef}
          className="browser-nav-input"
          data-testid="browser-nav-input"
          type="text"
          value={draft}
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
