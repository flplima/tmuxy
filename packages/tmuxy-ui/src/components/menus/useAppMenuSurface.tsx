/**
 * What the application menu needs beyond its spec, shared by the hamburger and
 * the native menu bar.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useAppSend, useAppActor, useAppRuntime, useAppSelector } from '../../machines/appHooks';
import { isTauri } from '../../infra/platform';
import { copyAppState, type ClipboardReport } from './copyAppState';
import { copyBugReport } from './copyBugReport';
import { CopyTraceDialog } from './CopyTraceDialog';
import { KillSessionDialog } from './KillSessionDialog';
import type { AppMachineContext } from '../../machines/types/context';
import type { AppRuntime } from '../../infra/runtime';
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
import { useProfileDialog } from './useProfileDialog';
import './AppMenu.css';

export interface AppMenuSurface {
  dispatch: AppMenuDispatch;
  options: AppMenuOptions;
  dialogs: ReactNode;
}

/** The Debug menu's copies: each puts its text on the clipboard and says so. */
function copyFromMenu(
  verb: 'copy-app-state' | 'copy-bug-report' | 'copy-trace-path',
  ctx: AppMachineContext,
  runtime: AppRuntime,
  report: ClipboardReport,
  tracePath: string | null,
): void {
  if (verb === 'copy-app-state') return copyAppState(ctx, report);
  if (verb === 'copy-bug-report') return copyBugReport(ctx, runtime, report);
  return copyTracePath(tracePath, report);
}

export function useAppMenuSurface(env: MenuEnv): AppMenuSurface {
  const send = useAppSend();
  const actor = useAppActor();
  const runtime = useAppRuntime();
  const activePaneId = useAppSelector((c) => c.activePaneId);
  const sessionName = useAppSelector((c) => c.sessionName);
  const tracePath = useAppSelector((c) => c.traceSettings?.path ?? null);
  const widgetItems = useWidgetMenuItems(activePaneId);

  const { windows, style, setStyle, refreshWindows } = useGuiWindows();

  const [confirmKill, setConfirmKill] = useState(false);
  const profileDialog = useProfileDialog();
  const [copyTrace, setCopyTrace] = useState(false);

  const report: ClipboardReport = {
    onCopied: (text) => send({ type: 'SHOW_STATUS_MESSAGE', text }),
    onFailed: (text) => send({ type: 'NOTIFY', text }),
  };

  const onLocal = (local: MenuLocal) => {
    switch (local.verb) {
      case 'confirm-kill-session':
        return setConfirmKill(true);
      case 'profile-dialog':
        return profileDialog.open(local.dialog);
      case 'copy-trace':
        return setCopyTrace(true);
      case 'copy-app-state':
      case 'copy-bug-report':
      case 'copy-trace-path':
        return copyFromMenu(local.verb, actor.getSnapshot().context, runtime, report, tracePath);
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
      {profileDialog.dialog}
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

/** The desktop's windows and window style, read on demand: other windows open and close windows, and the style is the OS's answer. */
function useGuiWindows() {
  const [windows, setWindows] = useState<GuiWindowInfo[]>([]);
  const [style, setStyle] = useState<WindowStyleSlug>('normal');
  const refreshWindows = useCallback(() => {
    if (!isTauri()) return;
    void listGuiWindows().then(setWindows);
    void getWindowStyle().then(setStyle);
  }, []);
  useEffect(refreshWindows, [refreshWindows]);
  return { windows, style, setStyle, refreshWindows };
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
