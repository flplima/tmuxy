import { useAppActor, usePane } from '../../machines/appHooks';
import { paneWidgetOf } from './registry';
import type { AppMenuSpec } from '../menus/specs/actions';
import type { PaneId } from '../../domain/ids';

const NO_ITEMS: AppMenuSpec = [];

/** Read from a snapshot, not subscribed to: a menu lives only while it is open. */
export function useWidgetMenuItems(paneId: PaneId | null | undefined): AppMenuSpec {
  const actor = useAppActor();
  const widget = paneWidgetOf(usePane(paneId ?? null));
  if (!paneId || !widget?.definition.selectMenuItems) return NO_ITEMS;
  return widget.definition.selectMenuItems(actor.getSnapshot().context, paneId, widget.lines);
}
