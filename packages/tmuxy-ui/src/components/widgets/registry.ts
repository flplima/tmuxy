import type { ComponentType } from 'react';
import { selectPaneWidget } from '../../machines/selectors/paneWidget';
import type { PaneWidget } from '../../domain/paneWidget';
import type { AppMachineContext } from '../../machines/types/context';
import type { AppMenuSpec } from '../menus/specs/actions';
import type { PaneId } from '../../domain/ids';

export interface WidgetProps {
  paneId: PaneId;
  /** The pane's text lines below the widget marker. */
  lines: string[];
}

/**
 * What a widget contributes to the pane chrome it does not own: the tab title,
 * the process icon and the ⋮ menu.
 */
export interface WidgetDefinition {
  component: ComponentType<WidgetProps>;
  /** Nerd-font glyph for the pane tab, in place of the process icon. */
  icon?: string;
  /**
   * Pane tab title. When absent, or when it returns undefined, the tab shows
   * the pane's own title the way a terminal pane does.
   */
  selectTitle?: (context: AppMachineContext, paneId: PaneId, lines: string[]) => string | undefined;
  /**
   * The widget's section of the pane menu, above the generic items. Derived from
   * context: the menu hangs off the header, a sibling of the widget, not its child.
   */
  selectMenuItems?: (context: AppMachineContext, paneId: PaneId, lines: string[]) => AppMenuSpec;
}

/**
 * The widgets this build draws, by the name `tmuxy-widget` prints. Filled by
 * `builtins.ts`, which App.tsx loads: this module imports no widget, since
 * the widgets' own components reach back here for the pane menu and the tab.
 */
const widgets: Record<string, WidgetDefinition> = {};

/** Draw panes whose widget is `name` with `definition`. */
export function registerWidget(name: string, definition: WidgetDefinition): void {
  widgets[name] = definition;
}

function widgetDefinitions(): Record<string, WidgetDefinition> {
  return widgets;
}

export interface RegisteredPaneWidget extends PaneWidget {
  definition: WidgetDefinition;
}

/**
 * The widget a pane is showing and its definition, or null when the pane draws
 * as a terminal — no widget (`selectPaneWidget`), or one this build does not
 * draw.
 */
export function paneWidgetOf(
  pane: Parameters<typeof selectPaneWidget>[0],
): RegisteredPaneWidget | null {
  const widget = selectPaneWidget(pane);
  const definition = widget ? widgetDefinitions()[widget.name] : undefined;
  return widget && definition ? { ...widget, definition } : null;
}
