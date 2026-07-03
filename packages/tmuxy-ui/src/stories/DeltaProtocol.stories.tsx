import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect } from 'storybook/test';

/**
 * Delta protocol — driven by the REAL tmuxy Rust core compiled to WASM (the same
 * `StateAggregator::to_state_update` the native server uses), fed a recorded
 * `tmux -CC` control-mode stream. No v86 boot needed: this is a pure,
 * deterministic exercise of the client-side state-update wire protocol.
 *
 * The aggregator emits a **full** `StateUpdate` on first sync, then **delta**
 * updates carrying only changed fields on subsequent changes. This story asserts
 * that full-then-delta sequence end to end through the WASM boundary.
 *
 * Tagged `spike` (loads the built `/wasm` bundle, like the other WASM/v86
 * stories) so it's excluded from the CI story probe.
 */

const WASM_JS = '/wasm/tmuxy_wasm.js';
const WASM_BG = '/wasm/tmuxy_wasm_bg.wasm';

interface FeedOut {
  updates: { type: string }[];
  commands: string[];
}
interface WasmCore {
  feed(text: string): FeedOut;
  tick(): FeedOut;
}
interface WasmModule {
  default(input?: string): Promise<unknown>;
  WasmTmux: new (session: string) => WasmCore;
}

// Initial control-mode stream establishing a 2-pane session — the first sync,
// which the aggregator reports as a FULL state.
const FULL_SYNC = [
  '%begin 1 1 0',
  '%end 1 1 0',
  '%session-changed $0 m',
  '%window-add @0',
  '%begin 2 2 1',
  '%0,0,0,0,40,24,0,0,1,zsh,,0,0,0,0,@0,,0,0,0,0,0,100',
  '%1,1,41,0,39,24,0,0,0,zsh,,0,0,0,0,@0,,0,0,0,0,0,100',
  '%end 2 2 1',
  '%layout-change @0 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} 8205,80x24,0,0{40x24,0,0,0,39x24,41,0,1} *',
  '',
].join('\n');

function DeltaHarness() {
  return <div data-testid="delta-harness">delta protocol — WASM core</div>;
}

const meta: Meta<typeof DeltaHarness> = {
  title: 'App/DeltaProtocol',
  component: DeltaHarness,
  tags: ['spike'],
  parameters: { layout: 'centered' },
};
export default meta;
type Story = StoryObj<typeof DeltaHarness>;

/**
 * First sync yields a `full` update; a subsequent single-field change (window
 * rename) yields a `delta` — proving the incremental wire protocol.
 */
export const FullThenDelta: Story = {
  play: async () => {
    const mod = (await import(/* @vite-ignore */ WASM_JS)) as unknown as WasmModule;
    await mod.default(WASM_BG);
    const core = new mod.WasmTmux('m');

    const types: string[] = [];
    const collect = (out: FeedOut) => out.updates.forEach((u) => types.push(u.type));

    // 1) Initial sync → the aggregator's first emit is a FULL snapshot.
    collect(core.feed(FULL_SYNC));
    expect(types[0]).toBe('full');

    // 2) A single-field change (rename window @0) → an incremental DELTA. Events
    // emit synchronously here (settling is never armed on the push path).
    collect(core.feed('%window-renamed @0 renamed\n'));

    expect(types).toContain('delta');
  },
};
