/**
 * Debug > Copy Bug Report Snippet: what a bug report needs to say about the
 * setup, as Markdown on the clipboard, ready to paste into an issue.
 *
 * It says which versions run where and how the app is set up, and nothing a
 * terminal holds: no session, tab or pane names, no commands, no paths, no
 * hosts, no screen text. Only counts of tabs and panes. Nothing is sent
 * anywhere; the user pastes it, and reads it first.
 */

import { Effect } from 'effect';
import { version as TMUXY_VERSION } from '../../../../../package.json';
import { TMUX_VERSION_QUERY } from '../../domain/commandHelpers';
import { writeClipboard } from '../../infra/clipboard';
import { isMacPlatform, isTauri } from '../../infra/platform';
import { TmuxTransport } from '../../infra/transport/TmuxTransport';
import type { AppRuntime } from '../../infra/runtime';
import type { AppMachineContext } from '../../machines/types/context';
import type { ClipboardReport } from './copyAppState';

/** What the snippet says about where it runs, gathered outside the context. */
export interface ReportFacts {
  tmuxy: string;
  /** tmux's own `#{version}`; `unknown` when tmux could not be asked. */
  tmux: string;
  app: 'desktop' | 'web';
  os: string;
}

const onOff = (on: boolean) => (on ? 'on' : 'off');

/** The snippet itself: Markdown, with nothing a terminal holds. */
export function bugReportSnippet(ctx: AppMachineContext, facts: ReportFacts): string {
  const tabs = ctx.windows.filter((w) => !w.windowType || w.windowType === 'tab').length;
  const trace = ctx.traceSettings;
  return [
    '### Environment',
    '',
    `- tmuxy ${facts.tmuxy} (${facts.app})`,
    `- tmux ${facts.tmux}`,
    `- ${facts.os}`,
    '',
    '### Settings',
    '',
    `- theme: ${ctx.themeName} (${ctx.themeMode})`,
    `- cursor blink ${onOff(ctx.cursorBlink)}, ask before sending keys ${onOff(ctx.sendAsk)}, transparency ${onOff(ctx.transparency)}`,
    `- traces: ${trace ? (trace.enabled ? `on, ${trace.level}` : 'off') : 'not available'}`,
    `- ${tabs} tab(s), ${ctx.panes.length} pane(s)`,
    '',
  ].join('\n');
}

/** The operating system, as the browser reports it, without the version strings that fingerprint a machine. */
function operatingSystem(): string {
  if (isMacPlatform()) return 'macOS';
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Android/i.test(agent)) return 'Android';
  if (/iPhone|iPad/i.test(agent)) return 'iOS';
  if (/Windows/i.test(agent)) return 'Windows';
  if (/Linux/i.test(agent)) return 'Linux';
  return 'unknown OS';
}

/** tmux's version, asked of tmux itself; `unknown` where nothing answers. */
const tmuxVersion = Effect.gen(function* () {
  const transport = yield* TmuxTransport;
  if (!transport.answersQueries()) return 'unknown';
  const said = yield* transport.query(TMUX_VERSION_QUERY);
  return said.trim() || 'unknown';
}).pipe(Effect.catchAll(() => Effect.succeed('unknown')));

export function copyBugReport(
  ctx: AppMachineContext,
  runtime: AppRuntime,
  report: ClipboardReport,
): void {
  void runtime
    .runPromise(tmuxVersion)
    .then((tmux) =>
      writeClipboard(
        bugReportSnippet(ctx, {
          tmuxy: TMUXY_VERSION,
          tmux,
          app: isTauri() ? 'desktop' : 'web',
          os: operatingSystem(),
        }),
        null,
      ),
    )
    .then((ok) =>
      ok
        ? report.onCopied('Copied a bug report snippet: check it before you paste it')
        : report.onFailed('Clipboard write failed'),
    );
}
