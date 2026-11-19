# Copy mode search

Copy mode searches the pane's whole scrollback with `/` and `?`, and `n` and `N` jump between matches, as tmux's `copy-mode-vi` table does. tmux never sees those keys: the client swallows every keydown while a pane is in copy mode, so the search runs on the client, over the rows it renders.

It is a companion to [COPY-MODE.md](COPY-MODE.md), which covers the scrollback, the loader and the key routing it builds on.

## Keys

| Key | Where | Does |
| --- | --- | --- |
| `/` | copy mode | opens the prompt to search down, towards newer lines ("Search Down") |
| `?` | copy mode | opens the prompt to search up, towards older lines ("Search Up") |
| a printable key | the prompt | adds to the query; `n`, `q` and `j` are text here, not motions |
| `Backspace` | the prompt | deletes the last character; on an empty query it closes the prompt |
| `Ctrl-u` | the prompt | clears the query |
| `Enter` | the prompt | runs the search; an empty query repeats the last one in the prompt's direction |
| `Escape` | the prompt | closes the prompt and stays in copy mode |
| `n` | copy mode | repeats the last search in its direction |
| `N` | copy mode | repeats it the other way, without changing the stored direction |

The scroll view has no search: there the first key closes the view and goes to the pane.

## What the user sees

- **The prompt** sits on the pane's last row (`components/terminal/CopySearchBar.tsx`): the direction and the query, with a caret. Typing goes to the machine as `COPY_MODE_KEY`, not to an input, so the browser never takes focus from the pane.
- **A match** moves the copy cursor to its first cell. When it is off screen, the view scrolls to put it in the middle. An active `v` or `V` selection grows with it, because the cursor is the selection's moving end.
- **Highlights** (`components/terminal/SearchHighlights.tsx`): the current match in the cursor's colour, the other matches in view in the selection's. Only the rows in view are matched for this, so a long history costs nothing while scrolling.
- **No match**: the cursor stays, and the prompt row says "Not found" for two seconds (`NOT_FOUND_MS`).
- **While history loads**: the prompt row says "Searching".

## Matching

- A plain substring, per row. A match cannot span a soft-wrapped row boundary.
- Smart case, as vim and tmux do it: case-insensitive unless the query has a capital letter.
- It wraps at both ends of history. The match under the cursor counts last, once the search has gone all the way round.
- A wide character's second cell holds no text, so it is counted inside the match it ends.

## The whole history

Scrollback loads in chunks and leaves gaps on purpose ([COPY-MODE.md](COPY-MODE.md#scrollback-loading)), and a search over the loaded rows alone would miss what is deep in history. So a search runs the way select-all copies:

1. `beginSearch` looks for the first unloaded gap (`firstUnloadedGap`). With none, it runs at once.
2. Otherwise the query waits in `search.pending` and the gap is fetched.
3. Each chunk that arrives (`applyScrollbackChunk` → `continueSearch`) asks for the next gap, or runs the search once there is none. While a search waits, the usual fetch of the older history above stays off, so the two never ask for rows at the same time.
4. A failed fetch drops the pending query, so the prompt row does not say "Searching" forever.

When history grows while a match is shown, the match's row moves with the rows, as the cursor's does.

## State

The search lives on the pane's `CopyModeState`, as `search` (`domain/copyMode.ts`), and goes when the pane leaves copy mode:

| Field | Holds |
| --- | --- |
| `prompt` | the query being typed and its direction, while the prompt is open |
| `last` | what `n` and `N` repeat, and what the highlights match |
| `match` | the current match: row, first cell, length in cells |
| `notFound` | the last run found nothing; cleared by `COPY_MODE_SEARCH_NOTICE_CLEAR` |
| `pending` | a query waiting for the rest of the history |

## Key files

| File | Responsibility |
| --- | --- |
| `packages/tmuxy-ui/src/domain/copyModeSearch.ts` | Pure search: the prompt's keys, matching, wrap, smart case, starting and running a search |
| `packages/tmuxy-ui/src/machines/app/actions/copyMode.ts` | `copyMode_key` gives search keys to the search first; `copyMode_searchNoticeClear` |
| `packages/tmuxy-ui/src/machines/app/actions/copyMode/scrollback.ts` | `requestGap` and `continueSearch`: the history a search waits for |
| `packages/tmuxy-ui/src/machines/actors/keyboard/modalAndCopyKeys.ts` | `Enter` in the prompt runs the search; it copies nothing |
| `packages/tmuxy-ui/src/components/terminal/CopySearchBar.tsx` | The prompt row and its notices |
| `packages/tmuxy-ui/src/components/terminal/SearchHighlights.tsx` | The boxes over the matches in view |

Tests: `domain/__tests__/copyModeSearch.test.ts` (the pure search) and `tests/1-input-interaction-copy-search.test.js` (the keys as a user types them, checked on screen).
