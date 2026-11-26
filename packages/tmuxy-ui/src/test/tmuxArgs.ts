/**
 * A model of how tmux reads what the client sends: each line one command list
 * (control mode), split into words and unquoted as tmux's parser does
 * (`cmd-parse.y`), and each command's options read as `args_parse` reads them
 * (`arguments.c`), with the command's own option template (the `args` of its
 * `cmd-*.c`, copied from tmux 3.8). tmux 3.2a reads options with BSD getopt,
 * which agrees on everything here: options end at the first word that does
 * not start with a dash (a lone `-` is an operand) or at `--`, and a flag
 * that takes an argument takes the next word whole.
 *
 * Tests run a command through it to see where a piece of text lands.
 */

/** A command as tmux reads it; a `{ … }` block operand is the commands inside. */
export interface TmuxCommand {
  readonly verb: string;
  readonly flags: ReadonlyArray<readonly [flag: string, value: string | null]>;
  readonly operands: ReadonlyArray<string | ReadonlyArray<TmuxCommand>>;
}

/**
 * Each verb's option template: a letter is a flag, `x:` takes an argument,
 * `x::` takes one only when the next word is not a flag. Only the verbs the
 * client sends: a verb missing here fails the read, so a new one is added
 * with its template from tmux's source.
 */
const TEMPLATES: Readonly<Record<string, string>> = {
  'break-pane': 'abdPF:n:s:t:Wx:X:y:Y:',
  'clear-history': 'Ht:',
  'command-prompt': '1CbeFiklI:NPp:t:T:',
  'copy-mode': 'dekHMqSs:t:u',
  'delete-buffer': 'b:',
  'display-message': 'aCc:d:jlINpt:F:v',
  'if-shell': 'bFt:',
  'join-pane': 'bdfhvp:l:s:t:',
  'kill-pane': 'af:t:',
  'kill-session': 'aCgf:t:',
  'kill-window': 'af:t:',
  'last-pane': 'det:Z',
  'last-window': 't:',
  'move-window': 'abdkrs:t:',
  'new-session': 'Ac:dDe:EF:f:n:Ps:t:x:Xy:',
  'new-window': 'abc:de:EF:kn:PSt:',
  'next-layout': 't:',
  'next-window': 'at:',
  'paste-buffer': 'db:prSs:t:',
  'previous-layout': 't:',
  'previous-window': 'at:',
  'rename-session': 't:',
  'rename-window': 't:',
  'resize-pane': 'D::L::MR::Tt:U::x:y:Z',
  'run-shell': 'bd:Ct:Es:c:',
  'select-layout': 'Enopt:',
  'select-pane': 'DdegLlMmP:RT:t:UZ',
  'select-window': 'lnpTt:',
  'send-keys': 'c:FHKlMN:Rt:X',
  'set-buffer': 'ab:t:n:w',
  'set-option': 'aFgopqst:uUw',
  'source-file': 't:Fnqv',
  'split-window': 'bB:c:de:EfF:hIkl:m:p:PR:s:S:t:T:vWZ',
  'swap-pane': 'dDs:t:UZ',
  'switch-client': 'c:EFlnO:pt:rT:Z',
  // tmuxy's own command aliases (tmuxy.essentials.conf): no options.
  'tmuxy-nav-left': '',
  'tmuxy-nav-right': '',
  'tmuxy-nav-up': '',
  'tmuxy-nav-down': '',
};

type Word = { readonly text: string; readonly bare: boolean } | { readonly block: string };

const utf8 = new TextEncoder();
const NAMED_ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  e: 27,
  f: 12,
  n: 10,
  r: 13,
  s: 32,
  t: 9,
  v: 11,
};

/** The byte(s) of the escape at `line[i]` (just after its `\`), and where it ends. */
function escape(line: string, i: number): [number[], number] {
  const ch = line[i];
  const octal = line.slice(i, i + 3);
  if (/^[0-3][0-7]{2}$/.test(octal)) return [[parseInt(octal, 8)], i + 3];
  if (/[4-7]/.test(ch)) throw new Error(`invalid octal escape at ${i}`);
  if (ch in NAMED_ESCAPES) return [[NAMED_ESCAPES[ch]], i + 1];
  return [Array.from(utf8.encode(ch)), i + 1];
}

/** The quoted part at `line[i]` (its opening quote), as bytes, and where it ends. */
function quoted(line: string, i: number): [number[], number] {
  const close = line[i];
  const bytes: number[] = [];
  let j = i + 1;
  while (j < line.length && line[j] !== close) {
    if (close === '"' && line[j] === '\\') {
      const [escaped, next] = escape(line, j + 1);
      bytes.push(...escaped);
      j = next;
      continue;
    }
    bytes.push(...utf8.encode(line[j]));
    j++;
  }
  if (j >= line.length) throw new Error(`unclosed ${close} at ${i}`);
  return [bytes, j + 1];
}

