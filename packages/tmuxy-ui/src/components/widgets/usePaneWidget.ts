/**
 * Resolve the widget a pane is running, for components that are not the widget
 * itself — the pane menu in particular, which hangs off the header and has
 * only a pane id to go on.
 *
 * Detection is the same `detectWidget` scan `usePaneWidgetInfo` runs for the
 * pane body, so the menu and the pane agree about what a pane is showing. It
 * skips that hook's latch over transiently empty content: a menu reads the
 * pane once, while it is open.
 */

import { useAppActor, usePane } from '../../machines/AppContext';
import { detectWidget, getWidget, type WidgetDefinition, type WidgetMenuItem } from './index';

interface PaneWidget {
  name: string;
  definition: WidgetDefinition;
  /** The widget's content lines, below the marker. */
  lines: string[];
}

function usePaneWidget(paneId: string | null | undefined): PaneWidget | null {
  const pane = usePane(paneId ?? '');
  if (!pane) return null;
  const info = detectWidget(pane.content, pane.paneWidget);
  if (!info) return null;
  const definition = getWidget(info.widgetName);
  if (!definition) return null;
  return { name: info.widgetName, definition, lines: info.contentLines };
}

const NO_ITEMS: WidgetMenuItem[] = [];

/**
 * The widget-specific pane menu items for a pane, or an empty list.
 *
 * Read from a snapshot rather than subscribed to: a menu is mounted only while
 * it is open and closes on the first click, so there is nothing to keep live —
 * and a selector that built a fresh array every tick would re-render the menu
 * on every model update for no gain.
 */
export function useWidgetMenuItems(paneId: string | null | undefined): WidgetMenuItem[] {
  const actor = useAppActor();
  const widget = usePaneWidget(paneId);
  if (!paneId || !widget?.definition.selectMenuItems) return NO_ITEMS;
  return widget.definition.selectMenuItems(actor.getSnapshot().context, paneId, widget.lines);
}
