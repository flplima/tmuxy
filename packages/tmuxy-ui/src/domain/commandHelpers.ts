import { realId, type PaneId } from './ids';
import { isPluginName } from './plugins';
// PASTE_BUFFER: named, so a paste never replaces the buffer the user last
// yanked, and dropped again once pasted.
import { CLI_PATH, PASTE_BUFFER, SCRIPT_EFFECT_TAGS, SCRIPTS_DIR } from './tmuxyConstants.gen';

const LITERAL_CHUNK_SIZE = 500;

/**
 * Free text as one tmux argument, single-quoted (`it's` → `'it'\''s'`).
 *
 * Control mode reads one command per line, and nothing escapes inside single
 * quotes: a newline in a name or a title would end the command there and run
 * the rest as tmux commands of its own. Text holding any control character
 * goes double-quoted instead, every unsafe byte an octal escape.
 */
export function quote(text: string): string {
  if (hasControlCharacter(text)) return tmuxDoubleQuoted(text);
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function target(name: string): string {
  return /^[\w.@%:-]+$/.test(name) ? name : quote(name);
}

export function script(name: string, ...args: Array<string | number>): string {
  return `run-shell "${[`${SCRIPTS_DIR}/${name}`, ...args].join(' ')}"`;
}

/** Where the `agent-revive --mark` check leaves its answer on a pane. */
const REVIVABLE_OPTION = '@tmuxy-revivable';

/**
 * The read that follows a `CheckRevive` op: the answer revive's check left
 * on the pane, `ok` or nothing. A query only reads, so the check itself runs
 * as an op first; tmux answers a client's commands in order.
 */
export function reviveCheckQuery(paneId: string): string {
  return `show-options -pqv -t ${paneId} ${REVIVABLE_OPTION}`;
}

/**
 * What the backend must know of a script run: `settle` for a script that takes
 * several tmux steps (the clients see only where it lands), `relist-windows`
 * for one that writes `@tmuxy-*` options tmux never announces. The marker is
 * the first word of the line `run-shell` hands the shell — an environment
 * assignment the script ignores — and the essentials aliases' bodies carry
 * the same word, so the monitor reads one marker whoever sent the command.
 */
export type ScriptEffect = keyof typeof SCRIPT_EFFECT_TAGS;

export function scriptWith(
  effect: ScriptEffect,
  name: string,
  ...args: Array<string | number>
): string {
  return `run-shell "${[SCRIPT_EFFECT_TAGS[effect], `${SCRIPTS_DIR}/${name}`, ...args].join(' ')}"`;
}

/** A shell command line as one `run-shell` argument; run-shell expands `#` first. */
export function runShell(command: string): string {
  return `run-shell ${quote(command.replace(/#/g, '##'))}`;
}

export function list(commands: ReadonlyArray<string>): string {
  return commands.join(' \\; ');
}

/**
 * The command lines that type `text` into `to` literally, one per line.
 *
 * Control mode reads one command per line, so a newline inside a quoted
 * literal would end the `send-keys` there and run the rest of the text as tmux
 * commands of its own — `run-shell` included.
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

const PASTE_CONTROLS = new Set(['\t', '\n', '\r']);

/** C0 (NUL and ESC among them), DEL, and C1 (U+0080–U+009F, where U+009B is CSI). */
function isPasteControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (code < 0x20 || (code >= 0x7f && code <= 0x9f)) && !PASTE_CONTROLS.has(ch);
}

