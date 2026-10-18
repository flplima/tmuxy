# Storybook Tests

The deterministic and v86 Storybook probes. Part of [TESTS.md](TESTS.md).

## Storybook Tests

Two tiers, cheapest first. All play functions follow the same rules as E2E tests (real user paths, visible-rect assertions, unique sentinels).

| Tier | What runs | Where |
| --- | --- | --- |
| Deterministic probe (`npm run test-storybook -w tmuxy-ui`) | Every non-`v86` story + its play function, fresh Chromium page each, 1280x800, 3 at a time | CI: `storybook-probe` (blocking) runs the commit tier — `PROBE_TIER=commit` leaves out stories tagged `nightly`, `PROBE_A11Y=0` skips the axe pass. Every story, with the axe pass, runs nightly in `nightly-v86.yml` (`deterministic`) |
| v86 probe (`npm run test-storybook:v86 -w tmuxy-ui`) | Every `v86`-tagged story on ONE shared page (real tmux in the x86 emulator, snapshot-reset between stories; periodic cold-boot to cap accumulated drift) | CI: `storybook-v86-probe` runs three gate stories (`split-optimistic-timeline`, `split-rejected-rollback`, `resize-pane-drag`), blocking. The full sweep moved to the nightly `nightly-v86.yml`, where it blocks and opens an issue |

The `v86` tier needs two gitignored artifact sets that Storybook mounts as static dirs (`.storybook/main.ts`): `packages/tmuxy-wasm/pkg` from `npm run build:wasm` (needs the `wasm32-unknown-unknown` target and a `wasm-bindgen` CLI matching the version in `Cargo.lock`), and `packages/tmuxy-ui/v86-assets` from `npm run fetch:v86-image -w tmuxy-ui` plus `npm run build:v86-snapshot -w tmuxy-ui` (needs the `i686-unknown-linux-musl` target for the guest `tmuxy-tree` and `zstd`). Without them the `V86AppHarness` stories render the app's Connection Error screen with a failed dynamic import of `/wasm/tmuxy_wasm.js`. Both directories must at least exist for Storybook to start; the `storybook-probe` CI job creates them empty because it only runs the deterministic tier. The `v86` tag is set at the meta level of a story file; `probe-stories.mjs` excludes it and `probe-spikes.mjs` selects it. The `nightly` tag is set per story (`tags: ['nightly']` on the export) and is the story-side of [Tiers](TESTS-LAYERS.md#tiers-per-commit-nightly-and-before-a-release): frame-sampled animations, render-count budgets and language sweeps carry it, and `PROBE_TIER` decides whether a run takes them.

**Seeing the raw tmux TUI.** The toolbar's "tmux view" global (`.storybook/preview.ts`, decorator in `src/stories/tmuxView.tsx`) attaches a second, read-only tmux client on the guest's VGA console and shows v86's rendering of it — tmux drawing its own borders, status line and cursor, no tmuxy code involved — either beside the story or as a cell-aligned translucent overlay. It applies to the shared-engine `Scenarios/Application` stories; use it to eyeball what tmux thinks the screen looks like versus what tmuxy rendered.

Both probes expect a running Storybook (`npm run storybook -w tmuxy-ui`). CI runs the **dev** server (no build step needed; on-demand compilation). Filter either probe to specific stories by id substring: `npm run test-storybook:v86 -w tmuxy-ui -- split-optimistic resize-pane-drag`. Set `PROBE_TIMINGS_JSON=<path>` to write per-story timings. The fonts a story's wide-glyph checks depend on are `bin/chromium-fonts` — the list CI installs and `bin/install-dev-tools` installs in a container, so the two measure a CJK or emoji cell the same way; a host without them sees every fullwidth glyph as a narrow fallback and fails those stories for a reason that has nothing to do with the code.

### When the probe goes red

The probe used to report `playFunctionThrewException` and nothing else, which is why it became the single biggest source of red `main`. It now writes a screenshot, a DOM dump and the real error with its stack to `packages/tmuxy-ui/probe-artifacts/` (gitignored, uploaded by CI on failure), and prints page and console errors.

To reproduce a CI failure locally, the knobs are `PROBE_REPEAT`, `PROBE_CONCURRENCY`, `PROBE_CPU_THROTTLE` (renderer throttling — a loaded runner is usually what a "flaky" story is actually reacting to) and `PROBE_A11Y=0`.

