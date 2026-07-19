# Tmuxy Deep Code Review

**Date:** 2026-07-16 · **Scope:** every hand-written source file in the repository — Rust crates (`tmuxy-core`, `tmuxy-server`, `tmuxy-tree`, `tmuxy-connect`, `tmuxy-wasm`, `tmuxy-tauri-app`), the React/XState frontend (`tmuxy-ui`), the demo engine and demo site, the shell/CLI layer (`bin/`), the E2E/QA test suites (`tests/`), CI workflows, and all documentation (`docs/`, `CLAUDE.md`, `README.md`). Generated dirs (`storybook-static`, `target`, `pkg`, `node_modules`, `.next/out`) excluded.

**Method:** eleven parallel deep-review passes, one per area, each reading every file in scope in full. Every dead-code claim was verified with repo-wide greps (including string-referenced XState actions, Tauri command names invoked by string, HTTP route strings, and shell-script `include_str!` embedding). Doc claims were verified against the code they describe. Findings carry severity (high/med/low), category, exact `file:line` anchors, and a concrete recommendation. Working-tree (uncommitted) state was reviewed where files were modified.

**Volume:** ~300 verified findings across 11 areas.

---

## Executive summary — the ten findings to act on first

> **Task list.** Checkboxes track remediation progress. `[ ]` = not started, `[~]` = in progress, `[x]` = done.

- [x] **1. Frozen UI after reconnect (web):** the SSE stream seeds its dedupe floor from a stale `Last-Event-Id` even when the replay buffer can't serve it, so after a server restart or a >2s disconnect (laptop sleep) every live event — including full snapshots — is silently skipped. `tmuxy-server/src/sse.rs:362,389`.
- [x] **2. Saved servers can be silently wiped:** `read_servers` maps parse failures to an empty list, and `add_server` then rewrites `servers.json` from that empty list — one corrupt read plus one add destroys every saved SSH server. `tmuxy-core/src/servers.rs:134-169`.
- [x] **3. Initial state fails to decode if a kitty image is on screen:** the production Effect schema for `ServerImagePlacement.protocol` omits `'kitty'`, which the Rust side emits — the exact drift the schema layer was built to catch, caused by the schema itself. `tmuxy-ui/src/tmux/effect/schemas.ts:55`.
- [x] **4. The project's #1 invariant ("all tmux commands through control mode") is violated in five reachable places:** the Tauri native menu (including a raw external `new-window` — the documented 3.5a crash), the `tmuxy run new-window` "safety" intercept, `session-switch`/`session-connect` scripts, `executor::new_window`, and a shell-metacharacter bypass of the new `is_readonly_query` guard (`&&`/`|`/`$()` pass the `;` filter into `sh -c`). See the Tauri, shell-layer, core, and server sections.
  - **Done:** `is_readonly_query` now rejects all shell metacharacters (`sse.rs`, + regression tests); the `tmuxy run new-window` intercept routes through `run-shell` via a temp file (`bin/tmuxy-cli`); `session-switch`/`session-connect` mutations wrapped in a new `_run_safe` helper (`bin/tmuxy/_lib`, `session-switch`, `session-connect`); the native menu now dispatches to the frontend's `executeMenuAction` via `window.tmuxyMenuAction` (`gui.rs`, `AppContext.tsx`) instead of raw external subprocesses; `docs/TMUX.md` updated. **Deferred to #5:** `executor::new_window` (only a pre-CC-attach fallback, crash-safe by timing) is slated for deletion with the coordinated executor-chain cleanup.
- [x] **5. A large dead command-handler chain spans three crates:**
  - **Done (committed, clean):** removed 24 dead `ClientCommand` variants + helper enums + `sse.rs` handler arms (incl. the hardcoded prefix-binding table), 17 dead Tauri commands + registration, ~18 dead `executor.rs` wrappers + the `process_key` lib re-export (~864 lines). Kept the 8 live commands + the 3 test-only Tauri commands the webdriver suite drives. Core 101 + server 17 tests green, clippy clean, tauri-app checks clean. the UI invokes only ~8 commands (`run_tmux_command`, `get_initial_state`, `get_scrollback_cells`, `set_client_size`, themes, connect, keybindings snapshot). That strands 24 of 32 server `ClientCommand` variants, 17 of 31 Tauri commands, and ~15 `executor` wrapper functions — deletable as one coordinated cleanup worth thousands of lines, along with the tests pinned to them.
- [x] **6. Three whole test tiers never run in CI:**
  - **Done:** added a `rust-tests` job (`cargo test --workspace`) and a `cli-tests` job (`npm run test:cli`) to `lint-and-tests.yml`; added E2E suites 6–9 to the matrix (+ `neovim` apt dep for suite 6); `skipIfNotReady()` now throws in CI (`process.env.CI`) instead of silently skipping. Verified locally: CLI suite 175/175 green, non-GUI workspace tests 152 green. no `cargo test` step exists (all Rust unit/integration tests unexecuted), the CLI suite that enforces tmux-socket isolation is excluded from the root jest config and referenced by no workflow, and E2E suites 6–9 (including the regression-bug suite) are absent from the CI matrix. Additionally `skipIfNotReady()` turns E2E infrastructure failure into a green run.
- [x] **7. Delta protocol gap detection exists only in the docs:**
  - **Done:** server SSE `Lagged` arm now replays from the ring buffer (`sse.rs`) instead of dropping the missed messages; stale `state.rs` comments corrected. Client gains `isDeltaSeqGap` (`deltaProtocol.ts`, tested); both adapters detect a seq gap and refetch `get_initial_state` (caching client size for the refetch). The existing DATA-FLOW.md promise is now accurate. **Committed (clean):** `deltaProtocol.ts` + test, `sse.rs`, `state.rs`. **Left uncommitted (your WIP):** `HttpAdapter.ts`, `adapters.ts` (resync wiring). DATA-FLOW.md promises the client resyncs on a `seq` gap; no client code reads `delta.seq`, and the server's "lagged subscriber replay" is also unimplemented. Dropped deltas silently diverge state. `tmuxy-ui/src/tmux/deltaProtocol.ts`, `tmuxy-server/src/state.rs:20-38`.
- [x] **8. Desktop-only feature breakage:**
  - **Done:** TauriAdapter now listens for `tmux-clipboard` + implements `onClipboard` (OSC 52 works on desktop); its KeyBatcher flush routes through `sendQueue` (no more keystroke reordering); `COPY_SELECTION` SIGINT targets `focusedFloatPaneId ?? realPaneId(activePaneId) ?? sessionName` (correct pane under a focused float / after an optimistic switch); `gui.rs` PATH `set_var` moved above the first spawn (false SAFETY comment removed); `monitor.rs` reconnect env race documented (full fix = `ConnectTarget` refactor, deferred). **Committed (clean base):** `gui.rs`, `monitor.rs`. **Left uncommitted (carry your in-progress WIP):** `adapters.ts` (clipboard + keystroke-queue), `appMachine.ts` (Ctrl+C target). OSC 52 clipboard is dropped (Tauri adapter never listens for `tmux-clipboard`), batched keystrokes bypass the Tauri serial queue (reordering risk the web adapter already fixed), and `Ctrl+C` from the selection menu targets the wrong pane when a float is focused. Plus `std::env::set_var` races on reconnect with a false SAFETY comment.
- [x] **9. OSC 8 hyperlinks stop working after the first screenful**
  - **Done:** `OscParser` now scroll-compensates its cell→URL map against a `viewport_height` (hyperlinks keep working past the first screenful and the map is bounded to the viewport), buffers incomplete OSC escapes split across `%output` chunks, and is `reset()` on pane resize + capture (`state.rs`) so stale URLs can't attach to new content. `ImageParser` buffers incomplete iTerm2/kitty/sixel escapes the same way (distinguishing split-from-non-image via a terminator scan). Removed the dead `HyperlinkRegion`/`hyperlinks`/`finalize_hyperlink*`/`update_cursor`. Added regression tests (osc scroll, osc split, image split, osc8 pass-through); tmuxy-core 102 tests green, clippy clean. (cursor-row tracking never resets/scrolls) and the per-pane URL map grows without bound. Escape sequences split across `%output` chunks (large iTerm2/sixel images) are torn and rendered as garbage. `tmuxy-core/src/control_mode/osc.rs`, `images.rs`.
- [x] **10. Stalled migrations left ~2,000 lines of scaffolding**
  - **Done (committed, clean):** deleted `VtEmulator.ts`, `useAnimatedPane.ts`, `tmuxStateSlices.ts`+test, the effect Phase-E2 modules (`sseStream`/`compoundOps`/`decoders`)+tests, the 5 empty guard files + `guards/index.ts`, the 5 empty `*Selectors` exports + `states/index.ts` barrel, `Ctx.fs`/`FileSystem`/`LiveFs`/`InMemoryFs`+`ctx_integration.rs`, and the server's speculative `error.rs`.
  - **Also done:** the tmux popup pipeline (`TmuxPopup`/`PopupDelta`/`PopupState` + parser events + delta diffing) deleted across `lib.rs`/`parser.rs`/`state.rs`; core tests + clippy green, wire format unchanged. that the project's own "no legacy code" rule forbids: `Ctx.fs`/`InMemoryFs` (never-enabled feature gate), the effect/ "Phase E2" modules (`sseStream`, `compoundOps`, `decoders`), `tmuxStateSlices.ts` (unwired and already diverged from the live handler), five empty guard files + five empty selector exports, `VtEmulator.ts` (356 lines, zero references), `useAnimatedPane.ts` (173 lines), the tmux popup pipeline (~300 lines, unreachable on both ends), and the server's speculative `error.rs`. Either finish these migrations or delete them; git history keeps them safe.

---

## Remediation status (updated 2026-07-19)

All ten executive-summary items above are done. A full re-verification pass of
the eleven per-area sections against current `main` (commit `1d4f714`) found
that roughly **60 more findings had already been fixed** as fallout from that
work, and **~220 remain open**. The per-area sections below are therefore
*stale as written* — treat this table as the index of what is left.

| Area | Fixed | Open | Notes |
| --- | --- | --- | --- |
| tmuxy-core: control_mode | 12 | 20 | OSC/image chunking, comma-safe window parsing, popup pipeline all landed |
| tmuxy-core: executor/session/lib | 18 | 22 | `Ctx.fs`, dead executor wrappers, servers.json data loss all landed |
| Rust: server/tree/connect/wasm | 17 | 19 | **Both security findings closed**; dead routes and `error.rs` deleted |
| tmuxy-tauri-app | 4 | 16 | native menu + PATH ordering landed; monitor/env findings open |
| tmuxy-ui: state machines | 6 | 37 | most bugs landed; dead events/constants/selectors open |
| tmuxy-ui: adapter/store | 11 | 20 | kitty schema, OSC 52, delta-gap, HttpAdapter races all landed |
| tmuxy-ui: components/hooks | 16 | 34 | all seven bugs landed; duplication + magic numbers open |
| Demo engine, stories, demo site | 0 | 31 | **untouched — no remediation yet** |
| Tests: E2E, helpers, QA | 2 | 41 | CI gaps closed; test-quality findings untouched |
| Shell layer: bin/, CI, root | 12 | 14 | see below |
| Documentation audit | 3 | 22 | mostly untouched |

### Remediation phases

- [x] **Phase 1 — Shell layer bugs** (commit `745ee84`). `run_safe` argument
      flattening (the headline one: `tmuxy run rename-window "my tab"` renamed
      the tab to `my`) fixed with a new `shquote` helper applied at every
      user-data interpolation site; `--json` serializers switched to a tab
      separator with escaped values; `tmuxy connect` env-write ordering race;
      `event-wait` flock (double-delivery); `event-list` socket namespace;
      `float-create` command-mode empty-id guard; `devcontainer --name` arity;
      `resize-window` message aligned with TMUX.md; `load-buffer -` documented
      in the safe-externals table. CLI suite 175 → 180 tests, all green.
- [x] **Phase 2 — Rust correctness** (commit `078cf5d`). Aggregator no longer
      reports a `ChangeType::Full` for empty command acks — every send-keys
      batch was forcing a full TmuxState rebuild + diff *per keystroke*; the
      list-panes sniff now requires the `%<digits>,` shape tmux actually emits
      so arbitrary `RunCommand` output can't conjure ghost panes. Scrollback
      geometry fails loudly instead of `unwrap_or(80)`/`(0)`; `set_client_size`
      treats a missing `x-connection-id` as absent rather than colliding on the
      real id 0; copy-mode sync queues before sending (no duplicate captures at
      the 50ms cadence); snapshot skips a pane that vanished mid-capture instead
      of aborting wholesale; `process_compound_command` splits on `\;` only
      outside quotes and stops treating a post-`-l` `-t` as a target; the
      `TraceLayer` span is attached to the future so it actually covers the
      dispatch/timeout/retries. Named the 200ms `source-file` settle, corrected
      the false `kill_on_drop` comment, and replaced two tautological executor
      tests with real helper coverage.
      **Still open in this area:** the blocking subprocesses inside the async
      monitor loop (`get_status_line`, `show_buffer_named`) and the full
      marker-routing of self-issued list commands, which would make the sniff
      exact rather than heuristic.
- [x] **Phase 3 — Tauri desktop** (commit `6cc630c`). The monitor now parks and
      waits for a user reconnect instead of returning after
      `MAX_CONSECUTIVE_FAILURES` — previously a transient tmux flap left the
      sidebar server picker silently no-opping until relaunch while
      `connect_server` still returned `Ok(())`. Hoisted
      `executor::new_window_rewrite` into tmuxy-core (quoting the session, which
      whitespace or a `;` previously broke) and pointed both transports at it.
      `show_status_message` uses `serde_json::to_string`, so a multi-line error
      no longer produces a JS syntax error and a silently missing banner; its
      speculative `_is_error` parameter is gone.
      **Still open in this area:** `TMUXY_CONNECT_SSH` is read with no writer
      (wire `tmuxy connect` to publish it, or drop the read — a product call);
      blocking subprocesses in async commands; the `std::env::set_var` reconnect
      race, whose real fix is the `ConnectTarget`-in-state refactor.
- [x] **Phase 4 — Frontend + demo bugs** (commit `3bc4f83`). All six
      demo-engine bugs fixed: `exit` now kills the shell's own pane (shells are
      bound to their pane id at construction) rather than the active one;
      `setSize` leaves float windows alone so a float no longer snaps to
      fullscreen on any viewport change; `getState` reports a float/group/
      sidebar pane's own shell dimensions instead of the whole surface; the CSI
      scanner terminates at the real final-byte range (`\x1b[K`, `\x1b[1A`,
      `\x1b[?25l` previously ate the text after them) and `parseSGR` consumes
      38/48 extended-colour arguments; `handleSendKeys` no longer
      double-unescapes (pasting `'quoted'` typed `quoted`); `groupAdd` allocates
      a window id only when it creates one; multi-line `write-widget` is
      detected before the newline split. Also corrected the two `appMachine`
      comments that claimed `reconnecting` shares idle's handlers — it does not,
      so input is dropped while the banner is up (which matches the transport
      being down; buffering would need an explicit queue).
      **Verification note:** the group-allocation regression test was checked
      against the pre-fix code and does fail there. An earlier draft asserting
      "no pane references a missing window" passed even with the bug
      reintroduced — `swapGroupPanes` always overwrites the phantom id — so that
      assertion was replaced rather than kept as false assurance.
      **Still open in this area:** the demo section's remaining ~25 findings are
      dead code, duplication and test-quality, not bugs. `LifoShell`'s CSI
      scanner has no public entry point, so it is covered only indirectly by the
      banner and story smoke tests; testing it directly needs either a test-only
      export or driving output through the sandbox. Tauri's hardcoded
      `defaultShell: 'bash'` is also still open.
- [x] **Phase 5 — Dead-code sweep** (commits `2811ab5`, `cecb01c`). Rust:
      `try_recv`/`command_counter`/`is_alive` and the whole command-number
      mechanism (send fns now return `Result<()>`), the ignored
      `ClientDetached`/`ClientSessionChanged` events (making `process_event`'s
      match exhaustive — future variants are compile errors), `SendTmuxBatch`,
      `StepResult.state_changed`, `queue_resize_captures`+`pending_resize_count`,
      `TestEmitter`, dead constants, `kill_session`/`read_theme_css`/
      `TmuxError::ParseFailure`/`TmuxRequest::new`, `bin/dev`'s unreachable
      trap; also fixed the initial-sync order to panes-first (the load-bearing
      order `refresh_after_window_add` documents). UI: the `machines/index.ts`
      and `tmux/index.ts` barrels, unused constants, TEN never-sent events end
      to end (incl. `DRAG_CANCEL`/`RESIZE_CANCEL`/`ENTER_COMMAND_MODE`), the
      `groupsAndFloatsState` alias, 14 dead selectors, `lastUpdateTime`/
      `connectionId`, the unused delta-schema graph, store dead members
      (`removeOp`/`cancelOp`/`resetToServer`/`OpTimedOut`/...). Demo: unused
      story helpers, write-only `updateStats`/`lastExitCode`, `isLastPane`/
      `closeFloat`, dead `start` script. Tests: `helpers/assertions.js` +
      `helpers/tmux.js` deleted whole, `performance.js` 10→2 exports, the dead
      `splitPaneUI` chain, four dead `TmuxTestSession` methods, the unused
      `glitchDetection` option, ten unused imports, the discarded `dbg` block.
      **Bonus:** `schemas.ts` now carries the compile-time hand-written⇄schema
      cross-check its header had falsely claimed — verified to fail when the
      kitty drift is reintroduced.
      **Left open:** the three Tauri commands kept for the webdriver test
      (documented in gui.rs), `TMUXY_CONNECT_SSH` (product call), QA scripts
      (possibly used by the qa agent — not deleted), `FLOAT_*` constants left
      because building the format strings from them is the better fix (phase 6
      DRY territory).
- [ ] **Phase 6 — DRY.** Theme listing + title-casing (still ×2 after the dead
      route went), `KeyBindings::current()`, the `new-window` rewrite string,
      `get_session()`, the `Output`/`ExtendedOutput` arms, newline
      normalization, bind-key parsing, `build_response`.
- [ ] **Phase 7 — Docs + test quality.** 22 open doc-drift findings (SSH
      "NOT IMPLEMENTED" for a shipped feature, `TMUXY_GROUPS`, WINDOW-TAGS.md
      as plan-doc-as-truth, missing crates/CLI nouns) and the 41 open E2E
      findings (tests that cannot fail, adapter calls instead of user paths,
      image tests that never check visibility).

---

## Cross-cutting themes

