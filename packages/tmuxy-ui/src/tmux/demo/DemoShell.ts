import type { PaneContent, CellLine, TerminalCell, CellStyle } from '../types';
import type { VirtualFS } from './virtualFs';
import type { DemoTmux } from './DemoTmux';
import type { ShellContext, CommandResult } from './commands/types';
import { ok } from './commands/types';
import * as filesystem from './commands/filesystem';
import * as text from './commands/text';
import * as navigation from './commands/navigation';
import * as environment from './commands/environment';
import * as shell from './commands/shell';
import { tmuxy } from './commands/tmuxy';

const COMMANDS: Record<string, (args: string[], ctx: ShellContext) => CommandResult> = {
  ls: filesystem.ls,
  cat: filesystem.cat,
  mkdir: filesystem.mkdir,
  touch: filesystem.touch,
  rm: filesystem.rm,
  cp: filesystem.cp,
  mv: filesystem.mv,
  head: text.head,
  tail: text.tail,
  wc: text.wc,
  grep: text.grep,
  echo: text.echo,
  cd: navigation.cd,
  pwd: navigation.pwd,
  which: navigation.which,
  env: environment.env,
  export: environment.exportCmd,
  unset: environment.unset,
  whoami: environment.whoami,
  hostname: environment.hostname,
  uname: environment.uname,
  date: environment.date,
  printenv: environment.printenv,
  help: shell.help,
  history: shell.history,
  clear: shell.clear,
  exit: shell.exit,
  true: shell.trueCmd,
  false: shell.falseCmd,
  tmuxy,
};

const KNOWN_COMMANDS = new Set([
  'vim',
  'vi',
  'nano',
  'emacs',
  'git',
  'docker',
  'npm',
  'node',
  'python',
  'python3',
  'pip',
  'cargo',
  'rustc',
  'go',
  'make',
  'gcc',
  'ssh',
  'scp',
  'curl',
  'wget',
  'tar',
  'zip',
  'unzip',
  'man',
  'less',
  'more',
  'sort',
  'uniq',
  'awk',
  'sed',
  'find',
  'xargs',
  'tee',
  'diff',
  'patch',
  'htop',
  'top',
  'ps',
  'kill',
  'bg',
  'fg',
  'jobs',
]);

export class DemoShell {
  cwd: string;
  env: Map<string, string>;
  history: string[] = [];
  inputBuffer = '';
  cursorPos = 0;
  historyIndex = -1;
  lastExitCode = 0;

  private vfs: VirtualFS;
  private tmux?: DemoTmux;
  private grid: PaneContent = [];
  private cursorRow = 0;
  private cursorCol = 0;
  private width: number;
  private height: number;
  /** Saved input when browsing history */
  private savedInput = '';

  constructor(vfs: VirtualFS, width: number, height: number) {
    this.vfs = vfs;
    this.width = width;
    this.height = height;
    this.cwd = '/home/demo';
    this.env = new Map([
      ['HOME', '/home/demo'],
      ['USER', 'demo'],
      ['SHELL', '/bin/bash'],
      ['PATH', '/usr/bin:/bin'],
      ['TERM', 'xterm-256color'],
      ['PWD', '/home/demo'],
    ]);
    this.initGrid();
  }

  setTmux(tmux: DemoTmux): void {
    this.tmux = tmux;
  }

