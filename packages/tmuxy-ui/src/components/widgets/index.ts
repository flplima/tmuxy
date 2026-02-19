import type { ComponentType } from 'react';
import type { PaneContent } from '../../tmux/types';

export interface WidgetProps {
  paneId: string;
  widgetName: string;
  lines: string[];
  lastLine: string;
  rawContent: PaneContent;
  writeStdin: (data: string) => void;
  width: number;
  height: number;
}

// Registry of widget name -> component
const widgetRegistry: Record<string, ComponentType<WidgetProps>> = {};

export function registerWidget(name: string, component: ComponentType<WidgetProps>) {
  widgetRegistry[name] = component;
}

export function getWidget(name: string): ComponentType<WidgetProps> | undefined {
  return widgetRegistry[name];
}

// Detect widget marker from CellLine[]
const WIDGET_MARKER_PREFIX = '__TMUXY_WIDGET__:';

export function detectWidget(content: PaneContent): { widgetName: string; contentLines: string[] } | null {
  if (content.length === 0) return null;

  // Scan all lines for the marker (it may not be at line 0 if run from a shell)
  for (let i = 0; i < content.length; i++) {
    const lineText = content[i].map(cell => cell.c).join('').trim();
    if (lineText.startsWith(WIDGET_MARKER_PREFIX)) {
      const widgetName = lineText.slice(WIDGET_MARKER_PREFIX.length).trim();
      if (!widgetName || !widgetRegistry[widgetName]) continue;

      // Content lines are everything after the marker line
      const contentLines = content.slice(i + 1).map(line =>
        line.map(cell => cell.c).join('').trimEnd()
      );

      return { widgetName, contentLines };
    }
  }

  return null;
}
