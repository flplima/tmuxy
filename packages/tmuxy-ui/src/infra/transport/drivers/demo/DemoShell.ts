/**
 * A pane's shell in the demo engine: a line editor over a cell grid that
 * runs what it is given on Enter, synchronously — `echo`, `printf` (with a
 * `>` into the shared disk, `demoFiles.ts`), `mkdir -p`, `clear`, `exit` and
 * `tmuxy open`; anything else is not found, as in a shell without it. The
 * real thing, a real bash under a real tmux, is the v86 engine's.
 */

import { previewKind } from '../../../../domain/preview';
import { previewArgs } from './demoPreview';
import { DEMO_HOME, resolvePath, type DemoFiles } from './demoFiles';
import type { PaneContent, CellLine, TerminalCell, CellStyle } from '../../../../domain/wire';
import type { DemoTmux } from './DemoTmux';
import { DEMO_BANNER_LINES, writeAnsiText } from './demoShellHelpers';
import { parseLine, printf } from './demoShellCommands';

export class DemoShell {
  cwd = DEMO_HOME;
  history: string[] = [];
  /**
   * The line being edited, one entry per Unicode CHARACTER. A plain string
   * would index an emoji (or any astral char) as two code units — two cursor
   * steps and two half-glyph cells for something the user typed as one key.
   */
  input: string[] = [];
  /** Cursor offset into `input`, in characters. */
  cursorPos = 0;
  historyIndex = -1;

  /** Called when the screen changes on its own (a preview following its file). */
  onUpdate?: () => void;

  private tmux?: DemoTmux;
  private ownPaneId: string | null = null;
  /** Ends a running `tmuxy open`, the one command that runs until C-c. */
  private stopPreview: (() => void) | null = null;

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

  /** The edited line as text, for running it and for history. */
  private get inputText(): string {
    return this.input.join('');
  }

  /** Replace the edited line, splitting text into characters. */
  private setInput(text: string): void {
    this.input = Array.from(text);
  }

  /** `files`: the disk this shell shares with the session's other panes. */
  constructor(
    width: number,
    height: number,
    private readonly files: DemoFiles,
  ) {
    this.width = width;
    this.height = height;
    this.initGrid();
  }

  /** Run one line; its output, or an error, goes to the screen or the `>` file. */
  private run(line: string): void {
    const { argv, redirect } = parseLine(line);
    const [name, ...args] = argv;
    let out = '';
    switch (name) {
      case undefined:
        break;
      case 'echo':
        out = `${args.join(' ')}\n`;
        break;
      case 'printf':
        out = printf(args[0] ?? '', args.slice(1));
        break;
      case 'mkdir':
        for (const arg of args) if (arg !== '-p') this.files.mkdir(resolvePath(this.cwd, arg));
        break;
      case 'clear':
        this.handleClearScreen();
        break;
      case 'tmuxy': {
        const preview = previewArgs(args);
        if (!preview) {
          out = `tmuxy: ${args.join(' ')}: not in this demo\n`;
          break;
        }
        const error = this.runPreview(preview);
        if (!error) return;
        this.writeOutput(error);
        break;
      }
      default:
        out = `bash: ${name}: command not found\n`;
    }
    if (redirect && !this.files.write(resolvePath(this.cwd, redirect), out)) {
      this.writeOutput(`bash: ${redirect}: No such file or directory\n`);
    } else if (!redirect && out) {
      this.writeOutput(out);
    }
    this.writePrompt();
  }

  /**
   * `tmuxy open`, as `tmuxy-widget-preview` runs it: authorise the pane's
   * preview, show the widget, rewrite its rev line whenever the file changes,
   * and hold the shell until C-c, which leaves the widget for the prompt.
   * Returns the error when there is nothing to open.
   */
  private runPreview(args: { file: string; net: boolean; themed: boolean }): string | null {
    const paneId = this.ownPaneId;
    const tmux = this.tmux;
    if (!tmux || !paneId) return 'tmuxy: no pane to open it in\n';
    const path = resolvePath(this.cwd, args.file);
    if (!args.file || !previewKind(path)) {
      return `Error: a preview shows .html and .md files: ${args.file}\n`;
    }
    let last = this.files.read(path);
    if (last === null) return `Error: not a file: ${args.file}\n`;
    let rev = 1;
    const name = path.slice(path.lastIndexOf('/') + 1);
    const lines = () => [
      ...(args.themed ? [] : ['__NO_THEME__']),
      `__FILE__:${name}`,
      `__REV__:${rev}`,
    ];
    tmux.previews.open(paneId, path, args.net, lines());
    const timer = setInterval(() => {
      const now = this.files.read(path);
      if (now === null || now === last) return;
      last = now;
      rev += 1;
      tmux.writeWidget(paneId, 'preview', lines());
      this.onUpdate?.();
    }, 500);
    this.stopPreview = () => {
      this.stopPreview = null;
      clearInterval(timer);
      tmux.previews.close(paneId);
      this.leaveWidget();
      this.writePrompt();
    };
    return null;
  }

  /** A file's bytes from the shared disk, for `read_preview`. */
  async readFileBytes(path: string): Promise<Uint8Array> {
    const bytes = this.files.read(path);
    if (!bytes) throw new Error(`${path}: no such file`);
    return bytes;
  }

