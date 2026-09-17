/**
 * The `session` widget's contributions to the pane chrome it does not own:
 * the tab icon and title, and its section of the ⋮ pane menu.
 *
 * No `onKeyDown` here — the switcher owns a selection cursor, so it handles
 * keys itself with a capture-phase listener (see TmuxySession), the way the
 * sidebar tree does. That hook is stateless and cannot move a cursor.
 */

import type { WidgetDefinition, WidgetMenuItem } from '../index';
import { TmuxySession } from './TmuxySession';

/**  nf-fa-server — the switcher is about sessions and the servers holding them. */
const SERVER_ICON = '';

export const sessionWidget: WidgetDefinition = {
  component: TmuxySession,
  icon: SERVER_ICON,
  selectTitle: () => 'Sessions',
  selectMenuItems: (): WidgetMenuItem[] => [
    {
      id: 'session-detach',
      label: 'Detach Session',
      keyHint: 'd',
      event: { type: 'DETACH_CLIENT' },
    },
    {
      id: 'session-close-switcher',
      label: 'Close Switcher',
      keyHint: 'esc',
      event: { type: 'CLOSE_TOP_FLOAT' },
    },
  ],
};
