import type { PaneContent, CellLine, TerminalCell, CellStyle } from '../types';
import type { Sandbox } from '@lifo-sh/core';

export class FakeShell {
  cwd: string;
  history: string[] = [];
  inputBuffer = '';
  cursorPos = 0;
  historyIndex = -1;
  lastExitCode = 0;

  /** Called when async command execution completes and grid has new content */
  onContentChange?: () => void;

  private sandbox: Sandbox;
  private grid: PaneContent = [];
  private cursorRow = 0;
  private cursorCol = 0;
  private width: number;
  private height: number;
  private savedInput = '';
  private pendingExecution: Promise<void> | null = null;

  constructor(sandbox: Sandbox, width: number, height: number) {
    this.sandbox = sandbox;
    this.width = width;
    this.height = height;
    this.cwd = sandbox.cwd;
    this.initGrid();
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
    return this.grid;
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

  writeBanner(): void {
    const lines = [
      '\x1b[1;36m Welcome to tmuxy demo! \x1b[0m',
      '',
      ' Try these commands:',
      '   ls, cd, cat, echo, grep, sed, awk, find',
      '   Pipes: ls | grep src | wc -l',
      '   Logic: test -f README.md && echo exists',
      '',
      ' Tmux shortcuts:',
      '   Ctrl+A " \u2014 split horizontally',
      '   Ctrl+A % \u2014 split vertically',
      '   Ctrl+A c \u2014 new window',
      '   Ctrl+A arrow \u2014 navigate panes',
      '',
    ];
    for (const line of lines) {
      this.writeText(line);
      this.newline();
    }
  }

  writePrompt(): void {
    const home = '/home/user';
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
      this.handleClearScreen();
      this.writePrompt();
      this.writeText(this.inputBuffer);
      this.cursorCol = this.promptLength() + this.cursorPos;
    } else if (key === 'C-u') {
      this.inputBuffer = this.inputBuffer.slice(this.cursorPos);
      this.cursorPos = 0;
      this.redrawInput();
    } else if (key === 'C-k') {
      this.inputBuffer = this.inputBuffer.slice(0, this.cursorPos);
      this.redrawInput();
    } else if (key === 'C-w') {
      this.handleCtrlW();
    } else if (key === 'Tab') {
      // Tab completion not implemented with lifo (would need completer access)
    } else if (key === 'Space') {
      this.insertChar(' ');
    } else if (key.length === 1 && key >= ' ') {
      this.insertChar(key);
    }
  }

  /** Process a literal string (from send-keys -l) */
  processLiteral(text: string): void {
    for (const ch of text) {
      this.insertChar(ch);
    }
  }

  /** Wait for any pending async command execution to finish */
  async waitForCompletion(): Promise<void> {
    if (this.pendingExecution) {
      await this.pendingExecution;
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
    this.cursorCol = this.promptLength() + this.inputBuffer.length;
    this.newline();

    const line = this.inputBuffer.trim();
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.savedInput = '';

    if (line.length > 0) {
      this.history.push(line);

      // Intercept 'clear' — lifo's clear builtin writes to terminal (no-op in headless)
      if (line === 'clear') {
        this.handleClearScreen();
        this.writePrompt();
        this.onContentChange?.();
        return;
      }

      // Async execution via lifo Sandbox
      this.pendingExecution = this.executeViaLifo(line);
    } else {
      this.writePrompt();
    }
  }

  private async executeViaLifo(line: string): Promise<void> {
    try {
      // Sync sandbox cwd to this pane's cwd before executing.
      // Don't pass cwd as an option — lifo restores the original cwd after
      // execution when options.cwd is set, which prevents cd from persisting.
      this.sandbox.cwd = this.cwd;

      const result = await this.sandbox.commands.run(line, {
        timeout: 5000,
      });

      // Write stdout
      if (result.stdout) {
        // lifo uses \n line endings; strip trailing newline to avoid extra blank line
        const output = result.stdout.endsWith('\n') ? result.stdout.slice(0, -1) : result.stdout;
        if (output) this.writeOutput(output);
      }

      // Write stderr
      if (result.stderr) {
        const errOutput = result.stderr.endsWith('\n') ? result.stderr.slice(0, -1) : result.stderr;
        if (errOutput) this.writeOutput(errOutput);
      }

      this.lastExitCode = result.exitCode;

      // Sync cwd back (in case cd was used)
      this.cwd = this.sandbox.cwd;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeOutput(msg);
      this.lastExitCode = 1;
    }

    this.writePrompt();
    this.pendingExecution = null;
    this.onContentChange?.();
  }

  private handleCtrlC(): void {
    this.writeText('^C');
    this.newline();
    this.inputBuffer = '';
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.writePrompt();
  }

  private handleClearScreen(): void {
    this.initGrid();
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
    this.cursorCol = this.promptLength();
  }

  private moveCursorToEnd(): void {
    this.cursorPos = this.inputBuffer.length;
    this.cursorCol = this.promptLength() + this.inputBuffer.length;
  }

  private promptLength(): number {
    const home = '/home/user';
    let displayCwd = this.cwd;
    if (this.cwd === home) displayCwd = '~';
    else if (this.cwd.startsWith(home + '/')) displayCwd = '~' + this.cwd.slice(home.length);
    return 'demo@tmuxy:'.length + displayCwd.length + '$ '.length;
  }

  private redrawInput(): void {
    const promptLen = this.promptLength();
    const row = this.cursorRow;
    for (let c = promptLen; c < this.width; c++) {
      if (this.grid[row]) this.grid[row][c] = { c: ' ' };
    }
    for (let i = 0; i < this.inputBuffer.length; i++) {
      const col = promptLen + i;
      if (col < this.width && this.grid[row]) {
        this.grid[row][col] = { c: this.inputBuffer[i] };
      }
    }
    this.cursorCol = promptLen + this.cursorPos;
  }

  private writeOutput(text: string): void {
    for (const line of text.split('\n')) {
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
      this.grid.shift();
      this.grid.push(this.emptyLine());
      this.cursorRow = this.height - 1;
    }
  }
}
