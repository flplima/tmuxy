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

## The counts on the status line

At the status line's right end, just left of the host name, two counts follow the panes in `needs-input` and in `error`, across every session: the same rows the inbox lists. Each leads with the icon a pane's own mark draws for its state (a warning triangle, a circled x), from the terminal font and in the line's own colour, so it reads on any status style; never a colour emoji. A count shows only above zero, and with both at zero nothing is drawn.

- **One pane in all** (the total of the two counts is 1): a click goes to that pane, as a row's Enter does.
- **More than one**: a click opens the inbox.
- It is a button, named like "2 panes need you, 1 failed".

When a pane of the session in view takes, changes or drops a state, the panes are read again at once, so the counts follow it as its header does, within about a second (tmux reports a pane's options about once a second). Nothing tells the client that a pane in another session changed state, so the status line also reads the panes every five seconds, whether the inbox is open or not. The demo does not poll.

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
| `packages/tmuxy-ui/src/components/TmuxStatusBar.tsx` | The counts and their poll |
| `packages/tmuxy-ui/src/machines/app/actions/layout/modelUpdate.ts` | The read again when a state in the session in view moves |
| `packages/tmuxy-ui/src/machines/actors/tmuxActor.ts` | `FETCH_ACTIVITY` and `GO_TO_PANE` on the transport |

## Tests

- `packages/tmuxy-ui/src/domain/__tests__/activity.test.ts`: the order, what is left out, the names and the words.
- `packages/tmuxy-ui/src/machines/app/states/__tests__/activity.test.ts`: opening reads, going closes, the jump skips the pane in front.
- `packages/tmuxy-ui/src/machines/app/__tests__/activityFollowsPaneState.test.ts`: a state that moves in the session in view is read at once, an update that moves none is not.
- `tests/4-session-connectivity-activity.test.js`: three panes in two sessions, and the status line's counts (one goes to its pane, two open the inbox, none shows nothing), in a browser against a real tmux.
- `packages/tmuxy-ui/src/components/TmuxStatusBar.stories.tsx`: the counts, their click, and the phone's width.
