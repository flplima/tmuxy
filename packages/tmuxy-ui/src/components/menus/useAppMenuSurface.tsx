/**
 * What the application menu needs beyond its spec, shared by the hamburger and
 * the native menu bar.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAppSend, useAppActor, useAppSelector } from '../../machines/appHooks';
import { isTauri } from '../../infra/platform';
import { copyAppState, type ClipboardReport } from './copyAppState';
import { CopyTraceDialog } from './CopyTraceDialog';
import { KillSessionDialog } from './KillSessionDialog';
import { writeClipboard } from '../../infra/clipboard';
import {
  closeGuiWindow,
  focusGuiWindow,
  getWindowStyle,
  listGuiWindows,
  newGuiWindow,
  quitApp,
  setWindowStyle,
} from '../../infra/guiWindows';
import type { GuiWindowInfo, WindowStyleSlug } from '../../domain/guiWindows';
import { windowMenuSpec } from './specs/windowMenu';
import type { AppMenuOptions } from './specs/appMenu';
import type { MenuEnv } from '../../domain/menus/spec';
import { useMenuDispatch, type AppMenuDispatch } from './SpecMenu';
import { useWidgetMenuItems } from '../widgets/usePaneWidget';
import { op, type AppMenuNode, type MenuLocal } from './specs/actions';
import { TmuxOp } from '../../domain/commands';
import './AppMenu.css';

export interface AppMenuSurface {
  dispatch: AppMenuDispatch;
  options: AppMenuOptions;
  dialogs: ReactNode;
}

export function useAppMenuSurface(env: MenuEnv): AppMenuSurface {
  const send = useAppSend();
  const actor = useAppActor();
  const activePaneId = useAppSelector((c) => c.activePaneId);
  const sessionName = useAppSelector((c) => c.sessionName);
  const tracePath = useAppSelector((c) => c.traceSettings?.path ?? null);
  const widgetItems = useWidgetMenuItems(activePaneId);

  // Read on demand: other windows open and close windows, and the style is the
  // OS's answer.
  const [windows, setWindows] = useState<GuiWindowInfo[]>([]);
  const [style, setStyle] = useState<WindowStyleSlug>('normal');
  const refreshWindows = useCallback(() => {
    if (!isTauri()) return;
    void listGuiWindows().then(setWindows);
    void getWindowStyle().then(setStyle);
  }, []);
  useEffect(refreshWindows, [refreshWindows]);

  const [confirmKill, setConfirmKill] = useState(false);
  const [copyTrace, setCopyTrace] = useState(false);

  const report: ClipboardReport = {
    onCopied: (text) => send({ type: 'SHOW_STATUS_MESSAGE', text }),
    onFailed: (text) => send({ type: 'NOTIFY', text }),
  };

  const onLocal = (local: MenuLocal) => {
    switch (local.verb) {
      case 'confirm-kill-session':
        return setConfirmKill(true);
      case 'copy-trace':
        return setCopyTrace(true);
      case 'copy-app-state':
        return copyAppState(actor.getSnapshot().context, report);
      case 'copy-trace-path':
        return copyTracePath(tracePath, report);
      case 'window-refresh':
        return refreshWindows();
      case 'window-new':
        return newGuiWindow();
      case 'window-close':
        return closeGuiWindow();
      case 'quit':
        return quitApp();
      case 'window-style':
        setWindowStyle(local.slug);
        return setStyle(local.slug);
      case 'window-focus':
        return focusGuiWindow(local.index);
    }
  };
  const dispatch = useMenuDispatch({ onLocal });

  const windowMenu: AppMenuNode | undefined = isTauri()
    ? windowMenuSpec(env, { windows, style })
    : undefined;

  const dialogs = (
    <>
      {confirmKill && (
        <KillSessionDialog
          sessionName={sessionName}
          onCancel={() => setConfirmKill(false)}
          onKill={() => {
            setConfirmKill(false);
            dispatch(op(TmuxOp.KillSession({ name: null })));
          }}
        />
      )}
      {copyTrace && <CopyTraceDialog onClose={() => setCopyTrace(false)} report={report} />}
    </>
  );

  return { dispatch, options: { widgetItems, windowMenu }, dialogs };
}

function copyTracePath(path: string | null, report: ClipboardReport): void {
  if (!path) {
    report.onFailed('No trace file path available');
    return;
  }
  void writeClipboard(path, null).then((ok) =>
    ok ? report.onCopied(`Copied ${path}`) : report.onFailed('Clipboard write failed'),
  );
}
