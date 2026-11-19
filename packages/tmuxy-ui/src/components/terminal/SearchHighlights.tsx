import { useMemo } from 'react';
import { cellsToCss } from '../../infra/dom/cellMetrics';
import { matchesInRows } from '../../domain/copyModeSearch';
import type { CopyModeState } from '../../domain/copyMode';

/**
 * The search's matches in view, as boxes laid over the rows: the current one
 * in the cursor's colour, the others in the selection's.
 */
export function SearchHighlights({
  copyState,
  charHeight,
}: {
  copyState: CopyModeState;
  charHeight: number;
}) {
  const { search, lines, scrollTop, height, totalLines } = copyState;
  const query = search?.last?.query;
  const current = search?.match;
  const matches = useMemo(
    () =>
      query ? matchesInRows({ lines, totalLines }, query, scrollTop, scrollTop + height - 1) : [],
    [query, lines, totalLines, scrollTop, height],
  );
  return (
    <>
      {matches.map((m) => {
        const isCurrent = !!current && current.row === m.row && current.col === m.col;
        return (
          <div
            key={`${m.row}:${m.col}`}
            className="terminal-search-match"
            data-testid={isCurrent ? 'search-match-current' : 'search-match'}
            data-row={m.row}
            data-col={m.col}
            data-current={isCurrent ? 'true' : undefined}
            style={{
              top: m.row * charHeight,
              height: charHeight,
              left: cellsToCss(m.col),
              width: cellsToCss(m.len),
            }}
          />
        );
      })}
    </>
  );
}
