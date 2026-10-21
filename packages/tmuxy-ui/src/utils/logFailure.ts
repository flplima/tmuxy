/**
 * One shape for a failure the user has nothing to do about — a desktop
 * command that did not take, a menu that could not be set — and nowhere else
 * to go: the console, named by what failed, and the action trace when it is
 * on (docs/TRACING.md), so a failure seen in the field has its place among
 * the actions around it.
 */

import { tracer } from '../infra/tracer';

/** Report that `scope` (a command or a subsystem) failed with `error`. */
export function logFailure(scope: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] ${message}`);
  tracer.event({ layer: 'ui', name: 'failure', component: scope, error: message.slice(0, 200) });
}

/** `logFailure` as a rejection handler: `promise.catch(failing('open_url'))`. */
export function failing(scope: string): (error: unknown) => void {
  return (error) => logFailure(scope, error);
}
