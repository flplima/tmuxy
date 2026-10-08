import type { ComponentType } from 'react';
import type { PaneContent } from '../../domain/wire';
import type { AppMachineContext, AppMachineEvent } from '../../machines/types';
import type { PaneId } from '../../domain/ids';

export interface WidgetProps {
  paneId: PaneId;
  widgetName: string;
  lines: string[];
  lastLine: string;
  rawContent: PaneContent;
  writeStdin: (data: string) => void;
  width: number;
  height: number;
}

/**
 * One entry in a widget's own section of the pane menu.
 *
 * Items are pure data derived from machine context, so the menu can show what
 * the widget can currently do (a `Back` greyed out with nowhere to go) without
 * reaching into the widget component — which is a sibling of the header the
 * menu hangs off, not an ancestor.
 */
export interface WidgetMenuItem {
  /** Stable id — the React key, and what tests click by. */
  id: string;
  label: string;
  /** Right-aligned key hint (e.g. `ctrl+r`) for actions with a shortcut. */
  keyHint?: string;
  disabled?: boolean;
  /** Dispatched on the app machine when the item is chosen. */
  event: AppMachineEvent;
}

/** What a widget's key handler is given to act with. */
export interface WidgetKeyContext {
  paneId: PaneId;
  lines: string[];
  context: AppMachineContext;
  send: (event: AppMachineEvent) => void;
}

/**
 * Everything the app needs to know about a widget beyond how it draws.
 *
 * A widget renders inside a pane it does not own the chrome of: the tab title,
 * the process icon, the ⋮ menu and the key routing all belong to shared
 * components. Rather than teaching each of those about each widget, a widget
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
  /** The widget's own section of the pane menu, above the generic pane items. */
  selectMenuItems?: (
    context: AppMachineContext,
    paneId: PaneId,
    lines: string[],
  ) => WidgetMenuItem[];
  /**
   * Keys the widget claims, handled capture-phase in `WidgetPane` before the
   * keyboard actor forwards anything to tmux. Return true when handled.
   */
  onKeyDown?: (event: KeyboardEvent, ctx: WidgetKeyContext) => boolean;
}

// Registry of widget name -> definition
const widgetRegistry: Record<string, WidgetDefinition> = {};

export function registerWidget(name: string, definition: WidgetDefinition) {
  widgetRegistry[name] = definition;
}

export function getWidget(name: string): WidgetDefinition | undefined {
  return widgetRegistry[name];
}

// Detect widget marker from CellLine[]
const WIDGET_MARKER_PREFIX = '__TMUXY_WIDGET__:';

/**
 * Which widget a pane is showing, if any.
 *
 * `authorizedWidget` is the pane's `@tmuxy-pane-widget` option, written by
 * `tmuxy-widget` out of band. It is required, because the marker itself
 * travels in pane OUTPUT: `cat` of a crafted file, a commit message in
 * `git log`, `curl` output or an ssh MOTD could otherwise replace the pane
 * with a browser widget pointed at an attacker's page — an iframe, inside the
 * terminal, that looks like the terminal. Nothing in the content authorises
 * anything; the option says the user asked for this widget in this pane.
 */
export function detectWidget(
  content: PaneContent,
  authorizedWidget: string | null | undefined,
): { widgetName: string; contentLines: string[] } | null {
  if (content.length === 0) return null;
  // The authorisation is the whole question. It is a tmux pane option, set out
  // of band by `tmuxy-widget` and cleared on its way out, so no amount of pane
  // output can produce or change it.
  if (!authorizedWidget) return null;

  if (!widgetRegistry[authorizedWidget]) return null;

  // Scan all lines for the marker (it may not be at line 0 if run from a shell)
  for (let i = 0; i < content.length; i++) {
    const lineText = content[i]
      .map((cell) => cell.c)
      .join('')
      .trim();
    if (lineText.startsWith(WIDGET_MARKER_PREFIX)) {
      const widgetName = lineText.slice(WIDGET_MARKER_PREFIX.length).trim();
      if (!widgetName || !widgetRegistry[widgetName]) continue;
      // The marker must name the widget the pane was tagged for. A pane
      // legitimately running one widget must not be turned into another by
      // something it prints.
      if (widgetName !== authorizedWidget) continue;

      // Content lines are everything after the marker line
      const contentLines = content.slice(i + 1).map((line) =>
        line
          .map((cell) => cell.c)
          .join('')
          .trimEnd(),
      );

      return { widgetName, contentLines };
    }
  }

  // No marker on screen means this is not a widget pane: a widget prints its
  // marker once and then sleeps, so a tag with no marker is a stale tag over a
  // live shell — a widget killed without its EXIT trap running. Showing a
  // widget over that shell would be worse than showing nothing.
  return null;
}