/** One word at `line[i]`: bare text, quoted parts and escapes, up to a blank. */
function word(line: string, i: number): [Word, number] {
  const bytes: number[] = [];
  let bare = true;
  let j = i;
  while (j < line.length && line[j] !== ' ' && line[j] !== '\t') {
    if (line[j] === "'" || line[j] === '"') {
      const [part, next] = quoted(line, j);
      bytes.push(...part);
      bare = false;
      j = next;
    } else if (line[j] === '\\') {
      const [escaped, next] = escape(line, j + 1);
      bytes.push(...escaped);
      j = next;
    } else {
      bytes.push(...utf8.encode(line[j]));
      j++;
    }
  }
  return [{ text: new TextDecoder().decode(new Uint8Array(bytes)), bare }, j];
}

/** Where the `{ … }` block opened at `line[i]` closes; quotes inside are skipped. */
function blockEnd(line: string, i: number): number {
  let depth = 0;
  for (let j = i; j < line.length; j++) {
    if (line[j] === "'" || line[j] === '"') j = quoted(line, j)[1] - 1;
    else if (line[j] === '{') depth++;
    else if (line[j] === '}' && --depth === 0) return j;
  }
  throw new Error(`unclosed { at ${i}`);
}

function words(line: string): Word[] {
  const found: Word[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === ' ' || line[i] === '\t') i++;
    else if (line[i] === '#') break;
    else if (line[i] === '{') {
      const end = blockEnd(line, i);
      found.push({ block: line.slice(i + 1, end) });
      i = end + 1;
    } else {
      const [next, end] = word(line, i);
      found.push(next);
      i = end;
    }
  }
  return found;
}

/** The argument of the flag `letter` of a word, and how many words that took. */
function flagArgument(
  template: string,
  letter: string,
  rest: string,
  next: Word | undefined,
): [string | null, number] {
  const at = template.indexOf(letter);
  if (template[at + 1] !== ':') return [null, 0];
  if (rest !== '') return [rest, 0];
  const optional = template[at + 2] === ':';
  const text = next && 'text' in next ? next.text : undefined;
  if (text === undefined || (optional && /^-[-A-Za-z]/.test(text))) {
    if (optional) return [null, 0];
    throw new Error(`-${letter} expects an argument`);
  }
  return [text, 1];
}

/** One command's words read as `args_parse` reads them, with its verb's template. */
function command(argv: Word[]): TmuxCommand {
  const [head, ...rest] = argv;
  const verb = head && 'text' in head ? head.text : '';
  const template = TEMPLATES[verb];
  if (template === undefined) throw new Error(`no option template for "${verb}"`);
  const flags: Array<readonly [string, string | null]> = [];
  let i = 0;
  while (i < rest.length) {
    const w = rest[i];
    if (!('text' in w) || !w.text.startsWith('-') || w.text === '-') break;
    i++;
    if (w.text === '--') break;
    for (let j = 1; j < w.text.length; j++) {
      const letter = w.text[j];
      if (!/[A-Za-z0-9]/.test(letter)) throw new Error(`invalid flag -${letter}`);
      if (!template.includes(letter)) throw new Error(`unknown flag -${letter}`);
      const [value, took] = flagArgument(template, letter, w.text.slice(j + 1), rest[i]);
      flags.push([letter, value]);
      i += took;
      if (value !== null) break;
    }
  }
  const operands = rest.slice(i).map((w) => ('block' in w ? tmuxCommands(w.block) : w.text));
  return { verb, flags, operands };
}

/**
 * What tmux reads from `sent`: one command list per line, its commands split
 * at a bare `;` or `\;`. Throws with tmux's own complaint where tmux would
 * refuse the command (`unknown flag -1`, `-t expects an argument`).
 */
export function tmuxCommands(sent: string): TmuxCommand[] {
  const commands: TmuxCommand[] = [];
  for (const line of sent.split('\n')) {
    let argv: Word[] = [];
    for (const w of [...words(line), { text: ';', bare: true }]) {
      if (!('text' in w && w.bare && w.text === ';')) argv.push(w);
      else if (argv.length > 0) {
        commands.push(command(argv));
        argv = [];
      }
    }
  }
  return commands;
}

/** The argument of `cmd`'s last `-letter`, or `undefined` without one. */
export function flagOf(cmd: TmuxCommand, letter: string): string | null | undefined {
  return [...cmd.flags].reverse().find(([f]) => f === letter)?.[1];
}

/**
 * A `command-prompt` template with what the user typed in place of `%%%`,
 * escaped as tmux escapes it (`cmd_template_replace` in tmux's `cmd.c`).
 */
export function promptFilled(template: string, typed: string): string {
  const escaped = typed.replace(/["\\$;~]/g, (ch) => `\\${ch}`);
  return template.replace('%%%', () => escaped);
}
