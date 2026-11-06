/**
 * Config beats menu state. The menus change some `@tmuxy-*` options and
 * remember the choice; one the user's `tmuxy.conf` sets is pinned instead
 * (tmuxy-core `pinned_options_in`): the backend neither restores a remembered
 * choice over it nor lets the menu change it, and lists it in the theme
 * settings' `pinned`. The menus show it greyed out and say where it is set.
 */

import { MANAGED_OPTIONS } from './tmuxyConstants.gen';

/** The options a menu changes, by what the client calls them (tmuxy-core `session::ManagedOption`). */
export const PINNABLE = MANAGED_OPTIONS;

export const PINNED_SUFFIX = ' (set in tmuxy.conf)';

export function pinnedLabel(label: string, pinned: boolean): string {
  return pinned ? `${label}${PINNED_SUFFIX}` : label;
}
