# The nightlies: telling a flake from a defect

The nightly workflow (`.github/workflows/nightly-v86.yml`) runs every Storybook story: the `v86` tier, which boots real tmux in an x86 emulator in the page, and the deterministic tier, which replays recorded fixtures. Any failing story used to open the tracking issue and the next green night closed it. This page records why that issue reopened almost every week, why moving the guest to CheerpX would not have fixed it, and what did. How to read tonight's verdict is in [TESTS-STORYBOOK.md](TESTS-STORYBOOK.md#when-the-nightly-reports). The nightly tmux matrix now [follows the same rule](#the-tmux-matrix-follows-the-same-rule).

## What failed

A different story nearly every night, and the same run passed when re-dispatched. No single story was broken; the whole tier was waiting on time: the v86 stories held fixed sleeps, frame and paint budgets and wall-clock reads, each measured on a fast machine, and a loaded runner missed one of them. Ten local runs reproduced a failure once, at any CPU throttle: a race, not slowness. The one real regression in that stretch arrived in the same issue as the flakes, and nothing told it apart, so the issue had become a coin toss and the defect read like the rest.

## Would CheerpX fix it?

CheerpX (Leaning Technologies) runs x86 binaries in the browser through a JIT to WebAssembly. v86 compiles hot x86 code to WebAssembly too, on top of an interpreter that runs the rest, and is still several times slower than CheerpX on tight CPU loops. CheerpX was weighed as the engine for the test tier, and rejected:

| Question                                  | v86                                                              | CheerpX                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Speed                                     | JIT over an interpreter; slow boot without a snapshot            | JIT; several times faster on tight CPU loops                                                                     |
| Snapshot and restore of the whole machine | Yes; every story starts from the same restored state on one page | No; only disk state persists (IndexedDB or overlays)                                                             |
| Fidelity of the terminal                  | Real ptys; real tmux                                             | Patched tmux with emulated ptys, no full-screen programs, no pane sizes, Ctrl+C emulated                         |
| Where it loads from                       | Self-hosted assets in the repo's build                           | Only from the vendor's CDN; self-hosting needs a commercial licence                                              |
| Licence                                   | BSD                                                              | Free for open-source and individual projects, with credit; would end if the project were owned by a company      |
| Page requirements                         | None                                                             | Cross-origin isolation (COOP and COEP headers) for SharedArrayBuffer, which Storybook's dev server does not send |
| Use in headless CI                        | Running nightly here                                             | No public evidence of it; untested                                                                               |

Speed was never the cause: the failures above came from waiting on wall-clock time, and a faster engine changes how long a sleep needs to be, not whether a sleep is the right tool. CheerpX would also remove the snapshot every story starts from, lower the fidelity the tier exists for, and add a CDN download to every run, which is a fresh source of network flakes. The demo site ran on CheerpX for a while, where the page could be made cross-origin isolated; it was removed from there too, so the demo and the tests run on one guest, v86.

## What changed

1. **Stories wait on state, never on time.** `window.app.caughtUp()` (`src/machines/AppContext.tsx`) resolves once tmux has done everything sent so far and the screen shows it. A query rides the same control-mode connection as every command and tmux answers in order, so its reply is a true barrier. `src/stories/tmuxBarrier.ts` wraps it, adds a wait for CSS transitions to finish, and names the one legitimate pause, between input events. Every fixed sleep in the v86 stories is converted, and `settleGeometry` samples across round trips instead of 400ms apart. `BLIND_WAIT_CEILING` in `bin/ci/policy.mjs` holds the v86 stories at zero and pins the other stories where they stand. The guest's own start, which every story pays on its reset, follows the rule too: it types the attach line as soon as the machine runs and sends the core's attach commands when tmux announces its control client, with no fixed sleep before either (`start` in `src/infra/transport/drivers/guest/GuestEngine.ts`).
2. **Animations are stepped, not sampled.** The focus-cue story reads the fade's two CSS transitions, pauses them, and checks them at eleven points of their own timeline. It failed about one run in ten before and passed 30 of 30 after, unthrottled and at 6x CPU throttle; the one failure at 6x was the probe's page load timing out, not the story.
3. **The nightly tells a flake from a defect.** A failing story runs again that night, alone, on a fresh runner. Failing twice is a defect and is reported. Passing the second time is a flake: logged and kept in a ledger, and reported once it flakes on 2 of the last 7 nights. The rules are `packages/tmuxy-ui/scripts/lib/nightly-ledger.mjs`, with unit tests beside it.
4. **Every story starts at the snapshot's time.** The sweep rewinds one emulator between stories, and v86 sets a restored TSC right only on a machine whose TSC was never set. Every second restore left the guest's clock 99s behind its kernel, so the guest's time stood still for a minute and a half; the others leapt it forward by the previous story's length. A story that waited on the guest's time (`ShowsOnlyTheFinishedStart`'s `sleep 1`) failed whenever it followed another story, and passed on the fresh retry. The engine now zeroes the TSC offset before each restore (`restoreSnapshot`, `src/infra/transport/drivers/v86/v86Guest.ts`).