/**
 * `text` with every control character but tab, newline and carriage return
 * removed.
 *
 * Removing the two bracketed-paste markers is not enough: a program that parses
 * its input as ECMA-48 reads `ESC [ 0201 ~`, or the C1 CSI `U+009B 201 ~`, as the
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

const PLAIN_IN_DOUBLE_QUOTES = /^[A-Za-z0-9 !%&'()*+,\-./:<=>?@[\]^_`|]$/;

const utf8 = new TextEncoder();

/**
 * `text` as a double-quoted tmux string, every character outside a plain set
 * an octal byte escape (`\012` for a newline). The escapes cover what tmux's parser would otherwise read as syntax — the
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
 * Control characters are removed (`withoutControls`) so a clipboard cannot
 * close the paste early and have what follows read as typed keys. A carriage
 * return is kept: tmux sends each newline as one, so a lone `\r` reaches the
 * pane as the Return it already was.
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
export function mouseReport(op: {
  readonly paneId: PaneId;
  readonly button: number;
  readonly x: number;
  readonly y: number;
  readonly release: boolean;
}): string {
  const seq = `\x1b[<${op.button};${op.x};${op.y}${op.release ? 'm' : 'M'}`;
  const hex = Array.from(seq, (ch) => ch.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');
  return `send-keys -t ${op.paneId} -H ${hex}`;
}

/**
 * The `split-window ; break-pane ; set-option` list that creates a sidebar
 * column's window running `run` (the default shell when `null`) and tags it
 * in one shot. The window is named by its fixed, unique name, so the list
 * never depends on the client's copy of the indices, which go stale for a
 * beat whenever a window closes. `splitFrom` is the pane to split, so the new
 * pane is born beside what the user sees rather than wherever tmux happens to
 * be; without one (or with a placeholder), tmux's current pane.
 */
export function sidebarWindowCommand(
  side: 'left' | 'right',
  name: string,
  run: string | null,
  splitFrom: PaneId | null,
): string {
  const from = realId(splitFrom) ? ` -t ${splitFrom}` : '';
  return list([
    run === null ? `split-window${from}` : `split-window${from} ${quote(run)}`,
    `break-pane -d -n ${name}`,
    `set-option -w -t :${name} @tmuxy-window-type sidebar-${side}`,
  ]);
}

/**
 * A float running `command`, made by the CLI's `pane float`: the server's
 * `float` verb, the one builder of a float (`tmuxy-core/src/float.rs`), split
 * from `splitFrom` so the float belongs to that pane's tab. In the background
 * with its output dropped: the pane id `--detach` prints would open a view
 * mode on the pane.
 */
export function openFloat(op: {
  readonly command: readonly string[];
  readonly splitFrom: PaneId | null;
}): string {
  const caller = op.splitFrom && /^%\d+$/.test(op.splitFrom) ? `TMUX_PANE=${op.splitFrom} ` : '';
  return (
    `run-shell -b "${caller}\\"${CLI_PATH}\\" pane float --detach ` +
    `${op.command.map(shellWordInRunShell).join(' ')} >/dev/null 2>&1"`
  );
}

/**
 * One word of the shell line a double-quoted `run-shell "…"` runs. The shell
 * quoting is `quote`'s; on top of it, tmux's parser reads `\`, `"` and `$`
 * inside its double quotes (a `\'` would reach the shell as a bare `'`, and
 * `it's` as `its`), and run-shell expands a `#` before the shell sees it.
 */
function shellWordInRunShell(word: string): string {
  return quote(word)
    .replace(/[\\"$]/g, '\\$&')
    .replace(/#/g, '##');
}

export const NAV_WORD = { L: 'left', R: 'right', U: 'up', D: 'down' } as const;

/**
 * `tmuxy plugin action` for a menu item, in the background with its output
 * dropped: a `run-shell -b` that prints opens a view mode on the pane. A
 * launch that fails says so on the status line itself (`--trigger menu`).
 *
 * Every word is checked against the alphabet the server accepts, since the
 * line is a shell's: an inventory entry that is not one is never sent. The
 * path is quoted for the shell, as a data dir may hold a space.
 */
export function pluginAction(op: {
  readonly plugin: string;
  readonly action: string;
  readonly paneId: PaneId;
  readonly token: string | null;
}): string {
  const valid =
    isPluginName(op.plugin) &&
    isPluginName(op.action) &&
    /^%\d+$/.test(op.paneId) &&
    (op.token === null || /^[0-9a-f]{32}$/.test(op.token));
  if (!valid) return `display-message ${quote('tmuxy: not a plugin action')}`;
  const token = op.token === null ? '' : ` --token ${op.token}`;
  return (
    `run-shell -b "\\"${CLI_PATH}\\" plugin action ${op.plugin}:${op.action}` +
    ` --pane ${op.paneId} --trigger menu${token} >/dev/null 2>&1"`
  );
}

/** tmux's own version, for the bug report snippet: a read, run as a query. */
export const TMUX_VERSION_QUERY = "display-message -p '#{version}'";
