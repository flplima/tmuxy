import { isPlaceholderId, type PaneId } from './ids';
import { quote, SCRIPTS_DIR, type TmuxOpOf } from './commands';

/** Longest literal a single `send-keys -l` carries before the text is split. */
const LITERAL_CHUNK_SIZE = 500;

/** A name used as a target: bare when it is plainly one word, quoted otherwise. */
export function target(name: string): string {
  return /^[\w.@%:-]+$/.test(name) ? name : quote(name);
}

/** A bundled script, run by tmux. */
export function script(name: string, ...args: Array<string | number>): string {
  return `run-shell "${[`${SCRIPTS_DIR}/${name}`, ...args].join(' ')}"`;
}

/** Commands run as one list (` \; ` between them). */
export function list(commands: ReadonlyArray<string>): string {
  return commands.join(' \\; ');
}

/**
 * The command lines that type `text` into `target` literally, one per line.
 *
 * Control mode reads one command per line, so a newline inside a quoted
 * literal would end the `send-keys` there and run the rest of the text as tmux
 * commands of its own — `run-shell` included. Each line of text goes as its own
 * `send-keys -l` (split into chunks so no command line grows unbounded), with
 * an `Enter` between lines: what pasting the text into a terminal does.
 *
 * `--` ends the options: without it, text starting with a dash (`-la`, or the
 * `-$` of `"line-$i"` when fast typing batches it so) is read as flags, tmux
 * rejects the command, and the text is lost.
 */
export function literalText(to: string, text: string): string {
  const lines = text.split(/\r?\n/);
  const commands: string[] = [];
  lines.forEach((line, i) => {
    for (let j = 0; j < line.length; j += LITERAL_CHUNK_SIZE) {
      commands.push(`send-keys -t ${to} -l -- ${quote(line.slice(j, j + LITERAL_CHUNK_SIZE))}`);
    }
    if (i < lines.length - 1) commands.push(`send-keys -t ${to} Enter`);
  });
  return commands.join('\n');
}

/**
 * An SGR mouse report as `send-keys -H` hex bytes — the one reliable way in:
 * tmux ≥ 3.7 consumes mouse sequences pasted through a buffer, and `-l`
 * literals are format-expanded (see docs/TMUX.md).
 */
export function mouseReport(op: TmuxOpOf<'SendMouse'>): string {
  const seq = `\x1b[<${op.button};${op.x};${op.y}${op.release ? 'm' : 'M'}`;
  const hex = Array.from(seq, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  return `send-keys -t ${op.paneId} -H ${hex}`;
}

/**
 * The `split-window ; break-pane ; set-option` list that creates a chrome
 * window running `run` (the default shell when `null`) and tags it in one
 * shot — the list `bin/tmuxy/float-create` builds for a float.
 *
 * `at` names the new window: a float by its index (picked free up front —
 * `set-option -w` with no target would land on the session's CURRENT window,
 * which `break-pane -d` leaves unchanged), a sidebar by its fixed, unique name
 * (so the list never depends on the client's copy of the indices, which go
 * stale for a beat whenever a window closes). `splitFrom` is the pane to split,
 * so the new pane is born beside what the user sees rather than wherever tmux
 * happens to be; without one (or with a placeholder), tmux's current pane.
 */
export function chromeWindow(
  windowType: 'float' | 'sidebar-left' | 'sidebar-right',
  name: string,
  run: string | null,
  splitFrom: PaneId | null,
  index: number | null,
): string {
  const at = index === null ? `:${name}` : `:${index}`;
  // A placeholder is no target: tmux has never heard of it.
  const from = splitFrom && !isPlaceholderId(splitFrom) ? ` -t ${splitFrom}` : '';
  return list([
    run === null ? `split-window${from}` : `split-window${from} ${quote(run)}`,
    index === null ? `break-pane -d -n ${name}` : `break-pane -d -n ${name} -t ${at}`,
    `set-option -w -t ${at} @tmuxy-window-type ${windowType}`,
  ]);
}

export const NAV_WORD = { L: 'left', R: 'right', U: 'up', D: 'down' } as const;
