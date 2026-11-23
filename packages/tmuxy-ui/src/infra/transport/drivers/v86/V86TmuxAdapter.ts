/**
 * The guest adapter over a v86 machine. With `shared: true` many adapters (one
 * per story) reuse a single booted engine — each story restores the snapshot
 * it names for a clean start (~1s) instead of cold-booting (~5s). Default
 * (`shared` unset) owns a private engine and tears it down on disconnect.
 *
 * The machine loads /v86 (the emulator) and /v86-img (kernel, BIOS, the
 * machine states) from the page's origin.
 */
import { GuestTmuxAdapter, type GuestTmuxAdapterOptions } from '../guest/GuestTmuxAdapter';
import { getSharedEngine, V86Engine } from './V86Engine';
import { guestSnapshot, type GuestSnapshotName } from './v86Guest';

export interface V86TmuxAdapterOptions extends GuestTmuxAdapterOptions {
  shared?: boolean;
  /** The machine state each start restores, and the session in it the app
   *  attaches to: `generic` unless named (`v86Guest.ts`). */
  snapshot?: GuestSnapshotName;
}

export class V86TmuxAdapter extends GuestTmuxAdapter {
  constructor(options?: V86TmuxAdapterOptions) {
    const shared = options?.shared ?? false;
    super(
      shared ? getSharedEngine() : new V86Engine(),
      !shared,
      guestSnapshot(options?.snapshot ?? 'generic'),
      options,
    );
  }
}
