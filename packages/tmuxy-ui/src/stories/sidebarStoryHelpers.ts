import { waitFor } from 'storybook/test';

export interface AppSnap {
  context: {
    activePaneId: string | null;
    activeWindowId: string | null;
    charWidth: number;
    windows: Array<{
      id: string;
      index: number;
      name: string;
      windowType: string | null;
      sidebarCols?: number | null;
    }>;
    panes: Array<{ tmuxId: string; windowId: string; width: number }>;
    sessions: Array<{ sessionName: string }>;
  };
}
export const app = () =>
  (window as unknown as { app: { getSnapshot(): AppSnap } }).app.getSnapshot();

/**
 * The panes that belong to TABS — the only ones the tree lists.
 *
 * `context.panes` also holds each sidebar column's own pane (the left column
 * runs the tree widget in a `sidebar-left` window), and the tree filters those
 * out along with floats — it would otherwise list itself.
 */
export function tabPanes() {
  const tabWindowIds = new Set(
    app()
      .context.windows.filter((w) => w.windowType === 'tab')
      .map((w) => w.id),
  );
  return app().context.panes.filter((p) => tabWindowIds.has(p.windowId));
}

/** Wait until the sidebar drawer + tree portal into document.body. */
export async function waitForTree(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector('.sidebar-tree') as HTMLElement | null;
      if (!el) throw new Error('no .sidebar-tree yet');
      return el;
    },
    { timeout: 8000 },
  );
}

export function rightClick(el: HTMLElement): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
  );
}

export const menuLabels = (): string[] =>
  [...document.querySelectorAll('[role="menuitem"]')].map((n) => n.textContent ?? '');