## The tmux matrix follows the same rule

The nightly tmux matrix (`.github/workflows/nightly-tmux-matrix.yml`) runs the E2E suite (181 tests) on four released tmux versions, and the snapshot and alternate-screen suites on tmux `HEAD`. Any single failing test used to open the issue "Nightly tmux version matrix is failing", which the next green night closed. Over 25 nights its failures were of three kinds:

| Kind | What it looked like |
| --- | --- |
| A defect | The same test red on every version, or red on one version every time it ran there (a plugin key on tmux 3.4, a notice on 3.2a) |
| A flake | One test on one version, a different one nearly every night, green on a re-dispatch. About 0.08% of test runs, which over some 720 a night is a red night more than one night in three, and it grows with the suite (114 tests on Nov 1, 181 on Nov 25) |
| A dead job | A job that ended before its suites ran: the apt mirror down, a cached tmux built against another ncurses |

Nothing told the first two apart, and the issue named no test. The verdicts and the ledger are now the story sweep's, imported from the same file, with these differences (`bin/ci/nightly-matrix.mjs`, with its tests beside it):

| | Story sweep | tmux matrix |
| --- | --- | --- |
| Unit | A story | A test (its file, describe titles and name), the same on every version; a file that could not run is one |
| Second run | The failing stories, on a fresh runner | The failing test files, in the same job, which has that version's tmux built; the server, tmux and the suite's config, data, state and home dirs are started over |
| Reported at once | A failure in both runs | A failure in both runs, or a flake of one test on two versions the same night: it depends on what ran before it, or it races everywhere |
| Not blocking | Nothing | tmux `HEAD`: a failure in both runs is reported without failing the run; a flake there is ignored |
| No verdict | A sweep that wrote no results | A version whose job left no results, and a step that failed without naming a test, count as failing twice |

The `core` step (the Rust integration tests) and the server start are not run twice: a failure there is reported that night.

## When the nightly matrix reports

One comment a night, naming each test, the tmux versions it failed on and what its error says before the stack. A flake on a single night is only in that run's job summary and log.

| Heading in the comment | What it means | What to do |
| --- | --- | --- |
| Failed twice | A defect in the product or the test. A version marked flaky passed its second run | Reproduce it against that tmux ([`TMUXY_E2E_TMUX_BIN`](TESTS-E2E.md#environment)) and fix it |
| Flaky on several nights | It flaked on 2 of the last 7 nights | Find what it waits on, or what an earlier test leaves behind |
| Flaky on several versions tonight | Two flakes of one test in one night are not chance | The same, starting with the tests that ran before it |
| tmux HEAD, non-blocking | Upstream master changed, or broke | Decide whether tmuxy has to follow; nothing is red because of it |

A reported test is fixed, not retried: the second run already was the retry. The run's job summaries list every version's failures and flakes. Its artifacts, per version, are the server log (the first server's is the file ending `-sweep.log` when a second one ran), and the jest results with the action trace ([TRACING.md](TRACING.md)).

To check a fix, run the version that failed: `gh workflow run nightly-tmux-matrix.yml -f version=3.4`, with `--ref` for a branch. Only a run of the whole matrix closes the issue, and only a scheduled night opens it or enters the ledger.
