/**
 * A transport driver that replays states recorded from real tmux
 * (`scripts/record-story-fixtures.mjs`), for Storybook.
 *
 * It imitates nothing. A story starts from one recorded state and names the
 * commands that move it to another: when the app sends a command matching a
 * transition, the state that transition names is emitted, as tmux's answer
 * would be. Any other command is accepted and changes nothing — a story that
 * waits on its effect has to script it, which is the point: what a story
 * shows is always a screen tmux really drew.
 *
 * The app's other calls (themes, the trace switch, preview pages) are
 * answered the way the demo site answers them, with nothing behind them.
 */

import type { TmuxAdapter } from '../../infra/transport/driver';
import { EventHub } from '../../infra/eventHub';
import { TransportEvent } from '../../infra/transport/events';
import { decodeServerStateOrThrow, decodeStateForListener } from '../../infra/transport/wireDecode';
import type { PaneId } from '../../domain/ids';
import type { CommandFailure, KeyBindings, ServerStateEncoded } from '../../domain/wire';
import type { TraceSettings } from '../../machines/types/domain';
import { loadThemeFromStorage, parseThemeMode, saveThemeToStorage } from '../../utils/themeManager';

/** A recording: the grid it was made at, the bindings in force, and a state per step. */
export interface Fixture {
  readonly cols: number;
  readonly rows: number;
  readonly keybindings: KeyBindings;
  readonly states: Readonly<Record<string, ServerStateEncoded>>;
  /** The preview document each preview pane read (`read_preview`), by pane id. */
  readonly previews?: Readonly<Record<string, unknown>>;
}

/**
 * A recording as a story imports it (`import x from './fixtures/gen/x.json'`):
 * the JSON is the wire's own encoding, which the type cannot see through.
 */
export function asFixture(json: unknown): Fixture {
  return json as Fixture;
}

/** When the app sends a command matching `match`, tmux's answer is the state `to`. */
export interface Transition {
  readonly match: RegExp;
  readonly to: string;
}

export interface FixtureAdapterOptions {
  fixture: Fixture;
  /** The state the session is in when the app connects. */
  start: string;
  transitions?: ReadonlyArray<Transition>;
  /**
   * How long every command takes to answer, so a story can watch the app
   * between sending one and tmux answering it.
   */
  commandDelayMs?: number;
  /**
   * Consulted before each command: a string makes tmux refuse it with that
   * message, as a real transport rejects one (`{ error, kind: 'tmux' }`).
   */
  failCommand?: (command: string) => string | false | null | undefined;
}

const THEMES = [
  { name: 'default', displayName: 'Default' },
  { name: 'dracula', displayName: 'Dracula' },
  { name: 'fallout', displayName: 'Fallout' },
  { name: 'gruvbox', displayName: 'Gruvbox' },
  { name: 'nord', displayName: 'Nord' },
  { name: 'solarized', displayName: 'Solarized' },
  { name: 'tokyonight', displayName: 'Tokyo Night' },
];

export class FixtureAdapter implements TmuxAdapter {
  readonly events = new EventHub<TransportEvent>();
  private readonly fixture: Fixture;
  private readonly transitions: ReadonlyArray<Transition>;
  private readonly commandDelayMs: number;
  private readonly failCommand: FixtureAdapterOptions['failCommand'];
  private current: string;
  /** Every command the app sent, in order. */
  readonly commands: string[] = [];
  private traceSettings: TraceSettings = {
    enabled: false,
    level: 'shape',
    path: '/home/demo/.local/state/tmuxy/trace.ndjson',
    locked: false,
  };
  /** Each pane's last staged page, revoked when the next replaces it. */
  private previewPages = new Map<string, string>();

  constructor(options: FixtureAdapterOptions) {
    this.fixture = options.fixture;
    this.transitions = options.transitions ?? [];
    this.commandDelayMs = options.commandDelayMs ?? 0;
    this.failCommand = options.failCommand;
    this.state(options.start);
    this.current = options.start;
  }

  /** Move to the recorded state `name` and tell the app, as tmux reporting a change would. */
  goTo(name: string): void {
    this.state(name);
    this.current = name;
    this.emitStateSnapshot();
  }

  /** Send the current state again, as an unsolicited update from the backend. */
  emitStateSnapshot(): void {
    const state = decodeStateForListener(this.state(this.current));
    if (state) this.events.emit(TransportEvent.State({ state, seq: null }));
  }

