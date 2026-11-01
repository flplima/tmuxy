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
 * an `Enter` between lines: what typing the text line by line does. A paste
 * goes through `pastedText` instead.
 *
 * `--` ends the options: without it, text starting with a dash (`-la`, or the
 * `-$` of `"line-$i"` when fast typing batches it so) is read as flags, tmux
 * rejects the command, and the text is lost.
 *
 * `to` is a pane id, or — before the client knows one — the session name,
 * which goes through `target` like every other name on a command line.
 */
export function literalText(to: string, text: string): string {
  const at = target(to);
  const lines = text.split(/\r?\n/);
  const commands: string[] = [];
  lines.forEach((line, i) => {
    for (let j = 0; j < line.length; j += LITERAL_CHUNK_SIZE) {
      commands.push(`send-keys -t ${at} -l -- ${quote(line.slice(j, j + LITERAL_CHUNK_SIZE))}`);
    }
    if (i < lines.length - 1) commands.push(`send-keys -t ${at} Enter`);
  });
  return commands.join('\n');
}

/**
 * The buffer a paste travels through. Named, so a paste never replaces the
 * buffer the user last yanked, and dropped again once pasted.
 */
const PASTE_BUFFER = 'tmuxy-paste';

/** The control characters a paste keeps: tab, newline and carriage return. */
const PASTE_CONTROLS = new Set(['\t', '\n', '\r']);

/**
 * Whether `ch` is a control character a paste drops: C0 (NUL and ESC among
 * them), DEL, and C1 (U+0080–U+009F, where U+009B is CSI).
 */
function isPasteControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code < 0x20 || (code >= 0x7f && code <= 0x9f)) && !PASTE_CONTROLS.has(ch);
}

/**
 * `text` with every control character but tab, newline and carriage return
 * removed.
 *
 * Removing the two literal markers was not enough: a program that parses its
 * input as ECMA-48 reads `ESC [ 0201 ~`, or the C1 CSI `U+009B 201 ~`, as the
 * end of the paste just as well, and runs what follows as typed keys. Without
 * ESC and C1 nothing in the text can start an escape sequence, so no spelling
 * of the end marker survives. tmux 3.7 and later make an ESC in a pasted
 * buffer visible (`^[`) on their own, but pass U+009B through as the UTF-8
 * character it is, and older tmux passes both. Plain text from a clipboard
 * has no use for the rest of C0 either, so those go too rather than being
 * argued one by one.
 */
export function withoutControls(text: string): string {
  return Array.from(text)
    .filter((ch) => !isPasteControl(ch))
    .join('');
}

/** What a double-quoted tmux string may carry as itself; the rest is escaped. */
const PLAIN_IN_DOUBLE_QUOTES = /^[A-Za-z0-9 !%&'()*+,\-./:<=>?@[\]^_`|]$/;

const utf8 = new TextEncoder();

/**
 * `text` as a double-quoted tmux string in which every character outside a
 * plain set is an octal byte escape (`\012` for a newline).
 *
 * The escapes cover what tmux's parser would otherwise read as syntax — the
 * quote, `\`, `$` and `~` (expanded inside double quotes), `;`, the `#{`
 * of a format — and, above all, the newline: control mode reads one command
 * per line, so a raw one would end the command there. Non-ASCII goes as its
 * UTF-8 bytes, which tmux reassembles.
 */
export function tmuxDoubleQuoted(text: string): string {
  let out = '';
  for (const ch of text) {
    if (PLAIN_IN_DOUBLE_QUOTES.test(ch)) {
      out += ch;
      continue;
    }
    for (const byte of utf8.encode(ch)) out += '\\' + byte.toString(8).padStart(3, '0');
  }
  return `"${out}"`;
}

/**
 * The command lines that paste `text` into `to` the way a terminal pastes.
 *
 * The text is staged in a tmux buffer and delivered with `paste-buffer -p`,
 * which wraps it in the bracketed-paste markers when the program in the pane
 * asked for them (`?2004h`) and sends it bare, each newline a Return, when it
 * did not. tmux decides from the pane's own mode, so the client tracks none of
 * it, and the paste reaches the pane in one write. Typed line by line instead
 * (`literalText`), a shell, an editor or an agent's TUI ran the first line the
 * moment its newline arrived and took the rest as fresh input.
 *
 * Control characters other than tab, newline and carriage return are removed
 * (`withoutControls`), so a clipboard cannot close the paste early, in any
 * spelling of the end marker, and have what follows read as typed keys. A
 * carriage return is kept: tmux sends each newline as one, so a lone `\r`
 * reaches the pane as the Return it already was. The text is staged in
 * chunks (`set-buffer -a` after the first) so no command line grows
 * unbounded, and `-d` drops the buffer once pasted.
 *
 * A `paste-buffer` reaches its target alone, where typed input in a window
 * with `synchronize-panes` on reaches every pane of it. So when the target is
 * synchronized the paste goes to each of those panes (`paste-synced`), as a
 * paste from the outer terminal would under native tmux.
 */
export function pastedText(to: string, text: string): string {
  const chars = Array.from(withoutControls(text).replace(/\r\n/g, '\n'));
  const commands: string[] = [];
  for (let i = 0; i < chars.length; i += LITERAL_CHUNK_SIZE) {
    const chunk = chars.slice(i, i + LITERAL_CHUNK_SIZE).join('');
    const append = i === 0 ? '' : '-a ';
    commands.push(`set-buffer ${append}-b ${PASTE_BUFFER} ${tmuxDoubleQuoted(chunk)}`);
  }
  if (commands.length === 0) return '';
  commands.push(pasteBufferInto(to));
  return commands.join('\n');
}

/**
 * The staged paste delivered to `to`, or to every synchronized pane of its
 * window. Only a pane id goes into the script's command line, which a shell
 * reads: the fallback target, a session name, could be anything at all.
 */
export function pasteBufferInto(to: string): string {
  const single = `paste-buffer -p -d -b ${PASTE_BUFFER} -t ${target(to)}`;
  if (!/^%\d+$/.test(to)) return single;
  const synced = script('paste-synced', to, PASTE_BUFFER);
  return `if-shell -F -t ${to} '#{pane_synchronized}' '${synced}' '${single}'`;
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
 * shot — the list `packages/tmuxy-cli/bin/tmuxy/float-create` builds for a float.
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
