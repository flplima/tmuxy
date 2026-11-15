import { describe, expect, it, vi } from 'vitest';
import { backendCall } from '../../../../../domain/backendCalls';
import { GuestTmuxAdapter } from '../GuestTmuxAdapter';
import { GuestEngine, type EngineSink } from '../GuestEngine';
import { EMPTY_STATE } from '../controlMode';

/** A machine that resets at once: what is under test is what reaches the app. */
class InstantEngine extends GuestEngine {
  send = vi.fn();
  protected async doBoot(): Promise<void> {}
  protected async doReset(): Promise<void> {}
  protected teardown(): void {}
  currentSink(): EngineSink | null {
    return this.sink;
  }
  /** A state the core streamed, as the resize to the viewport streams them. */
  stream(width: number): void {
    this.sink?.onState({ ...EMPTY_STATE, total_width: width });
  }
}

const shrinkToNothing = backendCall('set_client_size', { cols: 10, rows: 5 });

describe('the first state', () => {
  it('is the one sized to the viewport, not one streamed on the way to it', async () => {
    const engine = new InstantEngine();
    const adapter = new GuestTmuxAdapter(engine, true);
    const widths: number[] = [];
    adapter.events.subscribe((event) => {
      if (event._tag === 'State') widths.push(event.state.total_width);
    });

    await adapter.connect();
    engine.stream(80);
    vi.spyOn(engine, 'resize').mockImplementation(async () => engine.stream(40));
    await adapter.send(backendCall('get_initial_state', { cols: 64, rows: 20 }));
    expect(widths).toEqual([]);

    engine.stream(64);
    expect(widths).toEqual([64]);
  });
});

describe('two stories on one shared guest engine', () => {
  it("leaves the next story's tmux to the next story while the previous app unmounts", async () => {
    const engine = new InstantEngine();
    const resize = vi.spyOn(engine, 'setClientSize');
    const previous = new GuestTmuxAdapter(engine, false);
    const next = new GuestTmuxAdapter(engine, false);

    await previous.connect();
    await previous.send(backendCall('set_client_size', { cols: 40, rows: 30 }));
    expect(resize).toHaveBeenLastCalledWith(40, 30);
    expect(engine.currentSink()).not.toBeNull();

    // From the moment the next story starts, before its reset is done, the
    // previous app's last report (its box shrunk to nothing) goes nowhere and
    // it hears nothing of the next story's machine.
    const connecting = next.connect();
    expect(engine.currentSink()).toBeNull();
    await expect(previous.send(shrinkToNothing)).resolves.toBeNull();
    await connecting;
    await expect(previous.send(shrinkToNothing)).resolves.toBeNull();
    previous.disconnect();

    await next.send(backendCall('set_client_size', { cols: 64, rows: 20 }));
    expect(resize.mock.calls).toEqual([
      [40, 30],
      [64, 20],
    ]);
    expect(engine.currentSink()).not.toBeNull();
  });
});
