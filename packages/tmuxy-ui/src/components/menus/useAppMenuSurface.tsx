/**
 * What the application menu needs beyond its spec, shared by the hamburger
 * and the native menu bar: the dispatch with the surface's own verbs (the
 * dialogs, the clipboard, the desktop window verbs that answer with the OS),
 * the Window submenu's fetched lists, and the dialogs themselves.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Modal } from '../Modal';
import { useAppSend, useAppActor, useAppSelector } from '../../machines/AppContext';
import { isTauri } from '../../utils/platform';
import { copyAppState, type ClipboardReport } from '../../utils/copyAppState';
import {
  closeGuiWindow,
  focusGuiWindow,
  getWindowStyle,
  listGuiWindows,
  newGuiWindow,
  quitApp,
  revealLogFile,
  setWindowStyle,
  type GuiWindowInfo,
  type WindowStyleSlug,
} from '../../utils/guiWindows';
import { windowMenuSpec } from '../../domain/menus/windowMenu';
import type { AppMenuOptions } from '../../domain/menus/appMenu';
import type { MenuEnv, MenuNode } from '../../domain/menus/spec';
import { useMenuDispatch, type MenuDispatch } from './SpecMenu';
import { useWidgetMenuItems } from '../widgets/usePaneWidget';
import { activeCloseTarget } from './menuActions';
import { APP_VERSION } from '../../version';
import './AppMenu.css';

export interface AppMenuSurface {
  dispatch: MenuDispatch;
  /** What the spec builders take: the active pane's widget items and the Window submenu. */
  options: AppMenuOptions;
  /** Re-read the Window submenu's lists (windows come and go from other windows). */
  refreshWindows: () => void;
  /** The dialogs the menu opens, rendered at the body so they cover the page. */
  dialogs: ReactNode;
}

export function useAppMenuSurface(env: MenuEnv): AppMenuSurface {
  const send = useAppSend();
  const actor = useAppActor();
  const activePaneId = useAppSelector((c) => c.activePaneId);
  const focusedFloatPaneId = useAppSelector((c) => c.focusedFloatPaneId);
  const sessionName = useAppSelector((c) => c.sessionName);
  const tracePath = useAppSelector((c) => c.traceSettings?.path ?? null);
  // Widgets contribute their own items for whichever pane is active, the same
  // section the pane's ⋮ menu shows.
  const widgetItems = useWidgetMenuItems(activePaneId);

  // The desktop's Window submenu: both lists are read on demand rather than
  // held, since windows come and go from other windows and the style is the
  // OS's answer.
  const [windows, setWindows] = useState<GuiWindowInfo[]>([]);
  const [style, setStyle] = useState<WindowStyleSlug>('normal');
  const refreshWindows = useCallback(() => {
    if (!isTauri()) return;
    void listGuiWindows().then(setWindows);
    void getWindowStyle().then(setStyle);
  }, []);
  useEffect(refreshWindows, [refreshWindows]);

  // The two dialogs the menu opens: one asks before a destructive act, the
  // other says which build this is.
  const [confirmKill, setConfirmKill] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  const report: ClipboardReport = {
    onCopied: (text) => send({ type: 'SHOW_STATUS_MESSAGE', text }),
    onFailed: (text) => send({ type: 'NOTIFY', text }),
  };

  const dispatch = useMenuDispatch({
    closeTarget: activeCloseTarget(activePaneId, focusedFloatPaneId),
    onLocal: (id) => {
      if (id === 'confirm-kill-session') setConfirmKill(true);
      else if (id === 'about') setAboutOpen(true);
      else if (id === 'debug-copy-state') copyAppState(actor.getSnapshot().context, report);
      else if (id === 'trace-copy-path') copyTracePath(tracePath, report);
      else if (id === 'help-reveal-log-file') revealLogFile();
      else if (id === 'window-refresh') refreshWindows();
      else if (id === 'window-new') newGuiWindow();
      else if (id === 'window-close') closeGuiWindow();
      else if (id === 'quit') quitApp();
      else if (id.startsWith('window-style:')) {
        const slug = id.slice('window-style:'.length) as WindowStyleSlug;
        setWindowStyle(slug);
        setStyle(slug);
      } else if (id.startsWith('window-focus:'))
        focusGuiWindow(Number(id.slice('window-focus:'.length)));
    },
  });

  // OS windows are the desktop app's to manage; a browser tab has none.
  const windowMenu: MenuNode | undefined = isTauri()
    ? windowMenuSpec(env, { windows, style })
    : undefined;

  const dialogs = (
    <>
      {confirmKill &&
        createPortal(
          <Modal open title="Kill Session" width={360} onClose={() => setConfirmKill(false)}>
            <p className="app-menu-dialog-text">
              Kill session <strong>{sessionName}</strong>? Every window and pane in it closes, and
              what is running in them is ended.
            </p>
            <div className="app-menu-dialog-actions">
              <button type="button" onClick={() => setConfirmKill(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="is-destructive"
                onClick={() => {
                  setConfirmKill(false);
                  dispatch({ kind: 'action', id: 'session-kill' });
                }}
              >
                Kill Session
              </button>
            </div>
          </Modal>,
          document.body,
        )}
      {aboutOpen &&
        createPortal(
          <Modal open title="About tmuxy" width={360} onClose={() => setAboutOpen(false)}>
            <p className="app-menu-dialog-text">
              <strong>tmuxy</strong> {APP_VERSION}
              <br />
              The missing tmux GUI. Session <strong>{sessionName}</strong>.
            </p>
            <div className="app-menu-dialog-actions">
              <button type="button" onClick={() => dispatch({ kind: 'action', id: 'help-github' })}>
                GitHub {'↗'}
              </button>
              <button type="button" onClick={() => setAboutOpen(false)}>
                OK
              </button>
            </div>
          </Modal>,
          document.body,
        )}
    </>
  );

  return { dispatch, options: { widgetItems, windowMenu }, refreshWindows, dialogs };
}

/**
 * Put the trace file's path on the clipboard. The path itself is the useful
 * thing to hand around (`tmuxy trace`, `jq`, an editor); the file can be
 * hundreds of MB, so this never copies its contents.
 */
function copyTracePath(path: string | null, report: ClipboardReport): void {
  if (!path) {
    report.onFailed('No trace file path available');
    return;
  }
  navigator.clipboard.writeText(path).then(
    () => report.onCopied(`Copied ${path}`),
    (e: unknown) => report.onFailed(`Clipboard write failed: ${String(e)}`),
  );
}
