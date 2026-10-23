/**
 * The guest adapter over a CheerpX machine (see `CheerpXEngine`), which it
 * owns and tears down on disconnect. The machine loads /cheerpx-img (the
 * guest's ext2 image) from the page's origin and CheerpX from its CDN.
 */
import { GuestTmuxAdapter, type GuestTmuxAdapterOptions } from '../guest/GuestTmuxAdapter';
import { CheerpXEngine } from './CheerpXEngine';

export class CheerpXTmuxAdapter extends GuestTmuxAdapter {
  constructor(options?: GuestTmuxAdapterOptions) {
    super(new CheerpXEngine(), true, options);
  }
}
