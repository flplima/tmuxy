/**
 * The widget section of a pane's menu, for the pane menu which hangs off the
 * header and has only a pane id to go on.
 */

import { useAppActor, usePane } from '../../machines/appHooks';
import { paneWidgetOf } from './registry';
import type { AppMenuSpec } from '../menus/specs/actions';
import type { PaneId } from '../../domain/ids';

const NO_ITEMS: AppMenuSpec = [];

/**
 * The widget-specific pane menu items for a pane, or an empty list.
 *
 * Read from a snapshot rather than subscribed to: a menu is mounted only while
 * it is open and closes on the first click, so there is nothing to keep live —
 * and a selector that built a fresh array every tick would re-render the menu
 * on every model update for no gain.
 */
export function useWidgetMenuItems(paneId: PaneId | null | undefined): AppMenuSpec {
  const actor = useAppActor();
  const widget = paneWidgetOf(usePane(paneId ?? null));
  if (!paneId || !widget?.definition.selectMenuItems) return NO_ITEMS;
  return widget.definition.selectMenuItems(actor.getSnapshot().context, paneId, widget.lines);
}
