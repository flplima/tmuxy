/**
 * Config beats menu state.
 *
 * The menus change five `@tmuxy-*` options and remember the choice. One the
 * user's `tmuxy.conf` sets is pinned instead (tmuxy-core `pinned_options_in`):
 * the backend neither puts a remembered choice back over it nor lets the menu
 * change it, and lists it in the theme settings' `pinned`. The menus show such
 * an option greyed out and say where it is set.
 */

import { MANAGED_OPTIONS } from './tmuxyConstants.gen';

/** The options a menu changes, by what the client calls them (tmuxy-core `session::ManagedOption`). */
export const PINNABLE = MANAGED_OPTIONS;

/** What a menu item for a pinned option says after its label. */
export const PINNED_SUFFIX = ' (set in tmuxy.conf)';

/** A menu label, marked when its option is pinned. */
export function pinnedLabel(label: string, pinned: boolean): string {
  return pinned ? `${label}${PINNED_SUFFIX}` : label;
}