  /** An OSC 52 clipboard write from a pane, as the server forwards one. */
  emitClipboard(paneId: PaneId, text: string): void {
    this.events.emit(TransportEvent.Clipboard({ paneId, text }));
  }

  async connect(): Promise<void> {
    this.events.emit(TransportEvent.ConnectionInfo({ defaultShell: 'bash', readOnly: false }));
    this.events.emit(TransportEvent.KeyBindings({ keybindings: this.fixture.keybindings }));
  }

  disconnect(): void {}

  async switchSession(_sessionName: string): Promise<void> {
    this.events.emit(TransportEvent.Reconnection({ reconnecting: false }));
    this.emitStateSnapshot();
  }

  /**
   * A blob, there being no server to serve the page under a policy header;
   * the frame's `sandbox` attribute still gives it an opaque origin.
   */
  async stagePreview(paneId: string, html: string): Promise<string> {
    const previous = this.previewPages.get(paneId);
    if (previous) URL.revokeObjectURL(previous);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    this.previewPages.set(paneId, url);
    return url;
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    switch (cmd) {
      case 'get_initial_state':
        return decodeServerStateOrThrow(this.state(this.current)) as T;
      case 'run_tmux_command':
        await this.runCommand(String(args?.command ?? ''));
        return null as T;
      case 'read_preview': {
        const document = this.fixture.previews?.[String(args?.paneId)];
        if (document === undefined || args?.path !== undefined) {
          throw { error: 'nothing recorded to read', kind: 'unavailable' } satisfies CommandFailure;
        }
        return document as T;
      }
      case 'get_scrollback_cells':
        return this.scrollback(String(args?.paneId)) as T;
      // The client is sized to the recording, so there is nothing to re-tile.
      case 'set_client_size':
        this.emitStateSnapshot();
        return null as T;
      // The client leaves the session; tmux runs on.
      case 'detach_client':
        this.events.emit(TransportEvent.Detached({ reason: null }));
        return null as T;
      case 'set_theme': {
        const saved = loadThemeFromStorage();
        const mode = args?.mode as string | undefined;
        saveThemeToStorage(
          (args?.name as string | undefined) || saved?.theme || 'default',
          mode === undefined ? (saved?.mode ?? 'dark') : parseThemeMode(mode),
        );
        return null as T;
      }
      case 'set_theme_mode':
        saveThemeToStorage(loadThemeFromStorage()?.theme || 'default', parseThemeMode(args?.mode));
        return null as T;
      case 'get_theme_settings':
        return (loadThemeFromStorage() ?? { theme: 'default', mode: 'dark' }) as T;
      case 'get_themes_list':
        return THEMES as T;
      case 'get_trace_settings':
        return { ...this.traceSettings } as T;
      case 'set_trace_enabled':
        this.traceSettings.enabled = Boolean(args?.enabled);
        return this.traceSettings.enabled as T;
      case 'set_trace_level': {
        const level = args?.level;
        this.traceSettings.level = level === 'labeled' || level === 'full' ? level : 'shape';
        return this.traceSettings.level as T;
      }
      default:
        return null as T;
    }
  }

  private async runCommand(command: string): Promise<void> {
    if (!command) return;
    this.commands.push(command);
    const refusal = this.failCommand?.(command);
    if (this.commandDelayMs > 0) await new Promise((r) => setTimeout(r, this.commandDelayMs));
    if (typeof refusal === 'string') {
      throw { error: refusal, kind: 'tmux' } satisfies CommandFailure;
    }
    const transition = this.transitions.find((t) => t.match.test(command));
    if (transition) this.goTo(transition.to);
  }

  /** A pane's rows as the recording has them: what is on its screen is all there is. */
  private scrollback(paneId: string) {
    const pane = this.state(this.current).panes.find((p) => p.tmux_id === paneId);
    const cells = pane?.content ?? [];
    return {
      cells,
      historySize: pane?.history_size ?? 0,
      start: 0,
      end: cells.length,
      width: pane?.width ?? this.fixture.cols,
    };
  }

  private state(name: string): ServerStateEncoded {
    const state = this.fixture.states[name];
    if (!state) {
      throw new Error(
        `no recorded state "${name}" (recorded: ${Object.keys(this.fixture.states).join(', ')})`,
      );
    }
    return state;
  }
}
