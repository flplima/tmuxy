/**
 * The one way the page calls a command of the desktop shell (Tauri's
 * `invoke`, outside the transport): every call is traced (docs/TRACING.md)
 * under an `action_id`, and a failure is reported through `logFailure`.
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './platform';
import { logFailure } from './logFailure';
import { tracer } from './tracer';

/** Per-page-load prefix so ids stay unique across app restarts in one trace file. */
const actionPrefix = `desktop-${Date.now().toString(36)}`;
let actionCounter = 0;

/** A fresh action id for a traced call, or undefined while tracing is off. */
export function nextActionId(): string | undefined {
  return tracer.isEnabled() ? `${actionPrefix}-${++actionCounter}` : undefined;
}

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
    action_id: options.actionId ?? nextActionId(),
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