**Quarantine** (`packages/tmuxy-ui/scripts/probe-quarantine.json`) is the one way a known failure stops gating, and it is deliberately hard to abuse: every entry needs a reason and a `YYYY-MM-DD` expiry, after which it blocks again; there is a hard cap on how many entries may exist; and a malformed or over-cap file makes the probe exit without running anything. A quarantined story still runs and is still reported — it just does not fail the job, and it is listed as ready to remove once it passes.

A quarantined story that fails by **timing out** is the one kind quarantine must not hide: it sits at the per-story deadline on every push, reports nothing new, and once cost the commit probe two minutes a run for weeks before anyone looked. Its entry carries `failure: "probe-timeout"`, and the story must then also carry the `nightly` tag — the commit-tier probe refuses to run otherwise. The probe prints the ten slowest stories of every run, and names any shielded timeout whose entry does not declare it.

### Accessibility

Every story is scanned with axe-core (already installed via `@storybook/addon-a11y`) once its play function settles — nightly, in the `deterministic` job of `nightly-v86.yml`; the per-commit probe sets `PROBE_A11Y=0`, since the scan was a third of its time and every blocking rule is quarantined for now. **`critical` and `serious` violations fail the job; `moderate` and `minor` are printed only.** A story that navigates its own page is recorded as skipped rather than failed. `Mocked App/Sidebar → TabOrderNeverTrapsTheKeyboard` is the keyboard-only check: it tabs through the chrome and asserts focus moves, is visible at every stop, never repeats before wrapping and is never trapped.

### Choosing a harness

Both are in `src/stories/StoryHarness.tsx`.

- **`AppHarness` / `ProviderHarness`** (DemoAdapter, deterministic): component behavior, optimistic-update timing that needs controlled latency (`commandDelayMs`) or forced rejections (`failCommand`), render budgets.
- **`V86AppHarness`** (real tmux): anything whose bugs live in the real chain — command transport, control-mode parsing, reconcile timing, `%output` rendering. If a story asserts "tmux did X", it belongs here.

### Immediacy assertions (optimistic rendering)

"Immediate" is measured, not assumed: arm `armPaintProbe` (`src/stories/immediacy.ts`) just before the input, and assert the first matching DOM mutation lands within a few animation frames (≤5 absorbs userEvent dispatch overhead; a real round-trip takes dozens). A painted `__placeholder_*` pane id is itself proof of optimism — the server never emits one. After the optimistic paint, assert the reconcile is invisible: no pane-node removals (`LayoutMutationRecorder`), no highlight flaps (record the class/attribute history with a MutationObserver — polling misses one-frame reverts).

### Glitch budgets

`src/stories/glitchRecorder.ts` is the one glitch detector: MutationObserver-based node-flicker/attribute-churn detection plus rect sampling for size jumps, with the collector (runs in the page) separate from the classifier (pure). Stories use its `GlitchRecorder` in-page; the Jest helper `tests/helpers/glitch-detector.js` loads the same file through Node's own loader (Node strips the types, so the file keeps to erasable syntax), serialises the collector into the page with Playwright and classifies the recording in Node. Budgets are code: one `src/stories/glitch-thresholds.json` — loosening a budget is a reviewable diff, not a silent drift.

`src/stories/resizeGlitch.ts` (`ResizeGlitchRecorder`) is the resize-specific counterpart: it logs every pane's `top`/`left`/`width`/`height` — from both the inline-`style` MutationObserver (every React commit, so a 1-frame revert can't hide) and an rAF rect sampler — and flags any A→B→A _reversal_. A threshold-on-consecutive-frames detector misses these; a value that leaves and returns does not. It samples the outer box (top/left/width/height, via style + rAF) AND each pane's terminal-content top (`[role=log]`) — the content shifts a row when the header appears/disappears even while the box stays the same size. Because the resize stories drive a MONOTONIC drag, any reversal is a real glitch: a mid-drag grid shift, the pane flashing back to an old size after mouse-up, or an uninvolved pane's content jumping up a row. See `Scenarios/Application` → `ResizePaneDrag` (horizontal), `ResizePaneDragVertical` (stacked), `ResizePaneDragGrid` (2x2 tiled — a whole-band resize).

### Render budgets

`src/utils/renderLog.tsx` places `LogProfiler` markers inside key components; each marker records one entry per RENDER of its host component to `window.__tmuxyRenderLog` when a story enables it (`enableRenderLog()` before mount). Budgets assert render counts per component id (e.g. typing into pane A must not render `Pane:B` or `WindowTabs`). React's own `<Profiler onRender>` is deliberately not used — it over-reports in this tree, firing for subtrees that fully bailed out. MutationObserver cannot see this class of waste — a re-render that produces identical DOM still costs CPU.
