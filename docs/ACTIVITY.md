# The activity inbox

With agents in several sessions, the question is always "who needs me?". A tab's badge answers it for the session in view. The inbox answers it for the whole server: every pane that declared a state, in every session, the one that wants you most first.

| Key | Menu | Does |
| --- | --- | --- |
| `prefix A` | View ▸ Activity | opens the inbox |
| `prefix U` | View ▸ Go to the Pane That Needs You | goes straight to the most urgent pane |

Both keys are the client's own, like `prefix ?`: there is no tmux binding behind them ([TMUX-CONFIG.md](TMUX-CONFIG.md)).

## What it lists

A pane's state is its own word, `@tmuxy-pane-state`, with what its program said behind it in `@tmuxy-pane-status` ([TMUX-TAGS.md](TMUX-TAGS.md), [RICH-RENDERING.md](RICH-RENDERING.md#program-status-osc-7501)). tmux holds both for every pane of every session. So the inbox is one read, a `list-panes -a` through `query_tmux`, the same way the sidebar tree learns about other sessions (`machines/actors/serversActor.ts`). No server code is involved, and the session in view is not special.

```
needs-input   a question only you can answer        first
error         something failed
unread        a result nobody has looked at
working       busy
idle          said it is idle                       last
```

- A pane that never declared a state is not listed.
- Within a state the rows keep tmux's order, by session and tab.
- A pane-group member parked out of view is left out: there is no pane on screen to go to.
- Each row shows the state's mark, the pane's name (its label, else its program's title, else the program), what the program said ("Needs your approval: Apply 3 to add?") and where it is (`session · tab`).

The list is read when the inbox opens and every two seconds while it is open. What an earlier look left is shown until the first answer comes.

## Using it

The inbox is a combobox, like the session switcher: the keyboard stays in the filter box, and the arrows move a highlight through the list.

| Key | Does |
| --- | --- |
| typing | filters by session, tab, name and what the program said |
| `↓` / `↑`, `Ctrl+N` / `Ctrl+P`, `Ctrl+J` / `Ctrl+K` | move the highlight |
| `Enter`, or a click on a row | go to that pane |
| `Escape`, or a click outside | close |

The highlight is a pane, not a position, so a row that moves as states change keeps the highlight.

## Going to a pane

- **In the session in view** it is a tab and a pane picked, as a click would.
- **In another session** tmux is told first which window and pane that session has in front (`select-window`, `select-pane`), and then the client switches to the session. It arrives on the pane, not on whatever the session showed last.

`prefix U` reads the panes first (the list an open inbox left may be minutes old), then goes to the first pane that is waiting, failed or has a result. The pane in front is skipped: it already has you. With nobody waiting it says "No pane needs you" and stays.

## Not done

- **How long a pane has been in its state.** tmux keeps the state, not when it was set.
- **OS notifications.** `tmuxy server` already pushes a notice when a pane needs you ([SECURITY.md](SECURITY.md)); the desktop app sends none.
- **Mute for a tab or a pane**, and a way to group the list by session.
- **The in-browser demo** has one session and answers no queries: its inbox stays empty.

## Key files

| File | Responsibility |
| --- | --- |
| `packages/tmuxy-ui/src/domain/activity.ts` | The read, the rows, their order, the filter, who is most urgent |
| `packages/tmuxy-ui/src/machines/app/actions/activity.ts` | Open, refresh, go to a pane, go to the most urgent |
| `packages/tmuxy-ui/src/components/ActivityInbox.tsx` | The list and its keys |
| `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts` | `FETCH_ACTIVITY` and `GO_TO_PANE` on the transport |

## Tests

- `packages/tmuxy-ui/src/domain/__tests__/activity.test.ts`: the order, what is left out, the names and the words.
- `packages/tmuxy-ui/src/machines/app/states/__tests__/activity.test.ts`: opening reads, going closes, the jump skips the pane in front.
- `tests/4-session-connectivity-activity.test.js`: three panes in two sessions, in a browser against a real tmux.