  /** Back from a widget to a terminal: an empty screen for the prompt. */
  private leaveWidget(): void {
    this.widgetGrid = false;
    this.scrollback = [];
    this.initGrid();
  }

  /**
   * Bind this shell to its host pane. `paneId` is required so `exit` can kill
   * the pane the shell actually lives in: keys routed via `send-keys -t %N`
   * reach a shell that may not be the active pane (a float never becomes the
   * active window), and a bare `killPane()` kills the ACTIVE pane instead.
   */
  setTmux(tmux: DemoTmux, paneId: string): void {
    this.tmux = tmux;
    this.ownPaneId = paneId;
  }

  // ============================================
  // Grid management
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

  getWidth(): number {
    return this.width;
  }

  getHeight(): number {
    return this.height;
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
    for (const line of DEMO_BANNER_LINES) {
      this.writeText(line);
      this.newline();
    }
  }

  /** The working directory as the prompt shows it, `~` for home. */
  private displayCwd(): string {
    if (this.cwd === DEMO_HOME) return '~';
    if (this.cwd.startsWith(`${DEMO_HOME}/`)) return `~${this.cwd.slice(DEMO_HOME.length)}`;
    return this.cwd;
  }

  writePrompt(): void {
    this.writeStyled('demo@tmuxy', { fg: 2, bold: true });
    this.writeCell({ c: ':', s: undefined });
    this.writeStyled(this.displayCwd(), { fg: 4, bold: true });
    this.writeCell({ c: '$', s: undefined });
    this.writeCell({ c: ' ', s: undefined });
    this.promptRow = this.cursorRow;
  }

  // ============================================
  // Key input handling
  // ============================================

  processKey(key: string): void {
    // A running preview takes no input but C-c, which ends it.
    if (this.stopPreview) {
      if (key === 'C-c') this.stopPreview();
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
      if (this.cursorPos < this.input.length) {
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
    } else if (key === 'Space') {
      this.insertChar(' ');
    } else if (Array.from(key).length === 1 && key >= ' ') {
      // One Unicode character, which is not always one code unit: an emoji or
      // any astral char is a two-unit string the user typed as a single key.
      this.insertChar(key);
    }
  }

  processLiteral(text: string): void {
    if (this.stopPreview) return;
    for (const ch of text) {
      this.insertChar(ch);
    }
  }

  private insertChar(ch: string): void {
    this.input.splice(this.cursorPos, 0, ch);
    this.cursorPos++;
    this.historyIndex = -1;
    this.redrawInput();
  }

  private handleBackspace(): void {
    if (this.cursorPos <= 0) return;
    this.input.splice(this.cursorPos - 1, 1);
    this.cursorPos--;
    this.redrawInput();
  }

  private handleDelete(): void {
    if (this.cursorPos >= this.input.length) return;
    this.input.splice(this.cursorPos, 1);
    this.redrawInput();
  }

  private handleEnter(): void {
    this.cursorPos = this.input.length;
    this.updateCursorPosition();
    this.newline();

    const line = this.inputText.trim();
    this.input = [];
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.savedInput = '';

    if (line === 'exit') {
      this.tmux?.killPane(this.ownPaneId ?? undefined);
      this.onUpdate?.();
      return;
    }

    if (line.length > 0) this.history.push(line);
    this.run(line);
  }

  private handleCtrlC(): void {
    this.writeText('^C');
    this.newline();
    this.input = [];
    this.cursorPos = 0;
    this.historyIndex = -1;
    this.writePrompt();
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
    this.input = this.input.slice(this.cursorPos);
    this.cursorPos = 0;
    this.redrawInput();
  }

  private handleCtrlK(): void {
    this.input = this.input.slice(0, this.cursorPos);
    this.redrawInput();
  }

  private handleCtrlW(): void {
    let i = this.cursorPos - 1;
    while (i >= 0 && this.input[i] === ' ') i--;
    while (i >= 0 && this.input[i] !== ' ') i--;
    const newPos = i + 1;
    this.input = this.input.slice(0, newPos).concat(this.input.slice(this.cursorPos));
    this.cursorPos = newPos;
    this.redrawInput();
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === -1) {
      this.savedInput = this.inputText;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex--;
    } else {
      return;
    }
    this.setInput(this.history[this.historyIndex]);
    this.cursorPos = this.input.length;
    this.redrawInput();
  }

  private historyDown(): void {
    if (this.historyIndex === -1) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex++;
      this.setInput(this.history[this.historyIndex]);
    } else {
      this.historyIndex = -1;
      this.setInput(this.savedInput);
    }
    this.cursorPos = this.input.length;
    this.redrawInput();
  }

  private moveCursorToStart(): void {
    this.cursorPos = 0;
    this.updateCursorPosition();
  }

  private moveCursorToEnd(): void {
    this.cursorPos = this.input.length;
    this.updateCursorPosition();
  }

  private promptLength(): number {
    return 'demo@tmuxy:'.length + this.displayCwd().length + '$ '.length;
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
    for (let i = 0; i < this.input.length; i++) {
      const flat = promptLen + i;
      const row = this.promptRow + Math.floor(flat / this.width);
      const col = flat % this.width;
      if (row < this.height && this.grid[row]) {
        this.grid[row][col] = { c: this.input[i] };
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
    writeAnsiText(text, (cell) => this.writeCell(cell));
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