- **Two transports, one copy-paste:** the SSE server and the Tauri app duplicate five command handlers (scrollback, theme get/set/mode/list — already drifted on retry policy and option constants), the `new-window` rewrite string, theme title-casing (×3), and keybinding snapshot assembly (×3). Hoist into `tmuxy-core` functions over `&Ctx`.
- **Two renderers, two adapters, two comparators in the UI:** `TerminalLine.tsx` vs `terminalRendering.ts` reimplement the entire line renderer (and have diverged — copy-mode scrollback lacks wide-char handling); `HttpAdapter` vs `TauriAdapter` duplicate ~150 lines of listener/queue machinery; `cellLinesEqual` vs `linesEqual` disagree about what "changed" means. Each pair needs one shared core.
- **Tests that cannot fail:** beyond the CI gaps, the review found dozens of tautological or vacuous tests — assertions guarded by `if`, `expect(x).toBeGreaterThanOrEqual(0)`, tests that re-implement the code they test (HttpAdapter's SerialQueue copy, session.rs config parsing), "emoji" tests with no emoji, and a history test whose threshold is met before the feature runs.
- **Silent failure as a pattern:** `.ok()`/`unwrap_or` fallbacks that corrupt geometry or wipe data, test helpers that `catch → return` (pass on exception), `navigateToSession` returning a URL after exhausting retries, adapter `connect()` hanging forever on a `fatal` first event. Prefer loud errors at every one of these sites.
- **Comments describing code that no longer exists:** stale "Phase N" plan references across `tmuxy-core`, false SAFETY/JoinSet/control-mode-routing claims, docblocks contradicting the implementation two lines below. The docs audit found the same at doc level (SSH "NOT IMPLEMENTED" for an implemented feature; `TMUXY_GROUPS` mechanism that no longer exists; WINDOW-TAGS.md planning a finished migration).
- **Magic numbers guarding correctness paths:** settle timers (200ms source-file, 2s resize fallback, 50ms copy-mode pokes), buffer caps (32/8192 early-output), and timer-based "wait for the machine" syncs in components that should be machine-applied pending actions.

## Suggested cleanup order

1. Fix the data-loss and frozen-UI bugs (items 1–3 above) — small, high-impact, testable.
2. Add the missing CI: `cargo test --workspace`, the CLI suite, E2E suites 6–9, and make `skipIfNotReady` fail loudly. This locks in the baseline before the deletions.
3. Execute the coordinated dead-code deletion (item 5 + the per-area dead-code lists) — the `/dead-code` skill and `knip`/`cargo-machete` can drive the mechanical part; the cross-crate command chain needs the coordinated pass described in the core section.
4. Deduplicate the transport-pair and renderer-pair logic into shared cores.
5. Fix the control-mode-invariant violations (item 4) and the doc drift (docs section), updating TMUX.md to describe the *actual* remaining gaps.

---
## tmuxy-core: control_mode

### Dead code

1. **High / dead code — `state.rs:1021` `force_emit`, `state.rs:2734-2741` `get_pane`/`get_pane_mut`, `state.rs:2744-2747` `set_default_dimensions`, `state.rs:2661` `reset_delta_tracking`, `state.rs:2750-2761` `clear`, `state.rs:2764-2771` `has_popup`/`get_popup`, `state.rs:983` `mark_status_line_dirty`, `state.rs:1226-1232` `get_panes_in_copy_mode`.** Verified via rg across `/tmuxy/packages` (including `tmuxy-wasm`, `tmuxy-server`, `tmuxy-tauri-app`, core integration tests and benches), `/tmuxy/bin`, and `/tmuxy/tests`: none of these `StateAggregator`/`PaneState` public methods has a single caller. `clear()` is doubly problematic: it is documented "for reconnection" but doesn't reset `early_output`, `prev_state`, `delta_seq`, `pending_buffer_reads`, `buffer_read_armed`, or the settling fields — if a caller ever appeared, it would leak stale state across reconnects. Confidence: high. Recommendation: delete all of them; if reconnect-clearing is ever needed, reintroduce a correct `clear()` that resets every field (or just build a fresh `StateAggregator`).

2. **High / dead code — `state.rs:819-820` `default_width`/`default_height` fields.** Written in both constructors (`state.rs:933-934`, `961-962`) and by the dead `set_default_dimensions`, but never read anywhere in the crate or repo. The doc comment "Default pane dimensions (used when creating new panes)" is false — `PaneState::new` always receives explicit layout/list-panes dimensions. Confidence: high. Recommendation: delete the fields, the setter, and the constructor initializers.

3. **High / dead code — `connection.rs:588-591` `try_recv`, `connection.rs:636-639` `command_counter()`.** No callers anywhere. More broadly, the command-number tracking (`command_counter` field, the `u32` returned from `send_command`/`send_commands_batch` at `connection.rs:513-579`) is vestigial: no caller ever consumes the returned number — response correlation is done via the `TMUXY_CAP_BEGIN`/`END` markers instead. Confidence: high for the two methods; medium for removing the counter entirely (the returned value is part of the send signatures). Recommendation: delete `try_recv` and `command_counter()`; consider changing `send_command`/`send_commands_batch` to return `Result<(), TmuxError>` and dropping the counter.

4. **Medium / dead code — `monitor.rs:878-900` `TmuxMonitor::send_command`, `current_state`, `is_alive`, `kill`, `config`.** Grep of `tmuxy-server` and `tmuxy-tauri-app` (the only two `TmuxMonitor` consumers) shows they only use `connect()`, `run()`, and the `MonitorCommand` channel. None of these five public methods is called anywhere, including tests. Confidence: high (whole-repo grep). Recommendation: delete; the command channel is the supported external interface.

5. **Medium / dead code — `parser.rs:84-92, 296-301, 517-531` `ClientDetached` and `ClientSessionChanged` events.** Both are parsed into `ControlModeEvent` variants, but every consumer drops them: `state.rs:1828` `_ => ProcessEventResult::default()`, and neither `monitor.rs` nor `tmuxy-wasm` matches them. The parsing functions `parse_client_session_changed` exist only to feed a bit bucket. Confidence: high that they're unused; medium on removal (cheap forward-compat). Recommendation: remove the variants and parsing, or leave a one-line comment explaining why they're intentionally ignored — currently there's neither handling nor explanation.

6. **High / dead code — `osc.rs:10-24` `HyperlinkRegion`, `osc.rs:37` `hyperlinks` field, `osc.rs:198-211` `finalize_hyperlink`, `osc.rs:213-217` `finalize_hyperlink_line`, `osc.rs:61-64` `update_cursor`, `osc.rs:50-58` `reset`.** The only consumed output of `OscParser` is `cell_urls` (via `get_url` from `extract_cells_with_urls`, `lib.rs:188`) and `pending_clipboard` (via `take_clipboard`, `state.rs:1860`). The `hyperlinks: Vec<HyperlinkRegion>` accumulator is written but never read anywhere in the repo. `finalize_hyperlink_line` is an empty no-op called on every newline. `update_cursor` and `reset` have zero callers (rg across all packages) — and `reset` *should* be called (see Bugs #1). Confidence: high. Recommendation: delete `HyperlinkRegion`, `hyperlinks`, `finalize_hyperlink_line`, and either delete or start actually calling `update_cursor`/`reset`.

7. **Medium / dead code — `constants.rs:122` `UNLINKED_WINDOW_RENAMED`, `constants.rs:136` `SUBSCRIPTION_CHANGED`, `constants.rs:70-77` `LIST_WINDOWS_FIELDS`.** All three constants have zero uses (the parser handles neither event; `LIST_WINDOWS_CMD` is used everywhere instead of `LIST_WINDOWS_FIELDS`). The module's own doc claims constants exist so "a typo can't diverge a sender from its reader" — dead constants with no reader defeat that. Confidence: high. Recommendation: delete.

8. **Medium / dead feature — the entire popup pipeline.** `parser.rs:103-125, 338-401` (popup event parsing), `state.rs:620-688` `PopupState`, `state.rs:1754-1799` (popup event handling), `state.rs:2465-2495` (popup delta diffing), plus `TmuxPopup`/`PopupDelta` in `lib.rs:389-408, 602-637`. This requires tmux PR #4361, which every comment admits is unmerged ("popup state will always be None"), *and* the frontend has zero popup handling (rg for `popup` in `tmuxy-ui/src/tmux`, `machines`, `components` returns nothing but the unrelated `ServerPicker`). The feature is unreachable on both ends. Given CLAUDE.md's "no legacy code / breaking changes welcome" policy, ~300 lines of speculative plumbing is a maintenance tax. Confidence: high that it's unreachable; recommendation: delete, or at minimum extract to one module so it stops threading through `process_event`, `to_state_update`, and `TmuxState`.

9. **Low / dead code — `monitor.rs:931-949` `TestEmitter` fixture marked `#[allow(dead_code)]` and "kept for future StateEmitter tests".** This is exactly the "not doing" dead code CLAUDE.md forbids. Recommendation: delete; recreate when a test needs it.

10. **Low / dead code — `state.rs:143` `SideEffect::SendTmuxBatch`.** Never constructed by the aggregator (only `SendTmuxCommand` is, at `state.rs:1320`); the monitor arm at `monitor.rs:626-630` even documents itself as "unreachable today", and the wasm arm at `tmuxy-wasm/src/lib.rs:72` is likewise dead. Recommendation: remove the variant until something emits it.

11. **Low / dead code — `state.rs:126-129` `StepResult.state_changed`.** Both consumers (`monitor.rs:on_control_event` and `tmuxy-wasm`) read only `.effects` and `.change_type`; no code or test reads `StepResult.state_changed` (the sideeffects test at `state_aggregator_sideeffects.rs:116` asserts on `ProcessEventResult.state_changed`, a different struct). Recommendation: drop the field from `StepResult`.

### Bugs

1. **High / bug — OSC 8 hyperlink cell mapping breaks after the first screenful, and grows without bound.** `osc.rs:84-100`: `OscParser` tracks its own `cursor_row`, incremented on every `\n` and **never reset or scroll-adjusted** (no caller of `reset()`, `update_cursor()` is never invoked, and CSI cursor movement is ignored). Meanwhile the only reader, `extract_cells_with_urls` (`lib.rs:188`), queries `get_url(row, col)` with vt100 *screen* rows `0..height`. Once a pane's output exceeds its height, all new hyperlinks are recorded at rows ≥ height and never match a screen cell — hyperlinks silently stop working. Additionally `cell_urls` (a `HashMap<(u32,u32),String>`) is never pruned, growing unboundedly for long-lived panes, and stale mappings survive `PaneState::resize` (`state.rs:390-417` resets `image_parser` but not `osc_parser`) and `reset_and_process_capture` (`state.rs:350-386`), so old URLs can attach to new content at the same coordinates. The E2E suite comment "clickable links are a future enhancement" (`tests/3-rendering-protocols.test.js:233`) suggests this has gone unnoticed because the feature is barely exercised. Recommendation: derive URL regions from vt100 state (row-relative to scrollback) or reset/scroll-compensate the OSC cursor on every newline past the bottom row; prune `cell_urls` on resize/capture.

2. **Medium-high / bug — `parse_list_windows_line` breaks on commas in window names.** `state.rs:2253-2311` splits the list-windows line on `,` with fixed offsets. `#{window_name}` is free text — `rename-window 'build, test'` shifts every subsequent field: the name is truncated, `window_type` receives the name's tail (fails `WindowType::parse`, so the window is momentarily foreign and gets re-adopted/re-tagged), and all float metadata (`float_parent/width/height/drawer/bg/noheader`, `group_panes`) is misparsed. `parse_list_panes_line` (`state.rs:2090-2247`) grew a 90-line anchor-scanning workaround for exactly this class of problem in pane titles, but the window parser got no equivalent. Recommendation: change `LIST_WINDOWS_CMD` to a delimiter that can't appear in names (the `serversActor` poll already uses tab-joined rows for this reason) or move `window_name` to the last field and join the remainder; add a regression test mirroring `list_panes_title_with_commas_keeps_window_id`.

3. **Medium / bug — image/OSC escape sequences split across `%output` events are lost and leak garbage into vt100.** `images.rs:133-184` and `osc.rs:68-107` parse only within a single chunk: `try_parse_iterm2/kitty/sixel` and `find_osc_end` return `None` on an incomplete sequence, and `process()` then pushes the partial escape bytes straight to the vt100 stream. tmux emits `%output` in bounded chunks, so any inline image larger than one read (very common for iTerm2/sixel payloads) is torn: the header half renders as garbage text and the image is never stored. Kitty survives only when the *application* chunks with `m=1`. Recommendation: buffer an incomplete trailing escape in `ImageParser`/`OscParser` and carry it into the next `process()` call (the wasm `Session.pending` field at `tmuxy-wasm/src/lib.rs:50` does exactly this for line splitting — same pattern).

4. **Medium / bug — blocking subprocess calls inside the async monitor loop.** `state.rs:1087-1091` `get_status_line` calls `executor::capture_status_line` (multiple synchronous `std::process` tmux invocations, `executor.rs:525+`) from inside `to_tmux_state`, which runs on every `to_state_update()` in the tokio select loop; `monitor.rs:564-571` calls the synchronous `executor::show_buffer_named` in `on_control_event`. Both stall the entire event loop (no `%output` processing, no command dispatch) for the duration of subprocess spawn + tmux round-trip, on every status-dirty emission / paste-buffer event. They are read-only (documented safe re: the CC crash), but the latency lands in the hottest path. Recommendation: fetch the status line via the control-mode channel (marker-wrapped, like captures) or `spawn_blocking`; the in-band `TMUXY_BUF_BEGIN` mechanism already implemented for wasm (`state.rs:1577-1592`) would let the native path drop `show_buffer_named` entirely.

5. **Medium / bug — every unrecognized command response triggers a full state rebuild, and the list-panes sniffing heuristic can be spoofed.** `state.rs:1710-1721`: any `CommandResponse` that isn't marker-routed returns `state_changed: true, change_type: Full` — including the empty ack of every `send-keys` the frontend sends. Each one forces `to_state_update()`: a full `TmuxState` build, per-pane clone, and diff (Arc-sharing spares the grids, but windows/metadata are cloned and diffed per keystroke). Separately, `handle_command_response` (`state.rs:2015-2084`) treats any response line containing `%` and `,` with ≥11 comma-fields as list-panes output — output of an arbitrary `RunCommand` (which flows fire-and-forget through the same channel) matching that shape would create ghost panes in the aggregator. Recommendation: marker-wrap the self-issued `list-panes`/`list-windows` commands the same way captures are wrapped, then return `ChangeType::None` for unmarked acks.

6. **Low-medium / bug — copy-mode sync bypasses capture dedup.** `monitor.rs:773-795` `on_sync_tick` builds `capture_command(...)` entries for *every* copy-mode pane before calling `queue_captures`, then ignores the returned queued subset (`let _ =`). Contrast `refresh_panes` (`monitor.rs:654-674`), which only sends commands for `queued_panes`. At the 50ms copy-mode cadence, a slow response means duplicate captures pile onto the connection for panes already pending. Recommendation: mirror `refresh_panes` — queue first, send only what was newly queued.

7. **Low-medium / bug (vestigial mechanism) — `pending_resize_count` has no observable effect.** `monitor.rs:271, 660-666, 827-839`: it exists solely to choose `queue_resize_captures` over `queue_captures`, but the two methods are now byte-identical (`state.rs:1113-1139` — the comment on `queue_resize_captures` even narrates that its distinguishing behavior was removed). The counter can also drift upward when a resize produces no layout change (incremented on send at `monitor.rs:827/839`, decremented only on a matching `PaneLayout` refresh). Harmless today precisely because the branch is a no-op. Recommendation: delete `queue_resize_captures`, `pending_resize_count`, and the branch in `refresh_panes`.

8. **Low / bug — false `Drop` comment in `connection.rs:642-646`.** "kill_on_drop is set, so this is handled automatically" — it is not: pty-process 0.5.3 requires an explicit `Command::kill_on_drop(true)` call (verified in the crate source), and `spawn_tmux` (`connection.rs:391-439`) never calls it; tokio's default is `false`. In practice the child exits via SIGHUP when the PTY master drops, and the graceful-close path deliberately avoids SIGKILL, so behavior is probably fine — but the comment documents a mechanism that doesn't exist. Recommendation: delete the empty `Drop` impl and its comment, or document the actual PTY-hangup mechanism.

9. **Low / bug — stray `%end`/`%error` emits a garbage `CommandResponse`.** `parser.rs:193-202` `handle_end` doesn't check `in_response`; an unmatched `%end` produces a `CommandResponse` with the previous block's stale `timestamp`/`command_num` and an empty body, which downstream treats as a real (state-changing) response. Recommendation: return `None` when `!self.in_response`.

### Duplicate / near-duplicate logic (DRY)

10. **Medium — `state.rs:1387-1439`: the `Output` and `ExtendedOutput` arms of `process_event` are copy-pasted 50 lines.** Identical bodies apart from destructuring. Recommendation: extract a `fn output_result(&mut self, pane_id: String, content: &[u8]) -> ProcessEventResult` and call it from both arms.

11. **Medium — newline normalization triplicated.** The strip-trailing-`\n` + `\n`→`\r\n` expansion appears in `state.rs:350-386` (`reset_and_process_capture`), `state.rs:441-470` (`process_copy_mode_capture`), `lib.rs:227-249` (`parse_ansi_to_cells`), and a fourth hand-inlined copy in the `lib.rs:876-903` test. Recommendation: one `fn normalize_capture_bytes(content: &[u8]) -> Vec<u8>` in `control_mode` used by all of them.

12. **Medium — `StateAggregator::new()` vs `with_session_name()` (`state.rs:926-980`)** are two 25-line identical initializer blocks differing in one field. Recommendation: `new()` → `Self::with_session_name(crate::DEFAULT_SESSION_NAME)`, or `#[derive(Default)]`-style construction with an override.

13. **Low — `capture_command` vs `capture_command_range` (`state.rs:911-924`)** duplicate the marker-bracket format string; the range variant only appends `-S/-E`. Recommendation: build both from one helper taking an optional range.

14. **Low — `find_osc_end` implemented twice**: `osc.rs:111-129` (method) and `images.rs:538-548` (free function), same algorithm with slightly different slicing conventions. Recommendation: share one function.

15. **Low — hand-rolled base64 decoder in `osc.rs:231-264`** duplicates what `images.rs:551-567` already does with the `base64` crate (a workspace dependency), and does it with an O(64)-per-character alphabet scan. Recommendation: delete the hand-rolled decoder and use the crate (it's already wasm-safe).

### Refactoring opportunities

16. **Medium — `state.rs` is 3,102 lines with at least five separable concerns**: layout-string parsing (`parse_layout_panes` and friends, ~100 lines), list-panes/list-windows CSV parsing (~260 lines), the delta engine (`to_state_update`/`compute_pane_delta`/`compute_window_delta`, ~340 lines), the settling state machine, and per-pane VT emulation (`PaneState`). All are pure and independently testable. Recommendation: split into `layout.rs`, `list_parsers.rs`, `delta.rs`, `pane.rs` under `control_mode/`, keeping `StateAggregator` as the coordinator.

17. **Medium — `parse_list_panes_line` (`state.rs:2090-2247`) is a 160-line fragile CSV heuristic** (anchor scanning for `@N` bounded by four int-like fields, plus a fixed-offset fallback) that exists only because two free-text fields are embedded mid-row in a comma-joined format. The serversActor poll solved the same problem by tab-joining. Recommendation: change `LIST_PANES_CMD` to a tab (or `\x1f`) delimiter and reduce the parser to a straight split — this deletes the heuristic, its fallback, and the three comma-title regression tests' reason to exist.

18. **Low-medium — `safe_process` (`state.rs:22-34`) uses an unnecessary raw pointer + `unsafe`.** `std::panic::catch_unwind(AssertUnwindSafe(|| terminal.process(data)))` compiles fine — `AssertUnwindSafe` exists precisely to bless the `&mut` capture, which the code already relies on. The comment even acknowledges this while keeping the pointer. Recommendation: drop the `unsafe` block.

19. **Low-medium — native `%paste-buffer-changed` handling bypasses the sans-IO design.** `monitor.rs:560-571` intercepts the event *before* `aggregator.step()` and does blocking I/O, while `state.rs:1577-1592` implements a clean in-band effect-driven version used only by wasm. Two implementations of the same feature, one of which contradicts the module's "the aggregator never performs I/O — the runtime dispatches effects" architecture. Recommendation: let the native monitor use the aggregator's in-band `SideEffect::SendTmuxCommand` path and delete the intercept.

20. **Low — inconsistent constant usage in `parser.rs`.** All events go through `crate::constants::control_events`, except the three popup events (`parser.rs:338-353`) which use hardcoded `"%popup-open "` literals, and the body parsers slice with re-typed literals (`&line["%output ".len()..]`, `parser.rs:404`) instead of `strip_prefix(ev::OUTPUT)` — a divergence between the `starts_with` constant and the slice literal would corrupt parsing silently, which is exactly what constants.rs says it exists to prevent. Recommendation: use `strip_prefix` with the constants throughout.

### Contradictions

21. **Medium — `constants.rs:38-40` documents `@tmuxy-group-panes` as "CSV of pane IDs (e.g. `%4,%6,%7`)", but the actual format is space-separated.** `state.rs:2283-2289` parses `split_whitespace` with a comment explaining space-separation was chosen *specifically to avoid* commas, and `bin/tmuxy/_lib:6` confirms "space-separated pane ids". A reader implementing against the constants doc writes the wrong format. Recommendation: fix the doc comment.

22. **Low — initial-sync command order contradicts the window-add order and the wasm mirror's claim.** `refresh_after_window_add` (`monitor.rs:637-648`) documents list-panes-before-list-windows as load-bearing; `sync_initial_state` (`monitor.rs:366-374`) sends windows *then* panes; `tmuxy-wasm/src/lib.rs:174-183` sends panes-then-windows claiming "Order matches the native monitor". At startup the ordering risk described in `refresh_after_window_add` (emitting window state before its panes exist) applies equally. Recommendation: make `sync_initial_state` panes-first and share one constant pair.

23. **Low — `monitor.rs:417-427` "Window-level settings (setw -g)"** — the code sends `setw` *without* `-g` (and the next comment explains why `-g` is avoided). The heading documents the flag the code deliberately omits. Recommendation: fix the heading.

### Outdated code / comments

24. **Medium — `MonitorConfig::sync_interval` (`monitor.rs:69-70`) is documented as the "Interval for periodic state sync (e.g., list-panes for cursor position)" but is only used once, to pad the *initial* sync deadline (`RunState::new`, `monitor.rs:168`).** The actual sync cadences are hardcoded in `RunState` (`idle_threshold` 10s, `copy_mode_sync_interval` 50ms, `heartbeat_interval` 15s). Relatedly, `build_tmux_pane`'s comment (`state.rs:475-476`) still claims tmux cursor positions arrive from "periodic list-panes responses (every 500ms)" — that polling model was replaced by the event-driven heartbeat. Recommendation: rename/remove `sync_interval` and fix both comments.

25. **Low — `queue_resize_captures` doc block is garbled (`state.rs:1124-1129`)**: two overlapping doc comments, the first narrating removed behavior ("Previously suppressed the next %output… but that caused…"), the second a fresh summary. Together with Bugs #7 this method should simply be deleted.

26. **Low — `LogSink` doc (`log.rs:3-8`) says the sink "is threaded through connection.rs and monitor.rs"** — accurate — but `StateEmitter: LogSink` (`monitor.rs:42`) means every emitter carries a no-op log method; fine, just noting the trait bound is the only reason `log.rs` is re-exported.

### Unclear code / magic numbers

27. **Low — `handle_output` buffer caps (`state.rs:1867-1874`)**: `32` early-output entries and `8192` bytes per pane are unexplained magic numbers guarding an important correctness path (early output replay). Recommendation: named constants with a one-line rationale.

28. **Low — `parse_layout_node` conflates pane-id number with pane index.** `state.rs:790-799`: the trailing number in a tmux layout leaf is the pane's *id* number (`%N`), yet it's stored as `index: pane_idx` on `LayoutPane` and copied into `PaneState.index` ("tmux pane_index", `state.rs:175-176`) until the next list-panes overwrites it. Windows got a whole provisional-index mechanism for exactly this id/index conflation (`next_window_index`, `state.rs:1146-1161`); panes silently carry the wrong index in the interim. Impact is low (frontend keys on `tmux_id`), but the field is misleadingly documented. Recommendation: comment the provisional nature or stop populating `index` from the layout.

29. **Low — `RunState` hardcodes six tuning durations (`monitor.rs:163-186`)** (`10s`, `50ms`, `15s`, `16ms`, `100ms`, `16ms`) inline while three sibling knobs live in `MonitorConfig`. The split between "configurable" and "hardcoded" appears historical rather than principled. Recommendation: either move them into `MonitorConfig` or a single `const` block with rationale.

### Missing tests / low-value tests

30. **Medium / low-value test — `state.rs:3084-3101` `list_windows_still_corrects_a_wrong_provisional_index` is tautological.** It sets `w.index = 5` by hand and then asserts `w.index == 5` — `parse_list_windows_line` is never invoked; the test verifies field assignment, not the "authoritative list-windows wins" behavior its comment claims. Recommendation: drive it through `process_event(CommandResponse { output: "<list-windows line>" })` and assert the index correction.

31. **Medium / missing test — no test feeds a comma-containing window name through `parse_list_windows_line`** (would catch Bugs #2). The pane-side equivalent has three regression tests (`state.rs:2951-2986`); the window side has zero coverage at all — `parse_list_windows_line` is untested even for the happy path outside the integration stream in `control_mode_push_api.rs`. Recommendation: add both.

32. **Low / weak test — `images.rs:719-733` `sixel_decoded_to_png` guards all its assertions behind `if !parser.placements.is_empty()`**, so a total sixel-decode regression (every image silently dropped) passes green. Recommendation: use a known-good sixel fixture and assert unconditionally.

33. **Low / missing test — nothing exercises chunk-split escape sequences** (an iTerm2/OSC-52 sequence torn across two `process()` calls) — the case in Bugs #3. Once cross-chunk buffering is added, add a two-`feed` test; today a test would document the known loss.

### Overengineering

34. **Covered above but summarized:** the popup pipeline (Dead #8), `SideEffect::SendTmuxBatch` (Dead #10), the `queue_resize_captures`/`pending_resize_count` mechanism (Bugs #7), and the unread `default_width/height` "configuration" (Dead #2) are all machinery with no live consumer or no observable effect. Removing them shrinks `state.rs`/`monitor.rs` by several hundred lines with zero behavior change — well aligned with the project's "no legacy code" rule.
## tmuxy-core: executor, session, lib

Scope: all `.rs` under `/tmuxy/packages/tmuxy-core/src/` except `control_mode/` — `constants.rs`, `ctx.rs`, `debug_log.rs`, `error.rs`, `executor.rs`, `lib.rs`, `retry.rs`, `servers.rs`, `session.rs`, `tmux_service.rs`, `bin/tmux_capture.rs`. Every "dead" claim below was verified with `rg` across `/tmuxy/packages` (incl. tmuxy-server, tmuxy-tauri-app, tmuxy-wasm, tmuxy-connect), `/tmuxy/bin`, and `/tmuxy/tests`.

### Dead code

- **High severity, dead code — CI never runs any Rust tests.** `/tmuxy/.github/workflows/lint-and-tests.yml` runs `cargo fmt`, `cargo clippy`, Vitest, and E2E — there is no `cargo test` anywhere in workflows or npm scripts. Every `#[cfg(test)]` module in this crate (error.rs, retry.rs, ctx.rs, tmux_service.rs, session.rs, servers.rs, executor.rs, lib.rs) and `/tmuxy/packages/tmuxy-core/tests/*.rs` is effectively unexecuted by CI. This also silently blesses the dead code below (nothing exercises it). Recommendation: add a `cargo test --workspace` step to the lint-and-tests workflow. Confidence: high.

- **Med, dead code — `executor::capture_pane`** at `/tmuxy/packages/tmuxy-core/src/executor.rs:72`. Zero callers repo-wide (only a stale mention in a `retry.rs` doc comment). Delete. Confidence: high.

- **Med, dead code — `executor::get_pane_info`** at `/tmuxy/packages/tmuxy-core/src/executor.rs:127`. Zero callers repo-wide. Delete. Confidence: high.

- **Med, dead code — `executor::run_tmux_command`** at `/tmuxy/packages/tmuxy-core/src/executor.rs:862`. The `DEFAULT_SESSION_NAME` convenience wrapper has zero callers; server and Tauri both call `run_tmux_command_for_session` directly. Delete. Confidence: high.

- **Med, dead code — `PopupDelta`** at `/tmuxy/packages/tmuxy-core/src/lib.rs:603-637`. The struct and its `is_empty` are referenced nowhere else in the repo. `TmuxDelta.popup` (lib.rs:673) is `Option<Option<TmuxPopup>>` — full popups, never partial deltas — so the doc comment at lib.rs:670-671 ("Some(delta) = partial update") describes a shape that doesn't exist. Delete `PopupDelta` and fix the comment. Confidence: high.

- **Med, dead code — `TerminalCell::new`** at `/tmuxy/packages/tmuxy-core/src/lib.rs:112-114`. Zero callers (everything uses `with_style` or struct literals). Delete. Confidence: high.

- **Med, dead code — `session::kill_session`** at `/tmuxy/packages/tmuxy-core/src/session.rs:946-953`. Zero callers repo-wide. Delete. Confidence: high.

- **Med, dead code — `session::read_theme_css`** at `/tmuxy/packages/tmuxy-core/src/session.rs:831-845`. Zero callers; the server (`tmuxy-server/src/state.rs:466`, `server.rs:272`) and Tauri (`commands.rs:368`) read theme files from `config_dir().join("themes")` directly, which also means the bundled-theme fallback this function implements exists nowhere in the live path. Delete, or adopt it at those call sites if the fallback is wanted. Confidence: high.

- **Med, dead code — `TmuxError::ParseFailure`** at `/tmuxy/packages/tmuxy-core/src/error.rs:55`. Never constructed anywhere in the repo, yet the module doc (error.rs:19-20) claims "control-mode parser couldn't decode a line… the line itself is preserved for diagnostics." The parser silently returns `None` on undecodable lines instead. Either use the variant in the parser or delete it and its doc bullet. Confidence: high.

- **Med, dead code — unused constants in `constants.rs`:**
  - `tmux_options::FLOAT_PARENT/FLOAT_WIDTH/FLOAT_HEIGHT/FLOAT_DRAWER/FLOAT_BG/FLOAT_NOHEADER/GROUP_PANES` (`/tmuxy/packages/tmuxy-core/src/constants.rs:27-39`) — zero uses; the format strings in `tmux_formats` (constants.rs:70-102) hardcode `#{@tmuxy-float-parent}` etc. as literals, defeating the module's own stated purpose ("ensures a typo can't diverge a sender from its reader").
  - `tmux_options::WINDOW_LIST_FORMAT_OPTIONS` (constants.rs:49-58) — zero uses; its comment claims monitor.rs consumes it, which is false.
  - `tmux_formats::LIST_WINDOWS_FIELDS` (constants.rs:70-76) — zero uses; only `LIST_WINDOWS_CMD` is used, and the two duplicate the field list verbatim.
  - `control_events::UNLINKED_WINDOW_RENAMED` (constants.rs:122) and `control_events::SUBSCRIPTION_CHANGED` (constants.rs:136) — the parser never references them.
  Recommendation: delete the unused constants, or (better for the FLOAT_*/GROUP_PANES group) actually build the format strings from them. Confidence: high.

- **Med, dead code (feature chain) — the legacy per-operation executor wrappers.** `split_pane_horizontal`/`split_pane_vertical` (executor.rs:158-166), `new_window` (:168), `select_pane` (:221), `select_window` (:238), `next_window`/`previous_window` (:244-252), `kill_pane` (:254), `select_pane_by_id` (:260), `scroll_pane` (:266), `resize_pane` (:325), `kill_window` (:855), `execute_prefix_binding` (:1104), `show_buffer` (:83), `capture_pane_with_history` (:93), `process_key` (:1343). These are referenced only by server `ClientCommand` handlers (`sse.rs`) and Tauri commands (`commands.rs`) that **no current frontend sends** — the UI invokes exactly `run_tmux_command`, `connect_server`, `get_keybindings_snapshot`, `get_initial_state`, `get_scrollback_cells`, `set_client_size`, and theme commands (verified by grepping every `invoke(`/`cmd:` string in `packages/tmuxy-ui/src`). The only external consumer is `tests/tauri/tauri-app.test.js:149,290` calling `split_pane_horizontal` directly. Recommendation: treat this as one coordinated cleanup with the server/tauri owners — delete the executor fns together with their unreachable `ClientCommand` variants and Tauri commands. Confidence: medium (compiler-reachable, user-unreachable; one webdriver test would need updating).

- **Low, dead code — `TmuxRequest::new`** at `/tmuxy/packages/tmuxy-core/src/tmux_service.rs:36-41`. Only used by `tmux_service`'s own tests; all production callers use `with_name`. Delete or have tests use `with_name`. Confidence: high.

- **Med, dead code + overengineering — `Ctx.fs` / `FileSystem` / `LiveFs` / `InMemoryFs`** at `/tmuxy/packages/tmuxy-core/src/ctx.rs:41-46,141-159,251-288`. No production code reads `ctx.fs`; `session.rs` still calls `std::fs` directly. The only consumer is `/tmuxy/packages/tmuxy-core/tests/ctx_integration.rs`, which defines a stand-in function *inside the test* to exercise the mocks — and that file is gated on `#![cfg(feature = "test-support")]`, a feature no crate or CI invocation ever enables, so it never runs at all. The `Clock` half of `Ctx` is genuinely used (monitor.rs), but the filesystem capability is a single-implementation abstraction awaiting a "Phase 4.9b" migration that never happened. Recommendation: remove `fs` from `Ctx` (and `InMemoryFs`, `LiveFs`, the trait) or actually port `session.rs` to it; delete or un-gate `ctx_integration.rs`. Confidence: high on non-use; medium on remove-vs-finish.

### Bugs

- **High, bug — corrupt `servers.json` silently destroys the user's saved servers.** `/tmuxy/packages/tmuxy-core/src/servers.rs:134-147`: `read_servers` maps both read and parse failures to an empty list with `.ok()`, no warning. `add_server` (:161-169) then does `read_servers()` → mutate → `write_servers()`, so one transient parse failure (e.g. a truncated write, or a newer schema an old binary can't parse) followed by any add/replace **overwrites the file with just `[localhost]` plus the new entry**, permanently losing every saved SSH server. Contrast `read_managed_state` (session.rs:443-455), which at least warns. Recommendation: on parse failure, log a warning and make `add_server` refuse to write (or write a `.bak` first). Confidence: high.

- **Med, bug — `TraceLayer`'s span does not cover the async work.** `/tmuxy/packages/tmuxy-core/src/tmux_service.rs:251-256`: `#[instrument]` is applied to `call()`, a synchronous fn that returns a boxed future. The span opens and closes during future *construction*; the actual tmux dispatch, timeout, and retries run outside it, so the layer's stated guarantee ("the span fields … attach to every inner emit", :222-224, and `build_tmux_stack`'s "one span per outer call, attached to every downstream emit", :98-100) is false. Recommendation: create the span manually and attach it with `tracing::Instrument::instrument(async move { … }, span)` on the boxed future. Confidence: high.

- **Med, bug — remote status-line `#(cmd)` executes on the wrong host.** `/tmuxy/packages/tmuxy-core/src/executor.rs:568-577,612-651`: `capture_status_line` fetches the raw `status-right` format and `evaluate_shell_commands` runs each `#(cmd)` via local `sh -c`. When the app is attached to a remote server (`TMUXY_SSH` set — supported since the server-picker feature), the *remote* tmux config's shell snippets execute on the *local* machine: wrong results at best, local execution of remote-controlled command strings at worst. Also blocking with no timeout — one slow `#(cmd)` stalls every status-line capture. Recommendation: route `#()` evaluation through `session::tmux_command()`-style invocation (so it hops the SSH tunnel), or skip `#()` evaluation when `ssh_target()` is `Some`, and add a timeout. Confidence: high on behavior; medium on exploitability.

- **Med, bug — `executor::new_window` issues external mutating tmux commands.** `/tmuxy/packages/tmuxy-core/src/executor.rs:168-219` runs `split-window`, `break-pane`, `resize-window`, and `set-option` as external subprocesses. `docs/TMUX.md:48` states external tmux commands while a control-mode client is attached can crash tmux 3.3a/3.5a, and `resize-window` sent externally is at minimum ignored (TMUX.md:67). This function is reachable from the Tauri fallback path (`tmuxy-tauri-app/src/commands.rs:190`). Recommendation: delete it as part of the legacy-chain cleanup above, or route it through the monitor's control-mode connection. Confidence: high that the code contradicts the documented invariant.

- **Low, bug — `content_to_hash_string` has line-boundary collisions.** `/tmuxy/packages/tmuxy-core/src/lib.rs:129-139` joins all lines with `""`, so `["ab","c"]` and `["a","bc"]` hash identically. Its one consumer is polling-mode change detection (`tmuxy-server/src/sse.rs:1557`), so a content change that only moves a line break can be missed. Join with `"\n"` (or include line count). Confidence: high.

- **Low, bug — compound-command splitting ignores quoting.** `/tmuxy/packages/tmuxy-core/src/executor.rs:938-940`: the comment says "be careful with quoted strings" but `cmd.split("\\;")` splits unconditionally, so `send-keys -l 'a\;b'` is broken into two commands. Similarly `parts.contains(&"-t")` (:976) false-positives when `-t` is a literal argument, and `cmd.replace(&format!(" {}", window_arg), …)` (:992) replaces every occurrence of the substring, not the argument. Recommendation: tokenize with quote awareness (a tiny shell-words pass) or document the limitation at the API boundary. Confidence: high on the behavior, low on real-world impact.

- **Low, bug — snapshot fails wholesale if a pane dies mid-capture.** `/tmuxy/packages/tmuxy-core/src/lib.rs:739`: `capture_state_for_session` does `capture_pane_by_id(&info.id)?` inside the loop; a pane closed between `list-panes` and `capture-pane` aborts the entire snapshot (polling tick dropped, `GetInitialState` errors). Skip the vanished pane (`PaneNotFound`) instead. Confidence: high on behavior, low severity because polling is a fallback path.

### Contradictions between code, comments, and docs

- **Med — `docs/TMUX.md:130` vs `executor.rs:168`.** TMUX.md claims `executor::new_window()` "uses external `tmux new-window` without the `splitw ; breakp` workaround." The code has used `split-window` + `break-pane` (with an explanatory comment) — the doc describes a prior implementation. The *real* remaining issue is externality, not `neww` (see bug above). Update TMUX.md.

- **Med — "Alias for backwards compatibility" violates the repo's no-legacy rule.** `/tmuxy/packages/tmuxy-core/src/lib.rs:830-839`: `capture_window_state`/`capture_window_state_for_session` are pure aliases — and they are the only names callers use (`sse.rs:501,1547`, `commands.rs:45`); the "real" `capture_state`/`capture_state_for_session` (:721,:727) have no direct external callers. CLAUDE.md says "No legacy code… No backwards compatibility required." Collapse to one pair of names and update the three call sites.

- **Low — stale "Phase N" plan references throughout.** `ctx.rs:8-11` ("seed for Phase 4.9's broader migration… Phases 4.9b / 5.7"), `error.rs:20,26` ("Phase 5.7"), `error.rs:114-116` ("Phase 2.4 will replace that contract"), `tmux_service.rs:3` ("Phase 5.10"), `ctx_integration.rs` ("Phase 4.9b's port"). The plan these numbers refer to is not in the repo, and several describe futures that never happened (the fs port) or already happened (the tower stack). Rewrite as present-tense descriptions.

- **Low — `retry.rs:3-4` names operations that don't use retry.** "the retry-eligible operations (`capture_pane`, `list_panes`, `has_session`)" — none of those sync helpers go through `retry_with`; retries only apply to `Ctx::tmux_call` dispatch. Update the doc.

- **Low — popup comments overstate absence.** `/tmuxy/packages/tmuxy-core/src/lib.rs:387-388` ("Until then, popup state will always be None") and :824-826. The control-mode path *does* populate popups (`control_mode/state.rs:670 to_tmux_popup`, parser handles `%popup-close`); "always None" is only true of the polling path where the comment at :824 sits. Scope the claim to polling mode at :388.

- **Low — `debug_log.rs:1` says the log goes to `/tmp/tmuxy-debug.log`;** `log_path()` (:15-21) writes `~/tmuxy-debug.log` (with an explanatory comment). Fix the module header. Also note: the file grows without bound — no truncation or rotation.

- **Low — `constants.rs:66-69` doc on `LIST_WINDOWS_FIELDS`** claims "Trailing `'` is included" — the constant has no quotes at all; the sentence describes `LIST_WINDOWS_CMD`. Moot if the dead constant is deleted.

### Duplicate logic (DRY)

- **Med — three copies of `bind-key` line parsing in executor.rs.** `execute_prefix_binding` (:1104-1181), `get_prefix_bindings` (:1196-1277), and `get_root_bindings` (:1294-1339) each re-implement "parse `bind-key [-r] -T <table> KEY command…`" with slightly different fidelity: `execute_prefix_binding` doesn't handle the `-r` form at all (so repeat bindings like `bind -r h` can never be executed through it), and `get_root_bindings` computes the `-r` indices but then hardcodes `repeat: false` (:1330-1335). Extract one `parse_bindings(table) -> Vec<KeyBinding>` and derive all three from it.

- **Med — two parallel `list-panes` formats/parsers with different column orders.** Polling: `executor.rs:399-459` (`history_size` deliberately placed *before* the comma-soaking title fields, with a comment explaining why). Control mode: `constants.rs:89-102 LIST_PANES_CMD` places `#{T:pane-border-format}` mid-string and `#{history_size}` last — the exact ordering `executor.rs:394-398` warns is comma-unsafe — with a separate parser in `control_mode/state.rs`. Two grammars to keep in lockstep, and they embody contradictory comma-safety strategies. Recommendation: converge on one field order/constant, or at minimum cross-reference the two with comments; add unit tests for titles containing commas on both paths.

- **Med — hand-maintained `is_empty()` field checklists.** `PaneDelta::is_empty` (`lib.rs:533-559`, 25 fields), `WindowDelta::is_empty` (:587-599), `TmuxDelta::is_empty` (:693-704). Adding a delta field and forgetting the corresponding `is_empty` line silently suppresses emissions of that delta (undocumented invariant, no test guards it). Recommendation: a small macro that declares fields once and derives both the struct and `is_empty`, or at least a test that a fully-populated delta is non-empty via serde field-count.

- **Low — identical match arms in `add_session_target_if_needed`.** `/tmuxy/packages/tmuxy-core/src/executor.rs:998-1009`: the `"resize-window"`, `"send-keys" | "send-prefix"`, and `_` arms all produce `format!("{} -t {}", cmd, session_name)`. Collapse to the default arm.

### Refactoring opportunities

- **Med — `executor.rs` (1463 lines) mixes four concerns:** subprocess plumbing (:47-120), a status-line renderer with a full tmux-style→ANSI converter (:525-852), a command-rewriting/session-targeting mini-parser (:862-1101), and keybinding introspection (:1104-1359). The ANSI conversion block alone (`evaluate_shell_commands`, `visible_len`, `truncate_ansi`, `convert_tmux_style_to_ansi`, `tmux_style_to_ansi`, `color_to_ansi`) is ~330 self-contained lines. Split into `executor/status_line.rs`, `executor/targeting.rs`, `executor/bindings.rs`.

- **Med — `session.rs` (1056 lines) mixes eight concerns:** tmux binary discovery, socket/SSH resolution, config templating + three migration passes, theme management, bin-script materialization, launcher install, managed JSON state, and session lifecycle. The socket/SSH/argv block (:19-145) is the piece other code depends on most and deserves its own module.

- **Low — `lib.rs` mixes cell extraction/ANSI parsing (:144-249) with wire types (:255-717) and polling capture (:721-839).** Moving the delta types to `lib::state_types` (or similar) would make the crate root legible.

### Unclear code

- **Low — `TmuxPane.id` is not an ID.** `/tmuxy/packages/tmuxy-core/src/lib.rs:258` (`pub id: u32`) is populated from the *pane index* (`lib.rs:752 id: info.index`) while `tmux_id` holds the actual `%N`. The `id`/`tmux_id` pair invites bugs (and the polling hash at `sse.rs:1550` keys on `p.id`, the index). Rename to `index` (breaking the wire shape knowingly — the project allows it) or document loudly.

- **Low — magic numbers in the pane-line anchor scan.** `/tmuxy/packages/tmuxy-core/src/executor.rs:437-459`: `i in 14..`, `parts[i-3]`, `i+1`, `i+2` encode the column layout implicitly. Well-commented but untested and fragile against format changes; see the DRY item — a named-offset table or a shared parser fixes both.

- **Low — `source_config(_session_name)`** at `/tmuxy/packages/tmuxy-core/src/session.rs:917` accepts and ignores a session parameter (config is sourced server-globally). Drop the parameter.

- **Low — `bin/tmux_capture.rs` writes `snapshots/` relative to CWD** (:194, :259) with a hardcoded `MAX_SNAPSHOTS: 1000`; fine for the test harness that consumes it (`tests/helpers/TmuxTestSession.js`), but nothing documents that CWD contract at the binary's entry point.

### Tests

- **Med, low-value tests — tautologies that test the standard library.** `/tmuxy/packages/tmuxy-core/src/executor.rs:1366-1386`: `test_pane_info_parsing` and `test_capture_pane_parsing` split a literal string and assert the split — no crate code is exercised. `/tmuxy/packages/tmuxy-core/src/session.rs:1011-1022`: `parse_option_from_config_reads_set_g_lines` re-implements the parsing inside the test and asserts on its own string ops; its own comment admits the real parser lives in another crate. Delete all three.

- **Med, missing tests for tricky logic:** the comma-anchor scan in `get_all_panes_info` (executor.rs:437-459) — the most fragile parser in the file — has zero tests (no test feeds it a title containing commas); `convert_tmux_style_to_ansi`/`truncate_ansi`/`visible_len` (executor.rs:654-852) untested (e.g. `truncate_ansi` can split multi-codepoint graphemes; `visible_len` counts chars, not display width, so wide glyphs mis-pad the status line); `process_compound_command`/`add_session_target_if_needed` untested (only `validate_and_fix_target` has coverage). These are pure functions — cheap to test.

- **Low — `tests/ctx_integration.rs` never runs** (gated on the never-enabled `test-support` feature) and, when run manually, only verifies the test doubles against a consumer defined inside the test itself. Delete alongside the `Ctx.fs` cleanup, or wire the feature into a real test invocation.

### Overengineering

- **Low — `Ctx.fs` capability** (covered in dead code above) is the clearest case: trait + live impl + in-memory impl + tuple-returning `test_ctx` for a capability with zero production readers.

- **Low — per-call Tower stack construction.** `/tmuxy/packages/tmuxy-core/src/ctx.rs:88-104` builds the full `TraceLayer → RetryLayer → TimeoutLayer → TmuxService` stack on every `tmux_call`. Functionally fine (all layers are cheap clones), but it undercuts `tmux_service.rs`'s framing of "one composition point" — the composed service is never held anywhere; each call recomposes it. Either cache the built service on `Ctx` or acknowledge in the comment that composition is per-call by design. The three custom layers (~260 lines) exist mainly because tower's stock layers don't fit `TmuxError`; acceptable, but worth noting the same behavior is `retry_with(policy, || timeout(dur, run(args)))` in ~10 lines if the stack ever becomes a maintenance burden.
## Rust: tmuxy-server, tmuxy-tree, tmuxy-connect, tmuxy-wasm

### Actual bugs

**[HIGH] Stale `Last-Event-Id` silently drops all live SSE events after a broadcast reset** — `/tmuxy/packages/tmuxy-server/src/sse.rs:362`, `sse.rs:389`
`last_replayed` is initialized to the client's `Last-Event-Id` unconditionally, but the dedupe check `if seq <= last_replayed { continue; }` runs even when `buffer_can_serve` is false. Each `SessionBroadcast` starts its `seq` counter at 0 (`state.rs:53`), and a fresh broadcast is created whenever the grace-period cleanup removes the session (`sse.rs:1157`) or the server restarts. A browser `EventSource` auto-reconnects carrying its old id (e.g. 5000); the new broadcast emits seq 0, 1, 2, … which are all `<= 5000` and silently skipped — including the `StateUpdate::Full` snapshots the replay comment (`sse.rs:359-361`) claims will cover the gap. The client renders a frozen UI until 5000 events have been broadcast. Fix: only seed `last_replayed` from events actually replayed from the ring buffer; when `buffer_can_serve` is false, leave it at 0. This is easily reachable (laptop sleep > 2s grace period, then wake).

**[HIGH] `is_readonly_query` allowlist is bypassable via shell metacharacters** — `/tmuxy/packages/tmuxy-server/src/sse.rs:1013-1022` with `/tmuxy/packages/tmuxy-core/src/executor.rs:920-922`
The guard (new in the working tree) rejects `;` and `\n` "so a mutating command can't ride along a read", then hands the string to `executor::run_tmux_command_for_session`, which executes it via `Command::new("sh").args(["-c", format!("{} {}", tmux_bin, cmd)])`. `&&`, `||`, `|`, `$( )`, backticks, and `>` all pass the guard: `list-windows && tmux kill-window` runs an external mutating tmux command while control mode is attached (the exact crash class docs/TMUX.md exists to prevent), and `list-sessions $(anything)` is arbitrary shell. It isn't a privilege escalation (unauthenticated `/commands` already grants command execution by design), but it breaks the documented control-mode-safety invariant. Fix: execute without a shell (`Command::new(tmux_bin).args(shell_words::split(cmd)?)`) or reject all of `; \n & | $ \` > <` in the guard; extend the unit tests at `sse.rs:1619-1628` accordingly.

**[MED] Lagged SSE subscribers are never resynced, contradicting the stated design** — `/tmuxy/packages/tmuxy-server/src/sse.rs:399-401` vs `/tmuxy/packages/tmuxy-server/src/state.rs:20-22, 37-38`
`state.rs` says the ring buffer is "Sized to match the broadcast channel capacity so any lagged client can recover without a full state snapshot" and "a client that hit `RecvError::Lagged` can replay from `recent`". The actual `Lagged(n)` arm just logs a warning and continues — the `n` dropped messages are never replayed (and since ring capacity equals channel capacity, they're usually gone from the ring too). Recovery instead relies on the client's delta-`seq` gap detection triggering a full resync — which the client doesn't implement either (see adapter-layer finding 10). Either implement replay-on-lag in the recv loop or fix the two comments.

**[MED] Monitor task is not tracked in the shutdown `JoinSet`, contrary to its own comment** — `/tmuxy/packages/tmuxy-server/src/sse.rs:275-281`
The comment says "Track in the structured `JoinSet` so `shutdown_signal` drains it on Ctrl+C", but the code uses plain `tokio::spawn`. `shutdown_signal` (`server.rs:447-456`) drains only `state.join_set`, so graceful shutdown never joins the monitor task — it exits only via the cancellation-token checks inside its own loop, and nothing waits for the control-mode connection to detach cleanly. Either spawn via `state.spawn(...)` as the comment claims or rewrite the comment.

**[MED] Blocking subprocess calls inside async handlers** — `/tmuxy/packages/tmuxy-server/src/sse.rs:501, 517, 521, 591, 680-682, 1357-1361, 1383-1387, 1429-1433`
`capture_window_state_for_session`, `executor::capture_pane_with_history`, `executor::show_buffer`, `executor::send_mouse_event`, `executor::run_tmux_command_for_session`, and the repeated `has-session` `.output()` polls are all synchronous `std::process::Command` invocations executed directly on tokio worker threads. `GetInitialState` runs on every client connect and the `has-session` poll loop runs up to 50 iterations inside the monitor task. Under multi-client load this stalls the runtime. Route them through the existing async Tower stack (`AppState::tmux_call`, which `GetScrollbackCells` already uses) or `spawn_blocking`.

**[LOW] Silent fallbacks corrupt scrollback geometry** — `/tmuxy/packages/tmuxy-server/src/sse.rs:776, 792`
`width_output.trim().parse().unwrap_or(80)` and `unwrap_or(0)` swallow parse failures (e.g. tmux returning an error string) and produce cells wrapped at the wrong width instead of an error the client could retry. Return `Err` on parse failure like the surrounding calls do.

**[LOW] `RunTmuxCommand` source-file handling sleeps a magic 200ms and hopes** — `/tmuxy/packages/tmuxy-server/src/sse.rs:705-709`
The `RunCommand` is fire-and-forget into the monitor channel; the fixed 200ms sleep before `broadcast_keybindings` is a race — a slow `source-file` broadcasts stale keybindings. A correct fix would key off the command's control-mode response; at minimum name the constant and document the race.

**[LOW] Clients that omit `x-connection-id` all collide on conn_id 0** — `/tmuxy/packages/tmuxy-server/src/sse.rs:430-434`
`set_client_size` keyed by the defaulted `0` means two header-less clients overwrite each other's viewport entry, skewing the min-size computation. Reject size-affecting commands without the header, or derive the id server-side.

### Security

**[MED] Path traversal in the embedded-asset theme fallback** — `/tmuxy/packages/tmuxy-server/src/server.rs:270-275`
`serve_embedded` accepts any path matching `starts_with("themes/") && ends_with(".css")` and joins it onto `config_dir()`. Axum does not normalize dot segments, so `GET /themes/../../../../etc/foo.css` (sent with `--path-as-is`) reads any `.css`-suffixed file on disk. Yes, `/api/file` already reads arbitrary files by design — but that one is documented in SECURITY.md:81, while this route is an undocumented second door that also works when a future hardening pass restricts `/api/file`. Canonicalize and verify the resolved path stays under `config_dir()/themes`.

**[LOW] `/api/snapshot` executes a workspace-relative binary** — `/tmuxy/packages/tmuxy-server/src/server.rs:376-408` (`state.rs:371-443`)
The handler locates `target/{release,debug}/tmux-capture` under `find_workspace_root()` (which falls back to the server's cwd) and executes it. In a packaged install (brew/AppImage) the binary never exists so the endpoint always 500s; worse, if the server's cwd happens to contain an attacker-writable `package.json` with `"workspaces"` plus a `target/release/tmux-capture`, the server executes it. It's a debug endpoint — gate it behind dev mode or drop it from the production router.

### Dead code

**[HIGH] 24 of 32 `ClientCommand` variants are unreachable from any client** — `/tmuxy/packages/tmuxy-server/src/command.rs:96-195`, handlers `/tmuxy/packages/tmuxy-server/src/sse.rs:485-593, 594-655, 716-750, 829-833, 949-952`
The frontend funnels everything through `run_tmux_command` (key input via `KeyBatcher`, `keyBatching.ts:74-75`; pane/window ops via XState actions). Repo-wide grep (packages, bin, tests, docs, demo) finds zero senders for: `send_keys_to_tmux`, `process_key`, `initialize_session`, `get_scrollback_history`, `get_buffer`, `split_pane_horizontal`, `split_pane_vertical`, `new_window`, `select_pane`, `select_window`, `next_window`, `previous_window`, `kill_pane`, `select_pane_by_id`, `scroll_pane`, `send_mouse_event`, `execute_prefix_binding`, `kill_window`, `refresh_keybindings`, `resize_pane`, `resize_window`, `get_key_bindings`, `list_directory`, `ping`. (The tauri-app test hits go through Tauri's separate `#[tauri::command]` handlers, not this enum; `DemoAdapter.ts:272-278` handles a few names locally without ever reaching the server.) Live variants: `GetInitialState`, `SetClientSize`, `RunTmuxCommand`, `GetScrollbackCells`, `GetThemeSettings`, `SetTheme`, `GetThemesList`, `SetThemeMode`. Deleting the dead variants also kills the helper enums `Direction`/`ResizeDirection`/`ScrollDirection` (`command.rs:28-87`), the 50-line hardcoded prefix-binding table (`sse.rs:602-641` — which also ignores the user's real bindings), and ~8 of the tests in `command.rs:262-420`. Confidence: high (only caveat is out-of-tree consumers of the public HTTP API).

**[HIGH] `error.rs` / `ServerError` is entirely unused** — `/tmuxy/packages/tmuxy-server/src/error.rs:17-73`
Only reference outside the module is the re-export at `lib.rs:12`. The module's own header admits it "exists so the next refactor pass can introduce typed error responses" — a speculative placeholder that violates the project's "no legacy code / no 'not doing' comments" rule. Delete it.

**[HIGH] `/api/themes` route has zero consumers** — `/tmuxy/packages/tmuxy-server/src/state.rs:306, 465-497`
No frontend, test, script, or doc references `/api/themes`; the frontend uses the `get_themes_list` command instead. Delete the route and `themes_handler`.

**[HIGH] `/api/directory` route has zero consumers (and the docs claim otherwise)** — `/tmuxy/packages/tmuxy-server/src/state.rs:304, 351-364`; `/tmuxy/packages/tmuxy-server/src/sse.rs:1213-1271`
Nothing in the repo fetches `/api/directory` (widgets use only `/api/file`), and the `list_directory` `ClientCommand` is also dead, leaving `list_directory()` + `DirectoryEntry` with no live caller. docs/DATA-FLOW.md:311-313 and docs/SECURITY.md:21,81,197 say it's "used by widget panes" — outdated. Delete route, handler, `list_directory`, `DirectoryEntry`, and update both docs.

**[MED] Polling fallback monitor is unreachable, undocumented, and half-broken** — `/tmuxy/packages/tmuxy-server/src/sse.rs:1282-1291, 1540-1588`
`TMUXY_USE_POLLING` appears nowhere else in the repo (no docs, no scripts, no tests). If enabled, `start_monitoring_polling` never sets `monitor_command_tx`, so every mutating command fails with "No monitor connection available", it only polls the default window via `capture_window_state()` (ignoring the session argument), it ignores the shutdown token (infinite loop leaks on Ctrl+C), and never removes its session entry. Delete the polling path and the `start_monitoring` dispatcher.

**[MED] Unused `WasmTmux` exports** — `/tmuxy/packages/tmuxy-wasm/src/lib.rs:215-227`
`active_pane_id()`, `active_window_id()`, and `set_status_line()` have no callers: the only host, `V86Engine.ts`, declares `active_pane_id/active_window_id` in its core interface (lines 74-75) but never invokes them (lines 495-496 touch the snapshot *fields*, not the methods), and `set_status_line` isn't even declared. The `active_pane_id` doc comment ("hosts stamp this over the replayed state") describes behavior that doesn't exist. Confidence: medium (wasm-bindgen surface; other hosts conceivable but none in-repo).

### Duplicate / near-duplicate logic

**[MED] Theme-directory listing + display-name title-casing triplicated** — `/tmuxy/packages/tmuxy-server/src/sse.rs:897-930`, `/tmuxy/packages/tmuxy-server/src/state.rs:465-497`, `/tmuxy/packages/tmuxy-tauri-app/src/commands.rs:367-394`
Three byte-for-byte copies of read-dir → strip `.css` → sort → split-on-`-` → uppercase-first-letter → `{name, displayName}`. Deleting the dead `/api/themes` route removes one; hoist the remaining logic into `tmuxy_core::session` (which already owns `config_dir()`/`ensure_themes()`) so the server and Tauri share it.

**[MED] `KeyBindings` snapshot construction triplicated** — `/tmuxy/packages/tmuxy-server/src/sse.rs:125-129, 344-348, 962-966`
Identical `prefix_key`/`prefix_bindings`/`root_bindings` assembly with identical fallbacks in `on_initial_sync_complete`, the SSE greeting, and `broadcast_keybindings`. Extract `KeyBindings::current()`.

**[LOW] Monitor channel lookup duplicated instead of reusing `send_via_control_mode`** — `/tmuxy/packages/tmuxy-server/src/sse.rs:689-714, 726-741` vs `sse.rs:979-1000`
`RunTmuxCommand` and `ResizeWindow` re-implement the sessions-read-lock → `monitor_command_tx.clone()` → send dance that `send_via_control_mode` already encapsulates.

**[LOW] `build_response` duplicated** — `/tmuxy/packages/tmuxy-server/src/state.rs:158-164` vs `/tmuxy/packages/tmuxy-server/src/server.rs:259-265`
`serve_embedded` re-declares a local closure identical to the module-level helper one file over, including the same three-line comment.

**[LOW] `has-session` subprocess check repeated three times in one function** — `/tmuxy/packages/tmuxy-server/src/sse.rs:1357-1361, 1383-1387, 1429-1433`
Same 5-line block; extract `fn session_exists(name: &str) -> bool`.

### Refactoring opportunities

**[MED] `sse.rs` is five modules in one file** — `/tmuxy/packages/tmuxy-server/src/sse.rs` (1629 lines)
It contains: the `SseEmitter` (78-153), SSE stream handler with replay logic (215-412), a 475-line `handle_command` match (478-954), directory listing (1213-1271), and the 260-line monitor supervision loop (1277-1588). The supervision loop alone mixes four concerns (client-liveness polling, session recreation via a sibling CC connection, backoff, fatal-error broadcast). Suggested split: `emitter.rs`, `handlers.rs`, `monitor_supervisor.rs`; removing the dead command variants shrinks `handle_command` by more than half on its own.

**[LOW] `start_monitoring_control_mode` state flags are hard to reason about** — `/tmuxy/packages/tmuxy-server/src/sse.rs:1314-1321, 1474-1479`
`is_first_connect`, `ever_ran_successfully`, and `consecutive_failures` interact across a 200-line loop, with "ran > 2 seconds" (`sse.rs:1476`) as the undocumented-constant proxy for "successful run". A small enum-based state machine (FirstConnect / Reattaching / GivingUp) would make the recreate-vs-stop decisions at 1363-1375 and 1495-1502 explicit.

**[LOW] Dev proxy builds a new `reqwest::Client` per request and buffers whole bodies** — `/tmuxy/packages/tmuxy-server/src/dev.rs:61, 114`
Client-per-request discards connection pooling on every proxied Vite asset; `resp.bytes().await` buffers entire responses. Dev-only, but a `static OnceLock<Client>` and `Body::from_stream(resp.bytes_stream())` are one-liners.

### Contradictions between code, comments, and docs

**[MED] DATA-FLOW.md endpoint table is wrong in both directions** — `/tmuxy/docs/DATA-FLOW.md:301-313`
The table omits two live routes, `/api/images/{pane_id}/{image_id}` (used by `Terminal.tsx:34`) and `/api/themes` (dead, see above), while listing `/api/directory` as "used by widget panes" when nothing uses it. Update the table when the dead routes are removed.

**[LOW] `sse_event_type` comment describes an approach the code doesn't take** — `/tmuxy/packages/tmuxy-server/src/sse.rs:40-41`
"`serde_json::from_str` is faster than a full enum decode because we stop at the first matching field" — the function performs raw substring matching and never calls `from_str`. (The substring scan is actually safe only because serde emits the `event` tag first; worth stating that invariant instead.)

**[LOW] `commands_handler` comment says session is "(required)"** — `/tmuxy/packages/tmuxy-server/src/sse.rs:424-427`
The very next line defaults it to `DEFAULT_SESSION_NAME`.

**[LOW] Garbled crate doc sentence in tmuxy-tree** — `/tmuxy/packages/tmuxy-tree/src/lib.rs:8-11`
"This is what `tmuxy tree` launches standalone in any terminal pane." is a leftover splice from an earlier edit; rewrite the sentence.

**[LOW] `FeedOutput::responses` doc describes a 3-tuple for a 2-tuple** — `/tmuxy/packages/tmuxy-wasm/src/lib.rs:40-43`
"(success, first line of the output, truncated)" — the field is `Vec<(bool, String)>`; "truncated" is a property of the string (120 chars, `lib.rs:119`), not a third element. Reword.

### Unclear code / magic numbers

**[LOW] Unnamed timing constants scattered through the monitor lifecycle** — `/tmuxy/packages/tmuxy-server/src/sse.rs:707` (200ms source-file settle), `sse.rs:1141` (2s grace period), `sse.rs:1176-1180` (20×100ms shutdown poll), `sse.rs:1427-1428` (50×100ms create-session poll), `sse.rs:1476` (2s "successful run" heuristic), `/tmuxy/packages/tmuxy-server/src/server.rs:180` (2s dev-server warmup sleep). Only the grace period is explained. Name them as `const`s with one-line justifications.

**[LOW] Ring buffer is bounded in count but not bytes** — `/tmuxy/packages/tmuxy-server/src/state.rs:22, 60-71`
`EVENT_BUFFER_SIZE = 100` entries, but each entry can be a multi-megabyte `StateUpdate::Full` snapshot, and each payload is cloned into both the ring and the broadcast channel (up to ~200 retained copies per session). Not unbounded, but worth a doc note or a byte-budget eviction if large panes become common.

### Tests

**[MED] `is_readonly_query` tests miss the actual attack surface** — `/tmuxy/packages/tmuxy-server/src/sse.rs:1619-1628`
The smuggling tests cover `;` and `\n` but not `&&`, `|`, `$( )`, or backticks — precisely the metacharacters the `sh -c` execution path makes dangerous. Add them alongside the fix.

**[MED] The SSE replay/dedupe stream logic is untested** — `/tmuxy/packages/tmuxy-server/src/sse.rs:354-408`
`SessionBroadcast` has good unit tests (`state.rs:104-149`), but `buffer_can_serve`, the replay-then-live dedupe, and the stale-id case (the HIGH bug above) live in the untestable-as-written `async_stream` block. Extracting a pure `fn replay_plan(last_event_id, oldest_seq) -> (start_from, dedupe_floor)` would make the bug's fix regression-testable.

**[LOW] tmuxy-tree has no tests for its only nontrivial logic** — `/tmuxy/packages/tmuxy-tree/src/lib.rs:87-118, 189-209`
`fetch_rows` ordering and `App::refresh` cursor preservation (key-based reselection with clamping) are pure given parsed JSON, but `fetch_rows` couples parsing to the `tmuxy` subprocess. Split parse-from-JSON out of the exec and unit-test it.

**[LOW] Tests pinned to dead code** — `/tmuxy/packages/tmuxy-server/src/command.rs:333-404`
`directions_deserialize_lowercase`, `resize_direction_uppercase_letters`, `defaults_fill_missing_optional_fields`, `mouse_event_camel_case_eventtype`, `scrollback_defaults_match_legacy_handler` exercise wire shapes no client sends; remove with their variants.

### Overengineering

**[LOW] Speculative typed-error layer** — `/tmuxy/packages/tmuxy-server/src/error.rs` (whole file)
Covered under dead code: a full `thiserror` enum with `From` bridges and a test, built for a refactor that never landed.

**[LOW] `ClientCommand` decode retry machinery mostly serves dead variants** — `/tmuxy/packages/tmuxy-server/src/command.rs:212-231`
The strip-empty-`args`-and-retry dance exists to rescue unit variants, most of which are dead on the web path. After pruning variants, check whether `decode` can collapse to plain `serde_json::from_slice` (keeping `get_themes_list`/`get_theme_settings` in mind — they are unit variants and live, so the retry stays until they gain fields or the TS adapter stops sending `args: {}`).
## tmuxy-tauri-app

### Dead code

**[High severity, high confidence] 17 of 31 registered Tauri commands are never invoked by anything**
`/tmuxy/packages/tmuxy-tauri-app/src/commands.rs` — the following `#[tauri::command]` functions are registered in the `invoke_handler` list (`/tmuxy/packages/tmuxy-tauri-app/src/gui.rs:1134-1175`) but no string-name invocation exists anywhere in the repo (checked `packages/tmuxy-ui/src` raw `invoke()` calls, all `adapter.invoke`/`eff.invoke`/`decodingInvoke` literals, all `cmd:` fields in XState events, `tests/`, `bin/`): `send_keys_to_tmux` (commands.rs:14), `process_key` (:19), `initialize_session` (:64 — the string appears only in `DemoAdapter.ts:278`, a case nothing sends), `get_scrollback_history` (:69), `split_pane_vertical` (:79), `select_pane` (:94), `select_window` (:99), `next_window` (:104), `previous_window` (:109), `kill_pane` (:114), `kill_window` (:119), `select_pane_by_id` (:124), `scroll_pane` (:129), `send_mouse_event` (:134), `execute_prefix_binding` (:145), `resize_pane` (:401), `resize_window` (:410). The frontend routes all these operations through `run_tmux_command` today. Verified the only dynamic `cmd` values reaching adapters are `set_client_size`/`set_theme`/`set_theme_mode`. Recommendation: delete all 17 commands and their `generate_handler!` entries; that removes over a third of commands.rs.

**[Low severity, medium confidence] `TMUXY_CONNECT_SSH` global-env read has no writer**
`/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:375-383` reads `TMUXY_CONNECT_SSH` and clears it, but nothing in the repo sets it: `bin/tmuxy-cli:829-830` sets only `TMUXY_CONNECT_TO` and `TMUXY_CONNECT_SESSION`, and the SSH path goes through the `connect_server` Tauri command (which passes `ssh` directly from `servers.json`). Either wire `tmuxy connect` to publish it or remove the read.

**[Low severity, high confidence] Three commands are kept alive only by the CI webdriver test**
`split_pane_horizontal` (commands.rs:74), `new_window` (commands.rs:84), and `get_key_bindings` (commands.rs:415) are invoked solely by `tests/tauri/tauri-app.test.js:149,166,290,308` — no production frontend path uses them (the UI splits via `run_tmux_command` and reads keybindings via the `tmux-keybindings` event + `get_keybindings_snapshot`). Not dead, but worth knowing they exist purely as test fixtures; the test could exercise `run_tmux_command` instead (per docs/TESTS.md "use real user paths") and these three could then be deleted.

### Actual bugs

**[High severity] Native macOS menu mutations bypass the control-mode channel, the `new-window` rewrite, and the window-type tag**
`/tmuxy/packages/tmuxy-tauri-app/src/gui.rs:614-666` — `handle_menu_event` maps every menu item to a raw tmux command and executes it via `executor::run_tmux_command_for_session` (external `sh -c "tmux …"` subprocess). This violates the project-critical rule (CLAUDE.md: "All tmux commands must go through the control mode stdin connection") and, worse, `"tab-new" => Some("new-window")` (gui.rs:636) runs a literal external `new-window` — the exact command `commands::run_tmux_command` (commands.rs:167-192) painstakingly rewrites to `splitw ; breakp` through the CC channel. `executor::run_tmux_command_for_session` performs no such rewrite. A menu-created tab also misses the `set-option -w @tmuxy-window-type tab` tag and the viewport `resizew`, so it renders differently from a UI-created tab. The doc comment directly above (gui.rs:610-612, "Tmux commands are executed directly via the control mode connection") is false. Additionally these blocking subprocesses run on the menu-event (main) thread. Recommendation: give `handle_menu_event` access to `MonitorState` and route the tmux commands through `cmd_tx` (`MonitorCommand::RunCommand`), reusing the `new-window` rewrite; or simply eval `window.app?.send({type:'SEND_TMUX_COMMAND',…})` so menu items reuse the exact frontend path.

**[Medium severity] After fatal give-up, the monitor is unrecoverable but `connect_server` pretends to work**
`/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:286-294` and :304-312 — after `MAX_CONSECUTIVE_FAILURES` the `start_monitoring` loop `return`s permanently. But `request_reconnect` (monitor.rs:75-83) still happily writes `pending_reconnect` that no loop will ever read, and `commands::connect_server` (commands.rs:455-470) returns `Ok(())`. So after a transient tmux flap kills the monitor, the sidebar server picker silently no-ops until app relaunch; `poll_connect_requests` (monitor.rs:340-347) likewise skips forever because `cmd_tx` stays `None`. Recommendation: instead of returning, park the loop in a "fatal" state that still consumes `pending_reconnect` (a deliberate user reconnect is a legitimate revival path — the loop already resets counters for it at monitor.rs:226-227), or have `request_reconnect` report/restart when the loop is dead.

**[Medium severity] Runtime `std::env::set_var` in a multithreaded process, with a false SAFETY comment**
`/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:217-224` mutates `TMUX_SOCKET`/`TMUXY_SESSION`/`TMUXY_SSH` on every reconnect while Tauri command handlers on other runtime threads concurrently read them (`get_session()` at commands.rs:11, socket resolution inside every `executor::*` call). Beyond the logical race (a command issued mid-switch can target the old server with the new session or vice versa — the three vars are not set atomically), `setenv` alongside libc `getenv` in threaded processes is the classic UB pattern and `set_var` is `unsafe` in Rust 2024. Relatedly, `/tmuxy/packages/tmuxy-tauri-app/src/gui.rs:1031` claims "SAFETY: we're in setup before any threads/subprocesses are spawned" for the macOS PATH patch — false: `tauri::async_runtime::spawn(refresh_launcher)` was already spawned at gui.rs:1001-1003, and the tokio runtime's worker threads exist. Recommendation: move the PATH patch above the first spawn (trivial); longer term, replace env-var-as-app-state with an explicit `ConnectTarget` held in `MonitorState`/`Ctx` that executor calls read.

**[Medium severity] Blocking subprocess calls inside async Tauri commands**
`/tmuxy/packages/tmuxy-tauri-app/src/commands.rs` — several live `async fn` commands call synchronous `executor::*` helpers that spawn subprocesses and block: `get_initial_state` (:32 `resize_window`, :45 `capture_window_state_for_session` — the heaviest, many tmux calls), `set_client_size` (:61), `run_tmux_command`'s default path (:214), and `get_scrollback_cells` (:260 `capture_pane_range`). These run on Tauri's async runtime and stall other tasks (including the monitor's emit path) for the duration. Note the inconsistency inside `get_scrollback_cells` itself: pane width and history size go through the async `ctx.tmux_call` Tower stack (:230-258) but the capture goes through the blocking executor — the SSE server routes all three through the stack with a retry policy precisely because "capture-pane sometimes races a pending layout change" (`sse.rs:756-816`). Recommendation: route the capture through `ctx.tmux_call` (matching sse.rs, including `RetryPolicy::standard()`), and wrap remaining blocking executor calls in `spawn_blocking`.

**[Low severity] `tmuxy connect` env handshake has a set/read ordering race**
`bin/tmuxy-cli:829-830` sets `TMUXY_CONNECT_TO` *before* `TMUXY_CONNECT_SESSION` (two separate `run-shell` round-trips), while `poll_connect_requests` (`/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:349`) triggers on `TMUXY_CONNECT_TO`. If the 2-second poll fires between the two writes, the app reconnects to the right socket but the default session instead of the requested one. Fix: set `TMUXY_CONNECT_SESSION` (and future `_SSH`) first, and the `_TO` trigger last.

**[Low severity] Session name interpolated unquoted into command strings**
`/tmuxy/packages/tmuxy-tauri-app/src/commands.rs:172-181` — `format!("splitw -t {} ; breakp ; …", session)` breaks (or injects extra commands) for a session name containing whitespace or `;`. Session names now come from `servers.json` entries (commands.rs:459), not just the env default, so this is user-reachable via the connect form. Same pattern exists in `sse.rs:1041-1048` — fixing it in a shared helper (see duplication below) covers both.

**[Low severity] `show_status_message` escaping misses newlines**
`/tmuxy/packages/tmuxy-tauri-app/src/gui.rs:931-936` escapes `\` and `'` but not `\n`/`\r`; a multi-line error message (e.g. an fs error containing a path plus context) produces a JS syntax error and the banner silently never shows. The file already demonstrates the right approach — `serde_json::to_string` for theme names at gui.rs:752-753. Use it here.

### Contradictions between code, comments, docs

**[Medium severity] `MonitorState` doc overstates what routes through control mode**
`/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:47-54` says "The SSE server avoids this by routing every mutation through `MonitorCommand::RunCommand`; the Tauri app now does the same." In reality only `new-window` rewrites and multiline batches go through `cmd_tx` (commands.rs:167-212); every other mutation — including every keystroke batch the keyboard actor sends via `run_tmux_command` — falls through to the external subprocess at commands.rs:214. DATA-FLOW.md:107 documents the stdout-returning subprocess divergence deliberately, so the *code* may be intentional, but the comment is wrong. Fix the comment, or better, route non-output-needing commands through `cmd_tx` and keep the subprocess path only for the read-only enumeration commands (mirroring sse.rs's `is_readonly_query` allowlist).

**[Medium severity] `gui.rs` claims the shared `Ctx` is handed to the monitor; it isn't**
`/tmuxy/packages/tmuxy-tauri-app/src/gui.rs:968-971`: "Shared execution context — handed to TmuxMonitor on connect AND used by async Tauri commands." The managed `Ctx` (gui.rs:971) is only used by commands; `start_monitoring` builds its own separate `Ctx::live()` at monitor.rs:203 and hands *that* to `TmuxMonitor::connect` (monitor.rs:236). Functionally equivalent today (both are live), but it defeats the stated purpose ("participate in the same Ctx substitution that tests use") and the comment misleads. Pass the managed `Arc<Ctx>` into `start_monitoring`.

**[Medium severity] TMUX.md "Known gap" about the Tauri `new-window` path is stale**
`/tmuxy/docs/TMUX.md:130` claims the Tauri app "calls `executor::new_window()` which uses external `tmux new-window` without the `splitw ; breakp` workaround." Doubly outdated: `commands::run_tmux_command` rewrites `new-window` through the CC channel (commands.rs:167-192, external `executor::new_window` only as a pre-connection fallback), and `executor::new_window` itself now uses `split-window` + `break-pane` (`tmuxy-core/src/executor.rs:168-177`). The *actual* remaining gap is the native menu path (see bug above). Update the doc to describe the real gap.

### Duplicate logic

**[Medium severity] Five command handlers are near-verbatim copies of the SSE server's handlers**
`/tmuxy/packages/tmuxy-tauri-app/src/commands.rs` vs `/tmuxy/packages/tmuxy-server/src/sse.rs`: `get_scrollback_cells` (commands.rs:223-272 ≈ sse.rs:751-828), `get_theme_settings` (:275-300 ≈ sse.rs:834-863), `set_theme` (:302-342 ≈ sse.rs:864-896), `set_theme_mode` (:344-364 ≈ sse.rs:931+), `get_themes_list` (:366-399 ≈ sse.rs:897-930, byte-for-byte including the capitalization loop). Both sides only need a `tmux_call`-capable context — hoist these into `tmuxy-core` functions taking `&Ctx` and call them from both transports. Bonus: the copies have already drifted — sse.rs uses `tmux_options::THEME` constants and a retry policy on capture; commands.rs hardcodes `"@tmuxy-theme"` strings (:278, :289, :311, :324, :350) and has no retry.

**[Medium severity] The `new-window` rewrite string is duplicated across transports**
`/tmuxy/packages/tmuxy-tauri-app/src/commands.rs:172-181` and `/tmuxy/packages/tmuxy-server/src/sse.rs:1039-1049` build the identical `"splitw -t {} ; breakp ; resizew -x {} -y {} ; set-option -w @tmuxy-window-type tab"` string. If the tag name or rewrite shape changes, one side will be missed. Extract a `new_window_rewrite(session, size: Option<(u32,u32)>)` helper into tmuxy-core (and quote the session there — see bug above).

**[Low severity] Small in-crate duplications**
`get_session()` is copy-pasted in commands.rs:10-12 and monitor.rs:11-13, and inlined again at gui.rs:661 and gui.rs:1055-1056 — one helper (arguably in `tmuxy_core::session`) should own the `TMUXY_SESSION`-or-`"tmuxy"` default. The theme display-name capitalization exists three times: commands.rs:383-393, gui.rs:597-608 (`display_theme_name`), sse.rs:914-924. And `commands::get_themes_list` re-implements the directory scan that already exists as `tmuxy_core::session::list_themes()` (used correctly by gui.rs:423).

### Refactoring opportunities

**[Medium severity] gui.rs is 1234 lines of mixed concerns**
`/tmuxy/packages/tmuxy-tauri-app/src/gui.rs` mixes: tmux-config option parsing (:14-96), vibrancy/window effects (:99-194), menu construction (:200-608), menu event handling with embedded multi-line JS strings (:614-766), window creation (:775-822), debug-log clipboard plumbing (:825-938), and app bootstrap (:941-1178). Split into `menu.rs`, `effects.rs` (option parsing + vibrancy), and `logs.rs`; keep `gui.rs` as the builder/setup. Independently, `build_app_menu` (:200-592) is ~390 lines of copy-pasted `MenuItem::with_id` invocations — a `const` table of `(submenu, id, label, accel)` driven by a loop would cut it to ~80 lines and make the id↔label mapping reviewable at a glance against `handle_menu_event`'s match arms (which must stay in sync manually today).

### Missing tests / low-value tests

**[Low severity] Monitor reconnect/backoff logic has zero unit coverage**
`/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs` — the failure-classification logic (healthy-duration reset vs consecutive-failure counting, :274-295), `request_reconnect` semantics, and `read_global_env` parsing (:408-414) are all pure or nearly pure but untested; the crate's only tests are the six `parse_option_from_config` tests in gui.rs:1180-1234 (which are good). The give-up-after-fatal bug above would have been caught by a test asserting that a pending reconnect revives the loop. Extract the failure-counting decision into a small pure function and unit-test it; `read_global_env`'s line parsing is trivially testable with a fake `Ctx`.

### Unclear code / minor

**[Low severity] `apply_window_effects` JS injection races the page load**
`/tmuxy/packages/tmuxy-tauri-app/src/gui.rs:190-193` and :1110-1113 `window.eval(...)` during `setup`, while the webview is still navigating to `devUrl`/`frontendDist`; attributes set on the provisional document can be wiped by the real document load (works in the CI e2e today — tests/tauri/tauri-app.test.js:250 — but it's timing-dependent). `WebviewWindowBuilder::initialization_script()` in `create_main_window` (gui.rs:780) is the guaranteed mechanism: it runs before page scripts on every navigation.

**[Low severity] Minor nits**
`KeyBindingsState`'s manual `Default` impl (monitor.rs:41-45) is derivable. `show_status_message`'s `_is_error` parameter (gui.rs:929) is a "reserved for future" flag — the comment admits both paths render the same; drop it until styling exists (CLAUDE.md "no legacy code"). `build.rs`'s hand-rolled TOML section scanner (:44-65) would also match keys like `version-suffix` via `strip_prefix("version")`; harmless today, but a `rest.starts_with(|c| c=='=' || c.is_whitespace())` guard would make it exact — the no-serde design itself is deliberate and well justified by the comment at :67-70.
## tmuxy-ui: state machines

### Dead code

1. **[high, dead code]** `machines/index.ts` — entire barrel is unimported. `/tmuxy/packages/tmuxy-ui/src/machines/index.ts:1-13` re-exports `appMachine`, `dragMachine`, actors, types, and constants, but no file in the repo imports from the `machines` barrel (all consumers use deep paths like `./machines/AppContext`; `lib.ts` imports `./machines/AppContext` directly). Confidence: high. Delete the file.

2. **[high, dead code]** Unused constants in `/tmuxy/packages/tmuxy-ui/src/machines/constants.ts`: `PREFIX_TIMEOUT` (line 8 — keyboardActor defines its own `PREFIX_TIMEOUT_MS = 8000` at `actors/keyboardActor.ts:151`, and the values disagree: 2000 vs 8000), `COMMIT_TIMEOUT` (line 11 — no commit states exist anywhere), `PANE_ANIMATION_DURATION` / `PANE_ANIMATION_SPEED` / `PANE_ANIMATION_MIN_DURATION` / `PANE_ANIMATION_MAX_DURATION` / `calculateAnimationDuration` (lines 39-67), and `LIST_PANES_REFRESH_CMD` (lines 69-71). None are referenced outside this file. Confidence: high. Delete all; keep `DEFAULT_*`, `SIDEBAR_COLS`.

3. **[high, dead code]** `sendTmuxCommand` helper at `/tmuxy/packages/tmuxy-ui/src/machines/actors/tmuxActor.ts:321-326` — exported, never imported anywhere. Confidence: high.

4. **[high, dead code]** `RESET_TO_SERVER` event variant and handler at `/tmuxy/packages/tmuxy-ui/src/machines/actors/tmuxStoreActor.ts:47,156-159` — nothing in the codebase ever sends `RESET_TO_SERVER` to the store actor (grep across all of src including tests: only this file). Confidence: high. Remove the variant, or wire it where the docblock claims it's used ("initial-state full snapshot").

5. **[high, dead code]** `REFRESH_SESSIONS` at `/tmuxy/packages/tmuxy-ui/src/machines/actors/serversActor.ts:24,175-177` — the "nudge" event is never sent by anyone; the actor is pure interval polling. Confidence: high.

6. **[high, dead code]** `SYNC_PANES` at `/tmuxy/packages/tmuxy-ui/src/machines/drag/dragMachine.ts:142-145` and `machines/types.ts:314` — never sent. The appMachine even carries a comment explaining panes are deliberately NOT synced to the drag machine during drag (`appMachine.ts:964-968`). Confidence: high.

7. **[high, dead code]** `DRAG_ERROR` / `RESIZE_ERROR`: declared in `/tmuxy/packages/tmuxy-ui/src/machines/types.ts:353,360`, handled by `layout_dragError` / `layout_resizeError` (`app/actions/layout.ts:214-232`) via `states/layout.ts:35,32` — but neither `dragMachine.ts` nor `resizeMachine.ts` ever `sendParent`s them. Removing them also removes the two `as any` casts and the two `eslint-disable` comments (see finding 39). Confidence: high.

8. **[high, dead code]** `ANIMATION_DRAG_COMPLETE`: event type `/tmuxy/packages/tmuxy-ui/src/machines/types.ts:465`, empty handler `app/appMachine.ts:1272` — no sender exists (the "animation actor" it references is gone). Confidence: high.

9. **[medium, dead code]** `DRAG_COMPLETED` chain: `dragMachine.ts:38` (`notifyCompleted`) sends it, but the parent handler is the empty object at `app/appMachine.ts:1247` — the entire pathway is a no-op. Contrast with `RESIZE_COMPLETED`, which does real work. Confidence: high that it's a no-op; medium that removal is safe (it silences "unhandled event" only, which XState tolerates anyway).

10. **[high, dead code]** `SET_ANIMATION_ROOT`: event type `/tmuxy/packages/tmuxy-ui/src/machines/types.ts:460`, state entry `app/states/uiPrefs.ts:17`, and the literally-no-op action `uiPrefs_setAnimationRoot: assign(() => ({}))` at `app/actions/uiPrefs.ts:34`. Never dispatched from anywhere. Confidence: high.

11. **[medium, dead code]** `ENTER_COMMAND_MODE` (`types.ts:571-576`, `states/commandUi.ts:11`, `actions/commandUi.ts:23-32`) is sent only by its own unit test. Production command-mode entry happens via the inline `command-prompt` intercepts in `SEND_TMUX_COMMAND`/`SEND_COMMAND`, which assign `commandMode` directly instead of raising this event. Either route the intercepts through the event (removing duplication, see finding 18) or delete it. Confidence: medium (it is arguably external API).

12. **[high, dead code]** Empty placeholder exports: `uiPrefsSelectors`, `commandUiSelectors`, `copyModeSelectors`, `groupsAndFloatsSelectors`, `layoutSelectors` (`app/states/uiPrefs.ts:28`, `commandUi.ts:19`, `copyMode.ts:29`, `groupsAndFloats.ts:44`, `layout.ts:39` + re-exports in `states/index.ts:1-5`) — all `{}`, never read. Same for the five empty guard files under `/tmuxy/packages/tmuxy-ui/src/machines/app/guards/` plus `guards/index.ts` (imported by nothing; individual guard files are imported only by tests, which pass empty objects through). STATE-MANAGEMENT.md:234 documents guards as "currently empty placeholders", but placeholders for tasks #5-#10 that carry no code are scaffolding noise per the "no legacy code" rule. Confidence: high.

13. **[medium, dead code]** `groupsAndFloatsState` back-compat alias at `/tmuxy/packages/tmuxy-ui/src/machines/app/states/groupsAndFloats.ts:30-34` — used only by its own test file. The "index.ts re-export contract" it mentions serves no consumer. Confidence: high.

14. **[high, dead code + contradiction]** `tmuxStateSlices.ts` (`/tmuxy/packages/tmuxy-ui/src/machines/app/tmuxStateSlices.ts`, 174 lines) is production-dead: no non-test file calls any slice. Worse, the header (lines 16-20) claims "the slice + the inline handler are kept in lock-step by the unit tests" — nothing enforces that, and they have already diverged: `sliceCopyModeStates` (line 69) drops a pane's copy-mode state whenever `!pane.inMode`, while the live handler (`appMachine.ts:838-841`) drops only on an `inMode: true → false` *transition* and additionally honors the `copyModeExitTimes` cooldown. `detectRemovedPanes` and `sliceStatusLine` have no inline counterpart at all (statusLine flows through `snapshotFromModel`). Either finish the migration or delete the module and its test file. Confidence: high.

15. **[high, dead code]** Dead selectors in `/tmuxy/packages/tmuxy-ui/src/machines/selectors.ts` (only defined and/or re-exported in AppContext, zero component/test consumers): `selectFloatPanes` (:537), `selectFloatPaneState` (:541), `selectVisibleFloatPanes` (:551 — byte-identical body to `selectFloatPanes`), `selectFloatPaneIds` (:558), `selectDragOriginalPosition` (:139), `selectResizePixelDelta` (:226), `selectPanePixelDimensions` + `PanePixelDimensions` interface + uncached variant (:338-376), `selectActiveWindowId` (:261), `selectStatusLine` (:566), `selectResize` (:222), `selectIsConnected` (:269), `selectPaneGroups` (:382), `selectBaseFontSize` (:739), `getActiveIndexInGroup` (:402). String-name search done (these are plain functions, not XState string-referenced). Note STATE-MANAGEMENT.md:292 still advertises `selectPaneGroups`, `selectFloatPanes`, `selectIsConnected` as the selector API. Confidence: high.

16. **[high, dead code]** Context fields written but never read: `lastUpdateTime` (`types.ts:193`, written at `appMachine.ts:909`, no reader anywhere — the "(for activity tracking)" comment describes a consumer that doesn't exist) and `connectionId` (`types.ts:184`, written at `appMachine.ts:474`, no reader). Confidence: high. Remove fields, `FIELD_OWNERS` entries (`app/context.ts:67`, implicit), and the `CONNECTION_INFO` assign of `connectionId`.

17. **[medium, dead code]** `DRAG_CANCEL` / `RESIZE_CANCEL`: forwarders at `app/appMachine.ts:1242-1244,1264-1266`, machine transitions at `dragMachine.ts:266-269` / `resizeMachine.ts:247-250`, event types at `types.ts:431,443` — no component or test ever sends either; cancel actually happens via the Escape `KEY_PRESS` guard. Confidence: high that they're unsent; medium severity because they're plausible public API — but per "no legacy code" they should go until needed.

### Duplicate logic

18. **[high, duplication]** The `SEND_TMUX_COMMAND` and `SEND_COMMAND` handlers in `/tmuxy/packages/tmuxy-ui/src/machines/app/appMachine.ts` (lines 1022-1188 and 1315-1394) duplicate ~70 lines of intercept logic nearly verbatim: `stripActivePanePrefix`, copy-mode intercept, command-prompt intercept, display-message intercept (including the identical inline `setTimeout` → `CLEAR_STATUS_MESSAGE` block), `resolveTabNavTarget` routing, and `resolvePaneGroupNavTarget` routing. A third copy of the display-message and command-prompt intercepts lives in `commandUi_submitCommandMode` (`app/actions/commandUi.ts:55-80`). Extract a shared `interceptClientCommand(tail, context, enqueue): boolean` helper; the two handlers then differ only in final dispatch target (store vs tmux) and the few SEND_TMUX_COMMAND-only extras (format expansion, Ctrl+number remap, sidebar boundary, animation suppression).

19. **[medium, duplication]** Copy-mode exit is implemented five times: `copyMode_exit` (`app/actions/copyMode.ts:101-116`), `copyMode_yank` (:409-427), and twice inside `copyMode_key` — the `yank` and `exit` branches (:439-465) are byte-identical to each other — plus the `COPY_SELECTION` handler (`appMachine.ts:1494-1507`). Each repeats: stamp `copyModeExitTimes`, clone-and-delete `copyModeStates[paneId]`, send `send-keys -t <pane> -X cancel`. Extract one `exitCopyMode(paneId, context, enqueue)` helper; the `COPY_SELECTION` case could simply `enqueue.raise({ type: 'EXIT_COPY_MODE', paneId })`.

20. **[medium, duplication]** Copy-mode entry state construction exists twice: `copyMode_enter` (`app/actions/copyMode.ts:30-97`) and the tmux-initiated detection block inside `TMUX_MODEL_UPDATE` (`appMachine.ts:795-835`). Both build the same `CopyModeState` (pre-populated lines map, loadedRanges, cursor, scrollTop) with small differences (cursor-col clamping only in the action). The detect block could share a `buildInitialCopyModeState(pane)` helper.

21. **[medium, duplication]** `DragState` construction is duplicated between the parent `DRAG_START` handler (`appMachine.ts:1202-1221`) and the drag machine's own `DRAG_START` (`drag/dragMachine.ts:94-112`) — two identical 14-field literals built from the same event. The parent's copy is immediately superseded by the child's `DRAG_STATE_UPDATE` anyway; the parent assign exists only to make `context.drag` non-null one tick earlier. Let the child be the single constructor and drop the parent assign (or extract `makeInitialDragState(event, pane)`).

22. **[low, duplication]** `updateActivationOrder` (`appMachine.ts:107-110`) and `sliceActivationOrder` (`tmuxStateSlices.ts:101-121`) implement the same MRU-promote logic (the slice adds pruning). Resolves itself if finding 14 is settled.

23. **[low, duplication]** `groupsAndFloats_closeFloat` and `groupsAndFloats_closeTopFloat` (`app/actions/groupsAndFloats.ts:86-150`) share ~90% of their body (kill-pane, remove from floatPanes, refocus next, notify keyboard). `closeTopFloat` could resolve the top pane id and reuse the `CLOSE_FLOAT` path via `enqueue.raise`.

24. **[low, duplication]** `selectContainerSize`, `selectGridDimensions`, `selectCharSize` (`selectors.ts:293-332`) each pass the identical object-builder as both `inputSelector` and `resultSelector`, computing the same object twice per cache miss. A `createStableObjectSelector(inputSelector)` (result = input) would halve each.

### Bugs

25. **[high, bug]** `COPY_SELECTION` SIGINT targets the wrong pane. `/tmuxy/packages/tmuxy-ui/src/machines/app/appMachine.ts:1510-1515` sends `send-keys -t ${context.sessionName} C-c`, i.e. tmux's *server-side* active pane. This violates the project's own keystroke-routing contract (STATE-MANAGEMENT.md:184-197): with a focused float, Ctrl+C is delivered to the hidden session-active pane instead of the float; right after an optimistic tab/pane switch it lands in the previous pane. Every other key path in keyboardActor uses `focusedFloatPaneId ?? realPaneId(activePaneId) ?? sessionName`. Fix: resolve the target the same way here (the machine has both `focusedFloatPaneId` and `activePaneId` in context).

26. **[medium, bug + contradiction]** Typing during `reconnecting` is silently dropped, while two comments claim otherwise. The `reconnecting` state (`appMachine.ts:1530-1563`) handles only `TMUX_RECONNECTED`, `TMUX_DISCONNECTED`, `TMUX_STATE_UPDATE`, `TMUX_MODEL_UPDATE` — no `SEND_TMUX_COMMAND`, `KEY_PRESS`, `FOCUS_PANE`, etc. The keyboard actor stays enabled (only `APP_BLUR` disables it), so keystrokes reach the machine and vanish. Yet the comment at `appMachine.ts:383-384` says "The reconnecting state shares idle's handlers via the event spreads below", and the state docblock (:1526-1528) repeats "flow through the idle handlers via the shared event spreads". Either share idle's handler slice with reconnecting (extract the `idle.on` object and spread into both), or fix the comments and deliberately queue/reject input.

27. **[medium, bug]** — **Done:** the 2s fallback now captures the resize object being previewed at schedule time and only clears if `context.resize` is still that exact reference; a new resize replaces it with a different object, so the stale timer no longer nulls the live preview. Regression tests added (stale preview still cleared when idle; a newer resize started within the window survives). `layout_resizeCompleted`'s 2s fallback can clobber a *new* resize. `/tmuxy/packages/tmuxy-ui/src/machines/app/actions/layout.ts:204-211`: the `setTimeout` checks only `snap.context.resize` truthiness before sending `RESIZE_STATE_UPDATE { resize: null }`. If the user finishes resize A and starts resize B within 2 seconds, A's timer nulls B's live preview and flips `resizeActive` to false mid-drag (self-heals on the next mousemove, but produces a visible geometry blip and briefly re-enables transitions). Fix: capture the resize's identity (e.g. `paneId` + `lastSentAt`) and only clear if unchanged, or track a generation counter in context.

28. **[medium, perf bug]** — **Done:** `usePaneGroup` now passes a `paneGroupResultEqual` comparator to `useSelector` (compares `group` by ref — it's memoized on `paneGroups` — `activePaneId` by value, and `groupPanes` shallow element-wise). This eliminates the per-snapshot re-render, most impactfully for the common ungrouped case (`{ undefined, [], null }`) that every non-grouped `PaneHeader` hit on every delta. Faithful comparison → no missed renders. `usePaneGroup` (`/tmuxy/packages/tmuxy-ui/src/machines/AppContext.tsx:268-280`) returns a freshly allocated `{ group, groupPanes, activePaneId }` object from `useSelector` with no comparator, so every `PaneHeader` re-renders on **every** machine snapshot change — including 60fps content-only deltas during terminal output bursts. Pass a shallow-equality comparator (like `useAppSelectorShallow` does for arrays) or split into three selectors.

29. **[low, bug]** — **Done:** added the `g` flag to the `resolveWindowTarget` replace so every relative window target in a compound command is resolved, not just the first. `resolveWindowTarget` (`appMachine.ts:64-69`) uses `command.replace(/-t :\./, ...)` without the `g` flag, so a compound command containing two relative window targets (`selectw -t :. \; swapw -t :.`) only rewrites the first; the second still resolves against the drifting control-mode client window the function exists to avoid.

### Refactoring opportunities

30. **[high, oversized handler]** The `TMUX_MODEL_UPDATE` handler in `idle` (`/tmuxy/packages/tmuxy-ui/src/machines/app/appMachine.ts:607-1007`) is a single ~400-line `enqueueActions` doing at least eight jobs: anti-flash window-switch guard, structural-change detection, group build/prune, float build/prune/auto-focus, copy-mode enter/exit detection, dimension-change/animation suppression, MRU + lastActivePaneByWindow bookkeeping, and client-resize round-trip. This is exactly what `tmuxStateSlices.ts` was created to fix (Phase D′ task #8) and the migration stalled. Recommend actually finishing it: each block above is already a pure function of `(context, transformed, model)` and would slot into the slice pattern with its existing tests.

31. **[medium, refactoring]** `appMachine.ts` remains 1592 lines after the Option D′ decomposition because every interesting handler is declared "cross-cutting" and kept inline (`actions/layout.ts:15-23` lists six). The two biggest wins that don't require restructuring: extract the shared intercept pipeline (finding 18) into `app/helpers.ts`, and move the `TMUX_MODEL_UPDATE` sub-computations into `tmuxStateSlices.ts` (finding 30). Together that removes ~450 lines.

32. **[low, event consolidation]** `SWITCH_SESSION` vs `SESSION_SWITCH_REQUESTED` (`appMachine.ts:494-540`): the latter's entire body is re-sending the former via `self.send`. One event with an optional provenance field (or just have `tmuxActor` send `SWITCH_SESSION` directly) removes an event type, a handler, and a hop.

33. **[low, derived state]** `context.resizeActive` (`types.ts:180`) is almost always `context.resize !== null` — it diverges only during the post-RESIZE_END "hold preview" window. The pair of fields plus `lastSentDelta`/`lastSentAt` inside `ResizeState` mixing UI-preview state with wire-throttle state makes `layout_applyResizeState`/`layout_resizeCompleted` hard to follow. Consider a discriminated `resize: { phase: 'dragging' | 'awaiting-confirm', ... } | null`.

### Contradictions & outdated comments

34. **[medium, contradiction]** `snapshotFromModel` (`appMachine.ts:71-104`): the docblock says "The downstream TMUX_MODEL_UPDATE handler mutates the snapshot in place (mostly: temporary pinning during select-tab grace and group-switch freeze)... we shallow-clone the arrays once" — but the body comment (:91-93) says "Pass the derived arrays through by REFERENCE... spreading here would hand every subscriber a fresh identity", no clone happens, and the handler no longer mutates anything (the pinning/freeze moved into store ops, as other comments state). The docblock describes deleted behavior and directly contradicts the implementation two lines below it. Rewrite it; the function is now just a typed view-cast.

35. **[medium, doc contradiction]** `docs/STATE-MANAGEMENT.md:105` says "Five top-level states arranged as a connection lifecycle" then lists four (`connecting`, `idle`, `reconnecting`, `disconnected`), matching the four in code. The vanished fifth (`syncing`, now a derived flag per line 108) also survives in two appMachine comments: `appMachine.ts:373` ("live-only event handlers (idle, reconnecting, syncing)") and `:1571` ("Live-state handlers (idle, syncing, reconnecting)").

36. **[medium, contradiction]** `app/actions/layout.ts:9-13` header claims `DRAG_COMPLETED` and `ANIMATION_DRAG_COMPLETE` were "MIGRATED HERE" — neither appears in `states/layout.ts` nor in `layoutActions`; both are empty inline handlers in `appMachine.ts:1247,1272`. Line 18 of the same header claims TMUX_STATE_UPDATE is "sliced via helpers/tmuxStateSlices.ts" — the slices are unwired (finding 14; `tmuxStateSlices.ts:16-20` admits this).

37. **[low, contradiction]** `app/states/uiPrefs.ts:4-5` claims uiPrefs owns `suppressLayoutTransition`, but `FIELD_OWNERS` (`app/context.ts:84`) assigns it to `layout` (as does `actions/layout.ts:7`). The ESLint ownership rule follows FIELD_OWNERS, so the uiPrefs comment is wrong.

38. **[low, outdated comments]** (a) `types.ts:149` — the docstring on `AppMachineContext` reads "Pending state update stored during pane exit animation", describing a long-gone mechanism. (b) `types.ts:480-484` — `SelectPaneGroupTabEvent` doc says the handler "primes the group-switch dim override to suppress mid-swap nvim redraw flicker"; the dim override was replaced by the `GroupSwitch` store op (`appMachine.ts:1457-1464` explicitly says "replacing the dim-override freeze and its 500/550/750ms timers"). (c) `app/actions/copyMode.ts:7-9` — refers to "the parent machine's TMUX_STATE_UPDATE reconciliation (still in appMachine.ts pending the layout-state migration)"; that reconciliation is the `TMUX_MODEL_UPDATE` handler now. (d) `docs/STATE-MANAGEMENT.md:195` — says keyboardActor re-reads `activePaneId` "on this event or on `TMUX_STATE_UPDATE`"; the actor has no `TMUX_STATE_UPDATE` handler (`actors/keyboardActor.ts:597-615`), it's pushed `UPDATE_ACTIVE_PANE` on each model update. (e) `appMachine.ts:112` — "parseCommandPrompt, parseDisplayMessage moved to ./helpers.ts" is a change-log comment, not a description of code; delete.

### Project-rule violations

39. **[medium, rule violation]** New `eslint-disable` comments, which CLAUDE.md forbids adding: `/tmuxy/packages/tmuxy-ui/src/machines/app/actions/layout.ts:218,230` (`@typescript-eslint/no-explicit-any`, paired with `as any` casts to smuggle the parent-owned `error` field past the ownership rule), `app/states/__tests__/testHarness.ts:57,59`, and `AppContext.tsx:229`. For layout.ts specifically both offending actions are dead code (finding 7) — deleting them removes the violations. For the harness/AppContext, type the casts properly (`snapshot.matches` can take the machine's typed state value) instead of disabling the rule.

### Unclear code / magic numbers

40. **[low, magic numbers]** (a) `COPY_MODE_REENTRY_COOLDOWN = 2000` (`app/actions/copyMode.ts:24`) — no rationale for the 2s choice; the file header explains the mechanism but not the constant. (b) `Date.now() - ...timestamp >= STATUS_MESSAGE_DURATION - 100` (`app/actions/commandUi.ts:126`) — the 100ms tolerance is unexplained. (c) `Date.now() - context.lastLayoutCommandTime < 500` (`appMachine.ts:886-887`) — undocumented 500ms window. (d) `containerWidth - 100` / `containerHeight - 100` float margins (`app/helpers.ts:266,269`). (e) resize-neighbor gap `=== 1 || === 2` (`resize/resizeMachine.ts:82-83`) encodes "real tmux vs demo separator+header" as bare integers; a named constant per layout mode would survive the next chrome change. (f) the `2000`ms fallback in `layout_resizeCompleted` (`actions/layout.ts:210`).

### Tests

41. **[medium, missing tests]** No unit tests exist for the highest-complexity code in scope: the `TMUX_MODEL_UPDATE` handler (structural-change detection `appMachine.ts:652-689`, anti-flash guard :625-639, float auto-focus :754-780, the two-quiet-updates `enableAnimations` invariant :986-1005), the command-intercept pipeline (`resolveTabNavTarget` :124-164, `resolvePaneGroupNavTarget` :182-225, `stripActivePanePrefix` :247-250 — all module-private, hence untestable without extraction), `dragMachine` (swap-on-hover, optimistic pane shuffle, Escape cancel), `resizeMachine` (throttle + RESIZE_END flush), and `tmuxStoreActor` (structural-rollback → TMUX_ERROR surfacing, `tmuxStoreActor.ts:132-154`). Extracting the intercept helpers (finding 18) makes them trivially testable. The Escape-cancel and throttle behaviors of drag/resize are user-visible flows worth harness tests like the existing `keyboardActor.test.ts`.

42. **[low, low-value tests]** (a) `app/states/__tests__/layout.test.ts:239-244` "DRAG_STATE_UPDATE assigns the drag field directly" sends `drag: null` into a context whose drag is already `null` and asserts `null` — tautological; assert a real DragState round-trip. (b) `layout.test.ts:213-224` "SELECT_TAB is a no-op" asserts only that `activeWindowId` didn't change (it couldn't have — it's the target), without asserting no dispatch reached the store stub; use `extraActors` to capture sends. (c) `commandUi.test.ts:57-66` "COMMAND_MODE_SUBMIT with template substitutes %% with value" never observes the substituted command — it only checks `commandMode` cleared, so the substitution logic (`actions/commandUi.ts:49`) is untested despite the test name. (d) `app/__tests__/tmuxStateSlices.test.ts` exclusively tests production-dead code (finding 14). The actor tests (`tmuxActor.test.ts`, `keyboardActor.test.ts`, `serversActor.test.ts`) are good: real event flow, meaningful race coverage.

### Overengineering

43. **[low, overengineering]** The Option D′ scaffolding carries more ceremony than migrated behavior: five empty guard files + index (finding 12), five empty `*Selectors` exports (finding 12), a back-compat state alias with one test consumer (finding 13), and an unwired slice module (finding 14). Meanwhile the explicit XState-typed-action generics (`enqueueActions<Ctx, Evt, undefined, Evt, never, never, never, never, never>` repeated ~20× across `app/actions/*.ts`) add nine type parameters of noise per action; a single `type AppAction = ...` helper alias (or `setup()`-scoped action definitions) would remove hundreds of lines.
## tmuxy-ui: tmux adapter/store layer

### Actual bugs

**1. [high] Effect schema rejects `kitty` image placements — production decode failure**
`/tmuxy/packages/tmuxy-ui/src/tmux/effect/schemas.ts:55` — `ServerImagePlacement.protocol` is `Schema.Union(Literal('iterm2'), Literal('sixel'))`, but the Rust enum serializes three variants lowercase, including `"kitty"` (`/tmuxy/packages/tmuxy-core/src/control_mode/images.rs:26-31`), and the hand-written TS type agrees (`/tmuxy/packages/tmuxy-ui/src/tmux/types.ts:206`). This schema is used in production: `tmuxActor.ts:181` runs `decodingInvoke('get_initial_state', Schemas.ServerState, ...)`, so any pane holding a kitty image placement at connect time fails the decode with `ProtocolError` and the initial state never reaches the app — the exact drift bug the schemas were built to prevent, caused by the schema itself. Fix: add `'kitty'` to the literal union; ideally derive one source of truth (see finding on schema/type duplication below).

**2. [high] OSC 52 clipboard silently broken on desktop (Tauri)**
The Tauri backend emits `tmux-clipboard` with `{pane_id, text}` (`/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:136-140`, comment: "Forward … to the frontend so it can write the payload via the WebView's navigator.clipboard"), but `TauriAdapter` (`/tmuxy/packages/tmuxy-ui/src/tmux/adapters.ts`) neither listens for that event nor implements the optional `onClipboard` — so `tmuxActor.ts:153` treats the desktop app as "no clipboard plumbing" and terminal-app clipboard writes are dropped. `HttpAdapter` implements the full path (`HttpAdapter.ts:159-169, 427-430`). Add a `listen('tmux-clipboard', …)` + `onClipboard` to `TauriAdapter`, mirroring the log/fatal listeners.

**3. [med] Reconnect race can leak a second live `EventSource` (duplicate state streams)** — **Done:** `connect()` now dedupes via an in-flight `connectPromise` (a rival caller reuses it instead of opening a second stream) and defensively closes any lingering `eventSource` before opening a new one; `disconnect`/`switchSession` clear the marker so a forced teardown starts fresh. Regression tests added (`HttpAdapter.test.ts`: concurrent-connect dedupe + drop-race no-orphan).
`/tmuxy/packages/tmuxy-ui/src/tmux/HttpAdapter.ts:93-99` — `connect()` assigns `this.eventSource = new EventSource(...)` without closing an existing one, and only short-circuits when already *connected*. `invokeInternal` auto-connects whenever `!this.connected` (line 365-367). Sequence: connection drops → `attemptReconnect` schedules a timer (line 463) → any `invoke` (e.g. the sidebar `serversActor` poll) triggers `connect()` and opens ES#1 → the timer fires and `connect()` opens ES#2, overwriting the reference. ES#1 stays open with all listeners attached: duplicate `state-update` handling, and it can never be closed. Guard `connect()` with an in-flight-connection check (reuse the pending promise) and/or close any existing `eventSource` before creating a new one.

**4. [med] TauriAdapter batched keystrokes bypass the serial queue it defines**
`/tmuxy/packages/tmuxy-ui/src/tmux/adapters.ts:52-57` — the `KeyBatcher` send function calls `invoke(cmd, args)` directly, while non-batched `run_tmux_command` is serialized through `sendQueue` (lines 180, 200-217) precisely because "tauri::invoke spawns each command as its own task and … no cross-command ordering guarantee" (the adapter's own comment, lines 175-179). Batched keystroke sends can therefore reorder against each other and against queued mutating commands — the character-transposition bug HttpAdapter fixed by chaining *both* paths through one `sendQueue` (`HttpAdapter.ts:84, 347-358, 310`). Route the Tauri batcher's sends through `sendQueue` too.

**5. [med] `TmuxError` classification is unreachable on both real transports**
`/tmuxy/packages/tmuxy-ui/src/tmux/effect/AdapterError.ts:57-67` classifies rejections shaped `{error: string}` as `TmuxError` ("see packages/tmuxy-server/src/sse.rs command response shape"), but `HttpAdapter.invokeInternal` unwraps that shape and throws `new Error(data.error)` (`HttpAdapter.ts:383-389`) → `TransportError`; Tauri rejects with plain strings → `TransportError`. Additionally, web `run_tmux_command` is fire-and-forget and resolves `null` even when tmux later rejects (`sse.rs` control-mode path), so the store's rollback-on-`OpRejectedByTmux` branch (`TmuxStore.ts:243-245`) and the stderr surfacing in `tmuxStoreActor.ts:100-101` effectively only ever fire on the DemoAdapter. Either make `HttpAdapter` reject with the structured shape, or drop the pretense and document that tmux rejections surface via the SSE `error` event + stale sweep.

**6. [low] `HttpAdapter.connect()` hangs forever if the first SSE event is `fatal`** — **Done:** the `fatal` handler now `reject`s the pending `connect()` promise (no-op if `connection-info` already resolved it); with the new `connectPromise` cache this also prevents a wedged promise from being handed to every future caller (the `fatal` early-return in `connect()` refuses subsequent calls outright).
`HttpAdapter.ts:186-202` — the `fatal` handler closes the EventSource and nulls it, but the surrounding `connect()` promise (line 93) is neither resolved nor rejected, and `onerror` can no longer fire. Callers awaiting `connect()` (e.g. `invokeInternal`'s auto-connect at line 366) wedge silently. Reject the pending promise in the fatal handler.

**7. [low] `invokeInternal` parses the body before checking `response.ok`** — **Done:** `invokeInternal` now checks `response.ok` first and, on an error, tries for a structured `{error}` inside a `try/catch` so a non-JSON body falls back to `HTTP <status>` instead of throwing a JSON `SyntaxError`. Unit test added (502 with a non-JSON body → `HTTP 502`).
`HttpAdapter.ts:383-387` — `await response.json()` runs first; a non-JSON error response (reverse-proxy 502 page, `--password` 401 challenge) throws `SyntaxError: Unexpected token...` instead of the intended `HTTP <status>` error. Check `response.ok` (or wrap the parse) first.

**8. [low] Module-level `sessionOverride` is cross-instance global state and `fatal` never resets** — **Done:** `sessionOverride` is now a private instance field (with `getEffectiveSession` a method); `switchSession` clears `this.fatal` so recovering from a dead session by switching to a live one no longer needs a page reload. Unit test added (switchSession after a fatal connects the new session). (The `disconnect()`-doesn't-null-currentState note is harmless — `get_initial_state` resets it — and left as-is.)
`HttpAdapter.ts:35` — `sessionOverride` lives at module scope, shared by every `HttpAdapter` instance and never cleared on `disconnect()`; `switchSession` also leaves `this.fatal` set, so a session switch after a fatal is permanently rejected (line 88-89). Make the override an instance field. Also note `disconnect()` doesn't null `currentState` while `TauriAdapter.disconnect()` does (adapters.ts:164) — harmless today only because `get_initial_state` resets it.

**9. [low] Tauri hardcodes `defaultShell: 'bash'`**
`adapters.ts:129` — `notifyConnectionInfo(0, 'bash')`, whereas the web server derives it from `$SHELL` (`sse.rs` connection-info). The value feeds optimistic placeholder panes (`ops.ts` `makePlaceholderPane` `command` field), so desktop zsh/fish users see the wrong command on predicted panes.

### Contradictions with the protocol / docs

**10. [high] Delta `seq` is never checked — DATA-FLOW.md promises a resync that doesn't exist**
`docs/DATA-FLOW.md:141`: "If a delta arrives with a sequence gap, the client requests a full state resync." No client code reads `delta.seq`: `deltaProtocol.ts:87-163` (`applyDelta`) ignores it entirely, and the only references to `seq` in `src` are the type declaration (`types.ts:282`) and the schema (`schemas.ts:168`). A dropped/misordered delta silently diverges state until the next periodic full snapshot (SSE `Last-Event-Id` replay mitigates the web transport, but the Tauri event channel has no such buffer). Note also that `applyDelta` silently drops deltas for unknown pane ids (`deltaProtocol.ts:117-121`), compounding the silent-divergence mode. Either implement gap detection + a `get_initial_state` refetch, or fix the doc.

**11. [low] `schemas.ts` claims a cross-check that doesn't exist**
`/tmuxy/packages/tmuxy-ui/src/tmux/effect/schemas.ts:11-14`: "we cross-check that the schemas match them via a type assertion at the end of this file" — the file ends with plain type exports (lines 206-209); there is no assertion tying `ServerStateSchema` to `types.ts`'s `ServerState`. That missing assertion is exactly what would have caught the kitty drift (finding 1). Add e.g. `const _check: ServerState = {} as Schema.Schema.Type<typeof ServerState>` pairs, or delete the claim.

**12. [low] `compoundOps.createAndRenameWindow` cannot work over the web transport**
`/tmuxy/packages/tmuxy-ui/src/tmux/effect/compoundOps.ts:73-77` expects `new-window -P -F "#{window_id}"` to return the window id, but the web server rewrites `new-window` to `splitw ; breakp` and returns `null` fire-and-forget (`/tmuxy/packages/tmuxy-server/src/sse.rs:665-670`), so `windowId` is always empty → guaranteed `ProtocolError`. Test-only today (see finding 15), but it's a landmine if anyone wires it up.

### Dead code

**13. [high, high confidence] `VtEmulator.ts` — 356 lines, zero references**
`/tmuxy/packages/tmuxy-ui/src/tmux/VtEmulator.ts` — grepped all of `packages/tmuxy-ui/src` (including demo/v86), `packages/tmuxy-server/src`, `/tmuxy/tests`, and repo-wide `*.ts/*.tsx/*.js/*.mjs`: the only occurrence is its own definition. No test either. Delete.

**14. [high, high confidence] `tmux/index.ts` barrel and the `TmuxState` interface**
`/tmuxy/packages/tmuxy-ui/src/tmux/index.ts` has zero importers (every consumer imports concrete modules: `./types`, `./adapters`, `./HttpAdapter`, …). `TmuxState` (`types.ts:89-102`) is referenced only by this barrel and a stale doc-comment example (`effect/EffectTmuxAdapter.ts:11`). Delete both; fix the comment.

**15. [high, high confidence] Production-unused effect/ modules: `sseStream.ts`, `compoundOps.ts`, `decoders.ts`**
Grep across `src`, `tests`, and the server shows each is referenced only by its own tests and `effect/index.ts`:
- `effect/sseStream.ts` (145 lines) — the "Phase E2" foundation; `HttpAdapter.ts:44-53`'s migration note admits the conversion "wasn't landed".
- `effect/compoundOps.ts` (135 lines) — `createAndRenameWindow`/`withTemporaryWindow`/`CompoundOps` have no production callers, and the primitive is broken on the web transport (finding 12).
- `effect/decoders.ts` (49 lines) — `decodeStateUpdate`/`decodeServerState`/`decodeServerDelta`/`decodeKeyBindings` unused; production decoding goes through `EffectTmuxAdapter.decodingInvoke` directly.
Per the project's "no legacy code" rule, delete all three plus their ~600 lines of tests, and prune `schemas.ts` to the `ServerState` graph (the only schema used in production, `tmuxActor.ts:181` — `StateUpdate`, `ServerDelta`, `PaneDelta`, `WindowDelta`, `KeyBindings` schemas are then dead too).

**16. [high, high confidence] Unused store reducers and helpers**
- `/tmuxy/packages/tmuxy-ui/src/tmux/store/model.ts:46` `removeOp`, `:66` `markOpFailed`, `:71` `setOpStatus` — exported (also via `store/index.ts:39,45,46`), called nowhere, not even in tests.
- `/tmuxy/packages/tmuxy-ui/src/tmux/store/TmuxStore.ts:359-366` `_failureFromCause`, `_isExitFailure` — exported, zero callers (the underscore prefix suggests they were kept just to appease something; delete).
- `/tmuxy/packages/tmuxy-ui/src/tmux/store/types.ts:111` `IDENTITY_PATCH` — referenced only in comments.

**17. [med, high confidence] `OpTimedOut` is never constructed**
`/tmuxy/packages/tmuxy-ui/src/tmux/store/types.ts:201-205` — part of the `OpError` union and pattern-matched in `tmuxStoreActor.ts:102-103`, but nothing ever fails with it: timeouts are handled by the stale sweep inside `applyServerSnapshot` (`model.ts:175-183`), which produces rollback entries, not `OpError`s. Remove the class and the dead match arm.

**18. [med, high confidence] `TmuxStore.cancelOp` has no callers**
`TmuxStore.ts:122, 303-308` — the "resize drag-end" use case in the docstring was never wired; no production or test usage. Remove or wire it.

**19. [low] `store/index.ts` barrel is 90% unused surface**
`/tmuxy/packages/tmuxy-ui/src/tmux/store/index.ts` — only `makeTmuxStore` and types are consumed externally (`AppContext.tsx:38`, `appMachine.ts:37`, `tmuxStoreActor.ts:26-27`); tests import from concrete modules. `parseCommandToOp`, `toTmuxCommand`, `predict`, `reconcile`, `recomputeDerived`, `addPendingOp`, `rollbackOp`, `applyServerSnapshot`, `modelFromSnapshot`, `makePendingOp`, `generateOpId`, `serverStateToSnapshot`, `EMPTY_SNAPSHOT`, `EMPTY_MODEL`, `OP_STALE_TIMEOUT_MS` re-exports are all unused via the barrel. Trim to what's consumed.

### Overengineering (effect/ verdict)

**20. [med] effect/ is half real, half parallel abstraction**
Verified by grep: the *used* parts are `AdapterError`/`classifyAdapterError`, `toEffectAdapter` (`AppContext.tsx:39,150`; `tmuxActor.ts:4,51`; `TmuxStore.ts:21-22`), and `Schemas.ServerState` (one call site). The *unused* parts — `sseStream`, `compoundOps`, `decoders`, 4/5 of `schemas` (finding 15) — are a speculative "Phase E2" layer duplicating what `HttpAdapter` already does with `addEventListener` + `setTimeout` backoff. The Effect wrapper itself is a reasonable thin facade; the unlanded migration scaffolding is the overengineering. Recommendation: keep `AdapterError` + `EffectTmuxAdapter` + `ServerState` schema; delete the rest until a real migration commit needs them (they live in git history).

### Duplicate logic

**21. [med] TauriAdapter and HttpAdapter duplicate ~150 lines of listener/notify/queue machinery**
`adapters.ts:32-38, 222-291` vs `HttpAdapter.ts:64-71, 392-524` (seven identical `Set`+`on*`+`notify*` triplets), plus near-identical `invoke` logic: `get_initial_state` → capture `currentState`, KeyBatcher intercept/flush, serial-queue-for-`run_tmux_command` (`adapters.ts:182-220` vs `HttpAdapter.ts:266-319` — `enqueueSerialInvoke` is a verbatim copy of the Tauri inline version). Extract a shared `AdapterBase` (listener hub + serial queue + delta-state handling); that would also make finding 4 impossible by construction.

**22. [med] Three subtly different cell-line equality implementations run per tick**
`deltaProtocol.ts:169-200` `cellLinesEqual` (normalizes undefined booleans, manual RGB compare) vs `store/adapters.ts:30-55` `linesEqual` (strict boolean compare, `JSON.stringify` colors). Both execute on every state update — the adapter preserves line identity in `mergeSparseContent` (`deltaProtocol.ts:222`), then `preserveSnapshotIdentity` re-compares the same lines in the store (`TmuxStore.ts:277`). Unify on one comparator and one identity-preservation pass; the divergent semantics (e.g. `bold: false` vs `undefined`) mean the two layers can disagree about "changed".

**23. [low] HttpAdapter URL construction ×3 and the phantom port 3853**
`HttpAdapter.ts:95-97, 341-343, 370-372` — identical protocol/host/session URL building, each with the fallback `'localhost:3853'`, a port that appears nowhere else in the repo (server default is 9000). Extract a `commandsUrl()`/`eventsUrl()` helper and fix or document the fallback.

**24. [low] Idle reconcile duplicates `reconcile`'s body**
`TmuxStore.ts:170-186` re-implements apply-snapshot + log + notify inline instead of reusing the `reconcile` flow (modulo `preserveSnapshotIdentity`); also the `idleTimer` is never cleared on teardown (the store has no dispose API at all — worth adding when unifying).

### Refactoring / unclear code

**25. [med] `ops.ts` (1094 lines) — split by op family; type the `meta` bags**
`/tmuxy/packages/tmuxy-ui/src/tmux/store/ops.ts` holds 11 predict/reconcile pairs, each self-contained — natural seams for per-domain modules (focus, split/new-window, kill, zoom, group). More importantly, `meta` is `Record<string, unknown>` and every reconciler does unchecked casts (`meta.priorPaneIds as string[]` at :252, `meta.expectedSourcePos as {...}` at :487-498, `meta.before as {...}` at :1077, ~20 sites) — a typo in a meta key is invisible to the compiler. A per-op meta union (`SplitMeta | SwapMeta | …` keyed by `op._tag`) removes the whole class of bug.

**26. [low] `HttpAdapter.connect()` is a 145-line function nesting eight handlers**
`HttpAdapter.ts:86-232`. Extract the per-event handlers; that also makes the connect promise's resolve/reject lifecycle (findings 3 and 6) auditable.

**27. [low] Dual-shape payload handling obscures the wire contract**
Every SSE handler does `data.data ?? data` / `data.data?.x ?? data.x` (`HttpAdapter.ts:104, 114, 126, 140, 150, 162-164, 174, 189`), but the server always emits the serde `{event, data}` envelope (`sse.rs:166-188`). The unwrapped fallback is defensive dead weight that hides which shape is real — pick one and delete the fallback.

### Missing tests / low-value tests

**28. [med] `HttpAdapter.test.ts` tests a copy of the code, not the code**
`/tmuxy/packages/tmuxy-ui/src/tmux/__tests__/HttpAdapter.test.ts:34-53` re-implements `SerialQueue` ("we replicate the relevant queue shape") — if `enqueueSerialInvoke` regresses, this stays green. Meanwhile the genuinely tricky adapter paths have zero tests: reconnect backoff, the double-connect race (finding 3), fatal handling (finding 6), `switchSession`, rAF coalescing, non-OK response handling (finding 7). Test the real class with injected `EventSource`/`fetch` fakes (the sseStream test already demonstrates a FakeEventSource harness at `effect/__tests__/sseStream.test.ts`).

**29. [med] deltaProtocol edge cases untested**
`__tests__/deltaProtocol.test.ts` covers only content-preservation. Untested: pane/window *removal* (`null` delta entries), `new_panes`/`new_windows` insertion, delta-before-full (`handleStateUpdate` returning null, `deltaProtocol.ts:76-79`), delta for an unknown pane id (silently dropped, :117-121), `mergeSparseContent` growth beyond old length and line-identity preservation (:206-234), `cellLinesEqual` RGB/url branches, and `isSessionChanged` window-id-overlap detection (:18-23).

**30. [low] `AdapterError.test.ts:10-33` asserts library behavior**
Four tests construct a `Data.TaggedError` and read back `_tag`/fields — that's testing Effect, not tmuxy. The `classifyAdapterError` half of the file is fine; drop the ADT-construction half.

### Outdated comments

**31. [low]** `HttpAdapter.ts:44-53` — the "MIGRATION NOTE (Phase E2)" describes work that never landed; update or remove alongside finding 15. `effect/EffectTmuxAdapter.ts:11` — usage example references the dead `TmuxState` type (finding 14). `AdapterError.ts:57-59` — "tmux command failures come back as `{ error: ... }`" is untrue for the shipping adapters (finding 5).
## tmuxy-ui: components, hooks, app shell

### Actual bugs

- **[high] bug — `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneMouse.ts:79,103-120`** — **Done:** the unmount effect now also `clearInterval`s `autoScrollTimerRef` and removes the document `mouseup` listener (covers this + the `:211-216` listener-leak finding below). The auto-scroll interval is never cleared on unmount. The only unmount cleanup (`usePaneMouse.ts:84-87`) clears `pendingTimers`; `autoScrollTimerRef` is only cleared via `stopAutoScroll()` from mouse handlers. If the pane unmounts while drag-auto-scroll is running (e.g. the pane is killed by new tmux state mid-selection), the `setInterval` keeps dispatching `COPY_MODE_CURSOR_MOVE` every 50 ms forever. Add `stopAutoScroll()` to an unmount effect (and consider also removing the document `mouseup` listener there — see below).

- **[med] bug — `/tmuxy/packages/tmuxy-ui/src/components/menus/menuActions.ts:68-70` vs `/tmuxy/packages/tmuxy-ui/src/components/PaneContextMenu.tsx:33-38`** — **Done:** `executeMenuAction` gained an optional `closeTargetPaneId`; when the caller knows the target pane, `pane-close` now routes through group-aware `CLOSE_PANE` instead of raw `kill-pane`. The hamburger `AppMenu` and the Tauri native-menu bridge resolve that target with a shared `activeCloseTarget(activePaneId, focusedFloatPaneId)` helper (focused float, else real active pane, else undefined → falls back to server-active `kill-pane`, no regression). Unit tests added for both. "Close Pane" behaves differently depending on which menu you use. `PaneContextMenu` special-cases `pane-close` to the group-aware `CLOSE_PANE` event (routing through `pane-group-close.sh`), but the AppMenu hamburger renders the same `PaneMenuItems` and dispatches through `executeMenuAction`, which sends raw `kill-pane`. Closing a grouped pane from the hamburger menu bypasses the group logic the context menu was explicitly fixed to use. Move the `CLOSE_PANE` routing into `executeMenuAction` so every caller gets it.

- **[med] bug — `/tmuxy/packages/tmuxy-ui/src/components/widgets/TmuxyMarkdown.tsx:48-70`** — **Done (the race; rule-violation deferred):** both `.then`/`.catch` now early-return unless `lastFetchRef.current === fetchKey`, so an earlier request resolving after a newer `__SEQ__`/file fetch can't clobber the newer content (also neutralizes the post-unmount setState). Regression test added (render seq 1 → rerender seq 2 → resolve seq 2 then seq 1, assert newer content survives). The fetch-in-render pattern itself (the "side effects belong in the machine" rule violation) is left as the component's existing deliberate "no useEffect" design; a full fix would move it to an actor. `useFetchFile` fires a network fetch during render (the comment advertises "no useEffect") with no abort or stale-response check: if `__SEQ__` changes twice quickly, the responses can resolve out of order and the older file content clobbers the newer one; it also calls `setContent` after unmount. This is both a race and a project-rule violation (side effects belong in the machine/an actor). At minimum record the fetchKey with the promise and drop responses whose key no longer matches `lastFetchRef.current`.

- **[low] bug — `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneTouch.ts:57,67-72,182-207`** — **Done:** added a self-contained unmount effect that cancels `momentumRAFRef` (doesn't rely on the consumer wiring `cancelMomentum`). The momentum `requestAnimationFrame` loop is never cancelled on unmount. `cancelMomentum` is returned from the hook but `TerminalPane` never wires it to cleanup, so after a flick the loop keeps mutating `scrollRef.current.scrollTop` / calling `send` on an unmounted pane until velocity decays. Add an unmount effect calling `cancelMomentum()`.

- **[low] bug — `/tmuxy/packages/tmuxy-ui/src/components/FloatPane.tsx:109-119,155-165`** — **Done:** both float `Terminal` renders (drawer + centered) now pass `width={pane.width}`, `selectionPresent`, `selectionStartX/Y` from the pane model, so a tmux-side copy-mode selection inside a float shows its highlight and selection math uses the real width. The float's `Terminal` is not passed `width`, `selectionPresent`, `selectionStartX/Y`. A tmux-side copy-mode selection inside a float renders the copy cursor but never the selection highlight, and any selection math falls back to the default `width = 80`. Pass the same selection props `TerminalPane` passes (`TerminalPane.tsx:386-405`) or document the limitation.

- **[low] bug — `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneMouse.ts:211-216`** — **Done** (with the `:79` auto-scroll fix above; same unmount effect removes the document `mouseup` listener). The document-level `mouseup` listener added on mousedown is removed only when it fires or on the next mousedown. If the component unmounts mid-drag it survives until the next global mouseup and then calls `setSelectionStart` on an unmounted component. Listener leak; remove it in the same unmount cleanup as the auto-scroll timer.

- **[low] lint — `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneMouse.ts:350` and `/tmuxy/packages/tmuxy-ui/src/components/ScrollbackTerminal.tsx:111`** — **Done:** added `startAutoScroll` to the `handleMouseMove` deps; narrowed `computeScrollbackSelection` to a `Pick<CopyModeState, ...>` of the five fields it reads and destructured them so the `useMemo` deps are honest. Two live `react-hooks/exhaustive-deps` warnings (`handleMouseMove` missing `startAutoScroll`; the selection `useMemo` missing `copyState`). Both are coincidentally safe today because the missing deps' own inputs are present, but the invariants are implicit. Fix the dep arrays (for `ScrollbackTerminal`, destructure the five fields and depend on them directly).

### Dead code

- **[high, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/hooks/useAnimatedPane.ts:1-173`** — **Done earlier** (deleted in finding #10's migration cleanup). The entire 173-line spring-physics hook is unused: grep of all of `src` (incl. stories/tests) finds only its definition and the `hooks/index.ts:7` re-export. `PaneLayout`'s `AnimatedPaneWrapper` (`PaneLayout.tsx:652-678`) sets `translate3d` directly and relies on CSS transitions. Delete the hook and its export.

- **[high, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/hooks/usePrevious.ts:1-17`** — **Done:** deleted the file and its `hooks/index.ts` re-export. Unused everywhere except its `hooks/index.ts:8` re-export. Delete.

- **[high, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/styles.css:1220-1380` (`.file-picker*`, `.file-tree*`, `.is-dir`), `:659` (`.pane-drag-placeholder`), `:193` (`.pane-container.secondary-client`); `/tmuxy/packages/tmuxy-ui/src/components/StatusBar.css` (`.tab-placeholder`)** — **Done:** removed all four blocks (re-verified zero code refs for every selector; also dropped the now-orphaned `@keyframes pulse-placeholder` used only by `.tab-placeholder`). Kept live neighbors `.pane-drag-ghost` and the real `.pane-container` rules; brace-balanced and `vite build` clean. ~170 lines of CSS for a file-picker/file-tree feature that no longer exists, a drag placeholder (`PaneLayout` renders only `.pane-drag-ghost`), a `secondary-client` container mode, and a tab placeholder. Repo-wide grep finds zero references. Delete the blocks.

- **[high, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/components/menus/menuActions.ts:25-36,144-146`** — **Done:** removed the `pane-navigate-up/down/left/right` and `help-keybindings` cases (re-verified zero dispatch sites via grep). Action IDs `pane-navigate-up/down/left/right` and `help-keybindings` have no dispatch sites in the UI, and the Tauri native menu (`gui.rs`) maintains its own separate command map. Remove the dead cases.

- **[high, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/components/TerminalLine.tsx:219-221,234`** — **Done:** removed the `width` prop from `TerminalLineProps`, the `_width` destructure, `Terminal.tsx`'s `width={width}` pass, and the four `width: 80` story args (comparator already ignored it). The `width` prop is documented as "needed to pad selection highlight beyond line content", but it is bound to `_width` and never read (padding uses `selectionRange`/`line.length`), and the memo comparator ignores it. `Terminal.tsx:192` still threads it into every line. Remove the prop.

- **[high, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/components/terminalRendering.ts:159-175` (`detectPaneBg`)** — **Done:** deleted `detectPaneBg` (verified no importers; `detectLineBg`, its only callee, is still used by `renderLineToDOM`). Exported but never imported anywhere; only the private `detectLineBg` is used. Delete the export.

- **[med, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/constants/layout.ts:21 (`PANE_BORDER`), :18 (`PANE_HEADER_HEIGHT`)`** — **Done (PANE_BORDER):** deleted the unused `PANE_BORDER`. **Kept PANE_HEADER_HEIGHT** deliberately — `= CHAR_HEIGHT` documents the "header consumes exactly one terminal row" invariant, and its test asserts that invariant; marginal value in removing self-documentation. `PANE_BORDER` has zero usages. `PANE_HEADER_HEIGHT` is used only by its own test (`constants/__tests__/layout.test.ts:18`), which asserts it equals `CHAR_HEIGHT` — a constant asserting a constant. Delete `PANE_BORDER`; either use `PANE_HEADER_HEIGHT` somewhere real (e.g. FloatPane's magic 28 below) or drop it and its test.

- **[med, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/components/widgets/index.ts:4-13` + `/tmuxy/packages/tmuxy-ui/src/components/WidgetPane.tsx:118-121,139-148`** — `WidgetProps.lastLine`, `rawContent`, `writeStdin`, `width`, `height`, `widgetName` are computed and threaded by `WidgetPane` but neither registered widget reads anything except `lines`; only the story helpers construct them. Speculative API surface — trim `WidgetProps` to what widgets actually use.

- **[low, confidence: high] — `/tmuxy/packages/tmuxy-ui/src/components/TerminalLine.tsx:59-79` and `/tmuxy/packages/tmuxy-ui/src/components/terminalRendering.ts:42-61`** — **Done:** removed the `standard16` table and its `index < 16` guard from both `getAnsi256Color` copies (verified `cellColorToCss` is the sole caller and it returns the CSS-var path for `< 16` first). In both copies of `getAnsi256Color`, the 16-entry `standard16` hex table is unreachable: `cellColorToCss` returns the CSS-var path for `color < 16` before ever calling it. Dead branch ×2.

- **[med, confidence: medium] — `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneMouse.ts:76,90-92,123-136` + `/tmuxy/packages/tmuxy-ui/src/components/Terminal.tsx:141-146`** — The `selectionStart` React state committed on drag-end is passed into `Terminal`, but a mouse-drag selection only exists while client copy mode is active — and in that state `TerminalPane` renders `ScrollbackTerminal`, not `Terminal` (`TerminalPane.tsx:383-406`). The prop can matter only in a sub-tick window before `copyState` materializes. Likely removable plumbing, but verify the ENTER_COPY_MODE gap first.

### Duplicate logic

- **[high] — `/tmuxy/packages/tmuxy-ui/src/components/TerminalLine.tsx` vs `/tmuxy/packages/tmuxy-ui/src/components/terminalRendering.ts`** — Two parallel implementations of the entire line renderer: `STANDARD_16_VARS` (TerminalLine.tsx:22-39 / terminalRendering.ts:15-32), `cellColorToCss` + `getAnsi256Color` (44-95 / 34-73), style building incl. inverse-swap (177-207 / 79-116), style-equality grouping, auto-URL span grouping, and the selection-padding tail (434-445 / 280-291). Any rendering fix must be made twice, and they have already diverged (wide-char isolation and `${n}ch` width pinning exist only in the React path — meaning copy-mode scrollback does NOT get the anti-jitter/wide-char handling the live terminal has). Extract the color/style/grouping core into one module consumed by both, or port `ScrollbackTerminal` to `TerminalLine`.

- **[med] — `KeyLabel` defined three times: `/tmuxy/packages/tmuxy-ui/src/components/menus/AppMenu.tsx:35-39`, `menus/PaneMenuItems.tsx:9-13`, `TabContextMenu.tsx:23-27`** — Byte-identical component. Export it once from `menus/`.

- **[med] — Tab menu items duplicated: `/tmuxy/packages/tmuxy-ui/src/components/menus/AppMenu.tsx:77-106` vs `TabContextMenu.tsx:66-96`** — New/Next/Previous/Last/Rename/Close Tab with the same `KeyLabel` commands, maintained twice (they already drifted: the context menu's Rename does a select-window + 50 ms `setTimeout` first). Extract a `TabMenuItems` exactly like `PaneMenuItems`.

- **[med] — `/tmuxy/packages/tmuxy-ui/src/components/TerminalPane.tsx:258-266`** — `handleContextMenu` re-implements `pixelToCell` from `usePaneMouse.ts:144-161` line-for-line (the comment says so). Export the converter and reuse it.

- **[low] — selection colors hardcoded thrice: `TerminalLine.tsx:322`, `terminalRendering.ts:87,287`** — `#c0c0c0` + `var(--term-black)` inline; not theme-variable driven, so light/dark themes can't restyle the selection. Move to a `--term-selection-bg/fg` CSS variable used via the `terminal-selected` class.

### React+XState rule violations

- **[high] — timer-based "wait for the machine" sync in four places: `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneMouse.ts:307-318` (50 ms before `COPY_MODE_SELECTION_START`), `:489-495` and `:513-518` (100 ms before word/line select), `/tmuxy/packages/tmuxy-ui/src/components/TerminalPane.tsx:276-302` (100 ms + nested 50 ms before showing the selection menu), plus `TabContextMenu.tsx:53-62` (50 ms select-then-rename)** — Components schedule follow-up events on wall-clock timers hoping copy-mode state has initialized: the textbook "sync instead of derive" CLAUDE.md forbids, and inherently race-prone on slow scrollback fetches. Let `ENTER_COPY_MODE` carry an optional pending action (`selectWordAt`, `selectLineAt`, `startSelectionAt`, `openMenuAt`) that the machine applies when it creates the `CopyModeState` — this deletes all five timers and the `showMenuFromSnapshot` actor-poke (`TerminalPane.tsx:234-244`).

- **[med] — `/tmuxy/packages/tmuxy-ui/src/components/WidgetPane.tsx:37-113`** — A capture-phase `window` keydown listener inside the component implements keyboard policy (Ctrl-C → `SEND_KEYS 'C-c'`, vi scroll keys, swallowing events before the keyboard actor). Everywhere else key routing lives in `keyboardActor`; this parallel interception point is business logic that belongs in the machine. Route widget-active state through the keyboard actor and keep only the DOM `scrollTop` mutation here.

- **[med] — `/tmuxy/packages/tmuxy-ui/src/components/widgets/TmuxyMarkdown.tsx:48-70`** — Fetch-during-render (see bug above): data fetching for widget content belongs in an actor/machine service.

### Contradictions with docs / outdated comments

- **[med] — `/tmuxy/packages/tmuxy-ui/src/components/ScrollbackTerminal.tsx:6` and `terminalRendering.ts:4`** — Both headers claim the imperative DOM renderer is "same as / shared with Terminal (normal mode)". False: `Terminal.tsx` renders via React `TerminalLine`; only `ScrollbackTerminal` uses `renderLineToDOM`. Misleading for anyone deciding where to fix a rendering bug. Fix the comments or actually share the code.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/Cursor.tsx:19-21`** — The mode docs are backwards: it says inline mode is "used by ScrollbackTerminal", but `ScrollbackTerminal.tsx:210-220` passes `charWidth/charHeight` (overlay mode); the inline mode is what `TerminalLine` uses.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/TmuxStatusBar.tsx:9` vs `:219-223`** — Header lists center-mode 3 as "renders tmux status line with ANSI colors", while the code deliberately does not display the tmux status line content. Update the header.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/menus/keybindingLabel.ts:5,46`** — Doc comments promise labels like `"^B %"`; `formatPrefixKey` actually emits `"ctrl+b %"`. Update the comments.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/PaneLayout.tsx:1-7`** — Header says panes are dragged "with spring physics"; the spring hook is dead (above) and `AnimatedPaneWrapper` applies a plain `translate3d` with CSS transitions. Update alongside deleting `useAnimatedPane`.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/test/App.test.tsx:36-38`** — Mocks `../hooks/useKeyboardHandler`, a module that no longer exists. The mock is silently inert; delete it.

- **Docs verified consistent:** COPY-MODE.md's key-files table and entry/exit description match the implementation; RICH-RENDERING.md's story inventory, `window.__tmuxyImageSrc` stub, `/api/images/<pane>/<id>` URL shape, and `ImageAnchoredDuringScroll` all exist as described.

### Refactoring opportunities

- **[med] — `/tmuxy/packages/tmuxy-ui/src/components/PaneLayout.tsx` (680 lines)** — One component owns grid math/centering, global drag/resize listeners, AND the ~350-line enter/leave/shift lifecycle engine (`:174-525`: render-phase diffing, FLIP in `useLayoutEffect`, three timer maps, leaving-panes context). The lifecycle block is self-contained and would extract cleanly into a `usePaneLifecycle(currView, opts)` hook. The invariants (StrictMode-safe render mutations, DOM-order stability for leaving panes) are well-commented — keep those comments with the hook.

- **[med] — `/tmuxy/packages/tmuxy-ui/src/components/TerminalPane.tsx:386-405`** — `Terminal` takes 17 scalar props, 14 of which are fields copied off `pane`. Pass `pane` (or a typed slice) plus the few derived values; this also removes the FloatPane omission bug class where a call site forgets three of them.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/TerminalLine.tsx:284-448`** — `renderCells` is a 165-line closure with cursor-splitting, link wrapping, and selection padding braided through `flushGroup`. Extracting `flushGroup` and a `wrapWithLink` helper would make the grouping predicate (`:406-416`) auditable at a glance.

- **[low] — z-index management: `FloatPane.tsx:31,39,185` (hardcoded 1001/`1001 + index`), `Modal.tsx:30` (default 1000), `TerminalPane.tsx:427` (`zIndex: 5`), `PerfHud.tsx:51` (99999)** — The codebase has `--z-*` CSS variables (used in `PaneLayout.tsx:665`), but overlays use scattered literals. Centralize.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/Pane.tsx:50,56` + `TerminalPane.tsx:359`** — Both wrap the same subtree in `LogProfiler id={`Pane:${paneId}`}`, double-counting commits for terminal panes in the render log. Drop one.

### Unclear code / magic numbers

- **[med] — `/tmuxy/packages/tmuxy-ui/src/components/FloatPane.tsx:65`** — `headerHeight = 28` while every tiled pane header is exactly one char row (`PANE_HEADER_HEIGHT = CHAR_HEIGHT = 24`, an invariant layout.ts documents and tests). If the float header really is 28 px, the divergence deserves a comment; if not, this misplaces `terminalRows` by a fraction of a row. Use the shared constant or document why floats differ.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/WidgetPane.tsx:38`** — `LINE_HEIGHT = 24` for vi-scroll while the app measures `charHeight` dynamically; a font-size change makes j/k scroll by a wrong amount. Read char size from context.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/TerminalPane.tsx:327-331,411-429`** — Scroll-indicator geometry is inline arithmetic with unexplained literals (min thumb `5`%, `1200` ms flash, `4px`/`8px`/`7px`/`30px`, `0.6` opacity) plus direct DOM style mutation. Name the constants; consider a tiny `ScrollIndicator` component.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/SidebarTree.tsx:268`** — `paddingLeft: 8 + rowDepth(row) * 16` — base/step indents as bare numbers; name them.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneTouch.ts:155`** — Tap threshold `dx < 10 && dy < 10` is a bare literal (unlike the file's other tuned constants which are named and documented). Name it `TAP_MOVE_THRESHOLD_PX`.

### Overengineering

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/WindowTabs.tsx:37-41`** — The "dedup safety net" `Map` over window IDs patches symptoms of an upstream state bug in the render layer — the derive-don't-patch smell. If duplicate window IDs can reach context, that's a machine bug to fix (or assert on), not silently mask.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/ScrollbackTerminal.tsx:123-125`** — `visibleStart`/`visibleEnd` are pure aliases of `renderStart`/`renderEnd`, leaving two names for one concept in a function where off-by-one row math matters. Keep one pair.

- **[low] — `/tmuxy/packages/tmuxy-ui/src/components/PerfHud.tsx:22-33`** — The module-level `latencyTracker.subscribe` + rAF coalescer runs on import even when the HUD never mounts, slightly contradicting the "cost nothing in production" comment. Move the subscription inside the component's `useSyncExternalStore` subscribe.

### Missing tests / low-value tests

- **[med] missing — `/tmuxy/packages/tmuxy-ui/src/components/terminalRendering.ts`** — `renderLineToDOM` is the *only* renderer for copy-mode scrollback (grouping, inverse colors, OSC-8 vs auto links, selection padding, line-bg detection) and has zero unit tests, while its React twin gets coverage via `Terminal.test.tsx`. Its known behavioral gaps vs `TerminalLine` would have been caught by shared tests. Add unit tests, ideally parameterized over both renderers.

- **[med] missing — `/tmuxy/packages/tmuxy-ui/src/hooks/usePaneTouch.ts`** — No tests at all for the momentum/velocity/tap logic (its wheel sibling has a good suite in `hooks/__tests__/usePaneMouse.test.tsx`). The unmount-leak bug above would surface immediately under test.

- **[med] missing — `/tmuxy/packages/tmuxy-ui/src/components/TerminalPane.tsx:100-157`** — The three-ref scroll-sync protocol (`suppressScrollRef`, `lastDomScrollTopRef`, `prevCopyScrollTopRef`) encodes subtle DOM↔machine feedback rules with no direct test; regressions here manifest as the historical scroll-fighting bugs the comments describe.

- **[low] low-value — `/tmuxy/packages/tmuxy-ui/src/components/Cursor.stories.tsx:37-88`** — Every play function asserts a class name that is a one-line string-template echo of the prop, including `terminal-cursor-block` which has no CSS rule anywhere — a tautology that passes even if the cursor renders invisibly. Assert something user-visible (bounding rect, non-zero size) or drop the plays.

- **[low] low-value — `/tmuxy/packages/tmuxy-ui/src/components/FloatPane.stories.tsx:54-123`** — The drawer/backdrop stories assert only class presence and one inline style coordinate; none would fail if the float rendered zero-sized or clipped. Add a bounding-rect visibility check to `waitForFloat()` (the Sidebar stories at `Sidebar.stories.tsx:83-86` already model this well).

- **[low] low-value — `/tmuxy/packages/tmuxy-ui/src/test/App.test.tsx:57-109`** — Three of five tests are near-duplicates asserting the same `loading-display` testid under slightly different mock permutations of a fully-mocked App shell; combined with the dead `useKeyboardHandler` mock, the file mostly tests its own mocks. Collapse the loading variants into one and delete the stale mock.
## Demo engine, stories, demo site

### Actual bugs

**1. `exit` in a demo shell kills the wrong pane** — severity: high, category: bug — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/LifoShell.ts:317-321`
When a line equals `exit`, the shell calls `this.tmux?.killPane()` with **no argument**, which kills the *active* pane (`DemoTmux.ts:313-314`). But a `LifoShell` instance doesn't know its own pane id, and keys routed via `send-keys -t %N` (`DemoAdapter.ts:750-755` → `sendKeyToPane`) reach a shell that may not be the active pane — e.g. typing `exit` into a demo float (floats never become the active window, `DemoTmux.ts:886-887`) kills the active grid pane instead of the float. Recommendation: give `LifoShell` its pane id (or have `FakePane` own the exit handling) and call `killPane(ownId)`.

**2. `DemoTmux.setSize` clobbers float pane dimensions; `getState` reports wrong sizes for off-layout panes** — severity: medium, category: bug — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts:140-148, 186-191`
`setSize` applies layout to every non-`group` window — including `float` windows — so a float shell created at `floatW×floatH` (`createFloat`, lines 849-852) is resized to `totalWidth × totalHeight-1` on the next `set_client_size`. Independently, `getState` computes positions only for the active window, so float/group/sidebar panes fall through to `width: pos?.width ?? this.totalWidth` — a float pane's reported width is *always* the full surface, disagreeing with both its shell grid and its `float_width` metadata. Real tmux floats (hidden windows) keep their own size. Recommendation: skip `float` windows in `setSize` (resize their shells to `floatWidth/floatHeight` if set), and report `pane.shell` dimensions for panes not in the active layout.

**3. `LifoShell.writeText` CSI parsing swallows text after unrecognized sequences** — severity: medium, category: bug — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/LifoShell.ts:535-544`
The CSI scanner advances until it finds `m`, `J`, or `H`. Any other final byte — `\x1b[K` (erase-to-EOL), `\x1b[1A`, `\x1b[?25l`, all common in real command output — causes the scan to run past the sequence and consume ordinary text until the next *literal* `m`/`J`/`H` character anywhere in the string, silently dropping it. Recommendation: terminate the scan at the first byte in the CSI final range (`0x40–0x7E`) and ignore unknown finals. Also, `parseSGR` (lines 555-570) misreads 256-color sequences: `38;5;31` sets `fg=1` because the `31` is treated as a standalone code.

**4. `DemoAdapter.handleSendKeys` double-unescapes literals** — severity: low, category: bug — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoAdapter.ts:735-746`
`parseTmuxCommand` (lines 759-808) already strips quotes and resolves `\'` escapes, yet `handleSendKeys` then runs `.replace(/^'|'$/g, '')` and `.replace(/'\\'''/g, "'")` on the already-unescaped text. The second regex can never match post-parse text, and the first strips *genuine* leading/trailing single quotes — pasting `'quoted'` into a demo pane types `quoted`. Recommendation: delete both replaces (or unescape via `unescapeLiteralText` from `keyBatching.ts` before parsing, not after).

**5. `groupAdd` leaks a window id and can orphan the new pane** — severity: low, category: bug — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts:929-943`
When the target pane already belongs to a group, `allocWindowId()` and the free-index search still run, and the new pane's `windowId` is set to that never-created window. It's only corrected as a side effect of `swapGroupPanes`; if that early-returns (line 1122), the pane is permanently invisible. Recommendation: only allocate the window id in the "create group window" branch and assign `newPane.windowId` to the real group window.

**6. Multi-line `write-widget` broken on the runtime command path** — severity: low, category: bug — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoAdapter.ts:363-369 vs 380-387`
`executeCommand`'s widget regex deliberately supports multi-line content (`[\s\S]*`), but `handleTmuxCommand` splits every `run_tmux_command` payload on `\n` *first*, so a runtime `write-widget` with multi-line content is shredded into garbage commands. It only works today because the demo site passes multi-line widgets via `initCommands` (`TmuxyDemoInner.tsx:70-99`), which bypasses the split. Recommendation: detect `write-widget` before the newline split.

### Dead code

**7. Unused exports in story helper modules** — severity: low, category: dead code, confidence: high
- `expectPaintWithin`, `removesElement`, `changesAttribute` — `/tmuxy/packages/tmuxy-ui/src/stories/immediacy.ts:111-127, 145-162`
- `startGlitchRecorder` — `/tmuxy/packages/tmuxy-ui/src/stories/glitchRecorder.ts:377-383`
- `startContentMutationRecorder` — `/tmuxy/packages/tmuxy-ui/src/stories/contentMutation.ts:161-163`
Grepped the whole `tmuxy-ui` src and `tmuxy-demo`: only the definitions exist. Delete them (CLAUDE.md: "Remove dead code immediately").

**8. `V86Engine.updateStats` / `window.__v86UpdateStats` / `window.__osc` are write-only instrumentation** — severity: medium, category: dead code + outdated comment, confidence: high — `/tmuxy/packages/tmuxy-ui/src/tmux/v86/V86Engine.ts:310-312, 324-325, 471, 486-491`
No story, test, or app code reads `updateStats` or `__v86UpdateStats`; the comments at line 311 ("Test hook: lets stories assert bursts ride the delta wire path") and line 486 ("exercised and asserted (Throughput, DeltaProtocol stories)") are false — the Throughput stories assert rendered text and `DeltaProtocol.stories.tsx` constructs its *own* `WasmTmux`. The `__osc?.push(...)` at line 324-325 is a devtools-only debug hook (nothing ever creates `window.__osc`) that pays a `chunk.includes('1337')` scan on every serial flush. Delete all three.

**9. Unused `DemoTmux` methods** — severity: low, category: dead code, confidence: high — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts:1224-1226 (isLastPane), 890-896 (closeFloat)`
No callers anywhere. `isLastPane` looks like a leftover guard for the `exit` path that was never wired (related to bug 1). Delete or wire up.

**10. `CommandFn` type and unused `ShellContext` fields** — severity: low, category: dead code, confidence: high — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/commands/types.ts:3-10`
`CommandFn` has zero references. `ShellContext.cwd/env/history` are populated by `LifoShell.registerCustomCommands` (`LifoShell.ts:89-95`) but `tmuxy.ts` — the only command — reads only `ctx.tmux`. Trim `ShellContext` to `{ tmux }`.

**11. `LifoShell.lastExitCode` is write-only** — severity: low, category: dead code, confidence: high — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/LifoShell.ts:13, 358, 370`
Assigned in two places, never read (no `$?` support in the shell). Delete.

**12. `DemoTmux` sidebar window handling is unreachable** — severity: low, category: dead code + outdated comment, confidence: medium — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts:50, 166-172`
Nothing in the demo engine or any init-command path creates a `'sidebar'` (or `'float-backdrop'`) window; the sidebar is now a native React tree (the `SidebarToggle` story explicitly asserts `windowType === 'sidebar'` never appears, `App.stories.tsx:2084`). The comment "the hidden sidebar window (rendered in the left drawer)" describes the removed architecture. Keep the union in shared `tmux/types.ts` (server schema), but drop the `isSidebar` branch and comment here.

### Duplicate logic

**13. `DEFAULT_KEYBINDINGS` duplicated between the two demo adapters, already drifted** — severity: medium, category: duplication — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoAdapter.ts:16-97` and `/tmuxy/packages/tmuxy-ui/src/tmux/v86/V86TmuxAdapter.ts:39-103`
~90 lines of keybinding tables copy-pasted and independently edited: the v86 copy has `repeat: true` on H/J/K/L and bare `copy-mode`; the demo copy has `copy-mode -t demo` (a session target its own copy-mode handler can't parse — it only honours `%` targets, `DemoAdapter.ts:679-682`), a dead `r: source-file` binding, and window bindings 3-9 the v86 copy dropped. Extract one shared table (with an options diff if the engines genuinely need different commands).

**14. ~150 lines of verbatim helper duplication inside App.stories.tsx** — severity: medium, category: duplication — `/tmuxy/packages/tmuxy-ui/src/stories/App.stories.tsx`
- `numbersOf`/`breaks`/`fill`/`byTop`/`cmd`/`sleep` are copy-pasted between `SwapKeepsContentInCorrectLines` (4416-4477) and `DragSwapKeepsContentInCorrectLines` (4528-4585), with a third variant in `DragSwapShortContentStaysTopAnchored` (4666-4707).
- The mouse drag-swap gesture (mousedown → threshold moves → drop) is written out four times: `PaneDragSwap` (1007-1027), `SwapDragReconcile` (3472-3512), `DragSwapKeepsContentInCorrectLines` (4599-4620), `DragSwapShortContentStaysTopAnchored` (4718-4739).
- `stableSig` inside `SplitRejectedRollback` (3179-3187), the settle loops in `FontSizeShortcuts` (2489-2493) and `ZoomOptimisticTimeline` (3663-3667) all reimplement `settleGeometry` (3074-3081).
- The wheel-dispatch helper is duplicated in `CopyModeScrollAndYank` (1582-1589) and `WheelScrollEntersCopyMode` (1681-1689).
- `recordClassHistory` (3098-3108) is reimplemented inline in `SelectTabImmediate` (3338-3347).
- The `(window as unknown as { app: ... }).app.getSnapshot()` cast is repeated ~30 times with ad-hoc context shapes. One typed `appSnapshot()` helper would delete hundreds of lines.
- `PaneNavKeys` (617-618) creates two `userEvent.setup()` instances, using one and discarding the other.

**15. `writePrompt` / `promptLength` duplicate the cwd-display computation** — severity: low, category: duplication — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/LifoShell.ts:205-220 vs 463-469`
Same `~`-substitution logic twice; if the prompt format changes in one place, cursor math silently breaks. Extract a `promptText()` helper. Similarly `DemoTmux.splitPane`'s manual shell resize (293-298) is immediately overridden by `applyLayout` (301) with *different* header math — the manual block is redundant; delete it.

**16. tmuxy-demo init command lists duplicated** — severity: low, category: duplication — `/tmuxy/packages/tmuxy-demo/components/TmuxyDemoInner.tsx:70-121`
`INIT_COMMANDS_DESKTOP` and `INIT_COMMANDS_MOBILE` differ only in the tab-1 split and hard-coded pane numbering (`%3` vs `%2` etc.). A small builder taking `isMobile` would remove the drift risk (the hard-coded `%N` ids are also brittle against any change to `DemoTmux` id allocation).

### Contradictions & outdated code

**17. `Resilience/SteadyStreamNoBlink` doesn't test what it claims** — severity: medium, category: contradiction / low-value test — `/tmuxy/packages/tmuxy-ui/src/stories/Resilience.stories.tsx:14-16, 385-425`
The header and story docs claim it "simulates a Gemini-CLI-style clear+redraw burst (sequential `write-widget` updates)" and that "the demo loop keeps emitting state updates". The play function drives **no** redraws and `DemoTmux` has no emit loop (`setOnAsyncUpdate` is a callback, not a timer) — it samples static banner text 16 times over ~250ms while nothing changes. The assertion is vacuous. The real coverage lives in `SteadyStreamNoBlinkV86` (`App.stories.tsx:4277-4307`), which actually drives `\033[2J` redraws. Recommendation: either drive real clear+redraw traffic through the DemoAdapter (e.g. a `printf`-loop line via `send-keys`) or delete the mock story and its stale header bullet.

**18. Leftover debug logging in a CI-gating story** — severity: medium, category: outdated code — `/tmuxy/packages/tmuxy-ui/src/stories/RenderBudgets.stories.tsx:103-109`
`console.error('ISOLATION-DEBUG', ...)` fires on every `TypingIsolation` run. This story is part of the blocking `storybook-probe` job, and the probe collects console errors per story (`scripts/probe-stories.mjs:36-40`) — the noise pollutes failure reports. Remove it (it was clearly a debugging aid for the `sameObj` investigation).

**19. `eslint-disable` comment in the smoke test** — severity: low, category: contradiction with project rules — `/tmuxy/packages/tmuxy-ui/src/stories/__tests__/stories.smoke.test.tsx:25`
CLAUDE.md rule 5 forbids adding `eslint-disable` comments, yet the file carries `// eslint-disable-next-line @typescript-eslint/no-explicit-any`. `composeStories` accepts a generic; typing the modules as `Record<string, unknown>`-shaped story modules (or using `ReturnType<typeof composeStories>`) removes the need. Similarly `LifoShell.ts:268` ("Tab completion not supported in lifo mode") is a "not doing" comment CLAUDE.md rule 2 forbids.

**20. Demo `swap-pane -U/-D` and `select-pane -t :.+` operate over the global pane list** — severity: low, category: contradiction with tmux semantics — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoAdapter.ts:446-452, 547-558`
`state.panes` includes float and hidden group panes, so "next pane" / "swap with previous" can pick a pane in another window — which `swapPanes` then silently rejects (same-window check, `DemoTmux.ts:638`). Real tmux cycles/swaps within the current window. Filter by `active_window_id` first.

**21. Demo window/pane selection semantics drift** — severity: low, category: contradiction — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts:398-400, 404-418`
`selectWindow` always focuses the *first* pane by insertion order (real tmux remembers each window's active pane), and `nextWindow`/`previousWindow` return `false` when the current window is a float (real tmux cycles the last-active tab). Fine for a demo, but worth a one-line comment or a per-window `activePaneId` field, since stories assert focus behavior.

### Refactoring opportunities

**22. Split App.stories.tsx (4,895 lines) along its existing section headers** — severity: medium, category: refactoring — `/tmuxy/packages/tmuxy-ui/src/stories/App.stories.tsx`
The file already has §1-§16 dividers (lines 804, 1242, 1472, 1772, 2192, 2382, 2568, 2715, 2911, 3049, 3591, 3820, 4267, 4354). Natural split: `v86/helpers.ts` (pasteLine, activePaneId/appSnapshot, paneGroups/paneIds/paneRect, focusFirstPane, settleGeometry, waitForBurstTail, windows(), openAppMenu, drag/wheel gesture helpers, recordClassHistory — roughly lines 36-158, 639-647, 804-815, 1244-1251, 2570-2590, 3058-3108) plus per-domain story files (`App.basics`, `App.paneOps`, `App.tabs`, `App.copyMode`, `App.floatsGroups`, `App.widgets`, `App.input`, `App.optimistic`, `App.perf`) sharing one meta factory that keeps `title: 'Scenarios/Application'`, `tags: ['v86']`, `args: { shared: true }`. The §-numbering (1.1-5.6 with gaps like 1.8, 3.8, 4.1-4.2) references an external "gap plan" that isn't in the repo — renumber or drop the numbers when splitting.

**23. Prune overlapping v86 stories** — severity: low, category: refactoring — same file
Several stories are strict subsets of later, stronger ones: `Splits` (271-283, count-only) ⊂ `KeyboardSplit` (295-311) ⊂ `SplitOptimisticTimeline` (3118-3158); `TabCreateViaPlusButton` (1286-1303) ⊂ `TabCreateOptimisticTimeline` (3230-3258); `SwapPanes`/`PaneDragSwap` ⊂ `SwapDragReconcile`. Since only three stories gate CI (`lint-and-tests.yml:376-379`) and the full sweep is `continue-on-error`, each redundant story mostly adds wall-clock (a snapshot restore each) and maintenance surface. Keep the strongest variant per interaction path (keyboard vs mouse paths are legitimately distinct; count-only twins are not).

**24. Oversized `DemoTmux.groupAdd` / `selectPaneByDirection`** — severity: low, category: refactoring — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts:903-971, 464-536`
`groupAdd` interleaves pane allocation, group lookup, window creation, and the swap; fixing bug 5 is a good moment to split it into `ensureGroupWindow()` + `addMember()`. `selectPaneByDirection`'s switch duplicates the adjacent/overlaps/dist computation four times; a direction-vector table would halve it.

### Unclear code / magic numbers

**25. Float/group window index `1000`** — severity: low, category: unclear — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/DemoTmux.ts:866, 932`
The `index = 1000` starting point for hidden windows is an undocumented convention (presumably mirroring the real CLI's hidden-window indexing). One comment, or a named constant `HIDDEN_WINDOW_INDEX_BASE`, would prevent someone "fixing" it to 0.

**26. `exitTail` window of 8 bytes** — severity: low, category: unclear — `/tmuxy/packages/tmuxy-ui/src/tmux/v86/V86Engine.ts:339`
`this.exitTail = window_.slice(-8)` — the 8 is load-bearing (must cover `\n%exit` minus one byte) but unexplained; a named constant derived from the marker length would document the invariant. The `warm ? 400 : 1500` / `500 : 1000` / `8000 : 6000` settle waits in `start()` (438-457) are commented but would benefit from named constants since three call sites must stay consistent.

### Tests: missing & low-value

**27. The trickiest demo-engine logic has zero unit tests** — severity: medium, category: missing tests — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/__tests__/`
Coverage exists only for basic split/kill/window ops. Untested pure logic where the verified bugs above live: `DemoAdapter.parseTmuxCommand` + `handleSendKeys` quoting (bug 4), `LifoShell` input editing/history/wrap/ANSI (bugs 1, 3), `DemoTmux` named layouts, `adjustRatio` recursion, zoom save/restore, group add/switch/close bookkeeping (bug 5), `joinPane`, float sizing (bug 2), and the 557-line `commands/tmuxy.ts`. Also `V86Engine`'s `onResponse` marker-tracking state machine and `scanCaptures` line reassembly (lines 220-248, 505-527) are pure, browser-independent functions guarding against a documented desync bug ("the misattributed-outcome bug", line 121-124) — ideal unit-test targets, currently only exercised indirectly by non-blocking v86 stories.

**28. Low-value/tautological tests** — severity: low, category: low-value tests
- `/tmuxy/packages/tmuxy-ui/src/tmux/demo/__tests__/DemoTmux.test.ts:226-263` — the "state serialization" block asserts `toHaveProperty` on a TypeScript-typed return value; the compiler already guarantees this.
- `/tmuxy/packages/tmuxy-ui/src/stories/__tests__/stories.smoke.test.tsx:118-131` — the provider tier asserts `typeof Story === 'function'`, which `composeStories` guarantees unconditionally; it only verifies the module *imports*, which the pure tier's imports already do. The pure tier (mount-and-render, lines 104-116) does add value as a cheap jsdom regression net; keep it, collapse the provider tier to a bare import-side-effect test or delete it.

### Overengineering assessment

**29. v86 layer: justified core, oversized surface** — severity: low, category: overengineering — `/tmuxy/packages/tmuxy-ui/src/tmux/v86/`, `/tmuxy/packages/tmuxy-ui/src/stories/App.stories.tsx`
The v86 engine's sole consumer is the story suite (the public demo site uses `DemoAdapter`, not v86 — `TmuxyDemoInner.tsx:125`). It delivers something the Jest E2E suite can't: the *client-side* deployment path (WASM core parsing, serial pacing, marker-tracked command correlation) against real tmux 3.7a. That's worth keeping. But the cost profile is visible in the code itself — retry-attach loops, UART-drop workarounds, tracker-desync postmortems, shared-engine sink races (`V86Engine.ts:161-168, 250-258, 441-449`; `V86TmuxAdapter.ts:203-210`) — and only 3 of ~70 stories block CI while the rest are `continue-on-error` (`lint-and-tests.yml:376-386`). Many of those 70 re-verify flows the blocking Jest E2E suite already covers against a real server. Recommendation: keep the engine and the client-side-unique stories (throughput/serial integrity, WASM image protocols, optimistic timelines, session switching, fatal `%exit`); fold the count-only duplicates (finding 23).

**30. `LifoShell` is appropriately sized, with one questionable cost** — severity: low, category: overengineering — `/tmuxy/packages/tmuxy-ui/src/tmux/demo/LifoShell.ts:49-86`
The shell itself is not over-general — every feature (history, C-w/C-u/C-k, ANSI, scrollback) is exercised by the public demo. The one real cost: each pane constructs its **own** `Sandbox.create` with the full seeded filesystem (constructor, line 49), so N panes = N sandboxes, and files created in one pane are invisible in another — a silent contradiction of real tmux (shared FS) and avoidable memory. Recommendation: share one `Sandbox` per `DemoTmux` instance (per-pane cwd is already tracked shell-side and passed to `commands.run`).

**31. tmuxy-demo package is lean; one dead script** — severity: low, category: dead code, confidence: medium — `/tmuxy/packages/tmuxy-demo/package.json:9`
The `"start": "next start"` script is incompatible with `output: 'export'` (`next.config.ts:9`) — `next start` refuses to run for static-export apps. It can never have worked; remove it. Everything else in the package (MacWindow, analytics union type, webpack externals for `@lifo-sh/core`) is used and proportionate.
## Tests: E2E suites, helpers, QA scripts

### 1. Violations of docs/TESTS.md principles

**[HIGH] `skipIfNotReady()` makes every E2E test vacuously green when the environment is broken** — `tests/helpers/test-setup.js:241-246`, used at the top of every test (e.g. `tests/1-input-interaction.test.js:76`). If the server or browser fails to come up, `beforeAll` swallows the error, `skipIfNotReady()` returns true, and every test returns early and *passes*. This is functionally a suite-wide `it.skip` that CI reports as green, directly contradicting TESTS.md's "No Skipped Tests" section and the "false confidence is worse than no test" principle. Recommendation: `throw` in `beforeAll` when the server/browser is unavailable (or `expect(ctx.isReady()).toBe(true)` at test start) so infrastructure failure is a red run, not a silent pass.

**[HIGH] Arrow-up history test cannot fail** — `tests/1-input-interaction.test.js:251-260`. The assertion `expect(text.split('history_test_123').length).toBeGreaterThan(2)` requires only 2 occurrences of the marker. But `runCommand(page, 'echo history_test_123', ...)` at line 251 already leaves 2 occurrences in the DOM (the echoed command line on the prompt plus its output) before any ArrowUp is pressed. The test passes even if history recall is completely broken. Recommendation: count occurrences before and after the recall and assert the count increased by ≥2, or assert `>4`.

**[MED] "Close" step of Window Lifecycle uses `_exec('kill-window ...')`, not a user path** — `tests/2-layout-navigation.test.js:236-243`. The test name promises "…rename → close → layout", but closing goes through `ctx.session._exec()` (tmux CLI) with a comment "adapter path avoids keyboard focus races". Per TESTS.md, adapter calls are allowed only for setup *not part of the feature under test*; here "close" is part of the named chain. `killWindowKeyboard` is even imported (line 29) and never used. Recommendation: close at least one window via the real user path (tab close button or `killWindowKeyboard`) and keep `_exec` only for bulk cleanup.

**[MED] `createWindowKeyboard()` is an adapter call masquerading as a keyboard helper** — `tests/helpers/window-ops.js:16-26`. Despite the name, it POSTs `run_tmux_command new-window` to `/commands` via `fetch`. It is used ~15 times across suites 2, 5, 7, 9 as if it exercised the user path, skipping the keyboard actor → prefix binding → HTTP chain entirely. The one real user path (`clickAddTab` clicking `.tab-add`) exists only in `tests/7-regression-bugs.test.js:1333-1335`. Recommendation: rename it `createWindowViaAdapter` (so misuse is visible) and add/use a genuine user-path helper (prefix+c or `.tab-add` click) in at least the window-lifecycle tests.

**[MED] Float input-isolation assertion silently dropped** — `tests/2-layout-navigation.test.js:587-594`. Step 8 of the flagship float test is a comment explaining that the isolation check (typed keys must NOT appear in the background pane) was removed because of a CDP keyboard-routing issue, with a TODO. TESTS.md's "Keyboard Input Tests" section explicitly requires verifying output did not appear in other panes. As written, a keyboard-routing regression that duplicates float input into the background pane passes. Recommendation: assert isolation via the background pane's tmux-side content (`capture-pane` through the allowed helper path) instead of the DOM, or fix the keyboard actor per the TODO and restore the assertion.

**[MED] Broken `waitForState` call asserts nothing** — `tests/2-layout-navigation.test.js:889-899` and `tests/helpers/TmuxTestSession.js:206-227`. `ctx.session.waitForState((ctx) => ctx.activePaneId === win1PaneId)` stringifies the predicate and `eval`s it in the page, so the `win1PaneId` closure is lost; the call always rejects and the `.catch(() => {...})` swallows it (the comment admits this). The follow-up `activeAfterSwitch` (line 897-899) is computed and never asserted. Step 6 ("Verify we switched") verifies nothing. `waitForState` has no other callers. Recommendation: delete `waitForState` entirely and replace the step with `waitForCondition` + `expect(activeAfterSwitch).toBe(win1PaneId)`.

**[MED] Image-protocol tests assert XState + DOM existence, never visibility** — `tests/3-rendering-protocols.test.js:316-368, 384-406`. Placements are read from `window.app` context and the `<img>` is checked for existence/`src`/`data-protocol` only — no bounding rect, no check the image occupies its declared `widthCells × heightCells` area. An image rendered at 0×0 or clipped passes. Same for widget tests (`.widget-image` at `tests/3-rendering-protocols.test.js:556-576`). Recommendation: add `getBoundingClientRect()` width/height > 0 assertions on `.terminal-image` / `.widget-image img` per the TESTS.md visual-verification helper pattern.

**[MED] Pane-group identity test is nearly all XState-context assertions** — `tests/2-layout-navigation.test.js:297-352`. Tab switching is verified by comparing `context.activePaneId` values (ALPHA/BETA IDs), with no check that the visible pane's *content* changed. A bug where the state flips but the rendered pane doesn't would pass. (The regression suite covers this gap for keystroke routing at `tests/7-regression-bugs.test.js:1020+`, but Scenario 5 itself is state-only.) Recommendation: fingerprint each pane with a marker (as the regression tests do) and assert on the visible `.pane-active [role="log"]` content.

**[MED] ESLint's tmuxQuery/tmuxRun ban in `*.test.js` is routinely bypassed with raw `execSync`** — `tests/4-session-connectivity.test.js:230-243, 330-336`, `tests/7-regression-bugs.test.js:229-233, 1320-1330`. `eslint.config.mjs` bans `tmuxQuery`/`tmuxRun` calls in test files, but tests call `execSync(\`${tmuxCmd()} ...\`)` directly, which the AST selector can't see. Each use has a justification comment (pre-control-mode setup, ground-truth reads), so these may be legitimate — but the lint rule provides false assurance. Recommendation: extend the `no-restricted-syntax` selector to flag `execSync` in `tests/**/*.test.js`, and funnel the legitimate cases through a named, documented helper (e.g. `tmuxGroundTruth()`) that is allow-listed.

**[LOW] Computed-style assertions without visual pairing** — `tests/2-layout-navigation.test.js:502-519` (float border widths + boxShadow via `getComputedStyle`), `tests/1-input-interaction.test.js:713-719` (`touch-action: none`). TESTS.md's table explicitly lists `getComputedStyle(...)borderColor` as an assertion that does not catch real bugs. These are adjacent to rect checks so severity is low, but the border/shadow block adds no user-visible signal. Recommendation: drop or fold into a screenshot/rect-based check.

### 2. Low-value tests (tautological, can't fail, duplicated)

**[HIGH] "Emoji" and "box drawing" unicode steps contain no emoji or box-drawing characters** — `tests/3-rendering-protocols.test.js:88` (box test echoes `"BOX_TOP\n|test|\nBOX_BTM"` — pipes, not `│┌┐`), `:108` (`echo "EMOJI_TEST: X X X END_EMOJI"` — literal ASCII `X`), `:113` (`echo "MULTI_EMOJI_START END_MULTI"` — no multi-codepoint emoji). These steps cannot catch any unicode-width, grapheme-cluster, or box-drawing rendering bug; only step 7 (tree output, line 124-132) uses real box characters. Recommendation: put actual emoji (`🎉`, `👨‍👩‍👧`) and box characters in the echoed strings, and assert alignment (e.g. the column position of a marker after a wide char).

**[MED] OSC 8 detailed test computes link info and asserts nothing** — `tests/3-rendering-protocols.test.js:205-234`. `linkInfo` (anchors/data-hrefs) is gathered and then dropped with the comment "clickable links are a future enhancement". The only real assertion (`text` contains "Click Here") duplicates Scenario 14 step 1 exactly (`:33-38`). Recommendation: delete the dead evaluation and the whole test, or assert the future behavior when implemented.

**[MED] Category 11 duplicates Scenario 14 wholesale** — `tests/3-rendering-protocols.test.js:193-297` vs `:22-71`. Both cover OSC 8 single/multiple/malformed and OSC 52 single/multiple with the same commands and the same textContent assertions, split across five tests, each paying the full ~6s per-test setup/teardown cost. Recommendation: delete Category 11.

**[MED] Category 15.1–15.3 duplicate Scenario 20, and drive splits via the adapter** — `tests/5-stress-stability.test.js:360-460` vs `:273-333`. Scenario 20 already does split-H, split-V, resize, click-focus with glitch detection via keyboard. Category 15.1/15.2 repeat splits with `ctx.session.splitHorizontal()` / `splitVertical()` (`:369, :388`) — adapter calls where the split is itself the operation being glitch-measured, so the optimistic-update path a user triggers is not what's measured. Recommendation: delete 15.1–15.3 or keep only the resize variant.

**[LOW] Category 15.4 tests the test harness** — `tests/5-stress-stability.test.js:466-555`. Four tests assert GlitchDetector's own API shape: `expect(result.summary.totalNodeMutations).toBeGreaterThanOrEqual(0)` (`:487`) cannot fail; `toBeDefined()` chains (`:482-486`) verify the helper returns an object. TESTS.md's "What Not to Test" excludes exactly this. Recommendation: move any needed harness verification into a cheap unit test; delete from E2E.

**[LOW] Timing assertions that can't fail** — `tests/5-stress-stability.test.js:45-48, 52-55`: `expect(elapsed1).toBeLessThan(20000)` after `runCommand(..., 20000)`, which throws at 20000ms — the expect can never trip. `tests/6-nvim-performance.test.js:131-137`: `typeWithTiming` measures only `page.keyboard.type(text, {delay: 0})` dispatch (milliseconds), and `waitForTerminalText` runs *after* the measurement — "typing + round-trip should complete within 5s" asserts on a number that excludes the round trip. Recommendation: for 6-nvim, measure type + wait inside the timer; for 5-stress, delete the redundant asserts.

**[LOW] Conditional sixel assertions** — `tests/3-rendering-protocols.test.js:424-435`: `if (sixel) { ...assert... }` means a sixel decoder that silently produces nothing passes (acknowledged in the comment). Recommendation: rename to reflect "terminal survives sixel input", or make the fixture a known-good sixel and assert unconditionally.

**[LOW] Multi-Client scenario asserts almost nothing** — `tests/4-session-connectivity.test.js:110-141`. After building a 3-pane layout, page 2 is only checked for `[role="log"]` existence and `p2PaneCount >= 1` — not 3 panes, not visible rects, not shared content. Recommendation: assert page 2 shows the same 3 pane IDs with non-zero rects, and that output typed in page 1 appears in page 2.

**[LOW] Token-free routing test only asserts HTTP 200** — `tests/4-session-connectivity.test.js:176-194`. Hard-codes `X-Connection-Id: '1'` and asserts `res.ok`; it doesn't prove tokens are *not* required (no negative case) nor that the resize took effect. Recommendation: add the negative assertion or fold into another test.

### 3. Missing coverage

**[HIGH] Suites 6, 7, 8, 9 never run in CI** — `.github/workflows/lint-and-tests.yml:88-96` matrixes only `tests/snapshots/` and suites 1–5. `6-nvim-performance`, `7-regression-bugs` (the entire production-bug regression suite, ~60KB of the most bug-targeted tests in the repo), `8-tui-alternate-screen`, and `9-pane-animations` run only when someone invokes `npm run test:e2e` locally. CLAUDE.md's "if CI is red, make it green" rule is unenforceable for these. Recommendation: add four matrix entries.

**[MED] `tmuxy event emit/wait/list` has zero tests anywhere** — no match in `tests/`, `tests/cli/`, or elsewhere. The CLI table in CLAUDE.md documents it as the inter-agent coordination primitive. Recommendation: at minimum a CLI-suite test (emit → wait round-trip, list shows pending).

**[MED] `--password` / HTTP Basic auth has zero tests** — no match for `password`/`TMUXY_PASSWORD` under `tests/` (including `tests/cli/cli-server.test.js`). An auth regression (accepting requests without credentials) would ship silently. Recommendation: an E2E or smoke test that starts the server with `--password`, asserts 401 without credentials and success with them, including the SSE endpoint.

**[MED] `tmuxy widget markdown` untested** — `tests/3-rendering-protocols.test.js` covers only the image widget (17.1–17.3). No test renders markdown (file or stdin path). Recommendation: add a markdown-widget case to Category 17 mirroring 17.1 (pipe `# Hello`, assert a visible rendered heading, no `[role="log"]`).

**[MED] Copy-mode search is untested and the file header claims otherwise** — `tests/1-input-interaction.test.js:4-5` says "copy mode navigation, copy mode search/yank", but no test presses `/` or asserts a search match/highlight. Scenario 10 covers select+yank only. Recommendation: extend Scenario 10 with `/BUGMARK` → `n` → assert cursor lands on the match, or fix the header comment.

**[MED] Paste is untested** — `pasteText` (`tests/helpers/copy-mode-ui.js:37-48`) and `pasteBufferKeyboard` (`:29-34`) have no callers; neither `tmuxy pane paste` nor clipboard-paste nor `prefix ]` after a yank is exercised. Scenario 10 yanks but never pastes to verify the yanked text. Recommendation: complete the yank test with a paste + visible-output assertion.

**[LOW] Pane-group CLI verbs (`group switch/next/prev`) exercised only by non-running QA scripts** — `tests/qa-flicker-run.js:231`, `tests/qa-snapshot-run.js:308`; the jest E2E suites drive groups exclusively through the UI menu. `tests/cli/cli-pane-group.test.js` exists but the CLI suite has no CI entry. Recommendation: add the CLI suite to CI.

**[LOW] `tmuxy pane swap/break/capture/send` CLI paths absent from E2E** — swap is tested only via keyboard (`tests/5-stress-stability.test.js:179-188`); break/capture/send only in the non-CI CLI suite. Acceptable if the CLI suite gains a CI job; otherwise add one E2E smoke pass.

### 4. Dead code

**[MED] `tests/helpers/assertions.js` — entire file unused.** None of `verifyLayoutChanged`, `getUISnapshot`, `verifyMouseDragEffect` has a caller in any test or QA script. Delete the file and its `index.js` re-export (`tests/helpers/index.js:11,37`).

**[MED] `tests/helpers/tmux.js` — entire file unused.** `runTmuxCommand`, `generateTestSessionName`, `createTmuxSession`, `killTmuxSession`, `captureTmuxSnapshot` have zero callers, and `captureTmuxSnapshot` duplicates `TmuxTestSession.captureSnapshot()` (`tests/helpers/TmuxTestSession.js:605-628`), itself also unused. Delete both.

**[MED] `tests/helpers/performance.js` — 8 of 10 exports unused.** Only `measureTime` and `typeWithTiming` are called (6-nvim). `sendKeysWithTiming`, `assertCompletesWithin`, `measureKeyboardRoundTrip`, `sendCtrlKeyWithTiming`, `sendPrefixSequenceWithTiming` (which hard-codes Ctrl+A, contradicting the dynamic-prefix helper), `clickWithTiming`, `dragWithTiming`, `scrollWithTiming` are dead. Prune to the two live functions — though note `measureKeyboardRoundTrip` is exactly what the 6-nvim perf test *should* use (see §2).

**[MED] Dead helpers scattered across live files** — `tests/helpers/pane-ops.js`: `getPaneText`, `uiContainsText`, `runCommandWithDelay`, `clickPane`, `clickButton`, `clickMenuItem`, `splitPaneUI` (all uncalled); `tests/helpers/keyboard.js:180-183` `typeChar`; `tests/helpers/copy-mode-ui.js` `exitCopyModeKeyboard`, `pasteBufferKeyboard`, `pasteText`; `tests/helpers/mouse-capture.js:99-101` `expectedSgrCoord`; `tests/helpers/consistency.js:548-613` `assertConsistencyPasses`; `tests/helpers/pane-groups.js:145-165` `getUIPaneTitles`; `tests/helpers/TmuxTestSession.js`: `getPaneBorderTitles` (:488), `getScrollPosition` (:469), `isPaneInCopyMode` (:443), `waitForState` (:206, broken — see §1), `_execSession` (:197). Recommendation: delete all; the ones representing untested features (paste) should first gain callers per §3.

**[MED] `glitchDetection` option of `createTestContext` is never enabled** — `tests/helpers/test-setup.js:45,206-210`. No suite passes `{ glitchDetection: true }`; all glitch tests use `ctx.startGlitchDetection()` manually. The auto-start block and the option are dead. Delete.

**[MED] Unused imports in five suites** (ESLint has no `no-unused-vars` for tests, so nothing catches them) — `tests/1-input-interaction.test.js:22,25` (`navigatePaneKeyboard`, `pasteText`); `tests/2-layout-navigation.test.js:7,29,30,42` (`fs`, `killWindowKeyboard`, `killPaneKeyboard`, `assertContentMatch`); `tests/3-rendering-protocols.test.js:17` (`TMUXY_URL`); `tests/4-session-connectivity.test.js:17,19,20` (`verifyRoundTrip`, `getBrowser`, `TmuxTestSession`); `tests/5-stress-stability.test.js:13` (`sendKeyCombo`). Recommendation: remove them and add `no-unused-vars: 'error'` to the tests block of `eslint.config.mjs`.

**[MED] `dbg` computed and discarded** — `tests/7-regression-bugs.test.js:468-485`. A full state dump ("Dump state to diagnose what landed") is evaluated into `dbg` and never logged or asserted. Delete or log it in the failure path.

**[LOW] QA scripts are orphaned and their cleanup targets the wrong tmux socket** — `tests/qa-flicker-run.js`, `tests/qa-flicker-rerun.js`, `tests/qa-snapshot-run.js`, `tests/qa-snapshot-retest.js` are referenced by no `package.json` script and no workflow; `qa-flicker-run.js:4` cites a `.claude/agents/qa/styles/flicker.md` that doesn't exist in the repo. `qa-snapshot-run.js:466` and `qa-snapshot-retest.js:151` clean up with `tmux -L tmuxy-prod kill-session -t tmuxy-qa`, but every helper targets socket `tmuxy` (`tests/helpers/tmux-socket.js:14-15`) — the kill-session is a guaranteed no-op, leaking the `tmuxy-qa` session on the real socket. Recommendation: delete all four (their scenarios are subsumed by suites 5/7 and `tests/snapshots/`), or fix the socket via `tmuxCmd()` and document their invocation.

### 5. Duplicate logic

**[MED] Three near-identical ~60-line MutationObserver + RAF sampler blocks** — `tests/7-regression-bugs.test.js:740-794`, `:884-936`, `:1170-1222`. Each installs the same `snapshotPanes`/observer/`requestAnimationFrame` rig with only the marker names and window-global names differing. Recommendation: extract a `tests/helpers/frame-sampler.js`, which would also let Scenario 24 in 2-layout (`:958-1045`, a fourth variant) share the blink-detection logic.

**[MED] Inactive-tab-finding loop repeated four times** — `tests/2-layout-navigation.test.js:795-805`, `:875-885`, `:912-921`, `:993-1002`: identical `$$('.tab-name:not(.tab-add)')` + classList scan. Recommendation: `findInactiveTab(page)` helper.

**[MED] Float-open boilerplate repeated in four describes** — `tests/2-layout-navigation.test.js:446-455`, `:656-666`, `:716-725`, `:1065-1071` (type CLI → `waitForFloatModal` → `delay(SYNC)` → `verifyFloatVisible` → wait for `focusedFloatPaneId`). Recommendation: `openFloatViaCli(ctx)` helper returning the float pane id.

**[MED] `consistency.js` vs `snapshot-compare.js` are parallel implementations of "compare tmux state to UI state"** — `tests/helpers/consistency.js:28-239` and `tests/helpers/snapshot-compare.js:29-649` both extract windows/panes/content from tmux and XState and diff them, with different tolerances and different bugs. Notably `snapshot-compare.js:254` builds the socket flag as `` `-L ${process.env.TMUX_SOCKET || 'tmuxy'} ` `` — wrong when `TMUX_SOCKET` is a path (must be `-S`), which `tests/helpers/tmux-socket.js:19-22` already solves. Recommendation: fix the socket bug immediately; longer-term converge on `snapshot-compare.js` (the stricter one).

**[LOW] `qa-flicker-rerun.js` duplicates `resetToOnePane`/`ensurePaneCount` from `qa-flicker-run.js`** — `tests/qa-flicker-rerun.js:30-49` vs `tests/qa-flicker-run.js:51-80`. Moot if the scripts are deleted (§4).

**[LOW] `TmuxTestSession.captureSnapshot` duplicates `tmux.js#captureTmuxSnapshot` verbatim** — both dead; covered in §4.

### 6. Unclear tests

**[MED] Misleading test name: "close via button" closes via command prompt** — `tests/2-layout-navigation.test.js:753` names the Status Bar chain "…→ close via button", but step 8 (`:820-828`) runs `tmuxCommandKeyboard('kill-window -t :N')`. The tab close button is never clicked anywhere in the suite. Recommendation: either click the actual close affordance or rename the step.

**[MED] Duplicate scenario numbers break the documented debug workflow** — docs/TESTS.md:229 recommends `--testNamePattern="Scenario 22"`, but "Scenario 22" is both Float fzf (`tests/2-layout-navigation.test.js:1051`) and Token-Free Routing (`tests/4-session-connectivity.test.js:146`); "Scenario 23" appears three times (`tests/1-input-interaction.test.js:869`, `tests/2-layout-navigation.test.js:834`, `tests/3-rendering-protocols.test.js:301`); "Scenario 24" twice (`tests/2-layout-navigation.test.js:938`, `tests/4-session-connectivity.test.js:199`). Recommendation: renumber uniquely or drop numbers in favor of descriptive names.

**[MED] 175 fixed `delay(DELAYS.*)` sleeps across the suites** — e.g. 30 `delay(DELAYS.SYNC)` (1.5s each) in `tests/2-layout-navigation.test.js` alone, plus raw magic sleeps: `tests/2-layout-navigation.test.js:632` (`delay(1000)`), `tests/3-rendering-protocols.test.js:560,641` (`delay(2000)` before widget selector wait), `tests/6-nvim-performance.test.js:87,105,122` (`delay(1500/2000/3000)`). Recommendation: audit the SYNC sleeps that immediately precede a `waitFor*` (redundant) and replace bare sleeps with condition polls; keep only the ones whose comment names a specific grace window.

**[LOW] Touch-scroll test falls back to keyboard, so the touch path can't fail** — `tests/1-input-interaction.test.js:756-763` and `:796-807`. Both fallbacks are documented as headless-unreliability workarounds, but the effect is that a total touch-handling regression passes. Recommendation: record and `console.warn` when the fallback fired, and assert the *touch* path in the v86/storybook harness where input is deterministic; or gate the fallback behind a CI env flag.

**[LOW] Retry loops around prefix keybindings mask dropped-input bugs** — `tests/2-layout-navigation.test.js:130-162, 165-188, 205-227` retry `next/prev/last-window` up to 3× for a documented Playwright headless keyboard flake. A real "first prefix keypress is dropped" product bug now needs to fail 3× consecutively to surface. Recommendation: keep the retries but assert (and log) the attempt count.

### 7. Flakiness risks

**[MED] `waitForPaneCount` can succeed for the wrong reason and is wrong with >1 window** — `tests/helpers/browser.js:273-290` returns true when `paneIds.length === count || logs.length === count`. `[data-pane-id]` nodes include hidden-window panes (kept mounted for instant tab switching — acknowledged at `tests/9-pane-animations.test.js:252-255`), so after any window is created, neither operand reliably equals the visible-pane count, and the OR lets one stale selector satisfy the wait. Recommendation: count panes of the *active window* via XState (which `TmuxTestSession.getPaneCount()` already does), and drop the OR.

**[MED] `snapshot.test.js` borrows any open tmuxy tab it finds** — `tests/snapshots/snapshot.test.js:32-38, 157-172`. When a developer runs the suite locally with a tmuxy tab open, the "read-only" snapshot attaches to that arbitrary page/session, making results depend on ambient browser state. Recommendation: gate the borrow behind an explicit env var (`SNAPSHOT_ATTACH=1`) and default to an owned page.

**[MED] Assertion helpers that silently pass on exceptions** — `tests/helpers/content-match.js:227-230` (`catch (e) { return; }`), `tests/helpers/consistency.js:270-280` (`if (!tmux || !ui) return; // can't compare, skip silently` and `catch → return`), `tests/helpers/browser.js:96-131` (`navigateToSession` exhausts retries and *returns the URL anyway*). Recommendation: only swallow the specific "page is closing / session destroyed during teardown" cases (checkable via `page.isClosed()`), rethrow everything else.

**[LOW] Fixed 4s teardown sleep per test plus 250ms per `_exec`** — `tests/helpers/test-setup.js:157` (`delay(4000)` for the server's 2s SSE-disconnect grace) and `tests/helpers/TmuxTestSession.js:188` (blanket 250ms after every command). With ~35 E2E tests that's ~2.5 minutes of unconditional sleeping per full run. Recommendation: poll the server for monitor shutdown instead of the fixed 4s; make `_exec`'s settle opt-in for reads.

**[LOW] Hard-coded `tabs[0].click()` assumes window ordering** — `tests/7-regression-bugs.test.js:798-802, 939-943`. Recommendation: select the tab by inactive-state or window id.

### 8. Contradictions between tests and docs

**[MED] docs/TESTS.md references a nonexistent helper and a wrong lifecycle** — `docs/TESTS.md:92` says "Call `destroyViaAdapter()` before closing the browser page"; no such function exists (`session.destroy()` is the real API, and it routes through `tmuxQuery kill-session`, not the adapter). `docs/TESTS.md:91` says "Each `describe` block gets its own tmux session via `createTestContext()`" — sessions are actually created per *test* in `beforeEach` (`tests/helpers/test-setup.js:77-107`). Recommendation: update TESTS.md to match reality.

**[MED] CLAUDE.md project tree mislabels the helpers layout** — CLAUDE.md says `tests/helpers/ # One file per helper function`; the directory is organized as ~20 domain modules exporting 5–15 functions each. Recommendation: fix the tree comment to "one file per domain".

**[LOW] TESTS.md "never install Playwright browsers" vs CI** — `docs/TESTS.md:85` / CLAUDE.md say "Never install Playwright browsers", but CI runs `npx playwright install chromium --with-deps` (`.github/workflows/lint-and-tests.yml:145,267,356`) and `tests/helpers/browser.js:38-42` launches its own Chromium when no CDP endpoint exists. The rule is evidently "don't install browsers *locally in the devcontainer*". Recommendation: reword the doc rule to scope it.

**[LOW] `// eslint-disable-next-line no-console` comments violate CLAUDE.md's ESLint rule** — `tests/7-regression-bugs.test.js:826, 960, 1276`. The config already allows `console.warn`/`console.error`; switching the three `console.log` diagnostics to `console.warn` removes the need for the disables entirely.
## Shell layer: bin/, CI, root config

### Stray files

- [x] **[med] Stray tmux debug log in `bin/`** — **Done (verified):** no `*.log` remains in `bin/`. Still open: no explicit `tmux-client-*.log` line in `.gitignore` (a generic `*.log` covers it today). — `/tmuxy/bin/tmux-client-47364.log` is a 19KB tmux 3.6a client debug log from a macOS machine (`socket /private/tmp/tmux-501/default`, Darwin 25.1.0), dated April. Verified via `git ls-files`: it is **not tracked** and `git check-ignore` confirms it is ignored (by a generic log pattern, not a `tmux-client-*` rule), so it is litter in the working tree rather than a committed artifact. It does however sit inside `bin/`, which the v86 asset cache key hashes (`.github/workflows/lint-and-tests.yml:346` hashes `bin/tmuxy/**` — narrowly misses it, but any future broadening to `bin/**` would bust caches on it). Recommendation: delete the file and add an explicit `tmux-client-*.log` line to `/tmuxy/.gitignore` so future `tmux -vv` runs from `bin/` can't be accidentally staged.

### Contradictions: CLAUDE.md / docs vs actual behavior

- [x] **[high] `tmuxy run new-window` intercept** — **Done (verified):** now uses `run_safe "splitw \; breakp ... \; set-option"`. — `/tmuxy/bin/tmuxy-cli:752-774`: the intercept prints "Note: new-window intercepted for safety" then runs `tmux split-window -dP`, `tmux break-pane`, and `tmux set-option` as **direct external subprocesses** (the `tmux()` shim at line 36 only adds socket flags; it does not route through run-shell). This contradicts the file's own header (`bin/tmuxy-cli:4-5`, "All mutating commands route through tmux run-shell"), the CLAUDE.md claim, and `docs/TMUX.md:48` ("Running external tmux commands ... can crash the tmux server"). Compare `cmd_tab create` (`bin/tmuxy-cli:513-518`), which does the identical splitw+breakp via `run_safe`, and `float-create:113-131`, which solved the "need the new pane id back" problem with run-shell + a temp file. Recommendation: reuse the float-create temp-file pattern (or delegate to `cmd_tab create`) so the intercept is actually safe.
- [x] **[med] `tmuxy pane paste` mutates via direct subprocess** — **Done:** documented in docs/TMUX.md's safe-externals table with the justification (reads stdin, which run-shell can't supply; mutates only the paste buffer, not session state). **[med] `tmuxy pane paste` mutates via direct subprocess** — `/tmuxy/bin/tmuxy-cli:372`: `tmux load-buffer - <<< "$text"` is a state-modifying command run externally; only the subsequent `pasteb` goes through `run_safe` (line 373). Violates the "all mutating commands route through run-shell" claim. Recommendation: `load-buffer` reads stdin so it can't ride run-shell trivially — either document it in `docs/TMUX.md`'s safe-externals table with a justification, or switch to `run_safe "send-keys -l ..."`.
- [x] **[med] `session-switch`/`session-connect` external mutations** — **Done (verified):** both wrap their mutations in `_run_safe`; only `switch-client` stays direct, with a justifying comment. — `/tmuxy/bin/tmuxy/session-switch:53,70,72` (`new-session`, `set-environment -g`, `switch-client`) and `/tmuxy/bin/tmuxy/session-connect:37,39` (`new-session`, `set-environment -g`). `docs/TMUX.md:75-77` lists `set-environment` under "Commands That MUST Go Through Control Mode", and `new-session` is documented safe only "**before** control mode attaches" (`docs/TMUX.md:92`) — these scripts run inside a live pane with control mode attached (the UI spawns them in floats, `packages/tmuxy-ui/src/machines/app/actions/groupsAndFloats.ts:36,56`). They are interactive (`read -rp`) so they can't run under run-shell themselves, but their mutating tmux calls could be wrapped `_tmux run-shell "tmux $TMUX_SOCKET_FLAG $TMUX_SOCKET set-environment ..."`. Recommendation: wrap the mutations, or amend TMUX.md's table if these are empirically safe on 3.7a.
- **[med] CLI commands implemented but absent from the CLAUDE.md table** — `tmuxy session switch/connect` (`bin/tmuxy-cli:633-666`), `tmuxy nav <dir>` (`bin/tmuxy-cli:670-692`), and `tmuxy tree` (`bin/tmuxy-cli:863-875`) are all implemented, listed in the CLI's own `usage()` (lines 66-71), and exercised by the UI — yet none appear in CLAUDE.md's "CLI Usage" section (verified by grep: no `tmuxy nav`, `tmuxy tree`, or `tmuxy session` in `/tmuxy/CLAUDE.md`). `tmuxy server status` (`packages/tmuxy-server/src/server.rs:85`) is likewise reachable via `tmuxy server status` but documented nowhere, including the dispatcher's own help. The reverse direction checks out: every command in the CLAUDE.md table exists (including `server --host/--password/stop`, verified against `server.rs:19-93`). Recommendation: add the three missing nouns to CLAUDE.md.
- [x] **[low] `resize-window` messaging is internally inconsistent** — **Done:** the block message now reads "unreliable with control mode attached (ignored when sent externally). Use resize-pane."; the CLI test asserts the new wording. **[low] `resize-window` messaging is internally inconsistent** — `bin/tmuxy-cli:776-779` blocks `tmuxy run resize-window` with "crashes tmux with control mode attached", but `docs/TMUX.md:67` says externally-sent `resize-window` is merely "ignored", and `/tmuxy/bin/tmuxy/pane-group-add:59` plus `/tmuxy/bin/tmuxy/pane-group-switch:37` issue `_tmux resize-window` routinely (from run-shell context, which is sanctioned). Recommendation: align the error message with the documented behavior ("blocked: unreliable with control mode; use resize-pane") so the next reader doesn't conclude the group scripts are crash bugs.

### tmux-socket-isolation audit

- **Verified clean overall.** Every tmux invocation in `bin/` goes through `_tmux` (`_lib:33-35`), the `tmux()` shim (`tmuxy-cli:36`), explicit `"$SOCKET_FLAG" "$SOCKET"` args (`bin/dev:57-58`), hardcoded `-L tmuxy-prod` (`bin/prod:17-18`), or explicit flags on `exec tmux ...` lines (`tmuxy-cli:427-457,675-678` — correctly not relying on the shell function, which `exec` would bypass). Embedded run-shell strings all interpolate `$TMUX_SOCKET_FLAG $TMUX_SOCKET` (`float-create:119,131,159,163`; `run_safe` at `tmuxy-cli:40`). No bare `tmux` calls found.
- [x] **[med] `event-list` uses a different socket resolution** — **Done:** `event-list` now sources `_lib`, so a standalone invocation resolves the hosting socket instead of always reporting the `tmuxy` namespace. **[med] `event-list` uses a different socket resolution than `event-emit`/`event-wait`** — `/tmuxy/bin/tmuxy/event-list:9` reads `SOCKET="${TMUX_SOCKET:-tmuxy}"` without sourcing `_lib`, so it skips the derive-from-`$TMUX` step that `event-emit:13` and `event-wait:12` get by sourcing `_lib:16-19`. Through the `tmuxy` dispatcher this is masked (`tmuxy-cli:23-28` exports a resolved `TMUX_SOCKET` before exec), but the scripts are also materialized standalone into `~/.config/tmuxy/bin/tmuxy` (`packages/tmuxy-core/src/session.rs:212-221`); invoked directly inside a pane on `tmuxy-dev`, `event-list` would report the `tmuxy` namespace while emit/wait use `tmuxy-dev` — silently showing "No event channels" for pending events. Recommendation: `source "$(dirname "$0")/_lib"` in event-list (it already exports the resolved value) and drop the local `SOCKET=` lines from all three (emit/wait re-deriving `SOCKET="${TMUX_SOCKET:-tmuxy}"` at `event-emit:24`/`event-wait:16` is redundant with `_lib`).

### Bugs

- [x] **[med] `float-create` command mode doesn't check the split succeeded** — **Done:** the command-mode branch now guards the empty `NEW_PANE_ID` exactly as the interactive branch does. **[med] `float-create` command mode doesn't check the split succeeded** — the interactive branch guards empty `NEW_PANE_ID` (`/tmuxy/bin/tmuxy/float-create:124-127`), but the command-mode branch (`float-create:163-168`) reads `$TMPID` and feeds `NEW_PANE_ID` straight into `build_break_and_tag_float`. On a failed split the generated command becomes `break-pane -d -s  -n float`, i.e. `-s` consumes `-n` as its argument — tmux errors at best, and the subsequent `wait-for` at line 178 then blocks forever since the wrapper never runs. Recommendation: copy the interactive branch's empty-check.
- [x] **[med] Argument flattening in `run_safe`** — **Done:** new `shquote` helper emits one single-quoted token per argument (embedded `'` escaped, `#` doubled for run-shell's format expansion), applied at every user-data interpolation site (`pane send`, `run <cmd>`, `tab rename`, `breakp -n`, `set-environment`, and the `-t` targets). Replaced the three ad-hoc `${name//.../}` copies. Regression tests cover spaces, quotes and `#`; verified end-to-end against a real tmux server. **[med] Argument flattening in `run_safe` breaks any argument containing spaces or quotes** — `run_safe()` (`/tmuxy/bin/tmuxy-cli:39-41`) interpolates `$*` into a shell string executed via run-shell, so `tmuxy run rename-window "my tab"` renames to "my" with a trailing error, `tmuxy pane send` mangles quoted keys, and on tmux 3.7a any `#{...}` in user args is format-expanded by run-shell before the inner command sees it (`docs/TMUX.md:176-180` — only `float-create` applies the `##` escaping). `cmd_run` compounds it at line 782 (`run_safe "$tmux_cmd $*"`). Recommendation: build the inner command with `printf '%q '` per argument, and double `#` → `##` before handing to run-shell.
- [x] **[med] `event-wait` has no locking** — **Done:** the scan → cat → cursor → rm critical section now holds the same `$DIR/.lock` flock `event-emit` uses, released before blocking on `wait-for` so emit can still acquire it. **[med] `event-wait` has no locking — concurrent waiters double-consume** — `event-emit` serializes sequence allocation with `flock` (`/tmuxy/bin/tmuxy/event-emit:29-33`), but `event-wait`'s read-cursor → cat → write-cursor → rm sequence (`/tmuxy/bin/tmuxy/event-wait:22-47`) is unlocked; two agents waiting on the same channel can both `cat` the same message before either advances the cursor. For a primitive whose stated purpose is inter-agent coordination (CLAUDE.md "Event queue"), delivery-exactly-once matters. Recommendation: take the same `$DIR/.lock` flock around the scan-and-consume critical section.
- [x] **[low] `pane list --json` / `tab list --json` emit invalid JSON** — **Done:** both serializers now use a tab separator (`LIST_PANES_JSON_FMT`/`LIST_WINDOWS_JSON_FMT`) and an awk `jstr()` that escapes backslash, quote, and control chars. Regression test feeds a window named `build, "test"`. **[low] `pane list --json` / `tab list --json` emit invalid JSON for hostile field values** — the awk serializers at `/tmuxy/bin/tmuxy-cli:254-255` and `495-496` split on `,` and never escape `"`: a `pane_current_command` or a window name containing a comma or quote (user-controlled via `tmuxy tab rename`) shifts fields or breaks the JSON. `pane capture --json` (`tmuxy-cli:349-352`) similarly leaves tabs/control characters unescaped. Recommendation: use tab as the `-F` separator and escape `"` and control chars in awk, or shell out to `jq -R`.
- [x] **[low] `devcontainer` trailing `--name`** — **Done:** arity checked before `shift 2`, with an explicit error message. **[low] `devcontainer` global-flag parsing dies silently on trailing `--name`** — `/tmuxy/bin/devcontainer:48`: `--name) OVERRIDE_NAME="$2"; shift 2` with `--name` as the last argument makes `shift 2` fail, and under `set -e` (line 34) the script exits 1 with no message. Recommendation: `[ $# -ge 2 ] || { echo "--name requires a value" >&2; exit 1; }`.

### Dead code

- **[low] `bin/dev` cleanup trap is unreachable in practice** — `/tmuxy/bin/dev:35-41` defines `cleanup()` killing `jobs -p`, but the script starts no background jobs and ends with `exec cargo watch` (line 60), which replaces the process and discards the trap. The trap can only fire in the microseconds between lines 41 and 60. Recommendation: delete the trap/cleanup block (CLAUDE.md rule 1: "No legacy code").
- [x] **[low] `build-app.yml` smoke-test cleanup dead on failure** — **Done (verified):** no `RESULT=$?` captures remain. — `.github/workflows/build-app.yml` Linux smoke test (~lines 90-117), hostile-config test (~148-153), and macOS smoke test (~157-171) all use the `node ...; RESULT=$?; kill ...; exit $RESULT` pattern, but GitHub Actions' default `bash -e` shell aborts the step at the failing `node` line — the `kill` cleanup and `exit $RESULT` never run on failure (harmless on ephemeral runners, but the pattern misleads). Recommendation: either drop the dead capture (`node ...` as last command) or set `shell: bash {0}` if cleanup genuinely matters.
- Checked all 8 `_lib` functions (`window_type`, `find_group_for_pane`, `parse_group_panes`, `set_group_panes`, `find_visible_pane_from_list`, `active_window`, `pane_window`, `refresh_panes`) — **all have live callers** across `float-create`, `nav`, `stack`, and the `pane-group-*` scripts. All `bin/tmuxy/*` scripts are live: embedded via `include_str!` in `packages/tmuxy-core/src/session.rs:204-267` and wired to keybindings in `.devcontainer/.tmuxy.defaults.conf:23-31` or UI actions. No dead scripts found.

### Duplicate logic

- **[med] Socket-resolution block duplicated three times, with drift** — `/tmuxy/bin/tmuxy/_lib:16-28`, `/tmuxy/bin/tmuxy-cli:23-36`, and `/tmuxy/bin/dev:28-32`. The tmuxy-cli inline copy is sanctioned by `docs/TMUX.md:19`, but `bin/dev`'s copy has already drifted: it omits the derive-from-`$TMUX` step, so `npm start` run from inside a tmuxy pane targets `tmuxy` instead of the hosting socket (arguably intended for dev, but undocumented). Recommendation: have `bin/dev` source `_lib`, or document the intentional difference.
- **[low] `pane-group-next` and `pane-group-prev` are ~95% identical** — `/tmuxy/bin/tmuxy/pane-group-next` vs `pane-group-prev` differ only in the index arithmetic (next:43-48 vs prev:43-47); `nav`'s `nav_horizontal` (`/tmuxy/bin/tmuxy/nav:58-84`) re-implements the same find-visible/index/circular-wrap logic a third time. Recommendation: one `pane-group-step <dir> <pane>` script; have `nav` exec it.
- **[low] `float-create` branches duplicate the split→break→resize sequence** — `/tmuxy/bin/tmuxy/float-create:113-141` (interactive) vs `153-175` (command mode) repeat the run-shell split, TMPID read, break+tag, and both resize blocks nearly line-for-line. Recommendation: extract a `create_float_pane` function; this would also fix the missing empty-check bug above in one place.
- **[low] tmux 3.7a build block and Storybook-start poller duplicated across CI jobs** — `.github/workflows/lint-and-tests.yml:122-136` vs `217-231` (identical cache+compile of tmux 3.7a in `e2e` and `tauri-e2e`), and `274-290` vs `358-374` (identical Storybook dev-server start + Node polling loop). Recommendation: a local composite action (`.github/actions/setup-tmux`, `.github/actions/start-storybook`).
- **[low] Root `lint` script inlines `lint:tests`** — `/tmuxy/package.json:26-27`: `"lint"` runs `eslint tests/` directly instead of `npm run lint:tests`. Trivial, but they can drift. Similarly `"build"` (line 14) and `"tauri:build"`/`bin/build-tauri` (line 20) are two overlapping ways to produce the Tauri bundle with different steps (`build` skips the dist-exists check and does an extra redundant `cargo build --release -p tmuxy-server` — the Tauri build doesn't consume it).

### Missing tests / CI gaps

- [x] **[high] The CLI test suite never runs in CI** — **Done (verified):** `lint-and-tests.yml` has a `cli-tests` job running `npm run test:cli`. — `/tmuxy/tests/cli/` contains 11 suites (`cli-dispatch`, `cli-run`, `cli-pane`, `cli-tab`, `cli-connect`, ...) with its own config (`tests/cli/jest.config.js`) and an npm entry (`"test:cli"`, `/tmuxy/package.json:25`), but the root `jest.config.js:6` explicitly excludes `tests/cli/`, and grep across `.github/workflows/*.yml` and `.github/pre-commit` finds **zero** references to `test:cli` or `tests/cli`. Per project memory this suite is what enforces the tmux-socket-isolation invariant — the project's most critical shell-layer rule is enforced by tests that nothing executes automatically. Recommendation: add a `cli-tests` job to `lint-and-tests.yml` (it needs only node + tmux 3.7a, both already available via the existing cache block).
- **[low] No shellcheck in CI** — scripts carry `# shellcheck disable=SC2086` annotations (`nav:48`, `pane-group-close:27` etc.), implying shellcheck is part of the workflow, but no workflow or pre-commit step runs it over `bin/`. Recommendation: add `shellcheck bin/tmuxy-cli bin/tmuxy/* bin/dev bin/prod bin/devcontainer bin/kill-port bin/build-tauri` to the lint job.

### Outdated code / comments

- **[low] Changelog-style help text** — `/tmuxy/bin/tmuxy-cli:85`: "the left sidebar is **now** a native React tree" describes a past migration, not the command. Recommendation: "A standalone browser of tabs/panes (the app sidebar shows the same tree natively)."
- **[low] Doubled section headers in build-app.yml** — `# --- Collect Artifacts ---` immediately followed by `# --- Collect & Upload Artifacts ---` (`.github/workflows/build-app.yml`, ~lines 192-195): the first is a leftover. Delete it.
- **[low] Hardcoded `/tmuxy` paths assume the devcontainer** — `/tmuxy/bin/dev:22` (`cd /tmuxy`), `/tmuxy/bin/prod:14`, and `/tmuxy/package.json:16` (`--cwd /tmuxy`) break on any checkout outside the container, while `bin/build-tauri:20` and `bin/devcontainer:36` correctly resolve via `dirname "$0"`. Recommendation: `cd "$(dirname "$0")/.."` in dev/prod and drop the pm2 `--cwd` literal.
- **[low] `devcontainer help` uses a hardcoded sed line range** — `/tmuxy/bin/devcontainer:297`: `sed -n '3,31p' "$0"` — inserting one comment line in the header silently corrupts the help output. Recommendation: print between markers or a heredoc.

### Overengineering

- **[low] `eslint.config.mjs` redundant glob** — `/tmuxy/eslint.config.mjs:5`: `files: ['tests/**/*.js', 'tests/**/*.test.js']` — the second pattern is a strict subset of the first. Drop it.
- Reviewed `bin/kill-port`'s manual `/proc/net/tcp` + fd-inode scan and `bin/devcontainer`'s 317 lines: both look heavyweight but are justified by their own comments (no lsof/fuser in minimal containers; compose-style worktree isolation) and are internally consistent. Not flagged.
## Documentation audit

### docs/DATA-FLOW.md

- **HIGH — Outdated / contradiction — docs/DATA-FLOW.md:195-221.** Scenario 2 is headlined "Status: NOT IMPLEMENTED. The Tauri app currently connects only to local tmux sessions" and claims "No SSH library or tunnel management exists in the codebase." Remote SSH servers ARE implemented: `ssh_target()` / `tmux_argv(pty)` in `/tmuxy/packages/tmuxy-core/src/session.rs:93-111` wrap every tmux invocation as `ssh <TMUXY_SSH tail> tmux …`; saved servers live in `/tmuxy/packages/tmuxy-core/src/servers.rs` (`~/.config/tmuxy/servers.json`); the `tmuxy-connect` crate provides the add-server TUI; and `poll_connect_requests` in `/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:333` drives live reconnects. This directly contradicts the (up-to-date) TMUX.md:25-29 "Remote servers over SSH (desktop app)" section and NON-GOALS.md:83-85. Rewrite Scenario 2 as an implemented scenario referencing TMUX.md, deleting the "What would be needed / What exists today" speculation.
- **MED — Outdated — docs/DATA-FLOW.md:62,65-66.** "On connection failure: exponential backoff (100ms to 10s max), retries indefinitely" — the Tauri reconnect loop is bounded: `MAX_CONSECUTIVE_FAILURES: u32 = 5` in `/tmuxy/packages/tmuxy-tauri-app/src/monitor.rs:195`, after which it emits `tmux-fatal` (monitor.rs:421). "No explicit disconnect — the monitor runs for the app's lifetime" is also stale: the live socket switch (TMUX.md:23) tears the monitor down via a graceful `MonitorCommand::Shutdown` and reconnects to a different socket. Correct both bullets.
- **MED — Outdated — docs/DATA-FLOW.md:301-313.** The "Additional API Endpoints" table omits two live routes: `/api/themes` and `/api/images/{pane_id}/{image_id}` (`/tmuxy/packages/tmuxy-server/src/state.rs:306-307`). The image route is documented in RICH-RENDERING.md, so the table presented as the endpoint inventory is incomplete. Add both rows (or delete `/api/themes` per the server crate's dead-code finding).
- **LOW — Outdated — docs/DATA-FLOW.md:41.** The `TmuxAdapter` method list omits `onLog`, `onFatal`, `onClipboard`, `switchSession`, and `enumeratesSessions` (`/tmuxy/packages/tmuxy-ui/src/tmux/types.ts:320-350`). The last two are load-bearing for the sessions-tree feature described in TMUX.md:33. Update the list.
- **LOW — Broken reference — docs/DATA-FLOW.md:299.** `scripts/probe-spikes.mjs` — the actual path is `/tmuxy/packages/tmuxy-ui/scripts/probe-spikes.mjs` (PERFORMANCE.md:34 cites it correctly). Use the full path.

### docs/TMUX.md

- **HIGH — Outdated — docs/TMUX.md:128-130.** "Tauri Desktop App: Missing `new-window` Workaround … calls `executor::new_window()` which uses external `tmux new-window` without the workaround. This will crash tmux 3.5a." Fixed: the Tauri `new_window` command now delegates to `run_tmux_command` (`/tmuxy/packages/tmuxy-tauri-app/src/commands.rs:85-92`), which intercepts `new-window`/`neww` and pushes a `splitw ; breakp` rewrite through the control-mode channel (commands.rs:166-186); the external `executor::new_window` path survives only as an early-startup fallback before the CC connection exists. Delete or rewrite the section to describe the fallback-only residual risk (and the native-menu gap found in the Tauri crate review).
- **LOW/MED — Outdated / doc-vs-doc inconsistency — docs/TMUX.md:152-166.** The "tmux Configuration" section instructs users to set `aggressive-resize off` and `window-size manual` in `~/.tmux.conf` — the monitor enforces these itself per session (`/tmuxy/packages/tmuxy-core/src/control_mode/monitor.rs:335,419-420`; `.devcontainer/.tmuxy.defaults.conf:263-265` explicitly says "enforced per-session by the Rust server"). The `set -g terminal-features "hyperlinks"` line appears in no shipped config, and RICH-RENDERING.md:11 spells the same requirement differently (`"*:hyperlinks"`). Reword to "the server enforces these; no user config needed" and reconcile the hyperlinks claim between the two docs.
- **LOW — Low-value / outdated — docs/TMUX.md:215-217.** "JSON in tmux Environment Variables … Always use `jq -c`" — no code stores JSON in tmux env vars anymore (the `TMUXY_GROUPS` mechanism is gone; `jq -c` has zero hits under `bin/`). Remove or mark as historical.

### docs/STATE-MANAGEMENT.md

- **MED/HIGH — Outdated — docs/STATE-MANAGEMENT.md:318.** Sync rule 6: "Pane groups are stored in tmux's session-level environment variable (`TMUXY_GROUPS` as compact JSON). The backend reads this on state sync." `TMUXY_GROUPS` has zero hits in the entire repo; groups are now derived from the `@tmuxy-window-type=group` window option plus `@tmuxy-group-panes` membership (`/tmuxy/packages/tmuxy-core/src/control_mode/state.rs:549`, `/tmuxy/packages/tmuxy-ui/src/machines/app/helpers.ts:167-171`) — exactly the WINDOW-TAGS schema. Rewrite the bullet.
- **MED — Outdated — docs/STATE-MANAGEMENT.md:105.** "Five top-level states arranged as a connection lifecycle" followed by four bullets; the machine has exactly four (`connecting`/`idle`/`reconnecting`/`disconnected` at `/tmuxy/packages/tmuxy-ui/src/machines/app/appMachine.ts:543,587,1530,1574`). Fix the count.
- **MED — Outdated / missing coverage — docs/STATE-MANAGEMENT.md:143-150.** "The machine spawns three persistent actors" — it invokes five: `tmuxActor`, `tmuxStoreActor`, `keyboardActor`, `sizeActor`, `serversActor` (appMachine.ts:257-263). `serversActor` (the sessions-tree/server-picker poll) is entirely absent from this doc, as are its context fields `sessions`, `servers`, `sidebarOpen`, `sidebarFocused` (`/tmuxy/packages/tmuxy-ui/src/machines/types.ts:198-272`). Add the two actors and the sidebar/sessions context fields.

### docs/WINDOW-TAGS.md

- **HIGH — Outdated (plan doc presented as current truth) — docs/WINDOW-TAGS.md:5,45-155.** The doc calls itself "the canonical reference for the schema and the source of truth for the migration," but the migration it plans is finished and partially diverged. Done: the tag schema and auto-adopt exist (`/tmuxy/packages/tmuxy-core/src/control_mode/state.rs:549,1163-1174,1286`; all eight `@tmuxy-*` options in the table match code exactly), and the legacy name parsers slated for deletion in step E are already gone (zero hits). Never implemented: the "New single-step ops" `SetWindowType`/`UnsetWindowType`/`ResizePane` (the `TmuxOp` union at `/tmuxy/packages/tmuxy-ui/src/tmux/store/types.ts:68-84` has only the ten ops STATE-MANAGEMENT documents), the "New compound ops" `createFloat`/`closeFloat`/`createGroup`/`closeGroup`/`adoptWindow` (`compoundOps.ts` exports only `createAndRenameWindow` and `withTemporaryWindow`), and the `tmuxy tab adopt` CLI command (absent from `bin/tmuxy-cli`). All file:line references (monitor.rs:201,453,725; state.rs:521,529; lib.rs:296,316-340; helpers.ts:208-237; DemoTmux.ts line lists; TmuxStore.ts:161-241) are stale. Trim the doc to the accurate parts (Filtering rule + Schema + parent semantics) and delete or clearly archive the migration steps and unbuilt-ops sections.
- **MED — Doc-rule violation — docs/WINDOW-TAGS.md:86-88,110-124.** Inline project-specific code: the `list-windows` format string block and the migration pseudocode, plus dozens of hard `file.rs:NNN` line references — against CLAUDE.md's "No project-specific code in docs … Reference file paths instead" and docs/README.md:51. Replace with prose + file-path references.
- **LOW — Broken internal reference network.** WINDOW-TAGS.md is listed in neither docs/README.md's Document Guide nor CLAUDE.md's doc list, and no other doc links to it — despite TMUX.md and STATE-MANAGEMENT.md now depending on the tag schema it defines. Either link it (post-trim) or fold the schema into TMUX.md.

### docs/ARCHITECTURE.md

- **MED — Outdated — docs/ARCHITECTURE.md:76-86.** The "Crate layout" table omits two real crates: `tmuxy-connect` (the `tmuxy connect` server-picker TUI) and `tmuxy-tree` (the `tmuxy tree` tab/pane TUI, cross-compiled for the v86 guest and shipped inside tmuxy-server) — both under `/tmuxy/packages/`. Add rows.
- **LOW — Outdated — docs/ARCHITECTURE.md:64.** "XState owns UI-mode finite states (connecting / idle / removingPane, drag, resize, copy mode, command mode)" — there is no `removingPane` state; the only remaining reference is a comment about "the old removingPane 300ms hold" in `Sidebar.stories.tsx:153`. Actual top-level states are connecting/idle/reconnecting/disconnected. Correct the list.

### docs/RICH-RENDERING.md

- **MED — Broken reference — docs/RICH-RENDERING.md:17.** "The frontend `richContentParser.ts` / `RichContent.tsx` modules predate this work and are used only for widget markdown rendering" — neither file exists anywhere in the repo; widget markdown lives in `/tmuxy/packages/tmuxy-ui/src/components/widgets/TmuxyMarkdown.tsx`. Delete the sentence.
- **LOW — Slightly wrong attribution — docs/RICH-RENDERING.md:25.** "`set -g allow-passthrough on` … Tmuxy's bundled `~/.tmuxy.conf` sets this" — the option is enforced per-session by the Rust monitor (`/tmuxy/packages/tmuxy-core/src/control_mode/monitor.rs:399-400`), and the shipped `.tmuxy.defaults.conf:263-265` explicitly notes it is server-enforced, not conf-set. Also reconcile the `terminal-features "*:hyperlinks"` claim (line 11) with TMUX.md:165.

### docs/NON-GOALS.md

- **LOW/MED — Outdated — docs/NON-GOALS.md:81.** §9 says session switching happens via "`tmuxy session switch` and the status bar session picker." There is no session picker in `StatusBar.tsx`; the UI path is the sidebar sessions→tabs→panes tree (`/tmuxy/packages/tmuxy-ui/src/components/SidebarTree.tsx:177-184`, `SWITCH_SESSION`). Update the phrase to match TMUX.md:31-33.

### docs/README.md

- **MED — Missing entries — docs/README.md:15-47.** The Document Guide omits PERFORMANCE.md and WINDOW-TAGS.md, both of which exist in the directory (PERFORMANCE.md is even cross-referenced from ARCHITECTURE.md:98). A reader using the guide as the index will never find them. Add rows (or, for WINDOW-TAGS.md, first resolve its staleness above).

### docs/TESTS.md

- **LOW — Doc-rule tension — docs/TESTS.md:105-135.** The "Visual Verification Helpers" section embeds project-specific JS snippets (`.float-container` selectors, Playwright calls) despite the "no project-specific code in docs" convention. They are genuinely useful patterns; either genericize the selectors or explicitly exempt illustrative test patterns in the convention. Everything else in the doc verifies: CI jobs `unit-tests`/`storybook-probe`/`storybook-v86-probe` exist, the scripts `test-storybook`/`test-storybook:v86` exist, and the referenced files all exist.
- (See also the Tests section: TESTS.md:91-92 references a nonexistent `destroyViaAdapter()` helper and describes a per-`describe` session lifecycle that is actually per-test.)

### docs/COPY-MODE.md, docs/SECURITY.md, docs/PERFORMANCE.md

- **No inaccuracies found.** COPY-MODE.md's key-file table, event names, constants (`COPY_MODE_REENTRY_COOLDOWN`, chunk fetch via `get_scrollback_cells`) all check out. SECURITY.md's claims verify against code: constant-time compare (`/tmuxy/packages/tmuxy-server/src/auth.rs:34`), CORS `allow_origin(Any)` (`state.rs:310`), `0.0.0.0`/`9000` defaults and the off-box no-password warning (`server.rs:24-63`). PERFORMANCE.md's file references and the `metadata_delta_shares_content_and_omits_grids` lock-in test (`state.rs:3033`) all exist.

### README.md (root)

- **No inaccuracies found.** Install commands match the release workflow in CLAUDE.md; the architecture sketch matches ARCHITECTURE.md.

### CLAUDE.md

- **MED — Outdated — CLAUDE.md "Project Structure".** The packages tree omits three real packages: `tmuxy-wasm` (referenced by the root `build:wasm` script and ARCHITECTURE.md's crate table), `tmuxy-connect`, and `tmuxy-tree`. Add them so agents don't rediscover them by accident.
- **MED — Outdated — CLAUDE.md "CLI Usage".** The command reference omits three top-level nouns that `bin/tmuxy-cli`'s own usage lists: `tmuxy session` (switch/connect), `tmuxy nav <direction>`, and `tmuxy tree`. NON-GOALS.md:81 already references `tmuxy session switch`, so the omission creates a cross-doc gap. Add the three command groups.
- **LOW — Missing entries — CLAUDE.md doc list (header).** The "See docs/…" list omits PERFORMANCE.md and WINDOW-TAGS.md (same gap as docs/README.md). Add PERFORMANCE.md at minimum.

### Missing documentation (cross-cutting)

- **LOW/MED — No coverage for the `tmuxy-tree` and `tmuxy-connect` crates.** `tmuxy-tree` (standalone ratatui tab/pane tree TUI, cross-compiled into the v86 guest per its Cargo.toml) appears in no doc; `tmuxy-connect` gets a single parenthetical in TMUX.md:27. The event queue (`tmuxy event`, socket-namespaced FIFOs per TMUX.md:19) similarly has no doc beyond one CLAUDE.md line. A short "CLI companion tools" subsection in ARCHITECTURE.md or TMUX.md would close the gap.

