import { Sandbox } from '@lifo-sh/core';
import type { PaneContent, CellLine, TerminalCell, CellStyle } from '../types';
import type { DemoTmux } from './DemoTmux';
import { tmuxy as tmuxyCmd } from './commands/tmuxy';

export class LifoShell {
  cwd: string;
  env: Map<string, string>;
  history: string[] = [];
  inputBuffer = '';
  cursorPos = 0;
  historyIndex = -1;
  lastExitCode = 0;

  /** Called after an async command completes — triggers state re-emit in DemoAdapter */
  onUpdate?: () => void;

  private sandbox: Sandbox | null = null;
  private sandboxPromise: Promise<Sandbox>;
  private tmux?: DemoTmux;
  private busy = false;
  private abortController: AbortController | null = null;

  private grid: PaneContent = [];
  private scrollback: CellLine[] = [];
  private cursorRow = 0;
  private cursorCol = 0;
  private width: number;
  private height: number;
  private widgetGrid = false;
  /** Row where the current prompt starts */
  private promptRow = 0;
  /** Saved input when browsing history */
  private savedInput = '';

  constructor(width: number, height: number) {
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
    this.sandboxPromise = this.initSandbox();
  }

  private async initSandbox(): Promise<Sandbox> {
    const sb = await Sandbox.create({
      cwd: '/home/demo',
      env: {
        HOME: '/home/demo',
        USER: 'demo',
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
        PWD: '/home/demo',
        HOSTNAME: 'tmuxy',
      },
      files: {
        '/home/demo/.keep': '',
      },
    });
    this.sandbox = sb;
    this.registerCustomCommands(sb);
    return sb;
  }

  private registerCustomCommands(sb: Sandbox): void {
    sb.commands.register('tmuxy', async (ctx) => {
      const shellCtx = {
        cwd: this.cwd,
        env: this.env,
        vfs: null as never,
        history: this.history,
        tmux: this.tmux,
      };
      const result = tmuxyCmd(ctx.args, shellCtx);
      if (result.output) ctx.stdout.write(result.output);
      return result.exitCode;
    });
  }

  setTmux(tmux: DemoTmux): void {
    this.tmux = tmux;
  }

  // ============================================
  // Grid management (same as DemoShell)
  // ============================================

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

  getHistorySize(): number {
    return this.scrollback.length;
  }

