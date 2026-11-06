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
 * Everything the app needs to know about a widget beyond how it draws.
 *
 * A widget renders inside a pane it does not own the chrome of: the tab title,
 * the process icon and the ⋮ menu all belong to shared components. Rather than teaching each of those about each widget, a widget
 * declares its contributions here and they are picked up by name.
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
   * The widget's own section of the pane menu, above the generic pane items.
   * Pure data derived from machine context, so the menu can show what the
   * widget can currently do (an action greyed out when it has nothing to act
   * on) without reaching into the widget component — which is a sibling of
   * the header the menu hangs off, not an ancestor.
   */
  selectMenuItems?: (context: AppMachineContext, paneId: PaneId, lines: string[]) => AppMenuSpec;
}

// Registry of widget name -> definition
const widgetRegistry: Record<string, WidgetDefinition> = {};

export function registerWidget(name: string, definition: WidgetDefinition) {
  widgetRegistry[name] = definition;
}

export function getWidget(name: string): WidgetDefinition | undefined {
  return widgetRegistry[name];
}

export interface RegisteredPaneWidget extends PaneWidget {
  definition: WidgetDefinition;
}

/**
 * The widget a pane is showing and its definition, or null when the pane draws
 * as a terminal — no widget (`selectPaneWidget`), or one this build does not
 * register.
 */
export function paneWidgetOf(
  pane: Parameters<typeof selectPaneWidget>[0],
): RegisteredPaneWidget | null {
  const widget = selectPaneWidget(pane);
  const definition = widget ? widgetRegistry[widget.name] : undefined;
  return widget && definition ? { ...widget, definition } : null;
}
