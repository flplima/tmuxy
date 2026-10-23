/**
 * The guest adapter over a v86 machine. With `shared: true` many adapters (one
 * per story) reuse a single booted engine — each story restores the pinned
 * snapshot for a clean start (~1s) instead of cold-booting (~5s). Default
 * (`shared` unset) owns a private engine and tears it down on disconnect.
 *
 * The machine loads /v86 (the emulator) and /v86-img (kernel, BIOS,
 * tmux-state.bin snapshot) from the page's origin.
 */
import { GuestTmuxAdapter, type GuestTmuxAdapterOptions } from '../guest/GuestTmuxAdapter';
import { getSharedEngine, V86Engine } from './V86Engine';

export interface V86TmuxAdapterOptions extends GuestTmuxAdapterOptions {
  /** Reuse a single process-wide v86 engine across adapters (opt-in). Each
   *  connect restores the pinned snapshot for a clean start instead of a cold
   *  boot. Leave unset for a private, torn-down-on-disconnect engine. */
  shared?: boolean;
}

export class V86TmuxAdapter extends GuestTmuxAdapter {
  constructor(options?: V86TmuxAdapterOptions) {
    const shared = options?.shared ?? false;
    super(shared ? getSharedEngine() : new V86Engine(), !shared, options);
  }
}
