# The nightly story sweep: why it kept failing, and what fixed it

The nightly workflow (`.github/workflows/nightly-v86.yml`) runs every Storybook story: the `v86` tier, which boots real tmux in an x86 emulator in the page, and the deterministic tier, which replays recorded fixtures. Until October 2026 any failing story opened the tracking issue "Nightly v86 sweep is failing", and the next green night closed it. This page records why that issue reopened almost every week, why moving the guest to CheerpX would not have fixed it, and what did. How to read tonight's verdict is in [TESTS-STORYBOOK.md](TESTS-STORYBOOK.md#when-the-nightly-reports).

## What failed

Eight issues in six weeks: #87, #94, #108, #115, #124, #125, #144 and #145. The failing runs behind them:

| Run         | Stories that failed                                         | Kind                                                                  |
| ----------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 37456242059 | swap-drag-reconcile                                         | Frame budget: the drop painted in more frames than the budget allowed |
| 37612601097 | group-close-member, pane-group, swap-drag-reconcile, theme  | Frame budget (15 frames against 5), and timing on the others          |
| 38045912852 | osc-8-hyperlink                                             | Timing                                                                |
| 38172956792 | theme                                                       | Theme stylesheet not yet swapped in when read                         |
| 38394197740 | image-anchored-during-scroll                                | Timing                                                                |
| 38711758263 | theme                                                       | The same, again                                                       |
| 39113497315 | sync-panes                                                  | A fixed 1.5s "give the mirror a beat"                                 |
| 40861988960 | clicking-shown-members, swap-keeps-content-in-correct-lines | One real defect, one timing                                           |
| 41044549391 | focus-cue-never-hard-flips (deterministic tier)             | An 80ms fade sampled by real frames                                   |

#87 was a resize precondition read before the boot-time resize had landed.

Three things stand out:

- **A different story nearly every night.** No single story was broken; the whole tier was waiting on time. The v86 stories held 23 fixed sleeps, 10 frame or paint budgets and 6 wall-clock reads, each measured on a fast machine.
- **The same run passed when re-dispatched.** #145's story passed in the manual run on the same commit. Ten runs locally reproduced it once, at any CPU throttle: a race, not slowness.
- **Real defects hid in the noise.** clicking-shown-members was a real regression. It arrived in the same issue as the flakes, and nothing told it apart.

The issue had become a coin toss, so the one real defect it carried read like the others.

## Would CheerpX fix it?

CheerpX (Leaning Technologies) runs x86 binaries in the browser through a JIT to WebAssembly, where v86 interprets. tmuxy already ships it, for the public demo (`packages/tmuxy-ui/cheerpx/`, and the guest engine under `src/infra/transport/drivers/cheerpx/`). It was weighed as the engine for the test tier, and rejected:

| Question                                  | v86                                                              | CheerpX                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Speed                                     | Interpreted; slow boot without a snapshot                        | JIT; much faster                                                                                                 |
| Snapshot and restore of the whole machine | Yes; every story starts from the same restored state on one page | No; only disk state persists (IndexedDB or overlays)                                                             |
| Fidelity of the terminal                  | Real ptys; real tmux                                             | Patched tmux with fake ptys (`tmuxy-pty`), no full-screen programs, no pane sizes, Ctrl+C emulated               |
| Where it loads from                       | Self-hosted assets in the repo's build                           | Only from the vendor's CDN; self-hosting needs a commercial licence                                              |
| Licence                                   | BSD                                                              | Free for open-source and individual projects, with credit; would end if the project were owned by a company      |
| Page requirements                         | None                                                             | Cross-origin isolation (COOP and COEP headers) for SharedArrayBuffer, which Storybook's dev server does not send |
| Use in headless CI                        | Running nightly here                                             | No public evidence of it; untested                                                                               |

Speed was never the cause: the failures above came from waiting on wall-clock time, and a faster engine changes how long a sleep needs to be, not whether a sleep is the right tool. CheerpX would also remove the snapshot every story starts from, lower the fidelity the tier exists for, and add a CDN download to every run, which is a fresh source of network flakes. CheerpX stays the demo's engine. It may later suit a fast per-commit smoke tier that needs no snapshot and tolerates the CDN, but that is a separate decision.

## What changed

1. **Stories wait on state, never on time.** `window.app.caughtUp()` (`src/machines/AppContext.tsx`) resolves once tmux has done everything sent so far and the screen shows it. A query rides the same control-mode connection as every command and tmux answers in order, so its reply is a true barrier. `src/stories/tmuxBarrier.ts` wraps it, adds a wait for CSS transitions to finish, and names the one legitimate pause, between input events. Every fixed sleep in the v86 stories is converted, and `settleGeometry` samples across round trips instead of 400ms apart. `BLIND_WAIT_CEILING` in `bin/check-repo-policy.mjs` holds the v86 stories at zero and pins the other stories where they stand.
2. **Animations are stepped, not sampled.** The focus-cue story reads the fade's two CSS transitions, pauses them, and checks them at eleven points of their own timeline. It failed about one run in ten before and passed 30 of 30 after, unthrottled and at 6x CPU throttle; the one failure at 6x was the probe's page load timing out, not the story.
3. **The nightly tells a flake from a defect.** A failing story runs again that night, alone, on a fresh runner. Failing twice is a defect and is reported. Passing the second time is a flake: logged and kept in a ledger, and reported once it flakes on 2 of the last 7 nights. The rules are `packages/tmuxy-ui/scripts/lib/nightly-ledger.mjs`, with unit tests beside it.

The recurring theme story was deleted on 2026-10-20 with most of the v86 tier, so it needed no fix.