  private initGrid(): void {
    this.grid = [];
    for (let r = 0; r < this.height; r++) {
      this.grid.push(this.emptyLine());
    }
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  private emptyLine(): CellLine {
    return Array.from({ length: this.width }, () => ({ c: ' ' }));
  }

  getContent(): PaneContent {
    return this.grid.map((line) => [...line]);
  }

  getCursorX(): number {
    return this.cursorCol;
  }

  getCursorY(): number {
    return this.cursorRow;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    // Rebuild grid preserving content
    const newGrid: PaneContent = [];
    for (let r = 0; r < height; r++) {
      if (r < this.grid.length) {
        const oldRow = this.grid[r];
        const newRow: CellLine = [];
        for (let c = 0; c < width; c++) {
          newRow.push(c < oldRow.length ? oldRow[c] : { c: ' ' });
        }
        newGrid.push(newRow);
      } else {
        newGrid.push(this.emptyLine());
      }
    }
    this.grid = newGrid;
    if (this.cursorRow >= height) this.cursorRow = height - 1;
    if (this.cursorCol >= width) this.cursorCol = width - 1;
  }

  /** Write a welcome banner to the grid */
  writeBanner(): void {
    const lines = [
      '\x1b[1;36m Welcome to tmuxy demo! \x1b[0m',
      '',
      ' Try these commands:',
      '   ls, cd, cat, echo, help',
      '',
      ' Tmux shortcuts:',
      '   Ctrl+A " — split horizontally',
      '   Ctrl+A % — split vertically',
      '   Ctrl+A c — new window',
      '   Ctrl+A arrow — navigate panes',
      '',
    ];
    for (const line of lines) {
      this.writeText(line);
      this.newline();
    }
  }

  /** Write the shell prompt to the grid */
  writePrompt(): void {
    const home = this.env.get('HOME') ?? '/home/demo';
    let displayCwd = this.cwd;
    if (this.cwd === home) {
      displayCwd = '~';
    } else if (this.cwd.startsWith(home + '/')) {
      displayCwd = '~' + this.cwd.slice(home.length);
    }

    // demo@tmuxy in green bold
    this.writeStyled('demo@tmuxy', { fg: 2, bold: true });
    this.writeCell({ c: ':', s: undefined });
    // cwd in blue bold
    this.writeStyled(displayCwd, { fg: 4, bold: true });
    this.writeCell({ c: '$', s: undefined });
    this.writeCell({ c: ' ', s: undefined });
  }

  /** Process a tmux key sequence */
  processKey(key: string): void {
    if (key === 'Enter') {
      this.handleEnter();
    } else if (key === 'BSpace') {
      this.handleBackspace();
    } else if (key === 'DC') {
      this.handleDelete();
    } else if (key === 'Left') {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this.cursorCol--;
      }
    } else if (key === 'Right') {
      if (this.cursorPos < this.inputBuffer.length) {
        this.cursorPos++;
        this.cursorCol++;
      }
    } else if (key === 'Up') {
      this.historyUp();
    } else if (key === 'Down') {
      this.historyDown();
    } else if (key === 'Home' || key === 'C-a') {
      this.moveCursorToStart();
    } else if (key === 'End' || key === 'C-e') {
      this.moveCursorToEnd();
    } else if (key === 'C-c') {
      this.handleCtrlC();
    } else if (key === 'C-l') {
      this.handleClear();
    } else if (key === 'C-u') {
      this.handleCtrlU();
    } else if (key === 'C-k') {
      this.handleCtrlK();
    } else if (key === 'C-w') {
      this.handleCtrlW();
    } else if (key === 'Tab') {
      this.handleTab();
    } else if (key === 'Space') {
      this.insertChar(' ');
    } else if (key.length === 1 && key >= ' ') {
      this.insertChar(key);
    }
    // Ignore other keys (function keys, etc.)
  }

  /** Process a literal string (from send-keys -l) */
  processLiteral(text: string): void {
    for (const ch of text) {
      this.insertChar(ch);
    }
  }

  private insertChar(ch: string): void {
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos) + ch + this.inputBuffer.slice(this.cursorPos);
    this.cursorPos++;
    this.historyIndex = -1;

