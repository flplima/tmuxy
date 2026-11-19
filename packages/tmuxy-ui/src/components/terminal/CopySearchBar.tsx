import { useEffect } from 'react';
import { useAppSend } from '../../machines/appHooks';
import { NOT_FOUND_MS } from '../../domain/copyModeSearch';
import type { CopySearch } from '../../domain/copyMode';
import type { PaneId } from '../../domain/ids';
import './CopySearchBar.css';

/**
 * Copy mode's one-line search prompt, on the pane's bottom row as tmux draws
 * it: the direction and the query while it is being typed, and for a moment
 * the notice that a search found nothing. Typing goes to the machine
 * (`COPY_MODE_KEY`), not to an input.
 */
export function CopySearchBar({ paneId, search }: { paneId: PaneId; search: CopySearch }) {
  const send = useAppSend();
  const { prompt, notFound, pending, last } = search;

  useEffect(() => {
    if (!notFound) return;
    const timer = setTimeout(
      () => send({ type: 'COPY_MODE_SEARCH_NOTICE_CLEAR', paneId }),
      NOT_FOUND_MS,
    );
    return () => clearTimeout(timer);
  }, [notFound, paneId, send]);

  let text: string | null = null;
  if (prompt) text = `${prompt.dir === 'down' ? 'Search Down' : 'Search Up'}: ${prompt.query}`;
  else if (pending) text = `Searching: ${pending.query}`;
  else if (notFound && last) text = `Not found: ${last.query}`;
  if (text === null) return null;

  return (
    <div
      className="copy-search-bar"
      data-testid="copy-search-bar"
      data-state={prompt ? 'prompt' : pending ? 'pending' : 'not-found'}
      role="status"
    >
      <span className="copy-search-text">{text}</span>
      {prompt && <span className="copy-search-caret" />}
    </div>
  );
}