  getScrollbackContent(start: number, end: number): PaneContent {
    const result: PaneContent = [];
    const totalLines = this.scrollback.length + this.height;
    const clampedStart = Math.max(0, start);
    const clampedEnd = Math.min(end, totalLines);
    for (let i = clampedStart; i < clampedEnd; i++) {
      if (i < this.scrollback.length) {
        result.push([...this.scrollback[i]]);
      } else {
        const gridIdx = i - this.scrollback.length;
        if (gridIdx < this.grid.length) {
          result.push([...this.grid[gridIdx]]);
        }
      }
    }
    return result;
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
    if (this.widgetGrid) return;
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

  writeWidgetContent(widgetName: string, contentLines: string[]): void {
    this.scrollback = [];
    this.widgetGrid = true;
    const marker = `__TMUXY_WIDGET__:${widgetName}`;
    const allLines = [marker, ...contentLines];
    this.grid = allLines.map((line) => [...line].map((c) => ({ c })));
    while (this.grid.length < this.height) {
      this.grid.push(Array.from({ length: this.width }, () => ({ c: ' ' })));
    }
    this.cursorRow = Math.min(allLines.length, this.height - 1);
    this.cursorCol = 0;
  }

  writeBanner(): void {
    const lines = [
      '\x1b[1;36mThis is a live demo! \x1b[0m',
      'Powered by \x1b[1;33mlifo.sh\x1b[0m — real bash in your browser.',
      'Try: ls, cat, grep, echo, curl, and more.',
      '',
    ];
    for (const line of lines) {
      this.writeText(line);
      this.newline();
    }
  }

  writePrompt(): void {
    const home = this.env.get('HOME') ?? '/home/demo';
    let displayCwd = this.cwd;
    if (this.cwd === home) {
      displayCwd = '~';
    } else if (this.cwd.startsWith(home + '/')) {
      displayCwd = '~' + this.cwd.slice(home.length);
    }

    this.writeStyled('demo@tmuxy', { fg: 2, bold: true });
    this.writeCell({ c: ':', s: undefined });
    this.writeStyled(displayCwd, { fg: 4, bold: true });
    this.writeCell({ c: '$', s: undefined });
    this.writeCell({ c: ' ', s: undefined });
    this.promptRow = this.cursorRow;
  }

  // ============================================
  // Key input handling
  // ============================================

  processKey(key: string): void {
    // Ignore all keys while a command is running (except C-c)
    if (this.busy) {
      if (key === 'C-c') this.handleCtrlC();
      return;
    }

    if (key === 'Enter') {
      this.handleEnter();
    } else if (key === 'BSpace') {
      this.handleBackspace();
    } else if (key === 'DC') {
      this.handleDelete();
    } else if (key === 'Left') {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this.updateCursorPosition();
      }
    } else if (key === 'Right') {
      if (this.cursorPos < this.inputBuffer.length) {
        this.cursorPos++;
        this.updateCursorPosition();
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
      // Tab completion not supported in lifo mode
    } else if (key === 'Space') {
      this.insertChar(' ');
    } else if (key.length === 1 && key >= ' ') {
      this.insertChar(key);
    }
  }

  processLiteral(text: string): void {
    if (this.busy) return;
    for (const ch of text) {
      this.insertChar(ch);
    }
  }

  private insertChar(ch: string): void {
    this.inputBuffer =
      this.inputBuffer.slice(0, this.cursorPos) + ch + this.inputBuffer.slice(this.cursorPos);
    this.cursorPos++;
    this.historyIndex = -1;
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
    this.cursorPos = this.inputBuffer.length;
    this.updateCursorPosition();
    this.newline();

    const line = this.inputBuffer.trim();
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.savedInput = '';

    if (line.length > 0) {
      this.history.push(line);
      this.busy = true;
      this.abortController = new AbortController();
      this.executeLineAsync(line, this.abortController.signal);
    } else {
      this.writePrompt();
    }
  }

  private async executeLineAsync(line: string, signal: AbortSignal): Promise<void> {
    try {
      const sandbox = this.sandbox ?? (await this.sandboxPromise);

      const result = await sandbox.commands.run(line, {
        cwd: this.cwd,
        signal,
      });

      // Track cwd changes (e.g. from cd)
      const newCwd = sandbox.shell.getCwd();
      if (newCwd !== this.cwd) {
        this.cwd = newCwd;
        this.env.set('PWD', this.cwd);
      }

      const output = (result.stdout + result.stderr).replace(/\r\n/g, '\n');
      if (output) {
        // Check for clear-screen escape
        if (output.includes('\x1b[2J')) {
          this.handleClearScreen();
        } else {
          this.writeOutput(output);
        }
      }
      this.lastExitCode = result.exitCode;
    } catch (e: unknown) {
      const isAbort =
        e instanceof Error && (e.name === 'AbortError' || e.message.includes('abort'));
      if (isAbort) {
        this.writeText('^C');
        this.newline();
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        this.writeText(msg);
        this.newline();
      }
      this.lastExitCode = 1;
    } finally {
      this.busy = false;
      this.abortController = null;
      this.writePrompt();
      this.onUpdate?.();
    }
  }

  private handleCtrlC(): void {
    if (this.busy) {
      this.abortController?.abort();
      // The executeLineAsync finally block handles the prompt
    } else {
      this.writeText('^C');
      this.newline();
      this.inputBuffer = '';
      this.cursorPos = 0;
      this.historyIndex = -1;
      this.writePrompt();
    }
  }

  private handleClear(): void {
    this.handleClearScreen();
    this.writePrompt();
    this.redrawInput();
  }

  private handleClearScreen(): void {
    this.scrollback = [];
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
    let i = this.cursorPos - 1;
    while (i >= 0 && this.inputBuffer[i] === ' ') i--;
    while (i >= 0 && this.inputBuffer[i] !== ' ') i--;
    const newPos = i + 1;
    this.inputBuffer = this.inputBuffer.slice(0, newPos) + this.inputBuffer.slice(this.cursorPos);
    this.cursorPos = newPos;
    this.redrawInput();
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
    this.updateCursorPosition();
  }

  private moveCursorToEnd(): void {
    this.cursorPos = this.inputBuffer.length;
    this.updateCursorPosition();
  }

  private promptLength(): number {
    const home = this.env.get('HOME') ?? '/home/demo';
    let displayCwd = this.cwd;
    if (this.cwd === home) displayCwd = '~';
    else if (this.cwd.startsWith(home + '/')) displayCwd = '~' + this.cwd.slice(home.length);
    return 'demo@tmuxy:'.length + displayCwd.length + '$ '.length;
  }

  private updateCursorPosition(): void {
    const flat = this.promptLength() + this.cursorPos;
    this.cursorRow = this.promptRow + Math.floor(flat / this.width);
    this.cursorCol = flat % this.width;
  }

  private redrawInput(): void {
    const promptLen = this.promptLength();
    if (this.grid[this.promptRow]) {
      for (let c = promptLen; c < this.width; c++) {
        this.grid[this.promptRow][c] = { c: ' ' };
      }
    }
    for (let r = this.promptRow + 1; r < this.height; r++) {
      if (this.grid[r]) this.grid[r] = this.emptyLine();
    }
    for (let i = 0; i < this.inputBuffer.length; i++) {
      const flat = promptLen + i;
      const row = this.promptRow + Math.floor(flat / this.width);
      const col = flat % this.width;
      if (row < this.height && this.grid[row]) {
        this.grid[row][col] = { c: this.inputBuffer[i] };
      }
    }
    this.updateCursorPosition();
  }

  // ============================================
  // Output rendering
  // ============================================

  private writeOutput(text: string): void {
    // Trim trailing newline to avoid extra blank line before prompt
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
    for (const line of trimmed.split('\n')) {
      this.writeText(line);
      this.newline();
    }
  }

  private writeText(text: string): void {
    let i = 0;
    let currentStyle: CellStyle | undefined;

    while (i < text.length) {
      if (text[i] === '\x1b' && text[i + 1] === '[') {
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
      const shifted = this.grid.shift()!;
      this.scrollback.push(shifted);
      this.grid.push(this.emptyLine());
      this.cursorRow = this.height - 1;
    }
  }
}
