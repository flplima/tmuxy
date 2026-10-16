/**
 * AppMenu — the hamburger: the application menu where there is no native
 * menu bar (the web, the demo, Linux). The items are the `appMenuSpec`
 * (domain/menus), rendered by the floating menu; what this component adds is
 * what only a surface can — the two dialogs, the clipboard, and the desktop
 * window verbs that answer with the OS.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FloatingMenu } from '../floating/Menu';
import { Modal } from '../Modal';
import {
  useAppSend,
  useAppActor,
  useAppSelector,
  selectMarkedPaneId,
} from '../../machines/AppContext';
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
import { appMenuSpec } from '../../domain/menus/appMenu';
import { windowMenuSpec } from '../../domain/menus/windowMenu';
import { renderSpec, useMenuDispatch } from './SpecMenu';
import { useMenuEnv } from './menuEnv';
import { activeCloseTarget } from './menuActions';
import { useWidgetMenuItems } from '../widgets/usePaneWidget';
import './AppMenu.css';

export function AppMenu() {
  // The button owns the open flag and the menu hangs off the button: the
  // floating layer, the placement and the exit are the surface's
  // (components/floating), which is what makes this the same object as the
  // context menus and the tab preview.
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const send = useAppSend();
  const actor = useAppActor();
  const env = useMenuEnv();
  const activePaneId = useAppSelector((c) => c.activePaneId);
  const focusedFloatPaneId = useAppSelector((c) => c.focusedFloatPaneId);
  const sessionName = useAppSelector((c) => c.sessionName);
  const tracePath = useAppSelector((c) => c.traceSettings?.path ?? null);
  // Read so the Pane submenu's Mark/Unmark follows the marked pane live.
  useAppSelector(selectMarkedPaneId);
  // Widgets contribute their own items for whichever pane is active, the same
  // section the pane's ⋮ menu shows.
  const widgetItems = useWidgetMenuItems(activePaneId);

  // The desktop's Window submenu: both lists are read when it opens rather
  // than held, since windows come and go from other windows and the style
  // is the OS's answer.
  const [windows, setWindows] = useState<GuiWindowInfo[]>([]);
  const [style, setStyle] = useState<WindowStyleSlug>('normal');
  const refreshWindows = useCallback(() => {
    void listGuiWindows().then(setWindows);
    void getWindowStyle().then(setStyle);
  }, []);

  // The spec is derived from the whole context, so it is built only while
  // the menu is up — the button alone has nothing to derive. A state change
  // while it is up re-renders the item list through the selector.
  const spec = useAppSelector((ctx) =>
    menuOpen
      ? appMenuSpec(ctx, env, {
          widgetItems,
          // OS windows are the desktop app's to manage; a browser tab has none.
          windowMenu: isTauri() ? windowMenuSpec(env, { windows, style }) : undefined,
        })
      : [],
  );

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

  // Rendering reads the Window lists: a stale list on first open is one the
  // user sees for a moment, so they are fetched once the desktop menu mounts.
  useEffect(() => {
    if (isTauri()) refreshWindows();
  }, [refreshWindows]);

  return (
    <>
      <button
        ref={buttonRef}
        className="app-menu-button"
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <rect x="2" y="3" width="12" height="1.5" rx="0.5" />
          <rect x="2" y="7.25" width="12" height="1.5" rx="0.5" />
          <rect x="2" y="11.5" width="12" height="1.5" rx="0.5" />
        </svg>
      </button>
      {menuOpen && (
        <FloatingMenu
          id="app-menu"
          label="Application"
          anchor={{ kind: 'element', element: buttonRef.current }}
          onClose={() => setMenuOpen(false)}
          // The press that closes an open menu must not be the press that
          // reopens it: the button is the menu's own, not "outside" it.
          ignoreRef={buttonRef}
        >
          {renderSpec(spec, dispatch)}
        </FloatingMenu>
      )}
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
              <strong>tmuxy</strong> {__APP_VERSION__}
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