    // Redraw input line from cursor
    this.redrawInput();
  }

  private handleBackspace(): void {
    if (this.cursorPos <= 0) return;
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos - 1) + this.inputBuffer.slice(this.cursorPos);
    this.cursorPos--;
    this.redrawInput();
  }

  private handleDelete(): void {
    if (this.cursorPos >= this.inputBuffer.length) return;
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos) + this.inputBuffer.slice(this.cursorPos + 1);
    this.redrawInput();
  }

  private handleEnter(): void {
    // Move cursor to end of input
    this.cursorCol = this.promptLength() + this.inputBuffer.length;
    this.newline();

    const line = this.inputBuffer.trim();
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.savedInput = '';

    if (line.length > 0) {
      this.history.push(line);
      const result = this.executeLine(line);
      if (result.output) {
        // Check for clear screen escape
        if (result.output === '\x1b[2J\x1b[H') {
          this.handleClearScreen();
        } else {
          this.writeOutput(result.output);
        }
      }
      this.lastExitCode = result.exitCode;
    }

    this.writePrompt();
  }

  private handleCtrlC(): void {
    this.writeText('^C');
    this.newline();
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.writePrompt();
  }

  private handleClear(): void {
    this.handleClearScreen();
    this.writePrompt();
    this.writeText(this.inputBuffer);
    this.cursorCol = this.promptLength() + this.cursorPos;
  }

  private handleClearScreen(): void {
    this.initGrid();
  }

  private handleCtrlU(): void {
    this.inputBuffer = this.inputBuffer.slice(this.cursorPos);
    this.cursorPos = 0;
    this.redrawInput();
  }

  private handleCtrlK(): void {
    this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos);
    this.redrawInput();
  }

  private handleCtrlW(): void {
    // Delete previous word
    let i = this.cursorPos - 1;
    while (i >= 0 && this.inputBuffer[i] === ' ') i--;
    while (i >= 0 && this.inputBuffer[i] !== ' ') i--;
    const newPos = i + 1;
    this.inputBuffer = this.inputBuffer.slice(0, newPos) + this.inputBuffer.slice(this.cursorPos);
    this.cursorPos = newPos;
    this.redrawInput();
  }

  private handleTab(): void {
    // Simple tab completion: complete file/directory names
    const parts = this.inputBuffer.slice(0, this.cursorPos).split(/\s+/);
    const partial = parts[parts.length - 1] || '';
    if (!partial) return;

    const dir = partial.includes('/')
      ? this.vfs.resolvePath(this.cwd, partial.substring(0, partial.lastIndexOf('/') + 1))
      : this.cwd;
    const prefix = partial.includes('/')
      ? partial.substring(partial.lastIndexOf('/') + 1)
      : partial;

    const entries = this.vfs.readdir(dir);
    if (!entries) return;

    const matches = entries.filter((e) => e.startsWith(prefix));
    if (matches.length === 1) {
      const completion = matches[0].slice(prefix.length);
      const node = this.vfs.stat(dir === '/' ? `/${matches[0]}` : `${dir}/${matches[0]}`);
      const suffix = node?.type === 'directory' ? '/' : ' ';
      this.inputBuffer =
        this.inputBuffer.slice(0, this.cursorPos) +
        completion +
        suffix +
        this.inputBuffer.slice(this.cursorPos);
      this.cursorPos += completion.length + 1;
      this.redrawInput();
    }
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.savedInput = this.inputBuffer;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this.inputBuffer = this.history[this.historyIndex];
    this.cursorPos = this.inputBuffer.length;
    this.redrawInput();
  }

  private historyDown(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.inputBuffer = this.history[this.historyIndex];
    } else {
      this.historyIndex = -1;
      this.inputBuffer = this.savedInput;
    }
    this.cursorPos = this.inputBuffer.length;
    this.redrawInput();
  }

  private moveCursorToStart(): void {
    this.cursorPos = 0;
    this.cursorCol = this.promptLength();
  }

  private moveCursorToEnd(): void {
    this.cursorPos = this.inputBuffer.length;
    this.cursorCol = this.promptLength() + this.inputBuffer.length;
  }

  private promptLength(): number {
    // "demo@tmuxy:" + cwd + "$ "
    const home = this.env.get('HOME') ?? '/home/demo';
    let displayCwd = this.cwd;
    if (this.cwd === home) displayCwd = '~';
    else if (this.cwd.startsWith(home + '/')) displayCwd = '~' + this.cwd.slice(home.length);
    return 'demo@tmuxy:'.length + displayCwd.length + '$ '.length;
  }

  private redrawInput(): void {
    // Clear from prompt start to end of line and rewrite
    const promptLen = this.promptLength();
    const row = this.cursorRow;
    // Clear the input area on current line
    for (let c = promptLen; c < this.width; c++) {
      if (this.grid[row]) this.grid[row][c] = { c: ' ' };
    }
    // Write input buffer
    for (let i = 0; i < this.inputBuffer.length; i++) {
      const col = promptLen + i;
      if (col < this.width && this.grid[row]) {
        this.grid[row][col] = { c: this.inputBuffer[i] };
      }
    }
    this.cursorCol = promptLen + this.cursorPos;
  }

  private executeLine(line: string): CommandResult {
    // Support simple pipes
    if (line.includes(' | ')) {
      return this.executePipe(line);
    }
    return this.executeCommand(line);
  }

  private executePipe(line: string): CommandResult {
    const parts = line.split(' | ').map((s) => s.trim());
    let input = '';
    let result: CommandResult = ok();

    for (const part of parts) {
      // For piped commands, prepend previous output as a virtual file
      if (input) {
        // Create temp context with stdin
        const tmpPath = '/tmp/.pipe_stdin';
        this.vfs.writeFile(tmpPath, input);
        const parsed = this.parseCommand(part);
        if (parsed) {
          // Append stdin file as last arg for commands that read files
          const cmdArgs = [...parsed.args, tmpPath];
          const cmdFn = COMMANDS[parsed.cmd];
          if (cmdFn) {
            result = cmdFn(cmdArgs, this.makeContext());
          } else {
            result = { output: `${parsed.cmd}: command not found`, exitCode: 127 };
          }
        }
        this.vfs.rm('/tmp/.pipe_stdin');
      } else {
        result = this.executeCommand(part);
      }
      input = result.output;
    }
    return result;
  }

  private executeCommand(line: string): CommandResult {
    const parsed = this.parseCommand(line);
    if (!parsed) return ok();

    const { cmd, args } = parsed;
    const cmdFn = COMMANDS[cmd];

    if (cmdFn) {
      const ctx = this.makeContext();
      const result = cmdFn(args, ctx);
      // Handle cd: update cwd from result
      if (cmd === 'cd' && result.exitCode === 0 && result.output) {
        this.cwd = result.output;
        this.env.set('PWD', this.cwd);
        return ok();
      }
      return result;
    }

    if (KNOWN_COMMANDS.has(cmd)) {
      return {
        output: `'${cmd}' is not available in this demo shell. Try 'help' for available commands.`,
        exitCode: 127,
      };
    }

    return { output: `${cmd}: command not found`, exitCode: 127 };
  }

  private parseCommand(line: string): { cmd: string; args: string[] } | null {
    const tokens = this.tokenize(line);
    if (tokens.length === 0) return null;
    return { cmd: tokens[0], args: tokens.slice(1) };
  }

  private tokenize(line: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inSingle = false;
    let inDouble = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inSingle) {
        if (ch === "'") inSingle = false;
        else current += ch;
      } else if (inDouble) {
        if (ch === '"') inDouble = false;
        else current += ch;
      } else if (ch === "'") {
        inSingle = true;
      } else if (ch === '"') {
        inDouble = true;
      } else if (ch === ' ' || ch === '\t') {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  private makeContext(): ShellContext {
    return {
      cwd: this.cwd,
      env: this.env,
      vfs: this.vfs,
      history: this.history,
      tmux: this.tmux,
    };
  }

  private writeOutput(text: string): void {
    for (const line of text.split('\n')) {
      this.writeText(line);
      this.newline();
    }
  }

  private writeText(text: string): void {
    // Parse basic ANSI escape sequences
    let i = 0;
    let currentStyle: CellStyle | undefined;

    while (i < text.length) {
      if (text[i] === '\x1b' && text[i + 1] === '[') {
        // Parse SGR sequence
        let j = i + 2;
        while (j < text.length && text[j] !== 'm' && text[j] !== 'J' && text[j] !== 'H') j++;
        if (j < text.length) {
          if (text[j] === 'm') {
            currentStyle = this.parseSGR(text.slice(i + 2, j), currentStyle);
          }
          i = j + 1;
          continue;
        }
      }
      this.writeCell({ c: text[i], s: currentStyle ? { ...currentStyle } : undefined });
      i++;
    }
  }

  private parseSGR(params: string, current?: CellStyle): CellStyle | undefined {
    const codes = params.split(';').map(Number);
    const style: CellStyle = current ? { ...current } : {};

    for (const code of codes) {
      if (code === 0) return undefined;
      if (code === 1) style.bold = true;
      if (code === 3) style.italic = true;
      if (code === 4) style.underline = true;
      if (code === 7) style.inverse = true;
      if (code >= 30 && code <= 37) style.fg = code - 30;
      if (code >= 40 && code <= 47) style.bg = code - 40;
      if (code >= 90 && code <= 97) style.fg = code - 90 + 8;
    }
    return Object.keys(style).length > 0 ? style : undefined;
  }

  private writeStyled(text: string, style: CellStyle): void {
    for (const ch of text) {
      this.writeCell({ c: ch, s: { ...style } });
    }
  }

  private writeCell(cell: TerminalCell): void {
    if (this.cursorCol >= this.width) {
      this.newline();
    }
    if (this.grid[this.cursorRow]) {
      this.grid[this.cursorRow][this.cursorCol] = cell;
    }
    this.cursorCol++;
  }

  private newline(): void {
    this.cursorCol = 0;
    this.cursorRow++;
    if (this.cursorRow >= this.height) {
      // Scroll up
      this.grid.shift();
      this.grid.push(this.emptyLine());
      this.cursorRow = this.height - 1;
    }
  }
}
