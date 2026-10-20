/**
 * What a recording is made of: the steps `scripts/record-story-fixtures.mjs`
 * runs against real tmux, one module per recording under `scenarios/`, each
 * written to `gen/<module name>.json`.
 *
 * A step's commands are tmux's own, spelled by `toTmuxCommand` wherever the
 * app sends the command itself, so a story's transition sees the same string
 * the recording was made with.
 */

export interface ScenarioStep {
  /** The name the state after this step is recorded under. */
  readonly state: string;
  /** tmux commands, sent one by one as a client sends them. */
  readonly run?: ReadonlyArray<string>;
  /** Files written under the session's home before the commands run. */
  readonly files?: Readonly<Record<string, string>>;
  /** The client size from this step on (a column opening narrows it). */
  readonly size?: { readonly cols: number; readonly rows: number };
  /** Text that must be on screen before the state counts as settled. */
  readonly waitFor?: string;
  /** Panes whose preview document (`read_preview`) is recorded with this step. */
  readonly previews?: ReadonlyArray<string>;
}

export interface Scenario {
  /** The client size the recording starts at; 120 x 30 unless given. */
  readonly cols?: number;
  readonly rows?: number;
  readonly steps: ReadonlyArray<ScenarioStep>;
}
