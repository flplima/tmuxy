// The one way the page calls a desktop-shell command outside the transport (docs/TRACING.md).

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { isTauri } from './platform';
import { logFailure } from './logFailure';
import { tracer } from './tracer';

/**
 * Call `cmd`, traced. Rejects when the call fails. `traced` adds fields to
 * the trace event (never the arguments themselves, which can carry a URL or
 * a path); `actionId` is the id to trace it under, for a caller that also
 * hands it to the shell to echo.
 */
export function desktopInvoke<T = void>(
  cmd: string,
  args: Record<string, unknown> = {},
  options: { actionId?: string; traced?: Record<string, unknown> } = {},
): Promise<T> {
  tracer.event({
    layer: 'tauri',
    component: 'desktop',
    name: cmd,
    action_id: options.actionId ?? tracer.actionId(),
    ...options.traced,
  });
  return invoke<T>(cmd, args);
}

/**
 * A desktop-only command: `fallback` in a browser, and on failure — logged,
 * never thrown: these are menu actions and keystrokes, and neither has
 * anywhere to put a rejected promise.
 */
export async function desktopCall<T = void>(
  cmd: string,
  fallback: T,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) return fallback;
  try {
    return await desktopInvoke<T>(cmd, args);
  } catch (e: unknown) {
    logFailure(cmd, e);
    return fallback;
  }
}

/**
 * Hear `event` when the desktop sends it to this window (`emit_to` its
 * label), or to every window; resolves to the function that stops. Tauri's
 * bare `listen` hears an event whichever window it was sent to, so a second
 * window would take the first one's states, of another session, as its own.
 */
export function listenToThisWindow<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  return listen<T>(event, (e) => handler(e.payload), {
    target: getCurrentWebviewWindow().label,
  });
}
